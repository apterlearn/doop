import { useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Frame } from '../../shared/types'
import { api } from '../lib/api'
import { moveFrameInStack } from '../lib/frameOrder'
import { copyFrames, duplicateFrames, hasFrameClip, pasteFrameAtScreen } from '../lib/frameClipboard'
import { caughtStaleWrite, deleteFramesTracked, noteOwnWrite, recordUpdate } from '../lib/history'
import { useStore } from '../lib/store'
import { MOD_KEY } from '../lib/keys'
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { MenuHint } from './ui/menu'
import { Toast } from './ui/toast'
import { EyeIcon, EyeOffIcon, LockIcon, UnlockIcon } from './ui/icons'

/** Right-click menu for a frame. FrameView owns the trigger, and passes the
 *  point the right-click happened at — Paste lands there. */
export function FrameContextMenu({ frame, at }: { frame: Frame; at: MutableRefObject<{ x: number; y: number }> }) {
  /* a right-click inside a multi-selection acts on the whole group */
  const groupSize = useStore((s) => (s.selectedIds.includes(frame.id) ? s.selectedIds.length : 1))
  const [toast, setToast] = useState<string | null>(null)
  /* the component this frame is an instance of, when it is one: the wrapper
     attribute the insert path and every instance carry */
  const instanceOf = frame.html.match(/data-doop-component="([^"]+)"/)?.[1]
  function groupFrames(): Frame[] {
    const s = useStore.getState()
    const ids = s.selectedIds.includes(frame.id) ? s.selectedIds : [frame.id]
    return s.canvas?.frames.filter((f) => ids.includes(f.id)) ?? [frame]
  }
  function deleteSelection() {
    /* the count is the server's: part of a group may already be gone, and
       naming how many frames actually left is the whole of the confirmation */
    deleteFramesTracked(groupFrames())
      .then((n) => {
        if (n > 0) showToast(`${n} frame${n === 1 ? '' : 's'} moved to trash — undo with ⌘Z`)
      })
      .catch(console.error)
  }
  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }
  /* The frame's own markup becomes a library entry — html and size, exactly
     as it stands. It stays a plain frame on the canvas: unlike an instance, a
     definition is not linked to where it came from, so a later edit here does
     not rewrite it. The Components tab needs no nudge: the server broadcasts
     the new component, and the store folds it into the list. */
  function createComponent(variantOf?: string) {
    api
      .createComponent(frame.canvasId, {
        name: frame.name,
        html: frame.html,
        width: frame.width,
        height: frame.height,
        ...(variantOf ? { variantOf } : {}),
      })
      .then(() => showToast(variantOf ? `Saved “${frame.name}” as a variant` : `“${frame.name}” is now a component`))
      .catch((err: unknown) => {
        console.error(err)
        showToast('Couldn’t save the component')
      })
  }
  /** A presentation change on this one frame (stacking, lock, visibility):
   *  painted locally at once, written through the normal frame route, and
   *  recorded so ⌘Z puts it back — the three steps the Inspector's own fields
   *  take, and the reason a restack is undoable like any other edit. The copy
   *  the menu was opened on is the version the write preconditions on: a frame
   *  somebody else changed since refuses the flip instead of losing their
   *  change, and the frame repaints from the server's answer. */
  function commit(patch: Partial<Frame>) {
    recordUpdate(frame.id, frame, patch)
    useStore.getState().patchFrameLocal(frame.id, patch)
    api
      .updateFrame(frame.id, patch, { expectedUpdatedAt: frame.updatedAt })
      .then(noteOwnWrite)
      .catch((err: unknown) => {
        const conflict = caughtStaleWrite(err)
        if (conflict) showToast(conflict.error)
      })
  }
  return (
    <>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => copyFrames(groupFrames())}>
          {groupSize > 1 ? `Copy ${groupSize} frames` : 'Copy'}
          <MenuHint>{MOD_KEY}C</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!hasFrameClip()}
          onSelect={() => pasteFrameAtScreen(frame.canvasId, at.current.x, at.current.y)}
        >
          Paste
          <MenuHint>{MOD_KEY}V</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicateFrames(groupFrames())}>
          {groupSize > 1 ? `Duplicate ${groupSize} frames` : 'Duplicate'}
          <MenuHint>{MOD_KEY}D</MenuHint>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Stacking moves the frame the menu was opened on; the rest of a
            multi-selection keeps its own z. The write answers with the page's
            new front-to-back order, and frameOrder paints that answer */}
        <ContextMenuItem onSelect={() => moveFrameInStack(frame, 'front')}>
          Bring to front
          <MenuHint>{MOD_KEY}⇧]</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => moveFrameInStack(frame, 'forward')}>
          Forward
          <MenuHint>{MOD_KEY}]</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => moveFrameInStack(frame, 'backward')}>
          Backward
          <MenuHint>{MOD_KEY}[</MenuHint>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => moveFrameInStack(frame, 'back')}>
          Send to back
          <MenuHint>{MOD_KEY}⇧[</MenuHint>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* both toggles stay enabled on a locked frame: the server keeps lock,
            visibility and stacking writable precisely so the client that locked
            a frame can still reach it */}
        <ContextMenuItem
          title={
            frame.locked ? 'Allow edits to this frame again' : 'Block edits to this frame — content writes are refused'
          }
          onSelect={() => commit({ locked: !frame.locked })}
        >
          {frame.locked ? <UnlockIcon width={13} height={13} /> : <LockIcon width={13} height={13} />}
          {frame.locked ? 'Unlock' : 'Lock'}
        </ContextMenuItem>
        <ContextMenuItem
          title={frame.hidden ? 'Show this frame on the stage again' : 'Hide this frame — it stays in the Layers rail'}
          onSelect={() => commit({ hidden: !frame.hidden })}
        >
          {frame.hidden ? <EyeIcon width={13} height={13} /> : <EyeOffIcon width={13} height={13} />}
          {frame.hidden ? 'Show' : 'Hide'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => navigator.clipboard.writeText(`${location.origin}/c/${frame.canvasId}?frame=${frame.id}`)}
        >
          Copy link
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`)}>
          Copy image URL
        </ContextMenuItem>
        <ContextMenuItem asChild>
          <a href={`/i/${frame.id}.png?scale=2&download`}>Download PNG</a>
        </ContextMenuItem>
        <ContextMenuItem asChild>
          <a href={`/i/${frame.id}.jpg?scale=2&download`}>Download JPG</a>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          title="Will be used as reference — agents copy its style in new designs"
          onSelect={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
        >
          Add to design memory
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          title="Save this frame's markup to the canvas's component library, so agents and the Components tab can instance it"
          onSelect={() => createComponent()}
        >
          Create component
        </ContextMenuItem>
        {/* only on an instance: a variant is a variation on the component this
            frame already points at, so there is nowhere else it could go */}
        {instanceOf && (
          <ContextMenuItem
            title="Save this frame as a variation of the component it instances"
            onSelect={() => createComponent(instanceOf)}
          >
            Save as variant
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem tone="danger" onSelect={deleteSelection}>
          {groupSize > 1 ? `Move ${groupSize} frames to trash` : 'Move to trash'}
          <MenuHint>⌫</MenuHint>
        </ContextMenuItem>
      </ContextMenuContent>
      {/* outside the menu: Radix unmounts the content when the menu closes on
          select, and the confirmation would be unmounted with it */}
      {toast && <Toast>{toast}</Toast>}
    </>
  )
}
