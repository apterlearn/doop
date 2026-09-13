import type { DesignTokens } from './types.ts'

/**
 * Design tokens → CSS. One implementation for both surfaces: the server
 * injects the same block into every render (screenshots, lint, review,
 * exports) and the browser injects it into every frame it mounts, so a frame
 * looks the same whether it is being designed, checked or exported.
 *
 * The block is never stored in a frame's HTML: `withTokenStyle` adds it at
 * render time and `stripTokenStyle` removes it on the way back, so changing
 * the tokens restyles every frame without rewriting a single frame document.
 */

/** Marker attribute on the injected <style>, so it can be found and replaced
 *  (or removed) without touching the frame's own styles. */
const TOKEN_ATTR = 'data-doop-tokens'

/** A frame can opt out of token binding with this attribute on <html> or
 *  <body> — for a design that deliberately ships its own :root. */
const OPT_OUT_ATTR = 'data-doop-tokens="off"'

/** The tokens as a `:root` block. The one place a token becomes CSS. */
export function cssForTokens(tokens: DesignTokens): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(tokens.colors ?? {})) lines.push(`  --color-${name}: ${value.trim()};`)
  for (const [key, value] of Object.entries(tokens.fonts ?? {})) {
    if (value) lines.push(`  --font-${key}: ${value.trim()};`)
  }
  for (const value of tokens.spacing ?? []) lines.push(`  --space-${value}: ${value}px;`)
  for (const value of tokens.radii ?? []) lines.push(`  --radius-${value}: ${value}px;`)
  for (const [index, value] of (tokens.shadows ?? []).entries()) lines.push(`  --shadow-${index + 1}: ${value.trim()};`)
  for (const value of tokens.type?.size ?? []) lines.push(`  --text-${value}: ${value}px;`)
  for (const value of tokens.type?.weight ?? []) lines.push(`  --weight-${value}: ${value};`)
  for (const value of tokens.type?.leading ?? []) lines.push(`  --leading-${value}: ${value};`)
  return `:root {\n${lines.join('\n')}\n}`
}

/** The tokens as a <style> element ready to drop into a document head. */
export function tokenStyleBlock(tokens: DesignTokens): string {
  return `<style ${TOKEN_ATTR}>\n${cssForTokens(tokens)}\n</style>`
}

const TOKEN_STYLE_RE = new RegExp(`<style\\s+${TOKEN_ATTR}(?:\\s[^>]*)?>[\\s\\S]*?</style>`, 'gi')

/** Drop any injected token block — the inverse of `withTokenStyle`. Every
 *  write path runs this, so an injected block can never be stored as part of
 *  a frame. */
export function stripTokenStyle(html: string): string {
  return html.replace(TOKEN_STYLE_RE, '')
}

/** A frame that declares it ships its own token root. */
const TOKENS_OFF_RE = new RegExp(`<(?:html|body)[^>]*${OPT_OUT_ATTR}`, 'i')

/**
 * Bind tokens into a document: replace a previously injected block, else
 * insert one as the last thing in <head> (so it wins ties against the frame's
 * own `:root` at equal specificity). A document with no <head> gets it before
 * the first <body>; a fragment gets it prepended.
 */
export function withTokenStyle(html: string, tokens: DesignTokens | undefined | null): string {
  const clean = stripTokenStyle(html)
  if (!tokens || TOKENS_OFF_RE.test(clean)) return clean
  const block = tokenStyleBlock(tokens)
  const headEnd = clean.toLowerCase().lastIndexOf('</head>')
  if (headEnd !== -1) return `${clean.slice(0, headEnd)}${block}${clean.slice(headEnd)}`
  const bodyStart = clean.toLowerCase().indexOf('<body')
  if (bodyStart !== -1) return `${clean.slice(0, bodyStart)}${block}${clean.slice(bodyStart)}`
  return `${block}${clean}`
}
