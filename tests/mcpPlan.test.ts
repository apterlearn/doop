import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { clearOpIds } from '../server/opIds.ts'
import type { AgentPlan, Canvas, ServerMessage } from '../shared/types.ts'

/* Agent plans: the record a long run (or a compacted context) reads back to
   know where it is, and the line the Agents panel shows. */

vi.mock('../server/db/persist.ts', () => ({
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
  savePlan: () => {},
  deletePlan: () => {},
}))

const OWNER_ID = 'plan-owner'
/* a fresh canvas id per test: the action logs are module state, and a shared id
   would let one test's plan leak into the next */
let CANVAS_ID = 'c-plan'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-plan-test', version: '1.0.0' })
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
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

let counter = 0

function seedCanvas(): Canvas {
  counter += 1
  CANVAS_ID = `c-plan-${counter}`
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Plan',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-plan-${counter}`, canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
}

const steps = [
  { id: 'tokens', text: 'Set the canvas design tokens' },
  { id: 'hero', text: 'Build the hero frame' },
  { id: 'review', text: 'Screenshot and fix what looks wrong' },
]

beforeEach(() => {
  vi.restoreAllMocks()
  clearOpIds()
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
  seedCanvas()
})

describe('plan tools', () => {
  it('publishes a plan, moves its steps, and reads it back', async () => {
    const { client, close } = await connect()
    try {
      const created = await callTool(client, 'set_plan', { canvas_id: CANVAS_ID, steps, agent_name: 'Claude' })
      expect(created.isError).toBeFalsy()
      const plan = created.parsed.plan as unknown as AgentPlan
      expect(plan.steps.map((s) => s.id)).toEqual(['tokens', 'hero', 'review'])
      expect(plan.steps.every((s) => s.status === 'pending')).toBe(true)
      expect(plan.agentName).toBe('Claude')
      expect(plan.owner).toBe('Test Owner')

      const active = await callTool(client, 'update_plan_step', {
        canvas_id: CANVAS_ID,
        step_id: 'hero',
        status: 'active',
        note: 'hero first, tokens after',
        agent_name: 'Claude',
      })
      expect(active.isError).toBeFalsy()
      const moved = (active.parsed.plan as unknown as AgentPlan).steps.find((s) => s.id === 'hero')!
      expect(moved.status).toBe('active')
      expect(moved.note).toBe('hero first, tokens after')

      const read = await callTool(client, 'get_plan', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      const plans = read.parsed.plans as unknown as AgentPlan[]
      expect(plans).toHaveLength(1)
      expect(plans[0]!.steps.find((s) => s.id === 'hero')!.status).toBe('active')
    } finally {
      await close()
    }
  })

  it('keeps the progress of steps a re-published plan did not change', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_plan', { canvas_id: CANVAS_ID, steps, agent_name: 'Claude' })
      await callTool(client, 'update_plan_step', {
        canvas_id: CANVAS_ID,
        step_id: 'tokens',
        status: 'done',
        agent_name: 'Claude',
      })

      const republished = await callTool(client, 'set_plan', {
        canvas_id: CANVAS_ID,
        steps: [
          { id: 'tokens', text: 'Set the canvas design tokens' },
          { id: 'hero', text: 'Build the hero frame' },
          { id: 'review', text: 'Screenshot and fix what looks wrong' },
          { id: 'flow', text: 'Add the pricing page' },
        ],
        agent_name: 'Claude',
      })
      const plan = republished.parsed.plan as unknown as AgentPlan
      expect(plan.steps.find((s) => s.id === 'tokens')!.status).toBe('done')
      expect(plan.steps.find((s) => s.id === 'flow')!.status).toBe('pending')
    } finally {
      await close()
    }
  })

  it('lists every agent plan on the canvas, newest first', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_plan', { canvas_id: CANVAS_ID, steps, agent_name: 'Claude' })
      await callTool(client, 'set_plan', {
        canvas_id: CANVAS_ID,
        steps: [{ id: 'a11y', text: 'Audit the hero' }],
        agent_name: 'Auditor',
      })
      const { parsed } = await callTool(client, 'get_plan', { canvas_id: CANVAS_ID })
      const plans = parsed.plans as unknown as AgentPlan[]
      expect(new Set(plans.map((p) => p.agentName))).toEqual(new Set(['Auditor', 'Claude']))
      /* both plans are on the canvas, and each carries its own steps */
      expect(plans.find((p) => p.agentName === 'Auditor')!.steps.map((st) => st.id)).toEqual(['a11y'])
    } finally {
      await close()
    }
  })

  it('rejects an empty plan, too many steps and a duplicate id', async () => {
    const { client, close } = await connect()
    try {
      /* an empty plan is refused at the schema, before the handler runs */
      const empty = (await client.callTool({
        name: 'set_plan',
        arguments: { canvas_id: CANVAS_ID, steps: [], agent_name: 'Claude' },
      })) as unknown as CallResult
      expect(empty.isError).toBe(true)
      expect(empty.content[0]!.text).toContain('steps')

      const many = (await client.callTool({
        name: 'set_plan',
        arguments: {
          canvas_id: CANVAS_ID,
          steps: Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, text: `Step ${i}` })),
          agent_name: 'Claude',
        },
      })) as unknown as CallResult
      expect(many.isError).toBe(true)
      expect(many.content[0]!.text).toContain('steps')

      const dupes = await callTool(client, 'set_plan', {
        canvas_id: CANVAS_ID,
        steps: [
          { id: 'same', text: 'One' },
          { id: 'same', text: 'Two' },
        ],
        agent_name: 'Claude',
      })
      expect(dupes.isError).toBe(true)
      expect(String((dupes.parsed.error as unknown as { message: string }).message)).toContain('duplicate step id')
    } finally {
      await close()
    }
  })

  it('reports an unknown step as not_found and a plan-less agent as empty', async () => {
    const { client, close } = await connect()
    try {
      const missing = await callTool(client, 'update_plan_step', {
        canvas_id: CANVAS_ID,
        step_id: 'ghost',
        status: 'done',
        agent_name: 'Claude',
      })
      expect(missing.isError).toBe(true)
      expect(missing.parsed.error).toMatchObject({ code: 'not_found' })

      const none = await callTool(client, 'get_plan', { canvas_id: CANVAS_ID })
      expect(none.parsed.plans).toEqual([])
    } finally {
      await close()
    }
  })

  it('broadcasts the plan to the room', async () => {
    const messages: ServerMessage[] = []
    actions.wire(
      (_canvasId, msg) => messages.push(msg),
      () => {},
    )
    const { client, close } = await connect()
    try {
      await callTool(client, 'set_plan', { canvas_id: CANVAS_ID, steps, agent_name: 'Claude' })
      await callTool(client, 'update_plan_step', {
        canvas_id: CANVAS_ID,
        step_id: 'hero',
        status: 'active',
        agent_name: 'Claude',
      })
      const planMessages = messages.filter((m) => m.type === 'plan')
      expect(planMessages).toHaveLength(2)
      expect((planMessages[1] as unknown as { plan: AgentPlan }).plan.steps.find((s) => s.id === 'hero')!.status).toBe(
        'active',
      )
    } finally {
      await close()
    }
  })
})

describe('idempotent creates', () => {
  it('returns the original frame for a repeated op_id instead of creating a second', async () => {
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        op_id: 'frame-hero-1',
        agent_name: 'Claude',
      })
      expect(first.isError).toBeFalsy()
      expect((first.parsed.frame as unknown as { id: string }).id).toBeTruthy()
      expect(first.parsed.idempotent_replay).toBeUndefined()

      const retry = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        op_id: 'frame-hero-1',
        agent_name: 'Claude',
      })
      expect(retry.parsed.idempotent_replay).toBe(true)
      expect((retry.parsed.frame as unknown as { id: string }).id).toBe((first.parsed.frame as unknown as { id: string }).id)
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(1)

      /* a fresh op_id is a genuinely new create */
      const second = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero 2',
        html: '<h1>again</h1>',
        op_id: 'frame-hero-2',
        agent_name: 'Claude',
      })
      expect(second.parsed.idempotent_replay).toBeUndefined()
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('deduplicates pages, comments and canvases the same way', async () => {
    const { client, close } = await connect()
    try {
      const page = await callTool(client, 'create_page', {
        canvas_id: CANVAS_ID,
        name: 'Checkout',
        op_id: 'page-1',
        agent_name: 'Claude',
      })
      const pageRetry = await callTool(client, 'create_page', {
        canvas_id: CANVAS_ID,
        name: 'Checkout',
        op_id: 'page-1',
        agent_name: 'Claude',
      })
      expect(pageRetry.parsed.idempotent_replay).toBe(true)
      expect((pageRetry.parsed as unknown as { id: string }).id).toBe((page.parsed as unknown as { id: string }).id)
      expect(store.getCanvas(CANVAS_ID)!.pages).toHaveLength(2)

      const frame = await callTool(client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        agent_name: 'Claude',
      })
      const frameId = (frame.parsed.frame as unknown as { id: string }).id
      const comment = await callTool(client, 'add_comment', {
        frame_id: frameId,
        selector: 'h1',
        text: 'too loud',
        op_id: 'comment-1',
        agent_name: 'Claude',
      })
      const commentRetry = await callTool(client, 'add_comment', {
        frame_id: frameId,
        selector: 'h1',
        text: 'too loud',
        op_id: 'comment-1',
        agent_name: 'Claude',
      })
      expect(commentRetry.parsed.idempotent_replay).toBe(true)
      expect((commentRetry.parsed as unknown as { id: string }).id).toBe((comment.parsed as unknown as { id: string }).id)
      expect(actions.getComments(CANVAS_ID)).toHaveLength(1)

      const before = store.listCanvases(OWNER_ID).length
      const canvas = await callTool(client, 'create_canvas', { name: 'Second', op_id: 'canvas-1' })
      const created = store.listCanvases(OWNER_ID).length
      expect(created).toBe(before + 1)
      const canvasRetry = await callTool(client, 'create_canvas', { name: 'Second', op_id: 'canvas-1' })
      expect(canvasRetry.parsed.idempotent_replay).toBe(true)
      expect(canvasRetry.parsed.id).toBe(canvas.parsed.id)
      /* the retry created nothing */
      expect(store.listCanvases(OWNER_ID)).toHaveLength(created)
    } finally {
      await close()
    }
  })

  it('keys op ids per account, so one agent cannot replay another result', async () => {
    const a = await connect()
    const serverB = buildMcpServer('Other Owner', 'other-owner')
    const clientB = new Client({ name: 'doop-plan-test-b', version: '1.0.0' })
    const [t1, t2] = InMemoryTransport.createLinkedPair()
    await serverB.connect(t2)
    await clientB.connect(t1)
    try {
      await callTool(a.client, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Hero',
        html: '<h1>hi</h1>',
        op_id: 'shared-key',
        agent_name: 'Claude',
      })
      /* the same key from another account is a different create, not a replay */
      store.addMember(CANVAS_ID, 'other-owner', 'alice')
      const other = await callTool(clientB, 'create_frame', {
        canvas_id: CANVAS_ID,
        name: 'Theirs',
        html: '<h1>theirs</h1>',
        op_id: 'shared-key',
        agent_name: 'Claude',
      })
      expect(other.isError).toBeFalsy()
      expect(other.parsed.idempotent_replay).toBeUndefined()
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(2)
    } finally {
      await a.close()
      await clientB.close()
      await serverB.close()
    }
  })
})
