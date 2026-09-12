import { store } from './store.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import * as persist from './db/persist.ts'
import { PUBLIC_ORIGIN } from './auth.ts'

/**
 * Email opt-in for agent events. In-app toasts cover people already looking
 * at the canvas; this covers everyone else. Default is OFF for every user,
 * and the whole channel silently no-ops when SMTP is not configured — a
 * self-hosted instance without mail must not lose a card over it.
 */

export type AgentEventKind = 'completed' | 'failed' | 'question' | 'stopped'

const LABELS: Record<AgentEventKind, string> = {
  completed: 'finished a card',
  failed: 'needs your attention',
  question: 'is asking you a question',
  stopped: 'was stopped',
}

/** Fire-and-forget: a notification must never break the action it reports. */
export async function notifyAgentEvent(canvasId: string, kind: AgentEventKind, subject: string): Promise<void> {
  if (!mailerConfigured) return
  try {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return
    const prefs = await persist.getNotificationPrefs()
    const recipientIds = [canvas.ownerId, ...(canvas.memberIds ?? [])].filter((id): id is string => !!id)
    const recipients: string[] = []
    for (const userId of recipientIds) {
      if (!prefs.get(userId)) continue
      const user = await persist.getUserEmail(userId)
      if (user) recipients.push(user)
    }
    if (!recipients.length) return
    const link = `${PUBLIC_ORIGIN}/c/${canvasId}`
    const body = `${subject}\n\n${LABELS[kind]} on “${canvas.name}”.\nOpen: ${link}`
    for (const to of recipients) {
      await sendMail({ to, subject: `[doop] ${subject}`, text: body })
    }
  } catch (err) {
    console.error('[notifications] failed', err)
  }
}

export function setNotificationPref(userId: string, agentEmail: boolean): void {
  persist.saveNotificationPref(userId, agentEmail)
}

export async function getNotificationPref(userId: string): Promise<boolean> {
  const prefs = await persist.getNotificationPrefs()
  return prefs.get(userId) ?? false
}
