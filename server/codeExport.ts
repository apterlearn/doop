import type { DesignTokens, Frame } from '../shared/types.ts'
import { loadFramePage } from './screenshot.ts'
import { cssForTokens } from './designLint.ts'

/**
 * Design → code handoff.
 *
 * The workflow otherwise ends in a PNG, which means the HTML/CSS an agent
 * authored is thrown away and a human re-types it. Both exports parse through
 * the browser — the same rationale `cssPrune` states for using Chromium as the
 * CSS parser: a regex over HTML/CSS is wrong in exactly the cases that matter
 * (entities, nested rules, media queries, void elements), and the browser is
 * already a dependency.
 */

export interface ReactExport {
  component_name: string
  jsx: string
  /** the frame's own <style> blocks, concatenated */
  css: string
  /** the canvas tokens as a :root block, when the canvas has any */
  tokens_css: string
  notes: string[]
}

/** `Hero — pricing / v2` -> `HeroPricingV2`; a leading digit gets `Frame`. */
export function componentName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join('')
  if (!cleaned) return 'Frame'
  return /^[0-9]/.test(cleaned) ? `Frame${cleaned}` : cleaned
}

/* ------------------------------------------------------------------ */
/* Tokens as portable code                                             */

/** The tokens as a Tailwind v4 `@theme` block. Same naming as
 *  `cssForTokens` (designLint.ts), the one other place a token becomes a
 *  custom property, except spacing, which Tailwind namespaces `--spacing-*`
 *  where the paste-into-a-frame block uses `--space-*`. */
export function tailwindThemeCss(tokens: DesignTokens): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(tokens.colors ?? {})) lines.push(`  --color-${name}: ${value.trim()};`)
  for (const [key, value] of Object.entries(tokens.fonts ?? {}))
    if (value) lines.push(`  --font-${key}: ${value.trim()};`)
  for (const value of tokens.spacing ?? []) lines.push(`  --spacing-${value}: ${value}px;`)
  for (const value of tokens.radii ?? []) lines.push(`  --radius-${value}: ${value}px;`)
  for (const [index, value] of (tokens.shadows ?? []).entries()) lines.push(`  --shadow-${index + 1}: ${value.trim()};`)
  return `@theme {\n${lines.join('\n')}\n}`
}

/** The tokens verbatim, pretty-printed — the machine-readable form the CSS
 *  exports are derived from. */
export function tokensJson(tokens: DesignTokens): string {
  return JSON.stringify(tokens, null, 2)
}

interface Extracted {
  css: string
  jsx: string
  notes: string[]
}

/** Walk the rendered body and emit JSX, hoisting <style> into `css`. */
async function extract(frame: Frame): Promise<Extracted> {
  const loaded = await loadFramePage(frame)
  const { page } = loaded
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. */
    await page.evaluate('globalThis.__name = (target) => target')
    return (await page.evaluate(() => {
      const VOID_TAGS = new Set([
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'source',
        'track',
        'wbr',
      ])
      const CAMEL: Record<string, string> = {
        class: 'className',
        for: 'htmlFor',
        tabindex: 'tabIndex',
        readonly: 'readOnly',
        maxlength: 'maxLength',
        minlength: 'minLength',
        autocomplete: 'autoComplete',
        autofocus: 'autoFocus',
        colspan: 'colSpan',
        rowspan: 'rowSpan',
        contenteditable: 'contentEditable',
        crossorigin: 'crossOrigin',
        srcset: 'srcSet',
        enctype: 'encType',
        novalidate: 'noValidate',
        spellcheck: 'spellCheck',
        usemap: 'useMap',
        datetime: 'dateTime',
        accesskey: 'accessKey',
      }
      const SVG_KEEP = new Set([
        'stroke-width',
        'stroke-linecap',
        'stroke-linejoin',
        'fill-rule',
        'clip-rule',
        'stroke-dasharray',
        'stroke-dashoffset',
        'stop-color',
        'stop-opacity',
        'text-anchor',
        'dominant-baseline',
        'xmlns:xlink',
      ])
      const notes: string[] = []

      /** JSX text: braces and angle brackets are syntax there. */
      const text = (value: string) => value.replace(/[{}<>]/g, (c) => `{'${c}'}`)

      /** `background-color: red` -> `backgroundColor: 'red'` */
      const styleToJsx = (raw: string): string | undefined => {
        const pairs: string[] = []
        for (const declaration of raw.split(';')) {
          const colon = declaration.indexOf(':')
          if (colon < 0) continue
          const property = declaration.slice(0, colon).trim()
          const value = declaration.slice(colon + 1).trim()
          if (!property || !value) continue
          if (property.startsWith('--')) {
            /* custom properties are not camelCased and must be quoted */
            pairs.push(`'${property}': '${value.replace(/'/g, "\\'")}'`)
            continue
          }
          const camel = property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
          pairs.push(`${camel}: '${value.replace(/'/g, "\\'")}'`)
        }
        /* JSX wants an object literal here, hence the doubled braces */
        return pairs.length ? `{{ ${pairs.join(', ')} }}` : undefined
      }

      const attributes = (el: Element): string => {
        let out = ''
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name
          if (name === 'style' && !el.getAttribute('style')?.trim()) continue
          if (name.startsWith('data-') || name.startsWith('aria-')) {
            out += ` ${name}="${attr.value.replace(/"/g, '&quot;')}"`
            continue
          }
          if (name === 'style') {
            const style = styleToJsx(attr.value)
            if (style) out += ` style=${style}`
            else notes.push('an inline style attribute could not be parsed and was dropped')
            continue
          }
          const jsxName =
            CAMEL[name] ?? (SVG_KEEP.has(name) ? name : name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()))
          if (jsxName === 'value' || jsxName === 'checked' || jsxName === 'selected' || jsxName === 'disabled') {
            /* boolean/controlled attributes are left as strings so the export
               renders identically without a React state model */
            out += ` ${jsxName}="${attr.value.replace(/"/g, '&quot;')}"`
            continue
          }
          out += ` ${jsxName}="${attr.value.replace(/"/g, '&quot;')}"`
        }
        return out
      }

      const render = (node: Node, depth: number): string => {
        if (node.nodeType === 3) {
          const value = node.nodeValue ?? ''
          return value.trim() ? text(value.replace(/\s+/g, ' ')) : value.includes('\n') ? '\n' : ''
        }
        if (node.nodeType !== 1) return ''
        const el = node as Element
        const tag = el.tagName.toLowerCase()
        if (tag === 'style') return ''
        if (tag === 'script') {
          notes.push('a <script> element was dropped: React components carry behaviour, not page scripts')
          return ''
        }
        const pad = '  '.repeat(depth)
        const children = Array.from(el.childNodes)
          .map((child) => render(child, depth + 1))
          .join('')
        const open = `<${tag}${attributes(el)}`
        if (VOID_TAGS.has(tag)) return `${pad}${open} />\n`
        if (!children.trim()) return `${pad}${open}></${tag}>\n`
        return `${pad}${open}>\n${children}${pad}</${tag}>\n`
      }

      const css = Array.from(document.querySelectorAll('style'))
        .map((el) => el.textContent ?? '')
        .join('\n')
      const jsx = Array.from(document.body.childNodes)
        .map((child) => render(child, 2))
        .join('')
      return { css, jsx, notes }
    })) as Extracted
  } finally {
    await loaded.close()
  }
}

export interface HtmlToReactOptions {
  /** component name; defaults to the frame name or "Frame" */
  name?: string
  /** the frame id the scoped stylesheet keys off (`[data-frame="<id>"]`) */
  frameId?: string
  tokens?: DesignTokens
  /** Emit the frame's CSS scoped under `[data-frame="<id>"]` (the same mapping
   *  `htmlBundle` uses) instead of global rules, and wrap the markup in an
   *  element carrying that attribute so the selectors match. Default false:
   *  the frame's own `<style>` blocks ship unmodified. */
  scopedCss?: boolean
}

/** A frame's HTML as a self-contained React component plus its stylesheet.
 *  `htmlToReact(html, name, tokens)` and `htmlToReact(html, options)` are the
 *  same call. */
export async function htmlToReact(html: string, name: string, tokens?: DesignTokens): Promise<ReactExport>
export async function htmlToReact(html: string, options: HtmlToReactOptions): Promise<ReactExport>
export async function htmlToReact(
  html: string,
  nameOrOptions: string | HtmlToReactOptions,
  tokens?: DesignTokens,
): Promise<ReactExport> {
  const options = typeof nameOrOptions === 'string' ? { name: nameOrOptions, tokens } : nameOrOptions
  const name = options.name ?? 'Frame'
  const frame: Frame = {
    id: options.frameId ?? 'export',
    canvasId: 'export',
    name,
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    html,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'export',
  }
  const { css: unscopedCss, jsx, notes } = await extract(frame)
  const scoped = options.scopedCss === true
  const scope = `[data-frame="${frame.id}"]`
  const css = scoped ? (await scopedCss(frame, scope)).css : unscopedCss
  const component = componentName(name)
  /* the scoped selectors only match inside an element with the attribute, so
     the markup carries it; children shift one level deeper */
  const body = jsx.trimEnd()
  const markup = scoped
    ? body
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
    : body
  const styleNote = scoped
    ? `styles are scoped to ${scope}; keep the wrapper element's data-frame attribute when reusing the markup`
    : undefined
  return {
    component_name: component,
    jsx: [
      `/* ${component} — exported from Doop. Styles are in ${component}.css. */`,
      `export function ${component}() {`,
      '  return (',
      scoped ? `    <div data-frame="${frame.id}">` : '    <>',
      ...(markup ? markup.split('\n') : []),
      '      <style>{css}</style>',
      scoped ? '    </div>' : '    </>',
      '  )',
      '}',
      '',
      `const css = \`${css.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')}\``,
      '',
    ].join('\n'),
    css,
    tokens_css: options.tokens ? cssForTokens(options.tokens) : '',
    notes: styleNote ? [...notes, styleNote] : notes,
  }
}

interface FrameCss {
  /** the frame's rules, every selector scoped under `scope` */
  css: string
  /** the same rules unscoped — what two frames built from the same starting
   *  point share, so the bundle can hoist one copy */
  raw: string
}

/** The frame's stylesheets, with every selector scoped under `scope`. */
async function scopedCss(frame: Frame, scope: string): Promise<FrameCss> {
  const loaded = await loadFramePage(frame)
  const { page } = loaded
  try {
    await page.evaluate('globalThis.__name = (target) => target')
    const result = (await page.evaluate((prefix: string) => {
      const scopeOne = (selector: string) =>
        selector
          .split(',')
          .map((part) => {
            const trimmed = part.trim()
            if (!trimmed) return trimmed
            /* html/body/:root describe the page, not the frame's content: map
               them onto the scope itself so a scoped export keeps its ground */
            if (/^(html|body|:root)\b/.test(trimmed)) return prefix + trimmed.replace(/^(html|body|:root)/, '')
            return `${prefix} ${trimmed}`
          })
          .join(', ')

      const walkRaw = (rules: CSSRuleList): string => {
        let out = ''
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) out += `${rule.selectorText} {${rule.style.cssText}}\n`
          else if (rule instanceof CSSMediaRule) out += `@media ${rule.conditionText} {\n${walkRaw(rule.cssRules)}}\n`
          else if (rule instanceof CSSSupportsRule)
            out += `@supports ${rule.conditionText} {\n${walkRaw(rule.cssRules)}}\n`
        }
        return out
      }

      const walk = (rules: CSSRuleList, inside: string): string => {
        let out = ''
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) {
            out += `${inside}${scopeOne(rule.selectorText)} {${rule.style.cssText}}\n`
          } else if (rule instanceof CSSMediaRule) {
            out += `${inside}@media ${rule.conditionText} {\n${walk(rule.cssRules, `${inside}  `)}${inside}}\n`
          } else if (rule instanceof CSSSupportsRule) {
            out += `${inside}@supports ${rule.conditionText} {\n${walk(rule.cssRules, `${inside}  `)}${inside}}\n`
          }
        }
        return out
      }

      let all = ''
      let unscoped = ''
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          unscoped += walkRaw(sheet.cssRules)
          all += walk(sheet.cssRules, '')
        } catch {
          /* a cross-origin sheet cannot be read; imports are inlined at import
             time, so this is a stylesheet the frame loaded from a CDN */
        }
      }
      return { scoped: all, raw: unscoped }
    }, scope)) as { scoped: string; raw: string }
    return { css: result.scoped, raw: result.raw }
  } finally {
    await loaded.close()
  }
}

export interface CanvasBundle {
  html: string
  notes: string[]
}

/** Every frame on the canvas as one self-contained document. */
export async function htmlBundle(frames: Frame[], tokens?: DesignTokens): Promise<CanvasBundle> {
  const notes: string[] = []
  const sections: string[] = []
  const seen = new Set<string>()
  const styles: string[] = []

  for (const [index, frame] of frames.entries()) {
    const scope = `[data-frame="${frame.id}"]`
    const { css, raw } = await scopedCss(frame, scope)
    /* frames built from the same starting point share a stylesheet: compare the
       unscoped rules and hoist the scoped copy once */
    if (!seen.has(raw)) {
      seen.add(raw)
      styles.push(css)
    }
    const body = await bodyOf(frame)
    sections.push(
      `  <section data-frame="${frame.id}" data-frame-name="${escapeAttribute(frame.name)}" style="width:${Math.round(frame.width)}px">\n${body}\n  </section>`,
    )
    if (index === 0 && /<script/i.test(frame.html))
      notes.push('scripts were not carried into the bundle: it is a static render of the designs')
  }

  const head = [
    '<meta charset="utf-8">',
    '<title>Doop canvas export</title>',
    tokens ? `<style>${cssForTokens(tokens)}</style>` : '',
    `<style>\nbody { margin: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 48px; padding: 48px; }\n[data-frame] { position: relative; }\n${styles.join('\n')}\n</style>`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    html: `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n${sections.join('\n')}\n</body>\n</html>\n`,
    notes,
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** The rendered body markup of a frame, stylesheets excluded. */
async function bodyOf(frame: Frame): Promise<string> {
  const loaded = await loadFramePage(frame)
  const { page } = loaded
  try {
    await page.evaluate('globalThis.__name = (target) => target')
    return (await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('style, script'))) el.remove()
      return document.body.innerHTML
    })) as string
  } finally {
    await loaded.close()
  }
}
