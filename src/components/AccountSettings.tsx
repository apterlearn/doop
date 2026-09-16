import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth'
import { api, type NotificationPrefs } from '../lib/api'
import { posthog } from '../lib/posthog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Note } from './ui/note'
import { CheckboxCard } from './ui/checkbox'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'

/* settings fields are a fixed column on desktop and full width on a phone */
const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'
const settingsInput = 'w-full sm:w-[280px]'

/** The "Your account" pane of /settings: who you are on a canvas, and how you
 *  get back into one. Everything here is better-auth's own account surface —
 *  no endpoints of ours. */
export function AccountSettings() {
  const { data: session } = authClient.useSession()
  const user = session?.user

  /* null while untouched, so the field tracks the session until you type */
  const [draft, setDraft] = useState<string | null>(null)
  const name = draft ?? user?.name ?? ''
  const dirty = name.trim().length > 0 && name.trim() !== (user?.name ?? '')

  const [savingName, setSavingName] = useState(false)
  const [nameNote, setNameNote] = useState('')
  const [nameError, setNameError] = useState('')

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [savingPw, setSavingPw] = useState(false)

  const [pwNote, setPwNote] = useState('')
  const [pwError, setPwError] = useState('')

  /* agent-event email is opt-in per account and per kind: being blocked on a
     question, a run finishing and a run failing are different reasons to be
     interrupted, so each has its own switch */
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null)
  useEffect(() => {
    api.notifications().then(setPrefs).catch(console.error)
  }, [])

  function setPref(key: keyof NotificationPrefs, next: boolean) {
    const was = prefs
    if (!was) return
    setPrefs({ ...was, [key]: next }) // optimistic; a refused save rolls back below
    api
      .setNotifications({ [key]: next })
      .then((saved) => {
        setPrefs(saved)
        if (next) posthog.capture(`agent_email_enabled_${key}`)
      })
      .catch((err) => {
        console.error(err)
        setPrefs(was)
      })
  }

  const [verifyNote, setVerifyNote] = useState('')

  async function saveName() {
    setSavingName(true)
    setNameNote('')
    setNameError('')
    const { error } = await authClient.updateUser({ name: name.trim() })
    setSavingName(false)
    if (error) return setNameError(error.message || 'That name could not be saved')
    posthog.capture('account_name_changed')
    setDraft(null)
    setNameNote('Saved — agents pick it up within a minute')
  }

  async function savePassword() {
    setSavingPw(true)
    setPwNote('')
    setPwError('')
    /* revoking is the point: a password change you make because you fear a
       device is compromised is useless if that device stays signed in */
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    })
    setSavingPw(false)
    if (error) return setPwError(error.message || 'That password could not be changed')
    posthog.capture('account_password_changed')
    setCurrent('')
    setNext('')
    setPwNote('Password updated — every other session was signed out')
  }

  async function resendVerification() {
    if (!user?.email) return
    setVerifyNote('')
    const { error } = await authClient.sendVerificationEmail({ email: user.email })
    setVerifyNote(error ? error.message || 'That email could not be sent' : 'Verification email sent')
  }

  return (
    <>
      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Your name is the identity shown on cursors, in the activity feed, and on everything you leave for an agent.
            Agents see the change within a minute.
          </CardDescription>
        </CardHeader>

        <CardRow
          label="Name"
          action={
            <Button size="sm" disabled={!dirty || savingName} onClick={saveName}>
              {savingName ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <Input
            className={settingsInput}
            value={name}
            onChange={(e) => {
              setDraft(e.target.value)
              setNameNote('')
              setNameError('')
            }}
            maxLength={60}
            aria-label="Display name"
          />
          {nameError ? (
            <Note tone="error">{nameError}</Note>
          ) : nameNote ? (
            <Note tone="success">{nameNote}</Note>
          ) : dirty ? (
            <Note>Changed — not saved yet</Note>
          ) : null}
        </CardRow>

        <CardRow
          label="Email"
          action={
            user?.emailVerified ? (
              <Note>Sign-in address — not changeable yet</Note>
            ) : (
              <Button size="sm" onClick={resendVerification}>
                Resend verification
              </Button>
            )
          }
        >
          <span className="min-w-0 font-mono text-[13px] [overflow-wrap:anywhere]">{user?.email}</span>
          {user?.emailVerified ? (
            <Badge className="border-[#3f9c52]/35 bg-[#3f9c52]/10 text-[10.5px] text-[#2f7a3f]">verified</Badge>
          ) : (
            <Badge className="text-[10.5px]">unverified</Badge>
          )}
          {verifyNote && <Note tone="success">{verifyNote}</Note>}
        </CardRow>
      </Card>

      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Changing it signs out every other browser and device — this one stays signed in.
          </CardDescription>
        </CardHeader>
        <CardRow label="Current password">
          <Input
            className={settingsInput}
            type="password"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              setPwError('')
            }}
            autoComplete="current-password"
            aria-label="Current password"
          />
        </CardRow>
        <CardRow
          label="New password"
          action={
            <Button size="sm" disabled={savingPw || !current || next.length < 8} onClick={savePassword}>
              {savingPw ? 'Updating…' : 'Update password'}
            </Button>
          }
        >
          <Input
            className={settingsInput}
            type="password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
              setPwError('')
            }}
            autoComplete="new-password"
            aria-label="New password"
          />
          {pwError ? (
            <Note tone="error">{pwError}</Note>
          ) : pwNote ? (
            <Note tone="success">{pwNote}</Note>
          ) : (
            <Note>At least 8 characters</Note>
          )}
        </CardRow>
      </Card>

      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Agents</CardTitle>
          <CardDescription>
            How you hear about the work agents do on your canvases — finishing, failing short, or stopping to ask you
            something.
          </CardDescription>
        </CardHeader>
        {prefs === null ? null : (
          <>
            <CheckboxCard
              checked={prefs.agentEmail}
              onChange={(next) => setPref('agentEmail', next)}
              title="An agent is waiting on a question"
              description="The one kind that genuinely blocks: an agent cannot finish until somebody answers. In-app toasts always show these regardless."
            />
            <CheckboxCard
              checked={prefs.agentFinishEmail}
              onChange={(next) => setPref('agentFinishEmail', next)}
              title="A run finished"
              description="One message when a design workflow stops designing — its verdict and a link back to the frames it produced."
            />
            <CheckboxCard
              checked={prefs.agentFailEmail}
              onChange={(next) => setPref('agentFailEmail', next)}
              title="A run failed or was stopped"
              description="Sent when a run ends without finishing: a tool error, a failed judge check, or someone pressing Stop."
            />
          </>
        )}
      </Card>
    </>
  )
}
