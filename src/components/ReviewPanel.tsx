import { useEffect, useMemo, useState } from 'react'
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
              <ProposalCard key={p.id} canvasId={canvasId} proposal={p} />
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

/** One proposed change: the frame as it is beside the frame as proposed, with
 *  the accept/reject decision. Accepting applies it; the frame having changed
 *  since the agent read it marks the proposal stale instead of overwriting —
 *  a stale row is still here so the reviewer can apply it anyway. A reject can
 *  carry a note the agent reads back. */
function ProposalCard({ canvasId, proposal }: { canvasId: string; proposal: FrameProposal }) {
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === proposal.frameId))
  const width = proposal.width ?? frame?.width ?? 640
  const height = proposal.height ?? frame?.height ?? 480
  const proposed = useHtmlPreview(proposal.html, width, height)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const stale = proposal.status === 'stale'
  const ratio = Math.max(0.2, width / Math.max(1, height))

  function resolve(accept: boolean, force = false) {
    setBusy(true)
    const trimmed = note.trim()
    api
      .resolveFrameProposal(canvasId, proposal.id, accept, {
        ...(!accept && trimmed ? { note: trimmed } : {}),
        ...(force ? { force: true } : {}),
      })
      .then(() => {
        setRejecting(false)
        setNote('')
      })
      .catch(console.error)
      .finally(() => setBusy(false))
  }

  return (
    <div className="rounded-[12px] border border-line bg-surface px-3.5 py-3 shadow-card">
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
      <div className="mt-2.5 flex justify-end gap-2">
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
                disabled={busy}
                onClick={() => resolve(true, true)}
              >
                Apply anyway
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                className="text-[11.5px]"
                disabled={busy}
                onClick={() => resolve(true)}
              >
                Accept
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
