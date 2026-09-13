import type { DesignTokens, Frame } from '../shared/types.ts'
import { probeFrame, type Probe } from './domProbe.ts'

/**
 * The token conformance lint: does a rendered frame use the canvas's declared
 * palette, type scale and spacing/radii scales, or has it drifted into
 * near-miss shades and one-off paddings?
 *
 * Token validation and CSS rendering live elsewhere — server/tokenCss.ts and
 * shared/tokens.ts — so this module stays a pure function over a probe.
 */

/* ---- design lint ---- */

export type LintRule = 'off_token_color' | 'off_token_font' | 'off_token_type' | 'off_scale_radius' | 'off_grid_spacing'

export interface LintViolation {
  rule: LintRule
  selector: string
  /** the CSS property that drifted — what a fix has to rewrite */
  property: string
  value: string
  expected: string
  /** the token the value should have used, named the way a frame refers to it
   *  (`--color-ink`, `--space-8`). Absent where there is no nearest to name: a
   *  font family is a membership test, not a distance. */
  nearest_token?: string
  /** how far `value` sits from `nearest_token`, in the rule's own unit: CIE76
   *  for colors, px for lengths, weight steps, a leading ratio. */
  distance?: number
}

export interface LintReport {
  violations: LintViolation[]
  counts: Record<LintRule, number>
  tokens_present: boolean
  checked_elements: number
}

const MAX_VIOLATIONS = 50
/** Perceptual distance under which two colors are the same design decision. */
const COLOR_TOLERANCE = 3

function parseColor(value: string): [number, number, number] | undefined {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hex) {
    const raw = hex[1]!
    const full =
      raw.length === 3
        ? raw
            .split('')
            .map((c) => c + c)
            .join('')
        : raw.slice(0, 6)
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ]
  }
  const rgb = value.trim().match(/^rgba?\(([^)]+)\)$/)
  if (!rgb) return undefined
  const parts = rgb[1]!.split(',').map((p) => Number.parseFloat(p.trim()))
  if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return undefined
  return [parts[0]!, parts[1]!, parts[2]!]
}

function toLab([r, g, b]: [number, number, number]): [number, number, number] {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [channel(r), channel(g), channel(b)]
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 distance — enough to tell "the same brand color" from "a different
 *  color", and free of a dependency. */
export function colorDistance(a: string, b: string): number | undefined {
  const left = parseColor(a)
  const right = parseColor(b)
  if (!left || !right) return undefined
  const [l1, a1, b1] = toLab(left)
  const [l2, a2, b2] = toLab(right)
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
}

/** The first family in a CSS font stack, lowercased and unquoted. */
function firstFamily(stack: string): string {
  return (stack.split(',')[0] ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
}

function px(value: string): number | undefined {
  const match = value.match(/^(-?[\d.]+)px$/)
  return match ? Number.parseFloat(match[1]!) : undefined
}

/** The CSS custom-property name a token is published under. Mirrors
 *  `cssForTokens` (shared/tokens.ts) — the one place a token becomes CSS — so a
 *  finding can name the token a frame would actually reference, and a fix that
 *  emits `var(--space-8)` resolves because the render injects exactly that. */
function tokenVar(
  kind: 'color' | 'font' | 'space' | 'radius' | 'text' | 'weight' | 'leading',
  token: string | number,
): string {
  return `--${kind}-${token}`
}

/** The nearest value on a declared scale. One implementation, so the token the
 *  lint names and the token a fix rewrites to are the same choice. */
function nearestOnScale(value: number, scale: number[]): number | undefined {
  if (scale.length === 0) return undefined
  return scale.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a))
}

/** Check a rendered frame against the canvas's tokens. Pure over a probe, so
 *  the rules are verifiable without a browser. */
export function lintProbe(probe: Probe, tokens: DesignTokens | undefined): LintReport {
  const empty: Record<LintRule, number> = {
    off_token_color: 0,
    off_token_font: 0,
    off_token_type: 0,
    off_scale_radius: 0,
    off_grid_spacing: 0,
  }
  /* nothing to lint against: the tool does not invent a scale */
  if (!tokens) {
    return { violations: [], counts: empty, tokens_present: false, checked_elements: probe.elements.length }
  }
  const visible = probe.elements.filter((el) => !el.attrs.hiddenFromAT)
  const colorTokens = Object.entries(tokens.colors ?? {})
  const fontTokens = Object.values(tokens.fonts ?? {}).filter((f): f is string => !!f)
  const spacingScale = tokens.spacing ?? []
  const radiiScale = tokens.radii ?? []
  const sizeScale = tokens.type?.size ?? []
  const weightScale = tokens.type?.weight ?? []
  const leadingScale = tokens.type?.leading ?? []
  const violations: LintViolation[] = []

  const nearestColor = (value: string): { token: string; distance: number } | undefined => {
    let best: { token: string; distance: number } | undefined
    for (const [name, token] of colorTokens) {
      const distance = colorDistance(value, token)
      if (distance === undefined) continue
      if (!best || distance < best.distance) best = { token: name, distance }
    }
    return best
  }

  for (const el of visible) {
    if (colorTokens.length) {
      for (const [property, declared] of [
        ['color', el.style.color],
        ['background-color', el.style.background],
      ] as const) {
        if (!declared || declared === 'rgba(0, 0, 0, 0)') continue
        const nearest = nearestColor(declared)
        /* an unparseable value (a gradient, `currentcolor`) is not a color
           decision to judge — skip rather than report noise */
        if (!nearest || nearest.distance <= COLOR_TOLERANCE) continue
        violations.push({
          rule: 'off_token_color',
          selector: el.selector,
          property,
          value: declared,
          expected: nearest.token,
          nearest_token: tokenVar('color', nearest.token),
          distance: nearest.distance,
        })
      }
    }
    if (fontTokens.length) {
      const family = firstFamily(el.style.font)
      if (family && !fontTokens.some((token) => firstFamily(token) === family)) {
        violations.push({
          rule: 'off_token_font',
          selector: el.selector,
          property: 'font-family',
          value: family,
          expected: fontTokens.join(', '),
        })
      }
    }
    if (sizeScale.length || weightScale.length || leadingScale.length) {
      const fontSize = el.fontSizePx
      if (fontSize > 0 && sizeScale.length) {
        const nearest = nearestOnScale(fontSize, sizeScale)!
        /* half a pixel is sub-perceptual at every size a design uses; beyond
           that the frame invented a size of its own */
        if (Math.abs(nearest - fontSize) > 0.5) {
          violations.push({
            rule: 'off_token_type',
            selector: el.selector,
            property: 'font-size',
            value: `${fontSize}px`,
            expected: sizeScale.map((s) => `${s}px`).join(', '),
            nearest_token: tokenVar('text', nearest),
            distance: Math.abs(nearest - fontSize),
          })
        }
      }
      if (el.fontWeight > 0 && weightScale.length && !weightScale.includes(el.fontWeight)) {
        const nearest = nearestOnScale(el.fontWeight, weightScale)!
        violations.push({
          rule: 'off_token_type',
          selector: el.selector,
          property: 'font-weight',
          value: `font-weight ${el.fontWeight}`,
          expected: weightScale.join(', '),
          nearest_token: tokenVar('weight', nearest),
          distance: Math.abs(nearest - el.fontWeight),
        })
      }
      const lineHeightPx = Number.parseFloat(el.style.lineHeight)
      if (fontSize > 0 && lineHeightPx > 0 && leadingScale.length) {
        const ratio = lineHeightPx / fontSize
        const nearest = nearestOnScale(ratio, leadingScale)!
        if (Math.abs(nearest - ratio) > 0.05) {
          violations.push({
            rule: 'off_token_type',
            selector: el.selector,
            property: 'line-height',
            value: `line-height ${ratio.toFixed(2)}`,
            expected: leadingScale.join(', '),
            nearest_token: tokenVar('leading', nearest),
            distance: Math.abs(nearest - ratio),
          })
        }
      }
    }
    if (radiiScale.length) {
      for (const corner of el.style.borderRadius.split(/\s+/)) {
        const value = px(corner)
        if (value === undefined || value === 0 || radiiScale.includes(value)) continue
        const nearest = nearestOnScale(value, radiiScale)!
        violations.push({
          rule: 'off_scale_radius',
          selector: el.selector,
          property: 'border-radius',
          value: corner,
          expected: radiiScale.map((r) => `${r}px`).join(', '),
          nearest_token: tokenVar('radius', nearest),
          distance: Math.abs(nearest - value),
        })
      }
    }
    if (spacingScale.length) {
      for (const [property, shorthand] of [
        ['margin', el.style.margin],
        ['padding', el.style.padding],
        ['gap', el.style.gap],
      ] as const) {
        for (const part of shorthand.split(/\s+/)) {
          const value = px(part)
          if (value === undefined || value === 0 || spacingScale.includes(value)) continue
          const nearest = nearestOnScale(value, spacingScale)!
          violations.push({
            rule: 'off_grid_spacing',
            selector: el.selector,
            property,
            value: `${property}: ${value}px`,
            expected: spacingScale.map((s) => `${s}px`).join(', '),
            nearest_token: tokenVar('space', nearest),
            distance: Math.abs(nearest - value),
          })
        }
      }
    }
  }

  const counts = { ...empty }
  for (const violation of violations) counts[violation.rule] += 1
  return {
    violations: violations.slice(0, MAX_VIOLATIONS),
    counts,
    tokens_present: true,
    checked_elements: visible.length,
  }
}

export async function lintFrame(
  frame: Frame,
  tokens: DesignTokens | undefined,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<LintReport> {
  return lintProbe(await probeFrame(frame, opts), tokens)
}

/* ---- token write-back ---- */

export interface TokenFix {
  selector: string
  property: string
  from: string
  to: string
}

/** The unit a finding's distance is measured in, which decides the tolerance a
 *  fix may snap within. */
type FixUnit = 'color' | 'length' | 'weight' | 'ratio'

/** How far a value may sit from a token and still be snapped to it. The lint's
 *  tolerance answers "are these the same design decision?"; a fix answers a
 *  looser question — "is this token the one the author meant?" — because a
 *  value the lint already refused has to be close to be worth rewriting at
 *  all, and every substitution is reported so the caller sees the judgement
 *  rather than a silent rewrite. */
const SNAP_TOLERANCE: Record<FixUnit, number> = {
  /* CIE76. Calibrated on the near-miss shades a frame actually drifts to: a
     #1a1a1a→#111111 slip is 4, #222222→#111110 is 8, #333333→#111110 is 16 —
     all the same shade to a reader — while #444444 is 24 and a different hue
     is 100+. Everything past this is a colour choice, not a typo, and the
     finding's `distance` lets a caller draw the line differently. */
  color: 20,
  length: 2, // px: under half a step of any scale a design uses
  weight: 100, // one weight step
  ratio: 0.1, // leading
}

/** The unit a property's distance is measured in. Every property the lint
 *  emits is either one of these or a font family, which is a membership test
 *  with no distance to judge. */
function fixUnitFor(property: string): FixUnit | undefined {
  if (property === 'color' || property === 'background-color') return 'color'
  if (property === 'font-weight') return 'weight'
  if (property === 'line-height') return 'ratio'
  if (property === 'font-family') return undefined
  return 'length'
}

/** Every custom-property name the canvas publishes, the same set `cssForTokens`
 *  writes into the frame. A fix may only emit a `var()` that resolves: the
 *  report can outlive the palette it was made against. */
function publishedTokenVars(tokens: DesignTokens): Set<string> {
  const names = new Set<string>()
  for (const name of Object.keys(tokens.colors ?? {})) names.add(tokenVar('color', name))
  for (const [key, value] of Object.entries(tokens.fonts ?? {})) if (value) names.add(tokenVar('font', key))
  for (const value of tokens.spacing ?? []) names.add(tokenVar('space', value))
  for (const value of tokens.radii ?? []) names.add(tokenVar('radius', value))
  for (const value of tokens.type?.size ?? []) names.add(tokenVar('text', value))
  for (const value of tokens.type?.weight ?? []) names.add(tokenVar('weight', value))
  for (const value of tokens.type?.leading ?? []) names.add(tokenVar('leading', value))
  return names
}

/**
 * Turn a lint report into the edits that would put the frame back on its
 * tokens. Pure over the report and the tokens — it renders nothing and invents
 * nothing: a value with no token close enough is reported in `skipped` with the
 * distance that made it a judgement call, never snapped to a guess.
 */
export function planTokenFixes(
  report: LintReport,
  tokens: DesignTokens,
  only?: LintRule[],
): { fixed: TokenFix[]; skipped: { selector: string; property: string; value: string; reason: string }[] } {
  const fixed: TokenFix[] = []
  const skipped: { selector: string; property: string; value: string; reason: string }[] = []
  const wanted = only && only.length > 0 ? new Set(only) : undefined
  const published = publishedTokenVars(tokens)
  for (const violation of report.violations) {
    if (wanted && !wanted.has(violation.rule)) continue
    const unit = fixUnitFor(violation.property)
    const tolerance = unit ? SNAP_TOLERANCE[unit] : undefined
    const token = violation.nearest_token
    const entry = { selector: violation.selector, property: violation.property, value: violation.value }
    /* no nearest to name (a font family), or a rule with no distance unit */
    if (token === undefined || violation.distance === undefined || tolerance === undefined) {
      skipped.push({ ...entry, reason: 'no token within tolerance' })
      continue
    }
    /* the report may predate the palette: a var() that no longer resolves
       would leave the frame with no color at all */
    if (!published.has(token)) {
      skipped.push({ ...entry, reason: `${token} is no longer a canvas token — re-run lint_frame` })
      continue
    }
    if (violation.distance > tolerance) {
      skipped.push({
        ...entry,
        reason: `${token} is ${violation.distance.toFixed(1)} away — the fix tolerance is ${tolerance}`,
      })
      continue
    }
    fixed.push({
      selector: violation.selector,
      property: violation.property,
      from: violation.value,
      to: `var(${token})`,
    })
  }
  return { fixed, skipped }
}
