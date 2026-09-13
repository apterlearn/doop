import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Frame } from '../shared/types.ts'

/* Cards are persisted and broadcast; these cases only care about what a card
   carries, so both sides are stubbed. The list is the one a resident run
   touches too — the kickoff case below runs a real one. */
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
  deleteTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveFrameReview: () => {},
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
  listFrameVersions: async () => [],
  getFrameVersion: async () => undefined,
  listGuidelineVersions: async () => [],
  flush: async () => {},
  hydrate: async () => ({}),
}))

/* The resident loop's model is stubbed so the kickoff a run sends can be read
   back. Off by default: the card-shape cases above queue cards too, and they
   must not start runs. */
const modelStub = vi.hoisted(() => ({
  enabled: false,
  /** each run's turns, flattened to text — a run's kickoff is runs[n][0] */
  runs: [] as { role: string; text: string }[][],
}))

vi.mock('../server/agentModel.ts', () => ({
  ModelAuthError: class ModelAuthError extends Error {},
  pickModel: async () =>
    modelStub.enabled
      ? {
          provider: 'anthropic',
          label: 'test model',
          userId: 'user-1',
          run: async (req: { messages: { role: string; content: unknown }[] }) => {
            const turn = req.messages.map((m) => ({
              role: m.role,
              text:
                typeof m.content === 'string'
                  ? m.content
                  : (m.content as { type: string; text?: string }[])
                      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
                      .join(' '),
            }))
            /* a run opens with the single kickoff message */
            if (req.messages.length === 1) modelStub.runs.push(turn)
            /* the opening turn uses a tool so the loop comes back with tool
               results; the next turn ends the run */
            return req.messages.length === 1
              ? {
                  content: [
                    { type: 'text' as const, text: 'looking' },
                    { type: 'tool_use' as const, id: 'tu1', name: 'set_status', input: { status: 'working' } },
                  ],
                  stop_reason: 'tool_use',
                  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
                }
              : {
                  content: [{ type: 'text' as const, text: 'done' }],
                  stop_reason: 'end_turn',
                  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
                }
          },
        }
      : null,
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const resident = await import('../server/resident.ts')

/**
 * A card queued from a canvas selection is about THAT frame: the agent edits it
 * in place instead of delivering somewhere else. The targets are validated like
 * the attachments are — only frames on this canvas, deduped, capped — because a
 * card naming a frame that is not here would send the agent hunting.
 */

/* hydrateLogs only overwrites the canvases it is given, so each case gets its
   own canvas — a shared one would carry the previous case's cards over. */
let CANVAS = ''

function frame(id: string, canvasId: string): Frame {
  return {
    id,
    canvasId,
    name: `Frame ${id}`,
    html: '<p/>',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: 'alice',
  }
}

beforeEach(() => {
  CANVAS = `canvas-${Math.random().toString(36).slice(2, 10)}`
  modelStub.enabled = false
  modelStub.runs.length = 0
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
  vi.spyOn(store, 'getCanvas').mockImplementation((id) => (id === CANVAS ? ({ id: CANVAS } as never) : undefined))
  vi.spyOn(store, 'getFrame').mockImplementation((id) => {
    if (id === 'here') return frame('here', CANVAS)
    if (id === 'other') return frame('other', 'canvas-2')
    return undefined
  })
  vi.spyOn(store, 'getPage').mockImplementation((id) =>
    id === 'page-here' ? ({ canvas: { id: CANVAS }, page: { id } } as never) : undefined,
  )
})

describe('addQueuedCard target frames', () => {
  it('keeps only frames that live on this canvas, deduped', () => {
    const card = actions.addQueuedCard(CANVAS, 'make the hero bigger', 'alice', undefined, undefined, 'alice', [
      'here',
      'other',
      'here',
      'missing',
    ])

    expect(card?.targetFrameIds).toEqual(['here'])
  })

  it('leaves the targets off a card that was not aimed at anything', () => {
    const card = actions.addQueuedCard(CANVAS, 'design a pricing page', 'alice')
    expect(card?.targetFrameIds).toBeUndefined()
  })

  it('caps the targets at four', () => {
    vi.spyOn(store, 'getFrame').mockImplementation((id) => (/^f\d$/.test(id) ? frame(id, CANVAS) : undefined))
    const card = actions.addQueuedCard(CANVAS, 'tighten these', 'alice', undefined, undefined, 'alice', [
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
    ])
    expect(card?.targetFrameIds).toEqual(['f1', 'f2', 'f3', 'f4'])
  })

  it('treats the same prompt aimed at a different frame as a new card', () => {
    const first = actions.addQueuedCard(CANVAS, 'make it bigger', 'alice', undefined, undefined, 'alice', ['here'])
    vi.spyOn(store, 'getFrame').mockImplementation((id) =>
      id === 'here' || id === 'second' ? frame(id, CANVAS) : undefined,
    )
    const second = actions.addQueuedCard(CANVAS, 'make it bigger', 'alice', undefined, undefined, 'alice', ['second'])

    expect(second?.id).not.toBe(first?.id)
    expect(actions.getTasks(CANVAS)).toHaveLength(2)
  })

  it('still collapses a duplicate of the same prompt aimed at the same frame', () => {
    const first = actions.addQueuedCard(CANVAS, 'make it bigger', 'alice', undefined, undefined, 'alice', ['here'])
    const again = actions.addQueuedCard(CANVAS, 'make it bigger', 'alice', undefined, undefined, 'alice', ['here'])

    expect(again?.id).toBe(first?.id)
    expect(actions.getTasks(CANVAS)).toHaveLength(1)
  })
})

describe('addQueuedCard target element', () => {
  it('carries the element and page the human pointed at', () => {
    const card = actions.addQueuedCard(
      CANVAS,
      'fix this',
      'alice',
      undefined,
      undefined,
      'alice',
      ['here'],
      '.hero h1',
      'page-here',
    )

    expect(card?.targetSelector).toBe('.hero h1')
    expect(card?.targetPageId).toBe('page-here')
  })

  it('leaves the element off a card that is not about a frame', () => {
    const card = actions.addQueuedCard(
      CANVAS,
      'design a pricing page',
      'alice',
      undefined,
      undefined,
      'alice',
      undefined,
      '.hero h1',
      'page-here',
    )

    expect(card?.targetSelector).toBeUndefined()
    expect(card?.targetPageId).toBeUndefined()
  })

  it('keeps the selector but drops a page that is not on this canvas', () => {
    const card = actions.addQueuedCard(
      CANVAS,
      'fix this',
      'alice',
      undefined,
      undefined,
      'alice',
      ['here'],
      '.hero h1',
      'page-elsewhere',
    )

    expect(card?.targetSelector).toBe('.hero h1')
    expect(card?.targetPageId).toBeUndefined()
  })

  it('treats the same prompt on the same frame but a different element as a new card', () => {
    const first = actions.addQueuedCard(CANVAS, 'fix it', 'alice', undefined, undefined, 'alice', ['here'], '.hero h1')
    const second = actions.addQueuedCard(CANVAS, 'fix it', 'alice', undefined, undefined, 'alice', ['here'], '.hero h2')

    expect(second?.id).not.toBe(first?.id)
    expect(actions.getTasks(CANVAS)).toHaveLength(2)
  })
})

describe('the kickoff a card produces', () => {
  /* the resident loop reads the card, so this case runs a real one against a
     stubbed model and reads back the prompt the agent was given */
  it('names the target element and the page it lives on', async () => {
    vi.restoreAllMocks()
    modelStub.enabled = true
    const canvas = store.createCanvas('target element', 'alice')
    const page = canvas.pages![0]!
    const target = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>Hi</h1>' }, 'alice')!
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
    })

    const card = actions.addQueuedCard(
      canvas.id,
      'fix this heading',
      'alice',
      undefined,
      undefined,
      'alice',
      [target.id],
      '.hero h1',
      page.id,
    )!
    resident.onFeedback(canvas.id)
    /* the stubbed model changes nothing, so the run ends the card as failed —
       either way it is terminal once the run is done */
    await vi.waitFor(() => {
      const settled = actions.getTasks(canvas.id).find((t) => t.id === card.id)
      expect(settled?.failedAt ?? settled?.endedAt).toBeTruthy()
    })

    const kickoff = modelStub.runs[0]![0]!.text
    expect(kickoff).toContain('fix this heading')
    expect(kickoff).toContain('TARGET ELEMENT: .hero h1')
    expect(kickoff).toContain(`page ${page.id}`)
  })
})
