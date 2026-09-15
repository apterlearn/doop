import { beforeEach, describe, expect, it } from 'vitest'
import { forgetCanvas, getRunEvents, hydrate, pruneOlderThan, record } from '../server/runLog.ts'
import type { RunEvent } from '../shared/types.ts'

/**
 * The run timeline is what answers "what did the agent actually do": one row
 * per MCP tool call, recorded as an agent works. The per-canvas ring is the
 * read path — the DB write is fire-and-forget and absent without a booted
 * server — so these cases drive the module directly, with a fresh canvas id
 * per case because the ring is module state.
 */

let canvasId = ''

beforeEach(() => {
  canvasId = `c-${Math.random().toString(36).slice(2, 10)}`
})

function recordTool(i: number, runId = 'run-1'): RunEvent {
  return record({
    canvasId,
    runId,
    agentName: 'Doop Agent',
    kind: 'tool',
    name: 'create_frame',
    ok: true,
    ms: i,
    summary: `call ${i}`,
  })
}

/**
 * One row as the boot path hands it to the ring: the id and timestamp are the
 * database's, and each canvas's list arrives newest first — the order
 * `record` writes and the reads assume.
 */
function persistedTool(i: number, at: number): RunEvent {
  return {
    id: `persisted-${i}`,
    canvasId,
    runId: 'run-1',
    agentName: 'Doop Agent',
    kind: 'tool',
    name: 'create_frame',
    ok: true,
    ms: i,
    summary: `call ${i}`,
    at,
  }
}

describe('record / getRunEvents', () => {
  it('returns a canvas newest first with distinct ids and the recorded fields', () => {
    const first = recordTool(1)
    const second = recordTool(2)
    const third = recordTool(3)
    const events = getRunEvents(canvasId)

    expect(events.map((e) => e.summary)).toEqual(['call 3', 'call 2', 'call 1'])
    expect(new Set(events.map((e) => e.id)).size).toBe(3)
    expect(events[0]).toMatchObject({
      id: third.id,
      canvasId,
      runId: 'run-1',
      agentName: 'Doop Agent',
      kind: 'tool',
      name: 'create_frame',
      ok: true,
      ms: 3,
      summary: 'call 3',
    })
    expect(third.at).toBeGreaterThanOrEqual(first.at)
    expect(third.at).toBeGreaterThanOrEqual(second.at)
  })

  it('honours an explicit timestamp instead of stamping the record time', () => {
    const at = Date.now() - 5_000
    const event = record({ canvasId, runId: 'run-1', agentName: 'Doop Agent', kind: 'tool', at })
    expect(event.at).toBe(at)
    expect(getRunEvents(canvasId)[0]?.at).toBe(at)
  })

  it('keeps only the newest 500 events of a canvas', () => {
    for (let i = 0; i < 600; i++) recordTool(i)
    const events = getRunEvents(canvasId, { limit: 500 })
    expect(events).toHaveLength(500)
    expect(events[0]?.summary).toBe('call 599')
    expect(events.at(-1)?.summary).toBe('call 100')
  })

  it('caps a read at 200 events by default', () => {
    for (let i = 0; i < 250; i++) recordTool(i)
    const events = getRunEvents(canvasId)
    expect(events).toHaveLength(200)
    expect(events[0]?.summary).toBe('call 249')
  })

  it('filters a read to one run', () => {
    recordTool(1, 'run-a')
    recordTool(2, 'run-b')
    recordTool(3, 'run-a')
    expect(getRunEvents(canvasId, { runId: 'run-a' }).map((e) => e.summary)).toEqual(['call 3', 'call 1'])
    expect(getRunEvents(canvasId, { runId: 'run-b' }).map((e) => e.summary)).toEqual(['call 2'])
    expect(getRunEvents(canvasId, { runId: 'run-none' })).toEqual([])
  })

  it('reports an unknown canvas as empty', () => {
    expect(getRunEvents('c-never-used')).toEqual([])
  })
})

describe('hydrate', () => {
  it('seeds a canvas with the persisted events in the newest-first order they arrived in', () => {
    const base = Date.now()
    const persisted = [persistedTool(3, base), persistedTool(2, base - 1_000), persistedTool(1, base - 2_000)]
    hydrate(new Map([[canvasId, persisted]]))

    const events = getRunEvents(canvasId)
    expect(events.map((e) => e.summary)).toEqual(['call 3', 'call 2', 'call 1'])
    expect(events[0]).toMatchObject({ id: 'persisted-3', canvasId, runId: 'run-1', at: base })
  })

  it('leaves a canvas with no persisted events reading as empty', () => {
    const empty: RunEvent[] = []
    hydrate(new Map([[canvasId, empty]]))

    expect(getRunEvents(canvasId)).toEqual([])
    recordTool(1)
    expect(empty).toHaveLength(0)
  })

  it('keeps only the newest 500 of a longer persisted list, leaving the list itself whole', () => {
    const base = Date.now()
    const persisted: RunEvent[] = []
    for (let i = 599; i >= 0; i--) persisted.push(persistedTool(i, base - (599 - i)))
    hydrate(new Map([[canvasId, persisted]]))

    const events = getRunEvents(canvasId, { limit: 500 })
    expect(events).toHaveLength(500)
    expect(events[0]?.summary).toBe('call 599')
    expect(events.at(-1)?.summary).toBe('call 100')
    expect(persisted).toHaveLength(600)
  })

  it('does not alias the persisted list when the canvas is recorded to again', () => {
    const base = Date.now()
    const persisted = [persistedTool(2, base), persistedTool(1, base - 1_000)]
    hydrate(new Map([[canvasId, persisted]]))

    recordTool(3)

    expect(getRunEvents(canvasId).map((e) => e.summary)).toEqual(['call 3', 'call 2', 'call 1'])
    expect(persisted.map((e) => e.summary)).toEqual(['call 2', 'call 1'])
  })
})

describe('forgetCanvas / pruneOlderThan', () => {
  it('forgets a canvas entirely', () => {
    recordTool(1)
    recordTool(2)
    forgetCanvas(canvasId)
    expect(getRunEvents(canvasId)).toEqual([])
  })

  it('prunes every event at or before the cutoff', () => {
    recordTool(1)
    recordTool(2)
    pruneOlderThan(0)
    expect(getRunEvents(canvasId)).toEqual([])
  })

  it('keeps events newer than the cutoff', () => {
    record({
      canvasId,
      runId: 'run-1',
      agentName: 'Doop Agent',
      kind: 'tool',
      summary: 'old',
      at: Date.now() - 60_000,
    })
    record({ canvasId, runId: 'run-1', agentName: 'Doop Agent', kind: 'tool', summary: 'fresh' })
    pruneOlderThan(30_000)
    expect(getRunEvents(canvasId).map((e) => e.summary)).toEqual(['fresh'])
  })
})
