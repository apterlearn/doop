import { useEffect, useMemo, useState } from 'react'
import type { ElementComment, Frame, RunEvent } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { DEFAULT_ROLE_ID, roleName } from '../../shared/agents'
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
import {
  Panel,
  PanelBody,
  PanelDisclosure,
  PanelHeader,
  PanelTab,
  PanelTabPanel,
  PanelTabs,
  PanelTabsRoot,
} from './ui/panel'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { ListSection } from './ui/list'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
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
              value="claims"
              title="What the agents are working on right now — the claims they hold, the ones they dropped, and the notes still waiting for a role"
            >
              Claims
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
        <PanelTabPanel value="claims">
          <ClaimsList />
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

/* The work in flight on this canvas: the notes an agent is on, the ones whose
   attempt failed, and the ones nobody has picked up yet. Read off the same
   comment slice the pins come from, so this list and a pin can never disagree
   about where a note stands — and grouped in the order a human triages them:
   what stopped, what is moving, what is still waiting for a role. */
function ClaimsList() {
  const comments = useStore((s) => s.comments)
  const frames = useStore((s) => s.canvas?.frames)
  const activePageId = useStore((s) => s.activePageId)
  const groups = useMemo(() => {
    const failed: ElementComment[] = []
    const working: ElementComment[] = []
    const waiting: ElementComment[] = []
    for (const c of comments) {
      /* a resolved note is history, not work in flight, whatever it says */
      if (c.resolvedAt) continue
      if (c.failedAt) failed.push(c)
      /* a failed attempt keeps its claimant, so the failure is read first */
      else if (c.claimedBy) working.push(c)
      /* forAgent is what routing keys on: the text @mentions a role or a
         connected agent, so somebody is addressed and has not answered */
      else if (c.forAgent) waiting.push(c)
    }
    return [
      { title: 'Failed', rows: failed },
      { title: 'In progress', rows: working },
      { title: 'Waiting for a role', rows: waiting },
    ].filter((g) => g.rows.length > 0)
  }, [comments])

  if (groups.length === 0) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>Nothing in flight. @mention a role in a comment to hand it work.</div>
      </PanelBody>
    )
  }
  return (
    <PanelBody className="py-2">
      {groups.map((group) => (
        <div key={group.title}>
          <ListSection className="pb-1">
            <span>{group.title}</span>
            <span>{group.rows.length}</span>
          </ListSection>
          {group.rows.map((c) => (
            <ClaimRow key={c.id} comment={c} frames={frames} activePageId={activePageId} />
          ))}
        </div>
      ))}
    </PanelBody>
  )
}

/** One claim: the note, where it lives, who has it and when it last moved.
 *  Same rule as the feed above — when the frame still exists the row flies the
 *  canvas to it. */
function ClaimRow({
  comment,
  frames,
  activePageId,
}: {
  comment: ElementComment
  frames?: Frame[]
  activePageId?: string
}) {
  const frame = frames?.find((f) => f.id === comment.frameId)
  /* the stage draws only the active page, so a frame on another page is not on
     screen: the jump moves the tab first, or the camera would glide to
     coordinates nothing is drawn at */
  const jumpPage = frame && activePageId && frame.pageId !== activePageId ? frame.pageId : undefined
  /* the role a note with no target falls to, so an unnamed request still reads
     as addressed to somebody rather than to nobody */
  const target = comment.targetAgent ?? roleName(DEFAULT_ROLE_ID)
  /* where the note stands, in the words its pin uses. The owner rides along
     because two accounts can run an agent under the same name */
  const state = comment.failedAt
    ? `${target} stopped`
    : comment.claimedBy
      ? `${comment.claimedBy}${comment.claimedByOwner ? ` (${comment.claimedByOwner})` : ''} is on it`
      : `waiting for ${target}`
  const body = (
    <>
      <Dot className="mt-[5px]" style={{ background: colorFor(comment.claimedBy ?? target) }} />
      <div className="min-w-0">
        <div className="truncate">{comment.text}</div>
        <div className="mt-0.5 text-[11px] text-ink-faint">
          {frame ? frame.name : 'Frame gone'} · {state}
          {comment.failedAt && comment.failureReason ? ` — ${comment.failureReason}` : ''} ·{' '}
          {timeAgo(comment.failedAt ?? comment.claimedAt ?? comment.at)}
        </div>
      </div>
    </>
  )
  if (!frame) {
    return <div className={activityRow}>{body}</div>
  }
  return (
    <button
      type="button"
      title="Go to this frame"
      className={cn(activityRow, 'w-full text-left hover:bg-paper-deep')}
      onClick={() => {
        const s = useStore.getState()
        /* the tab first: the fly reads its frame from the whole canvas, so
           switching pages cannot lose the target */
        if (jumpPage) s.setActivePage(jumpPage)
        /* the guard above narrowed `frame`, not the id, so read the id off the
           frame we know exists */
        s.select(frame.id)
        s.requestFlyTo(frame.id)
      }}
    >
      {body}
    </button>
  )
}

/* What the connected agents actually did, read as runs: one group per run,
   newest run first, and inside a group the steps in the order they happened.
   Same rule as the feed above — when a step's frame still exists the row is a
   button that flies the canvas to it. A group also carries the two things a
   human wants about a finished or running run: taking back what it wrote, and
   stopping or steering it — while its agent is connected, or while the run's
   own newest step says it is still moving, which is all a run started from the
   Brief composer has. The list itself is the room's live window with pages of
   older steps fetched behind it on request, as deep as the server's own
   history goes. */

/** Which kinds mean the run is still moving. A stop, an error and the engine's
 *  own `ended` line are endings; everything else is work in progress. Written
 *  as a table over the whole union so a kind added later cannot quietly default
 *  to "live" and offer Stop on a run that is over. */
const LIVE_RUN_STEP_KINDS: Record<RunEvent['kind'], true | undefined> = {
  tool: true,
  status: true,
  stop: undefined,
  error: undefined,
  ended: undefined,
}

/** What a run step's badge says. A tool call shows the tool's own name — what
 *  the agent did — and the four steps that are not calls show what they are:
 *  a black-on-paper `run ended` for the stop, `error` in the error ink, a
 *  neutral `status` for a line the server recorded, and `passed` for the
 *  engine's own ending. */
const RUN_STEP_BADGE: Record<
  RunEvent['kind'],
  { label: string; tone?: 'default' | 'outline' | 'accent'; className?: string }
> = {
  tool: { label: 'tool' },
  status: { label: 'status', tone: 'outline' },
  error: { label: 'error', tone: 'accent' },
  stop: { label: 'run ended', className: 'border-ink bg-ink text-paper' },
  /* the judge passed it: the run ended on its own terms, which is not a stop */
  ended: { label: 'passed', tone: 'outline' },
}

/** The run timeline is read a page at a time behind the live window: the room
 *  pushes the newest steps into a bounded one (200, src/lib/store.ts) and this
 *  is how many steps one press asks the server for. It is only the page size —
 *  how deep the history goes is the server's answer (`has_more` /
 *  `next_offset`), not a number this client can hold: the steps behind the
 *  window come out of the durable table, which holds far more than the live
 *  ring ever does. */
const RUN_PAGE = 200

function RunList() {
  const canvasId = useStore((s) => s.canvas?.id)
  const runEvents = useStore((s) => s.runEvents)
  const frames = useStore((s) => s.canvas?.frames)
  const activePageId = useStore((s) => s.activePageId)
  /* The steps behind the live window, as the last press fetched them, kept
     with the canvas they were fetched for. They are held here rather than in
     the store because the store's window is bounded on purpose — a live entry
     pushes the oldest off the end — and steps a human asked for must not be
     evicted by a broadcast. The canvas rides along so a page that lands after
     a canvas switch is never read as this canvas's own, `atEnd` is the
     server's own answer that there is nothing older behind what it just sent,
     and `next` is the offset it said to ask for next — the offset is never
     inferred here, so a canvas whose history is longer than a page keeps
     going until the server says stop. */
  const [paged, setPaged] = useState<{ canvas: string; events: RunEvent[]; atEnd: boolean; next: number } | null>(null)
  const [paging, setPaging] = useState(false)
  /* Which steps are open, held by the list because that is the thing that
     outlives a row. A step is keyed by its own id and never by its place in
     the list: the room pushes a step onto the top of this newest-first list on
     every call, so an index would open somebody else's step the moment one
     arrived — and a step paged off the end and fetched back opens the way it
     was left. */
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(() => new Set())
  function toggleStep(id: string, open: boolean) {
    setOpenSteps((prev) => {
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }
  /* the live window with the older pages behind it. Steps are unique by id and
     a step that arrived live while a page was in flight is on both lists, so
     the overlap is dropped rather than listed twice — the window's own copy is
     the one kept, because that is the list live entries are pushed onto. Both
     lists arrive newest-first, so the unseen tail appends in order. */
  const timeline = useMemo(() => {
    const older = paged && paged.canvas === canvasId ? paged.events : []
    if (older.length === 0) return runEvents
    const held = new Set(runEvents.map((e) => e.id))
    return [...runEvents, ...older.filter((e) => !held.has(e.id))]
  }, [runEvents, paged, canvasId])
  /* a window that came back short of a page is the room's init saying there is
     nothing older — the init asks for a page of the ring, and the ring holds
     the newest rows, so a shorter answer is the ring running out. Once a press
     has answered, the server's own verdict is the one read, and it is the only
     thing that knows how far the durable history goes. */
  const atEnd = paged && paged.canvas === canvasId ? paged.atEnd : runEvents.length < RUN_PAGE
  /* the same timeline the rows have always come from, grouped by the run each
     step belongs to. The server sends it newest-step-first, so a run is first
     seen at its newest step and the groups come out newest-run-first */
  const runs = useMemo(() => {
    const groups = new Map<string, { runId: string; agentName: string; steps: RunEvent[] }>()
    for (const e of timeline) {
      const group = groups.get(e.runId)
      if (group) group.steps.push(e)
      else groups.set(e.runId, { runId: e.runId, agentName: e.agentName, steps: [e] })
    }
    /* a run is a sequence: inside its group the steps have to read in the
       order they happened, or the story of the run runs backwards */
    for (const group of groups.values()) group.steps.reverse()
    return [...groups.values()]
  }, [timeline])

  async function loadOlder() {
    if (!canvasId || paging) return
    const id = canvasId
    const mine = paged && paged.canvas === canvasId ? paged : null
    /* The offset is counted from the newest step. The window the room seeded is
       the server's own newest page — offset 0 answers with the same one — so
       the first press continues from its end, and every press after that asks
       for the offset the server named. Nothing here decides where the history
       ends: the page's own has_more is that answer, and a page with no steps in
       it is the end whatever the flag says, so the button cannot come back
       asking for the same offset again. */
    /* A live step arriving between two presses shifts every offset by one: the
       page then repeats what the window or an earlier page already holds, which
       the dedupe below drops, and the server's next_offset carries on past it.
       Nothing is skipped — the shift only ever moves the offsets back over
       steps already on screen. */
    const from = mine ? mine.next : timeline.length
    setPaging(true)
    try {
      const page = await api.runEvents(id, { limit: RUN_PAGE, offset: from })
      setPaged((prev) => {
        const older = prev && prev.canvas === id ? prev.events : []
        /* the pages are unique by id: a page repeats nothing, but a step that
           arrived live between two presses is on the window and in a page, and
           the accumulated list has to stay deduped on its own — the merge
           below only filters against the window */
        const held = new Set([...runEvents.map((e) => e.id), ...older.map((e) => e.id)])
        return {
          canvas: id,
          events: [...older, ...page.events.filter((e) => !held.has(e.id))],
          atEnd: !page.has_more || page.events.length === 0,
          next: page.next_offset ?? from,
        }
      })
    } catch (err) {
      /* the window already on screen still reads: a failed press is not worth
         a toast, and the button is still there to try again */
      console.error('run timeline page failed', err)
    } finally {
      setPaging(false)
    }
  }

  return (
    <PanelBody className="py-2">
      {timeline.length === 0 && (
        <div className={emptyNote}>No agent activity yet — connect an MCP client and it will show up here.</div>
      )}
      {runs.map((run) => (
        <RunGroup
          key={run.runId}
          run={run}
          frames={frames}
          activePageId={activePageId}
          openSteps={openSteps}
          onToggleStep={toggleStep}
        />
      ))}
      {/* the steps behind the live window: one press asks for one page, as
          deep as the server's history goes, and the button goes away once the
          server has said there are none older */}
      {timeline.length > 0 && !atEnd && (
        <div className="flex justify-center px-4 pb-3">
          <Button variant="ghost" size="pill" disabled={paging} onClick={() => void loadOlder()}>
            {paging ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      )}
    </PanelBody>
  )
}

/** One run: who ran it, what a human can do about it, then its steps. The
 *  header names the agent, so the steps below it do not repeat the name. */
function RunGroup({
  run,
  frames,
  activePageId,
  openSteps,
  onToggleStep,
}: {
  run: { runId: string; agentName: string; steps: RunEvent[] }
  frames?: Frame[]
  activePageId?: string
  /* the list's open steps, keyed by step id, handed down so a live push that
     adds a step above the open one cannot move what is open */
  openSteps: ReadonlySet<string>
  onToggleStep: (id: string, open: boolean) => void
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
  /* Who the run's actor was: an agent working over MCP, or the person who
     started the run from the Brief composer. Steps recorded before the kind
     was tracked carry none, and an absent kind reads as an agent — the only
     kind that existed then — so the newest step that declares one is the run's
     answer. A human's run is filed under the person's own name, so the header
     can name them; the tag beside that name is what says a person started it. */
  const actor = run.steps.reduce<RunEvent | undefined>((found, s) => (s.actorKind ? s : found), undefined)
  const actorKind: 'human' | 'agent' = actor?.actorKind ?? 'agent'
  /* What a stop or a steer is addressed to: the agent's id when the run's
     steps carry one, because two accounts can run an agent under the same
     name and a bare name is only accepted while it names exactly one of them.
     The newest step that has an id wins, and a run recorded before ids existed
     falls back to the name. Both ride the same path segment — the routes take
     an id there and resolve a name. */
  const controlTarget =
    run.steps.reduce<string | undefined>((found, s) => s.agentId ?? found, undefined) ?? run.agentName
  /* there is only something to take back when a step wrote a frame */
  const canRevert = !readOnly && run.steps.some((s) => s.frameId !== undefined)
  /* stop and steer reach an agent at its next tool call, so control needs a
     run that is still moving. Two things say so: the agent is connected right
     now, or the run's newest step is one that only happens while it runs — a
     tool call or a status line, never a stop, an error or the engine's own
     `ended` line. The second is what a run started from the Brief composer
     needs: a human starts it, so no agent presence ever carries that name, and
     the run's steps are filed under the person's own name — which is exactly
     what the stop and steer routes key on, so the same press reaches it. */
  const canControl =
    !readOnly &&
    (Object.values(presences).some((p) => p.kind === 'agent' && p.name === run.agentName) ||
      LIVE_RUN_STEP_KINDS[newest.kind] === true)
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
      await api.stopAgent(canvasId, controlTarget)
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
      await api.steerAgent(canvasId, controlTarget, message)
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
        <span className="min-w-0 truncate">
          {run.agentName}
          {/* the same tag the feed above puts beside an actor's name: it is
              what separates a run a person started from an agent's */}
          <span className="ml-[5px] font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            {actorKind}
          </span>
        </span>
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
        <RunStep
          key={step.id}
          event={step}
          frames={frames}
          activePageId={activePageId}
          open={openSteps.has(step.id)}
          onToggle={onToggleStep}
        />
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

/** The arguments a step carried, as they should read: the JSON the server
 *  stored, pretty-printed when it parses. The field is cut at 2 KB, so a long
 *  payload arrives mid-value and does not parse — that text is shown exactly as
 *  it came rather than dropped, which is why the parse failure is swallowed. */
function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

/** One step of a run. A step that is not a tool call has no tool name to show
 *  in that column, so its badge says what it is and the summary is the row —
 *  which is how a status line, an error and the stop that ended the run read
 *  as themselves instead of as nameless calls.
 *
 *  A step that carried arguments, or wrote a frame through a version pair, also
 *  opens: the chevron beside the row reveals what the call actually sent, and
 *  for a write a diff of the frame against the version the step started from. A
 *  step with neither is the one line it has always been — no chevron, nothing
 *  to open. The chevron is its own control beside the row and never inside it:
 *  a step that names a live frame is a button that flies the canvas to it, and
 *  a button inside a button is neither valid nor an unambiguous click. */
function RunStep({
  event,
  frames,
  activePageId,
  open,
  onToggle,
}: {
  event: RunEvent
  frames?: Frame[]
  activePageId?: string
  /* whether this step's disclosure is open, read off the list's own set */
  open: boolean
  onToggle: (id: string, open: boolean) => void
}) {
  const badge = RUN_STEP_BADGE[event.kind]
  const frame = frames?.find((f) => f.id === event.frameId)
  /* the stage draws only the active page, so a frame on another page is not on
     screen: the jump moves the tab first, or the camera would glide to
     coordinates nothing is drawn at */
  const jumpPage = frame && activePageId && frame.pageId !== activePageId ? frame.pageId : undefined
  /* the pair of versions the step wrote, with the frame they belong to — the
     diff route is keyed by that frame, so a pair without it is nothing this
     panel can render */
  const pair =
    event.frameId !== undefined && event.beforeVersionId !== undefined && event.afterVersionId !== undefined
      ? { frameId: event.frameId, versionId: event.beforeVersionId }
      : undefined
  /* parsed once per step rather than on every push that re-renders the list */
  const args = useMemo(() => (event.args ? prettyArgs(event.args) : undefined), [event.args])
  /* what the step has to show beyond its line: the arguments it carried, or a
     version pair to diff. A step with neither gets no affordance at all */
  const hasDetail = args !== undefined || pair !== undefined
  const [diff, setDiff] = useState<{ png: string; ratio: number } | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  const [diffFailed, setDiffFailed] = useState(false)

  /* The diff the frame's own History list runs: one saved version against the
     frame as it stands now, magenta on what moved. Handing it the version the
     step started from reads as the step's own change — where the step is the
     frame's newest write, "now" is exactly the version it produced. */
  async function showDiff() {
    if (!pair || diffBusy) return
    /* the same press puts it away again, as that history button does */
    if (diff) {
      setDiff(null)
      return
    }
    const { frameId, versionId } = pair
    setDiffBusy(true)
    setDiffFailed(false)
    try {
      const result = await api.frameDiff(frameId, versionId)
      setDiff({ png: result.png, ratio: result.changed_ratio })
    } catch (err) {
      console.error('step diff failed', err)
      setDiffFailed(true)
    } finally {
      setDiffBusy(false)
    }
  }

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
  /* the step's line: a jump to its frame when that frame is still on the
     canvas, a plain line when it is not. `min-w-0` lets it shrink beside the
     chevron instead of pushing the chevron out of the panel. */
  const line = frame ? (
    <button
      type="button"
      title="Go to this frame"
      className={cn(activityRow, 'w-full min-w-0 text-left hover:bg-paper-deep')}
      onClick={() => {
        const s = useStore.getState()
        /* the tab first: the fly reads its frame from the whole canvas, so
           switching pages cannot lose the target */
        if (jumpPage) s.setActivePage(jumpPage)
        s.select(frame.id)
        s.requestFlyTo(frame.id)
      }}
    >
      {body}
    </button>
  ) : (
    <div className={cn(activityRow, 'w-full min-w-0')}>{body}</div>
  )
  /* nothing to show: exactly the row it has always been, with no affordance and
     no empty panel under it */
  if (!hasDetail) return line
  /* how much of the frame moved, at the precision the Inspector's history list
     reads it at: a hairline difference earns two decimals, anything larger one */
  const changed = diff ? (diff.ratio * 100).toFixed(diff.ratio > 0 && diff.ratio < 0.01 ? 2 : 1) : ''
  return (
    <Collapsible open={open} onOpenChange={(next) => onToggle(event.id, next)}>
      <div className="flex items-start">
        {line}
        {/* the panel's own disclosure, cut down to a chevron beside the row:
            `w-auto border-t-0` undo the full-width ruled row it draws when it
            is a section header, and the padding matches the row's so the glyph
            sits on the summary's line */}
        <PanelDisclosure
          className="w-auto flex-none border-t-0 px-3 py-[9px] text-[11px]"
          title="Show what this step carried"
          aria-label="Show what this step carried"
        />
      </div>
      <CollapsibleContent className="px-4 pb-3">
        {args !== undefined && (
          <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-line bg-paper px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-ink-soft">
            {args}
          </pre>
        )}
        {pair !== undefined && (
          <div className={cn(args !== undefined && 'mt-1.5')}>
            <Button
              variant="ghost"
              size="sm"
              className="text-[11.5px]"
              disabled={diffBusy}
              title="The frame as this step found it, against how it stands now — magenta marks what moved"
              onClick={() => void showDiff()}
            >
              {diffBusy ? 'Comparing…' : 'Diff'}
            </Button>
            {diffFailed && <span className="ml-2 text-[11px] text-ink-faint">Couldn’t render the difference.</span>}
            {diff && (
              <span className="mt-1.5 block">
                <img
                  src={diff.png}
                  alt="Difference against the version this step started from"
                  className="w-full rounded-[8px] border border-line bg-white"
                />
                <span className="mt-0.5 block text-[11px] text-ink-faint">
                  {changed}% of pixels changed (magenta) — the frame before this step, against now
                </span>
              </span>
            )}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
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
