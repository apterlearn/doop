import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { store } from '../server/store.ts'
import type { Canvas, FrameVersion } from '../shared/types.ts'

/* Queue ordering and frame-version revert run against the real actions/store
   machinery; persist is stubbed, the ordering logic is real. */
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
  deleteTask: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  saveCanvas: () => {},
  saveFrameVersion: () => {},
  appendFrameVersion: async () => {},
  listFrameVersions: async () => [] as FrameVersion[],
  savePage: () => {},
}))

const OWNER_ID = 'owner-1'
let canvas: Canvas

function wireBroadcasts() {
  actions.wire(
    () => {},
    () => {},
    () => {},
    () => {},
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
    plans: new Map(),
  })
  wireBroadcasts()
  canvas = store.createCanvas(`queue-${Math.random().toString(36).slice(2, 8)}`, OWNER_ID)
})

describe('queue priority', () => {
  it('claims higher-priority cards first, then position order', () => {
    const low = actions.addQueuedCard(canvas.id, 'low', 'owner', undefined, undefined, OWNER_ID)!
    const high = actions.addQueuedCard(canvas.id, 'high', 'owner', undefined, undefined, OWNER_ID)!
    const mid = actions.addQueuedCard(canvas.id, 'mid', 'owner', undefined, undefined, OWNER_ID)!
    actions.setCardPriority(canvas.id, low.id, 0)
    actions.setCardPriority(canvas.id, high.id, 5)
    actions.setCardPriority(canvas.id, mid.id, 1)

    const claimed = actions.takeQueuedCardsFor(canvas.id, 'Doop', OWNER_ID)
    expect(claimed.map((c) => c.status)).toEqual(['high', 'mid', 'low'])
  })

  it('reorder rewrites position among equal-priority cards', () => {
    const a = actions.addQueuedCard(canvas.id, 'first', 'owner', undefined, undefined, OWNER_ID)!
    const b = actions.addQueuedCard(canvas.id, 'second', 'owner', undefined, undefined, OWNER_ID)!
    const c = actions.addQueuedCard(canvas.id, 'third', 'owner', undefined, undefined, OWNER_ID)!

    actions.reorderCards(canvas.id, [c.id, a.id, b.id])
    const claimed = actions.takeQueuedCardsFor(canvas.id, 'Doop', OWNER_ID)
    expect(claimed.map((x) => x.status)).toEqual(['third', 'first', 'second'])
  })

  it('paused cards are skipped until resumed', () => {
    const card = actions.addQueuedCard(canvas.id, 'pausable', 'owner', undefined, undefined, OWNER_ID)!
    actions.claimCard(canvas.id, card.id, 'Doop')
    expect(actions.pauseAgentWork(canvas.id, 'Doop', 'owner')).toBe(1)
    expect(actions.takeQueuedCardsFor(canvas.id, 'Doop', OWNER_ID)).toHaveLength(0)

    const resumed = actions.resumeCard(canvas.id, card.id, 'owner')
    expect(resumed?.pausedAt).toBeUndefined()
    expect(actions.takeQueuedCardsFor(canvas.id, 'Doop', OWNER_ID).map((c) => c.status)).toEqual(['pausable'])
  })
})

describe('hand_back', () => {
  it('sends a card back to an earlier pipeline stage and records the reason', () => {
    const card = actions.addQueuedCard(canvas.id, 'needs copy first', 'owner', ['copy', 'ux'], undefined, OWNER_ID)!
    actions.claimCard(canvas.id, card.id, 'UX Lead')
    const actor = actions.resolveActor({ name: 'ux lead', kind: 'agent', ownerId: OWNER_ID })
    const handed = actions.handBackCard(canvas.id, card.id, 'Copywriter', 'copy must exist before layout', actor)
    expect(handed?.stage).toBe(0)
    expect(handed?.handback).toMatchObject({ fromAgent: 'ux lead', reason: 'copy must exist before layout' })
    expect(handed?.agentName).toBe('')
  })

  it('refuses a role outside the card pipeline', () => {
    const card = actions.addQueuedCard(canvas.id, 'scoped work', 'owner', ['copy', 'ux'], undefined, OWNER_ID)!
    actions.claimCard(canvas.id, card.id, 'Copywriter')
    const actor = actions.resolveActor({ name: 'copywriter', kind: 'agent', ownerId: OWNER_ID })
    const handed = actions.handBackCard(canvas.id, card.id, 'Accessibility', 'wrong lane', actor)
    expect(handed?.handback).toBeUndefined()
  })
})
