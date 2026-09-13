import { beforeEach, describe, expect, it, vi } from 'vitest'

/* A run that spends without limit is a run nobody agreed to. The ceilings are
   tokens — the unit providers actually report — and they have to fire at a turn
   boundary, with a reason a human can act on, rather than mid-tool. The model
   is stubbed so the test can spend an exact number of tokens. */

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

/** Tokens each turn reports, so the budget can be crossed exactly. */
let perTurn: { input: number; output: number } = { input: 100, output: 50 }
let modelCalls = 0
/** Turns that answer with a tool call; the turn after the last one ends the
 *  run, so a test can watch a run finish on its own. */
let toolTurns = Number.POSITIVE_INFINITY

vi.mock('../server/agentModel.ts', () => ({
  ModelAuthError: class ModelAuthError extends Error {},
  pickModel: async () => ({
    provider: 'anthropic',
    label: 'test model',
    userId: 'user-1',
    run: async () => {
      modelCalls += 1
      const usage = { input: perTurn.input, output: perTurn.output, cacheRead: 0, cacheWrite: 0 }
      if (modelCalls > toolTurns) {
        return { content: [{ type: 'text' as const, text: 'done' }], stop_reason: 'end_turn', usage }
      }
      /* a tool call keeps the loop going, so the next turn is the boundary
         the budget is checked at */
      return {
        content: [
          { type: 'text' as const, text: 'working' },
          { type: 'tool_use' as const, id: `tu${modelCalls}`, name: 'set_status', input: { status: 'working' } },
        ],
        stop_reason: 'tool_use',
        usage,
      }
    },
  }),
}))

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const resident = await import('../server/resident.ts')
const runBudget = await import('../server/runBudget.ts')

let CANVAS = ''
let cardId = ''

function card() {
  return actions.getTasks(CANVAS).find((t) => t.id === cardId)!
}

function settled() {
  const c = card()
  return c.failedAt ?? c.endedAt ?? c.cancelledAt ?? false
}

beforeEach(() => {
  modelCalls = 0
  perTurn = { input: 100, output: 50 }
  toolTurns = Number.POSITIVE_INFINITY
  runBudget.clearSpend()
  delete process.env.DOOP_RUN_TOKEN_BUDGET
  delete process.env.DOOP_ACCOUNT_DAILY_TOKENS
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
  CANVAS = store.createCanvas('run budget', 'alice').id
  /* a review pass may legitimately finish without changing a frame, so this
     card can complete — an originating card would be failed by the
     no-mutation gate before any budget question is answered */
  cardId = actions.addQueuedCard(CANVAS, 'Review the hero', 'alice', ['brand'], undefined, 'alice')!.id
})

describe('the run budget', () => {
  it('stops a run at the next turn boundary once it is over, and says so on the card', async () => {
    process.env.DOOP_RUN_TOKEN_BUDGET = '1000'
    /* 600 tokens a turn against a 1000-token ceiling: the second turn takes
       the run over, so the third is never sent */
    perTurn = { input: 600, output: 0 }

    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(settled()).toBeTruthy())

    expect(modelCalls).toBe(2)
    expect(card().failureReason ?? '').toContain('token budget')
    expect(card().failureReason ?? '').toContain('1,000')
    /* the spend is recorded even though the run stopped early */
    expect(card().usage?.input).toBe(1200)
    expect(runBudget.spentToday('user-1')).toBe(1200)
    /* and what the panel was told is the budget stop, not "out of turns" */
    const working = actions
      .getActivity(CANVAS)
      .map((a) => a.message)
      .filter((m) => m.startsWith('is working on:'))
    expect(working).toContain('is working on: Budget reached — continuing needs a human')
    expect(working).not.toContain('is working on: Ran out of turns — waiting for a retry')
  })

  it('lets a run that stays under its budget finish normally', async () => {
    process.env.DOOP_RUN_TOKEN_BUDGET = '100000'
    perTurn = { input: 100, output: 50 }
    /* the model stops asking for tools after three turns, so the run ends on
       its own: not stopped by the budget, and not out of turns */
    toolTurns = 3

    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(settled()).toBeTruthy())

    expect(modelCalls).toBe(4)
    const finished = card()
    expect(finished.endedAt).toBeGreaterThan(0)
    expect(finished.failedAt).toBeUndefined()
    expect(finished.failureReason).toBeUndefined()
    expect(finished.usage?.input).toBeGreaterThan(0)
  })

  it('refuses new work for an account that has spent its day', async () => {
    process.env.DOOP_ACCOUNT_DAILY_TOKENS = '500'
    runBudget.recordSpend('user-1', 500)

    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(settled()).toBeTruthy())

    /* refused before any model call, and the reason names the cap */
    expect(modelCalls).toBe(0)
    const reason = card().failureReason ?? ''
    expect(reason).toContain('Daily budget reached')
    expect(reason).toContain('500')
    expect(reason).toContain('DOOP_ACCOUNT_DAILY_TOKENS')
  })

  it('caps nothing when no daily ceiling is configured', async () => {
    runBudget.recordSpend('user-1', 10_000_000)
    expect(runBudget.dailyCapReached('user-1')).toBeUndefined()
  })
})
