import type { Frame } from '../../shared/types'
import { api, staleFrameConflict, type StaleFrameConflict } from './api'
import { useStore } from './store'
import { posthog } from './posthog'

/** Local undo/redo for this client's own frame edits. Undo re-issues the
 *  inverse through the normal API, so every collaborator sees it live —
 *  remote actors' work is never undone from here.
 *
 *  The same module keeps the bookkeeping every one of those writes needs:
 *  `trackSave` for the ones still in flight, and the two below for what the
 *  server's answer to a preconditioned write means. */

type Patch = Partial<
  Pick<Frame, 'name' | 'html' | 'x' | 'y' | 'width' | 'height' | 'z' | 'locked' | 'hidden' | 'rotation' | 'opacity'>
>
type Snapshot = Pick<
  Frame,
  'canvasId' | 'name' | 'html' | 'x' | 'y' | 'width' | 'height' | 'z' | 'locked' | 'hidden' | 'rotation' | 'opacity'
> & { pageId?: string }

type Entry =
  | { type: 'update'; frameId: string; before: Patch; after: Patch; at: number }
  | { type: 'create'; frameId: string; snapshot: Snapshot }
  | { type: 'delete'; frameId: string; snapshot: Snapshot }
  /* one multi-frame action (a group move, a group delete): undone and
     redone as a unit */
  | { type: 'group'; entries: Entry[] }

const MAX = 100
/* consecutive edits to the same fields land as one entry within this window
   (the Inspector autosaves every 700ms while typing) */
const COALESCE_MS = 1500

let undoStack: Entry[] = []
let redoStack: Entry[] = []
let busy = false
/* saves still in flight from a drag: undo/redo wait for them so the inverse
   write never lands before (and gets overwritten by) the original */
let inflight: Promise<unknown> = Promise.resolve()

export function trackSave(p: Promise<unknown>) {
  inflight = inflight.then(() => p.catch(() => undefined))
}

/** A frame write's own answer says when the server now holds the frame as
 *  changed. The local copy takes it, so this client's NEXT write preconditions
 *  on its own last one instead of on a read that write already superseded —
 *  whose broadcast may still be in flight, which would fire the guard against
 *  the user's own work (a held arrow key, a burst of saves). */
export function noteOwnWrite(saved: Frame) {
  useStore.getState().patchFrameLocal(saved.id, { updatedAt: saved.updatedAt, updatedBy: saved.updatedBy })
}

/** The tail of a frame write this client made: a write the server refused
 *  because the frame moved on is painted back from the server's copy — the
 *  write landed nowhere, so the local one is what is wrong — and handed back
 *  for the caller to report in its own words. Any other failure is logged,
 *  exactly as the bare `.catch(console.error)` it replaces did. */
export function caughtStaleWrite(err: unknown): StaleFrameConflict | undefined {
  const conflict = staleFrameConflict(err)
  if (!conflict) {
    console.error(err)
    return undefined
  }
  useStore.getState().patchFrameLocal(conflict.current.id, conflict.current)
  return conflict
}

/* A replay the server refused because a frame it touches had moved on. The
   entry is no longer this client's to apply, so it is neither consumed nor
   half-applied: `step` catches this, puts the entry back where it came from,
   and reports the conflict. */
class StaleReplay extends Error {
  constructor(readonly conflict: StaleFrameConflict) {
    super(conflict.error)
    this.name = 'StaleReplay'
  }
}

export function clearHistory() {
  undoStack = []
  redoStack = []
}

function push(entry: Entry) {
  undoStack.push(entry)
  if (undoStack.length > MAX) undoStack.shift()
  redoStack = []
}

function snapshot(f: Frame): Snapshot {
  return {
    canvasId: f.canvasId,
    name: f.name,
    html: f.html,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    /* an undone delete recreates the frame through createFrame, which assigns
       a fresh z at the front of the page: carrying the original's stacking,
       lock, visibility, rotation and opacity means the frame comes back the
       way it left, not as a default-looking copy */
    z: f.z,
    locked: f.locked,
    hidden: f.hidden,
    rotation: f.rotation,
    opacity: f.opacity,
    pageId: f.pageId,
  }
}

type UpdateEntry = Extract<Entry, { type: 'update' }>

function updateEntry(frameId: string, before: Patch, after: Patch): UpdateEntry | null {
  const keys = (Object.keys(after) as (keyof Patch)[]).filter((k) => before[k] !== after[k])
  if (!keys.length) return null
  const b: Patch = {}
  const a: Patch = {}
  for (const k of keys) {
    b[k] = before[k] as never
    a[k] = after[k] as never
  }
  return { type: 'update', frameId, before: b, after: a, at: Date.now() }
}

export function recordUpdate(frameId: string, before: Patch, after: Patch) {
  const entry = updateEntry(frameId, before, after)
  if (!entry) return
  const keys = Object.keys(entry.after) as (keyof Patch)[]
  const top = undoStack[undoStack.length - 1]
  if (
    top?.type === 'update' &&
    top.frameId === frameId &&
    Date.now() - top.at < COALESCE_MS &&
    keys.every((k) => k in top.after)
  ) {
    /* merge a burst of saves: keep the oldest before, the newest after */
    top.after = { ...top.after, ...entry.after }
    top.at = Date.now()
    redoStack = []
    return
  }
  push(entry)
}

/** Several frames moved together (a group drag): one undo step. */
export function recordUpdates(items: { frameId: string; before: Patch; after: Patch }[]) {
  const entries = items.map((i) => updateEntry(i.frameId, i.before, i.after)).filter((e): e is UpdateEntry => !!e)
  const [first, ...rest] = entries
  if (!first) return
  push(rest.length ? { type: 'group', entries } : first)
}

export function recordCreate(frame: Frame) {
  push({ type: 'create', frameId: frame.id, snapshot: snapshot(frame) })
}

/** Several frames created together (a multi-frame paste): one undo step. */
export function recordCreates(frames: Frame[]) {
  if (!frames.length) return
  const entries: Entry[] = frames.map((f) => ({ type: 'create', frameId: f.id, snapshot: snapshot(f) }))
  const [first] = entries
  push(entries.length === 1 && first ? first : { type: 'group', entries })
}

/** Delete a frame through the API, remembering enough to bring it back. */
export function deleteFrameTracked(frame: Frame) {
  deleteFramesTracked([frame])
}

/** Delete several frames as one undo step. */
export function deleteFramesTracked(frames: Frame[]) {
  const entries: Entry[] = frames.map((f) => ({ type: 'delete', frameId: f.id, snapshot: snapshot(f) }))
  const [first, ...rest] = entries
  if (!first) return
  push(rest.length ? { type: 'group', entries } : first)
  for (const f of frames) api.deleteFrame(f.id).catch(console.error)
}

/* undoing a delete recreates the frame under a fresh server id — every
   other entry that pointed at the old id must follow it */
function remapId(oldId: string, newId: string) {
  const visit = (e: Entry) => {
    if (e.type === 'group') e.entries.forEach(visit)
    else if (e.frameId === oldId) e.frameId = newId
  }
  for (const e of [...undoStack, ...redoStack]) visit(e)
}

async function recreate(e: { frameId: string; snapshot: Snapshot }) {
  const { canvasId, z, locked, hidden, rotation, opacity, ...rest } = e.snapshot
  const f = await api.createFrame(canvasId, rest)
  const previousId = e.frameId
  remapId(e.frameId, f.id)
  e.frameId = f.id
  /* createFrame places the copy at the front of the page, unlocked and
     unrotated: the snapshot's stacking, lock, visibility, rotation and opacity
     land in a second call, so an undone delete brings the frame back exactly as
     it was. These five are the fields a user lock leaves writable, so a frame
     that comes back locked still accepts this patch — and the copy is only a
     moment old, so the precondition can only fail if something reached the new
     frame first, which is not this entry's to overwrite. */
  try {
    await api.updateFrame(f.id, { z, locked, hidden, rotation, opacity }, { expectedUpdatedAt: f.updatedAt })
  } catch (err) {
    const conflict = staleFrameConflict(err)
    if (!conflict) throw err
    /* Give the entry back the id it had and take the half-made copy off the
       canvas: a replay after the reload recreates the frame from the snapshot,
       and a stray second frame would be a duplicate nothing points at. Every
       other entry that followed the remap goes back to the dead id with it —
       which is where they were, waiting for the replay that finally lands. */
    e.frameId = previousId
    remapId(f.id, previousId)
    await api.deleteFrame(f.id).catch(console.error)
    throw new StaleReplay(conflict)
  }
}

/* the frames an applied entry brought back (a redone create, an undone
   delete): they become the selection, as a group when several returned */
function recreatedIds(e: Entry, direction: 'undo' | 'redo'): string[] {
  if (e.type === 'group') return e.entries.flatMap((child) => recreatedIds(child, direction))
  const recreated = e.type === (direction === 'redo' ? 'create' : 'delete')
  return recreated ? [e.frameId] : []
}

/* Apply an entry and report which of its members took effect. A group's
   frames are independent, so every member is attempted even if one fails;
   the survivors are what the opposite stack gets, so a partially failed
   group can still be reversed. Failed members are dropped, exactly as a
   failed single entry is: the frame is gone or the canvas moved on — except
   for a frame that moved on, which is refused whole and stops the step (a
   StaleReplay: see step). */
async function apply(e: Entry, direction: 'undo' | 'redo'): Promise<Entry | null> {
  if (e.type === 'group') {
    const results = await Promise.allSettled(e.entries.map((child) => apply(child, direction)))
    /* one refused member stops the group rather than being dropped from it:
       the entry goes back whole, so the next attempt is the same undo over the
       state the reload left behind — its patches are absolute values, so a
       member that did land is a value no-op when it is re-applied */
    const stale = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && r.reason instanceof StaleReplay,
    )
    if (stale) throw stale.reason
    const ok = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) console.error(`${direction} failed for ${e.entries.length - ok.length} frame(s)`, failed.reason)
    const [first, ...rest] = ok
    if (!first) return null
    return rest.length ? { type: 'group', entries: ok } : first
  }
  const forward = direction === 'redo'
  if (e.type === 'update') {
    const patch = forward ? e.after : e.before
    /* the live copy's updatedAt is the version this entry was written against:
       a frame that moved on since — someone else's edit, an agent's stream —
       refuses the inverse instead of overwriting their work with a value from
       a canvas nobody has any more. A frame the canvas no longer holds has
       nothing to precondition on, and no local copy either. */
    const live = useStore.getState().canvas?.frames.find((f) => f.id === e.frameId)
    useStore.getState().patchFrameLocal(e.frameId, patch)
    try {
      /* the answer carries the frame's new freshness, and the local copy takes
         it: an undo and the redo that follows it are two writes to the same
         frame, and the second must precondition on the first's, not on the
         read before it (whose broadcast may still be in flight) */
      const saved = await api.updateFrame(e.frameId, patch, live ? { expectedUpdatedAt: live.updatedAt } : undefined)
      noteOwnWrite(saved)
    } catch (err) {
      const conflict = staleFrameConflict(err)
      if (conflict) {
        /* the server's copy is the truth and the only thing worth painting:
           the local patch above was never ours to keep */
        useStore.getState().patchFrameLocal(conflict.current.id, conflict.current)
        throw new StaleReplay(conflict)
      }
      /* the server kept the old value — put the local copy back in step
         with it rather than leave a client-only position behind */
      useStore.getState().patchFrameLocal(e.frameId, forward ? e.before : e.after)
      throw err
    }
  } else if ((e.type === 'create') === forward) {
    await recreate(e)
  } else {
    await api.deleteFrame(e.frameId)
  }
  return e
}

/** Take one step through the stacks, and report a step the server refused
 *  because a frame it touches had moved on. */
async function step(direction: 'undo' | 'redo'): Promise<StaleFrameConflict | undefined> {
  if (busy) return undefined
  const [from, to] = direction === 'undo' ? [undoStack, redoStack] : [redoStack, undoStack]
  const e = from.pop()
  if (!e) return undefined
  busy = true
  try {
    await inflight
    const applied = await apply(e, direction)
    if (applied) {
      to.push(applied)
      const ids = recreatedIds(applied, direction)
      if (ids.length) useStore.getState().selectMany(ids)
      posthog.capture(direction === 'undo' ? 'canvas_undo' : 'canvas_redo')
    }
  } catch (err) {
    if (err instanceof StaleReplay) {
      /* The entry is not this client's to apply any more, and nothing about it
         is half-done: the local canvas was repainted from the frame the server
         sent back. So it goes straight back on the stack it came from — the
         last one popped, so the stacks are exactly as they were before the
         step — rather than being consumed, and the caller gets the conflict to
         report. A reload of the canvas, and ⌘Z again, is the retry. */
      from.push(e)
      return err.conflict
    }
    /* the frame is gone or the canvas moved on — drop the entry */
    console.error(`${direction} failed`, err)
  } finally {
    busy = false
  }
  return undefined
}

export function undo() {
  return step('undo')
}

export function redo() {
  return step('redo')
}
