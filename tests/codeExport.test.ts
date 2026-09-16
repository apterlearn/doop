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
import { componentName, handoffFiles } from '../server/codeExport.ts'
import { initDb, closeDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { CanvasRelease } from '../server/db/persist.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Handoff: the archive is verified by unzipping it with the system tool (a ZIP
   that only our own reader accepts is not a ZIP), the React conversion against
   a real render, and the manifest without a browser. */

vi.mock('../server/db/persist.ts', async () => {
  /* The release accessors keep their real implementation: the handoff tests
     seed a release in the database and read it back, so a stub would only
     prove the stub. Every other write stays a no-op — the store persists
     fire-and-forget, and that must not reach the test's database. */
  const actual = await vi.importActual<typeof persist>('../server/db/persist.ts')
  return {
    getUserEmail: async () => undefined,
    getNotificationPrefs: async () => new Map(),
    saveNotificationPref: () => {},
    pruneRunEvents: () => {},
    saveRunEvent: () => {},
    saveQuestion: () => {},
    saveFrameProposal: () => {},
    hydrate: () => {},
    saveCanvas: () => {},
    saveCanvasCopy: () => {},
    saveFrame: () => {},
    saveComponent: () => {},
    deleteFrame: () => {},
    savePage: () => {},
    deletePage: () => {},
    setFramePage: () => {},
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
    /* the export reads a frame's newest verification report into its spec */
    listFrameReviews: async () => [],
    saveRelease: actual.saveRelease,
    getRelease: actual.getRelease,
    releaseFrames: actual.releaseFrames,
    deleteComponentRow: () => {},
    freezeFrames: () => [],
    MAX_CANVAS_VERSIONS: 50,
    saveCanvasVersion: () => {},
    listCanvasVersions: async () => [],
    getCanvasVersion: async () => undefined,
    summarizeCanvasVersion: () => ({ id: '', cause: 'auto', createdAt: 0, createdBy: '', frameCount: 0 }),
    deleteCanvasVersion: () => {},
    pruneCanvasVersions: () => {},
    restoreFrameRow: () => {},
    restoreCanvasRow: () => {},
    hardDeleteFrame: () => {},
    hardDeleteCanvas: () => {},
    purgeTrash: () => {},
    TRASH_RETENTION_DAYS: 30,
  }
})

const OWNER_ID = 'export-owner'
const CANVAS_ID = 'c-export'

/* The export's manifest/html/tokens forms store nothing, but the zip form
   stores its archive and the export_frame image branch needs a working
   asset/database layer; boot the real one as the server does. */
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
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
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
        /* this test is about what is INSIDE the archive; the default form
           hands back a zip_url instead of the bytes (mcpCapabilities.test.ts
           covers that), so ask for the inline archive to unzip it here */
        inline: true,
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

describe('handoffFiles', () => {
  it('refuses a canvas that is not there, and a release that is not its own', async () => {
    const frames = seedCanvas([page('<main><h1>A</h1></main>')])
    await expect(handoffFiles('not-a-canvas')).rejects.toMatchObject({ code: 'not_found' })
    await expect(handoffFiles(frames[0]!.canvasId, { releaseId: 'not-a-release' })).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('leaves out the frames of a page that was not asked for', async () => {
    /* nothing on the requested page, so nothing renders and this needs no
       browser: what it proves is the filter and that the handoff is still a
       handoff without frames */
    const frames = seedCanvas([page('<main><h1>One</h1></main>'), page('<main><h1>Two</h1></main>')])
    const bundle = await handoffFiles(frames[0]!.canvasId, { pageId: 'p-somewhere-else' })
    expect(bundle.files.map((file) => file.path).filter((path) => path.startsWith('design/frame-'))).toEqual([])
    expect(bundle.files.map((file) => file.path)).toContain('design/DESIGN.md')
    expect(bundle.pr.body).toContain('0 frame(s) exported')
  })
})

/* The JSX and the specs come from a real render, so the file set itself is only
   asserted when a browser exists; the naming and the refusal paths above are
   not. */
describe.skipIf(!findBrowserPath())('handoffFiles over real renders', () => {
  it('writes the design/ file set, with the canvas library and what it designs for', async () => {
    const frames = seedCanvas([page('<main><h1>One</h1></main>'), page('<main><h1>Two</h1></main>')])
    const canvasId = frames[0]!.canvasId
    const alice = actions.resolveActor({ name: 'alice', kind: 'user' })
    store.setTokens(
      canvasId,
      {
        colors: { ink: '#111110' },
        spacing: [4, 8],
        type: { size: [16], weight: [600], leading: [1.5] },
        updatedAt: 0,
        updatedBy: 'alice',
      },
      'alice',
    )
    store.setBreakpoints(
      canvasId,
      [
        { name: 'mobile', min_width: 390 },
        { name: 'desktop', min_width: 1280 },
      ],
      'alice',
    )
    actions.createComponent(
      canvasId,
      {
        name: 'Pricing card',
        description: 'The plan tile',
        html: page('<div class="card">Card</div>'),
        width: 320,
        height: 480,
      },
      alice,
    )

    const bundle = await handoffFiles(canvasId)
    const paths = bundle.files.map((file) => file.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'design/frame-0.html',
        'design/frame-0.jsx',
        'design/frame-0.spec.md',
        'design/frame-1.html',
        'design/frame-1.jsx',
        'design/frame-1.spec.md',
        'design/components/pricing-card.jsx',
        'design/tokens.css',
        'design/tokens.dtcg.json',
        'design/tailwind.css',
        'design/DESIGN.md',
        'design/AGENTS.md',
        'design/README.md',
      ]),
    )
    const byPath = new Map<string, string>(bundle.files.map((entry) => [entry.path, entry.content]))
    expect(byPath.get('design/frame-0.html')).toContain('<h1>One</h1>')
    expect(byPath.get('design/frame-0.jsx')).toContain('export function Frame0')
    expect(byPath.get('design/frame-0.spec.md')).toContain('# Frame 0 — build spec')
    /* the exported theme carries the names a frame is authored against */
    expect(byPath.get('design/tailwind.css')).toContain('--space-8: 8px;')
    expect(byPath.get('design/tailwind.css')).toContain('--weight-600: 600;')
    /* DESIGN.md says what the canvas reuses and what it designs for */
    const design = byPath.get('design/DESIGN.md')!
    expect(design).toContain('## Components')
    expect(design).toContain('Pricing card')
    expect(design).toContain('`design/components/pricing-card.jsx`')
    expect(design).toContain('Breakpoints: mobile from 390px, desktop from 1280px')
    expect(bundle.pr.title).toBe('Design handoff: Export test')
    expect(bundle.pr.body).toContain(canvasId)
    expect(bundle.pr.body).toContain('2 frame(s) exported')
    expect(bundle.pr.body).toContain('`design/components/pricing-card.jsx`')
  }, 60_000)

  it('exports the frozen release instead of the live edits', async () => {
    const frames = seedCanvas([page('<main><h1>One</h1></main>')])
    const canvasId = frames[0]!.canvasId
    const alice = actions.resolveActor({ name: 'alice', kind: 'user' })
    const release: CanvasRelease = {
      id: 'rel-export-1',
      canvasId,
      name: 'v1',
      frames: [
        {
          id: frames[0]!.id,
          name: 'Home',
          width: 1440,
          height: 900,
          x: 0,
          y: 0,
          html: page('<main><h1>Frozen</h1></main>'),
          z: 0,
          locked: false,
          hidden: false,
          rotation: 0,
          opacity: 1,
        },
      ],
      tokens: { colors: { ink: '#000000' }, updatedAt: 0, updatedBy: 'alice' },
      createdAt: Date.now(),
      createdBy: 'alice',
    }
    await persist.saveRelease(release)
    /* the canvas moves on after the release: a rename, an edit, a new palette */
    actions.updateFrame(frames[0]!.id, { name: 'Live edit', html: page('<main><h1>Live edit</h1></main>') }, alice)
    store.setTokens(canvasId, { colors: { ink: '#ffffff' }, updatedAt: 0, updatedBy: 'alice' }, 'alice')

    const bundle = await handoffFiles(canvasId, { releaseId: release.id })
    const paths = bundle.files.map((file) => file.path)
    expect(paths).toContain('design/home.html')
    expect(paths).not.toContain('design/live-edit.html')
    const html = bundle.files.find((file) => file.path === 'design/home.html')!.content
    expect(html).toContain('Frozen')
    expect(html).not.toContain('Live edit')
    /* the tokens as they were frozen, not the canvas's current ones */
    const tokensCss = bundle.files.find((file) => file.path === 'design/tokens.css')!.content
    expect(tokensCss).toContain('--color-ink: #000000;')
    expect(tokensCss).not.toContain('#ffffff')
    /* and the PR body points at the link a reviewer was sent */
    expect(bundle.pr.body).toContain(`/p/${canvasId}/${release.id}`)
    expect(bundle.pr.body).toContain('frozen release')
  }, 60_000)
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
