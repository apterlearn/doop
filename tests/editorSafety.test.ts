import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client, startServer, type Server } from './harness.ts'
import type { Canvas, Component, Frame, Page } from '../shared/types.ts'

/**
 * Integration tests for the editor's safety surfaces, run against the REAL
 * server (see ./harness.ts): a child process on a fresh PGlite database,
 * driven over HTTP and WebSocket exactly like the browser. No mocks.
 *
 * These pin the promises that make editing safe to do. Stacking is a document
 * property, so it has to survive a reload; a frame a human locked refuses
 * content but must not refuse its own unlock, or the lock would be a trap; a
 * write based on a frame that moved on is refused whole rather than landed on
 * top of someone else's work; deleted work comes back from the trash with the
 * id and the markup it had, because that id is what comments, history and
 * every agent holding it point at; a checkpoint rollback is itself
 * checkpointed, so it too can be undone. And the trash is pinned as private:
 * it is not a way to reach someone else's deleted work.
 */

const PORT = 4994

let server: Server
let owner: Client
let stranger: Client

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  owner = new Client(server)
  await owner.signUp('owner@editor-safety.dev', 'Owner')
  stranger = new Client(server)
  await stranger.signUp('stranger@editor-safety.dev', 'Stranger')
}, 70_000)

afterAll(() => server?.stop())

async function createCanvas(client: Client, name: string): Promise<Canvas> {
  const res = await client.post('/api/canvases', { name })
  const body = await res.text()
  expect(res.status, body).toBe(200)
  return JSON.parse(body) as Canvas
}

async function createFrame(client: Client, canvasId: string, body: Record<string, unknown>): Promise<Frame> {
  const res = await client.post(`/api/canvases/${canvasId}/frames`, body)
  const text = await res.text()
  expect(res.status, text).toBe(200)
  return JSON.parse(text) as Frame
}

async function createPage(client: Client, canvasId: string, name: string): Promise<Page> {
  const res = await client.post(`/api/canvases/${canvasId}/pages`, { name })
  const text = await res.text()
  expect(res.status, text).toBe(201)
  return JSON.parse(text) as Page
}

async function getCanvas(client: Client, canvasId: string): Promise<Canvas> {
  const res = await client.get(`/api/canvases/${canvasId}`)
  const text = await res.text()
  expect(res.status, text).toBe(200)
  return JSON.parse(text) as Canvas
}

function frameOf(canvas: Canvas, frameId: string): Frame {
  const frame = canvas.frames.find((f) => f.id === frameId)
  /* every assertion below is about a frame that must still be on the canvas;
     a missing one is a failed setup, not a passing match */
  if (!frame) throw new Error(`frame ${frameId} is not on canvas ${canvas.id}`)
  return frame
}

/** The room messages this file asserts on, typed just enough to read them. */
interface RoomMessage {
  type: string
  pageId?: string
  frames?: Frame[]
}

/**
 * A socket joined to a canvas room, handing over the messages the server
 * pushes to it. `next` resolves with the first message matching the predicate
 * — including one that already arrived — so a broadcast that fires while an
 * HTTP call is in flight is never missed. Every render-backed test in this
 * suite drives the same room the browser does; here it is how a restack is
 * proven to reach the other clients, not just the caller's response body.
 */
async function joinRoom(client: Client, canvasId: string) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: client.header() } })
  const queue: RoomMessage[] = []
  const waiting: { match: (m: RoomMessage) => boolean; resolve: (m: RoomMessage) => void }[] = []
  ws.on('open', () =>
    ws.send(JSON.stringify({ type: 'join', canvasId, clientId: `t-${Math.random()}`, name: 't', kind: 'user' })),
  )
  ws.on('message', (d) => {
    const msg = JSON.parse(String(d)) as RoomMessage
    const idx = waiting.findIndex((w) => w.match(msg))
    if (idx === -1) queue.push(msg)
    else waiting.splice(idx, 1)[0]!.resolve(msg)
  })
  ws.on('error', () => {}) // the close event carries the verdict
  const next = (match: (m: RoomMessage) => boolean) =>
    new Promise<RoomMessage>((resolve, reject) => {
      const found = queue.findIndex(match)
      if (found !== -1) {
        resolve(queue.splice(found, 1)[0]!)
        return
      }
      const timer = setTimeout(() => reject(new Error('no matching room message within 8s')), 8000)
      waiting.push({
        match,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  await next((m) => m.type === 'init')
  return { next, close: () => ws.close() }
}

describe('canvas z-order', () => {
  it('persists a new stacking across a reload and announces it to the room', async () => {
    const canvas = await createCanvas(owner, 'Z order')
    const pageId = canvas.pages![0]!.id
    const back = await createFrame(owner, canvas.id, { name: 'back', pageId })
    const middle = await createFrame(owner, canvas.id, { name: 'middle', pageId })
    const front = await createFrame(owner, canvas.id, { name: 'front', pageId })
    /* an ordinary create lands on top of the page */
    expect([back.z, middle.z, front.z]).toEqual([0, 1, 2])

    const room = await joinRoom(owner, canvas.id)
    const announced = room.next((m) => m.type === 'frames:reordered' && m.pageId === pageId)
    const res = await owner.post(`/api/canvases/${canvas.id}/z-order`, {
      pageId,
      order: [front.id, back.id, middle.id],
    })
    const text = await res.text()
    expect(res.status, text).toBe(200)
    /* the answer is the page front-to-back, in the order that was posted */
    expect((JSON.parse(text) as Frame[]).map((f) => f.id)).toEqual([front.id, back.id, middle.id])
    /* and the room paints from the same list */
    expect((await announced).frames!.map((f) => f.id)).toEqual([front.id, back.id, middle.id])
    room.close()

    /* the reload: the restack is the document's, not the caller's, so z now
       runs highest-first down the page in the posted order */
    const reloaded = await getCanvas(owner, canvas.id)
    expect([frameOf(reloaded, front.id).z, frameOf(reloaded, back.id).z, frameOf(reloaded, middle.id).z]).toEqual([
      2, 1, 0,
    ])
  })

  it('refuses an unknown page and a non-array order', async () => {
    const canvas = await createCanvas(owner, 'Z order guards')
    const pageId = canvas.pages![0]!.id
    const frame = await createFrame(owner, canvas.id, { name: 'only', pageId })

    const unknown = await owner.post(`/api/canvases/${canvas.id}/z-order`, {
      pageId: 'no-such-page',
      order: [frame.id],
    })
    expect(unknown.status).toBe(404)
    expect((await unknown.json()).error).toBe('page not found')

    const bad = await owner.post(`/api/canvases/${canvas.id}/z-order`, { pageId, order: 'not-an-array' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('order must be an array of frame ids')
  })
})

describe('locked frames', () => {
  it('refuses content writes with 423 while still letting the frame be unlocked', async () => {
    const canvas = await createCanvas(owner, 'Locked frame')
    const frame = await createFrame(owner, canvas.id, { name: 'Hero', html: '<h1>shipped</h1>' })

    const locked = await owner.patch(`/api/frames/${frame.id}`, { locked: true })
    const lockedBody = await locked.text()
    expect(locked.status, lockedBody).toBe(200)
    expect(JSON.parse(lockedBody).locked).toBe(true)

    /* presentation is not content: hiding or restacking a locked frame is a
       human deciding how to look at work, not editing it */
    expect((await owner.patch(`/api/frames/${frame.id}`, { hidden: true })).status).toBe(200)

    const refused = await owner.patch(`/api/frames/${frame.id}`, { name: 'nope' })
    const refusal = await refused.text()
    expect(refused.status, refusal).toBe(423)
    expect(JSON.parse(refusal).code).toBe('frame_locked')

    const sneaky = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>sneaky</h1>' })
    expect(sneaky.status).toBe(423)

    /* the refusal wrote nothing at all */
    const held = await getCanvas(owner, canvas.id)
    expect([frameOf(held, frame.id).name, frameOf(held, frame.id).html]).toEqual(['Hero', '<h1>shipped</h1>'])

    /* the lock itself is not protected — that is what keeps it from being a trap */
    const unlocked = await owner.patch(`/api/frames/${frame.id}`, { locked: false })
    const unlockedBody = await unlocked.text()
    expect(unlocked.status, unlockedBody).toBe(200)
    expect(JSON.parse(unlockedBody).locked).toBe(false)

    const renamed = await owner.patch(`/api/frames/${frame.id}`, { name: 'Hero v2' })
    const renamedBody = await renamed.text()
    expect(renamed.status, renamedBody).toBe(200)
    expect(JSON.parse(renamedBody).name).toBe('Hero v2')
    expect(frameOf(await getCanvas(owner, canvas.id), frame.id).name).toBe('Hero v2')
  })
})

describe('stale writes', () => {
  it('answers 409 with the frame as the server has it when expected_updated_at moved on', async () => {
    const canvas = await createCanvas(owner, 'Stale writes')
    const created = await createFrame(owner, canvas.id, { name: 'Draft', html: '<p>v1</p>' })
    /* The two writes have to be a real millisecond apart or the freshness guard
       sees one base, not two — and the clock belongs to the child server
       process, so no fake timer of this worker's can move it. */
    await new Promise<void>((resolve) => setTimeout(resolve, 25))

    const base = frameOf(await getCanvas(owner, canvas.id), created.id).updatedAt
    const landed = await owner.patch(`/api/frames/${created.id}`, { name: 'Landed' })
    const afterFirst = await landed.text()
    expect(landed.status, afterFirst).toBe(200)
    expect(JSON.parse(afterFirst).updatedAt).toBeGreaterThan(base)

    /* the second write read the frame before the first one landed */
    const stale = await owner.patch(`/api/frames/${created.id}`, { name: 'Zombie', expected_updated_at: base })
    const conflict = await stale.text()
    expect(stale.status, conflict).toBe(409)
    const body = JSON.parse(conflict)
    expect(body.code).toBe('stale_frame')
    expect(body.current.id).toBe(created.id)
    expect(body.current.updatedAt).toBe(JSON.parse(afterFirst).updatedAt)

    /* refused whole: the field it tried to change is untouched */
    expect(frameOf(await getCanvas(owner, canvas.id), created.id).name).toBe('Landed')

    /* the same guard reads the ISO timestamp the MCP tools pass for it */
    const again = await owner.patch(`/api/frames/${created.id}`, {
      name: 'Landed again',
      expected_updated_at: new Date(JSON.parse(afterFirst).updatedAt as number).toISOString(),
    })
    const againBody = await again.text()
    expect(again.status, againBody).toBe(200)
    expect(JSON.parse(againBody).name).toBe('Landed again')
  })
})

describe('frame trash', () => {
  it('round-trips a deleted frame back with the same id and its html', async () => {
    const html = '<main><h1>Keep me</h1></main>'
    const canvas = await createCanvas(owner, 'Frame trash')
    const frame = await createFrame(owner, canvas.id, { name: 'Poster', html })

    const deleted = await owner.delete(`/api/frames/${frame.id}`)
    const deletedBody = await deleted.text()
    expect(deleted.status, deletedBody).toBe(200)
    expect(JSON.parse(deletedBody).ok).toBe(true)
    expect((await getCanvas(owner, canvas.id)).frames.map((f) => f.id)).not.toContain(frame.id)

    const listed = (await (await owner.get('/api/trash')).json()).frames.find((f: { id: string }) => f.id === frame.id)
    expect(listed).toMatchObject({ id: frame.id, canvasId: canvas.id, canvasName: 'Frame trash', name: 'Poster' })
    expect(typeof listed.deletedAt).toBe('number')

    const restored = await owner.post(`/api/trash/frames/${frame.id}/restore`)
    const restoredBody = await restored.text()
    expect(restored.status, restoredBody).toBe(200)
    expect(JSON.parse(restoredBody).ok).toBe(true)

    const back = frameOf(await getCanvas(owner, canvas.id), frame.id)
    expect(back.id).toBe(frame.id)
    expect(back.html).toBe(html)
    /* it is out of the trash, not duplicated in it */
    expect((await (await owner.get('/api/trash')).json()).frames.map((f: { id: string }) => f.id)).not.toContain(
      frame.id,
    )
  })
})

describe('page trash', () => {
  it('lists a deleted page and the frames it took, and puts the page back', async () => {
    const canvas = await createCanvas(owner, 'Page trash')
    const page = await createPage(owner, canvas.id, 'Sandbox')
    const frame = await createFrame(owner, canvas.id, { name: 'On the page', pageId: page.id, html: '<p>page</p>' })

    const deleted = await owner.delete(`/api/pages/${page.id}`)
    const deletedBody = await deleted.text()
    expect(deleted.status, deletedBody).toBe(200)
    expect(JSON.parse(deletedBody)).toEqual({ ok: true, deletedFrameIds: [frame.id] })

    const trash = await (await owner.get('/api/trash')).json()
    expect(trash.pages.find((p: { id: string }) => p.id === page.id)).toMatchObject({
      canvasId: canvas.id,
      canvasName: 'Page trash',
      name: 'Sandbox',
    })
    expect(trash.frames.map((f: { id: string }) => f.id)).toContain(frame.id)

    const restored = await owner.post(`/api/trash/pages/${page.id}/restore`)
    const restoredBody = await restored.text()
    expect(restored.status, restoredBody).toBe(200)
    expect(JSON.parse(restoredBody).ok).toBe(true)
    const after = await getCanvas(owner, canvas.id)
    expect(after.pages!.map((p) => p.id)).toContain(page.id)
    /* the frames that went down with the page come back with it: a page delete
       is one action, so restoring has to be one action too */
    expect(after.frames.find((f) => f.id === frame.id)).toMatchObject({
      pageId: page.id,
      name: 'On the page',
      html: '<p>page</p>',
    })
    const trashAfter = await (await owner.get('/api/trash')).json()
    expect(trashAfter.frames.map((f: { id: string }) => f.id)).not.toContain(frame.id)
  })
})

describe('component trash', () => {
  it('lists a deleted component in the trash and restores it to the library', async () => {
    const canvas = await createCanvas(owner, 'Component trash')
    const created = await owner.post(`/api/canvases/${canvas.id}/components`, {
      name: 'Primary button',
      html: '<button class="btn">Go</button>',
      width: 200,
      height: 48,
    })
    const createdBody = await created.text()
    expect(created.status, createdBody).toBe(200)
    const component = JSON.parse(createdBody) as Component
    expect(component).toMatchObject({ canvasId: canvas.id, name: 'Primary button', width: 200, height: 48 })

    const deleted = await owner.delete(`/api/components/${component.id}`)
    const deletedBody = await deleted.text()
    expect(deleted.status, deletedBody).toBe(200)
    expect(JSON.parse(deletedBody).ok).toBe(true)
    const afterDelete = ((await (await owner.get(`/api/canvases/${canvas.id}/components`)).json()) as Component[]).map(
      (c) => c.id,
    )
    expect(afterDelete).not.toContain(component.id)

    const listed = (await (await owner.get('/api/trash')).json()).components.find(
      (c: { id: string }) => c.id === component.id,
    )
    expect(listed).toMatchObject({ canvasId: canvas.id, canvasName: 'Component trash', name: 'Primary button' })

    const restored = await owner.post(`/api/trash/components/${component.id}/restore`)
    const restoredBody = await restored.text()
    expect(restored.status, restoredBody).toBe(200)
    expect(JSON.parse(restoredBody).ok).toBe(true)
    const afterRestore = ((await (await owner.get(`/api/canvases/${canvas.id}/components`)).json()) as Component[]).map(
      (c) => c.id,
    )
    expect(afterRestore).toContain(component.id)
  })
})

describe('canvas checkpoints', () => {
  it('rolls a frame back to a manual checkpoint and checkpoints the restore itself', async () => {
    const canvas = await createCanvas(owner, 'Checkpoints')
    const frame = await createFrame(owner, canvas.id, { name: 'Hero', html: '<h1>alpha</h1>', width: 640 })

    const saved = await owner.post(`/api/canvases/${canvas.id}/versions`)
    const savedBody = await saved.text()
    expect(saved.status, savedBody).toBe(200)
    const checkpoint = JSON.parse(savedBody)
    expect(checkpoint).toMatchObject({ cause: 'manual', createdBy: 'Owner', frameCount: 1 })

    const edited = await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>bravo</h1>', width: 321 })
    expect(edited.status).toBe(200)
    const live = frameOf(await getCanvas(owner, canvas.id), frame.id)
    expect([live.html, live.width]).toEqual(['<h1>bravo</h1>', 321])

    const restored = await owner.post(`/api/canvases/${canvas.id}/versions/${checkpoint.id}/restore`)
    const restoredBody = await restored.text()
    expect(restored.status, restoredBody).toBe(200)
    expect(JSON.parse(restoredBody)).toEqual({ ok: true, restored: 1, created: 0 })

    /* the whole frame, not just the field the patch named */
    const rolled = frameOf(await getCanvas(owner, canvas.id), frame.id)
    expect([rolled.html, rolled.width, rolled.height]).toEqual(['<h1>alpha</h1>', 640, 480])

    /* the state the restore replaced is itself on the timeline, so a rollback
       is undoable the same way the edit was */
    const versions = (await (await owner.get(`/api/canvases/${canvas.id}/versions`)).json()).versions
    expect(versions.map((v: { cause: string }) => v.cause)).toContain('restore')
  })

  it('404s a checkpoint that belongs to another canvas, and an unknown page', async () => {
    const other = await createCanvas(owner, 'Another canvas')
    await createFrame(owner, other.id, { name: 'Theirs', html: '<p>theirs</p>' })
    const foreign = await (await owner.post(`/api/canvases/${other.id}/versions`)).json()

    const canvas = await createCanvas(owner, 'Diff target')
    await createFrame(owner, canvas.id, { name: 'Mine', html: '<p>mine</p>' })

    const crossed = await owner.post(`/api/canvases/${canvas.id}/versions/${foreign.id}/diff`, {})
    expect(crossed.status).toBe(404)
    expect((await crossed.json()).error).toBe('version not found')

    expect((await owner.post(`/api/canvases/${canvas.id}/versions/no-such-version/diff`, {})).status).toBe(404)

    const checkpoint = await (await owner.post(`/api/canvases/${canvas.id}/versions`)).json()
    const badPage = await owner.post(`/api/canvases/${canvas.id}/versions/${checkpoint.id}/diff`, {
      pageId: 'no-such-page',
    })
    expect(badPage.status).toBe(404)
    expect((await badPage.json()).error).toBe('page not found')
  })

  it('answers empty when the page has nothing left to draw', async () => {
    const canvas = await createCanvas(owner, 'Emptied page')
    const frame = await createFrame(owner, canvas.id, { name: 'Gone', html: '<h1>gone</h1>' })
    const checkpoint = await (await owner.post(`/api/canvases/${canvas.id}/versions`)).json()
    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)

    const res = await owner.post(`/api/canvases/${canvas.id}/versions/${checkpoint.id}/diff`, {})
    const body = await res.text()
    expect(res.status, body).toBe(200)
    /* one side has no renderable frame: there is no picture to compare, and
       saying so is the answer rather than two blank PNGs */
    expect(JSON.parse(body)).toEqual({ empty: true })
  })
})

/* The diff renders both sides through the shared headless browser, like every
   other render-backed assertion in this repo. */
describe.skipIf(!findBrowserPath())('checkpoint diff over real renders', () => {
  it('renders the live page and the checkpoint it came from', async () => {
    const canvas = await createCanvas(owner, 'Rendered diff')
    const frame = await createFrame(owner, canvas.id, {
      name: 'Swatch',
      html: '<div style="width:640px;height:480px;background:#000"></div>',
    })
    const checkpoint = await (await owner.post(`/api/canvases/${canvas.id}/versions`)).json()
    expect(
      (
        await owner.patch(`/api/frames/${frame.id}`, {
          html: '<div style="width:640px;height:480px;background:#fff"></div>',
        })
      ).status,
    ).toBe(200)

    const res = await owner.post(`/api/canvases/${canvas.id}/versions/${checkpoint.id}/diff`, {})
    const body = await res.text()
    expect(res.status, body).toBe(200)
    const diff = JSON.parse(body)
    expect(diff.empty).toBeUndefined()
    expect(diff.current).toContain('/a/')
    expect(diff.version).toContain('/a/')
    expect(diff.current).not.toBe(diff.version)
    /* black plate against white plate: most of the image changed, and none of
       it would have if the two sides were the same render */
    expect(diff.changedRatio).toBeGreaterThan(0.5)
  }, 120_000)
})

describe('trash owner scoping', () => {
  it("does not let another user reach the first user's trashed work", async () => {
    const canvas = await createCanvas(owner, 'Private work')
    const frame = await createFrame(owner, canvas.id, { name: 'Secret', html: '<p>secret</p>' })
    const page = await createPage(owner, canvas.id, 'Private page')
    const component = (await (
      await owner.post(`/api/canvases/${canvas.id}/components`, { name: 'Private widget', html: '<b>p</b>' })
    ).json()) as Component

    expect((await owner.delete(`/api/frames/${frame.id}`)).status).toBe(200)
    expect((await owner.delete(`/api/pages/${page.id}`)).status).toBe(200)
    expect((await owner.delete(`/api/components/${component.id}`)).status).toBe(200)

    /* the rows are not even listed: the trash is not a directory of someone
       else's deleted work */
    const trash = await (await stranger.get('/api/trash')).json()
    expect(trash.frames.map((f: { id: string }) => f.id)).not.toContain(frame.id)
    expect(trash.pages.map((p: { id: string }) => p.id)).not.toContain(page.id)
    expect(trash.components.map((c: { id: string }) => c.id)).not.toContain(component.id)

    for (const path of [
      `/api/trash/frames/${frame.id}/restore`,
      `/api/trash/pages/${page.id}/restore`,
      `/api/trash/components/${component.id}/restore`,
    ]) {
      const res = await stranger.post(path)
      expect(res.status, path).toBe(404)
    }

    /* and nothing came back onto the canvas they still cannot read */
    expect((await getCanvas(owner, canvas.id)).frames.map((f) => f.id)).not.toContain(frame.id)
  })
})
