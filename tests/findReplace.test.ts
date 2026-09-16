import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import * as frameLocks from '../server/frameLocks.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import { replaceInFrames } from '../server/findReplace.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* A sweep writes through the real mutation seam — version rows, the review
   gate and the lock map all sit behind it — so this file drives the real
   database: a PGlite cluster in a temp directory, migrated at boot exactly as
   the server does. Nothing here needs a browser: find and replace is text in,
   text out. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-find-replace-'))
const OWNER_ID = 'replace-owner'
const CANVAS_ID = 'c-replace'
const PAGE = 'p-replace'
const OTHER_PAGE = 'p-other'
const ACTOR = { name: 'Claude', userId: OWNER_ID }

const HOME = 'f-home'
const PRICING = 'f-pricing'
const ABOUT = 'f-about'
const WELCOME = 'f-welcome'

const ACME_HOME = '<h1>Acme</h1><p>Acme ships the thing you asked for.</p>'
const ACME_PRICING = '<h1>Acme pricing</h1>'
const GLOBEX_ABOUT = '<h1>Globex</h1><p>We are different.</p>'

beforeAll(async () => {
  /* initDb() puts PGlite under process.cwd(); vitest isolates each test file
     in its own worker, so the chdir cannot reach another file. */
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

function frame(id: string, name: string, html: string, opts: { pageId?: string; demo?: boolean } = {}): Frame {
  return {
    id,
    canvasId: CANVAS_ID,
    name,
    x: 0,
    y: 0,
    width: 1200,
    height: 900,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
    pageId: opts.pageId ?? PAGE,
    ...(opts.demo ? { demo: true } : {}),
  }
}

function seed(frames: Frame[]): void {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Replace',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames,
    pages: [PAGE, OTHER_PAGE].map((id, position) => ({
      id,
      canvasId: CANVAS_ID,
      name: `Page ${position + 1}`,
      position,
      createdAt: 0,
      updatedAt: 0,
    })),
  }
  store.init([canvas])
}

/** The canvas every sweep in this file runs against: two frames carrying the
 *  same string, one that does not, and a demo frame that does — product
 *  onboarding content, which a sweep never renames. */
function defaultFrames(): Frame[] {
  return [
    frame(HOME, 'Home', ACME_HOME),
    frame(PRICING, 'Pricing', ACME_PRICING),
    frame(ABOUT, 'About', GLOBEX_ABOUT),
    frame(WELCOME, 'Welcome', ACME_HOME, { demo: true }),
  ]
}

beforeEach(() => {
  frameLocks.clearLocks()
  actions.wire(
    () => {},
    () => {},
  )
  seed(defaultFrames())
})

describe('replacing across a canvas', () => {
  it('counts each frame and rewrites every one that carries the string', async () => {
    const result = await replaceInFrames(CANVAS_ID, { find: 'Acme', replace: 'Northwind', actor: ACTOR })

    expect(result.totalMatches).toBe(3)
    expect(result.frames).toEqual([
      { frameId: HOME, name: 'Home', matches: 2, applied: true },
      { frameId: PRICING, name: 'Pricing', matches: 1, applied: true },
      { frameId: ABOUT, name: 'About', matches: 0, applied: false },
    ])
    /* every occurrence in a frame, not just the first */
    expect(store.getFrame(HOME)!.html).toBe('<h1>Northwind</h1><p>Northwind ships the thing you asked for.</p>')
    expect(store.getFrame(PRICING)!.html).toBe('<h1>Northwind pricing</h1>')
    /* the frame with no match is untouched, and so is the demo frame: the
       welcome show is product content, not the design being renamed */
    expect(store.getFrame(ABOUT)!.html).toBe(GLOBEX_ABOUT)
    expect(store.getFrame(WELCOME)!.html).toBe(ACME_HOME)
    /* the write landed through the mutation seam, not by poking the store */
    expect(store.getFrame(HOME)!.updatedBy).toBe(ACTOR.name)
    /* and the sweep leaves no claim behind: a finished rename is nobody's
       edit, so collaborators are not locked out of the frames it touched */
    expect(frameLocks.activeLocks()).toEqual([])
  })

  it('previews the counts with dryRun and changes nothing at all', async () => {
    const before = store.getFrame(HOME)!.updatedAt

    const result = await replaceInFrames(CANVAS_ID, {
      find: 'Acme',
      replace: 'Northwind',
      actor: ACTOR,
      dryRun: true,
    })

    expect(result.totalMatches).toBe(3)
    expect(result.frames).toEqual([
      { frameId: HOME, name: 'Home', matches: 2, applied: false },
      { frameId: PRICING, name: 'Pricing', matches: 1, applied: false },
      { frameId: ABOUT, name: 'About', matches: 0, applied: false },
    ])
    expect(store.getFrame(HOME)!.html).toBe(ACME_HOME)
    expect(store.getFrame(PRICING)!.html).toBe(ACME_PRICING)
    expect(store.getFrame(HOME)!.updatedAt).toBe(before)
    expect(store.getFrame(HOME)!.updatedBy).toBe('alice')
    expect(frameLocks.activeLocks()).toEqual([])
  })

  it('sweeps only the frames it was handed, ignoring an id from elsewhere', async () => {
    const result = await replaceInFrames(CANVAS_ID, {
      find: 'Acme',
      replace: 'Northwind',
      frameIds: [PRICING, 'f-from-another-canvas'],
      actor: ACTOR,
    })

    expect(result.frames).toEqual([{ frameId: PRICING, name: 'Pricing', matches: 1, applied: true }])
    expect(result.totalMatches).toBe(1)
    expect(store.getFrame(PRICING)!.html).toBe('<h1>Northwind pricing</h1>')
    expect(store.getFrame(HOME)!.html).toBe(ACME_HOME)
  })

  it('sweeps one page when it is given a pageId', async () => {
    seed([
      frame(HOME, 'Home', ACME_HOME, { pageId: PAGE }),
      frame(PRICING, 'Pricing', ACME_PRICING, { pageId: OTHER_PAGE }),
    ])

    const result = await replaceInFrames(CANVAS_ID, {
      find: 'Acme',
      replace: 'Northwind',
      pageId: PAGE,
      actor: ACTOR,
    })

    expect(result.frames).toEqual([{ frameId: HOME, name: 'Home', matches: 2, applied: true }])
    expect(store.getFrame(PRICING)!.html).toBe(ACME_PRICING)
  })

  it('reports a frame someone else is editing and still applies the rest', async () => {
    actions.acquireFrameLock(PRICING, actions.resolveActor({ name: 'Rival', kind: 'agent' }))

    const result = await replaceInFrames(CANVAS_ID, { find: 'Acme', replace: 'Northwind', actor: ACTOR })

    /* the count is still reported for the frame that could not be written:
       the caller learns what is left to rename, not just that it came up
       short — and one busy frame did not cost it the other two */
    expect(result.totalMatches).toBe(3)
    expect(result.frames).toEqual([
      { frameId: HOME, name: 'Home', matches: 2, applied: true },
      {
        frameId: PRICING,
        name: 'Pricing',
        matches: 1,
        applied: false,
        skippedReason: expect.stringContaining('Rival'),
      },
      { frameId: ABOUT, name: 'About', matches: 0, applied: false },
    ])
    expect(store.getFrame(HOME)!.html).toBe('<h1>Northwind</h1><p>Northwind ships the thing you asked for.</p>')
    expect(store.getFrame(PRICING)!.html).toBe(ACME_PRICING)
    /* the other agent's claim is still theirs */
    expect(frameLocks.activeLocks().map((lock) => lock.agentName)).toEqual(['Rival'])
  })

  it('honours regex mode, and caseSensitive inside it', async () => {
    const mixed = (): Frame[] => [frame(HOME, 'Home', '<h1>Acme</h1><p>ACME</p>'), frame(PRICING, 'Pricing', 'acme')]
    seed(mixed())

    const loose = await replaceInFrames(CANVAS_ID, { find: 'acme', replace: 'Northwind', regex: true, actor: ACTOR })
    expect(loose.totalMatches).toBe(3)
    expect(store.getFrame(HOME)!.html).toBe('<h1>Northwind</h1><p>Northwind</p>')
    expect(store.getFrame(PRICING)!.html).toBe('Northwind')

    seed(mixed())
    const exact = await replaceInFrames(CANVAS_ID, {
      find: 'acme',
      replace: 'Northwind',
      regex: true,
      caseSensitive: true,
      actor: ACTOR,
    })
    expect(exact.totalMatches).toBe(1)
    expect(store.getFrame(HOME)!.html).toBe('<h1>Acme</h1><p>ACME</p>')
    expect(store.getFrame(PRICING)!.html).toBe('Northwind')
  })

  it('refuses a find it cannot compile before touching a frame', async () => {
    await expect(
      replaceInFrames(CANVAS_ID, { find: 'Acme (', replace: 'Northwind', regex: true, actor: ACTOR }),
    ).rejects.toThrow(/not a valid regular expression/)
    await expect(replaceInFrames(CANVAS_ID, { find: '', replace: 'Northwind', actor: ACTOR })).rejects.toThrow(
      /must not be empty/,
    )

    expect(store.getFrame(HOME)!.html).toBe(ACME_HOME)
    expect(store.getFrame(HOME)!.updatedBy).toBe('alice')
  })

  it('refuses the whole sweep on a canvas that approves writes through review', async () => {
    store.setReviewMode(CANVAS_ID, true)

    await expect(replaceInFrames(CANVAS_ID, { find: 'Acme', replace: 'Northwind', actor: ACTOR })).rejects.toThrow(
      /review/,
    )

    /* refused at the first write, so the canvas is not half-renamed — and the
       claim the refusal interrupted is given back with it */
    expect(store.getFrame(HOME)!.html).toBe(ACME_HOME)
    expect(store.getFrame(PRICING)!.html).toBe(ACME_PRICING)
    expect(frameLocks.activeLocks()).toEqual([])
  })
})
