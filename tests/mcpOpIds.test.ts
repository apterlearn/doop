import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { clearOpIds } from '../server/opIds.ts'
import type { Canvas } from '../shared/types.ts'

/* op_id idempotency: a retried create returns the record the first call made
   instead of a second one, keyed per account so one agent cannot replay
   another's result. */

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

const OWNER_ID = 'plan-owner'
/* a fresh canvas id per test: the op-id log is module state, and a shared id
   would let one test's replay leak into the next */
let CANVAS_ID = 'c-plan'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-plan-test', version: '1.0.0' })
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

let counter = 0

function seedCanvas(): Canvas {
  counter += 1
  CANVAS_ID = `c-plan-${counter}`
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Plan',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-plan-${counter}`, canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
}

beforeEach(() => {
  vi.restoreAllMocks()
  clearOpIds()
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
  seedCanvas()
})

describe('idempotent creates', () => {
  it('returns the original frame for a repeated op_id instead of creating a second', async () => {
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        op_id: 'frame-hero-1',
        agent_name: 'Claude',
      })
      expect(first.isError).toBeFalsy()
      expect((first.parsed.frame as unknown as { id: string }).id).toBeTruthy()
      expect(first.parsed.idempotent_replay).toBeUndefined()

      const retry = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        op_id: 'frame-hero-1',
        agent_name: 'Claude',
      })
      expect(retry.parsed.idempotent_replay).toBe(true)
      expect((retry.parsed.frame as unknown as { id: string }).id).toBe(
        (first.parsed.frame as unknown as { id: string }).id,
      )
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(1)

      /* a fresh op_id is a genuinely new create */
      const second = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero 2',
        html: '<h1>again</h1>',
        op_id: 'frame-hero-2',
        agent_name: 'Claude',
      })
      expect(second.parsed.idempotent_replay).toBeUndefined()
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('deduplicates pages, comments and canvases the same way', async () => {
    const { client, close } = await connect()
    try {
      const page = await callTool(client, 'create_page', {
        canvas_id: CANVAS_ID,
        name: 'Checkout',
        op_id: 'page-1',
        agent_name: 'Claude',
      })
      const pageRetry = await callTool(client, 'create_page', {
        canvas_id: CANVAS_ID,
        name: 'Checkout',
        op_id: 'page-1',
        agent_name: 'Claude',
      })
      expect(pageRetry.parsed.idempotent_replay).toBe(true)
      expect((pageRetry.parsed as unknown as { id: string }).id).toBe((page.parsed as unknown as { id: string }).id)
      expect(store.getCanvas(CANVAS_ID)!.pages).toHaveLength(2)

      const frame = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        agent_name: 'Claude',
      })
      const frameId = (frame.parsed.frame as unknown as { id: string }).id
      const comment = await callTool(client, 'add_comment', {
        frame_id: frameId,
        selector: 'h1',
        text: 'too loud',
        op_id: 'comment-1',
        agent_name: 'Claude',
      })
      const commentRetry = await callTool(client, 'add_comment', {
        frame_id: frameId,
        selector: 'h1',
        text: 'too loud',
        op_id: 'comment-1',
        agent_name: 'Claude',
      })
      expect(commentRetry.parsed.idempotent_replay).toBe(true)
      expect((commentRetry.parsed as unknown as { id: string }).id).toBe(
        (comment.parsed as unknown as { id: string }).id,
      )
      expect(actions.getComments(CANVAS_ID)).toHaveLength(1)

      const before = store.listCanvases(OWNER_ID).length
      const canvas = await callTool(client, 'create_canvas', { name: 'Second', op_id: 'canvas-1' })
      const created = store.listCanvases(OWNER_ID).length
      expect(created).toBe(before + 1)
      const canvasRetry = await callTool(client, 'create_canvas', { name: 'Second', op_id: 'canvas-1' })
      expect(canvasRetry.parsed.idempotent_replay).toBe(true)
      expect(canvasRetry.parsed.id).toBe(canvas.parsed.id)
      /* the retry created nothing */
      expect(store.listCanvases(OWNER_ID)).toHaveLength(created)
    } finally {
      await close()
    }
  })

  it('keys op ids per account, so one agent cannot replay another result', async () => {
    const a = await connect()
    const serverB = buildMcpServer('Other Owner', 'other-owner')
    const clientB = new Client({ name: 'doop-plan-test-b', version: '1.0.0' })
    const [t1, t2] = InMemoryTransport.createLinkedPair()
    await serverB.connect(t2)
    await clientB.connect(t1)
    try {
      await callTool(a.client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        op_id: 'shared-key',
        agent_name: 'Claude',
      })
      /* the same key from another account is a different create, not a replay */
      store.addMember(CANVAS_ID, 'other-owner', 'alice')
      const other = await callTool(clientB, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Theirs',
        html: '<h1>theirs</h1>',
        op_id: 'shared-key',
        agent_name: 'Claude',
      })
      expect(other.isError).toBeFalsy()
      expect(other.parsed.idempotent_replay).toBeUndefined()
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(2)
    } finally {
      await a.close()
      await clientB.close()
      await serverB.close()
    }
  })
})
