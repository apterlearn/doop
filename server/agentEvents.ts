import { roleFor } from '../shared/agents.ts'
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
 *
 * The file also holds the stop/steer registry (bottom): in-process state, like
 * the frame locks and presence. A restart loses a pending stop, and that is
 * fine — it also ends the run the stop was aimed at.
 */

const MAX_EVENTS = 200

interface Waiter extends WaiterIdentity {
  canvasId: string
  cursor: number
  kinds?: AgentEventKind[]
  resolve: (events: AgentEvent[]) => void
  timer: NodeJS.Timeout
}

/** Who a parked agent is, for deciding whether an event is addressed to it. */
export interface WaiterIdentity {
  agentName: string
  /** the role the agent is working, as an id or a name */
  role?: string
}

/** Every spelling that addresses this agent: its own name, and the role it
 *  works.
 *
 *  A comment's target is either a role NAME (`@a11y` stores "Accessibility",
 *  so the note goes to whoever works that role) or an agent's own name
 *  (`@Claude`). Matching on the agent name alone leaves a parked agent asleep
 *  through a role mention — and `wait_for_events` is the only channel that
 *  reaches it between calls. */
function namesFor(who: WaiterIdentity): string[] {
  const out = new Set<string>()
  if (who.agentName) out.add(who.agentName.toLowerCase())
  /* an agent whose own name IS a role ("a11y", "Accessibility") is addressed
     by that role's name too */
  for (const role of [roleFor(who.agentName), roleFor(who.role)]) {
    if (!role) continue
    out.add(role.name.toLowerCase())
    out.add(role.id.toLowerCase())
  }
  return [...out]
}

/** Does this event address this agent? An event with no target reaches
 *  everyone. */
export function addressedTo(event: AgentEvent, who: WaiterIdentity): boolean {
  if (!event.targetAgent) return true
  return namesFor(who).includes(event.targetAgent.toLowerCase())
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
      /* an event addressed to a specific agent only wakes that agent — by its
         own name, or by the role it works */
      if (!addressedTo(full, waiter)) continue
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
    if (!addressedTo(e, waiter)) return false
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
  opts: WaiterIdentity & { cursor: number; timeoutMs: number; kinds?: AgentEventKind[] },
): Promise<AgentEvent[]> {
  const immediate = matching(canvasId, {
    canvasId,
    agentName: opts.agentName,
    ...(opts.role ? { role: opts.role } : {}),
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
      ...(opts.role ? { role: opts.role } : {}),
      cursor: opts.cursor,
      kinds: opts.kinds,
      resolve,
      timer: setTimeout(() => settle(waiter, []), Math.max(0, opts.timeoutMs)),
    }
    waiters.add(waiter)
  })
}

/** Drop a canvas's state (canvas deleted): its buffered events, its cursor,
 *  the stops and steers queued for its agents, and any parked waiter. */
export function forget(canvasId: string): void {
  log.delete(canvasId)
  cursors.delete(canvasId)
  stops.delete(canvasId)
  steers.delete(canvasId)
  for (const waiter of [...waiters]) {
    if (waiter.canvasId === canvasId) settle(waiter, [])
  }
}

/* -------------------------------------------------------------------------
 * Stop / steer registry
 * ---------------------------------------------------------------------- */

/**
 * What a human did to a running agent, remembered until the agent sees it.
 *
 * A stop or a steer is two things at once. It goes on the bus (through `push`
 * above, as a `'stop'`/`'steer'` event addressed to the agent), so an agent
 * already parked in wait_for_events / ask_human wakes with it in the tool
 * result. And it is kept here, because MCP is pull-based: an agent that is
 * *between* calls has nothing parked to wake, and the only thing that reaches
 * it is the call it is about to make. `pendingStop` is what a tool call checks
 * first — a pending stop refuses the call and ends the run — and `takeSteers`
 * is what a call drains to adjust course.
 *
 * Bounded per agent (one stop, the newest few steers) and cleared when it is
 * consumed: `clearStop` once the stop has been acted on, `takeSteers` as it
 * hands the steers over. Like the locks and presence this is in-process state,
 * so a restart loses a pending stop — acceptable, since a restart ends the run
 * it was aimed at too.
 */

/** One stop or steer, as the human asked for it. */
export interface AgentSignal {
  canvasId: string
  agentName: string
  kind: 'stop' | 'steer'
  message?: string
  at: number
  /** who asked — the human's display name, for the run timeline */
  by: string
}

/** Steers kept per agent: the most recent few, oldest first. */
const MAX_STEERS = 20

const stops = new Map<string, Map<string, AgentSignal>>() // canvasId -> agent key -> pending stop
const steers = new Map<string, Map<string, AgentSignal[]>>() // canvasId -> agent key -> unread steers, oldest first

/** The registry keys an agent name answers to: its own spelling, plus the
 *  role spellings the bus also addresses it by — an agent connected as "a11y"
 *  is "@Accessibility" to a human, and a stop aimed at the role must find it. */
function signalKeys(agentName: string): string[] {
  return [...new Set([agentName.trim().toLowerCase(), ...namesFor({ agentName })])]
}

function perAgent<T>(index: Map<string, Map<string, T>>, canvasId: string): Map<string, T> {
  const existing = index.get(canvasId)
  if (existing) return existing
  const created = new Map<string, T>()
  index.set(canvasId, created)
  return created
}

/** Ask an agent to stop. Delivered at once to a parked waiter and remembered
 *  until the agent's next call, which is refused. */
export function requestStop(canvasId: string, agentName: string, by: string): AgentSignal {
  const signal: AgentSignal = { canvasId, agentName, kind: 'stop', at: Date.now(), by }
  /* one stop per agent: a second press replaces the first rather than queueing
     behind it — the agent stops either way */
  perAgent(stops, canvasId).set(agentName.trim().toLowerCase(), signal)
  push(canvasId, { kind: 'stop', targetAgent: agentName, data: { by } })
  return signal
}

/** Redirect an agent that is mid-run — "use the brand blue", "stop after this
 *  frame". Delivered at once to a parked waiter and kept until the agent
 *  drains it with `takeSteers`. */
export function requestSteer(canvasId: string, agentName: string, message: string, by: string): AgentSignal {
  const signal: AgentSignal = { canvasId, agentName, kind: 'steer', message, at: Date.now(), by }
  const key = agentName.trim().toLowerCase()
  const index = perAgent(steers, canvasId)
  const list = index.get(key) ?? []
  list.push(signal)
  if (list.length > MAX_STEERS) list.splice(0, list.length - MAX_STEERS)
  index.set(key, list)
  push(canvasId, { kind: 'steer', targetAgent: agentName, data: { message, by } })
  return signal
}

/** The pending stop for this agent, if any — what a tool call checks first. */
export function pendingStop(canvasId: string, agentName: string): AgentSignal | undefined {
  const index = stops.get(canvasId)
  if (!index) return undefined
  for (const key of signalKeys(agentName)) {
    const signal = index.get(key)
    if (signal) return signal
  }
  return undefined
}

/** Consume (clear) an agent's pending stop — called once the stop has been
 *  acted on, so the run it ended does not refuse the next run's first call.
 *  `runId` names the run that ended, for the caller's bookkeeping: the stop is
 *  keyed by canvas + agent, not by run, so it does not narrow the removal. */
export function clearStop(canvasId: string, agentName: string, runId?: string): void {
  void runId
  const index = stops.get(canvasId)
  if (!index) return
  for (const key of signalKeys(agentName)) index.delete(key)
  if (index.size === 0) stops.delete(canvasId)
}

/** Steers the agent has not acknowledged yet, oldest first. Consumes them: the
 *  call that drains a steer is the call it was meant to change. */
export function takeSteers(canvasId: string, agentName: string): AgentSignal[] {
  const index = steers.get(canvasId)
  if (!index) return []
  const taken: AgentSignal[] = []
  for (const key of signalKeys(agentName)) {
    const list = index.get(key)
    if (!list) continue
    index.delete(key)
    taken.push(...list)
  }
  if (index.size === 0) steers.delete(canvasId)
  return taken.sort((a, b) => a.at - b.at)
}

/** Every signal a canvas is holding — pending stops and unread steers, oldest
 *  first. What the REST layer lists, so a human sees what is queued. */
export function listSignals(canvasId: string): AgentSignal[] {
  const out: AgentSignal[] = []
  for (const signal of stops.get(canvasId)?.values() ?? []) out.push(signal)
  for (const list of steers.get(canvasId)?.values() ?? []) out.push(...list)
  return out.sort((a, b) => a.at - b.at)
}
