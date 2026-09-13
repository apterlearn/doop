import type { Frame } from '../shared/types.ts'
import { ELEMENT_KEY_SRC, ELEMENT_PATH_SRC } from '../shared/selector.ts'
import { loadFramePage } from './screenshot.ts'
import type { Page } from 'puppeteer-core'

/**
 * Element-level editing: read one element, patch properties on elements, and
 * insert or remove subtrees.
 *
 * Every operation works on the rendered document in one page load, then
 * serializes the whole document back — the same contract the browser's own
 * element editor uses (frameRuntime `applyStyle` → `postEdited` → save), so an
 * agent's element edit and a human's produce the same kind of write. The
 * alternative, hand-editing the HTML string, is what makes agents produce
 * near-miss markup: they cannot see the cascade, so they guess.
 *
 * One render per call, whatever the number of edits: `update_elements` batches
 * up to 20 into a single page load, which is the only way a multi-element
 * change stays inside the render budget.
 */

export interface ElementStyleEdit {
  selector: string
  /** CSS declarations; a null value removes the property */
  style?: Record<string, string | null>
  /** attributes; a null value removes the attribute */
  attrs?: Record<string, string | null>
  /** replace the element's text */
  text?: string
}

export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementSnapshot {
  selector: string
  /** content key: what an anchor or a follow-up edit falls back to when the
   *  positional selector goes stale (shared/selector.ts) */
  key: string
  matched: number
  tag: string
  id?: string
  classes: string[]
  text: string
  attrs: Record<string, string>
  inline_style: string
  computed: {
    box: ElementBox
    display: string
    position: string
    color: string
    background: string
    font: string
    fontSize: string
    fontWeight: string
    lineHeight: string
    letterSpacing: string
    textAlign: string
    borderRadius: string
    margin: string
    padding: string
    gap: string
    overflow: string
    opacity: string
    zIndex: string
  }
  outerHTML: string
}

export interface UpdateElementsResult {
  html: string
  applied: number
  /** selectors that matched more than one element and were applied to all */
  ambiguous: string[]
  /** per-edit count of elements changed, in the order the edits were given */
  counts: number[]
}

export class ElementEditError extends Error {
  readonly code: 'not_found' | 'invalid_input'

  constructor(code: 'not_found' | 'invalid_input', message: string) {
    super(message)
    this.name = 'ElementEditError'
    this.code = code
  }
}

/** Bound a selector that matches nothing, naming it for the caller. */
function missing(selector: string): never {
  throw new ElementEditError(
    'not_found',
    `no element matches “${selector}” — call get_element or inspect_frame to find the current selector`,
  )
}

/**
 * Load the frame once, run `body` against that page, and hand back whatever it
 * returns. The shared selector algorithm is installed first, so in-page code
 * names elements exactly the way the panel and the server do.
 */
async function withRenderedFrame<T>(
  frame: Frame,
  body: (page: Page) => Promise<T>,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<T> {
  const loaded = await loadFramePage(frame, opts)
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. */
    await loaded.page.evaluate('globalThis.__name = (target) => target')
    await loaded.page.evaluate(ELEMENT_PATH_SRC)
    await loaded.page.evaluate(ELEMENT_KEY_SRC)
    return await body(loaded.page)
  } finally {
    await loaded.close()
  }
}

/** Read one element: the same computed view the human element panel shows. */
export async function getElement(frame: Frame, selector: string): Promise<ElementSnapshot> {
  return withRenderedFrame(frame, async (page) => {
    const result = await page.evaluate((sel: string) => {
      const nodes = document.querySelectorAll(sel)
      if (nodes.length === 0) return null
      const el = nodes[0] as HTMLElement
      const style = getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      const attrs: Record<string, string> = {}
      for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value
      return {
        selector: sel,
        key: (globalThis as unknown as { doopElementKey: (el: Element) => string }).doopElementKey(el),
        matched: nodes.length,
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: Array.from(el.classList),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        attrs,
        inline_style: el.getAttribute('style') ?? '',
        computed: {
          box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          display: style.display,
          position: style.position,
          color: style.color,
          background: style.backgroundColor,
          font: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          textAlign: style.textAlign,
          borderRadius: style.borderRadius,
          margin: style.margin,
          padding: style.padding,
          gap: style.gap,
          overflow: style.overflow,
          opacity: style.opacity,
          zIndex: style.zIndex,
        },
        outerHTML: (el.outerHTML || '').slice(0, 4000),
      }
    }, selector)
    if (!result) missing(selector)
    return result as ElementSnapshot
  })
}

/**
 * Apply style/attribute/text edits to elements and return the frame's new
 * HTML. Resolves every selector before changing anything, so a call with one
 * bad selector changes nothing.
 */
export async function updateElements(frame: Frame, edits: ElementStyleEdit[]): Promise<UpdateElementsResult> {
  return withRenderedFrame(frame, async (page) => {
    const outcome = await page.evaluate((input: ElementStyleEdit[]) => {
      const counts: number[] = []
      const ambiguous: string[] = []
      const absent: string[] = []
      const resolved: HTMLElement[][] = []
      for (const edit of input) {
        const nodes = Array.from(document.querySelectorAll(edit.selector)) as HTMLElement[]
        if (nodes.length === 0) absent.push(edit.selector)
        else if (nodes.length > 1) ambiguous.push(edit.selector)
        resolved.push(nodes)
      }
      /* nothing is touched when a selector does not resolve: a partial
         application is worse than a refusal, because the agent cannot see
         which half landed */
      if (absent.length) return { absent, html: null, counts: [], ambiguous: [] }
      /* the nodes are the ones the validation pass resolved: re-querying here
         would run against a document earlier edits have already changed, so an
         edit the batch itself invalidated would apply to nothing (or to nodes
         no one validated) while the call still reported success */
      for (const [index, edit] of input.entries()) {
        const nodes = resolved[index]!
        for (const el of nodes) {
          if (edit.style) {
            for (const [prop, value] of Object.entries(edit.style)) {
              if (value === null) el.style.removeProperty(prop)
              else el.style.setProperty(prop, value)
            }
          }
          if (edit.attrs) {
            for (const [name, value] of Object.entries(edit.attrs)) {
              if (value === null) el.removeAttribute(name)
              else el.setAttribute(name, value)
            }
          }
          if (edit.text !== undefined) el.textContent = edit.text
        }
        counts.push(nodes.length)
      }
      const doctype = document.doctype ? '<!doctype html>\n' : ''
      return { absent: [], html: doctype + document.documentElement.outerHTML, counts, ambiguous }
    }, edits)
    if (outcome.absent.length) missing(outcome.absent[0]!)
    return {
      html: outcome.html!,
      applied: outcome.counts.reduce((sum, n) => sum + n, 0),
      ambiguous: outcome.ambiguous,
      counts: outcome.counts,
    }
  })
}

/** Markup an agent may insert. Scripts and event handlers are refused: an
 *  inserted script would run inside every viewer's frame, which is not a
 *  design change. */
const FORBIDDEN_MARKUP = /<\s*(script|iframe|object|embed|link|meta)\b|\son[a-z]+\s*=/i

export async function insertElement(
  frame: Frame,
  input: { parent_selector: string; position: 'append' | 'prepend' | number; html: string },
): Promise<{ html: string; selector: string }> {
  if (FORBIDDEN_MARKUP.test(input.html))
    throw new ElementEditError(
      'invalid_input',
      'inserted markup may not contain <script>, <iframe>, <object>, <embed>, <link>, <meta> or an on* handler',
    )
  return withRenderedFrame(frame, async (page) => {
    {
      const outcome = await page.evaluate(
        (args: { parentSelector: string; position: 'append' | 'prepend' | number; html: string }) => {
          const parent = document.querySelector(args.parentSelector)
          if (!parent) return { absent: true as const }
          const fragment = document.createRange().createContextualFragment(args.html)
          const first = fragment.firstElementChild
          if (args.position === 'append') parent.append(fragment)
          else if (args.position === 'prepend') parent.prepend(fragment)
          else {
            const children = Array.from(parent.children)
            const index = Math.max(0, Math.min(args.position, children.length))
            if (index >= children.length) parent.append(fragment)
            else children[index]!.before(fragment)
          }
          const doctype = document.doctype ? '<!doctype html>\n' : ''
          return {
            absent: false as const,
            html: doctype + document.documentElement.outerHTML,
            selector: first
              ? (globalThis as unknown as { doopElementPath: (el: Element) => string }).doopElementPath(first)
              : args.parentSelector,
          }
        },
        { parentSelector: input.parent_selector, position: input.position, html: input.html },
      )
      if (outcome.absent) missing(input.parent_selector)
      return { html: outcome.html!, selector: outcome.selector! }
    }
  })
}

export async function deleteElement(frame: Frame, selector: string): Promise<{ html: string }> {
  return withRenderedFrame(frame, async (page) => {
    {
      const outcome = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return { absent: true as const }
        const tag = el.tagName.toLowerCase()
        /* the document's own root is not an element an agent may remove: the
           frame would stop rendering at all */
        if (tag === 'html' || tag === 'body') return { root: true as const }
        el.remove()
        const doctype = document.doctype ? '<!doctype html>\n' : ''
        return { absent: false as const, root: false as const, html: doctype + document.documentElement.outerHTML }
      }, selector)
      if (outcome.absent) missing(selector)
      if (outcome.root)
        throw new ElementEditError(
          'invalid_input',
          'an agent may not delete <html> or <body> — rewrite the frame instead',
        )
      return { html: outcome.html! }
    }
  })
}
