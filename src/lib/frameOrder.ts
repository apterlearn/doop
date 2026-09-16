import type { Frame } from '../../shared/types'
import { api } from './api'
import { useStore } from './store'
import { recordUpdate, recordUpdates } from './history'

/** Frame stacking. A frame's `z` is the authority on where it paints — higher
 *  in front, ties broken by array order — and it lives on the server, so the
 *  ws 'frames:reordered' broadcast is the durable path: every client, this one
 *  included, ends up on the order the server settled on. What these helpers
 *  add is the keystroke-to-paint path in between: they apply the order the
 *  write already answered with, so a ⌘] feels instant instead of waiting a
 *  round trip. A failure is therefore only a late paint, never lost work —
 *  hence console.error rather than a throw the caller would have to handle.
 *
 *  These helpers own the undo step for a restack, and callers must not record
 *  one themselves: the server decides the resulting `z` (it packs the page),
 *  so a caller could only guess at the `after` a redo would write. Here the
 *  answer is already in hand, and nothing is recorded when the write fails,
 *  which is right — no write, nothing to undo. */

export type ZDir = 'front' | 'back' | 'forward' | 'backward'

/** Move one frame within its page's stack (`forward`/`backward` one slot,
 *  `front`/`back` all the way), then repaint the page in the order the server
 *  returned. A frame with no pageId falls back to '' — applyFrameOrderLocal
 *  skips frames whose pageId does not match, so that is a quiet no-op, and
 *  the broadcast still lands. */
export async function moveFrameInStack(frame: Frame, dir: ZDir): Promise<void> {
  const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.z ?? frame.z
  await api
    .moveFrameZ(frame.id, dir)
    .then((returned) => {
      useStore.getState().applyFrameOrderLocal(returned[0]?.pageId ?? frame.pageId ?? '', returned)
      const settled = returned.find((f) => f.id === frame.id)
      if (settled && settled.z !== before) recordUpdate(frame.id, { z: before }, { z: settled.z })
    })
    .catch(console.error)
}

/** Write an explicit front-to-back order for a page — what a drag in the
 *  Layers rail produces — and repaint from the server's answer. Every frame
 *  whose z actually moved lands in one undo step, the way a group drag does. */
export async function setFrameStackOrder(pageId: string, orderedIds: string[]): Promise<void> {
  const canvasId = useStore.getState().canvas?.id
  if (!canvasId) return
  const before = new Map((useStore.getState().canvas?.frames ?? []).map((f) => [f.id, f.z]))
  await api
    .setFrameOrder(canvasId, pageId, orderedIds)
    .then((returned) => {
      useStore.getState().applyFrameOrderLocal(returned[0]?.pageId ?? pageId, returned)
      const moved = returned.flatMap((f) => {
        const was = before.get(f.id)
        return was === undefined || was === f.z ? [] : [{ frameId: f.id, before: { z: was }, after: { z: f.z } }]
      })
      if (moved.length) recordUpdates(moved)
    })
    .catch(console.error)
}
