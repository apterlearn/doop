import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Canvas } from '../shared/types.ts'

/* Undo needs real version history, so this drives the real database. The
   contract worth pinning: undo restores what was there before the agent's
   write, it is itself undoable, and it never discards a change someone made
   after the agent's — an undo aimed at my work must not delete yours. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-undo-'))
const OWNER_ID = 'undo-owner'
/* version history is durable, so each test needs its own frame: a shared id
   would let one test's history answer another test's undo */
let counter = 0
let CANVAS_ID = ''
let FRAME_ID = ''

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

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

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-undo-test', version: '1.0.0' })
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
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

async function seed() {
  counter += 1
  CANVAS_ID = `c-undo-${counter}`
  FRAME_ID = `f-undo-${counter}`
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Undo',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [
      {
        id: FRAME_ID,
        canvasId: CANVAS_ID,
        name: 'Hero',
        x: 0,
        y: 0,
        width: 1200,
        height: 900,
        html: '<section>original</section>',
        createdAt: 0,
        updatedAt: 1,
        updatedBy: 'alice',
        pageId: `p-undo-${counter}`,
      },
    ],
    pages: [{ id: `p-undo-${counter}`, canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  /* the pre-agent state has to be a saved version, as it would be in a real
     canvas: the human's own write snapshotted it */
  await persist.saveFrame(canvas.frames[0]!, true)
  await waitForVersions(FRAME_ID, 1)
}

/** Frame writes reach the database on a debounce, so history lags the store. */
async function waitForVersions(frameId: string, count: number) {
  const deadline = Date.now() + 5000
  for (;;) {
    const rows = await persist.listFrameVersions(frameId, 100)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) throw new Error(`only ${rows.length} version(s) for ${frameId}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeEach(async () => {
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
  await seed()
})

describe('undo_last_change', () => {
  it('puts the frame back to the state before the agent’s last write', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<section>first edit</section>',
        agent_name: 'Claude',
      })
      /* one version per settled write: the store debounces, so a burst of
         writes is one saved state */
      await waitForVersions(FRAME_ID, 2)
      await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<section>second edit</section>',
        agent_name: 'Claude',
      })
      await waitForVersions(FRAME_ID, 3)
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>second edit</section>')

      const undo = await callTool(client, 'undo_last_change', {
        canvas_id: CANVAS_ID,
        frame_id: FRAME_ID,
        agent_name: 'Claude',
      })
      expect(undo.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>first edit</section>')
      const [entry] = undo.parsed.frames as unknown as Array<{ frame_id: string; reverted_to: string }>
      expect(entry!.frame_id).toBe(FRAME_ID)

      /* undo is an ordinary edit, so it can be undone in turn — and the
         second undo skips the version the first one saved, which holds the
         same document it just restored */
      await waitForVersions(FRAME_ID, 4)
      const again = await callTool(client, 'undo_last_change', {
        canvas_id: CANVAS_ID,
        frame_id: FRAME_ID,
        agent_name: 'Claude',
      })
      expect(again.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>original</section>')
    } finally {
      await close()
    }
  })

  it('undoes every frame the agent changed when no frame is named', async () => {
    const second = store.createFrame(CANVAS_ID, { name: 'Footer', html: '<footer>original</footer>' }, 'alice')!
    await persist.saveFrame(store.getFrame(second.id)!, true)
    await waitForVersions(second.id, 1)

    const { client, close } = await connect()
    try {
      await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<section>changed</section>',
        agent_name: 'Claude',
      })
      await callTool(client, 'set_frame_html', {
        frame_id: second.id,
        html: '<footer>changed</footer>',
        agent_name: 'Claude',
      })
      await waitForVersions(FRAME_ID, 2)
      await waitForVersions(second.id, 2)
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>changed</section>')

      const undo = await callTool(client, 'undo_last_change', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(undo.isError).toBeFalsy()
      const frames = undo.parsed.frames as unknown as Array<{ frame_id: string }>
      expect(frames.map((f) => f.frame_id).sort()).toEqual([FRAME_ID, second.id].sort())
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>original</section>')
      expect(store.getFrame(second.id)!.html).toBe('<footer>original</footer>')
    } finally {
      await close()
    }
  })

  it('refuses to undo over a change someone else made afterwards', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<section>agent edit</section>',
        agent_name: 'Claude',
      })
      /* the human edits on top: an undo aimed at the agent's write must not
         take the human's work with it */
      actions.updateFrame(
        FRAME_ID,
        { html: '<section>alice edit</section>' },
        actions.resolveActor({ name: 'alice', kind: 'user' }),
      )

      const undo = await callTool(client, 'undo_last_change', {
        canvas_id: CANVAS_ID,
        frame_id: FRAME_ID,
        agent_name: 'Claude',
      })
      expect(undo.isError).toBe(true)
      expect((undo.parsed.error as unknown as { code: string }).code).toBe('not_found')
      expect((undo.parsed.error as unknown as { message: string }).message).toContain('alice')
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>alice edit</section>')
    } finally {
      await close()
    }
  })

  it('names the history tools when there is nothing older to go back to', async () => {
    /* a frame the agent created: its own write is the only version */
    store.createFrame(CANVAS_ID, { name: 'Fresh', html: '<div>fresh</div>' }, 'alice')
    const fresh = store.getCanvas(CANVAS_ID)!.frames.find((f) => f.name === 'Fresh')!
    await persist.saveFrame(fresh, true)

    const { client, close } = await connect()
    try {
      await callTool(client, 'set_frame_html', {
        frame_id: fresh.id,
        html: '<div>agent wrote this</div>',
        agent_name: 'Claude',
      })
      await waitForVersions(fresh.id, 2)
      const undo = await callTool(client, 'undo_last_change', {
        canvas_id: CANVAS_ID,
        frame_id: fresh.id,
        agent_name: 'Claude',
      })
      expect(undo.isError).toBe(true)
      const error = undo.parsed.error as unknown as { code: string; message: string; hint?: string }
      expect(error.code).toBe('not_found')
      expect(`${error.message} ${error.hint ?? ''}`).toContain('get_frame_history')
      expect(store.getFrame(fresh.id)!.html).toBe('<div>agent wrote this</div>')
    } finally {
      await close()
    }
  })

  it('has nothing to undo when the agent has not written anything', async () => {
    const { client, close } = await connect()
    try {
      const undo = await callTool(client, 'undo_last_change', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(undo.isError).toBe(true)
      expect((undo.parsed.error as unknown as { code: string }).code).toBe('not_found')
      expect((undo.parsed.error as unknown as { message: string }).message).toContain('nothing to undo')
    } finally {
      await close()
    }
  })
})
