import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as persist from '../server/db/persist.ts'
import * as frameLocks from '../server/frameLocks.ts'
import { clearOpIds } from '../server/opIds.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Dry runs are the one write path that must leave no trace: the frame keeps
   its HTML and its updatedAt, no version row is appended and nobody is told.
   `persist.saveFrame` is the version append (store.updateFrame writes through
   it), so it is the counter these tests read. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  hydrate: () => {},
  saveCanvas: vi.fn(),
  saveCanvasCopy: () => {},
  saveFrame: vi.fn(),
  deleteFrame: vi.fn(),
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
  listFrameReviews: async () => [],
}))

const OWNER_ID = 'dryrun-owner'
const CANVAS_ID = 'c-dryrun'
const FRAME_ID = 'f-dryrun'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-dryrun-test', version: '1.0.0' })
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

interface Diff {
  hunks: { a_start: number; b_start: number; lines: string[] }[]
  added: number
  removed: number
}

function seedCanvas(html: string): Frame {
  const frame: Frame = {
    id: FRAME_ID,
    canvasId: CANVAS_ID,
    name: 'Hero',
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    pageId: 'p-dryrun',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Dry run',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-dryrun', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

let broadcast: Mock

beforeEach(() => {
  vi.restoreAllMocks()
  /* the module mock outlives the test, so its counters are cleared by hand */
  vi.mocked(persist.saveFrame).mockClear()
  vi.mocked(persist.deleteFrame).mockClear()
  frameLocks.clearLocks()
  clearOpIds()
  broadcast = vi.fn()
  actions.wire(broadcast, () => {})
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  seedCanvas('<h1>original</h1>')
})

describe('dry_run', () => {
  it('diffs a rewrite and writes nothing at all', async () => {
    const { client, close } = await connect()
    try {
      const before = store.getFrame(FRAME_ID)!
      const beforeHtml = before.html
      const beforeUpdatedAt = before.updatedAt
      const sent = '<h1>rewritten</h1>\n<p>more</p>'

      const { parsed, isError } = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: sent,
        agent_name: 'Claude',
        dry_run: true,
      })
      expect(isError).toBeFalsy()
      expect(parsed.dry_run).toBe(true)
      expect(parsed.would_apply).toBe(true)
      expect(parsed.bytes_before).toBe(beforeHtml.length)
      expect(parsed.bytes_after).toBe(sent.length)
      const diff = parsed.diff as unknown as Diff
      /* one line replaced by two: the original heading, plus the new paragraph */
      expect(diff.added).toBe(2)
      expect(diff.removed).toBe(1)
      expect(diff.hunks.flatMap((hunk) => hunk.lines)).toContain('+<h1>rewritten</h1>')

      /* untouched: same document, same timestamp, no version, no broadcast */
      const after = store.getFrame(FRAME_ID)!
      expect(after.html).toBe(beforeHtml)
      expect(after.updatedAt).toBe(beforeUpdatedAt)
      expect(persist.saveFrame).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()

      /* the same call without dry_run does write — so the counters above mean
         something rather than counting a path that never fires */
      const real = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: sent,
        agent_name: 'Claude',
      })
      expect(real.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)!.html).toBe(sent)
      expect(persist.saveFrame).toHaveBeenCalled()
      expect(broadcast).toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('reports would_apply: false for an identical document', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'set_frame_html', {
        frame_id: FRAME_ID,
        html: store.getFrame(FRAME_ID)!.html,
        agent_name: 'Claude',
        dry_run: true,
      })
      expect(isError).toBeFalsy()
      expect(parsed.would_apply).toBe(false)
      const diff = parsed.diff as unknown as Diff
      expect(diff.hunks).toEqual([])
      expect([diff.added, diff.removed]).toEqual([0, 0])
      expect(persist.saveFrame).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('previews a delete and leaves the frame standing', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'delete_frame', {
        frame_id: FRAME_ID,
        agent_name: 'Claude',
        dry_run: true,
      })
      expect(isError).toBeFalsy()
      expect(parsed.dry_run).toBe(true)
      expect(parsed.would_apply).toBe(true)
      /* the payload carries the frame the delete would remove, read back as
         the summary the tool publishes */
      const doomed = parsed.frame as unknown as { id: string; name: string }
      expect(doomed.id).toBe(FRAME_ID)
      expect(doomed.name).toBe('Hero')
      expect(store.getFrame(FRAME_ID)).toBeDefined()
      expect(persist.deleteFrame).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()

      const real = await callTool(client, 'delete_frame', { frame_id: FRAME_ID, agent_name: 'Claude' })
      expect(real.isError).toBeFalsy()
      expect(store.getFrame(FRAME_ID)).toBeUndefined()
      expect(persist.deleteFrame).toHaveBeenCalled()
    } finally {
      await close()
    }
  })

  it('previews a find-and-replace, and says when the find would not land', async () => {
    const { client, close } = await connect()
    try {
      const html = store.getFrame(FRAME_ID)!.html
      const hit = await callTool(client, 'edit_frame_html', {
        frame_id: FRAME_ID,
        old_str: '<h1>',
        new_str: '<h1 class="title">',
        agent_name: 'Claude',
        dry_run: true,
      })
      expect(hit.isError).toBeFalsy()
      expect(hit.parsed.found).toBe(true)
      expect(hit.parsed.matches).toBe(1)
      expect(hit.parsed.would_apply).toBe(true)
      expect(hit.parsed.bytes_after).toBeGreaterThan(hit.parsed.bytes_before!)
      expect(store.getFrame(FRAME_ID)!.html).toBe(html)

      /* not found is a false answer, not a refusal: the caller is asking what
         the call would do */
      const miss = await callTool(client, 'edit_frame_html', {
        frame_id: FRAME_ID,
        old_str: '<section>',
        new_str: '<div>',
        agent_name: 'Claude',
        dry_run: true,
      })
      expect(miss.isError).toBeFalsy()
      expect(miss.parsed.found).toBe(false)
      expect(miss.parsed.matches).toBe(0)
      expect(miss.parsed.would_apply).toBe(false)
      expect(store.getFrame(FRAME_ID)!.html).toBe(html)
      expect(persist.saveFrame).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  })
})

/* Both of these render the frame to know what the edit would produce, so they
   need a browser; the no-write half of the contract is the same. */
describe.skipIf(!findBrowserPath())('dry_run over a real render', () => {
  it('previews a stylesheet and an element edit without writing either', async () => {
    const frame = seedCanvas('<style>.btn{background:#fff}</style><button class="btn">Buy</button>')
    const { client, close } = await connect()
    try {
      const css = '.btn:hover{background:#f00}'
      const sheet = await callTool(client, 'set_frame_css', {
        frame_id: FRAME_ID,
        css,
        agent_name: 'Claude',
        dry_run: true,
      })
      expect(sheet.isError).toBeFalsy()
      expect(sheet.parsed.dry_run).toBe(true)
      expect(sheet.parsed.would_apply).toBe(true)
      expect(sheet.parsed.css_bytes).toBe(css.length)
      const sheetDiff = sheet.parsed.diff as unknown as Diff
      expect(sheetDiff.added).toBeGreaterThan(0)

      const elements = await callTool(client, 'update_elements', {
        canvas_id: CANVAS_ID,
        frame_id: FRAME_ID,
        agent_name: 'Claude',
        dry_run: true,
        edits: [{ selector: '.btn', style: { 'background-color': 'rgb(255, 0, 0)' } }],
      })
      expect(elements.isError).toBeFalsy()
      expect(elements.parsed.dry_run).toBe(true)
      expect(elements.parsed.would_apply).toBe(true)
      expect(elements.parsed.applied).toBe(1)
      expect(elements.parsed.ambiguous).toEqual([])

      expect(store.getFrame(FRAME_ID)!.html).toBe(frame.html)
      expect(persist.saveFrame).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()
    } finally {
      await close()
    }
  }, 60_000)
})

/* apply_ops runs the same dry run through its own loop: every op validated,
   the ones that can diff asked for one, nothing applied. */
describe('dry_run inside apply_ops', () => {
  it('reports each op and applies none of them', async () => {
    const { client, close } = await connect()
    try {
      const html = store.getFrame(FRAME_ID)!.html
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        agent_name: 'Claude',
        dry_run: true,
        ops: [
          { op: 'set_frame_html', frame_id: FRAME_ID, html: '<h1>rewritten</h1>', agent_name: 'Claude' },
          { op: 'update_frame', frame_id: FRAME_ID, name: 'Hero v2', agent_name: 'Claude' },
        ],
      })
      expect(isError).toBeFalsy()
      expect(parsed.dry_run).toBe(true)
      expect(parsed.applied).toBe(0)
      expect(parsed.failed).toBe(0)
      expect(parsed.would_apply).toBe(2)
      const results = parsed.results as unknown as {
        index: number
        op: string
        ok: boolean
        would_apply: boolean
        diff?: Diff
      }[]
      expect(results.map((entry) => entry.index)).toEqual([0, 1])
      /* the op that can diff its write carries one; the rest cleared pre-flight */
      expect(results[0]!.diff!.removed).toBe(1)
      expect(results[1]!.diff).toBeUndefined()
      expect(results.every((entry) => entry.would_apply)).toBe(true)

      expect(store.getFrame(FRAME_ID)!.html).toBe(html)
      expect(store.getFrame(FRAME_ID)!.name).toBe('Hero')
      expect(persist.saveFrame).not.toHaveBeenCalled()
      expect(broadcast).not.toHaveBeenCalled()

      /* an op that could not run is reported by index, not applied */
      const blocked = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        agent_name: 'Claude',
        dry_run: true,
        ops: [{ op: 'set_frame_html', frame_id: 'nope', html: '<p>x</p>', agent_name: 'Claude' }],
      })
      expect(blocked.isError).toBeFalsy()
      expect(blocked.parsed.applied).toBe(0)
      expect(blocked.parsed.would_apply).toBe(0)
      expect(blocked.parsed.failed).toBe(1)
      expect(store.getFrame(FRAME_ID)!.html).toBe(html)
    } finally {
      await close()
    }
  })
})
