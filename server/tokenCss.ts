import type { DesignTokens } from '../shared/types.ts'

/**
 * Token validation: the rules every surface that writes tokens has to obey.
 *
 * Validation lives apart from the CSS rendering (shared/tokens.ts) so the
 * server can validate without importing anything browser- or render-related —
 * the renderer is shared with the client, this is not.
 */

export const MAX_TOKEN_COLORS = 64
export const MAX_TOKEN_SPACING = 12
export const MAX_TOKEN_RADII = 12
export const MAX_TOKEN_SHADOWS = 8
export const MAX_TOKEN_TYPE = 12
const TOKEN_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
/* A token value is interpolated verbatim into `--color-x: <value>;`, so both
   patterns match the whole value and neither can contain a character that
   ends the declaration or opens a tag. */
const COLOR_RE =
  /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|color)\(\s*[-\w.%,\s/]+\))$/i
/** Chrome serialises a computed box-shadow colour-first, so the length cannot
 *  be anchored to the start; `none` is the absent value. */
const SHADOW_RE = /(?:^|[\s,])[-+]?(?:\d*\.)?\d+px(?=[\s,]|$)|^none$/i
const DECLARATION_BREAK_RE = /[;{}<>]/

/** Throws with a caller-facing message on the first invalid token. */
export function validateTokens(tokens: DesignTokens): void {
  const colorNames = Object.keys(tokens.colors ?? {})
  if (colorNames.length > MAX_TOKEN_COLORS)
    throw new Error(`${colorNames.length} colors — the limit is ${MAX_TOKEN_COLORS}`)
  for (const [name, value] of Object.entries(tokens.colors ?? {})) {
    if (!TOKEN_NAME_RE.test(name))
      throw new Error(`invalid color token name “${name}” — lowercase a-z, 0-9 and hyphens, starting alphanumeric`)
    if (typeof value !== 'string' || DECLARATION_BREAK_RE.test(value) || !COLOR_RE.test(value.trim()))
      throw new Error(`invalid color for token “${name}”: ${String(value)} — use a hex, rgb(), hsl() or oklch() value`)
  }
  for (const key of ['display', 'body', 'mono'] as const) {
    const font = tokens.fonts?.[key]
    if (font !== undefined && (typeof font !== 'string' || !font.trim()))
      throw new Error(`fonts.${key} is empty — name a font family or omit the key`)
  }
  const numeric = (values: number[] | undefined, key: string, limit: number, positive: boolean) => {
    if (values === undefined) return
    if (values.length > limit) throw new Error(`${values.length} ${key} values — the limit is ${limit}`)
    for (const value of values) {
      if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0))
        throw new Error(`invalid ${key} value ${value} — use ${positive ? 'positive' : 'non-negative'} numbers in px`)
    }
  }
  numeric(tokens.spacing, 'spacing', MAX_TOKEN_SPACING, true)
  numeric(tokens.radii, 'radii', MAX_TOKEN_RADII, false)
  const type = tokens.type
  numeric(type?.size, 'type.size', MAX_TOKEN_TYPE, true)
  if (type?.weight !== undefined) {
    if (type.weight.length > MAX_TOKEN_TYPE)
      throw new Error(`${type.weight.length} type.weight values — the limit is ${MAX_TOKEN_TYPE}`)
    for (const value of type.weight) {
      if (!Number.isInteger(value) || value < 100 || value > 900 || value % 100 !== 0)
        throw new Error(`invalid type.weight ${value} — use a CSS weight step: 100, 200, … 900`)
    }
  }
  if (type?.leading !== undefined) {
    if (type.leading.length > MAX_TOKEN_TYPE)
      throw new Error(`${type.leading.length} type.leading values — the limit is ${MAX_TOKEN_TYPE}`)
    for (const value of type.leading) {
      if (!Number.isFinite(value) || value < 0.5 || value > 3)
        throw new Error(`invalid type.leading ${value} — use a unitless ratio between 0.5 and 3`)
    }
  }
  if (tokens.shadows !== undefined) {
    if (tokens.shadows.length > MAX_TOKEN_SHADOWS)
      throw new Error(`${tokens.shadows.length} shadows — the limit is ${MAX_TOKEN_SHADOWS}`)
    for (const shadow of tokens.shadows) {
      if (typeof shadow !== 'string' || DECLARATION_BREAK_RE.test(shadow) || !SHADOW_RE.test(shadow.trim()))
        throw new Error(`invalid shadow “${String(shadow)}” — use a CSS box-shadow value`)
    }
  }
}
