import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type AccountSession } from '../lib/api'
import { authClient } from '../lib/auth'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { ConfirmDialog } from './ui/alert-dialog'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'

/* settings fields are a fixed column on desktop and full width on a phone */
const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'

/* A session record's only description of a device is its user agent string,
   and the raw one is unreadable in a row. These two readers pull out the
   browser and the platform a person would recognise; an unparseable string
   says nothing rather than guessing. Order matters: Edge and Opera both carry
   "Chrome", and Chrome carries "Safari". */
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

function describeAgent(ua?: string): { browser: string | null; os: string | null } {
  if (!ua) return { browser: null, os: null }
  /* iOS before macOS: iPadOS reports itself as a Mac */
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  return { browser: BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null, os }
}

/** "iPhone on Safari", or "" when the user agent told us nothing. */
function describeDevice(ua?: string): string {
  const { browser, os } = describeAgent(ua)
  return [browser, os].filter(Boolean).join(' on ')
}

/**
 * The account's security surface: every browser and device signed in as you
 * — revocable one at a time, or all at once — a copy of your data, and the
 * way out of the account entirely.
 *
 * Sessions come from our own /api/account/sessions (which wraps better-auth's
 * own store), so this page never talks to better-auth directly for them.
 * Deletion is guarded by typing the account's own email: there is no undo and
 * no grace period, and one button is not enough to mean it.
 */
export function AccountSecurity() {
  const { data: session } = authClient.useSession()
  const email = session?.user?.email ?? ''
  const [sessions, setSessions] = useState<AccountSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<AccountSession | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [typed, setTyped] = useState('')
  const [mismatch, setMismatch] = useState(false)
  /* Radix's confirm action closes the dialog as it fires. A confirm whose
     email does not match asks to be kept open instead — Escape and an
     outside click never set this, so they always close. */
  const confirming = useRef(false)
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase()

  useEffect(() => {
    api
      .listSessions()
      .then(setSessions)
      .catch((err: unknown) => setError(err instanceof ApiError ? String(err.body.error ?? err.message) : String(err)))
  }, [])

  /* The revoked row is dropped locally rather than refetched: the server has
     already answered, and a refetch would blank the list for a moment. Signing
     out everywhere else deliberately keeps THIS row — it survives. */
  async function revoke(target: AccountSession) {
    setBusy(target.id)
    setError(null)
    try {
      await api.revokeSession(target.id)
      setSessions((list) => list?.filter((s) => s.id !== target.id) ?? list)
    } catch (err) {
      setError(err instanceof ApiError ? String(err.body.error ?? err.message) : String(err))
    } finally {
      setBusy(null)
      setRevoking(null)
    }
  }

  async function revokeOthers() {
    setBusy('others')
    setError(null)
    setNote(null)
    try {
      await api.revokeOtherSessions()
      setSessions((list) => list?.filter((s) => s.current) ?? list)
      setNote('Every other browser and device was signed out. This one is still signed in.')
    } catch (err) {
      setError(err instanceof ApiError ? String(err.body.error ?? err.message) : String(err))
    } finally {
      setBusy(null)
    }
  }

  async function deleteAccount() {
    if (!matches) {
      setMismatch(true)
      return
    }
    setBusy('delete')
    setError(null)
    try {
      await api.deleteAccount()
      /* the session that asked is gone with the account, so there is nothing
         left to render here — leave for the front door */
      location.assign('/')
    } catch (err) {
      setError(err instanceof ApiError ? String(err.body.error ?? err.message) : String(err))
      setBusy(null)
    }
  }

  return (
    <>
      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Every browser and device signed in as {email}. One you do not recognise is somebody else using your account
            — sign it out, then change your password.
          </CardDescription>
        </CardHeader>
        {sessions === null ? (
          <div className="px-4 py-4 sm:px-[22px]">
            {error ? <Note tone="error">Couldn’t list your devices — {error}</Note> : <Note>Loading devices…</Note>}
          </div>
        ) : (
          sessions.map((s) => (
            <CardRow
              key={s.id}
              label={s.current ? 'This device' : 'Device'}
              action={
                s.current ? (
                  /* the server refuses it, and refusing it here is the honest
                     version of the same rule: revoking the session you are
                     reading this page with is just signing yourself out */
                  <Note>Sign out from the menu to end this one</Note>
                ) : (
                  <Button size="sm" disabled={busy === s.id} onClick={() => setRevoking(s)}>
                    {busy === s.id ? 'Signing out…' : 'Revoke'}
                  </Button>
                )
              }
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink">
                  {describeDevice(s.userAgent) || 'Unrecognised browser'}
                  {s.current && <Badge>current</Badge>}
                </span>
                <Note>
                  {s.ipAddress ? `${s.ipAddress} · ` : ''}signed in {timeAgo(s.createdAt)} · expires in{' '}
                  {timeAgo(s.expiresAt).replace(' ago', '')}
                </Note>
              </span>
            </CardRow>
          ))
        )}
        <CardRow
          label="All other devices"
          action={
            <Button size="sm" disabled={busy === 'others' || sessions?.length === 1} onClick={revokeOthers}>
              {busy === 'others' ? 'Signing out…' : 'Sign out everywhere else'}
            </Button>
          }
        >
          <Note>Ends every session but this one. Use it when a laptop was lost or a device was borrowed.</Note>
        </CardRow>
        {(note || (error && sessions !== null)) && (
          <div className="border-t border-line-soft px-4 py-3 sm:px-[22px]">
            {note && <Note tone="success">{note}</Note>}
            {error && sessions !== null && <Note tone="error">{error}</Note>}
          </div>
        )}
      </Card>

      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Your data</CardTitle>
          <CardDescription>
            A zip of everything you own here: every canvas you own, its pages and frames as HTML, and their assets. It
            is the same archive a self-hoster can import into another instance.
          </CardDescription>
        </CardHeader>
        <CardRow
          label="Export"
          action={
            <Button size="sm" onClick={() => location.assign('/api/account/export')}>
              Export my data
            </Button>
          }
        >
          <Note>An authenticated download — the browser saves the zip as soon as the server finishes building it.</Note>
        </CardRow>
      </Card>

      <Card className={settingsCard}>
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            Deleting your account removes the canvases you own, your sessions on every device, your connected agents and
            the memory they built. It cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardRow
          label="Delete account"
          action={
            <Button variant="danger-solid" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete my account
            </Button>
          }
        >
          <Note tone="error">Everything you own here goes with it. Export first if you might want it back.</Note>
        </CardRow>
      </Card>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Sign this device out?"
        description={
          revoking
            ? `${describeDevice(revoking.userAgent) || 'This device'} will have to sign in again, and any canvas it is showing will stop loading.`
            : undefined
        }
        confirmLabel="Sign out"
        destructive
        onConfirm={() => revoking && void revoke(revoking)}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (open) return setConfirmDelete(true)
          /* the confirm action asked to close with an unearned email: stay
             open and keep the reason on screen */
          if (confirming.current) {
            confirming.current = false
            if (!matches) return
          }
          setConfirmDelete(false)
          setTyped('')
          setMismatch(false)
        }}
        title="Delete your account?"
        description={
          <span className="flex flex-col gap-2.5">
            <span>
              Every canvas you own, your connected agents and every session on every device are deleted. There is no
              undo and no grace period.
            </span>
            <span className="flex flex-col gap-1.5 text-ink">
              <span>
                Type your account email to confirm — <b className="font-semibold">{email}</b>
              </span>
              <Input
                value={typed}
                autoComplete="off"
                aria-label="Account email"
                placeholder="you@example.com"
                onChange={(e) => {
                  setTyped(e.target.value)
                  setMismatch(false)
                }}
              />
              {mismatch && <Note tone="error">That is not this account’s email.</Note>}
            </span>
          </span>
        }
        confirmLabel={busy === 'delete' ? 'Deleting…' : 'Delete everything'}
        destructive
        onConfirm={() => {
          confirming.current = true
          void deleteAccount()
        }}
      />
    </>
  )
}
