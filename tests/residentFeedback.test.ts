import { beforeEach, describe, expect, it, vi } from 'vitest'

/* A resident run is long. A human who asks for something while it is working
   must reach the turn that is about to run, not the next sweep — otherwise the
   agent delivers a design the human already asked it to change. The model is
   stubbed so the test can watch what the run actually sends. */

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

interface SentTurn {
  role: string
  /** the plain text the model was shown on this turn */
  text: string
}

/** Every run's turns, in order, flattened to the text blocks. */
const runs: SentTurn[][][] = []
/** Set to have the stub drop feedback into the canvas mid-turn. */
let injectOnTurn: (() => void) | null = null

vi.mock('../server/agentModel.ts', () => ({
  ModelAuthError: class ModelAuthError extends Error {},
  pickModel: async () => ({
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
      /* a run opens with the single kickoff message: that is what starts a
         fresh turn list, whatever ran before */
      const opening = req.messages.length === 1
      if (opening) runs.push([])
      runs[runs.length - 1]!.push(turn)
      if (opening && injectOnTurn) {
        const inject = injectOnTurn
        injectOnTurn = null
        inject()
      }
      /* the opening turn uses a tool so the loop comes back with tool results;
         the next turn ends the run */
      if (opening) {
        return {
          content: [
            { type: 'text' as const, text: 'looking' },
            { type: 'tool_use' as const, id: 'tu1', name: 'set_status', input: { status: 'working' } },
          ],
          stop_reason: 'tool_use',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        }
      }
      return {
        content: [{ type: 'text' as const, text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      }
    },
  }),
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const resident = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)
let CANVAS = ''
let cardId = ''
let feedbackId = ''

function terminalCard() {
  const card = actions.getTasks(CANVAS).find((t) => t.id === cardId)!
  return card.cancelledAt ?? card.failedAt ?? card.endedAt ?? false
}

beforeEach(() => {
  runs.length = 0
  injectOnTurn = null
  actions.wire(
    () => {},
    () => {},
    resident.cancelCanvasRuns,
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
  CANVAS = store.createCanvas('mid-run feedback', 'alice').id
  cardId = actions.addQueuedCard(CANVAS, 'Make a hero', 'alice', undefined, undefined, 'alice')!.id
  feedbackId = ''
})

describe('feedback that lands mid-run', () => {
  it('reaches the running agent’s next turn and is marked picked up at once', async () => {
    /* the human speaks while the first turn is in flight */
    injectOnTurn = () => {
      feedbackId = actions.addTaskFeedback(cardId, 'alice', 'Make the headline bigger', 'alice')!.id
    }

    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(terminalCard()).toBeTruthy())

    /* the second turn was sent with the human's words in it */
    const run = runs[0]!
    expect(run.length).toBeGreaterThanOrEqual(2)
    const secondTurn = run[1]!
    const carrier = secondTurn.find((m) => m.text.includes('HUMAN FEEDBACK'))
    expect(carrier).toBeDefined()
    expect(carrier!.text).toContain('Make the headline bigger')
    expect(carrier!.text).toContain('alice')
    /* and it is attributed to the card the human was looking at */
    expect(carrier!.text).toContain('about your work')

    /* roles still alternate: the block rode with the tool results instead of
       opening a second user message, which the Messages API rejects */
    for (let i = 1; i < secondTurn.length; i += 1) {
      expect(secondTurn[i]!.role).not.toBe(secondTurn[i - 1]!.role)
    }

    /* picked up during the run, not after it: the item is delivered and
       settled, so nothing waits for another sweep */
    const feedback = actions.getFeedback(CANVAS).find((f) => f.id === feedbackId)!
    expect(feedback.deliveredAt).toBeTruthy()
    expect(feedback.failedAt ?? feedback.completedAt).toBeTruthy()
    expect(actions.takeFeedbackFor(CANVAS, AGENT, 'alice')).toEqual([])
  })

  it('leaves feedback alone when no run is working', async () => {
    feedbackId = actions.addTaskFeedback(cardId, 'alice', 'Make the headline bigger', 'alice')!.id
    /* a sweep claims it the ordinary way: the run starts because of it */
    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(terminalCard()).toBeTruthy())
    const feedback = actions.getFeedback(CANVAS).find((f) => f.id === feedbackId)!
    expect(feedback.deliveredAt).toBeTruthy()
    /* claimed feedback is in the kickoff, not injected as a mid-run block */
    expect(runs[0]![0]!.some((m) => m.text.includes('Make the headline bigger'))).toBe(true)
  })
})
