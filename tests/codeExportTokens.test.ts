import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAsset, getCanvasAsset, listAssets } from '../server/assets.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import { htmlToReact, tailwindThemeCss, tokensJson } from '../server/codeExport.ts'
import { saveFrame } from '../server/db/persist.ts'
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
})
