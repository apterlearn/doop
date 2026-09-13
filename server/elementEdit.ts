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

/**
 * Move an element under another parent, keeping the node itself: identity
 * (`data-doop-key`, an anchor, a comment's selector) survives a move, where
 * delete + insert mints a new element and drops everything pinned to the old
 * one. The selector and the parent must each match exactly one element, so a
 * move can never land somewhere the caller did not name.
 */
export async function moveElement(
  frame: Frame,
  input: { selector: string; parent_selector: string; position: 'append' | 'prepend' | number },
): Promise<{ html: string }> {
  return withRenderedFrame(frame, async (page) => {
    const outcome = await page.evaluate(
      (args: { selector: string; parentSelector: string; position: 'append' | 'prepend' | number }) => {
        const nodes = Array.from(document.querySelectorAll(args.selector))
        if (nodes.length === 0) return { ok: false as const, reason: 'no_element' as const }
        /* one element moves: two matches would move a node the caller did not
           choose, and a half-applied move cannot be undone */
        if (nodes.length > 1) return { ok: false as const, reason: 'many_elements' as const, count: nodes.length }
        const el = nodes[0]!
        const parents = Array.from(document.querySelectorAll(args.parentSelector))
        if (parents.length === 0) return { ok: false as const, reason: 'no_parent' as const }
        if (parents.length > 1) return { ok: false as const, reason: 'many_parents' as const, count: parents.length }
        const parent = parents[0]!
        /* `el.contains(parent)` is true for the element itself and for every
           descendant: moving a node inside its own subtree detaches the subtree
           from the document and takes the node with it */
        if (el.contains(parent)) return { ok: false as const, reason: 'inside_self' as const }
        if (args.position === 'append') parent.append(el)
        else if (args.position === 'prepend') parent.prepend(el)
        else {
          /* the moved node is not one of the children an index counts: leaving
             it in would place a node moving down inside its own parent one slot
             too early */
          const children = Array.from(parent.children).filter((child) => child !== el)
          const index = Math.max(0, Math.min(args.position, children.length))
          if (index >= children.length) parent.append(el)
          else children[index]!.before(el)
        }
        const doctype = document.doctype ? '<!doctype html>\n' : ''
        return { ok: true as const, html: doctype + document.documentElement.outerHTML }
      },
      { selector: input.selector, parentSelector: input.parent_selector, position: input.position },
    )
    if (!outcome.ok) {
      if (outcome.reason === 'no_element') missing(input.selector)
      if (outcome.reason === 'no_parent') missing(input.parent_selector)
      if (outcome.reason === 'many_elements')
        throw new ElementEditError(
          'invalid_input',
          `“${input.selector}” matches ${outcome.count} elements — nothing was moved; narrow the selector to the one element to move`,
        )
      if (outcome.reason === 'many_parents')
        throw new ElementEditError(
          'invalid_input',
          `“${input.parent_selector}” matches ${outcome.count} elements — nothing was moved; narrow the selector to the one parent`,
        )
      throw new ElementEditError(
        'invalid_input',
        `“${input.parent_selector}” is “${input.selector}” or inside it — a node cannot be moved inside itself; nothing was moved`,
      )
    }
    return { html: outcome.html }
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

/** A frame script is an escape hatch for the one structural change the element
 *  tools cannot express — a bulk renumber, a repeated card rewritten. 20 000
 *  characters is a page of code; beyond that the caller wanted a program, and
 *  a program belongs in the frame's own document. */
const MAX_FRAME_SCRIPT = 20_000

/** A script that never settles must not hold a render open. The page is closed
 *  on the way out, which is what actually stops the work — the race only stops
 *  the wait. */
const FRAME_SCRIPT_TIMEOUT_MS = 5_000

/**
 * The surface a frame script runs against, as the documentation the MCP layer
 * serves verbatim. One definition: the tool's help text and the methods
 * installed below cannot drift apart.
 */
export const FRAME_SCRIPT_API = `# run_frame_script — the doop surface

A script runs inside the rendered frame with a \`doop\` global in scope. Its
return value is discarded; the frame's new HTML is the result.

  doop.$(sel)                  first match, or null
  doop.$$(sel)                 every match, as an array
  doop.set(el, prop, value)    el.style.setProperty(prop, value)
  doop.text(el, s)             replace the element's text
  doop.replace(el, html)       replace the element with parsed HTML
  doop.remove(el)              remove the element
  doop.attrs(el, obj)          set attributes; a null value removes one

Every method does nothing when the element is null or undefined, so a miss is a
no-op rather than a crash.

Limits: the script is at most ${MAX_FRAME_SCRIPT} characters and runs for at
most ${FRAME_SCRIPT_TIMEOUT_MS} ms. It may not add a <script>, <iframe>,
<object>, <embed>, <link>, <meta> or an on* handler. A script edits the frame,
it does not reach the network: fetch, XMLHttpRequest, WebSocket, EventSource
and navigator.sendBeacon throw, and the render refuses private hosts and
non-http schemes at the request layer.`

/** The page-side `doop` surface. Installed as a global before the script runs,
 *  so a script reads like the element API it wraps instead of raw DOM. */
function installDoopSurface(): void {
  const asElement = (value: unknown): Element | null => (value instanceof Element ? value : null)
  const doop = {
    $: (selector: string): Element | null => document.querySelector(selector),
    $$: (selector: string): Element[] => Array.from(document.querySelectorAll(selector)),
    set: (el: unknown, prop: string, value: string): void => {
      const target = asElement(el)
      if (target) (target as HTMLElement).style.setProperty(prop, value)
    },
    text: (el: unknown, value: string): void => {
      const target = asElement(el)
      if (target) target.textContent = value
    },
    replace: (el: unknown, html: string): void => {
      const target = asElement(el)
      if (target) target.replaceWith(document.createRange().createContextualFragment(html))
    },
    remove: (el: unknown): void => {
      asElement(el)?.remove()
    },
    attrs: (el: unknown, attrs: Record<string, string | null>): void => {
      const target = asElement(el)
      if (!target) return
      for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value === null) target.removeAttribute(name)
        else target.setAttribute(name, String(value))
      }
    },
  }
  ;(globalThis as unknown as { doop: typeof doop }).doop = doop
}

/**
 * A frame script edits a document; it has no business on the network. The
 * render already installs the request-layer guard (publicUrl.ts), which refuses
 * private hosts, non-http schemes and websockets — but a public URL is proxied
 * through the server rather than refused, so the reach-out APIs a script would
 * use are replaced for the duration. The error names the API, so a script that
 * tried learns what it did instead of seeing a bare failure.
 */
function blockFrameNetwork(): void {
  const refuse = (api: string) => () => {
    throw new Error(
      `${api} is not available in a frame script — a script edits the frame, it does not reach the network`,
    )
  }
  const scope = globalThis as unknown as Record<string, unknown>
  scope.fetch = refuse('fetch')
  scope.XMLHttpRequest = refuse('XMLHttpRequest')
  scope.WebSocket = refuse('WebSocket')
  scope.EventSource = refuse('EventSource')
  ;(navigator as unknown as { sendBeacon: () => void }).sendBeacon = refuse('navigator.sendBeacon')
}

/**
 * The script as the body of an async IIFE, compiled by the browser's own
 * evaluator. It is source text rather than a function because a rendered frame
 * may carry the imported-snapshot CSP (`script-src 'none'`, server/snapshotCsp.ts),
 * which refuses `new Function` — the expression the inspector compiles is the
 * only way in.
 *
 * The forbidden-markup check is a delta against the document as it arrived. A
 * frame imported from a site already carries <meta> and <link>, and refusing
 * every script for markup it did not write would make the escape hatch
 * unusable on exactly the frames that need it most.
 */
function frameScriptExpression(script: string): string {
  return `(async () => {
  const forbidden = new RegExp(${JSON.stringify(FORBIDDEN_MARKUP.source)}, ${JSON.stringify(`${FORBIDDEN_MARKUP.flags}g`)})
  const before = document.documentElement.outerHTML.match(forbidden) ?? []
  await (async () => {
${script}
  })()
  const html = document.documentElement.outerHTML
  const remaining = [...before]
  const added = []
  for (const hit of html.match(forbidden) ?? []) {
    const at = remaining.indexOf(hit)
    if (at === -1) added.push(hit)
    else remaining.splice(at, 1)
  }
  return { added, html: (document.doctype ? '<!doctype html>\\n' : '') + html }
})()`
}

/**
 * Run a script against the rendered frame and return its new HTML. The escape
 * hatch for the structural edits the element tools cannot express: it sees the
 * same rendered document they do, writes through the same serialization, and is
 * held to the same markup rules, so a scripted edit is an edit like any other
 * rather than a second write path.
 */
export async function runFrameScript(
  frame: Frame,
  script: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ html: string }> {
  if (script.length > MAX_FRAME_SCRIPT)
    throw new ElementEditError(
      'invalid_input',
      `script is ${script.length} characters; the limit is ${MAX_FRAME_SCRIPT}. A frame script is for one structural change — do the rest with the element tools, or split the work into several scripts.`,
    )
  const timeoutMs = opts.timeoutMs ?? FRAME_SCRIPT_TIMEOUT_MS
  return withRenderedFrame(frame, async (page) => {
    await page.evaluate(installDoopSurface)
    await page.evaluate(blockFrameNetwork)
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      /* both branches settle, so a script that rejects after the clock ran out
         is a value here rather than an unhandled rejection */
      const outcome = await Promise.race([
        page.evaluate(frameScriptExpression(script)).then(
          (value) => value as { added: string[]; html: string },
          (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        ),
        expired,
      ])
      if (outcome === 'timeout')
        throw new ElementEditError(
          'invalid_input',
          `the script did not finish within ${timeoutMs} ms — nothing was saved; the frame is closed, so a script cannot outlive the call`,
        )
      if (outcome instanceof Error) throw new ElementEditError('invalid_input', `the script failed: ${outcome.message}`)
      if (outcome.added.length)
        throw new ElementEditError(
          'invalid_input',
          `the script added “${outcome.added[0]}” — a frame script may not add <script>, <iframe>, <object>, <embed>, <link>, <meta> or an on* handler`,
        )
      return { html: outcome.html }
    } finally {
      clearTimeout(timer)
    }
  })
}
