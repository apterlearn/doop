import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { colorDistance, cssForTokens, lintProbe, validateTokens } from '../server/designLint.ts'
import type { Probe, ProbeElement } from '../server/domProbe.ts'
import type { Canvas, DesignTokens, Frame } from '../shared/types.ts'

/* Design tokens: validation and CSS rendering are pure, so they are pinned
   directly; the tools are exercised over the real store, with a real browser
   for the lint where one is installed. */

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
}))

const OWNER_ID = 'tokens-owner'
const CANVAS_ID = 'c-tokens'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-tokens-test', version: '1.0.0' })
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

function seedCanvas(): Frame {
  const frame: Frame = {
    id: 'f-tokens',
    canvasId: CANVAS_ID,
    name: 'Fixture',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html: '<main><h1>Hi</h1></main>',
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    pageId: 'p-tokens',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Tokens',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-tokens', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

function element(over: Partial<ProbeElement> & { selector: string }): ProbeElement {
  return {
    tag: 'div',
    top: 0,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    directText: '',
    style: {
      color: 'rgb(17, 17, 16)',
      background: 'rgba(0, 0, 0, 0)',
      effectiveBackground: 'rgb(255, 255, 255)',
      font: 'system-ui',
      fontSize: '16px',
      fontWeight: '400',
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
  }
}

function probeOf(elements: ProbeElement[]): Probe {
  return {
    document: { title: '', lang: 'en', width: 800, height: 600, htmlChars: 10 },
    design: { colors: [], backgrounds: [], fonts: [], fontSizes: [], radii: [], shadows: [], cssVariables: {} },
    elements,
  }
}

const tokens = (over: Partial<DesignTokens> = {}): DesignTokens => ({
  colors: { ink: '#111110', paper: '#ffffff' },
  fonts: { display: 'Fraunces', body: 'Inter' },
  spacing: [4, 8, 16, 24],
  radii: [0, 8, 16],
  updatedAt: 0,
  updatedBy: 'alice',
  ...over,
})

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
  seedCanvas()
})

describe('token validation and rendering', () => {
  it('accepts a well-formed set and rejects each malformed field by name', () => {
    expect(() => validateTokens(tokens())).not.toThrow()

    expect(() => validateTokens(tokens({ colors: { Ink: '#111110' } }))).toThrow(/invalid color token name “Ink”/)
    expect(() => validateTokens(tokens({ colors: { ink: 'brandish' } }))).toThrow(/invalid color for token “ink”/)
    expect(() => validateTokens(tokens({ fonts: { body: '  ' } }))).toThrow(/fonts.body is empty/)
    expect(() => validateTokens(tokens({ spacing: [4, -8] }))).toThrow(/invalid spacing value -8/)
    expect(() => validateTokens(tokens({ radii: [8, Number.NaN] }))).toThrow(/invalid radii value NaN/)
    expect(() => validateTokens(tokens({ shadows: ['soft and dreamy'] }))).toThrow(/invalid shadow/)
    expect(() => validateTokens(tokens({ spacing: Array.from({ length: 13 }, (_, i) => i + 1) }))).toThrow(
      /the limit is 12/,
    )
  })

  it('renders the tokens as a :root block', () => {
    const css = cssForTokens(tokens({ shadows: ['0 1px 2px rgba(0,0,0,.2)'] }))
    expect(css).toContain('--color-ink: #111110;')
    expect(css).toContain('--color-paper: #ffffff;')
    expect(css).toContain('--font-display: Fraunces;')
    expect(css).toContain('--space-16: 16px;')
    expect(css).toContain('--radius-8: 8px;')
    expect(css).toContain('--shadow-1: 0 1px 2px rgba(0,0,0,.2);')
    expect(css.startsWith(':root {')).toBe(true)
    expect(css.trimEnd().endsWith('}')).toBe(true)
  })

  it('measures perceptual color distance', () => {
    expect(colorDistance('#111110', '#111110')).toBe(0)
    expect(colorDistance('#111110', '#121212')!).toBeLessThan(3)
    expect(colorDistance('#111110', '#ff0000')!).toBeGreaterThan(50)
    expect(colorDistance('oklch(0.5 0 0)', '#fff')).toBeUndefined()
  })
})

describe('lintProbe', () => {
  it('reports nothing when the canvas has no tokens', () => {
    const report = lintProbe(probeOf([element({ selector: '#a' })]), undefined)
    expect(report.tokens_present).toBe(false)
    expect(report.violations).toEqual([])
    expect(report.counts.off_token_color).toBe(0)
  })

  it('flags an off-token color, font, radius and spacing, naming the nearest token', () => {
    const report = lintProbe(
      probeOf([
        element({
          selector: '#a',
          style: {
            ...element({ selector: '#a' }).style,
            color: 'rgb(51, 51, 51)',
            font: '"Comic Sans MS", cursive',
            borderRadius: '7px',
            padding: '0px 13px 0px 13px',
            margin: '0px',
          },
        }),
      ]),
      tokens(),
    )
    expect(report.tokens_present).toBe(true)
    expect(report.counts.off_token_color).toBe(1)
    expect(report.violations.find((v) => v.rule === 'off_token_color')).toMatchObject({
      selector: '#a',
      value: 'rgb(51, 51, 51)',
      expected: 'ink',
    })
    expect(report.violations.find((v) => v.rule === 'off_token_font')?.value).toBe('comic sans ms')
    expect(report.violations.find((v) => v.rule === 'off_scale_radius')?.expected).toContain('8px')
    expect(report.violations.filter((v) => v.rule === 'off_grid_spacing').map((v) => v.value)).toEqual([
      'padding: 13px',
      'padding: 13px',
    ])
  })

  it('accepts values that are on the tokens, including near-identical colors', () => {
    const report = lintProbe(
      probeOf([
        element({
          selector: '#ok',
          style: {
            ...element({ selector: '#ok' }).style,
            color: 'rgb(18, 18, 17)',
            font: 'Fraunces, serif',
            borderRadius: '8px',
            padding: '16px',
            margin: '0px 24px 4px 8px',
            gap: '8px',
          },
        }),
      ]),
      tokens(),
    )
    expect(report.violations).toEqual([])
    expect(report.counts).toEqual({
      off_token_color: 0,
      off_token_font: 0,
      off_scale_radius: 0,
      off_grid_spacing: 0,
    })
  })

  it('skips elements hidden from assistive tech', () => {
    const report = lintProbe(
      probeOf([
        element({
          selector: '#hidden',
          style: { ...element({ selector: '#hidden' }).style, color: 'rgb(255, 0, 0)' },
          attrs: { hiddenFromAT: true, focusable: false, wrappedInLabel: false },
        }),
      ]),
      tokens(),
    )
    expect(report.violations).toEqual([])
  })
})

describe('token tools', () => {
  it('round-trips tokens through set_tokens and get_tokens with the :root block', async () => {
    const { client, close } = await connect()
    try {
      const before = await callTool(client, 'get_tokens', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(before.parsed.tokens).toBeNull()
      expect(before.parsed.css).toBe('')

      const set = await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { ink: '#111110' }, spacing: [4, 8, 16], fonts: { body: 'Inter' } },
        agent_name: 'Claude',
      })
      expect(set.isError).toBeFalsy()
      expect(set.parsed.css).toContain('--color-ink: #111110;')
      expect((set.parsed.tokens as unknown as DesignTokens).updatedBy).toBe('Claude')

      const after = await callTool(client, 'get_tokens', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect((after.parsed.tokens as unknown as DesignTokens).colors).toEqual({ ink: '#111110' })
      expect(after.parsed.updated_by).toBe('Claude')

      /* merge keeps what is there */
      const merged = await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { paper: '#ffffff' } },
        merge: true,
        agent_name: 'Claude',
      })
      expect((merged.parsed.tokens as unknown as DesignTokens).colors).toEqual({ ink: '#111110', paper: '#ffffff' })
      expect((merged.parsed.tokens as unknown as DesignTokens).spacing).toEqual([4, 8, 16])
    } finally {
      await close()
    }
  })

  it('rejects an invalid token set as invalid_input without touching the stored tokens', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })
      const bad = await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { Ink: '#zz' } },
        agent_name: 'Claude',
      })
      expect(bad.isError).toBe(true)
      expect(bad.parsed.error).toMatchObject({ code: 'invalid_input' })
      expect(String((bad.parsed.error as unknown as { message: string }).message)).toContain('invalid color token name')
      expect(store.getCanvas(CANVAS_ID)!.tokens!.colors).toEqual({ ink: '#111110' })
    } finally {
      await close()
    }
  })

  it('reports token presence on get_canvas and nudges toward them', async () => {
    const { client, close } = await connect()
    try {
      const without = await callTool(client, 'get_canvas', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(without.parsed.tokens_present).toBe(false)

      await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })
      const withTokens = await callTool(client, 'get_canvas', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(withTokens.parsed.tokens_present).toBe(true)
      expect(String(withTokens.parsed.note)).toContain('get_tokens')
    } finally {
      await close()
    }
  })

  it('broadcasts a token change to the room', async () => {
    const messages: { type: string }[] = []
    actions.wire(
      (_canvasId, msg) => messages.push(msg as { type: string }),
      () => {},
    )
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })
      expect(messages.map((m) => m.type)).toContain('tokens')
    } finally {
      await close()
    }
  })
})

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui}</style></head><body>${body}</body></html>`

describe.skipIf(!findBrowserPath())('lint_frame over a real render', () => {
  it('flags an off-token color and clears once the frame uses the token', async () => {
    const frame = seedCanvas()
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_tokens', {
        canvas_id: CANVAS_ID,
        tokens: { colors: { ink: '#111110' } },
        agent_name: 'Claude',
      })

      actions.updateFrame(
        frame.id,
        { html: page('<h1 style="color:#ff0000">Wrong</h1>') },
        actions.resolveActor({ name: 'alice', kind: 'user' }),
      )
      const dirty = await callTool(client, 'lint_frame', { frame_id: frame.id, agent_name: 'Claude' })
      const colorViolations = (dirty.parsed.violations as unknown as { rule: string; expected: string }[]).filter(
        (v) => v.rule === 'off_token_color',
      )
      expect(colorViolations.length).toBeGreaterThan(0)
      expect(colorViolations[0]!.expected).toBe('ink')

      actions.updateFrame(
        frame.id,
        { html: page('<h1 style="color:#111110">Right</h1>') },
        actions.resolveActor({ name: 'alice', kind: 'user' }),
      )
      const clean = await callTool(client, 'lint_frame', { frame_id: frame.id, agent_name: 'Claude' })
      expect(clean.parsed.tokens_present).toBe(true)
      expect((clean.parsed.violations as unknown as unknown[]).length).toBe(0)
    } finally {
      await close()
    }
  }, 30_000)

  it('says so when the canvas has no tokens instead of inventing a scale', async () => {
    const frame = seedCanvas()
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'lint_frame', { frame_id: frame.id, agent_name: 'Claude' })
      expect(parsed.tokens_present).toBe(false)
      expect(parsed.violations).toEqual([])
    } finally {
      await close()
    }
  }, 30_000)
})
