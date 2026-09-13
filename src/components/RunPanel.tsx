import { useEffect, useMemo, useState } from 'react'
import type { RunEvent } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { timeAgo } from '../lib/time'

/** The Run tab: what the resident agent actually did, tool call by tool call.
 *  The ws stream carries the recent window; the REST log is the full record,
 *  so the panel fills in what the socket did not deliver. The run's journal —
 *  fetched alongside — is what says how long it took and what it spent. */
export function RunPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const events = useStore((s) => s.runEvents)
  const journals = useStore((s) => s.runJournals)
  /* '' until the human picks one, then the newest run by default */
  const [runId, setRunId] = useState('')

  useEffect(() => {
    if (!canvasId) return
    void api
      .runEvents(canvasId)
      .then((rows) => {
        if (rows.length === 0) return
        const s = useStore.getState()
        s.setRunEvents(mergeEvents(rows, s.runEvents))
      })
      .catch(console.error)
  }, [canvasId])

  /* Duration, turns, tool calls, tokens and cost live on the journal, not on
     the event stream, and a journal is written when its run ends — so this
     re-reads while the panel is open, or a run that finished while you were
     watching would show its totals only after a reload. */
  useEffect(() => {
    if (!canvasId) return
    let live = true
    const load = () =>
      void api
        .runJournals(canvasId)
        .then((rows) => {
          if (live) useStore.getState().setRunJournals(rows)
        })
        .catch(console.error)
    load()
    const t = window.setInterval(load, 10_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [canvasId])

  const runs = useMemo(() => groupRuns(events), [events])
  const selected = runs.find((r) => r.runId === runId) ?? runs[0]

  if (!canvasId) return null

  if (!selected) {
    return (
      <PanelBody className="py-2">
        <div className="px-4 py-6 text-center text-[13px] text-ink-faint">
          No agent runs yet. Every tool call a resident agent makes is journaled here while it works.
        </div>
      </PanelBody>
    )
  }

  const journal = journals.find((j) => j.runId === selected.runId)
  const toolCalls = selected.events.filter((e) => e.kind === 'tool').length
  /* each total is named only when the journal carries it: a field recorded
     before it existed must not read as a zero */
  const totals: string[] = []
  if (journal?.startedAt !== undefined && journal.endedAt !== undefined) {
    totals.push(formatDuration(journal.endedAt - journal.startedAt))
  }
  if (journal?.turns !== undefined) totals.push(`${journal.turns} turn${journal.turns === 1 ? '' : 's'}`)
  if (journal?.toolCalls !== undefined) totals.push(`${journal.toolCalls} tool calls`)
  if (journal?.tokens !== undefined) totals.push(`${journal.tokens.toLocaleString()} tokens`)
  /* null means no price is known for the model — not that the run was free */
  if (typeof journal?.costUsd === 'number') totals.push(`$${journal.costUsd.toFixed(2)}`)

  return (
    <PanelBody className="flex flex-col pb-3">
      {runs.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-line-soft px-4 py-2.5">
          {runs.map((r) => (
            <Button
              key={r.runId}
              variant={r.runId === selected.runId ? 'default' : 'ghost'}
              size="sm"
              className="shrink-0 gap-1.5 text-[11.5px] font-semibold"
              onClick={() => setRunId(r.runId)}
            >
              <AgentIcon name={r.agentName} size={11} />
              {r.agentName}
              <span className="font-mono text-[10px] font-normal text-ink-faint">{timeAgo(r.startedAt)}</span>
            </Button>
          ))}
        </div>
      )}
      <div className="border-b border-line-soft px-4 py-3">
        <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-ink">
          <AgentIcon name={selected.agentName} size={12} />
          {selected.agentName}
        </div>
        <div className="mt-1 font-mono text-[10.5px] text-ink-faint">
          {timeAgo(selected.startedAt)} · {toolCalls} tool calls
          {totals.length > 0 && ` · ${totals.join(' · ')}`}
        </div>
        {journal?.summary && <div className="mt-1 text-[11.5px] leading-[1.45] text-ink-soft">{journal.summary}</div>}
      </div>
      <StepScrubber events={selected.events} />
      <div>
        {selected.events.map((e) => (
          <EventRow key={e.id} event={e} />
        ))}
      </div>
    </PanelBody>
  )
}

interface Run {
  runId: string
  agentName: string
  startedAt: number
  /** chronological, so the timeline reads top-down */
  events: RunEvent[]
}

/** `1m 20s`, `48s`, `2h 5m` — the run's own clock, not a task's. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim()
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The run's steps that left a frame version behind, as a scrubber: dragging it
 *  renders the frame as that step left it, which is how a human sees where a
 *  run went wrong without reading HTML. Steps that wrote nothing are not in
 *  the list — there is nothing of theirs to show. */
function StepScrubber({ events }: { events: RunEvent[] }) {
  const steps = useMemo(
    () =>
      events.filter(
        (e): e is RunEvent & { frameId: string; afterVersionId: string } => !!e.frameId && !!e.afterVersionId,
      ),
    [events],
  )
  /* the newest step until the reviewer drags away from it */
  const [picked, setPicked] = useState<number | null>(null)
  const at = Math.min(picked ?? steps.length - 1, Math.max(0, steps.length - 1))
  const step = steps[at]
  const frame = useStore((s) => s.canvas?.frames.find((f) => f.id === step?.frameId))
  const [version, setVersion] = useState<{ id: string; html: string } | null>(null)

  useEffect(() => {
    if (!step) return
    let live = true
    api
      .frameVersion(step.frameId, step.afterVersionId)
      .then((v) => {
        if (live) setVersion({ id: v.id, html: v.html })
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [step?.frameId, step?.afterVersionId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* the same previewer the Review panel uses: tokens bound, one render at a
     time, and the blob released when this panel closes */
  const url = useHtmlPreview(
    version && version.id === step?.afterVersionId ? version.html : undefined,
    frame?.width ?? 640,
    frame?.height ?? 480,
  )

  if (steps.length === 0) return null

  return (
    <div className="border-b border-line-soft px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
          step {at + 1}/{steps.length}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-ink-faint">{clock(step!.at)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={steps.length - 1}
        step={1}
        aria-label="Run step"
        className="mt-1 h-6 w-full accent-brand"
        value={at}
        onChange={(e) => setPicked(Number(e.target.value))}
      />
      <div className="text-[11.5px] leading-[1.45] text-ink-soft">{step!.summary ?? step!.name ?? step!.kind}</div>
      {url && (
        <img
          src={url}
          alt={`The frame after step ${at + 1}`}
          className="mt-1.5 w-full rounded-[8px] border border-line bg-white"
        />
      )}
    </div>
  )
}

/** Newest run first; the run's own events in the order they happened. */
function groupRuns(events: RunEvent[]): Run[] {
  const byRun = new Map<string, RunEvent[]>()
  for (const e of events) {
    const list = byRun.get(e.runId) ?? []
    list.push(e)
    byRun.set(e.runId, list)
  }
  return [...byRun.entries()]
    .map(([runId, list]) => {
      list.sort((a, b) => a.at - b.at)
      return { runId, agentName: list[0]!.agentName, startedAt: list[0]!.at, events: list }
    })
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Union by id, newest first — the fetched log and the live stream overlap. */
function mergeEvents(fetched: RunEvent[], live: RunEvent[]): RunEvent[] {
  const byId = new Map<string, RunEvent>()
  for (const e of [...fetched, ...live]) byId.set(e.id, e)
  return [...byId.values()].sort((a, b) => b.at - a.at)
}

const markByKind: Record<RunEvent['kind'], string> = {
  tool: '⚙',
  turn: '✦',
  status: '·',
  error: '!',
  stop: '■',
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One timeline row: a tool call with its duration, or a one-line turn,
 *  status, error or stop. The summary expands — it is the tool's result. */
function EventRow({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false)
  const failed = event.ok === false
  const title = event.kind === 'tool' ? (event.name ?? 'tool') : event.kind
  return (
    <button
      type="button"
      className={cn(
        'flex w-full items-start gap-2.5 border-b border-line-soft px-4 py-[9px] text-left transition-colors hover:bg-paper',
        event.kind === 'tool' && 'cursor-pointer',
      )}
      onClick={() => event.summary && setOpen((v) => !v)}
    >
      <span
        className={cn(
          'mt-px w-[13px] flex-none text-center font-mono text-[11px]',
          failed ? 'font-extrabold text-accent-ink' : 'text-ink-faint',
          event.kind === 'stop' && 'text-ink',
        )}
      >
        {markByKind[event.kind]}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-[12px] font-semibold text-ink">{title}</span>
          {event.ms !== undefined && (
            <span className="font-mono text-[10.5px] text-ink-faint">{formatMs(event.ms)}</span>
          )}
        </span>
        {event.summary && (
          <span className={cn('mt-[2px] block text-[11.5px] leading-[1.45] text-ink-soft', !open && 'truncate')}>
            {event.summary}
          </span>
        )}
      </span>
      <span className="mt-px flex-none font-mono text-[10.5px] text-ink-faint">{clock(event.at)}</span>
    </button>
  )
}
