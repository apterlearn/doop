import { useEffect, useMemo, useState } from 'react'
import type { Frame, RunEvent } from '../../shared/types'
import { isReadOnly, useStore } from '../lib/store'
import { ApiError, api, type AgentSignal, type ConnectedAgent } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { MemoryPanel } from './MemoryPanel'
import { ReviewPanel } from './ReviewPanel'
import { TokensPanel } from './TokensPanel'
import { ChecksPanel } from './ChecksPanel'
import { ComponentsPanel } from './ComponentsPanel'
import { CanvasHistoryPanel } from './CanvasHistoryPanel'
import { ChatPanel } from './ChatPanel'
import { AssetsPanel } from './AssetsPanel'
import { Panel, PanelBody, PanelHeader, PanelTab, PanelTabPanel, PanelTabs, PanelTabsRoot } from './ui/panel'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { ListSection } from './ui/list'
import { ConfirmDialog } from './ui/alert-dialog'
import { Toast } from './ui/toast'
import { Tooltip } from './ui/tooltip'
import { PanelCollapseRightIcon } from './ui/icons'
import { Dot } from './ui/dot'

const emptyNote = 'px-4 py-6 text-center text-[13px] text-ink-faint'

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
            <PanelTab value="activity">Activity</PanelTab>
            <PanelTab
              value="run"
              title="What the connected agents actually did — every MCP tool call on this canvas, newest first"
            >
              Run
            </PanelTab>
            <PanelTab
              value="chat"
              title="The channel you and the agents talk on — @mention a role to route a message to whoever works it"
            >
              Chat
            </PanelTab>
            <PanelTab
              value="history"
              title="Every checkpoint of this canvas — preview one, or put the canvas back to it"
            >
              History
            </PanelTab>
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
            <PanelTab
              value="assets"
              title="Every image on this canvas — paste, drop or upload one and its URL can go into any frame"
            >
              Assets
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
        <PanelTabPanel value="activity">
          <ActivityList />
        </PanelTabPanel>
        <PanelTabPanel value="run">
          <RunList />
        </PanelTabPanel>
        <PanelTabPanel value="chat">
          <ChatPanel />
        </PanelTabPanel>
        <PanelTabPanel value="history">
          <CanvasHistoryPanel />
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
        <PanelTabPanel value="assets">
          <AssetsPanel />
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

const activityRow = 'flex animate-[chip-in_0.25s_ease] gap-2.5 px-4 py-[9px] text-[12.5px] leading-[1.45]'

/* The feed names the frame an entry is about; when that frame still exists the
   row is a button that flies the canvas to it, so a note is one click from the
   thing it describes. */
function ActivityList() {
  const activity = useStore((s) => s.activity)
  const frames = useStore((s) => s.canvas?.frames)
  const activePageId = useStore((s) => s.activePageId)
  return (
    <PanelBody className="py-2">
      {activity.length === 0 && <div className={emptyNote}>No activity yet. Add a frame, or connect an agent.</div>}
      {activity.map((a) => {
        const frameId = a.frameId
        const frame = frames?.find((f) => f.id === frameId)
        /* the stage draws only the active page, so a frame on another page is
           not on screen: the jump moves the tab first, or the camera would
           glide to coordinates nothing is drawn at */
        const jumpPage = frame && activePageId && frame.pageId !== activePageId ? frame.pageId : undefined
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
        if (!frame) {
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
              const s = useStore.getState()
              /* the tab first: the fly reads its frame from the whole canvas,
                 so switching pages cannot lose the target */
              if (jumpPage) s.setActivePage(jumpPage)
              /* the guard above narrowed `frame`, not `frameId`, so read the
                 id off the frame we know exists */
              s.select(frame.id)
              s.requestFlyTo(frame.id)
            }}
          >
            {body}
          </button>
        )
      })}
    </PanelBody>
  )
}

/* What the connected agents actually did, read as runs: one group per run,
   newest run first, and inside a group the steps in the order they happened.
   Same rule as the feed above — when a step's frame still exists the row is a
   button that flies the canvas to it. A group also carries the two things a
   human wants about a finished or running run: taking back what it wrote, and
   stopping or steering the agent while it is still connected. */

/** What a run step's badge says. A tool call shows the tool's own name — what
 *  the agent did — and the three steps that are not calls show what they are:
 *  a black-on-paper `run ended` for the stop, `error` in the error ink, and a
 *  neutral `status` for a line the server recorded. */
const RUN_STEP_BADGE: Record<
  RunEvent['kind'],
  { label: string; tone?: 'default' | 'outline' | 'accent'; className?: string }
> = {
  tool: { label: 'tool' },
  status: { label: 'status', tone: 'outline' },
  error: { label: 'error', tone: 'accent' },
  stop: { label: 'run ended', className: 'border-ink bg-ink text-paper' },
}

function RunList() {
  const runEvents = useStore((s) => s.runEvents)
  const frames = useStore((s) => s.canvas?.frames)
  const activePageId = useStore((s) => s.activePageId)
  /* the same timeline the rows have always come from, grouped by the run each
     step belongs to. The server sends it newest-step-first, so a run is first
     seen at its newest step and the groups come out newest-run-first */
  const runs = useMemo(() => {
    const groups = new Map<string, { runId: string; agentName: string; steps: RunEvent[] }>()
    for (const e of runEvents) {
      const group = groups.get(e.runId)
      if (group) group.steps.push(e)
      else groups.set(e.runId, { runId: e.runId, agentName: e.agentName, steps: [e] })
    }
    /* a run is a sequence: inside its group the steps have to read in the
       order they happened, or the story of the run runs backwards */
    for (const group of groups.values()) group.steps.reverse()
    return [...groups.values()]
  }, [runEvents])

  return (
    <PanelBody className="py-2">
      {runEvents.length === 0 && (
        <div className={emptyNote}>No agent activity yet — connect an MCP client and it will show up here.</div>
      )}
      {runs.map((run) => (
        <RunGroup key={run.runId} run={run} frames={frames} activePageId={activePageId} />
      ))}
    </PanelBody>
  )
}

/** One run: who ran it, what a human can do about it, then its steps. The
 *  header names the agent, so the steps below it do not repeat the name. */
function RunGroup({
  run,
  frames,
  activePageId,
}: {
  run: { runId: string; agentName: string; steps: RunEvent[] }
  frames?: Frame[]
  activePageId?: string
}) {
  const canvasId = useStore((s) => s.canvas?.id)
  const presences = useStore((s) => s.presences)
  /* a viewer reads the run and neither takes it back nor redirects it */
  const readOnly = useStore(isReadOnly)
  const [stopping, setStopping] = useState(false)
  const [steering, setSteering] = useState(false)
  const [steerDraft, setSteerDraft] = useState('')
  const [busy, setBusy] = useState(false)
  /* the frames the server refused to put back, and why — kept on the group
     rather than only toasted, because a refusal is the part worth reading */
  const [skipped, setSkipped] = useState<{ frameId: string; name: string; reason: string }[]>([])
  const [toast, setToast] = useState('')

  const newest = run.steps[run.steps.length - 1]!
  /* there is only something to take back when a step wrote a frame */
  const canRevert = !readOnly && run.steps.some((s) => s.frameId !== undefined)
  /* stop and steer need an agent that is connected right now: the timeline is
     readable forever, but only a live connection has a next tool call to refuse
     or a next call to read a steer on */
  const canControl = !readOnly && Object.values(presences).some((p) => p.kind === 'agent' && p.name === run.agentName)
  /* what the canvas is still holding for this agent: a stop that has not
     reached a tool call yet, and steers nobody has read. The agent name is
     kept with the list so the answer is only ever read against the group that
     asked for it — an agent with no live connection has no next call for
     either to land on, and a list fetched for another run must not appear
     here — which is what keeps this off the effect's cleanup path */
  const [polled, setPolled] = useState<{ agent: string; list: AgentSignal[] } | null>(null)

  useEffect(() => {
    if (!canControl || !canvasId) return
    const id = canvasId
    const agent = run.agentName
    /* polled rather than pushed: the indicator only has to be roughly current,
       and the toast on the press already acknowledged the action. A failed poll
       is not worth a toast — it would repeat every 5s for as long as the
       network stayed down */
    let live = true
    async function poll() {
      try {
        const { signals: pending } = await api.agentSignals(id)
        /* a reply already in flight when the group's agent changed, or when the
           group unmounted, must not write over the newer state */
        if (!live) return
        setPolled({ agent, list: pending.filter((s) => s.agentName === agent) })
      } catch (err) {
        console.error('agent signals poll failed', err)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 5000)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [canControl, canvasId, run.agentName])

  const signals = canControl && polled?.agent === run.agentName ? polled.list : []
  const stopPending = signals.some((s) => s.kind === 'stop')
  const queuedSteers = signals.filter((s) => s.kind === 'steer').length

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 2600)
  }

  async function revert() {
    if (!canvasId || busy) return
    setBusy(true)
    setSkipped([])
    try {
      const result = await api.revertRun(canvasId, run.runId)
      showToast(`Reverted ${result.reverted.length} frame${result.reverted.length === 1 ? '' : 's'}`)
      /* a frame somebody else has written since is refused rather than
         clobbered: the run cannot take back what is no longer its own work */
      setSkipped(result.skipped)
    } catch (err) {
      showToast(
        err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t revert that run.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!canvasId || busy) return
    setBusy(true)
    try {
      await api.stopAgent(canvasId, run.agentName)
      showToast(`${run.agentName} stops at its next tool call`)
    } catch (err) {
      showToast(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t stop it.')
    } finally {
      setBusy(false)
    }
  }

  async function steer() {
    const message = steerDraft.trim()
    if (!canvasId || !message || busy) return
    setBusy(true)
    try {
      await api.steerAgent(canvasId, run.agentName, message)
      setSteerDraft('')
      setSteering(false)
      showToast(`Steering ${run.agentName}`)
    } catch (err) {
      showToast(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t steer it.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ListSection className="pb-1">
        <span className="min-w-0 truncate">{run.agentName}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1 normal-case">
          <span className="whitespace-nowrap">
            {run.steps.length} step{run.steps.length === 1 ? '' : 's'} · {timeAgo(newest.at)}
          </span>
          {/* a stop that has not landed yet: the agent only finds out at its
              next tool call, so without this the press looks like nothing */}
          {stopPending && (
            <Badge tone="outline" title={`Stop queued — ${run.agentName}'s next tool call is refused`}>
              Stop pending
            </Badge>
          )}
          {queuedSteers > 0 && (
            <Badge
              tone="outline"
              title={`${queuedSteers} unread — ${run.agentName} reads ${
                queuedSteers === 1 ? 'it' : 'them'
              } on its next call`}
            >
              {queuedSteers} steer{queuedSteers === 1 ? '' : 's'} queued
            </Badge>
          )}
        </span>
      </ListSection>
      {(canControl || canRevert) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
          {canControl && (
            <>
              <Button
                variant="ghost"
                size="pill"
                disabled={busy}
                title={`Refuse ${run.agentName}'s next tool call and end the run`}
                onClick={() => setStopping(true)}
              >
                Stop
              </Button>
              <Button
                variant="ghost"
                size="pill"
                disabled={busy}
                title={`Redirect ${run.agentName} — it reads this on its next call`}
                onClick={() => setSteering((on) => !on)}
              >
                Steer
              </Button>
            </>
          )}
          {canRevert && (
            <Button
              variant="ghost"
              size="pill"
              disabled={busy}
              title="Put every frame this run wrote back to the state it had before the run"
              onClick={() => void revert()}
            >
              Revert this run
            </Button>
          )}
        </div>
      )}
      {steering && (
        <div className="px-4 pb-2">
          <Input
            inputSize="sm"
            className="text-[12px]"
            value={steerDraft}
            autoFocus
            placeholder={`Redirect ${run.agentName} — read on its next call…`}
            onChange={(e) => setSteerDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void steer()
              }
              if (e.key === 'Escape') setSteering(false)
            }}
          />
        </div>
      )}
      {skipped.length > 0 && (
        <div className="px-4 pb-2 text-[11px] leading-[1.45] text-ink-faint">
          {skipped.map((s) => (
            <div key={s.frameId} className="truncate" title={`${s.name} — ${s.reason}`}>
              <span className="font-semibold text-ink-soft">{s.name}</span> — {s.reason}
            </div>
          ))}
        </div>
      )}
      {run.steps.map((step) => (
        <RunStep key={step.id} event={step} frames={frames} activePageId={activePageId} />
      ))}
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title={`Stop ${run.agentName}?`}
        description="Its next tool call is refused and the run ends. Anything it has already written stays on the canvas — revert the run to take that back as well."
        confirmLabel="Stop agent"
        destructive
        onConfirm={() => void stop()}
      />
      {toast && <Toast>{toast}</Toast>}
    </>
  )
}

/** One step of a run. A step that is not a tool call has no tool name to show
 *  in that column, so its badge says what it is and the summary is the row —
 *  which is how a status line, an error and the stop that ended the run read
 *  as themselves instead of as nameless calls. */
function RunStep({ event, frames, activePageId }: { event: RunEvent; frames?: Frame[]; activePageId?: string }) {
  const badge = RUN_STEP_BADGE[event.kind]
  const frame = frames?.find((f) => f.id === event.frameId)
  /* the stage draws only the active page, so a frame on another page is not on
     screen: the jump moves the tab first, or the camera would glide to
     coordinates nothing is drawn at */
  const jumpPage = frame && activePageId && frame.pageId !== activePageId ? frame.pageId : undefined
  const body = (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <Badge tone={badge.tone} className={badge.className}>
          {event.kind === 'tool' ? (event.name ?? badge.label) : badge.label}
        </Badge>
        {(event.summary || event.ok === false) && (
          <span className="min-w-0 text-ink-soft">
            {event.ok === false ? (event.summary ? `failed — ${event.summary}` : 'failed') : event.summary}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-faint">
        {timeAgo(event.at)}
        {event.ms !== undefined && ` · ${event.ms}ms`}
      </div>
    </div>
  )
  if (!frame) {
    return (
      <div key={event.id} className={activityRow}>
        {body}
      </div>
    )
  }
  return (
    <button
      key={event.id}
      type="button"
      title="Go to this frame"
      className={cn(activityRow, 'w-full text-left hover:bg-paper-deep')}
      onClick={() => {
        const s = useStore.getState()
        /* the tab first: the fly reads its frame from the whole canvas, so
           switching pages cannot lose the target */
        if (jumpPage) s.setActivePage(jumpPage)
        /* the guard above narrowed `frame`, not `frameId`, so read the id off
           the frame we know exists */
        s.select(frame.id)
        s.requestFlyTo(frame.id)
      }}
    >
      {body}
    </button>
  )
}

/* The MCP clients acting as this account. Revoking deletes their tokens, which
   is what cuts a client off: its next call is refused and it must be approved
   again. This is the tab that answers "who can work on this canvas". */
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
