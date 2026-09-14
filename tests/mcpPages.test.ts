import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame, Page } from '../shared/types.ts'

/* Page MCP tools (create_page, rename_page, delete_page, move_frame,
   duplicate_frame) run against the real store + actions machinery — persist
   is stubbed to no-ops and broadcasts are dropped, everything else is real. */
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

const OWNER_ID = 'owner-1'

interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

async function connect(ownerId: string | undefined = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-pages-test', version: '1.0.0' })
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

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: unknown; raw: string; content: CallResult['content']; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* error strings are not JSON — leave the raw text for assertions */
  }
  return { parsed, raw, content: result.content, isError: result.isError }
}

let counter = 0

function makeFrame(canvasId: string, pageId: string, name: string, over: Partial<Frame> = {}): Frame {
  counter += 1
  return {
    id: `f-${counter}`,
    canvasId,
    name,
    html: `<p>${name}</p>`,
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'alice',
    pageId,
    ...over,
  }
}

/* A fresh canvas seeded straight into the real store: pages built from the
   given names ("Page 1" always exists — the boot invariant), frames added
   after the fact. Unique canvas ids keep tests isolated — the store is a
   singleton shared by the whole file. */
function seedCanvas<const T extends readonly string[]>(
  pageNames: T = ['Page 1'] as unknown as T,
): { canvas: Canvas; pages: { [K in keyof T]: Page } } {
  counter += 1
  const canvas: Canvas = {
    id: `c-${counter}`,
    name: `Canvas ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: pageNames.map((name, i) => ({
      id: `p-${counter}-${i}`,
      canvasId: `c-${counter}`,
      name,
      position: i,
      createdAt: 0,
      updatedAt: 0,
    })),
  }
  store.init([canvas])
  return { canvas, pages: canvas.pages! as { [K in keyof T]: Page } }
}

function addFrames(canvas: Canvas, frames: Frame[]) {
  canvas.frames.push(...frames)
  store.init([canvas]) // re-index the new frames
}

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

describe('pages MCP tools', () => {
  it('registers the page tools and documents frame deletion on delete_page', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const names = new Set(tools.map((t) => t.name))
      for (const name of ['create_page', 'rename_page', 'delete_page', 'move_frame', 'duplicate_frame']) {
        expect(names.has(name), `${name} should be registered`).toBe(true)
      }
      const deletePage = tools.find((t) => t.name === 'delete_page')!
      expect(deletePage.description).toMatch(/AND every frame/i)
      expect(deletePage.description).toMatch(/refused|refuses|deleting the last one is refused/i)
    } finally {
      await close()
    }
  })

  it('create_page appends a page and reports its position', async () => {
    const { canvas } = seedCanvas()
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'create_page', {
        canvas_id: canvas.id,
        name: 'Landing',
        agent_name: 'alice',
      })
      expect(first.isError).toBeUndefined()
      expect(first.parsed).toMatchObject({ name: 'Landing', position: 1 })
      expect(store.getCanvas(canvas.id)!.pages!.map((p) => p.name)).toEqual(['Page 1', 'Landing'])

      const second = await callTool(client, 'create_page', { canvas_id: canvas.id, agent_name: 'alice' })
      expect(second.parsed).toMatchObject({ name: 'Page 3', position: 2 })
      expect(store.getCanvas(canvas.id)!.pages!.map((p) => p.position)).toEqual([0, 1, 2])
    } finally {
      await close()
    }
  })

  it('rename_page renames in the store and errors on an unknown page id', async () => {
    const {
      canvas,
      pages: [, p2],
    } = seedCanvas(['Page 1', 'Page 2'])
    const { client, close } = await connect()
    try {
      const ok = await callTool(client, 'rename_page', {
        page_id: p2.id,
        name: 'Checkout',
        agent_name: 'alice',
      })
      expect(ok.isError).toBeUndefined()
      expect(ok.parsed).toMatchObject({ id: p2.id, name: 'Checkout', position: 1 })
      expect(store.getCanvas(canvas.id)!.pages!.find((p) => p.id === p2.id)!.name).toBe('Checkout')

      const missing = await callTool(client, 'rename_page', { page_id: 'nope', name: 'X' })
      expect(missing.isError).toBe(true)
      expect(missing.raw).toContain('no page with id nope')
    } finally {
      await close()
    }
  })

  it('delete_page removes the page and its frames, and refuses the last page', async () => {
    const {
      canvas,
      pages: [p1, p2],
    } = seedCanvas(['Page 1', 'Page 2'])
    const doomed = [makeFrame(canvas.id, p2.id, 'Hero'), makeFrame(canvas.id, p2.id, 'Pricing')]
    const survivor = makeFrame(canvas.id, p1.id, 'About')
    addFrames(canvas, [...doomed, survivor])

    const { client, close } = await connect()
    try {
      const ok = await callTool(client, 'delete_page', { page_id: p2.id, agent_name: 'alice' })
      expect(ok.isError).toBeUndefined()
      expect(ok.parsed).toMatchObject({ ok: true, deletedPageId: p2.id, deletedFrameIds: doomed.map((f) => f.id) })

      const c = store.getCanvas(canvas.id)!
      expect(c.pages!.map((p) => p.id)).toEqual([p1.id])
      expect(c.frames.map((f) => f.id)).toEqual([survivor.id])
      for (const f of doomed) expect(store.getFrame(f.id)).toBeUndefined()

      const last = await callTool(client, 'delete_page', { page_id: p1.id, agent_name: 'alice' })
      expect(last.isError).toBe(true)
      expect(last.raw).toContain('only page')
      expect(store.getCanvas(canvas.id)!.pages!).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('move_frame resolves the target page by id and by name, rejecting bogus pages', async () => {
    const {
      canvas,
      pages: [p1, p2],
    } = seedCanvas(['Page 1', 'Page B'])
    const f = makeFrame(canvas.id, p1.id, 'Hero')
    addFrames(canvas, [f])

    const { client, close } = await connect()
    try {
      const byId = await callTool(client, 'move_frame', { frame_id: f.id, page: p2.id, agent_name: 'alice' })
      expect(byId.isError).toBeUndefined()
      expect(store.getFrame(f.id)!.pageId).toBe(p2.id)

      const byName = await callTool(client, 'move_frame', { frame_id: f.id, page: 'Page 1', agent_name: 'alice' })
      expect(byName.isError).toBeUndefined()
      expect(store.getFrame(f.id)!.pageId).toBe(p1.id)

      const bogus = await callTool(client, 'move_frame', { frame_id: f.id, page: 'Nowhere', agent_name: 'alice' })
      expect(bogus.isError).toBe(true)
      expect((bogus.parsed as { error: { code: string; message: string } }).error).toMatchObject({
        code: 'invalid_input',
        message: 'no page "Nowhere" on this canvas — try a page id from get_canvas',
      })
      expect(store.getFrame(f.id)!.pageId).toBe(p1.id)
    } finally {
      await close()
    }
  })

  it('duplicate_frame copies the frame 40px down-right onto the same page', async () => {
    const {
      canvas,
      pages: [p1],
    } = seedCanvas(['Page 1'])
    const source = makeFrame(canvas.id, p1.id, 'Hero', { x: 100, y: 200, html: '<h1>Hero</h1>' })
    addFrames(canvas, [source])

    const { client, close } = await connect()
    try {
      const ok = await callTool(client, 'duplicate_frame', { frame_id: source.id, agent_name: 'alice' })
      expect(ok.isError).toBeUndefined()
      const copyId = (ok.parsed as { frame: { id: string } }).frame.id
      expect(copyId).not.toBe(source.id)

      const copy = store.getFrame(copyId)!
      expect(copy.canvasId).toBe(source.canvasId)
      expect(copy.pageId).toBe(source.pageId)
      expect(copy.name).toBe('Hero copy')
      expect(copy.x).toBe(source.x + 40)
      expect(copy.y).toBe(source.y + 40)
      expect(copy.html).toBe(source.html)
      expect(store.getCanvas(source.canvasId)!.frames.map((f) => f.id)).toEqual([source.id, copyId])
    } finally {
      await close()
    }
  })

  it('create_frame targets a page by name, defaulting to the first page', async () => {
    const {
      canvas,
      pages: [p1, p2],
    } = seedCanvas(['Page 1', 'Checkout'])

    const { client, close } = await connect()
    try {
      const named = await callTool(client, 'create_frame', {
        canvas_id: canvas.id,
        page: 'Checkout',
        name: 'Cart',
        html: '<p>cart</p>',
        agent_name: 'alice',
      })
      expect(named.isError).toBeUndefined()
      const namedId = (named.parsed as { frame: { id: string } }).frame.id
      expect(store.getFrame(namedId)!.pageId).toBe(p2.id)

      const defaulted = await callTool(client, 'create_frame', {
        canvas_id: canvas.id,
        name: 'Landing',
        html: '<p>landing</p>',
        agent_name: 'alice',
      })
      expect(defaulted.isError).toBeUndefined()
      const defaultId = (defaulted.parsed as { frame: { id: string } }).frame.id
      expect(store.getFrame(defaultId)!.pageId).toBe(p1.id)
    } finally {
      await close()
    }
  })
})
