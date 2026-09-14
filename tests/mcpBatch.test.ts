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
   there, another agent's lock, an oversized document. An atomic batch that
   dies while applying is rolled back from its pre-image, so a failure never
   leaves half a flow on the canvas. */

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

interface RollbackError {
  code: string
  message: string
  stopped_at?: number
  applied_before_failure?: number
  rolled_back?: boolean
  restored?: string[]
  recreated?: { name: string; from: string; to: string }[]
  not_rolled_back?: number[]
  rollback_failed?: string
}

interface FrameRead {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  html: string
  updatedAt: string
}

/** The frame as an agent reads it, so the comparisons below are of the canvas
 *  an agent sees rather than of the store's internals. */
async function readFrame(client: Client, frameId: string): Promise<FrameRead> {
  const { parsed } = await callTool(client, 'get_frame', { frame_id: frameId, agent_name: 'Claude' })
  return parsed as unknown as FrameRead
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

  it('rolls the batch back when an op fails on a lock taken while applying', async () => {
    const { client, close } = await connect()
    try {
      const before = await readFrame(client, FRAME_ID)
      /* a real token set, so the comparison below is of something the rollback
         could have clobbered rather than of two nulls */
      actions.setTokens(
        CANVAS_ID,
        { colors: { ink: '#111110' }, updatedAt: 0, updatedBy: 'alice' },
        actions.resolveActor({ name: 'alice', kind: 'user' }),
      )
      const beforeTokens = (await callTool(client, 'get_tokens', { canvas_id: CANVAS_ID })).parsed.tokens
      expect(beforeTokens).toBeTruthy()
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        atomic: true,
        agent_name: 'Claude',
        ops: [
          /* op 0 takes the frame lock as it writes — takeover is the batchable
             way to do that — running as AgentA */
          {
            op: 'set_frame_html',
            frame_id: FRAME_ID,
            html: '<h1>AgentA was here</h1>',
            takeover: true,
            agent_name: 'AgentA',
          },
          /* op 1 runs as Claude, so AgentA's lock refuses it. Pre-flight ran
             before either op applied and could not see a lock that did not
             exist yet. */
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Claude was here', agent_name: 'Claude' },
        ],
      })
      expect(isError).toBe(true)
      const failure = parsed.error as unknown as RollbackError
      expect(failure).toMatchObject({
        code: 'conflict',
        stopped_at: 1,
        applied_before_failure: 1,
        rolled_back: true,
      })
      expect(failure.restored).toContain(FRAME_ID)
      /* the frame is what the agent read before the batch — op 0 included */
      const after = await readFrame(client, FRAME_ID)
      expect(after.html).toBe(before.html)
      expect(after.name).toBe(before.name)
      expect(after.x).toBe(before.x)
      expect(after.y).toBe(before.y)
      expect(after.width).toBe(before.width)
      expect(after.height).toBe(before.height)
      expect((await callTool(client, 'get_tokens', { canvas_id: CANVAS_ID })).parsed.tokens).toEqual(beforeTokens)
      /* the lock the rolled-back op took went with it: the frame is free again */
      expect(frameLocks.activeLocks()).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('takes back a frame it created and a guide it wrote when a later op fails', async () => {
    const { client, close } = await connect()
    try {
      const before = await readFrame(client, FRAME_ID)
      /* a doc the batch will overwrite, so the rollback has to put its words
         back — not just delete what the batch added */
      actions.setGuideline(
        CANVAS_ID,
        'tone',
        'Original tone rules',
        actions.resolveActor({ name: 'alice', kind: 'user' }),
      )
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        atomic: true,
        agent_name: 'Claude',
        ops: [
          { op: 'create_frame', name: 'Step 1', html: '<p>one</p>', agent_name: 'Claude' },
          { op: 'set_guidelines', name: 'hero-rules', markdown: '# Hero rules', agent_name: 'Claude' },
          {
            op: 'set_guidelines',
            name: 'tone',
            markdown: 'Rewritten tone rules',
            title: 'Tone of voice',
            agent_name: 'Claude',
          },
          { op: 'set_frame_html', frame_id: FRAME_ID, html: '<h1>rewritten</h1>', agent_name: 'Claude' },
          /* this op read the frame before op 3 rewrote it, so it fails while
             applying — pre-flight read the same frame before that rewrite */
          {
            op: 'update_frame',
            frame_id: FRAME_ID,
            name: 'Never',
            expected_updated_at: before.updatedAt,
            agent_name: 'Claude',
          },
        ],
      })
      expect(isError).toBe(true)
      const failure = parsed.error as unknown as RollbackError
      expect(failure).toMatchObject({
        code: 'conflict',
        stopped_at: 4,
        applied_before_failure: 4,
        rolled_back: true,
      })
      expect(failure.restored).toEqual(expect.arrayContaining([FRAME_ID, 'hero-rules', 'tone']))
      /* the frame the batch created is gone, the guide it wrote is gone, the
         guide it rewrote reads as it did, and the seeded frame is unchanged */
      expect(store.getCanvas(CANVAS_ID)!.frames.map((f) => f.id)).toEqual([FRAME_ID])
      expect(
        store.getGuidelines(CANVAS_ID).map((d) => ({ name: d.name, title: d.title, markdown: d.markdown })),
      ).toEqual([{ name: 'tone', title: undefined, markdown: 'Original tone rules' }])
      const after = await readFrame(client, FRAME_ID)
      expect(after.html).toBe(before.html)
      expect(after.name).toBe(before.name)
    } finally {
      await close()
    }
  })

  it('brings back a frame the batch deleted, naming the id it returns with', async () => {
    const { client, close } = await connect()
    try {
      const before = await readFrame(client, FRAME_ID)
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        atomic: true,
        agent_name: 'Claude',
        ops: [
          { op: 'delete_frame', frame_id: FRAME_ID, agent_name: 'Claude' },
          /* this op read the frame before op 0 deleted it, so it fails while
             applying — pre-flight saw the frame still there */
          {
            op: 'set_frame_html',
            frame_id: FRAME_ID,
            html: '<h1>never</h1>',
            expected_updated_at: before.updatedAt,
            agent_name: 'Claude',
          },
        ],
      })
      expect(isError).toBe(true)
      const failure = parsed.error as unknown as RollbackError
      expect(failure).toMatchObject({ stopped_at: 1, applied_before_failure: 1, rolled_back: true })
      expect(failure.recreated).toHaveLength(1)
      const recreated = failure.recreated![0]!
      expect(recreated.name).toBe(before.name)
      expect(recreated.from).toBe(FRAME_ID)
      /* the design came back whole, under the id the error names */
      const back = await readFrame(client, recreated.to)
      expect(back.html).toBe(before.html)
      expect(store.getCanvas(CANVAS_ID)!.frames.map((f) => f.id)).toEqual([recreated.to])
      expect(failure.message).toContain(recreated.to)
    } finally {
      await close()
    }
  })

  it('answers a dry run with what each op would do, writing nothing', async () => {
    const { client, close } = await connect()
    try {
      const before = await readFrame(client, FRAME_ID)
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        dry_run: true,
        agent_name: 'Claude',
        ops: [
          { op: 'set_frame_html', frame_id: FRAME_ID, html: '<h1>would land</h1>', agent_name: 'Claude' },
          { op: 'create_frame', name: 'Would exist', html: '<p>x</p>', agent_name: 'Claude' },
          { op: 'set_frame_html', frame_id: 'nope', html: '<p>x</p>', agent_name: 'Claude' },
        ],
      })
      expect(isError).toBeFalsy()
      expect(parsed.dry_run).toBe(true)
      expect(parsed.applied).toBe(0)
      expect(parsed.failed).toBe(1)
      expect(parsed.would_apply).toBe(2)
      const results = parsed.results as unknown as (OpResult & {
        would_apply?: boolean
        diff?: { added: number; removed: number }
        bytes_before?: number
        bytes_after?: number
      })[]
      expect(results[0]!.would_apply).toBe(true)
      expect(results[0]!.diff).toBeTruthy()
      expect(results[0]!.bytes_before).toBe(before.html.length)
      expect(results[0]!.bytes_after).toBe('<h1>would land</h1>'.length)
      /* create_frame has no diff of its own — pre-flight passing is the answer */
      expect(results[1]!.would_apply).toBe(true)
      expect(results[1]!.diff).toBeUndefined()
      expect(results[2]!.error!.error!.code).toBe('not_found')
      /* nothing was written, and the frame is untouched */
      expect(store.getCanvas(CANVAS_ID)!.frames.map((f) => f.id)).toEqual([FRAME_ID])
      expect((await readFrame(client, FRAME_ID)).updatedAt).toBe(before.updatedAt)
    } finally {
      await close()
    }
  })

  it('reports what a best-effort batch landed and what cannot be taken back', async () => {
    const { client, close } = await connect()
    try {
      const commentsBefore = actions.getComments(CANVAS_ID).length
      const { parsed } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          { op: 'add_comment', frame_id: FRAME_ID, selector: 'h1', text: 'check the contrast', agent_name: 'Claude' },
          { op: 'set_frame_html', frame_id: 'nope', html: '<p>x</p>', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Still here', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(parsed.applied).toBe(2)
      expect(parsed.failed).toBe(1)
      /* nothing is rolled back here by design, and the payload says how far the
         batch got and which of the ops that landed cannot be taken back */
      expect(parsed.applied_before_failure).toBe(1)
      expect(parsed.not_rolled_back).toEqual([0])
      /* the comment op landed and stayed landed — that is what the field says */
      expect(actions.getComments(CANVAS_ID)).toHaveLength(commentsBefore + 1)
      expect(store.getFrame(FRAME_ID)!.name).toBe('Still here')
    } finally {
      await close()
    }
  })
})
