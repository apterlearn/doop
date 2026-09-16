import { useState } from 'react'
import { api, ApiError, type ReplaceResult } from '../lib/api'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Field } from './ui/field'
import { Input } from './ui/input'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Note } from './ui/note'

/* Canvas-wide find and replace: the same sweep the MCP `replace_in_frames`
   tool runs, with the dry-run preview in front of it so a text rename across a
   flow is read before it is written. Every write is an ordinary per-frame edit
   (the server sends each one through the frame action seam), so each frame
   keeps its own version history and a frame another agent holds the lock on is
   reported and stepped over instead of failing the sweep.

   Scope follows the page being viewed, which is what the human is looking at:
   the sweep reads the pages they can see, not the ones they have navigated
   away from. */
export function FindReplaceModal({
  canvasId,
  pageId,
  pageName,
  onToast,
  onClose,
}: {
  canvasId: string
  /** the page to sweep; unset sweeps every frame on the canvas */
  pageId?: string
  /** that page's name, for the scope line — unset reads as the whole canvas */
  pageName?: string
  /** the canvas owns the toast stack, so it raises the outcome */
  onToast: (message: string) => void
  onClose: () => void
}) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [regex, setRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [busy, setBusy] = useState<'preview' | 'replace' | null>(null)
  /* the last sweep and what it was: a preview counts, a replace writes. Kept
     after the write so the modal can report what landed and what did not. */
  const [sweep, setSweep] = useState<{ applied: boolean; result: ReplaceResult } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scope = pageName ? `page “${pageName}”` : 'every page on this canvas'
  const ready = !!find && !busy

  async function run(dryRun: boolean) {
    if (!ready) return
    setBusy(dryRun ? 'preview' : 'replace')
    setError(null)
    try {
      const result = await api.findReplace(canvasId, {
        find,
        replace,
        pageId,
        regex,
        caseSensitive,
        dryRun,
      })
      setSweep({ applied: !dryRun, result })
      if (!dryRun) onToast(outcome(result))
    } catch (err) {
      setError(err instanceof ApiError ? String(err.body.error ?? err.message) : 'Find and replace failed.')
    } finally {
      setBusy(null)
    }
  }

  const hits = sweep?.result.frames.filter((f) => f.matches > 0 || f.skippedReason) ?? []

  return (
    <Modal size="md" onClose={onClose}>
      <>
        <ModalTitle>Find and replace</ModalTitle>
        <ModalLede>
          Renames text across {scope}. Preview counts first; replacing rewrites each frame as its own edit, so every
          frame keeps its version history.
        </ModalLede>

        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <Field label="Find" labelVariant="form" htmlFor="find-replace-find">
            <Input
              id="find-replace-find"
              autoFocus
              value={find}
              disabled={!!busy}
              placeholder="Text to find"
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void run(true)}
            />
          </Field>
          <Field label="Replace with" labelVariant="form" htmlFor="find-replace-replace">
            <Input
              id="find-replace-replace"
              value={replace}
              disabled={!!busy}
              placeholder="Replacement"
              onChange={(e) => setReplace(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void run(true)}
            />
          </Field>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2.5">
          <label
            className="relative flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink"
            title="Regex reads Find as a pattern; $1 group references work in Replace with"
          >
            <Checkbox checked={regex} disabled={!!busy} onChange={(e) => setRegex(e.target.checked)} />
            Regular expression
          </label>
          <label
            className="relative flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink"
            title="Literal mode always matches case exactly; this flag applies to regex mode"
          >
            <Checkbox checked={caseSensitive} disabled={!!busy} onChange={(e) => setCaseSensitive(e.target.checked)} />
            Match case
          </label>
        </div>

        <div className="mt-5 border-t border-line-soft pt-3.5">
          {sweep ? (
            <>
              <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.09em] text-ink-faint">
                {sweep.applied ? 'Replaced' : 'Preview'}
              </p>
              {hits.length ? (
                <>
                  <ul className="mt-2 max-h-[40vh] overflow-y-auto">
                    {hits.map((row) => (
                      <li key={row.frameId} className="flex items-baseline gap-2.5 py-[3px] text-[13px]">
                        <span className="min-w-0 flex-1 truncate text-ink">{row.name}</span>
                        <span className="flex-none font-mono text-[11.5px] text-ink-soft">
                          {row.matches} {row.matches === 1 ? 'match' : 'matches'}
                          {sweep.applied && !row.skippedReason ? (row.applied ? ' · replaced' : ' · not replaced') : ''}
                        </span>
                        {row.skippedReason && (
                          <span className="flex-none text-[11.5px] text-ink-faint">skipped — {row.skippedReason}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <Note className="mt-2.5 block" tone="muted">
                    {total(sweep.result, sweep.applied)}
                  </Note>
                </>
              ) : (
                <p className="mt-2 text-[13px] text-ink-soft">Nothing matched on {scope}.</p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-ink-soft">
              Preview to see which frames match on {scope} before anything is written.
            </p>
          )}
          {error && (
            <Note className="mt-2.5 block" tone="error" size="sm">
              {error}
            </Note>
          )}
        </div>

        <ModalActions>
          <Button variant="ghost" disabled={!!busy} onClick={onClose}>
            Close
          </Button>
          <Button disabled={!ready} onClick={() => void run(true)}>
            {busy === 'preview' ? 'Previewing…' : 'Preview'}
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void run(false)}>
            {busy === 'replace' ? 'Replacing…' : 'Replace all'}
          </Button>
        </ModalActions>
      </>
    </Modal>
  )
}

/** One line for the whole sweep: how many occurrences, over how many frames,
 *  and what the write left behind. Only called with matches to report. */
function total(result: ReplaceResult, applied: boolean): string {
  const frames = result.frames.filter((f) => f.matches > 0)
  const where = `${frames.length} ${frames.length === 1 ? 'frame' : 'frames'}`
  const matches = `${result.totalMatches} ${result.totalMatches === 1 ? 'match' : 'matches'}`
  if (!applied) return `${matches} across ${where} — nothing written yet.`
  const written = frames.filter((f) => f.applied).length
  const skipped = frames.length - written
  return `${matches} replaced in ${written} of ${where}${skipped ? ` · ${skipped} skipped` : ''}.`
}

/** The outcome toast: the same numbers, said in one sentence. */
function outcome(result: ReplaceResult): string {
  const frames = result.frames.filter((f) => f.matches > 0)
  if (!frames.length) return 'Nothing matched — no frames changed'
  const written = frames.filter((f) => f.applied).length
  const skipped = frames.length - written
  const matched = `${result.totalMatches} ${result.totalMatches === 1 ? 'match' : 'matches'}`
  const replaced = `${matched} replaced in ${written} ${written === 1 ? 'frame' : 'frames'}`
  return skipped ? `${replaced} · ${skipped} skipped` : replaced
}
