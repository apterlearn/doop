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
  /** replace one occurrence of `old_str` inside the element's own text, leaving
   *  its child elements alone. `html: true` inserts inline markup instead of
   *  the literal characters. */
  text_replace?: { old_str: string; new_str: string; html?: boolean }
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
  /** true when `text` was clipped at 400 characters — pass `full_text` to read
   *  all of it. Absent when the text fitted. */
  text_truncated?: boolean
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
  /** codes the MCP surface already speaks: `too_large` is how an oversize
   *  document is refused, and a caller branches on it like any other */
  readonly code: 'not_found' | 'invalid_input' | 'too_large'

  constructor(code: 'not_found' | 'invalid_input' | 'too_large', message: string) {
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
export async function getElement(
  frame: Frame,
  selector: string,
  opts: { full_text?: boolean } = {},
): Promise<ElementSnapshot> {
  return withRenderedFrame(frame, async (page) => {
    const result = await page.evaluate(
      (args: { selector: string; fullText: boolean }) => {
        const nodes = document.querySelectorAll(args.selector)
        if (nodes.length === 0) return null
        const el = nodes[0] as HTMLElement
        const style = getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        const attrs: Record<string, string> = {}
        for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value
        /* the whole text, before clipping: a caller that does not ask for it
           still learns that what it got is a prefix */
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
        return {
          selector: args.selector,
          key: (globalThis as unknown as { doopElementKey: (el: Element) => string }).doopElementKey(el),
          matched: nodes.length,
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: Array.from(el.classList),
          text: args.fullText ? text : text.slice(0, 400),
          ...(args.fullText || text.length <= 400 ? {} : { text_truncated: true }),
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
      },
      { selector, fullText: opts.full_text === true },
    )
    if (!result) missing(selector)
    return result as ElementSnapshot
  })
}

/** Markup an agent may insert. Scripts and event handlers are refused: an
 *  inserted script would run inside every viewer's frame, which is not a
 *  design change. */
const FORBIDDEN_MARKUP = /<\s*(script|iframe|object|embed|link|meta)\b|\son[a-z]+\s*=/i

/** Inline tags `text_replace` may insert when `html: true`. Inline-only on
 *  purpose: a partial text edit is not the place to add a section, and a tag
 *  outside this list is a mistake worth refusing rather than guessing at. */
const TEXT_MARKUP_TAGS = ['strong', 'em', 'b', 'i', 'u', 's', 'br', 'span', 'a', 'small', 'sup', 'sub', 'mark']

/**
 * Apply style/attribute/text edits to elements and return the frame's new
 * HTML. Resolves every selector before changing anything, so a call with one
 * bad selector changes nothing.
 */
export async function updateElements(frame: Frame, edits: ElementStyleEdit[]): Promise<UpdateElementsResult> {
  return withRenderedFrame(frame, async (page) => {
    const outcome = await page.evaluate(
      (args: { edits: ElementStyleEdit[]; allowedTags: string[]; forbidden: string; forbiddenFlags: string }) => {
        /* the module's own markup rules travel into the page, so the check and
           the insertion agree on what a tag is */
        const forbiddenMarkup = new RegExp(args.forbidden, args.forbiddenFlags)
        const counts: number[] = []
        const ambiguous: string[] = []
        const absent: string[] = []
        const textMissing: Array<{ selector: string; oldStr: string }> = []
        const textAmbiguous: Array<{ selector: string; oldStr: string; count: number }> = []
        const invalid: string[] = []
        const resolved: HTMLElement[][] = []
        /* the fragment the allowlist is checked against is the one that gets
           inserted: validating a re-parse would check a different document */
        const parseMarkup = (markup: string): DocumentFragment | string => {
          if (forbiddenMarkup.test(markup))
            return 'text_replace markup may not contain <script>, <iframe>, <object>, <embed>, <link>, <meta> or an on* handler'
          const fragment = document.createRange().createContextualFragment(markup)
          for (const el of Array.from(fragment.querySelectorAll('*'))) {
            const tag = el.tagName.toLowerCase()
            if (!args.allowedTags.includes(tag))
              return `“<${tag}>” is not inline markup text_replace may insert — allowed: ${args.allowedTags.join(', ')}`
            if (tag === 'a') {
              const href = el.getAttribute('href') ?? ''
              if (!/^(https?:|\/|#|mailto:)/i.test(href))
                return `an <a> inserted by text_replace needs an href starting with http, /, # or mailto: (got “${href}”)`
            }
          }
          return fragment
        }
        const targets: Array<Array<Text | undefined>> = []
        const fragments: Array<Array<DocumentFragment | undefined>> = []
        for (const edit of args.edits) {
          const nodes = Array.from(document.querySelectorAll(edit.selector)) as HTMLElement[]
          if (nodes.length === 0) absent.push(edit.selector)
          else if (nodes.length > 1) ambiguous.push(edit.selector)
          resolved.push(nodes)
          const editTargets: Array<Text | undefined> = []
          const editFragments: Array<DocumentFragment | undefined> = []
          targets.push(editTargets)
          fragments.push(editFragments)
          const replacement = edit.text_replace
          if (!replacement) continue
          if (!replacement.old_str) {
            invalid.push('text_replace.old_str is empty — pass the text to replace')
            continue
          }
          for (const [position, el] of nodes.entries()) {
            /* the element's own text, not its children's: rewriting a child
               from a parent's edit would change markup nobody named */
            const texts = Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE) as Text[]
            const count = texts.reduce((sum, node) => sum + (node.data.split(replacement.old_str).length - 1), 0)
            if (count === 0) {
              textMissing.push({ selector: edit.selector, oldStr: replacement.old_str })
              continue
            }
            if (count > 1) {
              textAmbiguous.push({ selector: edit.selector, oldStr: replacement.old_str, count })
              continue
            }
            const target = texts.find((node) => node.data.includes(replacement.old_str))
            if (!target) continue
            if (!replacement.html) {
              editTargets[position] = target
              continue
            }
            const parsed = parseMarkup(replacement.new_str)
            if (typeof parsed === 'string') {
              invalid.push(parsed)
              continue
            }
            editTargets[position] = target
            editFragments[position] = parsed
          }
        }
        /* nothing is touched when a selector does not resolve, or when a text
           replacement cannot be applied exactly once: a partial application is
           worse than a refusal, because the agent cannot see which half landed */
        if (absent.length || textMissing.length || textAmbiguous.length || invalid.length)
          return {
            absent,
            textMissing,
            textAmbiguous,
            invalid,
            html: null,
            counts: [],
            ambiguous: [],
          }
        /* the nodes are the ones the validation pass resolved: re-querying here
           would run against a document earlier edits have already changed, so an
           edit the batch itself invalidated would apply to nothing (or to nodes
           no one validated) while the call still reported success */
        for (const [index, edit] of args.edits.entries()) {
          const nodes = resolved[index]!
          for (const [position, el] of nodes.entries()) {
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
            const replacement = edit.text_replace
            const target = replacement ? targets[index]?.[position] : undefined
            if (replacement && target) {
              const at = target.data.indexOf(replacement.old_str)
              const before = target.data.slice(0, at)
              const after = target.data.slice(at + replacement.old_str.length)
              const fragment = fragments[index]?.[position]
              /* the validated fragment, not the raw string: inserting the
                 string would show its tags to every viewer */
              if (fragment) target.replaceWith(before, fragment, after)
              else target.data = before + replacement.new_str + after
            }
          }
          counts.push(nodes.length)
        }
        const doctype = document.doctype ? '<!doctype html>\n' : ''
        return {
          absent: [],
          textMissing: [],
          textAmbiguous: [],
          invalid: [],
          html: doctype + document.documentElement.outerHTML,
          counts,
          ambiguous,
        }
      },
      {
        edits,
        allowedTags: TEXT_MARKUP_TAGS,
        forbidden: FORBIDDEN_MARKUP.source,
        forbiddenFlags: FORBIDDEN_MARKUP.flags,
      },
    )
    if (outcome.absent.length) missing(outcome.absent[0]!)
    if (outcome.textMissing.length) {
      const miss = outcome.textMissing[0]!
      throw new ElementEditError(
        'not_found',
        `no text under “${miss.selector}” contains “${miss.oldStr}” — nothing was changed; read the element's current text with get_element`,
      )
    }
    if (outcome.textAmbiguous.length) {
      const clash = outcome.textAmbiguous[0]!
      throw new ElementEditError(
        'invalid_input',
        `“${clash.oldStr}” occurs ${clash.count} times under “${clash.selector}” — nothing was changed; include more surrounding text in old_str so it matches exactly once`,
      )
    }
    if (outcome.invalid.length) throw new ElementEditError('invalid_input', outcome.invalid[0]!)
    return {
      html: outcome.html!,
      applied: outcome.counts.reduce((sum, n) => sum + n, 0),
      ambiguous: outcome.ambiguous,
      counts: outcome.counts,
    }
  })
}

/** The stylesheet block a frame's own CSS lives in. One block per frame:
 *  replacing the same element is what makes a second call an edit instead of a
 *  pile of rules that fight each other in source order. */
const CSS_STYLE_SELECTOR = 'style[data-doop-css]'

/** A frame stylesheet is media queries, states and transitions — a few KB.
 *  100 KB is a document, and every read of the frame would carry it. */
const MAX_FRAME_CSS = 100_000

/**
 * Write the frame's own stylesheet: the only place responsive rules,
 * interaction states and motion can live. Inline styles cannot express any of
 * the three, so without this an agent can only author the desktop resting
 * state. Returns the frame's new HTML, like every other edit here.
 */
export async function setFrameCss(frame: Frame, css: string): Promise<{ html: string }> {
  if (css.length > MAX_FRAME_CSS)
    throw new ElementEditError(
      'too_large',
      `css is ${css.length} characters; the limit is ${MAX_FRAME_CSS}. Keep only the rules this frame needs.`,
    )
  if (/@import/i.test(css))
    throw new ElementEditError(
      'invalid_input',
      '@import is refused — a frame stylesheet must not fetch anything external, because every viewer renders this document',
    )
  return withRenderedFrame(frame, async (page) => ({
    html: await page.evaluate(
      (args: { selector: string; css: string }) => {
        let block = document.querySelector(args.selector)
        if (!block) {
          block = document.createElement('style')
          block.setAttribute('data-doop-css', '')
          document.head.append(block)
        }
        block.textContent = args.css
        const doctype = document.doctype ? '<!doctype html>\n' : ''
        return doctype + document.documentElement.outerHTML
      },
      { selector: CSS_STYLE_SELECTOR, css },
    ),
  }))
}

/** Read back the frame's own stylesheet; empty when it has none. */
export async function getFrameCss(frame: Frame): Promise<{ css: string }> {
  return withRenderedFrame(frame, async (page) => ({
    css: await page.evaluate(
      (selector: string) => document.querySelector(selector)?.textContent ?? '',
      CSS_STYLE_SELECTOR,
    ),
  }))
}

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
