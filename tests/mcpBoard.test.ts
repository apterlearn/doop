import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Board-card MCP tools (list_cards, take_card, complete_card) run against the
   real actions machinery — persist + broadcasts are stubbed, the card queue
   state is real. No model calls enter the picture. */
vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
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
}))

/* attachments render through headless Chrome — stub the pixels, assert the block */
vi.mock('../server/screenshot.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/screenshot.ts')),
  renderFrame: vi.fn(async (frame: Frame) => Buffer.from(`png:${frame.id}`)),
}))

const OWNER_ID = 'owner-1'

const CANVAS: Canvas = {
  id: 'c1',
  name: 'Board',
  ownerId: OWNER_ID,
  createdAt: 0,
  updatedAt: 0,
  frames: [],
}

const ATTACHMENT: Frame = {
  id: 'ref1',
  canvasId: CANVAS.id,
  name: 'Reference',
  html: '<img src="x">',
  x: 0,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

const TARGET: Frame = {
  id: 'tgt1',
  canvasId: CANVAS.id,
  name: 'Pricing',
  html: '<p>$</p>',
  x: 700,
  y: 0,
  width: 640,
  height: 480,
  createdAt: 0,
  updatedAt: 0,
  updatedBy: 'alice',
}

interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

async function connect(ownerId: string | undefined = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-board-test', version: '1.0.0' })
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

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: unknown; raw: string; content: CallResult['content']; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* error strings are not JSON — leave the raw text for assertions */
  }
  return { parsed, raw, content: result.content, isError: result.isError }
}

function stubStore(canvases: Canvas[], frames: Frame[]) {
  vi.spyOn(store, 'getCanvas').mockImplementation((id: string) => canvases.find((c) => c.id === id))
  vi.spyOn(store, 'getFrame').mockImplementation((id: string) => frames.find((f) => f.id === id))
}

/* hydrateLogs only overwrites the canvases it is given, so each case works on
   its own canvas — a shared one would carry the previous case's card over. */
let CANVAS_ID = ''

beforeEach(() => {
  vi.restoreAllMocks()
  CANVAS_ID = `c-${Math.random().toString(36).slice(2, 10)}`
  stubStore(
    [{ ...CANVAS, id: CANVAS_ID }],
    [
      { ...ATTACHMENT, canvasId: CANVAS_ID },
      { ...TARGET, canvasId: CANVAS_ID },
    ],
  )
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
})

function queueCard(title: string) {
  return actions.addQueuedCard(CANVAS_ID, title, 'alice', undefined, undefined, 'alice')!
}

function card(id: string) {
  return actions.getTasks(CANVAS_ID).find((t) => t.id === id)!
}

describe('board card MCP tools', () => {
  it('registers all three tools with list_cards read-only', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const names = tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['list_cards', 'take_card', 'complete_card']))
      const list = tools.find((t) => t.name === 'list_cards')
      expect(list!.annotations?.readOnlyHint).toBe(true)
    } finally {
      await close()
    }
  })

  it('list_cards returns open unclaimed cards with brief and frames, hiding claimed and closed ones', async () => {
    const open = queueCard('Design a pricing page')
    const other = queueCard('Second card')
    actions.claimCard(CANVAS_ID, other.id, 'Doop') // claimed by another agent
    actions.completeCard(CANVAS_ID, other.id)

    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'list_cards', { canvas_id: CANVAS_ID })
      expect(isError).toBeFalsy()
      const { cards } = parsed as {
        cards: Array<{ id: string; title: string; queued_by: string; waiting_for: string }>
      }
      expect(cards.map((c) => c.id)).toEqual([open.id])
      expect(cards[0]).toMatchObject({
        title: 'Design a pricing page',
        queued_by: 'alice',
        waiting_for: 'Doop',
      })
    } finally {
      await close()
    }
  })

  it('list_cards hides repo-structured cards', async () => {
    const card = queueCard('Screen: /about')
    card.kind = 'sketch'
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'list_cards', { canvas_id: CANVAS_ID })
      expect((parsed as { cards: unknown[] }).cards).toEqual([])
    } finally {
      await close()
    }
  })

  it('take_card claims the card through the real queue and delivers brief + attachment images', async () => {
    const queued = actions.addQueuedCard(
      CANVAS_ID,
      'Design a pricing page',
      'alice',
      undefined,
      [ATTACHMENT.id],
      'alice',
      [TARGET.id],
    )!

    const { client, close } = await connect()
    try {
      const { parsed, content, isError } = await callTool(client, 'take_card', {
        card_id: queued.id,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed as { ok: boolean; card: { id: string; target_frames: string[] } }).toMatchObject({
        ok: true,
        card: { id: queued.id, target_frames: [TARGET.id] },
      })
      expect(JSON.stringify(parsed)).toContain('Design a pricing page')
      const image = content.find((block) => block.type === 'image')
      expect(image).toMatchObject({
        mimeType: 'image/png',
        data: Buffer.from(`png:${ATTACHMENT.id}`).toString('base64'),
      })

      const stored = card(queued.id)
      expect(stored.agentName).toBe('Claude')
      expect(stored.claimedAt).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  it('take_card refuses a card claimed by another agent, and repo-structured cards', async () => {
    const queued = queueCard('Design a pricing page')
    actions.claimCard(CANVAS_ID, queued.id, 'Doop')

    const { client, close } = await connect()
    try {
      const { raw, isError } = await callTool(client, 'take_card', { card_id: queued.id, agent_name: 'Claude' })
      expect(isError).toBe(true)
      expect(raw).toContain('already claimed by Doop')

      const repo = queueCard('Screen: /about')
      repo.kind = 'sketch'
      const structured = await callTool(client, 'take_card', { card_id: repo.id, agent_name: 'Claude' })
      expect(structured.isError).toBe(true)
      expect(structured.raw).toContain('structured import card')
    } finally {
      await close()
    }
  })

  it('take_card clears a stale stop so the fresh claim is not told to stop', async () => {
    queueCard('Design a pricing page')
    actions.cancelAgentWork(CANVAS_ID, 'Claude', 'alice') // stop from a previous session
    expect(actions.wasStopped(CANVAS_ID, 'Claude')).toBe(true)

    const { client, close } = await connect()
    try {
      // cancelAgentWork marks the card cancelled; queue a fresh one and claim it
      const fresh = queueCard('Second take')
      const { raw, isError } = await callTool(client, 'take_card', { card_id: fresh.id, agent_name: 'Claude' })
      expect(isError).toBeFalsy()
      expect(raw).not.toContain('STOPPED')
      expect(actions.wasStopped(CANVAS_ID, 'Claude')).toBe(false)
      expect(card(fresh.id).agentName).toBe('Claude')
    } finally {
      await close()
    }
  })

  it('complete_card closes the claimed card and posts the summary to the activity feed', async () => {
    const queued = queueCard('Design a pricing page')
    actions.claimCard(CANVAS_ID, queued.id, 'Claude')

    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'complete_card', {
        card_id: queued.id,
        summary: 'Pricing table redesigned, dark editorial style',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect((parsed as { ok: boolean }).ok).toBe(true)

      const stored = card(queued.id)
      expect(stored.endedAt).toBeGreaterThan(0)
      const feed = actions.getActivity(CANVAS_ID)
      expect(feed.some((a) => a.message.includes('finished: “Pricing table redesigned, dark editorial style”'))).toBe(
        true,
      )
    } finally {
      await close()
    }
  })

  it('complete_card refuses a card the agent did not claim and unknown card ids', async () => {
    const queued = queueCard('Design a pricing page')

    const { client, close } = await connect()
    try {
      const foreign = await callTool(client, 'complete_card', { card_id: queued.id, agent_name: 'Claude' })
      expect(foreign.isError).toBe(true)
      expect(foreign.raw).toContain('only the agent that claimed this card')

      const unknown = await callTool(client, 'complete_card', { card_id: 'nope', agent_name: 'Claude' })
      expect(unknown.isError).toBe(true)
      expect(unknown.raw).toContain('no card with id nope')
    } finally {
      await close()
    }
  })

  it('all three tools reject canvases this account cannot access', async () => {
    const queued = queueCard('Design a pricing page')
    const { client, close } = await connect('someone-else')
    try {
      const listed = await callTool(client, 'list_cards', { canvas_id: CANVAS_ID })
      expect(listed.raw).toContain(`no canvas with id ${CANVAS_ID}`)
      const taken = await callTool(client, 'take_card', { card_id: queued.id, agent_name: 'Claude' })
      expect(taken.raw).toContain(`no canvas with id ${CANVAS_ID}`)
      const completed = await callTool(client, 'complete_card', { card_id: queued.id, agent_name: 'Claude' })
      expect(completed.raw).toContain(`no canvas with id ${CANVAS_ID}`)
    } finally {
      await close()
    }
  })
})
