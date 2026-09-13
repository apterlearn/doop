import { beforeEach, describe, expect, it, vi } from 'vitest'

/* The run mirrors its claims into Postgres and calls a real model; this test
   only cares about how a stop unwinds a run, so both are stubbed. */
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

/** Every model call the run made, so the test can prove a stop reached the
 *  transport rather than only the loop around it. */
const turns: { signal?: AbortSignal }[] = []

/** The flattened text of every request's messages, so a test can read what a
 *  resumed run was told. */
const prompts: string[] = []

/* Holds the run inside its model call, so a stop can be landed while a turn is
   genuinely in flight. */
let turnGate: { promise: Promise<void>; release: () => void } | null = null

vi.mock('../server/agentModel.ts', () => ({
  ModelAuthError: class ModelAuthError extends Error {},
  pickModel: async () => ({
    provider: 'anthropic',
    label: 'test model',
    userId: 'user-1',
    run: async (req: { signal?: AbortSignal; messages: { role: string; content: unknown }[] }) => {
      turns.push({ signal: req.signal })
      prompts.push(
        req.messages
          .map((m) =>
            typeof m.content === 'string'
              ? m.content
              : (m.content as { type: string; text?: string }[])
                  .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
                  .join(' '),
          )
          .join('\n'),
      )
      if (turnGate) await turnGate.promise
      return {
        content: [{ type: 'text' as const, text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      }
    },
  }),
}))

function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const actions = await import('../server/actions.ts')
const { store } = await import('../server/store.ts')
const resident = await import('../server/resident.ts')
const { DEFAULT_ROLE_ID, roleName } = await import('../shared/agents.ts')

const AGENT = roleName(DEFAULT_ROLE_ID)

let CANVAS = ''
let cardId = ''

/** `onFeedback` fires the sweep without returning it, so tests wait on the
 *  observable end state instead: the card reaching a terminal state. */
function terminal() {
  const card = actions.getTasks(CANVAS).find((t) => t.id === cardId)!
  return card.cancelledAt ?? card.failedAt ?? card.endedAt ?? false
}

beforeEach(() => {
  turns.length = 0
  prompts.length = 0
  turnGate = null
  /* the real canceller: without it a stop cannot reach the in-flight call */
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
  })
  CANVAS = store.createCanvas('resident cancel', 'alice').id
  cardId = actions.addQueuedCard(CANVAS, 'Make a hero', 'alice', undefined, undefined, 'alice')!.id
})

describe('a stopped resident run', () => {
  it('runs work nobody stopped', async () => {
    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(terminal()).toBeTruthy())

    expect(turns.length).toBeGreaterThan(0)
    const card = actions.getTasks(CANVAS).find((t) => t.id === cardId)!
    expect(card.agentName).toBe(AGENT)
    expect(card.cancelledAt).toBeUndefined()
  })

  it('does not let a stop aimed at an idle agent abandon the next run', async () => {
    /* stop_work on an agent with nothing running records the stop so the agent
       learns about it on its next tool call — but a card claimed afterwards is
       new work, and must not be silently dropped */
    actions.cancelAgentWork(CANVAS, AGENT, 'alice')

    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(terminal()).toBeTruthy())

    const card = actions.getTasks(CANVAS).find((t) => t.id === cardId)!
    expect(card.agentName).toBe(AGENT)
    expect(card.cancelledAt).toBeUndefined()
  })

  it('aborts the model call it is already making', async () => {
    turnGate = deferred()
    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(turns.length).toBeGreaterThan(0))

    actions.cancelAgentWork(CANVAS, AGENT, 'alice')
    turnGate.release()
    turnGate = null
    await vi.waitFor(() => expect(terminal()).toBeTruthy())

    expect(turns[0]?.signal?.aborted).toBe(true)
    const card = actions.getTasks(CANVAS).find((t) => t.id === cardId)!
    expect(card.cancelledAt).toBeGreaterThan(0)
    expect(card.failedAt).toBeUndefined()
  })
})

describe('a paused resident run', () => {
  it('aborts the run without failing the card, and the resume re-runs with why it paused', async () => {
    turnGate = deferred()
    resident.onFeedback(CANVAS)
    await vi.waitFor(() => expect(turns.length).toBeGreaterThan(0))

    expect(actions.pauseAgentWork(CANVAS, AGENT, 'alice')).toBe(1)
    turnGate.release()
    turnGate = null
    /* the pause journal, then the aborted run's own journal: the run has
       unwound and its card is still open */
    await vi.waitFor(() => expect(actions.getRunJournals(CANVAS, AGENT).length).toBe(2))

    const card = actions.getTasks(CANVAS).find((t) => t.id === cardId)!
    expect(card.pausedAt).toBeGreaterThan(0)
    expect(card.failedAt).toBeUndefined()
    expect(card.cancelledAt).toBeUndefined()
    /* back in the queue, unclaimed: the resume is one click */
    expect(card.agentName).toBe('')
    expect(actions.getRunJournals(CANVAS, AGENT)[0]!.summary).toBe('paused by alice: Make a hero')

    const callsBefore = turns.length
    actions.resumeCard(CANVAS, cardId, 'alice')
    await vi.waitFor(() => expect(turns.length).toBeGreaterThan(callsBefore))

    /* the resumed run is a fresh kickoff, so the journal is what tells it why
       it stopped — otherwise the agent redoes work the human paused */
    expect(prompts.at(-1)).toContain('paused by alice')
    expect(prompts.at(-1)).toContain('Make a hero')
  })
})

describe('journals across a restart', () => {
  it('reads back the runs a previous process recorded', async () => {
    /* what boot does: the rows the database held become the in-memory log the
       next kickoff and revert_run read */
    actions.hydrateLogs({
      tasks: new Map(),
      feedback: new Map(),
      comments: new Map(),
      activity: new Map(),
      decisions: new Map(),
      proposals: new Map(),
      journals: new Map([
        [
          CANVAS,
          [
            {
              id: 'j-1',
              canvasId: CANVAS,
              agentName: AGENT,
              runId: 'run-before-restart',
              summary: 'paused by alice: Make a hero',
              frames: [{ frameId: 'f-1', name: 'Hero', beforeVersionId: 'v-1', afterVersionId: 'v-2' }],
              at: 1,
            },
          ],
        ],
      ]),
    })

    expect(actions.getRunJournals(CANVAS, AGENT).map((j) => j.summary)).toEqual(['paused by alice: Make a hero'])
    expect(actions.getRunJournalBy(CANVAS, { runId: 'run-before-restart' })?.frames).toEqual([
      { frameId: 'f-1', name: 'Hero', beforeVersionId: 'v-1', afterVersionId: 'v-2' },
    ])
  })
})
