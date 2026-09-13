/**
 * Instance-wide admission control for resident runs.
 *
 * `running`/`queued` in server/resident.ts are keyed by canvas, so they only
 * serialise a canvas against itself: with N canvases each holding queued
 * cards, N sweeps start N model runs at once, every one of them streaming a
 * paid model call and rendering through the same Chromium. Nothing in the repo
 * counted runs instance-wide, so a busy instance had no ceiling at all — a
 * burst of cards on a dozen canvases was a burst of a dozen models.
 *
 * This is that ceiling, and it is deliberately tiny: one process-wide count of
 * runs in flight, plus a FIFO queue of the canvases waiting for one. It knows
 * nothing about cards, agents or models — the resident loop asks for a slot
 * before it starts a sweep and gives it back in its `finally`, the same shape
 * as a frame lock. State is in memory on purpose: a restart ends every run
 * anyway, so a persisted queue would only resurrect work nobody is waiting on.
 *
 * Protocol for a caller:
 *
 *   const grant = requestRun(canvasId)
 *   if (!grant.granted) { park and retry later — `grant.ahead` is how many
 *     canvases are in front, and queuedRuns() lists them in service order }
 *   else { run, then releaseRun(canvasId) in a `finally` }
 *
 * A queued canvas keeps its place only while something keeps asking on its
 * behalf, so a refused caller should arrange its own retry (and a waker that
 * re-requests for every canvas queuedRuns() reports drains the queue fastest).
 */

/** Runs allowed at once across the whole process. An agent run streams a paid
 *  model call and renders through the shared browser, so this is a resource
 *  ceiling rather than a rate limit: four leaves the machine usable while
 *  still letting a handful of canvases make progress. Override with
 *  DOOP_MAX_CONCURRENT_RUNS. */
const DEFAULT_MAX_CONCURRENT_RUNS = 4

/* Mirrors limits.ts's positiveInt: a typo in the env var must not become a
   ceiling of zero, which would stop every run on the instance. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** How many runs may be in flight at once. Read per call rather than frozen at
 *  module load, so a test — or a process launched with a different env — sees
 *  the value it is actually running under. */
export function maxConcurrentRuns(): number {
  return positiveInt(process.env.DOOP_MAX_CONCURRENT_RUNS, DEFAULT_MAX_CONCURRENT_RUNS)
}

/* Canvases holding a slot right now. */
const inFlight = new Set<string>()

/* Canvases waiting for one, in service order. One entry per canvas: a canvas
   that keeps asking while it waits must not accumulate positions. */
const waiting: { canvasId: string; waitedSince: number }[] = []

/** How many runs are in flight across the instance right now. */
export function inFlightRuns(): number {
  return inFlight.size
}

/** Ask for a slot on this canvas's behalf.
 *
 *  Granted when the canvas already holds one (the same request, answered the
 *  same way), or when a slot is free and nobody has waited longer for it.
 *  Otherwise the canvas is queued — once, however often it asks — and told how
 *  many canvases are ahead of it.
 *
 *  Only the head of the queue may claim a slot a run just freed. That is the
 *  fairness rule: a canvas that has just finished and asks again goes to the
 *  back behind everyone who waited through its run, instead of taking the slot
 *  it freed back immediately and starving a long queue on a busy canvas. */
export function requestRun(canvasId: string): { granted: true } | { granted: false; ahead: number } {
  if (inFlight.has(canvasId)) return { granted: true }
  const at = waiting.findIndex((w) => w.canvasId === canvasId)
  if (at >= 0) {
    if (at === 0 && inFlight.size < maxConcurrentRuns()) {
      waiting.shift()
      inFlight.add(canvasId)
      return { granted: true }
    }
    return { granted: false, ahead: at }
  }
  if (waiting.length === 0 && inFlight.size < maxConcurrentRuns()) {
    inFlight.add(canvasId)
    return { granted: true }
  }
  waiting.push({ canvasId, waitedSince: Date.now() })
  return { granted: false, ahead: waiting.length - 1 }
}

/** Give the slot back when a canvas's sweep ends — and drop a pending request
 *  for a canvas that gave up while waiting, so a queue entry nobody will claim
 *  cannot block the canvases behind it. Idempotent: releasing a canvas that
 *  holds nothing and waits for nothing is a no-op. */
export function releaseRun(canvasId: string): void {
  const at = waiting.findIndex((w) => w.canvasId === canvasId)
  if (at >= 0) waiting.splice(at, 1)
  inFlight.delete(canvasId)
}

/** The waiting canvases in service order — who to wake, and how long each has
 *  been waiting. A snapshot: mutating it does not touch the queue. */
export function queuedRuns(): { canvasId: string; waitedSince: number }[] {
  return waiting.map((w) => ({ canvasId: w.canvasId, waitedSince: w.waitedSince }))
}

/** Test-only: forget every slot and waiter. */
export function resetScheduler(): void {
  inFlight.clear()
  waiting.length = 0
}
