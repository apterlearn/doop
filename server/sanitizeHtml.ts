/**
 * Sanitizing captured HTML before it becomes a frame.
 *
 * This is the ONE copy of the import sanitize rules, in two forms. The string
 * form below is what `import_code` applies to agent-supplied HTML, and the
 * last filter the website importer runs over its capture. The DOM form lives
 * in the importer's `page.evaluate` — removal has to happen in the live page
 * because layout is measured and stylesheets are collected from it before the
 * document is serialized — and it consumes these rules through
 * `IMPORT_SANITIZE_RULES` so neither side can drift.
 */

/** Elements a captured document must not keep: scripts re-run inside the
 *  canvas iframe, and frames/objects pull in a document we do not own. */
export const STRIPPED_ELEMENTS: readonly string[] = [
  'script',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'fencedframe',
]

/** The one `<meta>` attribute a captured page may not set. */
export const HTTP_EQUIV_ATTRIBUTE = 'http-equiv'

/** `meta[http-equiv]` tags are dropped wherever they appear: a captured
 *  snapshot is passive, and a http-equiv can re-impose refresh or CSP
 *  behaviour on the frame (the importer injects its own CSP afterwards). */
export const IMPORT_HTTP_EQUIV_SELECTOR = `meta[${HTTP_EQUIV_ATTRIBUTE}]`

/** Attributes removed by exact name: srcdoc carries a whole document, ping
 *  phones home on click. */
export const UNSAFE_ATTRIBUTE_NAMES: readonly string[] = ['srcdoc', 'ping']

/** Attributes removed by name prefix — every inline handler. */
export const UNSAFE_ATTRIBUTE_PREFIXES: readonly string[] = ['on']

/** Attributes whose value is a URL the frame would load or navigate. */
export const EXECUTABLE_URL_ATTRIBUTES: readonly string[] = [
  'action',
  'formaction',
  'href',
  'poster',
  'src',
  'xlink:href',
]

/** Trimmed-value test for an executable URL attribute. */
export const JAVASCRIPT_URL = /^\s*javascript:/i

/** The importer's in-page pass applies exactly these rules. Plain data, so it
 *  survives being passed as a `page.evaluate` argument. */
export const IMPORT_SANITIZE_RULES = {
  stripSelector: STRIPPED_ELEMENTS.join(', '),
  httpEquivSelector: IMPORT_HTTP_EQUIV_SELECTOR,
  unsafeAttributeNames: UNSAFE_ATTRIBUTE_NAMES,
  unsafeAttributePrefixes: UNSAFE_ATTRIBUTE_PREFIXES,
  executableUrlAttributes: EXECUTABLE_URL_ATTRIBUTES,
  javascriptUrlPattern: JAVASCRIPT_URL.source,
} as const

export interface SanitizeOptions {
  /** Resolve relative `url(...)` references against this URL. Without it
   *  relative references are left untouched — the frame keeps a `<base>` to
   *  resolve them, and inventing a base would be wrong. */
  baseUrl?: string
}

/* A tag, with quoted attribute values matched as a whole, so a ">" inside a
   value does not end the match early. Text between tags is never rewritten. */
const TAG = /<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g

const ELEMENT_NAMES = STRIPPED_ELEMENTS.join('|')

/** An element whose content goes with the tag. Content-free tags are caught by
 *  the leftover pass — the paired pass simply never matches them. */
const PAIRED_ELEMENT = new RegExp(`<(${ELEMENT_NAMES})\\b(?:"[^"]*"|'[^']*'|[^>"'])*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi')

/** An open or close tag left behind (an unclosed element has no content
 *  boundary to find), removed without touching what follows it. */
const LEFTOVER_TAG = new RegExp(`<\\/?(${ELEMENT_NAMES})\\b(?:"[^"]*"|'[^']*'|[^>"'])*\\/?>`, 'gi')

const ATTRIBUTE = /([\s/]+)([^\s"'=<>/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g

/** CSS url() references that need no resolution. */
const CSS_URL = /url\(\s*(['"]?)(?!data:|https?:|\/\/|#|blob:|mailto:)([^'")]+)\1\s*\)/gi

/** A `<meta http-equiv>` tag: the attribute name must appear outside a quoted
 *  value, so `content="…"` cannot smuggle a match. */
const META_HTTP_EQUIV = new RegExp(
  `<meta\\b(?:"[^"]*"|'[^']*'|[^>"'])*\\s${HTTP_EQUIV_ATTRIBUTE}(?:"[^"]*"|'[^']*'|[^>"'])*>`,
  'gi',
)

function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!))
    return value.slice(1, -1)
  return value
}

/** Strip unsafe attributes from one tag, byte-identical when there is nothing
 *  to strip. `/` separates attributes in real HTML too (`<svg/onload=…>`), but
 *  a quoted value is consumed as one attribute before it can be re-scanned, so
 *  a `/` inside a URL never reads as an attribute separator. */
function sanitizeTag(tag: string): string {
  /* closing tags carry no attributes, and a match without a tag name cannot
     be an attribute carrier either */
  if (tag.startsWith('</')) return tag
  const open = /^<[a-zA-Z][^\s/>]*/.exec(tag)
  if (!open) return tag
  const cleaned = tag.slice(open[0].length).replace(ATTRIBUTE, (all, sep: string, name: string, value?: string) => {
    const lower = name.toLowerCase()
    if (UNSAFE_ATTRIBUTE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return sep
    if (UNSAFE_ATTRIBUTE_NAMES.includes(lower)) return sep
    if (EXECUTABLE_URL_ATTRIBUTES.includes(lower) && value && JAVASCRIPT_URL.test(unquote(value))) return sep
    return all
  })
  return open[0] + cleaned
}

export function sanitizeImportedHtml(html: string, options: SanitizeOptions = {}): string {
  let out = html.replace(PAIRED_ELEMENT, '')
  out = out.replace(LEFTOVER_TAG, '')
  out = out.replace(META_HTTP_EQUIV, '')
  out = out.replace(TAG, sanitizeTag)
  if (!options.baseUrl) return out
  return out.replace(CSS_URL, (all, quote: string, ref: string) => {
    try {
      return `url(${quote}${new URL(ref, options.baseUrl).href}${quote})`
    } catch {
      /* unresolvable reference: leave it for the frame's <base> to sort out */
      return all
    }
  })
}
