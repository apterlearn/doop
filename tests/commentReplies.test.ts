import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* Replies are persisted and broadcast like any comment; the unit tests only
   care about how a thread is shaped, so both sides are stubbed. */
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
  deleteCanvas: () => {},
  deleteFrame: () => {},
  deletePage: () => {},
  deleteComponentRow: () => {},
  deleteGuideline: () => {},
  releaseFrames: () => [],
  freezeFrames: () => [],
  MAX_CANVAS_VERSIONS: 50,
  saveCanvasVersion: () => {},
  listCanvasVersions: async () => [],
  getCanvasVersion: async () => undefined,
  summarizeCanvasVersion: () => ({ id: '', cause: 'auto', createdAt: 0, createdBy: '', frameCount: 0 }),
  deleteCanvasVersion: () => {},
  pruneCanvasVersions: () => {},
  restoreFrameRow: () => {},
  restoreCanvasRow: () => {},
  hardDeleteFrame: () => {},
  hardDeleteCanvas: () => {},
  purgeTrash: () => {},
  TRASH_RETENTION_DAYS: 30,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
const CANVAS = 'canvas-1'
const FRAME: Frame = {
  id: 'f1',
  canvasId: CANVAS,
  name: 'Hero',
  html: '<p/>',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
  z: 0,
  locked: false,
  hidden: false,
  rotation: 0,
  opacity: 1,
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map([[CANVAS, []]]),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  vi.spyOn(store, 'getFrame').mockImplementation((id) => (id === FRAME.id ? FRAME : undefined))
})

/** Comment mutations take an Actor, not a bare name: an agent writing
 *  through MCP must be attributed as one. */
const human = (name: string) => actions.resolveActor({ name, kind: 'user' })

function root() {
  return actions.addElementComment(
    FRAME.id,
    { selector: '.hero h1', snippet: '<h1>Hi</h1>', text: 'Too small' },
    human('alice'),
  )!
}

describe('replying to a comment', () => {
  it('threads the reply under the root and inherits its element', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, 'Agreed', human('bob'))!
    expect(reply.parentId).toBe(parent.id)
    expect(reply.selector).toBe(parent.selector)
    expect(reply.snippet).toBe(parent.snippet)
    expect(actions.commentThread(reply).map((c) => c.text)).toEqual(['Too small', 'Agreed'])
  })

  it('gives every message a distinct timestamp so order survives a reload', () => {
    const parent = root()
    const first = actions.replyToComment(parent.id, 'one', human('bob'))!
    const second = actions.replyToComment(parent.id, 'two', human('carol'))!
    expect(first.at).toBeGreaterThan(parent.at)
    expect(second.at).toBeGreaterThan(first.at)
  })

  it('re-roots a reply to a reply, keeping threads one level deep', () => {
    const parent = root()
    const first = actions.replyToComment(parent.id, 'Agreed', human('bob'))!
    const second = actions.replyToComment(first.id, 'Same', human('carol'))!
    expect(second.parentId).toBe(parent.id)
    expect(actions.commentThread(parent).map((c) => c.from)).toEqual(['alice', 'bob', 'carol'])
  })

  it('routes an @mention in a reply to the agent with the thread anchor', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} make it 48px`, human('alice'), 'alice')!
    expect(reply.forAgent).toBe(true)
    expect(reply.targetAgent).toBe(AGENT)
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual([reply.id])
  })

  it('reports whether a thread can take a reply before anything is metered', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, 'Agreed', human('bob'))!
    expect(actions.openThread(reply.id)?.root.id).toBe(parent.id)
    actions.resolveComment(parent.id, human('alice'))
    expect(actions.openThread(reply.id)).toBeUndefined()
    expect(actions.openThread('missing')).toBeUndefined()
  })

  it('refuses replies on a resolved thread or with empty text', () => {
    const parent = root()
    expect(actions.replyToComment(parent.id, '   ', human('bob'))).toBeUndefined()
    actions.resolveComment(parent.id, human('alice'))
    expect(actions.replyToComment(parent.id, 'Late', human('bob'))).toBeUndefined()
    expect(actions.replyToComment('missing', 'Hello', human('bob'))).toBeUndefined()
  })

  it('resolving the root closes every open reply so none stays queued for an agent', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} bigger`, human('alice'), 'alice')!
    actions.resolveComment(parent.id, human('alice'))
    expect(actions.findComment(reply.id)?.resolvedAt).toBeDefined()
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')).toEqual([])
  })

  it('resolving a reply leaves the thread open', () => {
    const parent = root()
    const reply = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} bigger`, human('alice'), 'alice')!
    actions.resolveComment(reply.id, actions.resolveActor({ name: AGENT, kind: 'agent' }))
    expect(actions.findComment(parent.id)?.resolvedAt).toBeUndefined()
    expect(actions.findComment(reply.id)?.resolvedBy).toBe(AGENT)
  })

  it('marks an agent-authored message so the canvas can badge it', () => {
    const parent = root()
    const fromAgent = actions.replyToComment(
      parent.id,
      'Raised it to 48px',
      actions.resolveActor({ name: AGENT, kind: 'agent' }),
    )!
    expect(fromAgent.fromKind).toBe('agent')
    expect(parent.fromKind).toBeUndefined()
  })
})

describe('failing and retrying a claimed note', () => {
  it('a failed note stops being claimable until a human retries it, then any agent can take it', () => {
    const parent = root()
    const note = actions.replyToComment(parent.id, `@${DEFAULT_ROLE_ID} bigger`, human('alice'), 'alice')!

    const [claimed] = actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')
    expect(claimed!.id).toBe(note.id)

    const failed = actions.failComment(note.id, 'the asset is missing')!
    expect(failed.failedAt).toBeDefined()
    expect(failed.failureReason).toBe('the asset is missing')
    /* stopped, not closed: the human reads why, and no other agent picks up
       work that is known not to be doable */
    expect(failed.resolvedAt).toBeUndefined()
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice')).toEqual([])

    const retried = actions.retryComment(note.id, 'alice')!
    expect(retried.failedAt).toBeUndefined()
    expect(retried.failureReason).toBeUndefined()
    expect(retried.claimedBy).toBeUndefined()
    expect(actions.takeAgentCommentsFor(CANVAS, AGENT, 'alice').map((c) => c.id)).toEqual([note.id])
  })
})
