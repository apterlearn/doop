import type Anthropic from '@anthropic-ai/sdk'
import { nanoid } from 'nanoid'
import { store } from './store.ts'
import { ModelAuthError, pickModel } from './agentModel.ts'
import type { AgentModel } from './agentModel.ts'
import * as runLog from './runLog.ts'
import * as persist from './db/persist.ts'
import { reportIsCurrent, reviewFrame, reviewToRecord, type ReviewReport } from './review.ts'
import * as plans from './plans.ts'
import * as agentEvents from './agentEvents.ts'
import { RESIDENT_TASK_LIMIT } from './allowance.ts'
import * as actions from './actions.ts'
import * as frameLocks from './frameLocks.ts'
import { MAX_HTML_READ_CHARS, readFrameHtml, renderFrame } from './screenshot.ts'
import { inspectFrame } from './domProbe.ts'
import { AGENT_ROLES, DEFAULT_ROLE_ID, roleById, roleByAgentName, roleName } from '../shared/agents.ts'
import { feedbackAbout, feedbackBlock, injectFeedback } from './feedbackText.ts'
import * as runBudget from './runBudget.ts'
import type { AgentRole } from '../shared/agents.ts'
import * as imageSearch from './imageSearch.ts'
import * as backgrounds from './backgrounds.ts'
import { PUBLIC_ORIGIN } from './auth.ts'
import * as ingest from './ingest.ts'
import { viewWebsite, referencedUrls } from './website.ts'
import { createImportedWebpageFrame, findImportedWebpageFrame } from './webpageImport.ts'
import { DESIGN_BRIEF, DESIGN_QUALITY } from './guide.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import type { Frame, TaskFeedback } from '../shared/types.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { executeGuardedBatch } from './guardedBatch.ts'
import { runRepoCards } from './githubRecon.ts'

/**
 * The resident design team: a server-side Claude tool loop, run once per
 * agent role that has work waiting. Doop builds; the specialists (UX, copy,
 * brand, accessibility, polish) each own one pass. A board card names an
 * ordered pipeline of roles and moves down it one stage at a time, so a
 * single card can go design → copy → brand → a11y without a human in between.
 *
 * Everything each agent does flows through the same actions the MCP tools
 * use, so users see the full show: presence, set_status in the working-now
 * strip, a task in the panel, and edits playing back through the reveal.
 *
 * Which model each run uses is server/agentModel.ts's decision: the server
 * tier (Anthropic by default, or an Azure OpenAI deployment via
 * DOOP_AGENT_PROVIDER) covers the free tasks, and past that the run moves onto
 * the model account the requesting human connected (their ChatGPT
 * subscription or OpenAI key). With neither, the queue behaves as it always
 * did — the work waits for the next agent to connect over MCP.
 */

const MAX_TURNS = 24
/* a redesign card delivers an audit doc plus TWO draft frames in one run */
const MAX_REDESIGN_TURNS = 40
/* a sweep hands a card down its pipeline in place; the cap is a backstop
   against a card that somehow keeps requeueing itself */
const MAX_SWEEP_RUNS = 24
const LARGE_HTML_CHARS = 60_000
const MAX_REWRITE_CHUNK_CHARS = 12_000
const MAX_REWRITE_CHARS = 100_000

/* the tools the resident loop below actually registers — the shared feedback
   wording names them, and naming the MCP surface's instead would send the
   model to tools it does not have */
const RESIDENT_FEEDBACK_TOOLS = { locate: 'inspect_frame / get_frame_html', review: 'screenshot_frame' }

/* one run per canvas at a time; feedback arriving mid-run queues a re-run */
const running = new Set<string>()
const queued = new Set<string>()

/* one abort controller per canvas: a human's stop has to reach the model call
   that is streaming right now, not just the next turn */
const cancels = new Map<string, AbortController>()

/** Abort the in-flight run(s) on this canvas. Wired into actions via
 *  actions.wire's third argument. Safe to call with nothing running. */
export function cancelCanvasRuns(canvasId: string) {
  cancels.get(canvasId)?.abort()
}

export function onFeedback(canvasId: string) {
  if (running.has(canvasId)) {
    queued.add(canvasId)
    return
  }
  sweep(canvasId).catch((err) => console.error('[resident] sweep failed', err))
}

/** Work every agent that has something waiting, one at a time. Re-checking the
 *  queue between runs is what carries a card into its next pipeline stage. */
async function sweep(canvasId: string) {
  running.add(canvasId)
  /* Requesters with no usable model right now. A run bills one person, so
     without this a requester who cannot pay would be re-picked forever and
     block everyone queued behind them. */
  const stalled = new Set<string>()
  /* Agents whose whole queue is stalled. Skipped rather than breaking the
     sweep, so one unpayable queue cannot hide another agent's runnable work. */
  const idle = new Set<string>()
  try {
    for (let i = 0; i < MAX_SWEEP_RUNS; i++) {
      const next = actions.pendingWorkAgents(canvasId).find((name) => !idle.has(name))
      if (!next) break
      const outcome = await runAgent(canvasId, next, stalled)
      if (outcome === 'idle') {
        idle.add(next)
        continue
      }
      /* a completed run can hand a card down its pipeline, which may put
         payable work in front of an agent that had nothing a moment ago */
      idle.clear()
    }
  } finally {
    running.delete(canvasId)
    /* the sweep owns the controller's lifetime so this check still sees it: a
       stop must not be undone by the re-sweep it just queued */
    const wasStopped = cancels.get(canvasId)?.signal.aborted ?? false
    cancels.delete(canvasId)
    if (queued.delete(canvasId) && !wasStopped) onFeedback(canvasId)
  }
}

const SYSTEM = `You are a resident design agent of the Doop canvas — a multiplayer design tool where humans and AI agents design HTML frames together. You live in the server and your job is narrow: when work lands on the canvas for you, you do it, promptly and well.

Rules:
- Only make the changes the request asks for, and only the ones your specialty covers. No refactors, no redesigns beyond the request, no new frames unless asked.
- Queued cards are standalone work requests from the board. A card may be routed through several agents in turn — you own your stage of it and nothing else. If your specialty is to originate work: a new-asset card means create_frame sized for the job, a change request means editing the existing frame. One card, one deliverable.
- Later stages inherit whatever earlier stages left. Read the frame as it is now; never undo a previous agent's work because you would have done it differently.
- Resolve frame references against the numbered frame list in the request. A literal frame name wins; otherwise "Frame 1" means the first listed frame, and "the other frame" means the only remaining frame when there are two.
- Choose a size-aware strategy. For documents over 60,000 characters, call inspect_frame before reading HTML. Use get_frame_html with a query or bounded range only when markup is needed.
- For requests to copy, match, or borrow another frame's design: screenshot and inspect BOTH the target and reference before editing. Use the reference screenshot and computed design tokens as the source of visual truth. Read target HTML only when you need to preserve its content; do not load a large reference document just to learn its style. For a full redesign, use begin_frame_rewrite, append_frame_rewrite in chunks under 12,000 characters, and commit_frame_rewrite; then screenshot the changed frame.
- Element comments are pinned to ONE element (you get its CSS selector and an HTML excerpt). Change that element or its immediate context — never rework unrelated parts of the frame because of an element comment.
- Frames are complete HTML documents with inline CSS. Keep each frame's existing style and structure; change what the feedback requires.
- Prefer edit_frame_html (exact find/replace) for small changes; use set_frame_html only when the change is structural.
- After any visual change, call screenshot_frame and LOOK at the result. If it doesn't clearly satisfy the feedback, fix it before finishing.
- Call set_status when you start ("Fixing: …") and when your focus shifts. One line, under 80 chars, present tense. People watch this live.
- Never leave a frame worse than you found it.
- Reference sites: when a request names a site or URL — a redesign of it, or "like acme.com" — call import_webpage with as_reference=true FIRST so an editable HTML snapshot lands on the canvas, then call screenshot_frame on that imported source and design from what is actually there: its real copy, nav labels, product facts, and imagery direction. Leave the imported source unchanged and deliver your work in a separate frame. If importing or editing the snapshot itself is the requested deliverable, use as_reference=false. view_website is read-only; use it only when you need to inspect a live page without adding it to the canvas. A redesign that invents content is wrong even when it looks good. If automated access is blocked and there is no existing source frame or attached screenshot, stop and ask the user to attach screenshots; never approximate the site from guesses.
- Real imagery: when a design calls for photography, use search_images (you see thumbnails — pick the one whose mood and palette fit) and embed its image_url with object-fit: cover and a real alt text. For a hero, section band or bento tile that wants atmosphere or a focal glow, list_backgrounds shows a page of the curated library as thumbnails (filter by tone; judge by eye which one fits the frame's style and palette, paste its css line, put copy in the text_zone); a quiet typographic design may be better on a flat surface, but never settle for a default two-stop gradient, and draw the background yourself when nothing in the library genuinely fits. For UI icons use search_icons and hotlink the SVG URL. For company logos (customer walls, integration rows, press bars, payment methods, testimonial cards) call search_logos once per brand BEFORE writing that section, and use real, recognizable brands — never a gray tile, "LOGO" text, initials or an invented wordmark. Never fake a photo with a gray box or a made-up URL; if search is unavailable, draw the visual as inline SVG/CSS.
- If a request is unclear or impossible (missing frame, contradictory ask), do the closest reasonable thing and say what you did in your final message.
- Your final message should be one or two sentences: what you changed and where.

Design quality — the bar for anything you originate or restyle (canvas guidelines and pinned style references outrank it; a frame you are only editing keeps its established direction):
${DESIGN_QUALITY}

Design brief — when your card asks you to ORIGINATE new design work:
${DESIGN_BRIEF}`

/** The system prompt for one agent: the shared harness rules plus its specialty. */
function systemFor(role: AgentRole): string {
  const reviewer = role.reviewer
    ? '\n\nYou are a review pass. Judge what is already on the canvas against your specialty and fix only what fails it. Changing nothing is a valid outcome — if the frame already meets your bar, say so plainly in your final message instead of inventing work.'
    : ''
  return `${SYSTEM}\n\n---\n\nYour role on this canvas is ${role.name}. ${role.brief}${reviewer}\n\nStay inside that specialty. Anything outside it belongs to another agent on the team (${AGENT_ROLES.filter(
    (r) => r.id !== role.id,
  )
    .map((r) => `${r.name}: ${r.blurb.toLowerCase()}`)
    .join('; ')}) — leave it to them rather than fixing it yourself.`
}

interface FeedbackItem {
  from: string
  text: string
  about: string
}

interface RunState {
  mutatedFrames: Set<string>
  sourceFrames: Set<string>
  verificationFrames: Set<string>
  verifiedFrames: Set<string>
  rewriteDrafts: Map<string, string>
  blockedWebsiteAccess?: string
  /** review_frame output per deliverable frame — the automated quality gate */
  reviewedFrames: Map<string, ReviewReport>
  /** writes filed as proposals instead of landing: on a review-mode canvas
   *  they are the run's deliverable, so they count as a change */
  proposals: number
}

function deliverableFrameIds(runState: RunState): string[] {
  return [...runState.mutatedFrames].filter((id) => !runState.sourceFrames.has(id))
}

/** The first deliverable frame whose automated review is missing, stale, or
 *  failing — with a reason the model can act on.
 *
 *  A report is only evidence about the document it was made from, so a frame
 *  edited after its review counts as unreviewed. Without that check, reviewing
 *  early and editing afterwards passed the gate. */
function failedReview(runState: RunState): { frameId: string; detail: string } | undefined {
  for (const id of deliverableFrameIds(runState)) {
    const report = runState.reviewedFrames.get(id)
    if (!report) return { frameId: id, detail: 'no review_frame report yet' }
    const frame = store.getFrame(id)
    if (frame && !reportIsCurrent(report, frame, store.getCanvas(frame.canvasId)?.tokens))
      return { frameId: id, detail: 'the frame changed after it was reviewed — re-run review_frame' }
    if (report.verdict === 'fail' || report.blocking.length) {
      const worst = report.blocking.slice(0, 4).map((finding) => `${finding.rule} at ${finding.selector}`)
      return {
        frameId: id,
        detail: worst.length
          ? worst.join('; ')
          : `${report.summary.critical} critical a11y, ${report.summary.errors} layout errors`,
      }
    }
  }
  return undefined
}

function verificationFrameIds(runState: RunState): string[] {
  return [...new Set([...runState.mutatedFrames, ...runState.verificationFrames])]
}

function completeHtml(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const html = value.trim()
  if (html.length < 80 || !/<html(?:\s|>)/i.test(html) || !/<\/html>\s*$/i.test(html)) return undefined
  return html
}

const REDESIGN_RE =
  /\b(redesign|re-?style|same style|match (?:the )?(?:style|design)|copy (?:the )?(?:style|design)|design of)\b/i

function strategyFor(text: string, frames: NonNullable<ReturnType<typeof store.getCanvas>>['frames']): string {
  const isRedesign = REDESIGN_RE.test(text)
  const redesignNote = isRedesign
    ? ' For the redesign itself, work audit-first and deliver TWO drafts:' +
      ' (1) Audit the source — inspect_frame on a source frame for its computed palette, type, spacing, radii and shadows (import_webpage first for a live site), plus a screenshot for layout.' +
      ' (2) Persist the audit with set_guidelines as a doc named "redesign-<source>" (e.g. "redesign-pipefile-com"): a "Source baseline" recording the old system (palette hexes, type, spacing/radii, and the section map — each section\'s purpose and one-line message) as a descriptive record of what you are redesigning away from, NOT rules to follow; then two binding directions. "Direction A — closer to home": the brand stays recognizable — logo, name, core brand colors (re-weighted freely, with new neutrals and tints) — while every detail is redesigned: typography, spacing rhythm, radii, shadows, patterns, background treatments, button and component styling, section layout. "Direction B — further out": same product, same real copy and facts, but freer — reinterpret the palette and push the aesthetic somewhere genuinely different; do not invent it from vibes — retrieve category inspiration with search_inspiration (live exemplars with mood, palette and fonts), pick ONE exemplar and follow it, and name it in the redesign doc.' +
      ' (3) Deliver TWO new frames side by side, named "<source> — A (on-brand)" and "<source> — B (departure)", each executing its direction precisely; screenshot both. Both frames together are this card\'s deliverable. In both: keep the source\'s real copy and product facts, restructure sections when it strengthens the page\'s argument, and give details a genuinely new treatment rather than reordering the old elements.' +
      ' Exception: if the request already fixes the scope ("keep it subtle", "same style", "go wild", "rebrand"), deliver ONE draft at that scope instead.' +
      ' If your canvas guidelines already include a redesign doc for this source, skip (1)-(2) and follow its directions.'
    : ''
  const large = frames.filter((frame) => frame.html.length > LARGE_HTML_CHARS)
  if (large.length === 0)
    return 'Standard HTML strategy: inspect visually, read the relevant source, edit, and verify.' + redesignNote

  if (isRedesign && frames.length > 1) {
    return (
      `Large cross-frame redesign strategy (${large.map((frame) => frame.name).join(', ')} exceed ${LARGE_HTML_CHARS} HTML characters): ` +
      'screenshot and inspect the target and reference; use visible content plus computed design tokens; do not read the reference HTML; build replacement HTML atomically with begin_frame_rewrite, append_frame_rewrite chunks, and commit_frame_rewrite; screenshot the changed target.' +
      redesignNote
    )
  }
  return (
    `Large targeted-edit strategy (${large.map((frame) => frame.name).join(', ')} exceed ${LARGE_HTML_CHARS} HTML characters): ` +
    'inspect the relevant frame, use get_frame_html with query or a bounded range, apply the smallest exact edit, and screenshot the changed frame.' +
    redesignNote
  )
}

type RunOutcome = 'ran' | 'idle' | 'no-model'

/**
 * Work one requester's queue for one agent. A run bills exactly one person:
 * the account behind the oldest claimable item, resolved BEFORE anything is
 * claimed so a server with no model at all leaves the queue untouched.
 */
async function runAgent(canvasId: string, agentName: string, stalled: Set<string>): Promise<RunOutcome> {
  const role = roleByAgentName(agentName) ?? roleById(DEFAULT_ROLE_ID)!
  const payer = actions.nextWorkPayer(canvasId, role.name, stalled)
  if (payer === undefined) return 'idle'
  /* Only work that predates per-user attribution falls back to the canvas
     owner — a real requester never bills a collaborator or the owner. */
  const canvasOwner = store.getCanvas(canvasId)?.ownerId
  const model = await pickModel(payer || canvasOwner)
  if (!model) {
    stalled.add(payer)
    return 'no-model'
  }
  /* With no free tier, the server's key never pays for resident work. Work
     can still reach this point without a payable account — queued before the
     account was disconnected, or before metering tightened — and it must
     fail visibly with a fix, not crash on a key that was never meant to pay. */
  if (!model.userId && RESIDENT_TASK_LIMIT <= 0) {
    const reason =
      'The Doop Agent needs a connected account — connect your ChatGPT subscription or OpenAI key in Settings, then retry.'
    for (const f of actions.takeFeedbackFor(canvasId, role.name, payer)) actions.failTaskFeedback(f.id, reason)
    for (const c of actions.takeAgentCommentsFor(canvasId, role.name, payer)) actions.failComment(c.id, reason)
    for (const c of actions.takeQueuedCardsFor(canvasId, role.name, payer)) actions.failCard(canvasId, c.id, reason)
    stalled.add(payer)
    return 'no-model'
  }
  const actor = actions.resolveActor({ name: role.name, kind: 'agent' })

  /* A capped account must not pay for work it cannot finish: refuse the run
     before anything is claimed, so the card stays queued for a human. */
  const accountKey = model.userId ?? payer ?? 'server'
  const capped = runBudget.dailyCapReached(accountKey)
  if (capped) {
    const reason = `Daily budget reached — this account has spent ${capped.spent.toLocaleString()} of ${capped.cap.toLocaleString()} tokens today. Raise DOOP_ACCOUNT_DAILY_TOKENS or retry tomorrow.`
    for (const f of actions.takeFeedbackFor(canvasId, role.name, payer)) actions.failTaskFeedback(f.id, reason)
    for (const c of actions.takeAgentCommentsFor(canvasId, role.name, payer)) actions.failComment(c.id, reason)
    for (const c of actions.takeQueuedCardsFor(canvasId, role.name, payer)) actions.failCard(canvasId, c.id, reason)
    stalled.add(payer)
    return 'no-model'
  }

  /* claim this agent's open work — the UI flips to "picked up" instantly.
     Claiming happens before the try so an agent with nothing to do never
     shows up in presence. */
  const claimed = actions.takeFeedbackFor(canvasId, role.name, payer)
  const comments = actions.takeAgentCommentsFor(canvasId, role.name, payer)
  const allCards = actions.takeQueuedCardsFor(canvasId, role.name, payer)
  if (claimed.length === 0 && comments.length === 0 && allCards.length === 0) {
    /* nothing actually claimable for this payer — do not re-pick them */
    stalled.add(payer)
    return 'no-model'
  }
  /* structured repo cards (the GitHub import) have their own runner with
     repo-reading tools; only prompt cards go through the chat loop below */
  const repoCards = allCards.filter((c) => c.kind)
  const cards = allCards.filter((c) => !c.kind)

  /* Registered before any model work so a human's stop reaches the call that is
     streaming right now. A stop record left over from an earlier session is
     cleared here — it belongs to that session, and honoring it would abandon
     work this run has legitimately claimed. */
  const abort = new AbortController()
  cancels.set(canvasId, abort)
  actions.clearStop(canvasId, role.name)

  /* presence otherwise only refreshes on tool activity, and the sweep's TTL
     is shorter than a big generation turn */
  const heartbeat = setInterval(() => actions.heartbeatAgent(canvasId, actor), 15_000)

  /* what this run has spent, and the ceiling it stops at. The repo runner
     drives the model itself, so its tokens are counted beside the loop's:
     recon and sketch work bills the same account and counts against the same
     budget. */
  let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const repoUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const spentTokens = () => runBudget.tokensUsed(usage) + runBudget.tokensUsed(repoUsage)
  const runBudgetTokens = runBudget.runTokenBudget()
  let budgetReached = false

  if (repoCards.length > 0) {
    const counted: AgentModel = {
      ...model,
      run: async (request) => {
        const result = await model.run(request)
        repoUsage.input += result.usage.input
        repoUsage.output += result.usage.output
        repoUsage.cacheRead += result.usage.cacheRead
        repoUsage.cacheWrite += result.usage.cacheWrite
        return result
      },
    }
    if (!abort.signal.aborted) {
      try {
        await runRepoCards(canvasId, repoCards, counted, actor, abort.signal)
      } catch (err) {
        /* the runner fails cards one by one; this is the backstop for a
           failure outside any card, so none stays claimed forever */
        console.error('[resident] repo cards errored', err)
        for (const c of repoCards)
          actions.failCard(canvasId, c.id, 'Doop hit a snag before finishing. Retry when you are ready.')
      }
    }
    /* the run ends here on this path, so its spend is recorded here too */
    runBudget.recordSpend(accountKey, spentTokens())
    budgetReached = spentTokens() >= runBudgetTokens
    if (abort.signal.aborted) {
      /* the human stopped: release whatever the runner left claimed. Cards the
         stop already marked are skipped, so their attribution survives. */
      actions.endAgentTasks(canvasId, actor.name)
      actions.setAgentStatus(canvasId, actor, 'Stopped')
      clearInterval(heartbeat)
      return 'ran'
    }
    if (claimed.length === 0 && comments.length === 0 && cards.length === 0) {
      clearInterval(heartbeat)
      actions.setAgentStatus(canvasId, actor, budgetReached ? 'Budget reached — continuing needs a human' : '')
      return 'ran'
    }
  }

  try {
    const tasks = actions.getTasks(canvasId)
    const items: FeedbackItem[] = claimed.map((f) => ({
      from: f.from,
      text: f.text,
      about: tasks.find((t) => t.id === f.taskId)?.status ?? 'a task on this canvas',
    }))

    actions.setAgentStatus(
      canvasId,
      actor,
      items.length + comments.length > 0 ? 'Reading feedback…' : 'Picking up a card…',
    )

    const canvas = store.getCanvas(canvasId)
    /* demo frames (the Doop welcome show, seeded examples) are product
       content, not user work — hidden so agents never mistake them for
       the canvas's established style */
    const visibleFrames = (canvas?.frames ?? []).filter((f) => !f.demo)
    const frameList = visibleFrames
      .map(
        (f, index) =>
          `- Frame ${index + 1}: id=${f.id}, name="${f.name}", ${Math.round(f.width)}x${Math.round(f.height)} (last edit: ${f.updatedBy}, ${f.html.length} bytes${f.html.length > LARGE_HTML_CHARS ? '; large document — avoid a full read for visual-reference work' : ''})`,
      )
      .join('\n')

    const sections: string[] = []
    /* design-synced canvases: real navigation between the synced screens is
       redesign-critical context — heavy paths must stay prominent */
    const flowLines = canvas ? ingest.describeSyncFlow(await ingest.getSyncFlow(canvas), visibleFrames) : []
    if (flowLines.length > 0) {
      sections.push(
        `How this app's screens connect (from live design sync — navigation counts are real users):\n` +
          flowLines.map((line) => `- ${line}`).join('\n') +
          `\nRespect this when redesigning: do not bury or weaken elements that carry heavy navigation.`,
      )
    }
    if (items.length > 0) {
      sections.push(
        `New human feedback on this canvas:\n` +
          items.map((i) => `- ${i.from} (about the work "${i.about}"): "${i.text}"`).join('\n'),
      )
    }
    if (cards.length > 0) {
      sections.push(
        `Queued cards — work requests humans left on the board for you:\n` +
          cards
            .map((c) => {
              const pipeline = actions.pipelineOf(c)
              const stage = Math.min(c.stage ?? 0, pipeline.length - 1)
              const route =
                pipeline.length > 1
                  ? ` [stage ${stage + 1} of ${pipeline.length}: ${pipeline.map(roleName).join(' → ')}` +
                    (stage > 0 ? `; earlier stages have already run — build on what they left]` : `]`)
                  : ''
              const attached = (c.attachments ?? [])
                .map((id) => {
                  const f = store.getFrame(id)
                  return f ? `${f.id} ("${f.name}")` : null
                })
                .filter(Boolean)
              const refs =
                attached.length > 0
                  ? `\n  Attached reference images, already on the canvas as frames: ${attached.join(', ')}. ` +
                    `Call screenshot_frame on each BEFORE designing and build from what you see. ` +
                    `They are source material — leave them as they are and deliver in a separate frame.`
                  : ''
              const targets = (c.targetFrameIds ?? [])
                .map((id) => {
                  const f = store.getFrame(id)
                  return f ? `${f.id} ("${f.name}")` : null
                })
                .filter(Boolean)
              const subject =
                targets.length > 0
                  ? `\n  THIS CARD IS ABOUT: ${targets.join(', ')} — change that frame in place (rename/move/resize with update_frame, or edit its HTML). Do NOT deliver this one as a new frame elsewhere.`
                  : ''
              return `- from ${c.queuedBy}: "${c.status}"${route}${refs}${subject}`
            })
            .join('\n'),
      )
    }
    if (comments.length > 0) {
      sections.push(
        `New element comments addressed to you (each is pinned to a specific element):\n` +
          comments
            .map((c) => {
              const fname = store.getFrame(c.frameId)?.name ?? 'unknown frame'
              /* a reply carries the conversation it answers, so "make it
                 bigger" reads against what was said before */
              const history = actions.commentThread(c)
              const earlier = history
                .slice(
                  0,
                  history.findIndex((x) => x.id === c.id),
                )
                .map((x) => `    ${x.from}: "${x.text}"`)
                .join('\n')
              const thread = earlier ? `\n  earlier in this thread:\n${earlier}` : ''
              return `- ${c.from} on frame ${c.frameId} "${fname}", element ${c.selector}\n  element HTML at comment time: ${c.snippet}${thread}\n  comment: "${c.text}"`
            })
            .join('\n'),
      )
    }
    const workText = [
      ...items.map((item) => item.text),
      ...cards.map((card) => card.status),
      ...comments.map((comment) => comment.text),
    ].join('\n')
    const urls = referencedUrls(workText)
    const references = store.getReferences(canvasId)
    const referenceList =
      references.length > 0
        ? `\n\nPinned style references — designs humans marked "more like this"; they are the ground truth for this canvas's look:\n` +
          references
            .map(
              (r) =>
                `- ${r.id}: "${r.title}" (${Math.round(r.width)}x${Math.round(r.height)}, pinned by ${r.pinnedBy})`,
            )
            .join('\n') +
          `\nBefore designing or restyling anything, call get_reference on the most relevant one and match its palette, typography and spacing.`
        : ''
    const journals = actions.getRunJournals(canvasId, role.name, 3)
    const journalBlock = journals.length
      ? `\n\n# What you did before on this canvas\n` +
        journals.map((j) => `- ${new Date(j.at).toISOString().slice(0, 16)}: ${j.summary}`).join('\n')
      : ''
    const kickoff =
      sections.join('\n\n') +
      journalBlock +
      `\n\nFrames currently on the canvas:\n${frameList}` +
      referenceList +
      `\n\nExecution strategy selected by the harness:\n${strategyFor(workText, visibleFrames)}` +
      (urls.length > 0
        ? `\n\nThe request references ${urls.join(', ')} — if each page is source material for a separate design, call import_webpage with as_reference=true BEFORE designing so an editable HTML snapshot lands on the canvas for everyone to compare against. Then call screenshot_frame on each imported source, leave those source frames unchanged, and build from their real content and structure. If the imported snapshot itself is the requested deliverable, call it with as_reference=false instead. view_website is read-only and does not add anything to the canvas.`
        : '') +
      `\n\nAddress everything above now.` +
      (comments.length > 0
        ? ` For element comments, use the selector and HTML excerpt to find the exact element in the frame's HTML — the live document may have drifted since the comment was left, so match on content, not position.`
        : '')

    const runId = nanoid(8)
    console.log(
      `[resident] run start canvas=${canvasId} agent=${role.name} model=${model.label}${model.userId ? ` on=${model.userId}` : ''} feedback=${claimed.length} comments=${comments.length} cards=${cards.length}`,
    )
    /* a review pass legitimately ends without touching a frame; an
       originating pass that changed nothing has not delivered its card */
    const requireMutation = cards.length > 0 && !role.reviewer
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: kickoff }]
    const runState: RunState = {
      mutatedFrames: new Set(),
      sourceFrames: new Set(),
      verificationFrames: new Set(),
      verifiedFrames: new Set(),
      reviewedFrames: new Map(),
      rewriteDrafts: new Map(),
      proposals: 0,
    }
    let refused = false
    let crashed = false
    let cancelled = false
    let staleAccount = false
    let finished = false
    let mutationNudgeSent = false
    let verificationNudgeSent = false
    let outputLimitNudgeSent = false
    let reviewNudgeSent = false
    let turnsUsed = 0
    /* feedback that arrived while this run was already working: picked up
       between turns and completed (or failed) with the rest at the end */
    const pickedUp: TaskFeedback[] = []

    try {
      /* canvas design docs ride as a second system block with their own cache
         breakpoint: the role prefix stays cacheable across canvases, and the
         (rarely-changing) docs cache across the turns of a run */
      const guidelineDocs = store.getGuidelines(canvasId)
      const guidelinesBlock = guidelineDocs.length
        ? [
            {
              text:
                `# Canvas design guidelines\nEvery frame on this canvas must follow these docs — they outrank your own aesthetic preferences:\n\n` +
                guidelineDocs.map((d) => `## ${d.name}\n\n${d.markdown}`).join('\n\n'),
              cache: true,
            },
          ]
        : []
      const maxTurns = REDESIGN_RE.test(workText) ? MAX_REDESIGN_TURNS : MAX_TURNS
      for (let turn = 0; turn < maxTurns; turn++) {
        /* the human stopped this run: unwind before spending another turn */
        if (abort.signal.aborted) {
          cancelled = true
          break
        }
        /* A human asking for something now must reach the run that is working
           now — waiting for the next sweep would mean the agent finishes a
           design the human has already asked it to change. Their request rides
           with the message the loop is about to send, so roles stay
           alternating and no extra turn is spent picking it up. */
        /* a run that has spent its budget stops here, between turns, with a
           reason a human can act on — never mid-tool, never silently */
        if (spentTokens() >= runBudgetTokens) {
          budgetReached = true
          actions.setAgentStatus(canvasId, actor, 'Budget reached — continuing needs a human')
          break
        }
        const midRun = actions.takeFeedbackFor(canvasId, role.name, payer)
        if (midRun.length > 0) {
          pickedUp.push(...midRun)
          const running = actions.getTasks(canvasId)
          injectFeedback(
            messages,
            feedbackBlock(
              midRun.map((f) => {
                const task = running.find((t) => t.id === f.taskId)
                return {
                  from: f.from,
                  text: f.text,
                  about: feedbackAbout({
                    ...(task?.status ? { taskStatus: task.status } : {}),
                    mine: task?.agentName === actor.name,
                    ...(task?.agentName ? { agentName: task.agentName } : {}),
                  }),
                }
              }),
              RESIDENT_FEEDBACK_TOOLS,
            ),
          )
          actions.setAgentStatus(canvasId, actor, 'Picking up human feedback')
        }
        const res = await model.run({
          maxTokens: 16000,
          system: [{ text: systemFor(role), cache: true }, ...guidelinesBlock],
          tools: TOOLS,
          messages,
          signal: abort.signal,
        })

        /* the stop can land mid-stream: the aborted request rejects, but a
           provider that resolves anyway must not cost another turn */
        if (abort.signal.aborted) {
          cancelled = true
          break
        }

        if (res.stop_reason === 'refusal') {
          actions.setAgentStatus(canvasId, actor, "Couldn't address that feedback")
          refused = true
          break
        }

        messages.push({ role: 'assistant', content: res.content })
        turnsUsed = turn + 1
        usage = {
          input: usage.input + res.usage.input,
          output: usage.output + res.usage.output,
          cacheRead: usage.cacheRead + res.usage.cacheRead,
          cacheWrite: usage.cacheWrite + res.usage.cacheWrite,
        }
        runLog.record({
          canvasId,
          runId,
          agentName: actor.name,
          kind: 'turn',
          summary: `turn ${turnsUsed}: ${res.usage.output} output tokens`,
        })
        const toolBlocks = res.content.filter(
          (block): block is Anthropic.ToolUseBlockParam => block.type === 'tool_use',
        )
        console.log(
          `[resident] response canvas=${canvasId} turn=${turnsUsed} stop=${res.stop_reason} tools=${toolBlocks.map((block) => block.name).join(',') || 'none'}`,
        )

        /* A response can contain a complete tool_use block even when its stop
         reason is max_tokens. The Messages protocol still requires an
         immediate tool_result for every emitted tool id, so content blocks —
         not stop_reason — are authoritative for tool execution. */
        if (toolBlocks.length > 0) {
          /* Models may emit an import and design mutations in one parallel
             batch. Run imports first and defer every other call to the next
             turn, when the model can inspect the imported source. If access is
             blocked, skip the whole remainder. Results retain protocol order. */
          const importInBatch = toolBlocks.some((block) => block.name === 'import_webpage')
          let importFailureInBatch: string | undefined
          const results = await executeGuardedBatch<Anthropic.ToolUseBlockParam, Anthropic.ToolResultBlockParam>(
            toolBlocks,
            {
              priority: (block) => (block.name === 'import_webpage' ? 1 : 0),
              stopped: () => abort.signal.aborted,
              blocked: (block) =>
                runState.blockedWebsiteAccess ??
                importFailureInBatch ??
                (importInBatch && block.name !== 'import_webpage'
                  ? 'The website import must be inspected before any design changes. Continue on the next turn by calling screenshot_frame on the imported source.'
                  : undefined),
              skipped: (block, reason) => ({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Skipped ${block.name}. ${reason}`,
                is_error: true,
              }),
              execute: async (block) => {
                const target = (block.input as Record<string, unknown>).frame_id
                console.log(
                  `[resident] tool canvas=${canvasId} name=${block.name}${typeof target === 'string' ? ` frame=${target}` : ''}`,
                )
                const startedAt = Date.now()
                const result = await execTool(block, canvasId, actor, runState)
                /* the Run tab's tool timeline: name, duration, outcome and a
                   one-line summary the human can expand */
                const resultText = Array.isArray(result.content)
                  ? result.content
                      .map((c) => (typeof c === 'string' ? c : c.type === 'text' ? c.text : ''))
                      .join(' ')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .slice(0, 200)
                  : ''
                runLog.record({
                  canvasId,
                  runId,
                  agentName: actor.name,
                  kind: 'tool',
                  name: block.name,
                  ok: !result.is_error,
                  ms: Date.now() - startedAt,
                  summary: resultText,
                })
                if (block.name === 'import_webpage' && result.is_error && !runState.blockedWebsiteAccess) {
                  importFailureInBatch =
                    'The website import failed. Correct the tool error and retry the import before making design changes.'
                }
                return result
              },
            },
          )
          /* a cancel mid-batch must not feed results back and burn a turn */
          if (abort.signal.aborted) {
            cancelled = true
            break
          }
          messages.push({ role: 'user', content: results })
          continue
        }

        if (runState.blockedWebsiteAccess) {
          finished = true
          break
        }

        if (res.stop_reason === 'max_tokens' && !outputLimitNudgeSent) {
          outputLimitNudgeSent = true
          messages.push({
            role: 'user',
            content:
              'Your response reached the output limit before producing an executable edit. Continue with bounded tool calls: begin_frame_rewrite, append_frame_rewrite with each chunk under 12,000 characters, then commit_frame_rewrite and screenshot_frame.',
          })
          continue
        }

        if (
          requireMutation &&
          deliverableFrameIds(runState).length === 0 &&
          runState.proposals === 0 &&
          !mutationNudgeSent
        ) {
          mutationNudgeSent = true
          messages.push({
            role: 'user',
            content:
              'You have not changed or created a deliverable frame yet, so the queued design card is not complete. Imported source frames are reference material and do not count as the deliverable. Make the requested visual change now. For a full redesign, use begin_frame_rewrite, append_frame_rewrite chunks under 12,000 characters, and commit_frame_rewrite, then verify it with screenshot_frame.',
          })
          continue
        }
        const unverified = verificationFrameIds(runState).filter((id) => !runState.verifiedFrames.has(id))
        if (cards.length > 0 && unverified.length > 0 && !verificationNudgeSent) {
          verificationNudgeSent = true
          messages.push({
            role: 'user',
            content: `You have not visually verified ${unverified.join(', ')}. Call screenshot_frame for each frame, inspect the render, and fix any problems before finishing.`,
          })
          continue
        }
        /* the automated design gate: a deliverable must pass review_frame —
           zero critical a11y issues, zero layout errors, zero off-token
           colors. Screenshotting alone trusts the agent's own eye. */
        const failing = failedReview(runState)
        if (deliverableFrameIds(runState).length > 0 && failing && !reviewNudgeSent) {
          reviewNudgeSent = true
          messages.push({
            role: 'user',
            content: `Your design failed the automated checks (${failing.detail}). Call review_frame for ${failing.frameId}, fix the failing selectors, and re-run it until the report is clean.`,
          })
          continue
        }
        finished = true
        break
      }
    } catch (err) {
      /* a stop surfaces as a transport error from the aborted request — the
         human's decision is not a snag, so it gets no failure copy. The flag
         only covers checkpoint unwinds: the throw can come straight out of
         model.run mid-stream, so the signal itself must count too. */
      if (cancelled || abort.signal.aborted) {
        actions.setAgentStatus(canvasId, actor, 'Stopped')
      } else {
        /* An API/tool crash becomes a visible, manually retryable failure. */
        crashed = true
        /* a dead credential is the one crash a human can actually fix, so it
           gets its own wording all the way through to the card — but only when
           the credential is theirs: a server-tier run has no account to
           reconnect, whatever error class its transport leaks */
        staleAccount = err instanceof ModelAuthError && !!model.userId
        console.error('[resident] run errored', err)
        actions.setAgentStatus(
          canvasId,
          actor,
          staleAccount ? 'Your model connection expired — reconnect it' : 'Hit a snag — waiting for a retry',
        )
      }
    }

    /* only a NATURALLY finished run completes its work — refused, crashed,
       or out-of-turns runs pause so nothing gets a false Done or auto-retry */
    const deliverableFrames = deliverableFrameIds(runState)
    const blockedWebsiteAccess = runState.blockedWebsiteAccess
    const noMutation =
      finished && requireMutation && deliverableFrames.length === 0 && runState.proposals === 0 && !blockedWebsiteAccess
    /* The gate applies to every run that changed a deliverable frame, not
       only to card runs: an @mention or a hand-back produces a design too, and
       it is held to the same standard as a claimed card. */
    const gated = deliverableFrameIds(runState).length > 0
    const unverifiedMutation =
      finished &&
      !blockedWebsiteAccess &&
      gated &&
      verificationFrameIds(runState).some((id) => !runState.verifiedFrames.has(id))
    const failedGate = finished && !blockedWebsiteAccess && gated && !!failedReview(runState)
    /* a run stopped on its token budget stopped on purpose: it is not out of
       turns, and its own status must survive */
    const exhausted = !finished && !refused && !crashed && !cancelled && !budgetReached
    if (exhausted) actions.setAgentStatus(canvasId, actor, 'Ran out of turns — waiting for a retry')
    if (blockedWebsiteAccess && !staleAccount) {
      actions.setAgentStatus(canvasId, actor, 'Website blocked — needs screenshots')
    }
    if (noMutation) actions.setAgentStatus(canvasId, actor, 'No frame changed — waiting for a retry')
    if (unverifiedMutation) actions.setAgentStatus(canvasId, actor, 'Change not verified — waiting for a retry')
    if (failedGate) actions.setAgentStatus(canvasId, actor, 'Design checks failed — waiting for a retry')
    console.log(
      `[resident] run end canvas=${canvasId} agent=${role.name} turns=${turnsUsed} finished=${finished} refused=${refused} crashed=${crashed} mutations=${runState.mutatedFrames.size} sources=${runState.sourceFrames.size} deliverables=${deliverableFrames.length} proposals=${runState.proposals} verified=${runState.verifiedFrames.size}`,
    )
    if (finished) {
      /* The closing summary remains useful when a no-op card is returned to
         the queue: it tells the human why no deliverable was accepted. */
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        const text = last.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
        console.log(`[resident] summary canvas=${canvasId} ${text.replace(/\s+/g, ' ').trim().slice(0, 500)}`)
        actions.agentSummary(canvasId, actor, text)
      }
    }
    /* what the run cost, on every card it served, and against the account's
       day — a run that stops on its budget is still accounted for */
    runBudget.recordSpend(accountKey, spentTokens())
    if (usage.input > 0 || usage.output > 0) {
      actions.recordRunUsage(
        cards.map((c) => c.id),
        { ...usage, model: model.label },
      )
    }
    /* cross-run memory: the next run of this role starts knowing what this
       one did — the summary plus which frames it touched */
    const runSummaryText = (() => {
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        return last.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 800)
      }
      return ''
    })()
    actions.recordRunJournal({
      canvasId,
      agentName: actor.name,
      cardId: cards[0]?.id,
      summary: runSummaryText || `${role.name} run ended without a summary`,
      decisions: JSON.stringify({
        frames: [...runState.mutatedFrames],
        guidelines: store.getGuidelines(canvasId).map((d) => d.name),
      }),
    })
    if (finished && !blockedWebsiteAccess && !noMutation && !unverifiedMutation && !failedGate) {
      for (const f of [...claimed, ...pickedUp]) actions.completeTaskFeedback(f.id)
      for (const c of comments) actions.resolveComment(c.id, actor)
      /* a card moves to the next agent in its pipeline, or finishes here */
      for (const c of cards) {
        const last = messages[messages.length - 1]
        const summary =
          last?.role === 'assistant' && Array.isArray(last.content)
            ? last.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 1000)
            : undefined
        actions.advanceCard(canvasId, c.id, actor, summary)
      }
    } else {
      let reason: string
      if (cancelled) {
        reason = 'Stopped by a human. Retry when you are ready.'
      } else if (staleAccount) {
        reason = `${model.label} turned down the connected account. Reconnect it in Doop, then retry.${blockedWebsiteAccess ? ` ${blockedWebsiteAccess}` : ''}`
      } else if (blockedWebsiteAccess) {
        reason = blockedWebsiteAccess
      } else if (refused) {
        reason = `${role.name} could not take this request. Retry when you are ready.`
      } else if (crashed) {
        reason = `${role.name} hit a snag before finishing. Retry when you are ready.`
      } else if (budgetReached) {
        reason = `${role.name} reached this run's token budget (${runBudgetTokens.toLocaleString()}) before finishing. Retry to give it another budget, or raise DOOP_RUN_TOKEN_BUDGET.`
      } else if (exhausted) {
        reason = `${role.name} ran out of turns before finishing. Retry when you are ready.`
      } else if (noMutation) {
        reason = `${role.name} finished without changing a frame. Retry when you are ready.`
      } else if (failedGate) {
        const failing = failedReview(runState)
        reason = `Design checks failed: ${failing?.detail ?? 'review incomplete'}. Retry when you are ready.`
      } else {
        reason = `${role.name} changed a frame but could not verify it. Retry when you are ready.`
      }
      for (const f of [...claimed, ...pickedUp]) actions.failTaskFeedback(f.id, reason)
      for (const c of comments) actions.failComment(c.id, reason)
      for (const c of cards) actions.failCard(canvasId, c.id, reason)
    }
  } finally {
    clearInterval(heartbeat)
    /* a finished run holds nothing: its frames are free for the next agent,
       and the room is told so the "held by" chip does not outlive the run */
    actions.releaseLocksForAgent(canvasId, actor.name)
    /* clear the status — this completes the agent's task in the panel */
    actions.setAgentStatus(canvasId, actor, '')
  }
  return 'ran'
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'set_status',
    description:
      'Broadcast a one-line "what I am doing right now" to everyone watching the canvas. Call it when you start and whenever your focus shifts.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', description: 'Present tense, under 80 chars' } },
      required: ['status'],
    },
  },
  {
    name: 'create_frame',
    description:
      'Add a new frame to the canvas — use this when a queued card asks for a new design rather than a change to an existing frame. Streams in live for viewers.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        width: { type: 'number', description: 'px, e.g. 1200' },
        height: { type: 'number', description: 'px, e.g. 630' },
        html: { type: 'string', description: 'Complete HTML document with inline CSS' },
      },
      required: ['name', 'width', 'height', 'html'],
    },
  },
  {
    name: 'update_frame',
    description:
      "Change a frame's metadata without touching its design: rename it, or move/resize it on the canvas (x, y, width, height in canvas pixels). Use this when the card is about placement, naming or size — for a design change use edit_frame_html / set_frame_html instead.",
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['frame_id'],
    },
  },
  {
    name: 'inspect_frame',
    description:
      'Inspect the rendered page without relying on class names. Returns a compact semantic element outline, visible text, geometry, computed colors, typography, radii, shadows, and CSS variables. Use this before working with large frames and for cross-frame visual references.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'get_frame_html',
    description:
      "Read a bounded portion of a frame's source HTML before a targeted edit. Use query to retrieve small snippets around matching text, or offset/limit to page through source. For full visual redesigns, prefer inspect_frame plus screenshots and replace the target with compact standalone HTML.",
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        query: {
          type: 'string',
          description: 'Optional literal text to find in the HTML; returns bounded context around up to five matches',
        },
        offset: { type: 'number', description: 'Character offset for a bounded source read; defaults to 0' },
        limit: { type: 'number', description: 'Characters to return; defaults to 20000 and is capped at 30000' },
      },
      required: ['frame_id'],
    },
  },
  {
    name: 'edit_frame_html',
    description:
      'Exact find/replace in a frame\'s HTML — the change morphs into the live render. Use for small, targeted changes. "find" must occur exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
      },
      required: ['frame_id', 'find', 'replace'],
    },
  },
  {
    name: 'set_frame_html',
    description:
      'Replace a frame with a complete compact HTML document in one call. Use only when the entire html argument is under 12,000 characters; use the staged rewrite tools for larger documents.',
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        html: { type: 'string', description: 'Complete HTML document with inline CSS' },
      },
      required: ['frame_id', 'html'],
    },
  },
  {
    name: 'begin_frame_rewrite',
    description:
      'Start an atomic full-frame rewrite. This creates an empty server-side draft and does not change the live frame. Follow with one or more append_frame_rewrite calls, then commit_frame_rewrite.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'append_frame_rewrite',
    description:
      'Append one bounded chunk to an atomic frame rewrite draft. Keep each chunk under 12,000 characters. The live frame is unchanged until commit_frame_rewrite succeeds.',
    input_schema: {
      type: 'object',
      properties: {
        frame_id: { type: 'string' },
        chunk: { type: 'string', description: 'The next exact HTML chunk, under 12,000 characters' },
      },
      required: ['frame_id', 'chunk'],
    },
  },
  {
    name: 'commit_frame_rewrite',
    description:
      'Validate and atomically apply the accumulated rewrite draft to the live frame. Fails without changing the frame if the draft is empty or not a complete HTML document.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'search_images',
    description:
      'Search free stock photography and get candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame. Use concrete, scene-level queries ("team collaborating loft office", not "business"). Embed the chosen image_url directly in frame HTML with object-fit: cover and a real alt text.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Scene-level description of the photo you want' },
        orientation: {
          type: 'string',
          enum: ['landscape', 'portrait', 'square'],
          description: 'Match the slot the photo will fill',
        },
        count: { type: 'number', description: 'Candidates to return, 1-8, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_backgrounds',
    description:
      "Browse a curated library of premium backgrounds for hero sections, section bands and bento tiles (glows, grainy meshes, aurora, neon, painterly scenes) as a page of thumbnails, each with palette hexes and a ready-to-paste CSS line that includes a legibility scrim. Reach for it when a hero or full-bleed section wants atmosphere, depth or a focal glow; a quiet typographic design can stay flat, but a default two-stop gradient is rarely right. Filter by tone (light/dark — match your copy color), slot and style; an optional query only reorders. Then decide like a designer: does one genuinely fit the frame's style and palette? If yes use it and put copy in its text_zone; if not, call again with a different filter or draw the background yourself.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Mood / palette words to put first — reorders, never filters' },
        tone: {
          type: 'string',
          enum: [...backgrounds.BACKGROUND_TONES],
          description: 'light = dark copy on it, dark = light copy on it',
        },
        style: { type: 'string', enum: [...backgrounds.BACKGROUND_STYLES], description: 'Restrict to one look' },
        slot: {
          type: 'string',
          enum: [...backgrounds.BACKGROUND_SLOTS],
          description: 'hero, section band, or card/bento tile',
        },
        count: { type: 'number', description: 'Thumbnails to return, 1-24, default 12' },
      },
      required: [],
    },
  },
  {
    name: 'search_icons',
    description:
      'Search 200,000+ open-source UI icons, returned as hotlinkable SVG URLs. Search the concept ("shopping cart", "arrow right"). Results are semantically named ids — pick by name. For company logos use search_logos instead.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Icon concept, e.g. "shopping cart"' },
        limit: { type: 'number', description: 'Max results, default 24' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_logos',
    description:
      'Find a company\'s logo by brand name or domain — returns the company\'s real mark as a hotlinkable URL (thumbnail included when possible), plus open-source vector marks for well-known brands. The exact domain ("acme.io") resolves far more reliably than a name. Use for customer-logo walls, integration rows, testimonial cards, press bars. Favicon-sourced logos are small rasters — display at 32px or less, never scale up.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name or domain' },
        count: { type: 'number', description: 'Candidates to return, 1-8, default 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'view_website',
    description:
      'Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas. Use import_webpage instead when the page needs to land on the canvas as an editable HTML snapshot.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page URL — a bare domain like "acme.io" is loaded over https' },
      },
      required: ['url'],
    },
  },
  {
    name: 'import_webpage',
    description:
      'Import one public web page onto the current canvas as an editable HTML snapshot. Scripts and iframes are removed and stylesheets are inlined. Set as_reference=true when it is source material for a separate design; matching reference snapshots are reused across pipeline stages. Set false when importing or editing the snapshot itself is the deliverable; this creates a fresh deliverable copy. Call screenshot_frame on the returned frame.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page URL — a bare domain like "acme.io" is loaded over https' },
        as_reference: {
          type: 'boolean',
          description:
            'True for source material that must remain unchanged; false when the imported snapshot itself is the deliverable',
        },
      },
      required: ['url', 'as_reference'],
    },
  },
  {
    name: 'get_reference',
    description:
      'Read a pinned style reference — a design a human marked "more like this" — as a rendered screenshot plus its HTML. References are listed in your request when the canvas has them. Match the reference\'s palette, typography and spacing in what you design.',
    input_schema: {
      type: 'object',
      properties: {
        reference_id: { type: 'string', description: 'Reference id from the pinned-references list in your request' },
      },
      required: ['reference_id'],
    },
  },
  {
    name: 'search_inspiration',
    description:
      'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails with pre-distilled style facts (one-line mood north star, named palette, fonts). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages: query the page archetype plus the register you want ("law firm landing page, editorial", "dark fintech dashboard"), not just the product noun. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Page archetype + register, e.g. "grocery delivery landing page, warm", "dark fintech dashboard"',
        },
        count: { type: 'number', description: 'Exemplars to return, default 4, max 6' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_decision',
    description:
      'Persist a design decision to the canvas Memory so humans and later agents see what was committed to — this is how you post your design brief (mood, the one exemplar followed, palette roles, type). Keep it under 500 chars. Design taste only, never one-off content edits.',
    input_schema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          description:
            'The decision, e.g. "Brief: candlelit mood via oatside-soft-shelf — cream ground, caramel accent, Fraunces/Nunito Sans"',
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'set_guidelines',
    description:
      "Create, replace or delete a named style guide on this canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font families, spacing/radius/shadow conventions, layout recipes, do/don't lists. Also how you persist a redesign audit (binding Direction + descriptive source baseline) so every later job inherits it.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Doc slug, e.g. "redesign-pipefile-com" (a-z, 0-9, hyphens)' },
        markdown: { type: 'string', description: 'Full replacement markdown for this doc; empty string deletes it' },
        title: {
          type: 'string',
          description:
            'Pretty display name shown to humans, e.g. "Pipefile design system"; omit to keep the current one',
        },
      },
      required: ['name', 'markdown'],
    },
  },
  {
    name: 'screenshot_frame',
    description:
      'Render a frame and SEE it as an image. Call this after every visual change to verify the feedback is actually addressed.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'review_frame',
    description:
      'Run the automated design quality gate on a frame: token lint, accessibility audit and layout analysis (overflow, clipping, overlap, truncation) at mobile/tablet/desktop in one call. REQUIRED after finishing a frame: the run cannot complete while a deliverable frame has critical a11y issues, layout errors or off-token colors.',
    input_schema: {
      type: 'object',
      properties: { frame_id: { type: 'string' } },
      required: ['frame_id'],
    },
  },
  {
    name: 'set_plan',
    description:
      'Publish your working plan for the current task so the humans (and the rest of the team) can see it. Required for any task with more than two steps. Re-publishing the same steps keeps their progress.',
    input_schema: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 } },
      required: ['steps'],
    },
  },
  {
    name: 'update_plan_step',
    description:
      'Move a step of your published plan: set its status to active, done or blocked, optionally with a one-line note.',
    input_schema: {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked'] },
        note: { type: 'string' },
      },
      required: ['step_id', 'status'],
    },
  },
  {
    name: 'get_plan',
    description: 'Read your currently published plan for this canvas, with each step and its status.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ask_human',
    description:
      'Ask the humans on this canvas a blocking question and WAIT for the answer. Use it when a request is genuinely ambiguous or implies a destructive choice; never for information the canvas already answers. On timeout the question stays open — continue with best judgement and check get_answers later.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 2000 },
        frame_id: { type: 'string' },
        wait_seconds: { type: 'number', minimum: 0, maximum: 120 },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_answers',
    description: 'Check whether humans answered your ask_human questions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'hand_back',
    description:
      'Give the current card back to an agent with the specialty it needs (only roles that are part of the card pipeline can receive it), with a reason. Use it when the work belongs to an earlier or different specialty instead of fixing it outside your lane.',
    input_schema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        to_agent: { type: 'string' },
        reason: { type: 'string', maxLength: 500 },
      },
      required: ['card_id', 'to_agent', 'reason'],
    },
  },
]

/* tall frames (imported landing pages) are CROPPED to the top 4000px at full
   detail rather than downscaled to mush; width still scales down if it would
   breach the API's 8000px image limit */
const MAX_SHOT_HEIGHT = 4000

async function frameImageBlocks(
  f: Frame,
): Promise<NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>>> {
  const cropped = f.height > MAX_SHOT_HEIGHT
  const scale = Math.min(1, 7000 / f.width)
  const big = Math.max(f.width, Math.min(f.height, MAX_SHOT_HEIGHT)) * scale > 2000
  const buf = await renderFrame(f, scale, {
    maxHeight: MAX_SHOT_HEIGHT,
    ...(big ? { type: 'jpeg' as const, quality: 80 } : {}),
  })
  const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: big ? 'image/jpeg' : 'image/png',
        data: buf.toString('base64'),
      },
    },
  ]
  if (cropped) {
    blocks.push({
      type: 'text',
      text: `Note: this frame is ${Math.round(f.height)}px tall — the screenshot shows only the top ${MAX_SHOT_HEIGHT}px.`,
    })
  }
  return blocks
}

async function execTool(
  block: Anthropic.ToolUseBlockParam,
  canvasId: string,
  actor: ReturnType<typeof actions.resolveActor>,
  runState: RunState,
): Promise<Anthropic.ToolResultBlockParam> {
  const input = block.input as { frame_id: string } & Record<string, string>
  const fail = (msg: string): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: msg,
    is_error: true,
  })
  const ok = (content: Anthropic.ToolResultBlockParam['content']): Anthropic.ToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content,
  })
  /* Review mode: the canvas rejects agent writes, so a design change becomes a
     proposal a human accepts — the same contract the MCP surface follows. The
     model is told plainly that nothing landed, so it does not believe the
     design is on the canvas. */
  const reviewDiverted = (op: {
    kind: 'replace_html' | 'create_frame' | 'delete_frame'
    frameId?: string
    name?: string
    html?: string
    x?: number
    y?: number
    width?: number
    height?: number
    summary: string
  }): Anthropic.ToolResultBlockParam | undefined => {
    const proposal = actions.proposeInsteadOfWrite(canvasId, op, actor)
    if (!proposal) return undefined
    runState.proposals += 1
    return fail(
      `review mode — this change is filed as proposal ${proposal.id} (“${proposal.summary}”); a human must accept it before it lands on the canvas. Do NOT retry this write, do not screenshot to check it: finish the rest of the card and end your turn with a summary — the card advances when your turn ends.`,
    )
  }

  try {
    switch (block.name) {
      case 'set_status': {
        actions.setAgentStatus(canvasId, actor, String(input.status ?? ''))
        return ok('ok')
      }
      case 'create_frame': {
        const raw = block.input as { name?: string; width?: number; height?: number; html?: string }
        const html = completeHtml(raw.html)
        if (!html) return fail('create_frame requires a complete non-empty HTML document ending in </html>')
        if (html.length > MAX_REWRITE_CHUNK_CHARS) {
          return fail(`create_frame HTML must be compact (at most ${MAX_REWRITE_CHUNK_CHARS} characters)`)
        }
        const name = String(raw.name || 'Frame')
        const diverted = reviewDiverted({
          kind: 'create_frame',
          name,
          html,
          width: Number(raw.width) || 800,
          height: Number(raw.height) || 500,
          summary: `create “${name}”`,
        })
        if (diverted) return diverted
        const f = actions.createFrame(
          canvasId,
          {
            name,
            width: Number(raw.width) || 800,
            height: Number(raw.height) || 500,
            html,
          },
          actor,
        )
        if (!f) return fail('canvas not found')
        runState.mutatedFrames.add(f.id)
        runState.verifiedFrames.delete(f.id)
        return ok(
          `created frame ${f.id} ("${f.name}", ${Math.round(f.width)}x${Math.round(f.height)}) — it is revealing to viewers now`,
        )
      }
      case 'update_frame': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const raw = block.input as { name?: string; x?: number; y?: number; width?: number; height?: number }
        const patch: { name?: string; x?: number; y?: number; width?: number; height?: number } = {}
        if (typeof raw.name === 'string' && raw.name.trim()) patch.name = raw.name.trim().slice(0, 120)
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          const v = raw[key]
          if (typeof v === 'number' && Number.isFinite(v)) patch[key] = Math.round(v)
        }
        if (Object.keys(patch).length === 0) return fail('provide at least one of: name, x, y, width, height')
        const updated = actions.updateFrame(input.frame_id, patch, actor)
        if (!updated) return fail('could not update the frame')
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok(`updated ${updated.id}: ${JSON.stringify(patch)} — verify with screenshot_frame`)
      }
      case 'inspect_frame': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const inspection = await inspectFrame(f)
        return ok(JSON.stringify(inspection))
      }
      case 'get_frame_html': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        if (typeof f.html !== 'string') return fail('frame HTML is unavailable; retry after the frame reloads')
        const raw = block.input as { query?: string; offset?: number; limit?: number }
        const read = readFrameHtml(f.html, { query: raw.query, offset: raw.offset, limit: raw.limit })
        return 'error' in read ? fail(read.error) : ok(read.text)
      }
      case 'edit_frame_html': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        if (typeof f.html !== 'string') return fail('frame HTML is unavailable; retry after the frame reloads')
        if (typeof input.find !== 'string' || !input.find) return fail('find must be a non-empty exact HTML string')
        if (typeof input.replace !== 'string') return fail('replace must be an HTML string')
        const count = f.html.split(input.find).length - 1
        if (count === 0) return fail('"find" text not found — call get_frame_html and copy the exact text')
        if (count > 1)
          return fail(`"find" text occurs ${count} times — include more surrounding context to make it unique`)
        const nextHtml = f.html.replace(input.find, input.replace)
        const diverted = reviewDiverted({
          kind: 'replace_html',
          frameId: input.frame_id,
          html: nextHtml,
          summary: `edit “${f.name}”`,
        })
        if (diverted) return diverted
        actions.updateFrame(input.frame_id, { html: nextHtml }, actor)
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok('applied')
      }
      case 'set_frame_html': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const html = completeHtml(input.html)
        if (!html) {
          return fail(
            'set_frame_html did not receive a complete HTML document. If output was truncated, use begin_frame_rewrite, append_frame_rewrite chunks, and commit_frame_rewrite.',
          )
        }
        if (html.length > MAX_REWRITE_CHUNK_CHARS) {
          return fail(
            `set_frame_html is limited to ${MAX_REWRITE_CHUNK_CHARS} characters. Use begin_frame_rewrite, append_frame_rewrite chunks, and commit_frame_rewrite.`,
          )
        }
        const diverted = reviewDiverted({
          kind: 'replace_html',
          frameId: input.frame_id,
          html,
          summary: `redesign “${f.name}”`,
        })
        if (diverted) return diverted
        actions.updateFrame(input.frame_id, { html }, actor)
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok('applied — the new design is revealing to viewers now')
      }
      case 'begin_frame_rewrite': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        runState.rewriteDrafts.set(input.frame_id, '')
        return ok(
          `rewrite draft started for ${input.frame_id}; append chunks under ${MAX_REWRITE_CHUNK_CHARS} characters`,
        )
      }
      case 'append_frame_rewrite': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        if (!runState.rewriteDrafts.has(input.frame_id)) return fail('no rewrite draft; call begin_frame_rewrite first')
        const raw = block.input as { chunk?: unknown }
        if (typeof raw.chunk !== 'string' || raw.chunk.length === 0) return fail('chunk must be a non-empty string')
        if (raw.chunk.length > MAX_REWRITE_CHUNK_CHARS) {
          return fail(`chunk is ${raw.chunk.length} characters; maximum is ${MAX_REWRITE_CHUNK_CHARS}`)
        }
        const draft = (runState.rewriteDrafts.get(input.frame_id) ?? '') + raw.chunk
        if (draft.length > MAX_REWRITE_CHARS) {
          return fail(`rewrite draft exceeds the ${MAX_REWRITE_CHARS}-character safety limit`)
        }
        runState.rewriteDrafts.set(input.frame_id, draft)
        return ok(`appended ${raw.chunk.length} characters; draft is now ${draft.length} characters`)
      }
      case 'commit_frame_rewrite': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const draft = runState.rewriteDrafts.get(input.frame_id)
        if (draft === undefined) return fail('no rewrite draft; call begin_frame_rewrite first')
        const html = completeHtml(draft)
        if (!html)
          return fail('rewrite draft is not a complete HTML document ending in </html>; append the missing content')
        const diverted = reviewDiverted({
          kind: 'replace_html',
          frameId: input.frame_id,
          html,
          summary: `rewrite “${f.name}”`,
        })
        if (diverted) {
          runState.rewriteDrafts.delete(input.frame_id)
          return diverted
        }
        actions.updateFrame(input.frame_id, { html }, actor)
        runState.rewriteDrafts.delete(input.frame_id)
        runState.mutatedFrames.add(input.frame_id)
        runState.verifiedFrames.delete(input.frame_id)
        return ok(`committed ${html.length} characters — the new design is revealing to viewers now`)
      }
      case 'search_images': {
        if (!imageSearch.photoSearchEnabled())
          return fail('photo search is not configured on this server — draw the visual as inline SVG/CSS instead')
        const raw = block.input as { query?: string; orientation?: string; count?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const orientation = ['landscape', 'portrait', 'square'].includes(String(raw.orientation))
          ? (raw.orientation as imageSearch.PhotoOrientation)
          : undefined
        const photos = await imageSearch.searchPhotos(query, { orientation, count: Number(raw.count) || undefined })
        if (photos.length === 0) return ok(`no results for "${query}" — try a broader or more visual query`)
        const thumbs = await Promise.all(photos.map((p) => imageSearch.fetchThumb(p.thumb_url)))
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          { type: 'text', text: `${photos.length} photo(s) for "${query}" — thumbnails below, pick by number:` },
        ]
        photos.forEach((p, i) => {
          const thumb = thumbs[i]
          if (thumb)
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: thumb.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: thumb.data,
              },
            })
          blocks.push({
            type: 'text',
            text: `#${i + 1}${p.alt ? ` — ${p.alt}` : ''} (${p.width}×${p.height}, avg ${p.avg_color}, by ${p.photographer})\nimage_url: ${p.image_url}`,
          })
        })
        return ok(blocks)
      }
      case 'list_backgrounds': {
        if (!backgrounds.backgroundsEnabled())
          return fail(
            'the background library is empty on this server — draw the background as layered CSS gradients instead',
          )
        const raw = block.input as { query?: string; tone?: string; style?: string; slot?: string; count?: number }
        const query = String(raw.query || '').trim() || undefined
        const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
          list.includes(v as T) ? (v as T) : undefined
        const listing = backgrounds.browseBackgrounds(
          {
            query,
            tone: pick(backgrounds.BACKGROUND_TONES, raw.tone),
            style: pick(backgrounds.BACKGROUND_STYLES, raw.style),
            slot: pick(backgrounds.BACKGROUND_SLOTS, raw.slot),
            count: Number(raw.count) || undefined,
          },
          PUBLIC_ORIGIN,
        )
        const { results } = listing
        if (results.length === 0)
          return ok('no backgrounds match the tone/style/slot filters you set — drop one and call again')
        const thumbs = await Promise.all(results.map((r) => backgrounds.fetchThumb(r.id)))
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          { type: 'text', text: backgrounds.listHeadline(listing, query) },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb)
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: thumb.data } })
          blocks.push({ type: 'text', text: backgrounds.describeBackground(r, i) })
        })
        blocks.push({ type: 'text', text: backgrounds.BACKGROUND_USAGE_NOTE })
        return ok(blocks)
      }
      case 'search_icons': {
        const raw = block.input as { query?: string; limit?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const icons = await imageSearch.searchIcons(query, { limit: Number(raw.limit) || undefined })
        if (icons.length === 0) return ok(`no results for "${query}" — try a synonym or broader concept`)
        return ok(
          `${icons.length} icon(s):\n${icons.map((icon) => `${icon.id} → ${icon.svg_url}`).join('\n')}\n\n${imageSearch.ICON_USAGE_NOTE}`,
        )
      }
      case 'search_logos': {
        const raw = block.input as { query?: string; count?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const { brands, vector } = await imageSearch.lookupLogos(query, Number(raw.count) || undefined)
        if (brands.length === 0 && vector.length === 0) {
          return ok(
            `no logo found for "${query}" — retry with the company's exact domain (e.g. "acme.io"); if that also fails, search a different real brand instead of drawing a placeholder or guessing a logo URL`,
          )
        }
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          { type: 'text', text: `Logo results for "${query}":` },
        ]
        if (brands.length > 0) {
          const thumbs = await Promise.all(brands.map((b) => imageSearch.fetchThumb(b.thumb_url)))
          brands.forEach((b, i) => {
            const thumb = thumbs[i]
            if (thumb)
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: thumb.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                  data: thumb.data,
                },
              })
            blocks.push({ type: 'text', text: `#${i + 1} — ${b.name} (${b.domain})\nlogo_url: ${b.logo_url}` })
          })
        }
        if (vector.length > 0) {
          blocks.push({
            type: 'text',
            text: `Open-source vector marks:\n${vector.map((v) => `${v.id} → ${v.svg_url}`).join('\n')}`,
          })
        }
        blocks.push({ type: 'text', text: imageSearch.LOGO_USAGE_NOTE })
        return ok(blocks)
      }
      case 'view_website': {
        const raw = block.input as { url?: string }
        const url = String(raw.url || '').trim()
        if (!url) return fail('url must be a non-empty string')
        const site = await viewWebsite(url)
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: site.screenshot.toString('base64') },
          },
          {
            type: 'text',
            text:
              `${site.title || site.finalUrl} — ${site.finalUrl}` +
              (site.description ? `\nMeta description: ${site.description}` : '') +
              (site.shotCropped
                ? `\nNote: the page is ${site.pageHeight}px tall — the screenshot shows only the top portion.`
                : '') +
              `\n\nVisible page text${site.textTruncated ? ' (truncated)' : ''}:\n${site.text}` +
              '\n\nRead-only view — nothing was added to the canvas.',
          },
        ]
        return ok(blocks)
      }
      case 'import_webpage': {
        const raw = block.input as { url?: string; as_reference?: boolean }
        const requestedUrl = String(raw.url || '').trim()
        if (!requestedUrl) return fail('url must be a non-empty string')
        if (typeof raw.as_reference !== 'boolean') {
          return fail(
            'as_reference must be true for source material or false when the import itself is the deliverable',
          )
        }

        const existing = raw.as_reference
          ? findImportedWebpageFrame(store.getCanvas(canvasId)?.frames ?? [], requestedUrl)
          : undefined
        if (existing) {
          runState.sourceFrames.add(existing.id)
          runState.verificationFrames.add(existing.id)
          runState.verifiedFrames.delete(existing.id)
          return ok(
            `Reusing the existing editable source snapshot ${existing.id} ("${existing.name}") for ${requestedUrl}; no duplicate frame was added. Call screenshot_frame with frame_id=${existing.id}. Leave this source frame unchanged and deliver the new design separately.`,
          )
        }

        const { frame: f } = await createImportedWebpageFrame({ canvasId, url: requestedUrl, actor })
        if (!f) return fail('canvas not found')
        runState.mutatedFrames.add(f.id)
        if (raw.as_reference) runState.sourceFrames.add(f.id)
        else runState.sourceFrames.delete(f.id)
        runState.verifiedFrames.delete(f.id)
        return ok(
          `Imported ${requestedUrl} as editable frame ${f.id} ("${f.name}", ${Math.round(f.width)}x${Math.round(f.height)}, ${f.html.length} HTML characters). Call screenshot_frame with frame_id=${f.id}.${
            raw.as_reference
              ? ' Leave this source frame unchanged and deliver the new design separately.'
              : ' This imported frame is the requested deliverable and may be edited directly.'
          }`,
        )
      }
      case 'get_reference': {
        const refs = store.getReferences(canvasId)
        const ref = refs.find((r) => r.id === input.reference_id)
        if (!ref) {
          const ids = refs.map((r) => `${r.id} ("${r.title}")`)
          return fail(
            ids.length
              ? `no reference with id ${input.reference_id} — this canvas has: ${ids.join(', ')}`
              : 'no style references pinned on this canvas',
          )
        }
        const snapshot: Frame = {
          id: `reference-${ref.id}`,
          canvasId,
          name: ref.title,
          x: 0,
          y: 0,
          width: ref.width,
          height: ref.height,
          html: ref.html,
          createdAt: ref.pinnedAt,
          updatedAt: ref.pinnedAt,
          updatedBy: ref.pinnedBy,
        }
        const blocks = await frameImageBlocks(snapshot)
        const truncated = ref.html.length > MAX_HTML_READ_CHARS
        blocks.push({
          type: 'text',
          text:
            `"${ref.title}" (${Math.round(ref.width)}x${Math.round(ref.height)}, pinned by ${ref.pinnedBy}) — match its palette, typography and spacing.\n\n` +
            `HTML${truncated ? ` (first ${MAX_HTML_READ_CHARS} of ${ref.html.length} characters — lift the design tokens from the <style> head and the screenshot)` : ''}:\n${ref.html.slice(0, MAX_HTML_READ_CHARS)}`,
        })
        return ok(blocks)
      }
      case 'search_inspiration': {
        const raw = block.input as { query?: string; count?: number }
        const query = String(raw.query || '').trim()
        if (!query) return fail('query must be a non-empty string')
        const results = await searchInspiration(query, Number(raw.count) || 4)
        if (results.length === 0) return ok(`no inspiration for "${query}" — try a broader category`)
        const thumbs = await Promise.all(results.map((r) => imageSearch.fetchThumb(r.thumb_url)))
        const blocks: NonNullable<Exclude<Anthropic.ToolResultBlockParam['content'], string>> = [
          {
            type: 'text',
            text: `${results.length} exemplar(s) for "${query}" — study each thumbnail with its style facts:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb)
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: thumb.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
                data: thumb.data,
              },
            })
          blocks.push({ type: 'text', text: describeInspiration(r, i) })
        })
        blocks.push({ type: 'text', text: INSPIRATION_USAGE_NOTE })
        return ok(blocks)
      }
      case 'save_decision': {
        const decision = String(input.decision ?? '')
        try {
          const saved = actions.recordChatDecision(canvasId, decision, actor)
          if (saved === undefined) return fail('canvas not found')
          return ok(
            saved ? 'saved to the canvas Memory' : 'already in Memory — this exact decision was recorded before',
          )
        } catch (e) {
          return fail(e instanceof Error ? e.message : 'invalid decision')
        }
      }
      case 'set_guidelines': {
        const raw = block.input as { name?: string; markdown?: string; title?: string }
        if (typeof raw.name !== 'string' || !raw.name.trim()) return fail('name must be a non-empty slug')
        if (typeof raw.markdown !== 'string') return fail('markdown must be a string (empty string deletes the doc)')
        const doc = actions.setGuideline(canvasId, raw.name, raw.markdown, actor, undefined, raw.title)
        if (doc === undefined) return fail('canvas not found')
        return ok(
          doc
            ? `saved design guide "${actions.guidelineTitle(doc)}" (${doc.name}, ${doc.markdown.length} chars) — every actor on this canvas now inherits it`
            : `deleted design guide ${raw.name.trim().toLowerCase()}`,
        )
      }
      case 'screenshot_frame': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const blocks = await frameImageBlocks(f)
        if (runState.mutatedFrames.has(input.frame_id) || runState.verificationFrames.has(input.frame_id)) {
          runState.verifiedFrames.add(input.frame_id)
        }
        return ok(blocks)
      }
      case 'review_frame': {
        const f = store.getFrame(input.frame_id)
        if (!f || f.canvasId !== canvasId) return fail('frame not found on this canvas')
        const report = await reviewFrame(f, store.getCanvas(canvasId)?.tokens)
        runState.reviewedFrames.set(f.id, report)
        await persist.saveFrameReview(reviewToRecord(report, canvasId, actor.name))
        const s = report.summary
        if (report.verdict === 'pass')
          return ok(`review passed: 0 blocking findings across ${report.viewports.length} viewport(s)`)
        return ok(
          `review FAILED — ${report.blocking.length} blocking finding(s): ${report.blocking
            .slice(0, 6)
            .map((finding) => `${finding.rule} at ${finding.selector} (${finding.detail})`)
            .join(
              '; ',
            )}. Failing viewports: ${report.failing_viewports.join(', ') || 'none'}. Also ${s.warnings} warning(s), ${s.off_token} off-token color(s). Fix the selectors and re-run review_frame.`,
        )
      }
      case 'set_plan': {
        const raw = block.input as { steps?: unknown }
        const steps = Array.isArray(raw.steps)
          ? raw.steps
              .map(String)
              .filter((s) => s.trim())
              .slice(0, 12)
          : []
        if (!steps.length) return fail('set_plan requires a non-empty steps array')
        plans.publishPlan(canvasId, actor.name, steps, actor)
        return ok('plan published — update the steps as you go with update_plan_step')
      }
      case 'update_plan_step': {
        const raw = block.input as { step_id?: string; status?: string; note?: string }
        if (!raw.step_id || !raw.status) return fail('update_plan_step requires step_id and status')
        const updated = plans.advancePlanStep(
          canvasId,
          actor.name,
          { stepId: raw.step_id, status: raw.status, ...(raw.note ? { note: raw.note } : {}) },
          actor,
        )
        return updated
          ? ok(`step ${raw.step_id} is now ${raw.status}`)
          : fail(`no plan or no step ${raw.step_id} — check get_plan`)
      }
      case 'get_plan': {
        const plan = plans.readPlan(canvasId, actor.name)
        return plan
          ? ok(plan.steps.map((s) => `${s.id} [${s.status}] ${s.text}`).join('\n'))
          : ok('no plan published yet — call set_plan for multi-step work')
      }
      case 'ask_human': {
        const raw = block.input as { text?: string; frame_id?: string; wait_seconds?: number }
        const text = String(raw.text ?? '').trim()
        if (!text) return fail('ask_human requires text')
        const question = actions.askQuestion(
          canvasId,
          { text, ...(raw.frame_id ? { frameId: raw.frame_id } : {}), waitSeconds: raw.wait_seconds },
          actor,
        )
        if (!question) return fail('could not post the question')
        actions.markAgentWaiting(canvasId, actor.name, true)
        try {
          const answer = await agentEventsWaitForAnswer(canvasId, actor.name, question.id, question.expiresAt)
          if (answer !== undefined) return ok(`answered: ${answer}`)
          return ok(
            `nobody answered yet (status open, question_id ${question.id}). Continue with your best judgement; call get_answers later.`,
          )
        } finally {
          actions.markAgentWaiting(canvasId, actor.name, false)
        }
      }
      case 'get_answers': {
        const mine = actions.getQuestions(canvasId).filter((q) => q.agentName === actor.name)
        if (!mine.length) return ok('you have not asked any questions')
        return ok(
          mine
            .map((q) => `[${q.status}] ${q.text}${q.answer ? ` — answered by ${q.answeredBy}: ${q.answer}` : ''}`)
            .join('\n'),
        )
      }
      case 'hand_back': {
        const raw = block.input as { card_id?: string; to_agent?: string; reason?: string }
        if (!raw.card_id || !raw.to_agent || !raw.reason?.trim())
          return fail('hand_back requires card_id, to_agent and reason')
        const card = await actions.handBackCard(canvasId, raw.card_id, raw.to_agent, raw.reason, actor)
        if (!card) return fail(`no open card with id ${raw.card_id}`)
        if (!card.handback) return fail(`"${raw.to_agent}" is not a stage of this card's pipeline`)
        return ok(`handed back to ${raw.to_agent}`)
      }
      default:
        return fail(`unknown tool ${block.name}`)
    }
  } catch (e) {
    /* another agent holds the frame: report it like any tool error so the
       model can move to another frame instead of dying on the run */
    if (e instanceof frameLocks.FrameLockedError) return fail(e.message)
    /* Review mode reached through a path that cannot be diverted into a
       proposal (frame metadata, guides, decisions): report it as the tool
       error it is, so the model stops rather than retrying. */
    if (e instanceof actions.ReviewModeError) return fail(e.message)
    const blocked = websiteAccessErrorMessage(e, 'resident')
    if (blocked) runState.blockedWebsiteAccess = blocked
    return fail(blocked ?? (e instanceof Error ? e.message : 'tool failed'))
  }
}

/** Park until the answer to one question arrives, or its wait expires.
 *  Returns the answer text, or undefined on timeout. */
async function agentEventsWaitForAnswer(
  canvasId: string,
  agentName: string,
  questionId: string,
  expiresAt: number,
): Promise<string | undefined> {
  const events = await agentEvents.wait(canvasId, {
    agentName,
    cursor: 0,
    timeoutMs: Math.max(0, expiresAt - Date.now()),
    kinds: ['question_answer'],
  })
  const match = events.find((e) => (e.data as { questionId?: string; answer?: string })?.questionId === questionId)
  return (match?.data as { answer?: string } | undefined)?.answer
}
