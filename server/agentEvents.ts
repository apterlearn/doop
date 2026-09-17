import { roleFor } from '../shared/agents.ts'
import { db } from './db/index.ts'
import * as persist from './db/persist.ts'
import { store } from './store.ts'
import type { AgentEvent, AgentEventKind } from '../shared/types.ts'

/**
 * In-process event bus for the agent↔human channel.
 *
 * MCP is pull-based and the /mcp transport is stateless, so an agent cannot
 * be pushed anything between calls. The one lever we have is a call the agent
 * is *already waiting inside*: ask_human and wait_for_events park here until
 * something relevant happens (or their timeout elapses) and return it in the
 * tool result.
 *
 * The per-canvas ring below is the read path, and the durable half lives in
 * the database (agent_events, written behind like the run timeline). The
 * sequence is what makes a cursor mean something across a restart: it resumes
 * from the highest seq the canvas ever published, so a cursor an agent took
 * before the restart is still "everything up to here" afterwards. Without
 * that, the counter restarted at 1 while every connected agent held a cursor
 * from the old process, and `wait`/`matching` dropped every event that was not
 * past it — an agent that went silently deaf.
 *
 * The file also holds the stop/steer registry (bottom). A stop or a steer is
 * durable too: a restart must not swallow one a human just pressed, because
 * the restart is not what ended the run it was aimed at.
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

/** Fire-and-forget DB statement, the same contract runLog's write-behind has:
 *  `db` is unset until the server boots (and in module-level tests), and a
 *  failed write is logged rather than thrown — the ring above already holds
 *  the event, and losing durability must never fail the tool call that
 *  published it. The statements themselves go through the store, whose writes
 *  swallow their own rejections (persist.swallow); what this guard adds is the
 *  unbooted database and the synchronous failure. */
function writeBehind(statement: () => void): void {
  if (!db) return
  try {
    statement()
  } catch (err) {
    console.error('[agent-events] write failed', err)
  }
}

/** The one line the durable row carries: the human-readable field the event
 *  was published with, so a row read back from the table says what happened
 *  without the JSON payload. Capped like a run status line — the table is a
 *  log, not a transcript. */
function summaryOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const fields = data as Record<string, unknown>
  for (const key of ['text', 'message', 'answer', 'name']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return undefined
}

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
    /* the durable half: the seq just assigned is what a cursor taken before a
       restart is compared against, so it has to outlive this process */
    const summary = summaryOf(full.data)
    writeBehind(() =>
      store.saveAgentEvent({
        canvasId,
        seq: full.seq,
        kind: full.kind,
        at: full.at,
        ...(full.targetAgent ? { targetAgent: full.targetAgent } : {}),
        ...(summary ? { summary } : {}),
      }),
    )
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
 *  the stops and steers queued for its agents, any parked waiter, and the
 *  durable rows behind all of it. */
export function forget(canvasId: string): void {
  log.delete(canvasId)
  cursors.delete(canvasId)
  stops.delete(canvasId)
  steers.delete(canvasId)
  aliases.delete(canvasId)
  agentNames.delete(canvasId)
  writeBehind(() => store.deleteAgentEventsForCanvas(canvasId))
  writeBehind(() => store.deleteAgentSignalsForCanvas(canvasId))
  for (const waiter of [...waiters]) {
    if (waiter.canvasId === canvasId) settle(waiter, [])
  }
}

/** Seed the bus from the database at boot — what makes both halves survive a
 *  restart. The cursor per canvas is the highest seq it ever published, so the
 *  seq an agent took before the restart still means "I have seen up to here"
 *  and the next event it is waiting for is not silently dropped.
 *
 *  Untaken stops and steers are refiled under every spelling `signalKeys`
 *  answers to, exactly as `requestStop`/`requestSteer` file them live, so a stop
 *  aimed at a role still finds the agent working it. A row filed against a
 *  durable id is resolved through the agents table first: the press is filed
 *  under the id the server resolved, while the agent's own call carries the name
 *  it works under, and without the pairing the stop would be waiting for a
 *  spelling nothing ever looks up. Resolution runs over every row before any
 *  row is refiled, so a name-keyed row for the same agent picks the id up too.
 *
 *  Reads stay on the in-process maps — this is the only place that fills them
 *  from the store, and it runs before the server accepts a call. */
export async function hydrate(): Promise<void> {
  const [seqs, rows] = await Promise.all([store.listAgentEventCursors(), store.listPendingAgentSignals()])
  for (const [canvasId, seq] of seqs) cursors.set(canvasId, Math.max(cursors.get(canvasId) ?? 0, seq))
  for (const row of rows) {
    try {
      const agent = await persist.getAgent(row.target)
      if (agent) aliasAgent(row.canvasId, row.target, agent.name)
    } catch {
      /* a cold read that fails must not cost the boot the signals it is
         seeding: the row is still refiled under the spelling it was filed with */
    }
  }
  for (const row of rows) {
    const signal: AgentSignal = {
      canvasId: row.canvasId,
      /* the spelling the signal reads as — the agent's name when the row is
         keyed by its id, the spelling the human aimed at otherwise */
      agentName: displayName(row.canvasId, row.target),
      kind: row.kind,
      ...(row.message ? { message: row.message } : {}),
      at: row.at,
      by: row.by,
    }
    for (const key of signalKeys(row.canvasId, row.target)) {
      if (signal.kind === 'stop') {
        perAgent(stops, row.canvasId).set(key, signal)
        continue
      }
      const index = perAgent(steers, row.canvasId)
      const list = index.get(key) ?? []
      list.push(signal)
      if (list.length > MAX_STEERS) list.splice(0, list.length - MAX_STEERS)
      index.set(key, list)
    }
  }
}

/** Retention pass: forget everything at least `ms` old — what the boot path
 *  calls to keep seven days of history, mirroring runLog.pruneOlderThan. An
 *  event exactly on the cutoff counts as pruned. The ring is trimmed in
 *  memory and the durable rows go in two statements: the event log, and the
 *  signals, taken or not — a signal that old is aimed at a run that is over.
 *  The cursor itself is deliberately left alone: it is a high-water mark, and
 *  a prune must never move it back. */
export function pruneOlderThan(ms: number): void {
  const cutoff = Date.now() - ms
  for (const [canvasId, list] of log) {
    const kept = list.filter((event) => event.at > cutoff)
    if (kept.length === list.length) continue
    if (kept.length === 0) log.delete(canvasId)
    else log.set(canvasId, kept)
  }
  writeBehind(() => store.pruneAgentEvents(cutoff))
  writeBehind(() => store.pruneAgentSignals(cutoff))
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
 * with one difference: every signal is also written to agent_signals and read
 * back by `hydrate`, because a restart would otherwise swallow a stop a human
 * just pressed while the run it was aimed at is still going.
 *
 * A signal is filed under the spelling the server had: the durable agent id
 * when it resolved the press to one, the agent's name otherwise. The lookup
 * that delivers it comes from the agent's own call and carries its name, so the
 * two spellings are paired here — `aliasAgent` learns the pair the server
 * resolved, `hydrate` rebuilds it from the rows — and a signal filed under
 * either is found under both. An unregistered name has no pair and keys by
 * spelling alone, exactly as it always did.
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

/** The spellings the registry has learned address one agent, per canvas: the
 *  durable id a press is resolved to, and the name the agent works under. A
 *  signal is filed under the spelling the server had — the id when it resolved
 *  one, the name otherwise — and read back under whichever spelling the agent's
 *  own call carries, so the two have to meet somewhere. Learned where the
 *  server resolves the pair (`aliasAgent`) and rebuilt from the durable rows by
 *  `hydrate`; a canvas that never learned one simply keys by spelling. */
const aliases = new Map<string, Map<string, Set<string>>>() // canvasId -> key -> the other spellings

/** The name an id-keyed signal reads as, so what the humans' panel lists is the
 *  agent they aimed at rather than the id the route resolved. */
const agentNames = new Map<string, Map<string, string>>() // canvasId -> id spelling -> name

/** Which agents answer to a name, per canvas: a name is free text, so this is
 *  what tells a private name from one two accounts both work under. */
const nameOwners = new Map<string, Map<string, Set<string>>>() // canvasId -> name spelling -> ids

/** Every other spelling the registry knows addresses this agent. Looked up in
 *  both cases, because a lookup may come by either. */
function aliasSet(canvasId: string, key: string): Set<string> {
  const index = aliases.get(canvasId)
  if (!index) return new Set()
  return new Set([...(index.get(key) ?? []), ...(index.get(key.toLowerCase()) ?? [])])
}

/** Learn that a durable id and a display name are one agent — both ways, and in
 *  both cases, so a stop filed against the id is found by a lookup with the name
 *  and the other way round. Idempotent, and never a guess: the caller is the
 *  server, and the pair is the one it just resolved. */
export function aliasAgent(canvasId: string, id: string, name: string): void {
  const left = id.trim()
  const right = name.trim()
  if (!left || !right) return
  const index = perAgent(aliases, canvasId)
  for (const [from, to] of [
    [left, right],
    [right, left],
  ] as const) {
    for (const key of new Set([from, from.toLowerCase()])) {
      const known = index.get(key) ?? new Set<string>()
      known.add(to)
      known.add(to.toLowerCase())
      index.set(key, known)
    }
  }
  const names = perAgent(agentNames, canvasId)
  for (const key of new Set([left, left.toLowerCase()])) names.set(key, right)
  /* A name is free text: two accounts may both work as "Claude", and then it
     addresses two agents. Counted here so a lookup that knows its own id can
     tell a shared name from a private one — the name is not a key for a shared
     one, or a stop aimed at one Claude would end the other's run. */
  const owners = perAgent(nameOwners, canvasId)
  for (const key of new Set([right, right.toLowerCase()])) {
    const ids = owners.get(key) ?? new Set<string>()
    ids.add(left)
    owners.set(key, ids)
  }
}

/** Whether more than one agent answers to this name on this canvas — the
 *  question that decides if the name may stand in for an id. */
function sharedName(canvasId: string, name: string): boolean {
  const owners = nameOwners.get(canvasId)
  if (!owners) return false
  const ids = owners.get(name.trim()) ?? owners.get(name.trim().toLowerCase())
  return (ids?.size ?? 0) > 1
}

/** The spelling a signal reads as: the agent's name when the registry knows the
 *  id it was filed against, the filed spelling itself otherwise — an
 *  unregistered name is its own display name. */
function displayName(canvasId: string, key: string): string {
  const names = agentNames.get(canvasId)
  return names?.get(key) ?? names?.get(key.toLowerCase()) ?? key
}

/** The registry keys an agent answers to: its own spelling in both cases, the
 *  role spellings the bus also addresses it by — an agent connected as "a11y"
 *  is "@Accessibility" to a human, and a stop aimed at the role must find it —
 *  and every spelling the registry has learned is the same agent, which is what
 *  lets a stop filed against a durable id be found by the name the agent's own
 *  call carries. */
function signalKeys(canvasId: string, agentName: string): string[] {
  const out = new Set<string>()
  const add = (spelling: string) => {
    const key = spelling.trim()
    if (!key) return
    out.add(key)
    out.add(key.toLowerCase())
    for (const alias of aliasSet(canvasId, key)) out.add(alias)
  }
  add(agentName)
  for (const spelling of namesFor({ agentName })) out.add(spelling)
  return [...out]
}

function perAgent<T>(index: Map<string, Map<string, T>>, canvasId: string): Map<string, T> {
  const existing = index.get(canvasId)
  if (existing) return existing
  const created = new Map<string, T>()
  index.set(canvasId, created)
  return created
}

/** The registry keys a caller's own lookup may answer to.
 *
 *  When the caller has a durable id, the id is what decides: it is unique, so
 *  it cannot reach another agent. The name joins the lookup only when it
 *  addresses this agent alone — a name two accounts both work under is two
 *  agents, and delivering one Claude's stop to the other is exactly the mistake
 *  the id exists to prevent. A caller with no id (an unregistered name) looks up
 *  by spelling, as it always has.
 */
function lookupKeys(canvasId: string, agentName: string, agentId?: string): string[] {
  if (!agentId) return signalKeys(canvasId, agentName)
  const name = displayName(canvasId, agentId)
  if (!sharedName(canvasId, name)) return signalKeys(canvasId, agentId)
  const out = new Set<string>([agentId, agentId.toLowerCase()])
  for (const spelling of namesFor({ agentName: name })) out.add(spelling)
  return [...out]
}

/** Ask an agent to stop. Delivered at once to a parked waiter, remembered
 *  until the agent's next call (which is refused), and written through so a
 *  restart between the two does not lose it. `target` is the durable id when
 *  the caller resolved one and the agent's name otherwise — either way it is
 *  filed under every spelling the registry knows for that agent. */
export function requestStop(canvasId: string, target: string, by: string): AgentSignal {
  const key = target.trim()
  const signal: AgentSignal = { canvasId, agentName: displayName(canvasId, key), kind: 'stop', at: Date.now(), by }
  /* one stop per agent: a second press replaces the first rather than queueing
     behind it — the agent stops either way. Filed under every spelling that
     addresses it, so the lookup that follows finds it whether it comes by id or
     by name. */
  const index = perAgent(stops, canvasId)
  for (const spelling of signalKeys(canvasId, key)) index.set(spelling, signal)
  /* The durable row keeps the spelling the caller filed: an id has to resolve
     back to the agent's name at the next boot, and a name has to stay the name
     a human typed. */
  writeBehind(() => store.saveAgentSignal({ canvasId, target: key, kind: 'stop', by, at: signal.at }))
  /* the bus event is addressed by the agent's own spelling — a parked waiter
     matches on its name, never on an id */
  push(canvasId, { kind: 'stop', targetAgent: signal.agentName, data: { by } })
  return signal
}

/** Redirect an agent that is mid-run — "use the brand blue", "stop after this
 *  frame". Delivered at once to a parked waiter, kept until the agent drains
 *  it with `takeSteers`, and durable like a stop: a restart in between must
 *  not drop a course correction the human just made. Keyed exactly as a stop
 *  is, id or name, so the agent's own call finds it either way. */
export function requestSteer(canvasId: string, target: string, message: string, by: string): AgentSignal {
  const key = target.trim()
  const signal: AgentSignal = {
    canvasId,
    agentName: displayName(canvasId, key),
    kind: 'steer',
    message,
    at: Date.now(),
    by,
  }
  const index = perAgent(steers, canvasId)
  for (const spelling of signalKeys(canvasId, key)) {
    const list = index.get(spelling) ?? []
    list.push(signal)
    if (list.length > MAX_STEERS) list.splice(0, list.length - MAX_STEERS)
    index.set(spelling, list)
  }
  writeBehind(() => store.saveAgentSignal({ canvasId, target: key, kind: 'steer', message, by, at: signal.at }))
  push(canvasId, { kind: 'steer', targetAgent: signal.agentName, data: { message, by } })
  return signal
}

/** The pending stop for this agent, if any — what a tool call checks first. */
export function pendingStop(canvasId: string, agentName: string, agentId?: string): AgentSignal | undefined {
  const index = stops.get(canvasId)
  if (!index) return undefined
  for (const key of lookupKeys(canvasId, agentName, agentId)) {
    const signal = index.get(key)
    if (signal) return signal
  }
  return undefined
}

/** Consume (clear) an agent's pending stop — called once the stop has been
 *  acted on, so the run it ended does not refuse the next run's first call.
 *  `runId` names the run that ended, for the caller's bookkeeping: the stop is
 *  keyed by canvas + agent, not by run, so it does not narrow the removal.
 *  Every key holding the signal goes, not only the spellings this lookup
 *  answered to: one left behind would hand the same stop over again. The
 *  durable row is stamped taken rather than deleted, by the same keys, so the
 *  boot that follows does not hand the same stop to the next run. */
export function clearStop(canvasId: string, agentName: string, runId?: string): void {
  void runId
  const index = stops.get(canvasId)
  if (!index) return
  const signal = signalKeys(canvasId, agentName)
    .map((key) => index.get(key))
    .find((held) => held !== undefined)
  if (!signal) return
  const filed = [...index].filter(([, held]) => held === signal).map(([key]) => key)
  for (const key of filed) index.delete(key)
  if (index.size === 0) stops.delete(canvasId)
  writeBehind(() => store.markAgentSignalsTaken(canvasId, filed, 'stop'))
}

/** Steers the agent has not acknowledged yet, oldest first. Consumes them: the
 *  call that drains a steer is the call it was meant to change. The durable
 *  rows are stamped taken on the way out, so a restart cannot hand the same
 *  steer over twice. */
export function takeSteers(canvasId: string, agentName: string, agentId?: string): AgentSignal[] {
  const index = steers.get(canvasId)
  if (!index) return []
  const keys = new Set(lookupKeys(canvasId, agentName, agentId))
  const taken: AgentSignal[] = []
  for (const key of keys) taken.push(...(index.get(key) ?? []))
  if (taken.length === 0) return []
  /* the keys the steer was filed under are not only the ones this lookup
     answered to: a spelling left behind would hand the same steer over on the
     next call, so every key holding one of them is drained — and a key shared
     with another agent keeps the steers that are not being handed over */
  const handed = new Set(taken)
  const filed: string[] = []
  for (const [key, list] of [...index]) {
    const kept = list.filter((steer) => !handed.has(steer))
    if (kept.length === list.length) continue
    filed.push(key)
    if (kept.length) index.set(key, kept)
    else index.delete(key)
  }
  if (index.size === 0) steers.delete(canvasId)
  writeBehind(() => store.markAgentSignalsTaken(canvasId, filed, 'steer'))
  /* a hydrated signal is filed under every spelling it answers to, so the same
     steer can arrive through two keys — hand it over once */
  return [...new Set(taken)].sort((a, b) => a.at - b.at)
}

/** Every signal a canvas is holding — pending stops and unread steers, oldest
 *  first. What the REST layer lists, so a human sees what is queued. */
export function listSignals(canvasId: string): AgentSignal[] {
  const out = new Set<AgentSignal>()
  for (const signal of stops.get(canvasId)?.values() ?? []) out.add(signal)
  for (const list of steers.get(canvasId)?.values() ?? []) for (const signal of list) out.add(signal)
  return [...out].sort((a, b) => a.at - b.at)
}
