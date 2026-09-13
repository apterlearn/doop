import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { Client as ApiClient, startServer, type Server } from './harness.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Verification reports are persisted, so this file drives the real database:
   a PGlite cluster in a temp directory, migrated at boot exactly as the server
   does. What it proves is the part mocks cannot — that a report survives the
   agent that made it, and that the delivery gate reads it back. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-frame-reviews-'))
const OWNER_ID = 'reviews-owner'
const CANVAS_ID = 'c-reviews'

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  /* the same drain the server runs on shutdown: frame writes are debounced, and
     a pending one would be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-frame-reviews-test', version: '1.0.0' })
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

const CLEAN = `<!doctype html><html lang="en"><head><title>Acme</title>
  <meta name="description" content="Acme.">
  <style>
    body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
    h1 { font-size: 32px; line-height: 1.25; }
    a:hover { text-decoration: underline }
    a:focus-visible { outline: 2px solid #111110 }
  </style></head>
  <body><main style="min-height:700px"><h1>Acme</h1>
  <p style="color:#111110">We make things that work, reliably.</p>
  <a href="/start" style="color:#111110">Start</a></main></body></html>`

const frame: Frame = {
  id: 'f-reviews',
  canvasId: CANVAS_ID,
  name: 'Home',
  x: 0,
  y: 0,
  width: 1200,
  height: 900,
  html: CLEAN,
  createdAt: 0,
  updatedAt: 1,
  updatedBy: 'Claude',
  pageId: 'p-reviews',
}

beforeEach(async () => {
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
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Reviews',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [{ ...frame }],
    pages: [{ id: 'p-reviews', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  await persist.saveFrame(frame)
})

let cardSeq = 0
function seedCard(agentName = 'Claude') {
  cardSeq += 1
  const card = actions.addQueuedCard(CANVAS_ID, `Card ${cardSeq}`, 'alice', undefined, undefined, 'alice')!
  actions.claimCard(CANVAS_ID, card.id, agentName)
  return card
}

describe.skipIf(!findBrowserPath())('stored verification reports', () => {
  it('survives the agent that made it, and the gate reads it back', { timeout: 20_000 }, async () => {
    const card = seedCard()
    const first = await connect()
    try {
      const review = await callTool(first.client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      expect(review.parsed.verdict).toBe('pass')
      /* persisted: newest first, with the summary the panel renders */
      const stored = await persist.listFrameReviews(frame.id, 5)
      expect(stored).toHaveLength(1)
      expect(stored[0]!.verdict).toBe('pass')
      expect(stored[0]!.reviewedBy).toBe('Claude')
      expect(stored[0]!.summary).toMatchObject({ critical: 0, errors: 0, content_errors: 0 })
    } finally {
      await first.close()
    }

    /* a different server instance, as a later session would be */
    const second = await connect()
    try {
      const done = await callTool(second.client, 'complete_card', { card_id: card.id, agent_name: 'Claude' })
      expect(done.isError).toBeFalsy()
    } finally {
      await second.close()
    }
  })

  it('marks the report stale once the frame changes, and clears it after a re-check', async () => {
    const card = seedCard()
    const { client, close } = await connect()
    try {
      await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      actions.updateFrame(
        frame.id,
        { html: CLEAN.replace('reliably', 'quickly') },
        actions.resolveActor({ name: 'Claude', kind: 'agent', ownerId: OWNER_ID }),
      )

      const blocked = await callTool(client, 'complete_card', { card_id: card.id, agent_name: 'Claude' })
      expect(blocked.isError).toBe(true)
      expect((blocked.parsed.error as unknown as { message: string }).message).toContain(
        'changed after its last review',
      )

      /* the newest report is what the gate reads, so a fresh check unblocks it */
      const again = await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      expect(again.parsed.verdict).toBe('pass')
      const stored = await persist.listFrameReviews(frame.id, 5)
      expect(stored.length).toBeGreaterThanOrEqual(2)
      /* newest first: the current document is the one described */
      expect(stored[0]!.htmlSha).toBe(again.parsed.html_sha)

      const done = await callTool(client, 'complete_card', { card_id: card.id, agent_name: 'Claude' })
      expect(done.isError).toBeFalsy()
    } finally {
      await close()
    }
  })

  it('does not carry one agent’s verification over to another’s frame', async () => {
    const card = seedCard('Other')
    const { client, close } = await connect()
    try {
      await callTool(client, 'ready_for_review', {
        canvas_id: CANVAS_ID,
        frame_id: frame.id,
        agent_name: 'Claude',
      })
      /* the frame's last writer is Claude, so Other has nothing unverified and
         nothing to answer for: the gate follows authorship, not the canvas */
      const done = await callTool(client, 'complete_card', { card_id: card.id, agent_name: 'Other' })
      expect(done.isError).toBeFalsy()
    } finally {
      await close()
    }
  })
})

/* The same gate, on a human's word. A reviewer reading the checks panel should
   not have to wait for an agent to re-run the checks, and the report the button
   produces has to be the same stored kind the panel and the delivery gate read
   — not a second, parallel notion of "checked". */

const REST_PORT = 4988

describe.skipIf(!findBrowserPath())('checks a human can trigger', () => {
  let server: Server
  let client: ApiClient
  let canvasId: string
  let frameId: string

  beforeAll(async () => {
    server = await startServer(REST_PORT)
    client = new ApiClient(server)
    await client.signUp('checks@test.dev', 'Checker')
    canvasId = (await (await client.post('/api/canvases', { name: 'Checks' })).json()).id
    frameId = (await (await client.post(`/api/canvases/${canvasId}/frames`, { name: 'Home' })).json()).id
    await client.patch(`/api/frames/${frameId}`, { html: CLEAN })
  }, 90_000)

  afterAll(() => server?.stop())

  it('stores a report the panel can read, current for the html it checked', async () => {
    const res = await client.post(`/api/frames/${frameId}/reviews`)
    expect(res.status).toBe(200)
    const report = (await res.json()) as { id: string; verdict: string; htmlSha: string; current: boolean }
    expect(report.verdict).toBe('pass')
    expect(report.current).toBe(true)

    /* stored, not merely returned: the GET the panel reads reports it back */
    const listed = (await (await client.get(`/api/frames/${frameId}/reviews`)).json()) as {
      id: string
      htmlSha: string
      current: boolean
    }[]
    expect(listed[0]!.id).toBe(report.id)
    expect(listed[0]!.htmlSha).toBe(report.htmlSha)
    expect(listed[0]!.current).toBe(true)
  })

  it('marks the earlier report stale after the frame changes', async () => {
    await client.patch(`/api/frames/${frameId}`, { html: CLEAN.replace('reliably', 'quickly') })
    const listed = (await (await client.get(`/api/frames/${frameId}/reviews`)).json()) as {
      id: string
      current: boolean
    }[]
    expect(listed[0]!.current).toBe(false)

    const fresh = (await (await client.post(`/api/frames/${frameId}/reviews`)).json()) as {
      htmlSha: string
      current: boolean
    }
    expect(fresh.current).toBe(true)
    const after = (await (await client.get(`/api/frames/${frameId}/reviews`)).json()) as {
      id: string
      htmlSha: string
      current: boolean
    }[]
    expect(after[0]!.htmlSha).toBe(fresh.htmlSha)
    expect(after[0]!.current).toBe(true)
  })
})
