import type { Frame } from '../shared/types.ts'
import { probeFrame, type Probe, type ProbeElement } from './domProbe.ts'
import { colorDistance } from './designLint.ts'
import { contrastRatio } from './a11y.ts'

/**
 * Brand compliance: does a rendered frame obey the rules the canvas's brand
 * declares?
 *
 * The token lint asks whether a design follows the canvas's own scale and the
 * a11y audit whether it is usable; neither knows that the brand forbids
 * #ff0000, that the wordmark has to be on the page, or that a face outside the
 * two licensed families is not allowed. Those rules live as prose today — a
 * `## Brand rules` section of the guideline markdown — so this module reads
 * them back and a check can be run instead of remembered.
 *
 * Grammar, one rule per non-empty line under the section heading:
 *
 *   ## Brand rules
 *   - palette: #111111, #f5f5f0
 *   - forbidden color: #ff0000
 *   - font family: Inter, Inter Tight
 *   - logo required: selector=.brand-logo
 *   - logo forbidden: .wordmark
 *   - min contrast: 4.5
 *   - blocking: palette-1
 *   - detail: palette-1 from the 2024 brand book
 *
 * The phrase before the colon names the kind (case-insensitive, inner
 * whitespace collapsed) and the rest is a comma-separated value list, except
 * the two logo rules, whose value is one selector — bare, or after
 * `selector=`. A leading `-`, `*` or `+` is optional. Ids are derived from the
 * kind and the rule's position among rules of that kind (`palette-1`), which is
 * how `blocking: <id>` promotes a rule from advice to a gate and how
 * `detail: <id> <text>` attaches a note. Lines that do not parse are skipped,
 * never thrown on: a guideline is prose first, and one unreadable line must not
 * stop the rest of the document from being checked.
 *
 * Distances and contrast reuse the measurements that already exist —
 * `colorDistance` from the token lint, `contrastRatio` from the a11y audit —
 * rather than inventing a second definition of "this color" or "readable".
 * Everything is a pure function over a probe, so the rules are verifiable
 * without a browser; `checkBrandCompliance` is the thin async wrapper.
 */

export interface BrandRule {
  id: string
  kind: 'palette' | 'forbidden_color' | 'font_family' | 'logo_required' | 'logo_forbidden' | 'min_contrast'
  values: string[]
  selector?: string
  blocking?: boolean
  detail?: string
}

export interface BrandViolation {
  rule: string
  selector: string
  detail: string
  severity: 'advisory' | 'blocking'
}

export interface BrandReport {
  verdict: 'pass' | 'fail'
  violations: BrandViolation[]
  /** rules parsed and evaluated */
  rules: number
  /** violations the rules found, before the 50-cap: `violations.length` below
   *  this means the list was truncated */
  checked: number
}

const MAX_VIOLATIONS = 50
/** Same perceptual tolerance the token lint calls "the same design decision"
 *  (COLOR_TOLERANCE, server/designLint.ts): a brand rule must not disagree with
 *  the token check about which color an element is wearing. */
const COLOR_TOLERANCE = 3

/** The heading that opens the section, and the one that closes it. */
const SECTION = /^##\s+brand rules\s*$/i
const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^[-*+]\s+/

const KIND_BY_PHRASE: Record<string, BrandRule['kind']> = {
  palette: 'palette',
  'forbidden color': 'forbidden_color',
  'font family': 'font_family',
  'logo required': 'logo_required',
  'logo forbidden': 'logo_forbidden',
  'min contrast': 'min_contrast',
}

/** Read the brand rules out of a guideline document. Pure: the same markdown
 *  always yields the same rules, ids included. */
export function parseBrandRules(markdown: string): BrandRule[] {
  const rules: BrandRule[] = []
  /* how many rules of each kind have been read: the id counter, kept per kind
     so `palette-1` means the first palette line whatever else surrounds it */
  const counters: Record<BrandRule['kind'], number> = {
    palette: 0,
    forbidden_color: 0,
    font_family: 0,
    logo_required: 0,
    logo_forbidden: 0,
    min_contrast: 0,
  }
  let inSection = false
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (SECTION.test(line)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    /* the next heading ends the section: rules are a flat list */
    if (HEADING.test(line)) break
    const item = line.replace(LIST_ITEM, '')
    const colon = item.indexOf(':')
    if (colon < 0) continue
    const phrase = item.slice(0, colon).trim().toLowerCase().replace(/\s+/g, ' ')
    const value = item.slice(colon + 1).trim()
    if (!value) continue
    /* modifiers name the rule they change, so their own position in the
       document does not matter */
    if (phrase === 'blocking') {
      const target = rules.find((rule) => rule.id === value)
      if (target) target.blocking = true
      continue
    }
    if (phrase === 'detail') {
      const space = value.indexOf(' ')
      const target = rules.find((rule) => rule.id === (space < 0 ? value : value.slice(0, space)))
      if (target && space > 0) target.detail = value.slice(space + 1).trim()
      continue
    }
    const kind = KIND_BY_PHRASE[phrase]
    if (!kind) continue
    const index = (counters[kind] ?? 0) + 1
    const id = `${kind.replace(/_/g, '-')}-${index}`
    if (kind === 'logo_required' || kind === 'logo_forbidden') {
      const selector = value.replace(/^selector\s*=\s*/i, '').trim()
      if (!selector) continue
      rules.push({ id, kind, values: [], selector })
      counters[kind] = index
      continue
    }
    const values = value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    /* a contrast rule with no number is not a rule; a palette with no colors
       would flag every element in the frame */
    if (!values.length) continue
    if (kind === 'min_contrast' && !Number.isFinite(Number.parseFloat(values[0]!))) continue
    rules.push({ id, kind, values })
    counters[kind] = index
  }
  return rules
}

/** The first family in a CSS font stack, lowercased and unquoted — the same
 *  reading the token lint takes, so a font token and a brand rule agree. */
function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
}

/** The colors an element declares: its text color and its own background.
 *  A transparent background is the absence of a choice, not a color. */
function declaredColors(el: ProbeElement): Array<['color' | 'background', string]> {
  const declared: Array<['color' | 'background', string]> = []
  for (const property of ['color', 'background'] as const) {
    const value = el.style[property]
    if (!value || value === 'rgba(0, 0, 0, 0)') continue
    declared.push([property, value])
  }
  return declared
}

/** The palette entry nearest a value, or undefined when the value is not a
 *  color at all (a gradient, `currentcolor`) — not a decision to judge. */
function nearestColor(value: string, palette: string[]): { token: string; distance: number } | undefined {
  let best: { token: string; distance: number } | undefined
  for (const token of palette) {
    const distance = colorDistance(value, token)
    if (distance === undefined) continue
    if (!best || distance < best.distance) best = { token, distance }
  }
  return best
}

/** Whether an element sits at or under a rule's selector. The probe names
 *  elements by document path (shared/selector.ts), so a rule writes that path;
 *  an id matches on its own because a path stops at the first id. A class
 *  selector — what a guideline naturally writes for a logo — is matched
 *  against the content key, the one probe field that carries classes. */
function matchesSelector(el: ProbeElement, selector: string): boolean {
  const want = selector.trim()
  if (!want) return false
  if (el.selector === want || el.selector.startsWith(`${want} > `)) return true
  if (el.key === want) return true
  const classes = want.startsWith('.') ? want.slice(1).split('.').filter(Boolean) : []
  if (!classes.length) return false
  const own = el.key.startsWith(`${el.tag}.`) ? (el.key.slice(el.tag.length + 1).split('[')[0] ?? '') : ''
  const list = own.split('.').filter(Boolean)
  return classes.every((name) => list.includes(name))
}

/** Check a rendered frame against brand rules. Pure over a probe, so the rules
 *  are verifiable without a browser. A rule marked `blocking` reports its
 *  violations as `blocking`; everything else is advice, which is what
 *  `review_frame` folds into `advisory`. */
export function brandProbe(probe: Probe, rules: BrandRule[]): BrandReport {
  const violations: BrandViolation[] = []
  const visible = probe.elements.filter((el) => !el.attrs.hiddenFromAT)
  for (const rule of rules) {
    /* a value-less rule is one the parser would have dropped; a hand-built one
       is skipped rather than flagging every element in the frame */
    const logo = rule.kind === 'logo_required' || rule.kind === 'logo_forbidden'
    if (!logo && !rule.values.length) continue
    const severity: BrandViolation['severity'] = rule.blocking ? 'blocking' : 'advisory'
    const flag = (selector: string, detail: string) =>
      violations.push({
        rule: rule.id,
        selector,
        detail: rule.detail ? `${detail} — ${rule.detail}` : detail,
        severity,
      })
    switch (rule.kind) {
      case 'palette':
        for (const el of visible) {
          for (const [property, value] of declaredColors(el)) {
            const nearest = nearestColor(value, rule.values)
            if (!nearest || nearest.distance <= COLOR_TOLERANCE) continue
            flag(
              el.selector,
              `${property} ${value} is outside the brand palette (nearest ${nearest.token}, ${Math.round(nearest.distance)} apart) — the palette is ${rule.values.join(', ')}`,
            )
          }
        }
        break
      case 'forbidden_color':
        for (const el of visible) {
          for (const [property, value] of declaredColors(el)) {
            const hit = rule.values.find((forbidden) => {
              const distance = colorDistance(value, forbidden)
              return distance !== undefined && distance <= COLOR_TOLERANCE
            })
            if (!hit) continue
            flag(el.selector, `${property} ${value} is a forbidden brand color (${hit})`)
          }
        }
        break
      case 'font_family':
        for (const el of visible) {
          const family = firstFamily(el.style.font)
          if (!family) continue
          if (rule.values.some((allowed) => firstFamily(allowed) === family)) continue
          flag(el.selector, `font ${family} is outside the brand families (${rule.values.join(', ')})`)
        }
        break
      case 'min_contrast': {
        const threshold = Number.parseFloat(rule.values[0] ?? '')
        if (!Number.isFinite(threshold)) break
        for (const el of visible) {
          if (!el.directText) continue
          const ratio = contrastRatio(el.style.color, el.style.effectiveBackground)
          /* the same 0.005 slack the a11y audit takes: rounding must not turn a
             passing 4.5 into a failure */
          if (ratio === undefined || ratio + 0.005 >= threshold) continue
          flag(
            el.selector,
            `text “${el.directText.slice(0, 40)}” is ${ratio.toFixed(2)}:1 against its background — below the brand minimum of ${threshold}:1`,
          )
        }
        break
      }
      case 'logo_required': {
        const selector = rule.selector ?? ''
        if (!selector) break
        if (visible.some((el) => matchesSelector(el, selector))) break
        flag(selector, `no element matches ${selector} — the brand requires this mark`)
        break
      }
      case 'logo_forbidden': {
        const selector = rule.selector ?? ''
        if (!selector) break
        const hit = visible.find((el) => matchesSelector(el, selector))
        if (hit) flag(hit.selector, `${hit.selector} matches the forbidden mark ${selector}`)
        break
      }
    }
  }
  return {
    verdict: violations.length ? 'fail' : 'pass',
    violations: violations.slice(0, MAX_VIOLATIONS),
    rules: rules.length,
    checked: violations.length,
  }
}

/** Check a rendered frame against the brand rules in a guideline document.
 *  `selector` scopes the report to one element and its descendants, using the
 *  same selector syntax every other tool takes. */
export async function checkBrandCompliance(
  frame: Frame,
  markdown: string,
  opts: { selector?: string } = {},
): Promise<BrandReport> {
  const rules = parseBrandRules(markdown)
  /* nothing to check: a canvas with no brand section must not pay a render to
     learn that, and the tool does not invent rules */
  if (!rules.length) return { verdict: 'pass', violations: [], rules: 0, checked: 0 }
  const report = brandProbe(await probeFrame(frame), rules)
  if (!opts.selector) return report
  const selector = opts.selector
  const violations = report.violations.filter(
    (violation) => violation.selector === selector || violation.selector.startsWith(`${selector} > `),
  )
  return {
    verdict: violations.length ? 'fail' : 'pass',
    violations,
    rules: report.rules,
    checked: violations.length,
  }
}
