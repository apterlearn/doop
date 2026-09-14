import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoScreenRef } from '../shared/types.ts'

/* The queue mirrors into Postgres and broadcasts; a unit test only cares about
   the cards themselves. */
vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  saveTask: () => {},
  deleteTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveCanvas: () => {},
  saveCanvasCopy: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  setFramePage: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteCanvas: () => {},
  savePlan: () => {},
  deletePlan: () => {},
  deletePlansFor: () => {},
  flush: async () => {},
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)

/**
 * The GitHub import queues one structured card per screen (plus the
 * design-system extraction) instead of landing outline frames. These tests
 * pin what the import route relies on: ordering, de-duplication against cards
 * already on the board, and the payload a card carries.
 */

const button: RepoScreenRef = {
  kind: 'component',
  route: 'src/ui/Button.tsx',
  sourcePath: 'src/ui/Button.tsx',
  title: 'Button',
  source: 'placeholder',
}
const pricing: RepoScreenRef = {
  kind: 'page',
  route: '/pricing',
  sourcePath: 'app/pricing/page.tsx',
  title: 'Pricing',
  source: 'placeholder',
}

let canvasId: string

beforeEach(() => {
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = store.createCanvas('repo cards', 'kevin').id
})

describe('addRepoCards', () => {
  it('queues the design system first, then one sketch card per screen, all for Doop', () => {
    const cards = actions.addRepoCards(
      canvasId,
      { connectionId: 'conn-1', repo: 'acme/app', screens: [button, pricing], designSystem: true },
      'kevin',
      'user-1',
    )
    expect(cards.map((c) => c.kind)).toEqual(['design-system', 'sketch', 'sketch'])
    expect(cards.map((c) => c.status)).toEqual(['Design system of acme/app', 'Button', 'Pricing'])
    expect(cards.every((c) => c.queuedBy === 'kevin' && c.queuedByUserId === 'user-1' && !c.agentName)).toBe(true)
    expect(cards[1]!.payload).toEqual({
      connectionId: 'conn-1',
      repo: 'acme/app',
      importId: cards[0]!.payload!.importId,
      screen: button,
    })
    /* oldest first is the order the queue is worked in */
    expect(cards[0]!.startedAt).toBeLessThan(cards[2]!.startedAt)
  })

  it('does not queue a screen that is already waiting or in flight from the same connection', () => {
    actions.addRepoCards(
      canvasId,
      { connectionId: 'conn-1', repo: 'acme/app', screens: [button], designSystem: true },
      'kevin',
      'user-1',
    )
    const again = actions.addRepoCards(
      canvasId,
      { connectionId: 'conn-1', repo: 'acme/app', screens: [button, pricing], designSystem: true },
      'kevin',
      'user-1',
    )
    expect(again.map((c) => c.status)).toEqual(['Pricing'])
    /* a finished card is history — the same screen can be imported again */
    for (const c of actions.getTasks(canvasId)) actions.completeCard(canvasId, c.id)
    const fresh = actions.addRepoCards(
      canvasId,
      { connectionId: 'conn-1', repo: 'acme/app', screens: [button], designSystem: false },
      'kevin',
      'user-1',
    )
    expect(fresh.map((c) => c.kind)).toEqual(['sketch'])
  })
})

describe('trimTaskLog', () => {
  it('drops the oldest finished tasks first and never an open card', () => {
    const now = Date.now()
    const list = Array.from({ length: 130 }, (_, i) => ({
      id: `t${i}`,
      agentName: i % 3 === 0 ? '' : AGENT,
      color: '#000',
      status: `task ${i}`,
      startedAt: now - i,
      /* every third task is an open queued card; the rest are finished */
      ...(i % 3 === 0 ? { queuedBy: 'kevin', stage: 0 } : { endedAt: now }),
    }))
    const trimmed = actions.trimTaskLog(list)
    expect(trimmed).toHaveLength(100)
    expect(trimmed.filter((t) => t.queuedBy && !t.endedAt)).toHaveLength(44)
    /* newest first is preserved; the finished tasks that survive are the newest ones */
    expect(trimmed[0]!.id).toBe('t0')
    expect(trimmed.some((t) => t.id === 't128')).toBe(false)
    expect(trimmed.some((t) => t.id === 't1')).toBe(true)
  })
})

describe('planRepoCards', () => {
  it('reports nothing to queue when every screen is already on the board, without touching it', () => {
    const input = { connectionId: 'conn-1', repo: 'acme/app', screens: [button], designSystem: true }
    actions.addRepoCards(canvasId, input, 'kevin', 'user-1')
    const before = actions.getTasks(canvasId).length
    expect(actions.planRepoCards(canvasId, input)).toEqual([])
    expect(actions.getTasks(canvasId)).toHaveLength(before)
    expect(actions.planRepoCards(canvasId, { ...input, screens: [button, pricing] }).map((w) => w.title)).toEqual([
      'Pricing',
    ])
  })
})
