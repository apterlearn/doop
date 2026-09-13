import type { DesignTokens } from '../shared/types.ts'
import { cssForTokens } from '../shared/tokens.ts'
import type { Probe, UsageCount } from './domProbe.ts'

/**
 * Turning a rendered page into a design system: the palette, type ramp and
 * scales a frame (or an imported page) actually uses, named and written up as
 * a guide.
 *
 * This is the step that was missing between "here is a reference site" and
 * "design in this style". `inspect_frame` reports the top colours by usage but
 * never turns them into tokens, so an agent inventing a design system picks its
 * own hexes; these functions derive one from evidence and say what the evidence
 * was.
 */

export interface DesignSystemEvidence {
  colors: UsageCount[]
  fonts: UsageCount[]
  sizes: UsageCount[]
  weights: UsageCount[]
  leading: UsageCount[]
  spacing: UsageCount[]
  radii: UsageCount[]
}

export interface DesignSystem {
  tokens: Omit<DesignTokens, 'updatedAt' | 'updatedBy'>
  evidence: DesignSystemEvidence
  notes: string[]
}

/** `rgb(r, g, b)` → `#rrggbb`, so a token is a value a designer recognises.
 *  Anything else (oklch, colour functions, `transparent`) is kept verbatim. */
function toHex(value: string): string {
  const match = value.match(/^rgba?\(([^)]+)\)$/)
  if (!match) return value
  const parts = match[1]!.split(',').map((p) => Number.parseFloat(p.trim()))
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return value
  const hex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${hex(parts[0]!)}${hex(parts[1]!)}${hex(parts[2]!)}`
}

/** A CSS custom property name becomes the token name: `--brand-ink` → `ink`
 *  when the variable was declared, otherwise `color-1`, `color-2`, … in usage
 *  order. A name the caller can read back is worth more than a stable one.
 *  The token namespace itself is stripped — the frame's `--color-ink` is the
 *  token `ink`, and rendering it back as `--color-color-ink` would rename the
 *  palette the frames are already written against.
 *  Values are compared after normalising to hex, so `--ink: #111110` and a
 *  computed `rgb(17, 17, 16)` are recognised as the same colour. */
function nameFromVariable(probe: Probe, value: string): string | undefined {
  const wanted = toHex(value.trim()).toLowerCase()
  for (const [name, variableValue] of Object.entries(probe.design.cssVariables)) {
    if (toHex(variableValue.trim()).toLowerCase() !== wanted) continue
    const token = name.replace(/^--/, '').replace(/^(?:color|colour)-/, '')
    if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(token)) return token
  }
  return undefined
}

const px = (value: string): number | undefined => {
  const match = value.match(/^(-?[\d.]+)px$/)
  if (!match) return undefined
  const n = Number.parseFloat(match[1]!)
  return Number.isFinite(n) ? n : undefined
}

/** The first family in a computed `font-family` list. */
const firstFamily = (value: string): string =>
  value
    .split(',')[0]!
    .replace(/^["']|["']$/g, '')
    .trim()

/**
 * Derive a token set from a probe. Pure, so the derivation is testable against
 * a fixed probe without a browser, and so an imported page and a live frame go
 * through exactly the same rules.
 */
export function deriveDesignSystem(probe: Probe): DesignSystem {
  const notes: string[] = []
  const evidence: DesignSystemEvidence = {
    colors: probe.designEvidence.colors,
    fonts: probe.designEvidence.fonts,
    sizes: probe.designEvidence.fontSizes,
    weights: probe.designEvidence.fontWeights,
    leading: probe.designEvidence.leading,
    spacing: probe.designEvidence.spacing,
    radii: probe.designEvidence.radii,
  }

  const colors: Record<string, string> = {}
  /* the first positional name still free: a variable may be called
     `--color-2` and take it before the second colour gets there */
  const positional = (index: number): string => {
    let n = index + 1
    while (colors[`color-${n}`]) n += 1
    return `color-${n}`
  }
  probe.designEvidence.colors.slice(0, 12).forEach((entry, index) => {
    const name = nameFromVariable(probe, entry.value) ?? positional(index)
    /* a name collision means two colours map to one variable name; keep the
       first and let the second fall back to its positional name */
    if (colors[name]) colors[positional(index)] = toHex(entry.value)
    else colors[name] = toHex(entry.value)
  })

  const familyNames = probe.designEvidence.fonts.map((entry) => firstFamily(entry.value)).filter(Boolean)
  const uniqueFamilies = [...new Set(familyNames)]
  const fonts: DesignTokens['fonts'] = {}
  /* body is the most-used family; a code family is recognised by name; display
     is the most-used family that is neither, so a single-family design gets
     body alone rather than a display face that is a copy of it */
  const mono = uniqueFamilies.find((family) => /mono|code|courier|consolas/i.test(family))
  const body = uniqueFamilies.find((family) => family !== mono)
  if (body) fonts.body = body
  const display = uniqueFamilies.find((family) => family !== mono && family !== body)
  if (display) fonts.display = display
  if (mono) fonts.mono = mono

  const sizes = [
    ...new Set(
      probe.designEvidence.fontSizes.map((entry) => px(entry.value)).filter((n): n is number => n !== undefined),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 12)
  const weights = [
    ...new Set(
      probe.designEvidence.fontWeights
        .map((entry) => Number.parseInt(entry.value, 10))
        .filter((n) => Number.isInteger(n) && n >= 100 && n <= 900 && n % 100 === 0),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 12)
  /* Leading is counted in the page, per element, as line-height / font-size:
     the ratio a token holds, rather than a reconstruction from two separate
     usage counts. */
  const leading = [
    ...new Set(
      probe.designEvidence.leading
        .map((entry) => Number.parseFloat(entry.value))
        .filter((n) => Number.isFinite(n) && n >= 0.5 && n <= 3),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 12)
  const spacing = [
    ...new Set(
      probe.designEvidence.spacing
        .map((entry) => px(entry.value))
        .filter((n): n is number => n !== undefined && n > 0 && n <= 200),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 12)
  const radii = [
    ...new Set(
      probe.designEvidence.radii
        .map((entry) => px(entry.value))
        .filter((n): n is number => n !== undefined && n >= 0 && n <= 200),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 12)
  const shadows = probe.designEvidence.shadows.map((entry) => entry.value).slice(0, 8)

  if (!Object.keys(colors).length)
    notes.push('no painted colors found — the frame may be empty or entirely transparent')
  if (!sizes.length) notes.push('no font sizes found')
  if (!spacing.length) notes.push('no px spacing found — the layout may use rem, em or percentages')
  if (probe.document.fontsFailed.length)
    notes.push(
      `these font families did not load and were measured as fallbacks: ${probe.document.fontsFailed.join(', ')}`,
    )

  const tokens: DesignSystem['tokens'] = { colors }
  if (Object.keys(fonts).length) tokens.fonts = fonts
  if (spacing.length) tokens.spacing = spacing
  if (radii.length) tokens.radii = radii
  if (shadows.length) tokens.shadows = shadows
  if (sizes.length || weights.length || leading.length) {
    tokens.type = {
      ...(sizes.length ? { size: sizes } : {}),
      ...(weights.length ? { weight: weights } : {}),
      ...(leading.length ? { leading } : {}),
    }
  }
  return { tokens, evidence, notes }
}

/** The token set written up as a guide a designer or an agent can follow. */
export function designSystemMarkdown(system: DesignSystem, source: string): string {
  const { tokens, evidence, notes } = system
  const lines: string[] = [`# Design system — ${source}`, '']
  lines.push('Derived from the rendered page. Follow these values; do not invent near-misses.', '')

  lines.push('## Palette', '')
  lines.push('| Token | Value | Uses |', '| --- | --- | --- |')
  for (const [name, value] of Object.entries(tokens.colors)) {
    const used = evidence.colors.find((entry) => toHex(entry.value) === value)?.count ?? 0
    lines.push(`| \`--color-${name}\` | \`${value}\` | ${used} |`)
  }
  lines.push('')

  if (tokens.fonts) {
    lines.push('## Typography', '')
    for (const [key, value] of Object.entries(tokens.fonts)) lines.push(`- ${key}: ${value}`)
    if (tokens.type?.size?.length) lines.push(`- sizes: ${tokens.type.size.map((n) => `${n}px`).join(', ')}`)
    if (tokens.type?.weight?.length) lines.push(`- weights: ${tokens.type.weight.join(', ')}`)
    if (tokens.type?.leading?.length) lines.push(`- line heights: ${tokens.type.leading.join(', ')}`)
    lines.push('')
  }

  if (tokens.spacing?.length || tokens.radii?.length) {
    lines.push('## Shape & space', '')
    if (tokens.spacing?.length)
      lines.push(`- spacing: ${tokens.spacing.map((n) => `${n}px`).join(', ')} — use these for padding, margin and gap`)
    if (tokens.radii?.length) lines.push(`- radii: ${tokens.radii.map((n) => `${n}px`).join(', ')}`)
    if (tokens.shadows?.length) lines.push(`- shadows: ${tokens.shadows.map((s) => `\`${s}\``).join(', ')}`)
    lines.push('')
  }

  lines.push('## Usage rules', '')
  lines.push('- Reference the tokens as CSS variables (`var(--color-ink)`); the canvas binds them into every render.')
  lines.push('- Sizes, weights, line heights, spacing and radii come from the scales above — no in-between values.')
  lines.push('- Text over an image or gradient needs its own contrast check; the palette only covers flat backgrounds.')
  if (notes.length) {
    lines.push('', '## Notes', '')
    for (const note of notes) lines.push(`- ${note}`)
  }
  lines.push(
    '',
    '## CSS variables',
    '',
    '```css',
    cssForTokens({ ...tokens, updatedAt: 0, updatedBy: 'derived' }),
    '```',
  )
  return lines.join('\n')
}

/** The content outline as markdown, for the guide and for spec sheets. */
export function contentMarkdown(probe: Probe): string {
  const { content } = probe
  const lines: string[] = ['## Structure', '']
  if (content.headings.length) {
    lines.push('Headings:')
    for (const heading of content.headings.slice(0, 30))
      lines.push(`- h${heading.level}: ${heading.text}${heading.text ? '' : '(empty)'}`)
    lines.push('')
  }
  if (content.sections.length) {
    lines.push('Sections:')
    for (const section of content.sections.slice(0, 20))
      lines.push(`- ${section.heading ?? '(no heading)'} — ${section.text.slice(0, 120)}`)
    lines.push('')
  }
  if (content.ctas.length) {
    lines.push('Calls to action:')
    for (const cta of content.ctas.slice(0, 15)) lines.push(`- ${cta.text}${cta.href ? ` → ${cta.href}` : ''}`)
    lines.push('')
  }
  if (content.images.length) {
    lines.push('Images:')
    for (const image of content.images.slice(0, 20))
      lines.push(`- ${image.src} (${image.width}×${image.height}) alt: ${image.alt || '(none)'}`)
  }
  return lines.join('\n')
}
