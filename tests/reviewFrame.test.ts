import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reportIsCurrent, reviewFrame } from '../server/review.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Canvas, DesignTokens, Frame } from '../shared/types.ts'

/* review_frame is the verification gate's whole input, so it is checked
   against a real render (skipped where no browser is installed, like the other
   browser-backed suites): the findings must come out of the browser's own
   computed styles, and every viewport must actually be reviewed. */

const TOKENS: DesignTokens = {
  colors: { ink: '#111110', paper: '#ffffff' },
  fonts: { body: 'Inter' },
  spacing: [4, 8, 16, 24],
  radii: [0, 8],
  updatedAt: 0,
  updatedBy: 'alice',
}

function frame(html: string): Frame {
  return {
    id: 'f-review',
    canvasId: 'c-review',
    name: 'Review fixture',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
  }
}

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#ffffff}</style></head><body>${body}</body></html>`

describe.skipIf(!findBrowserPath())('reviewFrame over a real render', () => {
  it('reviews all three viewports and surfaces the a11y and token violations', async () => {
    const report = await reviewFrame(
      frame(
        page(`
          <main>
            <h1 style="color:#111110">Dashboard</h1>
            <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40">
            <p style="color:#777777;font-size:16px">Secondary explanation text</p>
            <p style="color:#123456;font-size:16px">Off-palette accent text</p>
          </main>
        `),
      ),
      TOKENS,
    )

    expect(report.frame_id).toBe('f-review')
    expect(report.viewports).toHaveLength(3)
    expect(report.viewports.map((entry) => entry.viewport.width)).toEqual([390, 834, 1440])
    expect(new Set(report.viewports.map((entry) => entry.viewport.width)).size).toBe(3)
    /* the image has no alt text and the body copy sits at 4.48:1 */
    expect(report.summary.critical).toBeGreaterThanOrEqual(1)
    /* #123456 is neither of the two palette colours */
    expect(report.summary.off_token).toBeGreaterThanOrEqual(1)
    expect(report.viewports[0]!.a11y.counts.critical).toBeGreaterThanOrEqual(1)
    expect(report.viewports[0]!.lint.counts.off_token_color).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

describe.skipIf(!findBrowserPath())('review provenance and verdicts', () => {
  it('names the document it describes, so a later edit invalidates it', async () => {
    const html = page('<main><h1>Dashboard</h1><p style="color:#111110">Body copy</p></main>')
    const before = await reviewFrame(frame(html), TOKENS)
    const after = await reviewFrame(frame(html.replace('Dashboard', 'Overview')), TOKENS)
    expect(before.html_sha).not.toBe(after.html_sha)
    expect(reportIsCurrent(before, frame(html), TOKENS)).toBe(true)
    expect(reportIsCurrent(before, frame(html.replace('Dashboard', 'Overview')), TOKENS)).toBe(false)
  })

  it('treats a token change as a change to the document it describes', async () => {
    const html = page('<main><h1 style="color:var(--color-ink)">Dashboard</h1></main>')
    const report = await reviewFrame(frame(html), TOKENS)
    /* the same HTML, a different palette: the render is different, so the
       report is not evidence about it any more */
    const repainted: DesignTokens = { ...TOKENS, colors: { ink: '#0000ff', paper: '#ffffff' } }
    expect(reportIsCurrent(report, frame(html), TOKENS)).toBe(true)
    expect(reportIsCurrent(report, frame(html), repainted)).toBe(false)
  })

  it('fails a frame whose own height exceeds a phone preset, instead of calling it clipped', async () => {
    /* a tall design is not clipped by the frame it is drawn in: the review
       renders it at its own height, so nothing is falsely cut off */
    const tall: Frame = { ...frame(page('<main><h1>Tall</h1></main>')), height: 2400 }
    const report = await reviewFrame(tall, TOKENS)
    expect(report.viewports.map((entry) => entry.viewport.height)).toEqual([2400, 2400, 2400])
    expect(report.blocking.filter((finding) => finding.rule === 'clipped_by_frame')).toEqual([])
  })

  it('reports which viewport failed, not just that something did', async () => {
    /* 500px overflows the phone preset and nothing wider, so the failing set
       is the point of the test rather than a property of the fixture. The rest
       of the document is clean — tokens, hover/focus states, a real tap target
       — so the only blocking finding is the narrow preset's overflow. */
    const wide = `<!doctype html><html lang="en"><head><title>Wide</title>
        <meta name="description" content="A layout that only overflows on the narrow preset.">
        <style>
          body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
          h1 { font-size: 32px; line-height: 1.25; }
          a:hover { text-decoration: underline }
          a:focus-visible { outline: 2px solid #111110 }
        </style></head>
        <body><main style="min-height:600px"><h1>Wide</h1>
        <div style="width:500px;height:40px;background:#111110"></div>
        <a href="/start" style="display:inline-block;min-width:44px;min-height:44px;color:#111110">Start</a>
        </main></body></html>`
    const report = await reviewFrame(frame(wide), TOKENS)
    expect(report.verdict).toBe('fail')
    expect(report.failing_viewports).toEqual(['mobile'])
    expect(report.viewports.find((entry) => entry.viewport.width === 390)?.verdict).toBe('fail')
    /* the wider presets are wide enough for the same content */
    expect(report.viewports.find((entry) => entry.viewport.width === 1440)?.verdict).toBe('pass')
  })

  it('catches the failures the older checks missed', async () => {
    const report = await reviewFrame(
      frame(
        page(`
          <main>
            <h1 style="color:#111110">Dashboard</h1>
            <p style="color:#111110">Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
            <img src="/missing-image.png" alt="Chart" width="40" height="40">
            <button style="color:#111110">Save</button>
          </main>
        `),
      ),
      TOKENS,
    )
    const rules = report.blocking.map((finding) => finding.rule)
    expect(rules).toContain('placeholder_text')
    expect(rules).toContain('broken_image')
    /* the page has no <title> in this fixture */
    expect(rules).toContain('no_title')
    /* the button has no hover/focus rule anywhere in the frame's CSS */
    const content = report.viewports[0]!.content
    expect(content.issues.map((issue) => issue.rule)).toContain('missing_state')
  })

  it('passes a clean, real page', async () => {
    const report = await reviewFrame(
      frame(`<!doctype html><html lang="en"><head><title>Acme</title>
        <meta name="description" content="Acme does things.">
        <style>
          body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
          h1 { font-size: 32px; line-height: 1.25; }
          a:hover { text-decoration: underline }
          a:focus-visible { outline: 2px solid #111110 }
        </style></head>
        <body><main style="min-height:600px"><h1>Acme</h1>
        <p style="color:#111110">We make things that work.</p>
        <a href="/start" style="color:#111110">Start</a>
        </main></body></html>`),
      TOKENS,
    )
    expect(report.blocking).toEqual([])
    expect(report.verdict).toBe('pass')
    expect(report.failing_viewports).toEqual([])
  })
})

/* A layout that only fits above 700px: it overflows the phone preset and a
   640px breakpoint, and fits the tablet preset and a 900px one. That is what
   makes a finding attributable to a width instead of to "the design is
   broken". */
const WIDE = `<!doctype html><html lang="en"><head><title>Wide</title>
      <meta name="description" content="A layout that only overflows below 700px.">
      <style>
        body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
        h1 { font-size: 32px; line-height: 1.25; }
        a:hover { text-decoration: underline }
        a:focus-visible { outline: 2px solid #111110 }
      </style></head>
      <body><main style="min-height:600px"><h1>Wide</h1>
      <div style="width:700px;height:40px;background:#111110"></div>
      <a href="/start" style="display:inline-block;min-width:44px;min-height:44px;color:#111110">Start</a>
      </main></body></html>`

const BREAKPOINTS = [
  { name: 'sm', min_width: 640 },
  { name: 'md', min_width: 900 },
]

describe.skipIf(!findBrowserPath())('review at the canvas’s own breakpoints', () => {
  it('reviews every breakpoint after the presets, and names the width that failed', async () => {
    const report = await reviewFrame(frame(WIDE), TOKENS, { breakpoints: BREAKPOINTS })

    expect(report.viewports.map((entry) => entry.label)).toEqual(['mobile', 'tablet', 'desktop', 'sm', 'md'])
    expect(report.viewports.map((entry) => entry.viewport.width)).toEqual([390, 834, 1440, 640, 900])
    /* a breakpoint is rendered at least as tall as a phone, so a short frame is
       not judged on a slice of itself */
    expect(report.viewports.slice(3).map((entry) => entry.viewport.height)).toEqual([844, 844])
    /* 700px of content overflows the phone preset and sm, and nothing wider —
       so the failing set is the point of the test, and the breakpoint is named
       the way the canvas named it */
    expect(report.failing_viewports).toEqual(['mobile', 'sm'])
    expect(report.viewports[3]!.verdict).toBe('fail')
    expect(report.viewports[4]!.verdict).toBe('pass')
  }, 120_000)

  it('keeps the three device presets when the canvas declares no breakpoints', async () => {
    const report = await reviewFrame(frame(WIDE), TOKENS, { breakpoints: [] })

    expect(report.viewports.map((entry) => entry.label)).toEqual(['mobile', 'tablet', 'desktop'])
    expect(report.viewports.map((entry) => entry.viewport.width)).toEqual([390, 834, 1440])
  }, 60_000)
})

/* The tool-level wiring: review_frame reads the canvas's own breakpoints, and
   the screenshot and audit tools render a width that is not a device preset.
   Both are only real if they survive the MCP surface — published schema
   included — so this drives the actual server over an in-memory transport
   against the real store and database, like the other MCP suites. */
const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-review-breakpoints-'))
const OWNER_ID = 'breakpoints-owner'
const CANVAS_ID = 'c-breakpoints'
const MCP_FRAME: Frame = { ...frame(WIDE), id: 'f-breakpoints', canvasId: CANVAS_ID, name: 'Wide', width: 1200 }

const CANVAS: Canvas = {
  id: CANVAS_ID,
  name: 'Breakpoints',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [MCP_FRAME],
}

describe.skipIf(!findBrowserPath())('review_frame and width over the MCP surface', () => {
  beforeAll(async () => {
    process.chdir(dataRoot)
    await initDb()
    store.init([CANVAS])
    /* the Wave-1 setter the tool reads through — not a hand-set field */
    store.setBreakpoints(CANVAS_ID, BREAKPOINTS, 'alice')
  }, 60_000)

  afterAll(async () => {
    /* the same drain the server runs on shutdown: frame writes are debounced,
       and a pending one would be in flight while the database closes */
    await persist.flush((id) => store.getFrame(id))
    await closeDb()
    process.chdir(tmpdir())
    rmSync(dataRoot, { recursive: true, force: true })
  }, 60_000)

  async function connect() {
    const server = buildMcpServer('Review Owner', OWNER_ID)
    const client = new Client({ name: 'doop-review-breakpoints', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    return {
      client,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  it('reviews the canvas’s breakpoints and labels them in the structured result', async () => {
    const { client, close } = await connect()
    try {
      const result = (await client.callTool({
        name: 'review_frame',
        arguments: { canvas_id: CANVAS_ID, frame_id: MCP_FRAME.id, agent_name: 'Reviewer' },
      })) as unknown as {
        isError?: boolean
        structuredContent: { viewports: { label?: string }[]; failing_viewports: string[] }
      }

      /* the published output schema has to accept the report, or the SDK turns
         every call into an InvalidParams error */
      expect(result.isError).toBeFalsy()
      expect(result.structuredContent.viewports.map((entry) => entry.label)).toEqual([
        'mobile',
        'tablet',
        'desktop',
        'sm',
        'md',
      ])
      expect(result.structuredContent.failing_viewports).toEqual(['mobile', 'sm'])
    } finally {
      await close()
    }
  }, 120_000)

  it('renders a screenshot and an audit at an arbitrary width', async () => {
    const { client, close } = await connect()
    try {
      const shot = (await client.callTool({
        name: 'get_frame_screenshot',
        arguments: { frame_id: MCP_FRAME.id, width: 320, agent_name: 'Reviewer' },
      })) as unknown as { content: { type: string; text?: string }[] }
      const caption = shot.content.find((block) => block.type === 'text')?.text ?? ''
      /* the width asked for, at the frame's own height */
      expect(caption).toContain('(320×600')

      const audit = (await client.callTool({
        name: 'audit_frame',
        arguments: { frame_id: MCP_FRAME.id, width: 320, agent_name: 'Reviewer' },
      })) as unknown as { structuredContent: { viewport: { width: number; height: number } } }
      expect(audit.structuredContent.viewport).toEqual({ width: 320, height: 600 })
    } finally {
      await close()
    }
  }, 60_000)
})
