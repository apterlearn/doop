import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ElicitResultSchema, InitializedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { Request, Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { randomUUID } from 'node:crypto'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { store } from './store.ts'
import * as persist from './db/persist.ts'
import * as actions from './actions.ts'
import { canvasAccess, hasDurableCanvasAccess, intentAtLeast, type CanvasIntent } from './access.ts'
import { auth, getUserName, isBanned, PUBLIC_ORIGIN } from './auth.ts'
import { capture, captureThrottled } from './analytics.ts'
import {
  MAX_HTML_READ_CHARS,
  readFrameHtml,
  renderFrame,
  StateRenderError,
  VIEWPORTS,
  type InteractionState,
} from './screenshot.ts'
import { htmlDiff } from './htmlDiff.ts'
import { inspectFrame } from './domProbe.ts'
import { auditFrame, auditProbe, type A11yReport } from './a11y.ts'
import { planA11yFixes } from './a11yFix.ts'
import { contentProbe } from './contentLint.ts'
import { diffFrames } from './visualDiff.ts'
import { cssForTokens, stripTokenStyle } from '../shared/tokens.ts'
import { lintFrame, lintProbe, planTokenFixes, type LintRule } from './designLint.ts'
import { deriveDesignSystem, designSystemMarkdown } from './designSystem.ts'
import { designLlmConfigured } from './designLlm.ts'
import { FRAME_HEIGHT, FRAME_WIDTH, runDesignWorkflow } from './designWorkflow.ts'
import { getDesignWorkflowPrefs } from './designWorkflowSettings.ts'
import { probeFrame, type Probe } from './domProbe.ts'
import {
  deleteElement,
  ElementEditError,
  FRAME_SCRIPT_API,
  getElement,
  getFrameCss,
  insertElement,
  runFrameScript,
  setFrameCss,
  updateElements,
  type UpdateElementsResult,
} from './elementEdit.ts'
import { motionFrame } from './motion.ts'
import { checkBrandCompliance } from './brand.ts'
import { generateImage, IMAGE_NOT_CONFIGURED, imageProvider } from './imageGen.ts'
import { DOOP_GUIDE, guideFor, GUIDE_TOPICS } from './guide.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml, repairEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import { buildZip } from './zip.ts'
import {
  IMAGES_PER_MIN,
  IMPORTS_PER_MIN,
  MAX_FRAME_HTML_BYTES,
  RENDERS_PER_MIN,
  SEARCHES_PER_MIN,
  UPLOADS_PER_MIN,
} from './limits.ts'
import * as imageSearch from './imageSearch.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { discoverSitePages, importPage, normalizeImportUrl, type DiscoveredSite } from './importer.ts'
import { cancelJob, getJob, jobProgress, recordUnit, startJob, waitForJobs } from './jobs.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { htmlSha, reportIsCurrent, reviewFrame, reviewToRecord } from './review.ts'
import { AGENT_ROLES, DEFAULT_ROLE_ID, roleFor, roleName } from '../shared/agents.ts'
import { parseListing, publishCanvas, unpublishCanvas } from './community.ts'
import { COMMUNITY_CATEGORIES } from '../shared/types.ts'
import { sanitizeImportedHtml } from './sanitizeHtml.ts'
import {
  agentsMd,
  designMd,
  handoffFileName,
  handoffFiles,
  HandoffError,
  rewriteAssetUrls,
  specMd,
  tailwindThemeCss,
  tokensDtcg,
  tokensJson,
} from './codeExport.ts'
import { reviewCanvas } from './canvasReview.ts'
import { replaceInFrames } from './findReplace.ts'
import { diffRelease } from './releaseDiff.ts'
import {
  commentPullRequest,
  commitToBranch,
  ensurePullRequest,
  GithubWriteError,
  readPullRequest,
} from './githubWrite.ts'
import * as github from './github.ts'
import { importRepoScreen, type RepoScreenImport } from './githubRecon.ts'
import { touchClient } from './mcpClients.ts'
import { TOOL_POLICY, toolEnabled } from './mcpPolicy.ts'
import { setSampler } from './distill.ts'
import { capabilities } from './capabilities.ts'
import * as agentEvents from './agentEvents.ts'
import * as runLog from './runLog.ts'
import { codeFor, err, mcpErrorPayload, ResourceError, type McpErrorPayload } from './mcpErrors.ts'
import * as frameLocks from './frameLocks.ts'
import { recall, remember, replay, replayAsync } from './opIds.ts'
import { htmlBundle, htmlToReact } from './codeExport.ts'
import type {
  AgentQuestion,
  Canvas,
  CanvasProposal,
  CanvasProposalKind,
  CanvasView,
  Component,
  DesignTokens,
  ElementComment,
  Frame,
  MemoryReference,
  UserMemory,
  Page,
  ServerMessage,
} from '../shared/types.ts'
import { recordToolCall } from './mcpStats.ts'

const INSTRUCTIONS = `Doop is a shared multiplayer design canvas: humans and AI agents design together in real time. Canvases contain frames — artboards that render complete HTML documents live for everyone viewing.

You MUST call get_guide({ topic: "doop-instructions" }) once before using other Doop tools. Call it again if a long conversation may have compressed or dropped the guide text.

- Context first: call get_canvas before adding or editing frames.
- Identity: pick an agent_name and reuse the SAME name on every call — your presence and edits are attributed live.
- Creating: create_frame, then stream the design with append_frame_html one complete section at a time (~1–4 KB chunks; start=true on the first, done=true on the last). Each chunk renders the moment it arrives — viewers watch you work.
- Pages: canvases contain ordered pages — sub-canvases that group frames. For multi-screen flows, create one page per screen with create_page and target it via the page param on create_frame (or move_frame later); get_canvas lists every page and which page each frame sits on.
- Review: after every create or significant edit you MUST call get_frame_screenshot and fix what looks wrong before moving on.
- Small edits: edit_frame_html (exact find/replace — the change morphs into the rendered frame in place). Full redesigns: set_frame_html or a new stream. Rename/move/resize: update_frame.
- Images: real imagery makes designs. search_images finds stock photos (you SEE thumbnails and pick), search_icons finds 200k+ UI icons as hotlinkable SVGs, search_logos finds real company logos by brand name or domain — call it once per brand BEFORE writing any logo wall, integration row, press bar or testimonial, and never ship a placeholder tile, "LOGO" text or an invented wordmark in its place, list_backgrounds shows a page of curated hero/section/bento backgrounds (glows, grainy meshes, aurora, painterly scenes) as thumbnails — browse it when a section wants atmosphere rather than defaulting to a flat CSS gradient, judge by eye whether one fits the frame, and draw your own when none does, upload_asset stores your own file (remote file → source_url; local file → local_file=true, returns a curl command) and returns a permanent URL. Never inline images as data: URIs.
- Websites: when a request names an existing site or URL — a redesign of it, or "like acme.com" — call import_webpage FIRST so an editable HTML snapshot lands on the canvas. Leave that source frame unchanged and design in a separate frame. view_website is only for read-only inspection when the page should not be added. If Doop cannot capture the site, do not retry with view_website because it uses the same capture path. Use your own browser or web tool and work only from content you actually observe; if that is unavailable, ask the user for screenshots or an HTML export rather than inventing content.
- Comments: a human asks you for work by commenting on an element and @mentioning a role — there is no queue to poll, so get_comments is how you find out what they want, and claim_comment takes the notes addressed to your role so two connected agents do not both do the same one. Do the work, answer in the thread with reply_to_comment, then close the note with resolve_comment; fail_comment (with the reason) when you cannot finish it, so the human sees it stopped and can retry. add_comment pins a new note to an element — use it to ask a human a question about a specific element.
- Inspecting: on a large or imported frame, call inspect_frame (rendered semantics, computed styles, element selectors) and get_frame_html (a bounded slice, or a query) instead of get_frame — pulling a whole document into context is the most common way to run out of room mid-design.
- Etiquette: never delete or rewrite a frame another agent is actively streaming into — if a run looks wrong, say so in a comment on the frame and let a human decide what happens to the work.
- Guidelines: canvases can carry named style guides (brand rules, style recipes). get_canvas lists them with one-line summaries — read the relevant ones with get_guidelines BEFORE designing and follow them.
- Memory: canvases can also carry pinned style references — exemplar designs humans marked as "more like this". get_canvas lists them; read the relevant one with get_reference and match its look. When your human gives you design feedback in conversation and you address it, record it with save_decision so the canvas remembers their taste.`

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

/**
 * A machine-readable result: the typed payload rides along as
 * `structuredContent` while the identical object stays the text block every
 * client already reads. Both ship because the spec requires the text fallback
 * for clients that do not render structured output.
 */
function structured<T extends object>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as unknown as Record<string, unknown>,
  }
}

/** A machine-readable result plus a workflow nudge: the typed payload rides
 *  as structuredContent, the nudge as a second text block the agent reads. */
function structuredWithNudge<T extends object>(data: T, nudge: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
      { type: 'text' as const, text: nudge },
    ],
    structuredContent: data as unknown as Record<string, unknown>,
  }
}

/** Result payload plus a workflow nudge the agent reads at its decision point. */
function textWithNudge(data: unknown, nudge: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(data, null, 2) },
      { type: 'text' as const, text: nudge },
    ],
  }
}

/** The document a frame write actually stores: `actions.updateFrame` repairs
 *  escaped markup and strips the render-time token block, so a dry run diffs
 *  what would land, not the raw argument. */
function storedHtml(html: string): string {
  return stripTokenStyle(repairEscapedHtml(html))
}

/** How a render names the interaction state it was measured in. */
function stateLabel(state: InteractionState): string {
  return `${state.pseudo} on ${state.selector}`
}

/**
 * A write tool's `dry_run` answer: what would change and by how much, with
 * nothing written. No version is snapshotted, no lock is taken and no viewer
 * is told — the diff is the whole point of the call.
 */
function dryRunPayload(before: string, after: string, extra: Record<string, unknown> = {}) {
  return {
    dry_run: true as const,
    would_apply: before !== after,
    diff: htmlDiff(before, after),
    bytes_before: before.length,
    bytes_after: after.length,
    ...extra,
  }
}

const REVIEW_NUDGE =
  'You have not seen this design yet. Call get_frame_screenshot on it now, judge it against the review checkpoints (fit, spacing, hierarchy, contrast, alignment, realism), and fix any issues before moving on.'

import type { Actor } from '../shared/types.ts'

/** Tells an agent its markup arrived escaped — actions.ts already decoded it. */
function withEscapeNote<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  sent: string,
): T {
  if (looksEscapedHtml(sent)) result.content.push({ type: 'text' as const, text: ESCAPED_HTML_NOTE })
  return result
}

/** Explicit viewport beats the named device beats the frame's own size. */
function resolveViewport(
  device: 'mobile' | 'tablet' | 'desktop' | undefined,
  viewport: { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (viewport) return viewport
  return device ? VIEWPORTS[device] : undefined
}

/** A frame write can lose a race two ways: another agent holds the lock, or the
 *  caller's read of the frame is stale. Both are `conflict` — retryable once
 *  the caller re-reads or takes the frame over — and both are structured, so an
 *  agent can branch on them instead of parsing prose. A frame its human locked
 *  is the third: no retry helps, so the refusal says whose lock it is and what
 *  a caller can still do about it. */
function lockConflict(e: unknown) {
  if (e instanceof actions.FrameLockedByUserError) {
    return err('conflict', e.message, {
      frame_id: e.frameId,
      holder: 'the user',
      hint: 'this frame is locked in the editor — ask the human to unlock it, or write to another frame',
    })
  }
  if (!(e instanceof frameLocks.FrameLockedError)) return undefined
  const until = new Date(e.holder.expiresAt).toISOString()
  return err('conflict', `frame ${e.holder.frameId} is being edited by ${e.holder.agentName} until ${until}`, {
    frame_id: e.holder.frameId,
    holder: e.holder.agentName,
    expires_at: until,
    hint: 'pass takeover: true to take the frame over, or wait for the lock to expire',
  })
}

/** A comment life-cycle call, or a question, that is not the caller's own: the
 *  record belongs to somebody else and no retry changes that. The action raises
 *  the typed refusal (`NotCommentAuthorError`, `NotCommentClaimantError`,
 *  `NotQuestionAskerError`) and its own sentence is the answer — carried under
 *  `forbidden`, the code an agent branches on, with the owner named beside it
 *  so the caller can say whose the record is rather than only that it may not
 *  touch it. */
function ownerRefusal(e: unknown) {
  if (e instanceof actions.NotCommentAuthorError) {
    return err('forbidden', e.message, {
      comment_id: e.commentId,
      author: e.author,
      hint: 'a note is its author’s to rewrite — answer it with reply_to_comment instead',
    })
  }
  if (e instanceof actions.NotCommentClaimantError) {
    return err('forbidden', e.message, {
      comment_id: e.commentId,
      ...(e.claimant ? { claimant: e.claimant } : {}),
      hint: e.claimant
        ? `only ${e.claimant} can give this claim back — take a different note with claim_comment, or leave it to them`
        : 'nobody holds this note, so there is nothing to release',
    })
  }
  if (e instanceof actions.NotQuestionAskerError) {
    return err('forbidden', e.message, {
      question_id: e.questionId,
      asker: e.asker,
      hint: 'a question is the asker’s own — read how it stands with get_answers',
    })
  }
  return undefined
}

/** How far back `undo_last_change` looks when it is not given a frame. */
const UNDO_WINDOW_MS = 30 * 60_000

/** An agent undoing repeatedly walks backwards through states, not back and
 *  forth between two of them. Each undo saves a version holding the state it
 *  restored, so without a record of where the chain has been, the next undo
 *  would find the state it just left and toggle. `visited` is that record:
 *  hashes of the states this chain has already moved away from. */
interface UndoChain {
  at: number
  visited: Set<string>
  /** the document the last undo in this chain restored */
  restored: string
}
const undoChains = new Map<string, UndoChain>() // `${frameId}:${agentName}`

/** The chain for this frame, or a fresh one: a chain that has aged out, or
 *  whose restored state is no longer what the frame holds (someone wrote since
 *  — the agent's own edit or a human's), starts over. */
function undoChainFor(frameId: string, agentName: string, currentHtml: string): UndoChain {
  const key = `${frameId}:${agentName}`
  const chain = undoChains.get(key)
  if (chain && Date.now() - chain.at <= UNDO_WINDOW_MS && chain.restored === htmlSha(currentHtml)) return chain
  const fresh: UndoChain = { at: Date.now(), visited: new Set(), restored: '' }
  undoChains.set(key, fresh)
  return fresh
}

/** Frames on this canvas this agent changed within the undo window, newest
 *  first — the natural set for "undo what I just did". */
function recentFramesFor(canvasId: string, agentName: string, now = Date.now()): string[] {
  return (store.getCanvas(canvasId)?.frames ?? [])
    .filter((f) => f.updatedBy === agentName && now - f.updatedAt <= UNDO_WINDOW_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((f) => f.id)
}

/** A write whose `expected_updated_at` no longer matches the frame. Absent
 *  precondition = no check, so existing callers are unaffected. */
function stalePayload(
  f: { id: string; updatedAt: number; updatedBy: string },
  expected?: string,
): McpErrorPayload | undefined {
  if (expected === undefined) return undefined
  const at = Date.parse(expected)
  if (Number.isNaN(at))
    return mcpErrorPayload('invalid_input', `expected_updated_at is not an ISO timestamp: ${expected}`)
  if (at === f.updatedAt) return undefined
  const now = new Date(f.updatedAt).toISOString()
  return mcpErrorPayload('conflict', `frame ${f.id} changed since you read it — now ${now} by ${f.updatedBy}`, {
    current_updated_at: now,
    current_updated_by: f.updatedBy,
    hint: 're-read with get_frame, then retry with the updatedAt you get back',
  })
}

function staleConflict(f: { id: string; updatedAt: number; updatedBy: string }, expected?: string) {
  const payload = stalePayload(f, expected)
  return payload ? err(payload.error.code, payload.error.message, payload.error) : undefined
}

/** One line describing what a tool returned, for the run timeline. Structured
 *  payloads are collapsed to their first text block; a long document is
 *  trimmed — the panel shows a summary, never a document. */
function resultSummary(result: CallToolResult | undefined): string {
  if (!result) return ''
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/** The frame a step wrote, for the Run timeline's jump-to-frame: the frame the
 *  call returned, or the one a writing call named. Only a call that landed
 *  wrote anything — a step that was refused or failed named a frame it never
 *  touched, and the Run tab would offer a jump from a row it renders as failed
 *  — so a failed step carries no id. Nor does a read that merely names a frame:
 *  that is not "the frame this step wrote" either. */
function runEventFrameId(
  args: Record<string, unknown>,
  result: CallToolResult | undefined,
  ok: boolean,
  isWrite: boolean,
): string | undefined {
  if (!ok) return undefined
  const text = result?.content?.find((block) => block.type === 'text')?.text
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        if ('frame' in parsed && parsed.frame && typeof parsed.frame === 'object' && 'id' in parsed.frame) {
          const id = parsed.frame.id
          if (typeof id === 'string' && id) return id
        }
        if ('frame_id' in parsed) {
          const id = parsed.frame_id
          if (typeof id === 'string' && id) return id
        }
      }
    } catch {
      /* not our payload — no frame to point at */
    }
  }
  if (!isWrite) return undefined
  const named = args.frame_id
  return typeof named === 'string' && named ? named : undefined
}

/** A failed tool's text block, as a structured error. Falls back to `internal`
 *  for anything that is not our own JSON payload (a transport-level failure). */
function parseToolError(text: string | undefined): McpErrorPayload {
  if (text) {
    try {
      const parsed = JSON.parse(text) as McpErrorPayload
      if (parsed?.error?.code) return parsed
    } catch {
      /* not our payload — keep the prose */
    }
    return mcpErrorPayload('internal', text)
  }
  return mcpErrorPayload('internal', 'the op failed without a message')
}

/**
 * Report progress on a long-running tool call.
 *
 * Importing a page, rendering a screenshot or diffing two renders takes
 * seconds to tens of seconds; a client that asked for progress should not sit
 * silent through it. Best-effort on purpose: the endpoint is stateless, so a
 * client that never opened an SSE stream simply gets nothing, and a failed
 * notification must never fail the work.
 */
async function progress(extra: unknown, fraction: number, message: string): Promise<void> {
  const token = (extra as { _meta?: { progressToken?: string | number } } | undefined)?._meta?.progressToken
  if (token === undefined) return
  try {
    await (
      extra as {
        sendNotification?: (n: {
          method: 'notifications/progress'
          params: { progressToken: string | number; progress: number; total: number; message: string }
        }) => Promise<void>
      }
    ).sendNotification?.({
      method: 'notifications/progress',
      params: { progressToken: token, progress: fraction, total: 1, message },
    })
  } catch {
    /* the client is gone or never subscribed — the work still stands */
  }
}

/** `takeover: true` is the explicit escape hatch out of another agent's lock:
 *  the caller knowingly overwrites a frame someone else is mid-edit on. */
function takeOver(frameId: string, canvasId: string, actor: Actor, takeover?: boolean) {
  if (!takeover) return
  const displaced = actions.releaseAllFrameLocks(frameId)
  actions.acquireFrameLock(frameId, actor)
  if (displaced) {
    /* the displaced agent's next write is refused with a lock conflict it can
       explain, so the takeover is never a silent clobber */
    actions.logActivity(canvasId, actor, `took over the edit lock on a frame`)
  }
}

/** Reaches agents that start designing without having read the canvas's style guides. */
function withGuidelinesNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const docs = store.getGuidelines(canvasId)
  if (docs.length === 0 || actions.hasSeenGuidelines(canvasId, actor.name)) return result
  result.content.push({
    type: 'text' as const,
    text: `This canvas has style guides you have not read: ${docs.map((d) => d.name).join(', ')}. Call get_guidelines({ canvas_id, name }) for each relevant one NOW and make your design follow them.`,
  })
  return result
}

/** A human's selection is how "fix THIS element" points at something, and MCP
 *  is pull-based: the agent can only be told on a call it makes. One line, and
 *  only when the newest selection changed since this session's last call — a
 *  human moving around the canvas must not cost a line per tool call. */
function withFocusNudge<T extends CallToolResult>(result: T, canvasId: string, session: McpSession): T {
  if (!result || result.isError) return result
  const [newest] = actions.listCanvasFocus(canvasId)
  const tuple = newest
    ? `${newest.clientId}|${newest.frameId ?? ''}|${newest.selector ?? ''}|${newest.pageId ?? ''}`
    : ''
  if (tuple === (session.lastFocus ?? '')) return result
  session.lastFocus = tuple
  /* a cleared selection is a change, but not something to interrupt a call for */
  if (!newest || (!newest.frameId && !newest.selector)) return result
  const frame = newest.frameId ? store.getFrame(newest.frameId) : undefined
  const where = frame ? `frame “${frame.name}”` : `frame ${newest.frameId}`
  result.content.push({
    type: 'text' as const,
    text: newest.selector
      ? `A human is looking at ${where} — element ${newest.selector}.`
      : `A human is looking at ${where}.`,
  })
  return result
}

/** What the session filled in for a call that omitted it. Defaulting silently
 *  is the failure this exists to prevent, so the substitution is reported in
 *  the payload and in prose. */
interface UsedContext {
  canvasId?: string
  agentName?: boolean
}

/** Say what the session supplied. Merged into `structuredContent` when the
 *  result has one, and always as a text line for the client that reads prose. */
function withSessionContext<T extends CallToolResult>(result: T, used: UsedContext): T {
  if (!result || result.isError) return result
  if (result.structuredContent) {
    if (used.canvasId) result.structuredContent.used_active_context = { canvas_id: used.canvasId, from: 'session' }
    if (used.agentName) result.structuredContent.used_agent_name = true
  }
  if (used.canvasId) {
    result.content.push({
      type: 'text' as const,
      text: `using canvas ${used.canvasId} from this session; pass canvas_id explicitly to target another`,
    })
  }
  return result
}

/** The per-call `extra` the SDK hands a tool handler, taken from the SDK so it
 *  stays the same type the registration site checks against. This server uses
 *  one part of it: `sendRequest`, which is how it asks the human at the agent's
 *  own client a question (elicitation) without going through the canvas. */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** A human edited a frame while this agent's stream was open: the base the
 *  agent was appending to is gone, and appending the next chunk onto what is
 *  there now would splice two designs together. Delivered once, on the next
 *  successful call, whichever tool it is. */
function withInterrupted<T extends CallToolResult>(result: T, canvasId: string, actor: Actor): T {
  const cut = actions.takeInterruptedStreams(canvasId, actor.name, actor.ownerId)
  if (cut.length === 0) return result
  const lines = cut.map(
    (entry) =>
      `- ${entry.by} edited “${entry.frameName}” (${entry.frameId}) at ${new Date(entry.at).toISOString()}, while your stream into it was open`,
  )
  result.content.push({
    type: 'text' as const,
    text: `STREAM INTERRUPTED — a human took over a frame you were streaming into:
${lines.join('\n')}
Your design's base changed: the HTML you are appending to is no longer what you last read. Re-read it with get_frame_html, then decide — continue with append_frame_html (pass the new updatedAt as expected_updated_at), or re-send the whole document with start: true if the human's edit should be kept.`,
  })
  return result
}

/** One field out of a bus event's `data`, without trusting the shape of the
 *  rest: every producer pushes a plain object with its own keys, so a reader
 *  asking for one of them must not assume the others are there. */
function eventField(data: unknown, field: string): unknown {
  if (data === null || typeof data !== 'object' || !(field in data)) return undefined
  return (data as Record<string, unknown>)[field]
}

/** A human redirected this agent's run — "use the brand blue", "stop after the
 *  hero". MCP is pull-based and the endpoint is stateless, so a steer has to
 *  ride a call the agent is already making: this is the notice that carries it,
 *  on the first call that lands after the human typed it. Consumed as it is
 *  handed over — the call that reads a steer is the call it was meant to
 *  change — and only attached to a result that landed, so a refused call does
 *  not swallow the instruction. */
function withSteers<T extends CallToolResult>(result: T, canvasId: string, agentName: string, agentId?: string): T {
  const steers = agentEvents.takeSteers(canvasId, agentName, agentId)
  if (steers.length === 0) return result
  const lines = steers.map(
    (steer) => `- ${steer.by} at ${new Date(steer.at).toISOString()}: ${steer.message || '(no message)'}`,
  )
  result.content.push({
    type: 'text' as const,
    text: `STEERED — a human redirected this run while it was in progress:
${lines.join('\n')}
Adjust what you are doing to follow that instruction now. If it changes what you already built, fix it with an ordinary edit rather than starting over silently, and say what you changed in the canvas chat (send_message).`,
  })
  return result
}

/* Rate limits live in server/limits.ts: one definition, enforced here and
   reported by get_capabilities. The hit maps are per connecting user. */
const uploadHits = new Map<string, number[]>()

/* photo search burns the shared Pexels quota */
const searchHits = new Map<string, number[]>()

/* importing writes a potentially large HTML frame */
const importHits = new Map<string, number[]>()

/* Every render (screenshot, inspect, lint, audit, review, diff, image export)
   boots a Chromium page; one shared budget keeps an agent from holding the
   browser hostage. */
const renderHits = new Map<string, number[]>()

/* image generation spends money per result and takes tens of seconds */
const imageHits = new Map<string, number[]>()

/** True when the render budget allows one more, else the seconds to wait. */
function renderBudget(key: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  const hits = (renderHits.get(key) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= RENDERS_PER_MIN) {
    renderHits.set(key, hits)
    return { ok: false, retryAfter: Math.ceil((60_000 - (now - hits[0]!)) / 1000) }
  }
  hits.push(now)
  renderHits.set(key, hits)
  return { ok: true }
}

/* One definition of "check this at a phone width": the screenshot, inspection
   and audit tools must agree on what mobile/tablet/desktop mean. */
const deviceName = z
  .enum(['mobile', 'tablet', 'desktop'])
  .optional()
  .describe(
    "Render at a device preset (mobile 390x844, tablet 834x1112, desktop 1440x900) instead of the frame's own size",
  )
const viewportOverride = z
  .object({ width: z.number().int().min(1).max(20_000), height: z.number().int().min(1).max(20_000) })
  .optional()
  .describe('Explicit viewport, overriding device and the frame size')

/** Force a pseudo-class on one element before rendering: the design a human
 *  only sees while interacting with it. */
const interactionState = z
  .object({
    selector: z.string().describe('CSS selector for the element to render in this state'),
    pseudo: z.enum(['hover', 'focus', 'active']),
  })
  .optional()
  .describe(
    'Render this element in this interaction state instead of its resting state — the only way to see a :hover/:focus/:active rule',
  )

/** The shape of a dry run's diff, published so a client can read it typed. */
const diffShape = z.object({
  hunks: z.array(z.object({ a_start: z.number(), b_start: z.number(), lines: z.array(z.string()) })),
  added: z.number(),
  removed: z.number(),
})

/** Every rule id `fix_frame_a11y` can be pointed at: the accessibility audit's
 *  rules and the content lint's, in one list. Only three of them have a
 *  mechanical repair — the rest come back in `skipped` naming the judgement
 *  they need, which is exactly what `only` is for. */
const A11Y_FIX_RULES = [
  'contrast',
  'missing_alt',
  'heading_order',
  'focus_order',
  'tap_target',
  'missing_main',
  'unlabeled_nav',
  'form_label',
  'html_lang',
  'placeholder_text',
  'placeholder_image',
  'broken_image',
  'no_title',
  'no_meta_description',
  'dead_zone',
  'missing_state',
  'contrast_unverified',
  'motion_no_reduced_motion',
  'motion_long_duration',
  'motion_infinite_animation',
] as const

const opId = z
  .string()
  .max(120)
  .optional()
  .describe(
    'Idempotency key: a retry of the same call with the same op_id returns the original result instead of running again. Accepted by every tool that changes state (all the writes and creates); use a fresh value per intended operation.',
  )

/**
 * Every tool that changes state, and therefore takes an `op_id`.
 *
 * Declared as a list rather than derived from annotations so it is one
 * reviewable definition: the wrapper injects the key into exactly these tools,
 * and a tool missing from it is a tool an agent cannot safely retry. Reads are
 * deliberately absent — a retried read has nothing to duplicate, and adding the
 * key to them would put a mutation parameter on tools a client auto-approves.
 */
export const MUTATING_TOOLS: Record<string, true> = {
  add_comment: true,
  append_frame_html: true,
  apply_ops: true,
  ask_human: true,
  begin_frame_edit: true,
  cancel_job: true,
  claim_comment: true,
  comment_pull_request: true,
  copy_frame: true,
  create_canvas: true,
  create_canvas_version: true,
  create_component: true,
  create_frame: true,
  create_page: true,
  create_release: true,
  delete_asset: true,
  delete_canvas: true,
  delete_component: true,
  delete_element: true,
  delete_frame: true,
  delete_page: true,
  delete_release: true,
  detach_component: true,
  duplicate_canvas: true,
  duplicate_frame: true,
  edit_comment: true,
  edit_frame_html: true,
  end_frame_edit: true,
  extract_design_system: true,
  fail_comment: true,
  fix_frame_a11y: true,
  fix_frame_tokens: true,
  generate_image: true,
  import_code: true,
  import_repo_screen: true,
  import_site: true,
  import_webpage: true,
  insert_component: true,
  insert_element: true,
  move_frame: true,
  open_pull_request: true,
  post_status: true,
  propose_canvas_change: true,
  propose_frame_create: true,
  propose_frame_delete: true,
  propose_frame_html: true,
  publish_canvas: true,
  ready_for_review: true,
  rebase_proposal: true,
  remember: true,
  rename_canvas: true,
  rename_page: true,
  rename_release: true,
  reorder_frame: true,
  replace_in_frames: true,
  reply_to_comment: true,
  resolve_canvas_proposal: true,
  resolve_comment: true,
  resolve_frame_proposal: true,
  resolve_frame_proposals: true,
  restore_canvas_version: true,
  restore_frame: true,
  restore_page: true,
  restore_release: true,
  revert_frame: true,
  revert_run: true,
  review_canvas: true,
  review_frame: true,
  run_design_workflow: true,
  run_frame_script: true,
  save_decision: true,
  send_message: true,
  set_breakpoints: true,
  set_frame_css: true,
  set_frame_html: true,
  set_guidelines: true,
  set_link_access: true,
  set_review_mode: true,
  set_tokens: true,
  unclaim_comment: true,
  undo_last_change: true,
  unpublish_canvas: true,
  update_component: true,
  update_elements: true,
  update_frame: true,
  update_pull_request: true,
  upload_asset: true,
  upload_font: true,
  withdraw_proposal: true,
  withdraw_question: true,
}

/**
 * What each tool needs from the caller before the wrapper will run it.
 *
 * Reach is `canvasFor`'s question — can this account see the canvas at all —
 * and this is authority. A viewer-role member and a live view share link both
 * reach the canvas, which is exactly why their agent may read it, and neither
 * may write to it. The comment tools write conversation rather than design, so
 * they need `comment`: that is what lets an invited commenter leave a note
 * without touching a frame. Every other tool that changes state needs `edit`,
 * and that half is derived from MUTATING_TOOLS rather than listed again, so a
 * write added there is covered the day it is added.
 *
 * A name missing from this map is the third case: reach is its whole
 * requirement, and `view` is the floor every access already confers. That is
 * the reads, and `wait_for_events`, which changes nothing but does not declare
 * itself read-only because its answer is a time window.
 */
export const TOOL_INTENT: Record<string, CanvasIntent> = {
  ...Object.fromEntries(Object.keys(MUTATING_TOOLS).map((name): [string, CanvasIntent] => [name, 'edit'])),
  add_comment: 'comment',
  claim_comment: 'comment',
  edit_comment: 'comment',
  fail_comment: 'comment',
  reply_to_comment: 'comment',
  resolve_comment: 'comment',
  unclaim_comment: 'comment',
  withdraw_question: 'comment',
}

/**
 * The tools that land a change by ASKING: an agent held at `propose` may call
 * these and nothing else that writes. A proposal changes no frame until a
 * human accepts it, which is why `propose` can be granted the write path
 * `comment` does not have — and why it is strictly weaker than `full`.
 *
 * The four are the proposal tools the review-mode refusal names, and they are
 * the only write path a propose-level agent keeps: everything else that
 * changes state is refused with the same typed refusal review mode produces.
 */
const PROPOSE_TOOLS: Record<string, true> = {
  propose_canvas_change: true,
  propose_frame_create: true,
  propose_frame_delete: true,
  propose_frame_html: true,
}

/**
 * What each tool is FOR, so get_capabilities can answer "what can I do here"
 * without an agent reading 100 descriptions. One entry per registered tool —
 * a name missing from this map would read as "other" in the catalog, which is
 * why a test asserts the map covers the registry exactly.
 */
export const TOOL_DOMAINS: Record<string, string> = {
  add_comment: 'comments',
  append_frame_html: 'frame',
  apply_ops: 'canvas',
  ask_human: 'comments',
  audit_frame: 'verify',
  begin_frame_edit: 'frame',
  cancel_job: 'web',
  check_brand_compliance: 'verify',
  claim_comment: 'comments',
  comment_pull_request: 'handoff',
  copy_frame: 'frame',
  create_canvas: 'canvas',
  create_canvas_version: 'canvas',
  create_component: 'canvas',
  create_frame: 'frame',
  create_page: 'canvas',
  create_release: 'canvas',
  delete_asset: 'assets',
  delete_canvas: 'canvas',
  delete_component: 'canvas',
  delete_element: 'element',
  delete_frame: 'frame',
  delete_page: 'canvas',
  delete_release: 'canvas',
  detach_component: 'element',
  diff_frame: 'verify',
  diff_release: 'handoff',
  duplicate_canvas: 'canvas',
  duplicate_frame: 'frame',
  edit_comment: 'comments',
  edit_frame_html: 'frame',
  end_frame_edit: 'frame',
  export_canvas: 'handoff',
  export_frame: 'frame',
  extract_design_system: 'web',
  fail_comment: 'comments',
  fix_frame_a11y: 'verify',
  fix_frame_tokens: 'verify',
  frame_script_api: 'element',
  generate_image: 'assets',
  get_agents: 'discovery',
  get_answers: 'comments',
  get_asset: 'assets',
  get_canvas: 'canvas',
  get_capabilities: 'discovery',
  get_comments: 'comments',
  get_component: 'canvas',
  get_element: 'element',
  get_focus: 'comments',
  get_frame: 'frame',
  get_frame_content: 'frame',
  get_frame_css: 'frame',
  get_frame_history: 'frame',
  get_frame_html: 'frame',
  get_frame_review: 'verify',
  get_frame_screenshot: 'frame',
  get_frame_version: 'frame',
  get_frames_html: 'frame',
  get_guide: 'discovery',
  get_guidelines: 'canvas',
  get_inbox: 'comments',
  get_job: 'web',
  get_memory: 'discovery',
  get_messages: 'comments',
  get_motion_context: 'verify',
  get_pull_request_review: 'handoff',
  get_reference: 'canvas',
  get_run_events: 'run',
  get_token_usage: 'verify',
  get_tokens: 'canvas',
  import_code: 'handoff',
  import_repo_screen: 'web',
  import_site: 'web',
  import_webpage: 'web',
  insert_component: 'element',
  insert_element: 'element',
  inspect_frame: 'element',
  lint_frame: 'verify',
  list_assets: 'assets',
  list_backgrounds: 'assets',
  list_canvases: 'canvas',
  list_canvas_versions: 'canvas',
  list_canvas_proposals: 'review',
  list_change_proposals: 'review',
  list_components: 'canvas',
  list_frame_locks: 'frame',
  list_frames: 'frame',
  list_guidelines: 'canvas',
  list_releases: 'canvas',
  list_repo_screens: 'web',
  list_trash: 'canvas',
  move_frame: 'frame',
  open_pull_request: 'handoff',
  post_status: 'run',
  propose_canvas_change: 'review',
  propose_frame_create: 'review',
  propose_frame_delete: 'review',
  propose_frame_html: 'review',
  publish_canvas: 'canvas',
  ready_for_review: 'verify',
  rebase_proposal: 'review',
  remember: 'discovery',
  rename_canvas: 'canvas',
  rename_page: 'canvas',
  rename_release: 'canvas',
  reorder_frame: 'frame',
  replace_in_frames: 'canvas',
  reply_to_comment: 'comments',
  resolve_canvas_proposal: 'review',
  resolve_comment: 'comments',
  resolve_frame_proposal: 'review',
  resolve_frame_proposals: 'review',
  restore_canvas_version: 'canvas',
  restore_frame: 'frame',
  restore_page: 'canvas',
  restore_release: 'canvas',
  revert_frame: 'frame',
  revert_run: 'run',
  review_canvas: 'verify',
  review_frame: 'verify',
  run_design_workflow: 'frame',
  run_frame_script: 'frame',
  save_decision: 'canvas',
  search_components: 'canvas',
  search_frames: 'frame',
  search_icons: 'assets',
  search_images: 'assets',
  search_inspiration: 'web',
  search_logos: 'assets',
  send_message: 'comments',
  set_breakpoints: 'canvas',
  set_frame_css: 'frame',
  set_frame_html: 'frame',
  set_guidelines: 'canvas',
  set_link_access: 'canvas',
  set_review_mode: 'canvas',
  set_tokens: 'canvas',
  unclaim_comment: 'comments',
  undo_last_change: 'frame',
  unpublish_canvas: 'canvas',
  update_component: 'canvas',
  update_elements: 'element',
  update_frame: 'frame',
  update_pull_request: 'handoff',
  upload_asset: 'assets',
  upload_font: 'assets',
  view_website: 'web',
  wait_for_events: 'comments',
  wait_for_jobs: 'web',
  whoami: 'discovery',
  withdraw_proposal: 'review',
  withdraw_question: 'comments',
}

/** The resources and prompts this server registers, by name — reported by
 *  get_capabilities so a client knows what it can attach before it reads the
 *  guide. The resource names are the registrations; a template expands to one
 *  entry per canvas on the wire. */
const RESOURCE_NAMES = ['doop-guide', 'doop-canvas', 'doop-canvas-tokens']
const PROMPT_NAMES = ['design_review', 'redesign_from_url', 'handoff_to_code']

/** The one-line gist of a tool for the catalog: its first sentence, capped —
 *  the full description is what the tool call itself returns. */
function toolSummary(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const stop = flat.indexOf('. ')
  const first = stop === -1 ? flat : flat.slice(0, stop + 1)
  return first.length > 200 ? `${first.slice(0, 197)}…` : first
}

/**
 * The tools that already own their `op_id`, and therefore keep it: they have
 * carried the key since before the wrapper did, and they mint their payloads
 * mid-flow (upload_asset's single-use upload URL, import_code's review-mode
 * proposal), so replaying beside them would be two mechanisms for one key.
 * The wrapper leaves these to their own `replay`/`replayAsync` and covers every
 * other mutating tool.
 */
const SELF_REPLAY_TOOLS: Record<string, true> = {
  add_comment: true,
  create_canvas: true,
  create_frame: true,
  create_page: true,
  import_code: true,
  open_pull_request: true,
  upload_asset: true,
}

const agentName = z
  .string()
  .describe(
    'Your display name, shown live to everyone on the canvas (e.g. "Claude", "Codex"). Reuse the SAME name on every call so your work is attributed consistently.',
  )

/* Published output schemas. The SDK rejects a structured result that does not
   match its declared schema, so these are the contract for every read tool. */
const frameSummaryShape = {
  id: z.string(),
  name: z.string(),
  page: z.string().optional(),
  demo: z.literal(true).optional(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  updatedAt: z.string(),
  updatedBy: z.string(),
  htmlBytes: z.number(),
  large: z.literal(true).optional(),
  image_url: z.string(),
}

const pagedShape = {
  total: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
}

const canvasListItemShape = {
  id: z.string(),
  name: z.string(),
  ownerId: z.string().optional(),
  shared: z.boolean().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  frameCount: z.number(),
  previewFrameId: z.string().optional(),
  agents: z
    .array(z.object({ name: z.string(), owner: z.string().optional(), lastAt: z.number().optional() }))
    .optional(),
  guidelinesCount: z.number(),
}

const guidelineSummaryShape = {
  name: z.string(),
  title: z.string(),
  summary: z.string(),
  bytes: z.number(),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
}

/** `breakpoints`, `review_mode` and `link_access` are reported by get_canvas and
 *  the canvas resource; the local extension keeps the shared CanvasView type
 *  untouched. The policy pair is what tells an agent how its writes will land
 *  and who else can reach the canvas before it writes. */
type CanvasViewWithBreakpoints = CanvasView & {
  breakpoints?: { name: string; min_width: number }[]
  review_mode?: boolean
  link_access?: 'none' | 'view' | 'comment' | 'edit'
}

const canvasViewShape = {
  id: z.string(),
  name: z.string(),
  frames: z.array(z.object(frameSummaryShape)),
  frame_total: z.number(),
  frames_truncated: z.literal(true).optional(),
  pages: z.array(z.object({ id: z.string(), name: z.string(), position: z.number(), frameCount: z.number() })),
  guidelines: z.array(z.object(guidelineSummaryShape)),
  references: z.array(
    z.object({ id: z.string(), title: z.string(), size: z.string(), htmlBytes: z.number(), pinnedBy: z.string() }),
  ),
  flow: z.array(z.string()).optional(),
  breakpoints: z.array(z.object({ name: z.string(), min_width: z.number() })).optional(),
  tokens_present: z.boolean(),
  review_mode: z.boolean().optional(),
  link_access: z
    .enum(['none', 'view', 'comment', 'edit'])
    .optional()
    .describe(
      'What the share link grants an uninvited visitor: none = private, view = read-only, comment = read-only plus element notes, edit = full design access. Invited members are unaffected.',
    ),
  note: z.string().optional(),
}

const tokensShape = z.object({
  colors: z.record(z.string(), z.string()),
  fonts: z
    .object({ display: z.string().optional(), body: z.string().optional(), mono: z.string().optional() })
    .optional(),
  spacing: z.array(z.number()).optional(),
  radii: z.array(z.number()).optional(),
  shadows: z.array(z.string()).optional(),
  type: z
    .object({
      size: z.array(z.number()).optional(),
      weight: z.array(z.number()).optional(),
      leading: z.array(z.number()).optional(),
    })
    .optional(),
})

const lintReportShape = {
  violations: z.array(z.object({ rule: z.string(), selector: z.string(), value: z.string(), expected: z.string() })),
  counts: z.record(z.string(), z.number()),
  tokens_present: z.boolean(),
  checked_elements: z.number(),
}

const inspectionShape = {
  document: z.object({ title: z.string(), width: z.number(), height: z.number(), htmlChars: z.number() }),
  design: z.object({
    colors: z.array(z.string()),
    backgrounds: z.array(z.string()),
    fonts: z.array(z.string()),
    fontSizes: z.array(z.string()),
    radii: z.array(z.string()),
    shadows: z.array(z.string()),
    cssVariables: z.record(z.string(), z.string()),
  }),
  elements: z.array(
    z.object({
      selector: z.string(),
      key: z.string(),
      tag: z.string(),
      role: z.string().optional(),
      text: z.string().optional(),
      rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      style: z.object({
        color: z.string(),
        background: z.string(),
        font: z.string(),
        fontSize: z.string(),
        fontWeight: z.string(),
      }),
    }),
  ),
}

/* An anchor's state, as far as the server can tell without a render: a key
   that names an id or a test id can be checked against the frame's HTML, a
   positional selector cannot. The client resolves the rest from the live DOM
   (frameRuntime's locate), so this is a hint for the agent, not the last word. */
function anchorState(
  frameHtml: string,
  comment: { selector: string; stableKey?: string },
): 'selector' | 'lost' | 'unverified' {
  const named = comment.stableKey?.startsWith('#')
    ? comment.stableKey.slice(1)
    : comment.stableKey?.match(/^\[data-testid=(.+)\]$/)?.[1]
  if (!named) return 'unverified'
  const escaped = named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:id|data-testid)=["']?${escaped}["'\\s>]`).test(frameHtml) ? 'selector' : 'lost'
}

const commentShape = {
  id: z.string(),
  canvasId: z.string(),
  frameId: z.string(),
  selector: z.string(),
  /** content key: the anchor a stale selector falls back to (shared/selector.ts) */
  stableKey: z.string().optional(),
  /** whether the anchor still resolves — 'unverified' when the server cannot
   *  tell without a render, 'lost' when the element is gone from the HTML */
  anchor: z.enum(['selector', 'key', 'ambiguous', 'lost', 'unverified']).optional(),
  snippet: z.string(),
  from: z.string(),
  fromUserId: z.string().optional(),
  text: z.string(),
  at: z.number(),
  forAgent: z.boolean().optional(),
  targetAgent: z.string().optional(),
  claimedBy: z.string().optional(),
  claimedAt: z.number().optional(),
  failedAt: z.number().optional(),
  failureReason: z.string().optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.number().optional(),
  parentId: z.string().optional(),
  fromKind: z.enum(['user', 'agent']).optional(),
}

/** The states a note can be in, in the order a reader asks them: settled, then
 *  paused on a failure, then claimed by somebody, then open for whoever takes
 *  it next. One vocabulary for the life-cycle tools and the pins' own badges. */
const COMMENT_STATES = ['resolved', 'failed', 'claimed', 'open'] as const

/** Where a note stands, in the one word the caller branches on — a comment
 *  carries no status column of its own, so the state is read off the fields the
 *  actions actually write. */
function commentState(comment: ElementComment): (typeof COMMENT_STATES)[number] {
  if (comment.resolvedAt !== undefined) return 'resolved'
  if (comment.failedAt !== undefined) return 'failed'
  return comment.claimedBy !== undefined ? 'claimed' : 'open'
}

/* The three agent HTML write paths share one ceiling: a frame is stored whole,
   broadcast whole, and rendered whole, so an unbounded document costs every
   viewer and every later reader, not just the caller. */
function tooLarge(html: string): boolean {
  return html.length > MAX_FRAME_HTML_BYTES
}

function frameSummary(
  f: {
    id: string
    name: string
    x: number
    y: number
    width: number
    height: number
    updatedAt: number
    updatedBy: string
    html: string
    demo?: boolean
  },
  page?: { name: string },
) {
  return {
    id: f.id,
    name: f.name,
    ...(page ? { page: page.name } : {}),
    ...(f.demo ? { demo: true as const } : {}),
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    updatedAt: new Date(f.updatedAt).toISOString(),
    updatedBy: f.updatedBy,
    htmlBytes: f.html.length,
    /* a big document is the one an agent must not pull whole: the flag lets it
       choose inspect_frame / get_frame_html before blowing its context */
    ...(f.html.length > 60_000 ? { large: true as const } : {}),
    /* public render of the CURRENT design — downloadable/hotlinkable
       (append &download, or .jpg?quality=90 for JPEG) */
    image_url: `${PUBLIC_ORIGIN}/i/${f.id}.png?scale=2`,
  }
}

/** Where an MCP-authored chat message is announced to the canvas's ws room.
 *  index.ts owns the room, so it wires this at boot exactly the way it wires
 *  runLog's and actions' broadcasters; the no-op default keeps the tools
 *  usable with no room attached (module tests, a worker process). */
export type CanvasBroadcast = (canvasId: string, message: ServerMessage) => void

let broadcast: CanvasBroadcast = () => {}

export function wireBroadcast(b: CanvasBroadcast): void {
  broadcast = b
}

/** What one connected account's session remembers between calls. The
 *  streamable-HTTP endpoint builds a fresh server per POST, so anything a
 *  later call should inherit has to live here, keyed by the account. */
interface McpSession {
  /** one id per connection: every call this agent makes lands on the Run tab
   *  under the same run, so its session reads as one timeline */
  runId: string
  /** the canvas this session last named, kept even for a call that failed
   *  before its own frame resolved (a mistyped id) */
  lastCanvasId?: string
  /** the canvas this session is working on. A call that omits canvas_id is
   *  filled in with this — which is what lets an agent stop repeating it. */
  canvasId?: string
  /** the agent name this session works as, so identity survives a call that
   *  forgot it and the work is still attributed to the agent doing it */
  agentName?: string
  /** the durable identity behind that name — what a per-agent permission is
   *  filed against, and what `whoami` answers with */
  agentId?: string
  /** the owner's leash on that agent, as the wrapper last resolved it for a
   *  call on this canvas. Keyed by the canvas it was read for, so a level read
   *  for one canvas is never applied to another; a handler that gates on the
   *  caller's own level (the propose tools) reads it from here. */
  agentLevel?: { canvasId: string; level: persist.AgentLevel }
  /** the newest human focus tuple this session has already been told about,
   *  so a selection is reported once per change and not once per call */
  lastFocus?: string
}

const MCP_SESSIONS = 2000
const mcpSessions = new Map<string, McpSession>()
function sessionFor(key: string) {
  const existing = mcpSessions.get(key)
  if (existing) return existing
  const fresh: McpSession = { runId: randomUUID() }
  if (mcpSessions.size >= MCP_SESSIONS) mcpSessions.delete(mcpSessions.keys().next().value!)
  mcpSessions.set(key, fresh)
  return fresh
}

/* ---- durable agent identity ------------------------------------------------
   A name is free text, so the `agents` table is what makes an agent: an
   (account, name) pair keeps its row — and with it its id — across
   connections, while two accounts both working as "Claude" are two agents.
   The registry lives at module scope because the streamable-HTTP endpoint
   builds a fresh server per POST: the id a call arrives under has to be the
   one the next call is answered with. */

/** (account, name) -> the durable id: the read half, for the callers that list
 *  or report identities without arriving as one. Bounded like the session map,
 *  because an agent name is caller-supplied text. */
const agentIds = new Map<string, string>()

/** In-flight arrivals, so a connection writes its row once however many tools
 *  it calls: keyed by account, client and name, because a connection through a
 *  NEW client is a new arrival — it is the client the row is revoked by. */
const agentArrivals = new Map<string, Promise<string | undefined>>()

const agentKey = (ownerId: string, name: string) => `${ownerId}\u0000${name}`

/** An OAuth client was disconnected: drop what it arrived as, so the next
 *  connection through it is a fresh ARRIVAL — which is the only thing that
 *  resurrects a revoked identity. Without this, a client that was revoked and
 *  then re-approved would keep the memo of its first arrival and never write
 *  its row back. */
export function forgetAgentArrivals(ownerId: string, clientId: string): void {
  const suffix = `\u0000${clientId}`
  for (const key of [...agentArrivals.keys()]) {
    if (key.startsWith(`${ownerId}\u0000`) && key.endsWith(suffix)) agentArrivals.delete(key)
  }
}

/** The durable id behind an (account, name), minted on first sight and
 *  refreshed by each new connection. Never rejects: the record is bookkeeping,
 *  and a connection that cannot write it (no account behind it, no database in
 *  a tools-only boot) still works — it just has no id to answer with. */
function agentIdentity(ownerId: string | undefined, name: string, clientId?: string): Promise<string | undefined> {
  if (!ownerId) return Promise.resolve(undefined)
  const key = agentKey(ownerId, name)
  const arrival = `${key}\u0000${clientId ?? ''}`
  const pending = agentArrivals.get(arrival)
  if (pending) return pending
  /* the write starts inside the chain, not before it: a store that cannot
     write at all (a tools-only boot with no database, a module test that stubs
     the persistence layer) must leave the call working, not throw into it */
  const write = Promise.resolve()
    .then(() => store.upsertAgent({ ownerId, name, ...(clientId ? { clientId } : {}) }))
    .then((row) => {
      if (agentIds.size >= MCP_SESSIONS) agentIds.delete(agentIds.keys().next().value!)
      agentIds.set(key, row.id)
      return row.id
    })
    .catch(() => {
      /* a write that failed is not remembered as "this agent has no identity":
         the next call arrives again */
      agentArrivals.delete(arrival)
      return undefined
    })
  if (agentArrivals.size >= MCP_SESSIONS) agentArrivals.delete(agentArrivals.keys().next().value!)
  agentArrivals.set(arrival, write)
  return write
}

/** Tools where the agent name is the whole point of the call rather than a
 *  detail of it: claiming the work a human addressed to you, answering a
 *  human, or waiting on their behalf. These keep `agent_name` required in
 *  their published schema — a session default here would mean claiming or
 *  answering as whichever agent last used this account. */
const IDENTITY_TOOLS: Record<string, true> = {
  ask_human: true,
  claim_comment: true,
  wait_for_events: true,
}

/** Tools that take a canvas and an agent name WITHOUT inheriting them from the
 *  session: a discovery call is about the server, not about the canvas this
 *  connection happens to be working on, so a call that names neither stays
 *  unattributed — no canvas substituted into it, and no step for it on that
 *  canvas's run timeline. get_capabilities takes both to report the caller's
 *  own level there, which is a question about the canvas it names and nothing
 *  more; it is not where the session's canvas is remembered either. */
const UNINHERITED_TOOLS: Record<string, true> = { get_capabilities: true }

/** Borrow the connected client's model for the distiller (MCP sampling). On a
 *  self-hosted instance with no ANTHROPIC_API_KEY, a client that declares the
 *  `sampling` capability is the only model available, so the canvas can still
 *  distill design decisions. The client hosts the model and may refuse or be
 *  offline — the failure surfaces to the distiller's own catch like any other
 *  model error. */
async function sampleThrough(server: McpServer, prompt: string, system: string): Promise<string> {
  const result = await server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
    maxTokens: 1000,
    ...(system ? { systemPrompt: system } : {}),
  })
  return result.content.type === 'text' ? result.content.text : ''
}

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. `opts.readonly` builds the read-only
 *  surface: write tools are never registered, so they are absent from
 *  `tools/list` rather than merely refused. */
export function buildMcpServer(
  owner?: string,
  ownerId?: string,
  clientId?: string,
  opts?: { readonly?: boolean },
): McpServer {
  /* one id per connection: every call this agent makes on a canvas lands on
     the Run tab under the same run, so its session reads as one timeline. The
     HTTP endpoint builds a fresh server for every POST, so this state lives
     outside it — keyed by the account AND the connection, because two MCP
     clients on one account must not inherit each other's canvas or agent name.
     An anonymous caller (no account, no client id) still shares one session. */
  const session = sessionFor(ownerId || clientId ? `${ownerId ?? ''}\u0000${clientId ?? ''}` : (owner ?? 'anonymous'))
  const actorFrom = (agent_name?: string) =>
    actions.resolveActor({ name: agent_name, kind: 'agent', owner, ownerId, clientId })
  /* Canvas access for agents mirrors the web UI: the OAuth user's id runs
     through the same canvasAccess gate as browser sessions, as the owner (edit)
     or as the member role they were granted. Every tool that takes a canvas or
     frame id resolves it through these; the wrapper separately refuses a call
     the caller's intent does not cover. */
  const canvasFor = (canvasId: string) => {
    const c = store.getCanvas(canvasId)
    if (!c || canvasAccess(ownerId, c) === null) return undefined
    return c
  }
  const frameFor = (frameId: string) => {
    const f = store.getFrame(frameId)
    if (!f) return undefined
    return canvasFor(f.canvasId) ? f : undefined
  }
  /** The human on the other end of the MCP connection: the account whose
   *  token authorized this server. Their answers are recorded as theirs. */
  const elicitedActor = () => actions.resolveActor({ name: owner ?? 'the connected client', kind: 'user' })
  const noCanvas = (id: string) => err('not_found', `no canvas with id ${id} accessible to this account`)
  const noFrame = (id: string) => err('not_found', `no frame with id ${id} accessible to this account`)
  /* Page resolution for agents: by id first, then by exact name within the
     canvas — an ambiguous name is an error naming the candidate ids. */
  const pageForId = (pageId: string) => {
    const found = store.getPage(pageId)
    if (!found || canvasAccess(ownerId, found.canvas) === null) return undefined
    return found
  }
  const resolvePage = (
    canvasId: string,
    page: string,
  ): { page: Page; error?: undefined } | { page?: undefined; error: string } => {
    const pages = store.getCanvas(canvasId)?.pages ?? []
    const byId = pages.find((p) => p.id === page)
    if (byId) return { page: byId }
    const matches = pages.filter((p) => p.name === page)
    if (matches.length === 1) return { page: matches[0] as Page }
    if (matches.length > 1)
      return {
        error: `page "${page}" is ambiguous — the canvas has several pages with that name (${matches.map((p) => p.id).join(', ')}); use the page id`,
      }
    return { error: `no page "${page}" on this canvas — try a page id from get_canvas` }
  }
  /* Server contract: trim, clamp to 80 chars, fall back when empty. */
  const pageName = (name: string | undefined, fallback: string) => (name ?? '').trim().slice(0, 80) || fallback
  /* Reads count as arrival: presence (and with it every "your agent is
     connected" confirmation in the UI) must appear on an agent's FIRST
     canvas-scoped call, not only once it mutates something. The durable
     identity is written on the same beat — the id it answers with is what the
     session's later calls are attributed to, and what a per-agent permission
     hangs off. */
  const arrive = async (canvasId: string, agent_name?: string) => {
    if (!agent_name) return
    const actor = actorFrom(agent_name)
    actions.heartbeatAgent(canvasId, actor)
    session.agentId = (await agentIdentity(ownerId, actor.name, clientId)) ?? session.agentId
  }
  /* Review mode: agent writes land as proposals a human accepts, so the
     direct writes are refused with the propose path named. */
  const REVIEW_MODE_MESSAGE =
    'this canvas is in review mode — agent changes need human approval. Deliver with propose_frame_html / propose_frame_create / propose_frame_delete instead; they land the moment a human accepts.'
  const reviewGatePayload = (canvasId: string): McpErrorPayload | undefined => {
    if (!store.getCanvas(canvasId)?.reviewMode) return undefined
    return mcpErrorPayload('unsupported', REVIEW_MODE_MESSAGE)
  }
  const reviewGate = (canvasId: string) => {
    const payload = reviewGatePayload(canvasId)
    return payload ? err(payload.error.code, payload.error.message) : undefined
  }

  /**
   * Whether a proposal is the way to land a change on this canvas, for a
   * propose tool that would otherwise refuse.
   *
   * Review mode is the canvas's rule: while it is on, the direct write is
   * refused and the proposal is the path. A per-agent `propose` level is the
   * owner's rule for one agent: it has no direct write path at all, so the
   * proposal is its only one — and since `propose` is strictly weaker than
   * `full`, opening that path to it grants nothing a full agent did not
   * already have. With neither rule in force the direct write is still the
   * answer, and a proposal would sit in a queue nobody is reviewing.
   *
   * The level is the one the wrapper resolved for THIS call's canvas (kept on
   * the session), so a level read for another canvas can never open this gate.
   */
  const proposeGate = (canvasId: string, direct: string) => {
    if (store.getCanvas(canvasId)?.reviewMode) return undefined
    if (session.agentLevel?.canvasId === canvasId && session.agentLevel.level === 'propose') return undefined
    return err('unsupported', `review mode is off on this canvas — write directly with ${direct} instead`)
  }

  /* Canvas policy and the canvas itself belong to the owner alone — the same
     rule the REST routes enforce (server/index.ts: the owner check on
     linkAccess, review-mode, publish and delete). Collaborators may rename
     pages and edit frames; who can reach the canvas, whether agent writes need
     approval, and whether it exists at all are the owner's decisions. A caller
     with no account id is nobody's owner, so an ownerless canvas matches no
     one — exactly like publishCanvas's `!actor.id ||` guard. */
  const ownerOnly = (c: Canvas, what: string) =>
    ownerId !== undefined && c.ownerId === ownerId
      ? undefined
      : err('forbidden', `only the owner can ${what} — this canvas belongs to another account`, {
          hint: 'ask the owner, or copy the design into your own canvas with duplicate_canvas',
        })

  /**
   * Frames on the canvas that are not currently verified, whoever wrote them.
   *
   * Shipping is a whole-canvas claim: a release, a pull request and a gallery
   * listing present the WHOLE canvas, so a frame someone else left failing
   * would ship under this caller's name. The evidence is the newest stored
   * report for the frame — current for the document it holds, and passing.
   */
  async function canvasUnverifiedFrames(
    canvasId: string,
  ): Promise<{ frameId: string; name: string; reason: string }[]> {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return []
    const out: { frameId: string; name: string; reason: string }[] = []
    for (const frame of canvas.frames.filter((f) => !f.demo && f.html)) {
      const [newest] = await persist.listFrameReviews(frame.id, 1)
      if (!newest) {
        out.push({ frameId: frame.id, name: frame.name, reason: 'never reviewed' })
        continue
      }
      if (!reportIsCurrent({ html_sha: newest.htmlSha }, frame, canvas.tokens)) {
        out.push({ frameId: frame.id, name: frame.name, reason: 'changed after its last review' })
        continue
      }
      if (newest.verdict !== 'pass') {
        out.push({ frameId: frame.id, name: frame.name, reason: 'its last review failed' })
      }
    }
    return out
  }

  /** The refusal every ship path returns when the canvas is not verified end
   *  to end: the frames named, the one call that clears them, and — because a
   *  human may know better than the gate — how to override it. */
  async function shipRefusal(canvasId: string, force?: boolean) {
    if (force) return undefined
    const pending = await canvasUnverifiedFrames(canvasId)
    if (!pending.length) return undefined
    return err(
      'conflict',
      `this canvas is not verified end to end — ${pending
        .map((entry) => `“${entry.name}” (${entry.reason})`)
        .join(
          ', ',
        )}. Call review_canvas to check every frame in one sweep, or pass force: true to ship anyway and state in your summary that the unverified frames were shipped unchecked.`,
      { frames: pending, hint: 'review_canvas runs the canvas-wide sweep and records a report per frame' },
    )
  }
  /* Webpage capture is a shared, slow, externally-metred resource: one helper
     so every capture path spends from the same per-user budget. */
  const takeImport = (agentName?: string) => {
    const key = ownerId ?? agentName ?? 'anonymous'
    const now = Date.now()
    const hits = (importHits.get(key) ?? []).filter((t) => now - t < 60_000)
    if (hits.length >= IMPORTS_PER_MIN) return err('rate_limited', 'webpage import rate limit — wait a minute')
    hits.push(now)
    importHits.set(key, hits)
    return undefined
  }

  /* Every render boots a Chromium page. One helper for the refusal, so the
     budget message stays identical across the tools that spend it. */
  const takeRender = (agentName?: string) => {
    const budget = renderBudget(ownerId ?? agentName ?? 'anonymous')
    if (budget.ok) return undefined
    return err(
      'rate_limited',
      `render budget exhausted (${RENDERS_PER_MIN}/min across screenshots, reviews, diffs and exports) — wait ${budget.retryAfter}s`,
      { retry_after_seconds: budget.retryAfter },
    )
  }
  const server = new McpServer({ name: 'doop-canvas', version: '0.1.0' }, { instructions: INSTRUCTIONS })
  /* A connected client that declares `sampling` can stand in for the server's
     own model key: on a self-hosted instance with no ANTHROPIC_API_KEY the
     canvas still distills design decisions, because the distiller borrows the
     caller's model. A client without the capability clears any sampler an
     earlier connection left behind, so distillation falls back to the key
     alone — today's behaviour. The SDK's ServerOptions.oninitialized is
     declared but never wired, so the notification is handled directly. */
  server.server.setNotificationHandler(InitializedNotificationSchema, () => {
    const sampling = server.server.getClientCapabilities()?.sampling
    setSampler(sampling ? (prompt, source) => sampleThrough(server, prompt, source) : null)
    /* A client that cached tools/list from an earlier session keeps offering
       writes this surface does not have; re-list is how it finds out. A no-op
       when the policy removed nothing. */
    if (policyFilteredTools) server.sendToolListChanged()
  })

  /* Every tool call lands here: one place that records outcome and latency for
     the whole surface, so the handlers stay readable. It also keeps each
     tool's own input schema and handler, which is what lets apply_ops batch a
     tool without restating its arguments anywhere. */
  type RegisterTool = McpServer['registerTool']
  type ToolHandler = (args: never, extra: never) => Promise<CallToolResult>
  /** The hints a tool declares to the client. Every tool carries
   *  `readOnlyHint` and `destructiveHint`; the other two are optional. */
  interface ToolAnnotations {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  interface RegisteredTool {
    inputSchema: z.ZodRawShape
    run: ToolHandler
    /* kept so get_capabilities can describe the surface from the registrations
       themselves rather than from a second, hand-maintained list */
    description: string
    annotations?: ToolAnnotations
  }
  const registry = new Map<string, RegisteredTool>()
  /** The canvas a call is about, from its own args: canvas_id, else the frame
   *  or page it names. Comment-scoped tools resolve their canvas from the
   *  comment. Deliberately not access-checked: the interrupted-stream notice
   *  belongs to the agent that was interrupted, and an agent working a canvas
   *  through a dispatch may not be the account that owns it. The run-event
   *  writer applies its own check. */
  const canvasArgOf = (args: Record<string, unknown>): string | undefined => {
    if (typeof args.canvas_id === 'string') return args.canvas_id
    if (typeof args.frame_id === 'string') return store.getFrame(args.frame_id)?.canvasId
    if (typeof args.page_id === 'string') return store.getPage(args.page_id)?.canvas.id
    return undefined
  }

  /** The canvas the intent check is about: what the call names, or the canvas
   *  the comment it names belongs to — the comment tools take a comment id
   *  instead of a canvas, and a gate a comment id can sidestep is not a gate.
   *  A tool that names no canvas at all (create_canvas, list_canvases) has
   *  nothing to be checked against, and an id nobody can resolve is left to the
   *  handler, which answers it with its own not_found. */
  const intentCanvasOf = (args: Record<string, unknown>): string | undefined =>
    canvasArgOf(args) ??
    (typeof args.comment_id === 'string' ? actions.findComment(args.comment_id)?.canvasId : undefined)

  /**
   * The session's context, applied to a call that omitted it.
   *
   * `canvas_id` and `agent_name` are the two arguments an agent has to repeat
   * on nearly every call, and forgetting `agent_name` is not a visible mistake:
   * every write, run event and presence heartbeat is attributed to it, so a
   * call without one acts as nobody. Both are therefore inherited from the
   * session, and — because a silent default is its own hazard — the
   * substitution is reported back in the result.
   *
   * An explicit argument always wins, and nothing is inherited by the tools
   * that have no canvas scope (create_canvas, list_canvases, whoami), which do
   * not declare `canvas_id` in the first place — nor by the discovery tools in
   * UNINHERITED_TOOLS, which declare both but mean them as their own.
   */
  const applySessionContext = (args: unknown, declared: z.ZodRawShape, name: string): UsedContext => {
    const used: UsedContext = {}
    if (!args || typeof args !== 'object') return used
    const record = args as Record<string, unknown>
    /* Only arguments the tool actually declares. A tool that never asked for a
       canvas or an agent name was not written to carry one, and handing it a
       field it does not know about would change what it means — a run-timeline
       event attributed to a call that never claimed to be that agent. */
    const inherits = UNINHERITED_TOOLS[name] !== true
    const declaresCanvas = inherits && 'canvas_id' in declared
    const declaresAgent = inherits && 'agent_name' in declared
    if (declaresCanvas && typeof record.canvas_id !== 'string' && session.canvasId) {
      record.canvas_id = session.canvasId
      used.canvasId = session.canvasId
    }
    if (declaresAgent && typeof record.agent_name !== 'string' && session.agentName) {
      record.agent_name = session.agentName
      used.agentName = true
    }
    /* record what this call named, so the next one can inherit it */
    if (declaresCanvas && typeof record.canvas_id === 'string') session.canvasId = record.canvas_id
    if (declaresAgent && typeof record.agent_name === 'string') session.agentName = record.agent_name
    return used
  }

  /** A call that omitted a canvas the session could not supply. The published
   *  schema no longer enforces `canvas_id` (the session may fill it), so this is
   *  where the refusal happens — naming what to do, instead of letting
   *  `undefined` travel into a handler that would report it as "no canvas with
   *  id undefined".
   *
   *  Only the canvas: an unresolved `agent_name` is nudged, never refused, or
   *  every client that has never passed one would break. */
  const missingCanvas = (args: unknown, declared: z.ZodRawShape): CallToolResult | undefined => {
    if (!args || typeof args !== 'object') return undefined
    const field = declared.canvas_id
    if (!(field instanceof z.ZodString) || field.isOptional()) return undefined
    const record = args as Record<string, unknown>
    if (typeof record.canvas_id === 'string') return undefined
    return err(
      'invalid_input',
      'canvas_id is required: this session has not worked on a canvas yet, so there is nothing to default to. Call list_canvases to pick one, or pass canvas_id explicitly.',
    )
  }

  /** The focus nudge and the session report, in that order: steering first,
   *  the bookkeeping about which canvas this was last. */
  const contextNotices = (
    args: unknown,
    result: CallToolResult,
    used: UsedContext,
    declared: z.ZodRawShape,
  ): CallToolResult => {
    if (!result || result.isError) return result
    if (!args || typeof args !== 'object') return result
    const record = args as Record<string, unknown>
    let out = result
    if (typeof record.agent_name === 'string') {
      const canvasId = canvasArgOf(record)
      /* A human's steer outranks the focus nudge: one is the run being
         redirected, the other is where someone's cursor is. */
      if (canvasId) out = withSteers(out, canvasId, record.agent_name, session.agentId)
      if (canvasId) out = withFocusNudge(out, canvasId, session)
    }
    /* A canvas-scoped call is where attribution matters, so an unresolved name
       is worth naming here — never as a hard error, which would break every
       client that has never passed one. Only for a tool that accepts the
       argument at all. */
    const unresolved = 'agent_name' in declared && used.agentName === undefined && typeof record.agent_name !== 'string'
    if (unresolved && canvasArgOf(record) !== undefined) {
      out.content.push({ type: 'text' as const, text: 'call with agent_name so this work is attributed to you' })
    }
    return withSessionContext(out, used)
  }

  /** The caller's idempotency key for a tool the wrapper replays, or undefined
   *  when the call carries none — or when the tool owns its key already (see
   *  SELF_REPLAY_TOOLS). */
  const opIdOf = (name: string, args: unknown): string | undefined => {
    if (SELF_REPLAY_TOOLS[name]) return undefined
    if (!args || typeof args !== 'object') return undefined
    const record = args as Record<string, unknown>
    /* A dry run changes nothing, so it has nothing to replay — and it must never
       answer a later real call's key with a preview. */
    if (record.dry_run === true) return undefined
    const value = record.op_id
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  /** Records are keyed per account AND per tool: an `op_id` names one intended
   *  operation, and the same string on another tool is another operation.
   *  Sharing one key space would let a create replay a write's result — and
   *  silently skip creating. */
  const opIdOwner = (toolName: string) => `${toolName}\u0000${ownerId ?? ''}`
  /** A frame's measurements for the spec, or undefined when it cannot be
   *  rendered — the caller turns that into the tool's own error. */
  const specProbe = async (frame: Frame): Promise<Probe | undefined> => {
    try {
      return await probeFrame(frame)
    } catch {
      return undefined
    }
  }

  /** Every agent's calls belong on the canvas timeline: the Run tab is where a
   *  human watches what an agent did, and a connected MCP agent's work is
   *  exactly that. One event per canvas-scoped call, named by the agent that
   *  made it — a separate runId per agent session, so the panel can group them. */
  const recordRunEvent = (
    name: string,
    args: unknown,
    ok: boolean,
    ms: number,
    summary: string,
    result?: CallToolResult,
    versions?: { beforeVersionId?: string; afterVersionId?: string },
  ) => {
    if (!args || typeof args !== 'object') return
    const record = args as Record<string, unknown>
    if (typeof record.agent_name !== 'string') return
    const named = canvasArgOf(record)
    if (named) session.lastCanvasId = named
    /* the Run tab is the canvas owner's view of what happened on their canvas,
       so a call that merely names an id this account cannot read does not get
       to write into it */
    const canvasId = canvasFor(named ?? session.lastCanvasId ?? '')?.id
    if (!canvasId) return
    runLog.record({
      canvasId,
      runId: session.runId,
      agentName: record.agent_name,
      kind: 'tool',
      name,
      ok,
      ms,
      summary: summary.slice(0, 200),
      /* The arguments this step was called with, as the Run tab's detail pane
         shows them — the serialised string, not a copy: `record` cuts it to
         ARGS_CAP bytes at the write boundary, so nothing is pre-truncated
         here and the ring and the row are cut the same way. */
      args: JSON.stringify(record),
      /* Who made the call. An MCP step is always an agent, and the id is the
         durable identity behind the name — what tells two accounts' agents
         apart when they share a display name. The wrapper resolves it before
         the handler runs, so the first call of a session is stamped too. */
      actorKind: 'agent',
      ...(session.agentId ? { agentId: session.agentId } : {}),
      frameId: runEventFrameId(record, result, ok, WRITE_OPS.has(name)),
      /* the replay cursor: which versions of that frame this step started from
         and produced. `revert_run` walks the run's events by these. */
      ...(versions?.beforeVersionId ? { beforeVersionId: versions.beforeVersionId } : {}),
      ...(versions?.afterVersionId ? { afterVersionId: versions.afterVersionId } : {}),
    })
  }

  /**
   * A human's stop, as this agent's next call sees it.
   *
   * MCP is pull-based: a human pressing stop cannot interrupt a call in flight,
   * so `agentEvents` remembers the stop and this is where it lands — the call
   * about to run is refused instead, which ends the run the way the human
   * asked. Consumed as it is delivered (`clearStop`), so the stop that ended
   * one run never refuses the next one's first call.
   */
  const stopRefusal = async (args: unknown): Promise<CallToolResult | undefined> => {
    if (!args || typeof args !== 'object') return undefined
    const record = args as Record<string, unknown>
    if (typeof record.agent_name !== 'string') return undefined
    /* the canvas this call is about, or the one the session is working — a
       stopped agent is stopped on any call, not only one that names its canvas */
    const canvasId = canvasFor(canvasArgOf(record) ?? session.lastCanvasId ?? '')?.id
    if (!canvasId) return undefined
    /* The identity is resolved here rather than left to the gate that follows:
       this check runs first, and on a session's first call there is no id yet.
       A stop filed against the id must not be missed — nor handed to a
       different agent that happens to work under the same name. */
    const agentId = session.agentId ?? (await agentIdentity(ownerId, record.agent_name, clientId))
    const stop = agentEvents.pendingStop(canvasId, record.agent_name, agentId)
    if (!stop) return undefined
    agentEvents.clearStop(canvasId, record.agent_name, session.runId)
    return err('stopped', `this run was stopped by ${stop.by}`, {
      stopped_by: stop.by,
      stopped_at: new Date(stop.at).toISOString(),
      hint: 'the run is over — stop calling tools. Report where you got to with send_message, and wait for a human to tell you what to do next (wait_for_events) before starting anything else.',
    })
  }

  /**
   * A call this connection's access does not cover, refused before the handler
   * runs.
   *
   * Reaching a canvas and being allowed to change it are different questions,
   * and only the second is about the tool: a viewer-role member and a live view
   * share link reach the canvas — which is what lets their agent read it — and
   * must not be able to write to it. What a tool needs is its own declaration
   * (TOOL_INTENT), and the check sits in the wrapper so no handler can be
   * written past it.
   *
   * A caller with NO access is left to the handler: it answers with the same
   * not_found it always has, which says nothing about what exists here.
   */
  const intentRefusal = (name: string, need: CanvasIntent, args: unknown): CallToolResult | undefined => {
    /* `view` is the floor every access confers, so a read has nothing to be
       refused for — and a call that only reads is not worth the canvas lookup */
    if (need === 'view' || !args || typeof args !== 'object') return undefined
    const canvasId = intentCanvasOf(args as Record<string, unknown>)
    if (!canvasId) return undefined
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return undefined
    const held = canvasAccess(ownerId, canvas)
    if (held === null || intentAtLeast(held, need)) return undefined
    return err('forbidden', `${name} needs ${need} access to canvas ${canvasId}; this connection holds ${held}`, {
      intent: held,
      required_intent: need,
      hint: `this account can read the canvas: use get_canvas and get_frame to follow the design. ${
        need === 'comment'
          ? 'Ask the owner to raise the role to commenter to leave notes on it.'
          : 'Ask the owner to raise the role to editor to design on it.'
      }`,
    })
  }

  /**
   * The level the owner has given this agent on the canvas this call names, or
   * undefined when the call cannot be attributed to one — no canvas, no agent
   * id, or a level that could not be read.
   *
   * A read that fails is undefined rather than a refusal: the level is a leash
   * ON TOP of canvas access (which the handlers and `canvasFor` enforce), and a
   * database that cannot answer must not refuse every agent on the box.
   */
  const agentLevelOf = async (
    args: unknown,
    agentId: string | undefined,
  ): Promise<{ canvasId: string; level: persist.AgentLevel } | undefined> => {
    if (!agentId || !args || typeof args !== 'object') return undefined
    const canvasId = intentCanvasOf(args as Record<string, unknown>)
    if (!canvasId) return undefined
    try {
      /* no row is the default, and the default is `full` */
      const row = await store.getAgentLevel(canvasId, agentId)
      return { canvasId, level: row?.level ?? 'full' }
    } catch {
      return undefined
    }
  }

  /**
   * A call the caller's own level does not cover, refused before the handler
   * runs — the owner's leash on ONE agent, applied on top of the connection's
   * intent (TOOL_INTENT), which is the account's.
   *
   * `full` is the default and the whole surface. `comment` may read and leave
   * notes. `view` may read. `propose` may read, comment, and PROPOSE: the four
   * proposal tools are the only write path it keeps, because a proposal lands
   * nothing until a human accepts it — and a refusal names the proposal tools
   * the way review mode does, since that is how this agent lands a change.
   *
   * A call that cannot be attributed to an agent on a canvas is not refused:
   * there is no level to hold it at, and refusing on a guess would refuse work
   * nobody leashed.
   */
  const levelRefusal = (
    name: string,
    need: CanvasIntent,
    held: { canvasId: string; level: persist.AgentLevel },
  ): CallToolResult | undefined => {
    const { canvasId, level } = held
    if (level === 'full') return undefined
    /* what the level itself confers, before `propose`'s one exception */
    const confers: CanvasIntent = level === 'view' ? 'view' : 'comment'
    if (intentAtLeast(confers, need)) return undefined
    if (level === 'propose') {
      if (PROPOSE_TOOLS[name]) return undefined
      return err(
        'unsupported',
        `this agent is held at propose on canvas ${canvasId}, and ${name} needs edit access: it may read, comment and propose, but not write. Deliver with propose_frame_html / propose_frame_create / propose_frame_delete / propose_canvas_change instead; they land the moment a human accepts.`,
        {
          agent_level: level,
          required_intent: need,
          hint: 'propose the change instead: a proposal lands the moment a human accepts it, and the owner can raise this agent to full to let it write directly.',
        },
      )
    }
    return err('forbidden', `${name} needs ${need} on canvas ${canvasId}; this agent is held at ${level}`, {
      agent_level: level,
      required_intent: need,
      hint:
        level === 'view'
          ? 'this agent can only read this canvas: follow the design with get_canvas and get_frame. Ask the canvas owner to raise its level to comment or full.'
          : 'this agent can read and comment on this canvas, but not change it. Ask the canvas owner to raise its level to full.',
    })
  }

  /**
   * The version a frame-writing step started from, read before the handler
   * runs. `revert_run` needs it to know what the frame looked like before the
   * run touched it, so this is the caller's half of the replay cursor; the
   * other half is captured after the call lands.
   *
   * Only for a write op that names its frame in the arguments: a frame id that
   * only exists in the result (create_frame) has no "before" to point at, and a
   * tool that touches no frame has no version at all.
   */
  const beforeVersionOf = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ frameId: string; versionId?: string } | undefined> => {
    if (!WRITE_OPS.has(name)) return undefined
    const frameId = runEventFrameId(args, undefined, true, true)
    if (!frameId) return undefined
    try {
      const versionId = await persist.latestFrameVersionId(frameId)
      return { frameId, ...(versionId ? { versionId } : {}) }
    } catch {
      /* a version read that fails must never fail the write it describes */
      return { frameId }
    }
  }

  /** What the write produced, read after it landed — and only then committed
   *  to the database, so the version row this step created is the one the next
   *  step reads back as its "before". Without the flush the frame row (and its
   *  version) would still be sitting in the write-behind debounce, and the step
   *  would be recorded against a stale version — which `revert_run` would then
   *  refuse as "someone wrote since". */
  const afterVersionOf = async (
    name: string,
    args: Record<string, unknown>,
    result: CallToolResult | undefined,
    before: { frameId: string; versionId?: string } | undefined,
  ): Promise<{ beforeVersionId?: string; afterVersionId?: string } | undefined> => {
    if (!before) return undefined
    /* A streamed frame writes on every chunk and the version history is
       deliberately debounced through the reveal; the stream's last chunk is
       where its document is complete, so that is the step worth recording. */
    if (name === 'append_frame_html' && args.done !== true) return undefined
    const written = runEventFrameId(args, result, true, true)
    /* a step whose result names a different frame wrote more than one frame:
       there is no single before/after pair to record for it */
    if (written !== before.frameId) return undefined
    try {
      await persist.flushFrame(before.frameId)
      const after = await persist.latestFrameVersionId(before.frameId)
      /* no new version means the write changed nothing versionable (a rename, a
         move, a dry run): there is nothing to revert to, so no cursor */
      if (!after || after === before.versionId) return undefined
      return { ...(before.versionId ? { beforeVersionId: before.versionId } : {}), afterVersionId: after }
    } catch {
      return undefined
    }
  }

  /** The interruption notice rides on any successful call that names a canvas,
   *  so it cannot be lost by an agent that never calls the frame tools again. */
  const interruptedResult = (args: unknown, result: CallToolResult): CallToolResult => {
    if (!result || result.isError) return result
    if (!args || typeof args !== 'object') return result
    const record = args as Record<string, unknown>
    if (typeof record.agent_name !== 'string') return result
    const canvasId = canvasArgOf(record)
    if (canvasId === undefined) return result
    return withInterrupted(result, canvasId, actorFrom(record.agent_name))
  }
  /** How many tools the source declares, against `registry.size`: when the
   *  policy removes some, the surface a client caches is smaller than the
   *  source, and it is told so once registration finishes. */
  let attemptedTools = 0
  const tool = ((name: string, config: never, cb: never) => {
    attemptedTools += 1
    const cfg = config as unknown as {
      inputSchema?: z.ZodRawShape
      description?: string
      annotations?: ToolAnnotations
    }
    /* A tool the policy removes is never registered, so it cannot appear in
       tools/list at all — that is what makes the read-only surface a real
       boundary rather than a hint a client could ignore. */
    if (
      !toolEnabled(name, TOOL_POLICY, {
        readonly: opts?.readonly === true,
        readOnlyHint: cfg.annotations?.readOnlyHint,
      })
    )
      return undefined as never
    /* The registry keeps the tool's OWN schema, so apply_ops validates a batch
       against exactly what the tool publishes. The schema registered with the
       SDK is loosened instead: `canvas_id` and `agent_name` are declared
       required on most tools, and the SDK validates arguments before this
       wrapper runs — so a call that omits them would be refused as invalid
       before the session could fill them in. Nothing is lost by loosening:
       applySessionContext supplies both, and a call that names neither a canvas
       nor a session canvas still fails in the handler with `not_found`. */
    const declared = cfg.inputSchema ?? {}
    const registered: z.ZodRawShape = { ...declared }
    /* Every state-changing tool takes the same idempotency key, declared here
       once so no tool can forget it — a write an agent cannot safely retry is
       a write it must re-read the canvas to check. */
    if (MUTATING_TOOLS[name] && !('op_id' in registered)) registered.op_id = opId
    /* What this call must hold to run at all: TOOL_INTENT for the tools that
       write, and plain reach for every other one — a read reaches the canvas or
       it does not, which is the gate canvasFor already applies. */
    const requiredIntent: CanvasIntent = TOOL_INTENT[name] ?? 'view'
    /* `agent_name` stays required where the identity IS the call */
    for (const key of IDENTITY_TOOLS[name] ? (['canvas_id'] as const) : (['canvas_id', 'agent_name'] as const)) {
      const field = registered[key]
      if (field instanceof z.ZodString) registered[key] = field.optional()
    }
    registry.set(name, {
      inputSchema: declared,
      run: cb as unknown as ToolHandler,
      description: cfg.description ?? '',
      annotations: cfg.annotations,
    })
    return server.registerTool(
      name as never,
      { ...(config as object), inputSchema: registered } as never,
      (async (args: never, extra: never) => {
        const started = Date.now()
        const used = applySessionContext(args, declared, name)
        const missing = missingCanvas(args, declared)
        if (missing) {
          recordToolCall(name, false, Date.now() - started, 'invalid_input')
          recordRunEvent(name, args, false, Date.now() - started, 'refused: a required argument was missing')
          return missing
        }
        /* A retried write must not land twice. The key is the account plus the
           caller's OWN op_id — never a field the session filled in — so a retry
           that omits the canvas or the name still finds its record. The replay
           is post-processed like the call it replays: the session's
           substitutions are reported again rather than baked into the record. */
        /* A human's stop ends the run here, before the call can touch anything:
           a replay included — the run is over either way, and the human asked
           for it to stop. */
        const stopped = await stopRefusal(args)
        if (stopped) {
          recordToolCall(name, false, Date.now() - started, 'stopped')
          recordRunEvent(name, args, false, Date.now() - started, 'refused: a human stopped the run')
          return stopped
        }
        /* Authority, and before anything can be touched — a replay included,
           which answers with a write's result and so is a write's answer. Reach
           is a different question and keeps its own answer: a canvas the caller
           cannot see at all is still the handler's not_found. */
        const denied = intentRefusal(name, requiredIntent, args)
        if (denied) {
          recordToolCall(name, false, Date.now() - started, 'forbidden')
          recordRunEvent(
            name,
            args,
            false,
            Date.now() - started,
            `refused: this connection does not hold ${requiredIntent} access`,
          )
          return denied
        }
        /* The owner's leash on this agent, on top of the account's access. The
           id it is filed against is resolved here rather than read off the
           session: on a session's FIRST call nothing has arrived yet, because
           `arrive` runs inside the handler — after this gate, which needs the
           id. The run events this call writes are stamped with it too. */
        const callArgs = (args ?? {}) as Record<string, unknown>
        const callingName = typeof callArgs.agent_name === 'string' ? callArgs.agent_name : session.agentName
        const agentId =
          callingName && intentCanvasOf(callArgs) ? await agentIdentity(ownerId, callingName, clientId) : undefined
        if (agentId) session.agentId = agentId
        const held = await agentLevelOf(args, agentId)
        if (held) {
          session.agentLevel = held
          const leashed = levelRefusal(name, requiredIntent, held)
          if (leashed) {
            recordToolCall(name, false, Date.now() - started, held.level === 'propose' ? 'unsupported' : 'forbidden')
            recordRunEvent(name, args, false, Date.now() - started, `refused: this agent is held at ${held.level}`)
            return leashed
          }
        }
        const opKey = opIdOf(name, args)
        if (opKey) {
          const replayed = recall(opIdOwner(name), opKey)
          if (replayed) {
            replayed.content.push({ type: 'text' as const, text: JSON.stringify({ idempotent_replay: true }) })
            recordToolCall(name, true, Date.now() - started)
            recordRunEvent(name, args, true, Date.now() - started, 'idempotent replay', replayed)
            return contextNotices(args, interruptedResult(args, replayed), used, declared)
          }
        }
        /* Read before the handler runs: the frame's version now is the state
           this step starts from. */
        const before = await beforeVersionOf(name, (args ?? {}) as Record<string, unknown>)
        try {
          const result = await (cb as unknown as ToolHandler)(args, extra)
          const ok = !result?.isError
          recordToolCall(name, ok, Date.now() - started)
          recordRunEvent(
            name,
            args,
            ok,
            Date.now() - started,
            resultSummary(result),
            result,
            ok ? await afterVersionOf(name, (args ?? {}) as Record<string, unknown>, result, before) : undefined,
          )
          /* only a result that landed is remembered: a refused write's key
             stays free, so the retry of a failure still runs */
          if (opKey && result && !result.isError) remember(opIdOwner(name), opKey, result)
          return contextNotices(args, interruptedResult(args, result), used, declared)
        } catch (e) {
          /* Review mode is enforced in the mutation layer, so it catches every
             write path — including ones reached indirectly (duplicate_frame,
             revert_frame, import_webpage). Report it the way the agent can act
             on: a typed refusal naming the proposal tools. */
          if (e instanceof actions.ReviewModeError) {
            recordToolCall(name, false, Date.now() - started, 'unsupported')
            recordRunEvent(name, args, false, Date.now() - started, 'refused: review mode needs human approval')
            return err(
              'unsupported',
              'this canvas is in review mode — agent changes need human approval. Deliver with propose_frame_html / propose_frame_create / propose_frame_delete instead; they land the moment a human accepts.',
            )
          }
          recordToolCall(name, false, Date.now() - started, 'internal')
          recordRunEvent(name, args, false, Date.now() - started, e instanceof Error ? e.message : 'failed')
          throw e
        }
      }) as never,
    )
  }) as unknown as RegisterTool

  tool(
    'get_guide',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        'Read the Doop agent guide: mandatory review checkpoints, the streaming workflow, frame sizing, design-quality doctrine, and multiplayer etiquette. Call with topic "doop-instructions" ONCE before using other Doop tools; call again if a long conversation may have compressed earlier context. Use the other topics ("streaming", "review", "images", "redesign") to re-load just one section after a compaction instead of the whole guide.',
      inputSchema: {
        topic: z
          .enum(GUIDE_TOPICS)
          .describe(
            'Which part of the guide to load. "doop-instructions" is the full guide and the one to read first.',
          ),
      },
      outputSchema: { topic: z.string(), guide: z.string() },
    },
    async ({ topic }) => {
      const guide = guideFor(topic)
      return { content: [{ type: 'text' as const, text: guide }], structuredContent: { topic, guide } }
    },
  )

  tool(
    'search_inspiration',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Search design inspiration',
      description:
        'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails of each, with pre-distilled style facts (one-line mood north star, named palette, fonts). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages: query the page archetype plus the register you want ("law firm landing page, editorial", "dark fintech dashboard"), not just the product noun. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
      inputSchema: {
        query: z
          .string()
          .describe('Page archetype + register, e.g. "grocery delivery landing page, warm", "dark fintech dashboard"'),
        count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
        canvas_id: z
          .string()
          .optional()
          .describe('The canvas you are designing on — keeps this call attributed on the canvas run timeline'),
        agent_name: agentName,
      },
    },
    async ({ query, count, agent_name }, extra) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate_limited', 'search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        await progress(extra, 0, `Searching real designs for “${query}”…`)
        const results = await searchInspiration(query, count ?? 4)
        await progress(extra, 1, `Searched real designs for “${query}”.`)
        if (results.length === 0)
          return text({ ok: true, results: [], note: `No inspiration for "${query}" — try a broader category.` })
        const thumbs = await Promise.all(results.map((r) => imageSearch.fetchThumb(r.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${results.length} exemplar(s) for "${query}" — study each thumbnail with its style facts:`,
          },
        ]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: describeInspiration(r, i) })
        })
        content.push({ type: 'text' as const, text: INSPIRATION_USAGE_NOTE })
        const result = { content }
        return result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'inspiration search failed')
      }
    },
  )

  tool(
    'list_canvases',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        "List the connected user's design canvases with their ids, names and frame counts, newest first. Paged — follow has_more instead of assuming the list is complete.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).describe('Canvases to return, default 50, max 200'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip, for paging'),
      },
      outputSchema: { canvases: z.array(z.object(canvasListItemShape)), ...pagedShape },
    },
    /* '' matches no ownerId: a session without a user sees nothing */
    async ({ limit, offset }) => {
      const all = store.listCanvases(ownerId ?? '').map((m) => ({
        ...m,
        /* count what get_canvas will actually return — demo frames are hidden from agents */
        frameCount: store.getCanvas(m.id)?.frames.filter((f) => !f.demo).length ?? m.frameCount,
        guidelinesCount: store.getGuidelines(m.id).length,
      }))
      const canvases = all.slice(offset, offset + limit)
      return structured({
        canvases,
        total: all.length,
        has_more: offset + canvases.length < all.length,
        ...(offset + canvases.length < all.length ? { next_offset: offset + canvases.length } : {}),
      })
    },
  )

  tool(
    'create_canvas',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description: 'Create a new design canvas. Returns the canvas id, which is part of the shareable URL (/c/<id>).',
      inputSchema: {
        name: z.string().max(200).describe('Canvas name'),
        op_id: opId,
        agent_name: agentName.optional(),
      },
      outputSchema: { id: z.string(), name: z.string(), url: z.string(), idempotent_replay: z.boolean().optional() },
    },
    async ({ name, op_id }) => {
      /* owned by the connecting user — an ownerless canvas would be invisible
         on every dashboard (and was once visible on all of them) */
      return structured(
        replay(ownerId ?? '', op_id, () => {
          const canvas = store.createCanvas(name, ownerId)
          return { id: canvas.id, name: canvas.name, url: `/c/${canvas.id}` }
        }),
      )
    },
  )

  tool(
    'get_canvas',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        'Get a canvas: its name, its ordered pages, and every frame with position, size and metadata (not the HTML — use get_frame for that). Use this to see the current layout before adding or editing frames. Pass your agent_name so this read is attributed to you and your presence stays live.',
      inputSchema: {
        canvas_id: z.string(),
        frames_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Frames to list, default 50, max 200 — page through the rest with list_frames'),
        agent_name: agentName.optional(),
      },
      outputSchema: canvasViewShape,
    },
    async ({ canvas_id, agent_name, frames_limit }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const docs = store.getGuidelines(canvas_id)
      const refs = store.getReferences(canvas_id)
      /* demo frames (the Doop welcome show, seeded examples) are product
         content, not user work — hidden so agents never mistake them for
         the canvas's established style */
      const visible = c.frames.filter((f) => !f.demo)
      const shown = visible.slice(0, frames_limit)
      const truncated = visible.length > shown.length
      /* design-synced canvases carry a flow map: real user navigation between
         the synced screens — context a redesign must respect */
      const flow = describeSyncFlow(await getSyncFlow(c), c.frames)
      const notes = [
        ...(flow.length
          ? [
              'This canvas is synced from a live app and `flow` shows how its screens connect — including how often real users take each path. Do not bury or weaken elements that carry heavy navigation.',
            ]
          : []),
        ...(docs.length
          ? [
              'This canvas has style guides. Call get_guidelines for each relevant one BEFORE designing — every frame must follow them.',
            ]
          : []),
        ...(refs.length
          ? [
              'This canvas has pinned style references — exemplar designs humans marked as "more like this". Call get_reference on the relevant one and match its look (palette, type, spacing) in what you design.',
            ]
          : []),
        ...(c.frames.some((f) => f.html.length > 60_000)
          ? [
              'Frames marked large: true hold a big document — read them with get_frame_html (a bounded slice, or a query) and inspect_frame (the rendered result) instead of get_frame.',
            ]
          : []),
        ...(truncated
          ? [
              `This canvas holds ${visible.length} frames and only the first ${shown.length} are listed here. Page through the rest with list_frames({ canvas_id, limit, offset }) — or filter with updated_since to see just what changed.`,
            ]
          : []),
        ...(c.tokens
          ? ['This canvas has design tokens — read them with get_tokens and use those exact colors, fonts and scales.']
          : []),
      ]
      const view: CanvasViewWithBreakpoints = {
        id: c.id,
        name: c.name,
        frames: shown.map((f) =>
          frameSummary(
            f,
            c.pages?.find((p) => p.id === f.pageId),
          ),
        ),
        frame_total: visible.length,
        ...(truncated ? { frames_truncated: true as const } : {}),
        pages: (c.pages ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          frameCount: c.frames.filter((f) => f.pageId === p.id).length,
        })),
        guidelines: docs.map((d) => ({
          name: d.name,
          title: actions.guidelineTitle(d),
          summary: actions.guidelineSummary(d),
          bytes: d.markdown.length,
        })),
        references: refs.map((r) => ({
          id: r.id,
          title: r.title,
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          htmlBytes: r.html.length,
          pinnedBy: r.pinnedBy,
        })),
        ...(flow.length ? { flow } : {}),
        ...(c.breakpoints?.length ? { breakpoints: c.breakpoints } : {}),
        tokens_present: !!c.tokens,
        /* the canvas's policy, so an agent knows how its writes will land
           (review mode) and who else can reach the canvas (link access)
           before it writes anything */
        review_mode: !!c.reviewMode,
        link_access: c.linkAccess ?? 'none',
        ...(notes.length ? { note: notes.join(' ') } : {}),
      }
      return structured(view)
    },
  )

  tool(
    'list_frames',
    {
      description:
        "Page through a canvas's frames without pulling their HTML: id, name, page, position, size, who last touched each one and when, plus a public image_url. Use it when get_canvas reported frames_truncated, or to poll a busy canvas for what changed since you last looked (updated_since).",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        page: z.string().optional().describe('Only frames on this page (name or id, from get_canvas)'),
        limit: z.number().int().min(1).max(200).default(50).describe('Frames to return, default 50, max 200'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip, for paging'),
        updated_since: z
          .string()
          .optional()
          .describe('ISO timestamp — only frames changed after it (e.g. the updatedAt of the last frame you read)'),
        agent_name: agentName.optional(),
      },
      outputSchema: { frames: z.array(z.object(frameSummaryShape)), ...pagedShape },
    },
    async ({ canvas_id, page, limit, offset, updated_since, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      let pageId: string | undefined
      if (page !== undefined) {
        const resolved = resolvePage(canvas_id, page)
        if (resolved.error !== undefined) return err('invalid_input', resolved.error)
        pageId = resolved.page.id
      }
      const since = updated_since === undefined ? undefined : Date.parse(updated_since)
      if (since !== undefined && Number.isNaN(since))
        return err('invalid_input', `updated_since is not an ISO timestamp: ${updated_since}`)
      await arrive(canvas_id, agent_name)
      const all = c.frames
        .filter((f) => !f.demo)
        .filter((f) => pageId === undefined || f.pageId === pageId)
        .filter((f) => since === undefined || f.updatedAt > since)
      const frames = all.slice(offset, offset + limit)
      const hasMore = offset + frames.length < all.length
      return structured({
        frames: frames.map((f) =>
          frameSummary(
            f,
            c.pages?.find((p) => p.id === f.pageId),
          ),
        ),
        total: all.length,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + frames.length } : {}),
      })
    },
  )

  tool(
    'list_guidelines',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        "List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries. Fetch the full text of the relevant ones with get_guidelines before designing. Pass agent_name: it keeps your presence live on the canvas and attributes this call on the run timeline.",
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
      outputSchema: {
        guidelines: z.array(z.object(guidelineSummaryShape)),
        note: z.string().optional(),
      },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      const docs = store.getGuidelines(canvas_id)
      if (docs.length === 0)
        return structured({
          guidelines: [],
          note: 'No style guides on this canvas yet. Set one with set_guidelines when a human hands you brand or style rules.',
        })
      return structured({
        guidelines: docs.map((d) => ({
          name: d.name,
          title: actions.guidelineTitle(d),
          summary: actions.guidelineSummary(d),
          bytes: d.markdown.length,
          updatedAt: new Date(d.updatedAt).toISOString(),
          updatedBy: d.updatedBy,
        })),
      })
    },
  )

  tool(
    'get_guidelines',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        "Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow. If get_canvas listed style guides, read the relevant ones with this BEFORE creating or restyling frames. Pass agent_name: it keeps your presence live on the canvas and attributes this call on the run timeline.",
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc name from get_canvas / list_guidelines, e.g. "feature-image"'),
        agent_name: agentName,
      },
      outputSchema: {
        canvas_id: z.string(),
        name: z.string(),
        title: z.string(),
        markdown: z.string(),
      },
    },
    async ({ canvas_id, name, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const doc = store.getGuidelines(canvas_id).find((d) => d.name === name.trim().toLowerCase())
      if (!doc) {
        const names = store.getGuidelines(canvas_id).map((d) => d.name)
        return err(
          'not_found',
          names.length
            ? `no style guide named “${name}” — this canvas has: ${names.join(', ')}`
            : `no style guides on this canvas yet`,
        )
      }
      if (agent_name) actions.markGuidelinesSeen(canvas_id, actorFrom(agent_name).name)
      return {
        content: [{ type: 'text' as const, text: doc.markdown }],
        structuredContent: { canvas_id, name: doc.name, title: actions.guidelineTitle(doc), markdown: doc.markdown },
      }
    },
  )

  tool(
    'set_guidelines',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        "Create, replace or delete a named style guide on a canvas (markdown, max 24,000 chars; empty string deletes). Write rules other designers and agents can execute directly: palette hexes, font <link>s, ready-to-paste <style> blocks, logo asset URLs (upload files with upload_asset first and reference the returned URLs), layout recipes, do/don't lists.",
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().describe('Doc slug, e.g. "feature-image" (a-z, 0-9, hyphens)'),
        markdown: z
          .string()
          .max(actions.MAX_GUIDELINE_CHARS)
          .describe('Full replacement markdown for this doc; empty string deletes it'),
        title: z
          .string()
          .max(actions.MAX_GUIDELINE_TITLE_CHARS)
          .optional()
          .describe('Pretty display name shown to humans, e.g. "Featured Images"; omit to keep the current one'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, markdown, title, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const doc = actions.setGuideline(canvas_id, name, markdown, actor, undefined, title)
        actions.markGuidelinesSeen(canvas_id, actor.name)
        return text(
          doc
            ? { ok: true, name: doc.name, title: actions.guidelineTitle(doc), bytes: doc.markdown.length }
            : { ok: true, deleted: true },
        )
      } catch (e) {
        if (e instanceof actions.ReviewModeError) throw e
        return err('invalid_input', e instanceof Error ? e.message : 'invalid guideline doc')
      }
    },
  )

  tool(
    'get_reference',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        'Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this"). References are listed by get_canvas. Match its palette, typography and spacing when designing on this canvas — it is the ground truth for the canvas\'s style. Pass agent_name: it keeps your presence live on the canvas and attributes this call on the run timeline.',
      inputSchema: {
        canvas_id: z.string(),
        reference_id: z.string().describe('Reference id from get_canvas'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, reference_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const ref = store.getReferences(canvas_id).find((r) => r.id === reference_id)
      if (!ref) {
        const ids = store.getReferences(canvas_id).map((r) => `${r.id} (“${r.title}”)`)
        return err(
          'not_found',
          ids.length
            ? `no reference with id ${reference_id} — this canvas has: ${ids.join(', ')}`
            : 'no style references pinned on this canvas yet',
        )
      }
      return text({
        id: ref.id,
        title: ref.title,
        width: ref.width,
        height: ref.height,
        pinnedBy: ref.pinnedBy,
        html: ref.html,
      })
    },
  )

  tool(
    'save_decision',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Record a design decision your human made while talking to YOU — style feedback you carried out ("rounder corners", "less purple, more white and blue", "stop using italic serif"). Doop\'s UI feedback is captured automatically, but you are the only one who hears your own conversation, so report it with this tool AFTER you have addressed it. It lands in the canvas\'s Memory; recurring preferences become suggested style rules. Record design taste only — not one-off content edits like typo fixes or copy changes.',
      inputSchema: {
        canvas_id: z.string(),
        decision: z
          .string()
          .max(actions.MAX_DECISION_CHARS)
          .describe('The feedback in the human\'s own words, e.g. "make it less claude-esque, more white and blue"'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, decision, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        const saved = actions.recordChatDecision(canvas_id, decision, actor)
        if (saved === undefined) return err('not_found', `no canvas with id ${canvas_id}`)
        return text(
          saved
            ? { ok: true, note: 'Saved to the canvas Memory. Recurring preferences become suggested style rules.' }
            : { ok: true, note: 'Already in Memory — this exact decision was recorded before.' },
        )
      } catch (e) {
        if (e instanceof actions.ReviewModeError) throw e
        return err('invalid_input', e instanceof Error ? e.message : 'invalid decision')
      }
    },
  )

  tool(
    'whoami',
    {
      title: 'Who am I on this server',
      description:
        'The identity your tool calls run as: the account behind the connection, the agent name you are posting under, and what that means for your work. Agent names are free text — two accounts can both call themselves the same thing — so this is how you tell which identity is yours when a canvas shows a name you did not expect. agent_id is that identity’s durable id: it stays the same when you reconnect under the same name, which is what a per-agent permission on a canvas is filed against.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { agent_name: agentName.optional() },
      outputSchema: {
        account: z.string().optional(),
        account_id: z.string().optional(),
        agent_id: z.string().optional(),
        agent_name: z.string(),
        note: z.string(),
      },
    },
    async ({ agent_name }) => {
      const identity = actions.resolveActor({ name: agent_name, kind: 'agent', owner, ownerId })
      const agentId = await agentIdentity(ownerId, identity.name, clientId)
      session.agentId = agentId ?? session.agentId
      return structured({
        ...(owner ? { account: owner } : {}),
        ...(ownerId ? { account_id: ownerId } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
        agent_name: identity.name,
        note: ownerId
          ? 'Your work, comments and claims are scoped to this account — another account using the same agent name is a different agent here.'
          : 'This connection has no account behind it, so your agent name is the only thing identifying you on a canvas.',
      })
    },
  )

  /* ---- cross-canvas memory: what this account taught doop about its taste ---- */

  tool(
    'get_memory',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read your account’s memory',
      description:
        'What the connected account has taught Doop about its taste, kept across canvases: preferences, brand rules and working workflows. Read it when starting work on a canvas you have never seen — a new canvas does not start from zero.',
      inputSchema: { agent_name: agentName.optional() },
      outputSchema: {
        memories: z.array(
          z.object({
            id: z.string(),
            kind: z.enum(['preference', 'brand', 'workflow']),
            text: z.string(),
            source_canvas_id: z.string().optional(),
            created_at: z.number(),
          }),
        ),
      },
    },
    async () => {
      /* the memory is the account's, not the agent's: every connection under
         one account reads and writes the same rows */
      if (!ownerId) return err('unsupported', 'memory is keyed by account — connect with an account token to use it')
      return structured({
        memories: actions.getUserMemory(ownerId).map((m) => ({
          id: m.id,
          kind: m.kind,
          text: m.text,
          ...(m.sourceCanvasId ? { source_canvas_id: m.sourceCanvasId } : {}),
          created_at: m.createdAt,
        })),
      })
    },
  )

  tool(
    'remember',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Record a durable preference',
      description:
        'Teach Doop something durable about this account that outlives the canvas: a styling preference ("likes generous whitespace"), a brand rule ("never use pure black"), a workflow ("wants mobile-first drafts first"). One fact per call, one or two sentences — not a work log. Read everything back with get_memory.',
      inputSchema: {
        kind: z
          .enum(['preference', 'brand', 'workflow'])
          .describe('preference = taste, brand = identity rules, workflow = how they like work done'),
        text: z.string().min(1).max(500).describe('The fact itself, one or two sentences'),
        canvas_id: z.string().optional().describe('The canvas the fact came from, for provenance'),
        op_id: opId,
        agent_name: agentName.optional(),
      },
      outputSchema: { ok: z.literal(true), id: z.string() },
    },
    async ({ kind, text, canvas_id, op_id }) => {
      if (!ownerId) return err('unsupported', 'memory is keyed by account — connect with an account token to use it')
      /* the row rides in a wrapper because replay cannot carry undefined: a
         factory that returns one is a call that never landed, not a payload */
      const saved = replay(ownerId, op_id, (): { memory?: UserMemory } => {
        const row = actions.remember(ownerId, kind, text, canvas_id)
        return row ? { memory: row } : {}
      })
      if (!saved.memory) return err('conflict', 'the same memory already exists')
      return structured({ ok: true as const, id: saved.memory.id })
    },
  )

  tool(
    'get_agents',
    {
      title: 'List the roles and who is on this canvas',
      description:
        'The roles this canvas organises work by, and who is live on it right now: each role with what it is for, and every agent currently present on the canvas, with the durable agent_id each one answers to. Roles are the vocabulary a human uses when they @mention one in an element comment — no agent is attached to a role; the agents are MCP clients connected to this canvas, and whichever of them is right for the work picks it up from the comment. Use it to see whether the agent you expected is actually connected.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
      outputSchema: {
        roles: z.array(z.object({ id: z.string(), name: z.string(), blurb: z.string() })),
        connected: z.array(
          z.object({ agent: z.string(), owner: z.string().optional(), agent_id: z.string().optional() }),
        ),
      },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      /* Presence is the record of who is here — an agent is named by the calls
         it makes. The ACCOUNT behind the connection is half of that identity
         and the durable agent_id is the other half: an agent name is free text,
         so two accounts both running "Claude" are two agents, not one. */
      const connected = new Map<string, { agent: string; owner?: string; agent_id?: string }>()
      for (const p of actions.listAgentPresence(canvas_id)) {
        const key = `${p.ownerId ?? ''}::${p.name}`
        if (connected.has(key)) continue
        const id = p.ownerId ? agentIds.get(agentKey(p.ownerId, p.name)) : undefined
        connected.set(key, {
          agent: p.name,
          ...(p.owner ? { owner: p.owner } : {}),
          ...(id ? { agent_id: id } : {}),
        })
      }
      return structured({
        roles: AGENT_ROLES.map((r) => ({ id: r.id, name: r.name, blurb: r.blurb })),
        connected: [...connected.values()],
      })
    },
  )

  tool(
    'get_comments',
    {
      description:
        'Read element-pinned comments and replies on a canvas, newest first, including author, text, frame, CSS selector, HTML snippet, parentId thread links, and claim/failure/resolution metadata. Includes resolved comments by default so complete conversations remain readable; set include_resolved to false for unresolved comments only. Returns the retained comment history (up to 100 entries per canvas), not an archive; paged, so follow has_more. Reading a comment claims nothing: claim_comment takes the notes @mentioned to your role, reply_to_comment answers in-thread, resolve_comment closes one, and fail_comment reports one you could not do.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string().optional().describe('Only comments on this frame; it must belong to the canvas.'),
        include_resolved: z.boolean().default(true).describe('Include resolved comments and replies. Default true.'),
        limit: z.number().int().min(1).max(100).default(50).describe('Comments to return, default 50, max 100'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip, for paging (newest first)'),
        agent_name: agentName.optional(),
      },
      outputSchema: { comments: z.array(z.object(commentShape)), ...pagedShape },
    },
    async ({ canvas_id, frame_id, include_resolved, limit, offset, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (frame_id !== undefined) {
        const frame = frameFor(frame_id)
        if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
      }
      await arrive(canvas_id, agent_name)
      const all = actions
        .getComments(canvas_id)
        .filter((comment) => frame_id === undefined || comment.frameId === frame_id)
        .filter((comment) => include_resolved || comment.resolvedAt === undefined)
      const comments = all.slice(offset, offset + limit).map((comment) => ({
        ...comment,
        anchor: anchorState(store.getFrame(comment.frameId)?.html ?? '', comment),
      }))
      const hasMore = offset + comments.length < all.length
      /* Deliberately no claim here: inspecting comments must not take work. */
      return structured({
        comments,
        total: all.length,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + comments.length } : {}),
      })
    },
  )

  tool(
    'claim_comment',
    {
      title: 'Claim the comments addressed to you',
      description:
        'Take the element comments a human @mentioned your role in, so two connected agents do not both do the same note: each one is claimed under your agent_name and its pin flips to "you are on it" for the human watching. Humans address work by @mentioning a role, so pass role: "<id>" (doop, ux, copy, brand, a11y, polish) to take the notes for the role you are working — without it your agent_name decides, which takes the notes addressed to you by name, or to the role your name itself names (an agent connected as "a11y" or "Accessibility" already covers that role). Returns the notes it claimed — id, frame, selector, the text the human wrote and who wrote it — and an empty list when nothing is addressed to that role (not an error). Idempotent per comment: claiming again returns nothing, because the note is already yours. Do the work, answer in the thread with reply_to_comment, and close the note with resolve_comment; call fail_comment instead when you cannot finish it.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName,
        role: z
          .string()
          .optional()
          .describe(
            'The role you are working, as an id or a name (e.g. "a11y" or "Accessibility"). Notes are addressed to roles, so pass this when your agent_name is your own name rather than a role.',
          ),
      },
      outputSchema: { comments: z.array(z.object(commentShape)) },
    },
    async ({ canvas_id, agent_name, role }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const wanted = roleFor(role)
      if (role && !wanted)
        return err('invalid_input', `no role "${role}" — the roles are ${AGENT_ROLES.map((r) => r.id).join(', ')}`)
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      /* `payer` stays undefined: a note is addressed to a ROLE, so whichever
         agent is connected to work that role may pick it up, on any account. */
      const comments = actions.takeAgentCommentsFor(
        canvas_id,
        actor.name,
        undefined,
        actor.ownerId,
        wanted ? wanted.name : undefined,
      )
      if (comments.length === 0) {
        /* Say which identity was actually searched, and push the role argument
           ONLY at an agent that has no role at all. An agent named after a role
           is already claiming that role's notes — telling it to "pass role"
           would be advice it cannot act on, and "by name" would be false. Same
           resolver the claim itself uses, so the message cannot contradict it. */
        const searching = wanted ?? roleFor(actor.name)
        return structuredWithNudge(
          { comments },
          searching
            ? `Nothing is addressed to the ${searching.name} role right now — you are already taking that role's notes. Read what is waiting with get_comments.`
            : `Nothing is addressed to ${actor.name} by name right now. Humans address work by @mentioning a role, so pass role: "<id>" (one of ${AGENT_ROLES.map((r) => r.id).join(', ')}) to take the notes for the role you work — or read what is waiting with get_comments.`,
        )
      }
      return structured({ comments })
    },
  )

  tool(
    'add_comment',
    {
      title: 'Pin a comment to an element',
      description:
        "Leave a note pinned to one element inside a frame — use it to record what you changed and why, or to ask a human a question about a specific element. selector is a CSS selector for the element: get one from inspect_frame's elements[].selector, or from an existing comment. Pass snippet (the element's outerHTML excerpt) when you have it so the pin still makes sense if the element moves. Humans see this as a pin on the canvas.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        selector: z.string().max(2000).describe('CSS selector of the element to pin to'),
        stable_key: z
          .string()
          .max(300)
          .optional()
          .describe(
            "The element's key from inspect_frame or get_element — the pin follows the content when the selector goes stale",
          ),
        snippet: z.string().max(10_000).optional().describe("The element's outerHTML excerpt, for context"),
        text: z.string().max(10_000).describe('The comment text'),
        op_id: opId,
        agent_name: agentName,
      },
    },
    async ({ frame_id, selector, stable_key, snippet, text: body, agent_name, op_id }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const gated = reviewGate(f.canvasId)
      if (gated) return gated
      const payload = replay(ownerId ?? '', op_id, () => {
        const comment = actions.addElementComment(
          frame_id,
          { selector, snippet: snippet ?? '', text: body, ...(stable_key ? { stableKey: stable_key } : {}) },
          actorFrom(agent_name),
        )
        return comment ?? { ok: false as const }
      })
      if ('ok' in payload && payload.ok === false) return err('not_found', 'could not add the comment — empty text?')
      return structured(payload as ElementComment)
    },
  )

  tool(
    'reply_to_comment',
    {
      title: 'Reply in a comment thread',
      description:
        "Reply inside an existing element-comment thread. The reply inherits the thread's element anchor, so it stays pinned to the same thing the conversation is about. Use this to answer a human's question on your work, or to record what you did about their note. Resolve the thread with resolve_comment once the note is addressed.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        comment_id: z.string(),
        text: z.string().max(10_000).describe('The reply text'),
        agent_name: agentName,
      },
    },
    async ({ comment_id, text: body, agent_name }) => {
      const found = actions.findComment(comment_id)
      if (!found) return err('not_found', `no comment with id ${comment_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      const reply = actions.replyToComment(comment_id, body, actorFrom(agent_name))
      if (!reply) {
        return err(
          'invalid_input',
          'the thread is resolved or the text is empty — resolve_comment cannot be undone by replying',
        )
      }
      return text(reply)
    },
  )

  tool(
    'resolve_comment',
    {
      title: 'Resolve a comment thread',
      description:
        'Mark an element-comment thread as resolved — do this once the note it carries has actually been addressed in the design. Resolving a root comment closes its whole thread. Humans can see who resolved it; nothing is deleted, and the conversation stays readable with get_comments.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: { comment_id: z.string(), agent_name: agentName },
    },
    async ({ comment_id, agent_name }) => {
      const found = actions.findComment(comment_id)
      if (!found) return err('not_found', `no comment with id ${comment_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      const resolved = actions.resolveComment(comment_id, actorFrom(agent_name))
      if (!resolved) return err('not_found', `no comment with id ${comment_id}`)
      return text({ ok: true, id: resolved.id, resolved: resolved.resolvedAt !== undefined })
    },
  )

  tool(
    'fail_comment',
    {
      title: 'Say you could not do a comment',
      description:
        'Report that you cannot carry out a comment you claimed, with the reason. The pin flips to "stopped" with the reason for the human, who can retry it (which clears the claim so any agent can pick it up again). Use this instead of resolve_comment when the note is not actually addressed — a pin that hangs forever teaches the human nothing, and a false resolve teaches them worse.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        comment_id: z.string(),
        reason: z.string().max(500).describe('Why you could not do it, in one line the human will read'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), id: z.string(), failed: z.boolean() },
    },
    async ({ comment_id, reason, agent_name }) => {
      const found = actions.findComment(comment_id)
      if (!found) return err('not_found', `no comment with id ${comment_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      await arrive(found.canvasId, agent_name)
      const failed = actions.failComment(comment_id, reason.trim())
      if (!failed) return err('invalid_input', 'that comment is already resolved — there is nothing to fail')
      return structured({ ok: true as const, id: failed.id, failed: failed.failedAt !== undefined })
    },
  )

  tool(
    'edit_comment',
    {
      title: 'Rewrite a note you wrote',
      description:
        'Rewrite the text of a comment you wrote — correct a typo, or sharpen what you asked for now that you know more. The edit is the same note, not a new one: the id, the element anchor and its place in the thread all stay, so the replies under it keep their positions and a reader who already saw the note reads the correction on its next call. Only the author may rewrite a note; another agent’s attempt is refused with forbidden naming the author, and the way to answer a note that is not yours is reply_to_comment.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        comment_id: z.string().describe('The comment to rewrite, from get_comments'),
        text: z.string().max(10_000).describe('The new text — it replaces what the note said'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), id: z.string(), text: z.string(), state: z.enum(COMMENT_STATES) },
    },
    async ({ comment_id, text: body, agent_name }) => {
      const found = actions.findComment(comment_id)
      if (!found) return err('not_found', `no comment with id ${comment_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      await arrive(found.canvasId, agent_name)
      let updated: ElementComment | undefined
      try {
        updated = actions.updateElementComment(comment_id, body, actorFrom(agent_name))
      } catch (e) {
        const refusal = ownerRefusal(e)
        if (refusal) return refusal
        throw e
      }
      /* an edit to nothing is what the action refuses: there is no text to
         store, so the note keeps what it said */
      if (!updated) return err('invalid_input', 'the new text is empty — the note still says what it said')
      return structured({
        ok: true as const,
        id: updated.id,
        text: updated.text,
        state: commentState(updated),
      })
    },
  )

  tool(
    'unclaim_comment',
    {
      title: 'Give a claimed note back',
      description:
        'Give back a note you claimed with claim_comment — use it when the work turns out to be outside what you can do, or the frame moved on and the note is stale. Its pin stops saying you are on it and another agent can pick the note up in your place. The claim is the claimant’s to release: another agent’s attempt is refused with forbidden naming the holder, and a note nobody holds has nothing to release. A note you genuinely tried and could not finish is fail_comment’s job instead — that leaves the reason for the human, which giving the claim back does not.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        comment_id: z.string().describe('The comment you claimed, from get_comments'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), id: z.string(), state: z.enum(COMMENT_STATES) },
    },
    async ({ comment_id, agent_name }) => {
      const found = actions.findComment(comment_id)
      if (!found) return err('not_found', `no comment with id ${comment_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      await arrive(found.canvasId, agent_name)
      let released: ElementComment | undefined
      try {
        released = actions.unclaimComment(comment_id, actorFrom(agent_name))
      } catch (e) {
        const refusal = ownerRefusal(e)
        if (refusal) return refusal
        throw e
      }
      if (!released) return err('not_found', `no comment with id ${comment_id}`)
      return structured({ ok: true as const, id: released.id, state: commentState(released) })
    },
  )

  tool(
    'get_focus',
    {
      title: 'See what the humans are looking at',
      description:
        'What every connected human on this canvas is looking at right now: the frame, the element selector and the page, with how recently each moved. Use it when a human says "fix this" or "this one" — it is how you find out which element they mean. An empty humans array means nobody is connected, not an error.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
      outputSchema: {
        humans: z.array(
          z.object({
            name: z.string(),
            frame_id: z.string().optional(),
            selector: z.string().optional(),
            page_id: z.string().optional(),
            at: z.number(),
          }),
        ),
        latest: z
          .object({
            name: z.string(),
            frame_id: z.string().optional(),
            selector: z.string().optional(),
            page_id: z.string().optional(),
            at: z.number(),
          })
          .nullable(),
      },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      /* nulls are dropped rather than sent: "looking at the canvas, no element
         in particular" is the absence of a field, not a null the caller has to
         branch on */
      const humans = actions.listCanvasFocus(canvas_id).map((f) => ({
        name: f.name,
        ...(f.frameId ? { frame_id: f.frameId } : {}),
        ...(f.selector ? { selector: f.selector } : {}),
        ...(f.pageId ? { page_id: f.pageId } : {}),
        at: f.at,
      }))
      return structured({ humans, latest: humans[0] ?? null })
    },
  )

  /* ---- component library: reusable pieces an instance marker binds into frames ---- */

  /** The summary shape list_components and search_components publish: metadata
   *  and usage, never the HTML — the full document is get_component's job. */
  const componentSummaryShape = {
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    width: z.number(),
    height: z.number(),
    variant_of: z.string().optional(),
    instance_count: z.number(),
    updated_at: z.string(),
    updated_by: z.string(),
    html_bytes: z.number(),
  }
  const componentSummary = (
    component: Component,
    instances: { frameId: string; canvasId: string; name: string }[],
  ) => ({
    id: component.id,
    name: component.name,
    ...(component.description ? { description: component.description } : {}),
    width: component.width,
    height: component.height,
    ...(component.variantOf ? { variant_of: component.variantOf } : {}),
    /* distinct frames on this canvas carrying the marker — componentsUsing is
       per-frame, so the filter is what keeps a foreign frame out of the count */
    instance_count: instances.filter((u) => u.canvasId === component.canvasId).length,
    updated_at: new Date(component.updatedAt).toISOString(),
    updated_by: component.updatedBy,
    html_bytes: component.html.length,
  })

  tool(
    'list_components',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'List the component library',
      description:
        'List the canvas’s reusable components — saved pieces (a nav bar, a pricing card) that can be inserted into any frame with insert_component and updated once for every instance with update_component. Metadata and instance counts only; the markup comes from get_component.',
      inputSchema: {
        canvas_id: z.string(),
        limit: z.number().int().min(1).max(200).default(50).describe('Components to return, default 50, max 200'),
        offset: z.number().int().min(0).default(0).describe('Rows to skip, for paging'),
        agent_name: agentName.optional(),
      },
      outputSchema: { components: z.array(z.object(componentSummaryShape)), total: z.number(), truncated: z.boolean() },
    },
    async ({ canvas_id, limit, offset, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const all = store.listComponents(canvas_id)
      /* one usage scan for the whole page: componentsUsing is cheap, but the
         same instance set answers every summary in it */
      const usage = new Map(all.map((c) => [c.id, actions.componentsUsing(c.id)]))
      const shown = all.slice(offset, offset + limit)
      return structured({
        components: shown.map((c) => componentSummary(c, usage.get(c.id) ?? [])),
        total: all.length,
        truncated: offset + shown.length < all.length,
      })
    },
  )

  tool(
    'search_components',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Search the component library',
      description:
        'Find saved components by name or description — "pricing", "nav", "testimonial". Same summaries as list_components; use it instead of paging the whole library when you know what kind of piece you want.',
      inputSchema: {
        canvas_id: z.string(),
        query: z.string().min(1).max(200).describe('Words from the component’s name or description'),
        limit: z.number().int().min(1).max(20).default(10).describe('Matches to return, default 10, max 20'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        components: z.array(z.object(componentSummaryShape)),
        total: z.number(),
        truncated: z.boolean(),
      },
    },
    async ({ canvas_id, query, limit, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const needle = query.trim().toLowerCase()
      const matches = store
        .listComponents(canvas_id)
        .filter((c) => c.name.toLowerCase().includes(needle) || (c.description ?? '').toLowerCase().includes(needle))
      const shown = matches.slice(0, limit)
      const usage = new Map(shown.map((c) => [c.id, actions.componentsUsing(c.id)]))
      return structured({
        components: shown.map((c) => componentSummary(c, usage.get(c.id) ?? [])),
        total: matches.length,
        truncated: matches.length > shown.length,
      })
    },
  )

  tool(
    'get_component',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read one component',
      description:
        'Read a component’s full markup and metadata before inserting or editing it. The html is capped at 30,000 characters; html_truncated: true means it was clipped — insert_component uses the stored document either way.',
      inputSchema: {
        component_id: z.string().describe('Component id from list_components or search_components'),
        agent_name: agentName.optional(),
      },
    },
    async ({ component_id, agent_name }) => {
      const component = store.getComponent(component_id)
      if (!component || !canvasFor(component.canvasId)) return err('not_found', `no component with id ${component_id}`)
      if (agent_name) await arrive(component.canvasId, agent_name)
      const clipped = component.html.length > MAX_HTML_READ_CHARS
      return structured({
        ...componentSummary(component, actions.componentsUsing(component_id)),
        canvas_id: component.canvasId,
        html: clipped ? component.html.slice(0, MAX_HTML_READ_CHARS) : component.html,
        ...(clipped ? { html_truncated: true as const } : {}),
        created_by: component.createdBy,
        created_at: component.createdAt,
      })
    },
  )

  tool(
    'create_component',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Save a component',
      description:
        'Save a reusable component on this canvas’s library: self-contained markup you will insert into frames (insert_component) and keep in sync across them (update_component propagates). width/height are the component’s natural artboard size in px — defaults to 640x480, the size a new frame gets, so pass the real size when the piece is a card or a band rather than a full page.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().min(1).max(200).describe('Library name, e.g. "Pricing card / dark"'),
        html: z
          .string()
          .min(1)
          .describe(
            `Self-contained markup for the piece — a fragment is fine. Max ${MAX_FRAME_HTML_BYTES} characters.`,
          ),
        description: z
          .string()
          .max(1000)
          .optional()
          .describe('What it is and when to reach for it — what search_components matches'),
        props: z
          .unknown()
          .optional()
          .describe('Free-form prop declarations agents may vary per instance, e.g. {"title": "string"}'),
        variant_of: z.string().optional().describe('Component id this one was derived from'),
        width: z.number().int().min(1).max(20_000).optional().describe('Natural width in px, default 640'),
        height: z.number().int().min(1).max(20_000).optional().describe('Natural height in px, default 480'),
        op_id: opId,
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, html, description, props, variant_of, width, height, agent_name, op_id }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (tooLarge(html))
        return err('too_large', `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}.`)
      /* the wrapper keeps replay type-safe across the undefined return: a
         failed create is a refusal below, not a payload to remember */
      const payload = replay(ownerId ?? '', op_id, (): { component?: Component } => ({
        component:
          actions.createComponent(
            canvas_id,
            {
              name,
              html,
              ...(description ? { description } : {}),
              ...(props !== undefined ? { props } : {}),
              ...(variant_of ? { variantOf: variant_of } : {}),
              ...(width !== undefined ? { width } : {}),
              ...(height !== undefined ? { height } : {}),
            },
            actorFrom(agent_name),
          ) ?? undefined,
      }))
      if (!payload.component) return noCanvas(canvas_id)
      return structured({
        ok: true as const,
        component: { ...componentSummary(payload.component, []), canvas_id: payload.component.canvasId },
      })
    },
  )

  tool(
    'update_component',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Update a component',
      description:
        'Edit a saved component once and let the change reach its instances: propagate: true (the default) re-renders every frame that carries the component and reports the frames updated and the ones skipped (with reasons — a locked frame is skipped, not blocked). Rename, re-describe, swap the markup or change its props here.',
      inputSchema: {
        component_id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(1000).optional(),
        html: z.string().min(1).optional().describe(`Full replacement markup. Max ${MAX_FRAME_HTML_BYTES} characters.`),
        props: z.unknown().optional(),
        propagate: z
          .boolean()
          .optional()
          .describe('Push the change into every frame carrying an instance (default true)'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        component: z.object(componentSummaryShape),
        updated: z.array(z.object({ frame_id: z.string(), name: z.string() })),
        skipped: z.array(z.object({ frame_id: z.string(), name: z.string(), reason: z.string() })),
      },
    },
    async ({ component_id, name, description, html, props, propagate, agent_name, op_id }) => {
      const outcome = await replayAsync(
        ownerId ?? '',
        op_id,
        async (): Promise<{ result?: NonNullable<ReturnType<typeof actions.updateComponent>> }> => ({
          result:
            (await actions.updateComponent(
              component_id,
              {
                ...(name !== undefined ? { name } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(html !== undefined ? { html } : {}),
                ...(props !== undefined ? { props } : {}),
              },
              actorFrom(agent_name),
              { propagate: propagate !== false },
            )) ?? undefined,
        }),
      )
      if (!outcome.result) return err('not_found', `no component with id ${component_id}`)
      return structured({
        ok: true as const,
        component: componentSummary(outcome.result.component, actions.componentsUsing(component_id)),
        updated: outcome.result.updated.map((u) => ({ frame_id: u.frameId, name: u.name })),
        skipped: outcome.result.skipped.map((s) => ({ frame_id: s.frameId, name: s.name, reason: s.reason })),
      })
    },
  )

  tool(
    'delete_component',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Delete a component',
      description:
        'Remove a component from the library (confirm: true). Refused while frames still hold instances — the instances’ markup is left alone either way, it simply stops being bound to a library entry; pass force: true to delete anyway.',
      inputSchema: {
        component_id: z.string(),
        confirm: z.literal(true).describe('Must be true — deleting unbinds every instance'),
        force: z.boolean().optional().describe('Delete even though frames still hold instances'),
        op_id: opId,
        agent_name: agentName,
      },
    },
    async ({ component_id, confirm, force, agent_name }) => {
      if (confirm !== true)
        return err('invalid_input', 'deleting a component unbinds its instances — pass confirm: true to go ahead')
      const component = store.getComponent(component_id)
      if (!component || !canvasFor(component.canvasId)) return err('not_found', `no component with id ${component_id}`)
      const using = actions.componentsUsing(component_id).filter((u) => u.canvasId === component.canvasId)
      if (using.length && !force)
        return err(
          'conflict',
          `${using.length} frame(s) still hold an instance (${using
            .slice(0, 5)
            .map((u) => u.name)
            .join(', ')}${using.length > 5 ? ', …' : ''}) — detach_component them first, or pass force: true`,
          {
            instance_frames: using.slice(0, 5).map((u) => ({ frame_id: u.frameId, name: u.name })),
            count: using.length,
            force_available: true,
          },
        )
      const outcome = actions.deleteComponent(component_id, actorFrom(agent_name), { force })
      if (!outcome) return err('not_found', `no component with id ${component_id}`)
      if (!outcome.deleted) return err('conflict', outcome.reason ?? 'the component still has instances')
      return text({ ok: true, deleted: component.name })
    },
  )

  tool(
    'insert_component',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Insert a component instance',
      description:
        'Insert a saved component into a frame: a single wrapper element carrying the component marker is placed under parent_selector (append, prepend, or a 0-based child index), with optional per-instance prop overrides. The instance tracks its component — update_component reaches it. Returns the new element’s selector.',
      inputSchema: {
        frame_id: z.string(),
        component_id: z.string().describe('Component id from list_components'),
        parent_selector: z.string().describe('The element to insert into, e.g. "main" or "#content"'),
        position: z
          .union([z.literal('append'), z.literal('prepend'), z.number().int().min(0).max(1000)])
          .describe('append, prepend, or a 0-based child index'),
        overrides: z
          .record(z.string(), z.string())
          .optional()
          .describe('Per-instance prop values overriding the component defaults, e.g. {"title": "Spring sale"}'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.unknown(), selector: z.string() },
    },
    async ({
      frame_id,
      component_id,
      parent_selector,
      position,
      overrides,
      agent_name,
      expected_updated_at,
      takeover,
    }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const component = store.getComponent(component_id)
      if (!component || !canvasFor(component.canvasId)) return err('not_found', `no component with id ${component_id}`)
      if (component.canvasId !== before.canvasId)
        return err(
          'forbidden',
          `component ${component_id} belongs to another canvas — create it there or copy it over first`,
        )
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = (
          await actions.insertComponent(
            frame_id,
            component_id,
            { parent_selector, position, ...(overrides ? { overrides } : {}) },
            actorFrom(agent_name),
          )
        )?.frame
      } catch (e) {
        if (e instanceof actions.ReviewModeError) throw e
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      /* the actions layer returns the wrapper's own selector with the frame */
      const selector = `[data-doop-component="${component_id}"]`
      return structuredWithNudge(
        { ok: true as const, frame: frameSummary(frame), selector },
        'Instance placed. Call get_frame_screenshot to see it in place, and pass the same selector to update_elements if it needs a nudge.',
      )
    },
  )

  tool(
    'detach_component',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Detach a component instance',
      description:
        'Unbind one component instance from its library entry: the wrapper element and its markup stay in the frame exactly as they are, but the component no longer tracks it — later update_component calls skip this frame. The selector is the wrapper carrying data-doop-component.',
      inputSchema: {
        frame_id: z.string(),
        selector: z.string().describe('The instance wrapper’s selector (from insert_component)'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.unknown() },
    },
    async ({ frame_id, selector, agent_name, expected_updated_at, takeover }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = (await actions.detachComponent(frame_id, selector, actorFrom(agent_name)))?.frame
      } catch (e) {
        if (e instanceof actions.ReviewModeError) throw e
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structured({ ok: true as const, frame: frameSummary(frame) })
    },
  )

  tool(
    'create_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Create a new frame on a canvas with an HTML design. A frame is a rectangular artboard that renders a full HTML document (inline <style> and <script> allowed, no external network access needed). If x/y are omitted the frame is auto-placed to the right of existing frames. Everyone viewing the canvas sees it appear live.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().max(200).describe('Frame title, e.g. "Landing hero" or "Pricing card"'),
        html: z
          .string()
          .describe(
            `Complete HTML for the frame body (a full document or a fragment; it is rendered in a sandboxed iframe). Max ${MAX_FRAME_HTML_BYTES} characters — stream larger designs with append_frame_html instead.`,
          ),
        x: z.number().min(-1_000_000).max(1_000_000).optional(),
        y: z.number().min(-1_000_000).max(1_000_000).optional(),
        width: z.number().min(1).max(20_000).optional().describe('Default 640'),
        height: z.number().min(1).max(20_000).optional().describe('Default 480'),
        page: z
          .string()
          .optional()
          .describe("Target page by id or exact name (see get_canvas). Defaults to the canvas's first page."),
        op_id: opId,
        agent_name: agentName,
      },
    },
    async ({ canvas_id, name, html, x, y, width, height, page, agent_name, op_id }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      if (tooLarge(html))
        return err(
          'too_large',
          `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}. Create the frame with a smaller opening document and stream the rest with append_frame_html.`,
        )
      let pageId: string | undefined
      if (page) {
        const resolved = resolvePage(canvas_id, page)
        if (resolved.error !== undefined) return err('invalid_input', resolved.error)
        pageId = resolved.page.id
      }
      const payload = replay(ownerId ?? '', op_id, () => {
        const frame = actions.createFrame(canvas_id, { name, html, x, y, width, height, pageId }, actorFrom(agent_name))
        if (!frame) return { ok: false as const }
        return {
          ok: true as const,
          frame: frameSummary(
            frame,
            c.pages?.find((p) => p.id === frame.pageId),
          ),
        }
      })
      if (!payload.ok) return noCanvas(canvas_id)
      const result = withEscapeNote(
        html.length > 0 ? structuredWithNudge(payload, REVIEW_NUDGE) : structured(payload),
        html,
      )
      return withGuidelinesNudge(result, canvas_id, actorFrom(agent_name))
    },
  )

  tool(
    'create_page',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Create a new page on a canvas. Pages are ordered sub-canvases that group frames — use them to build multi-screen flows, one page per screen. The page is appended at the end and starts empty.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().max(200).optional().describe('Page title, e.g. "Checkout". Defaults to "Page N".'),
        op_id: opId,
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, name, agent_name, op_id }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const payload = replay(ownerId ?? '', op_id, () => {
        const page = actions.createPage(
          canvas_id,
          pageName(name, `Page ${(c.pages?.length ?? 0) + 1}`),
          actorFrom(agent_name),
        )
        return page ? { id: page.id, name: page.name, position: page.position } : { ok: false as const }
      })
      if ('ok' in payload && payload.ok === false) return err('not_found', 'could not create the page')
      return withGuidelinesNudge(
        structured(payload as { id: string; name: string; position: number }),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'rename_page',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Rename a page. Pass the page id from get_canvas; the new name is trimmed and capped at 80 characters.',
      inputSchema: {
        page_id: z.string(),
        name: z.string().describe('New page title, e.g. "Checkout"'),
        agent_name: agentName.optional(),
      },
    },
    async ({ page_id, name, agent_name }) => {
      const found = pageForId(page_id)
      if (!found) return err('not_found', `no page with id ${page_id} accessible to this account`)
      await arrive(found.canvas.id, agent_name)
      const page = actions.renamePage(page_id, pageName(name, 'Untitled'), actorFrom(agent_name))
      if (!page) return err('not_found', 'could not rename the page')
      return withGuidelinesNudge(
        text({ id: page.id, name: page.name, position: page.position }),
        found.canvas.id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'delete_page',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Deletes the page AND every frame on it. The canvas keeps ≥1 page — deleting the last one is refused. Rescue frames you still need with move_frame first.',
      inputSchema: { page_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ page_id, agent_name }) => {
      const found = pageForId(page_id)
      if (!found) return err('not_found', `no page with id ${page_id} accessible to this account`)
      await arrive(found.canvas.id, agent_name)
      const result = actions.deletePage(page_id, actorFrom(agent_name))
      if (!result)
        return err(
          'invalid_input',
          'cannot delete the only page on this canvas — a canvas always keeps at least one page',
        )
      return withGuidelinesNudge(
        text({ ok: true, deletedPageId: result.page.id, deletedFrameIds: result.deletedFrameIds }),
        found.canvas.id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'move_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Move a frame to another page of its canvas (page by id or exact name — get_canvas lists both), optionally repositioning it with x/y in the same call. Use this to arrange screens across a multi-page flow.',
      inputSchema: {
        frame_id: z.string(),
        page: z.string().describe('Target page by id or exact name (see get_canvas)'),
        x: z.number().optional(),
        y: z.number().optional(),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, page, x, y, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const resolved = resolvePage(f.canvasId, page)
      if (resolved.error !== undefined) return err('invalid_input', resolved.error)
      const moved = actions.moveFrameToPage(frame_id, resolved.page.id, actorFrom(agent_name))
      if (!moved) return err('not_found', 'could not move the frame to the page')
      let frame = moved
      const reposition: { x?: number; y?: number } = {}
      if (x !== undefined) reposition.x = x
      if (y !== undefined) reposition.y = y
      if (reposition.x !== undefined || reposition.y !== undefined)
        frame = actions.updateFrame(frame_id, reposition, actorFrom(agent_name)) ?? moved
      const c = store.getCanvas(f.canvasId)
      return withGuidelinesNudge(
        text({
          ok: true,
          frame: frameSummary(
            frame,
            c?.pages?.find((p) => p.id === frame.pageId),
          ),
        }),
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'reorder_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Change where a frame sits in its page’s stack: dir "front" brings it above every other frame, "back" drops it behind them all, "forward"/"backward" move it one slot. A frame’s z is its stacking height (higher paints in front) and stays on the canvas for every viewer, so this is how you fix "the modal is behind the page" without touching the design. Returns the page’s frames front to back.',
      inputSchema: {
        frame_id: z.string(),
        dir: z
          .enum(['front', 'back', 'forward', 'backward'])
          .describe('Where the frame ends up: front/back all the way, forward/backward one slot'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        ok: z.literal(true),
        page_id: z.string(),
        frames: z.array(z.object({ id: z.string(), name: z.string(), z: z.number() })),
      },
    },
    async ({ frame_id, dir, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const frames = actions.reorderFrame(frame_id, dir, actorFrom(agent_name))
      if (!frames) return err('not_found', 'could not restack the frame — check the frame id with get_canvas')
      return withGuidelinesNudge(
        structured({
          ok: true as const,
          page_id: frames[0]?.pageId ?? f.pageId ?? '',
          frames: frames.map((frame) => ({ id: frame.id, name: frame.name, z: frame.z })),
        }),
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'duplicate_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Duplicate a frame: a full copy (same size and HTML) lands 40px below-right of the original, on the same page. Override the name and/or x/y to place it yourself.',
      inputSchema: {
        frame_id: z.string(),
        name: z.string().max(200).optional().describe('Title for the copy. Defaults to "<original> copy"'),
        x: z.number().min(-1_000_000).max(1_000_000).optional(),
        y: z.number().min(-1_000_000).max(1_000_000).optional(),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, name, x, y, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const frame = actions.duplicateFrame(frame_id, { name, x, y }, actorFrom(agent_name))
      if (!frame) return err('not_found', 'could not duplicate the frame')
      const c = store.getCanvas(f.canvasId)
      return withGuidelinesNudge(
        text({
          ok: true,
          frame: frameSummary(
            frame,
            c?.pages?.find((p) => p.id === frame.pageId),
          ),
        }),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'copy_frame',
    {
      title: 'Copy a frame to another canvas',
      description:
        'Copy a frame (same size and HTML) onto ANOTHER canvas. The copy becomes an ordinary frame there — the original is untouched. Pass page (id or exact name) and x/y to place it.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        to_canvas_id: z.string().describe('The canvas the copy lands on — must be accessible to this account'),
        name: z.string().max(200).optional().describe('Title for the copy. Defaults to "<original> copy"'),
        page: z
          .string()
          .optional()
          .describe('Target page ON THE DESTINATION canvas (id or exact name). Defaults to its first page.'),
        x: z.number().min(-1_000_000).max(1_000_000).optional(),
        y: z.number().min(-1_000_000).max(1_000_000).optional(),
        agent_name: agentName.optional(),
      },
    },
    async ({ frame_id, to_canvas_id, name, page, x, y, agent_name }) => {
      const source = frameFor(frame_id)
      if (!source) return noFrame(frame_id)
      const target = canvasFor(to_canvas_id)
      if (!target) return noCanvas(to_canvas_id)
      await arrive(to_canvas_id, agent_name)
      /* the write lands on the destination, so the destination's policy is what
         governs it — a copy into a review-mode canvas is a proposal, not a
         direct write, and must be refused the same way any other write is */
      const gated = reviewGate(to_canvas_id)
      if (gated) return gated
      /* the page is resolved against the DESTINATION canvas: the source's page
         ids and names mean nothing there */
      let pageId: string | undefined
      if (page !== undefined) {
        const resolved = resolvePage(to_canvas_id, page)
        if (resolved.error !== undefined) return err('invalid_input', resolved.error)
        pageId = resolved.page.id
      }
      const actor = actorFrom(agent_name)
      const frame = actions.createFrame(
        to_canvas_id,
        {
          name: name ?? `${source.name} copy`,
          x: x ?? source.x + 40,
          y: y ?? source.y + 40,
          width: source.width,
          height: source.height,
          html: source.html,
          ...(pageId ? { pageId } : {}),
          /* the copy carries the original's lock, visibility, rotation and
             opacity, so it arrives looking and behaving like what was copied;
             its stacking is fresh, landing at the front of the destination
             page */
          locked: source.locked,
          hidden: source.hidden,
          rotation: source.rotation,
          opacity: source.opacity,
        },
        actor,
      )
      if (!frame) return err('not_found', `could not copy the frame onto canvas ${to_canvas_id}`)
      /* No reconcileAssetRefs here: it rebuilds the WHOLE asset_refs table from
         the frame set it is given (db.delete(t.assetRefs) first), so passing
         one canvas's frames would erase every other canvas's refs. The copy's
         refs are maintained the same way every other frame's are —
         store.createFrame → persist.saveFrame → syncAssetRefs. */
      return withGuidelinesNudge(
        text({
          ok: true,
          frame: frameSummary(
            frame,
            target.pages?.find((p) => p.id === frame.pageId),
          ),
          copied_to: to_canvas_id,
          note: 'The copy is an ordinary frame on the destination canvas — the original is unchanged.',
        }),
        to_canvas_id,
        actor,
      )
    },
  )

  tool(
    'get_frame',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        'Get a frame including its full HTML content. Pass agent_name: it keeps your presence live on the canvas and attributes this call on the run timeline. On a large or imported frame prefer get_frame_html (a bounded slice or a query) and inspect_frame (the rendered result) over pulling the whole document.',
      inputSchema: { frame_id: z.string(), agent_name: agentName },
      outputSchema: {
        ...frameSummaryShape,
        html: z.string(),
        html_truncated: z.literal(true).optional(),
        note: z.string().optional(),
      },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      /* A whole imported document in one result is the most common way an
         agent runs out of context mid-design — clamp and say so. */
      const truncated = f.html.length > MAX_HTML_READ_CHARS
      return structured({
        ...frameSummary(f),
        html: truncated ? f.html.slice(0, MAX_HTML_READ_CHARS) : f.html,
        ...(truncated
          ? {
              html_truncated: true,
              note: `HTML truncated at ${MAX_HTML_READ_CHARS} of ${f.html.length} characters. Read the rest with get_frame_html({ frame_id, offset, limit }) or query it with get_frame_html({ frame_id, query }).`,
            }
          : {}),
      })
    },
  )

  tool(
    'get_frame_history',
    {
      description:
        "List the saved versions of a frame, newest first — every durable write is snapshotted, so this is how you see what a frame looked like before an edit (yours or anyone else's) and pick a version to restore. Returns metadata only, never the HTML: read one version's document with get_frame_version, restore it with revert_frame.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        limit: z.number().int().min(1).max(50).default(20).describe('Versions to return, default 20, max 50'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        frame_id: z.string(),
        versions: z.array(
          z.object({
            id: z.string(),
            savedAt: z.string(),
            savedBy: z.string(),
            name: z.string(),
            htmlBytes: z.number(),
            width: z.number(),
            height: z.number(),
          }),
        ),
      },
    },
    async ({ frame_id, limit, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const rows = await persist.listFrameVersions(frame_id, limit)
      return structured({
        frame_id,
        versions: rows.map((v) => ({
          id: v.id,
          savedAt: new Date(v.savedAt).toISOString(),
          savedBy: v.savedBy,
          name: v.name,
          htmlBytes: v.html.length,
          width: v.width,
          height: v.height,
        })),
      })
    },
  )

  tool(
    'get_frame_version',
    {
      description:
        'Read one saved version of a frame in full, including its HTML — the document to compare against or to restore with revert_frame. Get version ids from get_frame_history.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { version_id: z.string(), agent_name: agentName.optional() },
      outputSchema: {
        id: z.string(),
        frame_id: z.string(),
        name: z.string(),
        html: z.string(),
        width: z.number(),
        height: z.number(),
        savedAt: z.string(),
        savedBy: z.string(),
      },
    },
    async ({ version_id, agent_name }) => {
      const version = await persist.getFrameVersion(version_id)
      if (!version) return err('not_found', `no frame version with id ${version_id}`)
      const f = frameFor(version.frameId)
      if (!f) return noFrame(version.frameId)
      await arrive(f.canvasId, agent_name)
      return structured({
        id: version.id,
        frame_id: version.frameId,
        name: version.name,
        html: version.html,
        width: version.width,
        height: version.height,
        savedAt: new Date(version.savedAt).toISOString(),
        savedBy: version.savedBy,
      })
    },
  )

  tool(
    'revert_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      description:
        'Restore a frame to a version from get_frame_history. The restore is an ordinary edit — everyone sees it land live, it is logged, and it becomes a new version itself, so a revert is never a dead end. Use this instead of rebuilding a frame that was better before: an agent that made it worse, or a redesign you want to undo.',
      inputSchema: {
        frame_id: z.string(),
        version_id: z.string().describe('Version id from get_frame_history'),
        expected_updated_at: z
          .string()
          .optional()
          .describe(
            "The frame's updatedAt from when you read it — refuses the revert if someone else changed it since",
          ),
        takeover: z.boolean().optional().describe('Revert a frame another agent holds the lock on'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.object(frameSummaryShape), restored_from: z.string() },
    },
    async ({ frame_id, version_id, expected_updated_at, takeover, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const version = await persist.getFrameVersion(version_id)
      if (!version) return err('not_found', `no frame version with id ${version_id}`)
      if (version.frameId !== frame_id)
        return err('invalid_input', `version ${version_id} belongs to frame ${version.frameId}, not ${frame_id}`)
      const stale = staleConflict(f, expected_updated_at)
      if (stale) return stale
      const actor = actorFrom(agent_name)
      takeOver(frame_id, f.canvasId, actor, takeover)
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(
          frame_id,
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
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structured({ ok: true as const, frame: frameSummary(frame), restored_from: version_id })
    },
  )

  tool(
    'revert_run',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Undo everything one run changed',
      description:
        'Undo a whole run: every frame that run wrote goes back to the version it held before the run started, so a run that went the wrong way is one call to undo instead of a frame-by-frame walk through get_frame_history. Get run_id from get_run_events. Each restore is an ordinary edit — it lands live for everyone, it is logged, and it can be undone in turn. A frame someone (or something) has written since the run finished is REFUSED and reported in `skipped`, never clobbered; the same is true of a frame another agent holds the edit lock on. Frames the run created are skipped too: there is no version from before the run to go back to, so delete them explicitly if that is what you want.',
      inputSchema: {
        canvas_id: z.string(),
        run_id: z.string().describe('The run to undo, from get_run_events'),
        agent_name: agentName,
      },
      outputSchema: {
        reverted: z.array(z.object({ frame_id: z.string(), name: z.string() })),
        skipped: z.array(z.object({ frame_id: z.string(), name: z.string(), reason: z.string() })),
      },
    },
    async ({ canvas_id, run_id, agent_name }) => {
      const canvas = canvasFor(canvas_id)
      if (!canvas) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      /* newest first, the ring's order; the run is read oldest first below */
      const events = runLog.getRunEvents(canvas_id, { runId: run_id, limit: RUN_EVENT_SCAN })
      if (events.length === 0) return err('not_found', `no run with id ${run_id} in this canvas’s recent timeline`)

      /* Two pointers per frame, both from that frame's own steps: the version it
         held before the run (its EARLIEST step's before — every later step of
         the same frame points at a state the run itself produced), and the
         version the run's LAST finished write produced, which is what says
         whether anyone has written since. A step mid-stream records neither. */
      const touched = new Set<string>()
      const before = new Map<string, string>()
      const produced = new Map<string, string>()
      for (const event of [...events].reverse()) {
        if (!event.frameId) continue
        touched.add(event.frameId)
        if (event.beforeVersionId && !before.has(event.frameId)) before.set(event.frameId, event.beforeVersionId)
        if (event.afterVersionId) produced.set(event.frameId, event.afterVersionId)
      }

      const reverted: { frame_id: string; name: string }[] = []
      const skipped: { frame_id: string; name: string; reason: string }[] = []
      for (const frameId of touched) {
        const name = store.getFrame(frameId)?.name ?? frameId
        const pre = before.get(frameId)
        if (!pre) {
          skipped.push({
            frame_id: frameId,
            name,
            reason:
              'the run recorded no version from before it touched this frame — a frame the run created, or a stream it never finished',
          })
          continue
        }
        if (!frameFor(frameId)) {
          skipped.push({ frame_id: frameId, name, reason: 'the frame no longer exists on this canvas' })
          continue
        }
        const runProduced = produced.get(frameId)
        if (!runProduced) {
          skipped.push({
            frame_id: frameId,
            name,
            reason: 'the run recorded no finished write for this frame, so there is no way to tell what it changed',
          })
          continue
        }
        let newest: string | undefined
        try {
          newest = await persist.latestFrameVersionId(frameId)
        } catch {
          skipped.push({ frame_id: frameId, name, reason: 'the frame’s version history could not be read' })
          continue
        }
        if (newest !== runProduced) {
          skipped.push({
            frame_id: frameId,
            name,
            reason: `“${name}” was written after this run finished, so reverting it would discard that work — its current state is no longer the one this run produced`,
          })
          continue
        }
        let restored: Frame | undefined
        try {
          restored = await actions.revertFrame(frameId, pre, actor)
        } catch (e) {
          const conflict = lockConflict(e)
          if (conflict) {
            /* one locked frame must not throw away the frames already reverted:
               they are live, and a retry would revert them again */
            skipped.push({
              frame_id: frameId,
              name,
              reason:
                'another agent holds the edit lock on this frame — wait for it to expire, or take it over and call revert_frame',
            })
            continue
          }
          throw e
        }
        if (!restored) {
          skipped.push({ frame_id: frameId, name, reason: 'the version this run started from no longer exists' })
          continue
        }
        reverted.push({ frame_id: frameId, name: restored.name })
      }
      return structured({ reverted, skipped })
    },
  )

  tool(
    'undo_last_change',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Undo your own last change to a frame — the one-tool "that was a mistake, put it back". It reverts the frame to the state before your last write, using the same version history revert_frame uses, so the undo is itself an ordinary edit: it lands live, it is logged, and it can be undone in turn. Pass frame_id to undo one frame; omit it to undo every frame you changed on this canvas in the last 30 minutes. Refuses when someone else has changed the frame since your write — their work is never discarded by an undo aimed at yours.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string().optional().describe('The frame to undo. Omit to undo every frame you changed recently'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        frames: z.array(
          z.object({
            frame_id: z.string(),
            frame: z.object(frameSummaryShape),
            reverted_to: z.string().describe('Version id now restored'),
            savedAt: z.string().describe('When that version was saved'),
            undid: z.string().describe('When your undone change was made (the frame timestamp it left behind)'),
          }),
        ),
        skipped: z.array(z.object({ frame_id: z.string(), reason: z.string() })),
      },
    },
    async ({ canvas_id, frame_id, agent_name }) => {
      const canvas = store.getCanvas(canvas_id)
      if (!canvas) return err('not_found', `no canvas with id ${canvas_id}`)
      const actor = actorFrom(agent_name)
      const targets = frame_id ? [frame_id] : recentFramesFor(canvas_id, actor.name)
      if (targets.length === 0)
        return err(
          'not_found',
          frame_id
            ? `no frame with id ${frame_id} on this canvas`
            : `you have not changed any frame on this canvas in the last ${UNDO_WINDOW_MS / 60_000} minutes, so there is nothing to undo`,
        )

      const undone: Array<{
        frame_id: string
        frame: ReturnType<typeof frameSummary>
        reverted_to: string
        savedAt: string
        undid: string
      }> = []
      const skipped: Array<{ frame_id: string; reason: string }> = []

      for (const id of targets) {
        const f = frameFor(id)
        if (!f) {
          skipped.push({ frame_id: id, reason: 'frame no longer exists' })
          continue
        }
        /* the live frame is the tip, not the newest row: a frame write reaches
           the database on a debounce, so the row for the caller's own write may
           not be there yet. Authorship is what decides whether an undo is safe. */
        if (f.updatedBy !== actor.name) {
          skipped.push({
            frame_id: id,
            reason: `${f.updatedBy} changed this frame after your last write — reverting would discard their work. Read it with get_frame, or restore a specific version with get_frame_history + revert_frame.`,
          })
          continue
        }
        const chain = undoChainFor(id, actor.name, f.html)
        const versions = await persist.listFrameVersions(id, 50)
        /* The caller's last write may not have touched the document at all (a
           rename, a resize, a move is not versioned), so the newest saved row
           can hold the current document and belong to someone else: walking
           past it would restore a state that predates their work. */
        const newestOlder = versions.find((v) => v.savedAt < f.updatedAt)
        if (newestOlder?.html === f.html && newestOlder.savedBy !== actor.name) {
          skipped.push({
            frame_id: id,
            reason:
              'your last change did not touch this document, and the newest saved version of it belongs to another writer — nothing of yours to undo here.',
          })
          continue
        }
        /* the newest saved state that DIFFERS from what is there now and that
           this undo chain has not already been through: a rename or a revert
           saves a version without changing the document, and stopping on one
           would make undo look like a no-op */
        const previous = versions.find(
          (v) => v.savedAt < f.updatedAt && v.html !== f.html && !chain.visited.has(htmlSha(v.html)),
        )
        if (!previous) {
          skipped.push({
            frame_id: id,
            reason:
              'your write is the only saved version of this frame — there is nothing older to go back to. Use get_frame_history to see every version that was saved.',
          })
          continue
        }
        const departed = htmlSha(f.html)
        let frame: Frame | undefined
        try {
          frame = await actions.revertFrame(id, previous.id, actor)
        } catch (e) {
          const conflict = lockConflict(e)
          if (conflict) {
            /* one locked frame must not throw away the frames already undone:
               they are live, and a retry would walk further back instead */
            skipped.push({
              frame_id: id,
              reason:
                'another agent holds the edit lock on this frame — wait for it to expire, or take it over and call revert_frame',
            })
            continue
          }
          throw e
        }
        if (!frame) {
          skipped.push({ frame_id: id, reason: 'the version to restore no longer exists' })
          continue
        }
        chain.visited.add(departed)
        chain.restored = htmlSha(frame.html)
        chain.at = Date.now()
        undone.push({
          frame_id: id,
          frame: frameSummary(frame),
          reverted_to: previous.id,
          savedAt: new Date(previous.savedAt).toISOString(),
          undid: new Date(f.updatedAt).toISOString(),
        })
      }

      if (undone.length === 0)
        return err('not_found', skipped[0]?.reason ?? 'nothing to undo', {
          frames: [],
          skipped,
          hint: 'get_frame_history lists every saved version of a frame, newest first; revert_frame restores one of them.',
        })

      return structured({ ok: true as const, frames: undone, skipped })
    },
  )

  tool(
    'begin_frame_edit',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        "Claim a frame so no other agent writes to it while you work: other agents' writes to that frame fail with a conflict naming you until you release it with end_frame_edit, your run stops, or the lock expires. Use it when two agents share a canvas and you are about to make a series of edits to one frame. Locks are cooperative — a human or an agent that passes takeover: true can still write.",
      inputSchema: {
        frame_id: z.string(),
        ttl_seconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('How long the lock lasts, in seconds. Default 120, max 600.'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame_id: z.string(), expires_at: z.string() },
    },
    async ({ frame_id, ttl_seconds, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const actor = actorFrom(agent_name)
      const lock = actions.acquireFrameLock(frame_id, actor, (ttl_seconds ?? 120) * 1000)
      if ('heldBy' in lock) {
        const until = new Date(lock.heldBy.expiresAt).toISOString()
        return err('conflict', `frame ${frame_id} is being edited by ${lock.heldBy.agentName} until ${until}`, {
          frame_id,
          holder: lock.heldBy.agentName,
          expires_at: until,
          hint: 'wait for it to expire, or write with takeover: true if you must overwrite',
        })
      }
      return structured({ ok: true as const, frame_id, expires_at: new Date(lock.expiresAt).toISOString() })
    },
  )

  tool(
    'end_frame_edit',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Release a frame you claimed with begin_frame_edit so other agents can write to it again. Call it as soon as you are done with the frame rather than waiting for the lock to expire.',
      inputSchema: { frame_id: z.string(), agent_name: agentName },
      outputSchema: { ok: z.literal(true), frame_id: z.string(), released: z.boolean() },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const released = actions.releaseFrameLock(frame_id, actorFrom(agent_name).name)
      return structured({ ok: true as const, frame_id, released })
    },
  )

  tool(
    'list_frame_locks',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'See which frames are claimed right now',
      description:
        'The frames on this canvas that are claimed right now, with who holds each one and how long the claim has left. A claim is what makes two agents on one canvas a conflict instead of a silent clobber: a write to a claimed frame is refused with a conflict naming the holder, unless you pass takeover: true. Read this BEFORE a pass over several frames — a sweep, a rename, a token fix — so you can work the free ones first and come back to the claimed ones, instead of discovering the contention one refused write at a time. Frames you hold yourself are listed too, named as you: a claim you already hold is renewed rather than refused, so you never need to re-take one.',
      inputSchema: {
        canvas_id: z.string(),
        page_id: z.string().optional().describe('Only claims on frames of this page'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        locks: z.array(
          z.object({
            frame_id: z.string(),
            frame_name: z.string(),
            held_by: z.string().describe('The agent name the claim is held under'),
            held_by_owner: z.string().optional().describe('The account whose token authorized that agent'),
            kind: z.literal('agent'),
            expires_at: z.string().describe('ISO time the claim lapses on its own'),
            expires_in_seconds: z.number().describe('How long the holder has left'),
          }),
        ),
      },
    },
    async ({ canvas_id, page_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (page_id !== undefined) {
        const found = pageForId(page_id)
        if (!found || found.canvas.id !== canvas_id)
          return err('not_found', `no page with id ${page_id} on this canvas`)
      }
      await arrive(canvas_id, agent_name)
      const now = Date.now()
      const locks = frameLocks
        .activeLocks()
        .filter((lock) => lock.canvasId === canvas_id)
        /* the frame is read for its name and its page: a claim on a frame that
           has since been deleted is left out rather than reported nameless */
        .flatMap((lock) => {
          const frame = store.getFrame(lock.frameId)
          if (!frame) return []
          if (page_id !== undefined && frame.pageId !== page_id) return []
          return [
            {
              frame_id: lock.frameId,
              frame_name: frame.name,
              held_by: lock.agentName,
              ...(lock.owner ? { held_by_owner: lock.owner } : {}),
              kind: 'agent' as const,
              expires_at: new Date(lock.expiresAt).toISOString(),
              expires_in_seconds: Math.max(0, Math.round((lock.expiresAt - now) / 1000)),
            },
          ]
        })
      return structured({ locks })
    },
  )

  tool(
    'get_tokens',
    {
      title: 'Read the canvas design tokens',
      description:
        "The canvas's design tokens — the named colors, fonts, spacing scale and radii every frame on it should use — plus the ready-to-paste :root block. Read this BEFORE designing on an existing canvas: reusing its tokens is what makes a new frame look like it belongs. Returns null tokens when the canvas has none yet, in which case set them with set_tokens before you start.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
      outputSchema: {
        tokens: tokensShape.nullable(),
        css: z.string(),
        updated_at: z.string().optional(),
        updated_by: z.string().optional(),
      },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const tokens = c.tokens
      return structured({
        tokens: tokens ?? null,
        css: tokens ? cssForTokens(tokens) : '',
        ...(tokens ? { updated_at: new Date(tokens.updatedAt).toISOString(), updated_by: tokens.updatedBy } : {}),
      })
    },
  )

  tool(
    'set_tokens',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Define the canvas design tokens',
      description:
        "Define or update the canvas's design tokens: named colors, display/body/mono fonts, a px spacing scale and radii. Do this early on a new canvas — every later frame should use these values, and lint_frame checks that they do. merge: true folds the values into the existing set instead of replacing it. Returns the stored tokens and the :root block to paste into a frame.",
      inputSchema: {
        canvas_id: z.string(),
        tokens: tokensShape.describe('The token set. Colors are name -> CSS color, e.g. { ink: "#111110" }'),
        merge: z
          .boolean()
          .optional()
          .describe(
            'Fold these values into the existing tokens instead of replacing them: colors, fonts and the type scale merge key by key, spacing/radii/shadows replace the whole list when given',
          ),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), tokens: tokensShape, css: z.string() },
    },
    async ({ canvas_id, tokens, merge, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      const existing = c.tokens
      const next =
        merge && existing
          ? {
              ...existing,
              ...tokens,
              colors: { ...existing.colors, ...(tokens.colors ?? {}) },
              ...(tokens.fonts ? { fonts: { ...existing.fonts, ...tokens.fonts } } : {}),
              ...(tokens.type
                ? {
                    type: {
                      ...existing.type,
                      ...tokens.type,
                      /* a list is a scale: merge it, don't replace it with a
                         one-entry stub that would flag everything else */
                      size: tokens.type.size ?? existing.type?.size,
                      weight: tokens.type.weight ?? existing.type?.weight,
                      leading: tokens.type.leading ?? existing.type?.leading,
                    },
                  }
                : {}),
            }
          : tokens
      try {
        actions.setTokens(canvas_id, { ...next, updatedAt: 0, updatedBy: actor.name }, actor)
      } catch (e) {
        /* review mode is a canvas rule, not a token validation failure: let
           the tool wrapper report it as the typed refusal it is */
        if (e instanceof actions.ReviewModeError) throw e
        return err('invalid_input', e instanceof Error ? e.message : 'invalid tokens')
      }
      const stored = store.getCanvas(canvas_id)!.tokens!
      /* The endpoint is stateless (one server per POST, no session id), so a
         notification can only reach the client on THIS request: other clients
         learn about the change from the resource's lastModified / _meta. */
      try {
        server.sendResourceListChanged()
        await server.server.sendResourceUpdated({ uri: `doop://canvas/${canvas_id}/tokens` })
      } catch {
        /* no stream on this transport, or the client is gone — the write stands */
      }
      return structured({ ok: true as const, tokens: stored, css: cssForTokens(stored) })
    },
  )

  tool(
    'set_breakpoints',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Declare the canvas responsive breakpoints',
      description:
        "Declare the widths this canvas designs for, by name (e.g. [{ name: 'mobile', min_width: 390 }, { name: 'desktop', min_width: 1280 }]). review_frame then renders every frame at each one in addition to the device presets and labels its findings with the breakpoint name, so verification matches the widths the design targets. Order is normalised ascending by min_width; an empty list clears them.",
      inputSchema: {
        canvas_id: z.string(),
        breakpoints: z
          .array(
            z.object({
              name: z.string().min(1).max(40).describe('Short label, e.g. "mobile" or "desktop"'),
              min_width: z.number().int().min(0).max(20_000).describe('Viewport width in px this breakpoint starts at'),
            }),
          )
          .max(8)
          .describe('Up to 8 breakpoints; unique names, ordered ascending by min_width'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        breakpoints: z.array(z.object({ name: z.string(), min_width: z.number() })),
      },
    },
    async ({ canvas_id, breakpoints, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const actor = actorFrom(agent_name)
      const names = breakpoints.map((b) => b.name.trim().toLowerCase())
      const clash = names.find((n, i) => n && names.indexOf(n) !== i)
      if (clash) return err('invalid_input', `two breakpoints are both named “${clash}” — names must be unique`)
      if (names.some((n) => !n)) return err('invalid_input', 'a breakpoint name is empty')
      /* ascending is the order review_frame renders in and the order the panel
         shows, so the caller's ordering never decides what "mobile first" means */
      const next = breakpoints.length
        ? breakpoints
            .map((b) => ({ name: b.name.trim(), min_width: b.min_width }))
            .sort((a, b) => a.min_width - b.min_width)
        : undefined
      try {
        store.setBreakpoints(canvas_id, next, actor.name)
      } catch (e) {
        if (e instanceof actions.ReviewModeError) throw e
        return err('invalid_input', e instanceof Error ? e.message : 'invalid breakpoints')
      }
      const stored = store.getCanvas(canvas_id)?.breakpoints ?? []
      try {
        await server.server.sendResourceUpdated({ uri: `doop://canvas/${canvas_id}` })
      } catch {
        /* no stream on this transport, or the client is gone — the write stands */
      }
      return structured({ ok: true as const, breakpoints: stored })
    },
  )

  tool(
    'lint_frame',
    {
      title: 'Lint a frame against the design tokens',
      description:
        "Check the RENDERED frame for values that drift off the canvas's design tokens: colors that are not one of them, fonts outside the token set, and radii or spacing off the declared scales. Each violation names the selector, the value found, and the token it should have used. Run it after building a frame so the canvas stays coherent instead of accumulating near-miss shades and one-off paddings. With no tokens set it reports tokens_present: false rather than inventing a scale.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        device: deviceName,
        viewport: viewportOverride,
        agent_name: agentName,
      },
      outputSchema: lintReportShape,
    },
    async ({ frame_id, device, viewport, agent_name }, extra) => {
      const budget = takeRender(agent_name)
      if (budget) return budget
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const resolved = resolveViewport(device, viewport)
      const tokens = store.getCanvas(f.canvasId)?.tokens
      let report
      try {
        await progress(extra, 0, `Rendering “${f.name}” to check it against the canvas tokens…`)
        report = await lintFrame(f, tokens, resolved ? { viewport: resolved } : {})
        await progress(extra, 0.5, `Comparing “${f.name}” against the canvas tokens…`)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for linting')
      }
      const total = Object.values(report.counts).reduce((sum, n) => sum + n, 0)
      const nudge = report.tokens_present
        ? total > 0
          ? `${total} value(s) drift off the canvas tokens — read them with get_tokens and use those exact colors, fonts and scales so this frame matches the rest of the canvas.`
          : undefined
        : 'No design tokens on this canvas yet — define them with set_tokens so every frame shares one palette, type and scale.'
      await progress(extra, 1, `Linted “${f.name}”.`)
      return nudge ? structuredWithNudge(report, nudge) : structured(report)
    },
  )

  tool(
    'audit_frame',
    {
      title: 'Audit a frame’s accessibility',
      description:
        'Check the RENDERED frame against the accessibility rules a design review is responsible for: text contrast (WCAG ratios, computed from the real composited background), image alt text, heading order, focus order and tabindex, tap-target sizes, landmarks, form labels and the document language. Each issue names the CSS selector to fix. Run it before calling a design done — contrast in particular is the checkpoint the review workflow asks you to judge, and this measures it instead of guessing. Pass device/viewport to audit the layout at a phone or tablet width.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        device: deviceName,
        viewport: viewportOverride,
        state: interactionState,
        width: z
          .number()
          .int()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            'Audit at this width instead of the frame’s own — a breakpoint that is not a named device. Ignored when device or viewport is set.',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        counts: z.object({ critical: z.number(), serious: z.number(), moderate: z.number() }),
        issues: z.array(
          z.object({
            rule: z.string(),
            severity: z.string(),
            selector: z.string(),
            detail: z.string(),
            value: z.string().optional(),
            expected: z.string().optional(),
          }),
        ),
        checked_elements: z.number(),
        viewport: z.object({ width: z.number(), height: z.number() }),
        /** the interaction state the audit was measured in, when one was asked for */
        state: z.string().optional(),
      },
    },
    async ({ frame_id, device, viewport, state, width, agent_name }, extra) => {
      const budget = takeRender(agent_name)
      if (budget) return budget
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const resolved = resolveViewport(device, viewport) ?? (width ? { width, height: f.height } : undefined)
      let report: A11yReport
      try {
        await progress(extra, 0, `Rendering “${f.name}” for the audit…`)
        report = await auditFrame(f, {
          ...(resolved ? { viewport: resolved } : {}),
          ...(state ? { state } : {}),
        })
        await progress(extra, 0.5, `Checking “${f.name}” against the accessibility rules…`)
      } catch (e) {
        if (e instanceof StateRenderError) return err(e.code, e.message)
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for audit')
      }
      const nudge =
        report.counts.critical > 0
          ? `${report.counts.critical} critical issue(s) — the review checkpoints require contrast you can defend. Fix these in the frame HTML and run audit_frame again.`
          : undefined
      const payload = state ? { ...report, state: stateLabel(state) } : report
      const result = nudge ? structuredWithNudge(payload, nudge) : structured(payload)
      await progress(extra, 1, `Audited “${f.name}”.`)
      return result
    },
  )

  tool(
    'diff_frame',
    {
      title: 'Compare a frame against another render',
      description:
        "Measure how far a frame's CURRENT render is from another one, and see WHERE: a magenta-marked image plus the changed-pixel ratio. Compare against a previous version (get_frame_history), a pinned reference, another frame, or a live URL. Use it to confirm a fix actually landed, to check a redesign against the source it came from, or to match a pinned exemplar. identical: true means the two renders are the same design.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        against: z
          .object({
            previous_version: z
              .boolean()
              .optional()
              .describe(
                'Diff against the newest saved version of this frame — the shorthand for "did my edit change what I meant to change"',
              ),
            frame_id: z.string().optional(),
            version_id: z.string().optional(),
            reference_id: z.string().optional(),
            url: z.string().optional(),
          })
          .describe(
            'Exactly one of: frame_id (another frame), version_id (a saved version of this frame), reference_id (a pinned Memory reference), url (a live page, captured like import_webpage)',
          ),
        threshold: z
          .number()
          .int()
          .min(0)
          .max(255)
          .optional()
          .describe('Per-channel delta that counts as changed; default 12, which ignores antialiasing noise'),
        agent_name: agentName,
      },
      outputSchema: {
        identical: z.boolean(),
        changed_pixels: z.number(),
        total_pixels: z.number(),
        changed_ratio: z.number(),
        max_delta: z.number(),
        against: z.string(),
        diff_image_url: z.string(),
      },
    },
    async ({ frame_id, against, threshold, agent_name }, extra) => {
      const budget = takeRender(agent_name)
      if (budget) return budget
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const keys = Object.keys(against).filter((k) => against[k as keyof typeof against] !== undefined)
      if (keys.length !== 1)
        return err(
          'invalid_input',
          `pass exactly one of frame_id, version_id, reference_id or url — got ${keys.length}`,
        )
      await arrive(f.canvasId, agent_name)

      let other: Frame | undefined
      let label: string
      if (against.previous_version) {
        const versions = await persist.listFrameVersions(frame_id, 1)
        const newest = versions[0]
        if (!newest)
          return err(
            'not_found',
            'this frame has no saved version yet — every durable write snapshots one, so make an edit first',
          )
        other = { ...f, html: newest.html, width: newest.width, height: newest.height }
        label = 'the previous version'
      } else if (against.frame_id !== undefined) {
        other = frameFor(against.frame_id)
        if (!other) return noFrame(against.frame_id)
        label = `frame ${other.name}`
      } else if (against.version_id !== undefined) {
        const version = await persist.getFrameVersion(against.version_id)
        if (!version) return err('not_found', `no frame version with id ${against.version_id}`)
        if (version.frameId !== frame_id)
          return err(
            'invalid_input',
            `version ${against.version_id} belongs to frame ${version.frameId}, not ${frame_id}`,
          )
        other = { ...f, html: version.html, width: version.width, height: version.height }
        label = `version ${against.version_id}`
      } else if (against.reference_id !== undefined) {
        const ref = store.getReferences(f.canvasId).find((r) => r.id === against.reference_id)
        if (!ref) return err('not_found', `no reference with id ${against.reference_id} on this canvas`)
        other = { ...f, html: ref.html, width: ref.width, height: ref.height }
        label = `reference “${ref.title}”`
      } else {
        try {
          const captured = await importPage(against.url!, {})
          other = { ...f, html: captured.html, width: captured.width, height: captured.height }
          label = `live page ${against.url}`
        } catch (e) {
          return err(
            'upstream_failed',
            websiteAccessErrorMessage(e, 'connected-agent') ??
              (e instanceof Error ? e.message : 'could not capture that URL'),
          )
        }
      }

      let diff
      try {
        await progress(extra, 0, `Rendering both designs to compare them…`)
        diff = await diffFrames(f, other, threshold === undefined ? {} : { threshold })
        await progress(extra, 0.5, `Measuring the difference against ${label}…`)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render the frames for comparison')
      }
      const asset = await assets.createAsset(diff.diff_png, {
        canvasId: f.canvasId,
        ownerId,
        uploadedBy: actorFrom(agent_name).name,
      })
      const url = `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`
      const payload = {
        identical: diff.identical,
        changed_pixels: diff.changed_pixels,
        total_pixels: diff.total_pixels,
        changed_ratio: Number(diff.changed_ratio.toFixed(4)),
        max_delta: diff.max_delta,
        against: label,
        diff_image_url: url,
      }
      await progress(extra, 1, `Compared “${f.name}” against ${label}.`)
      return {
        content: [
          { type: 'image' as const, data: diff.diff_png.toString('base64'), mimeType: 'image/png' },
          { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
        ],
        structuredContent: payload,
      }
    },
  )

  /* ---- token usage and repair: read the drift, then write it back ---- */

  tool(
    'get_token_usage',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read a frame’s token usage',
      description:
        'Per-element account of which design tokens a rendered frame actually uses, and where it drifts off them: the token (or raw value) behind each element’s color, background, font, radius and spacing, plus the off-token findings the lint reports — value, nearest token, and how far away it is. Scope it with selector to read one subtree. The element list is capped; truncated: true means the report was cut.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        selector: z.string().optional().describe('Scope the report to this element and its descendants'),
        agent_name: agentName,
      },
      outputSchema: {
        frame_id: z.string(),
        viewport: z.object({ width: z.number(), height: z.number() }),
        elements: z.array(
          z.object({
            selector: z.string(),
            tag: z.string(),
            tokens_used: z.object({
              color: z.string().optional(),
              background: z.string().optional(),
              font: z.string().optional(),
              radius: z.string().optional(),
              spacing: z.string().optional(),
            }),
            off_token: z.array(
              z.object({
                property: z.string(),
                value: z.string(),
                nearest_token: z.string().optional(),
                delta: z.number().optional(),
              }),
            ),
          }),
        ),
        truncated: z.boolean(),
      },
    },
    async ({ canvas_id, frame_id, selector, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id) return noFrame(frame_id)
      await arrive(canvas_id, agent_name)
      const budget = takeRender(agent_name)
      if (budget) return budget
      const tokens = canvasFor(canvas_id)?.tokens
      let probe: Probe
      try {
        probe = await probeFrame(f)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for the token read')
      }
      /* the same comparator the lint runs — one definition of "off token", so
         this read and lint_frame can never disagree about a value */
      const report = lintProbe(probe, tokens)
      /* selector scoping follows motionFrame's reading: the element itself and
         its descendants, named by the probe's own selectors */
      const scoped = (el: (typeof probe.elements)[number]) =>
        !selector || el.selector === selector || el.selector.startsWith(`${selector} > `)
      const visible = probe.elements.filter((el) => !el.attrs.hiddenFromAT && scoped(el))
      const elements = visible.map((el) => {
        const violations = report.violations.filter((v) => v.selector === el.selector)
        return {
          selector: el.selector,
          tag: el.tag,
          tokens_used: {
            ...(el.style.color ? { color: el.style.color } : {}),
            ...(el.style.background && el.style.background !== 'rgba(0, 0, 0, 0)'
              ? { background: el.style.background }
              : {}),
            ...(el.style.font ? { font: el.style.font } : {}),
            ...(el.style.borderRadius && el.style.borderRadius !== '0px' ? { radius: el.style.borderRadius } : {}),
            ...(el.style.gap && el.style.gap !== 'normal' ? { spacing: el.style.gap } : {}),
          },
          off_token: violations.map((v) => ({
            property: v.property,
            value: v.value,
            ...(v.nearest_token ? { nearest_token: v.nearest_token } : {}),
            ...(v.distance !== undefined ? { delta: v.distance } : {}),
          })),
        }
      })
      return structured({
        frame_id,
        viewport: { width: f.width, height: f.height },
        elements,
        truncated: elements.length < probe.elements.length,
      })
    },
  )

  tool(
    'fix_frame_tokens',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Snap a frame back onto its tokens',
      description:
        'Fix the values a frame drifts off the canvas tokens: a fresh lint runs, every finding within the fix tolerance is rewritten to its token (var(--color-ink), var(--space-8) — values the render resolves), and the result is applied with the element editor and written through updateFrame. Restrict the pass with only (rule ids from lint_frame); rehearse with dry_run. Each fixed entry names what moved and what it became; each skipped entry names the value a token was not close enough to claim.',
      inputSchema: {
        frame_id: z.string(),
        only: z
          .array(
            z.enum(['off_token_color', 'off_token_font', 'off_token_type', 'off_scale_radius', 'off_grid_spacing']),
          )
          .optional()
          .describe('Fix only these rule classes; default fixes everything within tolerance'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        dry_run: z.boolean().optional().describe('Report the planned fixes and write nothing'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        frame: z.unknown().optional(),
        fixed: z.array(z.object({ selector: z.string(), property: z.string(), from: z.string(), to: z.string() })),
        skipped: z.array(
          z.object({ selector: z.string(), property: z.string(), value: z.string(), reason: z.string() }),
        ),
        dry_run: z.literal(true).optional(),
        would_apply: z.boolean().optional(),
        diff: diffShape.optional(),
        bytes_before: z.number().optional(),
        bytes_after: z.number().optional(),
      },
    },
    async ({ frame_id, only, expected_updated_at, takeover, dry_run, agent_name }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const tokens = canvasFor(before.canvasId)?.tokens
      if (!tokens)
        return err('unsupported', 'this canvas has no design tokens to fix toward — set them with set_tokens first')
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      const budget = takeRender(agent_name)
      if (budget) return budget
      await arrive(before.canvasId, agent_name)
      let report
      try {
        report = await lintFrame(before, tokens)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for linting')
      }
      const plan = planTokenFixes(report, tokens, only as LintRule[] | undefined)
      if (plan.fixed.length === 0) return structured({ ok: true as const, fixed: [], skipped: plan.skipped })
      /* one element edit per fix: the planned `to` is a var() the render
         resolves, so each rewrite is the exact declaration the lint judged */
      const edits = plan.fixed.map((fix) => ({ selector: fix.selector, style: { [fix.property]: fix.to } }))
      if (dry_run) {
        try {
          const preview = await updateElements(before, edits)
          return structured(
            dryRunPayload(before.html, storedHtml(preview.html), { fixed: plan.fixed, skipped: plan.skipped }),
          )
        } catch (e) {
          if (e instanceof ElementEditError) return err(e.code, e.message)
          throw e
        }
      }
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let outcome: UpdateElementsResult
      try {
        outcome = await updateElements(before, edits)
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: outcome.html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structuredWithNudge(
        { ok: true as const, frame: frameSummary(frame), fixed: plan.fixed, skipped: plan.skipped },
        'Token fixes applied. Call get_frame_screenshot to see the frame on its tokens.',
      )
    },
  )

  tool(
    'fix_frame_a11y',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Fix a frame’s accessibility and content findings',
      description:
        'The mechanical counterpart of fix_frame_tokens for accessibility and content: a fresh audit runs (the same render and the same probe review_frame uses), and every finding that has a one-line repair is applied — the document language, a missing or empty title, controls with no hover or focus rule. Each applied entry names what changed and what it became; each skipped entry names the decision that rule needs (alt text, form labels, contrast, tap targets), which no fixer can make for you. Restrict the pass with only (rule ids from review_frame); rehearse it with dry_run, which returns the plan and the diff and writes nothing. The write goes through the ordinary frame write, so locks, version history and review mode all apply.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        only: z
          .array(z.enum(A11Y_FIX_RULES))
          .optional()
          .describe('Fix only these rules; default considers every finding the audit reports'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        dry_run: z.boolean().optional().describe('Report the planned fixes and the diff, and write nothing'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        frame: z.unknown().optional(),
        applied: z.array(z.string()),
        skipped: z.array(z.object({ rule: z.string(), reason: z.string() })),
        changed: z.boolean(),
        dry_run: z.literal(true).optional(),
        would_apply: z.boolean().optional(),
        diff: diffShape.optional(),
        bytes_before: z.number().optional(),
        bytes_after: z.number().optional(),
      },
    },
    async ({ canvas_id, frame_id, only, expected_updated_at, takeover, dry_run, agent_name }) => {
      const before = frameFor(frame_id)
      if (!before || before.canvasId !== canvas_id) return noFrame(frame_id)
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      const budget = takeRender(agent_name)
      if (budget) return budget
      await arrive(before.canvasId, agent_name)
      /* One render, two probes: the audit's findings and the content lint's are
         the inputs the fixer plans against, and both read the same DOM the
         review would have measured. */
      let findings: { rule: string; selector?: string }[]
      try {
        const probe = await probeFrame(before)
        findings = [
          ...auditProbe(probe).issues.map((issue) => ({ rule: issue.rule as string, selector: issue.selector })),
          ...contentProbe(probe).issues.map((issue) => ({ rule: issue.rule as string, selector: issue.selector })),
        ]
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for the fixer')
      }
      /* `only` narrows what the fixer is asked about, not what it reports: a
         rule outside the filter is not this call's business, so it is neither
         applied nor skipped. */
      const asked = only?.length
        ? findings.filter((finding) => (only as readonly string[]).includes(finding.rule))
        : findings
      const plan = planA11yFixes(before.html, before.name, asked)
      const fixed = plan.fixedHtml
      if (fixed === null)
        return structured({
          ok: true as const,
          applied: plan.applied,
          skipped: plan.skipped,
          changed: false,
        })
      if (dry_run)
        return structured({
          ...dryRunPayload(before.html, storedHtml(fixed), { applied: plan.applied, skipped: plan.skipped }),
          ok: true as const,
          changed: true,
        })
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: fixed }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structured({
        ok: true as const,
        frame: frameSummary(frame),
        applied: plan.applied,
        skipped: plan.skipped,
        changed: true,
      })
    },
  )

  tool(
    'inspect_frame',
    {
      title: 'Inspect a rendered frame',
      description:
        "Inspect the RENDERED page instead of its source: a compact semantic element outline with each element's CSS selector, the visible text, geometry, and the computed colors, typography, radii, shadows and CSS variables actually in effect. Use this instead of get_frame on large or imported frames — it is a fraction of the size and shows what the design really looks like. Pair it with get_frame_screenshot for layout.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        device: deviceName,
        viewport: viewportOverride,
        agent_name: agentName,
      },
      outputSchema: inspectionShape,
    },
    async ({ frame_id, agent_name, device, viewport }) => {
      const budget = takeRender(agent_name)
      if (budget) return budget

      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      try {
        const resolved = resolveViewport(device, viewport)
        return structured(await inspectFrame(f, resolved ? { viewport: resolved } : {}))
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for inspection')
      }
    },
  )

  tool(
    'get_frame_html',
    {
      title: 'Read a bounded slice of a frame’s HTML',
      description:
        "Read a bounded portion of a frame's source HTML before a targeted edit. Use query for small snippets around matching text, or offset/limit to page through the source. Prefer this over get_frame whenever the frame may be large — get_frame returns the whole document, which is the most common way to run out of context mid-design.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        frame_id: z.string(),
        query: z
          .string()
          .optional()
          .describe('Literal text to find; returns bounded context around up to five matches'),
        offset: z.number().optional().describe('Character offset for a bounded read; defaults to 0'),
        limit: z.number().optional().describe('Characters to return; defaults to 20000, capped at 30000'),
        agent_name: agentName,
      },
      outputSchema: { frame_id: z.string(), html_bytes: z.number(), text: z.string() },
    },
    async ({ frame_id, query, offset, limit, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const read = readFrameHtml(f.html, { query, offset, limit })
      if ('error' in read) return err('invalid_input', read.error)
      return {
        content: [{ type: 'text' as const, text: read.text }],
        structuredContent: { frame_id, html_bytes: f.html.length, text: read.text },
      }
    },
  )

  tool(
    'get_frames_html',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read several frames’ HTML in one call',
      description:
        'Read the source of up to twenty frames of one canvas in a single call. Each frame comes back as the same bounded slice get_frame_html returns for it at offset 0 — a bigger document is cut, with html_truncated: true — so use this for a pass over several frames (checking that a rename landed, comparing how two frames build the same section, reading back what a run wrote) and get_frame_html when you need to page deeper into one document or query it for a snippet. Pass frame ids from get_canvas or list_frames; an id that is not on this canvas comes back as its own entry with "not_found" rather than failing the whole read, so one stale id never costs you the frames around it.',
      inputSchema: {
        canvas_id: z.string(),
        frame_ids: z.array(z.string()).min(1).max(20).describe('Frame ids to read, 1–20 of them, all on this canvas'),
        max_bytes_each: z
          .number()
          .int()
          .min(1000)
          .max(MAX_HTML_READ_CHARS)
          .optional()
          .describe(`Characters per frame; defaults to 20000, capped at ${MAX_HTML_READ_CHARS} like get_frame_html`),
        agent_name: agentName,
      },
      outputSchema: {
        frames: z.array(
          z.object({
            frame_id: z.string(),
            html: z.string().optional(),
            html_bytes: z.number().optional().describe('The frame’s full document length, before the clamp'),
            html_truncated: z.literal(true).optional(),
            error: z.string().optional().describe('"not_found" when no frame with that id is on this canvas'),
          }),
        ),
      },
    },
    async ({ canvas_id, frame_ids, max_bytes_each, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const frames = frame_ids.map((frame_id) => {
        const f = frameFor(frame_id)
        if (!f || f.canvasId !== canvas_id) return { frame_id, error: 'not_found' }
        /* the same bounded read get_frame_html serves, so the limit and what
           counts as truncated cannot drift from that tool: its text is the
           header line, a blank line, then exactly the slice */
        const read = readFrameHtml(f.html, { limit: max_bytes_each })
        if ('error' in read) return { frame_id, error: read.error }
        const html = read.text.slice(read.text.indexOf('\n\n') + 2)
        return {
          frame_id,
          html,
          html_bytes: f.html.length,
          ...(html.length < f.html.length ? { html_truncated: true as const } : {}),
        }
      })
      return structured({ frames })
    },
  )

  tool(
    'set_frame_html',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Replace the HTML design of a frame in one shot. The change renders live for everyone viewing the canvas. For new or heavily reworked designs, prefer append_frame_html so viewers can watch the design stream in.',
      inputSchema: {
        frame_id: z.string(),
        html: z
          .string()
          .describe(
            `Full replacement HTML. Max ${MAX_FRAME_HTML_BYTES} characters — stream larger designs with append_frame_html.`,
          ),
        expected_updated_at: z
          .string()
          .optional()
          .describe("The frame's updatedAt from when you read it — refuses the write if someone else changed it since"),
        takeover: z.boolean().optional().describe('Overwrite even if another agent holds the frame lock'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Return the diff this write would produce and change nothing — no version, no broadcast, no lock. Use it to check a large rewrite before sending it.',
          ),
        agent_name: agentName,
      },
    },
    async ({ frame_id, html, agent_name, expected_updated_at, takeover, dry_run }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      if (tooLarge(html))
        return err(
          'too_large',
          `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}. Stream the design with append_frame_html instead.`,
        )
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      if (dry_run) return structured(dryRunPayload(before.html, storedHtml(html)))
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return withGuidelinesNudge(
        withEscapeNote(structuredWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), html),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'set_frame_css',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Write the frame stylesheet',
      description:
        "Write the frame's own stylesheet (a <style data-doop-css> block in its head): the only place responsive rules (@media), interaction states (:hover/:focus/:active) and motion (transition/@keyframes) can live. Inline styles cannot express any of those, so a frame that needs them needs this. Replaces the whole block each call — read it first with get_frame_css if you are adding to it. @import is refused: a frame must not fetch anything external.",
      inputSchema: {
        frame_id: z.string(),
        css: z
          .string()
          .max(100_000)
          .describe(
            'The full stylesheet for this frame. Media queries, states and transitions belong here, not in inline styles.',
          ),
        expected_updated_at: z
          .string()
          .optional()
          .describe("The frame's updatedAt from when you read it — refuses the write if someone else changed it since"),
        takeover: z.boolean().optional().describe('Overwrite even if another agent holds the frame lock'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Return the diff this stylesheet would produce and change nothing — no version, no broadcast, no lock',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true).optional(),
        frame: z.unknown().optional(),
        css_bytes: z.number(),
        dry_run: z.literal(true).optional(),
        would_apply: z.boolean().optional(),
        diff: diffShape.optional(),
        bytes_before: z.number().optional(),
        bytes_after: z.number().optional(),
      },
    },
    async ({ frame_id, css, agent_name, expected_updated_at, takeover, dry_run }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const budget = takeRender(agent_name)
      if (budget) return budget
      /* the stylesheet is written into a rendered document, so a dry run still
         renders — it just never hands the result to a write */
      if (dry_run) {
        try {
          const preview = await setFrameCss(before, css)
          return structured(dryRunPayload(before.html, storedHtml(preview.html), { css_bytes: css.length }))
        } catch (e) {
          if (e instanceof ElementEditError) return err(e.code, e.message)
          throw e
        }
      }
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let outcome: { html: string }
      try {
        outcome = await setFrameCss(before, css)
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: outcome.html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structured({ ok: true as const, frame: frameSummary(frame), css_bytes: css.length })
    },
  )

  tool(
    'get_frame_css',
    {
      title: 'Read the frame stylesheet',
      description:
        "Read back the frame's own stylesheet (the <style data-doop-css> block), or an empty string when it has none. Read it before set_frame_css if you are adding to what is already there — set_frame_css replaces the whole block.",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
      outputSchema: { css: z.string() },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      const budget = takeRender(agent_name)
      if (budget) return budget
      try {
        return structured(await getFrameCss(f))
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
    },
  )

  tool(
    'search_frames',
    {
      title: 'Search across the canvas frames',
      description:
        'Find which frames on a canvas mention something: a literal, case-insensitive substring matched against every frame name and its HTML, newest-updated first, with a few short snippets around each hit. Use it on a big canvas to answer "where is the pricing table" or "which frames use the old brand name" without reading frames one at a time.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        query: z.string().min(1).max(500).describe('Literal text to find (case-insensitive)'),
        limit: z.number().int().min(1).max(20).optional().describe('Frames to return, default 10, max 20'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        results: z.array(
          z.object({
            frame_id: z.string(),
            name: z.string(),
            matches: z.number(),
            snippets: z.array(z.object({ before: z.string(), match: z.string(), after: z.string() })),
          }),
        ),
      },
    },
    async ({ canvas_id, query, limit, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const needle = query.toLowerCase()
      /* the same bound readFrameHtml applies to one frame's source: a search
         must not become the way a whole document enters the context */
      const CONTEXT = 40
      const MAX_SNIPPETS = 3
      const results: Array<{
        frame_id: string
        name: string
        matches: number
        snippets: { before: string; match: string; after: string }[]
      }> = []
      for (const f of [...c.frames].filter((frame) => !frame.demo).sort((a, b) => b.updatedAt - a.updatedAt)) {
        const haystack = f.html.slice(0, MAX_HTML_READ_CHARS)
        const nameHit = f.name.toLowerCase().includes(needle)
        const matches = haystack.toLowerCase().split(needle).length - 1
        if (!nameHit && matches === 0) continue
        const snippets: { before: string; match: string; after: string }[] = []
        let cursor = 0
        while (snippets.length < MAX_SNIPPETS) {
          const at = haystack.toLowerCase().indexOf(needle, cursor)
          if (at < 0) break
          snippets.push({
            before: haystack.slice(Math.max(0, at - CONTEXT), at),
            match: haystack.slice(at, at + query.length),
            after: haystack.slice(at + query.length, at + query.length + CONTEXT),
          })
          cursor = at + query.length
        }
        results.push({ frame_id: f.id, name: f.name, matches: matches + (nameHit ? 1 : 0), snippets })
        if (results.length >= (limit ?? 10)) break
      }
      return structured({ results })
    },
  )

  tool(
    'export_frame',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Export a frame — image or code',
      description:
        "Hand a frame to the world outside Doop. format: 'png'/'jpg' returns public image URLs rendering the CURRENT design (download one and upload it to a CMS media library, social post or og:image — it re-renders when the frame changes). format: 'html' returns the frame's stored document verbatim. format: 'react' converts the RENDERED frame into a self-contained React component plus its stylesheet, with the canvas tokens as a :root block — use it when a human asks for the code behind a design.",
      inputSchema: {
        frame_id: z.string(),
        format: z
          .enum(['png', 'jpg', 'html', 'react', 'spec'])
          .optional()
          .describe(
            "default png; 'spec' returns the frame's build spec as markdown — measurements, the type ramp, the colors, the structure outline and its verification report",
          ),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
        scoped_css: z
          .boolean()
          .optional()
          .describe(
            'react only: scope the stylesheet under [data-frame="<id>"] instead of emitting global element selectors — use it when the host page has its own global styles',
          ),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        format: z.string(),
        image_url: z.string().optional(),
        download_url: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        html: z.string().optional(),
        component_name: z.string().optional(),
        jsx: z.string().optional(),
        css: z.string().optional(),
        spec_md: z.string().optional(),
        tokens_css: z.string().optional(),
        notes: z.array(z.string()).optional(),
        note: z.string().optional(),
      },
    },
    async ({ frame_id, format, quality, scoped_css, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      /* the only read tool that was missing agent_name: without it the call is
         attributed to nobody, so an agent could export in a loop and never show
         up as connected on the canvas */
      await arrive(f.canvasId, agent_name)
      if (format === 'html') return structured({ format: 'html', html: f.html })

      if (format === 'spec') {
        /* this renders a Chromium page, like every other render tool */
        const budget = takeRender()
        if (budget) return budget
        const probe = await specProbe(f)
        if (!probe) return err('upstream_failed', 'could not render this frame to measure it')
        const [report] = await persist.listFrameReviews(frame_id, 1)
        return structured({ format: 'spec', spec_md: specMd(f, report, probe, canvasFor(f.canvasId)?.tokens) })
      }

      if (format === 'react') {
        let exported
        try {
          exported = await htmlToReact(f.html, {
            name: f.name,
            tokens: store.getCanvas(f.canvasId)?.tokens,
            frameId: f.id,
            scopedCss: scoped_css === true,
          })
        } catch (e) {
          return err('upstream_failed', e instanceof Error ? e.message : 'could not convert this frame to React')
        }
        /* the frame's asset references become the relative path a component
           library expects, and the export says which assets to copy */
        const reactAssets = [...assets.extractAssetIds(f.html)]
        const react = rewriteAssetUrls(exported.jsx, './')
        return structured({
          format: 'react',
          ...exported,
          jsx: react.html,
          notes: [
            ...exported.notes,
            ...(reactAssets.length
              ? [
                  `${reactAssets.length} asset reference(s) were rewritten to ./assets/<id>.<ext> — copy them from the canvas's asset list (list_assets) next to the component.`,
                ]
              : []),
            ...(react.external.length
              ? [`${react.external.length} third-party URL(s) stay external: ${react.external.slice(0, 5).join(', ')}`]
              : []),
          ],
        })
      }

      const ext = format === 'jpg' ? 'jpg' : 'png'
      const q = ext === 'jpg' ? `&quality=${quality ?? 90}` : ''
      return structured({
        format: ext,
        image_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}`,
        download_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}&download`,
        width: f.width * 2,
        height: f.height * 2,
        note: 'Public URL, no auth needed. To publish: fetch the URL and upload the bytes to the target platform (e.g. WordPress POST /wp/v2/media), or hotlink it directly — it always shows the current design.',
      })
    },
  )

  tool(
    'export_canvas',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Export a whole canvas',
      description:
        "Hand a canvas to a human's machine in one piece. format: 'manifest' returns the frame list with file names and the canvas tokens. format: 'html' returns one self-contained document containing every frame, with each frame's stylesheet scoped to it (frames that style html/body or use :root are noted, since that cannot be scoped perfectly). format: 'zip' returns the same document plus every frame's original HTML as a ZIP archive: it is stored and you get back zip_url, a public download link — fetch that (no auth needed) instead of carrying the bytes through your context. format: 'code' is the developer handoff open_pull_request commits — each frame's document, its React component and build spec, the design system in three forms and the assets that travel as text — returned as a file manifest (files) plus the same stored archive. Pass inline: true only when you cannot fetch a URL and need archive_base64 in the result.",
      inputSchema: {
        canvas_id: z.string(),
        page: z.string().optional().describe('Only frames on this page (name or id, from get_canvas)'),
        format: z
          .enum(['html', 'manifest', 'zip', 'tokens', 'code'])
          .optional()
          .describe(
            'default manifest; "tokens" returns the design tokens as JSON + plain CSS + a Tailwind v4 @theme block; "code" returns the repository file set as a manifest plus a stored archive',
          ),
        inline: z
          .boolean()
          .optional()
          .describe('zip/code only: return archive_base64 in the result instead of zip_url (default false)'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        format: z.string(),
        filename: z.string(),
        frames: z.array(
          z.object({ id: z.string(), name: z.string(), file: z.string(), width: z.number(), height: z.number() }),
        ),
        tokens_css: z.string(),
        tokens_json: z.string().optional(),
        tokens_dtcg: z.string().optional(),
        tailwind_css: z.string().optional(),
        design_md: z.string().optional(),
        html: z.string().optional(),
        /** code format: the repository paths the archive holds */
        files: z.array(z.string()).optional(),
        /** code format: the pull request this file set is meant to be opened as */
        pr: z.object({ title: z.string(), body: z.string() }).optional(),
        zip_url: z.string().optional(),
        archive_base64: z.string().optional(),
        bytes: z.number().optional(),
        notes: z.array(z.string()),
      },
    },
    async ({ canvas_id, page, format, agent_name, inline }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      if (agent_name) await arrive(canvas_id, agent_name)
      let pageId: string | undefined
      if (page !== undefined) {
        const resolved = resolvePage(canvas_id, page)
        if (resolved.error !== undefined) return err('invalid_input', resolved.error)
        pageId = resolved.page.id
      }
      const frames = c.frames.filter((f) => !f.demo).filter((f) => pageId === undefined || f.pageId === pageId)
      if (frames.length === 0) return err('not_found', 'this canvas has no frames to export')
      const tokens = c.tokens

      const manifest = frames.map((f, index) => ({
        id: f.id,
        name: f.name,
        file: `${String(index + 1).padStart(2, '0')}-${f.id}.html`,
        width: Math.round(f.width),
        height: Math.round(f.height),
      }))
      /* what the frames reference: the assets this instance serves, and the
         third-party URLs no export can carry */
      const assetsInExport = [...new Set(frames.flatMap((f) => [...assets.extractAssetIds(f.html)]))]
      const externalInExport = [...new Set(frames.flatMap((f) => rewriteAssetUrls(f.html, '').external))]
      const base = {
        filename: `${c.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'canvas'}.doop`,
        frames: manifest,
        tokens_css: tokens ? cssForTokens(tokens) : '',
      }
      /* The archive is the largest payload this surface can emit, and inlined
         base64 puts all of it in the agent's context. It is stored through the
         asset store instead and handed back as a public URL, which is also what
         the /a/<id>.<ext> route already serves. `inline: true` keeps the old
         shape for a client that cannot fetch a URL, and a store that refuses an
         oversized archive falls back to it too: a storage failure must not cost
         the caller its export. */
      const storeArchive = async (
        filename: string,
        archive: Buffer,
        notes: string[],
      ): Promise<Record<string, unknown>> => {
        const inlineNote = 'archive_base64 is a ZIP file: decode it and write it to disk, then unzip.'
        if (inline)
          return {
            filename,
            archive_base64: archive.toString('base64'),
            bytes: archive.length,
            notes: [...notes, inlineNote],
          }
        try {
          const asset = await assets.createAsset(archive, {
            canvasId: canvas_id,
            ownerId,
            uploadedBy: actorFrom(agent_name).name,
          })
          return {
            filename,
            zip_url: `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`,
            bytes: archive.length,
            notes: [
              ...notes,
              'zip_url serves the archive from this server with no auth — fetch it and unzip; the bytes are not in this result.',
            ],
          }
        } catch (e) {
          return {
            filename,
            archive_base64: archive.toString('base64'),
            bytes: archive.length,
            notes: [
              ...notes,
              `the archive could not be stored for download (${e instanceof Error ? e.message : 'storage failed'}), so it is returned inline.`,
              inlineNote,
            ],
          }
        }
      }
      if (format === undefined || format === 'manifest') return structured({ format: 'manifest', ...base, notes: [] })

      if (format === 'tokens') {
        if (!tokens) return err('not_found', 'this canvas has no design tokens — set them with set_tokens first')
        return structured({
          format: 'tokens',
          ...base,
          filename: `${base.filename}.tokens.json`,
          tokens_json: tokensJson(tokens),
          tokens_dtcg: tokensDtcg(tokens),
          tailwind_css: tailwindThemeCss(tokens),
          design_md: designMd(tokens, c),
          notes: [
            'tokens_json is the raw DesignTokens document; tokens_dtcg is the same tokens in W3C Design Tokens (DTCG 2025.10) form; tailwind_css is a Tailwind v4 @theme block ready to paste into your global stylesheet; design_md is the design system written out as DESIGN.md.',
          ],
        } as never)
      }

      if (format === 'html') {
        let bundle
        try {
          bundle = await htmlBundle(frames, tokens)
        } catch (e) {
          return err('upstream_failed', e instanceof Error ? e.message : 'could not render the frames for export')
        }
        return structured({
          format: 'html',
          ...base,
          filename: `${base.filename}.html`,
          html: bundle.html,
          notes: [
            ...bundle.notes,
            ...(assetsInExport.length
              ? [
                  `${assetsInExport.length} asset reference(s) in these frames are served by this Doop instance and are not inside a single HTML file — export format 'zip' bundles them under assets/ and rewrites the references.`,
                ]
              : []),
            ...(externalInExport.length
              ? [
                  `${externalInExport.length} third-party URL(s) stay external: ${externalInExport.slice(0, 5).join(', ')}`,
                ]
              : []),
          ],
        })
      }

      if (format === 'code') {
        /* The developer handoff, built without a GitHub connection: the same
           file set open_pull_request commits. It renders every frame (JSX and
           specs come from the browser), so it spends the render budget the way
           the zip export does — one unit per frame. */
        for (const _frame of frames) {
          const budget = takeRender(agent_name)
          if (budget) return budget
        }
        let handoff
        try {
          handoff = await handoffFiles(canvas_id, pageId === undefined ? {} : { pageId })
        } catch (e) {
          if (e instanceof HandoffError) return err(e.code, e.message)
          return err('upstream_failed', e instanceof Error ? e.message : 'could not build the code handoff')
        }
        const file = (path: string) => handoff.files.find((entry) => entry.path === path)?.content
        const designMdContent = file('design/DESIGN.md')
        const dtcg = file('design/tokens.dtcg.json')
        const tailwind = file('design/tailwind.css')
        const archive = buildZip(handoff.files.map((entry) => ({ name: entry.path, content: entry.content })))
        return structured({
          format: 'code',
          ...base,
          filename: `${base.filename}.code.zip`,
          files: handoff.files.map((entry) => entry.path),
          ...(designMdContent === undefined ? {} : { design_md: designMdContent }),
          ...(dtcg === undefined ? {} : { tokens_dtcg: dtcg }),
          ...(tailwind === undefined ? {} : { tailwind_css: tailwind }),
          pr: handoff.pr,
          ...(await storeArchive(`${base.filename}.code.zip`, archive, [
            ...handoff.notes,
            'files lists every path in the archive; the archive itself is the file set open_pull_request commits to a branch.',
          ])),
        } as never)
      }

      let bundle
      try {
        bundle = await htmlBundle(frames, tokens)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render the frames for export')
      }
      /* one spec per frame: the measurements a developer builds from. Rendered
         sequentially, like every other multi-frame render here — they share one
         headless browser. */
      const notes = [...bundle.notes]
      const specs: { name: string; content: string }[] = []
      for (const [index, f] of frames.entries()) {
        /* one Chromium page per frame, so the loop spends the budget per
           render instead of once per call */
        const budget = takeRender()
        if (budget) {
          notes.push(`no spec for ${manifest[index]!.file}: ${resultSummary(budget)}`)
          continue
        }
        const probe = await specProbe(f)
        if (!probe) {
          notes.push(`no spec for ${manifest[index]!.file}: the frame could not be rendered to measure it`)
          continue
        }
        const [report] = await persist.listFrameReviews(f.id, 1)
        specs.push({
          name: `specs/${manifest[index]!.file.replace(/\.html$/, '.spec.md')}`,
          content: specMd(f, report, probe, tokens),
        })
      }
      const index = [
        `# ${c.name}`,
        '',
        `${frames.length} frame(s), exported from Doop.`,
        '',
        ...manifest.map((entry) => `- ${entry.file} — ${entry.name} (${entry.width}x${entry.height})`),
        '',
        'Open canvas.html for a single-page render of all of them.',
        '',
        ...(specs.length
          ? [
              'Each frame has a build spec under specs/: its measurements, type ramp, colors and structure, plus the verification report it was checked against.',
              '',
            ]
          : []),
        ...(tokens
          ? [
              'DESIGN.md is the design system in prose; tokens.dtcg.json is the same tokens in W3C Design Tokens form; AGENTS.md tells an agent how to work on this canvas.',
              '',
            ]
          : ['AGENTS.md tells an agent how to work on this canvas.', '']),
      ].join('\n')
      /* the assets the frames reference, fetched once and written under
         assets/ — an archive that renders offline has to carry its own bytes */
      const bundled: { name: string; content: Buffer; time?: number }[] = []
      const missingAssets: string[] = []
      for (const id of assetsInExport) {
        const asset = await assets.getCanvasAsset(canvas_id, id)
        if (!asset) {
          missingAssets.push(id)
          continue
        }
        /* the stored row's url is `/a/<id>.<ext>`, and the archive writes the
           asset under the same name so a rewritten reference resolves */
        bundled.push({ name: `assets/${asset.url.replace(/^\/a\//, '')}`, content: asset.data })
      }
      const bundledPaths = bundled.map((entry) => entry.name)
      /* where each frame's document lands in THIS archive, for DESIGN.md */
      const frameFile = new Map(frames.map((f, index) => [f.id, `frames/${manifest[index]!.file}`]))
      const archive = buildZip([
        { name: 'canvas.html', content: rewriteAssetUrls(bundle.html, '').html },
        { name: 'README.md', content: index },
        ...specs,
        ...(bundle.fontsCss ? [{ name: 'fonts.css', content: bundle.fontsCss }] : []),
        ...bundled,
        ...(tokens
          ? [
              { name: 'tokens.css', content: cssForTokens(tokens) },
              { name: 'tokens.json', content: tokensJson(tokens) },
              { name: 'tokens.dtcg.json', content: tokensDtcg(tokens) },
              { name: 'tailwind.css', content: tailwindThemeCss(tokens) },
            ]
          : []),
        { name: 'DESIGN.md', content: designMd(tokens, c, (frame) => frameFile.get(frame.id) ?? '') },
        { name: 'AGENTS.md', content: agentsMd(c, `${PUBLIC_ORIGIN}/mcp`) },
        ...frames.map((f, index) => ({
          name: `frames/${manifest[index]!.file}`,
          content: rewriteAssetUrls(f.html, '../').html,
          time: f.updatedAt,
        })),
      ])
      const exportNotes = [
        ...notes,
        ...(bundledPaths.length
          ? [`${bundledPaths.length} asset(s) bundled under assets/ and the references rewritten to match.`]
          : []),
        ...(missingAssets.length
          ? [
              `${missingAssets.length} asset id(s) could not be read and are missing from the archive: ${missingAssets.join(', ')}`,
            ]
          : []),
        ...(externalInExport.length
          ? [`${externalInExport.length} third-party URL(s) stay external: ${externalInExport.slice(0, 5).join(', ')}`]
          : []),
        ...(bundle.fontsCss ? ['fonts.css carries the frames’ @font-face rules and linked stylesheets.'] : []),
      ]
      const filename = `${base.filename}.zip`
      return structured({
        format: 'zip',
        ...base,
        ...(await storeArchive(filename, archive, exportNotes)),
      } as never)
    },
  )

  tool(
    'upload_asset',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Upload an image asset',
      description:
        'Upload an image (png/jpg/webp/gif/svg, max 5 MB) and get back a permanent public URL to reference in frame HTML (<img src>, CSS background) — use this instead of inlining data: URIs. Pick ONE input by where the file lives: (1) remote — pass source_url and the server fetches it; (2) LOCAL FILE — pass local_file=true to receive a one-time upload URL and a ready-to-run curl command, run it in your shell, and the curl response JSON contains the permanent url. (3) data — base64, LAST RESORT for tiny files (under ~100 KB) when you cannot run shell commands; larger base64 payloads are slow and corrupt easily.',
      inputSchema: {
        source_url: z.string().optional().describe('Public http(s) URL to fetch the file from (remote files)'),
        local_file: z
          .boolean()
          .optional()
          .describe('true = the file is on YOUR machine: returns a one-time upload URL + curl command to run'),
        data: z
          .string()
          .optional()
          .describe('The file as base64 (raw base64 or a data: URL). Last resort, tiny files only.'),
        canvas_id: z.string().describe('The canvas this asset belongs to'),
        op_id: opId,
        agent_name: agentName,
      },
    },
    async ({ data, source_url, local_file, canvas_id, agent_name, op_id }) => {
      const provided = [data, source_url, local_file].filter(Boolean).length
      if (provided !== 1)
        return err(
          'invalid_input',
          'provide exactly one of: source_url (remote file), local_file=true (local file — returns a curl command), or data (small base64)',
        )
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (uploadHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= UPLOADS_PER_MIN) return err('rate_limited', 'upload rate limit — wait a minute')
      hits.push(now)
      uploadHits.set(limitKey, hits)
      if (local_file) {
        const { token, expiresAt } = assets.createUploadTicket({
          canvasId: canvas_id,
          ownerId,
          uploadedBy: agent_name,
        })
        const upload_url = `${PUBLIC_ORIGIN}/u/${token}`
        return text({
          ok: true,
          upload_url,
          command: `curl -sS -T "<path-to-your-file>" ${upload_url}`,
          expires_at: new Date(expiresAt).toISOString(),
          note: 'One-time upload URL (single use, 15 min). Run the curl command in your shell with your real file path — its JSON response contains the permanent public url to use in frame HTML. Request a fresh ticket for each file.',
        })
      }
      try {
        /* only the branches that store a file are replayed: an upload ticket is
           single-use, so a retry has to mint a fresh one */
        const payload = await replayAsync(ownerId ?? '', op_id, async () => {
          const buf = data
            ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
            : await assets.fetchRemote(source_url!)
          const asset = await assets.createAsset(buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
          const url = `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`
          return {
            ok: true as const,
            url,
            mime: asset.mime,
            size_bytes: asset.size,
            usage: `<img src="${url}" alt="">`,
            note: 'Permanent public URL — safe to reference in any frame on any canvas.',
          }
        })
        return structured(payload)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'upload failed')
      }
    },
  )

  tool(
    'search_images',
    {
      /* a read of Pexels, but not a free one: it spends the shared quota the
         whole server draws on, so the hint warns a client. No review policy
         refuses it: the call fetches a page of results and mutates nothing,
         so there is no gate here to pass through */
      annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true },
      title: 'Search stock photos',
      description:
        'Search free stock photography (Pexels) and get back candidate photos WITH visual thumbnails — look at them and pick the one that fits the frame\'s mood, palette and crop. Use concrete, scene-level queries ("team collaborating loft office", not "business"). Embed the returned image_url directly in frame HTML (hotlinking is fine and license-safe), or pass it to upload_asset source_url for a permanent copy on this origin. Always write a real alt text.',
      inputSchema: {
        query: z.string().describe('Scene-level description of the photo you want'),
        orientation: z
          .enum(['landscape', 'portrait', 'square'])
          .optional()
          .describe('Match the slot the photo will fill'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z
          .string()
          .optional()
          .describe('The canvas you are designing on — keeps this call attributed on the canvas run timeline'),
        agent_name: agentName,
      },
    },
    async ({ query, orientation, count, agent_name }) => {
      if (!imageSearch.photoSearchEnabled())
        return err(
          'unsupported',
          'photo search is not configured on this server (PEXELS_API_KEY is not set) — draw the visual as inline SVG/CSS instead, or ask your human for an image to upload',
        )
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate_limited', 'search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const photos = await imageSearch.searchPhotos(query, { orientation, count })
        if (photos.length === 0)
          return text({ ok: true, photos: [], note: `No results for "${query}" — try a broader or more visual query.` })
        const thumbs = await Promise.all(photos.map((p) => imageSearch.fetchThumb(p.thumb_url)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [
          {
            type: 'text' as const,
            text: `${photos.length} photo(s) for "${query}" — thumbnails below, pick by number:`,
          },
        ]
        photos.forEach((p, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({
            type: 'text' as const,
            text: `#${i + 1}${p.alt ? ` — ${p.alt}` : ''} (${p.width}×${p.height}, avg ${p.avg_color}, by ${p.photographer})\nimage_url: ${p.image_url}`,
          })
        })
        content.push({
          type: 'text' as const,
          text: 'Embed the chosen image_url directly (<img src> or CSS background, object-fit: cover), or upload_asset with source_url for a permanent copy. Pexels license: free to use and modify, no attribution required.',
        })
        const result = { content }
        return result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'photo search failed')
      }
    },
  )

  tool(
    'list_backgrounds',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'List backgrounds',
      description:
        'Browse a curated library of premium backgrounds for hero sections, section bands and bento tiles — soft glows, grainy meshes, aurora ribbons, neon, painterly landscapes — as a page of thumbnails you look at, each with palette hexes and a ready-to-paste CSS line that includes a legibility scrim. Reach for it when a hero or full-bleed section wants atmosphere, depth or a focal glow; a quiet typographic design can stay flat, but a default two-stop gradient is rarely right. Filter by tone (light/dark — match your copy color), slot and style; an optional query ("warm sunset", "dark teal") only reorders. Then decide like a designer: does one of these genuinely fit the frame\'s style and palette? If yes, use it and put the copy in its text_zone. If not, call again with a different filter, or draw the background yourself.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Mood / palette words to put first, e.g. "warm sunset glow" — reorders, never filters'),
        tone: z
          .enum(backgrounds.BACKGROUND_TONES)
          .optional()
          .describe('light = dark copy on it, dark = light copy on it'),
        style: z.enum(backgrounds.BACKGROUND_STYLES).optional().describe('Restrict to one look'),
        slot: z
          .enum(backgrounds.BACKGROUND_SLOTS)
          .optional()
          .describe('Where it goes: hero, section band, or card/bento tile'),
        count: z.number().min(1).max(24).optional().describe('Thumbnails to return, default 12'),
        canvas_id: z
          .string()
          .optional()
          .describe('The canvas you are designing on — keeps this call attributed on the canvas run timeline'),
        agent_name: agentName,
      },
    },
    async ({ query, tone, style, slot, count }) => {
      if (!backgrounds.backgroundsEnabled())
        return err(
          'unsupported',
          'the background library is empty on this server — draw the background as CSS (layered radial-gradients with a grain overlay) instead',
        )
      try {
        const listing = backgrounds.browseBackgrounds({ query, tone, style, slot, count }, PUBLIC_ORIGIN)
        const { results } = listing
        if (results.length === 0)
          return text({
            ok: true,
            backgrounds: [],
            note: 'No backgrounds match the tone/style/slot filters you set — drop one and call again.',
          })
        const thumbs = await Promise.all(results.map((r) => backgrounds.fetchThumb(r.id)))
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: backgrounds.listHeadline(listing, query) }]
        results.forEach((r, i) => {
          const thumb = thumbs[i]
          if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
          content.push({ type: 'text' as const, text: backgrounds.describeBackground(r, i) })
        })
        content.push({ type: 'text' as const, text: backgrounds.BACKGROUND_USAGE_NOTE })
        const result = { content }
        return result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'background search failed')
      }
    },
  )

  /* ---- motion, brand, images, fonts: the senses beyond a screenshot ---- */

  tool(
    'get_motion_context',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read a frame’s motion',
      description:
        'What a frame does over time, which no screenshot shows: the keyframes and media queries its stylesheet declares, which elements run transitions or animations and for how long, and whether it honors reduced motion. Scope with selector for one subtree. Use it before judging animation work, or when a frame feels "slow" and you need the numbers.',
      inputSchema: {
        frame_id: z.string(),
        selector: z.string().optional().describe('Scope the report to this element and its descendants'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, selector, agent_name }) => {
      const budget = takeRender(agent_name)
      if (budget) return budget
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      try {
        const report = await motionFrame(f, { ...(selector ? { selector } : {}) })
        return structured({ frame_id, ...report })
      } catch (e) {
        return err(
          'upstream_failed',
          e instanceof Error ? e.message : 'could not render this frame for the motion read',
        )
      }
    },
  )

  tool(
    'check_brand_compliance',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Check brand rules',
      description:
        'Check a rendered frame against the brand rules a style guide declares in its "## Brand rules" section — palette, forbidden colors, licensed fonts, logo presence, minimum contrast. Read get_guidelines first: the section heading and the `- kind: value` lines are the grammar this checks. Verdict pass/fail with per-violation selectors; blocking rules (marked with `blocking: <id>`) report as blocking.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        guideline: z
          .string()
          .optional()
          .describe('Which style guide holds the brand rules; default is the design-system doc, else the first guide'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, frame_id, guideline, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id) return noFrame(frame_id)
      await arrive(canvas_id, agent_name)
      const budget = takeRender(agent_name)
      if (budget) return budget
      const docs = store.getGuidelines(canvas_id)
      const doc = guideline
        ? docs.find((d) => d.name === guideline.trim().toLowerCase())
        : (docs.find((d) => d.name === 'design-system') ?? docs[0])
      if (guideline && !doc)
        return err(
          'not_found',
          docs.length
            ? `no style guide named “${guideline}” — this canvas has: ${docs.map((d) => d.name).join(', ')}`
            : 'no style guides on this canvas yet — brand rules live in a guide’s "## Brand rules" section',
        )
      if (!doc)
        return err(
          'not_found',
          'no style guides on this canvas yet — brand rules live in a guide’s "## Brand rules" section',
        )
      try {
        const report = await checkBrandCompliance(f, doc.markdown)
        return structured({ frame_id, guideline: doc.name, ...report })
      } catch (e) {
        return err(
          'upstream_failed',
          e instanceof Error ? e.message : 'could not render this frame for the brand check',
        )
      }
    },
  )

  tool(
    'generate_image',
    {
      /* destructive: it spends the account's provider budget and leaves a
         stored asset behind, so a canvas on the `destructive` policy gates it */
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      title: 'Generate an image',
      description:
        'Generate images from a prompt through the configured provider and store them as canvas assets with permanent /a/ URLs ready for <img src>. Real imagery beats placeholder tiles; reference_asset_ids (existing canvas assets) steer composition and style. The provider bill follows the connected account, else the server key. Generation takes tens of seconds per image.',
      inputSchema: {
        canvas_id: z.string(),
        prompt: z
          .string()
          .min(1)
          .max(2000)
          .describe('Scene-level description of the image, not a label — describe light, subject, mood'),
        size: z.enum(['1024x1024', '1536x1024', '1024x1536']).describe('Square, landscape or portrait'),
        count: z.number().int().min(1).max(4).default(1).describe('How many candidates, default 1'),
        reference_asset_ids: z
          .array(z.string())
          .max(3)
          .optional()
          .describe('Canvas assets to steer the result (product shot, face, illustration style)'),
        style: z
          .string()
          .max(200)
          .optional()
          .describe('A style modifier folded into the prompt, e.g. "flat vector, muted palette"'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        images: z.array(z.object({ url: z.string(), bytes: z.number() })),
      },
    },
    async ({ canvas_id, prompt, size, count, reference_asset_ids, style, agent_name, op_id }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      actions.assertAgentToolAllowed(canvas_id, actorFrom(agent_name), 'generate_image', { destructive: true })
      if (imageProvider() === 'none')
        return err(
          'unsupported',
          `no image provider is configured on this server — ${IMAGE_NOT_CONFIGURED}. Until then, draw with inline SVG/CSS, or search_images for photography.`,
        )
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (imageHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMAGES_PER_MIN)
        return err('rate_limited', `image generation rate limit (${IMAGES_PER_MIN}/min) — wait a minute`)
      hits.push(now)
      imageHits.set(limitKey, hits)
      try {
        const references: Buffer[] = []
        for (const id of reference_asset_ids ?? []) {
          const asset = await assets.getAsset(id)
          if (!asset) return err('not_found', `no asset with id ${id} — list_assets has the canvas's own`)
          references.push(asset.buf)
        }
        const payload = await replayAsync(ownerId ?? '', op_id, async () => {
          const generated = await generateImage({
            prompt,
            size,
            count,
            ...(style ? { style } : {}),
            referenceImages: references,
          })
          const images: { url: string; bytes: number }[] = []
          for (const { png } of generated) {
            const asset = await assets.createAsset(png, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
            images.push({ url: `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`, bytes: asset.size })
          }
          return { ok: true as const, images }
        })
        return textWithNudge(
          payload,
          'Embed with <img src> and real alt text; always get_frame_screenshot to see it in place. Do not inline data: URIs — the URLs are permanent.',
        )
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'image generation failed')
      }
    },
  )

  tool(
    'upload_font',
    {
      /* destructive: it stores an asset and fetches remote bytes, so a canvas
         on the `destructive` policy gates it */
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Upload a font',
      description:
        "Store a font file (woff2/woff/ttf, max 5 MB) as a canvas asset and get back a ready-to-paste @font-face block plus the permanent /a/ URL — put it in set_frame_css or the frame's own <style> and the family renders on the canvas. Exactly one of source_url (remote file) or data (base64) names where the bytes come from.",
      inputSchema: {
        canvas_id: z.string(),
        source_url: z.string().optional().describe('Public http(s) URL to fetch the font from'),
        data: z
          .string()
          .optional()
          .describe('The font file as base64 (raw or a data: URL) — last resort for tiny files'),
        family: z.string().min(1).max(120).describe('The font-family name to declare, e.g. "Inter Tight"'),
        weight: z.number().int().min(100).max(900).optional().describe('Weight this file carries, e.g. 400'),
        style: z.enum(['normal', 'italic']).optional().describe('Style this file carries, default normal'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        url: z.string(),
        font_face: z.string(),
      },
    },
    async ({ canvas_id, source_url, data, family, weight, style, agent_name, op_id }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      actions.assertAgentToolAllowed(canvas_id, actorFrom(agent_name), 'upload_font', { destructive: true })
      const provided = [source_url, data].filter(Boolean).length
      if (provided !== 1)
        return err('invalid_input', 'provide exactly one of source_url (remote file) or data (base64)')
      try {
        const payload = await replayAsync(ownerId ?? '', op_id, async () => {
          const buf = data
            ? Buffer.from(data.replace(/^data:[^,]*;base64,/, ''), 'base64')
            : await assets.fetchRemote(source_url!)
          const asset = await assets.createAsset(buf, { canvasId: canvas_id, ownerId, uploadedBy: agent_name })
          const url = `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`
          const src = `url('${url}') format('${asset.ext === 'ttf' ? 'truetype' : asset.ext}')`
          const font_face = [
            '@font-face {',
            `  font-family: '${family}';`,
            `  src: ${src};`,
            ...(weight ? [`  font-weight: ${weight};`] : []),
            ...(style ? [`  font-style: ${style};`] : []),
            '  font-display: swap;',
            '}',
          ].join('\n')
          return { ok: true as const, url, font_face }
        })
        return text({
          ...payload,
          usage: `Paste font_face into set_frame_css (or the frame's <style>), then use font-family: '${family}' — the frame renders it once the face is declared.`,
        })
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'font upload failed')
      }
    },
  )

  tool(
    'search_icons',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Search icons',
      description:
        'Search 200,000+ open-source UI icons (Iconify: Material, Lucide, Tabler, Phosphor, …) and get hotlinkable SVG URLs for frame HTML. Search one concept per call ("shopping cart", "arrow right") — multi-concept queries return nothing; call once per icon. Results are semantically named ids — pick by name. For company/brand logos use search_logos instead.',
      inputSchema: {
        query: z.string().describe('A single icon concept, e.g. "light bulb"'),
        limit: z.number().min(1).max(48).optional().describe('Max results, default 24'),
        canvas_id: z
          .string()
          .optional()
          .describe('The canvas you are designing on — keeps this call attributed on the canvas run timeline'),
        agent_name: agentName,
      },
    },
    async ({ query, limit }) => {
      try {
        const icons = await imageSearch.searchIcons(query, { limit })
        const result = text({
          ok: true,
          icons,
          ...(icons.length === 0 ? { note: `No results for "${query}" — try a synonym or broader concept.` } : {}),
          usage: imageSearch.ICON_USAGE_NOTE,
        })
        return result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'icon search failed')
      }
    },
  )

  tool(
    'search_logos',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Search company logos',
      description:
        'Find a company\'s logo by brand name or domain — returns the company\'s real mark as a hotlinkable URL (a thumbnail is included when possible so you can confirm the brand), plus open-source vector marks (SVG) for well-known brands. One company per call — for a logo wall, call once per brand. The exact domain ("acme.io") resolves far more reliably than a name ("Acme"). Use for customer-logo walls, "works with" integration rows, testimonial cards, press bars. Mind each result\'s size guidance: favicon-sourced logos are small rasters — never scale them up.',
      inputSchema: {
        query: z.string().describe('A single company name or domain, e.g. "vercel.com"'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z
          .string()
          .optional()
          .describe('The canvas you are designing on — keeps this call attributed on the canvas run timeline'),
        agent_name: agentName,
      },
    },
    async ({ query, count, agent_name }) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate_limited', 'search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        const { brands, vector } = await imageSearch.lookupLogos(query, count)
        if (brands.length === 0 && vector.length === 0)
          return text({
            ok: true,
            logos: [],
            note: `No logo found for "${query}" — retry with the company's exact domain (e.g. "acme.io"). If that also fails, search a different real brand instead of drawing a placeholder, or ask your human for a logo file to upload_asset.`,
          })
        type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        const content: ResultBlock[] = [{ type: 'text' as const, text: `Logo results for "${query}":` }]
        if (brands.length > 0) {
          const thumbs = await Promise.all(brands.map((b) => imageSearch.fetchThumb(b.thumb_url)))
          brands.forEach((b, i) => {
            const thumb = thumbs[i]
            if (thumb) content.push({ type: 'image' as const, data: thumb.data, mimeType: thumb.mime })
            content.push({
              type: 'text' as const,
              text: `#${i + 1} — ${b.name} (${b.domain})\nlogo_url: ${b.logo_url}`,
            })
          })
        }
        if (vector.length > 0) {
          content.push({
            type: 'text' as const,
            text: `Open-source vector marks:\n${vector.map((v) => `${v.id} → ${v.svg_url}`).join('\n')}`,
          })
        }
        content.push({ type: 'text' as const, text: imageSearch.LOGO_USAGE_NOTE })
        const result = { content }
        return result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'logo search failed')
      }
    },
  )

  tool(
    'view_website',
    {
      title: 'View a website',
      description:
        'Read-only inspection of a public web page: acquires its current HTML and returns a locally rendered desktop screenshot plus visible text without changing the canvas. Use it to study real copy, structure and branding. When the page should appear on the canvas as an editable source frame, use import_webpage instead.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        agent_name: agentName,
      },
    },
    async ({ url, agent_name }, extra) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate_limited', 'rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        await progress(extra, 0, `Loading ${url}…`)
        const site = await viewWebsite(url)
        await progress(extra, 1, `Loaded ${site.finalUrl}.`)
        const result = {
          content: [
            { type: 'image' as const, data: site.screenshot.toString('base64'), mimeType: 'image/jpeg' },
            {
              type: 'text' as const,
              text:
                `${site.title || site.finalUrl} — ${site.finalUrl}` +
                (site.description ? `\nMeta description: ${site.description}` : '') +
                (site.shotCropped
                  ? `\nNote: the page is ${site.pageHeight}px tall — the screenshot shows only the top portion.`
                  : '') +
                `\n\nVisible page text${site.textTruncated ? ' (truncated)' : ''}:\n${site.text}`,
            },
          ],
        }
        return result
      } catch (e) {
        return err(
          'upstream_failed',
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'website view failed'),
        )
      }
    },
  )

  tool(
    'import_webpage',
    {
      title: 'Import an editable webpage',
      description:
        'Import ONE public webpage into a canvas as an editable HTML snapshot. The rendered DOM is captured, scripts/iframes are removed, stylesheets are inlined, and the resulting source frame appears on the canvas for comparison or editing. Use this when a referenced or redesign-target page should be visible to everyone; leave the imported source frame unchanged and make the new design in a separate frame. With as_reference: true the page is instead pinned to the canvas Memory as a style reference and no frame is left behind — that is the right call when the page is a look-and-feel reference rather than something to compare against. For inspection without changing the canvas, use view_website.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        canvas_id: z.string().describe('Canvas that should receive the imported source frame'),
        as_reference: z
          .boolean()
          .optional()
          .describe(
            'Pin the page to the canvas Memory as a style reference instead of leaving the source frame on the canvas (default false)',
          ),
        agent_name: agentName,
      },
    },
    async ({ url, canvas_id, agent_name, as_reference }, extra) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await progress(extra, 0, `Fetching ${url}…`)
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeImportUrl(url).href
      } catch (e) {
        return err('invalid_input', e instanceof Error ? e.message : 'invalid webpage URL')
      }
      const gate = takeImport(agent_name)
      if (gate) return gate
      try {
        const actor = actorFrom(agent_name)
        const { imported, frame } = await createImportedWebpageFrame({
          canvasId: canvas_id,
          url: normalizedUrl,
          actor,
          includePreview: true,
        })
        if (!frame) return noCanvas(canvas_id)
        await progress(extra, 1, `Imported ${normalizedUrl}.`)

        /* as_reference: the page is source material, not a frame to keep — pin
           it to Memory and take the frame back off the canvas, so a reference
           import never litters the canvas with the thing it references. */
        if (as_reference) {
          const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []
          const preview = imported.preview
          if (preview) {
            content.push({ type: 'image', data: preview.screenshot.toString('base64'), mimeType: 'image/jpeg' })
          }
          let ref: MemoryReference | undefined
          try {
            ref = actions.pinReference(canvas_id, frame.id, actor)
          } catch (e) {
            /* pinReference refuses a duplicate pin and a full Memory — both are
               the caller's to act on, not an upstream failure */
            return err('conflict', e instanceof Error ? e.message : 'could not pin this page to Memory', {
              hint: 'call get_canvas to see what Memory already holds, or import without as_reference',
            })
          }
          if (!ref) return noCanvas(canvas_id)
          actions.deleteFrame(frame.id, actor)
          content.push({
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                reference: {
                  reference_id: ref.id,
                  title: ref.title,
                  width: Math.round(ref.width),
                  height: Math.round(ref.height),
                },
                source_url: preview?.finalUrl ?? normalizedUrl,
                note: `Pinned “${ref.title}” to the canvas Memory as a style reference — read it with get_reference, and call get_canvas to see it listed. No source frame was left on the canvas.`,
              },
              null,
              2,
            ),
          })
          return { content }
        }

        const preview = imported.preview
        const content: Array<{ type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }> = []
        if (preview) {
          content.push({ type: 'image', data: preview.screenshot.toString('base64'), mimeType: 'image/jpeg' })
        }
        content.push({
          type: 'text',
          text:
            JSON.stringify(
              {
                ok: true,
                frame: frameSummary(frame),
                source_url: preview?.finalUrl ?? normalizedUrl,
                snapshot: 'editable HTML; scripts, iframes and noscript content removed; linked stylesheets inlined',
              },
              null,
              2,
            ) +
            (preview?.description ? `\nMeta description: ${preview.description}` : '') +
            (preview?.shotCropped
              ? `\nThe source page is ${preview.pageHeight}px tall; the preview shows its top 4000px.`
              : '') +
            (preview ? `\n\nVisible source text${preview.textTruncated ? ' (truncated)' : ''}:\n${preview.text}` : '') +
            '\n\nThe editable snapshot is now on the canvas. If it is source material for a separate design, leave it unchanged; if the import itself is the requested deliverable, it is ready to use or edit.',
        })
        const result = { content }
        return result
      } catch (e) {
        return err(
          'upstream_failed',
          websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'webpage import failed'),
        )
      }
    },
  )

  tool(
    'extract_design_system',
    {
      title: 'Derive a design system from a frame or a URL',
      description:
        'Read a rendered page — an imported frame, an existing frame, or a live URL — and derive its design system: the palette, type families, size/weight/line-height scales, spacing and radii, each with how many elements use it. Returns the candidate tokens plus a written guide. Use this after importing a reference site, or on a canvas that has no tokens yet, then apply: true to make the canvas use them (every frame renders with them bound in). Without apply it is a read: nothing changes.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string().optional().describe('Frame to derive from (exactly one of frame_id / url)'),
        url: z.string().optional().describe('Public page to capture and derive from (exactly one of frame_id / url)'),
        apply: z
          .boolean()
          .optional()
          .describe('Write the derived tokens and guide to the canvas instead of only returning them'),
        agent_name: agentName,
      },
      outputSchema: {
        tokens: z.record(z.string(), z.unknown()),
        markdown: z.string(),
        evidence: z.record(z.string(), z.unknown()),
        notes: z.array(z.string()),
        applied: z.boolean(),
      },
    },
    async ({ canvas_id, frame_id, url, apply, agent_name }, extra) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      if (!!frame_id === !!url) return err('invalid_input', 'pass exactly one of frame_id or url')
      const actor = actorFrom(agent_name)
      const budget = takeRender(agent_name)
      if (budget) return budget

      let probe: Probe
      let source: string
      if (frame_id) {
        const frame = frameFor(frame_id)
        if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
        source = `frame “${frame.name}”`
        await progress(extra, 0, `Rendering ${source} to read its design…`)
        try {
          probe = await probeFrame(frame)
          await progress(extra, 1, `Read the design of ${source}.`)
        } catch (e) {
          return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame')
        }
      } else {
        let normalizedUrl: string
        try {
          normalizedUrl = normalizeImportUrl(url!).href
        } catch (e) {
          return err('invalid_input', e instanceof Error ? e.message : 'invalid webpage URL')
        }
        const gate = takeImport(agent_name)
        if (gate) return gate
        source = normalizedUrl
        await progress(extra, 0, `Capturing ${normalizedUrl}…`)
        try {
          const page = await importPage(normalizedUrl)
          /* a transient frame: the page is measured, never stored, so deriving
             a system from a URL leaves no frame behind */
          probe = await probeFrame({
            id: 'transient',
            canvasId: canvas_id,
            name: 'URL capture',
            x: 0,
            y: 0,
            width: page.width,
            height: page.height,
            html: page.html,
            z: 0,
            locked: false,
            hidden: false,
            rotation: 0,
            opacity: 1,
            createdAt: 0,
            updatedAt: 0,
            updatedBy: actor.name,
          })
          await progress(extra, 1, `Captured ${normalizedUrl}.`)
        } catch (e) {
          return err(
            'upstream_failed',
            websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'capture failed'),
          )
        }
      }

      const system = deriveDesignSystem(probe)
      const markdown = designSystemMarkdown(system, source)
      if (apply) {
        try {
          actions.setTokens(canvas_id, { ...system.tokens, updatedAt: 0, updatedBy: actor.name }, actor)
          actions.setGuideline(canvas_id, 'design-system', markdown, actor)
        } catch (e) {
          /* review mode is a canvas rule, not a malformed token document: let
             the tool wrapper report it as the typed refusal it is */
          if (e instanceof actions.ReviewModeError) throw e
          return err('invalid_input', e instanceof Error ? e.message : 'could not apply the derived tokens')
        }
      }
      return structured({
        tokens: system.tokens,
        markdown,
        evidence: system.evidence as unknown as Record<string, unknown>,
        notes: system.notes,
        applied: !!apply,
      })
    },
  )

  tool(
    'get_frame_content',
    {
      title: 'Read a frame as structured content',
      description:
        'Read what a frame SAYS, separately from how it looks: title and meta description, the heading outline with selectors, sections with their text, nav links, calls to action with hrefs, form fields with their labels, and images with their alt text and real pixel size. Use this on an imported page or an existing frame before rewriting its copy, and to check that a design has real content rather than placeholders.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        agent_name: agentName,
      },
      outputSchema: {
        title: z.string(),
        description: z.string(),
        headings: z.array(z.object({ level: z.number(), text: z.string(), selector: z.string() })),
        sections: z.array(
          z.object({
            selector: z.string(),
            heading: z.string().optional(),
            text: z.string(),
            imageCount: z.number(),
          }),
        ),
        nav: z.array(z.object({ text: z.string(), href: z.string() })),
        ctas: z.array(z.object({ text: z.string(), href: z.string(), selector: z.string() })),
        forms: z.array(
          z.object({
            selector: z.string(),
            fields: z.array(z.object({ label: z.string(), type: z.string(), name: z.string() })),
          }),
        ),
        images: z.array(
          z.object({
            src: z.string(),
            alt: z.string(),
            width: z.number(),
            height: z.number(),
            selector: z.string(),
          }),
        ),
        truncated: z.boolean(),
      },
    },
    async ({ canvas_id, frame_id, agent_name }) => {
      const frame = frameFor(frame_id)
      if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
      const budget = takeRender(agent_name)
      if (budget) return budget
      await arrive(canvas_id, agent_name)
      try {
        const probe = await probeFrame(frame)
        return structured(probe.content)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame')
      }
    },
  )

  tool(
    'import_site',
    {
      title: 'Import a whole site',
      description:
        'Capture a public site — its homepage plus the pages it links or lists in its sitemap — as one frame per page, on a new page of the canvas. Returns a job id immediately: capturing ten pages takes minutes, so this never blocks. Poll get_job for per-page progress and the frame ids as they land. Use import_webpage for a single page.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        canvas_id: z.string(),
        url: z.string().describe('The site to capture — a bare domain like "acme.io" is loaded over https'),
        max_pages: z.number().int().min(1).max(30).default(8).describe('How many pages to capture, default 8, max 30'),
        create_page: z
          .boolean()
          .default(true)
          .describe('Put the captured frames on a new canvas page named after the site'),
        agent_name: agentName,
      },
      outputSchema: {
        job_id: z.string(),
        total: z.number(),
        pages: z.array(z.object({ url: z.string(), title: z.string() })),
        truncated: z.boolean(),
      },
    },
    async ({ canvas_id, url, max_pages, create_page, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const gate = takeImport(agent_name)
      if (gate) return gate
      const actor = actorFrom(agent_name)

      let discovered: DiscoveredSite
      try {
        discovered = await discoverSitePages(url)
      } catch (e) {
        return err(
          'upstream_failed',
          websiteAccessErrorMessage(e, 'connected-agent') ??
            (e instanceof Error ? e.message : 'could not read that site'),
        )
      }
      if (!discovered.pages.length) return err('not_found', `no pages found at ${url}`)
      const targets = discovered.pages.slice(0, max_pages)

      /* The response is written before the capture runs, so progress is read
         from the job rather than pushed as notifications: this transport is
         stateless, so there is no stream left to notify on. */
      const job = startJob(
        {
          kind: 'import_site',
          canvasId: canvas_id,
          ...(ownerId ? { ownerId } : {}),
          ...(agent_name ? { agentName: agent_name } : {}),
          total: targets.length,
        },
        async (running) => {
          let pageId: string | undefined
          if (create_page) {
            pageId = actions.createPage(canvas_id, new URL(discovered.siteUrl).host, actor)?.id
          }
          for (const target of targets) {
            try {
              const imported = await importPage(target.url)
              const frame = actions.createFrame(
                canvas_id,
                {
                  name: imported.title.slice(0, 80) || target.title.slice(0, 80) || target.url,
                  width: imported.width,
                  height: imported.height,
                  html: imported.html,
                  ...(pageId ? { pageId } : {}),
                },
                actor,
              )
              recordUnit(running.id, { label: target.url, ok: true, ...(frame ? { frameId: frame.id } : {}) })
            } catch (e) {
              recordUnit(running.id, {
                label: target.url,
                ok: false,
                detail: e instanceof Error ? e.message : 'capture failed',
              })
            }
          }
        },
      )

      return structured({
        job_id: job.id,
        total: targets.length,
        pages: targets.map((page) => ({ url: page.url, title: page.title })),
        truncated: discovered.truncated || discovered.pages.length > targets.length,
      })
    },
  )

  tool(
    'get_job',
    {
      title: 'Read a background job',
      description:
        'Read the state of a job started by import_site: status, how far it has got, and each page’s frame id or the reason it failed. Poll this until status is done or failed — or block on several at once with wait_for_jobs.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        job_id: z.string(),
        /* reading a job is canvas-free and attributes nothing, so the name is
           optional — like get_comments */
        agent_name: agentName.optional(),
      },
      outputSchema: {
        id: z.string(),
        kind: z.string(),
        status: z.enum(['queued', 'running', 'done', 'failed']),
        total: z.number(),
        completed: z.number(),
        progress: z.object({ completed: z.number(), total: z.number() }),
        error: z.string().optional(),
        results: z.array(
          z.object({
            label: z.string(),
            ok: z.boolean(),
            detail: z.string().optional(),
            frameId: z.string().optional(),
          }),
        ),
      },
    },
    async ({ job_id }) => {
      const job = getJob(job_id)
      if (!job) return err('not_found', `no job with id ${job_id} — jobs are dropped 30 minutes after they finish`)
      /* a job belongs to the account that started it */
      if (job.ownerId && ownerId && job.ownerId !== ownerId) return err('not_found', `no job with id ${job_id}`)
      return structured({
        id: job.id,
        kind: job.kind,
        status: job.status,
        total: job.total,
        completed: job.completed,
        progress: jobProgress(job_id) ?? { completed: job.completed, total: job.total },
        ...(job.error ? { error: job.error } : {}),
        results: job.results,
      })
    },
  )

  tool(
    'wait_for_jobs',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Wait for background jobs',
      description:
        'Block until every named job settles (done or failed) or the timeout runs out — whichever first — then read each job’s state in one result instead of polling get_job in a loop. A timed_out job is not failed: call again to keep waiting. Only jobs your account started are visible.',
      inputSchema: {
        job_ids: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe('Job ids from import_site (or another job-returning call)'),
        timeout_seconds: z.number().min(5).max(120).default(60).describe('How long to block, default 60'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        jobs: z.array(
          z.object({
            job_id: z.string(),
            status: z.enum(['queued', 'running', 'done', 'failed', 'not_found']),
            completed: z.number(),
            total: z.number(),
            results: z
              .array(
                z.object({
                  label: z.string(),
                  ok: z.boolean(),
                  detail: z.string().optional(),
                  frameId: z.string().optional(),
                }),
              )
              .optional(),
          }),
        ),
        timed_out: z.boolean(),
      },
    },
    async ({ job_ids, timeout_seconds }) => {
      const before = new Map(
        job_ids.map((id) => {
          const job = getJob(id)
          return [id, job && (!job.ownerId || !ownerId || job.ownerId === ownerId) ? job.status : undefined]
        }),
      )
      await waitForJobs(
        job_ids.filter(
          (id) => before.get(id) !== undefined && before.get(id) !== 'done' && before.get(id) !== 'failed',
        ),
        (timeout_seconds ?? 60) * 1000,
      )
      const jobs = job_ids.map((id) => {
        const job = getJob(id)
        /* owner scoping reads exactly like get_job: a foreign job is no job */
        const visible = job && (!job.ownerId || !ownerId || job.ownerId === ownerId)
        return {
          job_id: id,
          status: (visible ? job!.status : 'not_found') as 'queued' | 'running' | 'done' | 'failed' | 'not_found',
          completed: visible ? job!.completed : 0,
          total: visible ? job!.total : 0,
          ...(visible && (job!.status === 'done' || job!.status === 'failed') ? { results: job!.results } : {}),
        }
      })
      return structured({
        jobs,
        timed_out: jobs.some((j) => j.status === 'queued' || j.status === 'running'),
      })
    },
  )

  tool(
    'cancel_job',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Cancel a background job',
      description:
        'Ask a running job to stop at its next unit boundary — the pages already captured stay, the rest never start. The worker owns its ending: the job reports done or failed with whatever it finished, so read the result back with get_job.',
      inputSchema: {
        job_id: z.string(),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        cancelled: z.boolean().optional(),
        completed: z.number().optional(),
        total: z.number().optional(),
      },
    },
    async ({ job_id }) => {
      const job = getJob(job_id)
      if (!job) return err('not_found', `no job with id ${job_id} — jobs are dropped 30 minutes after they finish`)
      if (job.ownerId && ownerId && job.ownerId !== ownerId) return err('not_found', `no job with id ${job_id}`)
      const cancelled = cancelJob(job_id)
      if (!cancelled) return err('conflict', `job ${job_id} has already finished — nothing to cancel`)
      return structured({
        ok: true as const,
        cancelled: true,
        completed: cancelled.completed,
        total: cancelled.total,
      })
    },
  )

  tool(
    'get_frame_screenshot',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      description:
        'Render a frame and return a PNG screenshot of it — this is how you SEE your design. Always review your work with this after creating or updating a frame, then fix what looks wrong (spacing, overflow, contrast, alignment) and check again. Iterate until it actually looks good, not just until the HTML seems right.',
      inputSchema: {
        frame_id: z.string(),
        scale: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Device scale factor: 1 (default) or 2 for a retina-resolution image'),
        device: deviceName,
        viewport: viewportOverride,
        width: z
          .number()
          .int()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            'Render at this width instead of the frame’s own — a breakpoint that is not a named device. Ignored when device or viewport is set.',
          ),
        full_page: z.boolean().optional().describe('Capture the whole document height, not just the viewport'),
        state: interactionState,
        clip: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().min(1),
            height: z.number().min(1),
          })
          .optional()
          .describe('Capture just this region of the frame, in frame pixels'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, scale, device, viewport, full_page, state, clip, width: renderWidth, agent_name }, extra) => {
      const budget = takeRender(agent_name)
      if (budget) return budget
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      await progress(extra, 0, `Rendering “${f.name}”…`)
      /* an explicit width renders one breakpoint at the frame's own height —
         how a design is checked at a width the device presets do not name */
      const resolved =
        resolveViewport(device, viewport) ?? (renderWidth ? { width: renderWidth, height: f.height } : undefined)
      if (clip && (clip.x < 0 || clip.y < 0 || clip.x + clip.width > f.width || clip.y + clip.height > f.height))
        return err(
          'invalid_input',
          `clip ${clip.x},${clip.y} ${clip.width}×${clip.height} falls outside the ${f.width}×${f.height} frame`,
        )
      try {
        const png = await renderFrame(f, scale ?? 1, {
          ...(resolved ? { viewport: resolved } : {}),
          ...(full_page ? { fullPage: true } : {}),
          ...(clip ? { clip } : {}),
          ...(state ? { state } : {}),
        })
        await progress(extra, 0.5, `Rendered “${f.name}”; encoding the PNG…`)
        const width = resolved?.width ?? f.width
        const height = resolved?.height ?? f.height
        await progress(extra, 1, `Captured “${f.name}”.`)
        return {
          content: [
            { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
            {
              type: 'text' as const,
              text: `Screenshot of “${f.name}” (${width}×${height}@${scale ?? 1}x${full_page ? ', full page' : ''}${clip ? `, clip ${clip.x},${clip.y} ${clip.width}×${clip.height}` : ''}${state ? `, ${stateLabel(state)}` : ''}, html ${f.html.length} bytes)`,
            },
          ],
        }
      } catch (e) {
        if (e instanceof StateRenderError) return err(e.code, e.message)
        return err('upstream_failed', `screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  tool(
    'append_frame_html',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Stream a design into a frame section by section — every chunk renders for viewers the moment it arrives, so they watch the design build up live. Prefer this over set_frame_html when creating or reworking a whole design. Send the HTML in document order, ONE complete section per call (head+styles first, then the hero, then each following section), roughly 1–4 KB per chunk. Set start=true on the FIRST chunk (replaces any existing content and shows a live "designing…" badge) and done=true on the LAST chunk. End chunks at element boundaries — partial HTML is healed, but a complete section paints cleanly.',
      inputSchema: {
        frame_id: z.string(),
        html_chunk: z
          .string()
          .describe(
            `The next piece of HTML, appended to what has been sent so far. Raw markup — never escaped. Max ${MAX_FRAME_HTML_BYTES} characters per call.`,
          ),
        start: z.boolean().optional().describe('true on the first chunk — clears the frame and starts the live stream'),
        done: z.boolean().optional().describe('true on the final chunk — ends the live stream'),
        expected_updated_at: z
          .string()
          .optional()
          .describe(
            "The frame's updatedAt from your last read. Send it to be told if the frame changed under you (a human editing mid-stream) instead of appending onto a base you never saw.",
          ),
        takeover: z.boolean().optional().describe('Stream into a frame another agent holds the lock on'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, html_chunk, start, done, expected_updated_at, agent_name, takeover }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      /* only the continuation of a stream has a base to be stale against: the
         opening chunk replaces whatever is there, on purpose */
      if (!start) {
        const stale = staleConflict(before, expected_updated_at)
        if (stale) return stale
      }
      if (tooLarge(html_chunk))
        return err(
          'too_large',
          `html_chunk is ${html_chunk.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}. Send one complete section per call.`,
        )
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = actions.appendFrameHtml(frame_id, html_chunk, actorFrom(agent_name), { start, done })
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      const result = done
        ? textWithNudge(
            { ok: true, streaming: false, htmlBytes: frame.html.length },
            `Stream complete. ${REVIEW_NUDGE}`,
          )
        : text({ ok: true, streaming: true, htmlBytes: frame.html.length })
      /* nudge only on the first chunk — mid-stream results should stay lean.
         The escape check rides along: the opening chunk decides the stream. */
      const nudged = start
        ? withGuidelinesNudge(withEscapeNote(result, html_chunk), frame.canvasId, actorFrom(agent_name))
        : result
      return nudged
    },
  )

  tool(
    'edit_frame_html',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Make a targeted edit to a frame: exact find-and-replace in its HTML. Use this for small tweaks (copy, a color, spacing, one element) instead of resending the whole document — the change morphs into the rendered frame in place. old_str must appear EXACTLY ONCE in the current HTML (call get_frame first if unsure); include enough surrounding context to make it unique.',
      inputSchema: {
        frame_id: z.string(),
        old_str: z
          .string()
          .max(MAX_FRAME_HTML_BYTES)
          .describe('Exact text to find in the frame HTML — must occur exactly once'),
        new_str: z.string().max(MAX_FRAME_HTML_BYTES).describe('Replacement text'),
        expected_updated_at: z
          .string()
          .optional()
          .describe(
            "The frame's updatedAt from your last read — send it and a frame that changed under you is refused",
          ),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Return the diff this replacement would produce and change nothing. Reports found: false (with the match count) when old_str does not occur exactly once.',
          ),
        agent_name: agentName,
      },
    },
    async ({ frame_id, old_str, new_str, expected_updated_at, agent_name, takeover, dry_run }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const stale = staleConflict(f, expected_updated_at)
      if (stale) return stale
      const count = f.html.split(old_str).length - 1
      if (dry_run) {
        /* a rehearsal answers "would this land", so a find that is not exactly
           one match is a false would_apply rather than a thrown refusal */
        const after = count === 1 ? storedHtml(f.html.replace(old_str, new_str)) : f.html
        return structured(dryRunPayload(f.html, after, { found: count === 1, matches: count }))
      }
      if (count === 0)
        return err('invalid_input', 'old_str not found in the frame HTML. Call get_frame to see the current content.')
      if (count > 1)
        return err(
          'invalid_input',
          `old_str occurs ${count} times — include more surrounding context so it matches exactly once.`,
        )
      takeOver(frame_id, f.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: f.html.replace(old_str, new_str) }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE)
    },
  )

  tool(
    'replace_in_frames',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Find and replace across a canvas',
      description:
        'Rename a string across a whole canvas in one call — a product name, a nav label, a price — instead of looping edit_frame_html with a screenshot per frame. Each frame reports how many matches it held and whether the replacement landed; a frame another agent holds the lock on is reported and stepped over, so one busy frame never costs the sweep the rest of the canvas. regex: true treats find as a regular expression (use $1 in replace for groups); case_sensitive only affects the regex path, since the literal path is the exact match edit_frame_html makes. Rehearse with dry_run, which counts the matches and writes nothing. Narrow with frame_ids or page.',
      inputSchema: {
        canvas_id: z.string(),
        find: z.string().min(1).max(2000).describe('The text to find'),
        replace: z.string().max(2000).describe('The replacement text'),
        frame_ids: z.array(z.string()).optional().describe('Only these frames (ids from get_canvas)'),
        page: z.string().optional().describe('Only frames on this page (name or id) — ignored when frame_ids is set'),
        regex: z.boolean().optional().describe('Treat find as a regular expression (default false)'),
        case_sensitive: z.boolean().optional().describe('Regex only: match case-sensitively (default false)'),
        dry_run: z.boolean().optional().describe('Count the matches and change nothing'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        frames: z.array(
          z.object({
            frame_id: z.string(),
            name: z.string(),
            matches: z.number(),
            applied: z.boolean(),
            skipped_reason: z.string().optional(),
          }),
        ),
        total_matches: z.number(),
        dry_run: z.literal(true).optional(),
      },
    },
    async ({ canvas_id, find, replace, frame_ids, page, regex, case_sensitive, dry_run, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      let pageId: string | undefined
      if (page !== undefined) {
        const resolved = resolvePage(canvas_id, page)
        if (resolved.error !== undefined) return err('invalid_input', resolved.error)
        pageId = resolved.page.id
      }
      const actor = actorFrom(agent_name)
      let result
      try {
        result = await replaceInFrames(canvas_id, {
          find,
          replace,
          ...(frame_ids?.length ? { frameIds: frame_ids } : {}),
          ...(pageId === undefined ? {} : { pageId }),
          ...(regex ? { regex: true } : {}),
          ...(case_sensitive ? { caseSensitive: true } : {}),
          ...(dry_run ? { dryRun: true } : {}),
          actor: { name: actor.name, ...(ownerId ? { userId: ownerId } : {}) },
        })
      } catch (e) {
        /* the canvas was checked above, so what is left is the pattern itself:
           an invalid regular expression is the caller's to fix */
        return err('invalid_input', e instanceof Error ? e.message : 'the find pattern could not be compiled')
      }
      return structured({
        ok: true as const,
        frames: result.frames.map((row) => ({
          frame_id: row.frameId,
          name: row.name,
          matches: row.matches,
          applied: row.applied,
          ...(row.skippedReason ? { skipped_reason: row.skippedReason } : {}),
        })),
        total_matches: result.totalMatches,
        ...(dry_run ? { dry_run: true as const } : {}),
      })
    },
  )

  tool(
    'get_element',
    {
      title: 'Read one element',
      description:
        'Read a single element of a rendered frame: its computed box and styles, its attributes, its text and its markup. Use this before changing an element — get the selector from inspect_frame (or from a comment), then read what it actually looks like. `matched` tells you how many elements the selector hits: more than one means the selector is too loose to edit with.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        selector: z.string().describe('A CSS selector for one element, e.g. ".card:nth-of-type(2) > h3"'),
        full_text: z
          .boolean()
          .optional()
          .describe('Return the element’s whole text instead of the first 400 characters'),
        agent_name: agentName,
      },
      outputSchema: {
        selector: z.string(),
        key: z.string(),
        matched: z.number(),
        tag: z.string(),
        id: z.string().optional(),
        classes: z.array(z.string()),
        text: z.string(),
        text_truncated: z.boolean().optional(),
        attrs: z.record(z.string(), z.string()),
        inline_style: z.string(),
        computed: z.record(z.string(), z.unknown()),
        outerHTML: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ canvas_id, frame_id, selector, full_text, agent_name }) => {
      const frame = frameFor(frame_id)
      if (!frame || frame.canvasId !== canvas_id) return noFrame(frame_id)
      const budget = takeRender(agent_name)
      if (budget) return budget
      try {
        return structured(await getElement(frame, selector, { full_text }))
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
    },
  )

  tool(
    'update_elements',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Set properties on elements',
      description:
        'Change elements of a frame by property instead of by text: set CSS declarations, set or remove attributes, or replace an element’s text. One call applies up to 20 edits in ONE render, so a multi-element change costs one screenshot’s worth of budget and lands atomically — if any selector does not resolve, nothing is changed. This is the right tool for "make every card’s heading 20px" or "give this button the accent background"; use edit_frame_html only for markup that has no element-level equivalent. The write is versioned and respects locks and review mode.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        edits: z
          .array(
            z.object({
              selector: z.string().describe('CSS selector for the element(s) to change'),
              style: z
                .record(z.string(), z.string().nullable())
                .optional()
                .describe('CSS declarations, e.g. {"background-color": "var(--color-ink)"}; null removes'),
              attrs: z
                .record(z.string(), z.string().nullable())
                .optional()
                .describe('Attributes, e.g. {"aria-label": "Close"}; null removes'),
              text: z.string().max(20_000).optional().describe('Replacement text content'),
              text_replace: z
                .object({
                  old_str: z.string().describe('The exact text to find inside this element'),
                  new_str: z.string().describe('What to put in its place'),
                  html: z
                    .boolean()
                    .optional()
                    .describe('Treat new_str as inline markup (strong, em, a, span, …) instead of literal characters'),
                })
                .optional()
                .describe(
                  "Replace one occurrence of old_str in the element's own text, leaving its child elements alone — the way to bold one word in a paragraph. Zero or several matches changes nothing and is reported.",
                ),
            }),
          )
          .min(1)
          .max(20)
          .describe('Up to 20 edits, applied in one render'),
        expected_updated_at: z
          .string()
          .optional()
          .describe("The frame's updatedAt from when you read it — refuses the write if someone else changed it since"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            'Run the same render and report the diff (plus applied/ambiguous) without writing. Still spends one render.',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true).optional(),
        frame: z.unknown().optional(),
        applied: z.number(),
        ambiguous: z.array(z.string()),
        dry_run: z.literal(true).optional(),
        would_apply: z.boolean().optional(),
        diff: diffShape.optional(),
        bytes_before: z.number().optional(),
        bytes_after: z.number().optional(),
      },
    },
    async ({ canvas_id, frame_id, edits, agent_name, expected_updated_at, takeover, dry_run }) => {
      const before = frameFor(frame_id)
      if (!before || before.canvasId !== canvas_id) return noFrame(frame_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const budget = takeRender(agent_name)
      if (budget) return budget
      /* `updateElements` transforms a document and hands the HTML back — only
         `actions.updateFrame` stores it, so a dry run is the same call minus
         the write */
      if (dry_run) {
        try {
          const preview = await updateElements(before, edits)
          return structured(
            dryRunPayload(before.html, storedHtml(preview.html), {
              applied: preview.applied,
              ambiguous: preview.ambiguous,
            }),
          )
        } catch (e) {
          if (e instanceof ElementEditError) return err(e.code, e.message)
          throw e
        }
      }
      takeOver(frame_id, canvas_id, actorFrom(agent_name), takeover)
      let outcome: UpdateElementsResult
      try {
        outcome = await updateElements(before, edits)
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: outcome.html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      const payload = {
        ok: true as const,
        frame: frameSummary(frame),
        applied: outcome.applied,
        ambiguous: outcome.ambiguous,
      }
      return outcome.ambiguous.length
        ? structuredWithNudge(
            payload,
            `these selectors matched more than one element and every match was changed: ${outcome.ambiguous.join(', ')} — use a tighter selector if that was not what you meant`,
          )
        : structured(payload)
    },
  )

  tool(
    'insert_element',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Insert markup into an element',
      description:
        'Insert HTML as a child of an existing element, at the start, the end, or a child index. The inserted markup may not contain <script>, <iframe>, <object>, <embed>, <link>, <meta> or on* handlers. Returns the new element’s own selector so you can immediately style it with update_elements.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        parent_selector: z.string().describe('The element to insert into'),
        position: z
          .union([z.literal('append'), z.literal('prepend'), z.number().int().min(0).max(1000)])
          .describe('append, prepend, or a 0-based child index'),
        html: z.string().max(60_000).describe('The markup to insert'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.unknown(), selector: z.string() },
    },
    async ({ canvas_id, frame_id, parent_selector, position, html, agent_name, expected_updated_at, takeover }) => {
      const before = frameFor(frame_id)
      if (!before || before.canvasId !== canvas_id) return noFrame(frame_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const budget = takeRender(agent_name)
      if (budget) return budget
      takeOver(frame_id, canvas_id, actorFrom(agent_name), takeover)
      let outcome: { html: string; selector: string }
      try {
        outcome = await insertElement(before, { parent_selector, position, html })
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: outcome.html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structured({ ok: true as const, frame: frameSummary(frame), selector: outcome.selector })
    },
  )

  tool(
    'delete_element',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Delete an element',
      description:
        'Remove an element and its subtree from a frame. Refuses <html> and <body>: rewrite the frame instead. Use get_element first to be sure the selector hits the element you mean.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        selector: z.string().describe('CSS selector for the element to remove'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.unknown() },
    },
    async ({ canvas_id, frame_id, selector, agent_name, expected_updated_at, takeover }) => {
      const before = frameFor(frame_id)
      if (!before || before.canvasId !== canvas_id) return noFrame(frame_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const budget = takeRender(agent_name)
      if (budget) return budget
      takeOver(frame_id, canvas_id, actorFrom(agent_name), takeover)
      let outcome: { html: string }
      try {
        outcome = await deleteElement(before, selector)
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: outcome.html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structured({ ok: true as const, frame: frameSummary(frame) })
    },
  )

  /* ---- frame script: the escape hatch for what the element tools cannot say ---- */

  tool(
    'frame_script_api',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read the frame-script surface',
      description:
        'The exact API a frame script runs against: the doop global, its methods, and the limits (size, time, forbidden markup, blocked network). Read it before writing your first run_frame_script, or whenever a script failed in a way the API doc explains.',
      inputSchema: { agent_name: agentName.optional() },
    },
    async () => ({ content: [{ type: 'text' as const, text: FRAME_SCRIPT_API }] }),
  )

  tool(
    'run_frame_script',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Run a script in a frame',
      description:
        "Run a short script inside a rendered frame to make the one structural change the element tools cannot express — a bulk renumber, every repeated card rewritten. The script sees the live DOM through the doop global (read the surface with frame_script_api) and the frame's new HTML is what gets saved. Nothing else can save the change: this is the write. dry_run returns the diff without writing. Scripts cannot add scripts/iframes or touch the network, and time out after 5 seconds — nothing is saved from a timed-out run.",
      inputSchema: {
        frame_id: z.string(),
        script: z.string().min(1).max(20_000).describe('The script body — JavaScript, async/await allowed'),
        expected_updated_at: z.string().optional().describe("The frame's updatedAt from when you read it"),
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        dry_run: z.boolean().optional().describe('Return the diff the script would produce and write nothing'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true).optional(),
        frame: z.unknown().optional(),
        dry_run: z.literal(true).optional(),
        would_apply: z.boolean().optional(),
        diff: diffShape.optional(),
        bytes_before: z.number().optional(),
        bytes_after: z.number().optional(),
      },
    },
    async ({ frame_id, script, expected_updated_at, takeover, dry_run, agent_name }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      const budget = takeRender(agent_name)
      if (budget) return budget
      await arrive(before.canvasId, agent_name)
      if (dry_run) {
        try {
          const preview = await runFrameScript(before, script)
          return structured(dryRunPayload(before.html, storedHtml(preview.html)))
        } catch (e) {
          if (e instanceof ElementEditError) return err(e.code, e.message)
          throw e
        }
      }
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let outcome: { html: string }
      try {
        outcome = await runFrameScript(before, script)
      } catch (e) {
        if (e instanceof ElementEditError) return err(e.code, e.message)
        throw e
      }
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, { html: outcome.html }, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return structuredWithNudge(
        { ok: true as const, frame: frameSummary(frame) },
        'Script applied. Call get_frame_screenshot to see the result.',
      )
    },
  )

  tool(
    'update_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Update frame metadata: rename it, move/resize it, or change how it presents (stacking z, locked, hidden, rotation degrees, opacity) on the canvas. A frame a human locked refuses name/size/content writes, but its presentation fields still move.',
      inputSchema: {
        frame_id: z.string(),
        name: z.string().max(200).optional(),
        x: z.number().min(-1_000_000).max(1_000_000).optional(),
        y: z.number().min(-1_000_000).max(1_000_000).optional(),
        width: z.number().min(1).max(20_000).optional(),
        height: z.number().min(1).max(20_000).optional(),
        z: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe(
            'Stacking height within the frame’s page — higher paints in front. Prefer reorder_frame, which renumbers a whole page densely',
          ),
        locked: z.boolean().optional().describe('A locked frame refuses name/size/content writes until it is unlocked'),
        hidden: z.boolean().optional().describe('Hidden frames stay on the canvas but render nothing'),
        rotation: z
          .number()
          .min(-3600)
          .max(3600)
          .optional()
          .describe('Rotation in degrees, applied as a CSS transform'),
        opacity: z.number().min(0).max(1).optional().describe('0 = invisible, 1 = fully opaque'),
        expected_updated_at: z
          .string()
          .optional()
          .describe("The frame's updatedAt from when you read it — refuses the write if someone else changed it since"),
        takeover: z.boolean().optional().describe('Update a frame another agent holds the lock on'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, expected_updated_at, takeover, ...patch }) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      if (!Object.keys(clean).length) return err('invalid_input', 'nothing to update')
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = actions.updateFrame(frame_id, clean, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return text({ ok: true, frame: frameSummary(frame) })
    },
  )

  tool(
    'delete_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      description: 'Delete a frame from its canvas.',
      inputSchema: {
        frame_id: z.string(),
        expected_updated_at: z
          .string()
          .optional()
          .describe(
            "The frame's updatedAt from when you read it — refuses the delete if someone else changed it since",
          ),
        takeover: z.boolean().optional().describe('Delete a frame another agent holds the frame lock'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Report what the delete would remove and delete nothing — the frame and its versions survive'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, expected_updated_at, takeover, dry_run }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const gated = reviewGate(before.canvasId)
      if (gated) return gated
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
      if (dry_run)
        return structured({
          dry_run: true as const,
          would_apply: true,
          frame: frameSummary(before),
          bytes_before: before.html.length,
          bytes_after: 0,
        })
      takeOver(frame_id, before.canvasId, actorFrom(agent_name), takeover)
      let frame: Frame | undefined
      try {
        frame = actions.deleteFrame(frame_id, actorFrom(agent_name))
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return text({ ok: true, deleted: frame.name })
    },
  )

  /* Tools that change a canvas. apply_ops checks review mode against this set,
     so it can never be the way around a rule the tools themselves enforce. */
  const WRITE_OPS = new Set([
    'create_frame',
    'set_frame_html',
    'edit_frame_html',
    'append_frame_html',
    'update_frame',
    'move_frame',
    'reorder_frame',
    'delete_frame',
    'duplicate_frame',
    'revert_frame',
    'revert_run',
    'undo_last_change',
    'create_page',
    'rename_page',
    'delete_page',
    'add_comment',
    'set_guidelines',
    'save_decision',
    'set_tokens',
    'update_elements',
    'insert_element',
    'delete_element',
    'fix_frame_tokens',
    'insert_component',
    'detach_component',
    'run_frame_script',
    'update_component',
    'restore_release',
    'publish_canvas',
    'unpublish_canvas',
  ])

  /* Ops whose effect is a line in a log a human may already have read — a
     comment, a decision. A failed batch cannot take those back, so it names
     them in `not_rolled_back` instead of pretending it undid them. Every other
     batchable op changes canvas content, which the pre-image restores. */
  const APPEND_ONLY_OPS: Record<string, true> = { add_comment: true, save_decision: true }

  /** One frame as a rollback needs it: the fields a batch op can write, plus
   *  the page it sits on. */
  interface FramePreImage {
    name: string
    x: number
    y: number
    width: number
    height: number
    html: string
    pageId?: string
  }

  /** The canvas before a batch runs: the frames its ops name, the guideline
   *  docs, the tokens, and the id sets that tell a rollback what the batch
   *  created. Taken for atomic and best-effort batches alike, so both modes
   *  read the same picture of "before". */
  interface CanvasPreImage {
    frames: Map<string, FramePreImage>
    frameIds: Set<string>
    pageIds: Set<string>
    tokens: DesignTokens | undefined
    /** `title: ''` is "this doc had no display name" — the store clears a
     *  title only when it is given an empty one, so the pre-image keeps the
     *  difference between absent and empty. */
    guidelines: { name: string; title: string; markdown: string }[]
  }

  function snapshotCanvas(canvasId: string, prepared: { args: Record<string, unknown> }[]): CanvasPreImage {
    const canvas = store.getCanvas(canvasId)!
    const frames = new Map<string, FramePreImage>()
    for (const entry of prepared) {
      const id = entry.args.frame_id
      if (typeof id !== 'string' || frames.has(id)) continue
      const frame = store.getFrame(id)
      /* an op naming a frame outside this canvas is refused before it runs, so
         it is not part of what a rollback has to put back */
      if (!frame || frame.canvasId !== canvasId) continue
      frames.set(id, {
        name: frame.name,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        html: frame.html,
        ...(frame.pageId !== undefined ? { pageId: frame.pageId } : {}),
      })
    }
    return {
      frames,
      frameIds: new Set(canvas.frames.map((f) => f.id)),
      pageIds: new Set((canvas.pages ?? []).map((p) => p.id)),
      tokens: canvas.tokens,
      guidelines: store.getGuidelines(canvasId).map((d) => ({
        name: d.name,
        title: d.title ?? '',
        markdown: d.markdown,
      })),
    }
  }

  /** Put the canvas back as the pre-image has it, through the actions layer so
   *  the room sees the same broadcasts a normal edit produces. Content only:
   *  appended comments and decisions are `not_rolled_back`.
   *  Throws when a step fails, so the caller can report that instead of
   *  claiming a rollback that did not happen. */
  function restoreCanvas(
    canvasId: string,
    before: CanvasPreImage,
    actor: Actor,
  ): { restored: string[]; recreated: { name: string; from: string; to: string }[] } {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) throw new Error(`canvas ${canvasId} is gone`)
    const restored: string[] = []
    /* A frame the batch deleted comes back as ITSELF: delete_frame trashes the
       row instead of dropping it, so the id survives the round trip — and the
       id is the frame's identity to every comment, version row and agent
       holding it. Named here only for the frame that is neither live nor in the
       trash, where nothing kept the id and createFrame has to mint one; the
       caller is then told which id came back so it is not left looking for the
       one that is gone. */
    const recreated: { name: string; from: string; to: string }[] = []

    /* frames the batch created did not exist before it ran: take them out. The
       batch locked whatever it wrote, so the lock goes first — a restore runs
       as the caller, and the batch's ops may have run as another agent. */
    for (const frame of [...canvas.frames]) {
      if (before.frameIds.has(frame.id)) continue
      actions.releaseAllFrameLocks(frame.id)
      if (actions.deleteFrame(frame.id, actor)) restored.push(frame.id)
    }

    for (const [id, was] of before.frames) {
      const now = store.getFrame(id)
      if (!now) {
        /* The pre-image is what has to come back, not the row in the trash: a
           batch that edited a frame and then deleted it left the edited copy
           behind. The trashed row carries what a content rollback does not
           touch (z, the lock, rotation, opacity), so it is the base the
           pre-image's fields are written onto; the helper consumes the trash
           entry, so the frame is not duplicated, and refuses when the id is
           live — which is the patch path below. `undefined` here means neither
           live nor trashed, the one case where the id cannot be preserved. */
        const trashed = store.getTrashedFrame(id)
        const back = trashed ? store.restoreFrameFromSnapshot({ ...trashed.frame, ...was }, actor.name) : undefined
        if (back) {
          /* the room saw the delete, so it has to see the frame come back
             under the same id — the store call is the persistence half only */
          broadcast(canvasId, { type: 'frame:created', frame: back, actor })
          restored.push(back.id)
          continue
        }
        const fresh = actions.createFrame(canvasId, { ...was }, actor)
        if (fresh) {
          restored.push(fresh.id)
          recreated.push({ name: was.name, from: id, to: fresh.id })
        }
        continue
      }
      const patch: Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html'>> = {}
      if (now.name !== was.name) patch.name = was.name
      if (now.x !== was.x) patch.x = was.x
      if (now.y !== was.y) patch.y = was.y
      if (now.width !== was.width) patch.width = was.width
      if (now.height !== was.height) patch.height = was.height
      if (now.html !== was.html) patch.html = was.html
      const moved = was.pageId !== undefined && now.pageId !== was.pageId
      if (Object.keys(patch).length === 0 && !moved) continue
      /* A batch op takes the frame lock as it writes, so undoing the write has
         to take the lock back too — otherwise the restore is refused by the
         very lock the batch left behind. */
      actions.releaseAllFrameLocks(id)
      if (Object.keys(patch).length > 0) actions.updateFrame(id, patch, actor)
      if (moved) actions.moveFrameToPage(id, was.pageId!, actor)
      restored.push(id)
    }

    /* pages the batch created — no batchable op makes one today, but the
       pre-image knows the difference either way */
    for (const page of [...(canvas.pages ?? [])]) {
      if (before.pageIds.has(page.id)) continue
      if (actions.deletePage(page.id, actor)) restored.push(page.id)
    }

    for (const was of before.guidelines) {
      const now = store.getGuidelines(canvasId).find((d) => d.name === was.name)
      if (now && now.markdown === was.markdown && (now.title ?? '') === was.title) continue
      actions.setGuideline(canvasId, was.name, was.markdown, actor, undefined, was.title)
      restored.push(was.name)
    }
    for (const now of [...store.getGuidelines(canvasId)]) {
      if (before.guidelines.some((d) => d.name === now.name)) continue
      actions.setGuideline(canvasId, now.name, '', actor)
      restored.push(now.name)
    }

    if (JSON.stringify(canvas.tokens) !== JSON.stringify(before.tokens)) {
      actions.setTokens(canvasId, before.tokens, actor)
      restored.push('tokens')
    }
    return { restored, recreated }
  }

  /**
   * Everything that can be known to make a batch op fail WITHOUT applying it:
   * missing targets, another agent's lock, a stale precondition, an oversized
   * document. Used by apply_ops both to pre-flight an atomic batch and to skip a
   * doomed op in a best-effort one.
   */
  function preflightOp(
    op: string,
    args: Record<string, unknown>,
    actor: Actor,
  ): { error: McpErrorPayload } | undefined {
    const html =
      typeof args.html === 'string' ? args.html : typeof args.html_chunk === 'string' ? args.html_chunk : undefined
    if (html !== undefined && tooLarge(html))
      return {
        error: mcpErrorPayload('too_large', `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}`),
      }

    if (typeof args.frame_id === 'string') {
      const frame = frameFor(args.frame_id)
      if (!frame)
        return { error: mcpErrorPayload('not_found', `no frame with id ${args.frame_id} accessible to this account`) }
      if (op !== 'create_frame') {
        const holder = frameLocks.heldBy(args.frame_id, actor.name)
        if (holder)
          return {
            error: mcpErrorPayload('conflict', `frame ${args.frame_id} is being edited by ${holder.agentName}`, {
              holder: holder.agentName,
              expires_at: new Date(holder.expiresAt).toISOString(),
            }),
          }
        if (typeof args.expected_updated_at === 'string') {
          const stale = stalePayload(frame, args.expected_updated_at)
          if (stale) return { error: stale }
        }
      }
    }
    if (typeof args.page === 'string' && op === 'move_frame') {
      const canvasId = typeof args.canvas_id === 'string' ? args.canvas_id : undefined
      if (canvasId) {
        const resolved = resolvePage(canvasId, args.page)
        if (resolved.error !== undefined) return { error: mcpErrorPayload('invalid_input', resolved.error) }
      }
    }
    /* A batch must not be a way around the rules the individual tools follow:
       every write op is checked against review mode here too, so atomic and
       non-atomic batches refuse alike. */
    const writeCanvasId =
      typeof args.canvas_id === 'string'
        ? args.canvas_id
        : typeof args.frame_id === 'string'
          ? store.getFrame(args.frame_id)?.canvasId
          : undefined
    if (writeCanvasId && WRITE_OPS.has(op)) {
      const gated = reviewGatePayload(writeCanvasId)
      if (gated) return { error: gated }
    }
    return undefined
  }

  tool(
    'apply_ops',
    {
      title: 'Apply several edits in one call',
      annotations: { readOnlyHint: false, destructiveHint: false },
      description:
        'Run a sequence of Doop edits in one round trip: create frames, write their HTML, position them, comment. Each op is `{ op: "<tool name>", ...that tool\'s arguments }` — the same fields the named tool takes (see its own schema). Use this to lay out a multi-frame flow, or to apply a review pass across several frames, instead of paying a round trip per call. Ops run in array order; with atomic: false (the default) a failing op is reported at its index and the rest still run, while atomic: true validates every op first and applies nothing if any would fail — and if an op still fails while applying (another agent took a lock in between), the batch stops and the ops that landed are rolled back from a pre-image taken before the first one: the error reports `rolled_back`, `restored` and how many ops landed before it. Appended comments and decisions cannot be taken back, and are named in `not_rolled_back`. With dry_run: true nothing is written at all: every op is validated, each op that can diff its own write returns `diff`, `bytes_before` and `bytes_after`, and the rest report that they cleared pre-flight.',
      inputSchema: {
        canvas_id: z.string(),
        ops: z
          .array(
            z
              .object({
                op: z
                  .enum([
                    'create_frame',
                    'set_frame_html',
                    'edit_frame_html',
                    'update_frame',
                    'move_frame',
                    'delete_frame',
                    'add_comment',
                    'set_guidelines',
                    'save_decision',
                    'update_elements',
                    'delete_element',
                    'fix_frame_tokens',
                    'insert_component',
                    'detach_component',
                    'run_frame_script',
                    'update_component',
                  ])
                  .describe('The tool to run; the remaining fields are that tool’s own arguments'),
              })
              .passthrough(),
          )
          .min(1)
          .max(50)
          .describe('Up to 50 ops, applied in order'),
        atomic: z
          .boolean()
          .optional()
          .describe('Validate every op before applying any (default false: apply what you can, report what failed)'),
        dry_run: z
          .boolean()
          .optional()
          .describe('Validate every op and report the diff each would produce, writing nothing'),
        agent_name: agentName,
      },
      outputSchema: {
        results: z.array(
          z.object({
            index: z.number(),
            op: z.string(),
            ok: z.boolean(),
            result: z.unknown().optional(),
            error: z.unknown().optional(),
            would_apply: z.boolean().optional(),
            diff: diffShape.optional(),
            bytes_before: z.number().optional(),
            bytes_after: z.number().optional(),
          }),
        ),
        applied: z.number(),
        failed: z.number(),
        stopped_at: z.number().optional(),
        applied_before_failure: z.number().optional(),
        not_rolled_back: z.array(z.number()).optional(),
        rolled_back: z.literal(true).optional(),
        restored: z.array(z.string()).optional(),
        /* only for a frame the rollback could not bring back under its own id —
           neither live nor in the trash — so it was created fresh: this is the
           id it landed with, so the caller is not left holding the one the
           batch destroyed */
        recreated: z.array(z.object({ name: z.string(), from: z.string(), to: z.string() })).optional(),
        rollback_failed: z.string().optional(),
        dry_run: z.literal(true).optional(),
        would_apply: z.number().optional(),
      },
    },
    async ({ canvas_id, ops, atomic, dry_run, agent_name }, extra) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)

      /* Each op is validated against the schema the named tool itself
         publishes, so the batch can never drift from the tools it mirrors. */
      const prepared: { index: number; op: string; args: Record<string, unknown>; error?: McpErrorPayload }[] = []
      for (const [index, raw] of ops.entries()) {
        const { op, ...rest } = raw as { op: string } & Record<string, unknown>
        const entry = registry.get(op)
        if (!entry) {
          prepared.push({ index, op, args: {}, error: mcpErrorPayload('unsupported', `unknown op “${op}”`) })
          continue
        }
        /* the batch always runs on the canvas it was called with: an op that
           names a different canvas would silently edit somewhere else */
        if (rest.canvas_id !== undefined && rest.canvas_id !== canvas_id) {
          prepared.push({
            index,
            op,
            args: {},
            error: mcpErrorPayload(
              'invalid_input',
              `op ${index} targets canvas ${String(rest.canvas_id)}, not ${canvas_id}`,
            ),
          })
          continue
        }
        /* the batch runs as this session's agent, exactly as a direct call
           would: an op that omitted agent_name inherits the session's, and
           still fails validation when the session has none */
        const parsed = z.object(entry.inputSchema).safeParse({
          ...(rest.agent_name === undefined && session.agentName ? { agent_name: session.agentName } : {}),
          ...rest,
          canvas_id,
        })
        if (!parsed.success) {
          prepared.push({
            index,
            op,
            args: {},
            error: mcpErrorPayload(
              'invalid_input',
              `op ${index} (${op}) is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'} ${i.message}`).join('; ')}`,
            ),
          })
          continue
        }
        prepared.push({ index, op, args: parsed.data as Record<string, unknown> })
      }

      /* A dry run answers the same question a batch answers — would this land?
         — and writes nothing. Every op is validated; the ops that can diff
         their own write are asked for one, and the rest report that they
         cleared pre-flight. No lock is taken, nothing is broadcast, and no
         frame's updatedAt moves. */
      if (dry_run) {
        const previews: {
          index: number
          op: string
          ok: boolean
          would_apply: boolean
          error?: unknown
          diff?: unknown
          bytes_before?: number
          bytes_after?: number
        }[] = []
        for (const entry of prepared) {
          if (entry.error) {
            previews.push({ index: entry.index, op: entry.op, ok: false, would_apply: false, error: entry.error })
            continue
          }
          const blocked = preflightOp(entry.op, entry.args, actor)
          if (blocked) {
            previews.push({ index: entry.index, op: entry.op, ok: false, would_apply: false, error: blocked.error })
            continue
          }
          /* Only the tools that can diff a write they did not make carry the
             numbers; the rest passed pre-flight, which is all a batch can know
             without running them. */
          if (!('dry_run' in registry.get(entry.op)!.inputSchema)) {
            previews.push({ index: entry.index, op: entry.op, ok: true, would_apply: true })
            continue
          }
          const outcome = await registry.get(entry.op)!.run({ ...entry.args, dry_run: true } as never, extra as never)
          const textBlocks = (outcome.content as { type: string; text?: string }[]).filter((b) => b.type === 'text')
          if (outcome.isError) {
            previews.push({
              index: entry.index,
              op: entry.op,
              ok: false,
              would_apply: false,
              error: parseToolError(textBlocks[0]?.text),
            })
            continue
          }
          const preview = (outcome.structuredContent ?? {}) as Record<string, unknown>
          previews.push({
            index: entry.index,
            op: entry.op,
            ok: true,
            would_apply: preview.would_apply === true,
            ...(preview.diff !== undefined ? { diff: preview.diff } : {}),
            ...(typeof preview.bytes_before === 'number' ? { bytes_before: preview.bytes_before } : {}),
            ...(typeof preview.bytes_after === 'number' ? { bytes_after: preview.bytes_after } : {}),
          })
        }
        return structured({
          results: previews,
          applied: 0,
          failed: previews.filter((preview) => !preview.ok).length,
          dry_run: true as const,
          would_apply: previews.filter((preview) => preview.would_apply).length,
        })
      }

      if (atomic) {
        const first = prepared.find((entry) => entry.error !== undefined)
        if (first) {
          return err('invalid_input', `op ${first.index} (${first.op}) would fail: ${first.error!.error.message}`, {
            stopped_at: first.index,
          })
        }
        for (const entry of prepared) {
          const blocked = preflightOp(entry.op, entry.args, actor)
          if (blocked)
            return err(
              blocked.error.error.code,
              `op ${entry.index} (${entry.op}) would fail: ${blocked.error.error.message}`,
              { ...blocked.error.error, stopped_at: entry.index },
            )
        }
      }

      const results: {
        index: number
        op: string
        ok: boolean
        result?: unknown
        error?: unknown
      }[] = []
      const nudges: string[] = []
      /* What a rollback needs, taken before the first op runs: an atomic batch
         that dies mid-apply is put back from this, and the id sets tell it
         which frames and pages the batch created. */
      const before = snapshotCanvas(canvas_id, prepared)
      for (const entry of prepared) {
        if (entry.error) {
          results.push({ index: entry.index, op: entry.op, ok: false, error: entry.error })
          continue
        }
        const blocked = atomic ? undefined : preflightOp(entry.op, entry.args, actor)
        if (blocked) {
          results.push({ index: entry.index, op: entry.op, ok: false, error: blocked.error })
          continue
        }
        const outcome = await registry.get(entry.op)!.run(entry.args as never, extra as never)
        const blocks = outcome.content as { type: string; text?: string }[]
        const textBlocks = blocks.filter((block) => block.type === 'text')
        if (outcome.isError) {
          const failure = parseToolError(textBlocks[0]?.text)
          if (atomic) {
            /* Pre-flight cannot see a lock another agent takes in between, so a
               batch can still fail while applying. The ops that landed are put
               back from the pre-image; the error says what was restored, or —
               when the restore itself failed — that, instead of claiming a
               rollback that did not happen. */
            const landed = results.filter((result) => result.ok)
            const appendOnly = landed.filter((result) => APPEND_ONLY_OPS[result.op]).map((result) => result.index)
            /* `err` spreads `extra` over the payload, so the inner error's own
               `message` would replace the prose composed here — it is the one
               field left out, because "failed while applying, rolled back" is
               the part the caller cannot get anywhere else. */
            const { message: innerMessage, ...failureFields } = failure.error
            const context = {
              ...failureFields,
              stopped_at: entry.index,
              applied_before_failure: landed.length,
              ...(appendOnly.length ? { not_rolled_back: appendOnly } : {}),
            }
            const what = `op ${entry.index} (${entry.op}) failed while applying: ${innerMessage}`
            let rollback: { restored: string[]; recreated: { name: string; from: string; to: string }[] }
            try {
              rollback = restoreCanvas(canvas_id, before, actor)
            } catch (e) {
              return err(failure.error.code, what, {
                ...context,
                rollback_failed: e instanceof Error ? e.message : 'the rollback failed',
              })
            }
            const back = rollback.recreated.length
              ? ` Frame${rollback.recreated.length === 1 ? '' : 's'} ${rollback.recreated
                  .map((f) => `“${f.name}” came back as ${f.to} (its id could not be preserved)`)
                  .join('; ')}.`
              : ''
            return err(
              failure.error.code,
              `${what}. Rolled back ${landed.length} op(s): the canvas is as it was before the batch.${back}`,
              {
                ...context,
                rolled_back: true,
                restored: rollback.restored,
                ...(rollback.recreated.length ? { recreated: rollback.recreated } : {}),
              },
            )
          }
          results.push({ index: entry.index, op: entry.op, ok: false, error: failure })
          continue
        }
        /* the first text block is the op's own result; anything after it is
           steering the individual tool added (a review nudge) — keep those,
           they are what tells the agent to look at what it just changed */
        for (const block of textBlocks.slice(1)) if (block.text) nudges.push(block.text)
        results.push({
          index: entry.index,
          op: entry.op,
          ok: true,
          result: outcome.structuredContent ?? textBlocks[0]?.text,
        })
      }

      const firstFailure = results.findIndex((result) => !result.ok)
      const payload = {
        results,
        applied: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        /* A best-effort batch undoes nothing by design, so a failure reports
           what landed instead: how far the batch got, and the ops a later
           cleanup cannot take back (comments, decisions). */
        ...(firstFailure === -1
          ? {}
          : {
              applied_before_failure: results.slice(0, firstFailure).filter((r) => r.ok).length,
              not_rolled_back: results.filter((r) => r.ok && APPEND_ONLY_OPS[r.op]).map((r) => r.index),
            }),
      }
      const summary = `${payload.applied} of ${results.length} op(s) applied${payload.failed ? `, ${payload.failed} failed — see the results array for the index and reason` : ''}`
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
          ...(nudges.length ? [{ type: 'text' as const, text: nudges.join('\n\n') }] : []),
          ...(payload.failed ? [{ type: 'text' as const, text: summary }] : []),
        ],
        structuredContent: payload,
      }
    },
  )

  /* ---- resources ----
     A client can attach a canvas as context without spending a tool call on it,
     which is what makes Doop usable from a chat client that reads resources.
     Every read resolves through the same canvasFor closure the tools use, so
     the one canvasAccess gate stays the single authorization answer. */
  server.registerResource(
    'doop-guide',
    'doop://guide',
    {
      title: 'Doop agent guide',
      description: 'The full playbook: streaming, review checkpoints, images, style guides, etiquette.',
      mimeType: 'text/markdown',
    },
    async () => ({ contents: [{ uri: 'doop://guide', mimeType: 'text/markdown', text: DOOP_GUIDE }] }),
  )

  server.registerResource(
    'doop-canvas',
    new ResourceTemplate('doop://canvas/{canvasId}', {
      list: () => ({
        resources: store.listCanvases(ownerId ?? '').map((m) => ({
          uri: `doop://canvas/${m.id}`,
          name: m.name,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Canvas',
      description: 'A canvas as JSON: its pages, frames, guides and references.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const canvasId = String(variables.canvasId ?? '')
      const c = canvasFor(canvasId)
      if (!c) throw new ResourceError('not_found', `no canvas with id ${canvasId} accessible to this account`)
      const visible = c.frames.filter((f) => !f.demo)
      const view: CanvasViewWithBreakpoints = {
        id: c.id,
        name: c.name,
        frames: visible.map((f) =>
          frameSummary(
            f,
            c.pages?.find((p) => p.id === f.pageId),
          ),
        ),
        frame_total: visible.length,
        pages: (c.pages ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          frameCount: c.frames.filter((f) => f.pageId === p.id).length,
        })),
        guidelines: store.getGuidelines(canvasId).map((d) => ({
          name: d.name,
          title: actions.guidelineTitle(d),
          summary: actions.guidelineSummary(d),
          bytes: d.markdown.length,
        })),
        references: store.getReferences(canvasId).map((r) => ({
          id: r.id,
          title: r.title,
          size: `${Math.round(r.width)}x${Math.round(r.height)}`,
          htmlBytes: r.html.length,
          pinnedBy: r.pinnedBy,
        })),
        ...(c.breakpoints?.length ? { breakpoints: c.breakpoints } : {}),
        tokens_present: !!c.tokens,
        review_mode: !!c.reviewMode,
        link_access: c.linkAccess ?? 'none',
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }] }
    },
  )

  server.registerResource(
    'doop-canvas-tokens',
    new ResourceTemplate('doop://canvas/{canvasId}/tokens', {
      list: async () => ({
        resources: store.listCanvases(ownerId ?? '').map((meta) => {
          const tokens = store.getCanvas(meta.id)?.tokens
          return {
            uri: `doop://canvas/${meta.id}/tokens`,
            name: `${meta.name} — design tokens`,
            mimeType: 'text/css',
            /* lastModified is the freshness signal this SDK revision can carry:
               a client that caches the resource knows when to read it again
               without polling on every turn. */
            ...(tokens ? { annotations: { lastModified: new Date(tokens.updatedAt).toISOString() } } : {}),
          }
        }),
      }),
    }),
    {
      title: 'Canvas design tokens',
      description: 'The canvas tokens as a CSS :root block.',
      mimeType: 'text/css',
    },
    async (uri, variables) => {
      const canvasId = String(variables.canvasId ?? '')
      const c = canvasFor(canvasId)
      if (!c) throw new ResourceError('not_found', `no canvas with id ${canvasId} accessible to this account`)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/css',
            text: c.tokens
              ? cssForTokens(c.tokens)
              : '/* this canvas has no design tokens yet — set them with set_tokens */',
            ...(c.tokens
              ? { _meta: { updatedAt: new Date(c.tokens.updatedAt).toISOString(), updatedBy: c.tokens.updatedBy } }
              : {}),
          },
        ],
      }
    },
  )

  /* ---- prompts: the standard flows, one slash command each ---- */

  const reviewPrompt = [
    'Review the design of the frame I name below against this checklist, then report findings in order of severity.',
    '',
    '1. Call get_frame_screenshot and look at it: hierarchy, alignment, spacing rhythm, contrast of the actual render.',
    '2. Call review_frame — it runs the token lint, the accessibility audit and the layout analysis at mobile/tablet/desktop in one call.',
    '3. Call audit_frame if the frame has images or interactive elements the report flags.',
    '',
    'Report: what passes, what fails (with the failing selector), and the single highest-impact fix. Offer to apply the fix; in review mode propose it instead of writing it.',
    '',
    'Canvas: {canvas_id}',
    'Frame: {frame_id}',
  ].join('\n')
  server.registerPrompt(
    'design_review',
    {
      title: 'Design review',
      description:
        'Run a full design review of one frame: visual pass, tokens, accessibility and layout across viewports',
      argsSchema: { canvas_id: z.string(), frame_id: z.string().optional() },
    },
    ({ canvas_id, frame_id }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: reviewPrompt
              .replace('{canvas_id}', canvas_id)
              .replace(
                '{frame_id}',
                frame_id ?? 'pick the frame the human means; ask with ask_human if it is ambiguous',
              ),
          },
        },
      ],
    }),
  )

  const redesignPrompt = [
    'Redesign the frame named below from a live page the human admires. Work in this order:',
    '',
    '1. import_webpage the URL as a reference (as_reference: true) and get_frame_screenshot it — study its palette, type and spacing.',
    '2. Call search_inspiration for the page archetype and pick ONE exemplar; name it in your brief.',
    '3. Rewrite the frame: stream the new design with append_frame_html so the human watches it build.',
    '4. Call review_frame; fix every error before you report done.',
    '',
    'Canvas: {canvas_id}',
    'Frame: {frame_id}',
    'URL: {url}',
  ].join('\n')
  server.registerPrompt(
    'redesign_from_url',
    {
      title: 'Redesign from a URL',
      description:
        'Redesign a frame using a live page as the reference: import it, study it, rebuild the frame, verify it',
      argsSchema: { canvas_id: z.string(), frame_id: z.string().optional(), url: z.string() },
    },
    ({ canvas_id, frame_id, url }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: redesignPrompt
              .replace('{canvas_id}', canvas_id)
              .replace('{frame_id}', frame_id ?? 'ask the human which frame with ask_human')
              .replace('{url}', url),
          },
        },
      ],
    }),
  )

  const handoffPrompt = [
    'Hand the design below to a developer as a GitHub pull request.',
    '',
    '1. Call get_capabilities — github must not be "none"; if it is, tell the human to connect a repo instead of failing later.',
    '2. Call export_canvas with format "tokens" and check the design tokens exist.',
    '3. Call open_pull_request with the repo the human names, and report the PR URL.',
    '',
    'Canvas: {canvas_id}',
    'Repo (owner/name): {repo}',
  ].join('\n')
  server.registerPrompt(
    'handoff_to_code',
    {
      title: 'Hand off to code',
      description: 'Open a pull request with the canvas design exported for developers',
      argsSchema: { canvas_id: z.string(), repo: z.string() },
    },
    ({ canvas_id, repo }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: handoffPrompt.replace('{canvas_id}', canvas_id).replace('{repo}', repo),
          },
        },
      ],
    }),
  )

  /* ---- capabilities: one call that says which integrations are live ---- */

  tool(
    'get_capabilities',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Get server capabilities',
      description:
        'Which optional integrations are actually configured on this server (screenshot renderer, image/icon/logo search, website capture, model accounts, the design workflow’s implementer and judge models, GitHub), plus the current size and rate limits. It also catalogues the surface itself: every registered tool with its domain and its read-only/destructive/idempotent flags, and the resources and prompts this server exposes. Call it ONCE before planning asset-heavy, import-heavy or export-heavy work: it is how you know a feature is available instead of discovering a failure mid-task. Pass canvas_id and your agent_name to also be told `agent_level`, the level the canvas owner has given this agent on that canvas (full, propose, comment or view) — what this agent may do there, before it tries and is refused.',
      inputSchema: {
        canvas_id: z
          .string()
          .optional()
          .describe('A canvas to report this agent’s level on, so the answer covers what you may do there'),
        agent_name: agentName.optional(),
      },
      outputSchema: { capabilities: z.record(z.unknown()) },
    },
    async ({ canvas_id, agent_name }) => {
      const caps = await capabilities()
      /* The caller's own leash, when this call names a canvas it can be
         resolved for: the level the owner has given this agent there. A call
         that names none — or an agent with no identity to file one against —
         reports nothing rather than a level it guessed. */
      const held = await agentLevelOf({ canvas_id, agent_name }, session.agentId)
      /* The catalog is derived from the registry the wrapper fills, so it
         cannot drift from the tools actually registered. `read_only` and
         `destructive` are the annotations the tool itself published — the same
         hints a client sees in tools/list — and `domain` is the taxonomy above. */
      const tools = [...registry.entries()].map(([name, entry]) => {
        const readOnly = entry.annotations?.readOnlyHint === true
        return {
          name,
          domain: TOOL_DOMAINS[name] ?? 'other',
          read_only: readOnly,
          destructive: entry.annotations?.destructiveHint === true,
          /* retryable without harm: a read, a tool the wrapper replays by
             op_id, or one that declares itself idempotent */
          idempotent: readOnly || entry.annotations?.idempotentHint === true || MUTATING_TOOLS[name] === true,
          summary: toolSummary(entry.description),
        }
      })
      const payload = {
        ...caps,
        /* this server's surface is filtered: read-only mode registers only the
           tools that declare readOnlyHint, so `tools` above is the honest list
           and a client can see why writes are missing */
        readonly: opts?.readonly === true,
        /* what this agent may do on the canvas it named, when it named one */
        ...(held ? { agent_level: held.level } : {}),
        tools,
        resources: RESOURCE_NAMES,
        prompts: PROMPT_NAMES,
        /* `with_read_only` is the coverage of the annotation contract: how many
           tools DECLARE readOnlyHint (true or false). A client reads it to know
           whether it can trust the flags above for auto-approval. */
        annotations_coverage: {
          with_read_only: [...registry.values()].filter((e) => e.annotations?.readOnlyHint !== undefined).length,
          total: registry.size,
        },
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: { capabilities: payload },
      }
    },
  )

  /* ---- the chat channel: the canvas's work queue ---- */

  /* Chat is where a human tells an agent what to do when there is no element
     to comment on ("when you're done, the CTA copy is wrong") and where an
     agent reports back without pinning a note. Unlike a comment it is not
     anchored to anything, and unlike a question it never blocks: it is a
     queue, and the agent reads it on its own schedule. */

  /** Does this message reach this agent? A message with no `to` is for
   *  everyone; one with a `to` is for the agent or the role it names — the
   *  same resolution the event bus uses (`addressedTo`), so a human who
   *  @mentions a role in chat and in a comment reaches the same agent.
   *  Written through the bus helper rather than a second matcher, or the two
   *  channels would drift. */
  const messageForMe = (message: { to?: string; at: number }, me: agentEvents.WaiterIdentity): boolean =>
    agentEvents.addressedTo(
      { seq: 0, at: message.at, kind: 'comment', ...(message.to ? { targetAgent: message.to } : {}) },
      me,
    )

  /** How many messages a read returns unless the caller asks for fewer. */
  const CHAT_DEFAULT_LIMIT = 50

  tool(
    'get_messages',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read the canvas chat — your work queue',
      description:
        'Read the canvas chat: the WORK QUEUE for this canvas. A human posts what they want done here (and answers you here), so an agent that just connected should read it FIRST, before touching any frame, and read it again between tasks. Returns messages addressed to you, to the role you work, or to everyone — oldest first, and never the notes routed to another agent. Pass `since` (the `at` of the last message you read) to get only what is new; it is an epoch-ms cursor, so pass it back verbatim. has_more is true when older unread messages were cut by the limit. Post your own with send_message, and treat a message here exactly like a comment: do the work, then answer in the chat.',
      inputSchema: {
        canvas_id: z.string(),
        since: z
          .number()
          .optional()
          .describe('Epoch-ms cursor: only messages at or after this time (the `at` of the last one you read)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(CHAT_DEFAULT_LIMIT)
          .describe('How many messages to return, newest of the window first — default 50, max 200'),
        role: z
          .string()
          .optional()
          .describe(
            'The role you are working, as an id or a name (e.g. "a11y" or "Accessibility") — messages addressed to that role reach you. Pass it unless your agent_name is already the role you work.',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        messages: z.array(
          z.object({
            id: z.string(),
            author_name: z.string(),
            author_kind: z.enum(['user', 'agent']),
            to: z.string().optional(),
            body: z.string(),
            at: z.number(),
          }),
        ),
        has_more: z.boolean().describe('Older messages were left out by the limit'),
      },
    },
    async ({ canvas_id, since, limit, role, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      if (agent_name) await arrive(canvas_id, agent_name)
      const wanted = roleFor(role)
      if (role && !wanted)
        return err('invalid_input', `no role "${role}" — the roles are ${AGENT_ROLES.map((r) => r.id).join(', ')}`)
      const me: agentEvents.WaiterIdentity = {
        agentName: actorFrom(agent_name).name,
        ...(wanted ? { role: wanted.id } : {}),
      }
      const mine = persist
        .getAgentMessages(canvas_id, { ...(since !== undefined ? { since } : {}) })
        .filter((m) => messageForMe(m, me))
      const messages = mine.slice(-limit)
      return structured({
        messages: messages.map((m) => ({
          id: m.id,
          author_name: m.authorName,
          author_kind: m.authorKind,
          ...(m.to ? { to: m.to } : {}),
          body: m.body,
          at: m.at,
        })),
        has_more: mine.length > messages.length,
      })
    },
  )

  tool(
    'get_inbox',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'What is waiting for you, canvas by canvas',
      description:
        'Every canvas this account can reach, with what is waiting for YOU on each: questions of yours nobody has answered, element comments addressed to you or to the role you work that nobody has claimed, chat messages addressed to you that you did not write, and proposals of yours a human has not decided yet. Ask it between tasks — "which canvas needs me?" — instead of reading each canvas in turn; it reads across every canvas in one call. Pass agent_name, and role if you work one, because nothing else tells the inbox which notes are yours. A count is a pointer, not the work: open the canvas it names with get_messages, get_comments, get_answers and list_change_proposals.',
      inputSchema: {
        role: z
          .string()
          .optional()
          .describe(
            'The role you work, as an id or a name (e.g. "a11y" or "Accessibility") — notes addressed to that role count as yours. Pass it unless your agent_name is already the role you work.',
          ),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        canvases: z.array(
          z.object({
            canvas_id: z.string(),
            canvas_name: z.string(),
            open_questions: z.number().describe('Your questions still open'),
            unclaimed_comments: z.number().describe('Notes addressed to you or your role that nobody has claimed'),
            unread_messages: z.number().describe('Chat messages that reach you and that you did not write'),
            pending_proposals: z.number().describe('Your proposals still waiting on a human'),
          }),
        ),
      },
    },
    async ({ role, agent_name }) => {
      const wanted = roleFor(role)
      if (role && !wanted)
        return err('invalid_input', `no role "${role}" — the roles are ${AGENT_ROLES.map((r) => r.id).join(', ')}`)
      const actor = actorFrom(agent_name)
      const me: agentEvents.WaiterIdentity = {
        agentName: actor.name,
        ...(wanted ? { role: wanted.id } : {}),
      }
      /* The same resolution the claim path uses, so a note counted here is a
         note claim_comment would actually take: a comment's target is a role
         NAME, while the agent may name itself by role id, by role name, or by
         a name of its own. */
      const addressed = wanted?.name ?? roleFor(actor.name)?.name ?? actor.name
      const canvases: {
        canvas_id: string
        canvas_name: string
        open_questions: number
        unclaimed_comments: number
        unread_messages: number
        pending_proposals: number
      }[] = []
      /* the reach gate list_canvases uses: the account's own canvases plus the
         ones it was made a member of — never a canvas it cannot open */
      for (const canvas of store.listCanvases(ownerId ?? '')) {
        const questions = actions
          .getQuestions(canvas.id)
          .filter((q) => q.status === 'open' && q.agentName === actor.name).length
        const comments = actions
          .getComments(canvas.id)
          .filter(
            (c) =>
              c.forAgent &&
              !c.claimedBy &&
              !c.failedAt &&
              !c.resolvedAt &&
              (c.targetAgent ?? roleName(DEFAULT_ROLE_ID)) === addressed,
          ).length
        /* a message with no `to` is for everyone on the canvas, which is the
           same reach get_messages applies — your own posts are not waiting */
        const messages = persist
          .getAgentMessages(canvas.id)
          .filter((m) => messageForMe(m, me) && m.authorName !== actor.name).length
        const frameProposals = actions
          .getFrameProposals(canvas.id, 'pending')
          .filter((p) => p.agentName === actor.name).length
        const canvasProposals = (await persist.listCanvasProposals(canvas.id, { status: 'pending' })).filter(
          (p) => p.proposedBy === actor.name,
        ).length
        canvases.push({
          canvas_id: canvas.id,
          canvas_name: canvas.name,
          open_questions: questions,
          unclaimed_comments: comments,
          unread_messages: messages,
          pending_proposals: frameProposals + canvasProposals,
        })
      }
      return structured({ canvases })
    },
  )

  tool(
    'send_message',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Post to the canvas chat',
      description:
        'Post a message to the canvas chat — how an agent reports back to the humans without pinning a note to an element: a question that is not worth blocking on, what you changed and why, what you need next. Pass `to` to route it (@mention an agent name or a role id like "a11y"); omit it and everyone on the canvas sees it in the chat. The message lands live for every viewer. Use ask_human instead when you need an answer before continuing, and reply_to_comment when answering a note on an element.',
      inputSchema: {
        canvas_id: z.string(),
        body: z.string().min(1).max(4000).describe('The message. Plain text; it renders as one paragraph block.'),
        to: z
          .string()
          .max(60)
          .optional()
          .describe(
            'Route it to an agent name or a role id ("copy", "Accessibility"); omit to address the whole canvas',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        message_id: z.string(),
        at: z.number(),
      },
    },
    async ({ canvas_id, body, to, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      const message = persist.recordAgentMessage({
        id: nanoid(10),
        canvasId: c.id,
        authorName: actor.name,
        authorKind: 'agent',
        authorColor: actor.color,
        ...(to ? { to } : {}),
        body,
        at: Date.now(),
      })
      /* the room hears it the same way it hears a human's message, so the chat
         panel needs no special case for who wrote it */
      broadcast(c.id, { type: 'agentMessage', message, messageId: message.id })
      return structured({ ok: true as const, message_id: message.id, at: message.at })
    },
  )

  /* ---- ask_human: the blocking question ---- */

  tool(
    'ask_human',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Ask the human a question',
      description:
        'Ask the humans on this canvas a question and WAIT for the answer (up to the wait_seconds you pass). Use it when a request is genuinely ambiguous or implies a destructive choice you cannot settle from the canvas — which palette direction, whether replacing a whole frame is intended, whether to delete something. Pass choices (2–6 short options) when the answer is one of a few directions: the client asks with those options, and the canvas shows them as buttons. When your client supports questions in its own UI the user is asked there and you get the answer directly (status "answered", via "elicitation"); otherwise the question appears live on the canvas and in the Review panel for the humans in the room. Either way the exchange is recorded on the canvas. If the wait expires you get status "open" plus the question id — carry on with your best judgement and check get_answers later, and do not ask the same question twice. Do not use it for information the canvas already answers. A human who stops or steers the run reaches you here too: the wait returns at once, with status "stopped" (stop working, report, and park in wait_for_events) or with the steer quoted in the result.',
      inputSchema: {
        canvas_id: z.string(),
        text: z
          .string()
          .min(1)
          .max(2000)
          .describe('The question. One clear ask; options inlined ("A or B?") if you have them.'),
        choices: z
          .array(z.string().min(1).max(120))
          .min(2)
          .max(6)
          .optional()
          .describe(
            '2–6 offered answers, each 1–120 chars. The human picks one (or several with multi) instead of typing free text; set allow_other to also accept a typed answer.',
          ),
        multi: z.boolean().optional().describe('The human may pick more than one choice (default: one)'),
        allow_other: z
          .boolean()
          .optional()
          .describe('Also accept an answer that is not one of the choices (default: only the choices)'),
        frame_id: z.string().optional().describe('Pin the question to a frame'),
        selector: z.string().optional().describe('Element selector the question is about, from inspect_frame'),
        stable_key: z
          .string()
          .max(300)
          .optional()
          .describe("That element's key from inspect_frame — keeps the pin on the content if the selector goes stale"),
        wait_seconds: z
          .number()
          .min(0)
          .max(120)
          .optional()
          .describe('How long to block waiting for an answer, default 60'),
        agent_name: agentName,
      },
    },
    async (
      { canvas_id, text, choices, multi, allow_other, frame_id, selector, stable_key, wait_seconds, agent_name },
      extra: ToolExtra,
    ) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const waitMs = Math.max(0, wait_seconds ?? 60) * 1000
      /* A choice question is only a choice question with real options: a
         one-entry list (or an empty one) is the free-text ask it already was. */
      const offered = (choices ?? []).map((c) => c.trim()).filter(Boolean)
      const useChoices = offered.length >= 2
      const isMulti = useChoices && !!multi
      /* The client in front of the agent can answer directly, in its own UI —
         no canvas question, no polling. When it cannot, the canvas question
         below is the fallback: the humans in the room are the other half of
         the audience, and one of them usually has the answer. */
      if (waitMs > 0 && server.server.getClientCapabilities()?.elicitation) {
        try {
          const elicited = await extra.sendRequest(
            {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: text,
                requestedSchema: {
                  type: 'object',
                  properties: {
                    answer: useChoices
                      ? {
                          title: 'Your answer',
                          description: 'Answer for the agent. It continues with this as soon as you submit.',
                          ...(isMulti
                            ? { type: 'array', items: { type: 'string', enum: offered } }
                            : { type: 'string', enum: offered }),
                        }
                      : {
                          type: 'string',
                          title: 'Your answer',
                          description: 'Answer for the agent. It continues with this as soon as you submit.',
                          maxLength: 2000,
                        },
                  },
                  required: ['answer'],
                },
              },
            },
            ElicitResultSchema,
            { timeout: waitMs },
          )
          const answerValue = (elicited.content as { answer?: unknown } | undefined)?.answer
          const answer = Array.isArray(answerValue)
            ? answerValue
                .filter((v): v is string => typeof v === 'string')
                .map((v) => v.trim())
                .filter(Boolean)
                .join(', ')
            : typeof answerValue === 'string'
              ? answerValue.trim()
              : ''
          if (
            elicited.action === 'accept' &&
            answer &&
            /* a client that ignored the enum does not get to settle a choice
               question with something that was never on offer — fall through
               to the canvas, where the choices are enforced */
            (!useChoices || allow_other || actions.matchesChoices(answer, offered, isMulti))
          ) {
            /* recorded on the canvas too: the humans who were not in front of
               the client still see the question and what settled it */
            const recorded = actions.recordElicitedAnswer(
              canvas_id,
              {
                text,
                answer,
                ...(useChoices ? { choices: offered } : {}),
                ...(isMulti ? { multi: true } : {}),
                ...(useChoices && allow_other ? { allowOther: true } : {}),
                ...(frame_id ? { frameId: frame_id } : {}),
                ...(selector ? { selector } : {}),
                ...(stable_key ? { stableKey: stable_key } : {}),
              },
              actorFrom(agent_name),
              elicitedActor(),
            )
            return structured({
              question_id: recorded?.id ?? null,
              status: 'answered' as const,
              answer,
              answered_by: elicitedActor().name,
              via: 'elicitation' as const,
            })
          }
        } catch {
          /* the client declared elicitation but did not complete one: fall
             through to the canvas question, which is the path that always works */
        }
      }
      const question = actions.askQuestion(
        canvas_id,
        {
          text,
          ...(useChoices ? { choices: offered } : {}),
          ...(isMulti ? { multi: true } : {}),
          ...(useChoices && allow_other ? { allowOther: true } : {}),
          ...(frame_id ? { frameId: frame_id } : {}),
          ...(selector ? { selector } : {}),
          ...(stable_key ? { stableKey: stable_key } : {}),
          waitSeconds: wait_seconds,
        },
        actorFrom(agent_name),
      )
      if (!question) return noCanvas(canvas_id)
      actions.markAgentWaiting(canvas_id, actorFrom(agent_name).name, true)
      const remaining = Math.max(0, question.expiresAt - Date.now())
      /* A stop or a steer has to be able to reach an agent parked on a
         question: a human who has decided the run should end must not have to
         wait out the question's timeout to be obeyed. Both arrive here as
         events, and the question itself is left OPEN — a human may still
         answer it, and get_answers will show what they said. */
      const events =
        waitMs > 0
          ? await agentEvents.wait(canvas_id, {
              agentName: actorFrom(agent_name).name,
              cursor: 0,
              timeoutMs: Math.min(waitMs, remaining),
              kinds: ['question_answer', 'stop', 'steer'],
            })
          : []
      const answer = events.find(
        (e) =>
          (e.data as { questionId?: string })?.questionId === question.id &&
          (e.data as { answer?: string })?.answer !== undefined,
      )
      if (answer) {
        const data = answer.data as { answer: string }
        return structured({
          question_id: question.id,
          status: 'answered' as const,
          answer: data.answer,
          answered_by: (question as { answeredBy?: string }).answeredBy,
        })
      }
      const stopped = events.find((e) => e.kind === 'stop')
      if (stopped) {
        const who = eventField(stopped.data, 'by')
        const by = typeof who === 'string' && who ? who : 'a human'
        return structuredWithNudge(
          { question_id: question.id, status: 'stopped' as const, stopped_by: by },
          `${by} STOPPED THIS RUN while you were waiting for an answer. Stop working now: do not start new tool calls. Say where you got to with send_message, then park in wait_for_events until a human tells you what to do next.`,
        )
      }
      const steered = events.filter((e) => e.kind === 'steer')
      return structuredWithNudge(
        {
          question_id: question.id,
          status: 'open' as const,
          ...(question.choices?.length ? { choices: question.choices } : {}),
          ...(question.multi ? { multi: true } : {}),
        },
        steered.length
          ? `A human steered this run while you were waiting for an answer: ${steered
              .map((e) => {
                const message = eventField(e.data, 'message')
                const by = eventField(e.data, 'by')
                return `${typeof by === 'string' ? by : 'a human'} — ${typeof message === 'string' ? message : ''}`
              })
              .join(
                '; ',
              )}. Follow that instruction. Your question is still open (get_answers later for the answer); judge whether it is still worth asking.`
          : 'Nobody answered yet. Continue with your best judgement; check get_answers later for this question_id.',
      )
    },
  )

  tool(
    'get_answers',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Check for answers to your questions',
      description:
        'Check whether humans answered your ask_human questions. Returns every question you asked on this canvas with its current status and answer. Cheap to poll; use it after a wait expired with status "open".',
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const mine = actions.getQuestions(canvas_id).filter((q) => q.agentName === actorFrom(agent_name).name)
      const summary = mine.map((q) => ({
        question_id: q.id,
        status: q.status,
        text: q.text,
        ...(q.choices?.length ? { choices: q.choices } : {}),
        ...(q.multi ? { multi: true } : {}),
        ...(q.answer ? { answer: q.answer, answered_by: q.answeredBy } : {}),
      }))
      return structured({ questions: summary })
    },
  )

  tool(
    'withdraw_question',
    {
      title: 'Take back a question you asked',
      description:
        'Withdraw a question you asked with ask_human that you no longer need answered — you worked the ambiguity out yourself, or the work moved on. It stops counting as open in the inbox and the Review panel instead of waiting out its time, and a parked ask_human waiting on it is told it is settled, so nobody spends an answer on a question that is already gone. Only the agent that asked may withdraw it; another agent’s attempt is refused with forbidden naming the asker. A question already answered, expired or withdrawn comes back with the status it holds and nothing changes.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        question_id: z.string().describe('The question to withdraw, from ask_human or get_answers'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        question_id: z.string(),
        status: z.enum(['open', 'answered', 'expired', 'withdrawn']),
      },
    },
    async ({ question_id, agent_name }) => {
      const found = actions.findQuestion(question_id)
      if (!found) return err('not_found', `no question with id ${question_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      /* a question is named by its own id, so the wrapper's authority check had
         no canvas in the arguments to read — the same refusal runs here, now
         that the canvas is known */
      const denied = intentRefusal('withdraw_question', 'comment', { canvas_id: found.canvasId })
      if (denied) return denied
      await arrive(found.canvasId, agent_name)
      let withdrawn: AgentQuestion | undefined
      try {
        withdrawn = actions.withdrawQuestion(question_id, actorFrom(agent_name))
      } catch (e) {
        const refusal = ownerRefusal(e)
        if (refusal) return refusal
        throw e
      }
      if (!withdrawn) return err('not_found', `no question with id ${question_id}`)
      return structured({ ok: true as const, question_id: withdrawn.id, status: withdrawn.status })
    },
  )

  /* ---- wait_for_events: the idle keep-alive ---- */

  tool(
    'wait_for_events',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      title: 'Wait for human events',
      description:
        'Block until something on this canvas needs you: a comment (a human @mentioning a role, replying to you, or claiming your note), an answer to your question, a proposal of yours being resolved, or a human taking over a frame you were streaming into. Pass the cursor from your previous call to only see newer events; an empty cursor means everything pending. Between tasks, call this instead of ending your session — it also keeps your presence alive so the humans see you connected. Resolves on the first event or on timeout (whichever comes first); a timeout is normal, just call again. Pass `role` for the role you work: humans address work by @mentioning a role, so without it you are woken only by notes addressed to your own name, or to a role your name itself names (connecting as "a11y" covers that role).',
      inputSchema: {
        canvas_id: z.string(),
        cursor: z
          .number()
          .optional()
          .describe('Cursor from your previous wait_for_events (or get 0 for "everything pending")'),
        timeout_seconds: z.number().min(5).max(120).optional().describe('How long to block, default 60'),
        role: z
          .string()
          .optional()
          .describe(
            'The role you are working, as an id or a name (e.g. "a11y" or "Accessibility"). Humans address work by @mentioning a role, so pass this unless your agent_name is already the role you work — a name that names a role covers it. Notes that @mention your agent_name reach you either way.',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        cursor: z.number(),
        timed_out: z.boolean(),
        events: z.array(z.object({ seq: z.number(), kind: z.string(), at: z.number(), summary: z.string() })),
      },
    },
    async ({ canvas_id, cursor, timeout_seconds, role, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const wanted = roleFor(role)
      if (role && !wanted)
        return err('invalid_input', `no role "${role}" — the roles are ${AGENT_ROLES.map((r) => r.id).join(', ')}`)
      const actor = actorFrom(agent_name)
      /* while parked the agent is legitimately idle: the 60s parked TTL
         applies, not the 20s idle sweep, and presence stays live */
      actions.heartbeatAgent(canvas_id, actor)
      actions.markAgentWaiting(canvas_id, actor.name, true)
      const from = cursor ?? agentEvents.cursor(canvas_id)
      const timeoutMs = Math.min(120, Math.max(5, timeout_seconds ?? 60)) * 1000
      const me = { agentName: actor.name, ...(wanted ? { role: wanted.id } : {}) }
      const events = await agentEvents.wait(canvas_id, { ...me, cursor: from, timeoutMs })
      const visible = events.filter((e) => agentEvents.addressedTo(e, me)).slice(-20)
      const summarized = visible.map((e) => {
        const d = (e.data ?? {}) as Record<string, unknown>
        const summary =
          typeof d.text === 'string' && d.text
            ? d.text.slice(0, 200)
            : typeof d.summary === 'string' && d.summary
              ? d.summary.slice(0, 200)
              : e.kind.replace('_', ' ')
        return { seq: e.seq, kind: e.kind, at: e.at, summary }
      })
      actions.markAgentWaiting(canvas_id, actor.name, false)
      const newCursor = summarized.length ? summarized[summarized.length - 1]!.seq : from
      /* A quiet timeout is the one place the role mistake goes silent: an
         agent that parked with only its own name gets nothing back and parks
         again, forever, while notes addressed to its role sit unread. Say so
         once — but only when NOTHING about this agent resolves to a role, so
         an agent that passed role, or whose own name is already a role, keeps
         its ordinary quiet timeout. Uses the same resolver as the matcher, so
         the message can never contradict who actually gets woken. */
      if (summarized.length === 0 && !wanted && !roleFor(actor.name))
        return structuredWithNudge(
          { cursor: newCursor, timed_out: true, events: [] },
          `Nothing arrived in ${Math.round(timeoutMs / 1000)}s, and nothing about your identity resolves to a role — so notes @mentioning one did not reach you. Humans address work to roles: pass role: "<id>" (one of ${AGENT_ROLES.map((r) => r.id).join(', ')}) to be woken for the role you work.`,
        )
      return structured({
        cursor: newCursor,
        timed_out: summarized.length === 0,
        events: summarized,
      })
    },
  )

  /* ---- review mode proposals ---- */

  tool(
    'propose_frame_html',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Propose new frame HTML for review',
      description:
        'Propose a full replacement design for a frame WITHOUT touching the canvas. Use it when the canvas is in review mode (direct writes fail with "review mode"); the proposal appears in the human Review panel with a side-by-side render, and lands on the canvas the moment a human accepts. Include a clear summary: it is the first thing the reviewer reads. If the frame changes before your proposal is reviewed, it is marked stale and you will see it in list_change_proposals.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        html: z
          .string()
          .describe(`Full replacement HTML (mode "replace", the default). Max ${MAX_FRAME_HTML_BYTES} characters.`),
        mode: z
          .enum(['replace', 'patch'])
          .optional()
          .describe(
            'replace = a whole new document (default); patch = targeted edits applied to the frame as you read it, so the reviewer can resolve hunks individually',
          ),
        edits: z
          .array(
            z.object({
              old_str: z.string().min(1).max(MAX_FRAME_HTML_BYTES),
              new_str: z.string().max(MAX_FRAME_HTML_BYTES),
            }),
          )
          .max(20)
          .optional()
          .describe(
            'patch mode: exact find/replace edits, in order — each old_str must occur exactly once in the frame HTML you based this on',
          ),
        summary: z.string().max(500).describe('One line: what changes and why the reviewer should accept it'),
        expected_updated_at: z.string().optional().describe('The frame updatedAt you based this on (baseUpdatedAt)'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), proposal_id: z.string(), status: z.string() },
    },
    async ({ canvas_id, frame_id, html, mode, edits, summary, expected_updated_at, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id || !canvasFor(canvas_id)) return noFrame(frame_id)
      /* patch mode carries no document, so the size ceiling applies to the
         replacement text instead — and every old_str is validated exactly the
         way edit_frame_html validates its replacement, against the base the
         agent read, before the proposal is worth a reviewer's time */
      if (mode === 'patch') {
        if (!edits?.length) return err('invalid_input', 'patch mode requires edits — a list of { old_str, new_str }')
        if (html)
          return err('invalid_input', 'patch mode takes edits, not html — omit html or switch to mode "replace"')
        const baseHtml = expected_updated_at ? undefined : f.html
        let patched = baseHtml ?? f.html
        for (const [i, edit] of edits.entries()) {
          const count = patched.split(edit.old_str).length - 1
          if (count === 0) return err('invalid_input', `edits[${i}]: old_str not found in the frame HTML`)
          if (count > 1)
            return err(
              'invalid_input',
              `edits[${i}]: old_str occurs ${count} times — include more surrounding context so it matches exactly once`,
            )
          patched = patched.replace(edit.old_str, edit.new_str)
        }
        if (tooLarge(patched))
          return err(
            'too_large',
            `the patched document would be ${patched.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}.`,
          )
        await arrive(canvas_id, agent_name)
        const gated = proposeGate(canvas_id, 'edit_frame_html')
        if (gated) return gated
        const base = expected_updated_at ? Date.parse(expected_updated_at) : f.updatedAt
        const proposal = actions.addFrameProposal(
          canvas_id,
          {
            kind: 'replace_html',
            frameId: frame_id,
            mode: 'patch',
            edits,
            summary,
            ...(Number.isFinite(base) ? { baseUpdatedAt: base } : {}),
          },
          actorFrom(agent_name),
        )
        if (!proposal) return noFrame(frame_id)
        return structured({ ok: true as const, proposal_id: proposal.id, status: proposal.status })
      }
      if (tooLarge(html))
        return err('too_large', `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}.`)
      await arrive(canvas_id, agent_name)
      /* A proposal is the way to land this change when the canvas gates writes
         (review mode) OR when this agent is itself held at `propose`: with it
         off and a full agent, the write should land directly rather than sit
         in a queue nobody is reviewing. */
      const gated = proposeGate(canvas_id, 'edit_frame_html')
      if (gated) return gated
      const base = expected_updated_at ? Date.parse(expected_updated_at) : f.updatedAt
      const proposal = actions.addFrameProposal(
        canvas_id,
        {
          kind: 'replace_html',
          frameId: frame_id,
          html,
          summary,
          ...(Number.isFinite(base) ? { baseUpdatedAt: base } : {}),
        },
        actorFrom(agent_name),
      )
      if (!proposal) return noFrame(frame_id)
      return structured({ ok: true as const, proposal_id: proposal.id, status: proposal.status })
    },
  )

  tool(
    'propose_frame_create',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Propose a new frame for review',
      description:
        'Propose creating a new frame without touching the canvas — the review-mode counterpart of create_frame. It appears in the human Review panel with a render of the proposed design and lands when a human accepts.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().max(200),
        html: z.string().describe(`Complete HTML for the frame body. Max ${MAX_FRAME_HTML_BYTES} characters.`),
        summary: z.string().max(500).describe('One line: what this frame adds and why'),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), proposal_id: z.string(), status: z.string() },
    },
    async ({ canvas_id, name, html, summary, x, y, width, height, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (tooLarge(html))
        return err('too_large', `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}.`)
      await arrive(canvas_id, agent_name)
      const gated = proposeGate(canvas_id, 'create_frame')
      if (gated) return gated
      const proposal = actions.addFrameProposal(
        canvas_id,
        { kind: 'create_frame', name, html, summary, x, y, width, height },
        actorFrom(agent_name),
      )
      if (!proposal) return noCanvas(canvas_id)
      return structured({ ok: true as const, proposal_id: proposal.id, status: proposal.status })
    },
  )

  tool(
    'propose_frame_delete',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Propose deleting a frame',
      description:
        'Propose deleting a frame without touching the canvas — the review-mode counterpart of delete_frame. The human sees what would go away and decides.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        summary: z.string().max(500).describe('One line: why this frame should go'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), proposal_id: z.string(), status: z.string() },
    },
    async ({ canvas_id, frame_id, summary, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id || !canvasFor(canvas_id)) return noFrame(frame_id)
      await arrive(canvas_id, agent_name)
      const gated = proposeGate(canvas_id, 'delete_frame')
      if (gated) return gated
      const proposal = actions.addFrameProposal(
        canvas_id,
        { kind: 'delete_frame', frameId: frame_id, summary },
        actorFrom(agent_name),
      )
      if (!proposal) return noFrame(frame_id)
      return structured({ ok: true as const, proposal_id: proposal.id, status: proposal.status })
    },
  )

  tool(
    'list_change_proposals',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'List your change proposals',
      description:
        'List the frame-change proposals on this canvas and their status — pending, accepted, rejected, withdrawn, or stale (the frame moved on after you proposed). Read it after a review to learn what the human decided.',
      inputSchema: {
        canvas_id: z.string(),
        status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn', 'stale']).optional(),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, status, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const proposals = actions.getFrameProposals(canvas_id, status).map((p) => ({
        proposal_id: p.id,
        /* the frame version this was proposed against: the anchor a reviewer
           compares the frame to before accepting, and what the stale guard
           reads — without it the list cannot say whether a proposal still
           describes what is on the canvas */
        base_updated_at: new Date(p.baseUpdatedAt).toISOString(),
        ...(p.html !== undefined ? { diff: { added: p.html.length, removed: 0 } } : {}),
        ...(p.mode === 'patch' && p.edits?.length
          ? {
              changed_regions: p.edits.map((edit, index) => {
                /* locate each edit's old_str in the base the proposal carries:
                   the region a reviewer reads before accepting one hunk */
                const base = p.baseHtml ?? store.getFrame(p.frameId ?? '')?.html ?? ''
                const at = base.indexOf(edit.old_str)
                return {
                  index,
                  ...(at >= 0
                    ? {
                        selector: `${
                          base
                            .slice(Math.max(0, at - 400), at)
                            .match(/<([a-z][a-z0-9]*)\b[^>]*>/gi)
                            ?.pop() ?? 'frame'
                        }`,
                      }
                    : {}),
                  kind: 'replace' as const,
                  before: at >= 0 ? edit.old_str.slice(0, 2000) : '',
                  after: edit.new_str.slice(0, 2000),
                }
              }),
            }
          : {}),
        ...(p.resolutionNote ? { resolution_note: p.resolutionNote } : {}),
      }))
      return structured({ proposals })
    },
  )

  tool(
    'resolve_frame_proposal',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Accept or reject a proposal',
      description:
        'Accept or reject a pending frame-change proposal. Without hunks the whole proposal lands or dies; with hunks ({ index, accept }) you resolve a patch proposal change by change and only the accepted hunks reach the frame. A note rides back to the proposing agent; force applies a proposal the stale guard would otherwise refuse.',
      inputSchema: {
        canvas_id: z.string(),
        proposal_id: z.string(),
        action: z.enum(['accept', 'reject']),
        hunks: z
          .array(z.object({ index: z.number().int().min(0), accept: z.boolean() }))
          .max(50)
          .optional()
          .describe('patch mode only: resolve individual edits — accepted hunks apply, the rest are dropped'),
        note: z.string().max(1000).optional().describe('One line the proposing agent reads with the decision'),
        force: z.boolean().optional().describe('Accept even though the frame changed since the proposal was made'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, proposal_id, action, hunks, note, force, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const proposal = actions.resolveFrameProposal(
        canvas_id,
        proposal_id,
        action === 'accept',
        actorFrom(agent_name),
        {
          ...(note ? { note } : {}),
          ...(force ? { force: true } : {}),
          ...(hunks?.length ? { hunks } : {}),
        },
      )
      if (!proposal) return err('not_found', `no pending proposal with id ${proposal_id} on this canvas`)
      return structured({ ok: true as const, proposal_id, status: proposal.status })
    },
  )

  tool(
    'resolve_frame_proposals',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Accept or reject several proposals',
      description:
        'Resolve up to 50 frame-change proposals in one call — clear a review queue after reading them. Per-id results: a proposal that is gone, already resolved, or not on this canvas is reported at its id and the rest still resolve.',
      inputSchema: {
        canvas_id: z.string(),
        ids: z.array(z.string()).min(1).max(50).describe('Proposal ids to resolve'),
        action: z.enum(['accept', 'reject']),
        note: z.string().max(1000).optional().describe('One note applied to every proposal in the batch'),
        agent_name: agentName,
      },
      outputSchema: {
        results: z.array(
          z.object({
            proposal_id: z.string(),
            ok: z.boolean(),
            status: z.string().optional(),
            reason: z.string().optional(),
          }),
        ),
      },
    },
    async ({ canvas_id, ids, action, note, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      const results = ids.map((id) => {
        const proposal = actions.resolveFrameProposal(canvas_id, id, action === 'accept', actor, {
          ...(note ? { note } : {}),
        })
        return proposal && proposal.status !== 'pending'
          ? { proposal_id: id, ok: true as const, status: proposal.status }
          : { proposal_id: id, ok: false as const, reason: 'no pending proposal with this id on this canvas' }
      })
      return structured({ results })
    },
  )

  tool(
    'rebase_proposal',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Rebase a stale proposal',
      description:
        'Re-apply a stale patch-mode proposal onto the frame as it stands now: the edits are re-run against the current HTML, the proposal’s base is refreshed and it goes back to pending for review. Use it when your proposal was marked stale — the alternative is proposing again from scratch. Only patch (edit-based) proposals rebase; a whole-document proposal must be re-proposed.',
      inputSchema: {
        proposal_id: z.string(),
        agent_name: agentName,
      },
    },
    async ({ proposal_id, agent_name }) => {
      const proposal = actions.findFrameProposal(proposal_id)
      if (!proposal) return err('not_found', `no proposal with id ${proposal_id}`)
      /* findFrameProposal scans every canvas's log without naming the canvas;
         the proposal's own frame (patch mode is always frame-scoped) resolves
         it, and rebaseProposal re-checks ownership anyway */
      const canvasId = proposal.frameId ? store.getFrame(proposal.frameId)?.canvasId : undefined
      if (!canvasId) return err('not_found', `no proposal with id ${proposal_id}`)
      await arrive(canvasId, agent_name)
      const rebased = actions.rebaseProposal(canvasId, proposal_id, actorFrom(agent_name))
      if (!rebased)
        return err(
          'conflict',
          'the proposal could not be rebased — only a stale patch-mode proposal can be, and its edits must still match the frame',
        )
      return structured({ ok: true as const, proposal_id, status: rebased.status })
    },
  )

  tool(
    'withdraw_proposal',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Withdraw a pending proposal',
      description:
        'Withdraw your own pending frame-change proposal (for example when you notice a better approach before the human reviews it). Accepted, rejected or already-resolved proposals cannot be withdrawn.',
      inputSchema: {
        canvas_id: z.string(),
        proposal_id: z.string(),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, proposal_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      const proposal = actions.findFrameProposal(proposal_id)
      if (!proposal || !actions.getFrameProposals(canvas_id).some((p) => p.id === proposal_id))
        return err('not_found', `no proposal with id ${proposal_id} on this canvas`)
      if (proposal.agentName !== actor.name) return err('forbidden', 'you can only withdraw your own proposals')
      const withdrawn = actions.withdrawFrameProposal(canvas_id, proposal_id, actor)
      if (!withdrawn || withdrawn.status !== 'withdrawn')
        return err('invalid_input', 'only pending proposals can be withdrawn')
      return structured({ ok: true as const, proposal_id, status: withdrawn.status })
    },
  )

  /* ---- canvas-level proposals: review mode for everything that is not a frame ---- */

  tool(
    'propose_canvas_change',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Propose a canvas-level change',
      description:
        'Propose a change to the canvas itself — its design tokens, one style guide, the responsive breakpoints, or the page set — without touching it. This is the review-mode counterpart of set_tokens / set_guidelines / set_breakpoints / the page tools: the change appears in the human Review panel with what it replaces, and lands through the ordinary setters the moment a human accepts. payload is shaped per kind: tokens carries the whole DesignTokens object (or null to clear them); guidelines carries { name, markdown } (empty markdown deletes the doc); breakpoints carries the { name, min_width }[] list (empty clears it); pages carries one page operation — { op: "create", name }, { op: "rename", pageId, name }, { op: "delete", pageId } or { op: "move_frame", frameId, pageId }.',
      inputSchema: {
        canvas_id: z.string(),
        kind: z.enum(['tokens', 'guidelines', 'breakpoints', 'pages']).describe('Which part of the canvas changes'),
        payload: z
          .unknown()
          .describe(
            'The change to apply on accept, shaped per kind — see the description; a payload that kind could not apply is refused here rather than when a human accepts it',
          ),
        summary: z.string().max(500).optional().describe('One line on why — the first thing the reviewer reads'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        proposal_id: z.string(),
        kind: z.string(),
        status: z.string(),
      },
    },
    async ({ canvas_id, kind, payload, summary, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const gated = proposeGate(canvas_id, 'set_tokens / set_guidelines / set_breakpoints / the page tools')
      if (gated) return gated
      const actor = actorFrom(agent_name)
      try {
        const proposal = await actions.proposeCanvasChange(canvas_id, kind as CanvasProposalKind, payload, {
          userId: ownerId ?? '',
          agentName: actor.name,
        })
        if (summary) actions.logActivity(canvas_id, actor, summary)
        return structured({
          ok: true as const,
          proposal_id: proposal.id,
          kind: proposal.kind,
          status: proposal.status,
        })
      } catch (e) {
        return err('invalid_input', e instanceof Error ? e.message : 'the proposal could not be stored')
      }
    },
  )

  tool(
    'list_canvas_proposals',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'List the canvas-level proposals',
      description:
        'The canvas-level change proposals on this canvas and their status — pending, accepted, rejected or withdrawn — newest first. Read it after a review to learn what the human decided about the tokens, a guide doc, the breakpoints or the page set. Frame-level proposals live in list_change_proposals.',
      inputSchema: {
        canvas_id: z.string(),
        status: z.enum(['pending', 'accepted', 'rejected', 'withdrawn']).optional(),
        agent_name: agentName,
      },
      outputSchema: {
        proposals: z.array(
          z.object({
            proposal_id: z.string(),
            kind: z.string(),
            status: z.string(),
            payload: z.unknown(),
            before: z.unknown(),
            proposed_by: z.string(),
            created_at: z.number(),
            resolved_at: z.number().optional(),
            resolution_note: z.string().optional(),
          }),
        ),
      },
    },
    async ({ canvas_id, status, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const proposals = await persist.listCanvasProposals(
        canvas_id,
        status === undefined ? {} : { status: status as CanvasProposal['status'] },
      )
      return structured({
        proposals: proposals.map((proposal) => ({
          proposal_id: proposal.id,
          kind: proposal.kind,
          status: proposal.status,
          payload: proposal.payload,
          before: proposal.before,
          proposed_by: proposal.proposedBy,
          created_at: proposal.createdAt,
          ...(proposal.resolvedAt === undefined ? {} : { resolved_at: proposal.resolvedAt }),
          ...(proposal.resolutionNote === undefined ? {} : { resolution_note: proposal.resolutionNote }),
        })),
      })
    },
  )

  tool(
    'resolve_canvas_proposal',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Accept or reject a canvas-level proposal',
      description:
        'Accept or reject a pending canvas-level proposal (owner-only, exactly like resolve_frame_proposal). Accepting applies the payload through the ordinary setters, so the change versions, broadcasts and logs like a human edit; rejecting changes nothing. A note rides back to the proposing agent.',
      inputSchema: {
        canvas_id: z.string(),
        proposal_id: z.string(),
        action: z.enum(['accept', 'reject']),
        note: z.string().max(1000).optional().describe('One line the proposing agent reads with the decision'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), proposal_id: z.string(), status: z.string() },
    },
    async ({ canvas_id, proposal_id, action, note, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'resolve a canvas-level proposal')
      if (denied) return denied
      try {
        const proposal = await actions.resolveCanvasProposal(canvas_id, proposal_id, {
          accept: action === 'accept',
          ...(note ? { note } : {}),
          actor: { userId: ownerId ?? '', agentName: actorFrom(agent_name).name },
        })
        return structured({ ok: true as const, proposal_id, status: proposal.status })
      } catch (e) {
        return err('not_found', e instanceof Error ? e.message : `no pending proposal with id ${proposal_id}`)
      }
    },
  )

  /* ---- review_frame: one call, every viewport ---- */

  tool(
    'get_frame_review',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read a frame’s stored review verdict',
      description:
        'The verdict a frame already holds, read back instead of re-run: the newest stored report — verdict "pass" or "fail", when it was made and by whom, its blocking findings, and whether it still describes the frame as it stands (`current`), because a report is only evidence about the document it was made from. This is the cheap read before you claim a frame is done or re-check work someone else did: the ship paths (open_pull_request, publish_canvas, create_release, restore_release) ask the same stored report, so `current: false` or a "fail" here is exactly what would refuse them. It never renders — when the frame has no stored report, `source` is "none" and the answer says to run ready_for_review.',
      inputSchema: {
        frame_id: z.string(),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        frame_id: z.string(),
        source: z
          .enum(['stored', 'none'])
          .describe('Where the verdict came from: the frame’s newest stored report, or no stored report at all'),
        verdict: z.enum(['pass', 'fail']).optional(),
        at: z.string().optional().describe('When the report was made, ISO'),
        by: z.string().optional().describe('Who ran the checks the report holds'),
        current: z
          .boolean()
          .optional()
          .describe('The report still describes the frame as it stands — false means it was edited since'),
        issues: z
          .array(z.object({ rule: z.string(), selector: z.string(), detail: z.string(), source: z.string() }))
          .optional()
          .describe('The blocking findings the report recorded, worst first'),
        note: z.string().optional(),
      },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      await arrive(f.canvasId, agent_name)
      /* the same read the ship gate makes — the newest stored report, never a
         fresh render: this tool's whole point is that it costs no browser */
      const [report] = await persist.listFrameReviews(frame_id, 1)
      if (!report)
        return structured({
          frame_id,
          source: 'none' as const,
          note: 'no stored review for this frame — run ready_for_review (or review_frame) to check it and record a verdict',
        })
      /* The full report is a jsonb column, so it is `unknown` at this boundary
         — the canvas sweep reads it the same way — and a row written before a
         field existed must not fail the read. */
      const stored = report.report as { blocking?: unknown } | null
      const issues = (Array.isArray(stored?.blocking) ? stored.blocking : []).flatMap((finding) => {
        const f = finding as { rule?: unknown; selector?: unknown; detail?: unknown; source?: unknown }
        return typeof f.rule === 'string' &&
          typeof f.selector === 'string' &&
          typeof f.detail === 'string' &&
          typeof f.source === 'string'
          ? [{ rule: f.rule, selector: f.selector, detail: f.detail, source: f.source }]
          : []
      })
      return structured({
        frame_id,
        source: 'stored' as const,
        verdict: report.verdict,
        at: new Date(report.reviewedAt).toISOString(),
        by: report.reviewedBy,
        current: reportIsCurrent({ html_sha: report.htmlSha }, f, canvasFor(f.canvasId)?.tokens),
        issues,
      })
    },
  )

  tool(
    'review_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Review a frame across viewports',
      description:
        'The full quality gate in one call: design-token lint, accessibility audit, and layout analysis (overflow, clipping, overlap, truncation) at mobile, tablet and desktop widths in a single render batch. A canvas that declares breakpoints is reviewed at those widths too, and every viewport in the result is reported by its label. Call it on every frame you touched before you report the work done — it is what "I checked my work" means here. summary.errors and summary.critical are the counts that must be zero; warnings are judgement calls.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        device: z
          .enum(['mobile', 'tablet', 'desktop'])
          .optional()
          .describe('Just one viewport instead of all three; the canvas’s breakpoints are still reviewed'),
        agent_name: agentName,
      },
      outputSchema: {
        frame_id: z.string(),
        html_sha: z.string(),
        frame_updated_at: z.number(),
        reviewed_at: z.number(),
        viewports: z.array(
          z.object({
            viewport: z.object({ width: z.number(), height: z.number() }),
            label: z.string().optional(),
            verdict: z.enum(['pass', 'fail']),
          }),
        ),
        failing_viewports: z.array(z.string()),
        verdict: z.enum(['pass', 'fail']),
        summary: z.record(z.string(), z.number()),
        blocking: z.array(z.object({ rule: z.string(), selector: z.string(), detail: z.string(), source: z.string() })),
      },
    },
    async ({ canvas_id, frame_id, device, agent_name }, extra) => {
      const budget = takeRender(agent_name)
      if (budget) return budget

      const canvas = canvasFor(canvas_id)
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id || !canvas) return noFrame(frame_id)
      await arrive(canvas_id, agent_name)
      /* the canvas's breakpoints are the widths this design claims to support,
         so they are reviewed on top of the device presets rather than instead
         of them — a named width is what makes a finding attributable */
      const breakpoints = canvas.breakpoints ?? []
      await progress(extra, 0, `Reviewing “${f.name}” across viewports…`)
      const report = await reviewFrame(f, canvas.tokens, {
        ...(device ? { viewports: [VIEWPORTS[device]] } : {}),
        ...(breakpoints.length ? { breakpoints } : {}),
      })
      await progress(extra, 1, `Reviewed “${f.name}” across ${report.viewports.length} viewport(s).`)
      /* Persist it: a human reading the checks panel usually reads them after
         the agent that produced them is gone, and the delivery gate reads the
         newest stored report rather than trusting a claim. */
      await persist.saveFrameReview(reviewToRecord(report, f.canvasId, agent_name ?? owner ?? 'agent'))
      const text = `verdict: ${report.verdict} — critical a11y: ${report.summary.critical}, layout errors: ${report.summary.errors}, content errors: ${report.summary.content_errors}, off-token colors: ${report.summary.off_token}, warnings: ${report.summary.warnings} across ${report.viewports.length} viewport(s) (${report.viewports.map((entry) => entry.label ?? entry.viewport.width).join(', ')})${
        report.blocking.length
          ? `. Blocking (${report.blocking.length}): ${report.blocking
              .slice(0, 5)
              .map((b) => `${b.rule} ${b.selector}`)
              .join('; ')}`
          : ''
      }`
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: report as unknown as Record<string, unknown>,
      }
    },
  )

  /* ---- review_canvas: the whole canvas in one sweep ---- */

  tool(
    'review_canvas',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Review every frame on a canvas',
      description:
        'The canvas-wide counterpart of review_frame: one verdict for the whole design, with a row per frame — its verdict, how many blocking and advisory findings it carries, and why a frame could not be checked. Frames whose stored report still describes them are reused, so a sweep over an already-verified canvas costs no renders; the rest are reviewed at the device presets and the canvas breakpoints and every fresh report is recorded against the document it checked. This is the check the ship paths ask for: open_pull_request, publish_canvas, create_release and restore_release refuse a canvas whose frames are not currently verified and point here. ready_for_review and review_frame remain the per-frame gate for a frame you just changed.',
      inputSchema: {
        canvas_id: z.string(),
        page: z.string().optional().describe('Only frames on this page (name or id, from get_canvas)'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        verdict: z.enum(['pass', 'fail']),
        totals: z.object({ pass: z.number(), fail: z.number(), stale: z.number(), skipped: z.number() }),
        frames: z.array(
          z.object({
            frame_id: z.string(),
            name: z.string(),
            verdict: z.enum(['pass', 'fail', 'stale', 'skipped']),
            blocking: z.number(),
            advisory: z.number(),
            reason: z.string().optional(),
          }),
        ),
        duration_ms: z.number(),
      },
    },
    async ({ canvas_id, page, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      let pageId: string | undefined
      if (page !== undefined) {
        const resolved = resolvePage(canvas_id, page)
        if (resolved.error !== undefined) return err('invalid_input', resolved.error)
        pageId = resolved.page.id
      }
      const actor = actorFrom(agent_name)
      let summary
      try {
        summary = await reviewCanvas(canvas_id, {
          ...(pageId === undefined ? {} : { pageId }),
          actor: { userId: ownerId ?? '', agentName: actor.name },
        })
      } catch (e) {
        /* the canvas was checked above, so this is a crash inside the sweep */
        return err(codeFor(e), e instanceof Error ? e.message : 'the canvas sweep failed')
      }
      const failed = summary.frames.filter((row) => row.verdict === 'fail' || row.verdict === 'stale')
      return structuredWithNudge(
        {
          verdict: summary.verdict,
          totals: summary.totals,
          frames: summary.frames.map((row) => ({
            frame_id: row.frameId,
            name: row.name,
            verdict: row.verdict,
            blocking: row.blocking,
            advisory: row.advisory,
            ...(row.reason === undefined ? {} : { reason: row.reason }),
          })),
          duration_ms: summary.durationMs,
        },
        summary.verdict === 'pass'
          ? 'Every frame passes. ready_for_review and review_frame remain the per-frame gate: run one on any frame you change after this sweep, and the ship paths will ask for a fresh sweep if a frame moves.'
          : `${failed.length} frame(s) are not shipping clean: ${failed
              .map((row) => `“${row.name}” (${row.verdict}${row.reason ? `: ${row.reason}` : ''})`)
              .join(
                ', ',
              )}. Fix them and run review_canvas again — the ship paths refuse a canvas that is not verified end to end. ready_for_review on a single frame is still how you record one frame's fix.`,
      )
    },
  )

  /* ---- import_code: the design→code→design round trip ---- */

  tool(
    'import_code',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Import HTML as a frame',
      description:
        'Turn an HTML document (or fragment) into a frame on this canvas — the counterpart of export_frame. Use it to bring a design from a developer, a generated page, or a previous export back into the canvas where it renders live and can be edited like any frame. Scripts and inline event handlers are stripped; visuals and inline styles survive. If the canvas is in review mode the import becomes a proposal.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().max(200),
        html: z.string().describe('The HTML document or fragment to render as a frame'),
        width: z.number().min(1).max(20_000).optional().describe('Default 640'),
        height: z.number().min(1).max(20_000).optional().describe('Default 480'),
        frame_id: z.string().optional().describe('Replace an existing frame instead of creating one'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.object(frameSummaryShape), sanitized: z.boolean() },
    },
    async ({ canvas_id, name, html, width, height, frame_id, agent_name, op_id }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const clean = sanitizeImportedHtml(html)
      if (!/<html|<body|<div|<section|<main/i.test(clean))
        return err(
          'invalid_input',
          'the html has no renderable body after sanitization — scripts and event handlers are stripped, so send markup that survives that',
        )
      const actor = actorFrom(agent_name)
      const withOp = replayAsync(ownerId ?? '', op_id ?? '', async () => {
        const gated = reviewGate(canvas_id)
        if (gated) {
          const proposal = actions.proposeInsteadOfWrite(
            canvas_id,
            {
              kind: frame_id ? 'replace_html' : 'create_frame',
              ...(frame_id ? { frameId: frame_id } : {}),
              name,
              html: clean,
              summary: `imported code: ${name}`,
              width,
              height,
            },
            actor,
          )
          if (proposal)
            return structured({
              ok: true as const,
              proposal_id: proposal.id,
              status: proposal.status,
              sanitized: true as const,
              frame: frameSummary({
                id: frame_id ?? 'pending',
                name,
                html: clean,
                x: 0,
                y: 0,
                width: width ?? 640,
                height: height ?? 480,
                updatedAt: Date.now(),
                updatedBy: actor.name,
              }),
            })
          return gated
        }
        let frame: Frame | undefined
        if (frame_id) {
          frame = await actions.updateFrame(frame_id, { html: clean }, actor)
        } else {
          frame = await actions.createFrame(
            canvas_id,
            {
              name,
              html: clean,
              ...(width !== undefined ? { width } : {}),
              ...(height !== undefined ? { height } : {}),
            },
            actor,
          )
        }
        if (!frame) return noFrame(frame_id ?? canvas_id)
        return structured({ ok: true as const, frame: frameSummary(frame), sanitized: clean !== html })
      })
      return withOp
    },
  )

  /* ---- assets: list and look at what the canvas already has ---- */

  tool(
    'list_assets',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'List canvas assets',
      description:
        'List the image assets this canvas already has (uploads and anything its frames reference), newest first, with their public /a/ URLs. Check here before uploading the same image again — reuse keeps the design consistent and the canvas light.',
      inputSchema: {
        canvas_id: z.string(),
        limit: z.number().min(1).max(200).optional().describe('Default 50'),
        offset: z.number().min(0).optional(),
        agent_name: agentName,
      },
      outputSchema: {
        assets: z.array(
          z.object({
            id: z.string(),
            url: z.string(),
            mime: z.string(),
            bytes: z.number(),
            at: z.number(),
          }),
        ),
        ...pagedShape,
      },
    },
    async ({ canvas_id, limit, offset, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const listing = await assets.listAssets(canvas_id, { limit, offset })
      const hasMore = (offset ?? 0) + listing.assets.length < listing.total
      return structured({
        assets: listing.assets,
        total: listing.total,
        has_more: hasMore,
        ...(hasMore ? { next_offset: (offset ?? 0) + listing.assets.length } : {}),
      })
    },
  )

  tool(
    'get_asset',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'View a canvas asset',
      description:
        'Look at one asset of this canvas: image assets come back as an image you can actually see (the same way get_frame_screenshot shows a frame), with their public /a/ URL. Use it to check what an uploaded logo or photo looks like before placing it.',
      inputSchema: {
        canvas_id: z.string(),
        asset_id: z.string(),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, asset_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const asset = await assets.getCanvasAsset(canvas_id, asset_id)
      if (!asset) return err('not_found', `no asset with id ${asset_id} on this canvas`)
      if (!asset.mime.startsWith('image/'))
        return structured({
          id: asset.id,
          url: asset.url,
          mime: asset.mime,
          bytes: asset.bytes,
          note: 'not an image — no visual preview',
        })
      return {
        content: [
          { type: 'image' as const, data: asset.data.toString('base64'), mimeType: asset.mime },
          { type: 'text' as const, text: `${asset.url} (${asset.mime}, ${asset.bytes} bytes)` },
        ],
      }
    },
  )

  tool(
    'delete_asset',
    {
      title: 'Delete a canvas asset',
      description:
        "Permanently remove an uploaded asset (confirm: true). Refused while any frame's HTML still points at it; pass force: true to delete anyway and see which frames would break.",
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        canvas_id: z.string(),
        asset_id: z.string().describe('Asset id from list_assets'),
        confirm: z.literal(true).describe('Must be true — the bytes cannot be recovered'),
        force: z.boolean().optional().describe('Delete even though frames still reference it'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        deleted: z.string(),
        referenced_by: z.array(z.string()),
      },
    },
    async ({ canvas_id, asset_id, confirm, force, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      if (confirm !== true)
        return err('invalid_input', 'deleting an asset is irreversible — pass confirm: true to go ahead')
      const asset = await assets.getCanvasAsset(canvas_id, asset_id)
      if (!asset) return err('not_found', `no asset with id ${asset_id} on this canvas`)
      /* HTML is the ground truth for what references an asset, so this reads
         the frames rather than the asset_refs projection — and both views of
         them: the ledger can name a frame this process has not flushed yet,
         the live store cannot see another process's frame */
      const referencing = [
        ...new Set([
          ...(await assets.framesReferencingAsset(canvas_id, asset_id)),
          ...store.framesReferencingAsset(canvas_id, asset_id),
        ]),
      ]
      if (referencing.length && !force)
        return err(
          'conflict',
          `${referencing.length} frame(s) still reference this asset (${referencing.slice(0, 5).join(', ')}${referencing.length > 5 ? ', …' : ''}) — replace or remove those images first, or pass force: true to delete it anyway`,
          { referenced_by: referencing.slice(0, 5), count: referencing.length, force_available: true },
        )
      const removed = await assets.deleteAsset(asset_id)
      if (!removed) return err('not_found', `no asset with id ${asset_id} on this canvas`)
      actions.logActivity(canvas_id, actorFrom(agent_name), `deleted asset ${asset_id}`)
      return structured({ ok: true as const, deleted: asset_id, referenced_by: referencing.slice(0, 5) })
    },
  )

  /* ---- open_pull_request: the repo handoff ---- */

  /** The canvas's connection for a repo, normalized: a handoff and a repo read
   *  both resolve the credential the same way, canvas-scoped so neither can
   *  spend another canvas's token. Undefined means the caller must connect the
   *  repository first — the GitHub write paths say so themselves. */
  const repoConnection = async (canvasId: string, repo: string) => {
    const wanted = repo
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/, '')
    const connections = await github.listConnections(canvasId)
    return connections.find(
      (conn) => conn.repo.toLowerCase() === wanted.toLowerCase() && !!(conn.token || conn.installationId),
    )
  }

  tool(
    'open_pull_request',
    {
      /* destructive: it writes commits to a real repository and opens a PR
         under the connected account, so the `destructive` policy gates it */
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      title: 'Open a pull request with the canvas design',
      description:
        'Hand the design to a developer: write the exported frames (design/<frame-name>.html, its React component, its build spec, the design system and the assets that travel as text) to a branch in a connected GitHub repo and open a pull request. The title and body come from the handoff itself; message overrides the title. Requires a GitHub connection with contents:write and pull_requests:write — check get_capabilities first, github is "none" when no connection is configured. Every non-demo frame on the canvas must hold a CURRENT passing review or the handoff is refused with conflict, naming the frames; run review_canvas to clear them, or force: true to ship an unverified canvas deliberately.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        branch: z.string().optional().describe('Defaults to doop/<canvas-id>'),
        base: z.string().optional().describe("PR target branch; defaults to the repo connection's own branch"),
        message: z.string().max(200).optional().describe('PR title; defaults to the handoff’s own title'),
        release_id: z
          .string()
          .optional()
          .describe('Hand off this frozen release instead of the live frames — the PR then matches the link you sent'),
        force: z
          .boolean()
          .optional()
          .describe('Ship even though frames on this canvas are not currently verified — state that in your summary'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), branch: z.string(), commit: z.string(), url: z.string() },
    },
    async ({ canvas_id, repo, branch, base, message, release_id, force, agent_name, op_id }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      actions.assertAgentToolAllowed(canvas_id, actorFrom(agent_name), 'open_pull_request', { destructive: true })
      await arrive(canvas_id, agent_name)
      const withOp = replayAsync(ownerId ?? '', op_id ?? '', async () => {
        const gated = reviewGate(canvas_id)
        if (gated) return gated
        /* the whole canvas ships in this pull request, so the whole canvas has
           to be verified — not just the frames this agent happened to touch */
        const unverified = await shipRefusal(canvas_id, force)
        if (unverified) return unverified
        let handoff
        try {
          handoff = await handoffFiles(canvas_id, release_id ? { releaseId: release_id } : {})
        } catch (e) {
          if (e instanceof HandoffError) return err(e.code, e.message)
          return err('upstream_failed', e instanceof Error ? e.message : 'could not build the handoff')
        }
        const head = branch?.trim() || `doop/${canvas_id}`
        try {
          /* canvasId scopes the credential lookup to this canvas's
             connections: a handoff can never spend another canvas's token.
             The two halves run on that one connection: the commit carries the
             message, the pull request the handoff's own title and body. */
          const conn = await repoConnection(canvas_id, repo)
          const baseRef = base?.trim() || conn?.branch || 'main'
          const commit = await commitToBranch({
            repo,
            baseRef,
            headRef: head,
            files: handoff.files,
            message: message ?? handoff.pr.title,
            canvasId: canvas_id,
          })
          const pull = await ensurePullRequest({
            repo,
            baseRef,
            headRef: head,
            title: message ?? handoff.pr.title,
            body: handoff.pr.body,
            canvasId: canvas_id,
          })
          return structured({ ok: true as const, branch: commit.branch, commit: commit.commitSha, url: pull.url })
        } catch (e) {
          if (e instanceof GithubWriteError) return err(e.code, e.message)
          return err(codeFor(e), e instanceof Error ? e.message : 'the GitHub handoff failed')
        }
      })
      return withOp
    },
  )

  tool(
    'update_pull_request',
    {
      /* destructive: pushes commits to a branch and comments on a real PR */
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      title: 'Push an update to an open handoff pull request',
      description:
        'Re-commit the canvas onto the branch a previous handoff opened and post a summary comment on its pull request — the "send the client an update" path. The branch defaults to doop/<canvas-id> and the base to the repository connection’s own branch, so a caller that handed off with open_pull_request passes neither. The pull request must already exist for that branch pair; when none does, this refuses with not_found rather than quietly opening one.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        branch: z.string().optional().describe('The branch the handoff opened; defaults to doop/<canvas-id>'),
        base: z.string().optional().describe("PR target branch; defaults to the repo connection's own branch"),
        message: z.string().max(200).optional().describe('Commit message; defaults to a dated handoff line'),
        release_id: z.string().optional().describe('Update from this frozen release instead of the live frames'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        number: z.number(),
        url: z.string(),
        commit: z.string(),
        comment_id: z.number(),
      },
    },
    async ({ canvas_id, repo, branch, base, message, release_id, agent_name, op_id }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      actions.assertAgentToolAllowed(canvas_id, actorFrom(agent_name), 'update_pull_request', { destructive: true })
      await arrive(canvas_id, agent_name)
      const withOp = replayAsync(ownerId ?? '', op_id ?? '', async () => {
        const gated = reviewGate(canvas_id)
        if (gated) return gated
        let handoff
        try {
          handoff = await handoffFiles(canvas_id, release_id ? { releaseId: release_id } : {})
        } catch (e) {
          if (e instanceof HandoffError) return err(e.code, e.message)
          return err('upstream_failed', e instanceof Error ? e.message : 'could not build the handoff')
        }
        const conn = await repoConnection(canvas_id, repo)
        const baseRef = base?.trim() || conn?.branch || 'main'
        const head = branch?.trim() || `doop/${canvas_id}`
        const line = message?.trim() || `Design update: ${c.name}`
        try {
          const commit = await commitToBranch({
            repo,
            baseRef,
            headRef: head,
            files: handoff.files,
            message: line,
            canvasId: canvas_id,
          })
          const pull = await ensurePullRequest({
            repo,
            baseRef,
            headRef: head,
            title: handoff.pr.title,
            body: handoff.pr.body,
            canvasId: canvas_id,
          })
          /* `created` is the existence answer: true means GitHub had no pull
             request for this head/base and one was opened just now, so there
             was no handoff to update. */
          if (pull.created)
            return err(
              'not_found',
              `no pull request existed for ${head} → ${baseRef} on ${repo} — this call committed the canvas and opened #${pull.number} (${pull.url}) with the current design. Use open_pull_request for a deliberate first handoff, or call update_pull_request again now that the pull request exists.`,
              { number: pull.number, url: pull.url },
            )
          const comment = await commentPullRequest({
            repo,
            prNumber: pull.number,
            body: [
              `${line}`,
              '',
              handoff.pr.body,
              '',
              `Committed \`${commit.commitSha.slice(0, 7)}\` to \`${head}\`.`,
            ].join('\n'),
            canvasId: canvas_id,
          })
          return structured({
            ok: true as const,
            number: pull.number,
            url: pull.url,
            commit: commit.commitSha,
            comment_id: comment.commentId,
          })
        } catch (e) {
          if (e instanceof GithubWriteError) return err(e.code, e.message)
          return err(codeFor(e), e instanceof Error ? e.message : 'the pull request update failed')
        }
      })
      return withOp
    },
  )

  tool(
    'comment_pull_request',
    {
      /* destructive: it posts under the connected account to a real
         repository's pull request — outside this server's undo */
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      title: 'Comment on a handoff pull request',
      description:
        'Say something on a pull request this canvas opened: a comment in the conversation, or — with in_reply_to — an answer on one of the inline review comments, which keeps the reply attached to the file and line the reviewer asked about. Read the thread first with get_pull_request_review.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        pull: z.number().int().positive().describe('pull request number'),
        body: z.string().max(10_000).describe('The comment text (markdown)'),
        in_reply_to: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Reply to this inline review comment id instead of adding to the conversation'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), comment_id: z.number() },
    },
    async ({ canvas_id, repo, pull, body, in_reply_to, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      actions.assertAgentToolAllowed(canvas_id, actorFrom(agent_name), 'comment_pull_request', { destructive: true })
      await arrive(canvas_id, agent_name)
      try {
        const created = await commentPullRequest({
          repo,
          prNumber: pull,
          body,
          ...(in_reply_to === undefined ? {} : { inReplyTo: in_reply_to }),
          canvasId: canvas_id,
        })
        return structured({ ok: true as const, comment_id: created.commentId })
      } catch (e) {
        if (e instanceof GithubWriteError) return err(e.code, e.message)
        return err(codeFor(e), e instanceof Error ? e.message : 'the comment could not be posted')
      }
    },
  )

  tool(
    'get_pull_request_review',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'Read the review on a handoff pull request',
      description:
        'Read what a reviewer said on a pull request this canvas opened: the conversation, the inline comments (with the file and line they are attached to) and the review verdicts. A comment on design/<frame>.html comes back with the frame_id it belongs to, so you can act on it with get_element / update_elements / edit_frame_html. Read-only; needs a GitHub connection for the repo.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        pull: z.number().int().positive().describe('pull request number'),
        agent_name: agentName,
      },
      outputSchema: {
        number: z.number(),
        title: z.string(),
        state: z.string(),
        url: z.string(),
        head: z.string(),
        base: z.string(),
        files: z.array(z.string()),
        comments: z.array(
          z.object({
            author: z.string(),
            body: z.string(),
            path: z.string().optional(),
            line: z.number().optional(),
            created_at: z.string(),
            frame_id: z.string().optional(),
          }),
        ),
        reviews: z.array(z.object({ author: z.string(), state: z.string(), body: z.string() })),
        /** the PR has more comments/reviews/files than were read: the lists
         *  below are the first pages, not the whole review */
        truncated: z.boolean().optional(),
      },
    },
    async ({ canvas_id, repo, pull, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      try {
        const summary = await readPullRequest(repo, pull, canvas_id)
        const built = structured({
          number: summary.number,
          title: summary.title,
          state: summary.state,
          url: summary.url,
          head: summary.head,
          base: summary.base,
          files: summary.files,
          comments: summary.comments.map((comment) => {
            const frameId = frameIdForPath(c, comment.path)
            return {
              author: comment.author,
              body: comment.body,
              ...(comment.path ? { path: comment.path } : {}),
              ...(comment.line === undefined ? {} : { line: comment.line }),
              created_at: comment.createdAt,
              ...(frameId ? { frame_id: frameId } : {}),
            }
          }),
          reviews: summary.reviews.map((review) => ({
            author: review.author,
            state: review.state,
            body: review.body,
          })),
          ...(summary.truncated ? { truncated: true } : {}),
        })
        return built
      } catch (e) {
        if (e instanceof GithubWriteError) return err(e.code, e.message)
        return err(codeFor(e), e instanceof Error ? e.message : 'could not read the pull request')
      }
    },
  )

  /* ---- repo recon: what a connected repository holds, and importing one of
     its screens as a frame. The same connection model as open_pull_request:
     canvas-scoped, so a call can never spend another canvas's credential. */

  tool(
    'list_repo_screens',
    {
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      title: 'List a repository’s screens',
      description:
        'List the screens Doop found in a connected GitHub repository — page routes, component and story files, and static HTML — each with the source file it comes from. Call it before import_repo_screen to pick what to bring onto the canvas.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        repo: z.string(),
        framework: z.string().nullable(),
        truncated: z.boolean(),
        screens: z.array(
          z.object({
            route: z.string(),
            file: z.string(),
            kind: z.string(),
            title: z.string(),
            dynamic: z.boolean(),
          }),
        ),
      },
    },
    async ({ canvas_id, repo, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const conn = await repoConnection(canvas_id, repo)
      if (!conn)
        return err(
          'unsupported',
          `no GitHub connection for ${repo} on this canvas — connect the repository first, the same prerequisite open_pull_request has. get_capabilities reports github: "none" when no connection exists at all.`,
        )
      try {
        const manifest = await github.analyzeConnection(conn)
        return structured({
          repo: conn.repo,
          framework: manifest.framework,
          truncated: manifest.truncated,
          screens: manifest.screens.map((screen) => ({
            route: screen.route,
            file: screen.sourcePath,
            kind: screen.kind,
            title: screen.title,
            dynamic: screen.dynamic,
          })),
        })
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : `could not read ${conn.repo}`)
      }
    },
  )

  tool(
    'import_repo_screen',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      title: 'Import a repository screen',
      description:
        'Bring one screen of a connected GitHub repository onto this canvas as a frame, marked doop-github-screen so it stays traceable to its route and source file. A static HTML screen lands the repo HTML verbatim; a screen that exists only as code comes back as its source to design from — design it, then call again with html to land the frame.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        route: z
          .string()
          .optional()
          .describe('Screen route from list_repo_screens, e.g. "/pricing" — exactly one of route / file'),
        file: z.string().optional().describe('Source file path from list_repo_screens — exactly one of route / file'),
        html: z
          .string()
          .optional()
          .describe(
            'For a screen that exists only as code: the complete document you designed from its source (a final <!-- doop-height: N --> comment sizes the frame)',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        screen: z.object({ route: z.string(), file: z.string(), kind: z.string(), title: z.string() }),
        frame: z.object(frameSummaryShape).nullable(),
        source: z.array(z.object({ path: z.string(), text: z.string() })).optional(),
        note: z.string().optional(),
      },
    },
    async ({ canvas_id, repo, route, file, html, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      if ((route === undefined) === (file === undefined))
        return err(
          'invalid_input',
          'pass exactly one of route or file — list_repo_screens returns both for every screen',
        )
      const conn = await repoConnection(canvas_id, repo)
      if (!conn)
        return err(
          'unsupported',
          `no GitHub connection for ${repo} on this canvas — connect the repository first, the same prerequisite open_pull_request has. get_capabilities reports github: "none" when no connection exists at all.`,
        )
      let manifest: github.RepoManifest
      try {
        manifest = await github.analyzeConnection(conn)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : `could not read ${conn.repo}`)
      }
      const screen = manifest.screens.find((s) => (route !== undefined ? s.route === route : s.sourcePath === file))
      if (!screen)
        return err(
          'not_found',
          `no screen "${route ?? file}" in ${conn.repo} — call list_repo_screens for its routes and files`,
        )
      /* A code screen with no document yet lands nothing, so review mode does
         not gate the read that makes designing it possible. */
      if (screen.source !== 'static' && html === undefined) {
        const outcome = await importRepoScreen(canvas_id, conn, screen, actorFrom(agent_name))
        if (outcome.kind !== 'source' || !outcome.files.length)
          return err('upstream_failed', `no readable source for ${screen.sourcePath} in ${conn.repo}`)
        return structured({
          ok: true as const,
          screen: { route: screen.route, file: screen.sourcePath, kind: screen.kind, title: screen.title },
          frame: null,
          source: outcome.files,
          note: `This screen exists only as code (${screen.sourcePath}). Design a complete self-contained document from the source above, then call import_repo_screen again with the same route/file and html to land it with the import marker.`,
        })
      }
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      let outcome: RepoScreenImport
      try {
        outcome = await importRepoScreen(canvas_id, conn, screen, actorFrom(agent_name), html)
      } catch (e) {
        /* with html supplied only the document parse can fail; otherwise the
           repository read did */
        return err(
          html !== undefined ? 'invalid_input' : 'upstream_failed',
          e instanceof Error ? e.message : 'the import failed',
        )
      }
      if (outcome.kind !== 'frame') return err('upstream_failed', 'the screen produced no frame')
      return structured({
        ok: true as const,
        screen: { route: screen.route, file: screen.sourcePath, kind: screen.kind, title: screen.title },
        frame: frameSummary(outcome.frame),
      })
    },
  )

  tool(
    'ready_for_review',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Check a frame and record the result',
      description:
        'Run the full quality gate on a frame — token conformance, accessibility, layout and content checks at mobile, tablet and desktop widths — and RECORD the result against the exact document it checked. Call this on every frame you changed before you call the work done: the ship paths (open_pull_request, publish_canvas, create_release, restore_release) check the whole canvas and refuse a frame whose newest stored report is missing, stale or failing. Returns verdict "pass" or "fail" with the blocking findings and their selectors. Fix them and call it again; a report is only valid for the document it was made from, so any later edit means checking again.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        agent_name: agentName,
      },
      outputSchema: {
        verdict: z.enum(['pass', 'fail']),
        frame_id: z.string(),
        html_sha: z.string(),
        reviewed_at: z.number(),
        blocking: z.array(
          z.object({
            rule: z.string(),
            selector: z.string(),
            detail: z.string(),
            source: z.string(),
          }),
        ),
        failing_viewports: z.array(z.string()),
        summary: z.record(z.string(), z.number()),
      },
    },
    async ({ canvas_id, frame_id, agent_name }, extra) => {
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id) return noFrame(frame_id)
      const budget = takeRender(agent_name)
      if (budget) return budget
      await arrive(canvas_id, agent_name)
      await progress(extra, 0, `Checking “${f.name}” across viewports…`)
      const report = await reviewFrame(f, canvasFor(canvas_id)?.tokens)
      await progress(extra, 1, `Checked “${f.name}” across ${report.viewports.length} viewport(s).`)
      await persist.saveFrameReview(reviewToRecord(report, canvas_id, actorFrom(agent_name).name))
      return structured({
        verdict: report.verdict,
        frame_id: report.frame_id,
        html_sha: report.html_sha,
        reviewed_at: report.reviewed_at,
        blocking: report.blocking,
        failing_viewports: report.failing_viewports,
        summary: report.summary,
      })
    },
  )

  /* ---- releases: the frozen handoff artifact ---- */

  tool(
    'diff_release',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'What changed since a release',
      description:
        'Compare the live canvas against a frozen release: per frame, whether it changed and how — a pixel ratio when both versions render at the same size, a line diff when they do not — plus which frames were added or removed since. Use it to answer "what moved since the link I sent?" before writing the update note, or to check that a fix actually landed in the release you are about to ship.',
      inputSchema: {
        canvas_id: z.string(),
        release_id: z.string().describe('Release id from list_releases'),
        agent_name: agentName,
      },
      outputSchema: {
        release_name: z.string(),
        changed_count: z.number(),
        frames: z.array(
          z.object({
            frame_id: z.string(),
            name: z.string(),
            changed: z.boolean(),
            status: z.enum(['changed', 'unchanged', 'added', 'removed']),
            changed_ratio: z.number().optional(),
            text_added: z.number().optional(),
            text_removed: z.number().optional(),
          }),
        ),
      },
    },
    async ({ canvas_id, release_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      try {
        const diff = await diffRelease(canvas_id, release_id)
        return structured({
          release_name: diff.releaseName,
          changed_count: diff.changedCount,
          frames: diff.frames.map((frame) => ({
            frame_id: frame.frameId,
            name: frame.name,
            changed: frame.changed,
            status: frame.status,
            ...(frame.changedRatio === undefined ? {} : { changed_ratio: frame.changedRatio }),
            ...(frame.textAdded === undefined ? {} : { text_added: frame.textAdded }),
            ...(frame.textRemoved === undefined ? {} : { text_removed: frame.textRemoved }),
          })),
        })
      } catch (e) {
        /* diffRelease throws for a missing canvas, a missing release and a
           release of another canvas — all three are "you named something that
           is not here" from the caller's side */
        return err('not_found', e instanceof Error ? e.message : `no release ${release_id} on this canvas`)
      }
    },
  )

  tool(
    'create_release',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Freeze the canvas as a release',
      description:
        'Snapshot every frame as it is right now and return a public, permanent preview URL (/p/<canvas>/<release>). Frames keep changing afterwards, so a handoff needs a frozen artifact: send this URL to a client, attach it to a pull request (open_pull_request accepts release_id) or point a listing at it. The snapshot is stored whole — later edits, renames and deletions on the canvas never change it. Restoring it later is possible with restore_release. Every non-demo frame on the canvas must hold a CURRENT passing review, or this refuses with conflict naming the frames: run review_canvas to sweep them, or force: true to release an unverified canvas deliberately.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().max(120).optional().describe('A label for this release, e.g. "v2 — pricing review"'),
        force: z
          .boolean()
          .optional()
          .describe(
            'Release even though frames on this canvas are not currently verified — state that in your summary',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        release_id: z.string(),
        name: z.string(),
        url: z.string(),
        frames: z.array(z.object({ id: z.string(), name: z.string(), width: z.number(), height: z.number() })),
        created_at: z.number(),
      },
    },
    async ({ canvas_id, name, force, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const frames = c.frames.filter((f) => !f.demo)
      if (frames.length === 0) return err('not_found', 'this canvas has no frames to release')
      /* a release is a frozen artifact handed to a client, so it is a ship
         path: every frame in it has to be verified now, not whenever it was
         last looked at */
      const unverified = await shipRefusal(canvas_id, force)
      if (unverified) return unverified
      const actor = actorFrom(agent_name)
      const release: persist.CanvasRelease = {
        id: nanoid(10),
        canvasId: c.id,
        name: name?.trim() || `Release ${new Date().toISOString().slice(0, 10)}`,
        frames: frames.map((f) => ({
          id: f.id,
          name: f.name,
          width: f.width,
          height: f.height,
          x: f.x,
          y: f.y,
          html: f.html,
          z: f.z,
          locked: f.locked,
          hidden: f.hidden,
          rotation: f.rotation,
          opacity: f.opacity,
          ...(f.pageId ? { pageId: f.pageId } : {}),
        })),
        ...(c.tokens ? { tokens: c.tokens } : {}),
        createdAt: Date.now(),
        createdBy: actor.name,
      }
      await persist.saveRelease(release)
      actions.logActivity(c.id, actor, `released “${release.name}” (${release.frames.length} frames)`)
      return structured({
        release_id: release.id,
        name: release.name,
        url: `${PUBLIC_ORIGIN}/p/${c.id}/${release.id}`,
        frames: release.frames.map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height })),
        created_at: release.createdAt,
      })
    },
  )

  tool(
    'list_releases',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'List the canvas’s releases',
      description:
        'Every frozen release of this canvas, newest first, with the public preview URL for each. Use it to find a release id for restore_release or to send the current one to a human.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
      outputSchema: {
        releases: z.array(
          z.object({
            release_id: z.string(),
            name: z.string(),
            url: z.string(),
            frames: z.number(),
            created_at: z.number(),
            created_by: z.string(),
          }),
        ),
      },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      if (agent_name) await arrive(canvas_id, agent_name)
      const releases = await persist.listReleases(canvas_id)
      return structured({
        releases: releases.map((release) => ({
          release_id: release.id,
          name: release.name,
          url: `${PUBLIC_ORIGIN}/p/${canvas_id}/${release.id}`,
          frames: release.frames.length,
          created_at: release.createdAt,
          created_by: release.createdBy,
        })),
      })
    },
  )

  tool(
    'rename_release',
    {
      title: 'Rename a release',
      description:
        'Relabel a frozen release (owner-only) — the label a handoff URL is listed under. Only the name moves: the snapshot, its frames and its tokens stay exactly as stored, so a link already sent out keeps serving the same design.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        release_id: z.string().describe('Release id from list_releases'),
        name: z.string().min(1).max(80).describe('New label, e.g. "v2 — pricing review"'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), name: z.string() },
    },
    async ({ canvas_id, release_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'rename a release')
      if (denied) return denied
      const release = await persist.getRelease(release_id)
      if (!release || release.canvasId !== canvas_id) return err('not_found', `no release ${release_id} on this canvas`)
      const trimmed = name.trim()
      if (!trimmed) return err('invalid_input', 'the release name cannot be empty')
      await persist.renameRelease(release_id, trimmed)
      actions.logActivity(canvas_id, actorFrom(agent_name), `renamed release “${release.name}” to “${trimmed}”`)
      return structured({ ok: true as const, name: trimmed })
    },
  )

  tool(
    'delete_release',
    {
      title: 'Delete a release',
      description:
        'Permanently delete a frozen release and its snapshot (owner-only, confirm: true). A release the gallery listing is pinned to cannot be deleted — unpublish_canvas first.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        canvas_id: z.string(),
        release_id: z.string().describe('Release id from list_releases'),
        confirm: z.literal(true).describe('Must be true — the snapshot cannot be recovered'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), deleted: z.string() },
    },
    async ({ canvas_id, release_id, confirm, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'delete a release')
      if (denied) return denied
      if (confirm !== true)
        return err('invalid_input', 'deleting a release is irreversible — pass confirm: true to go ahead')
      const release = await persist.getRelease(release_id)
      if (!release || release.canvasId !== canvas_id) return err('not_found', `no release ${release_id} on this canvas`)
      /* the listing's preview and the copies it hands out come from the pinned
         release, so deleting it would leave a gallery entry with nothing to
         show. Refuse and name the way out rather than silently unpinning. */
      if (c.publishedReleaseId === release_id)
        return err(
          'conflict',
          `release “${release.name}” is the snapshot this canvas is listed with in the gallery — call unpublish_canvas first (or re-publish without release_id)`,
          { release_id, published: true },
        )
      await persist.deleteRelease(release_id)
      actions.logActivity(canvas_id, actorFrom(agent_name), `deleted release “${release.name}”`)
      return structured({ ok: true as const, deleted: release.name })
    },
  )

  tool(
    'restore_release',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Put a release’s frames back on the canvas',
      description:
        'Write a release’s frames back onto the live canvas, as ordinary edits: each frame is written through the same path as any other edit, so the restore is logged, streamed to the room and reversible frame by frame with get_frame_history + revert_frame. Frames that no longer exist are recreated; frames added after the release are left alone. Every non-demo frame on the canvas must hold a CURRENT passing review, or this refuses with conflict naming the frames: run review_canvas to sweep them, or force: true to restore anyway.',
      inputSchema: {
        canvas_id: z.string(),
        release_id: z.string(),
        force: z
          .boolean()
          .optional()
          .describe(
            'Restore even though frames on this canvas are not currently verified — state that in your summary',
          ),
        agent_name: agentName,
      },
      outputSchema: {
        restored: z.array(z.object({ frame_id: z.string(), name: z.string(), created: z.boolean() })),
        skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
      },
    },
    async ({ canvas_id, release_id, force, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      /* restoring rewrites the live canvas from a snapshot, and the frames that
         come back are whatever was frozen — so the canvas has to be verified
         before it is moved under a caller who is about to ship it */
      const unverified = await shipRefusal(canvas_id, force)
      if (unverified) return unverified
      const release = await persist.getRelease(release_id)
      if (!release || release.canvasId !== canvas_id) return err('not_found', `no release ${release_id} on this canvas`)
      const actor = actorFrom(agent_name)
      const restored: { frame_id: string; name: string; created: boolean }[] = []
      const skipped: { name: string; reason: string }[] = []
      for (const [i, snapshot] of release.frames.entries()) {
        const live = store.getFrame(snapshot.id)
        if (!live) {
          /* through actions, like every other creation: the room has to see
             the frame appear, and review mode has to be able to refuse it.
             The snapshot's stacking, lock, visibility, rotation and opacity
             ride along, so a frame that was frozen hidden or rotated comes
             back that way; a release predating those fields stacks by its own
             array order. */
          let created: Frame | undefined
          try {
            created = actions.createFrame(
              canvas_id,
              {
                name: snapshot.name,
                html: snapshot.html,
                width: snapshot.width,
                height: snapshot.height,
                ...(snapshot.pageId ? { pageId: snapshot.pageId } : {}),
                z: snapshot.z ?? i,
                locked: snapshot.locked ?? false,
                hidden: snapshot.hidden ?? false,
                rotation: snapshot.rotation ?? 0,
                opacity: snapshot.opacity ?? 1,
              },
              actor,
            )
          } catch (e) {
            const conflict = lockConflict(e)
            if (conflict) return conflict
            skipped.push({ name: snapshot.name, reason: e instanceof Error ? e.message : 'the restore was refused' })
            continue
          }
          if (!created) {
            skipped.push({ name: snapshot.name, reason: 'could not be recreated' })
            continue
          }
          restored.push({ frame_id: created.id, name: created.name, created: true })
          continue
        }
        /* a missing field leaves the live frame as it is rather than resetting
           it to the column default — a release made before the frame model
           carried these says nothing about them */
        const next = {
          html: snapshot.html,
          name: snapshot.name,
          width: snapshot.width,
          height: snapshot.height,
          z: snapshot.z ?? live.z,
          locked: snapshot.locked ?? live.locked,
          hidden: snapshot.hidden ?? live.hidden,
          rotation: snapshot.rotation ?? live.rotation,
          opacity: snapshot.opacity ?? live.opacity,
        }
        if ((Object.keys(next) as (keyof typeof next)[]).every((k) => live[k] === next[k])) {
          skipped.push({ name: snapshot.name, reason: 'already matches the release' })
          continue
        }
        try {
          actions.updateFrame(snapshot.id, next, actor)
          restored.push({ frame_id: snapshot.id, name: snapshot.name, created: false })
        } catch (e) {
          const conflict = lockConflict(e)
          if (conflict) return conflict
          skipped.push({ name: snapshot.name, reason: e instanceof Error ? e.message : 'the restore was refused' })
        }
      }
      if (restored.length === 0)
        return err('conflict', skipped[0]?.reason ?? 'every frame already matches this release', { restored, skipped })
      actions.logActivity(canvas_id, actor, `restored “${release.name}” (${restored.length} frames)`)
      return structured({ restored, skipped })
    },
  )

  /* ---- publishing ---- */

  tool(
    'publish_canvas',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'List the canvas in the community gallery',
      description:
        'Publish this canvas to the Doop community gallery with a short description and a shelf. Owner-only. The gallery hands out previews and copies — never the source canvas or a seat in its room. Pass release_id to publish the frozen snapshot instead of the live frames. Every non-demo frame on the canvas must hold a CURRENT passing review, or this refuses with conflict naming the frames: run review_canvas to sweep them, or force: true to list an unverified canvas deliberately.',
      inputSchema: {
        canvas_id: z.string(),
        description: z.string().max(280).optional(),
        category: z.enum(COMMUNITY_CATEGORIES).describe('gallery shelf the canvas is listed under'),
        release_id: z.string().optional().describe('Publish this release rather than the live canvas'),
        force: z
          .boolean()
          .optional()
          .describe(
            'Publish even though frames on this canvas are not currently verified — state that in your summary',
          ),
        agent_name: agentName,
      },
      outputSchema: { published_at: z.number(), description: z.string().optional(), category: z.string() },
    },
    async ({ canvas_id, description, category, release_id, force, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      /* a listing hands the design to strangers, so it is a ship path: the
         canvas it points at has to be verified end to end first */
      const unverified = await shipRefusal(canvas_id, force)
      if (unverified) return unverified
      const release = release_id ? await persist.getRelease(release_id) : undefined
      if (release_id && (!release || release.canvasId !== canvas_id))
        return err('not_found', `no release ${release_id} on this canvas`)
      const listing = parseListing({ description, category })
      if (typeof listing === 'string') return err('invalid_input', listing)
      const result = publishCanvas(
        c,
        listing,
        { id: ownerId, name: actorFrom(agent_name).name },
        release ? { id: release.id, frames: persist.releaseFrames(release) } : undefined,
      )
      if (!result.ok) return err(result.status === 403 ? 'forbidden' : 'invalid_input', result.error)
      return structured({
        published_at: result.canvas.publishedAt ?? Date.now(),
        ...(result.canvas.description ? { description: result.canvas.description } : {}),
        category: result.canvas.category ?? 'other',
      })
    },
  )

  tool(
    'unpublish_canvas',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Take the canvas out of the gallery',
      description: 'Remove this canvas from the community gallery. Owner-only.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
      outputSchema: { ok: z.literal(true) },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const result = unpublishCanvas(c, { id: ownerId, name: actorFrom(agent_name).name })
      if (!result.ok) return err(result.status === 403 ? 'forbidden' : 'not_found', result.error)
      return structured({ ok: true as const })
    },
  )

  /* ---- canvas lifecycle ----
     Agents could create canvases but never rename, configure, copy or remove
     them, so anything past "make a new one" needed a human in the web UI.
     These are the same operations the REST routes perform, with the same
     authorization: the policy toggles and the destructive pair are the owner's
     alone, and a copy may only be taken by someone with durable access (the
     owner or an invited member) — a share-link visitor must not be able to
     lift a canvas into their own account. */

  tool(
    'rename_canvas',
    {
      title: 'Rename a canvas',
      description:
        'Rename this canvas (owner-only). The new name is what list_canvases, the dashboard and the share sheet show; the canvas id and URL do not change.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().min(1).max(80).describe('New canvas name'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), name: z.string() },
    },
    async ({ canvas_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'rename a canvas')
      if (denied) return denied
      const trimmed = name.trim()
      if (!trimmed) return err('invalid_input', 'the canvas name cannot be empty')
      const renamed = actions.renameCanvas(canvas_id, trimmed, actorFrom(agent_name))
      if (!renamed) return noCanvas(canvas_id)
      return structured({ ok: true as const, name: renamed.name })
    },
  )

  tool(
    'duplicate_canvas',
    {
      title: 'Copy a canvas into your account',
      description:
        'Copy this canvas — frames, pages, guides and references — into a new private canvas owned by you. Owner and invited members only: a share-link visitor cannot lift a canvas.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().min(1).max(200).optional().describe('Name for the copy. Defaults to "<source> copy"'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), canvas: z.object(canvasListItemShape) },
    },
    async ({ canvas_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      /* durable access, not plain access: the REST duplicate route uses
         hasDurableCanvasAccess for exactly this reason — a copy outlives the
         visit, so a link-edit visitor must not be able to take one */
      if (!ownerId || !hasDurableCanvasAccess(ownerId, c))
        return err('forbidden', 'only the canvas owner or an invited member can copy a canvas', {
          hint: 'ask the owner to invite you, or design into your own canvas instead',
        })
      const copy = await store.duplicateCanvas(
        c.id,
        ownerId,
        owner ?? ownerId,
        name?.trim() ? { name: name.trim() } : {},
      )
      if (!copy) return noCanvas(canvas_id)
      const previewFrame = copy.frames.length
        ? copy.frames.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
        : undefined
      return structured({
        ok: true as const,
        canvas: {
          id: copy.id,
          name: copy.name,
          ownerId: copy.ownerId,
          createdAt: copy.createdAt,
          updatedAt: copy.updatedAt,
          frameCount: copy.frames.length,
          ...(previewFrame ? { previewFrameId: previewFrame.id } : {}),
          guidelinesCount: copy.guidelines?.length ?? 0,
        },
      })
    },
  )

  tool(
    'set_review_mode',
    {
      title: 'Require approval for agent writes',
      description:
        'Turn review mode on or off (owner-only). While it is on, agent frame writes do not land: they become proposals a human accepts, and direct writes are refused. Turn it off to let agents write canonically again.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        on: z.boolean().describe('true = agent writes need human approval'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), review_mode: z.boolean() },
    },
    async ({ canvas_id, on, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'change review mode')
      if (denied) return denied
      actions.setCanvasReviewMode(canvas_id, on, actorFrom(agent_name))
      return structured({ ok: true as const, review_mode: on })
    },
  )

  tool(
    'set_link_access',
    {
      title: 'Set what the share link grants',
      description:
        'Set the canvas\'s share-link policy (owner-only). "view" lets anyone holding the link read the canvas, "comment" adds element notes on top of read-only, "edit" lets them open and edit it, and "none" makes it private to the owner and invited members. Invited members keep their own access either way.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        mode: z
          .enum(['none', 'view', 'comment', 'edit'])
          .describe(
            '"view" = read-only for anyone with the link, "comment" = read-only plus element notes, "edit" = they collaborate, "none" = private',
          ),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), link_access: z.enum(['none', 'view', 'comment', 'edit']) },
    },
    async ({ canvas_id, mode, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'change link access')
      if (denied) return denied
      if (!store.setLink(canvas_id, { access: mode })) return noCanvas(canvas_id)
      /* no canvas:linkAccess wire message exists, so the activity feed is where
         this lands for everyone watching — a policy change is worth a line */
      actions.logActivity(
        canvas_id,
        actorFrom(agent_name),
        mode === 'none'
          ? 'turned off the share link'
          : `set the share link so anyone with it can ${mode === 'edit' ? 'edit' : mode === 'comment' ? 'read and comment' : 'read'}`,
      )
      return structured({ ok: true as const, link_access: mode })
    },
  )

  tool(
    'delete_canvas',
    {
      title: 'Delete a canvas',
      description:
        'Delete this canvas with its frames, pages, guides, references and comments (owner-only, confirm: true). Nothing is destroyed: the canvas leaves every listing and waits in the owner’s trash, where the owner can restore it until the retention window passes (30 days by default). Take a release first (create_release) if the design may be wanted back sooner: a trashed canvas is restorable by its owner in the web UI, and no MCP tool brings one back — restore_frame and restore_page recover frames and pages, not a whole canvas.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        canvas_id: z.string(),
        confirm: z.literal(true).describe('Must be true — the canvas moves to the trash instead of being destroyed'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), deleted: z.string() },
    },
    async ({ canvas_id, confirm, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const denied = ownerOnly(c, 'delete a canvas')
      if (denied) return denied
      if (confirm !== true)
        return err(
          'invalid_input',
          'deleting a canvas empties it out of every listing — pass confirm: true to go ahead',
        )
      const name = c.name
      if (!actions.deleteCanvas(canvas_id)) return noCanvas(canvas_id)
      return structured({ ok: true as const, deleted: name })
    },
  )

  /* ---- recovery: the canvas's trash, and its own history ----
     Deleting is not the end of anything here — a frame, a page or a component
     waits in the canvas's trash until the retention window passes, and the
     whole canvas is checkpointed as it is edited — but neither was reachable
     from MCP, so an agent that deleted a frame by mistake, or that wanted the
     canvas as it stood an hour ago, had to ask a human. These are the same
     operations the Trash and History tabs perform, on the same store and
     through the same actions: a restore versions, logs and broadcasts like any
     other edit, and the frame locks every other write respects are respected
     here too. */

  tool(
    'list_trash',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'What this canvas has in the trash',
      description:
        'What a delete left behind on this canvas, newest first: the frames, pages and components waiting in the trash, each with the id that restores it, the page a frame would come back on, and when it went. Deleting is reversible here — delete_frame, delete_page and delete_component move work to the trash rather than destroy it — so this is how you find what you (or a human) removed by mistake, and how you get the id restore_frame or restore_page wants. The trash is the canvas owner’s view, exactly like the web UI’s: a member connection sees an empty list and a note saying so.',
      inputSchema: {
        canvas_id: z.string(),
        kind: z
          .enum(['frames', 'pages', 'components'])
          .optional()
          .describe('Only this kind of deleted thing; omit for all three'),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Offset into the newest-first list — a previous call’s next_cursor'),
        limit: z.number().int().min(1).max(100).default(50),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            kind: z.enum(['frames', 'pages', 'components']),
            canvas_id: z.string(),
            deleted_at: z.string(),
            page_id: z.string().optional().describe('The page a trashed frame would come back on'),
            frame_count: z.number().optional().describe('Frames a page restore brings back with it'),
          }),
        ),
        next_cursor: z.number().optional(),
        note: z.string().optional(),
      },
    },
    async ({ canvas_id, kind, cursor, limit, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      /* The store's trash listing is owner-scoped (the REST /api/trash route is
         its only other caller), so this is the canvas owner's view: a member
         connection reads an empty list rather than someone else's deleted work. */
      const ownsCanvas = ownerId !== undefined && c.ownerId === ownerId
      const trash = ownsCanvas && ownerId ? store.listTrash(ownerId) : undefined
      const rows: {
        id: string
        name: string
        kind: 'frames' | 'pages' | 'components'
        deletedAt: number
        pageId?: string
        frameCount?: number
      }[] = []
      for (const entry of trash?.frames ?? []) {
        if (entry.canvasId !== canvas_id) continue
        /* the page a frame would come back on: the store re-homes it when its
           page is gone, so this is where the restore will actually put it */
        const pageId = store.getTrashedFrame(entry.id)?.frame.pageId
        rows.push({
          id: entry.id,
          name: entry.name,
          kind: 'frames',
          deletedAt: entry.deletedAt,
          ...(pageId ? { pageId } : {}),
        })
      }
      for (const entry of trash?.pages ?? []) {
        if (entry.canvasId !== canvas_id) continue
        rows.push({
          id: entry.id,
          name: entry.name,
          kind: 'pages',
          deletedAt: entry.deletedAt,
          frameCount: store.listTrashedFramesOnPage(entry.id).length,
        })
      }
      for (const entry of trash?.components ?? []) {
        if (entry.canvasId !== canvas_id) continue
        rows.push({ id: entry.id, name: entry.name, kind: 'components', deletedAt: entry.deletedAt })
      }
      /* one list, newest deletion first — the three maps are each sorted on
         their own, and the page wants them merged */
      rows.sort((a, b) => b.deletedAt - a.deletedAt)
      const wanted = kind ? rows.filter((row) => row.kind === kind) : rows
      const start = Math.min(cursor ?? 0, wanted.length)
      const items = wanted.slice(start, start + limit)
      const next = start + items.length
      return structured({
        items: items.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          canvas_id,
          deleted_at: new Date(row.deletedAt).toISOString(),
          ...(row.pageId ? { page_id: row.pageId } : {}),
          ...(row.frameCount !== undefined ? { frame_count: row.frameCount } : {}),
        })),
        ...(next < wanted.length ? { next_cursor: next } : {}),
        ...(ownsCanvas
          ? {}
          : {
              note: 'the trash belongs to the canvas owner, and this connection is not that account — nothing is listed here. Ask the owner, or restore by id with restore_frame / restore_page.',
            }),
      })
    },
  )

  tool(
    'restore_frame',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Take a frame back out of the trash',
      description:
        'Put a deleted frame back on its canvas, with the id it always had — that is what makes its comments, its history and every agent reference to it still point at it. The restore is an ordinary edit: the room watches the frame appear, it lands in the activity feed, and it is written through the same durable path as any other write, so it becomes a version like any other change. Get the id from list_trash. A frame another agent holds is refused with conflict naming the holder; pass takeover: true to take it over deliberately.',
      inputSchema: {
        id: z.string().describe('The trashed frame’s id, from list_trash'),
        canvas_id: z.string().optional().describe('The canvas the frame sits on; defaults to the session’s canvas'),
        takeover: z.boolean().optional().describe('Restore even though another agent holds the frame lock'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.object(frameSummaryShape) },
    },
    async ({ id, canvas_id, takeover, agent_name }) => {
      /* the id is looked up in the trash, not in the canvas: a trashed frame is
         out of the frame index, which is also why the canvas has to come from
         the entry rather than from the caller */
      const found = store.getTrashedFrame(id)
      const canvas = found ? canvasFor(found.frame.canvasId) : undefined
      if (!canvas) return err('not_found', `no trashed frame with id ${id} accessible to this account`)
      if (canvas_id !== undefined && canvas_id !== canvas.id)
        return err('not_found', `no trashed frame with id ${id} on canvas ${canvas_id}`)
      /* The wrapper's authority check reads the canvas out of the arguments,
         and a call that named only the id gave it none to read — so the same
         refusal runs here, now that the canvas is known. */
      const denied = intentRefusal('restore_frame', 'edit', { canvas_id: canvas.id })
      if (denied) return denied
      const actor = actorFrom(agent_name)
      await arrive(canvas.id, agent_name)
      const holder = frameLocks.heldBy(id, actor.name)
      if (holder && !takeover) {
        const conflict = lockConflict(new frameLocks.FrameLockedError(holder))
        if (conflict) return conflict
      }
      takeOver(id, canvas.id, actor, takeover)
      const frame = actions.restoreFrame(id, actor)
      if (!frame) return err('not_found', `no trashed frame with id ${id}`)
      return structured({ ok: true as const, frame: frameSummary(frame) })
    },
  )

  tool(
    'restore_page',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Take a page and its frames back out of the trash',
      description:
        'Put a deleted page back on its canvas, in the slot it held, and bring the frames that went down with it back too — a page delete is one action ("remove the page and every frame on it"), so its inverse is one action as well, and restoring the page alone would leave an empty page with its frames waiting in the trash one by one. The room hears about the page list and about each frame that returns, and the restore lands in the activity feed. Get the id from list_trash. A frame another agent holds is refused with conflict naming the holder; pass takeover: true to take it over deliberately.',
      inputSchema: {
        id: z.string().describe('The trashed page’s id, from list_trash'),
        canvas_id: z.string().optional().describe('The canvas the page sits on; defaults to the session’s canvas'),
        takeover: z.boolean().optional().describe('Restore even though another agent holds a frame lock'),
        agent_name: agentName,
      },
      outputSchema: {
        ok: z.literal(true),
        page_id: z.string(),
        name: z.string(),
        frames_restored: z.number(),
      },
    },
    async ({ id, canvas_id, takeover, agent_name }) => {
      const found = store.getTrashedPage(id)
      const canvas = found ? canvasFor(found.page.canvasId) : undefined
      if (!canvas) return err('not_found', `no trashed page with id ${id} accessible to this account`)
      if (canvas_id !== undefined && canvas_id !== canvas.id)
        return err('not_found', `no trashed page with id ${id} on canvas ${canvas_id}`)
      /* the same re-check restore_frame makes: a page is not in the canvas's
         page list while it is trashed, so the arguments alone told the wrapper
         nothing about which canvas this touches */
      const denied = intentRefusal('restore_page', 'edit', { canvas_id: canvas.id })
      if (denied) return denied
      const actor = actorFrom(agent_name)
      await arrive(canvas.id, agent_name)
      /* the page itself is nobody's to hold: what a lock can refuse is a frame
         the restore would put back under the agent working on that id */
      const frames = store.listTrashedFramesOnPage(id)
      const holder = frames.map((f) => frameLocks.heldBy(f.id, actor.name)).find((held) => held !== undefined)
      if (holder && !takeover) {
        const conflict = lockConflict(new frameLocks.FrameLockedError(holder))
        if (conflict) return conflict
      }
      if (takeover) for (const f of frames) takeOver(f.id, canvas.id, actor, true)
      const page = actions.restorePage(id, actor)
      if (!page) return err('not_found', `no trashed page with id ${id}`)
      return structured({
        ok: true as const,
        page_id: page.id,
        name: page.name,
        frames_restored: frames.length,
      })
    },
  )

  tool(
    'create_canvas_version',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Save a checkpoint of the whole canvas',
      description:
        'Freeze the canvas as it stands — every frame’s HTML and geometry, its stacking and the design tokens — into the canvas’s history, the manual "save version" of the History tab. Take one before a change you might want to undo as a whole (a restyle, a re-import, a redesign across several frames), then put it back with restore_canvas_version. The canvas also checkpoints itself: every 25 durable frame writes, before a delete and before a restore, so a version usually exists for a mistake already — list_canvas_versions says which. `label` is a note for the humans reading the activity feed; the checkpoint’s own label stays "manual".',
      inputSchema: {
        canvas_id: z.string(),
        label: z
          .string()
          .max(80)
          .optional()
          .describe('A short note for this checkpoint, written onto the canvas activity feed next to it'),
        agent_name: agentName,
      },
      outputSchema: {
        version_id: z.string(),
        label: z.string().describe('Why the checkpoint exists: manual, auto, delete or restore'),
        at: z.string().describe('When it was taken, ISO'),
        frame_count: z.number(),
      },
    },
    async ({ canvas_id, label, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      const summary = actions.snapshotCanvas(canvas_id, 'manual', actor.name)
      if (!summary) return noCanvas(canvas_id)
      /* the same line the History tab's own save writes, so a human watching
         the canvas sees the checkpoint either way — and the caller's note
         rides it, which is the only place a label can live: a version row
         records why it was taken, not what someone called it */
      const note = label?.trim()
      actions.logActivity(
        canvas_id,
        actor,
        `saved a version of “${c.name}” (${summary.frameCount} frames)${note ? ` — ${note}` : ''}`,
      )
      return structured({
        version_id: summary.id,
        label: summary.cause,
        at: new Date(summary.createdAt).toISOString(),
        frame_count: summary.frameCount,
      })
    },
  )

  tool(
    'list_canvas_versions',
    {
      annotations: { readOnlyHint: true, destructiveHint: false },
      title: 'The canvas’s checkpoints, newest first',
      description:
        'The whole canvas’s history: every checkpoint it holds, newest first, with the id restore_canvas_version takes, why it was taken (`label`: a manual save, the automatic cadence, before a delete, or the state a restore replaced), when and by whom, and how many frames it froze. Read it before rolling the canvas back — and to check whether a version already exists for the mistake you are about to fix, rather than saving one. Page with cursor: pass the previous call’s next_cursor.',
      inputSchema: {
        canvas_id: z.string(),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Offset into the newest-first list — a previous call’s next_cursor'),
        limit: z.number().int().min(1).max(50).default(20),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        versions: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            at: z.string(),
            by: z.string(),
            frame_count: z.number(),
          }),
        ),
        next_cursor: z.number().optional(),
      },
    },
    async ({ canvas_id, cursor, limit, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      /* the store's ring is the read path the History tab uses — the same
         newest-first, capped list the version route serves */
      const all = store.getCanvasVersions(canvas_id)
      const start = Math.min(cursor ?? 0, all.length)
      const versions = all.slice(start, start + limit)
      const next = start + versions.length
      return structured({
        versions: versions.map((v) => ({
          id: v.id,
          label: v.cause,
          at: new Date(v.createdAt).toISOString(),
          by: v.createdBy,
          frame_count: v.frameCount,
        })),
        ...(next < all.length ? { next_cursor: next } : {}),
      })
    },
  )

  tool(
    'restore_canvas_version',
    {
      annotations: { readOnlyHint: false, destructiveHint: true },
      title: 'Roll the canvas back to a checkpoint',
      description:
        'Put a checkpoint back on the live canvas, as ordinary writes: frames the snapshot holds come back with their ids (one missing since is recreated under the same id, so its comments and history still point at it), frames added after it are left alone, and the state it replaced is checkpointed itself — a rollback is never a dead end. Every frame meets the gates an ordinary write meets — a frame another agent holds, one the canvas owner locked, or one the canvas’s review policy gates — and what they refuse is reported in `skipped` with the reason while the rest of the canvas rolls back. Get the id from list_canvas_versions.',
      inputSchema: {
        canvas_id: z.string(),
        version_id: z.string().describe('Checkpoint id from list_canvas_versions'),
        agent_name: agentName,
      },
      outputSchema: {
        restored: z.number().describe('Frames the rollback wrote or brought back'),
        created: z.number().describe('How many of those were recreated rather than updated'),
        skipped: z
          .array(z.object({ frame_id: z.string(), reason: z.string() }))
          .describe('Frames the gates refused, each with the refusal — they are left exactly as they are'),
      },
    },
    async ({ canvas_id, version_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      await arrive(canvas_id, agent_name)
      const result = await actions.restoreCanvasVersion(canvas_id, version_id, actorFrom(agent_name))
      if (!result) return err('not_found', `no canvas version with id ${version_id} on this canvas`)
      return structured({ restored: result.restored, created: result.created, skipped: result.skipped })
    },
  )

  /* ---- run timeline: what every agent did, in one place ---- */

  /* The run timeline ring holds 500 events per canvas; one read of the whole
     ring is what makes the cursor a plain offset, with no server-side state. */
  const RUN_EVENT_SCAN = 500

  tool(
    'get_run_events',
    {
      title: 'Read a run’s timeline',
      description:
        'The run timeline, newest first: one entry per step an agent took on this canvas — its tool calls (kind "tool", each with the tool `name`, the outcome `ok`, the duration `ms` and a summary, plus the frame it touched when it wrote one), the status lines it reported (kind "status", e.g. "judge reviewing attempt 2/3"), the failures (kind "error") and the stop that ended a run (kind "stop"). A tool step also carries `args`, the arguments it was called with (a long one is truncated) and the identity behind it (`actor_kind`, `agent_id`). Only "tool" steps carry a `name`; the others carry a `summary` alone. A step that wrote a frame also carries the frame\'s version before and after it (beforeVersionId / afterVersionId) — pass that run to revert_run to undo the whole run in one call. Filter to one run with run_id, or read the canvas’s whole recent history. Page with cursor: pass the previous next_offset back as cursor.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        run_id: z.string().optional().describe('Only this run’s events'),
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Offset into the newest-first list — a previous call’s next_offset'),
        limit: z.number().int().min(1).max(200).default(100),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, run_id, cursor, limit, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (agent_name) await arrive(canvas_id, agent_name)
      const all = runLog.getRunEvents(canvas_id, { ...(run_id ? { runId: run_id } : {}), limit: RUN_EVENT_SCAN })
      const start = Math.min(cursor ?? 0, all.length)
      const events = all.slice(start, start + limit)
      const next = start + events.length
      return structured({
        events: events.map((event) => ({
          id: event.id,
          runId: event.runId,
          agentName: event.agentName,
          at: event.at,
          kind: event.kind,
          ...(event.name ? { name: event.name } : {}),
          ...(event.ok !== undefined ? { ok: event.ok } : {}),
          ...(event.ms !== undefined ? { ms: event.ms } : {}),
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.frameId ? { frame_id: event.frameId } : {}),
          ...(event.beforeVersionId ? { before_version_id: event.beforeVersionId } : {}),
          ...(event.afterVersionId ? { after_version_id: event.afterVersionId } : {}),
          /* what the step was called with, and who made it: the detail the Run
             tab's pane shows. `args` is the tool call's own argument JSON, cut
             at the write boundary — a long document arrives truncated. */
          ...(event.args ? { args: event.args } : {}),
          ...(event.actorKind ? { actor_kind: event.actorKind } : {}),
          ...(event.agentId ? { agent_id: event.agentId } : {}),
        })),
        total_shown: events.length,
        has_more: next < all.length,
        ...(next < all.length ? { next_offset: next } : {}),
      })
    },
  )

  tool(
    'post_status',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      title: 'Say what you are doing, on the run timeline',
      description:
        'Write one line onto the run timeline the human watches in the Run tab — "step 3/7 rebuilding the hero", "waiting on the human", "reading the guide". Use it when you are about to spend a while on something that will not show up as tool calls (planning, a long read, a slow build), so a human can tell an agent that is thinking from one that is stuck; the tool calls around the line are still the record of what you actually did. It lands in YOUR run — the same timeline get_run_events reads back — unless you name another run_id on this canvas. One line, at most 200 characters, and it is not a message: use send_message to talk to the humans.',
      inputSchema: {
        canvas_id: z.string(),
        text: z.string().min(1).max(200).describe('One line: what you are doing, or what you are waiting on'),
        step: z.number().int().min(1).optional().describe('Step number, for "3/7"'),
        of: z.number().int().min(1).optional().describe('Total steps — pass it with `step`'),
        run_id: z.string().optional().describe("The run to report into; defaults to this connection's own run"),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: { recorded: z.literal(true), run_id: z.string(), at: z.number() },
    },
    async ({ canvas_id, text: line, step, of, run_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if ((step === undefined) !== (of === undefined))
        return err(
          'invalid_input',
          'pass both step and of (step: 3, of: 7) or neither — a step without a total reads as "3/?"',
        )
      await arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      const counter = step === undefined ? '' : `${step}/${of} `
      /* the session's own run id is what this call's own run-event row carries,
         so the status lands in the run the human is watching */
      const event = runLog.recordStatus(canvas_id, run_id ?? session.runId, actor.name, 'status', `${counter}${line}`)
      return structured({ recorded: true as const, run_id: event.runId, at: event.at })
    },
  )

  /* ---- design workflow: the implementer + judge pipeline ---- */

  /* The loop runs here, server-side, on the operator's one provider. Every
     attempt lands through actions.ts, so a human in the room watches the
     design build and rebuild itself while this call is still open; nothing
     streams back to the caller until the judge passes or the budget is spent.
     The verdict is pinned to the frame by the engine, and the run's one
     timeline entry is the wrapper's own record of this call — which is why
     this handler adds neither. */
  tool(
    'run_design_workflow',
    {
      annotations: { readOnlyHint: false, destructiveHint: false },
      title: 'Design a frame with implementer + judge models',
      description:
        "Design a frame from a brief with a server-side implementer + judge pipeline: an implementer model writes the frame HTML and streams it live onto the canvas, a deterministic review plus a judge model critique it, and the implementer iterates on the judge's issues until the judge passes or the attempts run out. Needs DESIGN_LLM_BASE_URL on the server and a model pair picked in Settings. Long-running — the call blocks until the workflow finishes (up to ~30 min), and each attempt replaces the frame HTML.",
      inputSchema: {
        canvas_id: z.string(),
        brief: z
          .string()
          .min(1)
          .max(4000)
          .describe('The design brief: what the implementer writes from and the judge measures against'),
        frame_name: z
          .string()
          .max(200)
          .optional()
          .describe(
            `Title for the new frame, which is created at ${FRAME_WIDTH} × ${FRAME_HEIGHT}. Defaults to "Design workflow"`,
          ),
        frame_id: z
          .string()
          .optional()
          .describe(
            'Redesign this existing frame instead of creating one — it must be on canvas_id, and its own size is the artboard the design is written and reviewed against',
          ),
        max_attempts: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('Implementer/judge rounds before giving up (1–5, default 3)'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, brief, frame_name, frame_id, max_attempts, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      /* The engine writes every attempt through actions.ts, so a canvas whose
         policy would turn those writes into proposals would spend two model
         calls per attempt on nothing. This is the broader gate than review
         mode: reviewPolicy 'destructive' with any of these tools listed in
         approvalTools refuses them too. */
      if (actions.agentWritesGated(canvas_id, ['create_frame', 'update_frame', 'append_frame_html']))
        return err(
          'unsupported',
          'this canvas gates agent writes — turn review mode off (or clear the approval list) before running the design workflow, or the implementer’s writes would land as proposals',
        )
      if (!designLlmConfigured())
        return err(
          'unsupported',
          'the design workflow is not configured on this server — set DESIGN_LLM_BASE_URL and pick models in Settings',
        )
      /* the model pair is per user, so there is no anonymous answer to "which
         models": the run would have to guess whose Settings to read */
      if (!ownerId)
        return err('forbidden', 'the design workflow needs a signed-in account — connect MCP with your doop login')
      const prefs = await getDesignWorkflowPrefs(ownerId)
      if (!prefs.implementerModel || !prefs.judgeModel)
        return err(
          'unsupported',
          'no design workflow models are picked — choose an implementer and a judge in Settings',
        )
      /* A redesign target is only meaningful on the canvas the caller named:
         the engine drives actions.ts with THAT canvas's tokens and broadcasts
         to its viewers, so a frame from another canvas would be judged against
         the wrong design system. */
      if (frame_id && frameFor(frame_id)?.canvasId !== canvas_id)
        return err('invalid_input', `frame ${frame_id} is not on canvas ${canvas_id}`)
      const actor = actorFrom(agent_name)
      try {
        const result = await runDesignWorkflow({
          canvasId: canvas_id,
          brief,
          frameName: (frame_name ?? '').trim() || 'Design workflow',
          implementerModel: prefs.implementerModel,
          judgeModel: prefs.judgeModel,
          actor,
          ...(max_attempts ? { maxAttempts: max_attempts } : {}),
          ...(frame_id ? { frameId: frame_id } : {}),
        })
        return structured(result)
      } catch (e) {
        /* the provider's own words are the actionable part of a failed run */
        return err('upstream_failed', e instanceof Error ? e.message : 'the design workflow failed')
      }
    },
  )

  /* The policy may have removed tools, so the surface is smaller than the
     source declares. The endpoint builds a fresh server per POST and this one
     is not connected yet, so the notification is sent from the initialized
     handler below — the first moment it can actually reach the client. */
  const policyFilteredTools = attemptedTools !== registry.size

  return server
}

/** The file set a design handoff PR carries: one html per frame plus tokens. */
/** The frame a handoff file belongs to, from the path a reviewer commented on:
 *  `design/<frame>.html` (and its `.jsx`/`.spec.md` siblings) name a frame, so
 *  an inline comment can be answered with a frame tool. */
function frameIdForPath(c: Canvas, path: string | undefined): string | undefined {
  if (!path) return undefined
  const match = /^design\/(.+?)(?:\.html|\.jsx|\.spec\.md)$/.exec(path)
  if (!match) return undefined
  const base = match[1]!
  /* a name that was ambiguous at handoff time carries the frame id in the
     path, and the canvas may have been renamed or pruned since — so the id is
     the anchor that survives, and the name is the fallback */
  const byId = c.frames.find((f) => base.endsWith(`-${f.id}`))
  if (byId) return byId.id
  return c.frames.find((f) => handoffFileName(f, c.frames) === base)?.id
}

/** Stateless streamable-HTTP MCP endpoint. `opts.readonly` builds the
 *  read-only surface (/mcp/readonly): write tools are never registered there. */
export async function handleMcpRequest(req: Request, res: Response, opts?: { readonly?: boolean }) {
  if (req.method !== 'POST') {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP endpoint is stateless; use POST.' },
      id: null,
    })
    return
  }
  /* OAuth gate: the 401 + WWW-Authenticate header is what triggers the
     browser approval flow in MCP clients (RFC 9728 discovery). */
  const session = await auth.api.getMcpSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
  if (!session) {
    const origin = `${req.protocol}://${req.get('host')}`
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer realm="doop", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      )
      .json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: this MCP server requires OAuth' },
        id: null,
      })
    return
  }
  /* banning revokes browser sessions, but an already-issued MCP token keeps
     validating until it expires — refuse it here so a ban is total */
  if (session.userId && (await isBanned(session.userId))) {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32003, message: 'This account has been disabled on this server.' },
      id: null,
    })
    return
  }
  /* A custom (bring-your-own) agent talking to us is the behavior we want to
     grow — instrument it. `initialize` marks a fresh client session (and is
     the only message carrying the client's name); tool calls mark actual use,
     throttled because one design task is dozens of calls. */
  if (session.userId) {
    const msgs = Array.isArray(req.body) ? req.body : [req.body]
    for (const msg of msgs) {
      if (msg?.method === 'initialize') {
        capture(session.userId, 'custom_agent_connected', {
          agent_client: msg.params?.clientInfo?.name,
          agent_client_version: msg.params?.clientInfo?.version,
        })
      } else if (msg?.method === 'tools/call') {
        captureThrottled(session.userId, 'custom_agent_used', { first_tool: msg.params?.name })
        /* per-tool adoption, throttled the same way: the admin stats endpoint
           has the full picture, this is what shows up in product analytics */
        captureThrottled(session.userId, 'custom_agent_tool_used', { tool: msg.params?.name })
      }
    }
  }
  const owner = session.userId ? await getUserName(session.userId) : undefined
  /* the OAuth client (not just the user) rides along: presence, activity and
     the clients panel can then tell two agents of one account apart */
  if (session.clientId) touchClient(session.clientId)
  const server = buildMcpServer(owner, session.userId ?? undefined, session.clientId ?? undefined, opts)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    /* the client is gone; there is nobody left to report a close failure to */
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('mcp error', e)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
}
