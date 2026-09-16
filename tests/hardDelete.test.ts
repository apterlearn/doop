import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDb, db, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { canvases, githubConnections, syncEdges, syncKeys, syncLinks } from '../server/db/schema.ts'
import { createSyncKey } from '../server/ingest.ts'
import { store } from '../server/store.ts'

/**
 * Purging a canvas takes its credentials with it. A design-sync key is a
 * write-only capability for one canvas and a GitHub connection is a repo import
 * source for one canvas; both are addressed by canvas id, so a canvas row that
 * goes without them strands a live secret no route can ever reach or revoke.
 *
 * The key's links and edges hang off the KEY id, not the canvas id, which is
 * why the purge chains sync_links -> sync_edges -> sync_keys instead of merely
 * listing them together: a subquery is evaluated when its own statement runs,
 * so the key row has to still be there for the two deletes that read it.
 *
 * The other half of the contract is what a purge is NOT. The ordinary delete
 * only sets deleted_at, and everything above — credentials included — survives
 * the trash window until the purge job really removes the canvas. All four
 * tables are read back through db.select(): these are facts about stored rows,
 * not about which functions were called.
 */

const OWNER = 'purge-owner'

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-hard-delete-'))
  /* the PGlite directory is resolved from process.cwd() when initDb runs */
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

/* the temp PGlite directory goes either way; this is so no case counts rows an
   earlier one left behind */
afterEach(async () => {
  await db.delete(syncLinks)
  await db.delete(syncEdges)
  await db.delete(syncKeys)
  await db.delete(githubConnections)
  await db.delete(canvases)
})

/** The credentials a canvas can strand: a sync key with one declared link and
 *  one recorded edge, plus a GitHub connection.
 *
 *  github.ts createConnection is not usable here — it verifies the repo against
 *  api.github.com before writing (and in installation mode mints an app token
 *  first), so it needs network. The row it would have written is inserted
 *  directly instead: same shape, same credential, same canvas id. */
async function seedCredentials(canvasId: string, name: string): Promise<string> {
  const key = await createSyncKey(canvasId, name, OWNER)
  await db.insert(syncLinks).values({
    keyId: key.id,
    page: '/',
    toPage: '/pricing',
    x: 12,
    y: 40,
    width: 160,
    height: 36,
    label: 'Pricing',
  })
  await db.insert(syncEdges).values({ keyId: key.id, fromPage: '/', toPage: '/pricing', count: 2, lastAt: Date.now() })
  await db.insert(githubConnections).values({
    id: `conn-${Math.random().toString(36).slice(2, 10)}`,
    canvasId,
    repo: 'acme/storefront',
    branch: 'main',
    token: 'ghp_test',
    installationId: null,
    deployUrl: null,
    createdBy: OWNER,
    createdAt: Date.now(),
    lastSyncedAt: null,
  })
  return key.id
}

/** Every row a canvas could strand, read back by canvas id — except links and
 *  edges, which are keyed by the key ids the caller seeded. */
async function strandedRows(canvasId: string, keyIds: string[]) {
  const [keys, links, edges, connections, canvas] = await Promise.all([
    db.select().from(syncKeys).where(eq(syncKeys.canvasId, canvasId)),
    db.select().from(syncLinks).where(inArray(syncLinks.keyId, keyIds)),
    db.select().from(syncEdges).where(inArray(syncEdges.keyId, keyIds)),
    db.select().from(githubConnections).where(eq(githubConnections.canvasId, canvasId)),
    db.select().from(canvases).where(eq(canvases.id, canvasId)),
  ])
  return { keys, links, edges, connections, canvas }
}

/** The purge is fire-and-forget (persist swallows each statement), so rows go
 *  when the writes land, not when the call returns. Waiting on all five at once
 *  is also the assertion: a deletion that is missing leaves its rows forever
 *  and the wait fails on the count that is still non-zero. */
async function expectPurged(canvasId: string, keyIds: string[]) {
  await vi.waitFor(
    async () => {
      const left = await strandedRows(canvasId, keyIds)
      expect({
        keys: left.keys.length,
        links: left.links.length,
        edges: left.edges.length,
        connections: left.connections.length,
        canvas: left.canvas.length,
      }).toEqual({ keys: 0, links: 0, edges: 0, connections: 0, canvas: 0 })
    },
    { timeout: 5000 },
  )
}

describe('purging a canvas takes its credentials with it', () => {
  it('deletes the sync key, its link and edge, and the GitHub connection', async () => {
    /* a canvas the way the app makes one: the store writes the row through */
    const canvasId = store.createCanvas('Purged', OWNER).id
    const keyId = await seedCredentials(canvasId, 'Storefront')

    /* seeded first, so "gone" below means deleted rather than never written */
    const before = await strandedRows(canvasId, [keyId])
    expect(before.keys.map((k) => k.id)).toEqual([keyId])
    expect(before.links).toHaveLength(1)
    expect(before.edges).toHaveLength(1)
    expect(before.connections).toHaveLength(1)
    expect(before.canvas).toHaveLength(1)

    persist.hardDeleteCanvas(canvasId)
    await expectPurged(canvasId, [keyId])

    /* the secret itself is what leaked: nothing left to authenticate an ingest
       with, and nothing left pointing at the canvas that is gone */
    const secret = before.keys[0]!.secret
    expect(await db.select().from(syncKeys).where(eq(syncKeys.secret, secret))).toHaveLength(0)
  })

  it('scopes the key subqueries to the canvas being purged', async () => {
    const doomed = store.createCanvas('Doomed', OWNER).id
    const kept = store.createCanvas('Kept', OWNER).id
    const firstKey = await seedCredentials(doomed, 'App one')
    const secondKey = await seedCredentials(doomed, 'App two')
    const survivorKey = await seedCredentials(kept, 'Another canvas')

    persist.hardDeleteCanvas(doomed)
    await expectPurged(doomed, [firstKey, secondKey])

    /* deleting one canvas cannot take another canvas's credentials with it: the
       subqueries read sync_keys by canvas id, so this key is never in scope */
    const other = await strandedRows(kept, [survivorKey])
    expect(other.keys.map((k) => k.id)).toEqual([survivorKey])
    expect(other.links).toHaveLength(1)
    expect(other.edges).toHaveLength(1)
    expect(other.connections).toHaveLength(1)
    expect(other.canvas).toHaveLength(1)
  })
})

describe('trash is not purge', () => {
  it('keeps the credentials while the canvas is only trashed', async () => {
    const canvasId = store.createCanvas('Trashed', OWNER).id
    const keyId = await seedCredentials(canvasId, 'Trash window')

    /* the app's delete: the row stays and gets a flag — the purge job is what
       removes it later, which is the whole reason the cascade exists */
    store.deleteCanvas(canvasId)
    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(canvases).where(eq(canvases.id, canvasId))
        expect(row?.deletedAt).toEqual(expect.any(Number))
      },
      { timeout: 5000 },
    )

    /* still there, credential included: a trashed canvas is restorable, and a
       restore that came back without its sync key or its repo connection would
       be a half-restored canvas */
    const trashed = await strandedRows(canvasId, [keyId])
    expect(trashed.keys.map((k) => k.id)).toEqual([keyId])
    expect(trashed.links).toHaveLength(1)
    expect(trashed.edges).toHaveLength(1)
    expect(trashed.connections).toHaveLength(1)

    persist.hardDeleteCanvas(canvasId)
    await expectPurged(canvasId, [keyId])
  })

  it('keeps the credentials when a trashed canvas is restored', async () => {
    const canvasId = store.createCanvas('Restored', OWNER).id
    const keyId = await seedCredentials(canvasId, 'Restored app')

    store.deleteCanvas(canvasId)
    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(canvases).where(eq(canvases.id, canvasId))
        expect(row?.deletedAt).toEqual(expect.any(Number))
      },
      { timeout: 5000 },
    )

    /* the flag is the only thing a restore touches — restoreCanvasRow clears
       deleted_at and the credential rows were never in its way */
    store.restoreCanvas(canvasId)
    await vi.waitFor(
      async () => {
        const [row] = await db.select().from(canvases).where(eq(canvases.id, canvasId))
        expect(row?.deletedAt).toBeNull()
      },
      { timeout: 5000 },
    )

    const restored = await strandedRows(canvasId, [keyId])
    expect(restored.keys.map((k) => k.id)).toEqual([keyId])
    expect(restored.links).toHaveLength(1)
    expect(restored.edges).toHaveLength(1)
    expect(restored.connections).toHaveLength(1)
  })
})
