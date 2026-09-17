import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, db, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { runEvents } from '../server/db/schema.ts'
import { ARGS_CAP, getRunEvents, record, recordStatus } from '../server/runLog.ts'
import type { RunEvent } from '../shared/types.ts'

/**
 * A step's arguments are the difference between "the agent called
 * set_frame_html" and "the agent called set_frame_html with this html": what
 * makes the Run tab's detail pane worth opening. They are stored as text, cut
 * at ARGS_CAP bytes, and mirrored to the run_events row so a restart rebuilds
 * the same timeline — which is what these cases drive, against the real PGlite
 * the server boots, with the rows read back through db.select() rather than
 * through the writer that produced them.
 *
 * The actor's identity rides the same ring, row and hydrate: `actorKind` says
 * whether a human or an agent is running the timeline, and `agentId` is what
 * addresses the right agent when two accounts share a display name. Both are
 * carried only when recorded — a step that never had one reads back without
 * one.
 */

let tmp: string
let canvasId = ''

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-run-args-'))
  /* the PGlite directory is resolved from process.cwd() when initDb runs */
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  canvasId = `c-${Math.random().toString(36).slice(2, 10)}`
})

function toolStep(args?: string): RunEvent {
  return record({
    canvasId,
    runId: 'run-1',
    agentName: 'Doop Agent',
    kind: 'tool',
    name: 'set_frame_html',
    ok: true,
    ms: 12,
    summary: 'set_frame_html',
    ...(args !== undefined ? { args } : {}),
  })
}

/** A recorded step's row as stored. The mirror write is fire-and-forget — the
 *  ring above already holds the event — so this waits for the insert to land
 *  rather than assuming it has. */
async function storedRow(id: string) {
  const [row] = await vi.waitFor(
    async () => {
      const rows = await db.select().from(runEvents).where(eq(runEvents.id, id))
      expect(rows).toHaveLength(1)
      return rows
    },
    { timeout: 5_000 },
  )
  if (!row) throw new Error(`no run_events row for ${id}`)
  return row
}

describe('a tool step carries its arguments', () => {
  it('reads the argument JSON back with the step, and stores the same string', async () => {
    const args = '{"frame_id":"f1","html":"<h1>hi</h1>"}'
    const step = toolStep(args)

    expect(getRunEvents(canvasId)[0]).toMatchObject({ id: step.id, name: 'set_frame_html', args })
    expect((await storedRow(step.id)).args).toBe(args)
  })

  it('cuts arguments over the cap to the leading bytes rather than dropping them', async () => {
    const args = JSON.stringify({ html: 'x'.repeat(4_000) })
    const step = toolStep(args)
    const stored = getRunEvents(canvasId)[0]?.args ?? ''

    expect(Buffer.byteLength(stored, 'utf8')).toBe(ARGS_CAP)
    expect(args.startsWith(stored)).toBe(true)
    expect((await storedRow(step.id)).args).toBe(stored)
  })

  it('never cuts a multi-byte character in half', async () => {
    const args = JSON.stringify({ label: '☃'.repeat(1_000) })
    const step = toolStep(args)
    const stored = getRunEvents(canvasId)[0]?.args ?? ''

    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(ARGS_CAP)
    expect(stored).not.toContain('\uFFFD')
    expect(stored).toBe(args.slice(0, stored.length))
    expect((await storedRow(step.id)).args).toBe(stored)
  })
})

describe('a step that is not a tool call has no arguments', () => {
  it('stores null for a status line, and none reaches the ring', async () => {
    const line = recordStatus(canvasId, 'run-1', 'Doop Agent', 'status', 'implementing attempt 2/3')

    expect(line.args).toBeUndefined()
    expect(getRunEvents(canvasId)[0]?.args).toBeUndefined()
    expect((await storedRow(line.id)).args).toBeNull()
  })

  it('drops arguments handed to a non-tool kind', async () => {
    const step = record({
      canvasId,
      runId: 'run-1',
      agentName: 'Doop Agent',
      kind: 'error',
      summary: 'judge reply was not valid JSON',
      args: '{"html":"never stored"}',
    })

    expect(getRunEvents(canvasId)[0]?.args).toBeUndefined()
    expect((await storedRow(step.id)).args).toBeNull()
  })
})

describe('a restart rebuilds the timeline from the table', () => {
  it('carries the stored arguments back into the ring through the boot hydrate', async () => {
    const args = JSON.stringify({ frame_id: 'f1', html: 'y'.repeat(3_000) })
    const step = toolStep(args)
    const ringArgs = getRunEvents(canvasId)[0]?.args
    await storedRow(step.id)

    /* the boot's read: persist maps the rows, index.ts hands the map to
       runLog.hydrate. The fresh module is what makes the restart real — the
       ring it had is gone, and only the table can fill it. */
    const rows = (await persist.hydrate()).runEvents.get(canvasId) ?? []
    expect(rows[0]).toMatchObject({ id: step.id, args: ringArgs })

    vi.resetModules()
    const restarted = await import('../server/runLog.ts')
    restarted.hydrate(new Map([[canvasId, rows]]))

    expect(restarted.getRunEvents(canvasId)[0]).toMatchObject({ id: step.id, args: ringArgs })
  })
})

describe("a step carries the run actor's identity", () => {
  it('reads a human actor and its agent id back with the step, and stores both', async () => {
    const step = record({
      canvasId,
      runId: 'run-1',
      agentName: 'Doop Agent',
      kind: 'tool',
      name: 'set_frame_html',
      ok: true,
      summary: 'set_frame_html',
      actorKind: 'human',
      agentId: 'agent-h1',
    })

    expect(getRunEvents(canvasId)[0]).toMatchObject({ id: step.id, actorKind: 'human', agentId: 'agent-h1' })
    const row = await storedRow(step.id)
    expect(row.actorKind).toBe('human')
    expect(row.agentId).toBe('agent-h1')
  })

  it('stamps a status line with the identity the design engine recorded it under', async () => {
    const line = recordStatus(canvasId, 'run-1', 'Doop Agent', 'status', 'implementing attempt 2/3', {
      actorKind: 'agent',
      agentId: 'agent-a2',
      actorOwner: 'someone@example.com',
    })

    expect(getRunEvents(canvasId)[0]).toMatchObject({
      id: line.id,
      actorKind: 'agent',
      agentId: 'agent-a2',
      actorOwner: 'someone@example.com',
    })
    const row = await storedRow(line.id)
    expect(row.actorKind).toBe('agent')
    expect(row.agentId).toBe('agent-a2')
  })

  it('rebuilds both through the boot hydrate', async () => {
    const step = record({
      canvasId,
      runId: 'run-1',
      agentName: 'Doop Agent',
      kind: 'tool',
      name: 'set_frame_html',
      summary: 'set_frame_html',
      actorKind: 'human',
      agentId: 'agent-h3',
    })
    await storedRow(step.id)

    const rows = (await persist.hydrate()).runEvents.get(canvasId) ?? []
    expect(rows[0]).toMatchObject({ id: step.id, actorKind: 'human', agentId: 'agent-h3' })

    vi.resetModules()
    const restarted = await import('../server/runLog.ts')
    restarted.hydrate(new Map([[canvasId, rows]]))

    expect(restarted.getRunEvents(canvasId)[0]).toMatchObject({ id: step.id, actorKind: 'human', agentId: 'agent-h3' })
  })

  it('fabricates neither field for a step recorded without them', async () => {
    const step = toolStep('{"a":1}')
    const ring = getRunEvents(canvasId)[0]!

    expect('actorKind' in ring).toBe(false)
    expect('agentId' in ring).toBe(false)

    const row = await storedRow(step.id)
    expect(row.actorKind).toBeNull()
    expect(row.agentId).toBeNull()
  })
})
