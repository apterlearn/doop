import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as frameLocks from '../server/frameLocks.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Actor, Canvas, ElementComment, Frame } from '../shared/types.ts'

/* The tools an agent reaches for BETWEEN the design calls: what other agents
   are holding, several frames' source in one round trip, which canvas needs it
   next, and a way to say what it is doing while it works. Each one is thin —
   it reads machinery that already exists — so what these cases pin is that the
   thinness is real: the lock registry, the bounded frame read, the claim
   routing and the caller's own run are the things actually being read.

   The database is real here (PGlite in a temp directory, as the server boots
   it) because the inbox counts proposals, which live in it. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-agent-tools-'))
const OWNER_ID = 'agent-tools-owner'
const CANVAS_ID = 'c-agent-tools'
const OTHER_CANVAS_ID = 'c-agent-tools-b'
const PAGE_ID = 'p-agent-tools'
const OTHER_PAGE_ID = 'p-agent-tools-b'
const FRAME_ID = 'f-hero'
const SECOND_FRAME_ID = 'f-pricing'
const LONG_FRAME_ID = 'f-long'
const OTHER_FRAME_ID = 'f-other'

/** Longer than the smallest bound get_frames_html accepts, so the clamp bites. */
const LONG_HTML = `<section>${'<p>copy</p>'.repeat(300)}</section>`

/** One entry of list_frame_locks, as an agent reads it. */
interface LockRow {
  frame_id: string
  frame_name: string
  held_by: string
  kind: string
  expires_at: string
  expires_in_seconds: number
}

/** One entry of get_frames_html — html, or the reason it is not there. */
interface FrameHtmlRow {
  frame_id: string
  html?: string
  html_bytes?: number
  html_truncated?: boolean
  error?: string
}

/** One entry of get_run_events. */
interface RunEventRow {
  kind: string
  name?: string
  summary?: string
  agentName: string
}

/** One canvas of get_inbox. */
interface InboxRow {
  canvas_id: string
  canvas_name: string
  open_questions: number
  unclaimed_comments: number
  unread_messages: number
  pending_proposals: number
}

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
}, 60_000)

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(clientId = 'agent-tools') {
  const server = buildMcpServer('Test Owner', OWNER_ID, clientId)
  const client = new Client({ name: 'doop-agent-tools-test', version: '1.0.0' })
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

/** The tool's payload, whether it arrived structured or as the text block. */
async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, unknown>, isError: result.isError }
}

function frame(id: string, canvasId: string, name: string, html: string, pageId: string): Frame {
  return {
    id,
    canvasId,
    name,
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
    pageId,
  }
}

function seed() {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Agent tools',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [
      frame(FRAME_ID, CANVAS_ID, 'Hero', '<h1>original</h1>', PAGE_ID),
      frame(SECOND_FRAME_ID, CANVAS_ID, 'Pricing', '<section>pricing</section>', PAGE_ID),
      frame(LONG_FRAME_ID, CANVAS_ID, 'Imported', LONG_HTML, PAGE_ID),
    ],
    pages: [{ id: PAGE_ID, canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  const other: Canvas = {
    id: OTHER_CANVAS_ID,
    name: 'Second canvas',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame(OTHER_FRAME_ID, OTHER_CANVAS_ID, 'Landing', '<h1>Hi</h1>', OTHER_PAGE_ID)],
    pages: [{ id: OTHER_PAGE_ID, canvasId: OTHER_CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas, other])
}

beforeEach(() => {
  frameLocks.clearLocks()
  actions.wire(
    () => {},
    () => {},
  )
  /* The log maps are per canvas and hydrating one the map does not mention
     leaves whatever the previous case left there — so every canvas this file
     reads is named, with an empty list. */
  const comments = new Map<string, ElementComment[]>()
  for (const canvasId of [CANVAS_ID, OTHER_CANVAS_ID]) comments.set(canvasId, [])
  actions.hydrateLogs({
    comments,
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  seed()
})

describe('list_frame_locks', () => {
  it('names the frame another agent claimed, and drops it once they let go', async () => {
    const { client, close } = await connect()
    try {
      const claimed = await callTool(client, 'begin_frame_edit', { frame_id: FRAME_ID, agent_name: 'Rival' })
      expect(claimed.isError).toBeFalsy()

      const held = await callTool(client, 'list_frame_locks', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(held.isError).toBeFalsy()
      const locks = held.parsed.locks as LockRow[]
      expect(locks).toHaveLength(1)
      expect(locks[0]?.frame_id).toBe(FRAME_ID)
      expect(locks[0]?.frame_name).toBe('Hero')
      expect(locks[0]?.held_by).toBe('Rival')
      expect(locks[0]?.kind).toBe('agent')
      expect(locks[0]?.expires_in_seconds).toBeGreaterThan(0)

      /* the release is what frees the frame for everyone else, and the listing
         has to follow it — a stale "busy" is an agent routing around a frame
         nobody is in */
      const released = await callTool(client, 'end_frame_edit', { frame_id: FRAME_ID, agent_name: 'Rival' })
      expect(released.isError).toBeFalsy()
      const free = await callTool(client, 'list_frame_locks', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(free.parsed.locks).toEqual([])
    } finally {
      await close()
    }
  })
})

describe('post_status', () => {
  it('adds a status line to the caller’s own run', async () => {
    const { client, close } = await connect()
    try {
      /* a call first, so the run already has a tool step to be read alongside */
      await callTool(client, 'get_canvas', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      const posted = await callTool(client, 'post_status', {
        canvas_id: CANVAS_ID,
        text: 'rebuilding the hero',
        step: 3,
        of: 7,
        agent_name: 'Claude',
      })
      expect(posted.isError).toBeFalsy()
      expect(posted.parsed.recorded).toBe(true)

      const runId = String(posted.parsed.run_id)
      const read = await callTool(client, 'get_run_events', {
        canvas_id: CANVAS_ID,
        run_id: runId,
        agent_name: 'Claude',
      })
      const events = read.parsed.events as RunEventRow[]
      const status = events.find((event) => event.kind === 'status')
      expect(status?.summary).toBe('3/7 rebuilding the hero')
      expect(status?.agentName).toBe('Claude')
      expect(status?.name).toBeUndefined()
      /* the caller's run, not a run of its own: the tool step it made is on the
         same timeline */
      expect(events.some((event) => event.kind === 'tool' && event.name === 'get_canvas')).toBe(true)
    } finally {
      await close()
    }
  })

  it('refuses a step with no total rather than writing "3/?"', async () => {
    const { client, close } = await connect()
    try {
      const { isError } = await callTool(client, 'post_status', {
        canvas_id: CANVAS_ID,
        text: 'rebuilding the hero',
        step: 3,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
    } finally {
      await close()
    }
  })
})

describe('get_inbox', () => {
  it('counts a note addressed to your role on another canvas, with no canvas named', async () => {
    const human: Actor = { name: 'alice', kind: 'user', color: '#000000' }
    /* the note is on the SECOND canvas, and the call below names neither */
    actions.addElementComment(
      OTHER_FRAME_ID,
      { selector: 'h1', snippet: '<h1>Hi</h1>', text: '@copy tighten this headline' },
      human,
    )

    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_inbox', { agent_name: 'Claude', role: 'copy' })
      expect(isError).toBeFalsy()
      const canvases = parsed.canvases as InboxRow[]
      expect(canvases.find((row) => row.canvas_id === OTHER_CANVAS_ID)).toEqual({
        canvas_id: OTHER_CANVAS_ID,
        canvas_name: 'Second canvas',
        open_questions: 0,
        unclaimed_comments: 1,
        unread_messages: 0,
        pending_proposals: 0,
      })
      /* the same note must not be counted on a canvas it is not on */
      expect(canvases.find((row) => row.canvas_id === CANVAS_ID)?.unclaimed_comments).toBe(0)
    } finally {
      await close()
    }
  })
})

describe('get_frames_html', () => {
  it('reads several frames in one call, and reports what it could not find per entry', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_frames_html', {
        canvas_id: CANVAS_ID,
        /* the last two are errors: no such id, and a real frame of ANOTHER
           canvas — which must not leak into this read */
        frame_ids: [FRAME_ID, SECOND_FRAME_ID, 'nope', OTHER_FRAME_ID],
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      const frames = parsed.frames as FrameHtmlRow[]
      expect(frames.map((row) => row.frame_id)).toEqual([FRAME_ID, SECOND_FRAME_ID, 'nope', OTHER_FRAME_ID])
      expect(frames[0]?.html).toBe('<h1>original</h1>')
      expect(frames[1]?.html).toBe('<section>pricing</section>')
      expect(frames[0]?.html_truncated).toBeUndefined()
      expect(frames[2]).toEqual({ frame_id: 'nope', error: 'not_found' })
      expect(frames[3]).toEqual({ frame_id: OTHER_FRAME_ID, error: 'not_found' })
    } finally {
      await close()
    }
  })

  it('clamps a frame to the bound it was given, and says it was cut', async () => {
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'get_frames_html', {
        canvas_id: CANVAS_ID,
        frame_ids: [LONG_FRAME_ID],
        max_bytes_each: 1000,
        agent_name: 'Claude',
      })
      const frames = parsed.frames as FrameHtmlRow[]
      expect(frames[0]?.html).toHaveLength(1000)
      expect(frames[0]?.html_truncated).toBe(true)
      /* the full document's length, so the agent knows how much is left */
      expect(frames[0]?.html_bytes).toBe(LONG_HTML.length)
    } finally {
      await close()
    }
  })
})
