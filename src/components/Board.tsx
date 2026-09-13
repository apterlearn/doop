import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { timeAgo } from '../lib/time'
import {
  AGENT_ROLES,
  DEFAULT_ROLE_ID,
  PIPELINE_PRESETS,
  roleByAgentName,
  roleById,
  roleName,
} from '../../shared/agents'
import type { AgentTask, Frame, TaskUsage } from '../../shared/types'
import { posthog } from '../lib/posthog'
import { MeterLine, isResidentLimit, useAllowance } from './TeamAllowance'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Card } from './ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Dot } from './ui/dot'
import { RoleMark } from './RoleMark'

/**
 * Board view over the canvas's tasks: queued cards humans leave for agents,
 * live work (claimed cards + agent status tasks), and what's done. Cards are
 * plain AgentTask objects, so everything updates over the same ws stream.
 *
 * A card names an ordered pipeline of agents — design → copy → brand → a11y —
 * and moves down it one stage at a time; the trail on each card is the live
 * position in that pipeline.
 */

/** The queue's running order — the same order the server claims cards in:
   priority first, then the position a human dragged cards to, then arrival. */
function queueOrder(a: AgentTask, b: AgentTask): number {
  return (b.priority ?? 0) - (a.priority ?? 0) || (a.position ?? 0) - (b.position ?? 0) || a.startedAt - b.startedAt
}

const PRIORITY_OPTIONS = [
  { value: 2, label: 'High', hint: 'jumps the queue' },
  { value: 0, label: 'Normal', hint: 'the default order' },
  { value: -1, label: 'Low', hint: 'runs after everything else' },
]

/* class recipes shared across the board's cards and columns */
const colHeadCls = 'mb-3.5 flex items-baseline gap-2 border-b border-line pb-3'
const colHeadH2Cls = 'font-display text-[12px] font-[750] uppercase tracking-[0.14em]'
const countCls = 'font-mono text-[11px] text-ink-faint'
const cardBase = 'group relative px-4 py-3.5'
/* mirrors MAX_CARD_CHARS in server/actions.ts */
const MAX_CARD_CHARS = 4_000
/** What a card's run spent, as the provider reported it. Shown on the running
 *  card so a human watching a long run can see the meter move. */
function UsageLine({ usage }: { usage: TaskUsage }) {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  if (tokens === 0) return null
  return (
    <div className="mt-1 text-[11px] tabular-nums text-ink-faint">
      {tokens.toLocaleString()} tokens
      {usage.cacheRead > 0 && <span> · {usage.cacheRead.toLocaleString()} cached</span>}
      {usage.model && <span> · {usage.model}</span>}
    </div>
  )
}

const cardH3Cls =
  'line-clamp-8 break-words pr-4 font-display text-[14.5px] font-[650] leading-[1.35] tracking-[-0.01em]'
const metaCls =
  'mt-[9px] flex flex-wrap items-center gap-1.5 text-[12px] text-ink-faint [&_b]:font-[650] [&_b]:text-ink-soft'
/* the ✕ on a card: always reachable on touch, revealed on hover elsewhere */
const dismissCls =
  'absolute right-[9px] top-[9px] size-[22px] justify-center rounded-full p-0 text-xs opacity-100 hover:bg-paper-deep hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100'
const hintCls = 'text-[11.5px] text-ink-faint'

const stepPhaseCls: Record<string, string> = {
  past: 'border-line text-ink-faint opacity-55',
  queued: 'border-ink-soft text-ink-soft',
  working: 'border-brand bg-brand text-white',
  ahead: 'border-line text-ink-faint',
}

function pipelineOf(t: AgentTask): string[] {
  return t.pipeline?.length ? t.pipeline : [DEFAULT_ROLE_ID]
}

/** The repo a structured card came from — the GitHub import's cards wear it
 *  so a dozen of them read as one import, not as spam. */
function RepoTag({ task }: { task: AgentTask }) {
  if (!task.payload) return null
  return (
    <span className="inline-flex max-w-full items-center gap-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] text-ink-faint">
      ⎇ {task.payload.repo}
      {task.kind === 'design-system' ? ' · design system' : task.payload.screen ? ` · ${task.payload.screen.kind}` : ''}
    </span>
  )
}

/** Queued cards from one import (same click on the same repo), oldest first. */
/** What the card is about, when the human queued it from a canvas selection:
 *  the agent edits that frame in place instead of delivering somewhere else. */
function TargetChip({ task, frames }: { task: AgentTask; frames?: Frame[] }) {
  const ids = task.targetFrameIds ?? []
  if (ids.length === 0) return null
  return (
    <div className="mt-[9px] font-mono text-[11px] text-brand">
      → {ids.map((id) => frames?.find((f) => f.id === id)?.name ?? id).join(', ')}
    </div>
  )
}

function groupImports(queued: AgentTask[]): { key: string; cards: AgentTask[] }[] {
  const groups: { key: string; cards: AgentTask[] }[] = []
  for (const t of queued) {
    const key = t.payload?.importId ? `import:${t.payload.importId}` : t.id
    const group = groups.find((g) => g.key === key)
    if (group) group.cards.push(t)
    else groups.push({ key, cards: [t] })
  }
  return groups
}

/** The pipeline of a card with its current position marked. */
function Trail({ task, state }: { task: AgentTask; state: 'queued' | 'working' | 'done' }) {
  const pipeline = pipelineOf(task)
  const at = Math.min(task.stage ?? 0, pipeline.length - 1)
  return (
    <div className="mt-[9px] flex flex-wrap items-center gap-x-[5px] gap-y-1">
      {pipeline.map((id, i) => {
        const role = roleById(id)
        const phase = state === 'done' || i < at ? 'past' : i === at ? state : 'ahead'
        return (
          <span
            key={id}
            className={cn(
              'inline-flex items-center gap-1 whitespace-nowrap rounded-full border py-0.5 pl-1.5 pr-2 text-[11px] font-semibold',
              stepPhaseCls[phase],
              i > 0 && "before:-ml-0.5 before:mr-0.5 before:text-ink-faint before:content-['›']",
            )}
            title={role?.blurb}
          >
            <RoleMark role={role} size={13} />
            {role?.name ?? id}
          </span>
        )
      })}
    </div>
  )
}

/** The roster: who is on the team, what each one owns, and what they're on. */
function Team({ tasks, onPick }: { tasks: AgentTask[]; onPick: (id: string) => void }) {
  return (
    <div className="mb-[26px]">
      <div className="mb-3 flex items-baseline gap-2.5 border-b border-line pb-2.5">
        <h2 className={cn(colHeadH2Cls, 'text-ink-soft')}>The team</h2>
        <span className={hintCls}>Pick one to queue a card · @mention them on any element</span>
      </div>
      <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1 [scroll-snap-type:x_proximity] md:flex-wrap md:overflow-visible md:pb-0">
        {AGENT_ROLES.map((role) => {
          const working = tasks.find((t) => t.agentName === role.name && !t.endedAt && !t.failedAt && !t.cancelledAt)
          const waiting = tasks.filter(
            (t) => t.queuedBy && !t.agentName && !t.failedAt && !t.endedAt && pipelineOf(t)[t.stage ?? 0] === role.id,
          ).length
          return (
            <Button
              key={role.id}
              variant="ghost"
              className={cn(
                'w-[178px] flex-none snap-start flex-col items-start gap-[3px] whitespace-normal rounded-[12px] bg-surface px-3 py-2.5 text-left font-normal hover:bg-surface hover:shadow-card',
                working ? 'border-brand' : 'hover:border-ink-soft',
              )}
              onClick={() => onPick(role.id)}
              title={`Queue a card for ${role.name}`}
            >
              <span className="flex flex-wrap items-center gap-x-[5px] gap-y-[2px] font-display text-[13px] font-[650] tracking-[-0.01em] text-ink">
                <RoleMark role={role} size={16} />
                {role.name}
                <span className="font-mono text-[10px] font-normal text-ink-faint">@{role.id}</span>
              </span>
              <span className="text-[11.5px] leading-[1.35] text-ink-faint">{role.blurb}</span>
              <span className="mt-auto flex max-w-full items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap pt-1.5 font-mono text-[10.5px] text-ink-soft">
                {working ? (
                  <>
                    <Dot
                      size="sm"
                      className="animate-[stream-pulse_1.2s_ease-in-out_infinite]"
                      style={{ background: role.reviewer ? '#1e7a4c' : 'var(--brand)' }}
                    />
                    {working.status}
                  </>
                ) : waiting > 0 ? (
                  `${waiting} card${waiting > 1 ? 's' : ''} waiting`
                ) : (
                  'idle'
                )}
              </span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}

/** The priority flag on a queued card: where it sits in the running order.
   Applies to the whole entry (an import group moves as one). */
function PriorityControl({ canvasId, cards }: { canvasId: string; cards: AgentTask[] }) {
  const current = Math.max(...cards.map((c) => c.priority ?? 0))
  const active = PRIORITY_OPTIONS.find((o) => o.value === current) ?? PRIORITY_OPTIONS[1]!
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="bare"
          size="sm"
          className={cn(
            'mt-1.5 -ml-1.5 gap-1 text-[11px] font-semibold',
            current > 0 && 'text-brand',
            current < 0 && 'text-ink-faint',
          )}
          title="Queue priority"
        >
          {current > 0 ? '⚑' : '⚐'} {active.label} priority
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[190px]">
        <DropdownMenuLabel>Runs in this order</DropdownMenuLabel>
        {PRIORITY_OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.value}
            disabled={o.value === current}
            onClick={() => {
              for (const c of cards) api.setCardPriority(canvasId, c.id, o.value).catch(console.error)
            }}
          >
            <span className="flex-none font-mono text-[12px]">{o.value > 0 ? '⚑' : '⚐'}</span>
            <span className="min-w-0">
              <span className="block font-semibold">{o.label}</span>
              <span className="block text-[11.5px] text-ink-faint">{o.hint}</span>
            </span>
            {o.value === current && <span className="ml-auto text-[12px] text-brand">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The roster: who is on the team, what each one owns, and what they're on. */
export function Board({ canvasId }: { canvasId: string }) {
  const tasks = useStore((s) => s.tasks)
  const frames = useStore((s) => s.canvas?.frames)
  const [draft, setDraft] = useState<string | null>(null)
  const [agents, setAgents] = useState<string[]>([DEFAULT_ROLE_ID])
  const { allowance, refresh } = useAllowance()

  /* a stopped card belongs with the failures: it needs a human decision, and
     its card body already reads "Attempt stopped" */
  const failed = tasks.filter((t) => t.queuedBy && (t.failedAt || t.cancelledAt) && !t.endedAt)
  const queued = useMemo(
    () =>
      tasks.filter((t) => t.queuedBy && !t.agentName && !t.failedAt && !t.cancelledAt && !t.endedAt).sort(queueOrder),
    [tasks],
  )
  /* paused cards stay claimed — an agent still owns them, the run is just
     held — so they read in the in-progress column with a Resume control */
  const inProgress = tasks.filter((t) => t.agentName && !t.failedAt && !t.cancelledAt && !t.endedAt)
  const done = tasks.filter((t) => t.endedAt).slice(0, 14)

  /* the drag order is optimistic: the ids as this client arranged them, so
     the column keeps the drop position until the server's own order says
     the same thing (inert then, and a broadcast always wins after that) */
  const [dragIds, setDragIds] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const ordered = useMemo(() => {
    const server = queued.map((t) => t.id).join(',')
    if (!dragIds || dragIds.join(',') === server) return queued
    const byId = new Map(queued.map((t) => [t.id, t]))
    const next = dragIds.flatMap((id) => byId.get(id) ?? [])
    for (const t of queued) if (!dragIds.includes(t.id)) next.push(t)
    return next
  }, [queued, dragIds])

  function dropOn(targetKey: string) {
    if (!dragging || dragging === targetKey) {
      setDragging(null)
      setOverKey(null)
      return
    }
    /* one id per rendered card; an import group moves as its block of ids */
    const entries = groupImports(ordered)
    const dragged = entries.find((e) => e.key === dragging)
    if (!dragged || !entries.some((e) => e.key === targetKey)) return
    const rest = entries.filter((e) => e.key !== dragging)
    rest.splice(
      rest.findIndex((e) => e.key === targetKey),
      0,
      dragged,
    )
    const ids = rest.flatMap((e) => e.cards.map((c) => c.id))
    setDragIds(ids)
    void api.reorderCards(canvasId, ids).catch(console.error)
    setDragging(null)
    setOverKey(null)
  }

  /* clicking a chip appends it to the pipeline, so click order = run order */
  function toggle(id: string) {
    setAgents((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function openCompose() {
    setAgents([DEFAULT_ROLE_ID])
    setDraft('')
  }

  async function submit() {
    const title = draft?.trim()
    const pipeline = agents.length > 0 ? agents : [DEFAULT_ROLE_ID]
    setDraft(null)
    if (!title) return
    try {
      await api.addCard(canvasId, title, pipeline)
      posthog.capture('agent_task_queued', { pipeline_length: pipeline.length })
    } catch (err) {
      if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
      else console.error(err)
    }
    refresh()
  }

  /* picking an agent from the roster opens a card already assigned to it */
  function composeFor(id: string) {
    setAgents([id])
    setDraft('')
  }

  return (
    <div className="absolute inset-0 overflow-auto px-4 pb-[calc(120px+env(safe-area-inset-bottom))] pt-[22px] [background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/26px_26px,var(--paper)] md:px-[34px] md:pb-[60px] md:pt-[30px]">
      <Team tasks={tasks} onPick={composeFor} />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7 md:min-w-max md:grid-cols-[repeat(3,minmax(280px,380px))] md:gap-[34px]">
        <section>
          <div className={colHeadCls}>
            <h2 className={cn(colHeadH2Cls, 'text-ink-soft')}>Queued</h2>
            <span className={countCls}>{queued.length + failed.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {failed.map((t) => (
              <Card
                key={t.id}
                className={cn(
                  cardBase,
                  'border-accent-ink/45 [background:linear-gradient(145deg,rgba(208,52,31,0.07),var(--surface)_62%)]',
                )}
              >
                <Button
                  variant="bare"
                  className={dismissCls}
                  aria-label="Remove this card"
                  title="Remove this card"
                  onClick={() => api.deleteCard(canvasId, t.id).catch(console.error)}
                >
                  ✕
                </Button>
                <h3 className={cardH3Cls}>{t.status}</h3>
                {t.payload ? (
                  <div className="mt-1.5">
                    <RepoTag task={t} />
                  </div>
                ) : (
                  <Trail task={t} state="queued" />
                )}
                <div className={metaCls}>
                  <b>Attempt stopped</b>
                  {t.agentName ? <span> · {t.agentName}</span> : null}
                  {t.cancelledAt ? (
                    <span> · stopped{t.cancelledBy ? ` by ${t.cancelledBy}` : ' — the agent went away'}</span>
                  ) : null}
                  <span> · {timeAgo((t.failedAt ?? t.cancelledAt)!)}</span>
                </div>
                <div className="mt-[9px] text-[11.5px] leading-[1.4] text-accent-ink">
                  {t.cancelledAt
                    ? 'Stopped. Retry when you are ready.'
                    : (t.failureReason ?? 'The agent did not finish this task.')}
                </div>
                <Button
                  variant="danger-solid"
                  size="pill"
                  className="mt-2.5 px-[11px] py-[5px]"
                  onClick={() =>
                    api.retryCard(canvasId, t.id).catch((err) => {
                      if (isResidentLimit(err)) useStore.getState().setLimitWall(true)
                      else console.error(err)
                    })
                  }
                >
                  ↻ Retry
                </Button>
              </Card>
            ))}
            {groupImports(ordered).map(({ key, cards }) => {
              const t = cards[0]!
              const isImport = cards.length > 1 || !!t.payload
              return (
                <Card
                  key={key}
                  className={cn(cardBase, 'bg-surface', overKey === key && dragging !== key && 'border-brand')}
                  draggable
                  onDragStart={(e: DragEvent<HTMLDivElement>) => {
                    setDragging(key)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e: DragEvent<HTMLDivElement>) => {
                    if (!dragging || dragging === key) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setOverKey(key)
                  }}
                  onDragLeave={() => setOverKey((k) => (k === key ? null : k))}
                  onDrop={(e: DragEvent<HTMLDivElement>) => {
                    e.preventDefault()
                    dropOn(key)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                    setOverKey(null)
                  }}
                >
                  <Button
                    variant="bare"
                    className={dismissCls}
                    title={cards.length > 1 ? 'Remove these cards' : 'Remove this card'}
                    onClick={() => Promise.all(cards.map((c) => api.deleteCard(canvasId, c.id))).catch(console.error)}
                  >
                    ✕
                  </Button>
                  {isImport ? (
                    <>
                      <h3 className={cardH3Cls}>
                        {cards.length === 1 ? t.status : `${cards.length} cards from ${t.payload?.repo}`}
                      </h3>
                      {cards.length === 1 ? (
                        <div className="mt-1.5">
                          <RepoTag task={t} />
                        </div>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cards.map((c) => (
                            <span
                              key={c.id}
                              className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft"
                              title={c.payload?.screen?.route}
                            >
                              {c.kind === 'design-system' ? '✦ design system' : c.status}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <h3 className={cardH3Cls}>{t.status}</h3>
                      <Trail task={t} state="queued" />
                    </>
                  )}
                  <div className={metaCls}>
                    <b>{t.queuedBy}</b> · {timeAgo(t.startedAt)}
                  </div>
                  <div className="mt-[9px] font-mono text-[11px] text-ink-faint">
                    ✦ waiting for {roleName(pipelineOf(t)[t.stage ?? 0])}
                  </div>
                  <TargetChip task={t} frames={frames} />
                  <PriorityControl canvasId={canvasId} cards={cards} />
                </Card>
              )
            })}
            {draft === null ? (
              <Button
                variant="ghost"
                className="justify-center rounded-[14px] border-[1.5px] border-dashed p-3.5 text-[13px] font-[650] text-ink-faint hover:border-brand hover:bg-transparent hover:text-accent-ink"
                onClick={openCompose}
              >
                + New card
              </Button>
            ) : (
              <Card className={cn(cardBase, 'bg-surface')}>
                <Textarea
                  autoFocus
                  variant="bare"
                  className="min-h-[54px] md:text-[13.5px]"
                  value={draft}
                  maxLength={MAX_CARD_CHARS}
                  placeholder="What should an agent work on?"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void submit()
                    }
                    if (e.key === 'Escape') setDraft(null)
                  }}
                />
                <div className="mt-1 border-t border-line pt-2.5">
                  <div className="flex flex-col gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-faint">
                    <span>Assign to</span>
                    <div className="-ml-1.5 flex flex-wrap gap-[3px]">
                      {PIPELINE_PRESETS.map((p) => (
                        <Button
                          key={p.id}
                          variant="bare"
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10.5px] font-[650] normal-case tracking-normal',
                            agents.join(',') === p.roles.join(',') && 'bg-paper-deep text-accent-ink',
                          )}
                          onClick={() => setAgents(p.roles)}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {AGENT_ROLES.map((role) => {
                      const at = agents.indexOf(role.id)
                      return (
                        <Button
                          key={role.id}
                          variant="ghost"
                          size="sm"
                          className={cn(
                            'gap-1 rounded-full px-2 py-1 text-[11.5px] text-ink-soft hover:border-ink-soft hover:bg-transparent',
                            at >= 0 && 'border-ink bg-ink text-white hover:border-ink hover:bg-ink hover:text-white',
                          )}
                          title={role.blurb}
                          onClick={() => toggle(role.id)}
                        >
                          <RoleMark role={role} size={13} />
                          {role.name}
                          {at >= 0 && agents.length > 1 && (
                            <span className="grid h-[13px] min-w-[13px] place-items-center rounded-full bg-white/25 font-mono text-[9.5px]">
                              {at + 1}
                            </span>
                          )}
                        </Button>
                      )
                    })}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2.5">
                  <Button
                    className="rounded-full border-transparent bg-ink px-3.5 py-1.5 text-xs font-bold text-white shadow-none hover:translate-x-0 hover:translate-y-0 hover:shadow-none"
                    disabled={!draft.trim()}
                    onClick={submit}
                  >
                    Queue it
                  </Button>
                  <MeterLine allowance={allowance} />
                  <span className={hintCls}>
                    {agents.length === 0
                      ? 'Doop picks it up right away'
                      : agents.length === 1
                        ? `${roleName(agents[0])} picks it up right away`
                        : `${roleName(agents[0])} starts, then ${agents.slice(1).map(roleName).join(' → ')}`}
                  </span>
                </div>
              </Card>
            )}
          </div>
        </section>

        <section>
          <div className={colHeadCls}>
            <h2 className={cn(colHeadH2Cls, 'text-accent-ink')}>In progress</h2>
            <span className={countCls}>{inProgress.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {inProgress.length === 0 && <div className="px-0.5 py-1 text-[13px] text-ink-faint">Nothing in flight</div>}
            {inProgress.map((t) => (
              <Card
                key={t.id}
                className={cn(cardBase, 'border-brand bg-surface shadow-[0_0_0_1px_var(--brand),var(--shadow-card)]')}
              >
                <h3 className={cardH3Cls}>{t.status}</h3>
                {t.payload ? (
                  <div className="mt-1.5">
                    <RepoTag task={t} />
                  </div>
                ) : (
                  t.queuedBy && <Trail task={t} state="working" />
                )}
                <div className={metaCls}>
                  <Dot
                    size="sm"
                    className={cn(!t.pausedAt && 'animate-[stream-pulse_1.2s_ease-in-out_infinite]')}
                    style={{ background: t.color }}
                  />
                  <b className="inline-flex items-center gap-1">
                    <RoleMark role={roleByAgentName(t.agentName)} size={13} />
                    {t.agentName}
                  </b>
                  {t.owner && <span> · for {t.owner}</span>}
                  {t.queuedBy && <span> · card from {t.queuedBy}</span>}
                  <span> · {timeAgo(t.claimedAt ?? t.startedAt)}</span>
                </div>
                <TargetChip task={t} frames={frames} />
                {t.usage && <UsageLine usage={t.usage} />}
                {t.pausedAt ? (
                  <div className="mt-2.5 flex items-center gap-2.5">
                    <Button
                      size="pill"
                      className="px-[11px] py-[5px]"
                      title="Let the agent pick this card back up"
                      onClick={() => api.resumeCard(canvasId, t.id).catch(console.error)}
                    >
                      ▶ Resume
                    </Button>
                    <span className="text-[11.5px] text-ink-faint">
                      paused{t.pausedBy ? ` by ${t.pausedBy}` : ''} · {timeAgo(t.pausedAt)}
                    </span>
                  </div>
                ) : (
                  <div className="mt-2.5 flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="pill"
                      className="px-[11px] py-[5px]"
                      title="Hold this run — the card stays claimed and can be resumed"
                      onClick={() => api.pauseAgentWork(canvasId, t.agentName).catch(console.error)}
                    >
                      ⏸ Pause
                    </Button>
                    <Button
                      variant="danger-solid"
                      size="pill"
                      className="px-[11px] py-[5px]"
                      title="Stop this agent"
                      onClick={() => api.stopAgentWork(canvasId, t.agentName).catch(console.error)}
                    >
                      Stop
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>

        <section>
          <div className={colHeadCls}>
            <h2 className={cn(colHeadH2Cls, 'text-ink-soft')}>Done</h2>
            <span className={countCls}>{done.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {done.length === 0 && <div className="px-0.5 py-1 text-[13px] text-ink-faint">Nothing yet</div>}
            {done.map((t) => (
              <Card key={t.id} className={cn(cardBase, 'bg-transparent shadow-none')}>
                <h3 className="break-words pr-4 font-display text-[13.5px] font-semibold leading-[1.35] tracking-[-0.01em] text-ink-soft">
                  {t.status}
                </h3>
                {t.payload && (
                  <div className="mt-1">
                    <RepoTag task={t} />
                  </div>
                )}
                {t.queuedBy && pipelineOf(t).length > 1 && <Trail task={t} state="done" />}
                <div className={metaCls}>
                  <span className="font-[750] text-[#1e7a4c]">✓</span> {t.agentName || t.queuedBy}
                  {t.queuedBy && t.agentName && <span> · for {t.queuedBy}</span>}
                  <span> · {timeAgo(t.endedAt!)}</span>
                </div>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
