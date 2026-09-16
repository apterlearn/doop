import { useEffect, useRef, useState } from 'react'
import {
  COMMUNITY_CATEGORIES,
  COMMUNITY_CATEGORY_LABELS,
  type Canvas,
  type CanvasRelease,
  type CommunityCategory,
} from '../../shared/types'
import { navigate } from '../App'
import {
  api,
  ApiError,
  type CanvasInvite,
  type CanvasMember,
  type CanvasRole,
  type GithubConnectionInfo,
  type LinkAccess,
} from '../lib/api'
import { authClient } from '../lib/auth'
import { posthog } from '../lib/posthog'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { ConfirmDialog } from './ui/alert-dialog'
import { Avatar } from './ui/avatar'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { ChevronDownIcon, GithubIcon, XIcon } from './ui/icons'
import { Input } from './ui/input'
import { Modal, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { Textarea } from './ui/textarea'
import { ToggleChip, ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'

type ShareableCanvas = Pick<
  Canvas,
  | 'id'
  | 'name'
  | 'ownerId'
  | 'linkAccess'
  | 'linkPasswordSet'
  | 'linkExpiresAt'
  | 'memberIds'
  | 'publishedAt'
  | 'description'
  | 'category'
  | 'publishedReleaseId'
>
type SharePatch = Partial<
  Pick<
    ShareableCanvas,
    | 'linkAccess'
    | 'linkPasswordSet'
    | 'linkExpiresAt'
    | 'memberIds'
    | 'publishedAt'
    | 'description'
    | 'category'
    | 'publishedReleaseId'
  >
>

/* The gallery pin's "no release" choice. Release ids are nanoids, so this can
   never collide with one. */
const LIVE_PIN = 'live'

/** One ship action at a time; the value is also the busy button's label key. */
type ShipBusy = 'zip' | 'code' | 'image' | 'pull' | 'update' | 'freeze' | null

/** How many releases a collapsed list shows before the rest go behind a
 *  disclosure — the modal is a fixed-height card, not a page. */
const SHOWN_RELEASES = 3

/** What each role is allowed to do, in the words the invite pickers and the
 *  collaborator rows use. */
const ROLE_LABELS: Record<CanvasRole, string> = {
  viewer: 'Can view',
  commenter: 'Can comment',
  editor: 'Can edit',
  admin: 'Admin',
}

/* Roles this form hands out. `admin` is one of them now that the server gives
   it the job its name promises (member and invitation management); the owner
   row itself is never re-roled by anyone. */
const ASSIGNABLE_ROLES: CanvasRole[] = ['viewer', 'commenter', 'editor', 'admin']

/** The four link modes, most closed first. The labels are the whole sentence
 *  because that sentence is the difference between them. */
const LINK_MODES: Record<LinkAccess, { label: string; blurb: string }> = {
  none: {
    label: 'Private',
    blurb: 'Only you and the people you invite can open this canvas.',
  },
  view: {
    label: 'Anyone with the link can view',
    blurb: 'Read-only: visitors can look, but they cannot edit frames or leave comments.',
  },
  comment: {
    label: 'Anyone with the link can comment',
    blurb: 'Read-only plus notes: visitors can leave comments, but they cannot edit frames.',
  },
  edit: {
    label: 'Anyone with the link can edit',
    blurb: 'Account needed to edit: visitors signed in to doop edit frames; signed-out visitors read and comment.',
  },
}

/** The order those four are offered in: closed to open. */
const LINK_MODE_ORDER: LinkAccess[] = ['none', 'view', 'comment', 'edit']

/** A day, month and (when it is not this year) year — an expiry reads as
 *  "Aug 3", never as a wall of digits. */
function shortDate(ts: number): string {
  const date = new Date(ts)
  return date.toLocaleDateString(
    undefined,
    date.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' },
  )
}

/** Epoch ms as the `datetime-local` input's own value format (local time, to
 *  the minute — the control has no seconds). */
function toLocalInput(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* One sharing surface for the canvas and dashboard. The caller owns canvas
   state; this component reports optimistic access changes back to it. */
export function ShareModal({
  canvas,
  onChange,
  onClose,
  onCopied,
}: {
  canvas: ShareableCanvas
  onChange: (patch: SharePatch) => void
  onClose: () => void
  onCopied: () => void
}) {
  const { data: session } = authClient.useSession()
  const meId = session?.user?.id
  const isOwner = !!canvas.ownerId && canvas.ownerId === meId
  const linkAccess: LinkAccess = canvas.linkAccess ?? 'none'
  const [people, setPeople] = useState<CanvasMember[] | null>(null)
  /* invitations to people who had no account to invite yet — owner-only, the
     same way the people list is */
  const [invites, setInvites] = useState<CanvasInvite[] | null>(null)
  /* frozen snapshots, newest first — the ship section lists them and the
     listing's pin picker chooses among them, so both read this one copy */
  const [releases, setReleases] = useState<CanvasRelease[] | null>(null)
  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<CanvasRole>('editor')
  /* the invitation this session created: its link is the only copy of that
     capability, so it stays on screen until it is revoked */
  const [created, setCreated] = useState<CanvasInvite | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  /* link protection. The password is write-only — a save clears the field and
     `passwordSet` says what happened to it; nothing ever reads it back. */
  const [password, setPassword] = useState('')
  const [passwordSet, setPasswordSet] = useState(false)
  const [expiry, setExpiry] = useState(canvas.linkExpiresAt ? toLocalInput(canvas.linkExpiresAt) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mode = LINK_MODES[linkAccess]
  const createdLink = created ? (created.url.startsWith('/') ? location.origin + created.url : created.url) : null
  /* the datetime-local draft as epoch ms; null while the field is empty or
     holds something that is not a date */
  const expiryDraft = expiry ? new Date(expiry).getTime() : null
  /* what the link currently asks for, as the one line under its controls */
  const gateParts = [
    ...(canvas.linkPasswordSet ? ['Password protected'] : []),
    ...(canvas.linkExpiresAt ? [`Expires ${shortDate(canvas.linkExpiresAt)}`] : []),
  ]

  useEffect(() => {
    let active = true
    api
      .listMembers(canvas.id)
      .then((members) => active && setPeople(members))
      .catch(() => active && setPeople([]))
    return () => {
      active = false
    }
  }, [canvas.id])

  useEffect(() => {
    if (!isOwner) return
    let active = true
    api
      .listInvites(canvas.id)
      .then((list) => active && setInvites(list))
      .catch(() => active && setInvites([]))
    return () => {
      active = false
    }
  }, [canvas.id, isOwner])

  useEffect(() => {
    if (!isOwner) return
    let active = true
    api
      .listReleases(canvas.id)
      .then((list) => active && setReleases(list))
      .catch(() => active && setReleases([]))
    return () => {
      active = false
    }
  }, [canvas.id, isOwner])

  /* Invite by email. An address that already has an account becomes a member
     on the spot; one that does not is a 404 from the server, and the way in
     for those people is the invitation link the server mints instead. */
  async function invite() {
    const clean = email.trim()
    if (!clean || busy || people === null) return
    setBusy(true)
    setError(null)
    setCreated(null)
    try {
      let member: CanvasMember
      try {
        /* the role rides on the add itself: a second request to apply it could
           fail and leave the person on the server's default, with the form
           still reporting success */
        member = await api.inviteMember(canvas.id, clean, inviteRole)
      } catch (caught) {
        if (!(caught instanceof ApiError) || caught.status !== 404) throw caught
        const invitation = await api.createInvite(canvas.id, clean, inviteRole)
        setInvites((current) => [invitation, ...(current ?? [])])
        setCreated(invitation)
        setEmail('')
        return
      }
      /* inviteMember answers with the membership it created; a re-add of
         somebody already on the canvas keeps the role they already had */
      setPeople((current) =>
        current?.some((person) => person.userId === member.userId)
          ? current.map((person) => (person.userId === member.userId ? member : person))
          : [...(current ?? []), member],
      )
      if (!canvas.memberIds?.includes(member.userId)) {
        onChange({ memberIds: [...(canvas.memberIds ?? []), member.userId] })
      }
      setEmail('')
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'invite failed') : 'invite failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(userId: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.removeMember(canvas.id, userId)
      setPeople((current) => current?.filter((person) => person.userId !== userId) ?? null)
      onChange({ memberIds: canvas.memberIds?.filter((id) => id !== userId) })
      if (userId === meId && !isOwner) navigate('/')
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'removal failed') : 'removal failed')
    } finally {
      setBusy(false)
    }
  }

  /* The link's four modes. The server owns what each one grants; this only
     reports which one the owner picked. */
  async function changeLink(next: LinkAccess) {
    if (busy || next === linkAccess) return
    setBusy(true)
    setError(null)
    try {
      await api.setLinkAccess(canvas.id, next)
      onChange({ linkAccess: next })
    } catch (caught) {
      setError(
        caught instanceof ApiError ? String(caught.body.error ?? 'access update failed') : 'access update failed',
      )
    } finally {
      setBusy(false)
    }
  }

  /* A role change answers with the membership as it now stands, so the row is
     rebuilt from the server's member rather than from what was asked for. */
  async function changeRole(person: CanvasMember, role: CanvasRole) {
    if (busy || role === person.role) return
    setBusy(true)
    setError(null)
    try {
      const updated = await api.setMemberRole(canvas.id, person.userId, role)
      setPeople((current) => current?.map((row) => (row.userId === updated.userId ? updated : row)) ?? null)
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'role change failed') : 'role change failed')
    } finally {
      setBusy(false)
    }
  }

  /* Password and expiry ride the same PATCH; its response is the canvas as it
     now stands, and that answer is what the modal reports back. */
  async function saveSharing(patch: { password?: string | null; expiresAt?: number | null }): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      const updated = await api.setLinkSharing(canvas.id, patch)
      onChange({ linkPasswordSet: updated.linkPasswordSet, linkExpiresAt: updated.linkExpiresAt })
      return true
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'the link settings were not saved')
          : 'the link settings were not saved',
      )
      return false
    } finally {
      setBusy(false)
    }
  }

  async function setLinkPassword() {
    const next = password.trim()
    if (!next || !(await saveSharing({ password: next }))) return
    /* the field is cleared rather than echoed: the server keeps the hash, and
       the summary line above reports that one is now in force */
    setPassword('')
    setPasswordSet(true)
  }

  async function clearLinkPassword() {
    if (!(await saveSharing({ password: null }))) return
    setPassword('')
    setPasswordSet(false)
  }

  async function setLinkExpiry() {
    if (expiryDraft === null || !Number.isFinite(expiryDraft)) return
    await saveSharing({ expiresAt: expiryDraft })
  }

  async function clearLinkExpiry() {
    if (await saveSharing({ expiresAt: null })) setExpiry('')
  }

  async function revoke(invitation: CanvasInvite) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.revokeInvite(canvas.id, invitation.id)
      setInvites((current) => current?.filter((row) => row.id !== invitation.id) ?? null)
      /* a revoked link must not stay on screen as though it still worked */
      setCreated((current) => (current?.id === invitation.id ? null : current))
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'the invitation was not revoked')
          : 'the invitation was not revoked',
      )
    } finally {
      setBusy(false)
    }
  }

  async function copyCreated() {
    if (!created || !createdLink) return
    setError(null)
    try {
      await navigator.clipboard.writeText(createdLink)
      setCopied(created.id)
    } catch {
      setError('Couldn’t copy the link. Select the URL above and copy it instead.')
    }
  }

  async function copy() {
    setError(null)
    try {
      await navigator.clipboard.writeText(`${location.origin}/c/${canvas.id}`)
      posthog.capture('canvas_link_shared')
      onCopied()
    } catch {
      setError('Couldn’t copy the link. Copy the URL from your browser instead.')
    }
  }

  return (
    <Modal size="sm" onClose={onClose}>
      <>
        <div className="flex items-start justify-between gap-3">
          <ModalTitle className="min-w-0">Share “{canvas.name}”</ModalTitle>
          <Button variant="ghost" size="icon" className="size-10" aria-label="Close sharing" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        {isOwner && (
          <>
            <div className="mt-4 flex flex-col items-stretch gap-2 sm:flex-row">
              <Input
                className="flex-1 rounded-[10px] bg-paper focus:ring-0"
                autoFocus
                placeholder="Invite by email (doop account)"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && invite()}
              />
              <Button
                variant="primary"
                className="justify-center"
                disabled={busy || people === null || !email.trim()}
                onClick={invite}
              >
                Invite
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="text-[12px] text-ink-faint">Invite as</span>
              <ToggleChipGroup
                aria-label="Role for new invitations"
                className="gap-1.5"
                value={inviteRole}
                onValueChange={(next) => setInviteRole(next as CanvasRole)}
              >
                {ASSIGNABLE_ROLES.map((role) => (
                  <ToggleChipItem key={role} value={role} className="px-2 py-0.5 text-[12px]" disabled={busy}>
                    {ROLE_LABELS[role]}
                  </ToggleChipItem>
                ))}
              </ToggleChipGroup>
            </div>
            {created && createdLink && (
              <div className="mt-2.5 flex flex-col gap-1.5 rounded-[10px] border border-line-soft bg-paper px-2.5 py-2">
                <Note tone="success" size="sm">
                  Invitation created — share this link with {created.email}.
                </Note>
                <div className="flex flex-col items-stretch gap-2 sm:flex-row">
                  <Input
                    className="flex-1 rounded-[10px] bg-paper text-[13px] focus:ring-0"
                    readOnly
                    aria-label="Invitation link"
                    value={createdLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button className="justify-center" onClick={copyCreated}>
                    {copied === created.id ? 'Copied' : '⧉ Copy'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="mx-[2px] mt-2 text-[12px] text-accent-ink">{error}</p>}
        <div className="mt-[14px] mb-1 flex max-h-[40vh] flex-col gap-[2px] overflow-y-auto">
          {(people ?? []).map((person) => (
            <div key={person.userId} className="flex items-center gap-2.5 px-[2px] py-1.5">
              <Avatar name={person.name} className="size-7 flex-none border-0 text-xs" />
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <b className="overflow-hidden whitespace-nowrap text-ellipsis text-[13px] font-semibold">
                  {person.name}
                  {person.userId === meId ? ' (you)' : ''}
                </b>
                <span className="overflow-hidden whitespace-nowrap text-ellipsis text-[12px] text-ink-faint">
                  {person.email}
                </span>
              </span>
              {person.owner ? (
                <span className="flex-none text-[12px] text-ink-faint">Owner</span>
              ) : (
                <>
                  {isOwner ? (
                    <span className="relative flex flex-none items-center">
                      <select
                        aria-label={`Role for ${person.name}`}
                        className="h-7 cursor-pointer appearance-none rounded-md border border-line bg-surface pl-2 pr-6 text-base font-medium text-ink outline-none transition-[border-color] focus:border-ink disabled:cursor-not-allowed disabled:opacity-60 md:text-xs"
                        value={person.role}
                        disabled={busy}
                        onChange={(event) => changeRole(person, event.target.value as CanvasRole)}
                      >
                        {ASSIGNABLE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                      <ChevronDownIcon
                        width={10}
                        height={10}
                        className="pointer-events-none absolute right-2 text-ink-faint"
                      />
                    </span>
                  ) : (
                    <span className="flex-none text-[12px] text-ink-faint">{ROLE_LABELS[person.role]}</span>
                  )}
                  {(isOwner || person.userId === meId) && (
                    <Button
                      variant="bare"
                      size="icon-sm"
                      className="flex-none text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
                      title={person.userId === meId ? 'Leave this canvas' : 'Remove'}
                      disabled={busy}
                      onClick={() => remove(person.userId)}
                    >
                      ✕
                    </Button>
                  )}
                </>
              )}
            </div>
          ))}
          {people === null && <p className="text-[12px] text-ink-faint">Loading…</p>}
          {isOwner && (invites?.length ?? 0) > 0 && (
            <div className="mt-1.5 flex flex-col gap-[2px] border-t border-line-soft pt-1.5">
              <span className="px-[2px] text-[12px] font-semibold text-ink-soft">Pending invitations</span>
              {(invites ?? []).map((invitation) => (
                <div key={invitation.id} className="flex items-center gap-2.5 px-[2px] py-1.5">
                  <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                    <b className="overflow-hidden whitespace-nowrap text-ellipsis text-[13px] font-semibold">
                      {invitation.email}
                    </b>
                    <span className="overflow-hidden whitespace-nowrap text-ellipsis text-[12px] text-ink-faint">
                      {ROLE_LABELS[invitation.role]} · Expires {shortDate(invitation.expiresAt)}
                    </span>
                  </span>
                  <Button
                    variant="bare"
                    size="icon-sm"
                    className="flex-none text-[13px] hover:bg-accent-ink/10 hover:text-accent-ink"
                    title={`Revoke the invitation for ${invitation.email}`}
                    disabled={busy}
                    onClick={() => revoke(invitation)}
                  >
                    ✕
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2.5 flex flex-col gap-2.5 border-t border-line-soft pt-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <span className="text-[12px] font-semibold text-ink-soft">Link access</span>
            <Button className="justify-center" onClick={copy}>
              ⧉ Copy link
            </Button>
          </div>
          {isOwner ? (
            <>
              <ToggleChipGroup
                aria-label="What the share link grants"
                className="gap-1.5"
                value={linkAccess}
                onValueChange={(next) => changeLink(next as LinkAccess)}
              >
                {LINK_MODE_ORDER.map((value) => (
                  <ToggleChipItem key={value} value={value} className="px-2.5 py-1 text-[12px]" disabled={busy}>
                    {LINK_MODES[value].label}
                  </ToggleChipItem>
                ))}
              </ToggleChipGroup>
              <Note>{mode.blurb}</Note>
            </>
          ) : (
            <>
              <ToggleChip state="idle" className="self-start px-2.5 py-1 text-[12px]">
                {mode.label}
              </ToggleChip>
              <Note>{mode.blurb}</Note>
            </>
          )}
          {/* a private canvas has no link to protect: the gate only means
              something once the link opens the canvas */}
          {isOwner && linkAccess !== 'none' && (
            <div className="flex flex-col gap-2 border-t border-line-soft pt-2.5">
              <Note>{gateParts.join(' · ') || 'No password, no expiry.'}</Note>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row">
                <Input
                  className="flex-1 rounded-[10px] bg-paper focus:ring-0"
                  type="password"
                  autoComplete="new-password"
                  aria-label="Link password"
                  placeholder="Password"
                  value={password}
                  disabled={busy}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setPasswordSet(false)
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && setLinkPassword()}
                />
                <Button className="justify-center" disabled={busy || !password.trim()} onClick={setLinkPassword}>
                  Set password
                </Button>
                {canvas.linkPasswordSet && (
                  <Button variant="danger" className="justify-center" disabled={busy} onClick={clearLinkPassword}>
                    Remove
                  </Button>
                )}
              </div>
              <div className="flex flex-col items-stretch gap-2 sm:flex-row">
                <Input
                  className="flex-1 rounded-[10px] bg-paper focus:ring-0"
                  type="datetime-local"
                  aria-label="Link expiry"
                  value={expiry}
                  disabled={busy}
                  onChange={(event) => setExpiry(event.target.value)}
                />
                <Button
                  className="justify-center"
                  disabled={busy || expiryDraft === null || !Number.isFinite(expiryDraft)}
                  onClick={setLinkExpiry}
                >
                  Set expiry
                </Button>
                {canvas.linkExpiresAt !== undefined && (
                  <Button variant="danger" className="justify-center" disabled={busy} onClick={clearLinkExpiry}>
                    Clear
                  </Button>
                )}
              </div>
              {passwordSet && <Note tone="success">Password set — it can’t be shown again.</Note>}
            </div>
          )}
        </div>
        {isOwner && (
          <CommunityListing
            canvas={canvas}
            releases={releases ?? []}
            busy={busy}
            setBusy={setBusy}
            setError={setError}
            onChange={onChange}
          />
        )}
        {isOwner && <ShipSection canvas={canvas} releases={releases} setReleases={setReleases} />}
      </>
    </Modal>
  )
}

/* The gallery is opt-in and owner-only. Listing hands out previews and
   copies, never access — so it sits apart from the access controls above,
   with its own switch and its own blurb. */
function CommunityListing({
  canvas,
  releases,
  busy,
  setBusy,
  setError,
  onChange,
}: {
  canvas: ShareableCanvas
  releases: CanvasRelease[]
  busy: boolean
  setBusy: (busy: boolean) => void
  setError: (error: string | null) => void
  onChange: (patch: SharePatch) => void
}) {
  const published = canvas.publishedAt !== undefined
  const livePin = canvas.publishedReleaseId ?? null
  const [description, setDescription] = useState(canvas.description ?? '')
  const [category, setCategory] = useState<CommunityCategory>(canvas.category ?? 'website')
  /* the pin the human has chosen but not saved yet; `live` is the no-pin
     choice, so a chosen release and "the live canvas" are one control */
  const [pin, setPin] = useState(livePin ?? LIVE_PIN)
  const dirty =
    published &&
    (description.trim() !== (canvas.description ?? '') ||
      category !== canvas.category ||
      (pin === LIVE_PIN ? null : pin) !== livePin)

  async function save(next: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (next) {
        /* a release with no frames is not a listing — the server refuses it,
           and the picker never offers it */
        const releaseId = pin === LIVE_PIN ? null : pin
        const listing = await api.publishCanvas(canvas.id, { description: description.trim(), category }, releaseId)
        if (!published) posthog.capture('canvas_published')
        /* what the listing carries is the pin we asked for: the server
           validates it or refuses the publish, and null clears it */
        onChange({ ...listing, publishedReleaseId: releaseId ?? undefined })
      } else {
        await api.unpublishCanvas(canvas.id)
        posthog.capture('canvas_unpublished')
        onChange({
          publishedAt: undefined,
          description: undefined,
          category: undefined,
          publishedReleaseId: undefined,
        })
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'publish failed') : 'publish failed')
    } finally {
      setBusy(false)
    }
  }

  const pinned = releases.find((release) => release.id === livePin)
  /* a listing carries a release id, and the list the server hands back is
     paged — so say the pin is outside this list rather than that it is gone */
  const pinNote = !published
    ? 'What a visitor sees once this canvas is listed.'
    : !livePin
      ? 'The listing shows the live canvas — every edit reaches the gallery.'
      : pinned
        ? `Pinned to “${pinned.name}” — visitors get that frozen snapshot, whatever the canvas does next.`
        : 'Pinned to a release this list doesn’t carry.'
  const pinnable = releases.filter((release) => release.frames.length > 0)

  return (
    <div className="mt-3.5 border-t border-line-soft pt-3.5">
      <label
        className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink"
        title="Anyone on doop can preview and copy a listed canvas. The canvas itself stays private."
      >
        <Checkbox checked={published} disabled={busy} onChange={(event) => save(event.target.checked)} />
        Show in the community gallery
      </label>
      <p className="mt-1 pl-[26px] text-[12px] leading-snug text-ink-faint">
        People can preview it and copy it into their own account. Your canvas stays private.
      </p>
      {pinnable.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5 pl-[26px]">
          <span className="text-[12px] font-semibold text-ink-soft">Gallery shows</span>
          {/* a canvas can carry a lot of releases: the cloud scrolls rather
              than pushing the rest of the modal down, and every release stays
              reachable */}
          <div className="max-h-[104px] overflow-y-auto pr-1">
            <ToggleChipGroup aria-label="Gallery preview source" className="gap-1.5" value={pin} onValueChange={setPin}>
              <ToggleChipItem value={LIVE_PIN} className="px-2.5 py-1 text-[12px]" disabled={busy}>
                The live canvas
              </ToggleChipItem>
              {pinnable.map((release) => (
                <ToggleChipItem key={release.id} value={release.id} className="px-2.5 py-1 text-[12px]" disabled={busy}>
                  {release.name}
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
          </div>
          <Note>{pinNote}</Note>
        </div>
      )}
      {published && (
        <div className="mt-3 flex flex-col gap-2.5 pl-[26px]">
          <Textarea
            rows={2}
            maxLength={280}
            className="rounded-[10px] bg-paper text-[13px] focus:ring-0"
            placeholder="What is this design? One or two lines helps people find it."
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
          <ToggleChipGroup
            aria-label="Gallery shelf"
            className="gap-1.5"
            value={category}
            onValueChange={(next) => setCategory(next as CommunityCategory)}
          >
            {COMMUNITY_CATEGORIES.map((value) => (
              <ToggleChipItem key={value} value={value} className="px-2.5 py-1 text-[12px]" disabled={busy}>
                {COMMUNITY_CATEGORY_LABELS[value]}
              </ToggleChipItem>
            ))}
          </ToggleChipGroup>
          {dirty && (
            <Button size="sm" className="self-start" disabled={busy} onClick={() => save(true)}>
              Update listing
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/* Ship: the half of the loop that leaves doop — the canvas as a file, as a
   pull request against a connected repo, and the frozen releases a handoff
   link or a pinned listing points at. Owner-only, exactly like the listing
   above: these spend the owner's repo credentials and rewrite their frames. */
function ShipSection({
  canvas,
  releases,
  setReleases,
}: {
  canvas: ShareableCanvas
  releases: CanvasRelease[] | null
  setReleases: (releases: CanvasRelease[]) => void
}) {
  const [busy, setBusy] = useState<ShipBusy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [connections, setConnections] = useState<GithubConnectionInfo[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [prMessage, setPrMessage] = useState('')
  /* the pull request this session opened: its number is what a later update
     reports against, and its URL is what the human clicks through to */
  const [pull, setPull] = useState<{ url: string; number: number } | null>(null)
  const [releaseName, setReleaseName] = useState('')
  /* the release whose Restore was clicked (awaiting confirmation), and the one
     a restore is running for — the row being written over says so */
  const [confirmRestore, setConfirmRestore] = useState<CanvasRelease | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

  /* The connection the pull request would spend. Same read the import surface
     does; a canvas with no connection is the disabled state below, not an
     error — nothing has failed yet. */
  useEffect(() => {
    let active = true
    api
      .listGithubConnections(canvas.id)
      .then((list) => {
        if (!active) return
        setConnections(list)
        setRepo((current) => current ?? list[0]?.repo ?? null)
      })
      .catch(() => active && setConnections([]))
    return () => {
      active = false
    }
  }, [canvas.id])

  const connection = connections?.find((conn) => conn.repo === repo) ?? connections?.[0] ?? null

  async function exportAs(format: 'zip' | 'code') {
    if (busy) return
    setBusy(format)
    setError(null)
    setNotice(null)
    try {
      const { url } = await api.exportCanvas(canvas.id, format)
      /* the archive is a public asset URL, so the download is a link click —
         nothing is fetched into memory to hand it back out */
      const link = document.createElement('a')
      link.href = url
      link.download = format === 'zip' ? `${canvas.name}.zip` : `${canvas.name} (code).zip`
      link.rel = 'noopener'
      document.body.append(link)
      link.click()
      link.remove()
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'the export failed') : 'the export failed')
    } finally {
      setBusy(null)
    }
  }

  /** One PNG of every visible frame on the page being viewed, laid out where
   *  the stage has them. Rendered on the server (the client cannot composite a
   *  sandboxed iframe), so this is the same asset-URL download the archives
   *  use; with no page active the server falls back to the canvas's first. */
  async function exportImage() {
    if (busy) return
    setBusy('image')
    setError(null)
    setNotice(null)
    try {
      const { url } = await api.exportCanvasImage(canvas.id, useStore.getState().activePageId)
      const link = document.createElement('a')
      link.href = url
      link.download = `${canvas.name}.png`
      link.rel = 'noopener'
      document.body.append(link)
      link.click()
      link.remove()
    } catch (caught) {
      setError(caught instanceof ApiError ? String(caught.body.error ?? 'the export failed') : 'the export failed')
    } finally {
      setBusy(null)
    }
  }

  async function openPull() {
    if (busy || !connection) return
    setBusy('pull')
    setError(null)
    setNotice(null)
    try {
      const opened = await api.openPullRequest(canvas.id, {
        repo: connection.repo,
        ...(prMessage.trim() ? { message: prMessage.trim() } : {}),
      })
      setPull(opened)
      setPrMessage('')
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'could not open the pull request')
          : 'could not open the pull request',
      )
    } finally {
      setBusy(null)
    }
  }

  async function updatePull() {
    if (busy || !connection || !pull) return
    setBusy('update')
    setError(null)
    setNotice(null)
    try {
      /* an empty message is the server's cue to describe the update itself */
      const updated = await api.updatePullRequest(canvas.id, prMessage.trim(), connection.repo)
      setPull({ url: updated.url, number: pull.number })
      setPrMessage('')
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'could not update the pull request')
          : 'could not update the pull request',
      )
    } finally {
      setBusy(null)
    }
  }

  async function freeze() {
    if (busy || releases === null) return
    setBusy('freeze')
    setError(null)
    setNotice(null)
    try {
      const release = await api.createRelease(canvas.id, releaseName.trim() || undefined)
      setReleases([release, ...releases])
      setReleaseName('')
      setNotice(`Froze “${release.name}” — ${release.frames.length} frames.`)
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? String(caught.body.error ?? 'could not freeze a release')
          : 'could not freeze a release',
      )
    } finally {
      setBusy(null)
    }
  }

  async function restore(release: CanvasRelease) {
    if (busy || restoringId) return
    setRestoringId(release.id)
    setError(null)
    setNotice(null)
    try {
      await api.restoreRelease(canvas.id, release.id)
      /* the frames land as ordinary edits, so the room — this canvas included
         — is already being told what changed */
      setNotice(`Restored “${release.name}” onto the canvas.`)
    } catch (caught) {
      setError(
        caught instanceof ApiError ? String(caught.body.error ?? 'the restore was refused') : 'the restore was refused',
      )
    } finally {
      setRestoringId(null)
    }
  }

  async function copyRelease(release: CanvasRelease) {
    setError(null)
    try {
      await navigator.clipboard.writeText(release.url)
      setCopied(release.id)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(
        () => setCopied((current) => (current === release.id ? null : current)),
        2000,
      )
    } catch {
      setError('Couldn’t copy the link. Open the release and copy the URL from your browser instead.')
    }
  }

  function releaseRow(release: CanvasRelease) {
    const frames = release.frames.length
    return (
      <div key={release.id} className="flex items-center gap-2 px-[2px] py-1.5">
        <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
          <b className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold">{release.name}</b>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-ink-faint">
            {frames ? `${frames} frame${frames === 1 ? '' : 's'}` : 'no frames'} · {timeAgo(release.createdAt)} ·{' '}
            {release.createdBy}
          </span>
        </span>
        <Button
          size="sm"
          className="flex-none px-2.5 text-xs"
          title={`Copy the public preview link (${release.url})`}
          onClick={() => copyRelease(release)}
        >
          {copied === release.id ? 'Copied' : '⧉ Copy'}
        </Button>
        {/* an empty release has nothing to put back — restoring it can only
            fail, so it offers no action rather than a dead one */}
        {frames > 0 && (
          <Button
            size="sm"
            variant="danger"
            className="flex-none px-2.5 text-xs"
            disabled={!!busy || restoringId !== null}
            onClick={() => setConfirmRestore(release)}
          >
            {restoringId === release.id ? 'Restoring…' : 'Restore'}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="mt-3.5 flex flex-col gap-2.5 border-t border-line-soft pt-3.5">
      <h3 className="text-[13px] font-semibold text-ink">Ship</h3>
      <Note>
        Hand the design to the people who build it: as a file, as a pull request on a connected repo, or as a frozen
        version you can point at later.
      </Note>

      <div className="flex flex-col gap-1.5">
        <b className="text-[12px] text-ink-soft">Export</b>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="px-2.5 text-xs" disabled={!!busy} onClick={() => exportAs('zip')}>
            {busy === 'zip' ? 'Zipping…' : 'Download ZIP'}
          </Button>
          <Button size="sm" className="px-2.5 text-xs" disabled={!!busy} onClick={() => exportAs('code')}>
            {busy === 'code' ? 'Exporting…' : 'Export code'}
          </Button>
          <Button size="sm" className="px-2.5 text-xs" disabled={!!busy} onClick={() => exportImage()}>
            {busy === 'image' ? 'Rendering…' : 'Export image'}
          </Button>
        </div>
        <Note>
          The ZIP is the canvas as one self-contained page; Export code is the repository file set a pull request
          commits; Export image is a single PNG of the page as the stage lays it out.
        </Note>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2.5">
        <b className="text-[12px] text-ink-soft">Pull request</b>
        {connection ? (
          <>
            <div className="flex items-center gap-2 text-[13px]">
              <GithubIcon width={13} height={13} className="shrink-0 text-ink-faint" />
              <b className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                {connection.repo}
                <span className="font-normal text-ink-faint">@{connection.branch}</span>
              </b>
              <Note className="mr-auto shrink-0">
                {connection.frames
                  ? `${connection.frames} screen${connection.frames === 1 ? '' : 's'}`
                  : 'nothing imported yet'}
              </Note>
            </div>
            {(connections?.length ?? 0) > 1 && (
              <ToggleChipGroup
                aria-label="Repository to ship to"
                className="gap-1.5"
                value={connection.repo}
                onValueChange={setRepo}
              >
                {(connections ?? []).map((conn) => (
                  <ToggleChipItem key={conn.id} value={conn.repo} className="px-2.5 py-1 text-[12px]" disabled={!!busy}>
                    {conn.repo}
                  </ToggleChipItem>
                ))}
              </ToggleChipGroup>
            )}
            <div className="flex flex-col items-stretch gap-2 sm:flex-row">
              <Input
                className="flex-1 rounded-[10px] bg-paper focus:ring-0"
                maxLength={200}
                placeholder="Pull request title (optional)"
                value={prMessage}
                disabled={!!busy}
                onChange={(event) => setPrMessage(event.target.value)}
              />
              <Button variant="primary" className="justify-center" disabled={!!busy} onClick={openPull}>
                {busy === 'pull' ? 'Opening…' : 'Open pull request'}
              </Button>
              {pull && (
                <Button className="justify-center" disabled={!!busy} onClick={updatePull}>
                  {busy === 'update' ? 'Updating…' : 'Update pull request'}
                </Button>
              )}
            </div>
            {pull && (
              <Note className="break-all">
                Pull request #{pull.number} —{' '}
                <a
                  className="font-semibold text-ink underline underline-offset-[3px]"
                  href={pull.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {pull.url}
                </a>
              </Note>
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="px-2.5 text-xs" disabled>
                Open pull request
              </Button>
            </div>
            <Note>
              {connections === null
                ? 'Checking whether a repo is connected…'
                : 'No GitHub repo is connected to this canvas — connect one from Import to open a pull request.'}
            </Note>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-2.5">
        <b className="text-[12px] text-ink-soft">Releases</b>
        <Note>
          A release freezes every frame at its own public link — the version you send, pin the gallery to, or restore
          onto the canvas.
        </Note>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row">
          <Input
            className="flex-1 rounded-[10px] bg-paper focus:ring-0"
            maxLength={120}
            placeholder="Release name (optional)"
            value={releaseName}
            disabled={!!busy}
            onChange={(event) => setReleaseName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && freeze()}
          />
          <Button variant="primary" className="justify-center" disabled={!!busy || releases === null} onClick={freeze}>
            {busy === 'freeze' ? 'Freezing…' : 'Freeze a release'}
          </Button>
        </div>
        {releases === null ? (
          <p className="text-[12px] text-ink-faint">Loading…</p>
        ) : releases.length === 0 ? (
          <Note>No releases yet — freeze one and it can be pinned in the gallery.</Note>
        ) : (
          <div className="flex flex-col gap-[2px]">
            {releases.slice(0, SHOWN_RELEASES).map(releaseRow)}
            {releases.length > SHOWN_RELEASES && (
              <Collapsible open={showAll} onOpenChange={setShowAll}>
                <CollapsibleTrigger className="self-start py-1 text-[12px] font-medium text-ink-soft hover:text-ink">
                  {showAll ? 'Fewer releases' : `${releases.length - SHOWN_RELEASES} older releases`}
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-[2px]">
                  {releases.slice(SHOWN_RELEASES).map(releaseRow)}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        )}
      </div>

      {error && <p className="mx-[2px] text-[12px] text-accent-ink">{error}</p>}
      {notice && <Note tone="success">{notice}</Note>}

      <ConfirmDialog
        open={confirmRestore !== null}
        onOpenChange={(open) => !open && setConfirmRestore(null)}
        title={`Restore “${confirmRestore?.name ?? ''}”?`}
        description={
          <>
            Restoring writes the {confirmRestore?.frames.length ?? 0} frozen frames back onto the canvas as ordinary
            edits: frames you drew since are left alone, frames the canvas has lost come back, and every change can be
            undone on its own.
          </>
        }
        confirmLabel="Restore frames"
        destructive
        onConfirm={() => confirmRestore && restore(confirmRestore)}
      />
    </div>
  )
}
