import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as frameLocks from '../server/frameLocks.ts'
import { clearOpIds } from '../server/opIds.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Batching: one call, several edits, each reported at its own index. The
   failures below are the ones an agent actually hits — a frame that is not
   there, another agent's lock, an oversized document. */

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
}))

const OWNER_ID = 'batch-owner'
const CANVAS_ID = 'c-batch'
const FRAME_ID = 'f-batch'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-batch-test', version: '1.0.0' })
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

interface OpResult {
  index: number
  op: string
  ok: boolean
  result?: unknown
  error?: { error?: { code: string; message: string } }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

function seedCanvas(): Frame {
  const frame: Frame = {
    id: FRAME_ID,
    canvasId: CANVAS_ID,
    name: 'Hero',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    html: '<h1>original</h1>',
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    pageId: 'p-batch',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Batch',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-batch', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

beforeEach(() => {
  vi.restoreAllMocks()
  frameLocks.clearLocks()
  clearOpIds()
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

describe('apply_ops', () => {
  it('applies a sequence of ops in order and reports each result by index', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          { op: 'create_frame', name: 'Step 1', html: '<p>one</p>', width: 400, height: 300, agent_name: 'Claude' },
          { op: 'set_frame_html', frame_id: FRAME_ID, html: '<h1>rewritten</h1>', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Hero v2', agent_name: 'Claude' },
          { op: 'add_comment', frame_id: FRAME_ID, selector: 'h1', text: 'check the contrast', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.applied).toBe(4)
      expect(parsed.failed).toBe(0)
      const results = parsed.results as unknown as OpResult[]
      expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3])
      expect(results.map((r) => r.op)).toEqual(['create_frame', 'set_frame_html', 'update_frame', 'add_comment'])
      expect(results.every((r) => r.ok)).toBe(true)
      /* the ops really landed, in order */
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>rewritten</h1>')
      expect(store.getFrame(FRAME_ID)!.name).toBe('Hero v2')
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(2)
      expect(actions.getComments(CANVAS_ID)).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('keeps going past a failing op and reports it at its index', async () => {
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          { op: 'create_frame', name: 'Step 1', html: '<p>one</p>', agent_name: 'Claude' },
          { op: 'set_frame_html', frame_id: 'nope', html: '<p>x</p>', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Still here', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(parsed.applied).toBe(2)
      expect(parsed.failed).toBe(1)
      const results = parsed.results as unknown as OpResult[]
      expect(results[1]!.ok).toBe(false)
      expect(results[1]!.error!.error!.code).toBe('not_found')
      expect(results[1]!.error!.error!.message).toContain('no frame with id nope')
      /* the third op ran despite the second failing */
      expect(store.getFrame(FRAME_ID)!.name).toBe('Still here')
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('applies nothing when atomic and one op would fail', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          { op: 'create_frame', name: 'Step 1', html: '<p>one</p>', agent_name: 'Claude' },
          { op: 'set_frame_html', frame_id: 'nope', html: '<p>x</p>', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Never', agent_name: 'Claude' },
        ],
        atomic: true,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(parsed.error).toMatchObject({ code: 'not_found', stopped_at: 1 })
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(1)
      expect(store.getFrame(FRAME_ID)!.name).toBe('Hero')
    } finally {
      await close()
    }
  })

  it('refuses an op that targets a locked frame, without touching it', async () => {
    frameLocks.acquire(FRAME_ID, CANVAS_ID, 'AgentA', undefined, 300_000)
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          { op: 'set_frame_html', frame_id: FRAME_ID, html: '<h1>mine</h1>', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Also mine', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(parsed.applied).toBe(0)
      expect(parsed.failed).toBe(2)
      const results = parsed.results as unknown as OpResult[]
      expect(results[0]!.error!.error!.code).toBe('conflict')
      expect(results[0]!.error!.error!.message).toContain('AgentA')
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>original</h1>')
    } finally {
      await close()
    }
  })

  it('rejects a malformed op by index rather than failing the whole call', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          /* no frame_id: the op cannot be run, and the batch says which one */
          { op: 'update_frame', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Fine', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.applied).toBe(1)
      const results = parsed.results as unknown as OpResult[]
      expect(results[0]!.error!.error!.code).toBe('invalid_input')
      expect(results[0]!.error!.error!.message).toContain('frame_id')
      expect(results[1]!.ok).toBe(true)
      expect(store.getFrame(FRAME_ID)!.name).toBe('Fine')
    } finally {
      await close()
    }
  })

  it('refuses an op name that is not a batchable tool, at the schema', async () => {
    const { client, close } = await connect()
    try {
      const result = (await client.callTool({
        name: 'apply_ops',
        arguments: { canvas_id: CANVAS_ID, ops: [{ op: 'not_a_tool' }], agent_name: 'Claude' },
      })) as unknown as CallResult
      expect(result.isError).toBe(true)
      const text = result.content.find((block) => block.type === 'text')?.text ?? ''
      expect(text).toContain('ops[0].op')
      /* nothing ran: the call never reached the handler */
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('refuses an op aimed at a different canvas', async () => {
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          { op: 'create_frame', canvas_id: 'somewhere-else', name: 'Stray', html: '<p>x</p>', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(parsed.applied).toBe(0)
      const results = parsed.results as unknown as OpResult[]
      expect(results[0]!.error!.error!.code).toBe('invalid_input')
      expect(results[0]!.error!.error!.message).toContain('somewhere-else')
    } finally {
      await close()
    }
  })
})
