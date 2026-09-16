import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { initDb, closeDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Frame history is real persistence, so this file drives the real one: a
   PGlite cluster in a temp directory, migrated at boot exactly as the server
   does, with the MCP tools on top. Nothing about the cap, the identical-write
   skip, or revert is mocked. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-frame-versions-'))
const OWNER_ID = 'versions-owner'

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

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-versions-test', version: '1.0.0' })
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

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

/** Persistence is fire-and-forget, so wait for the row instead of a duration. */
async function waitForVersions(frameId: string, count: number) {
  const deadline = Date.now() + 5000
  for (;;) {
    const rows = await persist.listFrameVersions(frameId, 100)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) throw new Error(`only ${rows.length} version(s) for ${frameId}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

let counter = 0
let canvas: Canvas
let frame: Frame

function seed() {
  counter += 1
  canvas = {
    id: `c-versions-${counter}`,
    name: 'Versions',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [
      {
        id: `p-versions-${counter}`,
        canvasId: `c-versions-${counter}`,
        name: 'Page 1',
        position: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  }
  frame = {
    id: `f-versions-${counter}`,
    canvasId: canvas.id,
    name: 'Hero',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    html: '<h1>one</h1>',
    createdAt: 1,
    updatedAt: 1,
    updatedBy: 'alice',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
    pageId: canvas.pages![0]!.id,
  }
  canvas.frames.push(frame)
  store.init([canvas])
}

beforeEach(() => {
  vi.restoreAllMocks()
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
  seed()
})

describe('frame version history', () => {
  it('snapshots each durable write, skips unchanged re-saves, and caps the ring', async () => {
    await persist.saveFrame(frame, true)
    await waitForVersions(frame.id, 1)

    await persist.saveFrame({ ...frame, html: '<h1>two</h1>', updatedAt: 2 }, true)
    let rows = await waitForVersions(frame.id, 2)
    expect(rows.map((r) => r.html)).toEqual(['<h1>two</h1>', '<h1>one</h1>'])
    expect(rows[0]!.savedBy).toBe('alice')

    /* a rename re-saves the same document — not a design version */
    await persist.saveFrame({ ...frame, name: 'Hero v2', html: '<h1>two</h1>', updatedAt: 3 }, true)
    await waitForVersions(frame.id, 2)
    expect(await persist.listFrameVersions(frame.id, 100)).toHaveLength(2)

    for (let i = 0; i < 55; i += 1) {
      await persist.saveFrame({ ...frame, html: `<p>${i}</p>`, updatedAt: 10 + i }, true)
    }
    rows = await waitForVersions(frame.id, 50)
    expect(rows).toHaveLength(50)
    expect(rows[0]!.html).toBe('<p>54</p>')
    expect(rows.some((r) => r.html === '<h1>one</h1>')).toBe(false)
  })

  it('lists metadata only, reads one version in full, and restores it', async () => {
    await persist.saveFrame({ ...frame, html: '<h1>original</h1>', updatedAt: 10 }, true)
    await waitForVersions(frame.id, 1)
    await persist.saveFrame({ ...frame, html: '<h1>ruined</h1>', updatedAt: 20 }, true)
    await waitForVersions(frame.id, 2)

    const { client, close } = await connect()
    try {
      const history = await callTool(client, 'get_frame_history', { frame_id: frame.id, agent_name: 'Claude' })
      const versions = history.parsed.versions as unknown as {
        id: string
        htmlBytes: number
        savedAt: string
        html?: string
      }[]
      expect(versions).toHaveLength(2)
      expect(versions[0]!.savedAt).toBe(new Date(20).toISOString())
      expect(versions[0]!.htmlBytes).toBe('<h1>ruined</h1>'.length)
      /* the list must never carry the documents themselves */
      expect(versions.every((v) => v.html === undefined)).toBe(true)

      const older = versions[1]!
      const one = await callTool(client, 'get_frame_version', { version_id: older.id, agent_name: 'Claude' })
      expect(one.parsed.html).toBe('<h1>original</h1>')

      const reverted = await callTool(client, 'revert_frame', {
        frame_id: frame.id,
        version_id: older.id,
        agent_name: 'Claude',
      })
      expect(reverted.isError).toBeFalsy()
      expect(reverted.parsed.restored_from).toBe(older.id)
      expect(store.getFrame(frame.id)!.html).toBe('<h1>original</h1>')
      /* the revert is itself a version: a revert is never a dead end */
      await waitForVersions(frame.id, 3)
      expect((await persist.listFrameVersions(frame.id, 100))[0]!.html).toBe('<h1>original</h1>')
    } finally {
      await close()
    }
  })

  it('refuses a version belonging to another frame and an unknown version', async () => {
    await persist.saveFrame(frame, true)
    await waitForVersions(frame.id, 1)
    const version = (await persist.listFrameVersions(frame.id, 1))[0]!
    const other = actions.createFrame(
      canvas.id,
      { name: 'Other', html: '<p>other</p>' },
      actions.resolveActor({ name: 'alice', kind: 'user' }),
    )!

    const { client, close } = await connect()
    try {
      const wrongFrame = await callTool(client, 'revert_frame', {
        frame_id: other.id,
        version_id: version.id,
        agent_name: 'Claude',
      })
      expect(wrongFrame.isError).toBe(true)
      expect(wrongFrame.parsed.error).toMatchObject({ code: 'invalid_input' })

      const missing = await callTool(client, 'get_frame_version', { version_id: 'nope', agent_name: 'Claude' })
      expect(missing.isError).toBe(true)
      expect(missing.parsed.error).toMatchObject({ code: 'not_found' })
    } finally {
      await close()
    }
  })

  it('drops a frame’s history with the frame', async () => {
    await persist.saveFrame(frame, true)
    await waitForVersions(frame.id, 1)
    persist.deleteFrame(frame.id)
    const deadline = Date.now() + 5000
    for (;;) {
      if ((await persist.listFrameVersions(frame.id, 100)).length === 0) break
      if (Date.now() > deadline) throw new Error('frame versions survived the frame')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  })
})
