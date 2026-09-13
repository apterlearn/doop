/**
 * The one way an element is named on a canvas.
 *
 * Three surfaces have to agree on this string or none of them can point at the
 * same element: the parent page (the Layers panel and the Inspector, which
 * parse frame HTML off the live DOM), the frame runtime (inside the sandboxed
 * iframe, which resolves a click to a selector), and the server (which probes a
 * rendered page to lint, inspect and edit it). An agent's selector only reaches
 * a human's selection if all three produce the same text, so the algorithm
 * lives here once.
 *
 * `elementPathOf` is deliberately self-contained — no imports, no nested
 * function declarations — because `ELEMENT_PATH_SRC` is interpolated into code
 * that runs inside the frame iframe and inside a puppeteer page, where neither
 * a module import nor the loader's `__name` helper exists. Keep it that way.
 */
export function elementPathOf(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1 && cur !== cur.ownerDocument.documentElement) {
    if (cur.id) {
      const cssEscape = (globalThis as { CSS?: { escape?: (value: string) => string } }).CSS?.escape
      parts.unshift('#' + (cssEscape ? cssEscape(cur.id) : cur.id))
      break
    }
    let nth = 1
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === cur.tagName) nth++
    }
    /* `localName`, not `tagName.toLowerCase()`: a CSS type selector is only
       lowercased against HTML elements, so a camelCase SVG element needs its
       own case back or the path matches nothing. */
    parts.unshift(`${cur.localName}:nth-of-type(${nth})`)
    cur = cur.parentElement
  }
  return parts.join(' > ')
}

/**
 * `elementPathOf` as an installable script: one expression, so it works
 * wherever it is pasted — a puppeteer `page.evaluate`, the frame runtime's
 * bootstrap string. `Function.prototype.toString` returns the transpiled
 * source, so the copy carries no TypeScript annotations.
 */
export const ELEMENT_PATH_SRC = `globalThis.doopElementPath = ${elementPathOf.toString()}`

/**
 * A content-addressed name for an element, for anchors that have to survive
 * edits a positional path cannot: `#id`, else `data-testid`, else
 * `data-doop-key`, else tag + classes + the first 40 characters of the
 * element's own text. A comment pinned to `.card:nth-of-type(2)` follows the
 * wrong element the moment a sibling is inserted above it; pinned to
 * `section.card[Monthly revenue]` it follows the content.
 *
 * Self-contained for the same reason as `elementPathOf`.
 */
export function elementKeyOf(el: Element): string {
  if (el.id) return `#${el.id}`
  const testid = el.getAttribute('data-testid')
  if (testid) return `[data-testid=${testid}]`
  const key = el.getAttribute('data-doop-key')
  if (key) return `[data-doop-key=${key}]`
  let own = ''
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) own += n.nodeValue || ''
  }
  own = own.replace(/\s+/g, ' ').trim().slice(0, 40)
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).join('.')
  return `${el.localName}${cls ? '.' + cls : ''}[${own}]`
}

/** `elementKeyOf` as an installable script, like `ELEMENT_PATH_SRC`. */
export const ELEMENT_KEY_SRC = `globalThis.doopElementKey = ${elementKeyOf.toString()}`
