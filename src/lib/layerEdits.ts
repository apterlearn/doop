import type { Frame } from '../../shared/types'
import { useStore } from './store'
import { api } from './api'
import { caughtStaleWrite, noteOwnWrite, recordUpdate } from './history'
import { duplicateElement, removeElement, replaceElement } from './layers'

/* ---- element edits shared by the Layers rail and the element panel ---- */

export function saveFrameHtml(frame: Frame, html: string) {
  recordUpdate(frame.id, { html: frame.html }, { html })
  useStore.getState().patchFrameLocal(frame.id, { html })
  /* The html the caller worked from is the version this write expects to
     replace: an agent that streamed into the frame in the meantime refuses it
     whole rather than have its design overwritten by an edit built on text
     that is no longer there. A refusal paints the server's copy back over the
     local one — the element edit visibly comes undone — and says why. */
  api
    .updateFrame(frame.id, { html }, { expectedUpdatedAt: frame.updatedAt })
    .then(noteOwnWrite)
    .catch((err: unknown) => {
      const conflict = caughtStaleWrite(err)
      if (conflict) console.error(conflict.error)
    })
}

export function deleteLayer(frame: Frame, selector: string) {
  const html = removeElement(frame.html, selector)
  if (html === null) return
  const store = useStore.getState()
  store.setSelectedElement(null)
  store.setElementPanelOpen(false)
  saveFrameHtml(frame, html)
}

export function duplicateLayer(frame: Frame, selector: string) {
  const html = duplicateElement(frame.html, selector)
  if (html !== null) saveFrameHtml(frame, html)
}

/** Swap one element's markup; false when the selector no longer resolves. */
export function replaceLayerHtml(frame: Frame, selector: string, outerHtml: string): boolean {
  const html = replaceElement(frame.html, selector, outerHtml)
  if (html === null) return false
  saveFrameHtml(frame, html)
  return true
}
