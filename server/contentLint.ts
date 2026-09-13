import type { Probe, ProbeElement } from './domProbe.ts'

/**
 * Content and interaction checks: the failures a design review catches by
 * looking, which no existing rule covered.
 *
 * The a11y audit covers contrast, alt text, labels and landmarks; the layout
 * lint covers geometry; the token lint covers palette drift. What was missing
 * is whether the design says anything real: placeholder copy, images that
 * never loaded, an empty page, a missing title, controls with no hover or
 * focus state. Those are exactly the things an agent generating a design
 * produces by accident.
 */

export type ContentRule =
  | 'placeholder_text'
  | 'placeholder_image'
  | 'broken_image'
  | 'no_title'
  | 'no_meta_description'
  | 'dead_zone'
  | 'missing_state'
  | 'contrast_unverified'

export type ContentSeverity = 'error' | 'warning'

export interface ContentIssue {
  rule: ContentRule
  severity: ContentSeverity
  selector: string
  detail: string
  value?: string
}

export interface ContentReport {
  counts: { errors: number; warnings: number }
  issues: ContentIssue[]
  checked_elements: number
  viewport: { width: number; height: number }
}

const MAX_ISSUES = 50
/** Copy that means "someone will write this later". */
const PLACEHOLDER_TEXT = [
  /\blorem ipsum\b/i,
  /\bdolor sit amet\b/i,
  /\bplaceholder\b/i,
  /\btbd\b/i,
  /\bTODO\b/,
  /^todo:?$/i,
  /\bsample text\b/i,
  /\binsert .{0,20}here\b/i,
  /^x{3,}$/i,
  /^text goes here/i,
]
/** A word that says the image is a stand-in, in an alt text or in any file
 *  name the src points at. */
const PLACEHOLDER_MARKER = [/placeholder/i, /\bdummy\b/i]
/** A file name a generator writes when it never picked an asset. Only a bare
 *  reference counts: a src with a path or a host points at a real asset. */
const PLACEHOLDER_FILE = [
  /^logo\.(png|svg|jpe?g)$/i,
  /^img_\d+\.(png|svg|jpe?g|gif|webp|avif)$/i,
  /^image\d+\.(png|svg|jpe?g|gif|webp|avif)$/i,
]
/** A control with no state rule of its own looks dead on hover and focus. */
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea'])
/** A page whose content stops this far above the fold is mostly empty. */
const DEAD_ZONE_RATIO = 0.25
const DEAD_ZONE_MIN_GAP = 240

function clean(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

/** Text that is filler rather than copy. */
export function placeholderText(text: string): string | undefined {
  const value = clean(text)
  if (!value) return undefined
  return PLACEHOLDER_TEXT.find((pattern) => pattern.test(value)) ? value : undefined
}

/** An image that stands in for a real one. */
function placeholderImage(el: ProbeElement): string | undefined {
  const alt = clean(el.attrs.alt)
  const src = clean(el.image?.src)
  /* the file name alone: a query, a hash or a directory is a path to a real asset */
  const name =
    src
      .replace(/[?#].*$/, '')
      .split('/')
      .pop() || ''
  const marker = [alt, name].some((text) => PLACEHOLDER_MARKER.some((pattern) => pattern.test(text)))
  const bare_name = src === name && PLACEHOLDER_FILE.some((pattern) => pattern.test(name))
  return marker || bare_name ? clean(`${alt} ${src}`) : undefined
}

/**
 * Interaction-state coverage, from the frame's own stylesheet text: a control
 * with no `:hover` or `:focus-visible` rule anywhere is a design that was never
 * driven. Read from CSS rather than from a live hover because a static frame
 * has no pointer.
 */
export function interactionProbe(probe: Probe): ContentIssue[] {
  const css = probe.cssText
  const issues: ContentIssue[] = []
  const hasHover = /:hover\b/.test(css)
  const hasFocus = /:focus(-visible)?\b/.test(css)
  if (hasHover && hasFocus) return issues
  const controls = probe.elements.filter((el) => !el.attrs.hiddenFromAT && INTERACTIVE_TAGS.has(el.tag))
  const seen = new Set<string>()
  for (const el of controls) {
    if (seen.has(el.tag)) continue
    seen.add(el.tag)
    if (!hasHover)
      issues.push({
        rule: 'missing_state',
        severity: 'warning',
        selector: el.selector,
        detail: `<${el.tag}> has no :hover rule in the frame's CSS — the control looks inert under the pointer`,
      })
    if (!hasFocus)
      issues.push({
        rule: 'missing_state',
        severity: 'warning',
        selector: el.selector,
        detail: `<${el.tag}> has no :focus-visible rule — keyboard users cannot see where they are`,
      })
  }
  return issues
}

/** Placeholder copy, stand-in images, images that failed to load, an empty or
 *  untitled page, and text over a background the contrast check cannot read. */
export function contentProbe(probe: Probe): ContentReport {
  const issues: ContentIssue[] = []
  const visible = probe.elements.filter((el) => !el.attrs.hiddenFromAT)

  for (const el of visible) {
    if (el.directText) {
      const filler = placeholderText(el.directText)
      if (filler)
        issues.push({
          rule: 'placeholder_text',
          severity: 'error',
          selector: el.selector,
          detail: `placeholder copy “${filler.slice(0, 60)}” — write the real content, or remove the element`,
          value: filler.slice(0, 60),
        })
    }
    if (el.tag === 'img') {
      if (el.image && (!el.image.complete || el.image.naturalWidth === 0))
        issues.push({
          rule: 'broken_image',
          severity: 'error',
          selector: el.selector,
          detail: `the image did not load (${el.image.src || 'no src'}) — a broken image ships as an empty box`,
          value: el.image.src,
        })
      const stand_in = placeholderImage(el)
      if (stand_in)
        issues.push({
          rule: 'placeholder_image',
          severity: 'error',
          selector: el.selector,
          detail: `stand-in image (${stand_in.slice(0, 60)}) — use a real asset from search_images or upload_asset`,
          value: stand_in.slice(0, 60),
        })
    }
    /* Text painted over an image or gradient: the flat-background contrast
       ratio does not apply, so say so instead of silently passing it. */
    if (el.directText && el.style.backgroundImage)
      issues.push({
        rule: 'contrast_unverified',
        severity: 'warning',
        selector: el.selector,
        detail: `text “${el.directText.slice(0, 40)}” sits over an image or gradient — check the contrast against the busiest part of it`,
      })
  }

  if (!clean(probe.document.title))
    issues.push({
      rule: 'no_title',
      severity: 'error',
      selector: 'html',
      detail: 'the document has no <title> — a frame is a real page, so give it one',
    })
  if (!clean(probe.document.description))
    issues.push({
      rule: 'no_meta_description',
      severity: 'warning',
      selector: 'html',
      detail: 'no meta description — one sentence describing the page',
    })

  /* The content stops well above the fold: a page that is mostly emptiness is
     not finished, and an agent that cannot see whitespace will not notice. */
  const contentBottom = visible.reduce((bottom, el) => Math.max(bottom, el.rect.y + el.rect.height), 0)
  const height = probe.document.height
  if (height > 0 && contentBottom > 0 && height - contentBottom > Math.max(DEAD_ZONE_MIN_GAP, height * DEAD_ZONE_RATIO))
    issues.push({
      rule: 'dead_zone',
      severity: 'warning',
      selector: 'body',
      detail: `content ends at ${Math.round(contentBottom)}px of a ${height}px frame — ${Math.round(height - contentBottom)}px is empty; shorten the frame or fill it`,
    })

  issues.push(...interactionProbe(probe))

  return {
    counts: {
      errors: issues.filter((issue) => issue.severity === 'error').length,
      warnings: issues.filter((issue) => issue.severity === 'warning').length,
    },
    issues: issues.slice(0, MAX_ISSUES),
    checked_elements: visible.length,
    viewport: { width: probe.document.width, height: probe.document.height },
  }
}
