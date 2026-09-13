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
  saveJournal: () => {},
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
  saveTask: () => {},
  deleteTask: () => {},
  saveFeedback: () => {},
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

function seed() {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Ask',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [],
  }
  store.init([canvas])
}

beforeEach(() => {
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
    plans: new Map(),
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
