import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import * as frameLocks from '../server/frameLocks.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { frameSha, reviewToRecord, type ReviewReport } from '../server/review.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Recovery, from the agent's side: what a delete left in the trash and how to
   take it back out, what the canvas looked like at a checkpoint and how to roll
   it back, and the verdict a frame already holds — read back instead of
   re-run. Every one of them is a thin layer over machinery that already
   exists (the store's trash, the canvas-version ring, the stored review rows),
   so what these cases pin is that the thinness is real: the frame comes back
   live and durably, a lock is still a lock, the rollback says what it could
   not put back, and a viewer reaches all three reads and none of the writes.

   The database is real here (PGlite in a temp directory, as the server boots
   it) because two of the three read back rows: a frame's version history and
   the stored review report. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-mcp-recovery-'))
const OWNER_ID = 'recovery-owner'
const VIEWER_ID = 'recovery-viewer'

/** One entry of list_trash, as an agent reads it. */
interface TrashRow {
  id: string
  name: string
  kind: string
  canvas_id: string
  deleted_at: string
  page_id?: string
  frame_count?: number
}

/** One entry of list_canvas_versions. */
interface VersionRow {
  id: string
  label: string
  at: string
  by: string
  frame_count: number
}

/** One blocking finding, as get_frame_review reports it. */
interface ReviewIssue {
  rule: string
  selector: string
  detail: string
  source: string
}

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
  /* the same drain the server runs on shutdown: a pending frame write would
     otherwise be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
}, 60_000)

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

/** A connection of its own per case: the account's MCP session — and with it
 *  the canvas a call that omits `canvas_id` inherits — is keyed by the client
 *  id, so a shared one would hand the next case the canvas the last one
 *  worked on. The real endpoint derives one id per connected client, which is
 *  the isolation each case here assumes. */
let connections = 0

async function connect(name = 'Test Owner', ownerId = OWNER_ID, clientId = `recovery-${(connections += 1)}`) {
  const server = buildMcpServer(name, ownerId, clientId)
  const client = new Client({ name: 'doop-mcp-recovery-test', version: '1.0.0' })
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

/** The payload's own array under `key`, validated as an array before it is read
 *  as one — the test's boundary, since a tool payload arrives as JSON. */
function rowsOf<T>(parsed: Record<string, unknown>, key: string): T[] {
  const value = parsed[key]
  return Array.isArray(value) ? (value as T[]) : []
}

/** The typed code of a refused call — `''` when the call carried no payload. */
function errorCode(parsed: Record<string, unknown>): string {
  const error = parsed.error
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  return typeof error.code === 'string' ? error.code : ''
}

/** The holder a lock conflict names. */
function conflictHolder(parsed: Record<string, unknown>): unknown {
  const error = parsed.error
  if (!error || typeof error !== 'object' || !('holder' in error)) return undefined
  return error.holder
}

/** A stored report in the shape the gate writes: one blocking finding, so the
 *  read-back has something to report. */
function storedReport(frame: Frame, verdict: 'pass' | 'fail'): ReviewReport {
  return {
    frame_id: frame.id,
    html_sha: frameSha(frame, undefined),
    frame_updated_at: frame.updatedAt,
    reviewed_at: Date.now(),
    viewports: [],
    summary: {
      critical: 0,
      serious: 0,
      errors: 0,
      warnings: 0,
      off_token: 0,
      off_token_font: 0,
      off_token_type: 0,
      content_errors: 0,
      content_warnings: 0,
    },
    blocking: [{ rule: 'a11y/contrast', selector: 'p', detail: 'contrast 3.1:1', source: 'a11y' }],
    advisory: [],
    failing_viewports: [],
    verdict,
  }
}

let counter = 0
let canvas: Canvas
let hero: Frame
let pricing: Frame

beforeEach(() => {
  counter += 1
  frameLocks.clearLocks()
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  /* one canvas per case, made the way the app makes one — so no case counts
     versions or trash rows an earlier one left behind */
  canvas = store.createCanvas(`Recovery ${counter}`, OWNER_ID)
  hero = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>hero</h1>', width: 800, height: 600 }, 'Owner')!
  pricing = store.createFrame(
    canvas.id,
    { name: 'Pricing', html: '<h1>pricing</h1>', width: 800, height: 600 },
    'Owner',
  )!
})

describe('recovery from the trash', () => {
  it('lists a deleted frame and puts it back live, logged and durably', async () => {
    const { client, close } = await connect()
    try {
      const deleted = await callTool(client, 'delete_frame', { frame_id: hero.id, agent_name: 'Claude' })
      expect(deleted.isError).toBeFalsy()
      expect(store.getFrame(hero.id)).toBeUndefined()

      const listed = await callTool(client, 'list_trash', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect(listed.isError).toBeFalsy()
      const items = rowsOf<TrashRow>(listed.parsed, 'items')
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        id: hero.id,
        name: 'Hero',
        kind: 'frames',
        canvas_id: canvas.id,
        page_id: hero.pageId,
      })
      expect(Number.isNaN(Date.parse(items[0]!.deleted_at))).toBe(false)

      const restored = await callTool(client, 'restore_frame', { id: hero.id, agent_name: 'Claude' })
      expect(restored.isError).toBeFalsy()
      expect(restored.parsed.frame).toMatchObject({ id: hero.id, name: 'Hero' })
      /* live again on its canvas, with the document it went down with */
      expect(store.getFrame(hero.id)?.html).toBe('<h1>hero</h1>')
      /* and out of the trash, so the listing follows the restore */
      const after = await callTool(client, 'list_trash', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect(after.parsed.items).toEqual([])

      /* the room is told: the restore is an ordinary edit, logged like one */
      const activity = actions.getActivity(canvas.id)
      expect(activity[0]?.message).toBe('restored frame “Hero” from the trash')
      expect(activity[0]?.actorName).toBe('Claude')

      /* and it went through the durable write path every other edit uses, so
         the document that came back is the frame's saved history */
      await vi.waitFor(async () => {
        const versions = await persist.listFrameVersions(hero.id, 5)
        expect(versions[0]?.html).toBe('<h1>hero</h1>')
      })
    } finally {
      await close()
    }
  })

  it('brings a deleted page and the frame that went down with it back together', async () => {
    const { client, close } = await connect()
    try {
      const made = await callTool(client, 'create_page', { canvas_id: canvas.id, name: 'Page 2', agent_name: 'Claude' })
      expect(made.isError).toBeFalsy()
      const pageId = String(made.parsed.id)
      const moved = await callTool(client, 'move_frame', { frame_id: pricing.id, page: pageId, agent_name: 'Claude' })
      expect(moved.isError).toBeFalsy()
      const deleted = await callTool(client, 'delete_page', { page_id: pageId, agent_name: 'Claude' })
      expect(deleted.isError).toBeFalsy()
      expect(store.getPage(pageId)).toBeUndefined()
      expect(store.getFrame(pricing.id)).toBeUndefined()

      const listed = await callTool(client, 'list_trash', {
        canvas_id: canvas.id,
        kind: 'pages',
        agent_name: 'Claude',
      })
      expect(listed.isError).toBeFalsy()
      const items = listed.parsed.items as TrashRow[]
      /* the frame count is what tells the caller a page restore is more than a
         page: it is how many frames come back with it */
      expect(items).toEqual([expect.objectContaining({ id: pageId, name: 'Page 2', kind: 'pages', frame_count: 1 })])

      const restored = await callTool(client, 'restore_page', { id: pageId, agent_name: 'Claude' })
      expect(restored.isError).toBeFalsy()
      expect(restored.parsed).toMatchObject({ page_id: pageId, name: 'Page 2', frames_restored: 1 })
      /* one action, both halves: the page is back in its slot and the frame
         that went down with it is on it again */
      expect(store.getPage(pageId)?.page.name).toBe('Page 2')
      expect(store.getFrame(pricing.id)?.pageId).toBe(pageId)
    } finally {
      await close()
    }
  })

  it('refuses a restore into a frame another agent is holding, and changes nothing', async () => {
    const { client, close } = await connect()
    try {
      /* Rival claims the frame; Claude deletes it with takeover, which takes
         the lock over — and a lock outlives the frame it was taken on, which is
         the state this refusal exists for */
      const claimed = await callTool(client, 'begin_frame_edit', { frame_id: hero.id, agent_name: 'Rival' })
      expect(claimed.isError).toBeFalsy()
      const deleted = await callTool(client, 'delete_frame', {
        frame_id: hero.id,
        agent_name: 'Claude',
        takeover: true,
      })
      expect(deleted.isError).toBeFalsy()

      const refused = await callTool(client, 'restore_frame', { id: hero.id, agent_name: 'Rival' })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('conflict')
      expect(conflictHolder(refused.parsed)).toBe('Claude')
      /* refused is refused: the frame is exactly where it was */
      expect(store.getFrame(hero.id)).toBeUndefined()
      expect(store.getTrashedFrame(hero.id)).toBeDefined()

      /* and the escape hatch a write tool offers is here too */
      const taken = await callTool(client, 'restore_frame', {
        id: hero.id,
        agent_name: 'Rival',
        takeover: true,
      })
      expect(taken.isError).toBeFalsy()
      expect(store.getFrame(hero.id)).toBeDefined()
    } finally {
      await close()
    }
  })
})

describe('canvas checkpoints', () => {
  it('saves one, names it in the history, and rolls two frames back to it', async () => {
    const { client, close } = await connect()
    try {
      const saved = await callTool(client, 'create_canvas_version', {
        canvas_id: canvas.id,
        label: 'before the rewrite',
        agent_name: 'Claude',
      })
      expect(saved.isError).toBeFalsy()
      expect(saved.parsed).toMatchObject({ label: 'manual', frame_count: 2 })
      const versionId = String(saved.parsed.version_id)

      const listed = await callTool(client, 'list_canvas_versions', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect(listed.isError).toBeFalsy()
      const versions = listed.parsed.versions as VersionRow[]
      expect(versions[0]).toMatchObject({ id: versionId, label: 'manual', by: 'Claude', frame_count: 2 })
      expect(Number.isNaN(Date.parse(versions[0]!.at))).toBe(false)

      for (const [frameId, html] of [
        [hero.id, '<h1>hero v2</h1>'],
        [pricing.id, '<h1>pricing v2</h1>'],
      ] as [string, string][]) {
        const written = await callTool(client, 'set_frame_html', { frame_id: frameId, html, agent_name: 'Claude' })
        expect(written.isError).toBeFalsy()
      }
      expect(store.getFrame(hero.id)?.html).toBe('<h1>hero v2</h1>')

      const rolled = await callTool(client, 'restore_canvas_version', {
        canvas_id: canvas.id,
        version_id: versionId,
        agent_name: 'Claude',
      })
      expect(rolled.isError).toBeFalsy()
      expect(rolled.parsed).toMatchObject({ restored: 2, created: 0, skipped: [] })
      expect(store.getFrame(hero.id)?.html).toBe('<h1>hero</h1>')
      expect(store.getFrame(pricing.id)?.html).toBe('<h1>pricing</h1>')

      /* the rollback checkpoints the state it replaced, so a restore is never a
         one-way door — and the history says which checkpoint is which */
      const after = await callTool(client, 'list_canvas_versions', { canvas_id: canvas.id, agent_name: 'Claude' })
      expect((after.parsed.versions as VersionRow[])[0]?.label).toBe('restore')
    } finally {
      await close()
    }
  })

  it('answers not_found for a checkpoint this canvas does not hold', async () => {
    const { client, close } = await connect()
    try {
      const refused = await callTool(client, 'restore_canvas_version', {
        canvas_id: canvas.id,
        version_id: 'no-such-version',
        agent_name: 'Claude',
      })
      expect(refused.isError).toBe(true)
      expect(errorCode(refused.parsed)).toBe('not_found')
      expect(store.getFrame(hero.id)?.html).toBe('<h1>hero</h1>')
    } finally {
      await close()
    }
  })
})

describe('the stored verdict', () => {
  it('says plainly when a frame has never been reviewed', async () => {
    const { client, close } = await connect()
    try {
      const read = await callTool(client, 'get_frame_review', { frame_id: hero.id, agent_name: 'Claude' })
      expect(read.isError).toBeFalsy()
      expect(read.parsed).toMatchObject({ frame_id: hero.id, source: 'none' })
      expect(String(read.parsed.note)).toContain('ready_for_review')
    } finally {
      await close()
    }
  })

  it('reads back the verdict, its findings, and whether the report still describes the frame', async () => {
    const { client, close } = await connect()
    try {
      /* the row ready_for_review / review_frame writes — the same read the ship
         gate makes, so what this pins is the read-back, not a fresh render */
      await persist.saveFrameReview(reviewToRecord(storedReport(hero, 'fail'), canvas.id, 'Claude'))

      const read = await callTool(client, 'get_frame_review', { frame_id: hero.id, agent_name: 'Claude' })
      expect(read.isError).toBeFalsy()
      expect(read.parsed).toMatchObject({
        frame_id: hero.id,
        source: 'stored',
        verdict: 'fail',
        by: 'Claude',
        current: true,
      })
      expect(Number.isNaN(Date.parse(String(read.parsed.at)))).toBe(false)
      expect(read.parsed.issues as ReviewIssue[]).toEqual([
        { rule: 'a11y/contrast', selector: 'p', detail: 'contrast 3.1:1', source: 'a11y' },
      ])

      /* a report is evidence about the document it was made from: an edit since
         makes it stale, which is exactly what the ship paths refuse on */
      const written = await callTool(client, 'set_frame_html', {
        frame_id: hero.id,
        html: '<h1>hero v2</h1>',
        agent_name: 'Claude',
      })
      expect(written.isError).toBeFalsy()
      const again = await callTool(client, 'get_frame_review', { frame_id: hero.id, agent_name: 'Claude' })
      expect(again.parsed).toMatchObject({ source: 'stored', verdict: 'fail', current: false })
    } finally {
      await close()
    }
  })

  /* the write path this reads back, end to end, where the renderer exists: the
     render itself is frameReviews.test.ts's subject, not this file's */
  describe.skipIf(!findBrowserPath())('after the gate ran', () => {
    it('reads back the verdict ready_for_review recorded', async () => {
      const { client, close } = await connect()
      try {
        const checked = await callTool(client, 'ready_for_review', {
          canvas_id: canvas.id,
          frame_id: hero.id,
          agent_name: 'Claude',
        })
        expect(checked.isError).toBeFalsy()

        const read = await callTool(client, 'get_frame_review', { frame_id: hero.id, agent_name: 'Claude' })
        expect(read.isError).toBeFalsy()
        expect(read.parsed).toMatchObject({
          source: 'stored',
          verdict: checked.parsed.verdict,
          by: 'Claude',
          current: true,
        })
      } finally {
        await close()
      }
    })
  })
})

describe('a viewer reaches the reads and none of the writes', () => {
  it('answers the three reads and refuses the four restores', async () => {
    store.addMember(canvas.id, VIEWER_ID, OWNER_ID, 'viewer')
    const owner = await connect()
    const viewer = await connect('Vic', VIEWER_ID, 'recovery-viewer')
    try {
      /* the trash holds something real, so the refused restores name a real id
         rather than failing on the lookup */
      const made = await callTool(owner.client, 'create_page', {
        canvas_id: canvas.id,
        name: 'Page 2',
        agent_name: 'Claude',
      })
      const pageId = String(made.parsed.id)
      await callTool(owner.client, 'delete_frame', { frame_id: hero.id, agent_name: 'Claude' })
      await callTool(owner.client, 'delete_page', { page_id: pageId, agent_name: 'Claude' })
      const version = await callTool(owner.client, 'create_canvas_version', {
        canvas_id: canvas.id,
        agent_name: 'Claude',
      })

      const reads: [string, Record<string, unknown>][] = [
        ['list_canvas_versions', { canvas_id: canvas.id }],
        ['list_trash', { canvas_id: canvas.id }],
        ['get_frame_review', { frame_id: pricing.id }],
      ]
      for (const [name, args] of reads) {
        const read = await callTool(viewer.client, name, args)
        expect(read.isError, `${name} is a read`).toBeFalsy()
      }
      /* the trash is the owner's view, and the answer says so rather than
         pretending the canvas has nothing in it */
      const trash = await callTool(viewer.client, 'list_trash', { canvas_id: canvas.id })
      expect(trash.parsed.items).toEqual([])
      expect(String(trash.parsed.note)).toContain('owner')

      const writes: [string, Record<string, unknown>][] = [
        ['create_canvas_version', { canvas_id: canvas.id }],
        ['restore_canvas_version', { canvas_id: canvas.id, version_id: String(version.parsed.version_id) }],
        /* these two name only the id: the canvas comes from the trash entry, so
           the refusal is the tool's own, not the wrapper's argument check */
        ['restore_frame', { id: hero.id }],
        ['restore_page', { id: pageId }],
      ]
      for (const [name, args] of writes) {
        const refused = await callTool(viewer.client, name, args)
        expect(refused.isError, `${name} writes`).toBe(true)
        expect(errorCode(refused.parsed), `${name} writes`).toBe('forbidden')
      }
      /* nothing moved */
      expect(store.getFrame(hero.id)).toBeUndefined()
      expect(store.getTrashedPage(pageId)).toBeDefined()
    } finally {
      await viewer.close()
      await owner.close()
    }
  })
})
