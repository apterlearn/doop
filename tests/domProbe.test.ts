import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import sharp from 'sharp'
import { probeFrame, selectInspectionElements, type Probe, type ProbeElement } from '../server/domProbe.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The DOM probe is the shared source of truth for inspect_frame, audit_frame
   and lint_frame, so its selection contract is pinned here: the refactor must
   not change what inspect_frame publishes, and the probe must keep the elements
   the audits need (which is more than inspect_frame shows). */

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
}))

const OWNER_ID = 'probe-owner'
const CANVAS_ID = 'c-probe'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-probe-test', version: '1.0.0' })
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

function seedFrame(html: string): Frame {
  const frame: Frame = {
    id: 'f-probe',
    canvasId: CANVAS_ID,
    name: 'Probe fixture',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    pageId: 'p-probe',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Probe',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-probe', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

function element(over: Partial<ProbeElement> & { tag: string; selector: string; top: number }): ProbeElement {
  return {
    rect: { x: 0, y: over.top, width: 100, height: 40 },
    directText: '',
    text: undefined,
    style: {
      color: 'rgb(0, 0, 0)',
      background: 'rgba(0, 0, 0, 0)',
      effectiveBackground: 'rgb(255, 255, 255)',
      font: 'system-ui',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: 'normal',
      backgroundImage: '',
      borderRadius: '0px',
      margin: '0px',
      padding: '0px',
      gap: 'normal',
    },
    fontSizePx: 16,
    fontWeight: 400,
    opacity: 1,
    attrs: { hiddenFromAT: false, focusable: false, wrappedInLabel: false },
    ...over,
    /* `over` is a Partial, so the spread makes every field optional in the
       inferred type; the required ones are restated to keep the result a
       ProbeElement */
    key: over.key ?? over.selector,
  }
}

function probeOf(elements: ProbeElement[]): Probe {
  return {
    document: {
      title: 'fixture',
      description: '',
      lang: 'en',
      viewportMeta: 'width=device-width, initial-scale=1',
      fonts: [],
      fontsFailed: [],
      width: 800,
      height: 600,
      htmlChars: 100,
    },
    design: { colors: [], backgrounds: [], fonts: [], fontSizes: [], radii: [], shadows: [], cssVariables: {} },
    /* these fixtures exist to pin the geometry rules, which read `elements`
       only; the derived-evidence fields are empty on purpose */
    designEvidence: {
      colors: [],
      backgrounds: [],
      fonts: [],
      fontSizes: [],
      fontWeights: [],
      lineHeights: [],
      leading: [],
      spacing: [],
      radii: [],
      shadows: [],
    },
    content: {
      title: 'fixture',
      description: '',
      headings: [],
      sections: [],
      nav: [],
      ctas: [],
      forms: [],
      images: [],
      truncated: false,
    },
    cssText: '',
    elements,
  }
}

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

describe('selectInspectionElements', () => {
  it('fills the per-category quotas in document order and caps the list at 64', () => {
    const elements: ProbeElement[] = []
    /* 30 paragraphs, 20 headings, 20 buttons: each category exceeds its quota */
    for (let i = 0; i < 30; i += 1) elements.push(element({ tag: 'p', selector: `#p${i}`, top: 1000 + i }))
    for (let i = 0; i < 20; i += 1) elements.push(element({ tag: 'h2', selector: `#h${i}`, top: 500 + i }))
    for (let i = 0; i < 20; i += 1) elements.push(element({ tag: 'button', selector: `#b${i}`, top: 2000 + i }))
    const selected = selectInspectionElements(probeOf(elements))

    expect(selected).toHaveLength(64)
    /* every category is served its quota before the fill pass runs */
    expect(selected.filter((el) => el.tag === 'h2').length).toBeGreaterThanOrEqual(16)
    expect(selected.filter((el) => el.tag === 'button')).toHaveLength(16)
    expect(selected.filter((el) => el.tag === 'p').length).toBeGreaterThanOrEqual(14)
    /* the remainder fills from whatever is left — each category is still
       emitted in document order, which is what an agent reads it as */
    for (const tag of ['h2', 'button', 'p']) {
      const tops = selected.filter((el) => el.tag === tag).map((el) => el.rect.y)
      expect(tops, `${tag} should stay in document order`).toEqual([...tops].sort((a, b) => a - b))
    }
  })

  it('orders by document position and truncates long text at 180 characters', () => {
    const long = 'x'.repeat(400)
    const selected = selectInspectionElements(
      probeOf([
        element({ tag: 'h1', selector: '#second', top: 200, text: 'Second' }),
        element({ tag: 'h1', selector: '#first', top: 100, text: long }),
      ]),
    )
    expect(selected.map((el) => el.selector)).toEqual(['#first', '#second'])
    expect(selected[0]!.text).toHaveLength(180)
    expect(selected[0]!.text!.endsWith('…')).toBe(true)
  })

  it('publishes exactly the documented element fields', () => {
    const selected = selectInspectionElements(
      probeOf([element({ tag: 'h1', selector: '#t', top: 10, text: 'Title', role: 'heading' })]),
    )
    expect(Object.keys(selected[0]!)).toEqual(['selector', 'key', 'tag', 'role', 'text', 'rect', 'style'])
    expect(Object.keys(selected[0]!.style)).toEqual(['color', 'background', 'font', 'fontSize', 'fontWeight'])
    expect(selected[0]!.role).toBe('heading')
  })
})

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui}</style></head><body>${body}</body></html>`

describe.skipIf(!findBrowserPath())('probeFrame over a real render', () => {
  it('keeps the interactive elements the audits need, beyond inspect_frame’s sample', async () => {
    const buttons = Array.from({ length: 90 }, (_, i) => `<button style="width:120px;height:40px">B${i}</button>`).join(
      '',
    )
    const frame = seedFrame(page(`<main>${buttons}</main>`))

    const probe = await probeFrame(frame)
    /* the probe is not a semantic sample: every button is there */
    expect(probe.elements.filter((el) => el.tag === 'button')).toHaveLength(90)

    /* while inspect_frame still shows a bounded, category-quota'd sample */
    expect(selectInspectionElements(probe)).toHaveLength(64)
    expect(probe.elements.length).toBeGreaterThan(selectInspectionElements(probe).length)
  }, 30_000)

  it('renders at a viewport override and reports it as the document size', async () => {
    const frame = seedFrame(page('<main><h1>Wide</h1></main>'))
    const narrow = await probeFrame(frame, { viewport: { width: 390, height: 844 } })
    expect(narrow.document.width).toBe(390)
    expect(narrow.document.height).toBe(844)
    const wide = await probeFrame(frame)
    expect(wide.document.width).toBe(800)
  }, 30_000)

  it('inspect_frame publishes exactly what the selection function produces', async () => {
    const frame = seedFrame(
      page(`
        <header><h1>Title</h1></header>
        <main>
          <p>Body copy</p>
          <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="A dot" width="20" height="20">
          <button>Act</button>
        </main>
      `),
    )
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'inspect_frame', { frame_id: frame.id, agent_name: 'Claude' })
      expect(isError).toBeFalsy()
      const expected = selectInspectionElements(await probeFrame(frame))
      expect(parsed.elements).toEqual(expected)
      expect(parsed.document).toMatchObject({ width: 800, height: 600, title: '' })
      /* the design summary is the probe's, untouched */
      expect(Array.isArray((parsed.design as unknown as { colors: string[] }).colors)).toBe(true)
    } finally {
      await close()
    }
  }, 30_000)

  it('renders a screenshot at the requested device size', async () => {
    const frame = seedFrame(page('<main><h1>Responsive</h1></main>'))
    const { client, close } = await connect()
    try {
      const result = (await client.callTool({
        name: 'get_frame_screenshot',
        arguments: { frame_id: frame.id, device: 'mobile', agent_name: 'Claude' },
      })) as unknown as { content: Array<{ type: string; data?: string; text?: string }>; isError?: boolean }
      expect(result.isError).toBeFalsy()
      const image = result.content.find((block) => block.type === 'image')!
      const meta = await sharp(Buffer.from(image.data!, 'base64')).metadata()
      expect([meta.width, meta.height]).toEqual([390, 844])
      expect(result.content.some((block) => block.text?.includes('390×844'))).toBe(true)

      /* an explicit viewport overrides the preset, and the frame's own size is the default */
      const explicit = (await client.callTool({
        name: 'get_frame_screenshot',
        arguments: { frame_id: frame.id, viewport: { width: 500, height: 400 }, agent_name: 'Claude' },
      })) as unknown as { content: Array<{ type: string; data?: string }> }
      const explicitMeta = await sharp(
        Buffer.from(explicit.content.find((b) => b.type === 'image')!.data!, 'base64'),
      ).metadata()
      expect([explicitMeta.width, explicitMeta.height]).toEqual([500, 400])
    } finally {
      await close()
    }
  }, 30_000)

  it('inspects at a device preset when asked', async () => {
    const frame = seedFrame(page('<main><h1>Responsive</h1></main>'))
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'inspect_frame', {
        frame_id: frame.id,
        device: 'tablet',
        agent_name: 'Claude',
      })
      expect(parsed.document).toMatchObject({ width: 834, height: 1112 })
    } finally {
      await close()
    }
  }, 30_000)

  it('renders an interaction state the frame only shows while hovered', async () => {
    const frame = seedFrame(
      page(
        '<style>.btn{display:block;width:120px;height:40px;background:#ffffff}.btn:hover{background:#ff0000}</style><button class="btn">Buy</button>',
      ),
    )
    const { client, close } = await connect()
    const shot = async (args: Record<string, unknown>) => {
      const result = (await client.callTool({
        name: 'get_frame_screenshot',
        arguments: { frame_id: frame.id, agent_name: 'Claude', ...args },
      })) as unknown as { content: Array<{ type: string; data?: string; text?: string }>; isError?: boolean }
      return result
    }
    try {
      const resting = await shot({})
      const hovered = await shot({ state: { selector: '.btn', pseudo: 'hover' } })
      expect(hovered.isError).toBeFalsy()
      /* the forced state is the frame's own :hover rule, not an injected style:
         the button's own pixels are red in one render and white in the other.
         `stats()` reads its input and ignores pipeline operations, so the crop
         is materialised before measuring it. */
      const buttonMean = async (result: typeof resting) => {
        const png = Buffer.from(result.content.find((block) => block.type === 'image')!.data!, 'base64')
        const cropped = await sharp(png).extract({ left: 6, top: 6, width: 20, height: 8 }).png().toBuffer()
        return (await sharp(cropped).stats()).channels.map((channel) => channel.mean)
      }
      const restingMean = await buttonMean(resting)
      const hoveredMean = await buttonMean(hovered)
      expect(restingMean[0]).toBeGreaterThan(240)
      expect(hoveredMean[0]).toBeGreaterThan(200)
      expect(hoveredMean[1]).toBeLessThan(60)
      expect(hoveredMean[2]).toBeLessThan(60)
      expect(hovered.content.some((block) => block.text?.includes('hover on .btn'))).toBe(true)

      /* a selector that matches nothing is a typed refusal, not a blank image */
      const missing = await shot({ state: { selector: '.nope', pseudo: 'hover' } })
      expect(missing.isError).toBe(true)
      expect(missing.content.some((block) => block.text?.includes('no element matches'))).toBe(true)

      /* audit_frame takes the same state, so a contrast problem that exists
         only while hovered is measurable instead of guessed at */
      const audit = await callTool(client, 'audit_frame', {
        frame_id: frame.id,
        state: { selector: '.btn', pseudo: 'hover' },
        agent_name: 'Claude',
      })
      expect(audit.isError).toBeFalsy()
      expect(audit.parsed.state).toBe('hover on .btn')
    } finally {
      await close()
    }
  }, 30_000)
})
