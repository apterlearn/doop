import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Review-mode MCP tools run against the real actions machinery: persist and
   broadcasts are stubbed, the proposal/queue state is real. */
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
  savePage: () => {},
}))

const OWNER_ID = 'owner-1'

let canvas: Canvas
let frame: Frame

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
  // hydrateLogs only overwrites the canvases it is given, so each case works
  // on its own canvas — a shared one would carry the previous case's state
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
  canvas = store.createCanvas(`review-${Math.random().toString(36).slice(2, 8)}`, OWNER_ID)
  frame = store.createFrame(
    canvas.id,
    { name: 'Hero', html: '<html><body style="background:#fff"><h1>Hi</h1></body></html>', width: 640, height: 480 },
    'alice',
  )!
})

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-review-test', version: '1.0.0' })
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
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content?.find((b) => b.type === 'text')?.text ?? ''
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* plain text result */
  }
  return { parsed, raw, isError: result.isError }
}

describe('review mode', () => {
  it('off by default: set_frame_html writes directly', async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'set_frame_html', {
      frame_id: frame.id,
      html: '<html><body><h1>direct</h1></body></html>',
      agent_name: 'ux lead',
    })
    expect(res.isError).toBeFalsy()
    await close()
  })

  it('on: set_frame_html is refused with the propose path named', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const res = await callTool(client, 'set_frame_html', {
      frame_id: frame.id,
      html: '<html><body><h1>overwritten</h1></body></html>',
      agent_name: 'ux lead',
    })
    expect(res.isError).toBe(true)
    expect((res.parsed as { error: { code: string } }).error.code).toBe('unsupported')
    await close()
  })

  it('on: propose_frame_html is pending, and accept lands the change', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const proposed = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body style="background:#eee"><h1>Proposed</h1></body></html>',
      summary: 'swap the hero copy',
      agent_name: 'ux lead',
    })
    expect(proposed.isError).toBeFalsy()
    const { proposal_id: proposalId, status } = proposed.parsed as { proposal_id: string; status: string }
    expect(status).toBe('pending')
    await close()

    const accepted = actions.resolveFrameProposal(
      canvas.id,
      proposalId,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    expect(accepted?.status).toBe('accepted')
    expect(store.getFrame(frame.id)?.html).toContain('Proposed')
  })

  it('accepting after the frame moved again marks the proposal stale', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const proposed = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body><p>v2-proposed</p></body></html>',
      summary: 'refresh hero',
      agent_name: 'ux lead',
    })
    const { proposal_id: proposalId } = proposed.parsed as { proposal_id: string }
    await close()

    // the frame moves on while the proposal is pending
    store.updateFrame(frame.id, { html: '<html><body><p>human edit</p></body></html>' }, 'alice')

    const accepted = actions.resolveFrameProposal(
      canvas.id,
      proposalId,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    expect(accepted?.status).toBe('stale')
    expect(store.getFrame(frame.id)?.html).toContain('human edit')
  })

  it('review mode off: propose tools are refused', async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body><p>x</p></body></html>',
      summary: 'no-op',
      agent_name: 'ux lead',
    })
    expect(res.isError).toBe(true)
    expect((res.parsed as { error: { code: string } }).error.code).toBe('unsupported')
    await close()
  })

  it('on: every write path is refused, including the ones with no early gate', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const page = store.getCanvas(canvas.id)!.pages![0]!
    const writes: [string, Record<string, unknown>][] = [
      ['set_frame_html', { frame_id: frame.id, html: '<html><body><p>x</p></body></html>' }],
      ['append_frame_html', { frame_id: frame.id, html_chunk: '<p>streamed</p>', start: true, done: true }],
      ['edit_frame_html', { frame_id: frame.id, old_str: '<h1>Hi</h1>', new_str: '<h1>Changed</h1>' }],
      ['update_frame', { frame_id: frame.id, name: 'Renamed' }],
      ['duplicate_frame', { frame_id: frame.id }],
      ['move_frame', { frame_id: frame.id, page: page.name }],
      ['delete_frame', { frame_id: frame.id }],
      ['create_frame', { canvas_id: canvas.id, name: 'New', html: '<html><body>n</body></html>' }],
      ['create_page', { canvas_id: canvas.id, name: 'Page 2' }],
      ['rename_page', { page_id: page.id, name: 'Renamed page' }],
      ['set_tokens', { canvas_id: canvas.id, tokens: { colors: { ink: '#111111' } } }],
      ['set_guidelines', { canvas_id: canvas.id, name: 'brand', markdown: '# Brand' }],
      ['save_decision', { canvas_id: canvas.id, decision: 'keep it dark' }],
      ['add_comment', { frame_id: frame.id, selector: 'h1', text: 'note' }],
    ]
    for (const [name, args] of writes) {
      const res = await callTool(client, name, { ...args, agent_name: 'ux lead' })
      expect(res.isError, `${name} must be refused in review mode`).toBe(true)
      expect((res.parsed as { error: { code: string } }).error.code, name).toBe('unsupported')
    }
    /* nothing landed */
    expect(store.getFrame(frame.id)?.name).toBe('Hero')
    expect(store.getFrame(frame.id)?.html).toContain('<h1>Hi</h1>')
    expect(store.getCanvas(canvas.id)?.tokens).toBeUndefined()
    expect(actions.getComments(canvas.id)).toHaveLength(0)
    await close()
  })

  it('on: a human write still lands', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const human = actions.resolveActor({ name: 'alice', kind: 'user', ownerId: OWNER_ID })
    const updated = actions.updateFrame(frame.id, { html: '<html><body><p>human</p></body></html>' }, human)
    expect(updated?.html).toContain('human')
  })
})

describe('ask_human', () => {
  it('returns the answer when a human answers during the wait', { timeout: 20000 }, async () => {
    const { client, close } = await connect()
    const pending = callTool(client, 'ask_human', {
      canvas_id: canvas.id,
      text: 'dark or light palette?',
      wait_seconds: 10,
      agent_name: 'ux lead',
    })
    // the tool parks in the wait; poll the question log with vi.waitFor,
    // then answer — the parked tool resolves through the event bus
    await vi.waitFor(() => expect(actions.getQuestions(canvas.id).length).toBe(1))
    const question = actions.getQuestions(canvas.id)[0]!
    expect(question.text).toBe('dark or light palette?')
    actions.answerQuestion(
      canvas.id,
      question.id,
      'use the dark palette',
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const res = await pending
    expect(res.parsed).toMatchObject({ status: 'answered', answer: 'use the dark palette' })
    await close()
  })

  it('times out open, and get_answers then returns the question', { timeout: 20000 }, async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'ask_human', {
      canvas_id: canvas.id,
      text: 'which logo?',
      wait_seconds: 0,
      agent_name: 'ux lead',
    })
    expect(res.isError).toBeFalsy()
    expect(res.parsed).toMatchObject({ status: 'open' })
    const answers = await callTool(client, 'get_answers', { canvas_id: canvas.id, agent_name: 'ux lead' })
    expect(answers.raw).toContain('which logo?')
    await close()
  })
})

describe('wait_for_events', () => {
  it('returns feedback pushed while parked, with a cursor', { timeout: 30000 }, async () => {
    const { client, close } = await connect()
    const cursor0 = (
      await callTool(client, 'wait_for_events', {
        canvas_id: canvas.id,
        timeout_seconds: 5,
        agent_name: 'ux lead',
      })
    ).parsed as { cursor: number; timed_out: boolean }
    /* the parked call blocks in real time — an integration-style wait that
       cannot be faked, so this suite needs the extended timeout */
    expect(cursor0.timed_out).toBe(true)

    const pending = callTool(client, 'wait_for_events', {
      canvas_id: canvas.id,
      cursor: cursor0.cursor,
      timeout_seconds: 10,
      agent_name: 'ux lead',
    })
    /* feedback must hang off a real claimed task: queue one, claim it as the
       agent, then push feedback the way the API does */
    const card = actions.addQueuedCard(canvas.id, 'make the hero bigger', 'owner', undefined, undefined, OWNER_ID)
    actions.claimCard(canvas.id, card!.id, 'ux lead')
    const feedback = actions.addTaskFeedback(card!.id, 'owner', 'make the hero bigger', OWNER_ID)
    expect(feedback?.targetAgent).toBe('UX Lead')
    const res = await pending
    const events = (res.parsed as { events: { kind: string; summary: string }[] }).events
    /* the queue push and the feedback both arrive while parked — the feedback
       event is the one addressed to this agent */
    expect(
      events.map((e) => [e.kind, e.summary]),
      'events seen while parked',
    ).toContainEqual(['feedback', 'make the hero bigger'])
    expect(events.map((e) => e.kind)).toContain('card')
    await close()
  })
})
