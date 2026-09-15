import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'

/* run_design_workflow is the one tool whose work happens entirely on the
   server: two models on the operator's provider, driven by the real engine and
   the real action layer, so the frame it writes is a frame the canvas really
   holds. What a test cannot have is the outside world — a provider call, a
   headless browser, Postgres — so the two models, the deterministic review
   they feed on and the per-user model pair are stubbed while the store, the
   action layer and the tool's own registration stay real. */

/* Only the database writes are stubbed, so a canvas created here never
   reaches Postgres and no test leaves a row behind. */
vi.mock('../server/db/persist.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/db/persist.ts')),
  saveCanvas: () => {},
  savePage: () => {},
  saveFrame: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteFrame: () => {},
  saveActivity: () => {},
  saveComponent: () => {},
  saveComment: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  saveProposal: () => {},
  saveDecision: () => {},
  saveFrameReview: () => {},
  listFrameReviews: async () => [],
}))

/* Both models answer out of scripted queues — the implementer's reply is the
   HTML under test, the judge's is the verdict that decides whether there is
   another round — and every call is kept so a test can tell a refused call
   from one that never ran. `configured` is read per call rather than captured
   at import, which is how the unconfigured server is driven from one module
   graph. */
const state = vi.hoisted(() => ({
  configured: true,
  implementer: 'deepseek-v4.1-flash',
  judge: 'kimi-k3',
  replies: { implementer: [] as string[], judge: [] as string[] },
  calls: [] as string[],
}))

vi.mock('../server/designLlm.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/designLlm.ts')),
  designLlmConfigured: () => state.configured,
  designComplete: async (input: { model: string }) => {
    state.calls.push(input.model)
    const queue = input.model === state.implementer ? state.replies.implementer : state.replies.judge
    const reply = queue.shift()
    if (reply === undefined) throw new Error(`no scripted reply for ${input.model}`)
    return { text: reply, truncated: false }
  },
}))

/* The pair is per user and lives in the database; the tool only reads it, so
   the read answers with what a Settings save would have left there. */
vi.mock('../server/designWorkflowSettings.ts', () => ({
  getDesignWorkflowPrefs: async () => ({
    implementerModel: state.implementer,
    judgeModel: state.judge,
    configured: state.configured,
  }),
}))

/* One blocking finding, canned: the engine only has to hand the judge what the
   review found, and a real review of a real document needs a browser. */
vi.mock('../server/review.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/review.ts')),
  reviewFrame: async (frame: { id: string; updatedAt: number }) => ({
    frame_id: frame.id,
    html_sha: 'stub-sha',
    frame_updated_at: frame.updatedAt,
    reviewed_at: Date.now(),
    viewports: [],
    summary: {
      critical: 1,
      serious: 0,
      errors: 0,
      warnings: 0,
      off_token: 0,
      off_token_font: 0,
      off_token_type: 0,
      content_errors: 0,
      content_warnings: 0,
    },
    blocking: [{ rule: 'missing_alt', selector: 'img.hero', detail: 'the hero image has no alt text', source: 'a11y' }],
    advisory: [],
    failing_viewports: ['mobile'],
    verdict: 'fail',
  }),
}))

const OWNER_ID = 'test-owner-id'
const BRIEF = 'a pricing card with three tiers'

/* the first attempt, then what the implementer writes once the judge has
   spoken: the second document is the one the canvas has to end up holding */
const FIRST_ATTEMPT = '<html><body><h1>Pricing</h1><p>One plan</p></body></html>'
const SECOND_ATTEMPT = '<html><body><h1>Pricing</h1><p>Three tiers, each with its own feature list</p></body></html>'

function judgeReply(verdict: 'pass' | 'fail', summary: string, issues: string[] = []): string {
  return JSON.stringify({ verdict, summary, issues })
}

/** The judge refuses the first attempt and accepts the second. */
function scriptFailingThenPassing(): void {
  state.replies.implementer = [FIRST_ATTEMPT, SECOND_ATTEMPT]
  state.replies.judge = [
    judgeReply('fail', 'the card shows one plan', ['show three tiers']),
    judgeReply('pass', 'three tiers, clean'),
  ]
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-design-workflow-test', version: '1.0.0' })
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

interface ToolResult {
  isError: boolean
  structured: Record<string, unknown>
  text: string
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  const text = result.content?.find((block) => block.type === 'text')?.text ?? ''
  /* a refusal carries no structured content, only the JSON payload in its text
     block — the same shape, read from the one place that always has it */
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return {
    isError: result.isError === true,
    structured: result.structuredContent ?? parsed,
    text,
  }
}

/** The error code a refused call carries — agents branch on this, not prose. */
function errorCode(result: ToolResult): string | undefined {
  const error = result.structured.error as { code?: string } | undefined
  return error?.code
}

beforeEach(() => {
  actions.wirePresence(() => [])
  state.configured = true
  state.calls.length = 0
  state.replies.implementer = []
  state.replies.judge = []
})

describe('run_design_workflow over MCP', () => {
  it('runs the implementer and the judge and leaves the accepted design on the canvas', async () => {
    const canvas = store.createCanvas('Pricing', OWNER_ID)
    scriptFailingThenPassing()
    const { client, close } = await connect()
    try {
      const result = await call(client, 'run_design_workflow', {
        canvas_id: canvas.id,
        brief: BRIEF,
        agent_name: 'Claude',
      })

      expect(result.isError).toBe(false)
      expect(result.structured.judgeVerdict).toBe('pass')
      expect(result.structured.attempts).toBe(2)
      /* the judge's second round is what ended it, so both models ran twice */
      expect(state.calls).toEqual([state.implementer, state.judge, state.implementer, state.judge])

      const frames = store.getCanvas(canvas.id)?.frames ?? []
      expect(frames).toHaveLength(1)
      expect(frames[0]?.name).toBe('Design workflow')
      expect(frames[0]?.html).toContain('Three tiers, each with its own feature list')
      /* the rejected first attempt is gone, not stacked up next to the accepted one */
      expect(frames[0]?.html).not.toContain('One plan')
    } finally {
      await close()
    }
  })

  it('refuses the call on a server with no design-LLM endpoint, running nothing', async () => {
    const canvas = store.createCanvas('Unconfigured', OWNER_ID)
    scriptFailingThenPassing()
    state.configured = false
    const { client, close } = await connect()
    try {
      const result = await call(client, 'run_design_workflow', {
        canvas_id: canvas.id,
        brief: BRIEF,
        agent_name: 'Claude',
      })

      expect(result.isError).toBe(true)
      expect(errorCode(result)).toBe('unsupported')
      expect(result.text).toContain('unsupported')
      /* nothing was written and no model was asked */
      expect(state.calls).toEqual([])
      expect(store.getCanvas(canvas.id)?.frames ?? []).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('refuses a redesign target that belongs to another canvas', async () => {
    const canvas = store.createCanvas('Target', OWNER_ID)
    const other = store.createCanvas('Elsewhere', OWNER_ID)
    const foreign = store.createFrame(
      other.id,
      { name: 'Foreign', html: '<h1>elsewhere</h1>', width: 400, height: 300 },
      'Owner',
    )
    scriptFailingThenPassing()
    const { client, close } = await connect()
    try {
      const result = await call(client, 'run_design_workflow', {
        canvas_id: canvas.id,
        brief: BRIEF,
        frame_id: foreign?.id ?? '',
        agent_name: 'Claude',
      })

      expect(result.isError).toBe(true)
      expect(errorCode(result)).toBe('invalid_input')
      expect(result.text).toContain('invalid_input')
      /* the frame it named is judged against the wrong design system, so the
         refusal lands before any model is asked */
      expect(state.calls).toEqual([])
      expect(store.getCanvas(canvas.id)?.frames ?? []).toHaveLength(0)
    } finally {
      await close()
    }
  })
})
