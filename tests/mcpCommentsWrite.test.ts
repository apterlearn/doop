import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Actor, Canvas, ElementComment, Frame } from '../shared/types.ts'

/* Comments are persisted and broadcast; the routing cases below run the real
   action, so the two sides it touches are stubbed instead of reaching a db. */
vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveJournal: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  saveTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
}))

const OWNER_ID = 'owner-1'

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Comments',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}

const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS.id,
  name: 'Hero',
  html: '<h1>Hi</h1>',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

const ROOT: ElementComment = {
  id: 'm1',
  canvasId: CANVAS.id,
  frameId: FRAME.id,
  selector: '.hero h1',
  snippet: '<h1>Hi</h1>',
  from: 'alice',
  text: 'Too small',
  at: 1,
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-comment-write-test', version: '1.0.0' })
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  return { result, raw: result.content.find((block) => block.type === 'text')?.text ?? '' }
}

/** The Actor the MCP layer hands to actions for a given agent_name. */
const agentActor = (name: string): Actor => ({ name, kind: 'agent', color: expect.any(String) as unknown as string })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => (id === CANVAS.id ? CANVAS : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => (id === FRAME.id ? FRAME : undefined))
  /* arrival and the feedback channel are not what these cases are about */
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
  vi.spyOn(actions, 'takeFeedbackFor').mockReturnValue([])
})

describe('add_comment', () => {
  it('pins the note as the calling agent, with the selector it was given', async () => {
    const created = { ...ROOT, id: 'm9', from: 'Claude', fromKind: 'agent' as const }
    const add = vi.spyOn(actions, 'addElementComment').mockReturnValue(created)
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'add_comment', {
        frame_id: FRAME.id,
        selector: '.hero h1',
        snippet: '<h1>Hi</h1>',
        text: 'Raised it to 48px',
        agent_name: 'Claude',
      })

      expect(result.isError).toBeFalsy()
      expect(JSON.parse(raw).id).toBe('m9')
      const [frameId, input, actor] = add.mock.calls[0]!
      expect(frameId).toBe(FRAME.id)
      expect(input).toEqual({ selector: '.hero h1', snippet: '<h1>Hi</h1>', text: 'Raised it to 48px' })
      expect(actor).toMatchObject(agentActor('Claude'))
      expect(actor.kind).toBe('agent')
    } finally {
      await close()
    }
  })

  it('reports an error instead of a phantom comment when the text is empty', async () => {
    vi.spyOn(actions, 'addElementComment').mockReturnValue(undefined)
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'add_comment', {
        frame_id: FRAME.id,
        selector: '.hero h1',
        text: '   ',
        agent_name: 'Claude',
      })
      expect(result.isError).toBe(true)
      expect(raw).toContain('could not add the comment')
    } finally {
      await close()
    }
  })
})

describe('reply_to_comment', () => {
  it('replies in the thread as the calling agent', async () => {
    const reply = { ...ROOT, id: 'm2', from: 'Claude', text: 'Done', parentId: ROOT.id, fromKind: 'agent' as const }
    vi.spyOn(actions, 'findComment').mockReturnValue(ROOT)
    const add = vi.spyOn(actions, 'replyToComment').mockReturnValue(reply)
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'reply_to_comment', {
        comment_id: ROOT.id,
        text: 'Done',
        agent_name: 'Claude',
      })

      expect(result.isError).toBeFalsy()
      expect(JSON.parse(raw).parentId).toBe(ROOT.id)
      expect(add.mock.calls[0]?.[0]).toBe(ROOT.id)
      expect(add.mock.calls[0]?.[2]).toMatchObject(agentActor('Claude'))
    } finally {
      await close()
    }
  })

  it('refuses a resolved thread without creating a reply', async () => {
    vi.spyOn(actions, 'findComment').mockReturnValue({ ...ROOT, resolvedAt: 9, resolvedBy: 'alice' })
    const add = vi.spyOn(actions, 'replyToComment').mockReturnValue(undefined)
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'reply_to_comment', {
        comment_id: ROOT.id,
        text: 'Too late?',
        agent_name: 'Claude',
      })
      expect(result.isError).toBe(true)
      expect(raw).toContain('resolved')
      expect(add).toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('rejects an unknown comment id', async () => {
    vi.spyOn(actions, 'findComment').mockReturnValue(undefined)
    const add = vi.spyOn(actions, 'replyToComment')
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'reply_to_comment', {
        comment_id: 'nope',
        text: 'hi',
        agent_name: 'Claude',
      })
      expect(result.isError).toBe(true)
      expect(raw).toContain('no comment with id nope')
      expect(add).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

describe('resolve_comment', () => {
  it('closes the thread as the calling agent and reports it', async () => {
    vi.spyOn(actions, 'findComment').mockReturnValue(ROOT)
    const resolve = vi
      .spyOn(actions, 'resolveComment')
      .mockReturnValue({ ...ROOT, resolvedAt: 5, resolvedBy: 'Claude' })
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'resolve_comment', {
        comment_id: ROOT.id,
        agent_name: 'Claude',
      })

      expect(result.isError).toBeFalsy()
      expect(JSON.parse(raw)).toMatchObject({ ok: true, id: ROOT.id, resolved: true })
      expect(resolve.mock.calls[0]?.[1]).toMatchObject(agentActor('Claude'))
    } finally {
      await close()
    }
  })

  it('rejects an unknown comment id', async () => {
    vi.spyOn(actions, 'findComment').mockReturnValue(undefined)
    const resolve = vi.spyOn(actions, 'resolveComment')
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'resolve_comment', { comment_id: 'nope', agent_name: 'Claude' })
      expect(result.isError).toBe(true)
      expect(raw).toContain('no comment with id nope')
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

describe('@mentions of connected agents', () => {
  /* These run the real action: routing a comment to an agent is exactly what
     is under test, so addElementComment must not be stubbed. Presence is
     injected the way index.ts wires it. */
  function withPresentAgent(name: string) {
    actions.wirePresence((canvasId) => (canvasId === CANVAS.id ? [{ name, lastSeen: Date.now() }] : []))
  }

  it('routes the comment to a connected agent that is not a resident role', async () => {
    withPresentAgent('OutsideAgent')
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'add_comment', {
        frame_id: FRAME.id,
        selector: '.hero h1',
        snippet: '<h1>Hi</h1>',
        text: '@OutsideAgent hi',
        agent_name: 'Claude',
      })

      expect(result.isError).toBeFalsy()
      expect(JSON.parse(raw)).toMatchObject({ forAgent: true, targetAgent: 'OutsideAgent', text: '@OutsideAgent hi' })
    } finally {
      await close()
    }
  })

  it('leaves a comment addressed to a name nobody answers to untargeted', async () => {
    withPresentAgent('OutsideAgent')
    const { client, close } = await connect()
    try {
      const { result, raw } = await call(client, 'add_comment', {
        frame_id: FRAME.id,
        selector: '.hero h1',
        snippet: '<h1>Hi</h1>',
        text: '@Nobody hi',
        agent_name: 'Claude',
      })

      expect(result.isError).toBeFalsy()
      const comment = JSON.parse(raw) as ElementComment
      expect(comment.forAgent).toBeUndefined()
      expect(comment.targetAgent).toBeUndefined()
    } finally {
      await close()
    }
  })
})
