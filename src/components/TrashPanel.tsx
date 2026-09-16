import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { TrashContents, TrashedCanvas, TrashedFrame } from '../lib/api'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import { Toast } from './ui/toast'

/* The Trash view: what deleting a canvas or a frame actually does now.
 *
 *  Neither is destroyed when it is deleted — the row is marked deleted, the
 *  frame stops rendering and the canvas leaves the dashboard, and both wait
 *  here to be put back. The only ways out of the trash are a restore and the
 *  purge that clears anything left for thirty days. That ordering is the
 *  point: "delete" is a decision a person can take back, and this is where
 *  they take it back. */

/** What a row, the confirm dialog and the request callbacks all address. */
type Target = { kind: 'canvas' | 'frame'; id: string; label: string }

/** one trash row: the list-view shell Home's canvas list uses */
const rowCls =
  'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-soft px-3 py-2.5 last:border-b-0 md:px-3.5 md:py-[11px]'

const canvasTarget = (canvas: TrashedCanvas): Target => ({ kind: 'canvas', id: canvas.id, label: canvas.name })
const frameTarget = (frame: TrashedFrame): Target => ({ kind: 'frame', id: frame.id, label: frame.name })
const keyOf = (t: Target) => `${t.kind}:${t.id}`

export function TrashPanel({ onRestored }: { onRestored: () => void }) {
  const [contents, setContents] = useState<TrashContents | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [purging, setPurging] = useState<Target | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(() => {
    api.listTrash().then(setContents).catch(console.error)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  /* Restoring a canvas puts it back on this dashboard, so the list behind this
     view is refetched too — refreshing the trash alone would leave a restored
     canvas invisible until a reload */
  function restore(target: Target) {
    if (busy) return
    setBusy(keyOf(target))
    setError(null)
    const call = target.kind === 'canvas' ? api.restoreTrashedCanvas(target.id) : api.restoreTrashedFrame(target.id)
    call
      .then(() => {
        showToast(`Restored “${target.label}”`)
        load()
        onRestored()
      })
      .catch((err: unknown) => {
        console.error(err)
        setError(`Could not restore “${target.label}”.`)
      })
      .finally(() => setBusy(null))
  }

  /* Permanent: the row goes, and nothing brings it back. The dialog says so
     before this runs. */
  function purge(target: Target) {
    setPurging(null)
    setBusy(keyOf(target))
    setError(null)
    const call = target.kind === 'canvas' ? api.purgeTrashedCanvas(target.id) : api.purgeTrashedFrame(target.id)
    call
      .then(() => {
        showToast(`Deleted “${target.label}” for good`)
        load()
      })
      .catch((err: unknown) => {
        console.error(err)
        setError(`Could not delete “${target.label}”.`)
      })
      .finally(() => setBusy(null))
  }

  const canvases = contents?.canvases ?? []
  const frames = contents?.frames ?? []
  const empty = canvases.length === 0 && frames.length === 0

  return (
    <div className="mt-[18px]">
      <p className="max-w-[560px] text-[13px] leading-[1.55] text-ink-soft">
        Deleting a canvas or a frame moves it here — nothing is destroyed. Restore it and it comes back exactly as it
        was; anything left here is cleared out automatically after 30 days.
      </p>
      {error && <p className="mt-2 text-[12.5px] text-accent-ink">{error}</p>}
      {contents === null ? (
        <p className="mt-4 text-[13.5px] text-ink-soft">Loading the trash…</p>
      ) : empty ? (
        <p className="mt-4 text-[13.5px] text-ink-soft">
          The trash is empty. Delete a canvas or a frame and it waits here instead of disappearing.
        </p>
      ) : (
        <>
          {canvases.length > 0 && (
            <Section label="Canvases" count={canvases.length}>
              {canvases.map((canvas) => {
                const t = canvasTarget(canvas)
                return (
                  <Row
                    key={t.id}
                    name={canvas.name}
                    meta={`${canvas.frameCount} frame${canvas.frameCount === 1 ? '' : 's'} · deleted ${timeAgo(
                      canvas.deletedAt,
                    )}`}
                    target={t}
                    busy={busy === keyOf(t)}
                    onRestore={restore}
                    onPurge={setPurging}
                  />
                )
              })}
            </Section>
          )}
          {frames.length > 0 && (
            <Section label="Frames" count={frames.length}>
              {frames.map((frame) => {
                const t = frameTarget(frame)
                return (
                  <Row
                    key={t.id}
                    name={frame.name}
                    meta={`in ${frame.canvasName} · deleted ${timeAgo(frame.deletedAt)}`}
                    target={t}
                    busy={busy === keyOf(t)}
                    onRestore={restore}
                    onPurge={setPurging}
                  />
                )
              })}
            </Section>
          )}
        </>
      )}
      <ConfirmDialog
        open={purging !== null}
        onOpenChange={(open) => !open && setPurging(null)}
        title={`Delete “${purging?.label ?? ''}” forever?`}
        description={
          purging?.kind === 'canvas'
            ? 'This deletes the canvas and everything in it for good — it does not stay in the trash. This can’t be undone.'
            : 'This deletes the frame for good — it does not stay in the trash. This can’t be undone.'
        }
        confirmLabel="Delete forever"
        destructive
        onConfirm={() => purging && purge(purging)}
      />
      {toast && <Toast>{toast}</Toast>}
    </div>
  )
}

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.15em] text-ink-faint">
        {label} · {count}
      </h2>
      <div className="mt-2 overflow-hidden rounded-[14px] border border-line bg-surface shadow-card">{children}</div>
    </section>
  )
}

/** One trashed thing: what it is, where it came from, and the two decisions
 *  left — put it back, or end it. */
function Row({
  name,
  meta,
  target,
  busy,
  onRestore,
  onPurge,
}: {
  name: string
  meta: string
  target: Target
  busy: boolean
  onRestore: (target: Target) => void
  onPurge: (target: Target) => void
}) {
  return (
    <div className={rowCls}>
      <span className="min-w-0 truncate font-display text-[13.5px] font-semibold">{name}</span>
      <span className="min-w-0 truncate text-xs text-ink-faint">{meta}</span>
      <span className="ml-auto flex flex-none items-center gap-1.5">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRestore(target)}>
          Restore
        </Button>
        <Button variant="bare-danger" size="sm" disabled={busy} onClick={() => onPurge(target)}>
          Delete forever
        </Button>
      </span>
    </div>
  )
}
