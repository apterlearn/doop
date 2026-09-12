import { useEffect, useMemo, useState } from 'react'
import type { RunEvent } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { timeAgo } from '../lib/time'

/** The Run tab: what the resident agent actually did, tool call by tool call.
 *  The ws stream carries the recent window; the REST log is the full record,
 *  so the panel fills in what the socket did not deliver. */
export function RunPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const events = useStore((s) => s.runEvents)
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
          {timeAgo(selected.startedAt)} · {selected.events.filter((e) => e.kind === 'tool').length} tool calls
        </div>
      </div>
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
