import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { CanvasFocus } from '../shared/types.ts'

/* Human focus: a human selects an element and says "fix this" — the agent can
   only find out which element they meant if the selection reaches it. The
   canvas keeps one focus per connected client (server/index.ts); here the
   reader is injected, because what is under test is the MCP half: the tool that
   reads it, and the nudge that rides on the next call. */

vi.mock('../server/db/persist.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/db/persist.ts')),
  saveCanvas: () => {},
  savePage: () => {},
  saveFrame: () => {},
  saveTask: () => {},
  saveActivity: () => {},
  saveFeedback: () => {},
}))

const OWNER_ID = 'focus-owner'

interface ToolResult {
  isError: boolean
  structured: Record<string, unknown>
  text: string
}

async function connect(ownerId = OWNER_ID) {
  const server = buildMcpServer('Focus Owner', ownerId)
  const client = new Client({ name: 'doop-focus-test', version: '1.0.0' })
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

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  return { isError: result.isError === true, structured: result.structuredContent ?? {}, text }
}

function focus(frameId: string, overrides: Partial<CanvasFocus> = {}): CanvasFocus {
  return {
    clientId: 'human-1',
    name: 'Kevin',
    frameId,
    selector: '.cta',
    pageId: null,
    at: 1,
    ...overrides,
  }
}

/* A canvas per test, owned by that test's account: the session record is keyed
   by account, so sharing one would let one test's focus state leak into the
   next through lastFocus. */
function seed(ownerId = OWNER_ID) {
  const canvas = store.createCanvas(`focus-${Math.random().toString(36).slice(2, 8)}`, ownerId)
  const frame = store.createFrame(canvas.id, { name: 'Hero', html: '<button class="cta">Buy</button>' }, 'alice')!
  return { canvasId: canvas.id, frameId: frame.id }
}

beforeEach(() => {
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
    plans: new Map(),
  })
  actions.wirePresence(() => [])
  actions.wireFocus(() => [])
})

describe('get_focus', () => {
  it('is a read, and reports nobody connected as an empty list rather than an error', async () => {
    const { canvasId } = seed()
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const tool = tools.find((entry) => entry.name === 'get_focus')
      expect(tool).toBeDefined()
      expect(tool!.annotations?.readOnlyHint).toBe(true)

      const empty = await call(client, 'get_focus', { canvas_id: canvasId })
      expect(empty.isError).toBe(false)
      expect(empty.structured.humans).toEqual([])
      expect(empty.structured.latest).toBeNull()
    } finally {
      await close()
    }
  })

  it('reports the frame, element and page each human is looking at', async () => {
    const { canvasId, frameId } = seed()
    actions.wireFocus(() => [
      focus(frameId, { at: 5, selector: '.price', pageId: 'page-1' }),
      focus(frameId, { clientId: 'human-2', name: 'Sam', at: 9, frameId: null, selector: null }),
    ])
    const { client, close } = await connect()
    try {
      const result = await call(client, 'get_focus', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(result.isError).toBe(false)
      /* newest first, and the nulls of "nothing in particular" are absent
         rather than nulls the caller has to branch on */
      expect(result.structured.humans).toEqual([
        { name: 'Sam', at: 9 },
        { name: 'Kevin', frame_id: frameId, selector: '.price', page_id: 'page-1', at: 5 },
      ])
      expect(result.structured.latest).toEqual({ name: 'Sam', at: 9 })

      const unknown = await call(client, 'get_focus', { canvas_id: 'nope' })
      expect(unknown.isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('focus nudge', () => {
  it('tells the agent once per change, not once per call', async () => {
    let current: CanvasFocus[] = []
    actions.wireFocus(() => current)
    const { canvasId, frameId } = seed()
    const { client, close } = await connect()
    try {
      /* nobody focused: nothing to say */
      const quiet = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(quiet.text).not.toContain('A human is looking at')

      /* a human selects an element: the very next call carries it */
      current = [focus(frameId)]
      const told = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(told.text).toContain('A human is looking at frame “Hero” — element .cta.')

      /* the same selection again: already delivered, so no repeat */
      const again = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(again.text).not.toContain('A human is looking at')

      /* the selection moved: that is a new fact, and worth one more line */
      current = [focus(frameId, { selector: '.price', at: 2 })]
      const moved = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(moved.text).toContain('A human is looking at frame “Hero” — element .price.')

      /* clearing the selection is a change, but not an interruption */
      current = []
      const cleared = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(cleared.text).not.toContain('A human is looking at')

      /* and pointing at it again reports again, because it is news again */
      current = [focus(frameId, { at: 3 })]
      const refocused = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(refocused.text).toContain('A human is looking at frame “Hero” — element .cta.')
    } finally {
      await close()
    }
  })

  it('names the frame without an element when the human selected the frame itself', async () => {
    const { canvasId, frameId } = seed()
    actions.wireFocus(() => [focus(frameId, { selector: null })])
    const { client, close } = await connect()
    try {
      const result = await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
      expect(result.text).toContain('A human is looking at frame “Hero”.')
    } finally {
      await close()
    }
  })
})
