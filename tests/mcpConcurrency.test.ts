import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as frameLocks from '../server/frameLocks.ts'
import { clearOpIds } from '../server/opIds.ts'
import type { Canvas } from '../shared/types.ts'

/* Optimistic concurrency: `expected_updated_at` is the caller's assertion that
   nobody has touched the frame since it read it. A stale assertion is a
   conflict the agent can act on, not a silent overwrite. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
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
  const texts = result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '')
  const raw = texts[0] ?? ''
  /* every text block, payload first: the steering the wrapper appends (feedback,
     session substitutions, the replay notice) rides after the payload */
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, text: texts.join('\n'), isError: result.isError }
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
  clearOpIds()
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

/* Idempotency: a dropped connection leaves the caller unable to tell whether a
   write landed, and the retry it sends must not land a second time. The key is
   the caller's `op_id`; the wrapper replays the recorded result instead of
   running the handler again. */
describe('idempotent retries', () => {
  it('replays a repeated op_id instead of writing twice', async () => {
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>first</h1>',
        op_id: 'html-1',
        agent_name: 'Claude',
      })
      expect(first.isError).toBeFalsy()
      expect(first.text).not.toContain('idempotent_replay')
      const written = store.getFrame(FRAME_ID)!

      /* the retry carries different html under the same key: the record is what
         answers it, so the frame is exactly as the first call left it */
      const retry = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>second</h1>',
        op_id: 'html-1',
        agent_name: 'Claude',
      })
      expect(retry.isError).toBeFalsy()
      expect(retry.text).toContain('idempotent_replay')
      expect(retry.raw).toBe(first.raw)
      const after = store.getFrame(FRAME_ID)!
      expect(after.html).toBe('<h1>first</h1>')
      expect(after.updatedAt).toBe(written.updatedAt)
    } finally {
      await close()
    }
  })

  it('leaves the key of a failed call free, so the retry still runs', async () => {
    const { client, close } = await connect()
    try {
      const failed = await callTool(client, 'set_frame_html', {
        frame_id: 'f-does-not-exist',
        html: '<h1>x</h1>',
        op_id: 'html-retry',
        agent_name: 'Claude',
      })
      expect(failed.isError).toBe(true)
      expect(failed.parsed.error).toMatchObject({ code: 'not_found' })

      /* nothing landed, so the id must still be usable for the real write */
      const retried = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>landed</h1>',
        op_id: 'html-retry',
        agent_name: 'Claude',
      })
      expect(retried.isError).toBeFalsy()
      expect(retried.text).not.toContain('idempotent_replay')
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>landed</h1>')
    } finally {
      await close()
    }
  })

  it('treats a different op_id as a new write', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>one</h1>',
        op_id: 'html-a',
        agent_name: 'Claude',
      })
      const second = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>two</h1>',
        op_id: 'html-b',
        agent_name: 'Claude',
      })
      expect(second.isError).toBeFalsy()
      expect(second.text).not.toContain('idempotent_replay')
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>two</h1>')
    } finally {
      await close()
    }
  })
})
