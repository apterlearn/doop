import { useEffect, useMemo, useState } from 'react'
import type { AgentPlan, AgentTask, PlanStep } from '../../shared/types'
import { useStore } from '../lib/store'
import { api, type ConnectedAgent } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { MemoryPanel } from './MemoryPanel'
import { ReviewPanel } from './ReviewPanel'
import { TokensPanel } from './TokensPanel'
import { ChecksPanel } from './ChecksPanel'
import { ComponentsPanel } from './ComponentsPanel'
import { Panel, PanelBody, PanelHeader, PanelTab, PanelTabPanel, PanelTabs, PanelTabsRoot } from './ui/panel'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { PanelCollapseRightIcon } from './ui/icons'
import { Input } from './ui/input'
import { Dot } from './ui/dot'
import { ListMeta, ListSection } from './ui/list'

const emptyNote = 'px-4 py-6 text-center text-[13px] text-ink-faint'

function duration(t: AgentTask): string {
  const end = t.endedAt ?? Date.now()
  const s = Math.max(1, Math.round((end - t.startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim()
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function ActivityPanel({
  onClose,
  surface = 'floating',
}: {
  onClose: () => void
  /* 'inline' when the panel is filling a mobile Sheet rather than floating */
  surface?: 'floating' | 'inline'
}) {
  const tab = useStore((s) => s.panelTab)
  const setTab = useStore((s) => s.setPanelTab)
  const [, tick] = useState(0)

  /* refresh relative timestamps and running durations */
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 5000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <Panel surface={surface} className={cn(surface === 'floating' && 'inset-y-3 right-3 w-[300px]')}>
      <PanelTabsRoot value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
        <PanelHeader>
          <PanelTabs>
            <PanelTab value="tasks">Agents</PanelTab>
            <PanelTab value="activity">Activity</PanelTab>
            <PanelTab
              value="memory"
              title="Design memory — references, rules and decisions every agent on this canvas designs with"
            >
              Memory
            </PanelTab>
            <PanelTab
              value="tokens"
              title="The canvas design system — palette, type and scales every frame renders with"
            >
              Tokens
            </PanelTab>
            <PanelTab value="review" title="Agent changes waiting for your approval, and their questions">
              Review
            </PanelTab>
            <PanelTab
              value="components"
              title="The canvas component library — reusable pieces every agent can instance into frames"
            >
              Components
            </PanelTab>
            <PanelTab value="checks" title="What the automated quality checks found on each frame">
              Checks
            </PanelTab>
            <PanelTab value="agents" title="MCP clients connected to your account — revoke one to cut it off">
              Clients
            </PanelTab>
          </PanelTabs>
          <Tooltip label="Collapse panel" side="bottom" align="end">
            <Button
              variant="bare"
              size="icon-sm"
              className="shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink"
              aria-label="Collapse panel"
              onClick={onClose}
            >
              <PanelCollapseRightIcon width={13} height={13} />
            </Button>
          </Tooltip>
        </PanelHeader>
        <PanelTabPanel value="tasks">
          <TaskList />
        </PanelTabPanel>
        <PanelTabPanel value="activity">
          <ActivityList />
        </PanelTabPanel>
        <PanelTabPanel value="tokens">
          <TokensPanel />
        </PanelTabPanel>
        <PanelTabPanel value="review">
          <ReviewPanel />
        </PanelTabPanel>
        <PanelTabPanel value="components">
          <ComponentsPanel />
        </PanelTabPanel>
        <PanelTabPanel value="checks">
          <ChecksPanel />
        </PanelTabPanel>
        <PanelTabPanel value="memory">
          <MemoryPanel />
        </PanelTabPanel>
        <PanelTabPanel value="agents">
          <ClientsList />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

/* Task history grouped by agent, à la Cursor's agent panel: the active task
   pulses at the top of each group, finished ones are checked off below. */
function TaskList() {
  const tasks = useStore((s) => s.tasks)

  const groups = useMemo(() => {
    const byAgent = new Map<string, AgentTask[]>()
    for (const t of tasks) {
      // Unclaimed board cards belong in the Board's Queued column. They have
      // no agent identity yet, so rendering them here creates a blank group.
      if (!t.agentName) continue
      const key = t.agentName
      const list = byAgent.get(key) ?? []
      list.push(t) // tasks arrive newest first, so groups stay newest first too
      byAgent.set(key, list)
    }
    /* agents ordered by their most recent task */
    return [...byAgent.entries()]
  }, [tasks])

  if (groups.length === 0) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>
          No tasks yet. Agents announce what they're working on here — the history sticks around after they finish.
        </div>
      </PanelBody>
    )
  }

  return (
    <PanelBody className="pt-1 pb-3">
      <PlansSection />
      {groups.map(([key, list]) => (
        <TaskGroup key={key} list={list} />
      ))}
    </PanelBody>
  )
}

/* Every plan published on this canvas, in full — the task rows show only the
   active step, which is enough to see progress but not enough to see what the
   agent said it would do, or where it got stuck. */
function PlansSection() {
  const canvasId = useStore((s) => s.canvas?.id)
  const plans = useStore((s) => s.plans)
  const setPlans = useStore((s) => s.setPlans)

  /* the ws stream carries plan events; this fills in plans published before
     this client joined, or while it was on another canvas */
  useEffect(() => {
    if (!canvasId) return
    let live = true
    api
      .plans(canvasId)
      .then((rows) => {
        if (!live) return
        /* a plan broadcast can land between the request and this response, so
           merge by recency instead of replacing the live array with a snapshot
           taken before it */
        const byAgent = new Map<string, AgentPlan>(
          useStore.getState().plans.map((plan) => [`${plan.canvasId}:${plan.agentName}`, plan]),
        )
        for (const row of rows) {
          const key = `${row.canvasId}:${row.agentName}`
          const current = byAgent.get(key)
          if (!current || row.updatedAt >= current.updatedAt) byAgent.set(key, row)
        }
        setPlans([...byAgent.values()])
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [canvasId, setPlans])

  if (plans.length === 0) return null

  return (
    <>
      <ListSection>Plans</ListSection>
      {plans.map((plan) => (
        <div key={`${plan.canvasId}:${plan.agentName}`} className="border-b border-line-soft px-4 py-[9px]">
          <div className="flex items-center gap-2 text-[12.5px] font-bold">
            <AgentIcon name={plan.agentName} />
            {plan.agentName}
            <ListMeta className="ml-auto font-normal">
              {plan.steps.filter((step) => step.status === 'done').length}/{plan.steps.length} ·{' '}
              {timeAgo(plan.updatedAt)}
            </ListMeta>
          </div>
          <ol className="mt-1.5 flex flex-col gap-1">
            {plan.steps.map((step) => (
              <li key={step.id} className="flex items-start gap-1.5 text-[12px] leading-[1.45]">
                <span className={cn('mt-[3px] flex-none font-mono text-[10px]', PLAN_MARK[step.status])}>
                  {PLAN_GLYPH[step.status]}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      step.status === 'done' && 'text-ink-faint line-through',
                      step.status === 'active' && 'font-semibold',
                      step.status === 'blocked' && 'font-semibold text-accent-ink',
                      step.status === 'pending' && 'text-ink-soft',
                    )}
                  >
                    {step.text}
                  </span>
                  {step.note && (
                    <span
                      className={cn(
                        'mt-0.5 block text-[11.5px]',
                        step.status === 'blocked' ? 'text-accent-ink' : 'text-ink-faint',
                      )}
                    >
                      {step.note}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </>
  )
}

/* A blocked step is the one a human has to act on, so it reads as an alert
   rather than as one more pending line. */
const PLAN_GLYPH: Record<PlanStep['status'], string> = {
  pending: '○',
  active: '◐',
  done: '✓',
  blocked: '!',
}

const PLAN_MARK: Record<PlanStep['status'], string> = {
  pending: 'text-ink-faint',
  active: 'text-brand',
  done: 'text-ink-faint',
  blocked: 'text-accent-ink',
}

/* Long histories collapse to the latest few per agent — the panel is a
   "what's happening" surface, not an archive. */
const TASKS_SHOWN_INITIALLY = 5
const TASKS_SHOWN_STEP = 15

const agentTag =
  'ml-[7px] rounded-full border border-current px-[7px] py-px align-[1px] font-mono text-[9px] uppercase text-accent-ink'

function TaskGroup({ list }: { list: AgentTask[] }) {
  const [shown, setShown] = useState(TASKS_SHOWN_INITIALLY)
  const hidden = list.length - shown
  const latest = list[0]
  if (!latest) return null

  return (
    <div className="border-t border-line-soft pt-2.5 pb-0.5 first:border-t-0">
      <div className="flex items-center gap-2 px-4 pt-1 pb-1.5 text-[12.5px] font-bold">
        <Dot shape="square" style={{ background: latest.color }} />
        <span>
          <AgentIcon name={latest.agentName} /> {latest.agentName}
          {latest.owner && <span className="ml-1.5 text-[11px] font-medium text-ink-faint">for {latest.owner}</span>}
          {latest.failedAt || latest.cancelledAt ? (
            <span className={cn(agentTag, 'font-semibold tracking-[0.08em]')}>needs retry</span>
          ) : !latest.endedAt ? (
            <span className={cn(agentTag, 'font-medium tracking-[0.1em]')}>working</span>
          ) : null}
        </span>
      </div>
      {list.slice(0, shown).map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
      {hidden > 0 && (
        <Button
          variant="link"
          size="sm"
          className="mx-4 mt-0.5 mb-2 px-0 py-0.5 text-[11.5px] text-ink-faint hover:text-ink"
          onClick={() => setShown((n) => n + TASKS_SHOWN_STEP)}
        >
          Show {Math.min(hidden, TASKS_SHOWN_STEP)} more ({hidden} older)
        </Button>
      )}
    </div>
  )
}

/* One task, with its human-feedback thread and a reply box. Feedback is
   delivered to the agent inside its next MCP tool result; the entry flips
   from "sending to agent…" to "seen" once that delivery happens. */
function TaskRow({ task }: { task: AgentTask }) {
  const canvasId = useStore((s) => s.canvas?.id)
  const feedback = useStore((s) => s.feedback.filter((f) => f.taskId === task.id))
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')

  async function submit() {
    const text = draft.trim()
    if (!text) return setReplying(false)
    setDraft('')
    setReplying(false)
    try {
      await api.sendTaskFeedback(task.id, text)
    } catch (e) {
      console.error(e)
    }
  }

  /* a stopped card is closed work with a human decision pending, so it reads
     as failed (needs a retry) rather than done */
  const state = task.endedAt ? 'done' : task.failedAt || task.cancelledAt ? 'failed' : 'active'
  const live = !task.endedAt && !task.failedAt && !task.cancelledAt

  /* the plan this agent published, so the row says what it is doing right now
     rather than only what it announced at the start */
  const plan = useStore((s) => s.plans.find((p) => p.agentName === task.agentName))
  const step = plan?.steps.find((s) => s.status === 'active') ?? plan?.steps.find((s) => s.status !== 'done')
  const stepNumber = plan && step ? plan.steps.indexOf(step) + 1 : 0

  return (
    <div className="group">
      <div className="flex animate-[chip-in_0.25s_ease] items-baseline gap-2 py-[5px] pr-4 pl-5 text-[12.5px] leading-[1.4]">
        {task.failedAt || task.cancelledAt ? (
          <span className="grid size-[15px] flex-none place-items-center self-center rounded-full bg-accent-ink text-[10px] font-extrabold text-white">
            !
          </span>
        ) : task.endedAt ? (
          <span className="flex-none text-[11px] text-ink-faint">✓</span>
        ) : (
          <Dot
            size="sm"
            className="animate-[status-pulse_1.6s_ease-in-out_infinite] self-center"
            style={{ background: task.color }}
          />
        )}
        <span
          className={cn(
            'min-w-0 flex-1',
            state === 'active' && 'font-semibold',
            state === 'done' && 'text-ink-soft',
            state === 'failed' && 'font-[650] text-accent-ink',
            /* server-inferred tasks (agent never announced) read as provisional */
            task.auto && 'italic text-ink-soft',
          )}
        >
          {task.status}
          {live && plan && step ? (
            <span className="font-normal text-ink-faint">
              {' '}
              · step {stepNumber}/{plan.steps.length}: {step.text}
            </span>
          ) : null}
        </span>
        <span className="flex-none font-mono text-[10.5px] text-ink-faint">
          {task.failedAt || task.cancelledAt
            ? timeAgo((task.failedAt ?? task.cancelledAt)!)
            : task.endedAt
              ? `${duration(task)} · ${timeAgo(task.endedAt)}`
              : duration(task)}
        </span>
        {(task.failedAt || task.cancelledAt) && task.queuedBy && canvasId ? (
          <Button
            variant="danger-solid"
            size="pill"
            onClick={() => api.retryCard(canvasId, task.id).catch(console.error)}
          >
            ↻ Retry
          </Button>
        ) : null}
        {live && canvasId ? (
          <Button
            variant="danger-solid"
            size="pill"
            className="flex-none"
            title="Stop this agent"
            onClick={() => api.stopAgentWork(canvasId, task.agentName).catch(console.error)}
          >
            Stop
          </Button>
        ) : null}
        {!replying && (
          <Button
            variant="bare"
            size="sm"
            className="flex-none px-1 py-0 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            title="Give the agent feedback on this task"
            onClick={() => setReplying(true)}
          >
            ↩
          </Button>
        )}
      </div>
      {feedback
        .slice()
        .reverse()
        .map((f) => (
          <div
            key={f.id}
            className="mt-px mr-4 mb-1 ml-[34px] animate-[chip-in_0.2s_ease] rounded-[8px] bg-paper-deep px-[9px] py-[5px] text-[12px] leading-[1.4]"
          >
            <span className="font-bold">{f.from}:</span> <span className="text-ink-soft">{f.text}</span>
            {f.failedAt ? (
              <span className="mt-[5px] flex items-center justify-between gap-2 text-[10.5px] text-accent-ink">
                {f.failureReason ?? 'The agent did not finish.'}
                <Button
                  variant="danger-solid"
                  size="pill"
                  onClick={() => api.retryTaskFeedback(f.id).catch(console.error)}
                >
                  ↻ Retry
                </Button>
              </span>
            ) : (
              <span
                className={cn(
                  'mt-0.5 block font-mono text-[9.5px] tracking-[0.06em]',
                  f.deliveredAt ? 'text-ink-faint' : 'text-accent-ink',
                )}
              >
                {f.completedAt
                  ? `✓ handled by ${f.claimedBy ?? 'an agent'}`
                  : f.deliveredAt
                    ? `↗ picked up by ${f.claimedBy ?? 'an agent'}`
                    : '→ waiting for an agent…'}
              </span>
            )}
          </div>
        ))}
      {replying && (
        <div className="mt-0.5 mr-4 mb-1.5 ml-[34px]">
          <Input
            inputSize="sm"
            className="rounded-lg px-[9px] focus:border-ink-soft focus:ring-0 md:text-xs"
            autoFocus
            placeholder="Feedback — any agent will pick this up…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
              if (e.key === 'Escape') setReplying(false)
            }}
            onBlur={() => (draft.trim() ? submit() : setReplying(false))}
          />
        </div>
      )}
    </div>
  )
}

const activityRow = 'flex animate-[chip-in_0.25s_ease] gap-2.5 px-4 py-[9px] text-[12.5px] leading-[1.45]'

/* The feed names the frame an entry is about; when that frame still exists the
   row is a button that flies the canvas to it, so a note is one click from the
   thing it describes. */
function ActivityList() {
  const activity = useStore((s) => s.activity)
  const frames = useStore((s) => s.canvas?.frames)
  return (
    <PanelBody className="py-2">
      {activity.length === 0 && <div className={emptyNote}>No activity yet. Add a frame, or connect an agent.</div>}
      {activity.map((a) => {
        const frameId = a.frameId
        const jumpable = !!frameId && !!frames?.some((f) => f.id === frameId)
        const body = (
          <>
            <Dot className="mt-[5px]" style={{ background: a.actorColor }} />
            <div>
              <div>
                <span className="font-bold">
                  {a.actorName}
                  <span className="ml-[5px] font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                    {a.actorKind}
                  </span>
                </span>{' '}
                <span className="text-ink-soft">{a.message}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-ink-faint">{timeAgo(a.at)}</div>
            </div>
          </>
        )
        if (!jumpable) {
          return (
            <div key={a.id} className={activityRow}>
              {body}
            </div>
          )
        }
        return (
          <button
            key={a.id}
            type="button"
            title="Go to this frame"
            className={cn(activityRow, 'w-full text-left hover:bg-paper-deep')}
            onClick={() => {
              useStore.getState().select(frameId)
              useStore.getState().requestFlyTo(frameId)
            }}
          >
            {body}
          </button>
        )
      })}
    </PanelBody>
  )
}

/* The MCP clients acting as this account. Revoking deletes their tokens, which
   is what cuts a client off: its next call is refused and it must be approved
   again. Kept beside the Agents tab because both answer "who is working here". */
function ClientsList() {
  const [clients, setClients] = useState<ConnectedAgent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let live = true
    api
      .listMcpAgents()
      .then((list) => {
        if (!live) return
        setClients(list)
        setFailed(false)
      })
      .catch(() => {
        if (!live) return
        setClients([])
        setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  if (clients === null) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>Loading connected clients…</div>
      </PanelBody>
    )
  }
  if (failed) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>Couldn&rsquo;t load connected clients. {note}</div>
      </PanelBody>
    )
  }
  if (clients.length === 0) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>
          No clients connected. Connect one from a canvas&rsquo;s &ldquo;Connect AI agent&rdquo; dialog.
        </div>
      </PanelBody>
    )
  }
  return (
    <PanelBody className="py-2">
      {clients.map((c) => (
        <div key={c.clientId} className={cn(activityRow, 'items-center justify-between')}>
          <div className="min-w-0">
            <div className="truncate font-bold">{c.name}</div>
            <div className="mt-0.5 text-[11px] text-ink-faint">
              {c.liveTokens} live token{c.liveTokens === 1 ? '' : 's'} ·{' '}
              {c.lastUsedAt ? `last used ${timeAgo(c.lastUsedAt)}` : 'never used'}
            </div>
          </div>
          <Button
            variant="danger-solid"
            size="pill"
            className="flex-none"
            title="Revoke this client's access"
            onClick={() => {
              setNote('')
              api
                .revokeMcpAgent(c.clientId)
                .then(async () => {
                  /* the revoked client must leave the list, or the row offers a
                     revoke that can only fail */
                  const list = await api.listMcpAgents().catch(() => null)
                  if (list) setClients(list)
                })
                .catch(() => setNote(`Couldn't revoke ${c.name} — try again.`))
            }}
          >
            Revoke
          </Button>
        </div>
      ))}
    </PanelBody>
  )
}
