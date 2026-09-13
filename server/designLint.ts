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
  value: string
  expected: string
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
      for (const declared of [el.style.color, el.style.background]) {
        if (!declared || declared === 'rgba(0, 0, 0, 0)') continue
        const nearest = nearestColor(declared)
        /* an unparseable value (a gradient, `currentcolor`) is not a color
           decision to judge — skip rather than report noise */
        if (!nearest || nearest.distance <= COLOR_TOLERANCE) continue
        violations.push({ rule: 'off_token_color', selector: el.selector, value: declared, expected: nearest.token })
      }
    }
    if (fontTokens.length) {
      const family = firstFamily(el.style.font)
      if (family && !fontTokens.some((token) => firstFamily(token) === family)) {
        violations.push({
          rule: 'off_token_font',
          selector: el.selector,
          value: family,
          expected: fontTokens.join(', '),
        })
      }
    }
    if (sizeScale.length || weightScale.length || leadingScale.length) {
      const fontSize = el.fontSizePx
      if (fontSize > 0 && sizeScale.length) {
        const nearest = sizeScale.reduce((a, b) => (Math.abs(b - fontSize) < Math.abs(a - fontSize) ? b : a))
        /* half a pixel is sub-perceptual at every size a design uses; beyond
           that the frame invented a size of its own */
        if (Math.abs(nearest - fontSize) > 0.5) {
          violations.push({
            rule: 'off_token_type',
            selector: el.selector,
            value: `${fontSize}px`,
            expected: sizeScale.map((s) => `${s}px`).join(', '),
          })
        }
      }
      if (el.fontWeight > 0 && weightScale.length && !weightScale.includes(el.fontWeight)) {
        violations.push({
          rule: 'off_token_type',
          selector: el.selector,
          value: `font-weight ${el.fontWeight}`,
          expected: weightScale.join(', '),
        })
      }
      const lineHeightPx = Number.parseFloat(el.style.lineHeight)
      if (fontSize > 0 && lineHeightPx > 0 && leadingScale.length) {
        const ratio = lineHeightPx / fontSize
        const nearest = leadingScale.reduce((a, b) => (Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a))
        if (Math.abs(nearest - ratio) > 0.05) {
          violations.push({
            rule: 'off_token_type',
            selector: el.selector,
            value: `line-height ${ratio.toFixed(2)}`,
            expected: leadingScale.join(', '),
          })
        }
      }
    }
    if (radiiScale.length) {
      for (const corner of el.style.borderRadius.split(/\s+/)) {
        const value = px(corner)
        if (value === undefined || value === 0 || radiiScale.includes(value)) continue
        violations.push({
          rule: 'off_scale_radius',
          selector: el.selector,
          value: corner,
          expected: radiiScale.map((r) => `${r}px`).join(', '),
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
          violations.push({
            rule: 'off_grid_spacing',
            selector: el.selector,
            value: `${property}: ${value}px`,
            expected: spacingScale.map((s) => `${s}px`).join(', '),
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
