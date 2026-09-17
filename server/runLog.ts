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

/** The bound a step's argument JSON is cut to, in bytes. A tool call's
 *  arguments are what makes the Run tab's detail pane worth opening; they are
 *  also the one field a caller cannot be trusted to bound, so the cut happens
 *  here, at the write boundary, rather than at each call site. */
export const ARGS_CAP = 2048

/** Strict decoder: a byte sequence cut mid-character throws rather than
 *  decoding to U+FFFD, which is how the cut below knows to step back. */
const utf8 = new TextDecoder('utf-8', { fatal: true })

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
 *  out, and the status/error/stop lines `recordStatus` writes do.
 *
 *  `args` is the caller's argument JSON as a string, the same way `summary` is
 *  a string the caller has already written out. It is cut to ARGS_CAP bytes
 *  here, at the write boundary, because that is the one bound a caller cannot
 *  be trusted to apply: the JSON is stored and rendered as text, so a tail cut
 *  mid-value is cosmetic, but the bytes straddling the cut are walked back off
 *  a multi-byte character so what lands in the column is always valid UTF-8.
 *  Only a tool step keeps arguments — a status, error or stop line records
 *  none — and the ring and the row are cut the same way, so a restart rebuilds
 *  the timeline the run actually showed. */
export function record(
  event: Omit<RunEvent, 'id' | 'at' | 'kind'> & { kind?: RunEvent['kind']; at?: number },
): RunEvent {
  const { args: rawArgs, ...step } = event
  const kind = step.kind ?? 'tool'
  let args: string | undefined
  if (kind === 'tool' && rawArgs !== undefined) {
    args = rawArgs
    const bytes = Buffer.from(rawArgs, 'utf8')
    if (bytes.length > ARGS_CAP) {
      let end = ARGS_CAP
      for (;;) {
        try {
          args = utf8.decode(bytes.subarray(0, end))
          break
        } catch {
          end--
        }
      }
    }
  }
  const full: RunEvent = {
    ...step,
    kind,
    id: nanoid(8),
    at: step.at ?? Date.now(),
    ...(args !== undefined ? { args } : {}),
  }
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
      /* a tool call's arguments, already cut above; null for every other kind */
      args: full.args ?? null,
      /* who the actor was — the run's own identity, not the canvas's. A step
         recorded without one comes back without one rather than as a
         fabricated default. */
      actorKind: full.actorKind ?? null,
      agentId: full.agentId ?? null,
      /* `actorOwner` is deliberately not a column: the id above joins to the
         agents row the account lives on, so the display string stays in the
         ring (and the broadcast) and is re-derived rather than duplicated. */
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
 *  neither should reach the ring raw.
 *
 *  `opts.actorKind`, `opts.agentId` and `opts.actorOwner` stamp the run's own
 *  identity on the line, so the design engine's status lines say who is
 *  running them and a client can address the right agent when two share a
 *  display name. All three are optional and left out rather than defaulted;
 *  `actorOwner` rides the ring and the broadcast only, since the id is what
 *  joins back to the account. */
export function recordStatus(
  canvasId: string,
  runId: string,
  agentName: string,
  kind: 'status' | 'error' | 'stop' | 'ended',
  summary: string,
  opts: {
    name?: string
    ok?: boolean
    frameId?: string
    actorKind?: RunEvent['actorKind']
    agentId?: string
    actorOwner?: string
  } = {},
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
    ...(opts.actorKind ? { actorKind: opts.actorKind } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.actorOwner ? { actorOwner: opts.actorOwner } : {}),
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
