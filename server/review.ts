import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { DesignTokens, Frame } from '../shared/types.ts'
import { withTokenStyle } from '../shared/tokens.ts'
import { auditProbe, type A11yReport } from './a11y.ts'
import { lintProbe, type LintReport } from './designLint.ts'
import { layoutProbe, type LayoutReport } from './layoutLint.ts'
import { contentProbe, type ContentReport } from './contentLint.ts'
import { probeFrame, type Probe } from './domProbe.ts'
import { VIEWPORTS } from './screenshot.ts'

/**
 * The whole verification story for one frame, in one call: the token lint, the
 * accessibility audit, the layout checks and the content checks, at every
 * viewport the design has to survive. The completion gate behind complete_card
 * and hand_back reads the verdict; a human reading the review panel reads the
 * per-viewport detail — both from the same renders, so they can never disagree.
 *
 * A report is only evidence about the document it was made from, so it carries
 * the hash of that HTML. The gate compares it against the frame's current HTML
 * and refuses a stale report: reviewing early and editing afterwards was
 * previously indistinguishable from reviewing the finished design.
 */

export interface ReviewViewport {
  viewport: { width: number; height: number }
  /** the width's name — the device preset, the canvas breakpoint, or "<n>px" */
  label?: string
  lint: LintReport
  a11y: A11yReport
  layout: LayoutReport
  content: ContentReport
  /** fail when this viewport has any blocking finding */
  verdict: 'pass' | 'fail'
}

/** One blocking finding, in the shape every check reduces to. */
export interface BlockingFinding {
  rule: string
  selector: string
  detail: string
  source: 'a11y' | 'layout' | 'content' | 'token'
}

export interface ReviewReport {
  frame_id: string
  /** sha256 of the frame HTML this report describes */
  html_sha: string
  /** the frame's updatedAt when it was reviewed */
  frame_updated_at: number
  reviewed_at: number
  viewports: ReviewViewport[]
  summary: {
    critical: number
    serious: number
    errors: number
    warnings: number
    off_token: number
    off_token_font: number
    off_token_type: number
    content_errors: number
    content_warnings: number
  }
  /** what a delivery gate must fix, worst first, capped for context */
  blocking: BlockingFinding[]
  /** real findings that are a judgement call, never a delivery blocker */
  advisory: BlockingFinding[]
  failing_viewports: string[]
  verdict: 'pass' | 'fail'
}

/** Mobile, tablet, desktop — the same three widths every other responsive tool
 *  means, so a review agrees with the screenshots next to it. */
const DEFAULT_VIEWPORTS: { width: number; height: number }[] = Object.values(VIEWPORTS).map((viewport) => ({
  width: viewport.width,
  height: viewport.height,
}))

/** One width to review at: a device preset, or a canvas breakpoint named by the
 *  canvas. */
interface ReviewViewportSpec {
  width: number
  height: number
  /** the name to report this width by; defaults to the preset it matches */
  name?: string
}

/** The viewport a preset means for THIS frame, and the name to report it by. A
 *  frame taller than the preset is rendered at its own height (up to the same
 *  4000px cap the renderer uses), so `clipped_by_frame` reports content that is
 *  really cut off rather than content that simply sits below a phone's fold. */
function viewportFor(preset: ReviewViewportSpec, frame: Frame): { width: number; height: number; label: string } {
  return {
    width: preset.width,
    height: Math.min(4000, Math.max(preset.height, Math.round(frame.height))),
    /* a name the caller chose — a canvas breakpoint — is what the render is
       for, so it wins over whatever preset the width happens to match */
    label: preset.name ?? presetName(preset),
  }
}

/** The name a preset is known by, for reporting which widths failed. */
function presetName(viewport: { width: number }): string {
  const match = Object.entries(VIEWPORTS).find(([, preset]) => preset.width === viewport.width)
  return match ? match[0] : `${viewport.width}px`
}

/** Accessibility findings that block a delivery: the ones that make the design
 *  unusable for someone, not the stylistic suggestions. */
const BLOCKING_A11Y = new Set(['missing_alt', 'form_label', 'html_lang', 'focus_order'])

/** Token rules that block. `off_token_font` is deliberately absent: a family
 *  mismatch is a real drift when the declared font is available, and a lie when
 *  it is not — a webfont that failed to load computes as its fallback. It is
 *  blocking only while the frame's fonts all loaded (see `findingsFrom`). */
const BLOCKING_TOKEN_RULES = new Set(['off_token_color', 'off_token_type'])

export function htmlSha(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 32)
}

/** The document a check actually renders: the frame's own HTML with the
 *  canvas's tokens bound in, the way every render path builds it. */
export function frameSha(frame: Frame, tokens: DesignTokens | undefined): string {
  return htmlSha(withTokenStyle(frame.html, tokens))
}

/** Split the findings into what must be fixed before delivery and what is a
 *  judgement call. `fontsLoaded` decides whether a family mismatch is real. */
function findingsFrom(
  reviewed: ReviewViewport[],
  fontsLoaded: boolean,
): { blocking: BlockingFinding[]; advisory: BlockingFinding[] } {
  const blocking: BlockingFinding[] = []
  const advisory: BlockingFinding[] = []
  const tokenRuleBlocks = (rule: string) => BLOCKING_TOKEN_RULES.has(rule) || (rule === 'off_token_font' && fontsLoaded)
  for (const entry of reviewed) {
    for (const issue of entry.a11y.issues) {
      const finding = { rule: issue.rule, selector: issue.selector, detail: issue.detail, source: 'a11y' as const }
      if (issue.severity === 'critical' || BLOCKING_A11Y.has(issue.rule)) blocking.push(finding)
      else advisory.push(finding)
    }
    for (const issue of entry.layout.issues) {
      const finding = { rule: issue.rule, selector: issue.selector, detail: issue.detail, source: 'layout' as const }
      if (issue.severity === 'error') blocking.push(finding)
      else advisory.push(finding)
    }
    for (const issue of entry.content.issues) {
      const finding = { rule: issue.rule, selector: issue.selector, detail: issue.detail, source: 'content' as const }
      if (issue.severity === 'error') blocking.push(finding)
      else advisory.push(finding)
    }
    for (const issue of entry.lint.violations) {
      const finding = {
        rule: issue.rule,
        selector: issue.selector,
        detail: `${issue.value} is not on the canvas scale (${issue.expected})`,
        source: 'token' as const,
      }
      if (tokenRuleBlocks(issue.rule)) blocking.push(finding)
      else advisory.push(finding)
    }
  }
  /* one line per distinct finding: the same rule on the same element at three
     widths is one thing to fix */
  const dedupe = (findings: BlockingFinding[]) => {
    const seen = new Set<string>()
    return findings.filter((finding) => {
      const key = `${finding.rule}|${finding.selector}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return { blocking: dedupe(blocking).slice(0, 20), advisory: dedupe(advisory).slice(0, 20) }
}

export async function reviewFrame(
  frame: Frame,
  tokens: DesignTokens | undefined,
  opts: { viewports?: ReviewViewportSpec[]; breakpoints?: { name: string; min_width: number }[] } = {},
): Promise<ReviewReport> {
  /* one document for the whole run: the frame object is mutated in place by
     writes, so rendering it per viewport could measure two different designs
     and hash a third */
  const target: Frame = { ...frame }
  const presets = opts.viewports?.length ? opts.viewports : DEFAULT_VIEWPORTS
  const viewports = presets.map((preset) => viewportFor(preset, target))
  /* the canvas's own breakpoints are reviewed on top of the presets: a design
     that declares where it reflows has to survive exactly those widths, and a
     finding there is reported by the breakpoint's name so it is attributable
     to the one width the agent chose rather than to a device preset */
  for (const breakpoint of opts.breakpoints ?? []) {
    viewports.push({
      width: breakpoint.min_width,
      height: Math.min(4000, Math.max(VIEWPORTS.mobile.height, Math.round(target.height))),
      label: breakpoint.name,
    })
  }
  const reviewed: ReviewViewport[] = []
  /* a family mismatch is drift only when the declared family was available at
     all: a webfont that never loaded computes as its fallback */
  let fontsLoaded = true
  /* sequential on purpose: the checks share one headless browser, and a
     parallel fan-out would only contend for it */
  for (const spec of viewports) {
    const viewport = { width: spec.width, height: spec.height }
    const probe: Probe = await probeFrame(target, { viewport })
    if (probe.document.fontsFailed.length) fontsLoaded = false
    const lint = lintProbe(probe, tokens)
    const a11y = auditProbe(probe)
    const layout = layoutProbe(probe)
    const content = contentProbe(probe)
    const failing =
      a11y.issues.some((issue) => issue.severity === 'critical' || BLOCKING_A11Y.has(issue.rule)) ||
      layout.issues.some((issue) => issue.severity === 'error') ||
      content.issues.some((issue) => issue.severity === 'error') ||
      lint.violations.some(
        (issue) => BLOCKING_TOKEN_RULES.has(issue.rule) || (issue.rule === 'off_token_font' && fontsLoaded),
      )
    reviewed.push({ viewport, label: spec.label, lint, a11y, layout, content, verdict: failing ? 'fail' : 'pass' })
  }

  const summary = {
    critical: 0,
    serious: 0,
    errors: 0,
    warnings: 0,
    off_token: 0,
    off_token_font: 0,
    off_token_type: 0,
    content_errors: 0,
    content_warnings: 0,
  }
  for (const entry of reviewed) {
    summary.critical += entry.a11y.counts.critical
    summary.serious += entry.a11y.counts.serious
    summary.errors += entry.layout.errors
    summary.warnings += entry.layout.warnings
    summary.off_token += entry.lint.counts.off_token_color
    summary.off_token_font += entry.lint.counts.off_token_font
    summary.off_token_type += entry.lint.counts.off_token_type
    summary.content_errors += entry.content.counts.errors
    summary.content_warnings += entry.content.counts.warnings
  }
  const { blocking, advisory } = findingsFrom(reviewed, fontsLoaded)
  return {
    frame_id: target.id,
    html_sha: frameSha(target, tokens),
    frame_updated_at: target.updatedAt,
    reviewed_at: Date.now(),
    viewports: reviewed,
    summary,
    blocking,
    advisory,
    failing_viewports: reviewed
      .filter((entry) => entry.verdict === 'fail')
      .map((entry) => entry.label ?? presetName(entry.viewport)),
    verdict: reviewed.every((entry) => entry.verdict === 'pass') ? 'pass' : 'fail',
  }
}

/** Whether a report still describes what this canvas would render now: the
 *  frame's HTML *and* the tokens bound into it. */
export function reportIsCurrent(report: { html_sha: string }, frame: Frame, tokens: DesignTokens | undefined): boolean {
  return report.html_sha === frameSha(frame, tokens)
}

/** The persisted row for a report. One mapper, so the MCP tool and the
 *  completion gate store byte-identical records and the checks panel reads one
 *  shape. */
export function reviewToRecord(
  report: ReviewReport,
  canvasId: string,
  reviewedBy: string,
): {
  id: string
  frameId: string
  canvasId: string
  htmlSha: string
  frameUpdatedAt: number
  verdict: 'pass' | 'fail'
  summary: Record<string, number>
  report: ReviewReport
  reviewedAt: number
  reviewedBy: string
} {
  return {
    id: nanoid(10),
    frameId: report.frame_id,
    canvasId,
    htmlSha: report.html_sha,
    frameUpdatedAt: report.frame_updated_at,
    verdict: report.verdict,
    summary: { ...report.summary },
    report,
    reviewedAt: report.reviewed_at,
    reviewedBy,
  }
}
