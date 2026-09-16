import { useEffect, useRef, useState } from 'react'
import type { Frame } from '../../shared/types'
import type { CanvasVersion, CanvasVersionDiff, CanvasVersionFrame, CanvasVersionSummary } from '../lib/api'
import { api } from '../lib/api'
import { recordCreates, recordUpdates } from '../lib/history'
import { useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import { Callout } from './ui/callout'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { ListItem, ListMeta, ListTitle } from './ui/list'
import { Modal, ModalActions, ModalLede, ModalTitle } from './ui/modal'
import { Note } from './ui/note'
import { PanelBody, PanelDisclosure } from './ui/panel'
import { Toast } from './ui/toast'

/* The History tab: every checkpoint of the whole canvas — the ones the server
   takes on its own while the canvas is edited, before a delete, and the ones a
   person asks for — newest first, each one previewable, comparable against the
   canvas as it stands, and restorable.
   This is the canvas-wide twin of the Inspector's frame history, and it is the
   answer to "I deleted that frame / that agent rewrote everything": a
   checkpoint is a way back, and restoring one is itself checkpointed so a
   restore is never a one-way door — and, since the restore is written as the
   ordinary frame edits it is, it is a ⌘Z away like any other edit. */

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
  /* which checkpoint the comparison modal is open on, and what came back for
     it: an id with no diff and no error is the render still on its way, which
     is one state the button and the modal both read */
  const [diffId, setDiffId] = useState<string | null>(null)
  const [diff, setDiff] = useState<CanvasVersionDiff | null>(null)
  const [diffError, setDiffError] = useState(false)
  /* rendering a page twice takes a second or two, and a person can move on to
     another checkpoint while one is still rendering: only the newest request
     may write the diff state */
  const diffRequest = useRef(0)

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

  /* Comparing renders the page twice on the server, so the modal opens on its
     loading state and fills in when the pair arrives — and says so when the
     render fails, rather than spinning at something that will never come. */
  function openDiff(versionId: string) {
    if (!canvasId) return
    const request = ++diffRequest.current
    setDiffId(versionId)
    setDiff(null)
    setDiffError(false)
    api
      .canvasVersionDiff(canvasId, versionId, useStore.getState().activePageId)
      .then((next) => {
        if (diffRequest.current === request) setDiff(next)
      })
      .catch((err: unknown) => {
        console.error(err)
        if (diffRequest.current === request) setDiffError(true)
      })
  }

  function closeDiff() {
    /* whatever is still rendering is no longer this panel's to land */
    diffRequest.current++
    setDiffId(null)
    setDiff(null)
    setDiffError(false)
  }

  /* Restoring writes the snapshot's frames back as ordinary edits, so the room
     is told what changed; what it does not touch is a frame added since — the
     server neither deletes nor rewrites those. `created` counts the frames the
     snapshot brought back that had been deleted in the meantime.

     Those writes are this client's own, so they are recorded for ⌘Z like any
     edit it makes: each frame the checkpoint rewrites gets its live values
     paired with the checkpoint's, and each frame the checkpoint brings back
     gets a create. The values are read before the write — once the restore has
     landed, the live canvas is the checkpoint's. The entries are pushed only
     after the restore answered ok: a restore that failed changed nothing, so
     an entry for it would be a step into a state nobody was ever in. */
  async function restore() {
    const versionId = confirmId
    setConfirmId(null)
    if (!canvasId || !versionId || restoring) return
    setRestoring(true)
    setError(null)
    try {
      const version = await api.getCanvasVersion(canvasId, versionId)
      /* the live canvas, read by frame id: every frame the checkpoint names is
         looked up against it below */
      const live: Record<string, Frame> = {}
      for (const frame of useStore.getState().canvas?.frames ?? []) live[frame.id] = frame
      const updates: { frameId: string; before: RestoreFields; after: RestoreFields }[] = []
      const created: Frame[] = []
      for (const frame of snapshotFrames(version)) {
        /* hasOwn, not a bare read: a frame id that happens to name something on
           Object.prototype is not a frame this canvas holds */
        const current = Object.hasOwn(live, frame.id) ? live[frame.id] : undefined
        /* gone since the checkpoint: the restore recreates it under the id the
           snapshot kept, so undoing the restore removes that frame again */
        if (!current) {
          created.push(frame)
          continue
        }
        const before = restoreFields(current)
        const after = restoreFields(frame)
        /* only the fields the restore actually writes: a page the checkpoint
           never kept is not the restore's to write, so it is not the undo's
           either — the same reading the server makes of a snapshot */
        const keys = Object.keys(after) as (keyof RestoreFields)[]
        if (keys.some((k) => before[k] !== after[k])) updates.push({ frameId: frame.id, before, after })
      }
      const { restored, created: recreated } = await api.restoreCanvasVersion(canvasId, versionId)
      recordUpdates(updates)
      recordCreates(created)
      const line = `Restored ${restored} frame${restored === 1 ? '' : 's'}`
      showToast(recreated ? `${line} · ${recreated} re-created` : line)
      /* the restore is itself a checkpoint, so the top of the list is a new
         row — refetching shows it and re-times everything else */
      reload()
    } catch (err: unknown) {
      console.error(err)
      setError('This checkpoint could not be restored.')
    } finally {
      setRestoring(false)
    }
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
                    disabled={diffId === v.id && !diff && !diffError}
                    onClick={() => openDiff(v.id)}
                  >
                    {diffId === v.id && !diff && !diffError ? 'Comparing…' : 'See what changed'}
                  </Button>
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
        description="Every frame in this checkpoint goes back to what it held then, and the frames it names are recreated if they were deleted. Frames added since are left alone. The restore is saved as a new checkpoint, and it is written as ordinary frame edits — so ⌘Z takes it back like any other edit."
        confirmLabel="Restore"
        onConfirm={restore}
      />
      {diffId && (
        <Modal size="xl" onClose={closeDiff}>
          <ModalTitle>What this checkpoint changes</ModalTitle>
          <ModalLede>
            The page you are looking at now, next to the same page as this checkpoint held it. Nothing is written until
            you ask for the restore — this is only the two renders.
          </ModalLede>
          <VersionDiffBody diff={diff} failed={diffError} />
          <ModalActions>
            <Button variant="ghost" onClick={closeDiff}>
              Close
            </Button>
          </ModalActions>
        </Modal>
      )}
      {toast && <Toast>{toast}</Toast>}
    </PanelBody>
  )
}

/** The comparison itself: the two renders side by side once they are made, and
 *  the two ways it can come back uninteresting — a page with nothing on one
 *  side of it, and a render that failed. The waiting state lives with the modal
 *  (a null diff), so this draws what the server answered and nothing else. */
function VersionDiffBody({ diff, failed }: { diff: CanvasVersionDiff | null; failed: boolean }) {
  if (failed)
    return (
      <Callout tone="error" className="mt-4">
        This comparison could not be rendered.
      </Callout>
    )
  if (!diff) return <Note className="mt-4 block">Rendering this page twice… one moment.</Note>
  /* a checkpoint taken when the page held nothing renderable (or a page added
     since it) has no second image to put beside the first */
  if (diff.empty || !diff.current || !diff.version)
    return <Note className="mt-4 block">Nothing to compare on this page.</Note>
  return (
    <div className="mt-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DiffRender src={diff.current} label="Now" alt="This page as it stands now" />
        <DiffRender src={diff.version} label="This checkpoint" alt="This page as the checkpoint held it" />
      </div>
      {diff.changedRatio !== undefined && (
        <ListMeta className="mt-2 block">
          {(diff.changedRatio * 100).toFixed(diff.changedRatio > 0 && diff.changedRatio < 0.01 ? 2 : 1)}% of the pixels
          differ
        </ListMeta>
      )}
    </div>
  )
}

/** One side of the comparison: the render, captioned with what it is. */
function DiffRender({ src, label, alt }: { src: string; label: string; alt: string }) {
  return (
    <figure className="min-w-0">
      <img src={src} alt={alt} className="w-full rounded-[8px] border border-line bg-white" />
      <ListMeta className="mt-1 block">{label}</ListMeta>
    </figure>
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

/** The fields a restore writes back on a frame it finds: the eleven every frame
 *  write carries, plus the page a checkpoint can move a frame to. History's own
 *  patch type stops at the eleven — its entries are the editor's edits — but
 *  the frame route takes `pageId`, and a restore that moved a frame between
 *  pages has to be undone as a move, not left half-reverted. */
type RestoreFields = Partial<
  Pick<Frame, 'name' | 'html' | 'x' | 'y' | 'width' | 'height' | 'z' | 'locked' | 'hidden' | 'rotation' | 'opacity'>
> & { pageId?: string }

/** A frame's side of an undo pair. The page travels only when the frame has
 *  one: a checkpoint that never kept a page leaves the live frame's alone, so
 *  omitting it here is what keeps the undo from claiming a page change that the
 *  restore never made. */
function restoreFields(frame: Frame): RestoreFields {
  return {
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    html: frame.html,
    z: frame.z,
    locked: frame.locked,
    hidden: frame.hidden,
    rotation: frame.rotation,
    opacity: frame.opacity,
    ...(frame.pageId ? { pageId: frame.pageId } : {}),
  }
}

/** A checkpoint's frames as ordinary frames — the server's own reading of a
 *  snapshot (`releaseFrames` in server/db/persist.ts), so the values this
 *  panel pairs for undo are the values a restore actually writes: the frozen
 *  stacking, lock, visibility, rotation and opacity come back with their
 *  defaults when the snapshot predates them, and `updatedAt` is the snapshot
 *  time, because that is when these frames are from. */
function snapshotFrames(version: CanvasVersion): Frame[] {
  return version.frames.map((frame, i) => ({
    id: frame.id,
    canvasId: version.canvasId,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    html: frame.html,
    /* a snapshot stored before the frame model carried stacking kept its
       frames in paint order: the index is the z it was frozen with */
    z: frame.z ?? i,
    locked: frame.locked ?? false,
    hidden: frame.hidden ?? false,
    rotation: frame.rotation ?? 0,
    opacity: frame.opacity ?? 1,
    createdAt: 0,
    updatedAt: version.createdAt,
    updatedBy: version.createdBy,
    ...(frame.pageId ? { pageId: frame.pageId } : {}),
  }))
}
