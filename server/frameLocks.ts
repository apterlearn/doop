/**
 * Cooperative frame locks.
 *
 * Presence on a canvas is advisory: an agent that is "editing" a frame in the
 * UI can still be overwritten by another agent's tool call. A lock is the
 * explicit claim that makes that a conflict instead of a silent clobber.
 *
 * Deliberately in-process and time-bounded: a lock is a coordination hint
 * between agents sharing a canvas, not a distributed mutex. It expires on its
 * own so a crashed agent can never wedge a frame, and any writer can take it
 * over with `takeover: true`.
 */
export interface FrameLock {
  frameId: string
  canvasId: string
  agentName: string
  /** display name of the account whose token authorized the agent */
  owner?: string
  expiresAt: number
}

export const LOCK_TTL_MS = 120_000
export const MAX_LOCK_TTL_MS = 600_000

const locks = new Map<string, FrameLock>()

/** The live lock on this frame, if it belongs to someone else. `undefined`
 *  when the frame is free, the lock has expired, or the caller holds it. An
 *  expired lock is reported as absent but left in place: `takeExpired` is what
 *  removes it, and it is the only path that tells the room the holder is gone. */
export function heldBy(frameId: string, agentName: string): FrameLock | undefined {
  const lock = locks.get(frameId)
  if (!lock) return undefined
  if (lock.expiresAt <= Date.now()) return undefined
  return lock.agentName === agentName ? undefined : lock
}

/** Every live lock, for reporting and tests. Expired entries are omitted but
 *  left for `takeExpired`, so the room still hears about them. */
export function activeLocks(): FrameLock[] {
  const now = Date.now()
  return [...locks.values()].filter((lock) => lock.expiresAt > now)
}

/** Take the lock, or report who holds it. A lock you already hold is renewed
 *  rather than refused — re-entrant on purpose, so an agent can lock a frame
 *  it is mid-edit on without tracking its own state. */
export function acquire(
  frameId: string,
  canvasId: string,
  agentName: string,
  owner?: string,
  ttlMs = LOCK_TTL_MS,
): FrameLock | { heldBy: FrameLock } {
  const holder = heldBy(frameId, agentName)
  if (holder) return { heldBy: holder }
  const lock: FrameLock = {
    frameId,
    canvasId,
    agentName,
    ...(owner ? { owner } : {}),
    expiresAt: Date.now() + Math.min(Math.max(ttlMs, 1000), MAX_LOCK_TTL_MS),
  }
  locks.set(frameId, lock)
  return lock
}

/** Extend a lock the caller already holds. No-op when it holds none. */
export function refresh(frameId: string, agentName: string, ttlMs = LOCK_TTL_MS): void {
  const lock = locks.get(frameId)
  if (!lock || lock.agentName !== agentName) return
  lock.expiresAt = Date.now() + Math.min(Math.max(ttlMs, 1000), MAX_LOCK_TTL_MS)
}

/** Drop the lock when the caller holds it. */
export function release(frameId: string, agentName: string): boolean {
  const lock = locks.get(frameId)
  if (!lock || lock.agentName !== agentName) return false
  locks.delete(frameId)
  return true
}

/** Drop everything this agent holds on a canvas — run teardown, stop, or an
 *  explicit end_frame_edit for a frame it no longer knows about. Returns the
 *  frames it released, so the caller can tell the room they are free. */
export function releaseAllFor(canvasId: string, agentName: string): string[] {
  const released: string[] = []
  for (const [frameId, lock] of locks) {
    if (lock.canvasId === canvasId && lock.agentName === agentName) {
      locks.delete(frameId)
      released.push(frameId)
    }
  }
  return released
}

/** Release every lock on a frame, whoever holds it (takeover). */
export function releaseAll(frameId: string): FrameLock | undefined {
  const lock = locks.get(frameId)
  locks.delete(frameId)
  return lock
}

/** Expired locks, removed and returned. A lock that expires silently leaves
 *  the room showing a holder that is gone, so the sweep reports what it
 *  dropped. */
export function takeExpired(now = Date.now()): FrameLock[] {
  const expired: FrameLock[] = []
  for (const [frameId, lock] of locks) {
    if (lock.expiresAt <= now) {
      locks.delete(frameId)
      expired.push(lock)
    }
  }
  return expired
}

/** Thrown by the shared mutation layer when a write hits someone else's lock,
 *  so both the MCP surface and the resident team report it the same way. */
export class FrameLockedError extends Error {
  readonly holder: FrameLock
  constructor(holder: FrameLock) {
    super(`frame is being edited by ${holder.agentName} until ${new Date(holder.expiresAt).toISOString()}`)
    this.name = 'FrameLockedError'
    this.holder = holder
  }
}

/** Test-only: drop all locks. */
export function clearLocks(): void {
  locks.clear()
}
