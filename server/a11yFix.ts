/**
 * The mechanical share of the a11y and content findings.
 *
 * The review gate blocks on a handful of findings that are a one-line repair —
 * a document with no language, a frame with no title, controls with no hover or
 * focus rule — and until now the only fixer that existed was
 * `fix_frame_tokens`, for palette drift. This is the same shape of thing for
 * the accessibility and content rules: pure over the frame's HTML string, so a
 * caller can rehearse it with `dry_run` and then apply the result through the
 * normal frame write.
 *
 * Only the repairs that need no judgement live here. Alt text, form labels,
 * contrast, tap targets, heading order and landmarks each encode a decision
 * about content or layout, so they come back in `skipped` with the decision
 * named rather than guessed at. A finding whose repair is already in place is
 * neither applied nor skipped: nothing to do is not the same as nothing that
 * could be done, and the second pass over a fixed frame has to stay quiet for
 * the fixer to be re-runnable.
 */

export interface A11yFixPlan {
  fixedHtml: string | null
  applied: string[]
  skipped: { rule: string; reason: string }[]
}

/** The document language, from `server/a11y.ts`. */
const LANG_RULE = 'html_lang'
/** The missing title, from `server/contentLint.ts`: the content lint owns the
 *  rule and calls it `no_title`. */
const TITLE_RULE = 'no_title'
/** A control with no hover or focus rule, from `server/contentLint.ts`. */
const STATE_RULE = 'missing_state'

/** The state rules a control needs to not read as inert. An outline follows
 *  the element's own text colour, so it is visible on any background and fights
 *  nothing in the design. */
const STATE_DECLARATIONS = '  outline: 2px solid currentColor;\n  outline-offset: 2px;'
/** Marks the rules this module wrote, so a human reading the frame's CSS knows
 *  where they came from. */
const STATE_MARKER = '/* interaction states (a11y fixer) */'

/** The stylesheet block a frame's own CSS lives in — the element
 *  `set_frame_css` writes (`server/elementEdit.ts`). */
const FRAME_STYLE_RE = /<style\s+data-doop-css[^>]*>[\s\S]*?<\/style\s*>/i
const STYLE_TAG_RE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi
/** The injected token block is generated CSS with no state rules of its own;
 *  the probe skips it and so does the state check. */
const TOKEN_BLOCK_RE = /data-doop-tokens/i
const HTML_TAG_RE = /<html\b[^>]*>/i
const LANG_ATTR_RE = /\slang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const HEAD_END_RE = /<\/head\s*>/i
const BODY_TAG_RE = /<body\b[^>]*>/i
const TITLE_RE = /<title\b([^>]*)>([\s\S]*?)<\/title\s*>/i

/**
 * Why each remaining rule is left alone, in the words of the decision it needs.
 * A rule with no entry here has no mechanical repair either, and says so.
 */
const JUDGEMENT: Record<string, string> = {
  /* server/a11y.ts */
  contrast: 'contrast needs a palette decision',
  missing_alt: "alt text needs the image's meaning",
  heading_order: 'heading order needs an outline decision',
  focus_order: 'focus order needs a document-order decision',
  tap_target: 'tap targets need a layout decision',
  missing_main: 'landmarks need a structure decision',
  unlabeled_nav: 'landmarks need a structure decision',
  form_label: "form labels need the field's purpose",
  /* server/contentLint.ts */
  placeholder_text: 'placeholder copy needs the real content',
  placeholder_image: 'a stand-in image needs a real asset',
  broken_image: 'a broken image needs a real asset or a removal decision',
  no_meta_description: 'the meta description needs a sentence about the page',
  dead_zone: 'the empty area needs a layout decision',
  contrast_unverified: 'contrast over an image needs a palette decision',
  motion_no_reduced_motion: 'motion needs a design decision — keep it, or turn it off',
  motion_long_duration: 'motion duration is a design decision',
  motion_infinite_animation: 'an iteration count is a design decision',
}

/** Frame names are authored text, so they may carry markup characters. */
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The selectors that still need each state, judged against the frame's own CSS
 * text the way the content lint judges it. A selector the frame already styles
 * on hover is not one to write a rule for again: the fix has to be idempotent.
 */
function missingStates(css: string, selectors: string[]): { hover: string[]; focus: string[] } {
  const hover: string[] = []
  const focus: string[] = []
  for (const selector of selectors) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`${escaped}\\s*:hover\\b`).test(css)) hover.push(selector)
    if (!new RegExp(`${escaped}\\s*:focus-visible\\b`).test(css)) focus.push(selector)
  }
  return { hover, focus }
}

/**
 * Put a block in the document head. A frame is a real page, so `</head>` is
 * where it goes; a headless document gets one where the head would have been,
 * and a document that is only a fragment has nowhere to put it — the caller
 * reports that rather than writing markup the frame cannot use.
 */
function insertIntoHead(html: string, block: string): string | null {
  const headEnd = HEAD_END_RE.exec(html)
  if (headEnd) return html.slice(0, headEnd.index) + block + html.slice(headEnd.index)
  const body = BODY_TAG_RE.exec(html)
  if (body) return html.slice(0, body.index) + `<head>${block}</head>` + html.slice(body.index)
  const root = HTML_TAG_RE.exec(html)
  if (root) {
    const end = root.index + root[0].length
    return html.slice(0, end) + `<head>${block}</head>` + html.slice(end)
  }
  return null
}

/** Append to the frame's own stylesheet block, or add one in the head. */
function appendFrameCss(html: string, css: string): string | null {
  const block = FRAME_STYLE_RE.exec(html)
  if (block) {
    const text = block[0]
    const closeAt = text.toLowerCase().lastIndexOf('</style')
    const open = text.slice(0, closeAt)
    const separator = open.endsWith('\n') || open.endsWith('>') ? '' : '\n'
    return html.slice(0, block.index) + open + separator + css + html.slice(block.index + closeAt)
  }
  return insertIntoHead(html, `<style data-doop-css>\n${css}</style>\n`)
}

/**
 * Turn a11y and content findings into the edits that settle them without a
 * judgement call. Pure over the frame's HTML: it renders nothing, reads
 * nothing and invents nothing, so the same frame and findings always produce
 * the same plan, and running it again on its own output applies nothing.
 */
export function planA11yFixes(
  frameHtml: string,
  frameName: string,
  findings: { rule: string; selector?: string }[],
): A11yFixPlan {
  const applied: string[] = []
  const skipped: { rule: string; reason: string }[] = []
  const reported = new Set<string>()
  const skip = (rule: string, reason: string) => {
    const key = `${rule}\u0000${reason}`
    if (reported.has(key)) return
    reported.add(key)
    skipped.push({ rule, reason })
  }
  const wanted = (rule: string) => findings.some((finding) => finding.rule === rule)
  let html = frameHtml

  /* ---- the document language ---- */
  if (wanted(LANG_RULE)) {
    const tag = HTML_TAG_RE.exec(html)
    if (!tag) {
      skip(LANG_RULE, 'the frame has no <html> element to carry the language')
    } else {
      const attr = tag[0].match(LANG_ATTR_RE)
      const value = (attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? '').trim()
      if (!value) {
        /* an attribute with no value is the same finding as no attribute: the
           probe reads the resolved lang, not the attribute's presence */
        const fixed = attr ? tag[0].replace(LANG_ATTR_RE, ' lang="en"') : tag[0].replace(/^<html/i, '<html lang="en"')
        html = html.slice(0, tag.index) + fixed + html.slice(tag.index + tag[0].length)
        applied.push('html_lang: added lang="en" to <html>')
      }
    }
  }

  /* ---- the document title ---- */
  if (wanted(TITLE_RULE)) {
    const title = TITLE_RE.exec(html)
    if (title) {
      /* an empty <title> is the same finding as no <title>: the page still has
         no name, and the frame name is the one the author already chose */
      if (!title[2]!.trim()) {
        const fixed = `<title${title[1] ?? ''}>${escapeText(frameName)}</title>`
        html = html.slice(0, title.index) + fixed + html.slice(title.index + title[0].length)
        applied.push(`no_title: filled the empty <title> with ${escapeText(frameName)}`)
      }
    } else {
      const name = escapeText(frameName)
      const withTitle = insertIntoHead(html, `<title>${name}</title>`)
      if (withTitle) {
        html = withTitle
        applied.push(`no_title: added <title>${name}</title>`)
      } else {
        skip(TITLE_RULE, 'the frame has no <head> or <body> to hold a <title>')
      }
    }
  }

  /* ---- interaction states ---- */
  if (wanted(STATE_RULE)) {
    const selectors: string[] = []
    for (const finding of findings) {
      if (finding.rule !== STATE_RULE || !finding.selector) continue
      if (!selectors.includes(finding.selector)) selectors.push(finding.selector)
    }
    if (selectors.length > 0) {
      /* the same stylesheet text the probe reads, minus the injected tokens */
      const css = (html.match(STYLE_TAG_RE) ?? []).filter((block) => !TOKEN_BLOCK_RE.test(block)).join('\n')
      const { hover, focus } = missingStates(css, selectors)
      if (hover.length || focus.length) {
        const rules: string[] = []
        if (hover.length)
          rules.push(`${hover.map((selector) => `${selector}:hover`).join(',\n')} {\n${STATE_DECLARATIONS}\n}`)
        if (focus.length)
          rules.push(`${focus.map((selector) => `${selector}:focus-visible`).join(',\n')} {\n${STATE_DECLARATIONS}\n}`)
        const withCss = appendFrameCss(html, `${STATE_MARKER}\n${rules.join('\n')}\n`)
        if (withCss) {
          html = withCss
          const touched = [...new Set([...hover, ...focus])]
          const states = [...(hover.length ? [':hover'] : []), ...(focus.length ? [':focus-visible'] : [])]
          applied.push(`missing_state: added ${states.join(' and ')} rules for ${touched.join(', ')}`)
        } else {
          skip(STATE_RULE, 'the frame has no <head>, <body> or stylesheet to hold the state rules')
        }
      }
    }
    if (findings.some((finding) => finding.rule === STATE_RULE && !finding.selector))
      skip(STATE_RULE, 'the finding names no element to give a state rule')
  }

  /* ---- what is left is a judgement call ---- */
  for (const finding of findings) {
    if (finding.rule === LANG_RULE || finding.rule === TITLE_RULE || finding.rule === STATE_RULE) continue
    skip(finding.rule, JUDGEMENT[finding.rule] ?? 'no mechanical fix for this rule')
  }

  return { fixedHtml: applied.length > 0 ? html : null, applied, skipped }
}
