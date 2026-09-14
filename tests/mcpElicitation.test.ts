import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* ask_human has two audiences: the human at the agent's own client, and the
   humans in the canvas room. A client that can ask its user directly gets the
   answer without a round trip through the canvas; a client that cannot falls
   back to the canvas question exactly as before. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  hydrate: () => {},
  saveCanvas: () => {},
  saveCanvasCopy: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  setFramePage: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteCanvas: () => {},
  saveFrameReview: async () => {},
  listFrameReviews: async () => [],
  listFrameVersions: async () => [],
  getFrameVersion: async () => undefined,
}))

const OWNER = 'Dana'
const OWNER_ID = 'ask-owner'
const CANVAS_ID = 'c-ask'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** `answer` is what the client's user types into the elicitation form. `null`
 *  with `capable: true` is the user declining the form; `capable: false` is a
 *  client that cannot be asked at all — different fallbacks. */
async function connect(answer: string | null, capable = answer !== null) {
  const server = buildMcpServer(OWNER, OWNER_ID)
  const client = new Client(
    { name: 'doop-ask-test', version: '1.0.0' },
    { capabilities: capable ? { elicitation: {} } : {} },
  )
  if (capable) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      expect(request.params.mode).toBe('form')
      expect(request.params.message).toContain('palette')
      /* the form the server asks for is answerable as-is: one free-text field
         named `answer`, which is what the handler reads back */
      const params = request.params as { requestedSchema?: { properties?: Record<string, unknown> } }
      expect(params.requestedSchema?.properties?.answer).toBeDefined()
      if (answer === null) return { action: 'decline' }
      return { action: 'accept', content: { answer } }
    })
  }
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

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  let parsed: Record<string, never> = {} as Record<string, never>
  try {
    parsed = JSON.parse(raw) as Record<string, never>
  } catch {
    /* not a JSON payload */
  }
  return { parsed, raw, isError: result.isError }
}

/** A capable client whose form handler the case supplies, so the requested
 *  schema (free text, single-choice enum, or multi-select array) can be read
 *  back. `connect` above pins the free-text form; this one varies it. */
async function connectForm(
  handler: (params: {
    message: string
    requestedSchema?: { properties?: Record<string, unknown> }
  }) => { action: 'accept'; content: Record<string, unknown> } | { action: 'decline' },
) {
  const server = buildMcpServer(OWNER, OWNER_ID)
  const client = new Client({ name: 'doop-ask-test', version: '1.0.0' }, { capabilities: { elicitation: {} } })
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const params = request.params as {
      message: string
      requestedSchema?: { properties?: Record<string, unknown> }
    }
    return handler(params) as never
  })
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

function canvasWith(id: string): Canvas {
  return {
    id,
    name: 'Ask',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [],
  }
}

function seed() {
  store.init([canvasWith(CANVAS_ID)])
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  /* question log is module state: start each test with an empty canvas */
  for (const q of actions.getQuestions(CANVAS_ID)) actions.expireQuestion(q.id)
  seed()
})

describe('ask_human with a client that can ask its user', () => {
  it('returns the answer without leaving a question open on the canvas', async () => {
    const { client, close } = await connect('Direction B')
    try {
      const { parsed, isError } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        wait_seconds: 30,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.status).toBe('answered')
      expect(parsed.answer).toBe('Direction B')
      expect(parsed.via).toBe('elicitation')
      expect(parsed.answered_by).toBe(OWNER)

      /* nothing is parked: the agent does not wait for the canvas */
      expect(actions.getQuestions(CANVAS_ID).every((q) => q.status !== 'open')).toBe(true)
      /* and the exchange is in the canvas transcript, answered */
      const [recorded] = actions.getQuestions(CANVAS_ID)
      expect(recorded?.text).toContain('palette')
      expect(recorded?.answer).toBe('Direction B')
      expect(recorded?.answeredBy).toBe(OWNER)
      /* the asking agent reads it back like any other answer */
      const later = await callTool(client, 'get_answers', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(later.raw).toContain('Direction B')
    } finally {
      await close()
    }
  })

  it('falls back to the canvas question when the user declines', async () => {
    /* capable client, declined form: the request goes out and comes back
       empty-handed, which is not the same as never asking */
    const { client, close } = await connect(null, true)
    try {
      const { parsed } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        wait_seconds: 0,
        agent_name: 'Claude',
      })
      /* wait_seconds 0 means "do not block": the question is on the canvas for
         the humans in the room, and the agent is told so */
      expect(parsed.status).toBe('open')
      expect(parsed.question_id).toBeTruthy()
      const open = actions.getQuestions(CANVAS_ID).filter((q) => q.status === 'open')
      expect(open).toHaveLength(1)
      expect(open[0]!.text).toContain('palette')
    } finally {
      await close()
    }
  })

  it('falls back to the canvas question when the client has no elicitation support', async () => {
    /* a client that declares nothing: no request may be sent to it at all */
    const { client, close } = await connect(null, false)
    try {
      const { parsed } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        wait_seconds: 0,
        agent_name: 'Claude',
      })
      expect(parsed.status).toBe('open')
      expect(actions.getQuestions(CANVAS_ID).filter((q) => q.status === 'open')).toHaveLength(1)
    } finally {
      await close()
    }
  })
})

describe('ask_human with choices', () => {
  const PALETTE = ['Direction A', 'Direction B']

  it('asks a capable client with an enum and records the chosen value', async () => {
    let schema: { properties?: Record<string, unknown> } | undefined
    const { client, close } = await connectForm((params) => {
      schema = params.requestedSchema
      return { action: 'accept', content: { answer: 'Direction B' } }
    })
    try {
      const { parsed, isError } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        choices: PALETTE,
        wait_seconds: 30,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      /* the form offers exactly the choices — not a free-text box */
      expect(schema?.properties?.answer).toMatchObject({ type: 'string', enum: PALETTE })
      expect(parsed.status).toBe('answered')
      expect(parsed.answer).toBe('Direction B')
      /* the canvas transcript keeps how the question was framed */
      const [recorded] = actions.getQuestions(CANVAS_ID)
      expect(recorded?.choices).toEqual(PALETTE)
      expect(recorded?.multi).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('asks a multi-select client for an array and joins the picks', async () => {
    let schema: { properties?: Record<string, unknown> } | undefined
    const { client, close } = await connectForm((params) => {
      schema = params.requestedSchema
      return { action: 'accept', content: { answer: ['Direction A', 'Direction B'] } }
    })
    try {
      const { parsed } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        choices: PALETTE,
        multi: true,
        allow_other: true,
        wait_seconds: 30,
        agent_name: 'Claude',
      })
      expect(schema?.properties?.answer).toMatchObject({
        type: 'array',
        items: { type: 'string', enum: PALETTE },
      })
      expect(parsed.status).toBe('answered')
      expect(parsed.answer).toBe('Direction A, Direction B')
      const [recorded] = actions.getQuestions(CANVAS_ID)
      expect(recorded?.multi).toBe(true)
      expect(recorded?.allowOther).toBe(true)
    } finally {
      await close()
    }
  })

  it('falls back to the canvas when a client answers outside the enum', async () => {
    /* a client that accepts the form but ignores the enum does not get to
       settle a choice question with something that was never on offer */
    const { client, close } = await connectForm(() => ({ action: 'accept', content: { answer: 'Direction Z' } }))
    try {
      const { parsed } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        choices: PALETTE,
        wait_seconds: 1,
        agent_name: 'Claude',
      })
      expect(parsed.status).toBe('open')
      const open = actions.getQuestions(CANVAS_ID).filter((q) => q.status === 'open')
      expect(open).toHaveLength(1)
      expect(open[0]!.choices).toEqual(PALETTE)
    } finally {
      await close()
    }
  })

  it('refuses a canvas answer outside the choices and keeps the question open', async () => {
    /* the humans in the room answer through the canvas, not the form */
    const { client, close } = await connect(null, false)
    try {
      const { parsed } = await callTool(client, 'ask_human', {
        canvas_id: CANVAS_ID,
        text: 'Which palette direction should the hero use?',
        choices: PALETTE,
        wait_seconds: 0,
        agent_name: 'Claude',
      })
      const questionId = parsed.question_id as unknown as string
      expect(parsed.choices).toEqual(PALETTE)
      const human = actions.resolveActor({ name: OWNER, kind: 'user', ownerId: OWNER_ID })

      let thrown: unknown
      try {
        actions.answerQuestion(CANVAS_ID, questionId, 'Direction C', human)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(actions.InvalidAnswerError)
      expect((thrown as Error).message).toContain('Direction A')

      /* nothing was recorded: the question is still open and answerable */
      const still = actions.getQuestions(CANVAS_ID).find((q) => q.id === questionId)!
      expect(still.status).toBe('open')
      expect(still.answer).toBeUndefined()

      actions.answerQuestion(CANVAS_ID, questionId, 'Direction A', human)
      expect(actions.getQuestions(CANVAS_ID).find((q) => q.id === questionId)!.status).toBe('answered')
    } finally {
      await close()
    }
  })

  it('wakes a parked ask with the chosen answer', { timeout: 20000 }, async () => {
    /* its own canvas: the agent-event log is per canvas, and the cases above
       have already pushed question_answer events on the shared one */
    const PARKED = 'c-ask-parked'
    store.init([canvasWith(PARKED)])
    const { client, close } = await connect(null, false)
    try {
      const pending = callTool(client, 'ask_human', {
        canvas_id: PARKED,
        text: 'Which palette direction should the hero use?',
        choices: PALETTE,
        wait_seconds: 10,
        agent_name: 'Claude',
      })
      await vi.waitFor(() => expect(actions.getQuestions(PARKED).filter((q) => q.status === 'open')).toHaveLength(1))
      const question = actions.getQuestions(PARKED).find((q) => q.status === 'open')!
      actions.answerQuestion(
        PARKED,
        question.id,
        'Direction B',
        actions.resolveActor({ name: OWNER, kind: 'user', ownerId: OWNER_ID }),
      )
      const res = await pending
      expect(res.parsed).toMatchObject({ status: 'answered', answer: 'Direction B' })
    } finally {
      await close()
      /* hand the shared canvas back for the cases after this one */
      seed()
    }
  })

  it('keeps the ask free-text when fewer than two choices reach the store', async () => {
    /* the tool schema refuses a one-entry list; this is the store-level guard
       that keeps a caller-built question from claiming to offer a choice */
    const question = actions.askQuestion(
      CANVAS_ID,
      { text: 'Which palette direction should the hero use?', choices: ['only one'] },
      actions.resolveActor({ name: 'Claude', kind: 'agent' }),
    )!
    expect(question.choices).toBeUndefined()
    /* any answer lands, because there is no choice list to enforce */
    actions.answerQuestion(
      CANVAS_ID,
      question.id,
      'anything goes',
      actions.resolveActor({ name: OWNER, kind: 'user', ownerId: OWNER_ID }),
    )
    expect(actions.getQuestions(CANVAS_ID).find((q) => q.id === question.id)!.status).toBe('answered')
  })
})
