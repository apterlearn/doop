import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as frameLocks from '../server/frameLocks.ts'
import type { Canvas } from '../shared/types.ts'

/* Frame locks: two agents on one canvas, each a real MCP server over its own
   in-memory transport, writing to the same frame through the real store. */

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

const OWNER_ID = 'locks-owner'
const CANVAS_ID = 'c-locks'
const FRAME_ID = 'f-locks'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-locks-test', version: '1.0.0' })
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
    name: 'Locks',
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
        updatedAt: 1,
        updatedBy: 'alice',
        pageId: 'p-locks',
      },
    ],
    pages: [{ id: 'p-locks', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
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

describe('frame locking between agents', () => {
  it('refuses another agent’s write while a lock is held, and honours takeover', async () => {
    const a = await connect()
    const b = await connect()
    try {
      const claim = await callTool(a.client, 'begin_frame_edit', {
        frame_id: FRAME_ID,
        ttl_seconds: 300,
        agent_name: 'AgentA',
      })
      expect(claim.isError).toBeFalsy()
      expect(claim.parsed.expires_at).toBeTypeOf('string')

      const blocked = await callTool(b.client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>from B</h1>',
        agent_name: 'AgentB',
      })
      expect(blocked.isError).toBe(true)
      expect(blocked.parsed.error).toMatchObject({ code: 'conflict', holder: 'AgentA' })
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>original</h1>')

      /* the holder itself is never blocked by its own lock */
      const own = await callTool(a.client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>from A</h1>',
        agent_name: 'AgentA',
      })
      expect(own.isError).toBeFalsy()

      const taken = await callTool(b.client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: '<h1>from B</h1>',
        takeover: true,
        agent_name: 'AgentB',
      })
      expect(taken.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toBe('<h1>from B</h1>')

      /* B took it over, so A's release is a no-op */
      const released = await callTool(a.client, 'end_frame_edit', { frame_id: FRAME_ID, agent_name: 'AgentA' })
      expect(released.parsed.released).toBe(false)
      const releasedByB = await callTool(b.client, 'end_frame_edit', { frame_id: FRAME_ID, agent_name: 'AgentB' })
      expect(releasedByB.parsed.released).toBe(true)
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('refuses a lock another agent holds and renews the caller’s own', async () => {
    const a = await connect()
    const b = await connect()
    try {
      await callTool(a.client, 'begin_frame_edit', { frame_id: FRAME_ID, ttl_seconds: 300, agent_name: 'AgentA' })
      const refused = await callTool(b.client, 'begin_frame_edit', { frame_id: FRAME_ID, agent_name: 'AgentB' })
      expect(refused.isError).toBe(true)
      expect(refused.parsed.error).toMatchObject({ code: 'conflict', holder: 'AgentA' })

      /* re-entrant: the holder renewing is not a conflict */
      const renewed = await callTool(a.client, 'begin_frame_edit', { frame_id: FRAME_ID, agent_name: 'AgentA' })
      expect(renewed.isError).toBeFalsy()
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('blocks delete_frame too, so a locked frame cannot be pulled out from under its editor', async () => {
    const a = await connect()
    const b = await connect()
    try {
      await callTool(a.client, 'begin_frame_edit', { frame_id: FRAME_ID, agent_name: 'AgentA' })
      const blocked = await callTool(b.client, 'delete_frame', { frame_id: FRAME_ID, agent_name: 'AgentB' })
      expect(blocked.isError).toBe(true)
      expect(blocked.parsed.error).toMatchObject({ code: 'conflict' })
      expect(store.getFrame(FRAME_ID)).toBeDefined()
    } finally {
      await a.close()
      await b.close()
    }
  })
})
