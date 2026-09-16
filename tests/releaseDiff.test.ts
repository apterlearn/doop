import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import * as persist from '../server/db/persist.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import { diffRelease } from '../server/releaseDiff.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* "What changed since the release I sent the client" — the question the
   release snapshot alone cannot answer, because the canvas it froze has moved
   on since. The comparison is proved case by case: untouched, edited, deleted,
   added, and a release id that belongs to somebody else's canvas. Releases
   live in the database, so this file drives the real one. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-release-diff-'))

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  /* the same drain the server runs on shutdown: frame writes are debounced, and
     a pending one would be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

const OWNER_ID = 'release-diff-owner'
const actor = actions.resolveActor({ name: 'alice', kind: 'user' })

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;background:#fff}</style></head><body>${body}</body></html>`

let counter = 0
let canvas: Canvas
let hero: Frame
let pricing: Frame

beforeEach(() => {
  counter += 1
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvas = store.createCanvas(`Handoff ${counter}`, OWNER_ID)
  hero = store.createFrame(canvas.id, { name: 'Hero', html: page('<h1>first</h1>'), width: 800, height: 600 }, 'Owner')!
  pricing = store.createFrame(
    canvas.id,
    { name: 'Pricing', html: page('<p>pricing</p>'), width: 800, height: 600 },
    'Owner',
  )!
})

/** Freeze a canvas the way create_release does: the non-demo frames with the
 *  fields a render needs, and nothing that can change afterwards. */
async function freeze(c: Canvas, name = 'v1'): Promise<persist.CanvasRelease> {
  const release: persist.CanvasRelease = {
    id: nanoid(10),
    canvasId: c.id,
    name,
    frames: c.frames
      .filter((f) => !f.demo)
      .map((f) => ({
        id: f.id,
        name: f.name,
        width: f.width,
        height: f.height,
        x: f.x,
        y: f.y,
        html: f.html,
        z: f.z,
        locked: f.locked,
        hidden: f.hidden,
        rotation: f.rotation,
        opacity: f.opacity,
        ...(f.pageId ? { pageId: f.pageId } : {}),
      })),
    ...(c.tokens ? { tokens: c.tokens } : {}),
    createdAt: Date.now(),
    createdBy: 'Owner',
  }
  await persist.saveRelease(release)
  return release
}

describe('diffRelease', () => {
  it('reports an untouched release as all unchanged, without rendering', async () => {
    const release = await freeze(canvas)

    const diff = await diffRelease(canvas.id, release.id)

    expect(diff.releaseName).toBe('v1')
    expect(diff.changedCount).toBe(0)
    /* exact objects: an unchanged frame carries no ratio and no line counts */
    expect(diff.frames).toEqual([
      { frameId: hero.id, name: 'Hero', changed: false, status: 'unchanged' },
      { frameId: pricing.id, name: 'Pricing', changed: false, status: 'unchanged' },
    ])
  })

  it('reports an edited frame as changed, naming the lines that moved', async () => {
    const release = await freeze(canvas)
    /* resized as well as rewritten, so the comparison is the line diff even
       where a browser is available to render */
    actions.updateFrame(hero.id, { html: page('<h1>second</h1>'), width: 900 }, actor)

    const diff = await diffRelease(canvas.id, release.id)

    expect(diff.changedCount).toBe(1)
    const edited = diff.frames.find((f) => f.frameId === hero.id)!
    expect(edited).toEqual({
      frameId: hero.id,
      name: 'Hero',
      changed: true,
      status: 'changed',
      textAdded: 1,
      textRemoved: 1,
    })
    expect(diff.frames.find((f) => f.frameId === pricing.id)!.status).toBe('unchanged')
  })

  it('reports a frame deleted since the release as removed', async () => {
    const release = await freeze(canvas)
    actions.deleteFrame(pricing.id, actor)

    const diff = await diffRelease(canvas.id, release.id)

    expect(diff.changedCount).toBe(1)
    expect(diff.frames.find((f) => f.frameId === pricing.id)).toEqual({
      frameId: pricing.id,
      name: 'Pricing',
      changed: true,
      status: 'removed',
    })
    expect(diff.frames.find((f) => f.frameId === hero.id)!.status).toBe('unchanged')
  })

  it('reports a frame created since the release as added', async () => {
    const release = await freeze(canvas)
    const fresh = store.createFrame(canvas.id, { name: 'FAQ', html: page('<p>faq</p>') }, 'Owner')!

    const diff = await diffRelease(canvas.id, release.id)

    expect(diff.changedCount).toBe(1)
    expect(diff.frames.find((f) => f.frameId === fresh.id)).toEqual({
      frameId: fresh.id,
      name: 'FAQ',
      changed: true,
      status: 'added',
    })
    expect(diff.frames.filter((f) => f.status === 'unchanged')).toHaveLength(2)
    /* the release's frames come first, the additions after them */
    expect(diff.frames.map((f) => f.status)).toEqual(['unchanged', 'unchanged', 'added'])
  })

  it('refuses a release id that belongs to another canvas, or to nothing', async () => {
    const other = store.createCanvas('Someone else', 'other-owner')
    store.createFrame(other.id, { name: 'Their hero', html: page('<h1>theirs</h1>') }, 'Owner')
    const foreign = await freeze(other)

    await expect(diffRelease(canvas.id, foreign.id)).rejects.toThrow(
      `release ${foreign.id} belongs to canvas ${other.id}, not ${canvas.id}`,
    )
    await expect(diffRelease(canvas.id, 'no-such-release')).rejects.toThrow(/no release no-such-release/)
  })
})

describe.skipIf(!findBrowserPath())('render comparison', () => {
  it('measures the changed ratio when both versions render at one size', async () => {
    const blank = page('<div style="width:100px;height:100px;background:#fff"></div>')
    actions.updateFrame(hero.id, { html: blank }, actor)
    const release = await freeze(canvas)
    actions.updateFrame(hero.id, { html: page('<div style="width:100px;height:100px;background:#000"></div>') }, actor)

    const diff = await diffRelease(canvas.id, release.id)

    const edited = diff.frames.find((f) => f.frameId === hero.id)!
    expect(edited.status).toBe('changed')
    expect(edited.changed).toBe(true)
    /* a 100x100 black square over the released 800x600 blank page — 2% of the
       pixels, with room for rasterization noise around the edges */
    expect(edited.changedRatio).toBeCloseTo(10_000 / 480_000, 3)
    expect(edited.textAdded).toBeUndefined()
  }, 30_000)
})
