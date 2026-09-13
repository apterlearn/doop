import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Stops are persisted and broadcast; these cases only care about the state a
   card ends up in, so both sides are stubbed. */
vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveJournal: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  deleteTask: () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')
const { buildMcpServer } = await import('../server/mcp.ts')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const AGENT = roleName(DEFAULT_ROLE_ID)

/* hydrateLogs only overwrites the canvases it is given, so each case works on
   its own canvas — a shared one would carry the previous case's card over. */
let CANVAS = ''

/** The MCP surface, so the stop latch that gates every tool call is exercised
 *  for real rather than inferred from actions.wasStopped. */
async function connectMcp() {
  const server = buildMcpServer('alice', 'alice')
  const client = new Client({ name: 'doop-stop-test', version: '1.0.0' })
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

async function callTool(client: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content?.find((b) => b.type === 'text')?.text ?? ''
  /* a tool payload is JSON when it is machine-readable and prose when it is a
     plain text() result — both are returned, unparsed text included */
  let parsed: { error?: { code?: string; message?: string }; [k: string]: unknown } = {}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    /* plain text */
  }
  return { parsed, raw, isError: result.isError }
}

function claimedCard() {
  const card = actions.addQueuedCard(CANVAS, 'Make a hero', 'alice', undefined, undefined, 'alice')!
  actions.takeQueuedCardsFor(CANVAS, AGENT, 'alice')
  return card
}

function card(id: string) {
  return actions.getTasks(CANVAS).find((t) => t.id === id)!
}

beforeEach(() => {
  CANVAS = `canvas-${Math.random().toString(36).slice(2, 10)}`
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
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS ? ({ id: CANVAS } as never) : undefined))
})

describe('stopping agent work', () => {
  it('stops a claimed card instead of failing it', () => {
    const queued = claimedCard()

    expect(actions.cancelAgentWork(CANVAS, AGENT, 'alice')).toBe(1)

    expect(card(queued.id).cancelledAt).toBeGreaterThan(0)
    expect(card(queued.id).cancelledBy).toBe('alice')
    expect(card(queued.id).failedAt).toBeUndefined()
    expect(card(queued.id).endedAt).toBeUndefined()
  })

  it('does not let a stopped card be picked up again by the next claim', () => {
    const queued = claimedCard()
    actions.cancelAgentWork(CANVAS, AGENT, 'alice')

    expect(actions.takeQueuedCardsFor(CANVAS, AGENT, 'alice')).toEqual([])
    expect(actions.pendingWorkAgents(CANVAS)).toEqual([])
    expect(card(queued.id).cancelledAt).toBeDefined()
  })

  it('lets a retry lift the stop', () => {
    const queued = claimedCard()
    actions.cancelAgentWork(CANVAS, AGENT, 'alice')

    actions.retryCard(CANVAS, queued.id, 'alice')

    expect(card(queued.id).cancelledAt).toBeUndefined()
    expect(card(queued.id).cancelledBy).toBeUndefined()
    expect(card(queued.id).agentName).toBe('')
    expect(actions.takeQueuedCardsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual([queued.id])
  })

  it('refuses to fail or advance a stopped card', () => {
    const queued = claimedCard()
    actions.cancelAgentWork(CANVAS, AGENT, 'alice')

    actions.failCard(CANVAS, queued.id, 'The agent did not finish this task.')
    actions.advanceCard(CANVAS, queued.id, actions.resolveActor({ name: AGENT, kind: 'agent' }))

    expect(card(queued.id).failedAt).toBeUndefined()
    expect(card(queued.id).failureReason).toBeUndefined()
    expect(card(queued.id).stage).toBe(0)
  })

  it('stops one card without stopping the agent', () => {
    const first = claimedCard()
    /* queued after the claim, so it is still waiting for an agent */
    const second = actions.addQueuedCard(CANVAS, 'Make a footer', 'alice', undefined, undefined, 'alice')!

    const stopped = actions.cancelCard(CANVAS, first.id, 'alice')

    expect(stopped?.cancelledAt).toBeGreaterThan(0)
    expect(stopped?.cancelledBy).toBe('alice')
    expect(stopped?.failedAt).toBeUndefined()
    /* the other card is untouched, and still claimable */
    expect(card(second.id).cancelledAt).toBeUndefined()
    expect(actions.takeQueuedCardsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual([second.id])
    /* and no agent-level stop: the agent keeps its other work and its calls */
    expect(actions.wasStopped(CANVAS, AGENT)).toBe(false)
  })

  it('does not re-cancel a card that already finished', () => {
    const queued = claimedCard()
    actions.completeCard(CANVAS, queued.id)

    const stopped = actions.cancelCard(CANVAS, queued.id, 'alice')

    expect(stopped?.cancelledAt).toBeUndefined()
    expect(card(queued.id).endedAt).toBeGreaterThan(0)
    expect(actions.wasStopped(CANVAS, AGENT)).toBe(false)
  })

  it('stops a card an agent abandoned without attributing it to a person', () => {
    const queued = claimedCard()

    actions.endAgentTasks(CANVAS, AGENT)

    expect(card(queued.id).cancelledAt).toBeGreaterThan(0)
    expect(card(queued.id).cancelledBy).toBeUndefined()
    expect(card(queued.id).failedAt).toBeUndefined()
  })

  it('ends an open status task rather than stopping it', () => {
    actions.setAgentStatus(CANVAS, actions.resolveActor({ name: AGENT, kind: 'agent' }), 'Designing')

    actions.cancelAgentWork(CANVAS, AGENT, 'alice')

    const narration = actions.getTasks(CANVAS).find((t) => t.status === 'Designing')!
    expect(narration.endedAt).toBeGreaterThan(0)
    expect(narration.cancelledAt).toBeUndefined()
  })

  it('reports an outstanding stop until a run clears it', () => {
    actions.cancelAgentWork(CANVAS, AGENT, 'alice')
    expect(actions.wasStopped(CANVAS, AGENT)).toBe(true)
    expect(actions.wasStopped(CANVAS, 'Someone Else')).toBe(false)

    actions.clearStop(CANVAS, AGENT)

    expect(actions.wasStopped(CANVAS, AGENT)).toBe(false)
  })

  it('stops reporting a stop once it is stale', () => {
    /* an external MCP agent has no run to clear the record, so it must age out
       — otherwise one stop would mute that agent name forever */
    vi.useFakeTimers()
    try {
      actions.cancelAgentWork(CANVAS, AGENT, 'alice')
      expect(actions.wasStopped(CANVAS, AGENT)).toBe(true)

      vi.advanceTimersByTime(11 * 60_000)

      expect(actions.wasStopped(CANVAS, AGENT)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a card off the board entirely', () => {
    const queued = actions.addQueuedCard(CANVAS, 'Make a hero', 'alice')!

    expect(actions.removeCard(CANVAS, queued.id, 'alice')).toBe(true)

    expect(actions.getTasks(CANVAS).some((t) => t.id === queued.id)).toBe(false)
    expect(actions.removeCard(CANVAS, queued.id, 'alice')).toBe(false)
  })

  it('stops the run behind a card it removes', () => {
    const queued = claimedCard()

    actions.removeCard(CANVAS, queued.id, 'alice')

    expect(actions.wasStopped(CANVAS, AGENT)).toBe(true)
    expect(actions.getTasks(CANVAS).some((t) => t.id === queued.id)).toBe(false)
  })

  it('stop_work with a card_id leaves the agent free to keep calling tools', async () => {
    const first = claimedCard()
    const second = actions.addQueuedCard(CANVAS, 'Make a footer', 'alice', undefined, undefined, 'alice')!
    const { client, close } = await connectMcp()
    try {
      const stopped = await callTool(client, 'stop_work', {
        canvas_id: CANVAS,
        card_id: first.id,
        agent_name: AGENT,
      })
      expect(stopped.isError).toBeFalsy()
      expect(card(first.id).cancelledAt).toBeGreaterThan(0)
      /* the second card is untouched and still waiting to be claimed */
      expect(card(second.id).cancelledAt).toBeUndefined()
      expect(actions.takeQueuedCardsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual([second.id])

      /* no agent-level latch: the agent's next call runs */
      const next = await callTool(client, 'set_status', {
        canvas_id: CANVAS,
        status: 'Still working',
        agent_name: AGENT,
      })
      expect(next.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('stop_work with a card_id refuses an unknown card', async () => {
    const { client, close } = await connectMcp()
    try {
      const res = await callTool(client, 'stop_work', {
        canvas_id: CANVAS,
        card_id: 'nope',
        agent_name: AGENT,
      })
      expect(res.isError).toBe(true)
      expect(res.parsed.error?.code).toBe('not_found')
      /* and the agent-level path is untouched: no stop was recorded */
      expect(actions.wasStopped(CANVAS, AGENT)).toBe(false)
    } finally {
      await close()
    }
  })
})
