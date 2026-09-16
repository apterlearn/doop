import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { MAX_HTML_READ_CHARS } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Bounded reads: a canvas or a document that is too big to return whole must
   say so and name the tool that pages through it, instead of silently filling
   the caller's context. */
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
  deleteComponentRow: () => {},
  releaseFrames: () => [],
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
}))

const OWNER_ID = 'paging-owner'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-mcp-paging-test', version: '1.0.0' })
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
  return { parsed: JSON.parse(raw) as Record<string, unknown>, raw, isError: result.isError }
}

const CANVAS_ID = 'c-paging'
const BIG_FRAME_ID = 'f-big'

function seedCanvas(): Canvas {
  const frames: Frame[] = []
  for (let i = 0; i < 120; i += 1) {
    frames.push({
      id: `f-${i}`,
      canvasId: CANVAS_ID,
      name: `Frame ${i}`,
      x: i * 10,
      y: 0,
      width: 640,
      height: 480,
      html: `<p>${i}</p>`,
      createdAt: 0,
      updatedAt: i,
      updatedBy: 'alice',
      z: 0,
      locked: false,
      hidden: false,
      rotation: 0,
      opacity: 1,
      pageId: 'p-paging',
    })
  }
  frames.push({
    id: BIG_FRAME_ID,
    canvasId: CANVAS_ID,
    name: 'Imported page',
    x: 0,
    y: 0,
    width: 1280,
    height: 4000,
    html: `<body>${'x'.repeat(40_000)}</body>`,
    createdAt: 0,
    updatedAt: 999,
    updatedBy: 'alice',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
    pageId: 'p-paging',
  })
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Paging',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames,
    pages: [{ id: 'p-paging', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
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

describe('paged MCP reads', () => {
  it('pages frames with total, has_more and next_offset', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'list_frames', { canvas_id: CANVAS_ID, limit: 50, agent_name: 'Claude' })
      expect(first.isError).toBeFalsy()
      expect((first.parsed.frames as unknown[]).length).toBe(50)
      expect(first.parsed.total).toBe(121)
      expect(first.parsed.has_more).toBe(true)
      expect(first.parsed.next_offset).toBe(50)

      const last = await callTool(client, 'list_frames', {
        canvas_id: CANVAS_ID,
        limit: 50,
        offset: 100,
        agent_name: 'Claude',
      })
      expect((last.parsed.frames as unknown[]).length).toBe(21)
      expect(last.parsed.has_more).toBe(false)
      expect(last.parsed.next_offset).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('filters list_frames by page and by update time', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const byName = await callTool(client, 'list_frames', {
        canvas_id: CANVAS_ID,
        page: 'Page 1',
        agent_name: 'Claude',
      })
      expect(byName.parsed.total).toBe(121)

      const bogus = await callTool(client, 'list_frames', {
        canvas_id: CANVAS_ID,
        page: 'Nowhere',
        agent_name: 'Claude',
      })
      expect(bogus.isError).toBe(true)
      expect(JSON.parse(bogus.raw).error.code).toBe('invalid_input')

      const recent = await callTool(client, 'list_frames', {
        canvas_id: CANVAS_ID,
        updated_since: new Date(110).toISOString(),
        agent_name: 'Claude',
      })
      expect(recent.parsed.total).toBe(10)
      expect((recent.parsed.frames as { id: string }[]).every((f) => f.id !== 'f-0')).toBe(true)
    } finally {
      await close()
    }
  })

  it('flags a truncated frame list on get_canvas and points at list_frames', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'get_canvas', {
        canvas_id: CANVAS_ID,
        frames_limit: 5,
        agent_name: 'Claude',
      })
      expect((parsed.frames as unknown[]).length).toBe(5)
      expect(parsed.frame_total).toBe(121)
      expect(parsed.frames_truncated).toBe(true)
      expect(String(parsed.note)).toContain('list_frames')

      const full = await callTool(client, 'get_canvas', {
        canvas_id: CANVAS_ID,
        frames_limit: 200,
        agent_name: 'Claude',
      })
      expect(full.parsed.frames_truncated).toBeUndefined()
      expect((full.parsed.frames as unknown[]).length).toBe(121)
    } finally {
      await close()
    }
  })

  it('clamps a whole-document get_frame and names the bounded reader', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'get_frame', { frame_id: BIG_FRAME_ID, agent_name: 'Claude' })
      expect(parsed.html_truncated).toBe(true)
      expect((parsed.html as string).length).toBe(MAX_HTML_READ_CHARS)
      expect(parsed.htmlBytes).toBeGreaterThan(MAX_HTML_READ_CHARS)
      expect(String(parsed.note)).toContain('get_frame_html')

      const small = await callTool(client, 'get_frame', { frame_id: 'f-0', agent_name: 'Claude' })
      expect(small.parsed.html_truncated).toBeUndefined()
      expect(small.parsed.html).toBe('<p>0</p>')
    } finally {
      await close()
    }
  })

  it('pages the canvas list', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'list_canvases', { limit: 1, offset: 0 })
      expect((first.parsed.canvases as unknown[]).length).toBe(1)
      expect(first.parsed.total).toBe(1)
      expect(first.parsed.has_more).toBe(false)
    } finally {
      await close()
    }
  })
})
