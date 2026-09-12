import { nanoid } from 'nanoid'
import { store } from './store.ts'
import * as persist from './db/persist.ts'
import * as frameLocks from './frameLocks.ts'
import * as agentEvents from './agentEvents.ts'
import * as thumbs from './thumbs.ts'
import { colorFor } from '../shared/types.ts'
import { validateTokens } from './designLint.ts'
import { DEFAULT_ROLE_ID, mentionedRole, normalizePipeline, roleByAgentName, roleName } from '../shared/agents.ts'
import { decodeEscapedHtml, looksEscapedHtml, repairEscapedHtml } from './escapedHtml.ts'
import type {
  Actor,
  ActivityItem,
  AgentPlan,
  AgentTask,
  Canvas,
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
}) {
  for (const [canvasId, list] of data.tasks) taskLog.set(canvasId, list)
  for (const [canvasId, list] of data.feedback) feedbackLog.set(canvasId, list)
  for (const [canvasId, list] of data.comments) commentLog.set(canvasId, list)
  for (const [canvasId, list] of data.activity) activityLog.set(canvasId, list)
  for (const [canvasId, list] of data.decisions) decisionLog.set(canvasId, list)
  for (const [canvasId, list] of data.proposals) proposalLog.set(canvasId, list)
  for (const [canvasId, byAgent] of data.plans ?? []) planLog.set(canvasId, byAgent)
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

function logActivity(canvasId: string, actor: Actor, message: string, frameId?: string) {
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

/** Owner flips review mode: agent frame writes now land as proposals. */
export function setCanvasReviewMode(canvasId: string, on: boolean, actor: Actor) {
  store.setReviewMode(canvasId, on)
  broadcast(canvasId, { type: 'canvas:reviewMode', reviewMode: on, actor })
  logActivity(canvasId, actor, on ? 'turned on review mode — agent changes need approval' : 'turned off review mode')
}

export function resolveActor(
  raw: { name?: string; kind?: string; clientId?: string; owner?: string; ownerId?: string } | undefined,
): Actor {
  const kind = raw?.kind === 'agent' ? 'agent' : raw?.kind === 'user' ? 'user' : 'agent'
  const name = raw?.name?.trim() || (kind === 'agent' ? 'AI Agent' : 'Anonymous')
  return { name, kind, color: colorFor(name), clientId: raw?.clientId, owner: raw?.owner, ownerId: raw?.ownerId }
}

/** Refuse a write to a frame another agent has locked. Shared by every
 *  mutation path so external agents and the resident team obey one rule. */
function assertUnlocked(frameId: string, actor: Actor) {
  const holder = frameLocks.heldBy(frameId, actor.name)
  if (holder) throw new frameLocks.FrameLockedError(holder)
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

/** An agent asked a human a blocking question (ask_human). It surfaces live
 *  on the canvas and in the Review tab; the answer rides back through the
 *  event bus into the agent's parked wait. */
export function askQuestion(
  canvasId: string,
  input: { text: string; frameId?: string; selector?: string; waitSeconds?: number },
  actor: Actor,
): AgentQuestion | undefined {
  const text = input.text.trim().slice(0, 2000)
  if (!text || !store.getCanvas(canvasId)) return undefined
  const question: AgentQuestion = {
    id: nanoid(8),
    canvasId,
    agentName: actor.name,
    ...(actor.owner ? { owner: actor.owner } : {}),
    ...(actor.ownerId ? { ownerId: actor.ownerId } : {}),
    color: actor.color,
    ...(input.frameId ? { frameId: input.frameId } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
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
  input: { selector: string; snippet: string; text: string },
  actor: Actor,
  fromUserId?: string,
): ElementComment | undefined {
  const frame = store.getFrame(frameId)
  if (!frame) return undefined
  return postComment(
    frame,
    { selector: String(input.selector ?? '').slice(0, 300), snippet: String(input.snippet ?? '').slice(0, 400) },
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
    { selector: root.selector, snippet: root.snippet, parentId: root.id },
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
  anchor: { selector: string; snippet: string; parentId?: string },
  text: string,
  actor: Actor,
  fromUserId?: string,
): ElementComment | undefined {
  const clean = text.trim()
  if (!clean) return undefined
  /* @Doop, @brand, @a11y… — whichever resident agent is mentioned picks it up */
  const mentioned = mentionedRole(clean)
  const list = commentLog.get(frame.canvasId) ?? []
  /* strictly increasing per canvas: thread order is reconstructed from `at`
     after a restart, so two messages must never share a timestamp */
  const at = Math.max(Date.now(), (list[0]?.at ?? 0) + 1)
  const comment: ElementComment = {
    id: nanoid(8),
    canvasId: frame.canvasId,
    frameId: frame.id,
    selector: anchor.selector,
    snippet: anchor.snippet,
    from: actor.name,
    ...(fromUserId ? { fromUserId } : {}),
    text: clean,
    at,
    ...(mentioned ? { forAgent: true, targetAgent: mentioned.name } : {}),
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
  frameLocks.releaseAllFor(canvasId, agentName)
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
    /* a stopped run holds nothing: its frames are free for the human to edit */
    frameLocks.releaseAllFor(canvasId, agentName)
    cancel(canvasId)
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `stopped ${agentName}`)
  }
  return stopped
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
  const list = taskLog.get(canvasId) ?? []
  const duplicate = list.find(
    (t) =>
      t.queuedBy === from &&
      !t.endedAt &&
      t.status === clean &&
      pipelineOf(t).join(',') === pipeline.join(',') &&
      (t.attachments ?? []).join(',') === refs.join(',') &&
      (t.targetFrameIds ?? []).join(',') === targets.join(','),
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
  }
  list.unshift(card)
  taskLog.set(canvasId, trimTaskLog(list))
  persist.saveTask(canvasId, card)
  broadcast(canvasId, { type: 'task', task: card })
  agentEvents.push(canvasId, { kind: 'card', data: { cardId: card.id, text: clean, pipeline } })
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
}

const streams = new Map<string, StreamState>() // frameId -> state

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
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: r.actor })
  endAutoTask(frame.canvasId, r.actor)
}

function finishStream(frameId: string, logDone: boolean) {
  const s = streams.get(frameId)
  if (!s) return
  streams.delete(frameId)
  const frame = store.getFrame(frameId)
  if (!frame) return
  broadcast(frame.canvasId, { type: 'frame:streaming', frameId, active: false, actor: s.actor })
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
  for (const [frameId, s] of streams) {
    if (now - s.lastActivity > STREAM_IDLE_MS) finishStream(frameId, false) // agent died mid-stream
  }
}, TICK_MS)

export function appendFrameHtml(
  frameId: string,
  chunk: string,
  actor: Actor,
  opts: { start?: boolean; done?: boolean } = {},
): Frame | undefined {
  const before = store.getFrame(frameId)
  if (!before) return undefined
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
  const html = opts.start ? piece : before.html + piece
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
  if (input.html !== undefined) input = { ...input, html: repairEscapedHtml(input.html) }
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
  assertUnlocked(frameId, actor)
  frameLocks.refresh(frameId, actor.name)
  if (patch.html !== undefined) patch = { ...patch, html: repairEscapedHtml(patch.html) }
  const prevName = before.name
  const prevHtml = before.html
  const frame = store.updateFrame(frameId, patch, actor.name)!

  const htmlChanged = patch.html !== undefined && patch.html !== prevHtml
  if (htmlChanged && actor.kind === 'agent') {
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
      /* a human takes over: cancel any live stream or playback */
      finishStream(frameId, false)
      finishReveal(frameId)
    }
    broadcast(frame.canvasId, { type: 'frame:updated', frame, actor })
    if (htmlChanged) {
      logActivity(frame.canvasId, actor, `updated the design of “${frame.name}”`, frame.id)
    } else if (patch.name !== undefined && patch.name !== prevName) {
      logActivity(frame.canvasId, actor, `renamed “${prevName}” to “${frame.name}”`, frame.id)
    }
  }

  touch(frame.canvasId, actor, frame.id)
  return frame
}

export function deleteFrame(frameId: string, actor: Actor): Frame | undefined {
  if (store.getFrame(frameId)) assertUnlocked(frameId, actor)
  /* close any live stream or playback while the frame still exists,
     so their auto “Designing…” tasks end with it */
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
  const page = store.createPage(canvasId, name)
  if (!page) return undefined
  const canvas = store.getCanvas(canvasId)!
  broadcast(canvasId, { type: 'pages', pages: canvas.pages!, actor })
  logActivity(canvasId, actor, `created page “${page.name}”`)
  return page
}

export function renamePage(pageId: string, name: string, actor: Actor) {
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
    summary: string
  },
  actor: Actor,
): FrameProposal | undefined {
  const target = input.frameId ? store.getFrame(input.frameId) : undefined
  if (input.frameId && !target) return undefined
  if ((input.kind === 'replace_html' || input.kind === 'delete_frame') && !target) return undefined
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
 *  again marks it stale instead of overwriting the newer design. */
export function resolveFrameProposal(
  canvasId: string,
  proposalId: string,
  accept: boolean,
  actor: Actor,
): FrameProposal | undefined {
  const proposal = (frameProposalLog.get(canvasId) ?? []).find((p) => p.id === proposalId)
  if (!proposal || proposal.status !== 'pending') return proposal
  if (accept) {
    const frame = proposal.frameId ? store.getFrame(proposal.frameId) : undefined
    if (frame && frame.updatedAt !== proposal.baseUpdatedAt) {
      proposal.status = 'stale'
    } else if (proposal.kind === 'replace_html' && frame) {
      updateFrame(frame.id, { html: proposal.html ?? frame.html }, actor)
    } else if (proposal.kind === 'delete_frame' && frame) {
      deleteFrame(frame.id, actor)
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
    }
    proposal.status = proposal.status === 'stale' ? 'stale' : 'accepted'
  } else {
    proposal.status = 'rejected'
  }
  proposal.resolvedBy = actor.name
  proposal.resolvedAt = Date.now()
  persist.saveFrameProposal(canvasId, proposal)
  broadcast(canvasId, { type: 'frameProposal', proposal })
  agentEvents.push(canvasId, {
    kind: 'frame_proposal',
    targetAgent: proposal.agentName,
    data: { proposalId: proposal.id, status: proposal.status },
  })
  logActivity(canvasId, actor, `${accept ? 'accepted' : 'rejected'} ${proposal.agentName}’s proposal`)
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
 *  instead of writing when the canvas is in review mode and the writer is an
 *  agent; otherwise returns undefined and the caller writes directly. */
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
    summary: string
  },
  actor: Actor,
): FrameProposal | undefined {
  if (actor.kind !== 'agent' || !store.getCanvas(canvasId)?.reviewMode) return undefined
  return addFrameProposal(canvasId, op, actor)
}

/* ------------------------------------------------------------------ */
/* Pause / resume: an aborted run whose card is skipped by the sweep   */
/* until a human resumes it. Not terminal — no metered retry needed.   */
/* ------------------------------------------------------------------ */

/** Pause a live run: abort the model call like a stop, but keep the card
 *  open and paused instead of cancelling it. */
export function pauseAgentWork(canvasId: string, agentName: string, by: string): number {
  const now = Date.now()
  let paused = 0
  for (const t of taskLog.get(canvasId) ?? []) {
    if (t.agentName !== agentName || !t.queuedBy) continue
    if (t.endedAt || t.cancelledAt || t.pausedAt || t.failedAt) continue
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
    frameLocks.releaseAllFor(canvasId, agentName)
    cancel(canvasId)
    logActivity(canvasId, resolveActor({ name: by, kind: 'user' }), `paused ${agentName}`)
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
  frameLocks.release(frameId, actor.name)
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

export function recordRunJournal(input: {
  canvasId: string
  agentName: string
  cardId?: string
  summary: string
  decisions?: string
}): void {
  const entry: RunJournal = {
    id: nanoid(8),
    canvasId: input.canvasId,
    agentName: input.agentName,
    ...(input.cardId ? { cardId: input.cardId } : {}),
    summary: input.summary.slice(0, 800),
    ...(input.decisions ? { decisions: input.decisions } : {}),
    at: Date.now(),
  }
  const list = journalLog.get(input.canvasId) ?? []
  list.unshift(entry)
  if (list.length > 100) list.length = 100
  journalLog.set(input.canvasId, list)
  persist.saveJournal(entry)
}

/** The role's last runs on this canvas, oldest first — kickoff context. */
export function getRunJournals(canvasId: string, agentName: string, limit = 3): RunJournal[] {
  return (journalLog.get(canvasId) ?? [])
    .filter((j) => j.agentName === agentName)
    .slice(0, limit)
    .reverse()
}
