import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import * as review from '../server/review.ts'
import { reviewCanvas } from '../server/canvasReview.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The sweep reads stored reports and writes new ones, so this file drives the
   real database: a PGlite cluster in a temp directory, migrated at boot exactly
   as the server does. Most of what the aggregation does needs no browser — a
   stored row of the documented shape is enough to prove reuse, staleness and
   the skip-and-carry-on path — and the one test that proves a real review
   stores what the checks panel and the delivery gate read is browser-gated the
   way every other render test is. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-canvas-review-'))
const OWNER_ID = 'sweep-owner'
const ACTOR = { userId: OWNER_ID, agentName: 'Claude' }
const PAGE = 'p-sweep'
const OTHER_PAGE = 'p-other'

/* Every render funnels through here, so a sweep that re-renders a frame it
   could have reused shows up as a render rather than as a slower test. */
const renders = vi.hoisted(() => ({ ids: [] as string[], failFor: new Set<string>() }))

vi.mock('../server/review.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof review>()
  return {
    ...actual,
    reviewFrame: async (...args: Parameters<typeof actual.reviewFrame>) => {
      renders.ids.push(args[0].id)
      if (renders.failFor.has(args[0].id)) throw new Error(`render failed for ${args[0].id}`)
      return actual.reviewFrame(...args)
    },
  }
})

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

afterEach(() => {
  renders.ids.length = 0
  renders.failFor.clear()
})

const CLEAN = `<!doctype html><html lang="en"><head><title>Acme</title>
  <meta name="description" content="Acme.">
  <style>
    body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
    h1 { font-size: 32px; line-height: 1.25; }
    a:hover { text-decoration: underline }
    a:focus-visible { outline: 2px solid #111110 }
  </style></head>
  <body><main style="min-height:700px"><h1>Acme</h1>
  <p style="color:#111110">We make things that work, reliably.</p>
  <a href="/start" style="color:#111110">Start</a></main></body></html>`

/* One blocking finding and nothing else: an image with no alt text is
   `missing_alt`, which the review treats as a delivery blocker. */
const UNLABELED_IMAGE = CLEAN.replace(
  '<h1>Acme</h1>',
  '<h1>Acme</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="20" height="20">',
)

function frame(id: string, canvasId: string, name: string, html: string, pageId = PAGE): Frame {
  return {
    id,
    canvasId,
    name,
    x: 0,
    y: 0,
    width: 1200,
    height: 900,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'Claude',
    pageId,
  }
}

function seed(canvasId: string, frames: Frame[]): Canvas {
  const canvas: Canvas = {
    id: canvasId,
    name: 'Sweep',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames,
    pages: [PAGE, OTHER_PAGE].map((id, position) => ({
      id,
      canvasId,
      name: `Page ${position + 1}`,
      position,
      createdAt: 0,
      updatedAt: 0,
    })),
  }
  store.init([canvas])
  return canvas
}

/** A stored row of the shape `review_frame` writes, without a render: what the
 *  sweep does with a report it already has is the thing under test, and making
 *  a real one would need a browser to review a five-viewport canvas.
 *  `current: false` hashes a different document, which is what a frame edited
 *  after its review looks like from here. */
function storedReview(
  frame: Frame,
  opts: { current?: boolean; blocking?: number; advisory?: number } = {},
): review.ReviewReport {
  const blocking = Array.from({ length: opts.blocking ?? 0 }, (_, i) => ({
    rule: `blocking_${i}`,
    selector: 'body',
    detail: '',
    source: 'a11y' as const,
  }))
  const advisory = Array.from({ length: opts.advisory ?? 0 }, (_, i) => ({
    rule: `advisory_${i}`,
    selector: 'body',
    detail: '',
    source: 'layout' as const,
  }))
  return {
    frame_id: frame.id,
    html_sha:
      opts.current === false
        ? review.frameSha({ ...frame, html: 'changed' }, undefined)
        : review.frameSha(frame, undefined),
    frame_updated_at: frame.updatedAt,
    reviewed_at: Date.now(),
    viewports: [],
    summary: {
      critical: 0,
      serious: 0,
      errors: 0,
      warnings: 0,
      off_token: 0,
      off_token_font: 0,
      off_token_type: 0,
      content_errors: 0,
      content_warnings: 0,
    },
    blocking,
    advisory,
    failing_viewports: [],
    verdict: blocking.length ? 'fail' : 'pass',
  }
}

describe('sweeping a canvas', () => {
  const CANVAS_REUSE = 'c-reuse'
  const CANVAS_SKIP = 'c-skip'
  const CANVAS_STALE = 'c-stale'
  const CANVAS_PAGES = 'c-pages'
  const CANVAS_EMPTY = 'c-empty'

  it('reuses a current stored report instead of rendering the frame again', async () => {
    const f = frame('f-reuse', CANVAS_REUSE, 'Home', CLEAN)
    seed(CANVAS_REUSE, [f])
    await persist.saveFrameReview(
      review.reviewToRecord(storedReview(f, { blocking: 1, advisory: 2 }), CANVAS_REUSE, 'earlier'),
    )

    const summary = await reviewCanvas(CANVAS_REUSE, { actor: ACTOR })

    /* nothing was rendered, and the row is the stored report verbatim — its
       verdict and both counts, not a re-derived guess */
    expect(renders.ids).toEqual([])
    expect(summary.frames).toEqual([{ frameId: f.id, name: 'Home', verdict: 'fail', blocking: 1, advisory: 2 }])
    expect(summary.totals).toEqual({ pass: 0, fail: 1, stale: 0, skipped: 0 })
    expect(summary.verdict).toBe('fail')
  })

  it('skips the frame whose render fails and still answers for the rest of the canvas', async () => {
    const broken = frame('f-broken', CANVAS_SKIP, 'Pricing', CLEAN)
    const verified = frame('f-verified', CANVAS_SKIP, 'Home', CLEAN)
    seed(CANVAS_SKIP, [broken, verified])
    await persist.saveFrameReview(review.reviewToRecord(storedReview(verified), CANVAS_SKIP, 'earlier'))
    renders.failFor.add(broken.id)

    const summary = await reviewCanvas(CANVAS_SKIP, { actor: ACTOR })

    expect(summary.frames).toEqual([
      {
        frameId: broken.id,
        name: 'Pricing',
        verdict: 'skipped',
        blocking: 0,
        advisory: 0,
        reason: 'render failed for f-broken',
      },
      { frameId: verified.id, name: 'Home', verdict: 'pass', blocking: 0, advisory: 0 },
    ])
    expect(summary.totals).toEqual({ pass: 1, fail: 0, stale: 0, skipped: 1 })
    /* a frame nobody could check is not a failure of the design, so the canvas
       verdict follows the frames that were checked — the caller reads
       totals.skipped to see what it did not get an answer for */
    expect(summary.verdict).toBe('pass')
  })

  it('reports an out-of-date report as stale when the re-run fails, and fails the canvas', async () => {
    const f = frame('f-stale', CANVAS_STALE, 'Home', CLEAN)
    seed(CANVAS_STALE, [f])
    await persist.saveFrameReview(
      review.reviewToRecord(storedReview(f, { current: false, blocking: 1 }), CANVAS_STALE, 'earlier'),
    )
    renders.failFor.add(f.id)

    const summary = await reviewCanvas(CANVAS_STALE, { actor: ACTOR })

    expect(summary.frames).toEqual([
      { frameId: f.id, name: 'Home', verdict: 'stale', blocking: 1, advisory: 0, reason: 'render failed for f-stale' },
    ])
    expect(summary.totals).toEqual({ pass: 0, fail: 0, stale: 1, skipped: 0 })
    expect(summary.verdict).toBe('fail')
  })

  it('sweeps only the page it was asked about', async () => {
    const here = frame('f-here', CANVAS_PAGES, 'Home', CLEAN, PAGE)
    const there = frame('f-there', CANVAS_PAGES, 'About', CLEAN, OTHER_PAGE)
    seed(CANVAS_PAGES, [here, there])
    renders.failFor.add(here.id)
    renders.failFor.add(there.id)

    const summary = await reviewCanvas(CANVAS_PAGES, { pageId: PAGE, actor: ACTOR })

    expect(summary.frames.map((row) => row.frameId)).toEqual([here.id])
    expect(renders.ids).toEqual([here.id])
  })

  it('passes an empty canvas with zero totals', async () => {
    seed(CANVAS_EMPTY, [])

    const summary = await reviewCanvas(CANVAS_EMPTY, { actor: ACTOR })

    expect(summary).toMatchObject({
      verdict: 'pass',
      totals: { pass: 0, fail: 0, stale: 0, skipped: 0 },
      frames: [],
    })
    expect(typeof summary.durationMs).toBe('number')
  })
})

describe.skipIf(!findBrowserPath())('sweeping a canvas for real', () => {
  const CANVAS = 'c-live'

  it('reviews every frame, aggregates the verdict, and stores what it found', { timeout: 120_000 }, async () => {
    const passing = frame('f-pass', CANVAS, 'Home', CLEAN)
    const failing = frame('f-fail', CANVAS, 'Gallery', UNLABELED_IMAGE)
    seed(CANVAS, [passing, failing])

    const summary = await reviewCanvas(CANVAS, { actor: ACTOR })

    expect(summary.verdict).toBe('fail')
    expect(summary.totals).toEqual({ pass: 1, fail: 1, stale: 0, skipped: 0 })
    expect(summary.frames.map((row) => [row.frameId, row.verdict])).toEqual([
      [passing.id, 'pass'],
      [failing.id, 'fail'],
    ])
    expect(summary.frames[0]!.blocking).toBe(0)
    expect(summary.frames[1]!.blocking).toBeGreaterThanOrEqual(1)
    expect(typeof summary.durationMs).toBe('number')

    /* stored the way review_frame stores them: the checks panel, the delivery
       gate and a later sweep all read these rows */
    const stored = await persist.listFrameReviews(failing.id, 1)
    expect(stored[0]!.verdict).toBe('fail')
    expect(stored[0]!.reviewedBy).toBe(ACTOR.agentName)
    expect(stored[0]!.canvasId).toBe(CANVAS)
    expect(stored[0]!.htmlSha).toBe(review.frameSha(failing, undefined))

    /* the second sweep finds both reports current and renders nothing */
    renders.ids.length = 0
    const again = await reviewCanvas(CANVAS, { actor: ACTOR })
    expect(renders.ids).toEqual([])
    expect(again.totals).toEqual(summary.totals)
    expect(again.frames[1]!.blocking).toBe(summary.frames[1]!.blocking)
  })
})
