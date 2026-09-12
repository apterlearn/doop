import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as frameLocks from '../server/frameLocks.ts'
import type { Canvas } from '../shared/types.ts'

/* Optimistic concurrency: `expected_updated_at` is the caller's assertion that
   nobody has touched the frame since it read it. A stale assertion is a
   conflict the agent can act on, not a silent overwrite. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveJournal: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  hydrate: () => {},
  saveCanvas: () => {},
  saveCanvasCopy: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  setFramePage: () => {},
  saveTask: () => {},
  deleteTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteCanvas: () => {},
}))

const OWNER_ID = 'concurrency-owner'
const CANVAS_ID = 'c-concurrency'
const FRAME_ID = 'f-concurrency'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-concurrency-test', version: '1.0.0' })
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

function seedCanvas(): Canvas {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Concurrency',
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
        width: 640,
        height: 480,
        html: '<h1>original</h1>',
        createdAt: 0,
        updatedAt: 1_700_000_000_000,
        updatedBy: 'alice',
        pageId: 'p-concurrency',
      },
    ],
    pages: [{ id: 'p-concurrency', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
}

beforeEach(() => {
  vi.restoreAllMocks()
  frameLocks.clearLocks()
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  seedCanvas()
})

describe('optimistic concurrency on frame writes', () => {
  it('refuses a write built on a stale read and accepts the retry', async () => {
    const { client, close } = await connect()
    try {
      const read = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      const stale = read.parsed.updatedAt as unknown as string

      /* someone else lands a change first */
      actions.updateFrame(FRAME_ID, { html: '<h1>theirs</h1>' }, actions.resolveActor({ name: 'Bob', kind: 'user' }))

      const refused = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>mine</h1>',
        expected_updated_at: stale,
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect(refused.parsed.error).toMatchObject({ code: 'conflict', current_updated_by: 'Bob' })
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>theirs</h1>')

      const fresh = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      const retried = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>mine</h1>',
        expected_updated_at: fresh.parsed.updatedAt as unknown as string,
        agent_name: 'Claude',
      })
      expect(retried.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>mine</h1>')
    } finally {
      await close()
    }
  })

  it('leaves writes without a precondition alone', async () => {
    const { client, close } = await connect()
    try {
      actions.updateFrame(FRAME_ID, { html: '<h1>theirs</h1>' }, actions.resolveActor({ name: 'Bob', kind: 'user' }))
      const ok = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>mine</h1>',
        agent_name: 'Claude',
      })
      expect(ok.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('applies the same precondition to update_frame and delete_frame', async () => {
    const { client, close } = await connect()
    try {
      const stale = new Date(1).toISOString()

      const update = await callTool(client, 'update_frame', {
        frame_id: FRAME_ID,
        name: 'Renamed',
        expected_updated_at: stale,
        agent_name: 'Claude',
      })
      expect(update.isError).toBe(true)
      expect(update.parsed.error).toMatchObject({ code: 'conflict' })
      expect(store.getFrame(FRAME_ID)!.name).toBe('Hero')

      const remove = await callTool(client, 'delete_frame', {
        frame_id: FRAME_ID,
        expected_updated_at: stale,
        agent_name: 'Claude',
      })
      expect(remove.isError).toBe(true)
      expect(remove.parsed.error).toMatchObject({ code: 'conflict' })
      expect(store.getFrame(FRAME_ID)).toBeDefined()
    } finally {
      await close()
    }
  })

  it('rejects a malformed precondition as invalid_input rather than silently ignoring it', async () => {
    const { client, close } = await connect()
    try {
      const bad = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>x</h1>',
        expected_updated_at: 'yesterday',
        agent_name: 'Claude',
      })
      expect(bad.isError).toBe(true)
      expect(bad.parsed.error).toMatchObject({ code: 'invalid_input' })
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>original</h1>')
    } finally {
      await close()
    }
  })
})
