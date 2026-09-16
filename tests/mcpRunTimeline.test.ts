import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import * as runLog from '../server/runLog.ts'
import { store } from '../server/store.ts'
import type { Canvas, ServerMessage } from '../shared/types.ts'

/* A connected MCP agent works on a shared canvas, and the Run tab is where a
   human watches what it did. Its calls have to land on that timeline,
   attributed to the agent that made them. */

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
  saveFrameReview: async () => {},
  listFrameReviews: async () => [],
  listFrameVersions: async () => [],
  getFrameVersion: async () => undefined,
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

const OWNER_ID = 'runs-owner'
const CANVAS_ID = 'c-runs'

/** What the room was told, per canvas: the Run tab renders from these. */
let room: { canvasId: string; message: ServerMessage }[] = []

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-runlog-test', version: '1.0.0' })
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
  return { isError: result.isError }
}

function seed() {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Runs',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [],
  }
  store.init([canvas])
  runLog.forgetCanvas(CANVAS_ID)
}

beforeEach(() => {
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
  room = []
  runLog.wireBroadcast((canvasId, message) => room.push({ canvasId, message }))
  seed()
})

describe('the run timeline for a connected agent', () => {
  it('records one entry per canvas-scoped call, with its duration and agent', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        width: 1200,
        height: 900,
        html: '<h1>hi</h1>',
        agent_name: 'Claude',
      })
      const frameId = store.getCanvas(CANVAS_ID)!.frames[0]!.id
      await callTool(client, 'append_frame_html', {
        frame_id: frameId,
        html_chunk: '<section>more</section>',
        start: true,
        agent_name: 'Claude',
      })

      const events = runLog.getRunEvents(CANVAS_ID, { limit: 50 })
      const tools = events.filter((e) => e.kind === 'tool')
      expect(tools.map((e) => e.name)).toEqual(['append_frame_html', 'create_frame'])
      for (const event of tools) {
        expect(event.agentName).toBe('Claude')
        expect(event.ok).toBe(true)
        expect(event.ms).toBeGreaterThanOrEqual(0)
      }
      /* one connection, one run: the panel groups them together */
      expect(new Set(tools.map((e) => e.runId)).size).toBe(1)
    } finally {
      await close()
    }
  })

  it('records a refused call as a failure rather than dropping it', async () => {
    const { client, close } = await connect()
    try {
      /* the agent has already named its canvas, then mistypes a frame id */
      await callTool(client, 'get_canvas', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      const { isError } = await callTool(client, 'get_frame', {
        frame_id: 'does-not-exist',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)

      const [event] = runLog.getRunEvents(CANVAS_ID, { limit: 10 })
      expect(event?.kind).toBe('tool')
      expect(event?.name).toBe('get_frame')
      expect(event?.ok).toBe(false)
    } finally {
      await close()
    }
  })

  it('leaves the timeline alone for calls that name no agent', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'get_capabilities', {})
      expect(runLog.getRunEvents(CANVAS_ID, { limit: 10 })).toEqual([])
    } finally {
      await close()
    }
  })

  it('tells the room, so the Run tab shows the agent working live', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'get_canvas', { canvas_id: CANVAS_ID, agent_name: 'Claude' })

      const events = room.filter((entry) => entry.message.type === 'run:event')
      expect(events).toHaveLength(1)
      expect(events[0]!.canvasId).toBe(CANVAS_ID)
      const event = (events[0]!.message as { event: { agentName: string; name: string; ok: boolean } }).event
      expect(event.agentName).toBe('Claude')
      expect(event.name).toBe('get_canvas')
      expect(event.ok).toBe(true)
    } finally {
      await close()
    }
  })

  it('stays quiet for a call that names no canvas', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'list_canvases', { agent_name: 'Claude' })
      expect(room.filter((entry) => entry.message.type === 'run:event')).toEqual([])
    } finally {
      await close()
    }
  })

  it('records the frame a write landed on, so the Run tab can jump to it', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        width: 1200,
        height: 900,
        html: '<h1>hi</h1>',
        agent_name: 'Claude',
      })
      const frameId = store.getCanvas(CANVAS_ID)!.frames[0]!.id
      await callTool(client, 'append_frame_html', {
        frame_id: frameId,
        html_chunk: '<section>more</section>',
        start: true,
        agent_name: 'Claude',
      })

      const events = runLog.getRunEvents(CANVAS_ID, { limit: 50 })
      const write = events.find((event) => event.name === 'append_frame_html')
      expect(write?.ok).toBe(true)
      expect(write?.frameId).toBe(frameId)
    } finally {
      await close()
    }
  })

  it('records no frame for a write that was refused, though it named a real one', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        width: 1200,
        height: 900,
        html: '<h1>hi</h1>',
        agent_name: 'Claude',
      })
      const frameId = store.getCanvas(CANVAS_ID)!.frames[0]!.id
      /* the frame moved on under the agent: the write is refused, and the row
         must not offer a jump to a frame it never touched */
      const { isError } = await callTool(client, 'set_frame_html', {
        frame_id: frameId,
        html: '<h1>rewritten</h1>',
        expected_updated_at: new Date(0).toISOString(),
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)

      const events = runLog.getRunEvents(CANVAS_ID, { limit: 50 })
      const refused = events.find((event) => event.name === 'set_frame_html')
      expect(refused?.ok).toBe(false)
      expect(refused?.frameId).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('records no frame for a read that merely names one', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        width: 1200,
        height: 900,
        html: '<h1>hi</h1>',
        agent_name: 'Claude',
      })
      const frameId = store.getCanvas(CANVAS_ID)!.frames[0]!.id
      await callTool(client, 'get_frame', { frame_id: frameId, agent_name: 'Claude' })

      const events = runLog.getRunEvents(CANVAS_ID, { limit: 50 })
      const read = events.find((event) => event.name === 'get_frame')
      /* the read landed, it just did not write anything to jump to */
      expect(read?.ok).toBe(true)
      expect(read?.frameId).toBeUndefined()
    } finally {
      await close()
    }
  })
})
