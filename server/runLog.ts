import { nanoid } from 'nanoid'
import { eq, lte } from 'drizzle-orm'
import { db } from './db/index.ts'
import { runEvents } from './db/schema.ts'
import type { RunEvent, ServerMessage } from '../shared/types.ts'

/**
 * An agent's run timeline: one record per model turn, tool call, status line,
 * error or stop, so a human can see what an agent actually did instead of
 * only where it ended up.
 *
 * The per-canvas ring is the hot path and the source of truth for reads, the
 * same shape as actions.ts's activityLog. Each event is mirrored to the
 * database fire-and-forget so a restart does not erase the recent history; a
 * write that fails, or cannot happen yet, never reaches the run.
 */
/** Ring size per canvas: the Run tab reads a bounded recent window. */
const CAP = 500

/** How many events a read returns unless the caller asks for fewer. */
const DEFAULT_LIMIT = 200

const runLog = new Map<string, RunEvent[]>() // canvasId -> events (newest first)

/** Where a recorded event is announced to the canvas's ws room. Wired by the
 *  server at boot; the no-op default keeps recording usable with no room
 *  (module tests, a worker process). */
type Broadcast = (canvasId: string, msg: ServerMessage) => void

let broadcast: Broadcast = () => {}

export function wireBroadcast(b: Broadcast): void {
  broadcast = b
}

/** Fire-and-forget DB statement. `db` is unset until the server boots (and in
 *  module-level tests), and a failed write is logged rather than thrown: the
 *  ring above already holds the event, and losing durability must not fail
 *  the run that is reporting it. */
function writeBehind(statement: () => Promise<unknown>): void {
  if (!db) return
  try {
    statement().catch((err) => console.error('[db] write failed', err))
  } catch (err) {
    console.error('[db] write failed', err)
  }
}

/** Append one event to a canvas's timeline and return it as stored. `kind`
 *  defaults to `'tool'`, so the common case — a tool call — need not spell it
 *  out, and the status/error/stop lines `recordStatus` writes do. */
export function record(
  event: Omit<RunEvent, 'id' | 'at' | 'kind'> & { kind?: RunEvent['kind']; at?: number },
): RunEvent {
  const full: RunEvent = { ...event, kind: event.kind ?? 'tool', id: nanoid(8), at: event.at ?? Date.now() }
  const list = runLog.get(full.canvasId) ?? []
  list.unshift(full)
  if (list.length > CAP) list.length = CAP
  runLog.set(full.canvasId, list)
  writeBehind(() =>
    db.insert(runEvents).values({
      id: full.id,
      canvasId: full.canvasId,
      runId: full.runId,
      agentName: full.agentName,
      at: full.at,
      kind: full.kind,
      name: full.name ?? null,
      ok: full.ok ?? null,
      ms: full.ms ?? null,
      summary: full.summary ?? null,
      /* the replay cursor: which frame this step touched and the versions it
         started from and produced. A field left out of this list lives in the
         ring only — the row would come back from a restart without it. */
      frameId: full.frameId ?? null,
      beforeVersionId: full.beforeVersionId ?? null,
      afterVersionId: full.afterVersionId ?? null,
    }),
  )
  broadcast(full.canvasId, { type: 'run:event', event: full })
  return full
}

/** Record a step that is not a tool call: a status line ("implementing attempt
 *  2/3", "judge reviewing"), a failure, or the stop that ended the run. Same
 *  ring, write-behind and broadcast as `record`; only the fields differ.
 *
 *  The summary is flattened to one line and cut at 200 characters — the bound
 *  a tool result summary carries and what the Run tab renders. A status line
 *  is often a human's sentence and an error is often a multi-line stack;
 *  neither should reach the ring raw. */
export function recordStatus(
  canvasId: string,
  runId: string,
  agentName: string,
  kind: 'status' | 'error' | 'stop',
  summary: string,
  opts: { name?: string; ok?: boolean; frameId?: string } = {},
): RunEvent {
  return record({
    canvasId,
    runId,
    agentName,
    kind,
    summary: summary.replace(/\s+/g, ' ').trim().slice(0, 200),
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.ok !== undefined ? { ok: opts.ok } : {}),
    ...(opts.frameId ? { frameId: opts.frameId } : {}),
  })
}

/** A canvas's timeline, newest first — optionally one run's, and never more
 *  than the ring holds. */
export function getRunEvents(canvasId: string, opts: { limit?: number; runId?: string } = {}): RunEvent[] {
  const list = runLog.get(canvasId) ?? []
  const wanted = opts.runId ? list.filter((event) => event.runId === opts.runId) : list
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 0), CAP)
  return wanted.slice(0, limit)
}

/** Drop a canvas's timeline: its rows in the database and its ring in memory. */
export function forgetCanvas(canvasId: string): void {
  runLog.delete(canvasId)
  writeBehind(() => db.delete(runEvents).where(eq(runEvents.canvasId, canvasId)))
}

/** Seed the ring from the database at boot — a restart must not erase the
 *  recent timeline a human was watching. Each list arrives newest first, the
 *  order `record` and the reads assume, and is copied so the ring never
 *  aliases the hydrated map; a canvas with no events is left out entirely
 *  rather than given an empty list to carry. */
export function hydrate(events: Map<string, RunEvent[]>): void {
  for (const [canvasId, list] of events) {
    if (list.length === 0) continue
    runLog.set(canvasId, list.slice(0, CAP))
  }
}

/** Retention pass: forget everything at least `ms` old — what the boot path
 *  calls to keep seven days of history. An event exactly on the cutoff counts
 *  as pruned, so `pruneOlderThan(0)` empties the log. */
export function pruneOlderThan(ms: number): void {
  const cutoff = Date.now() - ms
  for (const [canvasId, list] of runLog) {
    const kept = list.filter((event) => event.at > cutoff)
    if (kept.length === list.length) continue
    if (kept.length === 0) runLog.delete(canvasId)
    else runLog.set(canvasId, kept)
  }
  writeBehind(() => db.delete(runEvents).where(lte(runEvents.at, cutoff)))
}
