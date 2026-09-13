import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* A stream is a sequence of writes onto a base the agent read once. When a
   human edits that frame mid-stream the base is gone, and the next chunk would
   splice two designs together. Two things have to hold: the agent is told, and
   a chunk sent against the old base is refused rather than appended. */

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
  saveFrameReview: async () => {},
  listFrameReviews: async () => [],
}))

const OWNER_ID = 'interrupt-owner'
const CANVAS_ID = 'c-interrupt'
const FRAME_ID = 'f-interrupt'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-interrupt-test', version: '1.0.0' })
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
  const texts = result.content.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  let parsed: Record<string, never> = {} as Record<string, never>
  try {
    parsed = JSON.parse(texts[0] ?? '') as Record<string, never>
  } catch {
    /* not a JSON payload */
  }
  return { parsed, texts, isError: result.isError }
}

function seedCanvas(): Canvas {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Interrupt',
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
        pageId: 'p-interrupt',
      },
    ],
    pages: [{ id: 'p-interrupt', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
}

const human = () => actions.resolveActor({ name: 'alice', kind: 'user' })

beforeEach(() => {
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
    plans: new Map(),
  })
  seedCanvas()
})

describe('a stream whose base moved', () => {
  it('tells the streaming agent on its next call, once', async () => {
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>start</section>',
        start: true,
        agent_name: 'Claude',
      })
      expect(first.isError).toBeFalsy()

      /* the human takes the frame over mid-stream */
      actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())

      const next = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      const notice = next.texts.find((t) => t.includes('STREAM INTERRUPTED'))
      expect(notice).toBeDefined()
      expect(notice).toContain('alice')
      expect(notice).toContain('Hero')
      expect(notice).toContain('get_frame_html')

      /* a state change, not a standing fact: the next call is clean */
      const after = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      expect(after.texts.some((t) => t.includes('STREAM INTERRUPTED'))).toBe(false)
    } finally {
      await close()
    }
  })

  it('refuses a chunk sent against the pre-edit base', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>start</section>',
        start: true,
        agent_name: 'Claude',
      })
      const read = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      const stale = (read.parsed as unknown as { updatedAt: string }).updatedAt

      actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())
      const before = store.getFrame(FRAME_ID)!.html

      const refused = await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>more</section>',
        expected_updated_at: stale,
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect((refused.parsed.error as unknown as { code: string }).code).toBe('conflict')
      /* refused means nothing was written */
      expect(store.getFrame(FRAME_ID)!.html).toBe(before)
    } finally {
      await close()
    }
  })

  it('accepts a chunk once the agent re-reads and passes the new timestamp', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>start</section>',
        start: true,
        agent_name: 'Claude',
      })
      actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())

      const read = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      const current = (read.parsed as unknown as { updatedAt: string }).updatedAt

      const ok = await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<p>continued</p>',
        expected_updated_at: current,
        agent_name: 'Claude',
      })
      expect(ok.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toContain('continued')
    } finally {
      await close()
    }
  })

  it('does not complain about a base the agent never had, only about one that moved', async () => {
    const { client, close } = await connect()
    try {
      /* no expected_updated_at at all: the pre-existing streaming contract,
         still valid — the agent is told about the interruption instead */
      const ok = await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>fresh</section>',
        start: true,
        agent_name: 'Claude',
      })
      expect(ok.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toContain('fresh')
    } finally {
      await close()
    }
  })

  it('refuses an edit_frame_html whose base moved', async () => {
    const { client, close } = await connect()
    try {
      const read = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      const stale = (read.parsed as unknown as { updatedAt: string }).updatedAt
      actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())

      const refused = await callTool(client, 'edit_frame_html', {
        frame_id: FRAME_ID,
        old_str: 'original',
        new_str: 'edited',
        expected_updated_at: stale,
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect((refused.parsed.error as unknown as { code: string }).code).toBe('conflict')
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>by alice</section>')
    } finally {
      await close()
    }
  })

  it('does not tell an agent about a stream someone else was running', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>start</section>',
        start: true,
        agent_name: 'Claude',
      })
      actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())

      const other = await callTool(client, 'get_frame', { frame_id: FRAME_ID, agent_name: 'Pixel' })
      expect(other.texts.some((t) => t.includes('STREAM INTERRUPTED'))).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('a stream ends when its frame is taken over', () => {
  it('drops the open stream so the next chunk is not appended to the human’s work', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>start</section>',
        start: true,
        agent_name: 'Claude',
      })
      actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())
      /* the agent restarts deliberately: that is a fresh document, not an append */
      const restarted = await callTool(client, 'append_frame_html', {
        frame_id: FRAME_ID,
        html_chunk: '<section>mine again</section>',
        start: true,
        agent_name: 'Claude',
      })
      expect(restarted.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toBe('<section>mine again</section>')
    } finally {
      await close()
    }
  })
})
