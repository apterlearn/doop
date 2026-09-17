import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { Client, startServer, type Server } from './harness.ts'
import type * as Bus from '../server/agentEvents.ts'

/**
 * The bus and the stop/steer registry are in-process state; these cases are
 * about the half that is not — the durable event log (agent_events) and the
 * queued signals (agent_signals) that a boot reads back. Two levels:
 *
 *  - the module cases drive server/agentEvents.ts directly against an
 *    in-memory stand-in for the store, and `vi.resetModules()` is what makes
 *    the restart real: the fresh module has empty maps and is seeded by the
 *    same `hydrate()` the boot calls.
 *  - the last case is the whole thing end to end: a real server, a real
 *    PGlite directory, a real restart, over the same REST surface a human's
 *    Stop button uses.
 */

/** The durable tables, as the store hands them to the bus. `hoisted` so the
 *  table survives `vi.resetModules()` — in this arrangement it IS the
 *  database. */
const tables = vi.hoisted(() => ({
  events: [] as { canvasId: string; seq: number; kind: string; at: number; summary?: string; targetAgent?: string }[],
  signals: [] as {
    canvasId: string
    target: string
    kind: 'stop' | 'steer'
    message?: string
    by: string
    at: number
    takenAt: number | null
  }[],
  /** the agents table, as far as the bus reads it: an id resolves to a name */
  agents: new Map<string, { id: string; ownerId: string; name: string }>(),
}))

vi.mock('../server/db/persist.ts', () => ({
  saveAgentEvent: (row: (typeof tables.events)[number]) => {
    tables.events.push({ ...row })
  },
  agentEventCursors: async () => {
    const cursors = new Map<string, number>()
    for (const row of tables.events) cursors.set(row.canvasId, Math.max(cursors.get(row.canvasId) ?? 0, row.seq))
    return cursors
  },
  pruneAgentEvents: (before: number) => {
    tables.events = tables.events.filter((row) => row.at > before)
  },
  deleteAgentEventsForCanvas: (canvasId: string) => {
    tables.events = tables.events.filter((row) => row.canvasId !== canvasId)
  },
  saveAgentSignal: (row: Omit<(typeof tables.signals)[number], 'takenAt'>) => {
    tables.signals.push({ ...row, takenAt: null })
  },
  listPendingAgentSignals: async () =>
    tables.signals
      .filter((row) => row.takenAt === null)
      .sort((a, b) => a.at - b.at)
      .map(({ canvasId, target, kind, message, by, at }) => ({
        canvasId,
        target,
        kind,
        ...(message ? { message } : {}),
        by,
        at,
      })),
  markAgentSignalsTaken: (canvasId: string, targets: string[], kind: 'stop' | 'steer') => {
    for (const row of tables.signals) {
      if (row.canvasId === canvasId && row.kind === kind && row.takenAt === null && targets.includes(row.target)) {
        row.takenAt = Date.now()
      }
    }
  },
  deleteAgentSignalsForCanvas: (canvasId: string) => {
    tables.signals = tables.signals.filter((row) => row.canvasId !== canvasId)
  },
  pruneAgentSignals: (before: number) => {
    tables.signals = tables.signals.filter((row) => row.at > before)
  },
  /* the id half of a signal's identity: what `hydrate` resolves a row filed
     against a durable id by, so the row can also answer a name lookup */
  getAgent: async (id: string) => tables.agents.get(id),
}))

/* The bus's write-behind is a no-op until a database exists — runLog's rule,
   so a module test that publishes an event does not explode. The stand-in
   above is the database here; this just says the server is booted. */
vi.mock('../server/db/index.ts', () => ({ db: {}, initDb: async () => {}, closeDb: async () => {} }))

let canvasId = ''

/** The bus as a restart leaves it: a fresh module with empty maps, seeded from
 *  the durable tables by the same `hydrate()` the boot calls.
 *
 *  The dynamic import is the point of this helper — `vi.resetModules()` only
 *  re-creates a module for a fresh `await import()`, and a static one would
 *  hand back the instance the previous test already filled. */
async function restart(): Promise<typeof Bus> {
  vi.resetModules()
  const bus = await import('../server/agentEvents.ts')
  await bus.hydrate()
  return bus
}

beforeEach(() => {
  tables.events.length = 0
  tables.signals.length = 0
  tables.agents.clear()
  canvasId = `c-${Math.random().toString(36).slice(2, 10)}`
})

describe('a restart keeps what a human queued', () => {
  it('returns a stop queued before the restart, under the spelling it was filed with', async () => {
    const bus = await restart()
    const queued = bus.requestStop(canvasId, 'HeaderAgent', 'Ada')
    expect(bus.pendingStop(canvasId, 'HeaderAgent')).toMatchObject({ kind: 'stop', by: 'Ada' })

    const restarted = await restart()

    expect(restarted.pendingStop(canvasId, 'HeaderAgent')).toMatchObject({
      canvasId,
      agentName: 'HeaderAgent',
      kind: 'stop',
      by: 'Ada',
      at: queued.at,
    })
    expect(restarted.listSignals(canvasId)).toHaveLength(1)
  })

  it('finds a stop aimed at a role spelling after the restart', async () => {
    const bus = await restart()
    bus.requestStop(canvasId, 'a11y', 'Ada')

    const restarted = await restart()

    /* the human aimed at the role; the agent works it under its own name */
    expect(restarted.pendingStop(canvasId, 'Accessibility')).toMatchObject({ kind: 'stop', by: 'Ada' })
    /* filed under both spellings it answers to, listed once */
    expect(restarted.listSignals(canvasId)).toHaveLength(1)
  })

  it('hands steers queued before the restart over exactly once', async () => {
    const bus = await restart()
    bus.requestSteer(canvasId, 'HeaderAgent', 'focus on the header', 'Ada')
    bus.requestSteer(canvasId, 'HeaderAgent', 'keep the brand blue', 'Bo')

    const restarted = await restart()

    expect(restarted.takeSteers(canvasId, 'HeaderAgent').map((s) => [s.message, s.by])).toEqual([
      ['focus on the header', 'Ada'],
      ['keep the brand blue', 'Bo'],
    ])
    expect(restarted.takeSteers(canvasId, 'HeaderAgent')).toEqual([])

    /* and the drain is durable: the next restart must not hand them over again */
    const third = await restart()
    expect(third.takeSteers(canvasId, 'HeaderAgent')).toEqual([])
  })

  it('does not resurrect a stop the agent already consumed', async () => {
    const bus = await restart()
    bus.requestStop(canvasId, 'HeaderAgent', 'Ada')
    bus.clearStop(canvasId, 'HeaderAgent', 'run-1')
    expect(bus.pendingStop(canvasId, 'HeaderAgent')).toBeUndefined()

    const restarted = await restart()

    expect(restarted.pendingStop(canvasId, 'HeaderAgent')).toBeUndefined()
    expect(restarted.listSignals(canvasId)).toEqual([])
  })

  it('forgets a deleted canvas durably', async () => {
    const bus = await restart()
    bus.requestStop(canvasId, 'HeaderAgent', 'Ada')
    bus.forget(canvasId)

    const restarted = await restart()

    expect(restarted.pendingStop(canvasId, 'HeaderAgent')).toBeUndefined()
  })
})

/* A signal is filed under the spelling the server had — the durable id when the
   REST route resolved the press to one, the name otherwise — and read back
   under the spelling the agent's own call carries, which is its name. The two
   have to meet: `aliasAgent` pairs them where the server resolved them, and
   `hydrate` rebuilds the pair from the durable rows after a restart. */
describe('a signal is found under either spelling of one agent', () => {
  const CLAUDE_ID = 'agent-claude'

  beforeEach(() => {
    tables.agents.set(CLAUDE_ID, { id: CLAUDE_ID, ownerId: 'owner-1', name: 'Claude' })
  })

  it('finds a stop filed against the id by the agent’s name, and the other way round', async () => {
    const bus = await restart()
    /* the route resolved the press to an identity, so it paired the spellings
       before filing — an id on its own is not a name any lookup would carry */
    bus.aliasAgent(canvasId, CLAUDE_ID, 'Claude')
    bus.requestStop(canvasId, CLAUDE_ID, 'Ada')

    expect(bus.pendingStop(canvasId, 'Claude')).toMatchObject({ kind: 'stop', by: 'Ada', agentName: 'Claude' })
    expect(bus.pendingStop(canvasId, CLAUDE_ID)).toMatchObject({ kind: 'stop', by: 'Ada' })
    /* one signal, however many spellings address it */
    expect(bus.listSignals(canvasId)).toHaveLength(1)

    /* and a name-filed stop answers the id lookup the same way */
    bus.clearStop(canvasId, 'Claude', 'run-1')
    bus.requestStop(canvasId, 'Claude', 'Bo')
    expect(bus.pendingStop(canvasId, CLAUDE_ID)).toMatchObject({ kind: 'stop', by: 'Bo' })
    expect(bus.listSignals(canvasId)).toHaveLength(1)
  })

  it('refiles an id-keyed stop under the name the row resolves to, across a restart', async () => {
    const bus = await restart()
    bus.aliasAgent(canvasId, CLAUDE_ID, 'Claude')
    bus.requestStop(canvasId, CLAUDE_ID, 'Ada')
    bus.requestSteer(canvasId, CLAUDE_ID, 'keep the brand blue', 'Ada')

    const restarted = await restart()

    /* the row carries the id; the agent's next call carries its name */
    expect(restarted.pendingStop(canvasId, 'Claude')).toMatchObject({ kind: 'stop', by: 'Ada', agentName: 'Claude' })
    expect(restarted.takeSteers(canvasId, 'Claude').map((s) => s.message)).toEqual(['keep the brand blue'])
    expect(restarted.listSignals(canvasId)).toHaveLength(1)
  })

  it('clears every spelling at once, so the next boot does not hand the stop back', async () => {
    const bus = await restart()
    /* filed by name, cleared by the name in another case: the row carries the
       spelling the press used, and the drain has to stamp it taken */
    bus.requestStop(canvasId, 'HeaderAgent', 'Ada')
    bus.clearStop(canvasId, 'headeragent', 'run-1')

    expect(bus.pendingStop(canvasId, 'HeaderAgent')).toBeUndefined()
    const restarted = await restart()
    expect(restarted.pendingStop(canvasId, 'headeragent')).toBeUndefined()
    expect(restarted.listSignals(canvasId)).toEqual([])
  })

  it('leaves a differently-named agent alone when a stop is aimed at an id', async () => {
    const bus = await restart()
    tables.agents.set('agent-scout', { id: 'agent-scout', ownerId: 'owner-1', name: 'Scout' })
    bus.aliasAgent(canvasId, CLAUDE_ID, 'Claude')
    bus.aliasAgent(canvasId, 'agent-scout', 'Scout')
    bus.requestStop(canvasId, CLAUDE_ID, 'Ada')

    expect(bus.pendingStop(canvasId, 'Claude')).toBeDefined()
    expect(bus.pendingStop(canvasId, 'agent-scout')).toBeUndefined()
  })

  it('does not hand a stop aimed at one id to a same-named agent’s other id', async () => {
    const bus = await restart()
    tables.agents.set('agent-claude-b', { id: 'agent-claude-b', ownerId: 'owner-2', name: 'Claude' })
    /* only the identity the press resolved is paired with the name: the second
       Claude's id was never paired with anything, so a stop aimed at the first
       one does not answer a lookup for the second. (A lookup by the bare NAME
       cannot tell the two apart — the residual limitation the REST route
       refuses to create, by making an ambiguous name a 409.) */
    bus.aliasAgent(canvasId, CLAUDE_ID, 'Claude')
    bus.requestStop(canvasId, CLAUDE_ID, 'Ada')

    expect(bus.pendingStop(canvasId, CLAUDE_ID)).toBeDefined()
    expect(bus.pendingStop(canvasId, 'agent-claude-b')).toBeUndefined()
  })
})

describe('a restart keeps cursors meaningful', () => {
  it('resumes the sequence from the last published event, so a parked agent still wakes', async () => {
    const bus = await restart()
    bus.push(canvasId, { kind: 'comment', targetAgent: 'HeaderAgent', data: { text: 'first' } })
    bus.push(canvasId, { kind: 'comment', targetAgent: 'HeaderAgent', data: { text: 'second' } })
    const taken = bus.cursor(canvasId)

    const restarted = await restart()

    /* the counter used to restart at 1 here, leaving this cursor — taken from
       the previous process — ahead of every event the canvas published next,
       which is how a parked agent went silently deaf */
    expect(restarted.cursor(canvasId)).toBe(taken)
    const parked = restarted.wait(canvasId, { agentName: 'HeaderAgent', cursor: taken, timeoutMs: 1_000 })
    restarted.push(canvasId, { kind: 'comment', targetAgent: 'HeaderAgent', data: { text: 'after the restart' } })

    expect((await parked).map((e) => e.seq)).toEqual([taken + 1])
    expect(restarted.since(canvasId, taken).map((e) => e.seq)).toEqual([taken + 1])
  })

  it('prunes old rows without moving the cursor back', async () => {
    const bus = await restart()
    bus.push(canvasId, { kind: 'comment' })
    bus.push(canvasId, { kind: 'comment' })
    const taken = bus.cursor(canvasId)

    bus.pruneOlderThan(0)

    expect(tables.events).toEqual([])
    expect(bus.cursor(canvasId)).toBe(taken)
    bus.push(canvasId, { kind: 'comment' })
    expect(bus.cursor(canvasId)).toBe(taken + 1)
  })
})

/* The same thing over the wire: a real server, the Stop button's own route,
   and a restart of the process that queued it. */
const PORT = 4998

it('keeps a queued stop across a real server restart', async () => {
  let server: Server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  try {
    const owner = new Client(server)
    await owner.signUp('durable-bus@test.dev', 'Durable Owner')
    const canvas = await (await owner.post('/api/canvases', { name: 'Durable bus' })).json()

    expect((await owner.post(`/api/canvases/${canvas.id}/agents/HeaderAgent/stop`, {})).status).toBe(200)
    const queued = await (await owner.get(`/api/canvases/${canvas.id}/agent-signals`)).json()
    expect(queued.signals).toMatchObject([{ agentName: 'HeaderAgent', kind: 'stop', by: 'Durable Owner' }])

    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    server = await startServer(PORT + 1, { BETTER_AUTH_URL: `http://localhost:${PORT + 1}` }, dataDir)

    const back = new Client(server)
    expect(
      (await back.post('/api/auth/sign-in/email', { email: 'durable-bus@test.dev', password: 'password12345' })).status,
    ).toBe(200)
    const { signals } = await (await back.get(`/api/canvases/${canvas.id}/agent-signals`)).json()

    expect(signals).toMatchObject([{ canvasId: canvas.id, kind: 'stop', by: 'Durable Owner' }])

    /* a second stop, from the process that booted after the first: its event
         must continue the sequence the first published, which is the whole
         point of the durable log */
    expect((await back.post(`/api/canvases/${canvas.id}/agents/CopyAgent/stop`, {})).status).toBe(200)

    /* read the table itself: the server logs a failed write instead of
         failing the call, so nothing above would notice an insert that never
         landed. The cluster is closed, so the directory is readable. */
    server.stop({ keepData: true })
    await server.stopped
    const durable = new PGlite(path.join(dataDir, 'data', 'pg'))
    try {
      const { rows } = await durable.query<{ seq: number; kind: string; target_agent: string }>(
        'select seq, kind, target_agent from agent_events where canvas_id = $1 order by seq',
        [canvas.id],
      )
      expect(rows.map((row) => [Number(row.seq), row.kind, row.target_agent])).toEqual([
        [1, 'stop', 'HeaderAgent'],
        [2, 'stop', 'CopyAgent'],
      ])
    } finally {
      await durable.close()
    }
  } finally {
    server.stop()
  }
}, 70_000)
