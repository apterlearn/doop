import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, Frame, Page } from '../shared/types.ts'

/**
 * Integration tests for canvas Pages, run against the REAL server (see
 * ./harness.ts): a child process on a fresh PGlite database, exercised over
 * HTTP and WebSocket exactly like the browser and MCP clients. No mocks —
 * this is the same surface a self-hoster exposes to the internet.
 */

const PORT = 4982

let server: Server

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
}, 70_000)

afterAll(() => server?.stop())

/**
 * Like Client.joinWs, but resolves with the parsed `init` payload so tests
 * can assert on `canvas.pages` (the harness client discards the message).
 * No timeout guard here: vitest's per-test timeout bounds a hung socket.
 */
function joinInit(client: Client, canvasId: string): Promise<{ canvas: Canvas }> {
  let resolve!: (msg: { canvas: Canvas }) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<{ canvas: Canvas }>((res, rej) => {
    resolve = res
    reject = rej
  })
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: client.header() } })
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
  )
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d))
    if (msg.type === 'init') {
      ws.close()
      resolve(msg)
    }
  })
  ws.on('error', reject)
  return promise
}

async function getCanvas(client: Client, id: string): Promise<Canvas> {
  const res = await client.get(`/api/canvases/${id}`)
  const body = await res.text()
  expect(res.status, body).toBe(200)
  return JSON.parse(body)
}

describe('canvas pages', () => {
  let client: Client
  let canvasId: string
  let page1Id: string

  beforeAll(() => {
    client = new Client(server)
  })

  it('signs up and every new canvas boots with exactly one default page', async () => {
    await client.signUp('pages@test.dev', 'Pages Owner')
    const canvas = await (await client.post('/api/canvases', { name: 'Test' })).json()
    canvasId = canvas.id

    const fresh = await getCanvas(client, canvasId)
    const [page] = fresh.pages ?? []
    expect(page).toBeDefined()
    expect(page!.name).toBe('Page 1')
    expect(page!.position).toBe(0)
    expect(page!.canvasId).toBe(canvasId)
    page1Id = page!.id
  })

  it('frames created without pageId land on the first page', async () => {
    const frame: Frame = await (
      await client.post(`/api/canvases/${canvasId}/frames`, { name: 'Default page frame' })
    ).json()
    expect(frame.pageId).toBe(page1Id)
  })

  it('creates, renames and reorders pages', async () => {
    const res = await client.post(`/api/canvases/${canvasId}/pages`, { name: 'Landing' })
    expect(res.status).toBe(201)
    const landing: Page = await res.json()
    expect(landing.name).toBe('Landing')
    expect(landing.position).toBe(1)

    const renamed = await client.patch(`/api/pages/${landing.id}`, { name: 'Home' })
    expect(renamed.status).toBe(200)
    let pages: Page[] = (await renamed.json()).pages
    expect(pages.find((p) => p.id === landing.id)?.name).toBe('Home')

    const moved = await client.patch(`/api/pages/${landing.id}`, { position: 0 })
    expect(moved.status).toBe(200)
    pages = (await moved.json()).pages
    expect(pages.map((p) => p.id)).toEqual([landing.id, page1Id])
    expect(pages.map((p) => p.position)).toEqual([0, 1])
  })

  it('rejects bad page ids and non-integer positions', async () => {
    const bogusId = await client.patch('/api/pages/nope', { name: 'x' })
    expect(bogusId.status).toBe(404)
    expect((await bogusId.json()).error).toBe('page not found')

    const bogusPosition = await client.patch(`/api/pages/${page1Id}`, { position: 'x' })
    expect(bogusPosition.status).toBe(400)
    expect((await bogusPosition.json()).error).toBe('position must be an integer')
  })

  it('creates frames on a named page; bogus pageId is a 404', async () => {
    const landing = (await getCanvas(client, canvasId)).pages!.find((p) => p.name === 'Home')!
    const frame: Frame = await (
      await client.post(`/api/canvases/${canvasId}/frames`, { name: 'On Landing', pageId: landing.id })
    ).json()
    expect(frame.pageId).toBe(landing.id)

    const bogus = await client.post(`/api/canvases/${canvasId}/frames`, { name: 'x', pageId: 'nope' })
    expect(bogus.status).toBe(404)
    expect((await bogus.json()).error).toBe('page not found')
  })

  it('moves a frame between pages via PATCH /api/frames/:id', async () => {
    const { pages, frames } = await getCanvas(client, canvasId)
    expect(pages).toHaveLength(2) // 'Page 1' + renamed 'Home' from the reorder test
    const frame = frames.find((f) => f.name === 'On Landing')!
    const moved: Frame = await (await client.patch(`/api/frames/${frame.id}`, { pageId: page1Id })).json()
    expect(moved.pageId).toBe(page1Id)
  })
  it('refuses to delete the only page of a fresh canvas', async () => {
    const solo = await (await client.post('/api/canvases', { name: 'Solo' })).json()
    const only = (await getCanvas(client, solo.id)).pages![0]!
    const res = await client.delete(`/api/pages/${only.id}`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('cannot delete the only page')
  })

  it('deleting a page deletes its frames', async () => {
    const second: Page = await (await client.post(`/api/canvases/${canvasId}/pages`, { name: 'Sandbox' })).json()

    const f1: Frame = await (
      await client.post(`/api/canvases/${canvasId}/frames`, { name: 'A', pageId: second.id })
    ).json()
    const f2: Frame = await (
      await client.post(`/api/canvases/${canvasId}/frames`, { name: 'B', pageId: second.id })
    ).json()

    const res = await client.delete(`/api/pages/${second.id}`)
    expect(res.status).toBe(200)
    const { ok, deletedFrameIds } = await res.json()
    expect(ok).toBe(true)
    expect([...deletedFrameIds].sort()).toEqual([f1.id, f2.id].sort())

    const canvas = await getCanvas(client, canvasId)
    expect(canvas.pages!.map((p) => p.id)).not.toContain(second.id)
    expect(canvas.frames.map((f) => f.id)).toEqual(expect.not.arrayContaining([f1.id, f2.id]))
  })

  it('duplicates a page with fresh frame ids on the copy', async () => {
    const canvas = await getCanvas(client, canvasId)
    const source = canvas.pages![0]!
    const seeded: Frame[] = []
    for (const name of ['Seed A', 'Seed B']) {
      seeded.push(await (await client.post(`/api/canvases/${canvasId}/frames`, { name, pageId: source.id })).json())
    }

    const res = await client.post(`/api/pages/${source.id}/duplicate`)
    expect(res.status).toBe(201)
    const { page: copy, frames }: { page: Page; frames: Frame[] } = await res.json()
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe(`${source.name} copy`)
    expect(frames).toHaveLength(seeded.length)
    expect(frames.map((f) => f.id)).toEqual(expect.not.arrayContaining(seeded.map((f) => f.id)))
    for (const f of frames) expect(f.pageId).toBe(copy.id)

    const after = await getCanvas(client, canvasId)
    expect(after.pages).toHaveLength(canvas.pages!.length + 1)
    expect(after.frames.filter((f) => f.pageId === copy.id)).toHaveLength(seeded.length)
  })

  it('a joined ws client receives the pages in the init payload', async () => {
    await client.post(`/api/canvases/${canvasId}/pages`, { name: 'Second' })
    const msg = await joinInit(client, canvasId)
    expect(msg.canvas.pages!.map((p) => p.name)).toEqual(expect.arrayContaining(['Page 1', 'Second']))
  })
})
