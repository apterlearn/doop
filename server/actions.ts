import { nanoid } from 'nanoid'
import { store } from './store.ts'
import * as persist from './db/persist.ts'
import * as frameLocks from './frameLocks.ts'
import * as agentEvents from './agentEvents.ts'
import * as thumbs from './thumbs.ts'
import { colorFor } from '../shared/types.ts'
import { validateTokens } from './tokenCss.ts'
import { stripTokenStyle } from '../shared/tokens.ts'
import {
  DEFAULT_ROLE_ID,
  mentionedAgent,
  mentionedRole,
  normalizePipeline,
  roleByAgentName,
  roleName,
} from '../shared/agents.ts'
import { MAX_FRAME_HTML_BYTES } from './limits.ts'
import { insertElement, updateElements } from './elementEdit.ts'
import { decodeEscapedHtml, looksEscapedHtml, repairEscapedHtml } from './escapedHtml.ts'
import type {
  Actor,
  ActivityItem,
  AgentPlan,
  AgentTask,
  Canvas,
  CanvasFocus,
  Component,
  ComponentSummary,
  DesignDecision,
  DesignTokens,
  ElementComment,
  Frame,
  FrameProposal,
  AgentQuestion,
  TaskUsage,
  RunJournal,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  PlanStep,
  RepoCardKind,
  RepoCardPayload,
  RepoScreenRef,
  ServerMessage,
  TaskFeedback,
  ReviewPolicy,
  UserMemory,
} from '../shared/types.ts'

/**
 * Mutations shared by the REST API and the MCP tools. Every mutation
 * appends to the canvas activity log and broadcasts to the ws room.
 */

type Broadcast = (canvasId: string, msg: ServerMessage, excludeClientId?: string) => void
type AgentTouch = (
  canvasId: string,
  agentName: string,
  frameId?: string | null,
  status?: string | null,
  owner?: string,
  ownerId?: string,
) => void

let broadcast: Broadcast = () => {}
let agentTouch: AgentTouch = () => {}

/** Abort the in-flight resident run(s) on a canvas. Absent when the resident
 *  team is not wired — the no-op keeps every other behaviour intact. */
type Cancel = (canvasId: string) => void

let cancel: Cancel = () => {}

/** Flag an agent's presence as parked in a long wait; owned by index.ts. */
type MarkWaiting = (canvasId: string, agentName: string, waiting: boolean) => void

let markWaiting: MarkWaiting = () => {}

export function wire(b: Broadcast, t: AgentTouch, c?: Cancel, w?: MarkWaiting) {
  broadcast = b
  agentTouch = t
  cancel = c ?? (() => {})
  markWaiting = w ?? (() => {})
}

/** An agent currently present on a canvas, as index.ts's presence map holds
 *  it. The map lives in index.ts, which actions.ts must not import, so the
 *  reader is wired in at boot like the broadcaster. */
export interface AgentPresenceEntry {
  name: string
  owner?: string
  status?: string | null
  frameId?: string | null
  waiting?: boolean
  lastSeen: number
}
type PresenceReader = (canvasId: string) => AgentPresenceEntry[]

let presenceReader: PresenceReader = () => []

/** Wired once from index.ts. Absent (tests, tools-only boot) = nobody present. */
export function wirePresence(r: PresenceReader) {
  presenceReader = r
}

/** Live agents on a canvas — including one that has only called set_status
 *  once and so has no open task row to be read from. */
export function listAgentPresence(canvasId: string): AgentPresenceEntry[] {
  return presenceReader(canvasId)
}

type FocusReader = (canvasId: string) => CanvasFocus[]

let focusReader: FocusReader = () => []

/** Wired once from index.ts, like the presence reader — the map lives there. */
export function wireFocus(r: FocusReader) {
  focusReader = r
}

/** What every connected client on this canvas is looking at, newest first —
 *  the selection a human points an agent with. */
export function listCanvasFocus(canvasId: string): CanvasFocus[] {
  return [...focusReader(canvasId)].sort((a, b) => b.at - a.at)
}

/** The agent names an @mention on this canvas can address right now: the ones
 *  present (even with nothing claimed) plus the ones an open card belongs to.
 *  Matched against what is actually here, never against a name invented from
 *  the text — a typo must stay a note for the humans, not vanish into a
 *  delivery to nobody. */
function liveAgentNames(canvasId: string): string[] {
  const names = new Set(presenceReader(canvasId).map((p) => p.name))
  for (const t of taskLog.get(canvasId) ?? []) if (t.agentName) names.add(t.agentName)
  return [...names]
}

/** while parked in ask_human / wait_for_events the agent is alive but idle */
export function markAgentWaiting(canvasId: string, agentName: string, waiting: boolean): void {
  markWaiting(canvasId, agentName, waiting)
}

const activityLog = new Map<string, ActivityItem[]>() // canvasId -> items (newest first)

/** Fill the log maps from the database at boot. */
export function hydrateLogs(data: {
  tasks: Map<string, AgentTask[]>
  feedback: Map<string, TaskFeedback[]>
  comments: Map<string, ElementComment[]>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
  proposals: Map<string, MemoryProposal[]>
  /** canvasId -> agentName -> plan */
  plans?: Map<string, Map<string, AgentPlan>>
  /** canvasId -> journals, newest first — the resident's cross-run memory,
   *  which the next kickoff and revert_run read after a restart */
  journals?: Map<string, RunJournal[]>
}) {
  for (const [canvasId, list] of data.tasks) taskLog.set(canvasId, list)
  for (const [canvasId, list] of data.feedback) feedbackLog.set(canvasId, list)
  for (const [canvasId, list] of data.comments) commentLog.set(canvasId, list)
  for (const [canvasId, list] of data.activity) activityLog.set(canvasId, list)
  for (const [canvasId, list] of data.decisions) decisionLog.set(canvasId, list)
  for (const [canvasId, list] of data.proposals) proposalLog.set(canvasId, list)
  for (const [canvasId, byAgent] of data.plans ?? []) planLog.set(canvasId, byAgent)
  for (const [canvasId, list] of data.journals ?? []) journalLog.set(canvasId, list)
  /* A stop is per-canvas session state like the task log: a canvas whose logs
     were just re-read has no stop outstanding against it. */
  for (const canvasId of data.tasks.keys()) cancellations.delete(canvasId)
  interruptedStreams.clear()
  frameEditNotices.clear()
  failInterruptedWork()
}

/** Work that was mid-flight when the process last died (deploy, crash,
 *  dev restart): no agent will ever finish it, so at boot it becomes a
 *  visible, retryable failure instead of sitting "in progress" forever. */
function failInterruptedWork() {
  const reason = 'Interrupted by a server restart. Retry when you are ready.'
  const now = Date.now()
  for (const [canvasId, list] of taskLog) {
    for (const t of list) {
      /* a stopped card is a human's decision, not an interrupted run */
      if (t.endedAt || t.failedAt || t.cancelledAt || !t.agentName) continue
      if (t.queuedBy) {
        /* a claimed card whose run died — retryable */
        t.failedAt = now
        t.failureReason = reason
      } else {
        /* a live status row from the dead process — just close it out */
        t.endedAt = now
      }
      persist.saveTask(canvasId, t)
    }
  }
  for (const [, list] of feedbackLog) {
    for (const f of list) {
      if (f.deliveredAt && !f.completedAt && !f.failedAt) {
        f.failedAt = now
        f.failureReason = reason
        persist.saveFeedback(f)
      }
    }
  }
  for (const [, list] of commentLog) {
    for (const c of list) {
      if (c.claimedBy && !c.resolvedAt && !c.failedAt) {
        c.failedAt = now
        c.failureReason = reason
        persist.saveComment(c)
      }
    }
  }
}

export function getActivity(canvasId: string): ActivityItem[] {
  return activityLog.get(canvasId) ?? []
}

export function logActivity(canvasId: string, actor: Actor, message: string, frameId?: string) {
  const item: ActivityItem = {
    id: nanoid(8),
    actorName: actor.name,
    actorKind: actor.kind,
    actorColor: actor.color,
    message,
    frameId,
    at: Date.now(),
  }
  const list = activityLog.get(canvasId) ?? []
  list.unshift(item)
  if (list.length > 100) list.length = 100
  activityLog.set(canvasId, list)
  persist.saveActivity(canvasId, item)
  broadcast(canvasId, { type: 'activity', item })
}

/** Owner flips review mode: agent frame writes now land as proposals. The
 *  legacy all-or-nothing switch — written through the policy store so the
 *  boolean and the policy stay one fact: on is `all_writes` with no extra
 *  approved tools, off is `off`. */
export function setCanvasReviewMode(canvasId: string, on: boolean, actor: Actor) {
  store.setReviewPolicy(canvasId, on ? 'all_writes' : 'off')
  broadcast(canvasId, { type: 'canvas:reviewMode', reviewMode: on, actor })
  logActivity(canvasId, actor, on ? 'turned on review mode — agent changes need approval' : 'turned off review mode')
}

/** What a policy means, in the owner's own words for the activity feed. */
function reviewPolicyWords(policy: ReviewPolicy, approvalTools: string[]): string {
  if (policy === 'all_writes') return 'set review to all writes — every agent change needs approval'
  if (policy === 'destructive')
    return approvalTools.length
      ? `set review to destructive writes plus ${approvalTools.join(', ')} — those need approval`
      : 'set review to destructive writes — only destructive agent changes need approval'
  return 'turned review off — agent changes land directly'
}

/** Owner sets the scoped review policy: which agent writes need approval
 *  (`off` gates nothing, `destructive` gates destructive tools plus
 *  `approvalTools`, `all_writes` gates everything). The store mirrors the
 *  legacy reviewMode boolean, so the old toggle and the new policy agree. */
export function setCanvasReviewPolicy(
  canvasId: string,
  policy: ReviewPolicy,
  approvalTools: string[],
  actor: Actor,
): Canvas | undefined {
  const tools = [...new Set(approvalTools.map((t) => t.trim()).filter(Boolean))]
  const canvas = store.setReviewPolicy(canvasId, policy, tools)
  if (!canvas) return undefined
  broadcast(canvasId, { type: 'canvas:reviewPolicy', reviewPolicy: policy, approvalTools: tools, actor })
  logActivity(canvasId, actor, reviewPolicyWords(policy, tools))
  return canvas
}

export function resolveActor(
  raw: { name?: string; kind?: string; clientId?: string; owner?: string; ownerId?: string } | undefined,
): Actor {
  const kind = raw?.kind === 'agent' ? 'agent' : raw?.kind === 'user' ? 'user' : 'agent'
  const name = raw?.name?.trim() || (kind === 'agent' ? 'AI Agent' : 'Anonymous')
  return { name, kind, color: colorFor(name), clientId: raw?.clientId, owner: raw?.owner, ownerId: raw?.ownerId }
}

/* ------------------------------------------------------------------ */
/* Frame locks                                                         */
/*                                                                     */
/* A lock is only useful if everyone can see it. The room is told when a */
/* lock is taken, released, taken over or expires, so the human looking  */
/* at the frame sees "held by X" and can take it back — which is the     */
/* whole point of a cooperative lock.                                    */
/* ------------------------------------------------------------------ */

function broadcastLock(
  frameId: string,
  canvasId: string,
  holder: { name: string; color: string; kind: Actor['kind'] } | null,
) {
  broadcast(canvasId, { type: 'frame:lock', frameId, holder })
}

/** Take a frame's edit lock, telling the room. Returns the lock, or the
 *  current holder when someone else has it. */
export function acquireFrameLock(frameId: string, actor: Actor, ttlMs?: number): ReturnType<typeof frameLocks.acquire> {
  const frame = store.getFrame(frameId)
  const result = frameLocks.acquire(frameId, frame?.canvasId ?? '', actor.name, actor.owner, ttlMs)
  if (frame && !('heldBy' in result)) {
    broadcastLock(frameId, frame.canvasId, { name: actor.name, color: actor.color, kind: actor.kind })
  }
  return result
}

/** Release a frame's lock, telling the room. */
export function releaseFrameLock(frameId: string, actorName: string): boolean {
  const frame = store.getFrame(frameId)
  const released = frameLocks.release(frameId, actorName)
  if (frame && released) broadcastLock(frameId, frame.canvasId, null)
  return released
}

/** Release every lock on a frame, whoever holds it, telling the room. */
export function releaseAllFrameLocks(frameId: string): boolean {
  const frame = store.getFrame(frameId)
  const held = frameLocks.releaseAll(frameId)
  if (frame && held) broadcastLock(frameId, frame.canvasId, null)
  return !!held
}

/** Drop everything this agent holds on a canvas, telling the room about each
 *  frame it frees. Run teardown, stop, and an agent's own cleanup all land
 *  here, so no lock outlives the work that took it. */
export function releaseLocksForAgent(canvasId: string, agentName: string): string[] {
  const released = frameLocks.releaseAllFor(canvasId, agentName)
  for (const frameId of released) broadcastLock(frameId, canvasId, null)
  return released
}

/** Expired locks are gone from the map but still shown in the room until the
 *  room is told. Called on a timer by the server. */
export function sweepExpiredLocks(now = Date.now()): number {
  const expired = frameLocks.takeExpired(now)
  for (const lock of expired) broadcastLock(lock.frameId, lock.canvasId, null)
  return expired.length
}

/** Refuse a write to a frame another agent has locked. Shared by every
 *  mutation path so external agents and the resident team obey one rule. */
function assertUnlocked(frameId: string, actor: Actor) {
  const holder = frameLocks.heldBy(frameId, actor.name)
  if (holder) throw new frameLocks.FrameLockedError(holder)
}

export class ReviewModeError extends Error {
  readonly canvasId: string
  /** the tool the caller invoked, so an agent reading the refusal sees the
   *  exact action that needs a human, not a generic one */
  readonly toolName: string
  /** the policy that refused the write — `all_writes` also covers the legacy
   *  reviewMode boolean, which reads as that policy */
  readonly policy: ReviewPolicy

  constructor(canvasId: string, toolName: string, policy: ReviewPolicy) {
    super(
      `this canvas approves agent writes through review — ${toolName} needs a human. Deliver with propose_frame_html / propose_frame_create / propose_frame_delete instead; they land the moment a human accepts.`,
    )
    this.name = 'ReviewModeError'
    this.canvasId = canvasId
    this.toolName = toolName
    this.policy = policy
  }
}

/** The tool each action answers to, for the review gate: an approval list and
 *  the refusal message speak tool names, not action functions. Where one
 *  action backs several tools (update_frame serves set_frame_html,
 *  edit_frame_html and apply_ops), the action's own tool name stands for the
 *  write itself — the gate is about the write, not the alias it arrived on. */
const TOOL_NAME = {
  appendFrameHtml: 'append_frame_html',
  createFrame: 'create_frame',
  updateFrame: 'update_frame',
  deleteFrame: 'delete_frame',
  createPage: 'create_page',
  renamePage: 'rename_page',
  deletePage: 'delete_page',
  moveFrameToPage: 'move_frame',
  setTokens: 'set_tokens',
  setGuideline: 'set_guidelines',
  recordChatDecision: 'save_decision',
  createComponent: 'create_component',
  updateComponent: 'update_component',
  deleteComponent: 'delete_component',
  insertComponent: 'insert_component',
  detachComponent: 'detach_component',
} as const

/** What the canvas's policy says about one write. `all_writes` gates every
 *  write, `destructive` gates the tools that declare themselves destructive
 *  plus every tool the owner listed, `off` (or no policy at all) gates
 *  nothing. A canvas still carrying the legacy reviewMode boolean reads as
 *  `all_writes`, so nothing that was gated before is suddenly open. */
function policyRequiresApproval(canvas: Canvas | undefined, toolName: string, destructive: boolean): boolean {
  if (!canvas) return false
  const policy = canvas.reviewMode ? 'all_writes' : (canvas.reviewPolicy ?? 'off')
  if (policy === 'all_writes') return true
  if (policy === 'destructive') return destructive || (canvas.approvalTools?.includes(toolName) ?? false)
  return false
}

/** One gate for every agent write: a human is never gated, an agent writes
 *  only through whatever review policy the canvas's owner set. `destructive`
 *  is the caller's own annotation — delete_frame declares it, rename_page
 *  does not — and matters only under the `destructive` policy. */
function assertAgentWriteAllowed(
  canvasId: string,
  actor: Actor,
  toolName: string,
  opts: { destructive?: boolean } = {},
) {
  if (actor.kind !== 'agent') return
  const canvas = store.getCanvas(canvasId)
  if (!policyRequiresApproval(canvas, toolName, opts.destructive ?? false)) return
  throw new ReviewModeError(canvasId, toolName, canvas!.reviewMode ? 'all_writes' : (canvas!.reviewPolicy ?? 'off'))
}

function touch(canvasId: string, actor: Actor, frameId?: string | null) {
  if (actor.kind === 'agent') agentTouch(canvasId, actor.name, frameId, undefined, actor.owner, actor.ownerId)
}

/** Refresh an agent's presence without changing its frame or status. A model
 *  turn can stay silent longer than the presence TTL, and expiry fails the
 *  run's claimed cards as "disconnected" — resident runs beat this on a timer
 *  for as long as they are actually alive. */
export function heartbeatAgent(canvasId: string, actor: Actor) {
  touch(canvasId, actor)
}

/** Same agent identity = same name on the same account. A task with no recorded
 *  owner is legacy work, and matches on the name alone. */
function sameAgent(t: { agentName: string; ownerId?: string }, actor: Actor): boolean {
  if (t.agentName !== actor.name) return false
  if (t.ownerId === undefined) return true
  return t.ownerId === actor.ownerId
}

/* ------------------------------------------------------------------ */
/* Agent routing: a board card carries an ordered pipeline of roles and */
/* is only ever visible to the role at its current stage. Feedback and  */
/* element comments carry a target agent instead. Untargeted work stays */
/* open to anyone — that's what outside MCP agents pick up.             */
/* ------------------------------------------------------------------ */

/** The pipeline of a card, tolerating cards queued before pipelines existed. */
export function pipelineOf(task: AgentTask): string[] {
  return task.pipeline?.length ? task.pipeline : [DEFAULT_ROLE_ID]
}

/** The agent whose turn it is on this card. */
function stageAgent(task: AgentTask): string {
  const pipeline = pipelineOf(task)
  return roleName(pipeline[Math.min(task.stage ?? 0, pipeline.length - 1)])
}

/** Distinct resident agents with work waiting, in the order work arrived. */
export function pendingWorkAgents(canvasId: string): string[] {
  const names: string[] = []
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name)
  }
  /* priority first, then position, then arrival (queueOrder in card utils) */
  for (const card of queuedCards(canvasId).reverse()) {
    add(stageAgent(card))
  }
  for (const f of [...(feedbackLog.get(canvasId) ?? [])].reverse()) {
    if (!f.deliveredAt && !f.failedAt) add(f.targetAgent ?? roleName(DEFAULT_ROLE_ID))
  }
  for (const c of [...(commentLog.get(canvasId) ?? [])].reverse()) {
    if (c.forAgent && !c.claimedBy && !c.failedAt && !c.resolvedAt) add(c.targetAgent ?? roleName(DEFAULT_ROLE_ID))
  }
  return names
}

/**
 * Who pays for the next run: the account behind the OLDEST piece of work this
 * agent can claim. A run bills exactly one person, so the queue is worked one
 * requester at a time rather than sweeping several people's work into a single
 * model call on whichever account happened to be found first.
 *
 * Returns '' when the oldest item predates per-user attribution (the caller
 * falls back to the canvas owner), and undefined when nothing is claimable.
 * `skip` holds payers already found to have no usable model this sweep, so one
 * stalled requester never blocks everyone behind them.
 */
export function nextWorkPayer(canvasId: string, agentName: string, skip?: ReadonlySet<string>): string | undefined {
  let oldest: { at: number; payer: string } | undefined
  const consider = (at: number, userId: string | undefined) => {
    const payer = userId ?? ''
    if (skip?.has(payer)) return
    if (!oldest || at < oldest.at) oldest = { at, payer }
  }
  for (const card of taskLog.get(canvasId) ?? []) {
    if (
      card.queuedBy &&
      !card.agentName &&
      !card.failedAt &&
      !card.endedAt &&
      !card.cancelledAt &&
      stageAgent(card) === agentName
    ) {
      consider(card.startedAt, card.queuedByUserId)
    }
  }
  for (const c of commentLog.get(canvasId) ?? []) {
    if (
      c.forAgent &&
      !c.claimedBy &&
      !c.failedAt &&
      !c.resolvedAt &&
      (c.targetAgent ?? roleName(DEFAULT_ROLE_ID)) === agentName
    ) {
      consider(c.at, c.fromUserId)
    }
  }
  for (const f of feedbackLog.get(canvasId) ?? []) {
    if (!f.deliveredAt && !f.failedAt && (!f.targetAgent || f.targetAgent === agentName)) {
      consider(f.at, f.fromUserId)
    }
  }
  return oldest?.payer
}

/* ------------------------------------------------------------------ */
/* Agent tasks: every set_status becomes a task entry, so the client   */
/* can show a per-agent history of work (à la Cursor's agent panel),   */
/* not just the current status. A new status completes the previous.   */
/* ------------------------------------------------------------------ */

const taskLog = new Map<string, AgentTask[]>() // canvasId -> tasks (newest first)

/** canvasId -> agentName -> the plan that agent published for this canvas */
const planLog = new Map<string, Map<string, AgentPlan>>()

export function getTasks(canvasId: string): AgentTask[] {
  return taskLog.get(canvasId) ?? []
}

/** Which canvas a task lives on — routes that take a bare task id resolve it
 *  here so the canvas access check can run before mutating. */
export function taskCanvasId(taskId: string): string | undefined {
  for (const [canvasId, list] of taskLog) if (list.some((t) => t.id === taskId)) return canvasId
  return undefined
}

/** Agent announces what it is working on right now (empty string clears it). */
export function setAgentStatus(canvasId: string, actor: Actor, status: string) {
  const clean = status.trim()
  agentTouch(canvasId, actor.name, undefined, clean || null, actor.owner, actor.ownerId)

  const list = taskLog.get(canvasId) ?? []
  /* board cards stay open until explicitly completed — a status change
     narrates work ON a card, it doesn't end it */
  const open = list.find((t) => sameAgent(t, actor) && !t.endedAt && !t.queuedBy)
  if (open?.status === clean) return // same status re-posted: nothing new
  if (open) {
    open.endedAt = Date.now()
    persist.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
  if (clean) {
    const task: AgentTask = {
      id: nanoid(8),
      agentName: actor.name,
      owner: actor.owner,
      ownerId: actor.ownerId,
      color: actor.color,
      status: clean,
      startedAt: Date.now(),
    }
    list.unshift(task)
    if (list.length > 100) list.length = 100
    taskLog.set(canvasId, list)
    persist.saveTask(canvasId, task)
    broadcast(canvasId, { type: 'task', task })
    logActivity(canvasId, actor, `is working on: ${clean}`)
  }
}

/* ------------------------------------------------------------------ */
/* Task feedback: humans reply to a task in the UI; the text is        */
/* delivered to the agent inside its NEXT MCP tool result (MCP is      */
/* pull-based — the result-nudge layer is our channel into the agent). */
/* ------------------------------------------------------------------ */

const feedbackLog = new Map<string, TaskFeedback[]>() // canvasId -> entries (newest first)

export function getFeedback(canvasId: string): TaskFeedback[] {
  return feedbackLog.get(canvasId) ?? []
}

/** Look a feedback entry up by id (it carries its canvasId) for access checks. */
export function findFeedback(feedbackId: string): TaskFeedback | undefined {
  for (const list of feedbackLog.values()) {
    const fb = list.find((f) => f.id === feedbackId)
    if (fb) return fb
  }
  return undefined
}

export function addTaskFeedback(
  taskId: string,
  from: string,
  text: string,
  fromUserId?: string,
): TaskFeedback | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  for (const [canvasId, tasks] of taskLog) {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    /* a reply goes back to the agent whose work it is about — unless that was
       an outside agent, in which case it stays open to whoever shows up */
    const target = roleByAgentName(task.agentName)?.name
    const fb: TaskFeedback = {
      id: nanoid(8),
      taskId,
      canvasId,
      agentName: task.agentName,
      ...(target ? { targetAgent: target } : {}),
      from,
      ...(fromUserId ? { fromUserId } : {}),
      text: clean,
      at: Date.now(),
    }
    const list = feedbackLog.get(canvasId) ?? []
    list.unshift(fb)
    if (list.length > 100) list.length = 100
    feedbackLog.set(canvasId, list)
    persist.saveFeedback(fb)
    broadcast(canvasId, { type: 'feedback', feedback: fb })
    agentEvents.push(canvasId, { kind: 'feedback', targetAgent: fb.targetAgent, data: { text: clean, from, taskId } })
    /* resident Doop agent picks feedback up instantly (no-op without an API
       key). Dynamic import: resident depends on this module. */
    import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
    logActivity(
      canvasId,
      resolveActor({ name: from, kind: 'user' }),
      `left feedback on ${task.agentName}’s task: “${clean}”`,
    )
    return fb
  }
  return undefined
}

/** Open feedback this agent may take: everything addressed to it, plus
 *  untargeted feedback — that part stays a canvas-level queue where the first
 *  identified agent call wins. */
export function takeFeedbackFor(canvasId: string, agentName: string, payer?: string, ownerId?: string): TaskFeedback[] {
  const pending = (feedbackLog.get(canvasId) ?? []).filter(
    (f) =>
      !f.deliveredAt &&
      !f.failedAt &&
      (!f.targetAgent || f.targetAgent === agentName) &&
      (payer === undefined || (f.fromUserId ?? '') === payer) &&
      /* an undelivered item already claimed by another account's same-named
         agent is not ours to take */
      (f.claimedBy === undefined || f.claimedByOwner === undefined || f.claimedByOwner === ownerId),
  )
  for (const f of pending) {
    f.deliveredAt = Date.now()
    f.claimedBy = agentName
    f.claimedByOwner = ownerId
    persist.saveFeedback(f)
    broadcast(canvasId, { type: 'feedback', feedback: f }) // clients flip the entry to "picked up"
  }
  return pending
}

export function failTaskFeedback(feedbackId: string, reason: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    feedback.failedAt = Date.now()
    feedback.failureReason = reason
    persist.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    return feedback
  }
  return undefined
}

export function completeTaskFeedback(feedbackId: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    feedback.completedAt = Date.now()
    delete feedback.failedAt
    delete feedback.failureReason
    persist.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    /* addressed feedback is a settled design decision — capture it into Memory */
    captureDecision(canvasId, {
      text: feedback.text,
      source: 'feedback',
      from: feedback.from,
      agentName: feedback.claimedBy,
    })
    return feedback
  }
  return undefined
}

export function retryTaskFeedback(feedbackId: string, by: string): TaskFeedback | undefined {
  for (const [canvasId, list] of feedbackLog) {
    const feedback = list.find((f) => f.id === feedbackId)
    if (!feedback) continue
    if (!feedback.failedAt) return feedback
    delete feedback.deliveredAt
    delete feedback.claimedBy
    delete feedback.completedAt
    delete feedback.failedAt
    delete feedback.failureReason
    persist.saveFeedback(feedback)
    broadcast(canvasId, { type: 'feedback', feedback })
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), 'retried agent feedback')
    import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
    return feedback
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Agent questions (ask_human): a blocking ask that lands in the room,  */
/* plus the event-bus wake so a parked wait returns the answer.        */
/* ------------------------------------------------------------------ */

/** How long ask_human parks waiting for an answer before returning open.
 *  The record stays answerable after expiry — the agent can re-check. */
export const QUESTION_TTL_MS = 5 * 60 * 1000

const questionLog = new Map<string, AgentQuestion[]>() // canvasId -> questions (newest first)

export function getQuestions(canvasId: string, status?: AgentQuestion['status']): AgentQuestion[] {
  const list = questionLog.get(canvasId) ?? []
  return status ? list.filter((q) => q.status === status) : list
}

export function findQuestion(questionId: string): AgentQuestion | undefined {
  for (const list of questionLog.values()) {
    const q = list.find((x) => x.id === questionId)
    if (q) return q
  }
  return undefined
}

/** The choices a question may offer: at least two, at most six, each trimmed
 *  to the length the Review panel renders. Fewer than two is not a choice —
 *  the question stays the free-text ask it would have been anyway. */
function normalizeChoices(raw: string[] | undefined): string[] {
  const offered = (raw ?? [])
    .map((c) => c.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 6)
  return offered.length >= 2 ? offered : []
}

/** An agent asked a human a blocking question (ask_human). It surfaces live
 *  on the canvas and in the Review tab; the answer rides back through the
 *  event bus into the agent's parked wait. */
export function askQuestion(
  canvasId: string,
  input: {
    text: string
    frameId?: string
    selector?: string
    stableKey?: string
    waitSeconds?: number
    choices?: string[]
    multi?: boolean
    allowOther?: boolean
  },
  actor: Actor,
): AgentQuestion | undefined {
  const text = input.text.trim().slice(0, 2000)
  if (!text || !store.getCanvas(canvasId)) return undefined
  const choices = normalizeChoices(input.choices)
  const question: AgentQuestion = {
    id: nanoid(8),
    canvasId,
    agentName: actor.name,
    ...(actor.owner ? { owner: actor.owner } : {}),
    ...(actor.ownerId ? { ownerId: actor.ownerId } : {}),
    color: actor.color,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.stableKey ? { stableKey: input.stableKey } : {}),
    ...(choices.length ? { choices } : {}),
    ...(choices.length && input.multi ? { multi: true } : {}),
    ...(choices.length && input.allowOther ? { allowOther: true } : {}),
    text,
    at: Date.now(),
    status: 'open',
    expiresAt: Date.now() + Math.max(0, input.waitSeconds ?? 60) * 1000,
  }
  const list = questionLog.get(canvasId) ?? []
  list.unshift(question)
  if (list.length > 100) list.length = 100
  questionLog.set(canvasId, list)
  persist.saveQuestion(question)
  broadcast(canvasId, { type: 'question', question })
  /* announce the question itself (a card event): the question_answer event is
     reserved for the answer, or a parked ask_human would wake immediately */
  agentEvents.push(canvasId, { kind: 'card', targetAgent: actor.name, data: { questionId: question.id } })
  /* email the opted-in humans (fire-and-forget; mail off = silently skipped) */
  import('./notifications.ts')
    .then((n) => n.notifyAgentEvent(canvasId, 'question', `${actor.name} asks: ${text}`))
    .catch(() => {})
  return question
}

/** An answer that is not one of the choices the asker offered. Nothing is
 *  recorded: the question stays open, so the human can answer it properly. */
export class InvalidAnswerError extends Error {
  readonly choices: string[]
  constructor(choices: string[], multi: boolean) {
    super(
      `that answer is not one of this question's choices — answer with ${
        multi ? 'one or more of' : 'one of'
      }: ${choices.join(', ')}`,
    )
    this.name = 'InvalidAnswerError'
    this.choices = choices
  }
}

/** Whether an answer satisfies the choices an asker offered. A single-choice
 *  question takes exactly one offered value; a multi-choice one takes one or
 *  more, comma-separated — the shape the Review panel submits. */
export function matchesChoices(answer: string, choices: string[], multi: boolean): boolean {
  const given = multi
    ? answer
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [answer.trim()]
  return given.length > 0 && given.every((value) => choices.includes(value))
}

export function answerQuestion(
  canvasId: string,
  questionId: string,
  answer: string,
  actor: Actor,
): AgentQuestion | undefined {
  const question = (questionLog.get(canvasId) ?? []).find((q) => q.id === questionId)
  if (!question || question.status !== 'open') return question
  const clean = answer.trim().slice(0, 2000)
  if (!clean) return question
  if (question.choices?.length && !question.allowOther && !matchesChoices(clean, question.choices, !!question.multi))
    throw new InvalidAnswerError(question.choices, !!question.multi)
  question.status = 'answered'
  question.answer = clean
  question.answeredBy = actor.name
  question.answeredAt = Date.now()
  persist.saveQuestion(question)
  broadcast(canvasId, { type: 'question', question })
  agentEvents.push(canvasId, {
    kind: 'question_answer',
    targetAgent: question.agentName,
    data: { questionId: question.id, answer: clean },
  })
  logActivity(canvasId, actor, `answered ${question.agentName}’s question`)
  return question
}

/** Record a question the agent's own client answered out of band (MCP
 *  elicitation). The humans in the room never saw it asked, so it is stored
 *  already answered: the transcript gets the full exchange, get_answers shows
 *  it to later agents, and nobody is emailed about a question that is settled. */
export function recordElicitedAnswer(
  canvasId: string,
  input: {
    text: string
    answer: string
    frameId?: string
    selector?: string
    stableKey?: string
    choices?: string[]
    multi?: boolean
    allowOther?: boolean
  },
  agent: Actor,
  answeredBy: Actor,
): AgentQuestion | undefined {
  const text = input.text.trim().slice(0, 2000)
  const answer = input.answer.trim().slice(0, 2000)
  if (!text || !answer || !store.getCanvas(canvasId)) return undefined
  const choices = normalizeChoices(input.choices)
  const question: AgentQuestion = {
    id: nanoid(8),
    canvasId,
    agentName: agent.name,
    ...(agent.owner ? { owner: agent.owner } : {}),
    ...(agent.ownerId ? { ownerId: agent.ownerId } : {}),
    color: agent.color,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.stableKey ? { stableKey: input.stableKey } : {}),
    ...(choices.length ? { choices } : {}),
    ...(choices.length && input.multi ? { multi: true } : {}),
    ...(choices.length && input.allowOther ? { allowOther: true } : {}),
    text,
    at: Date.now(),
    status: 'answered',
    answer,
    answeredBy: answeredBy.name,
    answeredAt: Date.now(),
    /* asked and answered in the same breath: it never waits for anyone */
    expiresAt: Date.now(),
  }
  const list = questionLog.get(canvasId) ?? []
  list.unshift(question)
  if (list.length > 100) list.length = 100
  questionLog.set(canvasId, list)
  persist.saveQuestion(question)
  broadcast(canvasId, { type: 'question', question })
  return question
}

/** A question nobody answered before its wait expired — the agent moved on. */
export function expireQuestion(questionId: string): AgentQuestion | undefined {
  for (const [canvasId, list] of questionLog) {
    const q = list.find((x) => x.id === questionId)
    if (!q || q.status !== 'open') continue
    q.status = 'expired'
    persist.saveQuestion(q)
    broadcast(canvasId, { type: 'question', question: q })
    return q
  }
  return undefined
}

/* ------------------------------------------------------------------ */

/* Element comments: pinned to a specific element inside a frame.      */
/* Comments mentioning @Doop are routed to the resident agent; the     */
/* rest are notes for the humans in the room.                          */
/* ------------------------------------------------------------------ */

const commentLog = new Map<string, ElementComment[]>() // canvasId -> entries (newest first)

export function getComments(canvasId: string): ElementComment[] {
  return commentLog.get(canvasId) ?? []
}

/** Look a comment up by id (it carries its canvasId) for access checks. */
export function findComment(commentId: string): ElementComment | undefined {
  for (const list of commentLog.values()) {
    const c = list.find((x) => x.id === commentId)
    if (c) return c
  }
  return undefined
}

export function addElementComment(
  frameId: string,
  input: { selector: string; snippet: string; text: string; stableKey?: string },
  actor: Actor,
  fromUserId?: string,
): ElementComment | undefined {
  const frame = store.getFrame(frameId)
  if (!frame) return undefined
  return postComment(
    frame,
    {
      selector: String(input.selector ?? '').slice(0, 300),
      snippet: String(input.snippet ?? '').slice(0, 400),
      ...(input.stableKey ? { stableKey: String(input.stableKey).slice(0, 300) } : {}),
    },
    input.text,
    actor,
    fromUserId,
  )
}

/** Reply inside a thread: the reply inherits the root comment's element so an
 *  @mention in it gives the agent the same anchor the conversation is about. */
export function replyToComment(
  commentId: string,
  text: string,
  actor: Actor,
  fromUserId?: string,
): ElementComment | undefined {
  const open = openThread(commentId)
  if (!open) return undefined
  const { root, frame } = open
  return postComment(
    frame,
    {
      selector: root.selector,
      snippet: root.snippet,
      ...(root.stableKey ? { stableKey: root.stableKey } : {}),
      parentId: root.id,
    },
    text,
    actor,
    fromUserId,
  )
}

/** The root and frame a reply to this comment would land on, or undefined
 *  when the thread is resolved or its frame is gone — checked before any
 *  metering so a rejected reply never costs a resident task. */
export function openThread(commentId: string): { root: ElementComment; frame: Frame } | undefined {
  const parent = findComment(commentId)
  if (!parent) return undefined
  const root = parent.parentId ? findComment(parent.parentId) : parent
  if (!root || root.resolvedAt) return undefined
  const frame = store.getFrame(root.frameId)
  if (!frame) return undefined
  return { root, frame }
}

function postComment(
  frame: Frame,
  anchor: { selector: string; snippet: string; stableKey?: string; parentId?: string },
  text: string,
  actor: Actor,
  fromUserId?: string,
): ElementComment | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  /* @Doop, @brand, @a11y… — whichever resident agent is mentioned picks it up */
  const role = mentionedRole(clean)
  /* a role is not the only addressable agent: an outside agent connected over
     MCP has a name of its own, and @-mentioning it routes the comment to that
     agent. Only names that are actually here count, so a typo stays a note for
     the humans in the room instead of being delivered to nobody. */
  const target = role?.name ?? mentionedAgent(clean, liveAgentNames(frame.canvasId))
  const list = commentLog.get(frame.canvasId) ?? []
  /* strictly increasing per canvas: thread order is reconstructed from `at`
     after a restart, so two messages must never share a timestamp */
  const at = Math.max(Date.now(), (list[0]?.at ?? 0) + 1)
  const comment: ElementComment = {
    id: nanoid(8),
    canvasId: frame.canvasId,
    frameId: frame.id,
    selector: anchor.selector,
    ...(anchor.stableKey ? { stableKey: anchor.stableKey } : {}),
    snippet: anchor.snippet,
    from: actor.name,
    ...(fromUserId ? { fromUserId } : {}),
    text: clean,
    at,
    ...(target ? { forAgent: true, targetAgent: target } : {}),
    ...(anchor.parentId ? { parentId: anchor.parentId } : {}),
    ...(actor.kind === 'agent' ? { fromKind: 'agent' as const } : {}),
  }
  list.unshift(comment)
  if (list.length > 100) list.length = 100
  commentLog.set(frame.canvasId, list)
  persist.saveComment(comment)
  broadcast(frame.canvasId, { type: 'comment', comment })
  agentEvents.push(frame.canvasId, {
    kind: 'comment',
    targetAgent: comment.targetAgent,
    data: { commentId: comment.id, frameId: frame.id, text: clean, from: actor.name },
  })
  const excerpt = clean.length > 80 ? clean.slice(0, 77) + '…' : clean
  logActivity(
    frame.canvasId,
    resolveActor({ name: actor.name, kind: actor.kind }),
    anchor.parentId
      ? `replied to a comment in “${frame.name}”: “${excerpt}”`
      : `commented on an element in “${frame.name}”: “${excerpt}”`,
    frame.id,
  )
  if (comment.forAgent) {
    /* @Doop mention: the resident agent picks it up instantly (no-op without
       an API key). Dynamic import: resident depends on this module. */
    import('./resident.ts').then((r) => r.onFeedback(frame.canvasId)).catch(() => {})
  }
  return comment
}

/** The whole conversation a comment belongs to, oldest first. */
export function commentThread(comment: ElementComment): ElementComment[] {
  const rootId = comment.parentId ?? comment.id
  /* the log is newest-first; reverse before the (stable) sort so replies
     posted within the same millisecond keep their arrival order */
  return [...(commentLog.get(comment.canvasId) ?? [])]
    .reverse()
    .filter((c) => c.id === rootId || c.parentId === rootId)
    .sort((a, b) => a.at - b.at)
}

/** Open comments @mentioning this agent, claimed by it. */
export function takeAgentCommentsFor(
  canvasId: string,
  agentName: string,
  payer?: string,
  ownerId?: string,
): ElementComment[] {
  const pending = (commentLog.get(canvasId) ?? []).filter(
    (c) =>
      c.forAgent &&
      !c.claimedBy &&
      !c.failedAt &&
      !c.resolvedAt &&
      (c.targetAgent ?? roleName(DEFAULT_ROLE_ID)) === agentName &&
      (payer === undefined || (c.fromUserId ?? '') === payer),
  )
  for (const c of pending) {
    c.claimedBy = agentName
    c.claimedByOwner = ownerId
    c.claimedAt = Date.now()
    persist.saveComment(c)
    broadcast(canvasId, { type: 'comment', comment: c }) // pins flip to "Doop is on it"
  }
  return pending
}

export function failComment(commentId: string, reason: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const comment = list.find((c) => c.id === commentId)
    if (!comment || comment.resolvedAt) continue
    comment.failedAt = Date.now()
    comment.failureReason = reason
    persist.saveComment(comment)
    broadcast(canvasId, { type: 'comment', comment })
    return comment
  }
  return undefined
}

export function retryComment(commentId: string, by: string): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const comment = list.find((c) => c.id === commentId)
    if (!comment || comment.resolvedAt) continue
    if (!comment.failedAt) return comment
    delete comment.claimedBy
    delete comment.claimedAt
    delete comment.failedAt
    delete comment.failureReason
    persist.saveComment(comment)
    broadcast(canvasId, { type: 'comment', comment })
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), 'retried an element comment', comment.frameId)
    import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
    return comment
  }
  return undefined
}

export function resolveComment(commentId: string, actor: Actor): ElementComment | undefined {
  for (const [canvasId, list] of commentLog) {
    const c = list.find((x) => x.id === commentId)
    if (!c) continue
    if (c.resolvedAt) return c
    /* resolving the root closes its whole thread: an open reply under a
       resolved pin would be invisible yet still queued for an agent */
    const closing = c.parentId ? [c] : list.filter((x) => x.id === c.id || (x.parentId === c.id && !x.resolvedAt))
    for (const item of closing) {
      item.resolvedBy = actor.name
      item.resolvedAt = Date.now()
      persist.saveComment(item)
      broadcast(canvasId, { type: 'comment', comment: item })
      /* a resolved @agent comment was an instruction that got carried out —
         capture it as a decision (plain human-to-human notes are not) */
      if (item.forAgent) {
        captureDecision(canvasId, {
          text: item.text,
          source: 'comment',
          frameId: item.frameId,
          from: item.from,
          agentName: item.claimedBy ?? (actor.name !== item.from ? actor.name : undefined),
        })
      }
    }
    return c
  }
  return undefined
}

/** Surface an agent's closing summary in the activity feed. */
export function agentSummary(canvasId: string, actor: Actor, text: string) {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return
  logActivity(canvasId, actor, `finished: “${clean.length > 220 ? clean.slice(0, 217) + '…' : clean}”`)
}

/** True if the agent has an explicitly announced (non-auto) task open. */
export function hasAnnouncedTask(canvasId: string, actor: Actor): boolean {
  return (taskLog.get(canvasId) ?? []).some((t) => sameAgent(t, actor) && !t.endedAt && !t.auto)
}

/* Agents that never call set_status still get a task inferred from what
   they are visibly doing, so the Tasks panel is never silently empty. */
function autoTask(canvasId: string, actor: Actor, status: string) {
  const list = taskLog.get(canvasId) ?? []
  if (list.some((t) => sameAgent(t, actor) && !t.endedAt)) return // any open task wins
  const task: AgentTask = {
    id: nanoid(8),
    agentName: actor.name,
    owner: actor.owner,
    color: actor.color,
    status,
    startedAt: Date.now(),
    auto: true,
  }
  list.unshift(task)
  if (list.length > 100) list.length = 100
  taskLog.set(canvasId, list)
  persist.saveTask(canvasId, task)
  broadcast(canvasId, { type: 'task', task })
}

function endAutoTask(canvasId: string, actor: Actor) {
  const open = (taskLog.get(canvasId) ?? []).find((t) => sameAgent(t, actor) && !t.endedAt && t.auto)
  if (open) {
    open.endedAt = Date.now()
    persist.saveTask(canvasId, open)
    broadcast(canvasId, { type: 'task', task: open })
  }
}

/** Close an agent's open tasks, e.g. when its presence expires. */
export function endAgentTasks(canvasId: string, agentName: string, ownerId?: string) {
  releaseLocksForAgent(canvasId, agentName)
  /* a finished plan is history the panel does not need; the activity log keeps
     the record of what happened */
  if (planLog.get(canvasId)?.delete(agentName)) persist.deletePlan(canvasId, agentName)
  const now = Date.now()
  for (const t of taskLog.get(canvasId) ?? []) {
    if (t.agentName !== agentName || t.endedAt || t.cancelledAt) continue
    if (ownerId !== undefined && t.ownerId !== undefined && t.ownerId !== ownerId) continue
    if (t.queuedBy) {
      /* A card the run already failed keeps its failure: the crash is the
         actionable story, and overwriting it with "the agent went away" would
         hide why. Only a card still open when the agent vanished is stopped. */
      if (t.failedAt) continue
      t.cancelledAt = now
      delete t.failureReason
    } else {
      t.endedAt = now
    }
    persist.saveTask(canvasId, t)
    broadcast(canvasId, { type: 'task', task: t })
  }
}

/* ------------------------------------------------------------------ */
/* Board cards: humans queue work; agents claim it. Same AgentTask     */
/* object — queuedBy set, agentName empty until claimed.               */
/* ------------------------------------------------------------------ */

/* canvasId -> agent name -> the stop record. Kept so the MCP result-nudge
   layer can tell a stopped agent to stop, and so nothing re-claims the work
   before the run has actually unwound. The record carries the account the
   stop was aimed at; a stop recorded without one (the resident team) is read
   by any agent of that name, which is exactly the old behaviour. */
interface StopRecord {
  at: number
  ownerId?: string
}
const cancellations = new Map<string, Map<string, StopRecord>>()

/** How long a stop keeps being reported to the agent it was aimed at.
 *
 *  A resident run clears its own record as it unwinds. An external MCP agent
 *  has no run we control, so the record has to age out on its own — without
 *  this, one stop would mute that agent name on this canvas forever. */
const STOP_TTL_MS = 10 * 60_000

/** True while a stop request is outstanding for this agent on this canvas. */
export function wasStopped(canvasId: string, agentName: string, ownerId?: string): boolean {
  const record = cancellations.get(canvasId)?.get(agentName)
  if (!record) return false
  if (Date.now() - record.at > STOP_TTL_MS) {
    cancellations.get(canvasId)?.delete(agentName)
    return false
  }
  /* a stop with no account behind it (the resident team) reaches everyone
     running that name; an account-scoped stop reaches only its own agent */
  if (record.ownerId === undefined || ownerId === undefined) return true
  return record.ownerId === ownerId
}

/** True while a stop is outstanding for any agent on this canvas.
 *
 *  The sweep's teardown uses it to tell a stop from a pause: both abort the
 *  in-flight model call, but a stop must not be undone by the re-sweep it just
 *  queued, while a pause followed by a resume is exactly the re-sweep a human
 *  asked for. */
export function anyStopOutstanding(canvasId: string): boolean {
  const byName = cancellations.get(canvasId)
  if (!byName) return false
  for (const name of [...byName.keys()]) if (wasStopped(canvasId, name)) return true
  return false
}

/** Clear the record when a fresh run claims work, so a stop cannot leak into a
 *  later, unrelated session under the same agent name. Called by the resident
 *  runner right after it claims (server/resident.ts). */
export function clearStop(canvasId: string, agentName: string, ownerId?: string) {
  const byName = cancellations.get(canvasId)
  const record = byName?.get(agentName)
  if (!record) return
  /* the resident team clears unconditionally: it owns the bare name. An
     account-scoped agent only clears its own record. */
  if (ownerId !== undefined && record.ownerId !== undefined && record.ownerId !== ownerId) return
  byName!.delete(agentName)
}

/** Stop every run this agent has in flight on a canvas.
 *
 *  Open board cards go to a terminal cancelledAt (never failedAt): a human
 *  stopped this, so it needs an explicit Retry, not a failure. Open status
 *  tasks simply end. The model call is aborted if it is still streaming.
 *  Returns how many open tasks were stopped. */
export function cancelAgentWork(canvasId: string, agentName: string, by: string, ownerId?: string): number {
  const byName = cancellations.get(canvasId) ?? new Map<string, StopRecord>()
  cancellations.set(canvasId, byName)
  byName.set(agentName, { at: Date.now(), ownerId })
  const now = Date.now()
  let stopped = 0
  for (const t of taskLog.get(canvasId) ?? []) {
    if (t.agentName !== agentName || t.endedAt || t.cancelledAt) continue
    /* a stop aimed at one account's agent must not stop another's */
    if (t.ownerId !== undefined && t.ownerId !== ownerId) continue
    if (t.queuedBy) {
      /* a card the run already failed keeps its failure: that is the actionable
         story, and rewriting it as a stop would hide why it died */
      if (t.failedAt) continue
      t.cancelledAt = now
      t.cancelledBy = by
    } else {
      t.endedAt = now
    }
    persist.saveTask(canvasId, t)
    broadcast(canvasId, { type: 'task', task: t })
    agentEvents.push(canvasId, { kind: 'stop', targetAgent: agentName, data: { taskId: t.id, stoppedBy: by } })
    stopped++
  }
  /* no work was stopped — do not abort whatever run happens to be live */
  if (stopped > 0) {
    /* a stopped agent's stream ends here, and the frame says why rather than
       leaving a border that only times out */
    for (const [frameId, state] of streams) {
      if (state.actor.name === agentName && store.getFrame(frameId)?.canvasId === canvasId) state.endedBy = 'stopped'
    }
    /* a stopped run holds nothing: its frames are free for the human to edit */
    releaseLocksForAgent(canvasId, agentName)
    cancel(canvasId)
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `stopped ${agentName}`)
  }
  return stopped
}

/** Stop ONE board card, leaving the agent's other work alone. Unlike
 *  cancelAgentWork this records no agent-level stop, so the agent keeps its
 *  other cards and its next call is not refused. The card is cancelled, not
 *  failed: a human can retry it from the board. */
export function cancelCard(canvasId: string, cardId: string, by: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt || card.cancelledAt) return card
  card.cancelledAt = Date.now()
  card.cancelledBy = by
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  /* Only the agent holding the card is told: a stop event with no target
     wakes every parked agent on the canvas, and an unclaimed card has no one
     to tell — the board broadcast is the whole story there. */
  if (card.agentName)
    agentEvents.push(canvasId, {
      kind: 'stop',
      targetAgent: card.agentName,
      data: { taskId: card.id, stoppedBy: by },
    })
  logActivity(
    canvasId,
    resolveActor({ name: by, kind: 'user' }),
    `stopped a card${card.agentName ? ` for ${card.agentName}` : ''}`,
  )
  return card
}

/** Take a card off the board entirely — what the ✕ means. Distinct from
 *  completeCard ("this work is done") and from cancelAgentWork (stops a run but
 *  keeps the card for a retry). */
export function removeCard(canvasId: string, cardId: string, by: string): boolean {
  const list = taskLog.get(canvasId) ?? []
  const index = list.findIndex((t) => t.id === cardId && t.queuedBy)
  if (index < 0) return false
  const [card] = list.splice(index, 1)
  if (card?.agentName) cancelAgentWork(canvasId, card.agentName, by)
  persist.deleteTask(canvasId, cardId)
  broadcast(canvasId, { type: 'task:deleted', taskId: cardId })
  return true
}

/** A card's text is the whole prompt the agent gets — never shorten it for
 *  display here; the board clamps long headings visually. The cap only stops
 *  a pasted document from being stored, broadcast and prompted verbatim. */
export const MAX_CARD_CHARS = 4_000

export function addQueuedCard(
  canvasId: string,
  title: string,
  from: string,
  agents?: unknown,
  attachments?: unknown,
  fromUserId?: string,
  targetFrameIds?: unknown,
  targetSelector?: unknown,
  targetPageId?: unknown,
): AgentTask | undefined {
  const clean = title.trim().slice(0, MAX_CARD_CHARS)
  if (!clean || !store.getCanvas(canvasId)) return undefined
  const pipeline = normalizePipeline(agents)
  /* reference-image frame ids: only frames that actually live on this canvas */
  const refs = (Array.isArray(attachments) ? attachments : [])
    .filter((a): a is string => typeof a === 'string')
    .filter((id, i, arr) => arr.indexOf(id) === i && store.getFrame(id)?.canvasId === canvasId)
    .slice(0, 4)
  /* the frames the card is ABOUT (the human's selection when they queued it) —
     same liveness rule as the attachments, but the opposite instruction to the
     agent: edit these in place rather than delivering elsewhere */
  const targets = (Array.isArray(targetFrameIds) ? targetFrameIds : [])
    .filter((a): a is string => typeof a === 'string')
    .filter((id, i, arr) => arr.indexOf(id) === i && store.getFrame(id)?.canvasId === canvasId)
    .slice(0, 4)
  /* "fix THIS element": the selector only means something alongside a target
     frame, and the page is validated like every other id — a page id from
     another canvas would send the agent looking in the wrong place */
  const selector = targets.length > 0 && typeof targetSelector === 'string' ? targetSelector.trim().slice(0, 300) : ''
  const page =
    targets.length > 0 && typeof targetPageId === 'string' && store.getPage(targetPageId)?.canvas.id === canvasId
      ? targetPageId
      : ''
  const list = taskLog.get(canvasId) ?? []
  const duplicate = list.find(
    (t) =>
      t.queuedBy === from &&
      !t.endedAt &&
      t.status === clean &&
      pipelineOf(t).join(',') === pipeline.join(',') &&
      (t.attachments ?? []).join(',') === refs.join(',') &&
      (t.targetFrameIds ?? []).join(',') === targets.join(',') &&
      (t.targetSelector ?? '') === selector &&
      (t.targetPageId ?? '') === page,
  )
  if (duplicate) return duplicate
  const card: AgentTask = {
    id: nanoid(8),
    agentName: '',
    color: colorFor(from),
    status: clean,
    startedAt: Date.now(),
    queuedBy: from,
    ...(fromUserId ? { queuedByUserId: fromUserId } : {}),
    pipeline,
    stage: 0,
    ...(refs.length > 0 ? { attachments: refs } : {}),
    ...(targets.length > 0 ? { targetFrameIds: targets } : {}),
    ...(selector ? { targetSelector: selector } : {}),
    ...(page ? { targetPageId: page } : {}),
  }
  list.unshift(card)
  taskLog.set(canvasId, trimTaskLog(list))
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  /* a card that @mentions a connected agent is addressed to that agent: the
     event wakes it specifically instead of every parked agent on the canvas.
     Roles are left untargeted — the pipeline decides who picks the card up. */
  const outside = mentionedRole(clean) ? undefined : mentionedAgent(clean, liveAgentNames(canvasId))
  agentEvents.push(canvasId, {
    kind: 'card',
    ...(outside ? { targetAgent: outside } : {}),
    data: { cardId: card.id, text: clean, pipeline },
  })
  logActivity(
    canvasId,
    resolveActor({ name: from, kind: 'user' }),
    `queued a card for ${pipeline.map(roleName).join(' → ')}: “${clean}”`,
  )
  /* the resident agents pick queued cards up instantly (no-op without a key) */
  import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
  return card
}

const TASK_LOG_CAP = 100

/** Keep the task log at its cap without losing open work: the oldest FINISHED
 *  tasks go first, so a bulk import can never push a queued, claimed or
 *  failed card off the board. Open cards past the cap are kept as well. */
export function trimTaskLog(list: AgentTask[]): AgentTask[] {
  if (list.length <= TASK_LOG_CAP) return list
  const isOpen = (t: AgentTask) => !!t.queuedBy && !t.endedAt && !t.cancelledAt
  let room = TASK_LOG_CAP - list.filter(isOpen).length
  const kept: AgentTask[] = []
  for (const t of list) {
    if (isOpen(t)) kept.push(t)
    else if (room > 0) {
      kept.push(t)
      room--
    }
  }
  list.length = 0
  list.push(...kept)
  return list
}

/** One repo import as board cards: the design-system extraction first (it
 *  becomes the guide the sketches follow), then one sketch card per selected
 *  screen. Structured cards — the resident runner dispatches them straight to
 *  the GitHub sketch runner (server/githubRecon.ts) instead of the chat agent.
 *  A screen already queued or in flight from the same connection is not
 *  queued twice. Returns the cards, oldest first. */
export interface RepoImportInput {
  connectionId: string
  repo: string
  screens: RepoScreenRef[]
  designSystem: boolean
}

/** What an import would queue, after removing screens already waiting or in
 *  flight from the same connection. Pure — the route checks this BEFORE
 *  spending the requester's allowance, so a no-op re-import costs nothing. */
export function planRepoCards(
  canvasId: string,
  input: RepoImportInput,
): { kind: RepoCardKind; title: string; payload: RepoCardPayload }[] {
  if (!store.getCanvas(canvasId)) return []
  const list = taskLog.get(canvasId) ?? []
  const open = list.filter((t) => t.queuedBy && !t.endedAt && t.payload?.connectionId === input.connectionId)
  const importId = nanoid(8)
  const base = { connectionId: input.connectionId, repo: input.repo, importId }
  const wanted: { kind: RepoCardKind; title: string; payload: RepoCardPayload }[] = []
  if (input.designSystem && !open.some((t) => t.kind === 'design-system'))
    wanted.push({ kind: 'design-system', title: `Design system of ${input.repo}`, payload: base })
  for (const screen of input.screens) {
    const queued = open.some(
      (t) =>
        t.kind === 'sketch' &&
        t.payload?.screen?.sourcePath === screen.sourcePath &&
        t.payload.screen.kind === screen.kind,
    )
    if (!queued) wanted.push({ kind: 'sketch', title: screen.title, payload: { ...base, screen } })
  }
  return wanted
}

export function addRepoCards(canvasId: string, input: RepoImportInput, from: string, fromUserId: string): AgentTask[] {
  const wanted = planRepoCards(canvasId, input)
  if (!wanted.length) return []
  const list = taskLog.get(canvasId) ?? []
  const actor = resolveActor({ name: from, kind: 'user' })
  const cards: AgentTask[] = []
  /* startedAt orders the queue (oldest first); a shared timestamp would leave
     the order to Map iteration, so each card sits one tick after the last */
  const at = Date.now()
  wanted.forEach((w, i) => {
    const card: AgentTask = {
      id: nanoid(8),
      agentName: '',
      color: colorFor(from),
      status: w.title.slice(0, MAX_CARD_CHARS),
      startedAt: at + i,
      queuedBy: from,
      queuedByUserId: fromUserId,
      pipeline: [DEFAULT_ROLE_ID],
      stage: 0,
      kind: w.kind,
      payload: w.payload,
    }
    list.unshift(card)
    persist.saveTask(canvasId, card)
    broadcast(canvasId, { type: 'task', task: card })
    cards.push(card)
  })
  taskLog.set(canvasId, trimTaskLog(list))
  if (cards.length) {
    const sketches = cards.filter((c) => c.kind === 'sketch').length
    const what = [
      cards.some((c) => c.kind === 'design-system') ? 'the design system' : '',
      sketches ? `${sketches} ${sketches === 1 ? 'screen' : 'screens'}` : '',
    ]
      .filter(Boolean)
      .join(' and ')
    logActivity(canvasId, actor, `queued ${what} from ${input.repo} for ${roleName(DEFAULT_ROLE_ID)}`)
    import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
  }
  return cards
}

/** Cards waiting on THIS agent's stage, claimed by it. A card at another
 *  stage is invisible here — that is what keeps a pipeline in order. */
export function takeQueuedCardsFor(canvasId: string, agentName: string, payer?: string): AgentTask[] {
  /* same ordering the sweep sees: priority, then position, then arrival;
     paused cards are invisible until a human resumes them */
  const pending = queuedCards(canvasId).filter(
    (t) => stageAgent(t) === agentName && (payer === undefined || (t.queuedByUserId ?? '') === payer),
  )
  for (const c of pending) {
    c.agentName = agentName
    c.color = colorFor(agentName)
    c.claimedAt = Date.now()
    persist.saveTask(canvasId, c)
    broadcast(canvasId, { type: 'task', task: c })
  }
  return pending
}

/** Claim one open card by id for an outside agent (an MCP connection, which
 *  no pipeline stage names). The stage gate of takeQueuedCardsFor keeps the
 *  resident pipeline in order; an outside claim is a human-visible takeover of
 *  queued work — the board shows who holds the card, and Stop/Retry still work.
 *  Throws on the specific reason so the MCP layer can report it. */
export function claimCard(canvasId: string, cardId: string, agentName: string): AgentTask {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card) throw new Error(`no card with id ${cardId} on this canvas`)
  if (card.kind) throw new Error('this is a structured import card — the resident team dispatches on it')
  if (card.agentName) throw new Error(`card already claimed by ${card.agentName}`)
  if (card.endedAt || card.cancelledAt) throw new Error('card is no longer open — it was completed or stopped')
  if (card.failedAt) throw new Error('card failed and waits for a human retry')
  card.agentName = agentName
  card.color = colorFor(agentName)
  card.claimedAt = Date.now()
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  return card
}

/** An agent finished its stage: hand the card to the next agent in the
 *  pipeline, or complete it if that was the last one. The finishing agent's
 *  final message rides along as the next stage's handoff note. */
export function advanceCard(canvasId: string, cardId: string, by: Actor, stageSummary?: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt || card.cancelledAt) return card
  const pipeline = pipelineOf(card)
  const next = (card.stage ?? 0) + 1
  if (next >= pipeline.length) return completeCard(canvasId, cardId)

  if (stageSummary?.trim()) card.stageSummary = stageSummary.trim().slice(0, 1000)
  card.stage = next
  card.agentName = ''
  delete card.claimedAt
  delete card.failedAt
  delete card.failureReason
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, by, `handed “${card.status}” to ${roleName(pipeline[next])}`)
  import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
  return card
}

export function completeCard(canvasId: string, cardId: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt || card.cancelledAt) return card
  card.endedAt = Date.now()
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  import('./notifications.ts')
    .then((n) => n.notifyAgentEvent(canvasId, 'completed', `Card done: ${card.status}`))
    .catch(() => {})
  return card
}

/** An unsuccessful card stays failed until a human explicitly retries it. */
export function failCard(canvasId: string, cardId: string, reason: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt || card.cancelledAt) return card
  card.failedAt = Date.now()
  card.failureReason = reason
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  import('./notifications.ts')
    .then((n) => n.notifyAgentEvent(canvasId, 'failed', `Card failed: ${card.status}`))
    .catch(() => {})
  return card
}

export function retryCard(canvasId: string, cardId: string, by: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId && t.queuedBy)
  if (!card || card.endedAt) return card
  if (!card.failedAt && !card.cancelledAt) return card
  card.agentName = ''
  delete card.claimedAt
  delete card.failedAt
  delete card.failureReason
  /* a retry is the one thing that lifts a stop: the human has decided again */
  delete card.cancelledAt
  delete card.cancelledBy
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `retried a card: “${card.status}”`)
  import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
  return card
}

/* ------------------------------------------------------------------ */
/* Live rendering of agent writes.                                     */
/*                                                                     */
/* Streams (append_frame_html): every chunk broadcasts the moment it   */
/* arrives — viewers track the agent's real progress with no artificial*/
/* pacing. Stream state only carries the "designing…" badge, the       */
/* escape latch, and a timeout for agents that never send done=true.   */
/*                                                                     */
/* One-shot writes (set_frame_html, agent create_frame with html) play */
/* back as a short typewriter reveal so a paste reads as designing     */
/* rather than blinking in — drained against a fixed deadline so       */
/* playback time never grows with document size.                       */
/* ------------------------------------------------------------------ */

interface StreamState {
  actor: Actor
  /** the opening chunk was HTML-escaped: decode every chunk of this stream */
  escaped: boolean
  lastActivity: number
  /** set when something other than the agent ended the stream, so the end can
   *  say why (a human's edit, a takeover, a stop) */
  endedBy?: 'idle' | 'taken over' | 'stopped' | 'replaced'
}

const streams = new Map<string, StreamState>() // frameId -> state

/** A stream a human cut short by editing its frame. The agent that was
 *  streaming is told on its next tool call: its design's base moved under it,
 *  so appending the next chunk onto what is there now would corrupt the page. */
interface InterruptedStream {
  frameId: string
  frameName: string
  canvasId: string
  /** the human who took the frame over */
  by: string
  /** the agent whose stream was open */
  agentName: string
  ownerId?: string
  at: number
}

/** frameId -> the interruption, until the streaming agent is told. */
const interruptedStreams = new Map<string, InterruptedStream>()

/** How long an interruption keeps being reported. An agent that never comes
 *  back must not be told about an edit from an hour ago on its next session. */
const INTERRUPTED_TTL_MS = 15 * 60_000

/** The interruptions this agent has not been told about yet, cleared as they
 *  are read — the notice is about a state change, not a standing fact. */
export function takeInterruptedStreams(canvasId: string, agentName: string, ownerId?: string): InterruptedStream[] {
  const now = Date.now()
  const out: InterruptedStream[] = []
  for (const [frameId, record] of interruptedStreams) {
    if (now - record.at > INTERRUPTED_TTL_MS) {
      interruptedStreams.delete(frameId)
      continue
    }
    if (record.canvasId !== canvasId || record.agentName !== agentName) continue
    /* same account-scoping rule as a stop: an interruption recorded for an
       agent name without an account reaches any agent of that name */
    if (record.ownerId !== undefined && ownerId !== undefined && record.ownerId !== ownerId) continue
    interruptedStreams.delete(frameId)
    out.push(record)
  }
  return out
}

/** A human write to a frame an agent had just written. The agent is told on
 *  its next turn: it has been working from a base that no longer exists, so
 *  the write it is about to make would undo the human's edit. */
interface FrameEditNotice {
  frameId: string
  frameName: string
  canvasId: string
  /** the human who wrote */
  by: string
  /** the agent whose write the human landed on top of */
  agentName: string
  at: number
}

/** frameId -> the notice, until the agent that wrote the frame is told. */
const frameEditNotices = new Map<string, FrameEditNotice>()

/** Same lifetime rule as an interrupted stream: a notice is about a state
 *  change, not a standing fact, so an agent that never comes back must not be
 *  handed an edit from an hour ago on its next session. */
const FRAME_EDIT_TTL_MS = 15 * 60_000

/** How recently an agent must have written a frame for a human's write to
 *  count as landing on top of its work. Past this the human is simply working,
 *  and every agent that ever touched the frame would be nudged forever. */
const FRAME_EDIT_WINDOW_MS = 10 * 60_000

/** A human wrote a frame an agent holds or just wrote: wake that agent, and
 *  leave a notice for the ones a turn loop is driving (they are told between
 *  turns, not through the event bus). */
function noticeFrameEdited(
  frame: { id: string; name: string; canvasId: string },
  prev: { updatedBy: string; updatedAt: number },
  by: string,
): void {
  const holder = frameLocks.heldBy(frame.id, by)
  const recent = Date.now() - prev.updatedAt <= FRAME_EDIT_WINDOW_MS
  const agentName = holder?.agentName ?? (prev.updatedBy !== by && recent ? prev.updatedBy : undefined)
  if (!agentName) return
  frameEditNotices.set(frame.id, {
    frameId: frame.id,
    frameName: frame.name,
    canvasId: frame.canvasId,
    by,
    agentName,
    at: Date.now(),
  })
  agentEvents.push(frame.canvasId, {
    kind: 'frame_edited',
    targetAgent: agentName,
    data: { frameId: frame.id, name: frame.name },
  })
}

/** The human edits this agent has not been told about yet, cleared as they are
 *  read — one notice per frame, however many writes landed on it. */
export function takeFrameEditNotices(canvasId: string, agentName: string): FrameEditNotice[] {
  const now = Date.now()
  const out: FrameEditNotice[] = []
  for (const [frameId, record] of frameEditNotices) {
    if (now - record.at > FRAME_EDIT_TTL_MS) {
      frameEditNotices.delete(frameId)
      continue
    }
    if (record.canvasId !== canvasId || record.agentName !== agentName) continue
    frameEditNotices.delete(frameId)
    out.push(record)
  }
  return out
}

interface RevealState {
  actor: Actor
  /** how many chars of the frame's html are currently revealed to viewers */
  shown: number
  /** when the playback should have fully drained */
  deadline: number
}

const reveals = new Map<string, RevealState>() // frameId -> state

const TICK_MS = 80
const REVEAL_MIN_MS = 2500 // even a tiny one-shot plays for a beat
const REVEAL_MAX_MS = 5000 // even a huge one-shot lands within 5s
const REVEAL_CHARS_PER_MS = 8
const STREAM_IDLE_MS = 30_000

function revealDuration(chars: number): number {
  return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, chars / REVEAL_CHARS_PER_MS))
}

/** Make partially-revealed HTML paint sensibly. */
export function healPartialHtml(html: string): string {
  // drop a trailing half-written tag: "<div cla"
  const lastOpen = html.lastIndexOf('<')
  if (lastOpen > html.lastIndexOf('>')) html = html.slice(0, lastOpen)
  const lower = html.toLowerCase()
  // drop an unclosed <script> entirely — never run half-written JS
  const scriptAt = lower.lastIndexOf('<script')
  if (scriptAt !== -1 && lower.indexOf('</script', scriptAt) === -1) html = html.slice(0, scriptAt)
  // close an unclosed <style> so everything after it renders
  const styleAt = html.toLowerCase().lastIndexOf('<style')
  if (styleAt !== -1 && html.toLowerCase().indexOf('</style', styleAt) === -1) html += '</style>'
  return html
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

function startReveal(frame: Frame, actor: Actor, shown: number) {
  reveals.set(frame.id, { actor, shown, deadline: Date.now() + revealDuration(frame.html.length - shown) })
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId: frame.id, active: true, actor })
}

function finishReveal(frameId: string) {
  const r = reveals.get(frameId)
  if (!r) return
  reveals.delete(frameId)
  const frame = store.getFrame(frameId)
  if (!frame) return
  /* a reveal is a normal completion: saying nothing here would let the viewer
     read the end as an agent that went silent mid-stream */
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: r.actor, reason: 'done' })
  endAutoTask(frame.canvasId, r.actor)
}

function finishStream(frameId: string, logDone: boolean) {
  const s = streams.get(frameId)
  if (!s) return
  streams.delete(frameId)
  const frame = store.getFrame(frameId)
  if (!frame) return
  broadcast(frame.canvasId, {
    type: 'frame:streaming',
    frameId,
    active: false,
    actor: s.actor,
    /* why it ended: "done" is a delivery, "idle" is an agent that went
       silent mid-stream, "taken over" is a writer who moved in. The viewer
       is told which, instead of watching the border vanish unexplained. */
    reason: logDone ? 'done' : (s.endedBy ?? 'idle'),
  })
  if (logDone) logActivity(frame.canvasId, s.actor, `finished designing “${frame.name}”`, frameId)
  endAutoTask(frame.canvasId, s.actor)
}

setInterval(() => {
  const now = Date.now()
  for (const [frameId, r] of reveals) {
    const frame = store.getFrame(frameId)
    if (!frame) {
      reveals.delete(frameId)
      continue
    }

    const total = frame.html.length
    const remaining = total - r.shown

    if (remaining <= 0) {
      /* fully revealed: emit the exact html and close */
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor: r.actor })
      finishReveal(frameId)
      continue
    }

    /* drain the rest evenly so the playback lands exactly at the deadline */
    const ticksLeft = Math.max(1, Math.ceil((r.deadline - now) / TICK_MS))
    r.shown = Math.min(total, r.shown + Math.ceil(remaining / ticksLeft))
    const partial = r.shown >= total ? frame.html : healPartialHtml(frame.html.slice(0, r.shown))
    broadcast(frame.canvasId, { type: 'frame:updated', frame: { ...frame, html: partial }, actor: r.actor })
  }
  sweepIdleStreams(now)
}, TICK_MS)

/** Close streams whose agent stopped writing. An agent that dies mid-stream
 *  must not leave a frame marked "designing" forever; the end says it went
 *  silent rather than reporting a delivery. */
export function sweepIdleStreams(now = Date.now()): number {
  let closed = 0
  for (const [frameId, state] of streams) {
    if (now - state.lastActivity > STREAM_IDLE_MS) {
      finishStream(frameId, false)
      closed += 1
    }
  }
  return closed
}

export function appendFrameHtml(
  frameId: string,
  chunk: string,
  actor: Actor,
  opts: { start?: boolean; done?: boolean } = {},
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined
  assertAgentWriteAllowed(before.canvasId, actor, TOOL_NAME.appendFrameHtml)
  /* A streaming agent keeps its own lock alive chunk by chunk; a writer who
     holds no lock (the common case) is unaffected. */
  assertUnlocked(frameId, actor)
  frameLocks.refresh(frameId, actor.name)

  const starting = opts.start || !streams.has(frameId)
  /* an agent that escapes its opening chunk escapes the whole stream, so latch
     the verdict there: a chunk mid-design can hold a legitimate `&lt;` (a code
     sample) and must never be sniffed on its own */
  const escaped = starting ? looksEscapedHtml(chunk) : (streams.get(frameId)?.escaped ?? false)
  const piece = escaped ? decodeEscapedHtml(chunk) : chunk
  const html = stripTokenStyle(opts.start ? piece : before.html + piece)
  const frame = store.updateFrame(frameId, { html }, actor.name)!

  if (starting) {
    finishReveal(frameId) /* a live stream overrides any one-shot playback in flight */
    streams.set(frameId, { actor, escaped, lastActivity: Date.now() })
    broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: true, actor })
    logActivity(frame.canvasId, actor, `is designing “${frame.name}” live…`, frameId)
    autoTask(frame.canvasId, actor, `Designing “${frame.name}”`)
  }
  const s = streams.get(frameId)!
  s.lastActivity = Date.now()
  s.escaped = escaped

  /* the chunk renders the moment it arrives — viewers see the agent's real progress */
  broadcast(frame.canvasId, {
    type: 'frame:updated',
    frame: opts.done ? frame : { ...frame, html: healPartialHtml(frame.html) },
    actor,
  })
  if (opts.done) finishStream(frameId, true)

  touch(frame.canvasId, actor, frameId)
  return frame
}

/* ------------------------------------------------------------------ */

export function createFrame(
  canvasId: string,
  input: {
    name: string
    x?: number
    y?: number
    width?: number
    height?: number
    html?: string
    demo?: boolean
    pageId?: string
  },
  actor: Actor,
): Frame | undefined {
  assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.createFrame)
  /* The token block is bound at render time, never stored: a document that
     carries one (an export round-tripped back in, a client that serialized a
     rendered frame) is stripped on the way in. */
  if (input.html !== undefined) input = { ...input, html: stripTokenStyle(repairEscapedHtml(input.html)) }
  const frame = store.createFrame(canvasId, input, actor.name)
  if (!frame) return undefined
  if (actor.kind === 'agent' && frame.html.length > 0) {
    /* agent one-shot creation still plays back as a reveal */
    broadcast(canvasId, { type: 'frame:created', frame: { ...frame, html: '' }, actor })
    startReveal(frame, actor, 0)
    autoTask(canvasId, actor, `Designing “${frame.name}”`)
  } else {
    broadcast(canvasId, { type: 'frame:created', frame, actor })
  }
  logActivity(canvasId, actor, `created frame “${frame.name}”`, frame.id)
  touch(canvasId, actor, frame.id)
  return frame
}

export function updateFrame(
  frameId: string,
  patch: Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>>,
  actor: Actor,
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined
  assertAgentWriteAllowed(before.canvasId, actor, TOOL_NAME.updateFrame)
  assertUnlocked(frameId, actor)
  frameLocks.refresh(frameId, actor.name)
  if (patch.html !== undefined) patch = { ...patch, html: stripTokenStyle(repairEscapedHtml(patch.html)) }
  const prevName = before.name
  const prevHtml = before.html
  /* the store mutates the frame in place, so who last wrote it — the thing
     that decides whether a human's edit landed on an agent's work — has to be
     read before the write, not after */
  const prevWriter = before.updatedBy
  const prevUpdatedAt = before.updatedAt
  const frame = store.updateFrame(frameId, patch, actor.name)!

  const htmlChanged = patch.html !== undefined && patch.html !== prevHtml
  if (htmlChanged && actor.kind === 'agent') {
    /* another writer replacing the document takes the stream over; the same
       agent replacing its own is still working, and says so through presence */
    const replaced = streams.get(frameId)
    if (replaced && !replaced.endedBy) replaced.endedBy = replaced.actor.name === actor.name ? 'replaced' : 'taken over'
    finishStream(frameId, false) /* a full replace ends an open append stream */
    const prefix = commonPrefixLen(prevHtml, frame.html)
    /* mostly-unchanged replace (small tweak): broadcast at once — the client
       morphs the live DOM in place, so a reveal would only add churn */
    const smallTweak = prefix >= frame.html.length * 0.5 && prefix >= prevHtml.length * 0.5
    const openReveal = reveals.get(frameId)
    if (openReveal) {
      /* new content mid-playback: rewind to the divergence and re-arm the deadline */
      openReveal.actor = actor
      openReveal.shown = Math.min(openReveal.shown, prefix)
      openReveal.deadline = Date.now() + revealDuration(frame.html.length - openReveal.shown)
    } else if (smallTweak) {
      broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
      logActivity(frame.canvasId, actor, `tweaked the design of “${frame.name}”`, frame.id)
      autoTask(frame.canvasId, actor, `Tweaking “${frame.name}”`)
    } else {
      startReveal(frame, actor, prefix)
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
      autoTask(frame.canvasId, actor, `Redesigning “${frame.name}”`)
    }
  } else {
    if (htmlChanged) {
      /* a human takes over: cancel any live stream or playback, and tell the
         agent that was streaming — its next append would land on a base it
         never saw */
      const cut = streams.get(frameId)
      if (cut) {
        /* the first reason recorded wins: an agent that was stopped and then
           had its frame edited by a human ended because it was stopped */
        if (!cut.endedBy) cut.endedBy = 'taken over'
        interruptedStreams.set(frameId, {
          frameId,
          frameName: frame.name,
          canvasId: frame.canvasId,
          by: actor.name,
          agentName: cut.actor.name,
          ...(cut.actor.ownerId ? { ownerId: cut.actor.ownerId } : {}),
          at: Date.now(),
        })
      }
      finishStream(frameId, false)
      finishReveal(frameId)
    }
    broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
    if (htmlChanged) {
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
    } else if (patch.name !== undefined && patch.name !== prevName) {
      logActivity(frame.canvasId, actor, `renamed “${prevName}” to “${frame.name}”`, frame.id)
    }
    /* the human's write lands on an agent's work: that agent's next write would
       undo it unless it re-reads the frame first */
    if (actor.kind === 'user') {
      noticeFrameEdited(frame, { updatedBy: prevWriter, updatedAt: prevUpdatedAt }, actor.name)
    }
  }

  touch(frame.canvasId, actor, frame.id)
  return frame
}

export function deleteFrame(frameId: string, actor: Actor): Frame | undefined {
  const existing = store.getFrame(frameId)
  if (existing) {
    assertAgentWriteAllowed(existing.canvasId, actor, TOOL_NAME.deleteFrame, { destructive: true })
    assertUnlocked(frameId, actor)
  }
  /* close any live stream or playback while the frame still exists,
     so their auto “Designing…” tasks end with it */
  const dying = streams.get(frameId)
  if (dying && !dying.endedBy) dying.endedBy = 'taken over'
  finishStream(frameId, false)
  finishReveal(frameId)
  const frame = store.deleteFrame(frameId)
  if (!frame) return undefined
  thumbs.purge(frameId)
  broadcast(frame.canvasId, { type: 'frame:deleted', frameId, actor })
  logActivity(frame.canvasId, actor, `deleted frame “${frame.name}”`, frame.id)
  touch(frame.canvasId, actor, null)
  return frame
}

/** Remove a canvas with everything attached to it; viewers are told to leave. */
export function deleteCanvas(canvasId: string): boolean {
  const c = store.deleteCanvas(canvasId)
  if (!c) return false
  for (const f of c.frames) thumbs.purge(f.id)
  broadcast(canvasId, { type: 'canvas:deleted' })
  taskLog.delete(canvasId)
  feedbackLog.delete(canvasId)
  commentLog.delete(canvasId)
  activityLog.delete(canvasId)
  decisionLog.delete(canvasId)
  proposalLog.delete(canvasId)
  cancellations.delete(canvasId)
  for (const [frameId, record] of interruptedStreams) {
    if (record.canvasId === canvasId) interruptedStreams.delete(frameId)
  }
  for (const [frameId, record] of frameEditNotices) {
    if (record.canvasId === canvasId) frameEditNotices.delete(frameId)
  }
  return true
}

export function renameCanvas(canvasId: string, name: string, actor: Actor) {
  const canvas = store.renameCanvas(canvasId, name)
  if (!canvas) return undefined
  broadcast(canvasId, { type: 'canvas:renamed', name, actor })
  logActivity(canvasId, actor, `renamed the canvas to “${name}”`)
  return canvas
}

/* ------------------------------------------------------------------ */
/* Pages: ordered sub-canvases on a canvas. Any page mutation          */
/* broadcasts the full ordered list; frame moves ride frame:updated.   */
/* ------------------------------------------------------------------ */

export function createPage(canvasId: string, name: string, actor: Actor) {
  assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.createPage)
  const page = store.createPage(canvasId, name)
  if (!page) return undefined
  const canvas = store.getCanvas(canvasId)!
  broadcast(canvasId, { type: 'pages', pages: canvas.pages!, actor })
  logActivity(canvasId, actor, `created page “${page.name}”`)
  return page
}

export function renamePage(pageId: string, name: string, actor: Actor) {
  const canvasId = store.getPage(pageId)?.canvas.id
  if (canvasId) assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.renamePage)
  const page = store.renamePage(pageId, name)
  if (!page) return undefined
  const canvas = store.getCanvas(page.canvasId)!
  broadcast(page.canvasId, { type: 'pages', pages: canvas.pages!, actor })
  logActivity(page.canvasId, actor, `renamed a page to “${page.name}”`)
  return page
}

export function reorderPage(pageId: string, position: number, actor: Actor) {
  const pages = store.reorderPage(pageId, position)
  if (!pages) return undefined
  const canvasId = store.getPage(pageId)!.canvas.id
  broadcast(canvasId, { type: 'pages', pages, actor })
  logActivity(canvasId, actor, 'reordered pages')
  return pages
}

export function deletePage(pageId: string, actor: Actor) {
  const owner = store.getPage(pageId)?.canvas.id
  if (owner) assertAgentWriteAllowed(owner, actor, TOOL_NAME.deletePage, { destructive: true })
  const result = store.deletePage(pageId)
  if (!result) return undefined
  const { canvas, page, frames } = result
  for (const f of frames) {
    thumbs.purge(f.id)
    broadcast(canvas.id, { type: 'frame:deleted', frameId: f.id, actor })
  }
  broadcast(canvas.id, { type: 'pages', pages: canvas.pages!, actor })
  logActivity(canvas.id, actor, `deleted page “${page.name}” (${frames.length} frame${frames.length === 1 ? '' : 's'})`)
  return { page, deletedFrameIds: frames.map((f) => f.id) }
}

export function duplicatePage(pageId: string, actor: Actor) {
  const result = store.duplicatePage(pageId, nameForCopy(store.getPage(pageId)?.page.name ?? 'Page'))
  if (!result) return undefined
  const canvasId = result.page.canvasId
  broadcast(canvasId, { type: 'pages', pages: store.getCanvas(canvasId)!.pages!, actor })
  for (const f of result.frames) broadcast(canvasId, { type: 'frame:created', frame: f, actor })
  logActivity(canvasId, actor, `duplicated a page as “${result.page.name}”`)
  return result
}

export function moveFrameToPage(frameId: string, pageId: string, actor: Actor) {
  const moving = store.getFrame(frameId)
  if (moving) assertAgentWriteAllowed(moving.canvasId, actor, TOOL_NAME.moveFrameToPage)
  const frame = store.moveFrameToPage(frameId, pageId)
  if (!frame) return undefined
  const page = store.getPage(pageId)!.page
  broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
  logActivity(frame.canvasId, actor, `moved frame “${frame.name}” to page “${page.name}”`)
  return frame
}

export function duplicateFrame(
  frameId: string,
  overrides: { name?: string; x?: number; y?: number },
  actor: Actor,
): Frame | undefined {
  const source = store.getFrame(frameId)
  if (!source) return undefined
  const frame = createFrame(
    source.canvasId,
    {
      name: overrides.name ?? `${source.name} copy`,
      x: overrides.x ?? source.x + 40,
      y: overrides.y ?? source.y + 40,
      width: source.width,
      height: source.height,
      html: source.html,
      pageId: source.pageId,
    },
    actor,
  )
  if (frame) logActivity(source.canvasId, actor, `duplicated frame “${source.name}”`)
  return frame
}

function nameForCopy(name: string): string {
  return name.length <= 74 ? `${name} copy` : `${name.slice(0, 74)} copy`
}

/* ------------------------------------------------------------------ */
/* Design guidelines: named markdown docs on a canvas (brand rules,    */
/* style recipes). Written mostly for agents; humans read/edit them    */
/* in the Guidelines panel.                                            */
/* ------------------------------------------------------------------ */

export const MAX_GUIDELINE_CHARS = 24_000
export const MAX_GUIDELINE_DOCS = 20
export const GUIDELINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_GUIDELINE_TITLE_CHARS = 80

/** Display name of a design guide: the pretty title, else the prettified slug. */
export function guidelineTitle(doc: Pick<GuidelineDoc, 'name' | 'title'>): string {
  return doc.title ?? doc.name.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
}

/** First heading or non-empty line — the one-liner shown before an agent
 *  decides whether to fetch the full doc. */
export function guidelineSummary(doc: GuidelineDoc): string {
  for (const raw of doc.markdown.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 120 ? line.slice(0, 117) + '…' : line
  }
  return ''
}

/* ---- agent plans ---- */

const MAX_PLAN_STEPS = 20
const MAX_STEP_TEXT = 200
const MAX_STEP_NOTE = 500

export interface PlanStepInput {
  id: string
  text: string
}

/** Publish (or replace) an agent's plan for a canvas. Throws on invalid input
 *  with a message meant for the caller's error channel. */
export function setPlan(canvasId: string, agentName: string, steps: PlanStepInput[], actor: Actor): AgentPlan {
  if (steps.length === 0) throw new Error('a plan needs at least one step')
  if (steps.length > MAX_PLAN_STEPS) throw new Error(`${steps.length} steps — the limit is ${MAX_PLAN_STEPS}`)
  const ids = new Set<string>()
  const previous = planLog.get(canvasId)?.get(agentName)
  const now = Date.now()
  const clean = steps.map((step) => {
    const id = step.id.trim()
    if (!id) throw new Error('every step needs an id')
    if (ids.has(id)) throw new Error(`duplicate step id “${id}”`)
    ids.add(id)
    const text = step.text.trim()
    if (!text) throw new Error(`step “${id}” has no text`)
    if (text.length > MAX_STEP_TEXT) throw new Error(`step “${id}” is longer than ${MAX_STEP_TEXT} characters`)
    /* a re-published plan keeps each step's progress rather than resetting it */
    const prior = previous?.steps.find((s) => s.id === id)
    return prior && prior.text === text ? prior : { id, text, status: 'pending' as const, updatedAt: now }
  })
  const plan: AgentPlan = {
    canvasId,
    agentName,
    ...(actor.owner ? { owner: actor.owner } : {}),
    ...(actor.ownerId ? { ownerId: actor.ownerId } : {}),
    steps: clean,
    updatedAt: now,
  }
  const byAgent = planLog.get(canvasId) ?? new Map<string, AgentPlan>()
  byAgent.set(agentName, plan)
  planLog.set(canvasId, byAgent)
  persist.savePlan(plan)
  broadcast(canvasId, { type: 'plan', plan })
  touch(canvasId, actor)
  return plan
}

/** Move one step of a plan; the note is free text the agent leaves for itself. */
export function updatePlanStep(
  canvasId: string,
  agentName: string,
  stepId: string,
  status: PlanStep['status'],
  note: string | undefined,
  actor: Actor,
): AgentPlan | undefined {
  const plan = planLog.get(canvasId)?.get(agentName)
  if (!plan) return undefined
  const step = plan.steps.find((s) => s.id === stepId)
  if (!step) return undefined
  if (note !== undefined && note.length > MAX_STEP_NOTE)
    throw new Error(`note is longer than ${MAX_STEP_NOTE} characters`)
  step.status = status
  if (note !== undefined) step.note = note
  step.updatedAt = Date.now()
  plan.updatedAt = step.updatedAt
  persist.savePlan(plan)
  broadcast(canvasId, { type: 'plan', plan })
  touch(canvasId, actor)
  return plan
}

/** Every plan on the canvas, newest first. */
export function getPlans(canvasId: string): AgentPlan[] {
  return [...(planLog.get(canvasId)?.values() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getPlan(canvasId: string, agentName: string): AgentPlan | undefined {
  return planLog.get(canvasId)?.get(agentName)
}

/** Replace the canvas's design tokens (or clear them with undefined).
 *  Validates first, so an invalid token never reaches the store. */
export function setTokens(canvasId: string, tokens: DesignTokens | undefined, actor: Actor): Canvas | undefined {
  assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.setTokens)
  if (tokens) validateTokens(tokens)
  const canvas = store.setTokens(canvasId, tokens, actor.name)
  if (!canvas) return undefined
  broadcast(canvasId, { type: 'tokens', tokens: canvas.tokens ?? null, actor })
  logActivity(canvasId, actor, tokens ? 'updated the design tokens' : 'cleared the design tokens')
  touch(canvasId, actor)
  return canvas
}

/** Upsert (or, with empty markdown, delete) a design doc. Returns the doc,
 *  null for a deletion, undefined when the canvas is missing; throws on
 *  invalid input with a message meant for the caller's error channel. */
export function setGuideline(
  canvasId: string,
  name: string,
  markdown: string,
  actor: Actor,
  pos?: { x: number; y: number },
  title?: string,
): GuidelineDoc | null | undefined {
  assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.setGuideline)
  const slug = name.trim().toLowerCase()
  if (!GUIDELINE_NAME_RE.test(slug))
    throw new Error(`invalid doc name “${name}” — use a lowercase slug like "feature-image" (a-z, 0-9, hyphens)`)
  const clean = markdown.replace(/\r\n/g, '\n').trim()
  if (clean.length > MAX_GUIDELINE_CHARS)
    throw new Error(`doc is ${clean.length} chars — the limit is ${MAX_GUIDELINE_CHARS}`)
  const cleanTitle =
    title === undefined ? undefined : title.replace(/\s+/g, ' ').trim().slice(0, MAX_GUIDELINE_TITLE_CHARS)

  if (!clean) {
    const existing = store.getGuidelines(canvasId).find((d) => d.name === slug)
    if (!store.deleteGuideline(canvasId, slug)) return store.getCanvas(canvasId) ? null : undefined
    persist.saveGuidelineVersion(canvasId, slug, '', actor.name, Date.now())
    broadcast(canvasId, { type: 'guidelines', name: slug, doc: null, actor })
    logActivity(canvasId, actor, `deleted the design guide “${existing ? guidelineTitle(existing) : slug}”`)
    touch(canvasId, actor)
    return null
  }

  const existing = store.getGuidelines(canvasId)
  if (!existing.some((d) => d.name === slug) && existing.length >= MAX_GUIDELINE_DOCS)
    throw new Error(`this canvas already has ${MAX_GUIDELINE_DOCS} design guides — delete one first`)
  const doc = store.setGuideline(canvasId, slug, clean, actor.name, pos, cleanTitle)
  if (!doc) return undefined
  persist.saveGuidelineVersion(canvasId, slug, clean, actor.name, doc.updatedAt)
  broadcast(canvasId, { type: 'guidelines', name: slug, doc, actor })
  logActivity(canvasId, actor, `updated the design guide “${guidelineTitle(doc)}”`)
  touch(canvasId, actor)
  return doc
}

/** Patch design-guide metadata (card position, display title) without touching
 *  the content: no version snapshot, position changes make no activity noise. */
export function patchGuideline(
  canvasId: string,
  name: string,
  patch: { x?: number; y?: number; title?: string },
  actor: Actor,
): boolean {
  const clean: { x?: number; y?: number; title?: string } = {}
  if (patch.x !== undefined || patch.y !== undefined) {
    if (!Number.isFinite(patch.x) || !Number.isFinite(patch.y)) return false
    clean.x = patch.x
    clean.y = patch.y
  }
  if (patch.title !== undefined)
    clean.title = patch.title.replace(/\s+/g, ' ').trim().slice(0, MAX_GUIDELINE_TITLE_CHARS)
  if (Object.keys(clean).length === 0) return false
  const doc = store.patchGuideline(canvasId, name.trim().toLowerCase(), clean)
  if (!doc) return false
  broadcast(canvasId, { type: 'guidelines', name: doc.name, doc, actor })
  if (clean.title !== undefined) logActivity(canvasId, actor, `renamed a design guide to “${guidelineTitle(doc)}”`)
  return true
}

/* Per-process memory of which agents have read a canvas's design docs —
   worst case after a restart is one extra nudge, same trade-off as the
   task log's announce tracking. */
const guidelinesSeen = new Set<string>()

export function markGuidelinesSeen(canvasId: string, agentName: string) {
  guidelinesSeen.add(`${canvasId}:${agentName}`)
}

export function hasSeenGuidelines(canvasId: string, agentName: string): boolean {
  return guidelinesSeen.has(`${canvasId}:${agentName}`)
}

/* ------------------------------------------------------------------ */
/* Design memory: pinned reference frames (exemplars), captured        */
/* decisions (addressed feedback), and distiller proposals (rule edits */
/* a human accepts into a guide or dismisses). The guides above are    */
/* the distilled layer; this is everything upstream of them.           */
/* ------------------------------------------------------------------ */

export const MAX_REFERENCES = 12

const decisionLog = new Map<string, DesignDecision[]>() // canvasId -> newest first
const proposalLog = new Map<string, MemoryProposal[]>() // canvasId -> newest first

export function getDecisions(canvasId: string): DesignDecision[] {
  return decisionLog.get(canvasId) ?? []
}

export function getProposals(canvasId: string): MemoryProposal[] {
  return proposalLog.get(canvasId) ?? []
}

/** Record a settled design decision and poke the distiller. Deterministic and
 *  silent in the activity feed — the client toasts "Saved to Memory" instead. */
function captureDecision(
  canvasId: string,
  input: { text: string; source: DesignDecision['source']; frameId?: string; from: string; agentName?: string },
): DesignDecision {
  const decision: DesignDecision = {
    id: nanoid(8),
    text: input.text,
    source: input.source,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    from: input.from,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    at: Date.now(),
  }
  const list = decisionLog.get(canvasId) ?? []
  list.unshift(decision)
  if (list.length > 100) list.length = 100
  decisionLog.set(canvasId, list)
  persist.saveDecision(canvasId, decision)
  broadcast(canvasId, { type: 'decision', decision })
  /* generalize the raw words into a preference, then maybe propose a rule
     (both no-ops without an API key). Dynamic import: distill depends on
     this module. */
  import('./distill.ts').then((d) => d.onDecision(canvasId, decision.id)).catch(() => {})
  return decision
}

/** The summarizer generalized a decision — attach it and re-broadcast
 *  (clients upsert by id, so open panels and toasts update in place). */
export function setDecisionSummary(canvasId: string, id: string, summary: string) {
  const decision = getDecisions(canvasId).find((d) => d.id === id)
  if (!decision) return
  decision.summary = summary
  persist.saveDecision(canvasId, decision)
  broadcast(canvasId, { type: 'decision', decision })
}

export const MAX_DECISION_CHARS = 500

/** A connected agent reports a design decision its human made in conversation
 *  (the save_decision MCP tool) — the only party that hears that channel is
 *  the agent, so it is the reporter. Throws on bad input; returns undefined
 *  when the canvas is missing, null when it was a duplicate re-report. */
export function recordChatDecision(canvasId: string, text: string, actor: Actor): DesignDecision | null | undefined {
  if (!store.getCanvas(canvasId)) return undefined
  assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.recordChatDecision)
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('decision text is empty')
  if (clean.length > MAX_DECISION_CHARS)
    throw new Error(
      `decision is ${clean.length} chars — keep it under ${MAX_DECISION_CHARS} (the human's words, not an essay)`,
    )
  /* agents re-tell things; the same words land in Memory once */
  if (getDecisions(canvasId).some((d) => d.text === clean)) return null
  return captureDecision(canvasId, {
    text: clean,
    source: 'chat',
    from: actor.owner ?? actor.name,
    agentName: actor.name,
  })
}

/** Pin a frame to Memory as a style reference. Throws with a caller-facing
 *  message on limits; returns undefined when canvas/frame are missing. */
export function pinReference(canvasId: string, frameId: string, actor: Actor): MemoryReference | undefined {
  const frame = store.getFrame(frameId)
  if (!frame || frame.canvasId !== canvasId) return undefined
  const existing = store.getReferences(canvasId)
  if (existing.some((r) => r.frameId === frameId && r.html === frame.html)) {
    throw new Error('this frame is already pinned to Memory in its current state')
  }
  if (existing.length >= MAX_REFERENCES)
    throw new Error(`Memory already holds ${MAX_REFERENCES} references — unpin one first`)
  const ref = store.addReference(canvasId, frame, actor.name)
  if (!ref) return undefined
  broadcast(canvasId, { type: 'reference', id: ref.id, reference: ref, actor })
  logActivity(canvasId, actor, `pinned “${frame.name}” to Memory as a style reference`, frameId)
  return ref
}

export function unpinReference(canvasId: string, id: string, actor: Actor): boolean {
  const ref = store.deleteReference(canvasId, id)
  if (!ref) return false
  broadcast(canvasId, { type: 'reference', id, reference: null, actor })
  logActivity(canvasId, actor, `unpinned the reference “${ref.title}” from Memory`)
  return true
}

/** Decisions the distiller has not consumed yet. */
export function undistilledDecisions(canvasId: string): DesignDecision[] {
  return getDecisions(canvasId).filter((d) => !d.distilledAt)
}

/** Mark decisions consumed by a distiller run — even a run that produced no
 *  proposal, so the same set is never re-analyzed forever. */
export function markDecisionsDistilled(canvasId: string, ids: string[]) {
  const now = Date.now()
  for (const d of getDecisions(canvasId)) {
    if (ids.includes(d.id)) {
      d.distilledAt = now
      persist.saveDecision(canvasId, d)
    }
  }
}

/** The distiller proposed a rule: store it pending and show it to the room. */
export function addProposal(
  canvasId: string,
  input: { guideName: string; guideTitle?: string; rule: string; rationale: string; basedOn: string[] },
): MemoryProposal {
  const proposal: MemoryProposal = {
    id: nanoid(8),
    guideName: input.guideName,
    ...(input.guideTitle ? { guideTitle: input.guideTitle } : {}),
    rule: input.rule,
    rationale: input.rationale,
    basedOn: input.basedOn,
    at: Date.now(),
    status: 'pending',
  }
  const list = proposalLog.get(canvasId) ?? []
  list.unshift(proposal)
  if (list.length > 100) list.length = 100
  proposalLog.set(canvasId, list)
  persist.saveProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'proposal', proposal })
  return proposal
}

/** A human accepted (rule lands in the guide, versioned like any edit) or
 *  dismissed a proposal. */
export function resolveProposal(
  canvasId: string,
  proposalId: string,
  accept: boolean,
  actor: Actor,
): MemoryProposal | undefined {
  const proposal = getProposals(canvasId).find((p) => p.id === proposalId)
  if (!proposal || proposal.status !== 'pending') return proposal
  if (accept) {
    const guide = store.getGuidelines(canvasId).find((d) => d.name === proposal.guideName)
    const markdown = guide
      ? `${guide.markdown}\n\n${proposal.rule}`
      : `# ${proposal.guideTitle ?? guidelineTitle({ name: proposal.guideName })}\n\n${proposal.rule}`
    setGuideline(canvasId, proposal.guideName, markdown, actor, undefined, guide ? undefined : proposal.guideTitle)
  }
  proposal.status = accept ? 'accepted' : 'dismissed'
  proposal.resolvedBy = actor.name
  proposal.resolvedAt = Date.now()
  persist.saveProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'proposal', proposal })
  if (accept) logActivity(canvasId, actor, `accepted a Memory rule into “${proposal.guideName}”`)
  return proposal
}

/* ------------------------------------------------------------------ */
/* Frame proposals (review mode): an agent proposes; a human accepts.  */
/* The accept path writes through the ordinary actions so the change   */
/* versions, broadcasts and logs exactly like any human edit.          */
/* ------------------------------------------------------------------ */

const frameProposalLog = new Map<string, FrameProposal[]>() // canvasId -> newest first

export function getFrameProposals(canvasId: string, status?: FrameProposal['status']): FrameProposal[] {
  const list = frameProposalLog.get(canvasId) ?? []
  return status ? list.filter((p) => p.status === status) : list
}

export function findFrameProposal(proposalId: string): FrameProposal | undefined {
  for (const list of frameProposalLog.values()) {
    const p = list.find((x) => x.id === proposalId)
    if (p) return p
  }
  return undefined
}

export function addFrameProposal(
  canvasId: string,
  input: {
    kind: FrameProposal['kind']
    frameId?: string
    name?: string
    html?: string
    x?: number
    y?: number
    width?: number
    height?: number
    /** `patch` delivers `edits` against the frame's current document instead
     *  of a whole replacement document in `html` */
    mode?: FrameProposal['mode']
    edits?: FrameProposal['edits']
    baseHtml?: string
    diff?: FrameProposal['diff']
    summary: string
  },
  actor: Actor,
): FrameProposal | undefined {
  const target = input.frameId ? store.getFrame(input.frameId) : undefined
  if (input.frameId && !target) return undefined
  if ((input.kind === 'replace_html' || input.kind === 'delete_frame') && !target) return undefined
  /* a patch-mode replace carries `edits` rather than a whole `html`, so it
     is a valid replace without one */
  if (input.kind === 'replace_html' && !(input.mode === 'patch' && input.edits?.length) && input.html === undefined)
    return undefined
  if (input.kind === 'create_frame' && !store.getCanvas(canvasId)) return undefined
  const proposal: FrameProposal = {
    id: nanoid(8),
    kind: input.kind,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.html !== undefined ? { html: input.html } : {}),
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.mode === 'patch' && input.edits?.length ? { edits: input.edits } : {}),
    ...(input.baseHtml !== undefined ? { baseHtml: input.baseHtml } : {}),
    ...(input.diff ? { diff: input.diff } : {}),
    baseUpdatedAt: target?.updatedAt ?? Date.now(),
    summary: input.summary.trim().slice(0, 500) || input.kind.replace('_', ' '),
    agentName: actor.name,
    ...(actor.owner ? { owner: actor.owner } : {}),
    ...(actor.ownerId ? { ownerId: actor.ownerId } : {}),
    color: actor.color,
    at: Date.now(),
    status: 'pending',
  }
  const list = frameProposalLog.get(canvasId) ?? []
  list.unshift(proposal)
  if (list.length > 100) list.length = 100
  frameProposalLog.set(canvasId, list)
  persist.saveFrameProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'frameProposal', proposal })
  agentEvents.push(canvasId, {
    kind: 'frame_proposal',
    targetAgent: actor.name,
    data: { proposalId: proposal.id, kind: proposal.kind, frameId: proposal.frameId },
  })
  logActivity(canvasId, actor, `proposed a ${input.kind.replace('_', ' ')} — waiting for review`)
  return proposal
}

/** A human accepted or rejected a proposal. Accepting after the frame moved
 *  again marks it stale instead of overwriting the newer design — unless the
 *  reviewer passed `force`, which applies it anyway. A patch-mode proposal
 *  can be accepted hunk by hunk: each accepted edit is applied as an exact
 *  replacement against the frame's CURRENT html, and an edit that no longer
 *  fits (the text moved on) is skipped and reported, never forced. A reject
 *  may carry a note saying why, which the agent reads back through
 *  list_change_proposals. */
export function resolveFrameProposalDetailed(
  canvasId: string,
  proposalId: string,
  accept: boolean,
  actor: Actor,
  opts?: { note?: string; force?: boolean; hunks?: { index: number; accept: boolean }[] },
): { proposal: FrameProposal; applied: number[]; skipped: { index: number; reason: string }[] } | undefined {
  const proposal = (frameProposalLog.get(canvasId) ?? []).find((p) => p.id === proposalId)
  if (!proposal || proposal.status !== 'pending') return undefined
  const applied: number[] = []
  const skipped: { index: number; reason: string }[] = []
  if (accept) {
    const frame = proposal.frameId ? store.getFrame(proposal.frameId) : undefined
    /* the frame moved on since the agent read it: without an explicit
       "apply anyway" this is a stale decision, not an overwrite. A patch
       needs no such guard — its hunks are checked against the live document
       one by one, so it can never overwrite a design it did not read. */
    const stale = frame && frame.updatedAt !== proposal.baseUpdatedAt && !opts?.force && proposal.mode !== 'patch'
    if (stale) {
      proposal.status = 'stale'
    } else if (proposal.kind === 'replace_html' && proposal.mode === 'patch' && proposal.edits?.length && frame) {
      const wanted = opts?.hunks
      /* only the hunks the reviewer accepted, in proposal order; with no
         hunk list at all, every edit is the proposal */
      const order = wanted
        ? proposal.edits.map((_, i) => i).filter((i) => wanted.some((h) => h.index === i && h.accept))
        : proposal.edits.map((_, i) => i)
      let html = frame.html
      for (const index of order) {
        const edit = proposal.edits[index]!
        const at = html.indexOf(edit.old_str)
        if (at === -1) {
          skipped.push({ index, reason: 'the text it replaces is no longer in the frame' })
          continue
        }
        if (html.indexOf(edit.old_str, at + 1) !== -1) {
          skipped.push({ index, reason: 'the text it replaces occurs more than once — ambiguous' })
          continue
        }
        html = html.slice(0, at) + edit.new_str + html.slice(at + edit.old_str.length)
        applied.push(index)
      }
      if (applied.length) updateFrame(frame.id, { html }, actor)
      proposal.resolutionNote = `applied ${applied.length} of ${proposal.edits.length} hunks${
        skipped.length ? ` (${skipped.map((s) => `#${s.index}: ${s.reason}`).join('; ')})` : ''
      }`
      proposal.status = 'accepted'
    } else if (proposal.kind === 'replace_html' && frame) {
      updateFrame(frame.id, { html: proposal.html ?? frame.html }, actor)
      proposal.status = 'accepted'
    } else if (proposal.kind === 'delete_frame' && frame) {
      deleteFrame(frame.id, actor)
      proposal.status = 'accepted'
    } else if (proposal.kind === 'create_frame') {
      createFrame(
        canvasId,
        {
          name: proposal.name ?? 'Proposed frame',
          html: proposal.html,
          ...(proposal.x !== undefined ? { x: proposal.x } : {}),
          ...(proposal.y !== undefined ? { y: proposal.y } : {}),
          ...(proposal.width !== undefined ? { width: proposal.width } : {}),
          ...(proposal.height !== undefined ? { height: proposal.height } : {}),
        },
        actor,
      )
      proposal.status = 'accepted'
    }
  } else {
    proposal.status = 'rejected'
  }
  const note = opts?.note?.trim().slice(0, 1000)
  if (note) proposal.resolutionNote = note
  proposal.resolvedBy = actor.name
  proposal.resolvedAt = Date.now()
  persist.saveFrameProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'frameProposal', proposal })
  agentEvents.push(canvasId, {
    kind: 'frame_proposal',
    targetAgent: proposal.agentName,
    data: {
      proposalId: proposal.id,
      status: proposal.status,
      ...(proposal.resolutionNote ? { note: proposal.resolutionNote } : {}),
    },
  })
  logActivity(canvasId, actor, `${accept ? 'accepted' : 'rejected'} ${proposal.agentName}’s proposal`)
  return { proposal, applied, skipped }
}

/** The ordinary resolve — same code path, unchanged return for every
 *  existing caller. */
export function resolveFrameProposal(
  canvasId: string,
  proposalId: string,
  accept: boolean,
  actor: Actor,
  opts?: { note?: string; force?: boolean; hunks?: { index: number; accept: boolean }[] },
): FrameProposal | undefined {
  return resolveFrameProposalDetailed(canvasId, proposalId, accept, actor, opts)?.proposal
}

/** Re-base a stale patch proposal onto the frame's current html: each edit
 *  that still fits exactly once is kept, the rest are dropped and reported
 *  in the note. Only a patch can be rebased — a replace or a create carries
 *  a whole document, and re-basing it would be applying it. */
export function rebaseProposal(canvasId: string, proposalId: string, actor: Actor): FrameProposal | undefined {
  const proposal = (frameProposalLog.get(canvasId) ?? []).find((p) => p.id === proposalId)
  const frame = proposal?.frameId ? store.getFrame(proposal.frameId) : undefined
  if (!proposal || proposal.status !== 'stale' || proposal.mode !== 'patch' || !proposal.edits?.length || !frame)
    return undefined
  let html = frame.html
  const dropped: string[] = []
  const kept: number[] = []
  for (const [index, edit] of proposal.edits.entries()) {
    const at = html.indexOf(edit.old_str)
    if (at === -1 || html.indexOf(edit.old_str, at + 1) !== -1) {
      dropped.push(`#${index}`)
      continue
    }
    html = html.slice(0, at) + edit.new_str + html.slice(at + edit.old_str.length)
    kept.push(index)
  }
  if (kept.length) updateFrame(frame.id, { html }, actor)
  proposal.status = 'pending'
  proposal.baseHtml = frame.html
  proposal.baseUpdatedAt = frame.updatedAt
  proposal.resolutionNote = dropped.length
    ? `rebased onto the current frame — dropped hunk${dropped.length === 1 ? '' : 's'} ${dropped.join(', ')} (their text moved on)`
    : 'rebased onto the current frame — every hunk still applies'
  persist.saveFrameProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'frameProposal', proposal })
  logActivity(canvasId, actor, `rebased ${proposal.agentName}’s patch proposal onto the current frame`)
  return proposal
}

export function withdrawFrameProposal(canvasId: string, proposalId: string, actor: Actor): FrameProposal | undefined {
  const proposal = (frameProposalLog.get(canvasId) ?? []).find((p) => p.id === proposalId)
  if (!proposal || proposal.status !== 'pending') return proposal
  proposal.status = 'withdrawn'
  proposal.resolvedBy = actor.name
  proposal.resolvedAt = Date.now()
  persist.saveFrameProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'frameProposal', proposal })
  return proposal
}

/** Gate every agent frame write through review mode. Returns the proposal
 *  instead of writing when the canvas's review policy gates the write and
 *  the writer is an agent; otherwise returns undefined and the caller
 *  writes directly. */
export function proposeInsteadOfWrite(
  canvasId: string,
  op: {
    kind: FrameProposal['kind']
    frameId?: string
    name?: string
    html?: string
    x?: number
    y?: number
    width?: number
    height?: number
    mode?: FrameProposal['mode']
    edits?: FrameProposal['edits']
    baseHtml?: string
    diff?: FrameProposal['diff']
    summary: string
  },
  actor: Actor,
): FrameProposal | undefined {
  const canvas = store.getCanvas(canvasId)
  if (actor.kind !== 'agent' || !canvas?.reviewMode) return undefined
  return addFrameProposal(canvasId, op, actor)
}

/** Pause a live run: abort the model call like a stop, but keep the card
 *  open and paused instead of cancelling it. */
export function pauseAgentWork(canvasId: string, agentName: string, by: string): number {
  const now = Date.now()
  let paused = 0
  /* the card the journal names: the resume re-runs from a fresh kickoff, and
     the journal is the only thing that tells it why it stopped */
  let first: AgentTask | undefined
  for (const t of taskLog.get(canvasId) ?? []) {
    if (t.agentName !== agentName || !t.queuedBy) continue
    if (t.endedAt || t.cancelledAt || t.pausedAt || t.failedAt) continue
    first ??= t
    t.pausedAt = now
    t.pausedBy = by
    /* the card goes back into the queue (stage kept, claim dropped) so a
       resume is one click and the next sweep re-claims it */
    t.agentName = ''
    delete t.claimedAt
    persist.saveTask(canvasId, t)
    broadcast(canvasId, { type: 'task', task: t })
    paused++
  }
  if (paused > 0) {
    releaseLocksForAgent(canvasId, agentName)
    cancel(canvasId)
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `paused ${agentName}`)
    /* continuity for the resumed run: the message transcript is not
       checkpointed, so the journal plus the plan are what survive */
    recordRunJournal({
      canvasId,
      agentName,
      ...(first ? { cardId: first.id } : {}),
      summary: `paused by ${by}: ${first?.status ?? `${paused} open task(s) stopped`}`,
    })
  }
  return paused
}

/** Resume a paused card: clears the pause and re-fires the resident sweep. */
export function resumeCard(canvasId: string, cardId: string, by: string): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId)
  if (!card || !card.pausedAt) return card
  delete card.pausedAt
  delete card.pausedBy
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `resumed ${card.agentName || 'a paused card'}`)
  import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
  return card
}

/* ------------------------------------------------------------------ */
/* Queue ordering: higher priority first, then position, then arrival. */
/* ------------------------------------------------------------------ */

function queueOrder(a: AgentTask, b: AgentTask): number {
  const pa = a.priority ?? 0
  const pb = b.priority ?? 0
  if (pa !== pb) return pb - pa
  const sa = a.position ?? Number.MAX_SAFE_INTEGER
  const sb = b.position ?? Number.MAX_SAFE_INTEGER
  if (sa !== sb) return sa - sb
  return a.startedAt - b.startedAt
}

/** Queued cards in the order work should be taken. */
export function queuedCards(canvasId: string): AgentTask[] {
  return (taskLog.get(canvasId) ?? [])
    .filter((t) => t.queuedBy && !t.agentName && !t.failedAt && !t.endedAt && !t.cancelledAt && !t.pausedAt)
    .sort(queueOrder)
}

/** Rewrite the queue order: ids in array order get position 0..n. */
export function reorderCards(canvasId: string, ids: string[]): boolean {
  const list = taskLog.get(canvasId) ?? []
  const byId = new Map(list.map((t) => [t.id, t]))
  ids.forEach((id, index) => {
    const card = byId.get(id)
    if (!card) return
    card.position = index
    persist.saveTask(canvasId, card)
    broadcast(canvasId, { type: 'task', task: card })
  })
  return true
}

export function setCardPriority(canvasId: string, cardId: string, priority: number): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId)
  if (!card) return undefined
  card.priority = Math.max(0, Math.min(9, Math.round(priority)))
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  return card
}

/** A specialist handed the card back to an earlier pipeline stage. */
export function handBackCard(
  canvasId: string,
  cardId: string,
  toAgent: string,
  reason: string,
  actor: Actor,
): AgentTask | undefined {
  const card = (taskLog.get(canvasId) ?? []).find((t) => t.id === cardId)
  if (!card || !card.queuedBy) return card
  const pipeline = pipelineOf(card)
  const index = pipeline.findIndex((id) => roleName(id) === toAgent || id === toAgent)
  if (index < 0) return card
  card.stage = index
  card.agentName = ''
  card.handback = { fromAgent: actor.name, reason: reason.trim().slice(0, 500), at: Date.now() }
  delete card.claimedAt
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  logActivity(canvasId, actor, `handed the card back to ${toAgent}: ${card.handback.reason}`)
  agentEvents.push(canvasId, { kind: 'card', data: { cardId: card.id, handback: true, toAgent } })
  import('./resident.ts').then((r) => r.onFeedback(canvasId)).catch(() => {})
  return card
}

/** Record what a card's run cost, from the provider's own report. */
export function recordRunUsage(taskIds: string[], usage: TaskUsage): void {
  for (const [canvasId, list] of taskLog) {
    for (const t of list) {
      if (!taskIds.includes(t.id)) continue
      t.usage = usage
      persist.saveTask(canvasId, t)
      broadcast(canvasId, { type: 'task', task: t })
    }
  }
}

/** Restore a frame to a saved version. An ordinary edit: it versions, it
 *  broadcasts, and it lands live — a revert is never a dead end. Shared by
 *  the revert_frame MCP tool and the human History UI. */
export async function revertFrame(frameId: string, versionId: string, actor: Actor): Promise<Frame | undefined> {
  const version = await persist.getFrameVersion(versionId)
  if (!version || version.frameId !== frameId) return undefined
  /* through the wrapper, not frameLocks.release: the room has to be told the
     frame is free, or the "held by" chip sticks and the HTML editor stays
     disabled for everyone */
  releaseFrameLock(frameId, actor.name)
  return updateFrame(
    frameId,
    {
      html: version.html,
      name: version.name,
      x: version.x,
      y: version.y,
      width: version.width,
      height: version.height,
    },
    actor,
  )
}

/** Cross-run memory: what an agent did on its last runs of this canvas. */
const journalLog = new Map<string, RunJournal[]>() // canvasId -> newest first

/** How many frames of a run's change set a journal keeps. The journal is read
 *  by the next kickoff and by revert_run, not audited — the newest frames are
 *  the ones still worth reverting. */
const MAX_JOURNAL_FRAMES = 20

export function recordRunJournal(input: {
  canvasId: string
  agentName: string
  cardId?: string
  runId?: string
  summary: string
  decisions?: string
  frames?: RunJournal['frames']
  /** when the run's first turn started and when it stopped */
  startedAt?: number
  endedAt?: number
  /** model turns taken, tool calls made, tokens spent and what they cost */
  turns?: number
  toolCalls?: number
  tokens?: number
  costUsd?: number | null
}): RunJournal {
  /* newest first, one entry per frame: a run that wrote the same frame five
     times changed one frame, and the change set is what it touched */
  const frames = (input.frames ?? [])
    .filter((f, i, all) => all.findIndex((x) => x.frameId === f.frameId) === i)
    .slice(0, MAX_JOURNAL_FRAMES)
  const entry: RunJournal = {
    id: nanoid(8),
    canvasId: input.canvasId,
    agentName: input.agentName,
    ...(input.cardId ? { cardId: input.cardId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    summary: input.summary.slice(0, 800),
    ...(input.decisions ? { decisions: input.decisions } : {}),
    ...(frames.length ? { frames } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
    ...(input.turns !== undefined ? { turns: input.turns } : {}),
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    ...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
    ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    at: Date.now(),
  }

  const list = journalLog.get(input.canvasId) ?? []
  list.unshift(entry)
  if (list.length > 100) list.length = 100
  journalLog.set(input.canvasId, list)
  persist.saveJournal(entry)
  return entry
}

/** The canvas's last runs, newest first, whatever agent ran them — the Run
 *  tab's history view (getRunJournals is the per-agent kickoff read). */
export function listRunJournals(canvasId: string, limit = 20): RunJournal[] {
  return (journalLog.get(canvasId) ?? []).slice(0, limit)
}

/** How long after a run a frame may still be reverted — a write within this
 *  window of the journal is the run's own tail, not someone else's later
 *  work. The revert_run tool and the REST revert route both read it here. */
export const REVERT_RUN_GRACE_MS = 5_000

/** The role's last runs on this canvas, oldest first — kickoff context. */
export function getRunJournals(canvasId: string, agentName: string, limit = 3): RunJournal[] {
  return (journalLog.get(canvasId) ?? [])
    .filter((j) => j.agentName === agentName)
    .slice(0, limit)
    .reverse()
}

/** One journal, by the run it recorded or the card it worked — the read behind
 *  get_run_changes and revert_run. The log is newest first, so the most recent
 *  match wins. A journal written before the run id was stored on it carries
 *  only its own id, which is why a run id matches that too. */
export function getRunJournalBy(canvasId: string, query: { runId?: string; cardId?: string }): RunJournal | undefined {
  const list = journalLog.get(canvasId) ?? []
  if (query.runId) {
    const wanted = query.runId
    const byRun = list.find((j) => j.runId === wanted || j.id === wanted)
    if (byRun) return byRun
  }
  if (query.cardId) return list.find((j) => j.cardId === query.cardId)
  return undefined
}

/* ------------------------------------------------------------------ */
/* Component library: reusable markup a frame instantiates by carrying */
/* `data-doop-component` on one wrapper element. The frame HTML stays   */
/* the only document — an instance is an element, not a pointer into a  */
/* second store, so there is nothing to reconcile.                      */
/* ------------------------------------------------------------------ */

/** The attribute every instance wrapper carries, and the optional JSON
 *  attribute beside it holding the instance's prop values. */
const COMPONENT_ATTR = 'data-doop-component'
const COMPONENT_OVERRIDES_ATTR = 'data-doop-overrides'

/** The wrapper a component instance is inserted inside. Any element would
 *  do; a div is the neutral one that never carries behaviour of its own. */
function componentInstanceHtml(component: Component, overrides?: Record<string, string>): string {
  const overridesAttr =
    overrides && Object.keys(overrides).length > 0
      ? ` ${COMPONENT_OVERRIDES_ATTR}="${JSON.stringify(overrides).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
      : ''
  return `<div ${COMPONENT_ATTR}="${component.id}"${overridesAttr}>${component.html}</div>`
}

/** The offset just past `</${tag}>` starting at `at`, skipping over nested
 *  elements of the same name so a component containing its own kind of
 *  wrapper cannot end the scan early. */
function afterCloseTag(html: string, tag: string, at: number): number {
  const name = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`</?${name}(?=[\\s/>])`, 'gi')
  re.lastIndex = at
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0][1] === '/') {
      if (--depth === 0) return m.index + m[0].length + 1 // past the `>`
    } else if (html[m.index + m[0].length] !== '/') {
      depth++ // an open tag; `<tag/` is self-closing and stays shallow
    }
  }
  return -1
}

/** A component's size in the library panel until a real render says
 *  otherwise — the same defaults a new frame gets. */
const COMPONENT_DEFAULT_WIDTH = 640
const COMPONENT_DEFAULT_HEIGHT = 480

/** Replace the inner markup of every instance of `componentId` in a frame's
 *  HTML, leaving each wrapper element — and so its data-doop-overrides —
 *  exactly as the frame has it. Pure string work on purpose: propagation
 *  runs across every frame of a canvas, and a render per frame would spend
 *  the whole render budget restating markup nobody changed. */
export function replaceComponentInstances(
  html: string,
  componentId: string,
  inner: string,
): { html: string; replaced: number } {
  const marker = `${COMPONENT_ATTR}="${componentId}"`
  let out = ''
  let cursor = 0
  let replaced = 0
  for (;;) {
    const at = html.indexOf(marker, cursor)
    if (at === -1) break
    /* the wrapper's open tag: from the marker back to its `<`, and forward
       to the `>` that closes the tag */
    const open = html.lastIndexOf('<', at)
    const openEnd = html.indexOf('>', at)
    const name = open >= 0 && openEnd > at ? /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(open))?.[1] : undefined
    /* a marker that is not on a real open element (an attribute value, a
       truncated document) is left where it is — it is not an instance */
    if (!name || name === 'html' || name === 'body') {
      cursor = at + marker.length
      continue
    }
    const end = afterCloseTag(html, name, openEnd + 1)
    if (end === -1) {
      cursor = at + marker.length
      continue
    }
    out += html.slice(cursor, openEnd + 1) + inner
    cursor = end
    replaced++
  }
  if (replaced === 0) return { html, replaced: 0 }
  return { html: out + html.slice(cursor), replaced }
}

/** Every frame carrying at least one instance of this component, across
 *  canvases. A projection over frame HTML, not a counter: the markup is the
 *  only place an instance exists, so a stored count could only drift. */
export function componentsUsing(componentId: string): { frameId: string; canvasId: string; name: string }[] {
  const marker = `${COMPONENT_ATTR}="${componentId}"`
  const used: { frameId: string; canvasId: string; name: string }[] = []
  for (const canvas of store.canvases.values()) {
    for (const frame of canvas.frames) {
      if (frame.html.includes(marker)) used.push({ frameId: frame.id, canvasId: canvas.id, name: frame.name })
    }
  }
  return used
}

/** The component library as the components panel lists it: metadata and how
 *  widely each component is used, never the HTML (the panel previews render
 *  it from get_component). */
export function listComponentSummaries(canvasId: string): ComponentSummary[] {
  const instances = new Map<string, number>()
  for (const frame of store.getCanvas(canvasId)?.frames ?? []) {
    for (const component of store.listComponents(canvasId)) {
      if (frame.html.includes(`${COMPONENT_ATTR}="${component.id}"`))
        instances.set(component.id, (instances.get(component.id) ?? 0) + 1)
    }
  }
  return store.listComponents(canvasId).map((c) => ({
    id: c.id,
    name: c.name,
    ...(c.description ? { description: c.description } : {}),
    width: c.width,
    height: c.height,
    ...(c.variantOf ? { variantOf: c.variantOf } : {}),
    instanceCount: instances.get(c.id) ?? 0,
    updatedAt: new Date(c.updatedAt).toISOString(),
    updatedBy: c.updatedBy,
    htmlBytes: c.html.length,
  }))
}

/** Mint a library component. The html is the component's whole design — what
 *  insert_component stamps into frames — so it is bounded like a frame. */
export function createComponent(
  canvasId: string,
  input: {
    name: string
    html: string
    description?: string
    props?: unknown
    variantOf?: string
    width?: number
    height?: number
  },
  actor: Actor,
): Component | undefined {
  assertAgentWriteAllowed(canvasId, actor, TOOL_NAME.createComponent)
  const name = input.name.trim()
  if (!name) throw new Error('a component needs a name')
  const bytes = Buffer.byteLength(input.html)
  if (bytes > MAX_FRAME_HTML_BYTES)
    throw new Error(`component html is ${bytes} bytes — the limit is ${MAX_FRAME_HTML_BYTES}`)
  const component = store.createComponent(
    canvasId,
    {
      name,
      html: input.html,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      /* a component's natural size is a rendered question; the library needs
         a number for the panel's preview, and it gets the frame default
         unless the caller declared the real size */
      width: input.width ?? COMPONENT_DEFAULT_WIDTH,
      height: input.height ?? COMPONENT_DEFAULT_HEIGHT,
      props: input.props,
      ...(input.variantOf ? { variantOf: input.variantOf } : {}),
    },
    actor.name,
  )
  if (!component) return undefined
  broadcast(canvasId, { type: 'component', componentId: component.id, component, actor })
  logActivity(canvasId, actor, `created the component “${component.name}”`)
  touch(canvasId, actor)
  return component
}

/** Edit a library component. When the html changed, every frame carrying an
 *  instance is rewritten with it unless the caller passed
 *  `propagate: false` — a locked frame or a frame whose instance markup has
 *  gone missing is skipped with a reason, never force-overwritten. */
export function updateComponent(
  componentId: string,
  patch: { name?: string; description?: string; html?: string; props?: unknown },
  actor: Actor,
  opts: { propagate?: boolean } = {},
):
  | {
      component: Component
      updated: { frameId: string; name: string }[]
      skipped: { frameId: string; name: string; reason: string }[]
    }
  | undefined {
  const before = store.getComponent(componentId)
  if (!before) return undefined
  assertAgentWriteAllowed(before.canvasId, actor, TOOL_NAME.updateComponent)
  if (patch.html !== undefined) {
    const bytes = Buffer.byteLength(patch.html)
    if (bytes > MAX_FRAME_HTML_BYTES)
      throw new Error(`component html is ${bytes} bytes — the limit is ${MAX_FRAME_HTML_BYTES}`)
  }
  const component = store.updateComponent(
    componentId,
    {
      ...(patch.name !== undefined ? { name: patch.name.trim() || before.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() || undefined } : {}),
      ...(patch.html !== undefined ? { html: patch.html } : {}),
      ...(patch.props !== undefined ? { props: patch.props } : {}),
    },
    actor.name,
  )!
  broadcast(before.canvasId, { type: 'component', componentId, component, actor })

  let updated: { frameId: string; name: string }[] = []
  let skipped: { frameId: string; name: string; reason: string }[] = []
  if (patch.html !== undefined && opts.propagate !== false) {
    ;({ updated, skipped } = propagateComponent(component, actor))
  }
  logActivity(
    before.canvasId,
    actor,
    `updated the component “${component.name}”${
      updated.length ? ` — ${updated.length} instance${updated.length === 1 ? '' : 's'} refreshed` : ''
    }`,
  )
  touch(before.canvasId, actor)
  return { component, updated, skipped }
}

/** Rewrite every frame that carries an instance of the component with the
 *  component's current html. Runs through updateFrame, so each rewrite
 *  versions, broadcasts, lock-checks and review-gates like any other write. */
function propagateComponent(
  component: Component,
  actor: Actor,
): { updated: { frameId: string; name: string }[]; skipped: { frameId: string; name: string; reason: string }[] } {
  const updated: { frameId: string; name: string }[] = []
  const skipped: { frameId: string; name: string; reason: string }[] = []
  for (const use of componentsUsing(component.id)) {
    const frame = store.getFrame(use.frameId)
    if (!frame) continue
    const next = replaceComponentInstances(frame.html, component.id, component.html)
    if (next.replaced === 0) {
      skipped.push({
        frameId: frame.id,
        name: frame.name,
        reason: `no “${COMPONENT_ATTR}="${component.id}"” instance in this frame's markup to refresh`,
      })
      continue
    }
    try {
      updateFrame(frame.id, { html: next.html }, actor)
      updated.push({ frameId: frame.id, name: frame.name })
    } catch (e) {
      /* a locked frame or a review-gated one keeps its current markup and
         says why — a propagation is best effort per frame, never a force */
      skipped.push({
        frameId: frame.id,
        name: frame.name,
        reason:
          e instanceof frameLocks.FrameLockedError || e instanceof ReviewModeError ? e.message : 'could not update',
      })
    }
  }
  return { updated, skipped }
}

/** Delete a library component. Without `force`, a component still used by
 *  frames is refused with the list — deleting it out from under instances
 *  would leave markup nobody can trace. With `force`, the library row goes
 *  and the instance markup stays exactly where it is: an instance is an
 *  element in a frame, so it survives as ordinary markup. */
export function deleteComponent(
  componentId: string,
  actor: Actor,
  opts: { force?: boolean } = {},
): { deleted: boolean; reason?: string } | undefined {
  const component = store.getComponent(componentId)
  if (!component) return undefined
  assertAgentWriteAllowed(component.canvasId, actor, TOOL_NAME.deleteComponent, { destructive: true })
  if (!opts.force) {
    const uses = componentsUsing(componentId)
    if (uses.length)
      return {
        deleted: false,
        reason: `still used by ${uses.length} frame${uses.length === 1 ? '' : 's'} (${uses
          .slice(0, 5)
          .map((u) => `“${u.name}”`)
          .join(', ')}${uses.length > 5 ? ', …' : ''}) — detach the instances or pass force to delete anyway`,
      }
  }
  store.deleteComponent(componentId)
  broadcast(component.canvasId, { type: 'component', componentId, component: null, actor })
  logActivity(component.canvasId, actor, `deleted the component “${component.name}”`)
  touch(component.canvasId, actor)
  return { deleted: true }
}

/** Stamp an instance of a component into a frame: the component's html in one
 *  wrapper element, inserted through the element-editing layer (one render)
 *  and landed through updateFrame like any other write. `undefined` when the
 *  component belongs to another canvas — the MCP surface reports that as
 *  forbidden rather than letting one canvas's library leak into another. */
export async function insertComponent(
  frameId: string,
  componentId: string,
  input: { parent_selector: string; position: 'append' | 'prepend' | number; overrides?: Record<string, string> },
  actor: Actor,
): Promise<{ frame: Frame; selector: string } | undefined> {
  const frame = store.getFrame(frameId)
  if (!frame) return undefined
  const component = store.getComponent(componentId)
  if (!component || component.canvasId !== frame.canvasId) return undefined
  assertAgentWriteAllowed(frame.canvasId, actor, TOOL_NAME.insertComponent)
  const inserted = await insertElement(frame, {
    parent_selector: input.parent_selector,
    position: input.position,
    html: componentInstanceHtml(component, input.overrides),
  })
  const updated = updateFrame(frame.id, { html: inserted.html }, actor)
  if (!updated) return undefined
  logActivity(frame.canvasId, actor, `inserted the component “${component.name}”`, frame.id)
  return { frame: updated, selector: inserted.selector }
}

/** Make an instance ordinary markup again: strip its two data-doop
 *  attributes and the frame keeps the markup without the link to the
 *  library. `ElementEditError` (unknown selector, too many matches)
 *  propagates to the caller. */
export async function detachComponent(
  frameId: string,
  selector: string,
  actor: Actor,
): Promise<{ frame: Frame } | undefined> {
  const frame = store.getFrame(frameId)
  if (!frame) return undefined
  assertAgentWriteAllowed(frame.canvasId, actor, TOOL_NAME.detachComponent)
  const detached = await updateElements(frame, [
    { selector, attrs: { [COMPONENT_ATTR]: null, [COMPONENT_OVERRIDES_ATTR]: null } },
  ])
  const updated = updateFrame(frame.id, { html: detached.html }, actor)
  if (!updated) return undefined
  logActivity(frame.canvasId, actor, `detached a component instance`, frame.id)
  return { frame: updated }
}

/* ------------------------------------------------------------------ */
/* Cross-canvas memory: what an agent learned about one user's taste,   */
/* keyed by user, not canvas, so a new canvas does not start from zero. */
/* Not review-gated — it is the agent's own notebook, not a canvas      */
/* write.                                                               */
/* ------------------------------------------------------------------ */

const userMemory = new Map<string, UserMemory[]>() // userId -> newest first

/** Fill the memory map from the database at boot. Replaces the lists it is
 *  given, so re-hydrating is safe. */
export function hydrateUserMemory(rows: UserMemory[]): void {
  for (const row of rows) userMemory.set(row.userId, [row, ...(userMemory.get(row.userId) ?? [])])
}

/** What this user's agents have been taught, newest first. */
export function getUserMemory(userId: string): UserMemory[] {
  return userMemory.get(userId) ?? []
}

/** One thing worth carrying to the user's next canvas. Capped per user —
 *  the oldest entry falls off, because a notebook nobody prunes stops
 *  being a memory and becomes an archive. */
export function remember(
  userId: string,
  kind: UserMemory['kind'],
  text: string,
  sourceCanvasId?: string,
): UserMemory | undefined {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  const row: UserMemory = {
    id: nanoid(8),
    userId,
    kind,
    text: clean,
    ...(sourceCanvasId ? { sourceCanvasId } : {}),
    createdAt: Date.now(),
  }
  const list = userMemory.get(userId) ?? []
  list.unshift(row)
  if (list.length > 200) list.length = 200
  userMemory.set(userId, list)
  persist.saveUserMemory(row)
  return row
}

/** Forget one thing. */
export function forgetMemory(userId: string, id: string): boolean {
  const list = userMemory.get(userId)
  const idx = list?.findIndex((m) => m.id === id) ?? -1
  if (!list || idx === -1) return false
  list.splice(idx, 1)
  persist.deleteUserMemory(id)
  return true
}
