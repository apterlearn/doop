import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { AgentQuestion, FrameProposal } from '../../shared/types'
import { useStore } from '../lib/store'
import { api, ApiError } from '../lib/api'
import { authClient } from '../lib/auth'
import { timeAgo } from '../lib/time'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Textarea } from './ui/textarea'
import { ListSection } from './ui/list'
import { ShieldIcon } from './ui/icons'

const kindLabel: Record<FrameProposal['kind'], string> = {
  replace_html: 'redesign',
  create_frame: 'new frame',
  delete_frame: 'delete',
}

const thumbBox = 'overflow-hidden rounded-[8px] border border-line bg-white'
const thumbCaption = 'mt-1 block text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint'

/** One design a frame is rendered at, for the aspect box that frames it. */
function Thumb({
  label,
  src,
  ratio,
  loading,
}: {
  label: string
  src?: string | null
  ratio: number
  loading?: boolean
}) {
  return (
    <figure className="min-w-0">
      <div className={cn(thumbBox, 'max-h-[150px]')} style={{ aspectRatio: String(ratio) }}>
        {src ? (
          <img src={src} alt="" className="block h-full w-full object-cover object-top" />
        ) : loading ? (
          <div className="h-full w-full animate-[skeleton-pulse_1.4s_ease-in-out_infinite] bg-paper-deep" />
        ) : null}
      </div>
      <figcaption className={thumbCaption}>{label}</figcaption>
    </figure>
  )
}

/** The Review tab: open agent questions first (an agent may be blocked on
 *  one), then frame changes waiting for a decision while review mode is on. */
export function ReviewPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const ownerId = useStore((s) => s.canvas?.ownerId)
  const reviewMode = useStore((s) => s.reviewMode)
  const proposals = useStore((s) => s.frameProposals)
  const questions = useStore((s) => s.questions)
  const frames = useStore((s) => s.canvas?.frames)
  const { data: session } = authClient.useSession()
  const isOwner = !!ownerId && ownerId === session?.user?.id
  const [toggling, setToggling] = useState(false)
  /* Hunks the server refused when a patch was accepted — its old_str no longer
     matched the frame, usually because the frame moved on. Held here, not on
     the card: the card unmounts the moment its proposal resolves. */
  const [hunkReport, setHunkReport] = useState<{
    agentName: string
    skipped: { index: number; reason: string }[]
  } | null>(null)

  /* the ws init payload may predate this panel opening; a human who came here
     to review wants the current list, not the one the socket carried. Stale
     proposals come too — they need the "apply anyway" decision. */
  useEffect(() => {
    if (!canvasId) return
    void Promise.all([api.frameProposals(canvasId, 'pending'), api.frameProposals(canvasId, 'stale')])
      .then(([pendingList, staleList]) => {
        for (const p of [...pendingList, ...staleList]) useStore.getState().upsertFrameProposal(p)
      })
      .catch(console.error)
  }, [canvasId])

  const awaiting = useMemo(() => proposals.filter((p) => p.status === 'pending' || p.status === 'stale'), [proposals])
  const open = useMemo(() => questions.filter((q) => q.status === 'open'), [questions])
  /* one card per frame (or per proposed new frame), the agent's latest change on top */
  const groups = useMemo(() => {
    const byKey = new Map<string, FrameProposal[]>()
    for (const p of awaiting) {
      const key = p.frameId ?? p.id
      const list = byKey.get(key) ?? []
      list.push(p)
      byKey.set(key, list)
    }
    return [...byKey.entries()]
  }, [awaiting])

  if (!canvasId) return null

  function reportSkippedHunks(agentName: string, skipped: { index: number; reason: string }[]) {
    setHunkReport(skipped.length ? { agentName, skipped } : null)
  }

  function toggleReviewMode() {
    setToggling(true)
    api
      .setReviewMode(canvasId!, !reviewMode)
      .then((next) => useStore.getState().setReviewModeLocal(next.reviewMode))
      .catch(console.error)
      .finally(() => setToggling(false))
  }

  return (
    <PanelBody className="flex flex-col pb-3">
      <div className="flex items-start gap-2.5 border-b border-line-soft px-4 py-3.5">
        <ShieldIcon className={cn('mt-px size-4 flex-none', reviewMode ? 'text-brand' : 'text-ink-faint')} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold text-ink">Review mode is {reviewMode ? 'on' : 'off'}</div>
          <p className="mt-1 text-[11.5px] leading-[1.45] text-ink-soft">
            {reviewMode
              ? 'Agent frame changes wait here for your approval — nothing lands on the canvas until you accept it.'
              : 'Agents write to frames directly. Turn review mode on to approve their changes first.'}
          </p>
        </div>
        <Button
          variant={reviewMode ? 'ghost' : 'default'}
          size="sm"
          className="shrink-0 text-[11.5px]"
          disabled={!isOwner || toggling}
          title={isOwner ? undefined : 'Only the canvas owner can change review mode'}
          onClick={toggleReviewMode}
        >
          {reviewMode ? 'Turn off' : 'Turn on'}
        </Button>
      </div>

      {open.length === 0 && awaiting.length === 0 && (
        <div className="px-4 py-6 text-center text-[13px] text-ink-faint">
          {reviewMode
            ? 'Nothing waiting for review. Agent changes land here for your decision.'
            : 'Nothing waiting for review. Turn review mode on to gate agent changes.'}
        </div>
      )}

      {hunkReport && hunkReport.skipped.length > 0 && (
        <div className="mx-4 mt-3 rounded-[10px] border border-accent-ink/40 bg-white px-3 py-2.5 text-[11.5px] leading-[1.45]">
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-ink-soft">
              <b className="text-ink">
                {hunkReport.skipped.length} hunk{hunkReport.skipped.length === 1 ? '' : 's'} of {hunkReport.agentName}
                &rsquo;s change did not land:
              </b>{' '}
              {hunkReport.skipped.map((s) => `#${s.index + 1} ${s.reason}`).join(' · ')}
            </span>
            <Button
              variant="bare"
              className="flex-none px-1 py-0 text-[11px] hover:bg-transparent"
              title="Dismiss"
              onClick={() => setHunkReport(null)}
            >
              ✕
            </Button>
          </div>
        </div>
      )}

      {open.length > 0 && (
        <>
          <ListSection>
            <span>Questions</span>
            <Badge tone="accent">{open.length}</Badge>
          </ListSection>
          {open.map((q) => (
            <QuestionRow key={q.id} canvasId={canvasId} question={q} />
          ))}
        </>
      )}

      {groups.map(([key, list]) => {
        const first = list[0]!
        return (
          <div key={key} className="mt-3 px-4">
            <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
              {first.frameId ? (frames?.find((f) => f.id === first.frameId)?.name ?? 'frame') : 'new frame'}
            </div>
            {list.map((p) => (
              <ProposalCard key={p.id} canvasId={canvasId} proposal={p} onSkipped={reportSkippedHunks} />
            ))}
          </div>
        )
      })}
    </PanelBody>
  )
}

/** One open question with its answer box: the agent is parked in ask_human
 *  until this lands (or its wait times out). A question that offered choices
 *  renders them as buttons — one to pick, or several when it is multi-select —
 *  with a free-text "Other" field when the asker allowed one. */
function QuestionRow({ canvasId, question }: { canvasId: string; question: AgentQuestion }) {
  const choices = question.choices ?? []
  const [picked, setPicked] = useState<string[]>([])
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const frameName = useStore((s) => s.canvas?.frames.find((f) => f.id === question.frameId)?.name)
  /* picks win over a typed answer: a choice question's answer is the choice */
  const text = choices.length ? picked.join(', ') : answer.trim()

  function pick(choice: string) {
    setError('')
    setPicked((prev) =>
      question.multi
        ? prev.includes(choice)
          ? prev.filter((c) => c !== choice)
          : [...prev, choice]
        : prev.includes(choice)
          ? []
          : [choice],
    )
  }

  function submit() {
    if (!text) return
    setBusy(true)
    setError('')
    api
      .answerQuestion(canvasId, question.id, text)
      .then(() => {
        setAnswer('')
        setPicked([])
      })
      .catch((e) =>
        setError(e instanceof ApiError && e.body.error ? String(e.body.error) : 'Could not send that answer.'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className="mx-4 mt-3 rounded-[12px] border border-accent-ink/40 bg-white px-3.5 py-3 shadow-card">
      <div className="flex items-center gap-1.5 text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-accent-ink">
        <AgentIcon name={question.agentName} size={11} />
        {question.agentName} asks
      </div>
      <p className="mt-1.5 text-[13px] font-semibold leading-[1.45] text-ink">{question.text}</p>
      <div className="mt-1.5 text-[11.5px] text-ink-faint">
        {frameName ? `${frameName} · ` : ''}
        {timeAgo(question.at)}
        {question.multi ? ' · pick any number' : ''}
      </div>
      {choices.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {choices.map((choice) => (
            <Button
              key={choice}
              variant={picked.includes(choice) ? 'primary' : 'ghost'}
              size="sm"
              className="text-[11.5px]"
              disabled={busy}
              onClick={() => pick(choice)}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}
      {choices.length === 0 || question.allowOther ? (
        <Field label={choices.length ? 'Other' : 'Your answer'} className="mt-2.5">
          <Textarea
            className="min-h-[52px] text-[13px]"
            value={answer}
            placeholder={choices.length ? 'Something else — the agent is waiting…' : 'The agent is waiting for this…'}
            onChange={(e) => {
              setAnswer(e.target.value)
              /* typing an answer means you mean it: drop any picked choice */
              if (e.target.value) setPicked([])
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </Field>
      ) : null}
      {error && <div className="mt-2 text-[11.5px] text-accent-ink">{error}</div>}
      <div className="mt-2.5 flex justify-end">
        <Button variant="primary" size="sm" className="text-[11.5px]" disabled={!text || busy} onClick={submit}>
          Answer
        </Button>
      </div>
    </div>
  )
}

/** One side of a hunk: the exact text a patch replaces, or the text it puts in
 *  its place. Six lines is enough to recognize a change; the rest scrolls,
 *  because a reviewer reads the shape of it, not the whole document. */
function HunkText({ text, tone }: { text: string; tone: 'old' | 'new' }) {
  const removed = tone === 'old'
  return (
    <span className="mt-1 flex items-start gap-1.5">
      <span className={cn('flex-none font-mono text-[11px] font-bold', removed ? 'text-accent-ink' : 'text-brand')}>
        {removed ? '−' : '+'}
      </span>
      <span
        className={cn(
          'max-h-[100px] min-w-0 flex-1 overflow-auto rounded-[6px] px-2 py-1 font-mono text-[11px] leading-[1.4] whitespace-pre-wrap',
          removed ? 'bg-[rgba(208,52,31,0.05)] text-ink-soft' : 'bg-[rgba(39,67,238,0.05)] text-ink',
        )}
      >
        {text || '∅'}
      </span>
    </span>
  )
}

/** One proposed change: the frame as it is beside the frame as proposed, with
 *  the accept/reject decision. Accepting applies it; the frame having changed
 *  since the agent read it marks the proposal stale instead of overwriting —
 *  a stale row is still here so the reviewer can apply it anyway. A reject can
 *  carry a note the agent reads back. A patch-mode proposal resolves hunk by
 *  hunk: the checked edits are applied, the unchecked ones are dropped. */
function ProposalCard({
  canvasId,
  proposal,
  onSkipped,
}: {
  canvasId: string
  proposal: FrameProposal
  /** hunks the server refused to apply, reported above the list because this
   *  card is gone the moment the proposal resolves */
  onSkipped: (agentName: string, skipped: { index: number; reason: string }[]) => void
}) {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === proposal.frameId))
  const width = proposal.width ?? frame?.width ?? 640
  const height = proposal.height ?? frame?.height ?? 480
  const proposed = useHtmlPreview(proposal.html, width, height)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [rejecting, setRejecting] = useState(false)
  /* patch mode: every hunk applies until the reviewer unchecks it, so the set
     of *dropped* indices is what is held — a hunk added to the proposal since
     this card rendered arrives checked, not silently excluded */
  const edits = proposal.mode === 'patch' ? (proposal.edits ?? []) : []
  const [dropped, setDropped] = useState<number[]>([])
  const stale = proposal.status === 'stale'
  const ratio = Math.max(0.2, width / Math.max(1, height))
  /* how much of the patch survives the checkboxes, and whether that is less
     than all of it — the button says so rather than silently applying fewer */
  const applies = edits.length - dropped.length
  const partial = edits.length > 0 && applies < edits.length

  function resolve(accept: boolean, force = false) {
    /* accepting a patch with nothing checked would apply nothing while telling
       the agent its work landed */
    if (accept && edits.length > 0 && applies === 0) return
    setBusy(true)
    const trimmed = note.trim()
    api
      .resolveFrameProposal(canvasId, proposal.id, accept, {
        ...(!accept && trimmed ? { note: trimmed } : {}),
        ...(force ? { force: true } : {}),
        /* Only an accept carries hunks — a reject discards the whole patch, so
           there is no per-hunk verdict to report. And only a patch has them at
           all: a replace-mode body must not grow the field. */
        ...(accept && edits.length
          ? { hunks: edits.map((_, index) => ({ index, accept: !dropped.includes(index) })) }
          : {}),
      })
      .then((res) => {
        /* a hunk the server could not apply is reported where it can still be
           read: resolving the proposal unmounts this card */
        onSkipped(proposal.agentName, res.skipped ?? [])
        setRejecting(false)
        setNote('')
      })
      .catch(console.error)
      .finally(() => setBusy(false))
  }

  /* A and R are the review keys: they act on this card while it has focus, so
     a queue of proposals can be cleared without reaching for the mouse. A
     mirrors the card's primary action (which is "apply anyway" on a stale
     one); R opens the reject box, and R again confirms it. */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey || busy) return
    const key = e.key.toLowerCase()
    if (key !== 'a' && key !== 'r') return
    e.preventDefault()
    if (key === 'a') resolve(true, stale)
    else if (rejecting) resolve(false)
    else setRejecting(true)
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="group rounded-[12px] border border-line bg-surface px-3.5 py-3 shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-[0.06em]"
          style={{ color: proposal.color }}
        >
          <AgentIcon name={proposal.agentName} size={11} color={proposal.color} />
          {proposal.agentName}
        </span>
        <span className="font-mono text-[10.5px] text-ink-faint">
          {kindLabel[proposal.kind]} · {timeAgo(proposal.at)}
        </span>
        {stale && <Badge tone="banned">stale</Badge>}
      </div>
      <p className="mt-1.5 text-[13px] font-semibold leading-[1.45] text-ink">{proposal.summary}</p>
      {stale && (
        <p className="mt-1 text-[11.5px] leading-[1.45] text-ink-soft">
          The frame changed after {proposal.agentName} read it, so accepting would overwrite that newer work. Apply it
          anyway only if you know that is what you want.
        </p>
      )}
      {proposal.diff ? (
        /* the diff the server rendered when the proposal was made: one image,
           so the reviewer sees where the change landed instead of comparing
           two renders pixel by pixel */
        <figure className="mt-2.5">
          <img
            src={proposal.diff.png}
            alt={`What ${proposal.agentName} proposes changed`}
            className="w-full rounded-[8px] border border-line bg-white"
          />
          <figcaption className={thumbCaption}>
            {Math.round(proposal.diff.changed_ratio * 100)}% of the frame changed
          </figcaption>
        </figure>
      ) : (
        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
          {proposal.kind === 'create_frame' ? (
            <Thumb label="now" ratio={ratio} />
          ) : (
            <Thumb label="now" ratio={ratio} src={`/i/${proposal.frameId}.png?scale=1`} />
          )}
          {proposal.kind === 'delete_frame' ? (
            <div className="min-w-0">
              <div
                className={cn(
                  thumbBox,
                  'grid max-h-[150px] place-items-center bg-[repeating-linear-gradient(45deg,transparent_0_10px,rgba(208,52,31,0.06)_10px_20px)] text-[12px] text-accent-ink',
                )}
                style={{ aspectRatio: String(ratio) }}
              >
                removed
              </div>
              <span className={thumbCaption}>proposed</span>
            </div>
          ) : (
            <Thumb label="proposed" ratio={ratio} src={proposed} loading={!proposed} />
          )}
        </div>
      )}
      {edits.length > 0 && (
        <div className="mt-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
              {edits.length} hunk{edits.length === 1 ? '' : 's'} · {edits.length - dropped.length} applied
            </span>
            <Button
              variant="bare"
              size="sm"
              className="ml-auto px-1 py-0 text-[11px] text-ink-faint hover:bg-transparent hover:text-ink"
              onClick={() => setDropped(dropped.length ? [] : edits.map((_, index) => index))}
            >
              {dropped.length ? 'Select all' : 'Select none'}
            </Button>
          </div>
          {edits.map((edit, index) => {
            const applied = !dropped.includes(index)
            return (
              <label
                key={index}
                className="relative mt-1.5 flex cursor-pointer items-start gap-2 rounded-[8px] border border-line bg-white px-2.5 py-2"
                title={applied ? 'This hunk is applied on accept' : 'This hunk is left out'}
              >
                <Checkbox
                  boxClassName="mt-[3px] size-[15px] rounded-[4px] text-[10px]"
                  checked={applied}
                  disabled={busy}
                  onChange={(e) =>
                    setDropped((prev) =>
                      e.target.checked ? prev.filter((i) => i !== index) : [...prev, index].sort((a, b) => a - b),
                    )
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[10.5px] font-bold text-ink-faint">#{index + 1}</span>
                    <span
                      className={cn(
                        'font-mono text-[10.5px] uppercase tracking-[0.06em]',
                        applied ? 'text-brand' : 'text-ink-faint',
                      )}
                    >
                      {applied ? 'applied' : 'skipped'}
                    </span>
                  </span>
                  <HunkText text={edit.old_str} tone="old" />
                  <HunkText text={edit.new_str} tone="new" />
                </span>
              </label>
            )
          })}
        </div>
      )}
      {rejecting && (
        <Field label="Why? (optional — the agent reads this)" className="mt-2.5">
          <Textarea
            className="min-h-[44px] text-[12.5px]"
            value={note}
            placeholder="Too busy, wrong direction, keep the old hero…"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {!rejecting && (
          <span className="mr-auto hidden font-mono text-[10px] text-ink-faint group-focus-within:inline">
            A accept · R reject
          </span>
        )}
        {rejecting ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-[11.5px]"
              disabled={busy}
              onClick={() => setRejecting(false)}
            >
              Cancel
            </Button>
            <Button variant="danger" size="sm" className="text-[11.5px]" disabled={busy} onClick={() => resolve(false)}>
              {note.trim() ? 'Reject with note' : 'Reject'}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="text-[11.5px]"
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              Reject
            </Button>
            {stale ? (
              <Button
                variant="primary"
                size="sm"
                className="text-[11.5px]"
                disabled={busy || (edits.length > 0 && applies === 0)}
                title={edits.length > 0 && applies === 0 ? 'Check at least one hunk to accept' : undefined}
                onClick={() => resolve(true, true)}
              >
                {partial ? `Apply ${applies} of ${edits.length}` : 'Apply anyway'}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="text-[11.5px]"
                disabled={busy || (edits.length > 0 && applies === 0)}
                title={edits.length > 0 && applies === 0 ? 'Check at least one hunk to accept' : undefined}
                onClick={() => resolve(true)}
              >
                {partial ? `Accept ${applies} of ${edits.length}` : 'Accept'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
