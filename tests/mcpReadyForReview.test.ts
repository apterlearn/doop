import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The per-frame review report. ready_for_review renders a frame, records the
   result against the exact document it checked and names the blocking findings
   an agent has to fix; a report only describes the document it ran on, so a
   re-check after an edit records a fresh one. */

vi.mock('../server/db/persist.ts', () => {
  /* the report is stored by ready_for_review, so the store is real for those
     two functions and inert for everything else */
  const reviews = new Map<string, import('../shared/types.ts').FrameReview[]>()
  return {
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

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
})

describe.skipIf(!browser)('the review report over a real render', () => {
  it('passes a frame that meets the checks, with nothing blocking', async () => {
    const frame = seedFrame(CLEAN)
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
    } finally {
      await close()
    }
  })

  it('records a fresh report after the document changes', async () => {
    const frame = seedFrame(CLEAN)
    const { client, close } = await connect()
    try {
      const first = await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      expect(first.parsed.verdict).toBe('pass')
      /* the agent keeps working after checking — the report no longer
         describes the document, so the next check reports the one it ran on */
      actions.updateFrame(
        frame.id,
        { html: CLEAN.replace('Simple, predictable', 'Even simpler') },
        actions.resolveActor({ name: 'Claude', kind: 'agent', ownerId: OWNER_ID }),
      )
      const again = await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      expect(again.isError).toBeFalsy()
      expect(again.parsed.verdict).toBe('pass')
      expect(again.parsed.html_sha).not.toBe(first.parsed.html_sha)
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
})
