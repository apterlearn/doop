import type { Frame } from '../shared/types.ts'
import { loadFramePage } from './screenshot.ts'

/**
 * The rendered-DOM probe.
 *
 * One in-page walk collects everything an agent-facing tool needs to reason
 * about a frame: computed styles, geometry, text, accessibility attributes and
 * the composited background behind each element. `inspect_frame` is a
 * formatter over it, and the accessibility and design-token checks are
 * analyses over it, so all three see exactly the same rendering.
 *
 * The probe is deliberately wider than `inspect_frame`: it keeps every element
 * it can (up to MAX_PROBE_ELEMENTS) and full text, because a contrast or
 * tap-target check on a sampled subset is a check that misses things.
 */

/** Elements the probe keeps. A design frame is not a 10k-node document, and a
 *  bounded walk keeps one call's cost predictable. */
const MAX_PROBE_ELEMENTS = 300
const MAX_STYLE_SAMPLES = 500
const MAX_CSS_VARIABLES = 40
const MAX_CSS_VARIABLE_CHARS = 160

/** Tags `inspect_frame` treats as the design's structure. */
const SEMANTIC_TAGS = [
  'header',
  'nav',
  'main',
  'section',
  'article',
  'aside',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'form',
  'img',
  'ul',
  'ol',
  'table',
] as const

export interface ProbeElement {
  selector: string
  tag: string
  role?: string
  /** the element's visible text (alt text for images), untruncated */
  text?: string
  /** text painted directly on this element's own background */
  directText: string
  rect: { x: number; y: number; width: number; height: number }
  /** raw document-space top, for stable document-order-independent sorting */
  top: number
  style: {
    color: string
    background: string
    /** the first non-transparent background at or above this element,
     *  composited over its ancestors — the color text actually sits on */
    effectiveBackground: string
    font: string
    fontSize: string
    fontWeight: string
    borderRadius: string
    margin: string
    padding: string
    gap: string
  }
  fontSizePx: number
  fontWeight: number
  opacity: number
  attrs: {
    id?: string
    alt?: string
    href?: string
    tabindex?: string
    ariaLabel?: string
    ariaLabelledby?: string
    type?: string
    htmlFor?: string
    lang?: string
    /** aria-hidden, or a display:none/visibility:hidden ancestor */
    hiddenFromAT: boolean
    /** a[href], button, input, select, textarea or [tabindex] */
    focusable: boolean
    /** a <label> wraps this control */
    wrappedInLabel: boolean
  }
}

export interface FrameInspection {
  document: { title: string; width: number; height: number; htmlChars: number }
  design: {
    colors: string[]
    backgrounds: string[]
    fonts: string[]
    fontSizes: string[]
    radii: string[]
    shadows: string[]
    cssVariables: Record<string, string>
  }
  elements: Array<{
    selector: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
}

export interface Probe {
  document: { title: string; width: number; height: number; htmlChars: number; lang: string }
  design: FrameInspection['design']
  elements: ProbeElement[]
}

/** Render a frame and read everything the design tools need out of it. The
 *  viewport override is what makes the same design checkable at a phone width. */
export async function probeFrame(
  frame: Frame,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<Probe> {
  const loaded = await loadFramePage(frame, opts.viewport ? { viewport: opts.viewport } : {})
  const { page } = loaded
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. A tiny in-page
       identity shim keeps the evaluated code independent of the loader. */
    await page.evaluate('globalThis.__name = (target) => target')
    const probed = await page.evaluate(
      (limits: {
        maxElements: number
        maxStyleSamples: number
        maxCssVariables: number
        maxCssVariableChars: number
        semanticTags: string[]
      }) => {
        const { maxElements, maxStyleSamples, maxCssVariables, maxCssVariableChars, semanticTags } = limits
        const semantic = new Set(semanticTags)

        function visible(el: Element): el is HTMLElement {
          if (!(el instanceof HTMLElement)) return false
          const style = getComputedStyle(el)
          const rect = el.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) > 0 &&
            rect.width > 1 &&
            rect.height > 1
          )
        }

        function selectorFor(el: Element): string {
          if (el.id && el.id.length < 80) return `#${CSS.escape(el.id)}`
          const parts: string[] = []
          let node: Element | null = el
          while (node && node !== document.body && parts.length < 7) {
            const tag = node.tagName.toLowerCase()
            const parent: Element | null = node.parentElement
            if (!parent) {
              parts.unshift(tag)
              break
            }
            const sameTag = Array.from(parent.children).filter((child: Element) => child.tagName === node!.tagName)
            const suffix = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : ''
            parts.unshift(tag + suffix)
            node = parent
          }
          return `body > ${parts.join(' > ')}`
        }

        function cleanText(value: string | null | undefined): string | undefined {
          const text = (value || '').replace(/\s+/g, ' ').trim()
          return text || undefined
        }

        function normalizedColor(value: string): string | undefined {
          if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') return undefined
          return value
        }

        /** "rgb(r, g, b)" / "rgba(r, g, b, a)" -> channels; null for anything else. */
        function channels(value: string): [number, number, number, number] | null {
          const m = value.match(/^rgba?\(([^)]+)\)$/)
          if (!m) return null
          const parts = m[1]!.split(',').map((p) => Number.parseFloat(p.trim()))
          if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null
          return [parts[0]!, parts[1]!, parts[2]!, parts.length > 3 ? parts[3]! : 1]
        }

        /** The color the element's text actually sits on: every background from
         *  the root down, painted in order onto white. */
        function effectiveBackground(el: Element): string {
          const stack: string[] = []
          let node: Element | null = el
          while (node) {
            const bg = getComputedStyle(node).backgroundColor
            const parsed = channels(bg)
            if (parsed && parsed[3] > 0) stack.push(bg)
            if (parsed && parsed[3] >= 1) break
            node = node.parentElement
          }
          let out: [number, number, number] = [255, 255, 255]
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            const c = channels(stack[i]!)
            if (!c) continue
            const [r, g, b, a] = c
            out = [out[0] * (1 - a) + r * a, out[1] * (1 - a) + g * a, out[2] * (1 - a) + b * a]
          }
          return `rgb(${Math.round(out[0])}, ${Math.round(out[1])}, ${Math.round(out[2])})`
        }

        /** Text in this element's own text nodes — the text it paints itself. */
        function directText(el: Element): string {
          let out = ''
          for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === 3) out += node.nodeValue ?? ''
          }
          return out.replace(/\s+/g, ' ').trim()
        }

        const counts = {
          colors: new Map<string, number>(),
          backgrounds: new Map<string, number>(),
          fonts: new Map<string, number>(),
          fontSizes: new Map<string, number>(),
          radii: new Map<string, number>(),
          shadows: new Map<string, number>(),
        }
        const bump = (map: Map<string, number>, value?: string) => {
          if (value) map.set(value, (map.get(value) || 0) + 1)
        }

        const all = Array.from(document.body.querySelectorAll('*')).filter(visible)
        for (const el of all.slice(0, maxStyleSamples)) {
          const style = getComputedStyle(el)
          bump(counts.colors, normalizedColor(style.color))
          bump(counts.backgrounds, normalizedColor(style.backgroundColor))
          bump(counts.fonts, style.fontFamily)
          bump(counts.fontSizes, style.fontSize)
          if (style.borderRadius !== '0px') bump(counts.radii, style.borderRadius)
          if (style.boxShadow !== 'none') bump(counts.shadows, style.boxShadow)
        }

        /* Document order, structural and interactive elements first when the
           cap bites: a check that silently drops every button is worse than one
           that reports fewer decorative wrappers. */
        const interesting = (el: HTMLElement) => {
          const tag = el.tagName.toLowerCase()
          if (semantic.has(tag) || el.getAttribute('role')) return 0
          if (directText(el)) return 1
          return 2
        }
        const kept =
          all.length <= maxElements
            ? all
            : all
                .map((el, index) => ({ el, index, rank: interesting(el) }))
                .sort((a, b) => a.rank - b.rank || a.index - b.index)
                .slice(0, maxElements)
                .sort((a, b) => a.index - b.index)
                .map((entry) => entry.el)

        const elements = kept.map((el) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const tag = el.tagName.toLowerCase()
          const attrs = el.attributes
          const attr = (name: string) => attrs.getNamedItem(name)?.value || undefined
          const image = el instanceof HTMLImageElement
          const focusable =
            (tag === 'a' && !!attr('href')) ||
            tag === 'button' ||
            tag === 'input' ||
            tag === 'select' ||
            tag === 'textarea' ||
            attr('tabindex') !== undefined
          let hiddenFromAT = attr('aria-hidden') === 'true'
          for (let node: Element | null = el; node && !hiddenFromAT; node = node.parentElement) {
            const s = getComputedStyle(node)
            if (s.display === 'none' || s.visibility === 'hidden') hiddenFromAT = true
          }
          return {
            selector: selectorFor(el),
            tag,
            role: attr('role'),
            text: image
              ? cleanText(el.getAttribute('alt') || el.getAttribute('aria-label'))
              : cleanText(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder')),
            directText: directText(el),
            rect: {
              x: Math.round(rect.left + scrollX),
              y: Math.round(rect.top + scrollY),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            top: rect.top,
            style: {
              color: style.color,
              background: style.backgroundColor,
              effectiveBackground: effectiveBackground(el),
              font: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              borderRadius: style.borderRadius,
              margin: `${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}`,
              padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
              gap: style.rowGap === style.columnGap ? style.rowGap : `${style.rowGap} ${style.columnGap}`,
            },
            fontSizePx: Number.parseFloat(style.fontSize) || 0,
            fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
            opacity: Number(style.opacity),
            attrs: {
              id: attr('id'),
              alt: image ? (el.getAttribute('alt') ?? undefined) : attr('alt'),
              href: attr('href'),
              tabindex: attr('tabindex'),
              ariaLabel: attr('aria-label'),
              ariaLabelledby: attr('aria-labelledby'),
              type: attr('type'),
              htmlFor: tag === 'label' ? attr('for') : undefined,
              lang: attr('lang'),
              hiddenFromAT,
              focusable,
              wrappedInLabel: !!el.closest('label'),
            },
          }
        })

        const top = (map: Map<string, number>, limit: number) =>
          [...map.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([value]) => value)
        const rootStyle = getComputedStyle(document.documentElement)
        const cssVariables: Record<string, string> = {}
        for (const name of Array.from(rootStyle)) {
          if (!name.startsWith('--') || Object.keys(cssVariables).length >= maxCssVariables) continue
          const value = rootStyle.getPropertyValue(name).trim()
          if (value && value.length <= maxCssVariableChars) cssVariables[name] = value
        }

        return {
          title: document.title,
          lang: document.documentElement.lang || '',
          design: {
            colors: top(counts.colors, 10),
            backgrounds: top(counts.backgrounds, 10),
            fonts: top(counts.fonts, 8),
            fontSizes: top(counts.fontSizes, 10),
            radii: top(counts.radii, 8),
            shadows: top(counts.shadows, 6),
            cssVariables,
          },
          elements,
        }
      },
      {
        maxElements: MAX_PROBE_ELEMENTS,
        maxStyleSamples: MAX_STYLE_SAMPLES,
        maxCssVariables: MAX_CSS_VARIABLES,
        maxCssVariableChars: MAX_CSS_VARIABLE_CHARS,
        semanticTags: [...SEMANTIC_TAGS],
      },
    )

    return {
      document: {
        title: probed.title,
        lang: probed.lang,
        width: Math.round(opts.viewport?.width ?? frame.width),
        height: Math.round(opts.viewport?.height ?? frame.height),
        htmlChars: frame.html.length,
      },
      design: probed.design,
      elements: probed.elements,
    }
  } finally {
    await loaded.close()
  }
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** The element selection and per-element shape `inspect_frame` publishes:
 *  quotas per category, filled in document order, capped at 64. Pure over a
 *  probe, so the published contract is verifiable without a browser. */
export function selectInspectionElements(probe: Probe): FrameInspection['elements'] {
  const MAX_ELEMENTS = 64
  const semantic = new Set<string>(SEMANTIC_TAGS)

  const semanticElements = probe.elements
    .filter((el) => semantic.has(el.tag) || !!el.role)
    .sort((a, b) => a.top - b.top)
  const candidates: ProbeElement[] = []
  const selected = new Set<ProbeElement>()
  const take = (limit: number, predicate: (el: ProbeElement) => boolean) => {
    for (const el of semanticElements) {
      if (candidates.length >= MAX_ELEMENTS || limit <= 0) break
      if (selected.has(el) || !predicate(el)) continue
      selected.add(el)
      candidates.push(el)
      limit--
    }
  }
  take(18, (el) => ['header', 'nav', 'main', 'section', 'article', 'aside', 'footer'].includes(el.tag))
  take(16, (el) => /^h[1-6]$/.test(el.tag))
  take(16, (el) => ['button', 'a', 'input', 'textarea', 'select', 'form'].includes(el.tag) || !!el.role)
  take(14, (el) => ['p', 'img', 'ul', 'ol', 'table'].includes(el.tag))
  take(MAX_ELEMENTS - candidates.length, () => true)

  return candidates.map((el) => ({
    selector: el.selector,
    tag: el.tag,
    role: el.role,
    text: truncate(el.text, 180),
    rect: el.rect,
    style: {
      color: el.style.color,
      background: el.style.background,
      font: el.style.font,
      fontSize: el.style.fontSize,
      fontWeight: el.style.fontWeight,
    },
  }))
}

/** A compact, rendered representation for agents. It intentionally relies on
 *  visible text, semantics, geometry and computed styles rather than classes.
 *  A formatter over the probe: same fields, same selection quotas and caps as
 *  it has always had, so existing agent sessions keep reading what they read. */
export async function inspectFrame(
  frame: Frame,
  opts: { viewport?: { width: number; height: number } } = {},
): Promise<FrameInspection> {
  const probe = await probeFrame(frame, opts)
  return {
    document: {
      title: probe.document.title,
      width: probe.document.width,
      height: probe.document.height,
      htmlChars: probe.document.htmlChars,
    },
    design: probe.design,
    elements: selectInspectionElements(probe),
  }
}
