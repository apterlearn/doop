import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import * as runLog from '../server/runLog.ts'
import { store } from '../server/store.ts'
import type { Canvas, FrameVersion } from '../shared/types.ts'

/* The run lifecycle over MCP: what a run changed, its own timeline, and the
   run-level undo — plus pause/resume, the two ends of "stop this without
   losing the card". A journal is written at teardown, so these drive
   actions.recordRunJournal directly and read it back through the tools. */

const pendingVersions = vi.hoisted(() => new Map<string, FrameVersion>())

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
  savePlan: () => {},
  deletePlan: () => {},
  deletePlansFor: () => {},
  saveFrameReview: async () => {},
  listFrameReviews: async () => [],
  listFrameVersions: async () => [],
  getFrameVersion: async (id: string) => pendingVersions.get(id),
  listGuidelineVersions: async () => [],
  flush: async () => {},
}))

/* resume_work re-fires the canvas sweep, which would start a real model run. */
vi.mock('../server/resident.ts', () => ({
  onFeedback: () => {},
  cancelCanvasRuns: () => {},
}))

const OWNER_ID = 'run-owner'
const OTHER_ID = 'other-account'
const CANVAS_ID = 'c-runchanges'
const RUN_ID = 'run-abcdef'
const CARD_ID = 'card-1'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerName = 'Test Owner', ownerId = OWNER_ID) {
  const server = buildMcpServer(ownerName, ownerId)
  const client = new Client({ name: `doop-run-changes-${ownerId}`, version: '1.0.0' })
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return { parsed, raw, isError: result.isError }
}

function seed(linkAccess?: 'edit'): Canvas {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Run changes',
    ownerId: OWNER_ID,
    ...(linkAccess ? { linkAccess } : {}),
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [],
  }
  store.init([canvas])
  return canvas
}

/** The one frame the test created through MCP. */
const onlyFrameId = () => store.getCanvas(CANVAS_ID)!.frames[0]!.id

async function createFrame(client: Client, html = '<h1>new</h1>') {
  await call(client, 'create_frame', {
    canvas_id: CANVAS_ID,
    name: 'Hero',
    html,
    width: 800,
    height: 600,
    agent_name: 'Claude',
  })
  return onlyFrameId()
}

beforeEach(() => {
  vi.restoreAllMocks()
  pendingVersions.clear()
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map([[CANVAS_ID, []]]),
    feedback: new Map([[CANVAS_ID, []]]),
    comments: new Map([[CANVAS_ID, []]]),
    activity: new Map([[CANVAS_ID, []]]),
    decisions: new Map([[CANVAS_ID, []]]),
    proposals: new Map([[CANVAS_ID, []]]),
  })
  runLog.forgetCanvas(CANVAS_ID)
  seed()
})

describe('get_run_events', () => {
  it('filters the timeline to one run and pages with the cursor', async () => {
    const { client, close } = await connect()
    try {
      for (let i = 1; i <= 3; i++) {
        runLog.record({
          canvasId: CANVAS_ID,
          runId: RUN_ID,
          agentName: 'Claude',
          kind: 'tool',
          name: `tool-${i}`,
          ok: true,
          ms: i,
          summary: `call ${i}`,
        })
      }
      runLog.record({ canvasId: CANVAS_ID, runId: 'other-run', agentName: 'Codex', kind: 'tool', name: 'other' })

      const first = await call(client, 'get_run_events', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        limit: 2,
        agent_name: 'Claude',
      })
      expect(first.isError).toBeFalsy()
      const events = first.parsed.events as { name: string; runId: string; agentName: string; ms: number }[]
      expect(events.map((e) => e.name)).toEqual(['tool-3', 'tool-2'])
      expect(events.every((e) => e.runId === RUN_ID && e.agentName === 'Claude')).toBe(true)
      expect(first.parsed.total_shown).toBe(2)
      expect(first.parsed.has_more).toBe(true)
      expect(first.parsed.next_offset).toBe(2)

      const second = await call(client, 'get_run_events', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        cursor: 2,
        limit: 2,
        agent_name: 'Claude',
      })
      const rest = second.parsed.events as { name: string }[]
      expect(rest.map((e) => e.name)).toEqual(['tool-1'])
      expect(second.parsed.has_more).toBe(false)
      expect(second.parsed.next_offset).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('reports an empty timeline rather than failing', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await call(client, 'get_run_events', {
        canvas_id: CANVAS_ID,
        run_id: 'never-ran',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.events).toEqual([])
      expect(parsed.total_shown).toBe(0)
      expect(parsed.has_more).toBe(false)
    } finally {
      await close()
    }
  })
})

describe('get_run_changes', () => {
  it('reads a run journal by run id and by card id', async () => {
    const { client, close } = await connect()
    try {
      const frameId = await createFrame(client)
      actions.recordRunJournal({
        canvasId: CANVAS_ID,
        agentName: 'Claude',
        cardId: CARD_ID,
        runId: RUN_ID,
        summary: 'redesigned the hero',
        decisions: JSON.stringify({ guidelines: ['brand'] }),
        frames: [{ frameId, name: 'Hero', beforeVersionId: 'v-before', afterVersionId: 'v-after' }],
      })

      const byRun = await call(client, 'get_run_changes', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        agent_name: 'Claude',
      })
      expect(byRun.isError).toBeFalsy()
      expect(byRun.parsed.run_id).toBe(RUN_ID)
      expect(byRun.parsed.card_id).toBe(CARD_ID)
      expect(byRun.parsed.agent).toBe('Claude')
      expect(byRun.parsed.summary).toBe('redesigned the hero')
      expect(byRun.parsed.frames).toEqual([
        { frame_id: frameId, name: 'Hero', before_version_id: 'v-before', after_version_id: 'v-after' },
      ])
      expect(byRun.parsed.decisions).toEqual({ guidelines: ['brand'] })

      const byCard = await call(client, 'get_run_changes', { canvas_id: CANVAS_ID, card_id: CARD_ID })
      expect(byCard.parsed.run_id).toBe(RUN_ID)
      expect(byCard.parsed.frames).toEqual(byRun.parsed.frames)

      const unknown = await call(client, 'get_run_changes', {
        canvas_id: CANVAS_ID,
        run_id: 'no-such-run',
        agent_name: 'Claude',
      })
      expect(unknown.isError).toBe(true)
      expect((unknown.parsed.error as { code: string }).code).toBe('not_found')
    } finally {
      await close()
    }
  })

  it('returns an empty change set for a run that touched nothing', async () => {
    const { client, close } = await connect()
    try {
      actions.recordRunJournal({
        canvasId: CANVAS_ID,
        agentName: 'Claude',
        runId: RUN_ID,
        summary: 'answered a question',
      })
      const { parsed, isError } = await call(client, 'get_run_changes', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.frames).toEqual([])
    } finally {
      await close()
    }
  })
})

describe('revert_run', () => {
  it('restores every frame the run changed and reports one that is gone', async () => {
    const { client, close } = await connect()
    try {
      const frameId = await createFrame(client)
      pendingVersions.set('v-before', {
        id: 'v-before',
        frameId,
        canvasId: CANVAS_ID,
        name: 'Hero',
        html: '<h1>old</h1>',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        savedAt: 1,
        savedBy: 'alice',
      })
      actions.recordRunJournal({
        canvasId: CANVAS_ID,
        agentName: 'Claude',
        runId: RUN_ID,
        summary: 'redesigned the hero',
        frames: [
          { frameId, name: 'Hero', beforeVersionId: 'v-before', afterVersionId: 'v-after' },
          { frameId: 'f-deleted-since', name: 'Gone', beforeVersionId: 'v-gone' },
        ],
      })

      const { parsed, isError } = await call(client, 'revert_run', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.reverted).toEqual([frameId])
      expect(parsed.skipped).toEqual([{ frame_id: 'f-deleted-since', reason: 'the frame no longer exists' }])
      expect(store.getFrame(frameId)!.html).toBe('<h1>old</h1>')
    } finally {
      await close()
    }
  })

  it('skips a frame someone else edited after the run', async () => {
    const { client, close } = await connect()
    try {
      const frameId = await createFrame(client)
      pendingVersions.set('v-before', {
        id: 'v-before',
        frameId,
        canvasId: CANVAS_ID,
        name: 'Hero',
        html: '<h1>old</h1>',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        savedAt: 1,
        savedBy: 'alice',
      })
      actions.recordRunJournal({
        canvasId: CANVAS_ID,
        agentName: 'Claude',
        runId: RUN_ID,
        summary: 'redesigned the hero',
        frames: [{ frameId, name: 'Hero', beforeVersionId: 'v-before' }],
      })
      /* a human's later write: the frame moved on after the run ended */
      const frame = store.getFrame(frameId)!
      frame.updatedAt = Date.now() + 3_600_000
      frame.updatedBy = 'alice'
      const current = frame.html

      const { parsed } = await call(client, 'revert_run', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        agent_name: 'Claude',
      })
      expect(parsed.reverted).toEqual([])
      expect(parsed.skipped).toEqual([
        {
          frame_id: frameId,
          reason: expect.stringContaining('changed after the run by alice'),
        },
      ])
      expect(store.getFrame(frameId)!.html).toBe(current)
    } finally {
      await close()
    }
  })

  it('refuses while the canvas is in review mode', async () => {
    const { client, close } = await connect()
    try {
      await createFrame(client)
      actions.recordRunJournal({ canvasId: CANVAS_ID, agentName: 'Claude', runId: RUN_ID, summary: 'changed a frame' })
      store.setReviewMode(CANVAS_ID, true)
      const { parsed, isError } = await call(client, 'revert_run', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as { code: string }).code).toBe('unsupported')
    } finally {
      await close()
    }
  })

  it('says plainly when a run recorded no frame changes', async () => {
    const { client, close } = await connect()
    try {
      actions.recordRunJournal({ canvasId: CANVAS_ID, agentName: 'Claude', runId: RUN_ID, summary: 'no edits' })
      const { parsed, isError } = await call(client, 'revert_run', {
        canvas_id: CANVAS_ID,
        run_id: RUN_ID,
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.reverted).toEqual([])
      expect(parsed.skipped).toEqual([])
    } finally {
      await close()
    }
  })
})

describe('tool annotations', () => {
  it('marks the run undo destructive and the run reads read-only', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      expect(byName.get('get_run_changes')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('get_run_events')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('revert_run')!.annotations?.destructiveHint).toBe(true)
      expect(byName.get('pause_work')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
      expect(byName.get('resume_work')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    } finally {
      await close()
    }
  })
})

describe('pause_work / resume_work', () => {
  it('pauses a live card without failing it, then resumes it', async () => {
    const { client, close } = await connect()
    try {
      const card = actions.addQueuedCard(CANVAS_ID, 'Make a hero', 'alice')!
      actions.claimCard(CANVAS_ID, card.id, 'Claude')

      const paused = await call(client, 'pause_work', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(paused.isError).toBeFalsy()
      expect(paused.parsed.cards_paused).toBe(1)
      const after = actions.getTasks(CANVAS_ID).find((t) => t.id === card.id)!
      expect(after.pausedAt).toBeGreaterThan(0)
      expect(after.failedAt).toBeUndefined()
      expect(after.cancelledAt).toBeUndefined()
      /* the claim is dropped so the next sweep can pick it back up */
      expect(after.agentName).toBe('')

      const resumed = await call(client, 'resume_work', {
        canvas_id: CANVAS_ID,
        card_id: card.id,
        agent_name: 'Claude',
      })
      expect(resumed.isError).toBeFalsy()
      expect(resumed.parsed.resumed).toBe(true)
      expect(actions.getTasks(CANVAS_ID).find((t) => t.id === card.id)!.pausedAt).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('refuses to pause another account’s agent unless the caller owns the canvas', async () => {
    /* link access lets Bob reach the canvas — but stopping someone else's
       agent is a privileged act, exactly as stop_work treats it */
    seed('edit')
    const card = actions.addQueuedCard(CANVAS_ID, 'Make a hero', 'alice')!
    card.agentName = 'Claude'
    /* the run belongs to a third account — neither Bob's nor the canvas's */
    card.ownerId = 'third-account'
    const bob = await connect('Bob', OTHER_ID)
    try {
      const { parsed, isError } = await call(bob.client, 'pause_work', { canvas_id: CANVAS_ID, agent_name: 'Claude' })
      expect(isError).toBe(true)
      expect((parsed.error as { code: string }).code).toBe('forbidden')
      expect(card.pausedAt).toBeUndefined()
    } finally {
      await bob.close()
    }
  })
})
