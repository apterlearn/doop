import { store } from './store.ts'
import { mailerConfigured, sendMail } from './mailer.ts'
import * as persist from './db/persist.ts'
import type { NotificationPrefs } from './db/persist.ts'
import { PUBLIC_ORIGIN } from './auth.ts'
import type { AgentEventKind } from '../shared/types.ts'

/**
 * Email opt-in for agent events. In-app toasts cover people already looking at
 * the canvas; this covers everyone else. Default is OFF for every user, and the
 * whole channel no-ops when SMTP is not configured (it logs the skip instead) —
 * a self-hosted instance without mail must not lose a question, a finished run
 * or a failed one over it.
 */

/** How a run ended. None of these is an `AgentEventKind` — nothing parks waiting
 *  for a run to be over — so a caller passes one alongside the event that
 *  carried it, while the kinds that ARE on the bus (`question`, `stop`) are
 *  read from the kind alone. A run a human stopped is an ending of its own: the
 *  engine reports the stop as a stop, and the mail has to say the same thing. */
export type NotificationPhase = 'finished' | 'failed' | 'stopped'

const RUN_END_LABELS: Record<NotificationPhase, string> = {
  finished: 'finished its run',
  failed: 'failed its run',
  /* the same words the bus's own `stop` label uses: one human's stop reads the
     same whether the REST route or the engine is reporting it */
  stopped: 'was stopped',
}

/** The bus kinds a human opted into being emailed about. Every other kind
 *  (comments, proposals, frame edits) is a toast and not a mail: they are
 *  either frequent or only useful to someone already looking at the canvas. */
const EVENT_LABELS: Partial<Record<AgentEventKind, string>> = {
  question: 'is asking you a question',
  /** a run ended because a human stopped it — worth the same mail as a
   *  failure, with the reason the human already knows */
  stop: 'was stopped',
}

/** Which of a user's switches covers an event: questions have their own,
 *  a finished run has its own, and everything else that ends a run — a failure,
 *  and a human's stop whether it arrives as the bare kind or as the run's own
 *  ending — shares the "something went wrong" one: a stop is the run not
 *  finishing, and the person who pressed it already knows why. */
function switchFor(kind: AgentEventKind, phase: NotificationPhase | undefined): keyof NotificationPrefs {
  if (phase === 'finished') return 'agentFinishEmail'
  /* a stopped run is not a finished one: it is the switch a stop has always
     used, so a stop does not need a preference of its own */
  if (phase === 'failed' || phase === 'stopped') return 'agentFailEmail'
  return kind === 'question' ? 'agentEmail' : 'agentFailEmail'
}

/** Fire-and-forget: a notification must never break the action it reports. */
export async function notifyAgentEvent(
  canvasId: string,
  kind: AgentEventKind,
  subject: string,
  opts: { phase?: NotificationPhase } = {},
): Promise<void> {
  /* an explicit run end outranks the kind it came with: "the run finished" is
     the more specific statement, even when a tool error is what ended it */
  const label = (opts.phase && RUN_END_LABELS[opts.phase]) || EVENT_LABELS[kind]
  if (!label) return
  if (!mailerConfigured) {
    console.log(`[notifications] SMTP not configured — not mailing a ${opts.phase ?? kind} event`)
    return
  }
  try {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return
    const wanted = switchFor(kind, opts.phase)
    /* one read for every recipient rather than one per recipient; a user with
       no row has every switch off, so the absence is the opt-out */
    const prefs = await persist.getNotificationPrefs()
    const recipientIds = [canvas.ownerId, ...(canvas.memberIds ?? [])].filter((id): id is string => !!id)
    const recipients: string[] = []
    for (const userId of recipientIds) {
      if (!prefs.get(userId)?.[wanted]) continue
      const user = await persist.getUserEmail(userId)
      if (user) recipients.push(user)
    }
    if (!recipients.length) return
    const link = `${PUBLIC_ORIGIN}/c/${canvasId}`
    const body = `${subject}\n\n${label} on “${canvas.name}”.\nOpen: ${link}`
    for (const to of recipients) {
      await sendMail({ to, subject: `[doop] ${subject}`, text: body })
    }
  } catch (err) {
    console.error('[notifications] failed', err)
  }
}

export function setNotificationPref(userId: string, prefs: Partial<NotificationPrefs>): void {
  persist.saveNotificationPref(userId, prefs)
}

/** Whether this user wants any agent mail at all — the settings panel's
 *  single answer, and false for a user who has never changed anything. */
export async function getNotificationPref(userId: string): Promise<boolean> {
  const prefs = (await persist.getNotificationPrefs()).get(userId)
  return !!prefs && (prefs.agentEmail || prefs.agentFinishEmail || prefs.agentFailEmail)
}
