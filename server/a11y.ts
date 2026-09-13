import type { Frame } from '../shared/types.ts'
import { probeFrame, type Probe, type ProbeElement } from './domProbe.ts'

/**
 * Accessibility audit of a rendered frame.
 *
 * Every rule is computed from the DOM probe — no axe-core, no new dependency:
 * the checks that matter for a design review (contrast, alt text, heading
 * order, focus order, tap targets, landmarks, form labels, language) are all
 * derivable from computed styles and attributes, and the probe already has
 * both. Rules report the element's CSS selector so the agent can edit exactly
 * that element.
 */

export type A11yRule =
  | 'contrast'
  | 'missing_alt'
  | 'heading_order'
  | 'focus_order'
  | 'tap_target'
  | 'missing_main'
  | 'unlabeled_nav'
  | 'form_label'
  | 'html_lang'

export type A11ySeverity = 'critical' | 'serious' | 'moderate'

export interface A11yIssue {
  rule: A11yRule
  severity: A11ySeverity
  selector: string
  detail: string
  value?: string
  expected?: string
}

export interface A11yReport {
  counts: { critical: number; serious: number; moderate: number }
  issues: A11yIssue[]
  checked_elements: number
  viewport: { width: number; height: number }
}

const MAX_ISSUES = 50
/** WCAG 2.2 AA target size, in CSS pixels. */
const MIN_TAP_TARGET = 24

const SEVERITY_ORDER: Record<A11ySeverity, number> = { critical: 0, serious: 1, moderate: 2 }

interface Rgb {
  r: number
  g: number
  b: number
}

/** Parse "rgb(r, g, b)" / "rgba(r, g, b, a)". The probe always emits the
 *  composited opaque form for backgrounds; text colors may still carry alpha. */
function parseRgb(value: string): (Rgb & { a: number }) | undefined {
  const match = value.match(/^rgba?\(([^)]+)\)$/)
  if (!match) return undefined
  const parts = match[1]!.split(',').map((p) => Number.parseFloat(p.trim()))
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return undefined
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length > 3 ? parts[3]! : 1 }
}

/** Composite a possibly-translucent foreground over its background. */
function over(fg: Rgb & { a: number }, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  }
}

function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = parseRgb(foreground)
  const bg = parseRgb(background)
  if (!fg || !bg) return undefined
  const solid = over(fg, bg)
  const l1 = luminance(solid)
  const l2 = luminance(bg)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

/** WCAG "large text": 24px, or 18.66px when bold. */
function isLargeText(el: ProbeElement): boolean {
  return el.fontSizePx >= 24 || (el.fontSizePx >= 18.66 && el.fontWeight >= 700)
}

function isHidden(el: ProbeElement): boolean {
  return el.attrs.hiddenFromAT
}

/** Contrast, alt text, heading order, focus order, tap targets, landmarks,
 *  form labels, document language. */
export function auditProbe(probe: Probe): A11yReport {
  const issues: A11yIssue[] = []
  const visible = probe.elements.filter((el) => !isHidden(el))

  /* ---- contrast: text the element paints on its own background ---- */
  for (const el of visible) {
    if (!el.directText) continue
    const ratio = contrastRatio(el.style.color, el.style.effectiveBackground)
    if (ratio === undefined) continue
    const threshold = isLargeText(el) ? 3 : 4.5
    if (ratio + 0.005 >= threshold) continue
    issues.push({
      rule: 'contrast',
      severity: 'critical',
      selector: el.selector,
      detail: `text “${el.directText.slice(0, 60)}” is ${ratio.toFixed(2)}:1 against its background — below the ${threshold}:1 minimum for ${isLargeText(el) ? 'large' : 'normal'} text`,
      value: ratio.toFixed(2),
      expected: String(threshold),
    })
  }

  /* ---- images need alt text (an empty alt is a deliberate decorative mark) ---- */
  for (const el of visible) {
    if (el.tag !== 'img') continue
    if (el.attrs.alt === undefined) {
      issues.push({
        rule: 'missing_alt',
        severity: 'serious',
        selector: el.selector,
        detail: 'image has no alt attribute — describe it, or use alt="" if it is decorative',
      })
    }
  }

  /* ---- heading order ---- */
  const headings = visible.filter((el) => /^h[1-6]$/.test(el.tag))
  const levels = headings.map((el) => Number(el.tag.slice(1)))
  if (headings.length > 0 && !levels.includes(1)) {
    issues.push({
      rule: 'heading_order',
      severity: 'moderate',
      selector: headings[0]!.selector,
      detail: 'the page has headings but no h1 — the top-level heading is missing',
      expected: 'h1',
    })
  }
  if (levels.filter((level) => level === 1).length > 1) {
    const second = headings[levels.indexOf(1, levels.indexOf(1) + 1)]!
    issues.push({
      rule: 'heading_order',
      severity: 'moderate',
      selector: second.selector,
      detail: 'more than one h1 — keep a single top-level heading per page',
      expected: 'one h1',
    })
  }
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i]! - levels[i - 1]! > 1) {
      issues.push({
        rule: 'heading_order',
        severity: 'moderate',
        selector: headings[i]!.selector,
        detail: `heading level jumps from h${levels[i - 1]} to h${levels[i]} — a section was skipped`,
        expected: `h${levels[i - 1]! + 1}`,
      })
    }
  }

  /* ---- focus order ---- */
  const focusable = visible.filter((el) => el.attrs.focusable)
  for (const el of focusable) {
    const index = Number(el.attrs.tabindex)
    if (el.attrs.tabindex !== undefined && index > 0) {
      issues.push({
        rule: 'focus_order',
        severity: 'serious',
        selector: el.selector,
        detail: `tabindex="${el.attrs.tabindex}" forces a tab order that fights the document order`,
        value: el.attrs.tabindex,
        expected: '0 or -1',
      })
    }
  }
  if (focusable.length === 0 && probe.elements.length > 0) {
    issues.push({
      rule: 'focus_order',
      severity: 'moderate',
      selector: 'body',
      detail: 'nothing on the page is keyboard focusable — no links, buttons, inputs or tabindex',
    })
  }

  /* ---- tap targets ---- */
  for (const el of focusable) {
    if (el.rect.width < MIN_TAP_TARGET || el.rect.height < MIN_TAP_TARGET) {
      issues.push({
        rule: 'tap_target',
        severity: 'moderate',
        selector: el.selector,
        detail: `interactive element is ${el.rect.width}×${el.rect.height}px — smaller than the ${MIN_TAP_TARGET}×${MIN_TAP_TARGET}px minimum`,
        value: `${el.rect.width}x${el.rect.height}`,
        expected: `${MIN_TAP_TARGET}x${MIN_TAP_TARGET}`,
      })
    }
  }

  /* ---- landmarks ---- */
  if (probe.elements.length > 0 && !probe.elements.some((el) => el.tag === 'main')) {
    issues.push({
      rule: 'missing_main',
      severity: 'moderate',
      selector: 'body',
      detail: 'no <main> landmark — screen-reader users cannot jump to the content',
      expected: 'main',
    })
  }
  const navs = visible.filter((el) => el.tag === 'nav')
  if (navs.length > 1 && navs.some((el) => !el.attrs.ariaLabel)) {
    issues.push({
      rule: 'unlabeled_nav',
      severity: 'moderate',
      selector: navs.find((el) => !el.attrs.ariaLabel)!.selector,
      detail: `${navs.length} <nav> landmarks and at least one has no aria-label — name each so they are distinguishable`,
      expected: 'aria-label',
    })
  }

  /* ---- form labels ---- */
  for (const el of visible) {
    if (!['input', 'select', 'textarea'].includes(el.tag)) continue
    if ((el.attrs.type ?? '').toLowerCase() === 'hidden') continue
    const labelled =
      !!el.attrs.ariaLabel ||
      !!el.attrs.ariaLabelledby ||
      el.attrs.wrappedInLabel ||
      (!!el.attrs.id && probe.elements.some((label) => label.tag === 'label' && label.attrs.htmlFor === el.attrs.id))
    if (!labelled) {
      issues.push({
        rule: 'form_label',
        severity: 'serious',
        selector: el.selector,
        detail: 'form control has no label — wrap it in a <label>, link one with for, or add aria-label',
        expected: 'label',
      })
    }
  }

  /* ---- document language ---- */
  if (!probe.document.lang) {
    issues.push({
      rule: 'html_lang',
      severity: 'serious',
      selector: 'html',
      detail: 'the <html> element has no lang attribute — screen readers cannot pick a voice',
      expected: 'lang="en"',
    })
  }

  const sorted = [...issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.selector.localeCompare(b.selector),
  )
  return {
    counts: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      serious: issues.filter((i) => i.severity === 'serious').length,
      moderate: issues.filter((i) => i.severity === 'moderate').length,
    },
    issues: sorted.slice(0, MAX_ISSUES),
    checked_elements: visible.length,
    viewport: { width: probe.document.width, height: probe.document.height },
  }
}

export async function auditFrame(
  frame: Frame,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<A11yReport> {
  return auditProbe(await probeFrame(frame, opts))
}
