import fs from 'node:fs/promises'
import { once } from 'node:events'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, db, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { runEvents } from '../server/db/schema.ts'
import { getRunEvents, hydrate, record } from '../server/runLog.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The Run tab's timeline is the room's live window with pages of older steps
 * behind it. The window is the ring, and the ring is bounded — it is hydrated
 * from the newest rows of `run_events` and capped — so everything a busy canvas
 * did earlier is only in the table. Two levels, matching that split:
 *
 *  - the durable read (server/db/persist.ts) against the real PGlite the
 *    server boots: a canvas with more history than the ring holds, read page by
 *    page, where the pages have to join up exactly — no step repeated across
 *    two pages, none skipped between them, and an end that says so.
 *  - the route over the real server (./harness.ts): offset 0 answers with the
 *    newest steps the ring holds, and the offsets behind it reach the steps the
 *    ring has dropped, with `next_offset` / `has_more` as the contract.
 *
 * The ring's own cap is 500, and the boot hydration fills it with at most 200
 * rows; seeding the table with a dozen steps and hydrating a three-step view of
 * them is the same situation a busy canvas is in — a ring that no longer holds
 * what the table still has — without writing 500 rows to say so.
 */

/** How many of a seeded canvas's steps the ring still holds in these cases. */
const RING_HOLDS = 3
/** How many steps the table holds: several pages' worth. */
const HISTORY = 12
/** The oldest step's time; the steps below walk back from it by the second. */
const BASE = Date.now() - 43_200_000

let tmp = ''
let canvasId = ''

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-run-paging-'))
  /* the PGlite directory is resolved from process.cwd() when initDb runs */
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

beforeEach(async () => {
  canvasId = `c-${Math.random().toString(36).slice(2, 10)}`
  /* the seeded ids below are readable rather than random, so each case starts
     from an empty table — this is a temp PGlite of this file's own */
  await db.delete(runEvents)
})

/** One seeded step, as `runLog.record` would have written it: newest first by
 *  `at`, alternating runs, and the step that wrote a frame carrying the frame,
 *  its two versions, the tool's arguments and the human actor behind it. */
function stepRow(i: number, canvas: string) {
  return {
    id: `ev-${i}`,
    canvasId: canvas,
    runId: i % 2 === 0 ? 'run-even' : 'run-odd',
    agentName: 'Doop Agent',
    at: BASE - i * 1000,
    kind: 'tool',
    name: 'set_frame_html',
    ok: true,
    ms: 7 + i,
    summary: `step ${i}`,
    args: null as string | null,
    actorKind: null as string | null,
    agentId: null as string | null,
    frameId: null as string | null,
    beforeVersionId: null as string | null,
    afterVersionId: null as string | null,
  }
}

/** The table as a canvas with real history holds it: `count` steps, the newest
 *  first in every read below. */
async function seed(canvas: string, count = HISTORY) {
  await db.insert(runEvents).values(Array.from({ length: count }, (_, i) => stepRow(i, canvas)))
}

/** The ring as a boot leaves it: the newest `holds` rows of the table, mapped
 *  by the boot's own hydrate and handed to the ring the same way index.ts does.
 *  Returns the whole table as the boot mapped it, which is what the paged read
 *  has to agree with. */
async function bootRing(canvas: string, holds = RING_HOLDS) {
  const booted = (await persist.hydrate()).runEvents.get(canvas) ?? []
  hydrate(new Map([[canvas, booted.slice(0, holds)]]))
  return booted
}

describe('the durable timeline reads back the steps the ring has dropped', () => {
  it('answers a page the ring no longer holds, newest first', async () => {
    await seed(canvasId)
    await bootRing(canvasId)

    const ring = getRunEvents(canvasId, { limit: 500 })
    expect(ring.map((e) => e.id)).toEqual(['ev-0', 'ev-1', 'ev-2'])

    const page = await persist.listRunEvents(canvasId, { limit: 5 })
    expect(page.events.map((e) => e.id)).toEqual(['ev-0', 'ev-1', 'ev-2', 'ev-3', 'ev-4'])
    /* the steps past the ring's own window are the reason this read exists */
    expect(page.events.map((e) => e.id).slice(ring.length)).toEqual(['ev-3', 'ev-4'])
    expect(page.hasMore).toBe(true)
  })

  it('maps a row exactly as the boot hydrate does, frame versions and actor included', async () => {
    await db.insert(runEvents).values([
      stepRow(0, canvasId),
      {
        ...stepRow(1, canvasId),
        args: '{"frame_id":"f1","html":"<h1>hi</h1>"}',
        actorKind: 'human',
        agentId: 'agent-h1',
        frameId: 'f1',
        beforeVersionId: 'v-1',
        afterVersionId: 'v-2',
      },
      stepRow(2, canvasId),
    ])

    const booted = (await persist.hydrate()).runEvents.get(canvasId) ?? []
    const page = await persist.listRunEvents(canvasId, { limit: 10 })

    /* one mapping, two readers: the page is the boot's own list, field for
       field — including the frame and version ids a revert reads */
    expect(page.events).toEqual(booted)
    expect(page.events[1]).toMatchObject({
      id: 'ev-1',
      name: 'set_frame_html',
      ok: true,
      ms: 8,
      summary: 'step 1',
      args: '{"frame_id":"f1","html":"<h1>hi</h1>"}',
      actorKind: 'human',
      agentId: 'agent-h1',
      frameId: 'f1',
      beforeVersionId: 'v-1',
      afterVersionId: 'v-2',
    })
    /* and a step that never carried one comes back without it */
    expect(page.events[0]).not.toHaveProperty('args')
    expect(page.events[0]).not.toHaveProperty('actorKind')
    expect(page.events[0]).not.toHaveProperty('frameId')
  })

  it('continues the next page without repeating a step, and says when the rows end', async () => {
    await seed(canvasId)
    await bootRing(canvasId)

    const first = await persist.listRunEvents(canvasId, { limit: 5 })
    const second = await persist.listRunEvents(canvasId, { limit: 5, offset: 5 })
    const third = await persist.listRunEvents(canvasId, { limit: 5, offset: 10 })

    expect(second.events.map((e) => e.id)).toEqual(['ev-5', 'ev-6', 'ev-7', 'ev-8', 'ev-9'])
    expect(third.events.map((e) => e.id)).toEqual(['ev-10', 'ev-11'])
    /* the pages join up: every step exactly once, in order, across the three */
    const paged = [...first.events, ...second.events, ...third.events].map((e) => e.id)
    expect(paged).toEqual(Array.from({ length: HISTORY }, (_, i) => `ev-${i}`))
    expect(new Set(paged).size).toBe(paged.length)

    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false])
  })

  it('answers an empty page with no more past the last row', async () => {
    await seed(canvasId)

    const page = await persist.listRunEvents(canvasId, { limit: 5, offset: HISTORY + 1 })
    expect(page).toEqual({ events: [], hasMore: false })
  })

  it('pages one run on its own', async () => {
    await seed(canvasId)
    await bootRing(canvasId)

    const first = await persist.listRunEvents(canvasId, { runId: 'run-odd', limit: 2 })
    const second = await persist.listRunEvents(canvasId, { runId: 'run-odd', limit: 2, offset: 2 })
    const third = await persist.listRunEvents(canvasId, { runId: 'run-odd', limit: 2, offset: 4 })

    expect(first.events.map((e) => e.id)).toEqual(['ev-1', 'ev-3'])
    expect([...first.events, ...second.events, ...third.events].map((e) => e.id)).toEqual([
      'ev-1',
      'ev-3',
      'ev-5',
      'ev-7',
      'ev-9',
      'ev-11',
    ])
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false])
  })

  it('breaks a shared millisecond so paging can neither skip nor repeat a step', async () => {
    /* three steps recorded in the same millisecond: without a tiebreaker the
       order within them is whatever the database feels like, and an offset
       landing inside the group would list one twice and drop another */
    await db.insert(runEvents).values([
      { ...stepRow(0, canvasId), id: 'tie-a', at: BASE },
      { ...stepRow(1, canvasId), id: 'tie-b', at: BASE },
      { ...stepRow(2, canvasId), id: 'tie-c', at: BASE },
    ])

    const one = await persist.listRunEvents(canvasId, { limit: 1, offset: 0 })
    const two = await persist.listRunEvents(canvasId, { limit: 1, offset: 1 })
    const three = await persist.listRunEvents(canvasId, { limit: 1, offset: 2 })
    const tied = [...one.events, ...two.events, ...three.events].map((e) => e.id)
    expect([...tied].sort()).toEqual(['tie-a', 'tie-b', 'tie-c'])
    expect(three.hasMore).toBe(false)

    /* and the same page reads the same way twice: the order inside the group
       is not whatever the database happened to hand back this time */
    const again = await persist.listRunEvents(canvasId, { limit: 1, offset: 0 })
    expect(again.events.map((e) => e.id)).toEqual(one.events.map((e) => e.id))
  })

  it('keeps the ring’s newest step at the head of the first page', async () => {
    await seed(canvasId)
    await bootRing(canvasId)

    const live = record({
      canvasId,
      runId: 'run-even',
      agentName: 'Doop Agent',
      kind: 'tool',
      name: 'write_frame',
      ok: true,
      summary: 'wrote the hero',
    })
    expect(getRunEvents(canvasId)[0]?.id).toBe(live.id)

    /* the mirror write is fire-and-forget — the ring above already holds the
       step — so this waits for the row rather than assuming it landed */
    await vi.waitFor(
      async () => {
        const page = await persist.listRunEvents(canvasId, { limit: 1 })
        expect(page.events.map((e) => e.id)).toEqual([live.id])
      },
      { timeout: 5_000 },
    )

    /* the ring is the newest page of the same order, which is what makes an
       offset counted across both reads land on the same step */
    const page = await persist.listRunEvents(canvasId, { limit: 4 })
    expect(page.events.map((e) => e.id)).toEqual([live.id, 'ev-0', 'ev-1', 'ev-2'])
    expect(page.hasMore).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* The route, over the real server: what the Run tab's "Load older"    */
/* presses actually read.                                              */
/* ------------------------------------------------------------------ */

/** 4996 is clear of every other test file's ports (see the other harness
 *  files); the provider stub binds an OS-assigned one, so it cannot collide. */
const PORT = 4996
const IMPLEMENTER = 'paging-implementer'
const JUDGE = 'paging-judge'
const DESIGNED_HTML = '<!doctype html><html><body><h1>Pricing</h1><p>Three tiers</p></body></html>'
const JUDGE_SUMMARY = 'three tiers, one clear call to action'

/** What the route answers a page as: the steps, the server's verdict on
 *  whether older ones exist, and the offset that reads them. */
interface TimelinePage {
  events: { id: string; kind: string; summary?: string }[]
  has_more: boolean
  next_offset?: number
}

let provider: HttpServer
let server: Server
let user: Client

/** The provider is the one fake in this file: the design engine's two calls,
 *  scripted, because the alternative is a real third-party endpoint. It is how
 *  the canvas below gets a run timeline through the deployed path rather than
 *  through a hand-written row. */
function judgeReply(): string {
  return JSON.stringify({ verdict: 'pass', summary: JUDGE_SUMMARY, issues: [] })
}

beforeAll(async () => {
  provider = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: IMPLEMENTER }, { id: JUDGE }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const { model } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }
        const content = model === IMPLEMENTER ? DESIGNED_HTML : judgeReply()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no such route' } }))
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const providerBase = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

  server = await startServer(PORT, {
    BETTER_AUTH_SECRET: 'test-secret-not-for-real-use',
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    DESIGN_LLM_BASE_URL: providerBase,
    DESIGN_LLM_API_KEY: 'test-key',
    DOOP_IMPLEMENTER_MODEL: IMPLEMENTER,
    DOOP_JUDGE_MODEL: JUDGE,
  })
  user = await new Client(server).signUp('paging@test.dev', 'Pat Paging')
}, 120_000)

afterAll(() => {
  server?.stop()
  provider?.close()
})

/** One press of "Load older", as the panel makes it. */
async function timeline(canvas: string, query = ''): Promise<TimelinePage> {
  const res = await user.get(`/api/canvases/${canvas}/run-events${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as TimelinePage
}

/** A canvas with a run on it: the brief route is the deployed path that writes
 *  a timeline, and it is the run the pages below are read back from. */
async function canvasWithRun(): Promise<{ id: string; runId: string }> {
  const canvas = (await (await user.post('/api/canvases', { name: 'Timeline' })).json()) as { id: string }
  const saved = await user.patch('/api/design-workflow', { implementerModel: IMPLEMENTER, judgeModel: JUDGE })
  expect(saved.status).toBe(200)
  const res = await user.post(`/api/canvases/${canvas.id}/brief`, { brief: 'a pricing card with three tiers' })
  expect(res.status).toBe(200)
  const run = (await res.json()) as { runId: string }
  return { id: canvas.id, runId: run.runId }
}

describe('the run-events route pages the timeline', () => {
  it('serves the newest steps at offset 0 and the steps behind them page by page', async () => {
    const canvas = await canvasWithRun()

    /* offset 0 is the live ring: the run's own lines, newest first */
    const newest = await timeline(canvas.id)
    expect(newest.events.map((e) => e.summary)).toEqual([
      JUDGE_SUMMARY,
      'judge reviewing attempt 1',
      'implementing attempt 1/3',
    ])
    expect(newest.events.every((e) => e.kind === 'status')).toBe(true)
    const ids = newest.events.map((e) => e.id)

    /* the rows behind the ring are a write-behind, so the durable answer can
       lag the lines it mirrors by a moment — this is the wait for the third
       one, which is the oldest of the three */
    await vi.waitFor(
      async () => {
        const tail = await timeline(canvas.id, '?limit=1&offset=2')
        expect(tail.events.map((e) => e.id)).toEqual([ids[2]])
      },
      { timeout: 10_000 },
    )

    /* nothing is behind the three steps the run wrote, and the server says so
       rather than the client inferring it from a length */
    const anchored = await timeline(canvas.id)
    expect(anchored.has_more).toBe(false)
    expect(anchored).not.toHaveProperty('next_offset')

    const first = await timeline(canvas.id, '?limit=2')
    expect(first.events.map((e) => e.id)).toEqual(ids.slice(0, 2))
    expect(first.has_more).toBe(true)
    expect(first.next_offset).toBe(2)

    const second = await timeline(canvas.id, `?limit=2&offset=${first.next_offset}`)
    expect(second.events.map((e) => e.id)).toEqual(ids.slice(2))
    expect(second.has_more).toBe(false)
    expect(second).not.toHaveProperty('next_offset')
    /* the second page continues from the first: no step is listed twice */
    expect(second.events.filter((e) => ids.slice(0, 2).includes(e.id))).toEqual([])

    /* past the last row: an empty page, and it says there is nothing more */
    const past = await timeline(canvas.id, '?limit=5&offset=50')
    expect(past.events).toEqual([])
    expect(past.has_more).toBe(false)

    /* one run's own timeline is the same three steps */
    const filtered = await timeline(canvas.id, `?run_id=${canvas.runId}`)
    expect(filtered.events.map((e) => e.id)).toEqual(ids)
  }, 60_000)

  it('answers an empty page with nothing more on a canvas with no run at all', async () => {
    const canvas = (await (await user.post('/api/canvases', { name: 'No run' })).json()) as { id: string }

    expect(await timeline(canvas.id)).toEqual({ events: [], has_more: false })
    expect(await timeline(canvas.id, '?offset=10&limit=5')).toEqual({ events: [], has_more: false })
    expect(await timeline(canvas.id, '?run_id=run-nobody-ran')).toEqual({ events: [], has_more: false })
  }, 30_000)
})
