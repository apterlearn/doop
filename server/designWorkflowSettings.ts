import { eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { designWorkflowSettings } from './db/schema.ts'
import { designLlmConfigured } from './designLlm.ts'

/**
 * Which model plays which part in the design workflow: an implementer that
 * writes a frame from a brief, a judge that critiques it. The ids are picked
 * from the operator's provider, so they are per user; the provider itself
 * (base URL + key) is server env, which is why `configured` rides along —
 * with no endpoint there is nothing to run and no list to pick from.
 */
export interface DesignWorkflowPrefs {
  implementerModel: string
  judgeModel: string
  configured: boolean
}

/** The user's own pair, falling back to the operator's defaults, then to the
 *  empty string the Settings card reads as "nothing picked yet". */
export async function getDesignWorkflowPrefs(userId: string): Promise<DesignWorkflowPrefs> {
  const [row] = await db.select().from(designWorkflowSettings).where(eq(designWorkflowSettings.userId, userId))
  return {
    implementerModel: row?.implementerModel?.trim() || process.env.DOOP_IMPLEMENTER_MODEL?.trim() || '',
    judgeModel: row?.judgeModel?.trim() || process.env.DOOP_JUDGE_MODEL?.trim() || '',
    configured: designLlmConfigured(),
  }
}

/** Save this user's pair. No catalogue check on the way in: the provider's
 *  model list is live, so an id that has since vanished fails at run time with
 *  the provider's own message rather than being rejected here. */
export async function setDesignWorkflowPrefs(
  userId: string,
  input: { implementerModel: string; judgeModel: string },
): Promise<DesignWorkflowPrefs> {
  const implementerModel = input.implementerModel.trim()
  const judgeModel = input.judgeModel.trim()
  if (!implementerModel || !judgeModel) throw new Error('both an implementer and a judge model are required')
  const updatedAt = Date.now()
  await db
    .insert(designWorkflowSettings)
    .values({ userId, implementerModel, judgeModel, updatedAt })
    .onConflictDoUpdate({
      target: designWorkflowSettings.userId,
      set: { implementerModel, judgeModel, updatedAt },
    })
  return getDesignWorkflowPrefs(userId)
}
