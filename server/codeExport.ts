import type { Component, DesignTokens, Frame, FrameReview } from '../shared/types.ts'
import type { CanvasRelease } from './db/persist.ts'
import type { McpErrorCode } from './mcpErrors.ts'
import { probeFrame, type Probe } from './domProbe.ts'
import { loadFramePage } from './screenshot.ts'
import { frameSha } from './review.ts'
import { cssForTokens } from '../shared/tokens.ts'
import { store } from './store.ts'
import * as actions from './actions.ts'
import * as assets from './assets.ts'
import * as persist from './db/persist.ts'

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

/** The tokens as a Tailwind v4 `@theme` block. Two spellings ship on purpose.
 *
 *  Tailwind's own namespaces come first (`--spacing-*`, `--font-weight-*`) so
 *  the utilities resolve: `gap-8`, `font-semibold`.
 *
 *  Then the doop render-path spellings as aliases with the same literal value
 *  (`--space-*`, `--weight-*`) — the names `cssForTokens` (shared/tokens.ts)
 *  injects into every frame at render time. A frame is authored against those
 *  names, so without the alias `var(--space-8)` resolves on the canvas and
 *  falls back to nothing the moment the same design is consumed as this theme.
 *  Same tokens, two consumers, so both names exist; every other namespace
 *  already agrees between the two. */
export function tailwindThemeCss(tokens: DesignTokens): string {
  const lines: string[] = []
  for (const [name, value] of Object.entries(tokens.colors ?? {})) lines.push(`  --color-${name}: ${value.trim()};`)
  for (const [key, value] of Object.entries(tokens.fonts ?? {}))
    if (value) lines.push(`  --font-${key}: ${value.trim()};`)
  for (const value of tokens.spacing ?? []) {
    lines.push(`  --spacing-${value}: ${value}px;`)
    lines.push(`  --space-${value}: ${value}px;`)
  }
  for (const value of tokens.radii ?? []) lines.push(`  --radius-${value}: ${value}px;`)
  for (const [index, value] of (tokens.shadows ?? []).entries()) lines.push(`  --shadow-${index + 1}: ${value.trim()};`)
  for (const value of tokens.type?.size ?? []) lines.push(`  --text-${value}: ${value}px;`)
  for (const value of tokens.type?.weight ?? []) {
    lines.push(`  --font-weight-${value}: ${value};`)
    lines.push(`  --weight-${value}: ${value};`)
  }
  for (const value of tokens.type?.leading ?? []) lines.push(`  --leading-${value}: ${value};`)
  return `@theme {\n${lines.join('\n')}\n}`
}

/** The tokens verbatim, pretty-printed — the machine-readable form the CSS
 *  exports are derived from. */
export function tokensJson(tokens: DesignTokens): string {
  return JSON.stringify(tokens, null, 2)
}

/* ---- W3C DTCG 2025.10 ---- */

/** A DTCG dimension: value + unit, the shape the spec requires. */
interface DtcgDimension {
  value: number
  unit: 'px' | 'rem' | 'em'
}

function dimension(value: number, unit: 'px' | 'rem' | 'em' = 'px'): DtcgDimension {
  return { value, unit }
}

/** Split a CSS value on whitespace that is not inside parentheses — a color
 *  like `rgba(0, 0, 0, 0.1)` is one token, not five. */
function splitTop(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(char) && depth === 0) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) out.push(current)
  return out
}

const LENGTH = /^(-?\d*\.?\d+)(px|rem|em)?$/

function length(token: string): DtcgDimension | undefined {
  const match = LENGTH.exec(token)
  if (!match) return undefined
  const value = Number.parseFloat(match[1]!)
  if (!Number.isFinite(value)) return undefined
  /* a bare 0 is the one length CSS allows without a unit */
  const unit = (match[2] as DtcgDimension['unit'] | undefined) ?? 'px'
  return dimension(value, unit)
}

/** A CSS box-shadow as the DTCG shadow value, or undefined when it does not
 *  parse — the caller then emits the raw string instead of guessing. */
function parseShadow(raw: string): Record<string, unknown> | undefined {
  const tokens = splitTop(raw.replace(/!important/g, ''))
  if (tokens.length === 0) return undefined
  let inset = false
  const lengths: DtcgDimension[] = []
  const rest: string[] = []
  for (const token of tokens) {
    if (token === 'inset') {
      inset = true
      continue
    }
    const size = length(token)
    if (size) lengths.push(size)
    else rest.push(token)
  }
  /* offsetX and offsetY are required; blur and spread are optional */
  if (lengths.length < 2 || lengths.length > 4) return undefined
  const color = rest.join(' ')
  if (!color) return undefined
  return {
    color,
    offsetX: lengths[0],
    offsetY: lengths[1],
    ...(lengths[2] ? { blur: lengths[2] } : {}),
    ...(lengths[3] ? { spread: lengths[3] } : {}),
    ...(inset ? { inset: true } : {}),
  }
}

/** The canvas tokens as W3C Design Tokens (DTCG 2025.10) — the interchange
 *  format Figma, Style Dictionary and every design tool reads, so a handoff is
 *  not a screenshot of the system but the system itself. */
export function tokensDtcg(tokens: DesignTokens): string {
  const color: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(tokens.colors ?? {})) {
    color[name] = { $type: 'color', $value: value.trim() }
  }

  const font: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(tokens.fonts ?? {})) {
    if (!value) continue
    /* a font token is a stack: the families in order, as the spec's array */
    font[name] = {
      $type: 'fontFamily',
      $value: value
        .split(',')
        .map((family) => family.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean),
    }
  }

  const space: Record<string, unknown> = {}
  for (const value of tokens.spacing ?? []) space[String(value)] = { $type: 'dimension', $value: dimension(value) }

  const radius: Record<string, unknown> = {}
  for (const value of tokens.radii ?? []) radius[String(value)] = { $type: 'dimension', $value: dimension(value) }

  const shadow: Record<string, unknown> = {}
  for (const [index, value] of (tokens.shadows ?? []).entries()) {
    const parsed = parseShadow(value)
    shadow[String(index + 1)] = parsed
      ? { $type: 'shadow', $value: parsed }
      : {
          $type: 'string',
          $value: value.trim(),
          $description: 'raw CSS box-shadow — not parseable into a DTCG shadow value',
        }
  }

  const type: Record<string, unknown> = {}
  const sizes: Record<string, unknown> = {}
  for (const value of tokens.type?.size ?? []) sizes[String(value)] = { $type: 'dimension', $value: dimension(value) }
  const weights: Record<string, unknown> = {}
  for (const value of tokens.type?.weight ?? []) weights[String(value)] = { $type: 'fontWeight', $value: value }
  const leading: Record<string, unknown> = {}
  for (const value of tokens.type?.leading ?? []) leading[String(value)] = { $type: 'number', $value: value }
  if (Object.keys(sizes).length) type.size = sizes
  if (Object.keys(weights).length) type.weight = weights
  if (Object.keys(leading).length) type.leading = leading

  const document: Record<string, unknown> = {
    $description: `Design tokens for the Doop canvas, in W3C Design Tokens (DTCG 2025.10) form. Last written by ${tokens.updatedBy}.`,
  }
  if (Object.keys(color).length) document.color = color
  if (Object.keys(font).length) document.font = font
  if (Object.keys(space).length) document.space = space
  if (Object.keys(radius).length) document.radius = radius
  if (Object.keys(shadow).length) document.shadow = shadow
  if (Object.keys(type).length) document.type = type
  return JSON.stringify(document, null, 2)
}

/* ---- the documents a human inherits ---- */

/** One section of DESIGN.md. An empty section says so rather than vanishing:
 *  a reader who expected elevation tokens learns the canvas has none. */
function mdSection(title: string, body: string[]): string {
  if (body.length === 0) return `## ${title}\n\n_omitted — this canvas has no data for it._\n`
  return `## ${title}\n\n${body.join('\n')}\n`
}

/** One entry of the canvas's component library, as DESIGN.md lists it: what the
 *  component is, how big it is, how widely the canvas uses it, and where its
 *  code was written in this export. */
export interface DesignComponent {
  name: string
  description?: string
  width: number
  height: number
  /** frames on the canvas holding an instance of it */
  instanceCount?: number
  /** where its React component landed in the export */
  path?: string
}

/** DESIGN.md: the canvas's design system as a document a designer or an agent
 *  reads before touching the work. Section order is fixed.
 *
 *  `framePath` names where each frame's document was written in the export the
 *  reader is holding: the layouts differ (`design/<name>.html`, `frames/<name>`),
 *  so the caller supplies it rather than the document guessing a path that does
 *  not exist.
 *
 *  `library` is the canvas's component library: a reader building from this
 *  document inherits the components the canvas already reuses, not only its
 *  layouts. `canvas.breakpoints` are the widths the canvas declares it designs
 *  for — without them the layout section describes sizes but not the widths
 *  the design is meant to hold at. */
export function designMd(
  tokens: DesignTokens | undefined,
  canvas: { name: string; frames: Frame[]; breakpoints?: { name: string; min_width: number }[] },
  framePath?: (frame: Frame) => string,
  library?: DesignComponent[],
): string {
  const frames = canvas.frames.filter((f) => !f.demo)
  const colors = Object.entries(tokens?.colors ?? {})
  const fonts = Object.entries(tokens?.fonts ?? {}).filter(([, value]) => !!value)

  const overview = [
    `**${canvas.name}** — ${frames.length} frame(s), ${tokens ? 'a design token set' : 'no design tokens yet'}.`,
    '',
    ...frames.map((f) => `- ${f.name} — ${Math.round(f.width)}x${Math.round(f.height)}`),
  ]

  const colorLines = colors.length
    ? ['| Token | Value |', '| --- | --- |', ...colors.map(([name, value]) => `| \`${name}\` | \`${value}\` |`)]
    : []

  const typography = [
    ...fonts.map(([name, value]) => `- **${name}** — ${value}`),
    ...(tokens?.type?.size?.length ? [`- Sizes (px): ${tokens.type.size.join(', ')}`] : []),
    ...(tokens?.type?.weight?.length ? [`- Weights: ${tokens.type.weight.join(', ')}`] : []),
    ...(tokens?.type?.leading?.length ? [`- Line heights: ${tokens.type.leading.join(', ')}`] : []),
  ]

  const layout = [
    ...(tokens?.spacing?.length ? [`- Spacing scale (px): ${tokens.spacing.join(', ')}`] : []),
    ...(frames.length
      ? [`- Frame sizes: ${frames.map((f) => `${Math.round(f.width)}x${Math.round(f.height)}`).join(', ')}`]
      : []),
    ...(canvas.breakpoints?.length
      ? [`- Breakpoints: ${canvas.breakpoints.map((b) => `${b.name} from ${b.min_width}px`).join(', ')}`]
      : []),
  ]

  const elevation = (tokens?.shadows ?? []).map((value, index) => `- shadow ${index + 1}: \`${value}\``)
  const shapes = (tokens?.radii ?? []).map((value) => `- radius ${value}px`)
  const frameLines = frames.map((f) => {
    const path = framePath?.(f)
    return `- **${f.name}** — ${Math.round(f.width)}x${Math.round(f.height)}${path ? `; source: \`${path}\`` : ''}`
  })
  /* the library's pieces and the layouts are both reusable design, but they are
     read for different reasons — one to drop in, one to lay out — so a canvas
     that has a library gets them as two lists and a canvas that has none reads
     exactly as it did before */
  const libraryLines = (library ?? []).map((entry) => {
    const meta = [`${Math.round(entry.width)}x${Math.round(entry.height)}`]
    if (entry.instanceCount !== undefined) meta.push(`${entry.instanceCount} instance(s)`)
    const name = `- **${entry.name}**${entry.description ? ` — ${entry.description}` : ''}`
    const source = entry.path ? `; source: \`${entry.path}\`` : ''
    return `${name} (${meta.join(', ')})${source}`
  })
  const components = libraryLines.length
    ? [
        'Components in the library:',
        '',
        ...libraryLines,
        ...(frameLines.length ? ['', 'Frames (the layouts):', '', ...frameLines] : []),
      ]
    : frameLines

  const rules = [
    '- Use the tokens above. A color, size, radius or shadow that is not on these scales is drift: the checks flag it and the delivery gate can refuse it.',
    '- Every frame is a self-contained HTML document; keep styles inside it or in the shared token block.',
    '- Text must meet WCAG AA contrast against its background, and every image needs alt text.',
    "- Do not restyle another actor's frame without being asked — the canvas is multiplayer.",
  ]

  return [
    `# ${canvas.name} — design system`,
    '',
    `Generated from the Doop canvas's design tokens. ${tokens ? `Last written by ${tokens.updatedBy}.` : ''}`.trim(),
    '',
    mdSection('Overview', overview),
    mdSection('Colors', colorLines),
    mdSection('Typography', typography),
    mdSection('Layout', layout),
    mdSection('Elevation & Depth', elevation),
    mdSection('Shapes', shapes),
    mdSection('Components', components),
    mdSection("Do's and Don'ts", rules),
  ].join('\n')
}

/* ---- spec.md: the redlines a developer builds from ---- */

/** One row of the type ramp: a distinct combination of family, size, weight and
 *  line height, with how many elements use it. */
interface TypeRampRow {
  font: string
  size: number
  weight: number
  lineHeight: string
  count: number
}

function typeRamp(elements: Probe['elements']): TypeRampRow[] {
  const seen = new Map<string, TypeRampRow>()
  for (const element of elements) {
    if (!element.text?.trim()) continue
    const family =
      element.style.font
        .split(',')[0]
        ?.replace(/^["']|["']$/g, '')
        .trim() ?? ''
    const key = `${family}|${element.fontSizePx}|${element.fontWeight}|${element.style.lineHeight}`
    const row = seen.get(key)
    if (row) {
      row.count += 1
      continue
    }
    seen.set(key, {
      font: family,
      size: element.fontSizePx,
      weight: element.fontWeight,
      lineHeight: element.style.lineHeight,
      count: 1,
    })
  }
  return [...seen.values()].sort((a, b) => b.size - a.size || a.font.localeCompare(b.font)).slice(0, 12)
}

/** Colors actually painted, most used first. Text colors and backgrounds are
 *  counted together: a spec lists the palette the design uses. */
function colorUsage(elements: Probe['elements']): { color: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const element of elements) {
    for (const color of [element.style.color, element.style.background]) {
      if (!color || color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue
      counts.set(color, (counts.get(color) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count || a.color.localeCompare(b.color))
    .slice(0, 16)
}

/** Distinct px values out of a CSS shorthand (padding, margin, gap): the
 *  spacing the design actually uses, ascending. */
function scaleFrom(values: string[]): number[] {
  const found = new Set<number>()
  for (const value of values) {
    for (const token of splitTop(value)) {
      const size = length(token)
      if (size && size.unit === 'px' && size.value !== 0) found.add(size.value)
    }
  }
  return [...found].sort((a, b) => a - b)
}

/** The document's outline: headings and section boundaries in document order,
 *  indented by nesting — what a developer reads to find each block. */
function outline(elements: Probe['elements']): string[] {
  const rows: string[] = []
  const byIndex = elements
  for (const element of byIndex) {
    const heading = /^h[1-6]$/.test(element.tag)
    const landmark = ['section', 'header', 'footer', 'nav', 'main', 'aside', 'form'].includes(element.tag)
    if (!heading && !landmark) continue
    let depth = 0
    let parent = element.parentIndex
    while (parent !== undefined && byIndex[parent]) {
      const ancestor = byIndex[parent]!
      if (
        /^h[1-6]$/.test(ancestor.tag) ||
        ['section', 'header', 'footer', 'nav', 'main', 'aside', 'form'].includes(ancestor.tag)
      )
        depth += 1
      parent = ancestor.parentIndex
    }
    const label = element.text?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''
    rows.push(
      `${'  '.repeat(Math.min(depth, 6))}- \`${element.tag}\` ${label ? `— ${label}` : ''} \`${element.selector}\``,
    )
    if (rows.length >= 40) break
  }
  return rows
}

/** spec.md for one frame: the measurements a developer builds from, plus the
 *  verification report that says whether the design passed its checks. It is
 *  the handoff artifact that a screenshot cannot be — exact values, selectors
 *  and the findings that were fixed or waived. */
export function specMd(
  frame: Frame,
  report: FrameReview | undefined,
  probe: Probe,
  tokens: DesignTokens | undefined,
): string {
  const ramp = typeRamp(probe.elements)
  const colors = colorUsage(probe.elements)
  const spacing = scaleFrom(probe.elements.map((e) => `${e.style.padding} ${e.style.margin} ${e.style.gap}`))
  const radii = scaleFrom(probe.elements.map((e) => e.style.borderRadius))
  const rows = outline(probe.elements)

  const summary = report?.summary ?? {}
  /* a report names the document it describes: one whose hash no longer matches
     is not evidence about this frame, and the delivery gate reads it the same
     way — a spec must not ship a pass for a document nobody checked */
  const current = report !== undefined && report.htmlSha === frameSha(frame, tokens)
  const reportLines = report
    ? current
      ? [
          `- Verdict: **${report.verdict}** — checked ${new Date(report.reviewedAt).toISOString()} by ${report.reviewedBy}`,
          `- Counters: ${Object.entries(summary)
            .map(([key, value]) => `${key} ${value}`)
            .join(', ')}`,
          ...(report.verdict === 'fail'
            ? [
                '- This document did NOT pass its checks. The findings below are what has to change before it is delivered.',
              ]
            : []),
        ]
      : [
          `- The last check (${report.verdict}, ${new Date(report.reviewedAt).toISOString()} by ${report.reviewedBy}) ran on an EARLIER version of this document — it changed afterwards, so that result does not describe what is exported here.`,
          '- Run `ready_for_review` and export again to ship a verified spec.',
        ]
    : ['- No verification report for this frame yet. Run `ready_for_review` before delivering it.']

  return [
    `# ${frame.name} — build spec`,
    '',
    `Frame \`${frame.id}\` on canvas \`${frame.canvasId}\` — ${Math.round(frame.width)}x${Math.round(frame.height)}px.`,
    `Document: ${probe.document.width}x${probe.document.height}px rendered, ${probe.document.htmlChars} characters of HTML.`,
    frame.updatedBy ? `Last written by ${frame.updatedBy}.` : '',
    '',
    '## Verification',
    '',
    ...reportLines,
    '',
    '## Type ramp',
    '',
    ...(ramp.length
      ? [
          '| Family | Size | Weight | Line height | Uses |',
          '| --- | --- | --- | --- | --- |',
          ...ramp.map(
            (row) =>
              `| ${row.font || '(inherited)'} | ${row.size}px | ${row.weight} | ${row.lineHeight} | ${row.count} |`,
          ),
        ]
      : ['_No text elements found._']),
    '',
    '## Colors',
    '',
    ...(colors.length
      ? ['| Value | Uses |', '| --- | --- |', ...colors.map((row) => `| \`${row.color}\` | ${row.count} |`)]
      : ['_No painted colors found._']),
    '',
    '## Spacing & shapes',
    '',
    ...(spacing.length ? [`- Padding/margin/gap values (px): ${spacing.join(', ')}`] : []),
    ...(radii.length ? [`- Border radii (px): ${radii.join(', ')}`] : []),
    ...(spacing.length || radii.length ? [] : ['_No spacing or radius values found._']),
    '',
    '## Structure',
    '',
    ...(rows.length ? rows : ['_No headings or section boundaries found._']),
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

/** AGENTS.md: what an agent needs to work on this canvas — where it is, how to
 *  reach it, what to read first, and what the delivery gate requires. */
export function agentsMd(canvas: { id: string; name: string }, mcpUrl: string): string {
  return `# Working on the \`${canvas.name}\` canvas

This directory is an export of a Doop canvas (\`${canvas.id}\`). Doop is a multiplayer
design canvas: humans edit it in a browser while agents edit the same frames over MCP.

## Reaching the canvas

- MCP endpoint: \`${mcpUrl}\` (Streamable HTTP, OAuth — your client will run the browser
  approval flow on first connect).
- Canvas id: \`${canvas.id}\`. Pass it as \`canvas_id\` to the tools that need it.
- Read \`get_canvas\` before editing: it lists every frame with its size and who last
  touched it, and \`get_guide\` (topic \`doop-instructions\`) carries the full working
  doctrine.

## How work is delivered here

- Stream a design with \`append_frame_html\` so the humans watching see it build; use
  \`edit_frame_html\` for targeted changes to an existing frame.
- \`ready_for_review\` runs the quality gate — token conformance, accessibility, layout
  and content checks at three widths — and records the result against the exact
  document it checked. Any later edit invalidates it.
- The ship paths (\`create_release\`, \`publish_canvas\`, \`open_pull_request\`, \`restore_release\`)
  refuse a canvas whose frames you changed and did not verify. Fix what the report names, then
  call \`ready_for_review\` again.
- \`undo_last_change\` puts a frame back the way it was before your last write; it
  refuses when someone else has changed the frame since, because their work is not
  yours to discard.
- Pass \`expected_updated_at\` on writes. A frame that moved under you comes back as a
  conflict instead of silently winning.

## Files here

- \`design/*.html\` — each frame's document, self-contained.
- \`design/DESIGN.md\` — the canvas's design system, in prose.
- \`design/tokens.dtcg.json\` — the same tokens in W3C DTCG 2025.10 form.
- \`design/tokens.css\`, \`design/tailwind.css\` — the tokens as CSS and as a Tailwind v4 theme.
`
}

interface Extracted {
  css: string
  jsx: string
  notes: string[]
}

/** Walk the rendered body and emit JSX, hoisting <style> into `css`. */
async function extract(frame: Frame): Promise<Extracted> {
  /* `tokens: null`: the extraction reads the frame's own document. Binding the
     canvas's current tokens here would put today's token rules into an export
     that is supposed to carry the design it was made from (and a release's
     frozen tokens are passed in by the caller, not read from the canvas). */
  const loaded = await loadFramePage(frame, { tokens: null })
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
  /** the frame's `@font-face` rules. They are not selectors, so the scoping
   *  walk skips them; a handoff that drops them renders in the fallback. */
  fontFaces: string
  /** `<link rel="stylesheet">` hrefs the frame loads. A CDN sheet cannot be
   *  read cross-origin, so its href is what an offline export can carry. */
  links: string[]
}

/** The frame's stylesheets, with every selector scoped under `scope`. */
async function scopedCss(frame: Frame, scope: string): Promise<FrameCss> {
  const loaded = await loadFramePage(frame, { tokens: null })
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

      /* @font-face lives beside the selectors, not among them: a scoping walk
         would rewrite nothing and the export would lose the typeface */
      const fontFaces = (rules: CSSRuleList): string => {
        let out = ''
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSFontFaceRule) out += `@font-face {${rule.style.cssText}}\n`
          else if (rule instanceof CSSMediaRule) out += fontFaces(rule.cssRules)
          else if (rule instanceof CSSSupportsRule) out += fontFaces(rule.cssRules)
        }
        return out
      }

      /* A sheet the frame pulls in with `@import` (a webfont CDN, usually) is
         not in `document.styleSheets` as its own entry, and its `@font-face`
         rules are not readable from here — so its href travels as an import of
         its own, or the exported document renders in a fallback face. */
      const importsOf = (rules: CSSRuleList): string[] => {
        const out: string[] = []
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSImportRule) out.push(rule.href)
          else if (rule instanceof CSSMediaRule) out.push(...importsOf(rule.cssRules))
        }
        return out
      }

      let all = ''
      let unscoped = ''
      let faces = ''
      const imported: string[] = []
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          unscoped += walkRaw(sheet.cssRules)
          all += walk(sheet.cssRules, '')
          faces += fontFaces(sheet.cssRules)
          imported.push(...importsOf(sheet.cssRules))
        } catch {
          /* a cross-origin sheet cannot be read; its href is carried below so
             the export can still load it */
        }
      }
      const links = [
        ...new Set([
          ...imported,
          ...Array.from(document.querySelectorAll('link[rel~="stylesheet" i]'))
            .map((el) => el.getAttribute('href') ?? '')
            .filter(Boolean),
        ]),
      ]
      return { scoped: all, raw: unscoped, fontFaces: faces, links }
    }, scope)) as { scoped: string; raw: string; fontFaces: string; links: string[] }
    return { css: result.scoped, raw: result.raw, fontFaces: result.fontFaces, links: result.links }
  } finally {
    await loaded.close()
  }
}

export interface CanvasBundle {
  html: string
  notes: string[]
  /** the fonts every frame needs, as CSS an offline document can carry:
   *  `@import` lines for the sheets the frames linked, then their `@font-face`
   *  rules. Empty when no frame declares a font. */
  fontsCss: string
}

/** A stylesheet href as an `@import` — an offline document cannot keep a
 *  `<link>` to a CDN it may not reach, but the import is the same request.
 *  The href comes from frame HTML, and this string is inlined into a `<style>`
 *  element, so the characters that could end the element or the string are
 *  percent-encoded rather than emitted. */
function fontImport(href: string): string {
  const encoded = href.replace(/["'<>\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `@import url("${encoded}");`
}

/** The fonts a set of frames needs, deduplicated and in document order:
 *  imports for the sheets they link, then every `@font-face` they declare. */
function collectFonts(frames: { links: string[]; fontFaces: string }[]): string {
  const imports: string[] = []
  const faces: string[] = []
  for (const frame of frames) {
    for (const href of frame.links) {
      /* a relative sheet is the frame's own CSS, already in the bundle */
      if (!/^https?:\/\//i.test(href)) continue
      const line = fontImport(href)
      if (!imports.includes(line)) imports.push(line)
    }
    for (const rule of frame.fontFaces.split(/\n(?=@font-face)/)) {
      const trimmed = rule.trim()
      if (trimmed && !faces.includes(trimmed)) faces.push(trimmed)
    }
  }
  return [...imports, ...faces].join('\n')
}

/** Every frame on the canvas as one self-contained document. */
export async function htmlBundle(frames: Frame[], tokens?: DesignTokens): Promise<CanvasBundle> {
  const notes: string[] = []
  const sections: string[] = []
  const seen = new Set<string>()
  const styles: string[] = []

  const sheets: FrameCss[] = []
  for (const [index, frame] of frames.entries()) {
    const scope = `[data-frame="${frame.id}"]`
    const sheet = await scopedCss(frame, scope)
    const { css, raw } = sheet
    sheets.push(sheet)
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

  const fontsCss = collectFonts(sheets)
  const head = [
    '<meta charset="utf-8">',
    '<title>Doop canvas export</title>',
    tokens ? `<style>${cssForTokens(tokens)}</style>` : '',
    /* the frames' fonts travel with the document: a bundle opened offline must
       render in the typeface it was designed in */
    fontsCss ? `<style>\n${fontsCss}\n</style>` : '',
    `<style>\nbody { margin: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 48px; padding: 48px; }\n[data-frame] { position: relative; }\n${styles.join('\n')}\n</style>`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    html: `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body>\n${sections.join('\n')}\n</body>\n</html>\n`,
    notes,
    fontsCss,
  }
}

/* ---- assets ---- */

/** A file to write into an export, with its bytes. */
export interface ExportFile {
  name: string
  content: Buffer | string
  time?: number
}

/** One asset to bundle: already fetched, so the export cannot half-succeed. */
export interface BundledAsset {
  /** `/a/<id>.<ext>` path as it appears in the frame HTML */
  url: string
  /** the file's path inside the export, e.g. `assets/ab12.png` */
  file: string
  data: Buffer
  time?: number
}

/** Rewrite every `/a/<id>.<ext>` reference to where the asset lands in the
 *  export, and report the third-party URLs that cannot travel with it.
 *
 *  `prefix` is the path from the file doing the referencing to the archive
 *  root: `canvas.html` uses `assets/…`, a document inside `frames/` uses
 *  `../assets/…`. */
export function rewriteAssetUrls(html: string, prefix: string): { html: string; external: string[] } {
  /* `/a/<id>.<ext>` -> `<prefix>assets/<id>.<ext>`: the same bytes, at the path
     the archive writes them to. The lookbehind keeps it to this instance's own
     absolute paths: a third-party URL that happens to contain `/a/` is left
     alone (and reported as external, below). */
  const rewritten = html.replace(
    /(?<![\w.:/-])\/a\/([A-Za-z0-9_-]+\.[a-z0-9]+)/g,
    (_url, file: string) => `${prefix}assets/${file}`,
  )
  const external: string[] = []
  for (const [, src] of html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    if (src && !external.includes(src)) external.push(src)
  }
  return { html: rewritten, external }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** The rendered body markup of a frame, stylesheets excluded. */
async function bodyOf(frame: Frame): Promise<string> {
  const loaded = await loadFramePage(frame, { tokens: null })
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

/* ------------------------------------------------------------------ */
/* The handoff: a canvas as the files a repository holds               */

/** The canonical public origin, mirrored from `auth.ts` rather than imported:
 *  auth.ts builds the whole better-auth stack when it loads, and these helpers
 *  are imported by unit tests that never start a server. githubApp.ts mirrors
 *  the same constant for the same reason. */
const PUBLIC_ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

/** A handoff that cannot be built at all: no such canvas, or a release that is
 *  not this canvas's. `code` is what `mcpErrors.codeFor` reads, so the tool
 *  that called this answers with the same `not_found` the inline lookup did. */
export class HandoffError extends Error {
  readonly code: McpErrorCode

  constructor(message: string, code: McpErrorCode = 'not_found') {
    super(message)
    this.name = 'HandoffError'
    this.code = code
  }
}

/** A path-safe base name: `Hero — pricing / v2` -> `hero-pricing-v2`. */
function slug(name: string, fallback: string): string {
  const cleaned = name.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '')
  return cleaned.toLowerCase() || fallback
}

/** The base name a frame gets in the handoff, deduped by id when two frames
 *  in the exported set share a name so neither overwrites the other. */
export function handoffFileName(frame: Frame, exported: Frame[]): string {
  const base = slug(frame.name, 'frame')
  /* the set being exported, not the live canvas: a handoff pinned to a release
     can carry frames that were renamed or deleted since */
  const clash = exported.filter((f) => slug(f.name, 'frame') === base)
  return clash.length > 1 ? `${base}-${frame.id}` : base
}

/** The same naming for the component library: two entries called "Button"
 *  would otherwise write to the same file. */
function componentFileName(component: Component, exported: Component[]): string {
  const base = slug(component.name, 'component')
  const clash = exported.filter((c) => slug(c.name, 'component') === base)
  return clash.length > 1 ? `${base}-${component.id}` : base
}

/** The asset's bytes as text, or undefined when they are not valid UTF-8 —
 *  which is what decides whether a file can go through the commit API. */
function decodeText(data: Buffer): string | undefined {
  const text = data.toString('utf8')
  return text.includes('\uFFFD') ? undefined : text
}

/** Everything a repository needs from a canvas: the frame documents, their
 *  React components and build specs, the component library, the design system
 *  in three forms, and the assets that could travel as text. */
export interface HandoffBundle {
  /** the repository files, keyed by the path they are written to */
  files: { path: string; content: string }[]
  /** what the export could not carry: third-party URLs, frames that would not
   *  render, assets that could not be read. README.md says the same, for a
   *  reader who never sees this object. */
  notes: string[]
  /** the pull request this file set is meant to be opened as */
  pr: { title: string; body: string }
}

/** A canvas as the file set of a design handoff — the same documents
 *  `open_pull_request` commits, built without a GitHub connection so any
 *  surface can produce them.
 *
 *  Rendering is required (JSX and specs come from the browser), so this is
 *  async; a frame or component that cannot be rendered still ships what it has
 *  and says so in `notes` rather than failing the handoff.
 *
 *  `opts.releaseId` exports the frozen release — its frames and its tokens —
 *  instead of the live canvas, so a handoff matches the link that was sent.
 *  `opts.pageId` narrows the export to one page. */
export async function handoffFiles(
  canvasId: string,
  opts: { releaseId?: string; pageId?: string } = {},
): Promise<HandoffBundle> {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new HandoffError(`no canvas with id ${canvasId}`)

  let release: CanvasRelease | undefined
  if (opts.releaseId) {
    release = await persist.getRelease(opts.releaseId)
    if (!release || release.canvasId !== canvasId) throw new HandoffError(`no release ${opts.releaseId} on this canvas`)
  }

  /* a release that froze no tokens of its own falls back to the canvas's, the
     way the inline handoff did: an old release is not a reason to ship no
     design system */
  const tokens = release?.tokens ?? canvas.tokens
  /* a release handoff carries the frozen frames; the live path drops demo
     frames, which are product content rather than the canvas's own work */
  const source = release ? persist.releaseFrames(release) : canvas.frames.filter((f) => !f.demo)
  const frames = source.filter((f) => opts.pageId === undefined || f.pageId === opts.pageId)
  const notes: string[] = []
  const files: { path: string; content: string }[] = []

  for (const frame of frames) {
    const name = handoffFileName(frame, frames)
    const linked = rewriteAssetUrls(frame.html, './')
    files.push({ path: `design/${name}.html`, content: linked.html })
    for (const url of linked.external) {
      if (!notes.includes(url)) notes.push(url)
    }
    try {
      const react = await htmlToReact(frame.html, { name: frame.name, tokens, frameId: frame.id })
      files.push({ path: `design/${name}.jsx`, content: rewriteAssetUrls(react.jsx, './').html })
    } catch {
      notes.push(`no React component for design/${name}.html: the frame could not be rendered`)
    }
    try {
      const probe = await probeFrame(frame)
      const [report] = await persist.listFrameReviews(frame.id, 1)
      files.push({ path: `design/${name}.spec.md`, content: specMd(frame, report, probe, tokens) })
    } catch {
      notes.push(`no spec for design/${name}.html: the frame could not be rendered to measure it`)
    }
  }

  /* assets that are text (SVG, CSS) travel with the branch; binary ones cannot
     go through the commit API as text, so they are named for the developer */
  const binaries: string[] = []
  for (const id of [...new Set(frames.flatMap((f) => [...assets.extractAssetIds(f.html)]))]) {
    const asset = await assets.getCanvasAsset(canvasId, id)
    if (!asset) {
      notes.push(`asset ${id} could not be read and is not in this handoff`)
      continue
    }
    const file = asset.url.replace(/^\/a\//, '')
    const text = decodeText(asset.data)
    if (text === undefined) {
      binaries.push(`design/assets/${file}`)
      continue
    }
    files.push({ path: `design/assets/${file}`, content: text })
  }

  /* the component library is the canvas's reusable design, so it ships as code
     too — one React component per entry, named the way the frames are */
  const library = store.listComponents(canvasId)
  const instances = new Map<string, number>(
    actions.listComponentSummaries(canvasId).map((entry) => [entry.id, entry.instanceCount]),
  )
  const design: DesignComponent[] = []
  for (const component of library) {
    const path = `design/components/${componentFileName(component, library)}.jsx`
    const instanceCount = instances.get(component.id)
    design.push({
      name: component.name,
      ...(component.description ? { description: component.description } : {}),
      width: component.width,
      height: component.height,
      ...(instanceCount === undefined ? {} : { instanceCount }),
      path,
    })
    try {
      const react = await htmlToReact(component.html, { name: component.name, tokens })
      /* a component sits one directory below the assets it references */
      files.push({ path, content: rewriteAssetUrls(react.jsx, '../').html })
    } catch {
      notes.push(`no React component for ${path}: the library entry could not be rendered`)
    }
  }
  /* a release freezes the frames and the tokens, not the library: say so rather
     than let a reader take today's components for the released design */
  if (release && library.length) {
    notes.push('the component library is not part of a release: it is the canvas’s library today')
  }

  files.push(
    ...(tokens
      ? [
          { path: 'design/tokens.css', content: cssForTokens(tokens) },
          { path: 'design/tokens.dtcg.json', content: tokensDtcg(tokens) },
          { path: 'design/tailwind.css', content: tailwindThemeCss(tokens) },
        ]
      : []),
    {
      path: 'design/DESIGN.md',
      /* the exported set, not the live canvas: a DESIGN.md that lists frames the
         reader does not have in front of them describes a different handoff */
      content: designMd(
        tokens,
        { name: canvas.name, frames, ...(canvas.breakpoints ? { breakpoints: canvas.breakpoints } : {}) },
        (frame) => `design/${handoffFileName(frame, frames)}.html`,
        design,
      ),
    },
    { path: 'design/AGENTS.md', content: agentsMd(canvas, `${PUBLIC_ORIGIN}/mcp`) },
    {
      path: 'design/README.md',
      content: [
        '# Design handoff',
        '',
        `Exported from doop canvas \`${canvas.id}\` (${canvas.name}).`,
        ...(release ? [`This is the frozen release \`${release.id}\` (“${release.name}”).`] : []),
        '',
        'Each `design/*.html` is a self-contained frame document; open it in a browser to see the design.',
        'The matching `.jsx` is the same design as a React component and `.spec.md` is its build spec:',
        'measurements, the type ramp, the colors, the structure outline and the verification report it passed.',
        ...(library.length
          ? ['`design/components/*.jsx` is the canvas component library, one React component per entry.']
          : []),
        '`tokens.dtcg.json` is the design system in W3C Design Tokens form; `DESIGN.md` is the same system in prose.',
        '`tailwind.css` is the same tokens as a Tailwind v4 `@theme` block — it carries both Tailwind’s own',
        'namespaces and the `--space-*`/`--weight-*` names frames are authored against.',
        '',
        ...(binaries.length
          ? [
              'These image assets could not be committed as text — add them next to the frames at the same path:',
              ...binaries.map((path) => `- ${path}`),
              '',
            ]
          : []),
        ...(notes.length ? ['Notes:', ...notes.map((note) => `- ${note}`), ''] : []),
      ].join('\n'),
    },
  )

  const preview = release ? `${PUBLIC_ORIGIN}/p/${canvasId}/${release.id}` : undefined
  return {
    files,
    notes,
    pr: {
      title: `Design handoff: ${canvas.name}`,
      body: [
        `Design handoff for **${canvas.name}** (\`${canvasId}\`).`,
        '',
        `${frames.length} frame(s) exported${release ? ` from the frozen release “${release.name}”` : ''}.`,
        ...(opts.pageId ? [`One page only: \`${opts.pageId}\`.`] : []),
        ...(preview ? ['', `Preview: ${preview}`] : []),
        '',
        'Files:',
        ...files.map((file) => `- \`${file.path}\``),
        ...(notes.length ? ['', 'Notes:', ...notes.map((note) => `- ${note}`)] : []),
        '',
      ].join('\n'),
    },
  }
}
