import { nanoid } from 'nanoid'
import { asc, eq, lte } from 'drizzle-orm'
import { db } from './db/index.ts'
import { runEvents, runJournals, runSteps, runs } from './db/schema.ts'
import type { RunEvent, RunJournal, ServerMessage } from '../shared/types.ts'

/**
 * The resident agent's run timeline: one record per model turn, tool call,
 * status line, error or stop, so a human can see what an agent actually did
 * instead of only where it ended up.
 *
 * The per-canvas ring is the hot path and the source of truth for reads, the
 * same shape as actions.ts's activityLog. Each event is mirrored to the
 * database fire-and-forget so a restart does not erase the recent history; a
 * write that fails, or cannot happen yet, never reaches the run.
 *
 * The module also owns the `runs` / `run_steps` tables — the run's own durable
 * record and the transcript a restart replays it from (see the durable-runs
 * section below) — so every DB write behind the resident loop lives here.
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

/** Append one event to a canvas's timeline and return it as stored. */
export function record(event: Omit<RunEvent, 'id' | 'at'> & { at?: number }): RunEvent {
  const full: RunEvent = { ...event, id: nanoid(8), at: event.at ?? Date.now() }
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

/* ---- durable runs ---- */

/* The `runs` / `run_steps` half of the log: the row that says a run happened
   and the transcript a restart can replay it from. The events above are what
   a human reads; these rows are what the resident loop itself resumes from,
   so they are written through the same fire-and-forget — losing a step
   degrades a replay, it must not fail the turn that produced it. */

/** Open a run's durable record at the moment its id is minted: `cardIds` and
   `model` name what the run is working and on whose behalf, everything a
   resume needs to re-bill the same work. */
export function startRun(row: {
  id: string
  canvasId: string
  agentName: string
  cardIds: string[]
  model: string
}): void {
  const at = Date.now()
  writeBehind(() =>
    db.insert(runs).values({
      id: row.id,
      canvasId: row.canvasId,
      agentName: row.agentName,
      cardIds: row.cardIds,
      model: row.model,
      status: 'running',
      startedAt: at,
      updatedAt: at,
    }),
  )
}

/** Append one transcript entry. `payload` is the message object exactly as it
   was pushed into the loop, so a replay re-feeds the provider the same bytes. */
export function appendRunStep(runId: string, seq: number, role: 'assistant' | 'user', payload: unknown): void {
  writeBehind(() =>
    db.insert(runSteps).values({ id: nanoid(8), runId, seq, role, payload: payload as object, createdAt: Date.now() }),
  )
}

/** Close a run's durable record with how it ended: done reached its goal,
   failed crashed or was refused, stopped was cancelled by a human. */
export function finishRun(runId: string, status: 'done' | 'failed' | 'stopped'): void {
  writeBehind(() => db.update(runs).set({ status, updatedAt: Date.now() }).where(eq(runs.id, runId)))
}

/** A run whose row still says `running` when the process starts never got to
   close its record: the server died under it. These are what
   `resumeInterruptedRuns` replays. */
export async function interruptedRuns(): Promise<
  { id: string; canvasId: string; agentName: string; cardIds: string[]; model?: string }[]
> {
  if (!db) return []
  const rows = await db.select().from(runs).where(eq(runs.status, 'running'))
  return rows.map((row) => ({
    id: row.id,
    canvasId: row.canvasId,
    agentName: row.agentName,
    cardIds: row.cardIds ?? [],
    ...(row.model ? { model: row.model } : {}),
  }))
}

/** One run's transcript in order — the `seq` the loop wrote, oldest first. */
export async function runStepsFor(
  runId: string,
): Promise<{ seq: number; role: 'assistant' | 'user'; payload: unknown }[]> {
  const rows = await db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(asc(runSteps.seq))
  return rows.map((row) => ({ seq: row.seq, role: row.role as 'assistant' | 'user', payload: row.payload }))
}

/** Drop a run's transcript when its canvas is forgotten; the events above go
   through `forgetCanvas`, the run rows follow the same lifecycle. */
export function forgetRuns(canvasId: string): void {
  writeBehind(async () => {
    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.canvasId, canvasId))
    for (const row of rows) await db.delete(runSteps).where(eq(runSteps.runId, row.id))
    await db.delete(runs).where(eq(runs.canvasId, canvasId))
  })
}

/* The journal columns `recordRunJournal` now carries — duration, totals, cost —
   ride in memory through `saveJournal` until persist.ts adds the columns; the
   mirror below is what closes that gap from the one file that owns run-event
   writes. Written after `actions.recordRunJournal` has stored the entry, keyed
   by the journal id the action returned in the log. */
export function mirrorJournal(journal: RunJournal): void {
  writeBehind(() =>
    db
      .update(runJournals)
      .set({
        startedAt: journal.startedAt ?? null,
        endedAt: journal.endedAt ?? null,
        turns: journal.turns ?? null,
        toolCalls: journal.toolCalls ?? null,
        tokens: journal.tokens ?? null,
        costUsd: journal.costUsd ?? null,
      })
      .where(eq(runJournals.id, journal.id)),
  )
}
