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
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
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
  /* arrival is not what these cases are about */
  vi.spyOn(actions, 'heartbeatAgent').mockImplementation(() => {})
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

  it('routes the comment to a connected agent that is not a pipeline role', async () => {
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

/* The work channel. A human @mentions a role in a note on an element; the
   agent connected to that role takes it with claim_comment, and says so with
   fail_comment when it cannot finish it. Both run the real actions, so the
   claim that hands one agent a note — and hides it from the next — is the
   thing under test. */
describe('claim_comment and fail_comment', () => {
  function withPresentAgent(name: string) {
    actions.wirePresence((canvasId) => (canvasId === CANVAS.id ? [{ name, lastSeen: Date.now() }] : []))
  }

  /** A human's note @mentioning Claude, routed for real. */
  function mentionedNote(text = '@Claude make the hero bigger'): ElementComment {
    withPresentAgent('Claude')
    return actions.addElementComment(
      FRAME.id,
      { selector: '.hero h1', snippet: '<h1>Hi</h1>', text },
      actions.resolveActor({ name: 'alice', kind: 'user' }),
    )!
  }

  beforeEach(() => {
    /* the comment log is module state: each case starts with an empty canvas
       so one test's claimed note cannot answer the next one's claim */
    actions.hydrateLogs({
      comments: new Map([[CANVAS.id, []]]),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })
  })

  it('registers both as writes, claim harmless and a failure destructive', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const claim = byName.get('claim_comment')
      const fail = byName.get('fail_comment')
      expect(claim).toBeDefined()
      expect(fail).toBeDefined()
      expect(claim!.annotations?.readOnlyHint).toBe(false)
      expect(claim!.annotations?.destructiveHint).toBe(false)
      expect(fail!.annotations?.readOnlyHint).toBe(false)
      expect(fail!.annotations?.destructiveHint).toBe(true)
      expect(claim!.outputSchema).toBeDefined()
      expect(fail!.outputSchema).toBeDefined()
      const claimSchema = claim!.inputSchema as unknown as { required?: string[] }
      /* the claim is the call that names the role it works as — canvas_id is
         optional on the wire, supplied by the session when it is known */
      expect(claimSchema.required).toContain('agent_name')
      const failSchema = fail!.inputSchema as unknown as { required?: string[] }
      expect(failSchema.required).toEqual(expect.arrayContaining(['comment_id', 'reason']))
    } finally {
      await close()
    }
  })

  it('hands the @mentioned note to the claiming agent once, and nothing on a second claim', async () => {
    const note = mentionedNote()
    const { client, close } = await connect()
    try {
      const first = await call(client, 'claim_comment', { canvas_id: CANVAS.id, agent_name: 'Claude' })
      expect(first.result.isError).toBeFalsy()
      const claimed = JSON.parse(first.raw) as { comments: ElementComment[] }
      expect(claimed.comments.map((c) => c.id)).toEqual([note.id])
      expect(claimed.comments[0]).toMatchObject({
        text: '@Claude make the hero bigger',
        from: 'alice',
        selector: '.hero h1',
      })
      /* the pin flips to "Claude is on it" for the human watching */
      expect(actions.findComment(note.id)?.claimedBy).toBe('Claude')

      /* idempotent per note: the second agent to call gets nothing, not the
         same work again */
      const second = await call(client, 'claim_comment', { canvas_id: CANVAS.id, agent_name: 'Claude' })
      expect(second.result.isError).toBeFalsy()
      expect(JSON.parse(second.raw)).toEqual({ comments: [] })
    } finally {
      await close()
    }
  })

  it('marks a claimed note failed with the reason, and it stops being claimable', async () => {
    const note = mentionedNote()
    const { client, close } = await connect()
    try {
      await call(client, 'claim_comment', { canvas_id: CANVAS.id, agent_name: 'Claude' })
      const { result, raw } = await call(client, 'fail_comment', {
        comment_id: note.id,
        reason: 'the hero image is not in the asset library',
        agent_name: 'Claude',
      })

      expect(result.isError).toBeFalsy()
      expect(JSON.parse(raw)).toEqual({ ok: true, id: note.id, failed: true })
      const failed = actions.findComment(note.id)!
      expect(failed.failedAt).toBeDefined()
      expect(failed.failureReason).toBe('the hero image is not in the asset library')
      /* stopped, not resolved: the human reads why and can hand it back */
      expect(failed.resolvedAt).toBeUndefined()
      expect(actions.takeAgentCommentsFor(CANVAS.id, 'Claude')).toEqual([])
    } finally {
      await close()
    }
  })

  it('refuses to fail a note that is already resolved, and an unknown id', async () => {
    const note = mentionedNote()
    const { client, close } = await connect()
    try {
      actions.resolveComment(note.id, actions.resolveActor({ name: 'Claude', kind: 'agent' }))
      const resolved = await call(client, 'fail_comment', {
        comment_id: note.id,
        reason: 'too late',
        agent_name: 'Claude',
      })
      expect(resolved.result.isError).toBe(true)
      expect(resolved.raw).toContain('already resolved')

      const unknown = await call(client, 'fail_comment', {
        comment_id: 'nope',
        reason: 'gone',
        agent_name: 'Claude',
      })
      expect(unknown.result.isError).toBe(true)
      expect(unknown.raw).toContain('no comment with id nope')
    } finally {
      await close()
    }
  })

  /* The realistic flow: a human picks a role in the composer, so the note is
     addressed to the ROLE ("Accessibility"), while the agent that works it is
     an MCP client with a name of its own. Without the role argument the note
     would never match and the only work channel would go dead. */
  it('hands a role-addressed note to an agent that names the role it works', async () => {
    const note = actions.addElementComment(
      FRAME.id,
      { selector: '.hero h1', snippet: '<h1>Hi</h1>', text: '@a11y the heading contrast is too low' },
      actions.resolveActor({ name: 'alice', kind: 'user' }),
    )!
    /* the mention is stored as the role's name, not the agent's */
    expect(note.targetAgent).toBe('Accessibility')
    const { client, close } = await connect()
    try {
      /* an agent named "Claude" claims nothing by name alone... */
      const byName = await call(client, 'claim_comment', { canvas_id: CANVAS.id, agent_name: 'Claude' })
      expect(JSON.parse(byName.raw)).toEqual({ comments: [] })
      /* ...and the empty answer says what to pass instead of dead-ending */
      expect(byName.result.content.some((b) => /role/i.test(b.text ?? ''))).toBe(true)

      /* ...but takes the note when it names the role it works */
      const byRole = await call(client, 'claim_comment', {
        canvas_id: CANVAS.id,
        agent_name: 'Claude',
        role: 'a11y',
      })
      const claimed = JSON.parse(byRole.raw) as { comments: ElementComment[] }
      expect(claimed.comments.map((c) => c.id)).toEqual([note.id])
      /* the pin credits the agent that is actually on it, not the role */
      expect(actions.findComment(note.id)?.claimedBy).toBe('Claude')
    } finally {
      await close()
    }
  })

  /* A solo worker often connects NAMED after the role it works. It is woken by
     role mentions (the matcher resolves both spellings), so it must be able to
     claim them too — resolving the caller's identity by display name alone left
     it woken but unable to take the note, silently, on every comment. */
  it('lets an agent named after a role claim that role’s notes', async () => {
    const note = actions.addElementComment(
      FRAME.id,
      { selector: '.hero h1', snippet: '<h1>Hi</h1>', text: '@a11y the tap targets are small' },
      actions.resolveActor({ name: 'alice', kind: 'user' }),
    )!
    expect(note.targetAgent).toBe('Accessibility')
    const { client, close } = await connect()
    try {
      /* no role argument: the agent's own name IS the role id */
      const claimed = await call(client, 'claim_comment', { canvas_id: CANVAS.id, agent_name: 'a11y' })
      const parsed = JSON.parse(claimed.raw) as { comments: ElementComment[] }
      expect(parsed.comments.map((c) => c.id)).toEqual([note.id])
      expect(actions.findComment(note.id)?.claimedBy).toBe('a11y')

      /* The empty second call must not tell it to "pass role": its name already
         resolves to the role it just claimed under, so "nothing is addressed to
         a11y by name" would be false and the advice unusable. */
      const again = await call(client, 'claim_comment', { canvas_id: CANVAS.id, agent_name: 'a11y' })
      expect(JSON.parse(again.raw)).toEqual({ comments: [] })
      const nudge = (again.result.content ?? []).map((b) => b.text ?? '').join('\n')
      expect(nudge).not.toContain('by name')
      expect(nudge).toContain('Accessibility')
    } finally {
      await close()
    }
  })

  it('refuses a role that does not exist, naming the real ones', async () => {
    const { client, close } = await connect()
    try {
      const bad = await call(client, 'claim_comment', {
        canvas_id: CANVAS.id,
        agent_name: 'Claude',
        role: 'wizard',
      })
      expect(bad.result.isError).toBe(true)
      expect(bad.raw).toContain('no role')
      expect(bad.raw).toContain('wizard')
      expect(bad.raw).toContain('a11y')
    } finally {
      await close()
    }
  })
})
