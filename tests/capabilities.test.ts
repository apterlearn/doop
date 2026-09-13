import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { capabilities } from '../server/capabilities.ts'
import { closeDb, db, initDb } from '../server/db/index.ts'
import { githubConnections } from '../server/db/schema.ts'
import { IMPORTS_PER_MIN, RENDERS_PER_MIN, SEARCHES_PER_MIN, UPLOADS_PER_MIN } from '../server/limits.ts'

/**
 * What get_capabilities tells an agent has to be what the server enforces.
 * The rate limits live in one module and are reported from there; the GitHub
 * mode is read from the connections table instead of being assumed. Both are
 * checked against a real (temp) database.
 */

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-caps-'))
  /* the PGlite directory is resolved from process.cwd() when initDb runs */
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

type ConnectionRow = typeof githubConnections.$inferInsert

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: `conn-${Math.random().toString(36).slice(2, 10)}`,
    canvasId: 'c-caps',
    repo: 'acme/app',
    branch: 'main',
    token: 'ghp_x',
    installationId: null,
    deployUrl: null,
    createdBy: 'owner',
    createdAt: Date.now(),
    lastSyncedAt: null,
    ...overrides,
  }
}

describe('capabilities reports the enforced limits', () => {
  it('reports the same rate limits the MCP surface enforces', async () => {
    const caps = await capabilities()
    expect(caps.limits).toMatchObject({
      renders_per_min: RENDERS_PER_MIN,
      searches_per_min: SEARCHES_PER_MIN,
      uploads_per_min: UPLOADS_PER_MIN,
      imports_per_min: IMPORTS_PER_MIN,
    })
  })
})

describe('capabilities reports the GitHub surface that exists', () => {
  it('is "none" with no connection, "pat" with a token, "app" with an installation', async () => {
    expect((await capabilities()).github).toBe('none')

    await db.insert(githubConnections).values(connection({ canvasId: 'c-other', token: 'ghp_y' }))
    /* a connection on any canvas makes the surface live: the tool answers
       "is GitHub configured here", not "is it configured for this canvas" */
    expect((await capabilities()).github).toBe('pat')

    await db
      .insert(githubConnections)
      .values(connection({ canvasId: 'c-other', repo: 'acme/other', installationId: '12345', token: null }))
    expect((await capabilities()).github).toBe('app')

    await db.delete(githubConnections)
    expect((await capabilities()).github).toBe('none')
  })
})
