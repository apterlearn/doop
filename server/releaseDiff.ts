import * as persist from './db/persist.ts'
import { htmlDiff } from './htmlDiff.ts'
import { store } from './store.ts'
import { diffFrames } from './visualDiff.ts'

/**
 * What changed since the release the client was sent.
 *
 * A release is a frozen snapshot; the canvas keeps moving. "Send me an update
 * on what moved" is unanswerable from either side alone — the snapshot has no
 * live frames and the canvas has no memory of what was frozen — so this walks
 * the two side by side. Identity is the frame id, which is what survives a
 * rename; an edit becomes a pixel ratio when both versions render at the same
 * size (the honest measure of "is this the same design") and a line diff when
 * they do not, or when no browser is available to render.
 */

/** One frame's place in the comparison. `changedRatio` is set only on the
 *  render path and `textAdded`/`textRemoved` only on the line-diff fallback. */
export interface ReleaseDiffFrame {
  frameId: string
  name: string
  changed: boolean
  status: 'changed' | 'unchanged' | 'added' | 'removed'
  changedRatio?: number
  textAdded?: number
  textRemoved?: number
}

export async function diffRelease(
  canvasId: string,
  releaseId: string,
): Promise<{ releaseName: string; frames: ReleaseDiffFrame[]; changedCount: number }> {
  const release = await persist.getRelease(releaseId)
  if (!release) throw new Error(`no release ${releaseId}`)
  if (release.canvasId !== canvasId)
    throw new Error(`release ${releaseId} belongs to canvas ${release.canvasId}, not ${canvasId}`)
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new Error(`no canvas ${canvasId}`)

  /* The canvas's own frames, the same accessor and the same demo filter the
     MCP tools use, so a seeded welcome frame is never reported as new work. */
  const live = new Map(canvas.frames.filter((f) => !f.demo).map((f) => [f.id, f]))
  const frames: ReleaseDiffFrame[] = []
  let changedCount = 0

  for (const frozen of persist.releaseFrames(release)) {
    const frame = live.get(frozen.id)
    if (!frame) {
      frames.push({ frameId: frozen.id, name: frozen.name, changed: true, status: 'removed' })
      changedCount += 1
      continue
    }
    /* matched, so it is not "added" below however it comes out */
    live.delete(frozen.id)
    /* Identical bytes mean nothing to render — the common case, and the one
       that has to stay cheap enough to run on every release. */
    if (frame.html === frozen.html) {
      frames.push({ frameId: frame.id, name: frame.name, changed: false, status: 'unchanged' })
      continue
    }
    changedCount += 1
    const entry: ReleaseDiffFrame = { frameId: frame.id, name: frame.name, changed: true, status: 'changed' }
    const sameWidth = Math.round(frozen.width) === Math.round(frame.width)
    const sameHeight = Math.round(frozen.height) === Math.round(frame.height)
    if (sameWidth && sameHeight) {
      /* Both sides render at the frozen size with the canvas's design tokens
         bound at render time (loadFramePage reads them off the frame's canvas,
         which both frames carry) — the same pipeline every screenshot, probe
         and review goes through. */
      try {
        const diff = await diffFrames(frozen, frame)
        entry.changedRatio = diff.changed_ratio
        frames.push(entry)
        continue
      } catch {
        /* no renderer: the line diff still answers "what moved" */
      }
    }
    const text = htmlDiff(frozen.html, frame.html)
    entry.textAdded = text.added
    entry.textRemoved = text.removed
    frames.push(entry)
  }

  /* Whatever the release never froze was added after it. */
  for (const frame of live.values()) {
    frames.push({ frameId: frame.id, name: frame.name, changed: true, status: 'added' })
    changedCount += 1
  }

  return { releaseName: release.name, frames, changedCount }
}
