import { describe, expect, it } from 'vitest'
import { reviewFrame } from '../server/review.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { DesignTokens, Frame } from '../shared/types.ts'

/* review_frame is the verification gate's whole input, so it is checked
   against a real render (skipped where no browser is installed, like the other
   browser-backed suites): the findings must come out of the browser's own
   computed styles, and every viewport must actually be reviewed. */

const TOKENS: DesignTokens = {
  colors: { ink: '#111110', paper: '#ffffff' },
  fonts: { body: 'Inter' },
  spacing: [4, 8, 16, 24],
  radii: [0, 8],
  updatedAt: 0,
  updatedBy: 'alice',
}

function frame(html: string): Frame {
  return {
    id: 'f-review',
    canvasId: 'c-review',
    name: 'Review fixture',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
  }
}

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#ffffff}</style></head><body>${body}</body></html>`

describe.skipIf(!findBrowserPath())('reviewFrame over a real render', () => {
  it('reviews all three viewports and surfaces the a11y and token violations', async () => {
    const report = await reviewFrame(
      frame(
        page(`
          <main>
            <h1 style="color:#111110">Dashboard</h1>
            <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40">
            <p style="color:#777777;font-size:16px">Secondary explanation text</p>
            <p style="color:#123456;font-size:16px">Off-palette accent text</p>
          </main>
        `),
      ),
      TOKENS,
    )

    expect(report.frame_id).toBe('f-review')
    expect(report.viewports).toHaveLength(3)
    expect(report.viewports.map((entry) => entry.viewport.width)).toEqual([390, 834, 1440])
    expect(new Set(report.viewports.map((entry) => entry.viewport.width)).size).toBe(3)
    /* the image has no alt text and the body copy sits at 4.48:1 */
    expect(report.summary.critical).toBeGreaterThanOrEqual(1)
    /* #123456 is neither of the two palette colours */
    expect(report.summary.off_token).toBeGreaterThanOrEqual(1)
    expect(report.viewports[0]!.a11y.counts.critical).toBeGreaterThanOrEqual(1)
    expect(report.viewports[0]!.lint.counts.off_token_color).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
