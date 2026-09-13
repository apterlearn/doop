import type { Frame } from '../shared/types.ts'
import { ELEMENT_KEY_SRC, ELEMENT_PATH_SRC } from '../shared/selector.ts'
import { loadFramePage, type InteractionState } from './screenshot.ts'

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
  /** content key: the fallback an anchor uses when its selector goes stale */
  key: string
  tag: string
  role?: string
  /** the element's visible text (alt text for images), untruncated */
  text?: string
  /** text painted directly on this element's own background */
  directText: string
  rect: { x: number; y: number; width: number; height: number }
  /** raw document-space top, for stable document-order-independent sorting */
  top: number
  /** live box metrics and computed overflow, which is what the layout checks
   *  reason over; absent only on a hand-built probe fixture */
  scrollWidth?: number
  scrollHeight?: number
  clientWidth?: number
  clientHeight?: number
  overflowX?: string
  overflowY?: string
  /** index into Probe.elements of the nearest ancestor the walk kept; absent
   *  for a top-level element (body itself is not kept) */
  parentIndex?: number
  style: {
    color: string
    background: string
    /** the first non-transparent background at or above this element,
     *  composited over its ancestors — the color text actually sits on */
    effectiveBackground: string
    font: string
    fontSize: string
    fontWeight: string
    /** computed line-height in px; the lint compares the ratio to fontSize */
    lineHeight: string
    /** `none` is normalized to an empty string: a gradient or url() here is
     *  what makes a contrast measurement unreliable */
    backgroundImage: string
    borderRadius: string
    margin: string
    padding: string
    gap: string
  }
  fontSizePx: number
  fontWeight: number
  opacity: number
  /** natural size of an <img>; naturalWidth 0 means the source did not load */
  image?: { src: string; naturalWidth: number; naturalHeight: number; complete: boolean }
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
    /** data-doop-allow-overflow: the author says this box is meant to bleed
     *  (a marquee, a full-width band), so the layout lint leaves it alone */
    allowOverflow?: boolean
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
    /** content key: a stable fallback for anchoring when the selector goes stale */
    key: string
    tag: string
    role?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
    style: { color: string; background: string; font: string; fontSize: string; fontWeight: string }
  }>
}

/** A value and how many elements used it — the raw evidence a design system is
 *  derived from, before any rounding or top-N trimming. */
export interface UsageCount {
  value: string
  count: number
}

/** A font the document declared, and whether the browser actually loaded it. */
export interface ProbeFontFace {
  family: string
  status: string
  weight: string
  style: string
}

/** What the page says, as opposed to how it looks: the outline a content check
 *  reads and a handoff summarises. */
export interface ProbeContent {
  title: string
  description: string
  headings: { level: number; text: string; selector: string }[]
  sections: { selector: string; heading?: string; text: string; imageCount: number }[]
  nav: { text: string; href: string }[]
  ctas: { text: string; href: string; selector: string }[]
  forms: { selector: string; fields: { label: string; type: string; name: string }[] }[]
  images: { src: string; alt: string; width: number; height: number; selector: string }[]
  truncated: boolean
}

export interface Probe {
  document: {
    title: string
    /** meta description (og:description as the fallback) */
    description: string
    lang: string
    viewportMeta: string
    fonts: ProbeFontFace[]
    /** families the document asked for that did not load: a measurement taken
     *  through a fallback is not a measurement of the intended typeface */
    fontsFailed: string[]
    width: number
    height: number
    htmlChars: number
  }
  design: FrameInspection['design']
  designEvidence: {
    colors: UsageCount[]
    backgrounds: UsageCount[]
    fonts: UsageCount[]
    fontSizes: UsageCount[]
    fontWeights: UsageCount[]
    lineHeights: UsageCount[]
    /** line-height / font-size per element: the ratio a token can hold */
    leading: UsageCount[]
    spacing: UsageCount[]
    radii: UsageCount[]
    shadows: UsageCount[]
  }
  content: ProbeContent
  /** the frame's own stylesheet text, token block excluded — the interaction
   *  check reads the rules, not their computed result */
  cssText: string
  elements: ProbeElement[]
}

/** Render a frame and read everything the design tools need out of it. The
 *  viewport override is what makes the same design checkable at a phone width. */
export async function probeFrame(
  frame: Frame,
  opts: { viewport?: { width: number; height: number }; state?: InteractionState } = {},
): Promise<Probe> {
  const loaded = await loadFramePage(frame, {
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(opts.state ? { state: opts.state } : {}),
  })
  const { page } = loaded
  try {
    /* tsx/esbuild annotates nested functions with __name; page.evaluate
       serializes the callback without that runtime helper. A tiny in-page
       identity shim keeps the evaluated code independent of the loader. */
    await page.evaluate('globalThis.__name = (target) => target')
    /* install the shared selector algorithm: the same source the parent page
       and the frame runtime use, so an agent's selector matches a human's */
    await page.evaluate(ELEMENT_PATH_SRC)
    await page.evaluate(ELEMENT_KEY_SRC)
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

        /* the shared selector algorithm, installed into this page by
           probeFrame (shared/selector.ts) */
        function selectorFor(el: Element): string {
          return (globalThis as unknown as { doopElementPath: (el: Element) => string }).doopElementPath(el)
        }

        /* the element's content key, the fallback an anchor uses when its
           positional selector goes stale (shared/selector.ts) */
        function keyFor(el: Element): string {
          return (globalThis as unknown as { doopElementKey: (el: Element) => string }).doopElementKey(el)
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
          fontWeights: new Map<string, number>(),
          lineHeights: new Map<string, number>(),
          leading: new Map<string, number>(),
          spacing: new Map<string, number>(),
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
          bump(counts.fontWeights, style.fontWeight)
          if (style.lineHeight !== 'normal') bump(counts.lineHeights, style.lineHeight)
          /* the leading ratio is only knowable where both values are in hand:
             counting sizes and line-heights separately loses the pairing */
          {
            const sizePx = parseFloat(style.fontSize)
            const linePx = parseFloat(style.lineHeight)
            if (sizePx > 0 && linePx > 0) {
              const ratio = Math.round((linePx / sizePx) * 100) / 100
              if (ratio >= 0.5 && ratio <= 3) bump(counts.leading, String(ratio))
            }
          }
          /* the spacing scale a design actually uses: the px values in its
             margins, paddings and gaps, which is what a token set codifies */
          for (const value of [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft]) {
            if (value && value !== '0px' && value.endsWith('px')) bump(counts.spacing, value)
          }
          for (const value of [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]) {
            if (value && value !== '0px' && value.endsWith('px')) bump(counts.spacing, value)
          }
          if (style.gap && style.gap !== 'normal' && style.gap.endsWith('px')) bump(counts.spacing, style.gap)
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

        /* indices into the published list, so an element can name its parent */
        const indexOf = new Map<HTMLElement, number>()
        kept.forEach((el, index) => indexOf.set(el, index))

        const elements = kept.map((el) => {
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          const tag = el.tagName.toLowerCase()
          const attrs = el.attributes
          const attr = (name: string) => attrs.getNamedItem(name)?.value || undefined
          const image = el instanceof HTMLImageElement
          /* the nearest ancestor the cap kept: sibling rules compare elements
             by this index, so a dropped wrapper degrades to a coarser group
             rather than to a wrong one */
          let parentIndex: number | undefined
          for (let node = el.parentElement; node; node = node.parentElement) {
            const found = indexOf.get(node)
            if (found !== undefined) {
              parentIndex = found
              break
            }
          }
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
            key: keyFor(el),
            tag,
            ...(image
              ? {
                  image: {
                    src: (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '',
                    naturalWidth: (el as HTMLImageElement).naturalWidth,
                    naturalHeight: (el as HTMLImageElement).naturalHeight,
                    complete: (el as HTMLImageElement).complete,
                  },
                }
              : {}),
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
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight,
            clientWidth: el.clientWidth,
            clientHeight: el.clientHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            parentIndex,
            style: {
              color: style.color,
              background: style.backgroundColor,
              effectiveBackground: effectiveBackground(el),
              font: style.fontFamily,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              backgroundImage: style.backgroundImage === 'none' ? '' : style.backgroundImage,
              direction: style.direction,
              pointerEvents: style.pointerEvents,
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
              allowOverflow: el.hasAttribute('data-doop-allow-overflow'),
            },
          }
        })

        const top = (map: Map<string, number>, limit: number) =>
          [...map.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([value]) => value)
        const topCounts = (map: Map<string, number>, limit: number) =>
          [...map.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([value, count]) => ({ value, count }))
        const rootStyle = getComputedStyle(document.documentElement)
        const cssVariables: Record<string, string> = {}
        for (const name of Array.from(rootStyle)) {
          if (!name.startsWith('--') || Object.keys(cssVariables).length >= maxCssVariables) continue
          const value = rootStyle.getPropertyValue(name).trim()
          if (value && value.length <= maxCssVariableChars) cssVariables[name] = value
        }

        /* fonts: what the document asked for, and what actually loaded */
        const fontFaces = Array.from(document.fonts).map((face) => ({
          family: face.family.replace(/^["']|["']$/g, ''),
          status: face.status,
          weight: face.weight,
          style: face.style,
        }))
        const loadedFamilies = new Set(
          fontFaces.filter((face) => face.status === 'loaded').map((face) => face.family.toLowerCase()),
        )
        /* lowercase -> the family as the page wrote it, so the report names it
           the way a person would search for it */
        const wantedFamilies = new Map<string, string>()
        for (const family of counts.fonts.keys()) {
          /* a computed font-family list: the first family is the one that
             decides how the text looks */
          const first = family
            .split(',')[0]!
            .replace(/^["']|["']$/g, '')
            .trim()
          if (first) wantedFamilies.set(first.toLowerCase(), first)
        }
        const generic = new Set([
          'sans-serif',
          'serif',
          'monospace',
          'system-ui',
          'cursive',
          'fantasy',
          'ui-sans-serif',
          'ui-serif',
          'ui-monospace',
          'ui-rounded',
          '-apple-system',
          'blinkmacsystemfont',
          'segoe ui',
          'inherit',
        ])
        const fontsFailed = [
          ...fontFaces.filter((face) => face.status === 'error').map((face) => face.family),
          ...[...wantedFamilies.entries()]
            .filter(([lower]) => !generic.has(lower) && !loadedFamilies.has(lower))
            .map(([, original]) => original),
        ].filter((family, index, all) => all.indexOf(family) === index)

        const clean = (value: string | null | undefined, max = 300) =>
          (value || '').replace(/\s+/g, ' ').trim().slice(0, max)

        /* the frame's own stylesheet text: the interaction-state check needs
           the rules, not their computed result */
        let cssText = ''
        for (const node of Array.from(document.querySelectorAll('style'))) {
          if (node.hasAttribute('data-doop-tokens')) continue
          cssText += (node.textContent || '') + '\n'
          if (cssText.length > 200000) break
        }

        /* the content outline: what the page says, separated from how it looks */
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
          .slice(0, 60)
          .map((el) => ({
            level: Number(el.tagName.slice(1)),
            text: clean(el.textContent, 200),
            selector: selectorFor(el),
          }))
        const sectionNodes = Array.from(document.querySelectorAll('section,main > *,article'))
          .filter((el) => el.tagName.toLowerCase() !== 'main')
          .slice(0, 40)
        const sections = sectionNodes.map((el) => {
          const heading = el.querySelector('h1,h2,h3,h4,h5,h6')
          return {
            selector: selectorFor(el),
            ...(heading ? { heading: clean(heading.textContent, 200) } : {}),
            text: clean(el.textContent, 400),
            imageCount: el.querySelectorAll('img').length,
          }
        })
        const nav = Array.from(document.querySelectorAll('nav a, header a'))
          .slice(0, 60)
          .map((el) => ({ text: clean(el.textContent, 80), href: el.getAttribute('href') || '' }))
        const ctas = Array.from(document.querySelectorAll('a,button'))
          .filter((el) => clean(el.textContent, 80).length > 0)
          .slice(0, 40)
          .map((el) => ({
            text: clean(el.textContent, 80),
            href: el.getAttribute('href') || '',
            selector: selectorFor(el),
          }))
        const forms = Array.from(document.querySelectorAll('form'))
          .slice(0, 10)
          .map((form) => ({
            selector: selectorFor(form),
            fields: Array.from(form.querySelectorAll('input,select,textarea'))
              .slice(0, 30)
              .map((field) => {
                const id = field.getAttribute('id')
                const label =
                  (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : undefined) ||
                  field.closest('label')?.textContent ||
                  field.getAttribute('aria-label') ||
                  ''
                return {
                  label: clean(label, 80),
                  type: field.getAttribute('type') || field.tagName.toLowerCase(),
                  name: field.getAttribute('name') || '',
                }
              }),
          }))
        const images = Array.from(document.querySelectorAll('img'))
          .slice(0, 80)
          .map((el) => ({
            src: el.currentSrc || el.getAttribute('src') || '',
            alt: el.getAttribute('alt') || '',
            width: el.naturalWidth,
            height: el.naturalHeight,
            selector: selectorFor(el),
          }))
        const contentTruncated =
          document.querySelectorAll('h1,h2,h3,h4,h5,h6').length > 60 ||
          sectionNodes.length > 40 ||
          document.querySelectorAll('img').length > 80

        return {
          title: document.title,
          description:
            document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
            document.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
            '',
          viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content')?.trim() || '',
          fonts: fontFaces.slice(0, 40),
          fontsFailed,
          cssText: cssText.slice(0, 200000),
          content: {
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '',
            headings,
            sections,
            nav,
            ctas,
            forms,
            images,
            truncated: contentTruncated,
          },
          designEvidence: {
            colors: topCounts(counts.colors, 12),
            backgrounds: topCounts(counts.backgrounds, 12),
            fonts: topCounts(counts.fonts, 8),
            fontSizes: topCounts(counts.fontSizes, 12),
            fontWeights: topCounts(counts.fontWeights, 8),
            lineHeights: topCounts(counts.lineHeights, 12),
            leading: topCounts(counts.leading, 12),
            spacing: topCounts(counts.spacing, 16),
            radii: topCounts(counts.radii, 8),
            shadows: topCounts(counts.shadows, 8),
          },
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
        description: probed.description,
        lang: probed.lang,
        viewportMeta: probed.viewportMeta,
        fonts: probed.fonts,
        fontsFailed: probed.fontsFailed,
        width: Math.round(opts.viewport?.width ?? frame.width),
        height: Math.round(opts.viewport?.height ?? frame.height),
        htmlChars: frame.html.length,
      },
      design: probed.design,
      designEvidence: probed.designEvidence,
      content: probed.content,
      cssText: probed.cssText,
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
    key: el.key,
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
