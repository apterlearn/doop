import type { DesignTokens, Frame } from '../shared/types.ts'
import { auditProbe, type A11yReport } from './a11y.ts'
import { lintProbe, type LintReport } from './designLint.ts'
import { layoutProbe, type LayoutReport } from './layoutLint.ts'
import { probeFrame } from './domProbe.ts'
import { VIEWPORTS } from './screenshot.ts'

/**
 * The whole verification story for one frame, in one call: the token lint, the
 * accessibility audit and the layout checks, at every viewport the design has
 * to survive. The resident agent's completion gate reads the summary, and a
 * human reading the review panel reads the per-viewport detail — both from the
 * same renders, so they can never disagree.
 */

export interface ReviewViewport {
  viewport: { width: number; height: number }
  lint: LintReport
  a11y: A11yReport
  layout: LayoutReport
}

export interface ReviewReport {
  frame_id: string
  viewports: ReviewViewport[]
  summary: {
    critical: number
    serious: number
    errors: number
    warnings: number
    off_token: number
  }
}

/** Mobile, tablet, desktop — the same three widths every other responsive tool
 *  means, so a review agrees with the screenshots next to it. */
const DEFAULT_VIEWPORTS: { width: number; height: number }[] = Object.values(VIEWPORTS).map((viewport) => ({
  width: viewport.width,
  height: viewport.height,
}))

export async function reviewFrame(
  frame: Frame,
  tokens: DesignTokens | undefined,
  opts: { viewports?: { width: number; height: number }[] } = {},
): Promise<ReviewReport> {
  const viewports = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS
  const reviewed: ReviewViewport[] = []
  /* sequential on purpose: the checks share one headless browser, and a
     parallel fan-out would only contend for it */
  for (const viewport of viewports) {
    const probe = await probeFrame(frame, { viewport })
    reviewed.push({
      viewport,
      lint: lintProbe(probe, tokens),
      a11y: auditProbe(probe),
      layout: layoutProbe(probe),
    })
  }

  const summary = { critical: 0, serious: 0, errors: 0, warnings: 0, off_token: 0 }
  for (const entry of reviewed) {
    summary.critical += entry.a11y.counts.critical
    summary.serious += entry.a11y.counts.serious
    summary.errors += entry.layout.errors
    summary.warnings += entry.layout.warnings
    /* colours only: the gate that reads this is about palette drift, and a
       missing font family is a typographic suggestion, not a broken design */
    summary.off_token += entry.lint.counts.off_token_color
  }
  return { frame_id: frame.id, viewports: reviewed, summary }
}
