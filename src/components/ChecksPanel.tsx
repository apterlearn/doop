import { useEffect, useMemo, useState } from 'react'
import type { CanvasReviewSummary, Frame } from '../../shared/types'
import { checkVerdict, useStore } from '../lib/store'
import { api, ApiError } from '../lib/api'
import { timeAgo } from '../lib/time'
import { roleName } from '../../shared/agents'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { PanelBody } from './ui/panel'
import { ListSection } from './ui/list'

/* The Checks tab: what the automated quality gate found on each frame, as the
   server recorded it.
   The reports were previously only visible to the agent that produced them —
   a human could see a frame change with no way to know whether it had been
   checked, or what the check said. This reads the stored reports, and says
   plainly when a report no longer describes the frame in hand.
   Every frame is listed, not just the ones an agent touched: a person asking
   "does this pass" may be looking at a frame they drew themselves, and a check
   is evidence about the frame, not about who wrote it. */

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

/** Who fixes a finding, by the domain the check filed it under. The polish
 *  pass owns the token scale, overflow and alignment; the accessibility
 *  reviewer owns a11y; wording is the copywriter's. A domain this build does
 *  not know about goes to the generalist rather than to the wrong specialist. */
const PIPELINES: Record<string, string[]> = {
  a11y: ['a11y'],
  token: ['polish'],
  layout: ['polish'],
  content: ['copy'],
}

/** The sentence a failed request carries. The routes refuse with plain text
 *  (rate limit, renderer down), so show that rather than "429 {...}". */
function apiMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  return err instanceof ApiError ? String(err.body.error ?? err.message) : err.message
}

/** One finding, with the action that turns it into work. Blocking and
 *  advisory rows read the same; only their tone differs. */
function FindingRow({
  finding,
  blocking,
  busy,
  onQueue,
}: {
  finding: ReviewFinding
  blocking: boolean
  busy: boolean
  onQueue: () => void
}) {
  return (
    <li className="flex items-start gap-2 text-[11.5px] leading-[1.4]">
      <div className="min-w-0 flex-1">
        <span className={cn('font-mono text-[10.5px] font-bold', blocking ? 'text-accent-ink' : 'text-ink-soft')}>
          {finding.rule}
        </span>{' '}
        <span className={cn('font-mono text-[10.5px]', blocking ? 'text-ink-soft' : 'text-ink-faint')}>
          {finding.selector}
        </span>
        <div className="text-ink-soft">{finding.detail}</div>
      </div>
      {/* a finding is only useful if someone acts on it: this hands it to the
          role that owns the domain, with the frame and the element it named */}
      <Button variant="ghost" size="sm" className="flex-none px-2 py-0.5 text-[11px]" disabled={busy} onClick={onQueue}>
        {busy ? 'Queueing…' : 'Queue fix'}
      </Button>
    </li>
  )
}

export function ChecksPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const frames = useStore((s) => s.canvas?.frames)
  /* the newest stored check per frame lives in the store: the frame labels
     read the same entries, so the two surfaces cannot disagree */
  const reviews = useStore((s) => s.frameReviews)
  const setFrameReview = useStore((s) => s.setFrameReview)
  const setFrameReviews = useStore((s) => s.setFrameReviews)
  /* the frame whose check is in flight, and why the last one failed: both are
     per-panel rather than per-frame — only one run is ever outstanding */
  const [running, setRunning] = useState<string | null>(null)
  const [sweeping, setSweeping] = useState(false)
  /* the sweep and the frame set it described: a roll-up is a claim about the
     canvas as it was, so a later edit makes it stale rather than silently
     out of date */
  const [sweep, setSweep] = useState<{ summary: CanvasReviewSummary; signature: string } | null>(null)
  /* the finding whose card is in flight, keyed rule@selector within a frame */
  const [queuing, setQueuing] = useState<string | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  /* what the panel last did on the human's behalf — a card queued, named */
  const [note, setNote] = useState<{ key: string; message: string } | null>(null)
  /* which frame set the reports in hand belong to: "loading" is derived from
     that rather than set before the request, so the effect never has to touch
     state synchronously */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  /* Every frame on the canvas, newest-updated first. Demo frames are product
     onboarding rather than the design, and the cap keeps a canvas with
     hundreds of frames opening instantly. */
  const wanted = useMemo(
    () =>
      (frames ?? [])
        .filter((frame) => !frame.demo)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50),
    [frames],
  )
  /* the frames' updatedAt is the signal that a report may have gone stale */
  const signature = (frames ?? []).map((frame) => `${frame.id}:${frame.updatedAt}`).join(',')
  const wantedKey = wanted.map((frame) => frame.id).join(',')

  useEffect(() => {
    if (!wanted.length) return
    let live = true
    Promise.all(wanted.map((frame) => api.frameReviews(frame.id, 1)))
      .then((lists) => {
        if (!live) return
        setFrameReviews(lists.flat())
        setLoadedKey(wantedKey)
      })
      /* a failed load leaves the panel saying it does not know, which is the
         truth — a frame it cannot read is not a frame that passed */
      .catch(console.error)
    return () => {
      live = false
    }
  }, [wantedKey, signature]) // eslint-disable-line react-hooks/exhaustive-deps

  const loading = wanted.length > 0 && loadedKey !== wantedKey
  /* a sweep's roll-up describes the canvas it ran on: once any frame's
     updatedAt moves, it is history rather than a verdict about what is on
     screen now */
  const sweepStale = !!sweep && sweep.signature !== signature

  /* Ask the server to run the gate now and show what it recorded. The report
     is the same one ready_for_review stores, so it replaces what this panel
     was showing rather than sitting beside it. */
  const runChecks = (frameId: string) => {
    setRunning(frameId)
    setError(null)
    setNote(null)
    api
      .runFrameReviews(frameId)
      .then((report) => setFrameReview(frameId, report))
      .catch((err: unknown) => setError({ key: frameId, message: apiMessage(err, 'the checks could not run') }))
      .finally(() => setRunning(null))
  }

  /* The canvas-wide sweep: one verdict for the whole design. A sweep renders
     every frame at every breakpoint, so it is seconds of work and the button
     says so while it runs. */
  const runAll = () => {
    if (!canvasId || sweeping) return
    setSweeping(true)
    setError(null)
    setNote(null)
    api
      .runCanvasReviews(canvasId)
      .then(async (summary) => {
        setSweep({ summary, signature })
        /* the summary carries a verdict per frame, not the reports behind
           them: pull the stored reports so the findings — and the frame
           labels — show what the sweep just found. A frame it skipped has no
           report to pull, and one that cannot be read must not cost the
           others their refresh. */
        const checked = summary.frames
          .filter((row) => row.verdict === 'pass' || row.verdict === 'fail')
          .map((row) => row.frameId)
        const lists = await Promise.all(checked.map((id) => api.frameReviews(id, 1).catch(() => [])))
        setFrameReviews(lists.flat())
      })
      .catch((err: unknown) => setError({ key: 'sweep', message: apiMessage(err, 'the sweep could not run') }))
      .finally(() => setSweeping(false))
  }

  /* Queue the finding as a board card for the role that owns its domain. The
     card carries the frame and the element the check named, so the agent
     starts from the address rather than from a guess. */
  const queueFix = (frame: Frame, finding: ReviewFinding) => {
    if (!canvasId) return
    const key = `${frame.id}:${finding.rule}:${finding.selector}`
    const pipeline = PIPELINES[finding.source] ?? ['doop']
    const title = `Fix ${finding.rule} on “${frame.name}”`
    setQueuing(key)
    setError(null)
    setNote(null)
    api
      .addCard(canvasId, title, pipeline, [], [frame.id], finding.selector ? { selector: finding.selector } : undefined)
      .then(() =>
        setNote({ key: frame.id, message: `Card queued for ${pipeline.map(roleName).join(' → ')} — ${title}.` }),
      )
      .catch((err: unknown) => setError({ key: frame.id, message: apiMessage(err, 'the card could not be queued') }))
      .finally(() => setQueuing(null))
  }

  if (!wanted.length) {
    return (
      <PanelBody className="px-4 py-6 text-center text-[13px] text-ink-faint">
        No frames on this canvas yet. Checks run on frames, so there is nothing to verify.
      </PanelBody>
    )
  }

  return (
    <PanelBody className="flex flex-col pb-4">
      <div className="border-b border-line-soft px-4 py-3.5">
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="text-[11.5px]"
            disabled={sweeping || running !== null}
            onClick={runAll}
          >
            {sweeping ? 'Checking every frame…' : 'Run all checks'}
          </Button>
          {sweep && (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-px text-[10px] font-extrabold uppercase tracking-[0.06em]',
                sweepStale
                  ? 'bg-paper-deep text-ink-faint'
                  : sweep.summary.verdict === 'pass'
                    ? 'bg-brand/12 text-brand'
                    : 'bg-accent-ink/12 text-accent-ink',
              )}
            >
              {sweepStale ? 'stale' : sweep.summary.verdict}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-soft">
          {sweeping ? (
            'Every frame is rendered at every breakpoint, so a full sweep takes a few seconds.'
          ) : sweep ? (
            <>
              {sweep.summary.totals.pass} passed · {sweep.summary.totals.fail} failed · {sweep.summary.totals.stale}{' '}
              stale · {sweep.summary.totals.skipped} with no answer
              <span className="text-ink-faint"> in {(sweep.summary.durationMs / 1000).toFixed(1)}s</span>
              {sweepStale && <span className="text-accent-ink"> — the canvas changed since, so run it again</span>}
            </>
          ) : (
            'Check every frame on this canvas at once, and get one verdict for the design.'
          )}
        </p>
        {error?.key === 'sweep' && <p className="mt-1.5 text-[11.5px] text-accent-ink">{error.message}</p>}
      </div>

      {wanted.map((frame) => {
        const report = reviews[frame.id]
        const verdict = report ? checkVerdict(report, frame) : null
        /* a sweep answers for frames this panel has no report for — a frame it
           could not render says so rather than reading as unchecked */
        const sweepRow = sweep?.summary.frames.find((row) => row.frameId === frame.id)
        const shown = verdict ?? sweepRow?.verdict ?? null
        const stored =
          verdict === 'stale'
            ? undefined
            : (report?.report as { blocking?: ReviewFinding[]; advisory?: ReviewFinding[] } | undefined)
        const blocking = stored?.blocking ?? []
        const advisory = stored?.advisory ?? []
        const sweepLine = sweepRow
          ? sweepRow.verdict === 'pass'
            ? `The sweep passed this frame${
                sweepRow.advisory > 0
                  ? ` with ${sweepRow.advisory} advisory finding${sweepRow.advisory === 1 ? '' : 's'}`
                  : ''
              }.`
            : sweepRow.verdict === 'skipped'
              ? `The sweep could not check this frame — ${sweepRow.reason ?? 'nothing to fall back on'}.`
              : `The sweep left this frame ${sweepRow.verdict} — ${
                  sweepRow.reason ?? 'the stored report no longer describes it'
                }.`
          : null
        return (
          <div key={frame.id} className="mt-3 px-4">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="truncate font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-faint">
                {frame.name}
              </span>
              {shown ? (
                <span
                  className={cn(
                    'shrink-0 rounded-full px-1.5 py-px text-[10px] font-extrabold uppercase tracking-[0.06em]',
                    shown === 'pass'
                      ? 'bg-brand/12 text-brand'
                      : shown === 'skipped'
                        ? 'bg-paper-deep text-ink-faint'
                        : 'bg-accent-ink/12 text-accent-ink',
                  )}
                >
                  {shown}
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
                disabled={running !== null || sweeping}
                onClick={() => runChecks(frame.id)}
              >
                {running === frame.id ? 'Checking…' : 'Run checks'}
              </Button>
            </div>
            {error?.key === frame.id && <p className="mb-1.5 text-[11.5px] text-accent-ink">{error.message}</p>}
            {note?.key === frame.id && <p className="mb-1.5 text-[11.5px] text-brand">{note.message}</p>}
            {report ? (
              <div className="rounded-[10px] border border-line-soft bg-white px-3 py-2.5 shadow-card">
                <div className="text-[11.5px] text-ink-soft">
                  {timeAgo(report.reviewedAt)} by {report.reviewedBy}
                  {verdict === 'stale' ? ' — the frame changed since, so this no longer describes it' : ''}
                </div>
                {verdict !== 'stale' && (
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
                      <FindingRow
                        key={`${finding.rule}-${finding.selector}-${index}`}
                        finding={finding}
                        blocking
                        busy={queuing === `${frame.id}:${finding.rule}:${finding.selector}`}
                        onQueue={() => queueFix(frame, finding)}
                      />
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
                        <FindingRow
                          key={`${finding.rule}-${finding.selector}-${index}`}
                          finding={finding}
                          blocking={false}
                          busy={queuing === `${frame.id}:${finding.rule}:${finding.selector}`}
                          onQueue={() => queueFix(frame, finding)}
                        />
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : sweepLine ? (
              <p className="text-[11.5px] leading-[1.45] text-ink-faint">{sweepLine}</p>
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
