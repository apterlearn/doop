import { useEffect, useState } from 'react'
import type { CanvasVersion, CanvasVersionFrame, CanvasVersionSummary } from '../lib/api'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import { Callout } from './ui/callout'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { ListItem, ListMeta, ListTitle } from './ui/list'
import { Note } from './ui/note'
import { PanelBody, PanelDisclosure } from './ui/panel'
import { Toast } from './ui/toast'

/* The History tab: every checkpoint of the whole canvas — the ones the server
   takes on its own while the canvas is edited, before a delete, and the ones a
   person asks for — newest first, each one previewable and restorable.
   This is the canvas-wide twin of the Inspector's frame history, and it is the
   answer to "I deleted that frame / that agent rewrote everything": a
   checkpoint is a way back, and restoring one is itself checkpointed so a
   restore is never a one-way door. */

/** Why a checkpoint exists, in words rather than the wire's cause. */
const CAUSE_LABEL: Record<CanvasVersionSummary['cause'], string> = {
  auto: 'Automatic checkpoint',
  delete: 'Before a delete',
  manual: 'Manual checkpoint',
  restore: 'Restore point',
}

const actionBtn = 'px-[9px] py-[4px] text-[11.5px]'

export function CanvasHistoryPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const versions = useStore((s) => s.canvasVersions)
  const setCanvasVersions = useStore((s) => s.setCanvasVersions)
  const pushCanvasVersion = useStore((s) => s.pushCanvasVersion)
  /* which canvas the list in hand describes: derived rather than set before the
     request, so the effect never has to touch state synchronously */
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  /* no ws message drives this list — a checkpoint is taken by whoever writes,
     and a client that has to see it is the client looking at the tab — so the
     tab fetches on open and refreshes itself after a restore */
  useEffect(() => {
    if (!canvasId) return
    let live = true
    api
      .listCanvasVersions(canvasId)
      .then((list) => {
        if (!live) return
        setCanvasVersions(list)
        setLoadedId(canvasId)
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [canvasId, setCanvasVersions])

  function reload() {
    if (!canvasId) return
    api.listCanvasVersions(canvasId).then(setCanvasVersions).catch(console.error)
  }

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  /* Restoring writes the snapshot's frames back as ordinary edits, so the room
     is told what changed; what it does not touch is a frame added since — the
     server neither deletes nor rewrites those. `created` counts the frames the
     snapshot brought back that had been deleted in the meantime. */
  function restore() {
    const versionId = confirmId
    setConfirmId(null)
    if (!canvasId || !versionId || restoring) return
    setRestoring(true)
    setError(null)
    api
      .restoreCanvasVersion(canvasId, versionId)
      .then(({ restored, created }) => {
        const line = `Restored ${restored} frame${restored === 1 ? '' : 's'}`
        showToast(created ? `${line} · ${created} re-created` : line)
        /* the restore is itself a checkpoint, so the top of the list is a new
           row — refetching shows it and re-times everything else */
        reload()
      })
      .catch((err: unknown) => {
        console.error(err)
        setError('This checkpoint could not be restored.')
      })
      .finally(() => setRestoring(false))
  }

  function saveCheckpoint() {
    if (!canvasId || saving) return
    setSaving(true)
    setError(null)
    api
      .createCanvasVersion(canvasId)
      .then((summary) => {
        pushCanvasVersion(summary)
        showToast('Checkpoint saved')
      })
      .catch((err: unknown) => {
        console.error(err)
        setError('Could not save a checkpoint.')
      })
      .finally(() => setSaving(false))
  }

  const loading = !!canvasId && loadedId !== canvasId

  return (
    <PanelBody className="flex flex-col pb-3">
      <p className="border-b border-line-soft px-4 py-3.5 text-[11.5px] leading-[1.45] text-ink-soft">
        Checkpoints are taken automatically as the canvas is edited and before every delete. Restoring one puts those
        frames back and never deletes frames that were added since.
      </p>
      {error && (
        <div className="px-4 pt-3">
          <Callout tone="error">{error}</Callout>
        </div>
      )}
      {loading ? (
        <div className="px-4 py-6 text-center text-[13px] text-ink-faint">Loading checkpoints…</div>
      ) : versions.length === 0 ? (
        <div className="px-4 py-6 text-center text-[13px] text-ink-faint">
          No checkpoints yet. One is taken as the canvas is edited, and saving one now is always an option.
        </div>
      ) : (
        versions.map((v) => (
          <Collapsible key={v.id} open={openId === v.id} onOpenChange={(open) => setOpenId(open ? v.id : null)}>
            <ListItem className="gap-0 p-0">
              <span className="flex items-baseline gap-2 px-4 pt-[11px]">
                <ListTitle className="min-w-0 flex-1 truncate">{CAUSE_LABEL[v.cause]}</ListTitle>
                <ListMeta className="flex-none">{timeAgo(v.createdAt)}</ListMeta>
              </span>
              <PanelDisclosure className="mt-1.5">
                <span className="min-w-0 flex-1 truncate">
                  {v.createdBy} · {v.frameCount} frame{v.frameCount === 1 ? '' : 's'}
                </span>
              </PanelDisclosure>
              <CollapsibleContent>
                {/* keyed by the checkpoint: a fresh mount per snapshot is what
                    resets the loaded/failed state, with no state written from
                    inside the effect that fetches it */}
                {canvasId && <SnapshotPreview key={v.id} canvasId={canvasId} versionId={v.id} />}
                <span className="flex flex-wrap gap-1.5 px-4 pb-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={actionBtn}
                    disabled={restoring}
                    onClick={() => setConfirmId(v.id)}
                  >
                    Restore this version
                  </Button>
                </span>
              </CollapsibleContent>
            </ListItem>
          </Collapsible>
        ))
      )}
      <div className="mt-3 border-t border-line-soft px-4 py-3.5">
        <Button
          variant="default"
          size="sm"
          className="text-[11.5px]"
          disabled={saving || !canvasId}
          onClick={saveCheckpoint}
        >
          {saving ? 'Saving…' : 'Save a checkpoint now'}
        </Button>
        <Note className="mt-1.5 block">
          A checkpoint of the canvas exactly as it stands right now, before the next thing changes it.
        </Note>
      </div>
      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(open) => !open && setConfirmId(null)}
        title="Restore this version?"
        description="Every frame in this checkpoint goes back to what it held then, and the frames it names are recreated if they were deleted. Frames added since are left alone. The restore is saved as a new checkpoint, so this is undoable from the same list."
        confirmLabel="Restore"
        onConfirm={restore}
      />
      {toast && <Toast>{toast}</Toast>}
    </PanelBody>
  )
}

/** A checkpoint's frames, rendered from the snapshot itself.
 *
 *  A frame image (/i/<id>.png) is not an option here: the frames a checkpoint
 *  froze may have been deleted or renamed since, so there is nothing live to
 *  render. The HTML the checkpoint kept is rendered through the server's
 *  preview route instead — the same route, the same tokens binding and the
 *  same object-URL ownership as every other preview in the app. */
function SnapshotPreview({ canvasId, versionId }: { canvasId: string; versionId: string }) {
  const [version, setVersion] = useState<CanvasVersion | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    api
      .getCanvasVersion(canvasId, versionId)
      .then((loaded) => {
        if (live) setVersion(loaded)
      })
      .catch((err: unknown) => {
        console.error(err)
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [canvasId, versionId])

  if (failed) return <Note className="block px-4 pb-2.5">This checkpoint could not be read.</Note>
  if (!version) return <Note className="block px-4 pb-2.5">Loading the snapshot…</Note>
  if (!version.frames.length) return <Note className="block px-4 pb-2.5">This checkpoint holds no frames.</Note>

  const shown = version.frames.slice(0, 3)
  return (
    <span className="flex gap-1.5 px-4 pb-2.5">
      {shown.map((frame) => (
        <SnapshotThumb key={frame.id} frame={frame} />
      ))}
      {version.frames.length > shown.length && (
        <span className="grid flex-none place-items-center px-1 text-[10.5px] text-ink-faint">
          +{version.frames.length - shown.length}
        </span>
      )}
    </span>
  )
}

/** One snapshot frame's pixels: the hook owns the render and its object URL. */
function SnapshotThumb({ frame }: { frame: CanvasVersionFrame }) {
  const url = useHtmlPreview(frame.html, frame.width, frame.height)
  return (
    <span
      className="grid h-[58px] min-w-0 flex-1 place-items-center overflow-hidden rounded-[6px] border border-line bg-white"
      title={frame.name}
    >
      {url ? (
        <img src={url} alt={`${frame.name} at this checkpoint`} className="h-full w-full object-cover object-top" />
      ) : (
        <span className="text-[10.5px] text-ink-faint">…</span>
      )}
    </span>
  )
}
