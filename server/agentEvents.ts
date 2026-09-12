import type { AgentEvent, AgentEventKind } from '../shared/types.ts'

/**
 * In-process event bus for the agent↔human channel.
 *
 * MCP is pull-based and the /mcp transport is stateless, so an agent cannot
 * be pushed anything between calls. The one lever we have is a call the agent
 * is *already waiting inside*: ask_human and wait_for_events park here until
 * something relevant happens (or their timeout elapses) and return it in the
 * tool result. Events are also re-derivable from the DB-backed logs, so a
 * restart loses only in-flight waits — acceptable for a cooperative channel.
 */

const MAX_EVENTS = 200

interface Waiter {
  canvasId: string
  agentName: string
  cursor: number
  kinds?: AgentEventKind[]
  resolve: (events: AgentEvent[]) => void
  timer: NodeJS.Timeout
}

const log = new Map<string, AgentEvent[]>() // canvasId -> events (oldest first)
const cursors = new Map<string, number>() // canvasId -> last assigned seq
const waiters = new Set<Waiter>()

function nextSeq(canvasId: string): number {
  const seq = (cursors.get(canvasId) ?? 0) + 1
  cursors.set(canvasId, seq)
  return seq
}

/** Append an event and wake any waiter it satisfies. Never throws into the
 *  caller: an agent's tool result must not fail because the bus did. */
export function push(canvasId: string, event: { kind: AgentEventKind; targetAgent?: string; data?: unknown }): void {
  try {
    const full: AgentEvent = {
      seq: nextSeq(canvasId),
      at: Date.now(),
      kind: event.kind,
      ...(event.targetAgent ? { targetAgent: event.targetAgent } : {}),
      data: event.data,
    }
    const list = log.get(canvasId) ?? []
    list.push(full)
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
    log.set(canvasId, list)
    for (const waiter of [...waiters]) {
      if (waiter.canvasId !== canvasId) continue
      if (waiter.cursor >= full.seq) continue
      if (waiter.kinds && !waiter.kinds.includes(full.kind)) continue
      /* an event addressed to a specific agent only wakes that agent
         (case-insensitive: 'ux lead' and 'UX Lead' are the same role) */
      if (full.targetAgent && waiter.agentName && full.targetAgent.toLowerCase() !== waiter.agentName.toLowerCase())
        continue
      settle(waiter, matching(canvasId, waiter))
    }
  } catch (err) {
    console.error('[agent-events] push failed', err)
  }
}

function matching(canvasId: string, waiter: Waiter): AgentEvent[] {
  const list = log.get(canvasId) ?? []
  return list.filter((e) => {
    if (e.seq <= waiter.cursor) return false
    if (waiter.kinds && !waiter.kinds.includes(e.kind)) return false
    if (e.targetAgent && waiter.agentName && e.targetAgent.toLowerCase() !== waiter.agentName.toLowerCase())
      return false
    return true
  })
}

function settle(waiter: Waiter, events: AgentEvent[]) {
  clearTimeout(waiter.timer)
  waiters.delete(waiter)
  waiter.resolve(events)
}

/** The current cursor for a canvas — pass it back to only see newer events. */
export function cursor(canvasId: string): number {
  return cursors.get(canvasId) ?? 0
}

/** Events after `from`, oldest first. */
export function since(canvasId: string, from: number): AgentEvent[] {
  return (log.get(canvasId) ?? []).filter((e) => e.seq > from)
}

/** Park until an event matching the waiter arrives, or the timeout elapses.
 *  Resolves with [] on timeout — the caller reports `timed_out`, not an error. */
export function wait(
  canvasId: string,
  opts: { agentName: string; cursor: number; timeoutMs: number; kinds?: AgentEventKind[] },
): Promise<AgentEvent[]> {
  const immediate = matching(canvasId, {
    canvasId,
    agentName: opts.agentName,
    cursor: opts.cursor,
    kinds: opts.kinds,
    resolve: () => {},
    timer: undefined as unknown as NodeJS.Timeout,
  })
  if (immediate.length) return Promise.resolve(immediate)
  return new Promise<AgentEvent[]>((resolve) => {
    const waiter: Waiter = {
      canvasId,
      agentName: opts.agentName,
      cursor: opts.cursor,
      kinds: opts.kinds,
      resolve,
      timer: setTimeout(() => settle(waiter, []), Math.max(0, opts.timeoutMs)),
    }
    waiters.add(waiter)
  })
}

/** Is there anything an agent would care about right now? */
export function hasPending(canvasId: string, agentName: string, from = 0): boolean {
  return (log.get(canvasId) ?? []).some(
    (e) => e.seq > from && (!e.targetAgent || e.targetAgent.toLowerCase() === agentName.toLowerCase()),
  )
}

/** Drop a canvas's buffered events (canvas deleted). */
export function forget(canvasId: string): void {
  log.delete(canvasId)
  cursors.delete(canvasId)
  for (const waiter of [...waiters]) {
    if (waiter.canvasId === canvasId) settle(waiter, [])
  }
}
