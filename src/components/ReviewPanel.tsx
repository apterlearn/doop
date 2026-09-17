import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type {
  AgentQuestion,
  CanvasProposal,
  DesignTokens,
  Frame,
  FrameProposal,
  ReviewPolicy,
} from '../../shared/types'
import { colorFor } from '../../shared/types'
import { canComment, isReadOnly, useStore } from '../lib/store'
import { api, ApiError, type AgentLevel, type AgentLevelRow } from '../lib/api'
import { authClient } from '../lib/auth'
import { timeAgo } from '../lib/time'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { PanelBody, PanelDisclosure } from './ui/panel'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { Dot } from './ui/dot'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { ListSection } from './ui/list'
import { MarkdownBlock } from './ui/modal'
import { ToggleChipGroup, ToggleChipItem } from './ui/toggle-chip'
import { ShieldIcon } from './ui/icons'

const kindLabel: Record<FrameProposal['kind'], string> = {
  replace_html: 'redesign',
  create_frame: 'new frame',
  delete_frame: 'delete',
}

/** The canvas-level counterpart of `kindLabel`: what a proposal changes, for a
 *  reviewer who has not read the payload yet. */
const canvasKindLabel: Record<CanvasProposal['kind'], string> = {
  tokens: 'design tokens',
  guidelines: 'style guide',
  breakpoints: 'breakpoints',
  pages: 'pages',
}

/* The review policy, in the owner's own words: what each setting gates, what
   its chip says, and what hovering it promises. The three sentences are the
   whole vocabulary of the control, so they live together. */
const POLICIES: ReviewPolicy[] = ['off', 'destructive', 'all_writes']
const policyChipLabel: Record<ReviewPolicy, string> = {
  off: 'Off',
  destructive: 'Destructive',
  all_writes: 'All writes',
}
const policyHeading: Record<ReviewPolicy, string> = {
  off: 'Review is off',
  destructive: 'Review gates destructive writes',
  all_writes: 'Review gates every write',
}
const policyBlurb: Record<ReviewPolicy, string> = {
  off: 'Agents write to the canvas directly. Pick a setting to make their changes wait for your approval.',
  destructive:
    'Only the changes that declare themselves destructive wait here for approval — plus any tool names you list below.',
  all_writes: 'Every agent change waits here for your approval — nothing lands on the canvas until you accept it.',
}
const policyChipTitle: Record<ReviewPolicy, string> = {
  off: 'Nothing waits — agents write directly',
  destructive: 'Destructive writes wait — the safe ones land directly',
  all_writes: 'Every agent write waits for your approval',
}
const OWNER_ONLY = 'Only the canvas owner can change the review policy'

/* The leash, next to the gate: how far each agent may go on this canvas, in
   the owner's own words — what its chip says, what hovering it promises, and
   the one sentence a row wears once the level is set. `full` is written as the
   absence of a restriction, because that is what it is: the level every agent
   has when nobody has chosen anything for it. */
const AGENT_LEVELS: AgentLevel[] = ['full', 'propose', 'comment', 'view']
const levelChipLabel: Record<AgentLevel, string> = {
  full: 'Full',
  propose: 'Propose',
  comment: 'Comment',
  view: 'View',
}
const levelBlurb: Record<AgentLevel, string> = {
  full: 'Writes land directly — nothing this agent does waits for your approval.',
  propose: 'Writes must come as proposals: this agent reads and asks, and its changes wait above for your decision.',
  comment: 'May read and discuss — comments, questions and messages — but not change the frames.',
  view: 'Read-only: this agent sees the canvas and can point at things, and changes nothing.',
}
const levelChipTitle: Record<AgentLevel, string> = {
  full: 'Writes land directly',
  propose: 'Writes arrive here as proposals',
  comment: 'May discuss, may not change frames',
  view: 'Read-only',
}
const LEVELS_BLURB =
  'How far each agent may go here. Full is the default — an agent you have not narrowed writes to the canvas directly.'

/* The tools whose own MCP annotation calls them destructive — what the editor
   offers as suggestions beside the free-text input. One list for the whole
   page load: the registry does not change while a tab is open, so opening the
   panel again must not re-ask. A failure is not cached, so the next open gets
   another try. */
let destructiveTools: string[] | null = null
let destructiveToolsInFlight: Promise<string[]> | null = null

function loadDestructiveTools(): Promise<string[]> {
  if (destructiveTools) return Promise.resolve(destructiveTools)
  if (destructiveToolsInFlight) return destructiveToolsInFlight
  const request = api
    .destructiveTools()
    .then(({ tools }) => {
      destructiveTools = tools
      return tools
    })
    .catch((err) => {
      /* suggestions are a convenience: a dead route leaves the input as the
         only way to name a tool, not a broken editor */
      console.error('destructive tools fetch failed', err)
      return []
    })
    .finally(() => {
      /* the cache check above is what answers the next caller: the settled
         request is done being interesting either way */
      destructiveToolsInFlight = null
    })
  destructiveToolsInFlight = request
  return request
}

/** The chip group hands back a plain string; the three settings are the only
 *  values it can carry, and the guard keeps that fact in the type. */
function isReviewPolicy(value: string): value is ReviewPolicy {
  return (POLICIES as readonly string[]).includes(value)
}

/** The same guard for the leash, whose four settings arrive the same way. */
function isAgentLevel(value: string): value is AgentLevel {
  return (AGENT_LEVELS as readonly string[]).includes(value)
}

/** One row of the leash list, as the server states it plus the one thing only
 *  the room knows: whether that agent is connected right now. A level outlives
 *  the connection, so an agent that stepped away keeps its row — presence is
 *  read here, never listed from. */
type AgentLevelView = AgentLevelRow & { live: boolean }

/** The list with one agent's row replaced where it stands — a save must not
 *  reshuffle the rows under the cursor. */
function withLevelRow(rows: AgentLevelRow[] | null, next: AgentLevelRow): AgentLevelRow[] {
  const list = rows ?? []
  return list.some((r) => r.agent_id === next.agent_id)
    ? list.map((r) => (r.agent_id === next.agent_id ? next : r))
    : [...list, next]
}

/** A decision already made, as the history section reads it: frame proposals
 *  and canvas proposals are one queue to the reviewer, so they share a list.
 *  `status` is carried narrowed — a row only exists once it is resolved. */
type DecidedRow =
  | { kind: 'frame'; at: number; status: ResolvedStatus; proposal: FrameProposal }
  | { kind: 'canvas'; at: number; status: ResolvedStatus; proposal: CanvasProposal }

const RESOLVED_STATUSES = ['accepted', 'rejected', 'withdrawn'] as const
type ResolvedStatus = (typeof RESOLVED_STATUSES)[number]

/** Whether a proposal is done with, and if so how — the one place the three
 *  resolved statuses are spelled, for the filter and the badge alike. */
function isResolvedStatus(status: string): status is ResolvedStatus {
  return (RESOLVED_STATUSES as readonly string[]).includes(status)
}

/** How a decision reads in the history: one word, in the tone that word wears
 *  (the brand for a change that landed, the reject ink for one that did not). */
const resolvedStatus: Record<ResolvedStatus, { label: string; tone: string }> = {
  accepted: { label: 'accepted', tone: 'border-brand/40 text-brand' },
  rejected: { label: 'rejected', tone: 'border-accent-ink/40 text-accent-ink' },
  withdrawn: { label: 'withdrawn', tone: 'border-line text-ink-faint' },
}

/* A payload bigger than this folds behind a <details>: the reviewer is looking
   for the change inside it, not re-reading the whole theme or guide. */
const LARGE_DIFF_ROWS = 8
const LARGE_MARKDOWN = 700

const detailsSummary =
  'cursor-pointer font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint hover:text-ink'

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

/* ---- bulk decisions ---- */

/** One item of a bulk run: the id its resolve calls, and the headline the
 *  failure line names it by when the server refuses it. */
type BulkItem = { id: string; label: string }

/** A proposal a bulk run could not land: which queue asked for the run, which
 *  proposal it failed on, and what the server said about it. */
type BulkFailure = BulkItem & { key: string; message: string }

/** Hunks the server refused to apply, grouped by the agent whose patch they
 *  came from — a bulk accept resolves a whole queue at once, so the report the
 *  panel holds is one entry per agent, not one per decision. */
type HunkReport = { agentName: string; skipped: { index: number; reason: string }[] }

/** The proposals a bulk run could not land, listed under the header that asked
 *  for it: each line names the proposal and why it is still in the queue, so a
 *  refusal mid-run is read where the decision was made. */
function BulkFailures({ failures }: { failures: BulkFailure[] }) {
  if (!failures.length) return null
  return (
    <div className="mb-1.5 text-[11.5px] leading-[1.45] text-accent-ink">
      {failures.map((failure) => (
        <p key={failure.id}>
          <b className="font-semibold">{failure.label}</b> — {failure.message}
        </p>
      ))}
    </div>
  )
}

/** The Review tab: what an agent write must clear before it lands (the policy,
 *  which only the owner sets), the decisions waiting — questions an agent is
 *  blocked on, canvas-level changes, frame changes — and the record of what
 *  was already decided. */
export function ReviewPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const ownerId = useStore((s) => s.canvas?.ownerId)
  const reviewPolicy = useStore((s) => s.reviewPolicy)
  /* The queue is a write surface: a viewer reads the proposals, the diffs and
     the history, and every decision that would land a change is not rendered. */
  const readOnly = useStore(isReadOnly)
  const approvalTools = useStore((s) => s.approvalTools)
  const proposals = useStore((s) => s.frameProposals)
  const canvasProposals = useStore((s) => s.canvasProposals)
  const questions = useStore((s) => s.questions)
  const frames = useStore((s) => s.canvas?.frames)
  /* who is in the room, to say which of the leashed agents is here — the rows
     themselves come from the server, this only annotates them */
  const presences = useStore((s) => s.presences)
  const { data: session } = authClient.useSession()
  const isOwner = !!ownerId && ownerId === session?.user?.id
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [policyError, setPolicyError] = useState('')
  /* The leash list, from the server rather than the room: presence carries no
     agent id, so the GET is the only place a row and the id it is set by come
     from together. null until the first answer — a block that has not read
     anything yet says nothing rather than "no agents". */
  const [agentLevelRows, setAgentLevelRows] = useState<AgentLevelRow[] | null>(null)
  const [savingLevel, setSavingLevel] = useState<string | null>(null)
  const [levelError, setLevelError] = useState('')
  const [toolDraft, setToolDraft] = useState('')
  /* the destructive-declaring tool names, offered under the input so an owner
     does not have to recall them. Seeded from the shared cache, so reopening
     the panel shows the suggestions without a re-request */
  const [suggestedTools, setSuggestedTools] = useState<string[]>(destructiveTools ?? [])
  const [expiredOpen, setExpiredOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  /* Hunks the server refused when a patch was accepted — its old_str no longer
     matched the frame, usually because the frame moved on. Held here, not on
     the card: the card unmounts the moment its proposal resolves. One entry
     per agent, because a bulk accept decides a whole queue at once. */
  const [hunkReports, setHunkReports] = useState<HunkReport[]>([])
  /* The bulk run in flight, keyed by the queue it is clearing: its own buttons
     disable while it is out, and the other queues wait their turn. */
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  /* What a bulk run could not land. Held here, not on the cards: the ones it
     failed on are the ones still in the queue, and the line names them. */
  const [bulkErrors, setBulkErrors] = useState<BulkFailure[]>([])

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

  /* the suggestions live beside the tool list, so nothing is asked for while
     the policy is off or a viewer is reading — the same branch that renders
     the input is the one that wants them */
  useEffect(() => {
    if (readOnly || reviewPolicy === 'off') return
    let live = true
    void loadDestructiveTools().then((tools) => {
      if (live) setSuggestedTools(tools)
    })
    return () => {
      live = false
    }
  }, [readOnly, reviewPolicy])

  /* The leash list, read for the owner who sets it — and re-read when the
     agents in the room change, so one that connects while the panel is open
     appears without reopening it. Keyed by the agents themselves rather than
     by presence at large, so a heartbeat is not a request. A route that is not
     there yet answers with nothing to leash, which is the empty state rather
     than an error: the panel has no hand in whether the server has it. */
  const agentNamesHere = Object.values(presences)
    .filter((p) => p.kind === 'agent')
    .map((p) => `${p.owner ?? ''}::${p.name}`)
    .sort()
    .join('|')
  useEffect(() => {
    if (!canvasId || !isOwner) return
    let live = true
    void api
      .agentLevels(canvasId)
      .then((res) => {
        if (live) setAgentLevelRows(res.levels)
      })
      .catch(() => {
        if (live) setAgentLevelRows([])
      })
    return () => {
      live = false
    }
  }, [canvasId, isOwner, agentNamesHere])

  const awaiting = useMemo(() => proposals.filter((p) => p.status === 'pending' || p.status === 'stale'), [proposals])
  const pendingCanvas = useMemo(() => canvasProposals.filter((p) => p.status === 'pending'), [canvasProposals])
  const open = useMemo(() => questions.filter((q) => q.status === 'open'), [questions])
  /* a question whose wait ran out: the agent moved on, but a late answer still
     reaches it on its next tool call, so it stays answerable down here */
  const expired = useMemo(() => questions.filter((q) => q.status === 'expired'), [questions])
  /* what was decided, newest decision first — frame and canvas proposals
     alike, because the queue above is one queue from the reviewer's side */
  const decided = useMemo(() => {
    const rows: DecidedRow[] = []
    for (const p of proposals)
      if (isResolvedStatus(p.status))
        rows.push({ kind: 'frame', at: p.resolvedAt ?? p.at, status: p.status, proposal: p })
    for (const p of canvasProposals)
      if (isResolvedStatus(p.status))
        rows.push({ kind: 'canvas', at: p.resolvedAt ?? p.createdAt, status: p.status, proposal: p })
    return rows.sort((a, b) => b.at - a.at)
  }, [proposals, canvasProposals])
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

  /* The leash rows are the server's list, in its order: it is the only place
     an agent id and a level come from together. Presence only says which of
     those agents is in the room right now — a level outlives the connection,
     so an agent that stepped away still gets its row. */
  const agentRows = useMemo<AgentLevelView[]>(
    () =>
      (agentLevelRows ?? []).map((row) => ({
        ...row,
        live: Object.values(presences).some(
          (p) => p.kind === 'agent' && p.name === row.name && (!p.owner || !row.owner || p.owner === row.owner),
        ),
      })),
    [agentLevelRows, presences],
  )

  /* the header mark reads like the policy's shield: the brand while somebody
     here is leashed, muted while nobody is */
  const leashed = agentRows.some((r) => r.level !== 'full')

  if (!canvasId) return null

  function reportSkippedHunks(agentName: string, skipped: { index: number; reason: string }[]) {
    setHunkReports(skipped.length ? [{ agentName, skipped }] : [])
  }

  /* A bulk decision runs a queue in turn and does not stop at the first
     refusal: each response lands in the store as it arrives, through the same
     call the card's own button makes, so the queue and the history move one
     decision at a time. What the server refused is named under the header that
     asked for the run; the hunks it dropped are reported as a single card's
     would be. */
  async function resolveInTurn<T extends BulkItem>(
    key: string,
    items: T[],
    resolveOne: (item: T) => Promise<HunkReport | null>,
  ) {
    if (bulkBusy) return
    setBulkBusy(key)
    setBulkErrors((prev) => prev.filter((e) => e.key !== key))
    const failed: BulkFailure[] = []
    const reports = new Map<string, { index: number; reason: string }[]>()
    for (const item of items) {
      try {
        const report = await resolveOne(item)
        if (report) reports.set(report.agentName, [...(reports.get(report.agentName) ?? []), ...report.skipped])
      } catch (e) {
        failed.push({
          key,
          id: item.id,
          label: item.label,
          message: e instanceof ApiError && e.body.error ? String(e.body.error) : 'Could not resolve that proposal.',
        })
      }
    }
    if (reports.size) setHunkReports([...reports].map(([agentName, skipped]) => ({ agentName, skipped })))
    if (failed.length) setBulkErrors((prev) => [...prev.filter((e) => e.key !== key), ...failed])
    setBulkBusy(null)
  }

  /* Every proposal in one frame's queue, decided in turn. Accepting mirrors the
     card's own primary action — a stale proposal needs the same force, and a
     patch carries all of its hunks, because "all" is the whole proposal. */
  function resolveFrameGroup(key: string, list: FrameProposal[], accept: boolean) {
    if (!canvasId) return
    void resolveInTurn(
      key,
      list.map((p) => ({ ...p, label: p.summary })),
      async (p) => {
        const edits = p.mode === 'patch' ? (p.edits ?? []) : []
        const res = await api.resolveFrameProposal(canvasId, p.id, accept, {
          ...(accept && p.status === 'stale' ? { force: true } : {}),
          ...(accept && edits.length ? { hunks: edits.map((_, index) => ({ index, accept: true })) } : {}),
        })
        /* the decision lands in the store from the room's broadcast; taking it
           from the response too means the queue and the history move even when
           the socket is between connections */
        useStore.getState().upsertFrameProposal(res)
        return res.skipped?.length ? { agentName: p.agentName, skipped: res.skipped } : null
      },
    )
  }

  /* The canvas-level queue, accepted in turn — keyed apart from the frame
     queues, which key on a frame id. */
  function resolveCanvasGroup(list: CanvasProposal[]) {
    if (!canvasId) return
    void resolveInTurn(
      'canvas',
      list.map((p) => ({ ...p, label: canvasHeadline(p, frames) })),
      async (p) => {
        useStore.getState().upsertCanvasProposal(await api.resolveCanvasProposal(canvasId, p.id, true))
        return null
      },
    )
  }

  /* One write for the whole policy: the setting and its extra tool names are
     one fact on the canvas, so a change sends both. The store takes the new
     value first — the control answers the click — then the server's own value
     lands over it; a refused write rolls the optimistic one back. */
  function savePolicy(policy: ReviewPolicy, tools: string[]) {
    if (!canvasId || !isOwner || savingPolicy) return
    const before = { policy: reviewPolicy, tools: approvalTools }
    setSavingPolicy(true)
    setPolicyError('')
    useStore.getState().setReviewPolicyLocal(policy, tools)
    api
      .setReviewPolicy(canvasId, policy, tools)
      .then((res) => useStore.getState().setReviewPolicyLocal(res.reviewPolicy, res.approvalTools))
      .catch((e) => {
        useStore.getState().setReviewPolicyLocal(before.policy, before.tools)
        setPolicyError(
          e instanceof ApiError && e.body.error ? String(e.body.error) : 'Could not save the review policy.',
        )
      })
      .finally(() => setSavingPolicy(false))
  }

  /* One more name in the gated list — the end both ways in reach: the draft
     the input commits, and a suggestion chip's own name. */
  function addGatedTool(name: string) {
    if (!name || !isOwner || savingPolicy || approvalTools.includes(name)) return
    savePolicy(reviewPolicy, [...approvalTools, name])
  }

  /* One tool name typed into the chip input: committed on Enter, comma or blur,
     and dropped when it is already gated — the same name twice is one gate.
     The policy itself is untouched: this only edits the list it gates by. */
  function addApprovalTool() {
    const name = toolDraft.trim().replace(/,+$/, '')
    setToolDraft('')
    addGatedTool(name)
  }

  /* One agent's leash, saved the way the policy is: the row answers the click,
     the server's own answer lands over it, and a refused write puts the level
     back the way it was. `full` is sent like any other — the server drops the
     row it replaces, so the control and the default agree with no branch. */
  function saveLevel(row: AgentLevelRow, level: AgentLevel) {
    if (!canvasId || savingLevel) return
    const id = row.agent_id
    const before = agentLevelRows
    /* the stamp is the server's to write: until its answer lands the row keeps
       the one it had, and what the click changed is the level */
    const next = { ...row, level }
    setSavingLevel(id)
    setLevelError('')
    setAgentLevelRows((rows) => withLevelRow(rows, next))
    api
      .setAgentLevel(canvasId, id, level)
      .then((res) => setAgentLevelRows((rows) => withLevelRow(rows, { ...next, set_at: res.set_at })))
      .catch((e) => {
        setAgentLevelRows(before)
        setLevelError(
          e instanceof ApiError && e.body.error ? String(e.body.error) : 'Could not save that agent’s level.',
        )
      })
      .finally(() => setSavingLevel(null))
  }

  /* the declarations the list does not gate yet — a suggestion for a name
     already gated would be a button that can only do nothing */
  const suggestions = suggestedTools.filter((tool) => !approvalTools.includes(tool))

  return (
    <PanelBody className="flex flex-col pb-3">
      <div className="border-b border-line-soft px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <ShieldIcon
            className={cn('mt-px size-4 flex-none', reviewPolicy !== 'off' ? 'text-brand' : 'text-ink-faint')}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold text-ink">{policyHeading[reviewPolicy]}</div>
            <p className="mt-1 text-[11.5px] leading-[1.45] text-ink-soft">{policyBlurb[reviewPolicy]}</p>
          </div>
        </div>
        {/* The policy is the owner's write and a read-only viewer's click
            could never land. The heading and blurb above still say what the
            canvas is set to; the switch itself is not rendered. */}
        {readOnly ? (
          <p className="mt-2.5 text-[11.5px] leading-[1.45] text-ink-soft">Read only — sign in to edit this canvas.</p>
        ) : (
          <>
            <ToggleChipGroup
              className="mt-3"
              value={reviewPolicy}
              aria-label="Review policy"
              disabled={!isOwner || savingPolicy}
              title={isOwner ? undefined : OWNER_ONLY}
              onValueChange={(next) => {
                /* off gates nothing, so it names no tools — the server clears the
                   list with the policy, and the optimistic write says the same */
                if (isReviewPolicy(next)) savePolicy(next, next === 'off' ? [] : approvalTools)
              }}
            >
              {POLICIES.map((policy) => (
                <ToggleChipItem
                  key={policy}
                  value={policy}
                  className="text-[12px]"
                  title={isOwner ? policyChipTitle[policy] : OWNER_ONLY}
                >
                  {policyChipLabel[policy]}
                </ToggleChipItem>
              ))}
            </ToggleChipGroup>
            {reviewPolicy !== 'off' && (
              <>
                <Field
                  label={reviewPolicy === 'destructive' ? 'Also gate these tools' : 'Extra gated tools'}
                  htmlFor="review-approval-tools"
                  hint={
                    (reviewPolicy === 'destructive'
                      ? 'Tool names gated on top of the ones that declare themselves destructive. Enter adds one; ✕ removes it.'
                      : 'Every write is gated already — these names stay gated if you narrow the policy to destructive. Enter adds one; ✕ removes it.') +
                    (suggestions.length > 0
                      ? ' The suggestions below are the tools that declare themselves destructive.'
                      : '')
                  }
                  className="mt-3"
                >
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 focus-within:border-ink">
                    {approvalTools.map((tool) => (
                      <Badge key={tool} className="gap-1 pr-1">
                        {tool}
                        <button
                          type="button"
                          className="text-ink-faint hover:text-accent-ink"
                          aria-label={`Stop gating ${tool}`}
                          disabled={!isOwner || savingPolicy}
                          onClick={() =>
                            savePolicy(
                              reviewPolicy,
                              approvalTools.filter((t) => t !== tool),
                            )
                          }
                        >
                          ✕
                        </button>
                      </Badge>
                    ))}
                    <Input
                      id="review-approval-tools"
                      variant="bare"
                      inputSize="sm"
                      className="min-w-[104px] flex-1 font-mono md:text-[12px]"
                      value={toolDraft}
                      placeholder="tool_name"
                      spellCheck={false}
                      disabled={!isOwner || savingPolicy}
                      onBlur={addApprovalTool}
                      onChange={(e) => setToolDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          addApprovalTool()
                        }
                      }}
                    />
                  </div>
                </Field>
                {/* the names an owner would otherwise have to recall, one tap
                    each, saved through the path the input commits with */}
                {suggestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {suggestions.map((tool) => (
                      <Button
                        key={tool}
                        variant="ghost"
                        size="pill"
                        className="font-mono font-normal"
                        disabled={!isOwner || savingPolicy}
                        title={`${tool} declares itself destructive`}
                        onClick={() => addGatedTool(tool)}
                      >
                        {tool}
                      </Button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
        {policyError && <p className="mt-2 text-[11.5px] leading-[1.45] text-accent-ink">{policyError}</p>}
      </div>

      {/* The leash, under the gate: how far each agent may go here, which only
          the owner sets. The rows come from the server's own list — presence
          says who is in the room, but the id a save writes to and the level it
          writes are the server's to state, and the room carries neither. */}
      {isOwner && (
        <div className="border-b border-line-soft px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <span className={cn('mt-px flex-none', leashed ? 'text-brand' : 'text-ink-faint')}>
              <AgentIcon name="agent" size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-ink">Agent levels</div>
              <p className="mt-1 text-[11.5px] leading-[1.45] text-ink-soft">{LEVELS_BLURB}</p>
            </div>
          </div>
          {/* nothing is listed until the server's list has been read: a row
              before that would have no level to show, and a level invented
              here would be one nobody set */}
          {agentLevelRows !== null &&
            (agentRows.length === 0 ? (
              <p className="mt-2.5 text-[11.5px] leading-[1.45] text-ink-faint">No agents on this canvas yet.</p>
            ) : (
              agentRows.map((row) => (
                <div key={row.agent_id} className="mt-3">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[12.5px] font-medium text-ink">{row.name}</span>
                    {row.owner && <span className="truncate text-[11px] text-ink-faint">via {row.owner}</span>}
                    {/* the room's own reading of the same agent: the level
                        stands whether or not it is connected, and a level set
                        on an agent that is here takes effect on its next call */}
                    <span
                      className="ml-auto flex flex-none items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-faint"
                      title={
                        row.live ? 'Connected to this canvas now' : 'Not connected — the level is kept for its return'
                      }
                    >
                      <Dot tone={row.live ? 'done' : 'muted'} size="sm" />
                      {row.live ? 'here' : 'away'}
                    </span>
                  </div>
                  <ToggleChipGroup
                    className="mt-2 gap-1.5"
                    value={row.level}
                    aria-label={`Level for ${row.name}`}
                    disabled={savingLevel !== null}
                    onValueChange={(next) => {
                      if (isAgentLevel(next)) saveLevel(row, next)
                    }}
                  >
                    {AGENT_LEVELS.map((level) => (
                      <ToggleChipItem
                        key={level}
                        value={level}
                        className="px-2.5 py-1 text-[12px]"
                        title={levelChipTitle[level]}
                      >
                        {levelChipLabel[level]}
                      </ToggleChipItem>
                    ))}
                  </ToggleChipGroup>
                  <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-soft">{levelBlurb[row.level]}</p>
                </div>
              ))
            ))}
          {levelError && <p className="mt-2 text-[11.5px] leading-[1.45] text-accent-ink">{levelError}</p>}
        </div>
      )}

      {open.length === 0 && expired.length === 0 && awaiting.length === 0 && pendingCanvas.length === 0 && (
        <div className="px-4 py-6 text-center text-[13px] text-ink-faint">
          {reviewPolicy === 'off'
            ? 'Nothing waiting for review. Agents write directly — pick a setting above to gate their changes.'
            : 'Nothing waiting for review. Agent changes land here for your decision.'}
        </div>
      )}

      {hunkReports.map((report) => (
        <div
          key={report.agentName}
          className="mx-4 mt-3 rounded-[10px] border border-accent-ink/40 bg-white px-3 py-2.5 text-[11.5px] leading-[1.45]"
        >
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-ink-soft">
              <b className="text-ink">
                {report.skipped.length} hunk{report.skipped.length === 1 ? '' : 's'} of {report.agentName}
                &rsquo;s change did not land:
              </b>{' '}
              {report.skipped.map((s) => `#${s.index + 1} ${s.reason}`).join(' · ')}
            </span>
            <Button
              variant="bare"
              className="flex-none px-1 py-0 text-[11px] hover:bg-transparent"
              title="Dismiss"
              onClick={() => setHunkReports((prev) => prev.filter((r) => r.agentName !== report.agentName))}
            >
              ✕
            </Button>
          </div>
        </div>
      ))}

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

      {expired.length > 0 && (
        <Collapsible className="mt-3" open={expiredOpen} onOpenChange={setExpiredOpen}>
          <PanelDisclosure className="px-4">
            <span>Expired questions</span>
            <Badge>{expired.length}</Badge>
          </PanelDisclosure>
          <CollapsibleContent>
            {expired.map((q) => (
              <QuestionRow key={q.id} canvasId={canvasId} question={q} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {groups.map(([key, list]) => {
        const first = list[0]!
        const stale = list.some((p) => p.status === 'stale')
        return (
          <div key={key} className="mt-3 px-4">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
                {first.frameId ? (frames?.find((f) => f.id === first.frameId)?.name ?? 'frame') : 'new frame'}
              </span>
              {/* one frame's queue, decided whole: the same resolve each card
                  runs, in turn, so a refusal leaves the rest of them there */}
              {!readOnly && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[11.5px]"
                    disabled={bulkBusy !== null}
                    onClick={() => resolveFrameGroup(key, list, false)}
                  >
                    Reject all
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    className="text-[11.5px]"
                    disabled={bulkBusy !== null}
                    title={stale ? 'Accepts the stale ones too — they would overwrite newer work' : undefined}
                    onClick={() => resolveFrameGroup(key, list, true)}
                  >
                    Accept all
                  </Button>
                </>
              )}
            </div>
            <BulkFailures failures={bulkErrors.filter((e) => e.key === key && list.some((p) => p.id === e.id))} />
            {list.map((p) => (
              <ProposalCard key={p.id} canvasId={canvasId} proposal={p} onSkipped={reportSkippedHunks} />
            ))}
          </div>
        )
      })}

      {pendingCanvas.length > 0 && (
        <>
          <ListSection>
            <span>Canvas changes</span>
            <span className="flex flex-none items-center gap-2">
              <Badge tone="accent">{pendingCanvas.length}</Badge>
              {/* the whole canvas queue at once: the changes are independent of
                  each other, so one refusal must not hold up the rest */}
              {!readOnly && (
                <Button
                  variant="primary"
                  size="sm"
                  className="text-[11.5px] font-bold"
                  disabled={bulkBusy !== null}
                  onClick={() => resolveCanvasGroup(pendingCanvas)}
                >
                  Accept all
                </Button>
              )}
            </span>
          </ListSection>
          <div className="px-4">
            <BulkFailures
              failures={bulkErrors.filter((e) => e.key === 'canvas' && pendingCanvas.some((p) => p.id === e.id))}
            />
            {pendingCanvas.map((p) => (
              <CanvasProposalCard key={p.id} canvasId={canvasId} proposal={p} />
            ))}
          </div>
        </>
      )}

      {decided.length > 0 && (
        <Collapsible className="mt-3" open={historyOpen} onOpenChange={setHistoryOpen}>
          <PanelDisclosure className="px-4">
            <span>Review history</span>
            <Badge>{decided.length}</Badge>
          </PanelDisclosure>
          <CollapsibleContent>
            <div className="px-4">
              {decided.map((row) =>
                row.kind === 'frame' ? (
                  <ResolvedFrameCard key={row.proposal.id} proposal={row.proposal} status={row.status} />
                ) : (
                  <ResolvedCanvasCard key={row.proposal.id} proposal={row.proposal} status={row.status} />
                ),
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
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
  /* Answering is a comment-level write — the server takes the answer at that
     intent — so a viewer without it reads the question and only that. */
  const canNote = useStore(canComment)
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
      {question.status === 'expired' && (
        <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-soft">
          {question.agentName} stopped waiting for this. An answer still reaches it on its next tool call.
        </p>
      )}
      {canNote && choices.length > 0 && (
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
      {canNote && (choices.length === 0 || question.allowOther) ? (
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
      {canNote ? (
        <div className="mt-2.5 flex justify-end">
          <Button variant="primary" size="sm" className="text-[11.5px]" disabled={!text || busy} onClick={submit}>
            Answer
          </Button>
        </div>
      ) : (
        <p className="mt-2.5 text-[11.5px] leading-[1.45] text-ink-soft">
          Read only — sign in to comment on this canvas.
        </p>
      )}
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
  /* Deciding a proposal is a write, so a viewer reads the summary, the diff
     and the hunks, and is offered no accept, no reject and no hunk choice. */
  const readOnly = useStore(isReadOnly)
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
        /* the decision lands in the store from the room's broadcast; taking it
           from the response too means the queue and the history move even when
           the socket is between connections */
        useStore.getState().upsertFrameProposal(res)
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
    /* A and R are the decision keys: a viewer's card has no decision to take */
    if (readOnly) return
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

/* ---- canvas-level proposals ---- */

/** One page operation a `pages` proposal carries — the exact call its accept
 *  makes, which is why the card shows the operation rather than a page list. */
type PageOp = {
  op: 'create' | 'rename' | 'delete' | 'move_frame'
  name?: string
  pageId?: string
  frameId?: string
}

type Breakpoint = { name: string; min_width: number }

/* A canvas proposal's payload and `before` are `unknown` on the wire: the
   server checks each kind's shape when the proposal is made, so a reader here
   only has to be defensive — it never validates and never invents a default. */
const asTokens = (value: unknown): DesignTokens | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as DesignTokens) : null

const asGuideline = (value: unknown): { name: string; markdown: string } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { name, markdown } = value as { name?: unknown; markdown?: unknown }
  return typeof name === 'string' && typeof markdown === 'string' ? { name, markdown } : null
}

const asBreakpoints = (value: unknown): Breakpoint[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const { name, min_width } = entry as { name?: unknown; min_width?: unknown }
        return typeof name === 'string' && typeof min_width === 'number' ? [{ name, min_width }] : []
      })
    : []

const asPages = (value: unknown): { id: string; name: string }[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const { id, name } = entry as { id?: unknown; name?: unknown }
        return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : []
      })
    : []

const asPageOp = (value: unknown): PageOp | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { op, name, pageId, frameId } = value as { op?: unknown; name?: unknown; pageId?: unknown; frameId?: unknown }
  if (op !== 'create' && op !== 'rename' && op !== 'delete' && op !== 'move_frame') return null
  return {
    op,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof pageId === 'string' ? { pageId } : {}),
    ...(typeof frameId === 'string' ? { frameId } : {}),
  }
}

/** The name a page op's id had when the proposal was made: `before` is the
 *  page-list snapshot the server stored, so a rename can show both names. */
function pageNameOf(pages: { id: string; name: string }[], pageId: string | undefined): string {
  return pages.find((p) => p.id === pageId)?.name ?? 'a page'
}

/** Every value a token set carries, flattened to one name -> display value map
 *  so a proposal's diff is a plain comparison — and a new token section is a
 *  line here, not another branch in the renderer. */
function tokenValues(tokens: DesignTokens | null): Record<string, { value: string; swatch?: boolean }> {
  const out: Record<string, { value: string; swatch?: boolean }> = {}
  if (!tokens) return out
  for (const [name, value] of Object.entries(tokens.colors ?? {})) out[`colors.${name}`] = { value, swatch: true }
  for (const [slot, font] of Object.entries(tokens.fonts ?? {})) if (font) out[`font.${slot}`] = { value: font }
  const scale = (key: string, values: (number | string)[] | undefined, sep = ', ') => {
    if (values?.length) out[key] = { value: values.join(sep) }
  }
  scale('spacing', tokens.spacing)
  scale('radii', tokens.radii)
  scale('shadows', tokens.shadows, ' · ')
  scale('type.size', tokens.type?.size)
  scale('type.weight', tokens.type?.weight)
  scale('type.leading', tokens.type?.leading)
  return out
}

/** One line saying what a canvas proposal does, in the terms its kind means:
 *  the tokens it sets, the doc it writes, the widths it declares, the page op
 *  it runs. The card's headline and its history row alike. */
function canvasHeadline(proposal: CanvasProposal, frames: Frame[] | undefined): string {
  switch (proposal.kind) {
    case 'tokens':
      return asTokens(proposal.payload) ? 'Set the canvas design tokens' : 'Clear the canvas design tokens'
    case 'guidelines': {
      const doc = asGuideline(proposal.payload)
      if (!doc) return 'Write a style guide'
      return doc.markdown ? `Write the “${doc.name}” style guide` : `Delete the “${doc.name}” style guide`
    }
    case 'breakpoints': {
      const list = asBreakpoints(proposal.payload)
      return list.length ? `Set ${list.length} breakpoint${list.length === 1 ? '' : 's'}` : 'Clear the breakpoints'
    }
    case 'pages': {
      const op = asPageOp(proposal.payload)
      if (!op) return 'Change the pages'
      if (op.op === 'create') return `Create the page “${op.name ?? ''}”`
      const pages = asPages(proposal.before)
      if (op.op === 'delete') return `Delete the page “${pageNameOf(pages, op.pageId)}”`
      if (op.op === 'rename') return `Rename the page “${pageNameOf(pages, op.pageId)}” to “${op.name ?? ''}”`
      const frame = frames?.find((f) => f.id === op.frameId)?.name ?? 'a frame'
      return `Move “${frame}” to the page “${pageNameOf(pages, op.pageId)}”`
    }
  }
}

/** The palette, type and scales a tokens proposal changes, one row each: the
 *  value the canvas holds beside the one proposed. A token set is mostly
 *  unchanged, so only what differs is listed; a long diff folds away. */
function TokenDiff({ before, after }: { before: DesignTokens | null; after: DesignTokens | null }) {
  const from = tokenValues(before)
  const to = tokenValues(after)
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()
  const rows = keys.flatMap((key) => {
    const was = from[key]
    const next = to[key]
    return was?.value === next?.value ? [] : [{ key, was, next }]
  })
  if (!rows.length) return <p className="mt-2 text-[11.5px] text-ink-faint">The token set is unchanged.</p>
  const list = (
    <div className="mt-2 flex flex-col gap-1">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px]">
          <span className="text-ink-soft">{row.key}</span>
          <span className="flex flex-wrap items-baseline gap-1.5">
            {row.was?.swatch && (
              <span
                aria-hidden
                className="size-3 flex-none rounded-full border border-line"
                style={{ background: row.was.value }}
              />
            )}
            <span className="text-ink-faint line-through">{row.was?.value ?? '∅'}</span>
            <span className="text-ink-faint">→</span>
            {row.next?.swatch && (
              <span
                aria-hidden
                className="size-3 flex-none rounded-full border border-line"
                style={{ background: row.next.value }}
              />
            )}
            <span className="font-semibold text-ink">{row.next?.value ?? '∅'}</span>
          </span>
        </div>
      ))}
    </div>
  )
  return rows.length > LARGE_DIFF_ROWS ? (
    <details className="mt-2">
      <summary className={detailsSummary}>{rows.length} token values change</summary>
      {list}
    </details>
  ) : (
    list
  )
}

/** The guide doc a proposal writes: its slug and size, the markdown itself,
 *  and the version it replaces. A long doc folds behind its summary — a
 *  reviewer reads the change, not the whole style guide. */
function GuidelineChange({
  before,
  after,
}: {
  before: string | null
  after: { name: string; markdown: string } | null
}) {
  if (!after) return null
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-baseline gap-2 font-mono text-[11px] text-ink-soft">
        <span>{after.name}</span>
        <span className="text-ink-faint">{after.markdown ? `${after.markdown.length} chars` : 'deletes the doc'}</span>
      </div>
      {after.markdown &&
        (after.markdown.length > LARGE_MARKDOWN ? (
          <details className="mt-2">
            <summary className={detailsSummary}>Preview the guide</summary>
            <MarkdownBlock className="mt-2">{after.markdown}</MarkdownBlock>
          </details>
        ) : (
          <MarkdownBlock className="mt-2">{after.markdown}</MarkdownBlock>
        ))}
      {before && (
        <details className="mt-2">
          <summary className={detailsSummary}>Before — {before.length} chars</summary>
          <MarkdownBlock className="mt-2">{before}</MarkdownBlock>
        </details>
      )}
    </div>
  )
}

/** The widths a proposal declares, as chips — the server sorts them ascending,
 *  so the list reads mobile-first. The widths they replace fold away. */
function BreakpointChange({ before, after }: { before: Breakpoint[]; after: Breakpoint[] }) {
  const chips = (list: Breakpoint[]) => (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {list.map((b) => (
        <Badge key={b.name}>
          {b.name} · {b.min_width}px
        </Badge>
      ))}
    </div>
  )
  if (!after.length)
    return (
      <div className="mt-2 text-[11.5px] leading-[1.45] text-ink-soft">
        Clears the breakpoints — the canvas designs for one width.
        {before.length > 0 && (
          <details className="mt-2">
            <summary className={detailsSummary}>Before — {before.length}</summary>
            {chips(before)}
          </details>
        )}
      </div>
    )
  const unchanged =
    before.length === after.length &&
    before.every((b, i) => b.name === after[i]?.name && b.min_width === after[i]?.min_width)
  return (
    <div className="mt-2">
      {chips(after)}
      {before.length > 0 && !unchanged && (
        <details className="mt-2">
          <summary className={detailsSummary}>Before — {before.length}</summary>
          {chips(before)}
        </details>
      )}
    </div>
  )
}

/** A `pages` proposal runs one page op; the operation is the card's headline,
 *  so what is left to show is which pages the canvas had when it was proposed
 *  — the snapshot the server stored, which is what the op names. */
function PageChange({ before }: { before: unknown }) {
  const pages = asPages(before)
  if (!pages.length) return null
  return (
    <details className="mt-2">
      <summary className={detailsSummary}>Pages when proposed — {pages.length}</summary>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {pages.map((page) => (
          <Badge key={page.id} tone="outline">
            {page.name}
          </Badge>
        ))}
      </div>
    </details>
  )
}

/** What a canvas proposal changes, rendered per kind: the token values that
 *  differ, the guide's markdown, the breakpoint widths, the page op. */
function CanvasChange({ proposal }: { proposal: CanvasProposal }) {
  switch (proposal.kind) {
    case 'tokens':
      return <TokenDiff before={asTokens(proposal.before)} after={asTokens(proposal.payload)} />
    case 'guidelines':
      return (
        <GuidelineChange
          before={typeof proposal.before === 'string' ? proposal.before : null}
          after={asGuideline(proposal.payload)}
        />
      )
    case 'breakpoints':
      return <BreakpointChange before={asBreakpoints(proposal.before)} after={asBreakpoints(proposal.payload)} />
    case 'pages':
      return <PageChange before={proposal.before} />
  }
}

/** One canvas-level change waiting for a decision — the tokens, a guide doc,
 *  the breakpoints or a page op, against the value it replaces. Accepting
 *  applies it through the same setters a human edit uses; a reject may carry a
 *  note the agent reads back. A and R decide it, as on a frame proposal. */
function CanvasProposalCard({ canvasId, proposal }: { canvasId: string; proposal: CanvasProposal }) {
  const frames = useStore((s) => s.canvas?.frames)
  /* a canvas proposal carries no color of its own: the agent's name is the
     identity, and the palette turns it into the same color everywhere else */
  const color = colorFor(proposal.proposedBy)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [error, setError] = useState('')

  function resolve(accept: boolean) {
    setBusy(true)
    setError('')
    const trimmed = note.trim()
    api
      .resolveCanvasProposal(canvasId, proposal.id, accept, !accept && trimmed ? trimmed : undefined)
      /* the resolved proposal lands in the store from the response and from the
         room's broadcast alike; taking it here drops it out of the queue the
         moment the decision is made */
      .then((res) => useStore.getState().upsertCanvasProposal(res))
      .catch((e) =>
        setError(e instanceof ApiError && e.body.error ? String(e.body.error) : 'Could not resolve that proposal.'),
      )
      .finally(() => setBusy(false))
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey || busy) return
    const key = e.key.toLowerCase()
    if (key !== 'a' && key !== 'r') return
    e.preventDefault()
    if (key === 'a') resolve(true)
    else if (rejecting) resolve(false)
    else setRejecting(true)
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="group mt-2 rounded-[12px] border border-line bg-surface px-3.5 py-3 shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-[0.06em]"
          style={{ color }}
        >
          <AgentIcon name={proposal.proposedBy} size={11} color={color} />
          {proposal.proposedBy}
        </span>
        <span className="font-mono text-[10.5px] text-ink-faint">
          {canvasKindLabel[proposal.kind]} · {timeAgo(proposal.createdAt)}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] font-semibold leading-[1.45] text-ink">{canvasHeadline(proposal, frames)}</p>
      <CanvasChange proposal={proposal} />
      {error && <div className="mt-2 text-[11.5px] text-accent-ink">{error}</div>}
      {rejecting && (
        <Field label="Why? (optional — the agent reads this)" className="mt-2.5">
          <Textarea
            className="min-h-[44px] text-[12.5px]"
            value={note}
            placeholder="Wrong palette, keep the widths we have…"
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
            <Button variant="primary" size="sm" className="text-[11.5px]" disabled={busy} onClick={() => resolve(true)}>
              Accept
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/* ---- resolved proposals ---- */

/** One decision already made: what was proposed, who proposed it, how it was
 *  resolved and the note the agent was given. Read-only — the queue above is
 *  where a decision is made. */
function ResolvedCard({
  status,
  at,
  agentName,
  color,
  kind,
  summary,
  note,
}: {
  status: ResolvedStatus
  at: number
  agentName: string
  color: string
  kind: string
  summary: string
  note?: string
}) {
  return (
    <div className="mt-2 rounded-[12px] border border-line bg-surface px-3.5 py-3 shadow-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="inline-flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-[0.06em]"
          style={{ color }}
        >
          <AgentIcon name={agentName} size={11} color={color} />
          {agentName}
        </span>
        <span className="font-mono text-[10.5px] text-ink-faint">
          {kind} · {timeAgo(at)}
        </span>
        <Badge className={resolvedStatus[status].tone}>{resolvedStatus[status].label}</Badge>
      </div>
      <p className="mt-1.5 text-[12.5px] leading-[1.45] text-ink-soft">{summary}</p>
      {note && (
        <p className="mt-1.5 text-[12px] leading-[1.45] text-ink">
          <b className="font-semibold">Note:</b> {note}
        </p>
      )}
    </div>
  )
}

/** A resolved frame proposal: the frame it named, what the agent asked for. */
function ResolvedFrameCard({ proposal, status }: { proposal: FrameProposal; status: ResolvedStatus }) {
  const frameName = useStore((s) => s.canvas?.frames.find((f) => f.id === proposal.frameId)?.name)
  const what = kindLabel[proposal.kind]
  return (
    <ResolvedCard
      status={status}
      at={proposal.resolvedAt ?? proposal.at}
      agentName={proposal.agentName}
      color={proposal.color}
      kind={proposal.frameId ? `${what} · ${frameName ?? 'frame'}` : what}
      summary={proposal.summary}
      note={proposal.resolutionNote}
    />
  )
}

/** A resolved canvas-level proposal: the tokens, doc, widths or page op it
 *  asked for, in the same one line the pending card leads with. */
function ResolvedCanvasCard({ proposal, status }: { proposal: CanvasProposal; status: ResolvedStatus }) {
  const frames = useStore((s) => s.canvas?.frames)
  return (
    <ResolvedCard
      status={status}
      at={proposal.resolvedAt ?? proposal.createdAt}
      agentName={proposal.proposedBy}
      color={colorFor(proposal.proposedBy)}
      kind={canvasKindLabel[proposal.kind]}
      summary={canvasHeadline(proposal, frames)}
      note={proposal.resolutionNote}
    />
  )
}
