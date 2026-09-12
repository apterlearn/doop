import type { Frame } from '../shared/types.ts'
import { probeFrame, type Probe, type ProbeElement } from './domProbe.ts'

/**
 * Layout checks over the rendered-DOM probe: the geometry counterpart to the
 * accessibility audit and the token lint.
 *
 * The rules are deliberately conservative. Overflow, clipping and zero-size
 * boxes are errors — they mean content the visitor cannot see — so they only
 * fire on a box that really cannot show what it holds. The two rules that could
 * false-fire on decoration (overlapping cards, truncated labels) are warnings
 * and never block a delivery. A design that bleeds on purpose opts a box out
 * with `data-doop-allow-overflow`.
 */

export type LayoutRule =
  'overflow_x' | 'overflow_y' | 'clipped_by_frame' | 'sibling_overlap' | 'text_truncated' | 'zero_size'

export interface LayoutIssue {
  rule: LayoutRule
  severity: 'error' | 'warning'
  selector: string
  detail: string
  rect: { x: number; y: number; width: number; height: number }
}

export interface LayoutReport {
  errors: number
  warnings: number
  issues: LayoutIssue[]
  checked_elements: number
  viewport: { width: number; height: number }
}

const MAX_LAYOUT_ISSUES = 50
/** Scroll and client sizes disagree by a pixel on fractional boxes. */
const SIZE_TOLERANCE = 1
/** Under this, visible overflow is text-metric noise rather than a spill. */
const VISIBLE_OVERFLOW_NOISE = 8
/** Two rects must overlap by more than this to be a real collision. */
const MIN_OVERLAP_AREA = 4
/** A rect may sit this far outside the viewport before it counts as clipped. */
const CLIP_TOLERANCE = 2

/** The document itself is never "an element that overflows". */
const ROOT_TAGS: Record<string, true> = { html: true, body: true }
/** A zero-size box around one of these is a bug; a zero-size spacer is not. */
const CONTENT_TAGS: Record<string, true> = { img: true, svg: true, video: true, canvas: true }

const SEVERITY_ORDER: Record<LayoutIssue['severity'], number> = { error: 0, warning: 1 }

interface BoxAxis {
  scroll: number
  client: number
  overflow: string | undefined
}

/** Scroll and client size on one axis, with the computed overflow that decides
 *  whether the box clips at all. Undefined when a hand-built probe carries no
 *  live geometry to judge. */
function boxAxis(el: ProbeElement, axis: 'x' | 'y'): BoxAxis | undefined {
  if (axis === 'x') {
    if (el.scrollWidth === undefined || el.clientWidth === undefined) return undefined
    return { scroll: el.scrollWidth, client: el.clientWidth, overflow: el.overflowX }
  }
  if (el.scrollHeight === undefined || el.clientHeight === undefined) return undefined
  return { scroll: el.scrollHeight, client: el.clientHeight, overflow: el.overflowY }
}

/** The axes a rect leaves the viewport on. */
function clippedAxes(el: ProbeElement, viewport: { width: number; height: number }): Array<'x' | 'y'> {
  const axes: Array<'x' | 'y'> = []
  if (el.rect.x < -CLIP_TOLERANCE || el.rect.x + el.rect.width > viewport.width + CLIP_TOLERANCE) axes.push('x')
  if (el.rect.y < -CLIP_TOLERANCE || el.rect.y + el.rect.height > viewport.height + CLIP_TOLERANCE) axes.push('y')
  return axes
}

/** True when an ancestor the probe kept clips the given axis: the design asked
 *  for the clipping, so the overflow is not an escape from the frame. */
function ancestorClips(probe: Probe, el: ProbeElement, axis: 'x' | 'y'): boolean {
  let index = el.parentIndex
  while (index !== undefined) {
    const ancestor = probe.elements[index]
    if (!ancestor) return false
    const overflow = axis === 'x' ? ancestor.overflowX : ancestor.overflowY
    if (overflow !== undefined && overflow !== 'visible') return true
    index = ancestor.parentIndex
  }
  return false
}

/** Intersection area of two rects, 0 when they do not touch. */
function overlapArea(a: ProbeElement['rect'], b: ProbeElement['rect']): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/** True when `outer` fully covers `inner` — an element sitting inside another
 *  box is layout, not a collision. */
function contains(outer: ProbeElement['rect'], inner: ProbeElement['rect']): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  )
}

/** Overflow, clipping, zero-size boxes, sibling collisions and truncated text.
 *  Pure over a probe, so the rules are verifiable without a browser. */
export function layoutProbe(probe: Probe): LayoutReport {
  const viewport = { width: probe.document.width, height: probe.document.height }
  const visible = probe.elements.map((el, index) => ({ el, index })).filter((entry) => !entry.el.attrs.hiddenFromAT)
  /* which elements have children in the probe: a zero-size box with content
     and children is a wrapper, not a bug */
  const hasChildren = new Set<number>()
  for (const el of probe.elements) {
    if (el.parentIndex !== undefined) hasChildren.add(el.parentIndex)
  }
  const issues: LayoutIssue[] = []

  for (const { el, index } of visible) {
    const root = ROOT_TAGS[el.tag] === true

    /* ---- overflow: content the box cannot show ---- */
    if (!root) {
      for (const axis of ['x', 'y'] as const) {
        const box = boxAxis(el, axis)
        if (!box || box.client <= 0) continue
        if (box.scroll <= box.client + SIZE_TOLERANCE) continue
        if (el.attrs.allowOverflow) continue
        /* visible overflow is how the browser lays text out; only a real spill
           — a wide image, a fixed-width child — is worth an error */
        if (box.overflow === 'visible' && box.scroll - box.client < VISIBLE_OVERFLOW_NOISE) continue
        issues.push({
          rule: axis === 'x' ? 'overflow_x' : 'overflow_y',
          severity: 'error',
          selector: el.selector,
          detail: `${axis === 'x' ? 'horizontal' : 'vertical'} content is ${box.scroll}px inside a ${box.client}px box`,
          rect: el.rect,
        })
      }
    }

    /* ---- zero_size: a box with content but no room to show it ---- */
    const hasContent = el.directText.trim() !== '' || (el.text ?? '').trim() !== '' || CONTENT_TAGS[el.tag] === true
    if (!root && !hasChildren.has(index) && hasContent && (el.rect.width <= 0 || el.rect.height <= 0)) {
      issues.push({
        rule: 'zero_size',
        severity: 'error',
        selector: el.selector,
        detail: `${el.tag} renders ${el.rect.width}×${el.rect.height} but has content`,
        rect: el.rect,
      })
    }
  }

  /* ---- clipped_by_frame: content pushed outside the artboard ---- */
  for (const { el } of visible) {
    if (ROOT_TAGS[el.tag] === true) continue
    /* a full-bleed band is off-canvas on purpose */
    if (el.attrs.allowOverflow) continue
    const axes = clippedAxes(el, viewport)
    if (!axes.length) continue
    /* an ancestor that clips every escaping axis already explains it */
    if (axes.every((axis) => ancestorClips(probe, el, axis))) continue
    issues.push({
      rule: 'clipped_by_frame',
      severity: 'error',
      selector: el.selector,
      detail:
        `rect at ${el.rect.x},${el.rect.y} (${el.rect.width}×${el.rect.height}) ` +
        `extends past the ${viewport.width}×${viewport.height} frame`,
      rect: el.rect,
    })
  }

  /* ---- text_truncated: text the box silently cuts off ---- */
  for (const { el } of visible) {
    if (!el.directText.trim()) continue
    if (el.overflowY !== 'hidden' && el.overflowY !== 'clip') continue
    if (el.scrollHeight === undefined || el.clientHeight === undefined) continue
    if (el.scrollHeight <= el.clientHeight + SIZE_TOLERANCE) continue
    issues.push({
      rule: 'text_truncated',
      severity: 'warning',
      selector: el.selector,
      detail: `text needs ${el.scrollHeight}px but the box clips at ${el.clientHeight}px`,
      rect: el.rect,
    })
  }

  /* ---- sibling_overlap: boxes sharing a parent that collide ---- */
  const reported = new Set<ProbeElement>()
  for (let i = 0; i < visible.length; i += 1) {
    const later = visible[i]!.el
    if (later.rect.width <= 0 || later.rect.height <= 0) continue
    for (let j = 0; j < i; j += 1) {
      const earlier = visible[j]!.el
      if (earlier.parentIndex !== later.parentIndex) continue
      const area = overlapArea(earlier.rect, later.rect)
      if (area <= MIN_OVERLAP_AREA) continue
      if (contains(earlier.rect, later.rect) || contains(later.rect, earlier.rect)) continue
      if (reported.has(later)) continue
      reported.add(later)
      issues.push({
        rule: 'sibling_overlap',
        severity: 'warning',
        selector: later.selector,
        detail: `overlaps ${earlier.selector} by ${Math.round(area)}px²`,
        rect: later.rect,
      })
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.selector.localeCompare(b.selector))
  const errors = issues.filter((issue) => issue.severity === 'error').length
  return {
    errors,
    warnings: issues.length - errors,
    issues: issues.slice(0, MAX_LAYOUT_ISSUES),
    checked_elements: visible.length,
    viewport,
  }
}

export async function layoutFrame(
  frame: Frame,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<LayoutReport> {
  return layoutProbe(await probeFrame(frame, opts))
}
