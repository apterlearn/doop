import { useEffect, useState } from 'react'

import { api, ApiError, type CanvasRole } from '../lib/api'
import { Button } from './ui/button'
import { Note } from './ui/note'
import { AuthScreen } from './ui/screen'
import { Skeleton } from './ui/skeleton'
import { Wordmark } from './ui/wordmark'

/** What an invitation token resolves to — the payload `api.getInvite` answers
 *  with, named here because the contract types it inline. */
interface Invitation {
  canvasId: string
  canvasName: string
  role: CanvasRole
  email: string
}

/** What each role actually lets the visitor do — the decision the invitation
 *  is asking them to make. */
const ROLE_BLURBS: Record<CanvasRole, string> = {
  viewer: 'You can open the canvas and look around, but not change anything.',
  commenter: 'You can open the canvas and leave comments, but not change the design.',
  editor: 'You can edit the canvas along with everyone else on it.',
  admin: 'You can edit the canvas and manage who else can open it.',
}

/** One answer for one token: the invitation, or why there is none — and, when
 *  accepting was refused, both. */
interface InviteAnswer {
  token: string
  invitation?: Invitation
  failure?: string
}

/* The screen an invitation link lands on. A signed-out visitor never reaches
   it: the app shell keeps this URL while it shows the sign-in form, and comes
   back here once there is a session — so this only ever runs as somebody, and
   accepting is one POST away from the canvas. */
export function InviteAccept({ token }: { token: string }) {
  /* Keying the answer by token means a card that outlives its token reads as
     still loading, without resetting state from inside the effect. */
  const [answer, setAnswer] = useState<InviteAnswer>({ token })
  const [accepting, setAccepting] = useState(false)
  const settled: InviteAnswer = answer.token === token ? answer : { token }

  useEffect(() => {
    let active = true
    api.getInvite(token).then(
      (invitation) => active && setAnswer({ token, invitation }),
      (caught) =>
        active &&
        setAnswer({
          token,
          failure:
            caught instanceof ApiError && caught.status === 404
              ? 'This invitation link has expired, or it was revoked.'
              : 'We couldn’t read this invitation. The link may be incomplete.',
        }),
    )
    return () => {
      active = false
    }
  }, [token])

  async function accept() {
    if (!settled.invitation || accepting) return
    setAccepting(true)
    try {
      const { canvasId } = await api.acceptInvite(token)
      /* a full load rather than an in-app route change: the canvas has to come
         up holding the membership this call just created */
      location.assign('/c/' + canvasId)
    } catch (caught) {
      setAnswer((current) => ({
        ...current,
        failure:
          caught instanceof ApiError && caught.status === 404
            ? 'This invitation link has expired, or it was revoked.'
            : 'We couldn’t accept this invitation. Open the link again and retry.',
      }))
      setAccepting(false)
    }
  }

  return (
    <AuthScreen>
      <div className="flex w-[min(400px,100%)] flex-col gap-3.5 rounded-[12px] border border-line bg-surface p-6 pt-[30px] shadow-pop sm:p-9 sm:pb-7">
        <Wordmark className="mb-1.5" />
        {settled.invitation ? (
          <>
            <h1 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em]">Join the canvas.</h1>
            <p className="text-[14px] leading-[1.5] text-ink-soft">
              You’ve been invited to <b className="font-semibold text-ink">{settled.invitation.canvasName}</b> as{' '}
              <b className="font-semibold text-ink">{settled.invitation.role}</b>.
            </p>
            <p className="text-[13px] leading-[1.5] text-ink-soft">{ROLE_BLURBS[settled.invitation.role]}</p>
            <Note size="sm">The invitation is for {settled.invitation.email}.</Note>
            {settled.failure && (
              <Note tone="error" size="sm">
                {settled.failure}
              </Note>
            )}
            <Button variant="primary" size="lg" block disabled={accepting} onClick={accept}>
              {accepting ? 'Accepting…' : 'Accept invitation'}
            </Button>
          </>
        ) : settled.failure ? (
          <>
            <h1 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em]">
              That link doesn’t work.
            </h1>
            <p className="text-[14px] leading-[1.5] text-ink-soft">{settled.failure}</p>
            <Note size="sm">Ask whoever invited you to send a fresh one.</Note>
            <Button asChild variant="primary" size="lg" block>
              <a href="/">Go to doop</a>
            </Button>
          </>
        ) : (
          <>
            <h1 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em]">One moment.</h1>
            <p className="text-[14px] leading-[1.5] text-ink-soft">Reading your invitation…</p>
            <Skeleton className="h-11 w-full" />
          </>
        )}
      </div>
    </AuthScreen>
  )
}
