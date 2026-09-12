import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { getStats, recordToolCall } from '../server/mcpStats.ts'
import type { Canvas, ElementComment, ServerMessage, TaskFeedback } from '../shared/types.ts'

/* Agent identity: a name is free text, so the account behind it is what makes
   two "Claude"s two agents. Everything routed by name — feedback, comments,
   stops, presence — has to respect that, or one account's agent can read and
   halt another's work. */

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

const OWNER_ID = 'owner-account'
const OTHER_ID = 'other-account'
const CANVAS_ID = 'c-identity'
const FRAME_ID = 'f-identity'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerName: string, ownerId: string) {
  const server = buildMcpServer(ownerName, ownerId)
  const client = new Client({ name: `doop-identity-${ownerId}`, version: '1.0.0' })
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

function seedCanvas(shareWithOther = true): Canvas {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Identity',
    ownerId: OWNER_ID,
    /* with linkAccess 'edit' the other account can reach the canvas without
       being a member — which is exactly the case a stop must refuse */
    ...(shareWithOther ? { memberIds: [OTHER_ID] } : { linkAccess: 'edit' as const }),
    createdAt: 0,
    updatedAt: 0,
    frames: [
      {
        id: FRAME_ID,
        canvasId: CANVAS_ID,
        name: 'Hero',
        x: 0,
        y: 0,
        width: 640,
        height: 480,
        html: '<h1>hi</h1>',
        createdAt: 0,
        updatedAt: 1,
        updatedBy: 'alice',
        pageId: 'p-identity',
      },
    ],
    pages: [{ id: 'p-identity', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
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
  /* hydrateLogs only assigns the keys it is given, so the canvas is listed
     explicitly to start every test from empty logs */
  actions.hydrateLogs({
    tasks: new Map([[CANVAS_ID, []]]),
    feedback: new Map([[CANVAS_ID, []]]),
    comments: new Map([[CANVAS_ID, []]]),
    activity: new Map([[CANVAS_ID, []]]),
    decisions: new Map([[CANVAS_ID, []]]),
    proposals: new Map([[CANVAS_ID, []]]),
  })
  seedCanvas()
})

describe('agent identity is scoped to the account', () => {
  it('reports the account behind the connection from whoami', async () => {
    const a = await connect('Alice', OWNER_ID)
    try {
      const { parsed, isError } = await callTool(a.client, 'whoami', { agent_name: 'Claude' })
      expect(isError).toBeFalsy()
      expect(parsed.account).toBe('Alice')
      expect(parsed.account_id).toBe(OWNER_ID)
      expect(parsed.agent_name).toBe('Claude')
      expect(String(parsed.note)).toContain('scoped to this account')
    } finally {
      await a.close()
    }
  })

  it('does not let one account’s agent inherit feedback delivered to another’s', async () => {
    const a = await connect('Alice', OWNER_ID)
    const b = await connect('Bob', OTHER_ID)
    try {
      const fb: TaskFeedback = {
        id: 'fb-1',
        taskId: 'task-1',
        canvasId: CANVAS_ID,
        agentName: 'Claude',
        targetAgent: 'Claude',
        from: 'alice',
        text: 'round the corners',
        at: 1,
      }
      actions.hydrateLogs({
        tasks: new Map([[CANVAS_ID, []]]),
        feedback: new Map([[CANVAS_ID, [fb]]]),
        comments: new Map(),
        activity: new Map(),
        decisions: new Map(),
        proposals: new Map(),
      })

      /* Alice's Claude reads it first */
      const first = await callTool(a.client, 'get_feedback', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(first.raw).toContain('round the corners')

      /* Bob's Claude, same name, must not see the same delivery again */
      const second = await callTool(b.client, 'get_feedback', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(second.raw).not.toContain('round the corners')
      expect(second.isError).toBeFalsy()
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('records the account on a comment claim, so the pin can tell the agents apart', () => {
    const comment: ElementComment = {
      id: 'cm-1',
      canvasId: CANVAS_ID,
      frameId: FRAME_ID,
      selector: 'h1',
      snippet: '<h1>hi</h1>',
      from: 'alice',
      text: '@Doop make this bigger',
      at: 1,
      forAgent: true,
      targetAgent: 'Claude',
    }
    actions.hydrateLogs({
      tasks: new Map([[CANVAS_ID, []]]),
      feedback: new Map([[CANVAS_ID, []]]),
      comments: new Map([[CANVAS_ID, [comment]]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
    const claimed = actions.takeAgentCommentsFor(CANVAS_ID, 'Claude', undefined, OWNER_ID)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.claimedBy).toBe('Claude')
    expect(claimed[0]!.claimedByOwner).toBe(OWNER_ID)
  })

  it('refuses to stop another account’s agent, and allows the canvas owner to', async () => {
    /* Bob is NOT a member here: he can read the canvas by link, but stopping
       someone else's agent is a privileged act */
    seedCanvas(false)
    const b = await connect('Bob', OTHER_ID)
    try {
      /* an open status task belonging to Alice's agent */
      actions.setAgentStatus(
        CANVAS_ID,
        actions.resolveActor({ name: 'Claude', kind: 'agent', owner: 'Alice', ownerId: OWNER_ID }),
        'Sketching the hero',
      )
      const refused = await callTool(b.client, 'stop_work', {
        canvas_id: CANVAS_ID,
        target_agent: 'Claude',
        agent_name: 'BobAgent',
      })
      expect(refused.isError).toBe(true)
      expect(refused.parsed.error).toMatchObject({ code: 'forbidden' })
      expect(actions.getTasks(CANVAS_ID).some((t) => !t.endedAt)).toBe(true)
    } finally {
      await b.close()
    }

    const owner = await connect('Alice', OWNER_ID)
    try {
      const allowed = await callTool(owner.client, 'stop_work', {
        canvas_id: CANVAS_ID,
        target_agent: 'Claude',
        agent_name: 'AliceAgent',
      })
      expect(allowed.isError).toBeFalsy()
      expect(allowed.parsed.ok).toBe(true)
      expect(actions.getTasks(CANVAS_ID).every((t) => t.endedAt !== undefined)).toBe(true)
    } finally {
      await owner.close()
    }
  })

  it('keys presence per account, so the same name is two agents in the room', async () => {
    const seen: ServerMessage[] = []
    actions.wire(
      (_canvasId, msg) => seen.push(msg),
      () => {},
    )
    const a = await connect('Alice', OWNER_ID)
    const b = await connect('Bob', OTHER_ID)
    try {
      await callTool(a.client, 'set_status', { canvas_id: CANVAS_ID, status: 'Alice work', agent_name: 'Claude' })
      await callTool(b.client, 'set_status', { canvas_id: CANVAS_ID, status: 'Bob work', agent_name: 'Claude' })
      const tasks = actions.getTasks(CANVAS_ID)
      /* two open tasks, both named Claude, each carrying its own account */
      expect(tasks).toHaveLength(2)
      expect(new Set(tasks.map((t) => t.ownerId))).toEqual(new Set([OWNER_ID, OTHER_ID]))
      expect(tasks.every((t) => t.agentName === 'Claude')).toBe(true)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('lets a shared canvas’s agent stop its own run', async () => {
    const b = await connect('Bob', OTHER_ID)
    try {
      await callTool(b.client, 'set_status', { canvas_id: CANVAS_ID, status: 'Bob work', agent_name: 'Claude' })
      const stopped = await callTool(b.client, 'stop_work', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(stopped.isError).toBeFalsy()
      expect(stopped.parsed.ok).toBe(true)
      expect(actions.getTasks(CANVAS_ID).every((t) => t.endedAt !== undefined)).toBe(true)
    } finally {
      await b.close()
    }
  })
})

describe('per-tool telemetry', () => {
  it('counts calls, errors and latencies per tool', () => {
    const before = getStats().tools.find((t) => t.name === 'get_canvas')
    recordToolCall('get_canvas', true, 10)
    recordToolCall('get_canvas', true, 30)
    recordToolCall('get_canvas', false, 20, 'not_found')
    const after = getStats().tools.find((t) => t.name === 'get_canvas')!
    expect(after.calls).toBe((before?.calls ?? 0) + 3)
    expect(after.errors).toBe((before?.errors ?? 0) + 1)
    expect(after.p50).toBeGreaterThan(0)
    expect(after.p95).toBeGreaterThanOrEqual(after.p50)
  })

  it('records every real tool call through the MCP surface', async () => {
    const a = await connect('Alice', OWNER_ID)
    try {
      const before = getStats().tools.find((t) => t.name === 'get_guide')?.calls ?? 0
      await a.client.callTool({ name: 'get_guide', arguments: { topic: 'review' } })
      expect(getStats().tools.find((t) => t.name === 'get_guide')!.calls).toBe(before + 1)

      /* a failing call is counted as an error, with the code */
      const errorsBefore = getStats().tools.find((t) => t.name === 'get_comments')?.errors ?? 0
      await callTool(a.client, 'get_comments', { canvas_id: 'nope' })
      expect(getStats().tools.find((t) => t.name === 'get_comments')!.errors).toBe(errorsBefore + 1)
    } finally {
      await a.close()
    }
  })
})

describe('progress notifications', () => {
  it('reports progress on the wire when the client asked for it, and never otherwise', async () => {
    /* Asserted at the transport rather than through the SDK client's
       onprogress: that client only routes progress whose token is the numeric
       request id, which is its own convention, not the spec's. The spec says
       echo the caller's token — so this checks the wire. */
    const server = buildMcpServer('Alice', OWNER_ID)
    const client = new Client({ name: 'doop-progress-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const sent: { method?: string; params?: { progressToken?: unknown; progress?: number; message?: string } }[] = []
    const originalSend = serverTransport.send.bind(serverTransport)
    serverTransport.send = async (message) => {
      sent.push(message as never)
      return originalSend(message)
    }
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      await client.callTool({
        name: 'get_frame_screenshot',
        arguments: { frame_id: FRAME_ID, agent_name: 'Claude' },
        _meta: { progressToken: 'shot-1' },
      })
      const updates = sent.filter((m) => m.method === 'notifications/progress')
      expect(updates).toHaveLength(1)
      expect(updates[0]!.params).toMatchObject({ progressToken: 'shot-1', progress: 0 })
      expect(updates[0]!.params!.message).toContain('Hero')

      /* no token on the request: nothing is reported, because nothing asked */
      sent.length = 0
      await client.callTool({ name: 'get_frame_screenshot', arguments: { frame_id: FRAME_ID, agent_name: 'Claude' } })
      expect(sent.filter((m) => m.method === 'notifications/progress')).toEqual([])
    } finally {
      await client.close()
      await server.close()
    }
  }, 30_000)
})
