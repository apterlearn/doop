import { useEffect, useState } from 'react'
import type { FrameReview } from '../../shared/types'
import { useStore } from '../lib/store'
import { api, ApiError } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { PanelBody } from './ui/panel'
import { ListSection } from './ui/list'
import { AGENT_ROLES } from '../../shared/agents'

/* The Checks tab: what the automated quality gate found on each frame, as the
   server recorded it.
   The reports were previously only visible to the agent that produced them —
   a human could see a frame change with no way to know whether it had been
   checked, or what the check said. This reads the stored reports, and says
   plainly when a report no longer describes the frame in hand. */

const COUNT_LABELS: { key: string; label: string }[] = [
  { key: 'critical', label: 'critical a11y' },
  { key: 'serious', label: 'serious a11y' },
  { key: 'errors', label: 'layout errors' },
  { key: 'content_errors', label: 'content errors' },
  { key: 'content_warnings', label: 'content warnings' },
  { key: 'off_token', label: 'off-palette' },
  { key: 'off_token_type', label: 'off type scale' },
  { key: 'warnings', label: 'warnings' },
]

interface ReviewFinding {
  rule: string
  selector: string
  detail: string
  source: string
}

/**
 * Frames worth showing: those an agent designed, plus any with a pending
 * proposal. A human reading this tab is asking "did the agent's work get
 * checked", so a frame no agent touched is noise.
 *
 * "Agent" is decided from the canvas's own record of who the agents are —
 * every task, plan, proposal, question and run event names one — plus the
 * built-in roles, which are fixed. A frame written by a human collaborator
 * therefore stays out of the list.
 */
function framesOfInterest(
  frames: { id: string; name: string; updatedBy: string; updatedAt: number }[],
  proposedFrameIds: string[],
  agentNames: Set<string>,
): { id: string; name: string }[] {
  const proposed = new Set(proposedFrameIds)
  return frames
    .filter((frame) => proposed.has(frame.id) || agentNames.has(frame.updatedBy))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)
    .map((frame) => ({ id: frame.id, name: frame.name }))
}

export function ChecksPanel() {
  const frames = useStore((s) => s.canvas?.frames)
  const proposals = useStore((s) => s.frameProposals)
  const tasks = useStore((s) => s.tasks)
  const plans = useStore((s) => s.plans)
  const questions = useStore((s) => s.questions)
  const runEvents = useStore((s) => s.runEvents)
  const [reviews, setReviews] = useState<Record<string, (FrameReview & { current: boolean })[]>>({})
  /* the frame whose check is in flight, and why the last one failed: both are
     per-panel rather than per-frame — only one run is ever outstanding */
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState<{ frameId: string; message: string } | null>(null)
  /* which frame set the reports in hand belong to: "loading" is derived from
     that rather than set before the request, so the effect never has to touch
     state synchronously */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const proposedFrameIds = proposals.filter((p) => p.status === 'pending' && p.frameId).map((p) => p.frameId as string)
  const agentNames = new Set<string>([
    ...AGENT_ROLES.map((role) => role.name),
    ...tasks.map((task) => task.agentName),
    ...plans.map((plan) => plan.agentName),
    ...proposals.map((proposal) => proposal.agentName),
    ...questions.map((question) => question.agentName),
    ...runEvents.map((event) => event.agentName),
  ])
  /* the frames' updatedAt is the signal that a report may have gone stale */
  const signature = (frames ?? []).map((frame) => `${frame.id}:${frame.updatedAt}`).join(',')
  const wanted = framesOfInterest(frames ?? [], proposedFrameIds, agentNames)
  const wantedKey = wanted.map((frame) => frame.id).join(',')

  useEffect(() => {
    if (!wanted.length) return
    let live = true
    Promise.all(wanted.map(async (frame) => [frame.id, await api.frameReviews(frame.id, 1)] as const))
      .then((entries) => {
        if (!live) return
        setReviews(Object.fromEntries(entries))
        setLoadedKey(wantedKey)
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [wantedKey, signature]) // eslint-disable-line react-hooks/exhaustive-deps

  const loading = wanted.length > 0 && loadedKey !== wantedKey

  /* Ask the server to run the gate now and show what it recorded. The report
     is the same one ready_for_review stores, so it replaces what this panel
     was showing rather than sitting beside it. */
  const runChecks = (frameId: string) => {
    setRunning(frameId)
    setError(null)
    api
      .runFrameReviews(frameId)
      .then((report) => setReviews((prev) => ({ ...prev, [frameId]: [report, ...(prev[frameId] ?? [])] })))
      .catch((err: unknown) => {
        /* the route refuses with a plain sentence (rate limit, renderer down);
           show that rather than "429 {...}" */
        const fallback = err instanceof Error ? err.message : 'the checks could not run'
        setError({ frameId, message: err instanceof ApiError ? String(err.body.error ?? fallback) : fallback })
      })
      .finally(() => setRunning(null))
  }

  if (!wanted.length) {
    return (
      <PanelBody className="px-4 py-6 text-center text-[13px] text-ink-faint">
        No agent-designed frames on this canvas yet. Checks run when an agent reviews its work with ready_for_review.
      </PanelBody>
    )
  }

  return (
    <PanelBody className="flex flex-col pb-4">
      {wanted.map((frame) => {
        const report = reviews[frame.id]?.[0]
        const stale = report && !report.current
        const failing = report && (report.verdict !== 'pass' || stale)
        const stored = stale
          ? undefined
          : (report?.report as { blocking?: ReviewFinding[]; advisory?: ReviewFinding[] } | undefined)
        const blocking = stored?.blocking ?? []
        const advisory = stored?.advisory ?? []
        return (
          <div key={frame.id} className="mt-3 px-4">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
                {frame.name}
              </span>
              {report ? (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-px text-[10px] font-extrabold uppercase tracking-[0.06em]',
                    failing ? 'bg-accent-ink/12 text-accent-ink' : 'bg-brand/12 text-brand',
                  )}
                >
                  {stale ? 'stale' : report.verdict}
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-paper-deep px-1.5 py-px text-[10px] font-extrabold uppercase tracking-[0.06em] text-ink-faint">
                  {loading ? '…' : 'not checked'}
                </span>
              )}
              {/* the checks are three renders the server runs on demand, so a
                  reviewer can ask for a fresh verdict instead of waiting for
                  an agent to hand the frame back */}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto flex-none px-2 py-0.5 text-[11px]"
                disabled={running !== null}
                onClick={() => runChecks(frame.id)}
              >
                {running === frame.id ? 'Checking…' : 'Run checks'}
              </Button>
            </div>
            {error?.frameId === frame.id && <p className="mb-1.5 text-[11.5px] text-accent-ink">{error.message}</p>}
            {report ? (
              <div className="rounded-[10px] border border-line-soft bg-white px-3 py-2.5 shadow-card">
                <div className="text-[11.5px] text-ink-soft">
                  {timeAgo(report.reviewedAt)} by {report.reviewedBy}
                  {stale ? ' — the frame changed since, so this no longer describes it' : ''}
                </div>
                {!stale && (
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
                    {COUNT_LABELS.filter((entry) => (report.summary[entry.key] ?? 0) > 0).map((entry) => (
                      <span key={entry.key} className="text-ink">
                        <span className="font-bold">{report.summary[entry.key]}</span> {entry.label}
                      </span>
                    ))}
                    {COUNT_LABELS.every((entry) => (report.summary[entry.key] ?? 0) === 0) && (
                      <span className="text-brand">no findings</span>
                    )}
                  </div>
                )}
                {blocking.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {blocking.slice(0, 8).map((finding, index) => (
                      <li key={`${finding.rule}-${finding.selector}-${index}`} className="text-[11.5px] leading-[1.4]">
                        <span className="font-mono text-[10.5px] font-bold text-accent-ink">{finding.rule}</span>{' '}
                        <span className="font-mono text-[10.5px] text-ink-soft">{finding.selector}</span>
                        <div className="text-ink-soft">{finding.detail}</div>
                      </li>
                    ))}
                  </ul>
                )}
                {/* advisory findings are a judgement call, not a gate — shown
                    after the blocking ones, and marked as such */}
                {advisory.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11.5px] text-ink-soft">
                      {advisory.length} advisory finding{advisory.length === 1 ? '' : 's'} — judgement calls, not
                      blockers
                    </summary>
                    <ul className="mt-1.5 flex flex-col gap-1.5">
                      {advisory.slice(0, 8).map((finding, index) => (
                        <li
                          key={`${finding.rule}-${finding.selector}-${index}`}
                          className="text-[11.5px] leading-[1.4]"
                        >
                          <span className="font-mono text-[10.5px] font-bold text-ink-soft">{finding.rule}</span>{' '}
                          <span className="font-mono text-[10.5px] text-ink-faint">{finding.selector}</span>
                          <div className="text-ink-soft">{finding.detail}</div>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <p className="text-[11.5px] text-ink-faint">
                No check recorded for this frame. Run checks above, or let an agent call ready_for_review before it
                hands work back.
              </p>
            )}
          </div>
        )
      })}
      <ListSection>
        <span>Reports are per document</span>
      </ListSection>
      <p className="px-4 text-[11.5px] leading-[1.45] text-ink-faint">
        A check describes the exact HTML it ran on. Editing a frame after it was checked marks the report stale, and an
        agent cannot hand work back until the frame it changed passes.
      </p>
    </PanelBody>
  )
}
