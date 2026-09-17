import { randomUUID } from 'node:crypto'
import * as actions from './actions.ts'
import * as agentEvents from './agentEvents.ts'
import { DesignLlmError, designComplete } from './designLlm.ts'
import * as frameLocks from './frameLocks.ts'
import { MAX_FRAME_HTML_BYTES } from './limits.ts'
import { reviewFrame } from './review.ts'
import { findBrowserPath, VIEWPORTS } from './screenshot.ts'
import { store } from './store.ts'
import * as runLog from './runLog.ts'
import { cssForTokens } from '../shared/tokens.ts'
import type { NotificationPhase } from './notifications.ts'
import type { Actor, DesignTokens, Frame } from '../shared/types.ts'

/**
 * The design workflow: an implementer model writes one frame from a brief, the
 * deterministic review plus a judge model critique it, and the implementer
 * iterates on the judge's issues until the judge passes or the attempt budget
 * runs out. Everything runs server-side, against the operator's one
 * [OI]-compatible endpoint, and every attempt lands through actions.ts — so
 * the frame persists, versions and broadcasts exactly as a hand-written one
 * does, and a human in the room watches the design build attempt by attempt.
 * The run narrates itself on the canvas timeline while it works (each attempt
 * as it starts, the judge's pass over it, then how the run ended) and mails
 * that ending to the humans who opted into agent mail.
 *
 * The judge reads the frame's HTML and the review's findings, never a
 * screenshot. A render is the most expensive thing the server does, and it is
 * also the weakest evidence: a picture leaves the model guessing at a blur,
 * while the checks already know the exact rule, selector and detail that
 * failed. The findings are ground truth; the judge's job is to weigh them
 * against the brief and phrase the fix for the implementer.
 */

/** One attempt the workflow did not accept: either the implementer produced
 *  nothing writable, or the judge rejected the frame. `judgeFeedback` is what
 *  the next attempt was told to fix, so a caller can read back why the run
 *  went the way it did. */
export interface WorkflowIssue {
  attempt: number
  judgeFeedback: string
}

export interface WorkflowResult {
  ok: boolean
  attempts: number
  /** '' when no attempt produced writable HTML (nothing was ever created) */
  frameId: string
  htmlBytes: number
  judgeVerdict: 'pass' | 'fail'
  judgeSummary: string
  issues: WorkflowIssue[]
  /** true when a human's stop ended the run rather than the attempt budget:
   *  the run is over but nothing failed, so the caller reports it as a stop */
  stopped?: boolean
}

const DEFAULT_MAX_ATTEMPTS = 3
/** The loop's ceiling. Each attempt is two long model calls, so a design that
 *  has not converged in five is not converging — a human decides what is next. */
const MAX_ATTEMPTS = 5
/** A reasoning model spends its budget on the trace before it writes anything:
 *  deepseek-v4.1-flash emits ~26k characters of reasoning for one pricing
 *  section, and at 16k tokens it hit the cap mid-document (`finish_reason:
 *  "length"`) with the frame's HTML cut off. The same brief finished in 13.5k
 *  completion tokens once given room, so this is headroom, not a target. */
const IMPLEMENTER_MAX_TOKENS = 32_000
/** The judge answers with one small object, but it reasons first and its trace
 *  is charged to the same budget — an empty reply would fail the run rather
 *  than the attempt. */
const JUDGE_MAX_TOKENS = 4_000
/** How often a model call beats the agent's presence. Presence expires after
 *  ~20s of silence, and one implementer call can run for minutes, so beating
 *  only at the boundaries between calls would drop the agent mid-design. */
const PRESENCE_BEAT_MS = 15_000
/** The artboard a workflow design is created in when the caller did not name
 *  an existing frame. The height is the load-bearing number: the review renders
 *  the frame at mobile (390px), tablet and desktop, each at the frame's own
 *  height, and blocks on content that runs past it. A content-rich brief — a
 *  three-tier pricing section is the standard example — is 1300–1700px tall
 *  once it stacks on a phone, so a 900px artboard is a constraint no design can
 *  satisfy: the loop would spend every attempt failing the same layout check.
 *  A caller who wants a different box passes an existing frame_id, which is
 *  sized from the frame. */
export const FRAME_WIDTH = 1280
export const FRAME_HEIGHT = 1600
/** RunEvent.summary is documented as ≤200 chars, and the comment pinned to the
 *  frame says the same sentence, so both are cut from one string. */
const SUMMARY_MAX = 200
/** How much of an unparseable judge reply the failure note carries: enough to
 *  see what the model actually answered, not enough to flood the next prompt. */
const REPLY_EXCERPT_MAX = 200
/** What the judge reads where findings would go when the deterministic checks
 *  could not run — a host with no renderer, or a render that failed. The judge
 *  still sees the HTML; it is told, and has to say, that it judged that alone. */
const NO_CHECKS_NOTE =
  'The deterministic checks did not run on this server, so judge the HTML alone and say so in your summary.'

const IMPLEMENTER_SYSTEM = [
  'You design one frame of a product canvas, and you reply with a complete, self-contained HTML',
  'document and nothing else — no commentary, no markdown fence.',
  'Inline all CSS in a <style> element, use semantic HTML, and make the layout responsive.',
  'Add a <script> only when the brief asks for behaviour.',
  'When the canvas design tokens are given, build with those CSS custom properties instead of',
  'inventing colours, spacing or type scales.',
].join(' ')

const JUDGE_SYSTEM = [
  'You are a strict design judge reviewing one frame against the brief it was designed for.',
  'Reply with ONLY a JSON object — no prose, no markdown fence — in exactly this shape:',
  '{ "verdict": "pass" | "fail", "summary": string, "issues": string[] }.',
  'Judge the brief, not the checks: the deterministic findings are evidence, and a clean report does',
  'not mean the design did what was asked — that is what you are here to say.',
  'Fail for exactly two things: a blocking finding, or the design not meeting the brief.',
  'The advisory findings are never blockers and cannot fail a design on their own — mention them in',
  'issues as improvements, and still pass.',
  'The frame is a fixed artboard, not a scrolling page: content that ends above the bottom edge, or a',
  'viewport taller than the content, is empty space and not a defect — never fail for it, and never',
  'ask the implementer to fill it.',
  'summary is one sentence on what you saw. issues are concrete fixes addressed to the implementer,',
  'and are empty when you pass.',
].join(' ')

/** The attempt budget as the caller asked for it, held to what the loop can
 *  actually honour: 1–5 attempts, defaulting to 3. */
function clampAttempts(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_ATTEMPTS
  return Math.min(MAX_ATTEMPTS, Math.max(1, Math.trunc(requested)))
}

/** The document inside an implementer reply. Models fence a whole document
 *  whatever the prompt says, and introduce it with a sentence first — the real
 *  reply to a pricing brief opens "Here's a complete HTML document for a
 *  three-tier pricing section …" and only then starts the fence — so the fence
 *  is what delimits the HTML, not the start of the reply. A reply with no
 *  fence is taken from its first document tag, which drops such a sentence. */
function htmlFromReply(reply: string): string {
  const fenced = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(reply)
  const body = fenced?.[1] ?? reply
  const start = /<!doctype html|<html[\s>]/i.exec(body)
  return (start ? body.slice(start.index) : body).trim()
}

/** The JSON object inside a judge reply: fenced, or wrapped in a sentence. */
function jsonFromReply(reply: string): string {
  const fenced = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(reply)
  const body = fenced?.[1] ?? reply
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim()
}

interface JudgeVerdict {
  verdict: 'pass' | 'fail'
  summary: string
  issues: string[]
}

/** The judge's answer, or undefined when the reply is not the object it was
 *  asked for — an unparseable judge is a failed attempt, not a crash. */
function parseJudgeVerdict(reply: string): JudgeVerdict | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonFromReply(reply))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const verdict = record.verdict
  if (verdict !== 'pass' && verdict !== 'fail') return undefined
  return {
    verdict,
    summary: typeof record.summary === 'string' ? record.summary : '',
    issues: Array.isArray(record.issues)
      ? record.issues.filter((issue): issue is string => typeof issue === 'string')
      : [],
  }
}

/** The tallest box a review renders: review.ts viewportFor caps every viewport
 *  height here, so a frame taller than this is measured at this, and telling
 *  the implementer the frame's own larger height would send it designing into
 *  a box nothing ever renders. */
const MAX_REVIEWED_HEIGHT = 4000

/** The brief, plus what the last attempt was told to fix, plus the canvas's
 *  tokens as the CSS the frame will actually render with, plus every size the
 *  design is reviewed at. The sizes matter: the judge reads the layout
 *  findings, which measure the render, so an implementer that does not know it
 *  is designing into a 1280×1600 frame is being marked down for a constraint it
 *  was never told about.
 *
 *  The widths matter just as much, and they are not just the device presets: a
 *  canvas that declares its own breakpoints is reviewed at those too, and a
 *  three-column section that stacks vertically on a 390px screen grows past the
 *  frame's height — the layout check calls it `clipped_by_frame` and the
 *  delivery gate blocks on it. Naming the sizes is what turns "design to fit"
 *  into something the implementer can actually do. */
function implementerPrompt(
  brief: string,
  feedback: string,
  tokensCss: string | undefined,
  size: { width: number; height: number },
  breakpoints: { name: string; min_width: number }[],
): string {
  /* every viewport is rendered at its own preset height, raised to the frame's
     height when that is taller and capped at MAX_REVIEWED_HEIGHT — so the
     budget is not one number, and stating one would over-constrain the widest
     layouts. Breakpoints render at the mobile height raised the same way. */
  const rendered = (preset: number) => Math.min(MAX_REVIEWED_HEIGHT, Math.max(preset, size.height))
  const sizes = [
    ...Object.values(VIEWPORTS).map((viewport) => `${viewport.width} × ${rendered(viewport.height)}`),
    ...breakpoints.map(
      (breakpoint) => `${breakpoint.min_width} × ${rendered(VIEWPORTS.mobile.height)} (${breakpoint.name})`,
    ),
  ].join(', ')
  const sections = [
    brief.trim(),
    `## The frame\nIt is a fixed ${size.width} × ${Math.min(MAX_REVIEWED_HEIGHT, size.height)} px artboard, reviewed at ${sizes} px.`,
    `The design must fit the height of every one of those: the review renders the frame at each size ` +
      `and blocks on content that runs past the bottom edge. Budget for the narrowest one — a tall ` +
      `stack of full-width blocks will not fit on a phone, so that layout has to stay compact.`,
  ]
  if (feedback) sections.push(`## Fix these issues\n${feedback}`)
  if (tokensCss) {
    sections.push(`## Canvas design tokens\nThese custom properties are on :root when the frame renders:\n${tokensCss}`)
  }
  return sections.join('\n\n')
}

/** What the judge reads: the brief, the artboard the design lives in, the
 *  document, and the evidence. The artboard is named because the judge has no
 *  other way to know it — the findings carry selectors and rules, not sizes —
 *  and a judge left to infer the frame from a viewport preset fails designs for
 *  the height of the wrong box. */
function judgePrompt(brief: string, html: string, evidence: string, size: { width: number; height: number }): string {
  return [
    brief.trim(),
    `## The frame\nIt is ${size.width} × ${Math.min(MAX_REVIEWED_HEIGHT, size.height)} px, a fixed artboard.`,
    `## Frame HTML\n${html}`,
    `## Review findings\n${evidence}`,
  ].join('\n\n')
}

/** The review's findings as the judge reads them, or the note that stands in
 *  for them. The review renders, and a self-host may have no Chrome at all;
 *  a render that fails at run time is the same dead end. By then the operator
 *  has already paid for the attempt, so the judge gets the HTML plus the truth
 *  about its evidence rather than the run dying on a host that cannot render.
 *
 *  The canvas's own breakpoints are reviewed, exactly as `review_frame` and
 *  canvasReview review them: a narrower run would let this workflow pass a
 *  frame — and pin a pass comment on it — that the very next `review_frame`
 *  fails at a width the canvas itself declares. */
async function reviewEvidence(
  frame: Frame,
  tokens: DesignTokens | undefined,
  breakpoints: { name: string; min_width: number }[],
): Promise<string> {
  if (!findBrowserPath()) return NO_CHECKS_NOTE
  try {
    const report = await reviewFrame(frame, tokens, breakpoints.length ? { breakpoints } : {})
    /* The judge sees the findings, never the per-viewport detail: the same rule
       failing at three widths is one thing to fix. A finding is exactly
       rule/selector/detail/source, so the projection is the finding itself. */
    const findings = {
      summary: report.summary,
      blocking: report.blocking.map(({ rule, selector, detail, source }) => ({ rule, selector, detail, source })),
      advisory: report.advisory.map(({ rule, selector, detail, source }) => ({ rule, selector, detail, source })),
    }
    return JSON.stringify(findings, null, 2)
  } catch {
    return NO_CHECKS_NOTE
  }
}

/** Run one model call with the agent's presence held for as long as it takes:
 *  a beat lands before the call and every PRESENCE_BEAT_MS while it is in
 *  flight, and the timer is cleared however the call ends — nothing outlives
 *  the call, and a failure still propagates. A beat cannot throw (it writes a
 *  presence entry and a guarded socket send), so it is a bare call, not a
 *  guarded one, and the interval is a plain one like actions.ts's stream
 *  ticker: the finally is what ends it, so unref would only hide a leak. */
async function withPresence<T>(canvasId: string, actor: Actor, work: () => Promise<T>): Promise<T> {
  actions.heartbeatAgent(canvasId, actor)
  const beat = setInterval(() => actions.heartbeatAgent(canvasId, actor), PRESENCE_BEAT_MS)
  try {
    return await work()
  } finally {
    clearInterval(beat)
  }
}

/** The run's own identity, as the timeline records it. `Actor.kind` says
 *  'user' for a person and 'agent' for an MCP connection, while the timeline
 *  spells the person `'human'`; an absent kind reads as an agent, the only kind
 *  there was before it was tracked, so every line this engine writes declares
 *  one. The account behind the actor is stamped only when it is not the canvas's
 *  own owner — the owner's runs are the canvas's own work, and their name is
 *  what the reader already has. */
function actorStamp(canvasId: string, actor: Actor): { actorKind: 'human' | 'agent'; actorOwner?: string } {
  return {
    actorKind: actor.kind === 'user' ? 'human' : 'agent',
    ...(actor.ownerId && actor.ownerId !== store.getCanvas(canvasId)?.ownerId ? { actorOwner: actor.ownerId } : {}),
  }
}

/** What a run is given. `runId` names that run on the canvas timeline: the MCP
 *  wrapper's session run id when the caller has one, so the engine's lines land
 *  in the same run as the tool call that started it. A caller with no run id of
 *  its own gets a fresh one per call — the timeline groups by run id and
 *  nothing else, and a run whose lines carry none would be unreadable. */
interface DesignWorkflowInput {
  canvasId: string
  brief: string
  frameName: string
  implementerModel: string
  judgeModel: string
  actor: Actor
  maxAttempts?: number
  frameId?: string
  runId?: string
}

/** The one mail a run sends: how it ended. Fire-and-forget through a dynamic
 *  import, exactly like actions.ts's askQuestion — a mail that cannot go out
 *  (no SMTP, nobody opted in) is not the run's business, and the engine does
 *  not carry notifications.ts's part of the graph for it. `stop` is the closest
 *  kind the union has to a run being over; `phase` is what decides both the
 *  switch and the label, so the mail reads "finished its run", "failed its run"
 *  or "was stopped" whatever the kind. */
function notifyRunEnd(canvasId: string, agentName: string, frameName: string, phase: NotificationPhase): void {
  /* the sentence's verb, in the phase's own words: a run a human ended was not
     a run that failed, and the mail must not read as one */
  const ending = phase === 'finished' ? 'finished' : phase === 'stopped' ? 'stopped' : 'failed'
  import('./notifications.ts')
    .then((n) =>
      n.notifyAgentEvent(canvasId, 'stop', `${agentName} ${ending} the design run for “${frameName}”`, { phase }),
    )
    .catch(() => {})
}

/** Run the workflow and report it. The run's own lines are the engine's, not
 *  the caller's single tool event: the loop writes one per attempt as it starts
 *  it, and this writes the ending — which is why the ending is here, where the
 *  result and the throw both arrive. */
export async function runDesignWorkflow(input: DesignWorkflowInput): Promise<WorkflowResult> {
  const runId = input.runId ?? randomUUID()
  try {
    const result = await runDesignLoop({ ...input, runId })
    /* a run a human stopped is neither a pass nor a failure: the timeline says
       who ended it, in the kind the Run tab renders a stop with */
    runLog.recordStatus(
      input.canvasId,
      runId,
      input.actor.name,
      result.stopped ? 'stop' : result.ok ? 'status' : 'error',
      result.judgeSummary,
      {
        ok: result.ok,
        ...(result.frameId ? { frameId: result.frameId } : {}),
        ...actorStamp(input.canvasId, input.actor),
      },
    )
    /* the mail says the same thing the timeline does: a run a human stopped is
       neither a pass nor a failure, so it is not filed under a failure */
    const phase: NotificationPhase = result.ok ? 'finished' : result.stopped ? 'stopped' : 'failed'
    notifyRunEnd(input.canvasId, input.actor.name, input.frameName, phase)
    return result
  } catch (error) {
    runLog.recordStatus(
      input.canvasId,
      runId,
      input.actor.name,
      'error',
      error instanceof Error ? error.message : 'the design workflow failed',
      { ok: false, ...actorStamp(input.canvasId, input.actor) },
    )
    notifyRunEnd(input.canvasId, input.actor.name, input.frameName, 'failed')
    throw error
  }
}

/** The loop itself: one frame written from the brief, reviewed and judged, until
 *  the judge passes it or the attempt budget runs out. */
async function runDesignLoop(input: DesignWorkflowInput & { runId: string }): Promise<WorkflowResult> {
  const budget = clampAttempts(input.maxAttempts)
  const issues: WorkflowIssue[] = []
  let frameId = input.frameId ?? ''
  /* whether any attempt has landed HTML yet: the first write opens the frame's
     stream and closes it in the same call, and every later attempt replaces
     the document with a plain update */
  let wroteHtml = false
  let htmlBytes = 0
  let ok = false
  let judgeVerdict: 'pass' | 'fail' = 'fail'
  let judgeSummary = ''
  let attempts = 0
  let stopped = false
  /* A human's stop is a fact about the run, not about one attempt: MCP is
     pull-based and the endpoint is stateless, so the stop cannot interrupt the
     call in flight — it is checked at each boundary the loop owns and consumed
     as it is acted on, so the stop that ended this run cannot refuse the next
     run's first call. */
  const takeStop = (): boolean => {
    const stop = agentEvents.pendingStop(input.canvasId, input.actor.name)
    if (!stop) return false
    agentEvents.clearStop(input.canvasId, input.actor.name, input.runId)
    judgeSummary = `stopped by ${stop.by}`
    stopped = true
    return true
  }

  for (let attempt = 1; attempt <= budget; attempt++) {
    /* a stop that landed since the last attempt ends the run here, before
       another one is paid for */
    if (takeStop()) break
    attempts = attempt
    /* the run timeline is where a human watches this happen, and an attempt is
       minutes of model time: it says so before the call, not after */
    runLog.recordStatus(
      input.canvasId,
      input.runId,
      input.actor.name,
      'status',
      `implementing attempt ${attempt}/${budget}`,
      actorStamp(input.canvasId, input.actor),
    )
    /* A steer is a human's mid-run course correction, so it rides the slot the
       judge's issues ride: from the second attempt on there is work to correct,
       and the implementer reads both as what this attempt has to change. A
       steer nobody has read yet is drained here — the attempt it reaches is
       the one it was meant to change. */
    const steers = attempt > 1 ? agentEvents.takeSteers(input.canvasId, input.actor.name) : []
    const steered = steers.length
      ? `STEERED — a human redirected this run while it was in progress:\n${steers
          .map((steer) => `- ${steer.by}: ${steer.message || '(no message)'}`)
          .join('\n')}`
      : ''
    const previous = [issues.length ? issues[issues.length - 1]!.judgeFeedback : '', steered]
      .filter(Boolean)
      .join('\n\n')
    const canvas = store.getCanvas(input.canvasId)
    /* the artboard the design must fit: a redesign answers to the frame that is
       already there, a new design to the size this run will create */
    const existing = frameId ? store.getFrame(frameId) : undefined
    const size = { width: existing?.width ?? FRAME_WIDTH, height: existing?.height ?? FRAME_HEIGHT }
    /* the canvas's declared breakpoints are reviewed as well as the device
       presets, so they are part of the budget the implementer is told */
    const breakpoints = canvas?.breakpoints ?? []
    /* Both model calls sit inside one per-attempt guard: a provider timeout,
       a filter rejection, an empty reply — anything the endpoint says rather
       than a refusal this canvas produced — is that attempt spent and the
       next one fed the reason. Throwing instead would surface the endpoint's
       bad night as a tool error and end the run with the design still on the
       floor, when the only cure the caller has is the same retry the loop
       already knows how to do. */
    const calls = {
      implementer: () =>
        withPresence(input.canvasId, input.actor, () =>
          designComplete({
            model: input.implementerModel,
            system: IMPLEMENTER_SYSTEM,
            prompt: implementerPrompt(
              input.brief,
              previous,
              canvas?.tokens ? cssForTokens(canvas.tokens) : undefined,
              size,
              breakpoints,
            ),
            maxTokens: IMPLEMENTER_MAX_TOKENS,
          }),
        ),
      judge: (html: string, evidence: string) =>
        withPresence(input.canvasId, input.actor, () =>
          designComplete({
            model: input.judgeModel,
            system: JUDGE_SYSTEM,
            prompt: judgePrompt(input.brief, html, evidence, size),
            maxTokens: JUDGE_MAX_TOKENS,
          }),
        ),
    }

    /* A permanent refusal — a model the key cannot reach, a rejected request,
       missing configuration — ends the run on the first answer: the retry would
       be told the same thing, and each attempt is a paid call. A transient
       failure (timeout, 5xx, connection) spends the attempt and feeds the next
       one the reason, because that is exactly the case a retry fixes. Anything
       else is a bug in this process, and swallowing it into an attempt would
       hide it while spending the operator's money. */
    let reply: { text: string; truncated: boolean }
    try {
      reply = await calls.implementer()
    } catch (error) {
      if (!(error instanceof DesignLlmError)) throw error
      if (error.permanent) {
        judgeSummary = error.message
        break
      }
      issues.push({ attempt, judgeFeedback: `implementer call failed: ${error.message}` })
      continue
    }

    const html = htmlFromReply(reply.text)

    if (!html) {
      issues.push({ attempt, judgeFeedback: 'implementer returned no HTML' })
      continue
    }
    /* The provider stopped it at the budget, so the document is cut off
       mid-element. Writing it would put a broken page in front of the humans
       watching, and the judge would be reviewing half a design — the attempt
       is spent either way, and a retry is the only thing that can fix it. */
    if (reply.truncated) {
      issues.push({
        attempt,
        judgeFeedback: `the implementer's reply was cut off at the ${IMPLEMENTER_MAX_TOKENS}-token budget before the document finished — send a shorter design`,
      })
      continue
    }
    if (html.length > MAX_FRAME_HTML_BYTES) {
      issues.push({ attempt, judgeFeedback: 'the generated HTML exceeded the size limit' })
      continue
    }

    let target = frameId
    try {
      if (!target) {
        const created = actions.createFrame(
          input.canvasId,
          { name: input.frameName, html: '', width: FRAME_WIDTH, height: FRAME_HEIGHT },
          input.actor,
        )
        if (!created) {
          judgeSummary = 'the canvas no longer exists'
          break
        }
        target = created.id
      }
      if (wroteHtml) actions.updateFrame(target, { html }, input.actor)
      else actions.appendFrameHtml(target, html, input.actor, { start: true, done: true })
    } catch (error) {
      /* A refusal is about this canvas, not this attempt: retrying would hit
         the same gate, so the run ends here and the reason is the summary. */
      if (error instanceof actions.ReviewModeError || error instanceof frameLocks.FrameLockedError) {
        frameId = target
        judgeSummary = error.message
        break
      }
      throw error
    }

    frameId = target
    wroteHtml = true
    htmlBytes = Buffer.byteLength(html, 'utf8')
    const frame = store.getFrame(frameId)
    if (!frame) {
      judgeSummary = 'the frame no longer exists'
      break
    }

    /* A stop that landed while the implementer was writing ends the attempt
       here, ahead of the review render and the judge call: both are work a
       stopped run does not owe anyone, and the judge would be a paid model
       call on a design nobody asked to finish. The HTML that did arrive stays
       on the canvas for a human, exactly as a failed run's last design does. */
    if (takeStop()) break

    /* the review reads through the attempt's canvas reference: `getCanvas`
       hands back the live canvas — the store mutates tokens and breakpoints in
       place rather than replacing it — so this measures the canvas as it stands
       at review time, agreeing with the `review_frame` a human runs next */
    const evidence = await reviewEvidence(frame, canvas?.tokens, breakpoints)
    runLog.recordStatus(
      input.canvasId,
      input.runId,
      input.actor.name,
      'status',
      `judge reviewing attempt ${attempt}`,
      actorStamp(input.canvasId, input.actor),
    )
    let judgeReply: { text: string; truncated: boolean }
    try {
      judgeReply = await calls.judge(html, evidence)
    } catch (error) {
      if (!(error instanceof DesignLlmError)) throw error
      if (error.permanent) {
        judgeSummary = error.message
        break
      }
      issues.push({ attempt, judgeFeedback: `judge call failed: ${error.message}` })
      continue
    }
    const verdict = judgeReply.truncated ? undefined : parseJudgeVerdict(judgeReply.text)
    if (!verdict) {
      const excerpt = judgeReply.text.trim().slice(0, REPLY_EXCERPT_MAX)
      issues.push({
        attempt,
        judgeFeedback: judgeReply.truncated
          ? `the judge's reply was cut off at the ${JUDGE_MAX_TOKENS}-token budget`
          : `judge reply was not valid JSON: ${excerpt}`,
      })
      continue
    }

    judgeSummary = verdict.summary
    if (verdict.verdict === 'pass') {
      judgeVerdict = 'pass'
      ok = true
      break
    }
    issues.push({
      attempt,
      judgeFeedback: verdict.issues.length ? verdict.issues.join('\n') : verdict.summary,
    })
  }

  /* A run that never reached a judge still has to say something: the last
     attempt's failure is the honest summary of it. */
  if (!judgeSummary) {
    judgeSummary = ok
      ? 'the judge passed the design'
      : issues.length
        ? issues[issues.length - 1]!.judgeFeedback
        : 'the design workflow produced no result'
  }
  const summary = judgeSummary.slice(0, SUMMARY_MAX)
  const attemptWord = attempts === 1 ? 'attempt' : 'attempts'

  /* The comment is a report ON the run — the frame is already written and the
     result already decided, so it may not fail it. The run's terminal timeline
     line is not written here: the entry point records this same summary once
     the run is over, as a status when it passed, a stop when a human ended it
     and an error when it did not. */
  if (frameId) {
    try {
      actions.addElementComment(
        frameId,
        {
          selector: 'body',
          snippet: '',
          /* a stopped run reached no verdict, so reporting one would credit the
             judge with an answer it never gave */
          text: stopped
            ? `Design workflow: ${summary} after ${attempts} ${attemptWord}`
            : `Design workflow: judge verdict ${judgeVerdict} after ${attempts} ${attemptWord} — ${summary}`,
        },
        input.actor,
      )
    } catch {
      /* the verdict is pinned to the work when it can be, not as a condition */
    }
  }

  return { ok, attempts, frameId, htmlBytes, judgeVerdict, judgeSummary, issues, ...(stopped ? { stopped } : {}) }
}
