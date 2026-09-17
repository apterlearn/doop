import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* A release is what a handoff link points at, so the parts worth proving are
   the ones that make it trustworthy: it survives edits to the canvas, it is
   reachable by whoever holds the link, and putting it back is an ordinary edit
   that can itself be undone. Releases live in the database, so this file drives
   the real one.

   Releases, publishes and restores are SHIP paths: they refuse a canvas whose
   frames are not verified end to end. The canvases here are deliberately
   unverified — these tests are about what a release freezes, not about the
   gate — so those calls pass `force: true`. The gate's refusal and its force
   override are asserted in tests/mcpReviewMode.test.ts. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-releases-'))

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

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

let ownerId = ''

async function connect(owner = ownerId) {
  const server = buildMcpServer('Owner', owner)
  const client = new Client({ name: 'doop-releases-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

/** Frame writes reach the version table on a debounce, so history lags the
 *  store: a test that reads it has to wait for the flush. */
async function waitForVersions(frameId: string, count: number) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const rows = await persist.listFrameVersions(frameId, 100)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) throw new Error(`only ${rows.length} version(s) for ${frameId}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  let parsed: Record<string, never> = {} as Record<string, never>
  try {
    parsed = JSON.parse(raw) as Record<string, never>
  } catch {
    /* not a JSON payload */
  }
  return { parsed, raw, isError: result.isError }
}

let counter = 0
let canvas: Canvas
let frame: Frame

beforeEach(() => {
  counter += 1
  ownerId = `release-owner-${counter}`
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
  canvas = store.createCanvas(`Release ${counter}`, ownerId)
  frame = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>first</h1>', width: 800, height: 600 }, 'Owner')!
})

describe('create_release', () => {
  it('freezes the frames as they are and hands back a public url', async () => {
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        name: 'v1',
        agent_name: 'Claude',
      })
      expect(created.isError).toBeFalsy()
      expect(created.parsed.name).toBe('v1')
      expect(String(created.parsed.url)).toContain(`/p/${canvas.id}/${created.parsed.release_id}`)

      const stored = await persist.getRelease(created.parsed.release_id as unknown as string)
      expect(stored?.frames).toHaveLength(1)
      expect(stored?.frames[0]?.html).toBe('<h1>first</h1>')

      /* the canvas moves on; the release does not */
      actions.updateFrame(
        frame.id,
        { html: '<h1>second</h1>', name: 'Hero v2' },
        actions.resolveActor({ name: 'alice', kind: 'user' }),
      )
      const after = await persist.getRelease(created.parsed.release_id as unknown as string)
      expect(after?.frames[0]?.html).toBe('<h1>first</h1>')
      expect(after?.frames[0]?.name).toBe('Hero')

      /* deleting the frame leaves the release intact — that is why the frames
         are copied into the row rather than referenced */
      actions.deleteFrame(frame.id, actions.resolveActor({ name: 'alice', kind: 'user' }))
      const still = await persist.getRelease(created.parsed.release_id as unknown as string)
      expect(still?.frames).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('names a release by date when the caller does not', async () => {
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        agent_name: 'Claude',
      })
      expect(String(created.parsed.name)).toMatch(/^Release \d{4}-\d{2}-\d{2}$/)
    } finally {
      await close()
    }
  })

  it('refuses a canvas with nothing on it', async () => {
    const empty = store.createCanvas('Empty', ownerId)
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'create_release', { canvas_id: empty.id, agent_name: 'Claude' })
      expect(created.isError).toBe(true)
      expect((created.parsed.error as unknown as { code: string }).code).toBe('not_found')
    } finally {
      await close()
    }
  })
})

describe('list_releases', () => {
  it('lists this canvas’s releases newest first and nobody else’s', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        name: 'older',
        agent_name: 'Claude',
      })
      await new Promise((resolve) => setTimeout(resolve, 2))
      await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        name: 'newer',
        agent_name: 'Claude',
      })

      const other = store.createCanvas('Other', ownerId)
      store.createFrame(other.id, { name: 'X', html: '<p>x</p>' }, 'Owner')
      await callTool(client, 'create_release', {
        force: true,
        canvas_id: other.id,
        name: 'elsewhere',
        agent_name: 'Claude',
      })

      const { parsed } = await callTool(client, 'list_releases', { canvas_id: canvas.id, agent_name: 'Claude' })
      const names = (parsed.releases as unknown as { name: string }[]).map((r) => r.name)
      expect(names).toEqual(['newer', 'older'])
    } finally {
      await close()
    }
  })
})

describe('release names', () => {
  it('renames a release without touching its frozen frames', async () => {
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        name: 'v1',
        agent_name: 'Claude',
      })
      const releaseId = created.parsed.release_id as unknown as string

      await persist.renameRelease(releaseId, 'v2 — final')

      const renamed = await persist.getRelease(releaseId)
      expect(renamed?.name).toBe('v2 — final')
      /* the name is a label on the snapshot, not an edit to it */
      expect(renamed?.frames[0]?.html).toBe('<h1>first</h1>')
      expect((await persist.listReleases(canvas.id)).map((r) => r.name)).toEqual(['v2 — final'])
    } finally {
      await close()
    }
  })
})

describe('canvas breakpoints', () => {
  /* Breakpoints are a column on the canvas row, so the proof that they stick
     is a hydrate read-back against the real database — the same one boot runs. */
  it('survives a save, and clearing the list survives too', async () => {
    const listed = [
      { name: 'mobile', min_width: 390 },
      { name: 'desktop', min_width: 1280 },
    ]
    const before = Date.now()
    const set = store.setBreakpoints(canvas.id, listed, 'Owner')
    expect(set?.breakpoints).toEqual(listed)
    expect(set!.updatedAt).toBeGreaterThanOrEqual(before)
    /* the store owns its copy: a caller that keeps the array cannot reach in */
    listed.push({ name: 'wide', min_width: 1600 })
    expect(store.getCanvas(canvas.id)!.breakpoints).toHaveLength(2)

    await vi.waitFor(async () => {
      const stored = (await persist.hydrate()).canvases.find((c) => c.id === canvas.id)
      expect(stored?.breakpoints).toEqual([
        { name: 'mobile', min_width: 390 },
        { name: 'desktop', min_width: 1280 },
      ])
    })

    store.setBreakpoints(canvas.id, undefined, 'Owner')
    expect(store.getCanvas(canvas.id)!.breakpoints).toBeUndefined()
    await vi.waitFor(async () => {
      const stored = (await persist.hydrate()).canvases.find((c) => c.id === canvas.id)
      expect(stored?.breakpoints).toBeUndefined()
    })
  })

  it('leaves an unknown canvas alone', () => {
    expect(store.setBreakpoints('no-such-canvas', [{ name: 'mobile', min_width: 390 }], 'Owner')).toBeUndefined()
  })
})

describe('restore_release', () => {
  it('writes the snapshot back as ordinary, reversible edits', async () => {
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        name: 'v1',
        agent_name: 'Claude',
      })
      const releaseId = created.parsed.release_id as unknown as string

      actions.updateFrame(frame.id, { html: '<h1>ruined</h1>' }, actions.resolveActor({ name: 'alice', kind: 'user' }))
      /* the write reaches the database on a debounce, and the restore that
         follows would otherwise coalesce with it into one save — which is a
         re-save of the released html, so no version would be appended */
      await persist.flushFrame(frame.id)

      const restored = await callTool(client, 'restore_release', {
        force: true,
        canvas_id: canvas.id,
        release_id: releaseId,
        agent_name: 'Claude',
      })
      expect(restored.isError).toBeFalsy()
      expect(store.getFrame(frame.id)!.html).toBe('<h1>first</h1>')
      const entries = restored.parsed.restored as unknown as { frame_id: string; created: boolean }[]
      expect(entries).toEqual([{ frame_id: frame.id, name: 'Hero', created: false }])

      /* an ordinary edit, so history has it and it can be undone */
      const history = await waitForVersions(frame.id, 2)
      expect(history.length).toBeGreaterThanOrEqual(2)

      /* restoring again is a no-op, and says so rather than writing */
      const again = await callTool(client, 'restore_release', {
        force: true,
        canvas_id: canvas.id,
        release_id: releaseId,
        agent_name: 'Claude',
      })
      expect(again.isError).toBe(true)
      expect((again.parsed.error as unknown as { message: string }).message).toContain('already matches')
    } finally {
      await close()
    }
  })

  it('recreates a frame the release has and the canvas no longer does', async () => {
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'create_release', {
        force: true,
        canvas_id: canvas.id,
        name: 'v1',
        agent_name: 'Claude',
      })
      actions.deleteFrame(frame.id, actions.resolveActor({ name: 'alice', kind: 'user' }))
      expect(store.getCanvas(canvas.id)!.frames).toHaveLength(0)

      const restored = await callTool(client, 'restore_release', {
        canvas_id: canvas.id,
        release_id: created.parsed.release_id as unknown as string,
        agent_name: 'Claude',
      })
      expect(restored.isError).toBeFalsy()
      const frames = store.getCanvas(canvas.id)!.frames
      expect(frames).toHaveLength(1)
      expect(frames[0]!.html).toBe('<h1>first</h1>')
      expect((restored.parsed.restored as unknown as { created: boolean }[])[0]!.created).toBe(true)
    } finally {
      await close()
    }
  })

  it('refuses a release from another canvas', async () => {
    const { client, close } = await connect()
    try {
      const other = store.createCanvas('Other', ownerId)
      store.createFrame(other.id, { name: 'X', html: '<p>x</p>' }, 'Owner')
      const created = await callTool(client, 'create_release', {
        force: true,
        canvas_id: other.id,
        name: 'elsewhere',
        agent_name: 'Claude',
      })
      const refused = await callTool(client, 'restore_release', {
        /* force so the gate lets the call through to the release lookup this
           test is about — the frame here is unverified */
        force: true,
        canvas_id: canvas.id,
        release_id: created.parsed.release_id as unknown as string,
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect((refused.parsed.error as unknown as { code: string }).code).toBe('not_found')
      expect(store.getFrame(frame.id)!.html).toBe('<h1>first</h1>')
    } finally {
      await close()
    }
  })
})

describe('publish_canvas', () => {
  it('lists the canvas for its owner and takes it down again', async () => {
    const { client, close } = await connect()
    try {
      const published = await callTool(client, 'publish_canvas', {
        force: true,
        canvas_id: canvas.id,
        description: 'A hero section',
        category: 'marketing',
        agent_name: 'Claude',
      })
      expect(published.isError).toBeFalsy()
      expect(published.parsed.category).toBe('marketing')
      expect(store.getCanvas(canvas.id)!.publishedAt).toBeTruthy()

      const down = await callTool(client, 'unpublish_canvas', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect(down.isError).toBeFalsy()
      expect(store.getCanvas(canvas.id)!.publishedAt).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('refuses a canvas the account does not own', async () => {
    const { client, close } = await connect('someone-else')
    try {
      /* the canvas is reachable through the owner-scoped canvasFor, so a
         different account sees no canvas at all */
      const published = await callTool(client, 'publish_canvas', {
        canvas_id: canvas.id,
        category: 'marketing',
        agent_name: 'Claude',
      })
      expect(published.isError).toBe(true)
      expect(store.getCanvas(canvas.id)!.publishedAt).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('refuses a canvas with nothing on it', async () => {
    const empty = store.createCanvas('Empty', ownerId)
    const { client, close } = await connect()
    try {
      const published = await callTool(client, 'publish_canvas', {
        canvas_id: empty.id,
        category: 'marketing',
        agent_name: 'Claude',
      })
      expect(published.isError).toBe(true)
      expect((published.parsed.error as unknown as { message: string }).message).toContain('add a frame')
    } finally {
      await close()
    }
  })

  it('rejects a shelf that is not in the gallery', async () => {
    const { client, close } = await connect()
    try {
      /* the shelf is part of the tool's own schema, so a shelf that is not in
         the gallery never reaches the handler at all */
      const published = await callTool(client, 'publish_canvas', {
        canvas_id: canvas.id,
        category: 'not-a-shelf',
        agent_name: 'Claude',
      })
      expect(published.isError).toBe(true)
      expect(store.getCanvas(canvas.id)!.publishedAt).toBeUndefined()
    } finally {
      await close()
    }
  })
})
