import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The delivery gate. An agent that designs a frame and hands the card back
   without checking it is the failure this catches; the check has to be tied to
   the document it ran on, or reviewing early and editing afterwards passes. */

vi.mock('../server/db/persist.ts', () => {
  /* reports are read back by the gate, so the store is real for those two
     functions and inert for everything else */
  const reviews = new Map<string, import('../shared/types.ts').FrameReview[]>()
  return {
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
    saveFrameReview: async (review: import('../shared/types.ts').FrameReview) => {
      reviews.set(review.frameId, [review, ...(reviews.get(review.frameId) ?? [])])
    },
    listFrameReviews: async (frameId: string) => reviews.get(frameId) ?? [],
  }
})

const OWNER_ID = 'gate-owner'
const CANVAS_ID = 'c-gate'
const browser = findBrowserPath()

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-gate-test', version: '1.0.0' })
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
  let parsed: Record<string, never> = {} as Record<string, never>
  try {
    parsed = JSON.parse(raw) as Record<string, never>
  } catch {
    /* an SDK-level validation error is prose, not our payload */
  }
  return { parsed, raw, isError: result.isError }
}

const CLEAN = `<!doctype html><html lang="en"><head><title>Acme pricing</title>
  <meta name="description" content="Simple pricing.">
  <style>
    body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
    h1 { font-size: 32px; line-height: 1.25; }
    a:hover { text-decoration: underline }
    a:focus-visible { outline: 2px solid #111110 }
  </style></head>
  <body><main style="min-height:700px"><h1>Pricing</h1>
  <p style="color:#111110">Simple, predictable pricing for teams of any size.</p>
  <a href="/start" style="color:#111110;font-size:16px;padding:8px">Start free</a>
  </main></body></html>`

const BROKEN = CLEAN.replace('Simple, predictable pricing', 'Lorem ipsum dolor sit amet').replace(
  '<h1>Pricing</h1>',
  '<h1>Pricing</h1><p style="color:#111110">Lorem ipsum dolor sit amet.</p>',
)

function seedFrame(html: string, updatedBy = 'Claude'): Frame {
  const frame: Frame = {
    id: 'f-gate',
    canvasId: CANVAS_ID,
    name: 'Pricing',
    x: 0,
    y: 0,
    width: 1200,
    height: 900,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy,
    pageId: 'p-gate',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Gate',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-gate', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

/** A card claimed by the agent, so complete_card has something to complete. */
/* queuing the same title twice returns the existing card, so each test needs
   its own: the card log is module state shared across tests in this file */
let cardSeq = 0
function seedCard(agentName = 'Claude') {
  cardSeq += 1
  const card = actions.addQueuedCard(CANVAS_ID, `Pricing page ${cardSeq}`, 'alice', undefined, undefined, 'alice')!
  actions.claimCard(CANVAS_ID, card.id, agentName)
  return card
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
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
})

describe('the delivery gate', () => {
  it('refuses a card whose frames the agent never checked', async () => {
    seedFrame(CLEAN)
    const card = seedCard()
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'complete_card', {
        card_id: card.id,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('conflict')
      expect((parsed.error as unknown as { message: string }).message).toContain('never reviewed')
      expect((parsed.error as unknown as { message: string }).message).toContain('ready_for_review')
      /* the card is still open: a refused delivery is not a completion */
      expect(actions.getTasks(CANVAS_ID).find((t) => t.id === card.id)?.endedAt).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('refuses a hand-back on the same grounds', async () => {
    seedFrame(CLEAN)
    const card = seedCard()
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'hand_back', {
        canvas_id: CANVAS_ID,
        card_id: card.id,
        to_agent: 'Copywriter',
        reason: 'copy needs work',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('conflict')
    } finally {
      await close()
    }
  })
})

describe.skipIf(!browser)('the delivery gate over a real render', () => {
  it('lets a card through once its frames pass', async () => {
    const frame = seedFrame(CLEAN)
    const card = seedCard()
    const { client, close } = await connect()
    try {
      const review = await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      expect(review.isError).toBeFalsy()
      expect(review.parsed.verdict).toBe('pass')
      expect(review.parsed.blocking).toEqual([])

      const done = await callTool(client, 'complete_card', { card_id: card.id, agent_name: 'Claude' })
      expect(done.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('does not accept a report for a document that has since changed', async () => {
    const frame = seedFrame(CLEAN)
    const card = seedCard()
    const { client, close } = await connect()
    try {
      await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      /* the agent keeps working after checking — the pass no longer applies */
      actions.updateFrame(
        frame.id,
        { html: CLEAN.replace('Simple, predictable', 'Even simpler') },
        actions.resolveActor({ name: 'Claude', kind: 'agent', ownerId: OWNER_ID }),
      )
      const { parsed, isError } = await callTool(client, 'complete_card', {
        card_id: card.id,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { message: string }).message).toContain('changed after its last review')
    } finally {
      await close()
    }
  })

  it('reports the blocking findings a failing frame actually has', async () => {
    const frame = seedFrame(BROKEN)
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      expect(parsed.verdict).toBe('fail')
      const rules = (parsed.blocking as unknown as { rule: string }[]).map((finding) => finding.rule)
      expect(rules).toContain('placeholder_text')
      /* every blocking finding names the element to fix */
      for (const finding of parsed.blocking as unknown as { selector: string }[]) {
        expect(finding.selector.length).toBeGreaterThan(0)
      }
    } finally {
      await close()
    }
  })

  it('keeps an unchecked frame out of the completion path even when the card is otherwise done', async () => {
    const frame = seedFrame(BROKEN)
    const card = seedCard()
    const { client, close } = await connect()
    try {
      await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      const { parsed, isError } = await callTool(client, 'complete_card', {
        card_id: card.id,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { message: string }).message).toContain('its last review failed')
    } finally {
      await close()
    }
  })
})
