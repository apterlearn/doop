import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Context acquisition: what an agent reads before it designs. The frame is
   rendered for real, because the whole point of these tools is that they report
   what the page actually looks like rather than what its source claims. */

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

const OWNER_ID = 'context-owner'
const CANVAS_ID = 'c-context'
const browser = findBrowserPath()

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-context-test', version: '1.0.0' })
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

const SITE = `<!doctype html>
<html lang="en"><head>
  <title>Acme — pricing</title>
  <meta name="description" content="Simple pricing for teams.">
  <style>
    :root { --brand-ink: #111110; --brand-accent: rgb(255, 107, 61); }
    body { font-family: Inter, sans-serif; color: rgb(17, 17, 16); background: #ffffff; margin: 0; }
    h1 { font-size: 40px; font-weight: 700; line-height: 48px; margin: 0 0 24px; }
    h2 { font-size: 20px; font-weight: 600; line-height: 30px; margin: 0 0 16px; }
    p { font-size: 16px; font-weight: 400; line-height: 24px; margin: 0 0 16px; }
    a.cta { color: rgb(255, 107, 61); font-size: 16px; }
    .card { border-radius: 12px; padding: 24px; }
  </style>
</head><body>
  <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
  <main>
    <section id="hero"><h1>Pricing that scales</h1><p>Simple, predictable, per seat.</p>
      <a class="cta" href="/signup">Start free</a></section>
    <section id="plans" class="card"><h2>Pro</h2><p>$20 per seat.</p>
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="A chart" width="1" height="1">
      <form><label for="email">Work email</label><input id="email" name="email" type="email"></form>
    </section>
  </main>
</body></html>`

function seedFrame(html = SITE): Frame {
  const frame: Frame = {
    id: 'f-context',
    canvasId: CANVAS_ID,
    name: 'Acme pricing',
    x: 0,
    y: 0,
    width: 1200,
    height: 900,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    pageId: 'p-context',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Context',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-context', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
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
    plans: new Map(),
  })
  seedFrame()
})

describe.skipIf(!browser)('get_frame_content', () => {
  it('separates what the page says from how it looks', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_frame_content', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-context',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.title).toBe('Acme — pricing')
      expect(parsed.description).toBe('Simple pricing for teams.')
      const headings = parsed.headings as unknown as { level: number; text: string }[]
      expect(headings.map((h) => `${h.level}:${h.text}`)).toEqual(['1:Pricing that scales', '2:Pro'])
      expect((parsed.nav as unknown as { text: string }[]).map((l) => l.text)).toEqual(['Home', 'Pricing'])
      const ctas = parsed.ctas as unknown as { text: string; href: string }[]
      expect(ctas.find((c) => c.text === 'Start free')?.href).toBe('/signup')
      const forms = parsed.forms as unknown as { fields: { label: string; type: string }[] }[]
      expect(forms[0]?.fields[0]).toMatchObject({ label: 'Work email', type: 'email' })
      const images = parsed.images as unknown as { alt: string }[]
      expect(images[0]?.alt).toBe('A chart')
      expect(parsed.truncated).toBe(false)
    } finally {
      await close()
    }
  })
})

describe.skipIf(!browser)('extract_design_system', () => {
  it('derives the palette, type and scales from the rendered frame, and only applies when asked', async () => {
    const { client, close } = await connect()
    try {
      const read = await callTool(client, 'extract_design_system', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-context',
        agent_name: 'Claude',
      })
      expect(read.isError).toBeFalsy()
      const tokens = read.parsed.tokens as unknown as {
        colors: Record<string, string>
        fonts: Record<string, string>
        type: { size: number[]; weight: number[]; leading: number[] }
        spacing: number[]
        radii: number[]
      }
      /* the palette is named after the variables the page declared */
      expect(tokens.colors['brand-ink']).toBe('#111110')
      expect(tokens.colors['brand-accent']).toBe('#ff6b3d')
      expect(tokens.fonts.body).toBe('Inter')
      /* the authored ramp; the form control's UA-default size (13.3333px)
         is real evidence too and rides along with its usage count */
      expect(tokens.type.size).toEqual(expect.arrayContaining([16, 20, 40]))
      expect(tokens.type.weight).toEqual([400, 600, 700])
      expect(tokens.type.leading).toEqual([1.2, 1.5])
      expect(tokens.spacing).toContain(24)
      expect(tokens.radii).toEqual([12])
      expect(read.parsed.applied).toBe(false)
      /* a read leaves the canvas alone */
      expect(store.getCanvas(CANVAS_ID)!.tokens).toBeUndefined()
      /* the markdown is the canvas's design system as a document: what it
         carries is the palette and the type ramp, not a fixed heading */
      const markdown = String(read.parsed.markdown)
      expect(markdown).toContain('Acme pricing')
      expect(markdown).toContain('#111110')
      expect(markdown).toContain('Inter')

      const applied = await callTool(client, 'extract_design_system', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-context',
        apply: true,
        agent_name: 'Claude',
      })
      expect(applied.parsed.applied).toBe(true)
      expect(store.getCanvas(CANVAS_ID)!.tokens?.colors['brand-ink']).toBe('#111110')
      expect(store.getGuidelines(CANVAS_ID).map((g) => g.name)).toContain('design-system')
    } finally {
      await close()
    }
  })

  it('requires exactly one source', async () => {
    const { client, close } = await connect()
    try {
      const neither = await callTool(client, 'extract_design_system', {
        canvas_id: CANVAS_ID,
        agent_name: 'Claude',
      })
      expect(neither.isError).toBe(true)
      const both = await callTool(client, 'extract_design_system', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-context',
        url: 'example.com',
        agent_name: 'Claude',
      })
      expect(both.isError).toBe(true)
      expect((both.parsed.error as unknown as { code: string }).code).toBe('invalid_input')
    } finally {
      await close()
    }
  })

  it('reports a font that did not load instead of measuring its fallback silently', async () => {
    seedFrame(
      `<!doctype html><html><head>
        <style>body { font-family: "Definitely Not Installed", sans-serif; font-size: 16px; }</style>
      </head><body><p>Text in a missing face.</p></body></html>`,
    )
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'extract_design_system', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-context',
        agent_name: 'Claude',
      })
      expect((parsed.notes as unknown as string[]).join(' ')).toContain('Definitely Not Installed')
    } finally {
      await close()
    }
  })
})
