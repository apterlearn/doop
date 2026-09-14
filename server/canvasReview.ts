import type { CanvasReviewFrame, CanvasReviewSummary } from '../shared/types.ts'
import { store } from './store.ts'
import * as persist from './db/persist.ts'
import { reportIsCurrent, reviewFrame, reviewToRecord } from './review.ts'

/**
 * The canvas-level sweep: the per-frame `review_frame` gate, aggregated over
 * every frame a canvas holds. A human about to ship a whole design asks one
 * question — does this canvas pass? — and gets one verdict with a row per
 * frame, rather than a frame id per call.
 *
 * One frame at a time, in canvas order: the checks share one headless browser,
 * so a parallel fan-out would only contend for it, and a sweep is a person
 * waiting for an answer rather than a request that has to finish in one tick.
 * A frame that cannot be rendered is recorded and stepped over — one broken
 * frame must not cost the canvas its answer.
 */

/** The counts a stored report carries, read back without re-rendering. The
 *  full report is a jsonb column, so it is `unknown` at the boundary; a row
 *  written before a field existed must not crash the sweep. */
function storedFindings(report: unknown): { blocking: number; advisory: number } {
  const shape = report as { blocking?: unknown; advisory?: unknown } | null
  return {
    blocking: Array.isArray(shape?.blocking) ? shape.blocking.length : 0,
    advisory: Array.isArray(shape?.advisory) ? shape.advisory.length : 0,
  }
}

export async function reviewCanvas(
  canvasId: string,
  opts: { pageId?: string; actor: { userId: string; agentName: string } },
): Promise<CanvasReviewSummary> {
  const startedAt = Date.now()
  const canvas = store.getCanvas(canvasId)
  /* a sweep of a canvas that does not exist is a caller bug, not a pass: every
     tool checks the canvas first, and a "pass" here would be a lie the ship
     gate could read */
  if (!canvas) throw new Error(`no canvas with id ${canvasId}`)
  /* the frames the canvas shows, in canvas order: demo frames are product
     onboarding content, never the design being verified */
  const frames = canvas.frames.filter(
    (frame) => !frame.demo && (opts.pageId === undefined || frame.pageId === opts.pageId),
  )
  /* the canvas's breakpoints are the widths this design claims to support, so
     they are reviewed on top of the device presets exactly as review_frame
     reviews them — a sweep must agree with the per-frame tool */
  const breakpoints = canvas.breakpoints ?? []
  const rows: CanvasReviewFrame[] = []

  for (const frame of frames) {
    /* newest first: the report the delivery gate reads is the report the sweep
       reuses, so an already-verified canvas costs no renders at all */
    const [stored] = await persist.listFrameReviews(frame.id, 1)
    if (stored && reportIsCurrent({ html_sha: stored.htmlSha }, frame, canvas.tokens)) {
      rows.push({
        frameId: frame.id,
        name: frame.name,
        verdict: stored.verdict === 'pass' ? 'pass' : 'fail',
        ...storedFindings(stored.report),
      })
      continue
    }
    try {
      const report = await reviewFrame(frame, canvas.tokens, breakpoints.length ? { breakpoints } : {})
      await persist.saveFrameReview(reviewToRecord(report, canvasId, opts.actor.agentName))
      rows.push({
        frameId: frame.id,
        name: frame.name,
        verdict: report.verdict === 'pass' ? 'pass' : 'fail',
        blocking: report.blocking.length,
        advisory: report.advisory.length,
      })
    } catch (err) {
      /* a crash, a render timeout, a rate limit — the rest of the canvas is
         still worth an answer, so the frame is recorded and the sweep goes on */
      const findings = stored ? storedFindings(stored.report) : { blocking: 0, advisory: 0 }
      rows.push({
        frameId: frame.id,
        name: frame.name,
        /* a stored report that no longer describes the frame is evidence of a
           check that happened: out of date is a different thing from never
           checked, and only the sweep can tell the two apart */
        verdict: stored ? 'stale' : 'skipped',
        ...findings,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const totals = { pass: 0, fail: 0, stale: 0, skipped: 0 }
  for (const row of rows) totals[row.verdict] += 1
  return {
    verdict: totals.fail > 0 || totals.stale > 0 ? 'fail' : 'pass',
    totals,
    frames: rows,
    durationMs: Date.now() - startedAt,
  }
}
