import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as persist from '../server/db/persist.ts'
import { sendMail } from '../server/mailer.ts'
import { notifyAgentEvent } from '../server/notifications.ts'
import { store } from '../server/store.ts'
import type { NotificationPrefs } from '../server/db/persist.ts'
import type { Canvas } from '../shared/types.ts'

/* The one agent event with no in-app surface of its own: a run a human stopped
   is invisible to everyone who was not watching the canvas when it happened,
   which is exactly what the mail channel is for. The producer runs for real
   here — the store, the recipient list and the mail body all are — with only
   its two edges mocked: the mailer, which would reach SMTP, and the persisted
   reads, which would reach Postgres. */

/* mailerConfigured gates the whole channel and is read per call rather than
   captured at import, so the mock exposes it as a live getter: a case can turn
   SMTP on and off between calls. */
const mailer = vi.hoisted(() => ({ configured: true }))

vi.mock('../server/mailer.ts', () => ({
  get mailerConfigured() {
    return mailer.configured
  },
  sendMail: vi.fn(),
}))

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  /* the real persist surface, with only what this producer reads overridden
     and the writes it would trigger stubbed: the store is real, Postgres is
     not, so a canvas created here never leaves a row behind */
  const actual = (await importOriginal()) as typeof persist
  return {
    ...actual,
    saveCanvas: () => {},
    savePage: () => {},
    saveMember: () => {},
    getNotificationPrefs: vi.fn(async () => new Map<string, NotificationPrefs>()),
    getUserEmail: vi.fn(async () => undefined),
  }
})

const sendMailMock = vi.mocked(sendMail)

const OWNER_ID = 'notify-owner'
const MEMBER_ID = 'notify-member'
const OWNER_EMAIL = 'owner@example.com'
const MEMBER_EMAIL = 'member@example.com'
const SUBJECT = 'Checkout flow stopped mid-run'

/** Every switch off; a case turns on only the one it is about. */
function prefs(on: Partial<NotificationPrefs> = {}): NotificationPrefs {
  return { agentEmail: false, agentFinishEmail: false, agentFailEmail: false, ...on }
}

/** A canvas in the real store: the owner, and one collaborator who is a member
 *  rather than the owner, so both halves of the recipient list are exercised. */
function seedCanvas(): Canvas {
  const canvas = store.createCanvas('Checkout flow', OWNER_ID)
  store.addMember(canvas.id, MEMBER_ID, 'Owner')
  return canvas
}

/** The stored switches and addresses the producer reads. A user the map does
 *  not name has no prefs row at all, which is the opt-out. */
function seedStorage(byUser: Map<string, NotificationPrefs>): void {
  vi.mocked(persist.getNotificationPrefs).mockResolvedValue(byUser)
  vi.mocked(persist.getUserEmail).mockImplementation(async (userId) =>
    userId === OWNER_ID ? OWNER_EMAIL : userId === MEMBER_ID ? MEMBER_EMAIL : undefined,
  )
}

beforeEach(() => {
  /* the module mocks outlive the test, so their counters are cleared by hand */
  sendMailMock.mockClear()
  mailer.configured = true
})

describe('stop-run notifications', () => {
  it('mails the opted-in owner once when a human stops a run', async () => {
    const canvas = seedCanvas()
    seedStorage(new Map([[OWNER_ID, prefs({ agentFailEmail: true })]]))
    // the member has no prefs row: absence is the opt-out, not a missing check

    await notifyAgentEvent(canvas.id, 'stop', SUBJECT)

    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const [mail] = sendMailMock.mock.calls[0]!
    expect(mail.to).toBe(OWNER_EMAIL)
    expect(mail.subject).toBe(`[doop] ${SUBJECT}`)
    expect(mail.text).toContain(canvas.name)
  })

  it('mails nobody when the switches are off', async () => {
    const canvas = seedCanvas()
    seedStorage(
      new Map([
        [OWNER_ID, prefs()],
        [MEMBER_ID, prefs()],
      ]),
    )

    await notifyAgentEvent(canvas.id, 'stop', SUBJECT)

    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('says a stopped run was stopped, on the switch a stop already uses', async () => {
    const canvas = seedCanvas()
    /* the two switches live on different people again: a stopped run routed to
       the finish switch would reach the member, and a new preference column
       would reach nobody */
    seedStorage(
      new Map([
        [OWNER_ID, prefs({ agentFailEmail: true })],
        [MEMBER_ID, prefs({ agentFinishEmail: true })],
      ]),
    )
    const subject = 'Claude stopped the design run for “Hero”'

    await notifyAgentEvent(canvas.id, 'stop', subject, { phase: 'stopped' })

    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const [mail] = sendMailMock.mock.calls[0]!
    expect(mail.to).toBe(OWNER_EMAIL)
    expect(mail.subject).toBe(`[doop] ${subject}`)
    /* the sentence reads as the human's stop, not as a design that broke */
    expect(mail.text).toContain('was stopped')
    expect(mail.text).not.toContain('failed')
  })

  it('lets an explicit run end outrank the kind that carried it', async () => {
    const canvas = seedCanvas()
    /* the two switches live on different people, so which one was read is
       visible in who got the mail — a stop alone would reach the member */
    seedStorage(
      new Map([
        [OWNER_ID, prefs({ agentFinishEmail: true })],
        [MEMBER_ID, prefs({ agentFailEmail: true })],
      ]),
    )

    await notifyAgentEvent(canvas.id, 'stop', SUBJECT, { phase: 'finished' })
    expect(sendMailMock.mock.calls.map(([mail]) => mail.to)).toEqual([OWNER_EMAIL])

    sendMailMock.mockClear()
    await notifyAgentEvent(canvas.id, 'stop', SUBJECT, { phase: 'failed' })
    expect(sendMailMock.mock.calls.map(([mail]) => mail.to)).toEqual([MEMBER_EMAIL])
  })

  it('sends nothing without SMTP, and says so in the log', async () => {
    const canvas = seedCanvas()
    mailer.configured = false
    seedStorage(new Map([[OWNER_ID, prefs({ agentFailEmail: true })]]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await notifyAgentEvent(canvas.id, 'stop', SUBJECT)

    expect(sendMailMock).not.toHaveBeenCalled()
    expect(log.mock.calls.flat().join('\n')).toContain('SMTP not configured')
    log.mockRestore()
  })
})
