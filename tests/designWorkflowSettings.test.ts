import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDb, db, initDb } from '../server/db/index.ts'
import { designWorkflowSettings } from '../server/db/schema.ts'
import { getDesignWorkflowPrefs, setDesignWorkflowPrefs } from '../server/designWorkflowSettings.ts'

/**
 * Which models the design workflow runs on, per user: the stored pair, the
 * operator's env defaults behind it, and the upsert that writes the pair.
 * Checked against a real (temp) database.
 */

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-design-prefs-'))
  /* the PGlite directory is resolved from process.cwd() when initDb runs */
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await db.delete(designWorkflowSettings)
})

describe('the prefs a run reads', () => {
  it('falls back to the operator defaults when the user has picked nothing', async () => {
    vi.stubEnv('DOOP_IMPLEMENTER_MODEL', 'deepseek-v4.1-flash')
    vi.stubEnv('DOOP_JUDGE_MODEL', 'kimi-k3')
    const prefs = await getDesignWorkflowPrefs('u-1')
    expect(prefs).toMatchObject({ implementerModel: 'deepseek-v4.1-flash', judgeModel: 'kimi-k3' })
    expect(typeof prefs.configured).toBe('boolean')
  })

  it('resolves to empty ids when there is neither a row nor a default', async () => {
    vi.stubEnv('DOOP_IMPLEMENTER_MODEL', '')
    vi.stubEnv('DOOP_JUDGE_MODEL', '')
    expect(await getDesignWorkflowPrefs('u-1')).toMatchObject({ implementerModel: '', judgeModel: '' })
  })

  it('prefers the stored pair over the defaults, per user', async () => {
    vi.stubEnv('DOOP_IMPLEMENTER_MODEL', 'env-implementer')
    vi.stubEnv('DOOP_JUDGE_MODEL', 'env-judge')
    await db
      .insert(designWorkflowSettings)
      .values({ userId: 'u-1', implementerModel: 'stored-a', judgeModel: 'stored-b', updatedAt: Date.now() })

    const stored = await getDesignWorkflowPrefs('u-1')
    expect(stored).toMatchObject({ implementerModel: 'stored-a', judgeModel: 'stored-b' })
    /* the row is this user's, not the server's */
    const other = await getDesignWorkflowPrefs('u-2')
    expect(other).toMatchObject({ implementerModel: 'env-implementer', judgeModel: 'env-judge' })
  })
})

describe('saving the pair', () => {
  it('upserts, the last write winning, and returns what a run would read', async () => {
    vi.stubEnv('DOOP_IMPLEMENTER_MODEL', 'env-implementer')
    vi.stubEnv('DOOP_JUDGE_MODEL', 'env-judge')
    /* the saved-at stamp comes from Date.now(), so drive it instead of waiting */
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    const first = await setDesignWorkflowPrefs('u-1', { implementerModel: ' a-one ', judgeModel: ' j-one ' })
    expect(first).toMatchObject({ implementerModel: 'a-one', judgeModel: 'j-one' })
    expect(await db.select().from(designWorkflowSettings)).toMatchObject([
      { userId: 'u-1', implementerModel: 'a-one', judgeModel: 'j-one', updatedAt: 1_700_000_000_000 },
    ])

    clock.mockReturnValue(1_700_000_060_000)
    const second = await setDesignWorkflowPrefs('u-1', { implementerModel: 'a-two', judgeModel: 'j-two' })
    expect(second).toMatchObject({ implementerModel: 'a-two', judgeModel: 'j-two' })
    /* one row, updated in place — not a second one */
    expect(await db.select().from(designWorkflowSettings)).toMatchObject([
      { userId: 'u-1', implementerModel: 'a-two', judgeModel: 'j-two', updatedAt: 1_700_000_060_000 },
    ])
    expect(await getDesignWorkflowPrefs('u-1')).toMatchObject({ implementerModel: 'a-two', judgeModel: 'j-two' })
    clock.mockRestore()
  })

  it('rejects an empty or whitespace-only id, writing nothing', async () => {
    const message = 'both an implementer and a judge model are required'
    const noImplementer = { implementerModel: '  ', judgeModel: 'kimi-k3' }
    const noJudge = { implementerModel: 'deepseek-v4.1-flash', judgeModel: '' }
    await expect(setDesignWorkflowPrefs('u-1', noImplementer)).rejects.toThrow(message)
    await expect(setDesignWorkflowPrefs('u-1', noJudge)).rejects.toThrow(message)
    expect(await db.select().from(designWorkflowSettings)).toHaveLength(0)
  })
})
