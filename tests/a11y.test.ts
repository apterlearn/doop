import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { contrastRatio } from '../server/a11y.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The audit runs against a real headless Chromium (skipped where none is
   installed, like the other browser-backed suites): contrast is computed from
   the composited background the browser actually paints, which is the whole
   point of measuring it instead of eyeballing it. */

vi.mock('../server/db/persist.ts', () => ({
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
}))

const OWNER_ID = 'a11y-owner'
const CANVAS_ID = 'c-a11y'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-a11y-test', version: '1.0.0' })
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

interface Issue {
  rule: string
  severity: string
  selector: string
  value?: string
  expected?: string
}

function seedCanvas(html: string, height = 600): Frame {
  const frame: Frame = {
    id: 'f-a11y',
    canvasId: CANVAS_ID,
    name: 'Audit fixture',
    x: 0,
    y: 0,
    width: 800,
    height,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    pageId: 'p-a11y',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'A11y',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-a11y', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

const page = (body: string, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#ffffff}</style>${head}</head><body>${body}</body></html>`

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

describe('contrastRatio', () => {
  it('computes the WCAG ratio and handles translucency', () => {
    expect(contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)')!.toFixed(2)).toBe('21.00')
    expect(contrastRatio('rgb(255, 255, 255)', 'rgb(255, 255, 255)')!.toFixed(2)).toBe('1.00')
    /* #777 on white: the classic just-under-4.5 body-text case */
    expect(contrastRatio('rgb(119, 119, 119)', 'rgb(255, 255, 255)')!.toFixed(2)).toBe('4.48')
    /* half-transparent black on white composites to mid grey, not to black */
    const midGrey = contrastRatio('rgb(128, 128, 128)', 'rgb(255, 255, 255)')!
    expect(Math.abs(contrastRatio('rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)')! - midGrey)).toBeLessThan(0.1)
    expect(contrastRatio('oklch(0.5 0 0)', 'rgb(255, 255, 255)')).toBeUndefined()
  })
})

describe.skipIf(!findBrowserPath())('audit_frame over a rendered frame', () => {
  it('flags low-contrast text with the ratio, and passes a design that meets the rules', async () => {
    seedCanvas(
      page(`
        <main>
          <h1 style="color:#111110">Dashboard</h1>
          <p style="color:#777777;font-size:16px">Secondary explanation text</p>
          <button style="width:120px;height:40px">Save</button>
        </main>
      `),
    )
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'audit_frame', { frame_id: 'f-a11y', agent_name: 'Claude' })
      expect(isError).toBeFalsy()
      const issues = parsed.issues as unknown as Issue[]
      const contrast = issues.filter((i) => i.rule === 'contrast')
      expect(contrast).toHaveLength(1)
      expect(contrast[0]!.severity).toBe('critical')
      expect(contrast[0]!.value).toBe('4.48')
      expect(contrast[0]!.expected).toBe('4.5')
      expect((parsed.counts as unknown as { critical: number }).critical).toBe(1)
      /* the rest of the design is sound: no alt, heading, focus, landmark or lang noise */
      expect(issues.map((i) => i.rule)).not.toContain('missing_main')
      expect(issues.map((i) => i.rule)).not.toContain('html_lang')
      expect(issues.map((i) => i.rule)).not.toContain('heading_order')
      expect(issues.map((i) => i.rule)).not.toContain('focus_order')
    } finally {
      await close()
    }
  }, 30_000)

  it('passes a clean design with zero critical issues', async () => {
    seedCanvas(
      page(`
        <main>
          <h1 style="color:#111110">Dashboard</h1>
          <p style="color:#444444;font-size:16px">Secondary explanation text</p>
          <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="A chart" width="40" height="40">
          <button style="width:120px;height:40px">Save</button>
        </main>
      `),
    )
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'audit_frame', { frame_id: 'f-a11y', agent_name: 'Claude' })
      expect((parsed.counts as unknown as { critical: number }).critical).toBe(0)
      expect(parsed.issues).toEqual([])
    } finally {
      await close()
    }
  }, 30_000)

  it('flags a missing alt, a skipped heading level and an unlabelled form control', async () => {
    seedCanvas(
      page(`
        <main>
          <h2 style="color:#111110">Section</h2>
          <h4 style="color:#111110">Deep section</h4>
          <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40">
          <input type="text" style="width:200px;height:32px">
        </main>
      `),
    )
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'audit_frame', { frame_id: 'f-a11y', agent_name: 'Claude' })
      const rules = (parsed.issues as unknown as Issue[]).map((i) => i.rule)
      expect(rules).toContain('missing_alt')
      expect(rules).toContain('heading_order')
      expect(rules).toContain('form_label')
    } finally {
      await close()
    }
  }, 30_000)

  it('flags a tap target smaller than 24px and a positive tabindex', async () => {
    seedCanvas(
      page(`
        <main>
          <h1 style="color:#111110">Controls</h1>
          <a href="#x" tabindex="3" style="color:#111110">tiny</a>
        </main>
      `),
    )
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'audit_frame', { frame_id: 'f-a11y', agent_name: 'Claude' })
      const issues = parsed.issues as unknown as Issue[]
      expect(issues.some((i) => i.rule === 'tap_target' && i.expected === '24x24')).toBe(true)
      expect(issues.some((i) => i.rule === 'focus_order' && i.expected === '0 or -1')).toBe(true)
    } finally {
      await close()
    }
  }, 30_000)

  it('reports the audited viewport when a device preset is used', async () => {
    seedCanvas(page('<main><h1 style="color:#111110">Responsive</h1></main>'), 900)
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'audit_frame', {
        frame_id: 'f-a11y',
        device: 'mobile',
        agent_name: 'Claude',
      })
      expect(parsed.viewport).toEqual({ width: 390, height: 844 })
    } finally {
      await close()
    }
  }, 30_000)
})
