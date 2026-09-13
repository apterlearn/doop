import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { buildZip } from '../server/zip.ts'
import { componentName } from '../server/codeExport.ts'
import { initDb, closeDb } from '../server/db/index.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Handoff: the archive is verified by unzipping it with the system tool (a ZIP
   that only our own reader accepts is not a ZIP), the React conversion against
   a real render, and the manifest without a browser. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveJournal: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  hydrate: () => {},
  saveCanvas: () => {},
  saveCanvasCopy: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  setFramePage: () => {},
  saveTask: () => {},
  deleteTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteCanvas: () => {},
  savePlan: () => {},
  deletePlan: () => {},
  /* the export reads a frame's newest verification report into its spec */
  listFrameReviews: async () => [],
}))

const OWNER_ID = 'export-owner'
const CANVAS_ID = 'c-export'

/* export_canvas stores nothing, but the export_frame image branch needs a
   working asset/database layer; boot the real one as the server does. */
const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-code-export-'))

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
}, 60_000)

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-export-test', version: '1.0.0' })
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

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

let counter = 0

function seedCanvas(htmls: string[]): Frame[] {
  counter += 1
  const canvasId = `${CANVAS_ID}-${counter}`
  const frames: Frame[] = htmls.map((html, i) => ({
    id: `f-export-${counter}-${i}`,
    canvasId,
    name: `Frame ${i}`,
    x: i * 700,
    y: 0,
    width: 400,
    height: 300,
    html,
    createdAt: 0,
    updatedAt: 1000 + i,
    updatedBy: 'alice',
    pageId: `p-export-${counter}`,
  }))
  const canvas: Canvas = {
    id: canvasId,
    name: 'Export test',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames,
    pages: [{ id: `p-export-${counter}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frames
}

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>.card{color:#111110;padding:16px}</style></head><body>${body}</body></html>`

beforeEach(() => {
  vi.restoreAllMocks()
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
})

describe('buildZip', () => {
  it('produces an archive the system unzip reads back byte for byte', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'doop-zip-'))
    try {
      const archive = buildZip([
        { name: 'README.md', content: '# hello\n', time: Date.UTC(2026, 0, 2, 3, 4, 6) },
        { name: 'frames/01.html', content: '<p>one</p>', time: Date.UTC(2026, 0, 2, 3, 4, 6) },
      ])
      const zipPath = path.join(dir, 'bundle.zip')
      writeFileSync(zipPath, archive)

      const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
      expect(listing).toContain('README.md')
      expect(listing).toContain('frames/01.html')

      execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir])
      expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# hello\n')
      expect(readFileSync(path.join(dir, 'frames/01.html'), 'utf8')).toBe('<p>one</p>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is deterministic for the same entries', () => {
    const entries = [{ name: 'a.txt', content: 'x', time: 1_700_000_000_000 }]
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true)
  })
})

describe('componentName', () => {
  it('turns a frame name into a component identifier', () => {
    expect(componentName('Hero — pricing / v2')).toBe('HeroPricingV2')
    expect(componentName('pricing card')).toBe('PricingCard')
    expect(componentName('3-column grid')).toBe('Frame3ColumnGrid')
    expect(componentName('   ')).toBe('Frame')
  })
})

describe('export_canvas', () => {
  it('returns a manifest naming every frame and the canvas tokens', async () => {
    const frames = seedCanvas([page('<main><h1>A</h1></main>'), page('<main><h1>B</h1></main>')])
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_tokens', {
        canvas_id: frames[0]!.canvasId,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })
      const { parsed, isError } = await callTool(client, 'export_canvas', {
        canvas_id: frames[0]!.canvasId,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.format).toBe('manifest')
      expect(parsed.tokens_css).toContain('--color-ink: #111110;')
      const manifest = parsed.frames as unknown as { id: string; name: string; file: string }[]
      expect(manifest).toHaveLength(2)
      expect(manifest.map((f) => f.id)).toEqual(frames.map((f) => f.id))
      expect(manifest[0]!.file).toMatch(/^01-.*\.html$/)
    } finally {
      await close()
    }
  })

  it('refuses a canvas with nothing on it', async () => {
    seedCanvas([])
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'export_canvas', {
        canvas_id: `${CANVAS_ID}-${counter}`,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(parsed.error).toMatchObject({ code: 'not_found' })
    } finally {
      await close()
    }
  })
})

describe.skipIf(!findBrowserPath())('code handoff over real renders', () => {
  it('converts a frame to a React component with its stylesheet and the tokens', async () => {
    const frames = seedCanvas([
      page(`
        <main class="card">
          <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="A dot" width="20" height="20">
          <h1 style="color:#111110">Title</h1>
        </main>
      `),
    ])
    const canvasId = frames[0]!.canvasId
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_tokens', {
        canvas_id: canvasId,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })
      const { parsed, isError } = await callTool(client, 'export_frame', {
        frame_id: frames[0]!.id,
        format: 'react',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.component_name).toBe('Frame0')
      const jsx = parsed.jsx as unknown as string
      /* the mechanical JSX transforms */
      expect(jsx).toContain('className="card"')
      expect(jsx).toContain('style={{ color: ')
      expect(jsx).toMatch(/<img[^>]*\/>/)
      expect(jsx).toContain('export function Frame0()')
      /* the stylesheet moved out of the markup */
      expect(parsed.css as unknown as string).toContain('.card')
      expect(jsx).not.toContain('<style>.card')
      expect(parsed.tokens_css as unknown as string).toContain('--color-ink: #111110;')
    } finally {
      await close()
    }
  }, 30_000)

  it('returns the stored document verbatim for format html', async () => {
    const frames = seedCanvas([page('<main><h1>As authored</h1></main>')])
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'export_frame', {
        frame_id: frames[0]!.id,
        format: 'html',
        agent_name: 'Claude',
      })
      expect(parsed.format).toBe('html')
      expect(parsed.html).toBe(frames[0]!.html)
    } finally {
      await close()
    }
  }, 30_000)

  it('bundles every frame into one document with scoped styles, and zips it', async () => {
    const frames = seedCanvas([
      page('<main class="card"><h1>One</h1></main>'),
      /* the second frame declares its typeface the way a real design does:
         a webfont sheet and a @font-face rule, neither of which a single HTML
         file can carry on its own */
      page('<main class="card"><h1>Two</h1></main>').replace(
        '</head>',
        '<link rel="stylesheet" href="https://fonts.example.com/inter.css">' +
          '<style>@font-face { font-family: Inter; src: url("https://fonts.example.com/inter.woff2") format("woff2"); }</style>' +
          '</head>',
      ),
    ])
    const canvasId = frames[0]!.canvasId
    const { client, close } = await connect()
    try {
      /* a canvas with a real design system: the export carries it as tokens,
         as a document and as identity files */
      const setTokens = await callTool(client, 'set_tokens', {
        canvas_id: canvasId,
        tokens: {
          colors: { ink: '#111110', paper: '#ffffff' },
          fonts: { body: 'Inter' },
          spacing: [4, 8],
          radii: [8],
          shadows: ['0px 1px 2px rgba(0, 0, 0, 0.2)'],
          type: { size: [16], weight: [600], leading: [1.5] },
        },
        agent_name: 'Claude',
      })
      expect(setTokens.isError).toBeFalsy()
      const html = await callTool(client, 'export_canvas', {
        canvas_id: canvasId,
        format: 'html',
        agent_name: 'Claude',
      })
      expect(html.isError).toBeFalsy()
      const doc = html.parsed.html as unknown as string
      expect(doc).toContain('data-frame="' + frames[0]!.id + '"')
      expect(doc).toContain('data-frame="' + frames[1]!.id + '"')
      expect(doc).toContain('<h1>One</h1>')
      expect(doc).toContain('<h1>Two</h1>')
      /* the shared stylesheet is hoisted once, scoped to each frame */
      expect(doc).toContain(`[data-frame="${frames[0]!.id}"] .card`)
      expect(doc.split('.card {').length - 1).toBe(1)

      const zip = await callTool(client, 'export_canvas', {
        canvas_id: canvasId,
        format: 'zip',
        agent_name: 'Claude',
      })
      expect(zip.isError).toBeFalsy()
      const archive = Buffer.from(zip.parsed.archive_base64 as unknown as string, 'base64')
      expect(archive.length).toBe(zip.parsed.bytes)

      const dir = mkdtempSync(path.join(tmpdir(), 'doop-export-'))
      try {
        const zipPath = path.join(dir, 'canvas.zip')
        writeFileSync(zipPath, archive)
        const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' })
        expect(listing).toContain('canvas.html')
        expect(listing).toContain('README.md')
        expect(listing).toContain('frames/')
        expect(listing).toContain('tokens.dtcg.json')
        expect(listing).toContain('DESIGN.md')
        /* a bundle opened offline renders in the frame's typeface, so the
           fonts travel as their own file */
        expect(listing).toContain('fonts.css')
        expect(listing).toContain('AGENTS.md')
        /* one build spec per frame, rendered from the real document */
        expect(listing).toContain(`specs/01-${frames[0]!.id}.spec.md`)
        execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir])
        /* each frame's original document is in the archive untouched */
        expect(readFileSync(path.join(dir, 'frames', '01-' + frames[0]!.id + '.html'), 'utf8')).toBe(frames[0]!.html)
        expect(readFileSync(path.join(dir, 'canvas.html'), 'utf8')).toContain('<h1>One</h1>')

        /* the tokens travel in the interchange format, not only as our JSON */
        /* groups nest (type.size), so the index is loose and the shape is what
           each assertion pins */
        const dtcg = JSON.parse(readFileSync(path.join(dir, 'tokens.dtcg.json'), 'utf8')) as Record<
          string,
          Record<string, { $type?: string; $value?: unknown; [k: string]: unknown }>
        >
        expect(dtcg.color?.ink).toEqual({ $type: 'color', $value: '#111110' })
        expect(dtcg.space?.['4']).toEqual({ $type: 'dimension', $value: { value: 4, unit: 'px' } })
        expect(dtcg.radius?.['8']).toEqual({ $type: 'dimension', $value: { value: 8, unit: 'px' } })
        expect(dtcg.type?.size?.['16']).toEqual({ $type: 'dimension', $value: { value: 16, unit: 'px' } })
        expect(dtcg.font?.body).toEqual({ $type: 'fontFamily', $value: ['Inter'] })
        /* a shadow the spec's shape can hold is parsed; a hex color and four
           lengths, in the order the spec names them */
        expect(dtcg.shadow?.['1']).toEqual({
          $type: 'shadow',
          $value: {
            color: 'rgba(0, 0, 0, 0.2)',
            offsetX: { value: 0, unit: 'px' },
            offsetY: { value: 1, unit: 'px' },
            blur: { value: 2, unit: 'px' },
          },
        })

        const design = readFileSync(path.join(dir, 'DESIGN.md'), 'utf8')
        /* the normative section order, and the tokens inside it */
        const order = [
          '## Overview',
          '## Colors',
          '## Typography',
          '## Layout',
          '## Elevation & Depth',
          '## Shapes',
          "## Do's and Don'ts",
        ]
        const positions = order.map((heading) => design.indexOf(heading))
        expect(positions.every((at) => at >= 0)).toBe(true)
        expect(positions).toEqual([...positions].sort((a, b) => a - b))
        expect(design).toContain('#111110')
        expect(design).toContain('Inter')

        /* the fonts file carries the sheet the frame linked and its @font-face
           rule, and the bundle inlines the same CSS so canvas.html renders
           offline without it */
        const fonts = readFileSync(path.join(dir, 'fonts.css'), 'utf8')
        expect(fonts).toContain('@import url("https://fonts.example.com/inter.css");')
        expect(fonts).toContain('@font-face')
        expect(fonts).toContain('https://fonts.example.com/inter.woff2')
        const bundled = readFileSync(path.join(dir, 'canvas.html'), 'utf8')
        expect(bundled).toContain('@font-face')
        expect(bundled).toContain('https://fonts.example.com/inter.css')

        const spec = readFileSync(path.join(dir, `specs/01-${frames[0]!.id}.spec.md`), 'utf8')
        expect(spec).toContain(`# ${frames[0]!.name} — build spec`)
        /* measurements, not a screenshot: the values the frame renders at */
        expect(spec).toContain('## Type ramp')
        expect(spec).toContain('32px')
        expect(spec).toContain('## Colors')
        /* the palette the design actually paints, as computed — not the token list */
        expect(spec).toContain('`rgb(17, 17, 16)`')
        /* a frame that was never reviewed says so, rather than implying it passed */
        expect(spec).toContain('No verification report')

        const agents = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
        expect(agents).toContain(canvasId)
        expect(agents).toContain('/mcp')
        expect(agents).toContain('ready_for_review')
        expect(agents).toContain('get_guide')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      await close()
    }
  }, 30_000)

  it('limits the bundle to one page when asked', async () => {
    const frames = seedCanvas([page('<main><h1>One</h1></main>')])
    const canvasId = frames[0]!.canvasId
    const second = actions.createFrame(
      canvasId,
      { name: 'Other page', html: page('<main><h1>Two</h1></main>'), pageId: 'p-export-2' },
      actions.resolveActor({ name: 'alice', kind: 'user' }),
    )
    actions.createPage(canvasId, 'Page 2', actions.resolveActor({ name: 'alice', kind: 'user' }))
    const pages = store.getCanvas(canvasId)!.pages!
    const target = pages[1]!
    actions.moveFrameToPage(second!.id, target.id, actions.resolveActor({ name: 'alice', kind: 'user' }))

    const { client, close } = await connect()
    try {
      const all = await callTool(client, 'export_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect((all.parsed.frames as unknown as unknown[]).length).toBe(2)
      const one = await callTool(client, 'export_canvas', {
        canvas_id: canvasId,
        page: 'Page 2',
        agent_name: 'Claude',
      })
      const manifest = one.parsed.frames as unknown as { id: string }[]
      expect(manifest).toHaveLength(1)
      expect(manifest[0]!.id).toBe(second!.id)
    } finally {
      await close()
    }
  }, 30_000)
})

describe('MCP resources', () => {
  it('publishes the guide, each canvas and its tokens', async () => {
    const frames = seedCanvas([page('<main><h1>A</h1></main>')])
    const canvasId = frames[0]!.canvasId
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_tokens', {
        canvas_id: canvasId,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })

      const { resources } = await client.listResources()
      expect(resources.some((r) => r.uri === 'doop://guide')).toBe(true)

      const templates = await client.listResourceTemplates()
      expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(
        expect.arrayContaining(['doop://canvas/{canvasId}', 'doop://canvas/{canvasId}/tokens']),
      )

      const guide = await client.readResource({ uri: 'doop://guide' })
      const guideText = (guide.contents[0] as { text: string }).text
      expect(guideText.startsWith('# Doop Agent Guide')).toBe(true)

      const canvas = await client.readResource({ uri: `doop://canvas/${canvasId}` })
      const view = JSON.parse((canvas.contents[0] as { text: string }).text) as {
        id: string
        frames: unknown[]
        tokens_present: boolean
      }
      expect(view.id).toBe(canvasId)
      expect(view.frames).toHaveLength(1)
      expect(view.tokens_present).toBe(true)

      const tokens = await client.readResource({ uri: `doop://canvas/${canvasId}/tokens` })
      expect((tokens.contents[0] as { text: string }).text).toContain('--color-ink: #111110;')
    } finally {
      await close()
    }
  }, 30_000)

  it('refuses a canvas the account cannot access', async () => {
    seedCanvas([page('<main><h1>A</h1></main>')])
    const { client, close } = await connect()
    try {
      await expect(client.readResource({ uri: 'doop://canvas/not-mine' })).rejects.toThrow(/no canvas with id not-mine/)
    } finally {
      await close()
    }
  }, 30_000)
})
