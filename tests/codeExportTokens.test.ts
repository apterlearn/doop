import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createAsset,
  deleteAsset,
  framesReferencingAsset,
  getAsset,
  getCanvasAsset,
  listAssets,
} from '../server/assets.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import {
  agentsMd,
  designMd,
  htmlToReact,
  rewriteAssetUrls,
  specMd,
  tailwindThemeCss,
  tokensDtcg,
  tokensJson,
} from '../server/codeExport.ts'
import { saveFrame } from '../server/db/persist.ts'
import { frameSha } from '../server/review.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { DesignTokens } from '../shared/types.ts'

/* The token exports are pure string work and are asserted without a browser;
   the scoped-CSS option renders the frame like every other export here, so it
   only runs when a browser exists. The asset listing drives a real PGlite
   cluster in a temp directory — the ledger scope is SQL, and a fake would not
   test the part that matters. */

const TOKENS: DesignTokens = {
  colors: { ink: '#111110', paper: '#ffffff', accent: 'oklch(62% 0.19 260)' },
  fonts: { display: 'Fraunces', body: 'Inter', mono: 'JetBrains Mono' },
  spacing: [4, 8, 16],
  radii: [8, 16],
  shadows: ['0 1px 2px rgba(0,0,0,.2)', '0 8px 24px rgba(0,0,0,.15)'],
  type: { size: [14, 16, 32], weight: [400, 600], leading: [1.25, 1.5] },
  updatedAt: 1_700_000_000_000,
  updatedBy: 'test',
}

const FRAME_HTML = [
  '<!doctype html><html><head><style>',
  '.card { color: #111110; padding: 16px; border-radius: 8px; }',
  '</style></head><body><div class="card">Hello</div></body></html>',
].join('\n')

describe('tailwindThemeCss', () => {
  it('emits an @theme block with one --color- line per color token', () => {
    const css = tailwindThemeCss(TOKENS)
    expect(css.startsWith('@theme')).toBe(true)
    expect(css.match(/^ {2}--color-/gm)?.length).toBe(Object.keys(TOKENS.colors).length)
    expect(css).toContain('--color-ink: #111110;')
    expect(css).toContain('--color-paper: #ffffff;')
    expect(css).toContain('--color-accent: oklch(62% 0.19 260);')
  })

  it('namespaces fonts, spacing, radii and shadows like the paste block does', () => {
    const css = tailwindThemeCss(TOKENS)
    expect(css).toContain('--font-display: Fraunces;')
    expect(css).toContain('--font-body: Inter;')
    expect(css).toContain('--spacing-4: 4px;')
    expect(css).toContain('--spacing-16: 16px;')
    expect(css).toContain('--radius-8: 8px;')
    expect(css).toContain('--radius-16: 16px;')
    expect(css).toContain('--shadow-1: 0 1px 2px rgba(0,0,0,.2);')
    expect(css).toContain('--shadow-2: 0 8px 24px rgba(0,0,0,.15);')
  })

  it('carries the render-path spellings as aliases so a frame var() resolves', () => {
    const css = tailwindThemeCss(TOKENS)
    const valueOf = (name: string) => {
      const line = css.split('\n').find((candidate) => candidate.startsWith(`  ${name}: `))
      return line?.slice(`  ${name}: `.length, -1)
    }
    /* Tailwind's own namespaces, so gap-8 / font-semibold resolve */
    for (const size of TOKENS.spacing!) {
      expect(valueOf(`--spacing-${size}`)).toBe(`${size}px`)
      expect(valueOf(`--space-${size}`)).toBe(`${size}px`)
    }
    for (const weight of TOKENS.type!.weight!) {
      expect(valueOf(`--font-weight-${weight}`)).toBe(String(weight))
      expect(valueOf(`--weight-${weight}`)).toBe(String(weight))
    }
    /* the same literal values under the names cssForTokens injects into every
       frame — var(--space-8) in a frame resolves against this theme */
    expect(css).toContain('--space-8: 8px;')
    expect(css).toContain('--spacing-8: 8px;')
    expect(css).toContain('--weight-600: 600;')
    expect(css).toContain('--font-weight-600: 600;')
  })

  it('renders an empty block when the canvas has no tokens', () => {
    const css = tailwindThemeCss({ colors: {}, updatedAt: 0, updatedBy: 'test' })
    expect(css.startsWith('@theme')).toBe(true)
    expect(css).not.toContain('--color-')
  })
})

describe('tokensJson', () => {
  it('round-trips back to the input object', () => {
    expect(JSON.parse(tokensJson(TOKENS))).toEqual(TOKENS)
  })

  it('is pretty-printed', () => {
    expect(tokensJson(TOKENS)).toContain('\n  "colors": {')
  })
})

describe.skipIf(!findBrowserPath())('htmlToReact scopedCss', () => {
  it('scopes the stylesheet under [data-frame] when asked and leaves the default global', async () => {
    const scoped = await htmlToReact(FRAME_HTML, { name: 'Card', frameId: 'frame-9', scopedCss: true })
    expect(scoped.jsx).toContain('data-frame="frame-9"')
    expect(scoped.css).toContain('[data-frame="frame-9"] .card')
    expect(scoped.css).not.toContain('\n.card {')

    const plain = await htmlToReact(FRAME_HTML, 'Card')
    expect(plain.jsx).not.toContain('data-frame=')
    expect(plain.css).toContain('.card {')
  }, 60_000)

  it('accepts the options object without a name, defaulting the component name', async () => {
    const scoped = await htmlToReact(FRAME_HTML, { frameId: 'f', scopedCss: true })
    expect(scoped.component_name).toBe('Frame')
  }, 60_000)
})

/* ------------------------------------------------------------------ */
/* Asset listing                                                       */

const ASSETS_DATA = mkdtempSync(path.join(tmpdir(), 'doop-asset-listing-'))

beforeAll(async () => {
  process.chdir(ASSETS_DATA)
  await initDb()
})

afterAll(async () => {
  await closeDb()
  process.chdir(tmpdir())
  rmSync(ASSETS_DATA, { recursive: true, force: true })
})

/* 1x1 PNG */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('asset listing', () => {
  it('lists assets uploaded for a canvas newest first, with their public url', async () => {
    const first = await createAsset(PNG, { canvasId: 'c-list', uploadedBy: 'tester' })
    const second = await createAsset(PNG, { canvasId: 'c-list', uploadedBy: 'tester' })
    const { assets, total } = await listAssets('c-list')
    expect(total).toBe(2)
    expect(assets.map((asset) => asset.id)).toEqual([second.id, first.id])
    expect(assets[0]).toMatchObject({ url: `/a/${second.id}.png`, mime: 'image/png', bytes: PNG.length })
    expect(typeof assets[0]!.at).toBe('number')
  })

  it('keeps other canvases out of the listing', async () => {
    await createAsset(PNG, { canvasId: 'c-other', uploadedBy: 'tester' })
    const { assets, total } = await listAssets('c-list')
    expect(total).toBe(2)
    expect(assets.every((asset) => asset.mime === 'image/png')).toBe(true)
  })

  it('includes assets a frame references even when uploaded for another canvas', async () => {
    /* through saveFrame, the write path that maintains asset_refs — a raw
       insert would leave the projection empty and the test would lie */
    const borrowed = await createAsset(PNG, { canvasId: 'c-other', uploadedBy: 'tester' })
    saveFrame(
      {
        id: 'f-borrower',
        canvasId: 'c-borrower',
        name: 'F',
        html: `<img src="/a/${borrowed.id}.png">`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        createdAt: 1,
        updatedAt: 1,
        updatedBy: 'tester',
      },
      true,
    )
    /* persistence is fire-and-forget: wait for the projection row instead of
       a duration (same approach the frame-version tests take) */
    const deadline = Date.now() + 5000
    for (;;) {
      const { total } = await listAssets('c-borrower')
      if (total === 1) break
      if (Date.now() > deadline) throw new Error(`borrowed asset never showed up in the ledger`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const { total, assets } = await listAssets('c-borrower')
    expect(total).toBe(1)
    expect(assets[0]!.id).toBe(borrowed.id)
  })

  it('pages and reports the full total', async () => {
    for (let i = 0; i < 3; i++) await createAsset(PNG, { canvasId: 'c-page', uploadedBy: 'tester' })
    const page1 = await listAssets('c-page', { limit: 2 })
    const page2 = await listAssets('c-page', { limit: 2, offset: 2 })
    expect(page1.total).toBe(3)
    expect(page1.assets).toHaveLength(2)
    expect(page2.assets).toHaveLength(1)
    expect(page1.assets.map((asset) => asset.id)).not.toContain(page2.assets[0]!.id)
  })

  it('caps the page size', async () => {
    for (let i = 0; i < 3; i++) await createAsset(PNG, { canvasId: 'c-cap', uploadedBy: 'tester' })
    const { assets } = await listAssets('c-cap', { limit: 5000 })
    expect(assets).toHaveLength(3)
  })

  it('serves an asset back with its bytes and refuses assets outside the canvas', async () => {
    const asset = await createAsset(PNG, { canvasId: 'c-bytes', uploadedBy: 'tester' })
    const found = await getCanvasAsset('c-bytes', asset.id)
    expect(found?.mime).toBe('image/png')
    expect(found?.data.equals(PNG)).toBe(true)
    expect(found?.url).toBe(`/a/${asset.id}.png`)
    expect(await getCanvasAsset('c-somewhere-else', asset.id)).toBeUndefined()
    expect(await getCanvasAsset('c-bytes', 'missing')).toBeUndefined()
  })

  it('deletes an asset from the ledger and from storage, and tolerates a second delete', async () => {
    const asset = await createAsset(PNG, { canvasId: 'c-del', uploadedBy: 'tester' })
    expect(await getAsset(asset.id)).not.toBeNull()

    const removed = await deleteAsset(asset.id)
    expect(removed).toMatchObject({ id: asset.id, mime: 'image/png', size: PNG.length })
    /* both layers: the row is gone from the listing and the bytes are gone */
    expect(await getAsset(asset.id)).toBeNull()
    expect((await listAssets('c-del')).total).toBe(0)
    /* deleting what is not there is a miss, not a throw */
    expect(await deleteAsset(asset.id)).toBeUndefined()
  })

  it('names the frames whose html still points at an asset', async () => {
    const asset = await createAsset(PNG, { canvasId: 'c-ref', uploadedBy: 'tester' })
    saveFrame(
      {
        id: 'f-ref',
        canvasId: 'c-ref',
        name: 'F',
        html: `<img src="/a/${asset.id}.png">`,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        createdAt: 1,
        updatedAt: 1,
        updatedBy: 'tester',
      },
      true,
    )
    /* the frame row is written fire-and-forget: wait for the read to see it
       rather than for a duration */
    await vi.waitFor(async () => expect(await framesReferencingAsset('c-ref', asset.id)).toEqual(['f-ref']), {
      timeout: 5000,
    })
    /* another asset, another canvas: nothing */
    expect(await framesReferencingAsset('c-ref', 'not-referenced')).toEqual([])
    expect(await framesReferencingAsset('c-elsewhere', asset.id)).toEqual([])
  })
})

describe('tokensDtcg', () => {
  it('emits the DTCG shapes the spec defines, per token type', () => {
    const doc = JSON.parse(tokensDtcg(TOKENS)) as Record<string, Record<string, { $type: string; $value: unknown }>>
    /* a color is the value as written: the spec has no color format to normalize */
    expect(doc.color!.accent).toEqual({ $type: 'color', $value: 'oklch(62% 0.19 260)' })
    /* a font token is a stack of families, not one string */
    expect(doc.font!.mono).toEqual({ $type: 'fontFamily', $value: ['JetBrains Mono'] })
    expect(doc.font!.body).toEqual({ $type: 'fontFamily', $value: ['Inter'] })
    /* numbers carry the unit the spec requires */
    expect(doc.space!['16']).toEqual({ $type: 'dimension', $value: { value: 16, unit: 'px' } })
    expect(doc.radius!['16']).toEqual({ $type: 'dimension', $value: { value: 16, unit: 'px' } })
    /* a CSS shadow becomes the structured value, not a string */
    expect(doc.shadow!['1']).toEqual({
      $type: 'shadow',
      $value: {
        color: 'rgba(0,0,0,.2)',
        offsetX: { value: 0, unit: 'px' },
        offsetY: { value: 1, unit: 'px' },
        blur: { value: 2, unit: 'px' },
      },
    })
  })

  it('keeps a shadow it cannot parse as a string instead of inventing one', () => {
    const doc = JSON.parse(tokensDtcg({ ...TOKENS, shadows: ['var(--ring)'] })) as Record<
      string,
      Record<string, { $type: string; $value: unknown }>
    >
    expect(doc.shadow!['1']).toEqual({
      $type: 'string',
      $value: 'var(--ring)',
      $description: 'raw CSS box-shadow — not parseable into a DTCG shadow value',
    })
  })

  it('omits groups a canvas has no data for', () => {
    const doc = JSON.parse(tokensDtcg({ colors: { ink: '#000000' }, updatedAt: 0, updatedBy: 'test' })) as Record<
      string,
      unknown
    >
    expect(doc.color).toBeDefined()
    expect(doc.space).toBeUndefined()
    expect(doc.shadow).toBeUndefined()
    expect(doc.type).toBeUndefined()
  })
})

describe('specMd', () => {
  const frame = {
    id: 'f-spec',
    canvasId: 'c-spec',
    name: 'Pricing',
    x: 0,
    y: 0,
    width: 1200,
    height: 900,
    html: '<main><h1>Pricing</h1></main>',
    createdAt: 0,
    updatedAt: 1_700_000_000_000,
    updatedBy: 'Claude',
    pageId: 'p-spec',
  }

  const element = (over: Record<string, unknown>) => ({
    index: 0,
    tag: 'div',
    id: '',
    classes: [],
    selector: 'body > div',
    rect: { x: 0, y: 0, width: 100, height: 20 },
    style: {
      color: 'rgb(17, 17, 16)',
      background: 'rgba(0, 0, 0, 0)',
      font: 'Inter',
      padding: '8px',
      margin: '0px',
      gap: 'normal',
      borderRadius: '0px',
      lineHeight: '1.5',
    },
    fontSizePx: 16,
    fontWeight: 400,
    text: '',
    ...over,
  })

  const probe = {
    document: { width: 1200, height: 900, title: 'Pricing', htmlChars: 40, lang: 'en', fonts: [], fontsFailed: [] },
    elements: [
      element({ index: 0, tag: 'main', selector: 'body > main', text: '' }),
      element({
        index: 1,
        tag: 'h1',
        selector: 'body > main > h1',
        text: 'Pricing',
        fontSizePx: 32,
        fontWeight: 700,
        parentIndex: 0,
        style: { ...element({}).style, color: 'rgb(17, 17, 16)' },
      }),
    ],
  }

  it('writes the measurements and the outline', () => {
    const md = specMd(frame as never, undefined, probe as never, undefined)
    expect(md).toContain('# Pricing — build spec')
    expect(md).toContain('1200x900px')
    /* the ramp is what the document renders, deduplicated */
    expect(md).toContain('| Inter | 32px | 700 | 1.5 | 1 |')
    /* the ramp is the TEXT elements: a container with no text of its own is
       not a type style */
    expect(md).not.toContain('| Inter | 16px | 400 |')
    expect(md).toContain('`rgb(17, 17, 16)`')
    /* the outline nests by document structure and names the selector to use */
    expect(md).toContain('- `main`')
    expect(md).toContain('  - `h1` — Pricing `body > main > h1`')
  })

  it('says a frame has no report instead of implying it passed', () => {
    const md = specMd(frame as never, undefined, probe as never, undefined)
    expect(md).toContain('No verification report')
    expect(md).toContain('ready_for_review')
  })

  it('carries the verification verdict and what it found', () => {
    const md = specMd(
      frame as never,
      {
        id: 'r1',
        frameId: frame.id,
        /* the report names the document it ran on: this one matches */
        htmlSha: frameSha(frame as never, undefined),
        reviewedAt: 1_700_000_000_000,
        reviewedBy: 'Claude',
        verdict: 'fail',
        summary: { critical: 1, errors: 2 },
        viewports: [],
      } as never,
      probe as never,
      undefined,
    )
    expect(md).toContain('**fail**')
    expect(md).toContain('critical 1')
    expect(md).toContain('did NOT pass its checks')
  })

  it('does not claim a verdict for a document the report never ran on', () => {
    const md = specMd(
      frame as never,
      {
        id: 'r2',
        frameId: frame.id,
        htmlSha: 'the-hash-of-an-earlier-version',
        reviewedAt: 1_700_000_000_000,
        reviewedBy: 'Claude',
        verdict: 'pass',
        summary: {},
        viewports: [],
      } as never,
      probe as never,
      undefined,
    )
    expect(md).not.toContain('**pass**')
    expect(md).toContain('EARLIER version')
    expect(md).toContain('ready_for_review')
  })
})

/* The handoff documents are pure string work: they are what a developer or an
   agent reads when the canvas is not in front of them, so they are asserted on
   their content and their fixed section order. */
describe('designMd', () => {
  const canvas = {
    name: 'Acme',
    frames: [
      { id: 'f1', name: 'Home', width: 1440, height: 900, html: '<h1>x</h1>' },
      { id: 'f2', name: 'Pricing', width: 1440, height: 1200, html: '<h1>y</h1>' },
    ],
  } as unknown as Parameters<typeof designMd>[1]

  it('writes the fixed section order with the canvas tokens in it', () => {
    const doc = designMd(TOKENS, canvas, (frame) => `design/${frame.name.toLowerCase()}.html`)
    const order = [
      '## Overview',
      '## Colors',
      '## Typography',
      '## Layout',
      '## Elevation & Depth',
      '## Shapes',
      '## Components',
      "## Do's and Don'ts",
    ]
    const positions = order.map((heading) => doc.indexOf(heading))
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(doc).toContain('| `ink` | `#111110` |')
    expect(doc).toContain('Inter')
    expect(doc).toContain('1440x900')
    expect(doc).toContain('`design/home.html`')
  })

  it('carries the declared breakpoints and the library the export ships', () => {
    const withBreakpoints = {
      ...canvas,
      breakpoints: [
        { name: 'mobile', min_width: 390 },
        { name: 'desktop', min_width: 1280 },
      ],
    }
    const doc = designMd(TOKENS, withBreakpoints, (frame) => `design/${frame.name.toLowerCase()}.html`, [
      {
        name: 'Pricing card',
        description: 'The plan tile',
        width: 320,
        height: 480,
        instanceCount: 3,
        path: 'design/components/pricing-card.jsx',
      },
    ])
    /* the widths the canvas designs for, next to the sizes it uses */
    expect(doc).toContain('- Breakpoints: mobile from 390px, desktop from 1280px')
    /* the library is what a reader drops in; the frames are what they lay out */
    expect(doc).toContain(
      '- **Pricing card** — The plan tile (320x480, 3 instance(s)); source: `design/components/pricing-card.jsx`',
    )
    expect(doc).toContain('- **Home** — 1440x900; source: `design/home.html`')
  })

  it('names no source path when the caller does not know where the frame was written', () => {
    const doc = designMd(TOKENS, canvas)
    expect(doc).toContain('- **Home** — 1440x900')
    expect(doc).not.toContain('source:')
  })

  it('says a section is omitted rather than dropping it when the canvas has no data', () => {
    const bare = { name: 'Bare', frames: [] } as unknown as Parameters<typeof designMd>[1]
    const doc = designMd(undefined, bare)
    /* the headings stay, so a reader who expected a section learns it is
       empty rather than wondering where it went */
    expect(doc).toContain('## Elevation & Depth')
    expect(doc).toContain('_omitted — this canvas has no data for it._')
    /* and it does not claim a token set it does not have */
    expect(doc).toContain('no design tokens yet')

    /* a canvas with a partial token set says what it has, not what it lacks */
    const partial = designMd({ colors: { ink: '#111110' }, updatedAt: 0, updatedBy: 'test' }, bare)
    expect(partial).toContain('a design token set')
    expect(partial).toContain('| `ink` | `#111110` |')
  })
})

describe('agentsMd', () => {
  it('names the canvas, the endpoint and the tools an agent must not miss', () => {
    const doc = agentsMd({ id: 'c1', name: 'Acme' }, 'https://design.example.com/mcp')
    expect(doc).toContain('`c1`')
    expect(doc).toContain('https://design.example.com/mcp')
    for (const tool of [
      'get_canvas',
      'append_frame_html',
      'edit_frame_html',
      'ready_for_review',
      'complete_card',
      'hand_back',
      'undo_last_change',
      'get_guide',
    ]) {
      expect(doc).toContain(tool)
    }
    expect(doc).toContain('expected_updated_at')
  })
})

/* An export that renders offline has to carry its own bytes and its own
   typeface, and say what it could not carry. The rewrite is pure, so it is
   pinned without a browser. */
describe('rewriteAssetUrls', () => {
  const html = [
    '<div>',
    '<img src="/a/ab12cd34.png" alt="chart">',
    '<img src="/a/ef56gh78.svg" alt="logo">',
    '<img src="https://cdn.example.com/hero.jpg" alt="photo">',
    '<link rel="stylesheet" href="https://fonts.example.com/inter.css">',
    '</div>',
  ].join('')

  it('points this instance’s assets at the path the export writes them to', () => {
    const root = rewriteAssetUrls(html, '')
    expect(root.html).toContain('src="assets/ab12cd34.png"')
    expect(root.html).toContain('src="assets/ef56gh78.svg"')
    /* third-party URLs are left alone — they are reported, not rewritten */
    expect(root.html).toContain('https://cdn.example.com/hero.jpg')
  })

  it('rewrites relative to the file doing the referencing', () => {
    /* a frame document lives one directory down, so it reaches the archive's
       assets/ by going up */
    const nested = rewriteAssetUrls('<img src="/a/ab12cd34.png">', '../')
    expect(nested.html).toBe('<img src="../assets/ab12cd34.png">')
  })

  it('names the third-party URLs so the export can list them as external', () => {
    const { external } = rewriteAssetUrls(html, '')
    expect(external).toEqual(['https://cdn.example.com/hero.jpg', 'https://fonts.example.com/inter.css'])
  })

  it('leaves a document with no assets untouched', () => {
    const plain = '<h1>Just text</h1>'
    expect(rewriteAssetUrls(plain, '')).toEqual({ html: plain, external: [] })
  })

  it('does not mistake a third-party path for one of this instance’s assets', () => {
    /* `/a/` appears in plenty of other people's URLs; rewriting one would
       point the export at a file it never wrote */
    const { html: out, external } = rewriteAssetUrls(
      '<img src="https://cdn.example.com/a/ab12cd34.png"><img src="/a/ab12cd34.png">',
      '',
    )
    expect(out).toContain('src="https://cdn.example.com/a/ab12cd34.png"')
    expect(out).toContain('src="assets/ab12cd34.png"')
    expect(external).toEqual(['https://cdn.example.com/a/ab12cd34.png'])
  })
})
