import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js'
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
import { canAccessCanvas } from './access.ts'
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
import { auditFrame, type A11yReport } from './a11y.ts'
import { diffFrames } from './visualDiff.ts'
import { cssForTokens, stripTokenStyle } from '../shared/tokens.ts'
import { lintFrame } from './designLint.ts'
import { deriveDesignSystem, designSystemMarkdown } from './designSystem.ts'
import { probeFrame, type Probe } from './domProbe.ts'
import {
  deleteElement,
  ElementEditError,
  getElement,
  getFrameCss,
  insertElement,
  setFrameCss,
  updateElements,
  type UpdateElementsResult,
} from './elementEdit.ts'
import { DOOP_GUIDE, guideFor, GUIDE_TOPICS } from './guide.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml, repairEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import { buildZip } from './zip.ts'
import { IMPORTS_PER_MIN, MAX_FRAME_HTML_BYTES, RENDERS_PER_MIN, SEARCHES_PER_MIN, UPLOADS_PER_MIN } from './limits.ts'
import * as imageSearch from './imageSearch.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { discoverSitePages, importPage, normalizeImportUrl, type DiscoveredSite } from './importer.ts'
import { getJob, recordUnit, startJob } from './jobs.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { frameSha, htmlSha, reviewFrame, reviewToRecord } from './review.ts'
import { AGENT_ROLES, PIPELINE_PRESETS, roleName } from '../shared/agents.ts'
import { feedbackAbout, feedbackBlock } from './feedbackText.ts'
import { parseListing, publishCanvas, unpublishCanvas } from './community.ts'
import { COMMUNITY_CATEGORIES } from '../shared/types.ts'
import { sanitizeImportedHtml } from './sanitizeHtml.ts'
import { agentsMd, designMd, rewriteAssetUrls, specMd, tailwindThemeCss, tokensDtcg, tokensJson } from './codeExport.ts'
import { commitFiles, GithubWriteError, readPullRequest } from './githubWrite.ts'
import { touchClient } from './mcpClients.ts'
import { capabilities } from './capabilities.ts'
import * as agentEvents from './agentEvents.ts'
import * as runLog from './runLog.ts'
import { codeFor, err, mcpErrorPayload, ResourceError, type McpErrorPayload } from './mcpErrors.ts'
import * as frameLocks from './frameLocks.ts'
import { recall, remember, replay, replayAsync } from './opIds.ts'
import { htmlBundle, htmlToReact } from './codeExport.ts'
import type {
  AgentTask,
  Canvas,
  CanvasView,
  DesignTokens,
  ElementComment,
  Frame,
  MemoryReference,
  Page,
} from '../shared/types.ts'
import { recordToolCall } from './mcpStats.ts'

const INSTRUCTIONS = `Doop is a shared multiplayer design canvas: humans and AI agents design together in real time. Canvases contain frames — artboards that render complete HTML documents live for everyone viewing.

You MUST call get_guide({ topic: "doop-instructions" }) once before using other Doop tools. Call it again if a long conversation may have compressed or dropped the guide text.

- Context first: call get_canvas before adding or editing frames.
- Identity: pick an agent_name and reuse the SAME name on every call — your presence and edits are attributed live.
- Narrate: call set_status with a one-line summary when you start a task and whenever your focus shifts — people watching the canvas see it live next to your name.
- Creating: create_frame, then stream the design with append_frame_html one complete section at a time (~1–4 KB chunks; start=true on the first, done=true on the last). Each chunk renders the moment it arrives — viewers watch you work.
- Pages: canvases contain ordered pages — sub-canvases that group frames. For multi-screen flows, create one page per screen with create_page and target it via the page param on create_frame (or move_frame later); get_canvas lists every page and which page each frame sits on.
- Review: after every create or significant edit you MUST call get_frame_screenshot and fix what looks wrong before moving on.
- Small edits: edit_frame_html (exact find/replace — the change morphs into the rendered frame in place). Full redesigns: set_frame_html or a new stream. Rename/move/resize: update_frame.
- Images: real imagery makes designs. search_images finds stock photos (you SEE thumbnails and pick), search_icons finds 200k+ UI icons as hotlinkable SVGs, search_logos finds real company logos by brand name or domain — call it once per brand BEFORE writing any logo wall, integration row, press bar or testimonial, and never ship a placeholder tile, "LOGO" text or an invented wordmark in its place, list_backgrounds shows a page of curated hero/section/bento backgrounds (glows, grainy meshes, aurora, painterly scenes) as thumbnails — browse it when a section wants atmosphere rather than defaulting to a flat CSS gradient, judge by eye whether one fits the frame, and draw your own when none does, upload_asset stores your own file (remote file → source_url; local file → local_file=true, returns a curl command) and returns a permanent URL. Never inline images as data: URIs.
- Websites: when a request names an existing site or URL — a redesign of it, or "like acme.com" — call import_webpage FIRST so an editable HTML snapshot lands on the canvas. Leave that source frame unchanged and design in a separate frame. view_website is only for read-only inspection when the page should not be added. If Doop cannot capture the site, do not retry with view_website because it uses the same capture path. Use your own browser or web tool and work only from content you actually observe; if that is unavailable, ask the user for screenshots or an HTML export rather than inventing content.
- Feedback: humans reply to your tasks; their notes arrive inside your tool results as HUMAN FEEDBACK blocks — address them before continuing.
- Board: humans queue work as cards on the board. list_cards shows what is open; take_card claims one and delivers its brief (plus any reference-image attachments); complete_card closes it when done, with a one-line summary for the feed.
- Comments: get_comments reads element-pinned notes; reply_to_comment answers one in-thread and resolve_comment closes it once the note is addressed. add_comment pins a new note to an element — use it to ask a human a question about a specific element.
- Inspecting: on a large or imported frame, call inspect_frame (rendered semantics, computed styles, element selectors) and get_frame_html (a bounded slice, or a query) instead of get_frame — pulling a whole document into context is the most common way to run out of room mid-design.
- Stopping: if a run is going wrong — drifting from the brief, the wrong frame, looping — call stop_work (target_agent for another agent's run). Never delete a frame out from under a working agent.
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

/** Reaches agents whose session predates set_status (or who skipped the guide). */
function withStatusNudge<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  if (actions.hasAnnouncedTask(canvasId, actor)) return result
  result.content.push({
    type: 'text' as const,
    text: 'You have not announced what you are working on. Call set_status with a one-line, present-tense summary (e.g. "Designing a pricing page, dark editorial style") — it shows live next to your name and builds your task history in the panel. Update it when your focus shifts; clear it with "" when done.',
  })
  return result
}

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
 *  agent can branch on them instead of parsing prose. */
function lockConflict(e: unknown) {
  if (!(e instanceof frameLocks.FrameLockedError)) return undefined
  const until = new Date(e.holder.expiresAt).toISOString()
  return err('conflict', `frame ${e.holder.frameId} is being edited by ${e.holder.agentName} until ${until}`, {
    frame_id: e.holder.frameId,
    holder: e.holder.agentName,
    expires_at: until,
    hint: 'pass takeover: true to take the frame over, or wait for the lock to expire',
  })
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

/** Append any undelivered human feedback for this agent to a tool result.
 *  MCP is pull-based, so this is the channel through which humans steer agents. */
function withFeedback<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  const pending = actions.takeFeedbackFor(canvasId, actor.name, undefined, actor.ownerId)
  if (pending.length === 0) return result
  const tasks = actions.getTasks(canvasId)
  result.content.push({
    type: 'text' as const,
    text: feedbackBlock(
      pending.map((f) => {
        const task = tasks.find((t) => t.id === f.taskId)
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
    ),
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
const MUTATING_TOOLS: Record<string, true> = {
  add_comment: true,
  append_frame_html: true,
  apply_ops: true,
  ask_human: true,
  begin_frame_edit: true,
  complete_card: true,
  create_canvas: true,
  create_frame: true,
  create_page: true,
  create_release: true,
  delete_element: true,
  delete_frame: true,
  delete_page: true,
  duplicate_frame: true,
  edit_frame_html: true,
  end_frame_edit: true,
  hand_back: true,
  import_code: true,
  import_site: true,
  import_webpage: true,
  insert_element: true,
  move_frame: true,
  open_pull_request: true,
  pause_work: true,
  propose_frame_create: true,
  propose_frame_delete: true,
  propose_frame_html: true,
  publish_canvas: true,
  ready_for_review: true,
  rename_page: true,
  reply_to_comment: true,
  resolve_comment: true,
  restore_release: true,
  resume_work: true,
  revert_frame: true,
  revert_run: true,
  save_decision: true,
  set_breakpoints: true,
  set_frame_css: true,
  set_frame_html: true,
  set_guidelines: true,
  set_plan: true,
  set_status: true,
  set_tokens: true,
  stop_work: true,
  take_card: true,
  undo_last_change: true,
  unpublish_canvas: true,
  update_elements: true,
  update_frame: true,
  update_plan_step: true,
  upload_asset: true,
  withdraw_proposal: true,
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

/** `breakpoints` is reported by get_canvas and the canvas resource; the local
 *  extension keeps the shared CanvasView type untouched. */
type CanvasViewWithBreakpoints = CanvasView & { breakpoints?: { name: string; min_width: number }[] }

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

const planStepShape = z.object({
  id: z.string(),
  text: z.string(),
  status: z.enum(['pending', 'active', 'done', 'blocked']),
  note: z.string().optional(),
  updatedAt: z.number().optional(),
})

const planShape = z.object({
  canvasId: z.string(),
  agentName: z.string(),
  owner: z.string().optional(),
  steps: z.array(planStepShape),
  updatedAt: z.number(),
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

const boardCardShape = {
  id: z.string(),
  title: z.string(),
  queued_by: z.string(),
  queued_at: z.string(),
  stage: z.number(),
  waiting_for: z.string(),
  attachments: z.array(z.string()),
  target_frames: z.array(z.string()),
  /** the element the human had selected when they queued the card — "fix THIS
   *  element", not "fix this frame" */
  target_selector: z.string().optional(),
  /** the page the target frame lives on, so no lookup is needed to reach it */
  target_page_id: z.string().optional(),
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
   *  forgot it and the human feedback channel never goes quiet */
  agentName?: string
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

/** Tools where the agent name is the whole point of the call rather than a
 *  detail of it: claiming a card, answering a human, reading the feedback
 *  addressed to you, or stopping work. These keep `agent_name` required in
 *  their published schema — a session default here would mean acting as
 *  whichever agent last used this account. */
const IDENTITY_TOOLS = new Set([
  'set_status',
  'get_feedback',
  'take_card',
  'complete_card',
  'ask_human',
  'wait_for_events',
  'stop_work',
])

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. */
export function buildMcpServer(owner?: string, ownerId?: string, clientId?: string): McpServer {
  /* one id per connection: every call this agent makes on a canvas lands on
     the Run tab under the same run, so its session reads as one timeline. The
     HTTP endpoint builds a fresh server for every POST, so this state lives
     outside it — keyed by the account that authorized the token. */
  const session = sessionFor(ownerId ?? clientId ?? owner ?? 'anonymous')
  const actorFrom = (agent_name?: string) =>
    actions.resolveActor({ name: agent_name, kind: 'agent', owner, ownerId, clientId })
  /* Canvas access for agents mirrors the web UI: the OAuth user's id runs
     through the same canAccessCanvas gate as browser sessions. Every tool
     that takes a canvas or frame id resolves it through these. */
  const canvasFor = (canvasId: string) => {
    const c = store.getCanvas(canvasId)
    return c && canAccessCanvas(ownerId, c) ? c : undefined
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
    return found && canAccessCanvas(ownerId, found.canvas) ? found : undefined
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
     canvas-scoped call, not only once it mutates something. */
  const arrive = (canvasId: string, agent_name?: string) => {
    if (agent_name) actions.heartbeatAgent(canvasId, actorFrom(agent_name))
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
   * Frames this agent designed that are not currently verified: it wrote them
   * (they carry its name as the last writer), and the newest stored review does
   * not describe the document they hold now, or failed.
   *
   * Derived from the frames and the stored reports rather than from a counter
   * kept during the run, so it cannot drift: an agent that reviews its work and
   * then edits the frame again is unverified again, which is the whole point.
   */
  async function unverifiedFrames(
    canvasId: string,
    agentName: string,
  ): Promise<{ frameId: string; name: string; reason: string }[]> {
    const canvas = store.getCanvas(canvasId)
    if (!canvas) return []
    const mine = canvas.frames.filter((frame) => frame.updatedBy === agentName && !frame.demo && frame.html)
    const out: { frameId: string; name: string; reason: string }[] = []
    for (const frame of mine) {
      const [newest] = await persist.listFrameReviews(frame.id, 1)
      if (!newest) {
        out.push({ frameId: frame.id, name: frame.name, reason: 'never reviewed' })
        continue
      }
      if (newest.htmlSha !== frameSha(frame, canvas.tokens)) {
        out.push({ frameId: frame.id, name: frame.name, reason: 'changed after its last review' })
        continue
      }
      if (newest.verdict !== 'pass') {
        out.push({ frameId: frame.id, name: frame.name, reason: 'its last review failed' })
      }
    }
    return out
  }

  /** The refusal a delivery path returns when the caller's own frames are not
   *  verified. Names the frames and the tool that clears it. */
  async function reviewRefusal(canvasId: string, agentName: string) {
    const pending = await unverifiedFrames(canvasId, agentName)
    if (!pending.length) return undefined
    return err(
      'conflict',
      `these frames you designed are not verified: ${pending
        .map((entry) => `“${entry.name}” (${entry.reason})`)
        .join(', ')}. Call ready_for_review for each one — it runs the checks and records the result — then complete.`,
      { frames: pending },
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

  /* Every tool call lands here: one place that records outcome and latency for
     the whole surface, so the 43 handlers stay readable. It also keeps each
     tool's own input schema and handler, which is what lets apply_ops batch a
     tool without restating its arguments anywhere.

     The stop check lives here too: while a human's stop is outstanding for the
     calling agent on the canvas the call names, the call is refused outright —
     no read runs, no write lands, and the agent gets a code it can branch on
     instead of a prose note it can ignore. A stop is cleared by the run that
     claims the work (take_card takes a card, not a canvas, so it is not
     intercepted here). */
  type RegisterTool = McpServer['registerTool']
  type ToolHandler = (args: never, extra: never) => Promise<CallToolResult>
  interface RegisteredTool {
    inputSchema: z.ZodRawShape
    run: ToolHandler
  }
  const registry = new Map<string, RegisteredTool>()
  /** The canvas a call is about, from its own args: canvas_id, else the frame
   *  or page it names. Card-scoped tools resolve their canvas internally.
   *  Deliberately not access-checked: the stopped/interrupted notices belong
   *  to the agent that was stopped, and an agent working a canvas through a
   *  dispatch may not be the account that owns it. The run-event writer
   *  applies its own check. */
  const canvasArgOf = (args: Record<string, unknown>): string | undefined => {
    if (typeof args.canvas_id === 'string') return args.canvas_id
    if (typeof args.frame_id === 'string') return store.getFrame(args.frame_id)?.canvasId
    if (typeof args.page_id === 'string') return store.getPage(args.page_id)?.canvas.id
    return undefined
  }

  /**
   * The session's context, applied to a call that omitted it.
   *
   * `canvas_id` and `agent_name` are the two arguments an agent has to repeat
   * on nearly every call, and forgetting `agent_name` is not a visible mistake:
   * `withFeedback` returns early without an actor, so the human feedback channel
   * goes quiet with no error at all. Both are therefore inherited from the
   * session, and — because a silent default is its own hazard — the
   * substitution is reported back in the result.
   *
   * An explicit argument always wins, and nothing is inherited by the tools
   * that have no canvas scope (create_canvas, list_canvases, whoami), which do
   * not declare `canvas_id` in the first place.
   */
  const applySessionContext = (args: unknown, declared: z.ZodRawShape): UsedContext => {
    const used: UsedContext = {}
    if (!args || typeof args !== 'object') return used
    const record = args as Record<string, unknown>
    /* Only arguments the tool actually declares. A tool that never asked for a
       canvas or an agent name was not written to carry one, and handing it a
       field it does not know about would change what it means — a run-timeline
       event attributed to a call that never claimed to be that agent. */
    const declaresCanvas = 'canvas_id' in declared
    const declaresAgent = 'agent_name' in declared
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
      if (canvasId) out = withFocusNudge(out, canvasId, session)
    }
    /* A canvas-scoped call is exactly where feedback would have been delivered,
       so an unresolved name is worth naming here — never as a hard error, which
       would break every client that has never passed one. Only for a tool that
       accepts the argument at all. */
    const unresolved = 'agent_name' in declared && used.agentName === undefined && typeof record.agent_name !== 'string'
    if (unresolved && canvasArgOf(record) !== undefined) {
      out.content.push({ type: 'text' as const, text: 'call with agent_name to receive human feedback' })
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

  const stoppedResult = (args: unknown): CallToolResult | undefined => {
    if (!args || typeof args !== 'object') return undefined
    const record = args as Record<string, unknown>
    if (typeof record.agent_name !== 'string') return undefined
    const canvasId = canvasArgOf(record)
    if (!canvasId) return undefined
    const actor = actorFrom(record.agent_name)
    if (!actions.wasStopped(canvasId, actor.name, actor.ownerId)) return undefined
    return err(
      'stopped',
      'STOPPED — a human stopped your work on this canvas. Stop now: do not call any more frame tools and do not start new work. Reply with one short sentence about where you left off. The work is not lost — a human can retry the card.',
    )
  }
  /** A frame's measurements for the spec, or undefined when it cannot be
   *  rendered — the caller turns that into the tool's own error. */
  const specProbe = async (frame: Frame): Promise<Probe | undefined> => {
    try {
      return await probeFrame(frame)
    } catch {
      return undefined
    }
  }

  /** Connected MCP agents work on the same canvases as the resident team, so
   *  their calls belong on the same timeline: the Run tab is where a human
   *  watches what an agent did, and an external agent's work was invisible
   *  there. One event per canvas-scoped call, named by the agent that made it —
   *  a separate runId per agent session, so the panel can group them. */
  const recordRunEvent = (name: string, args: unknown, ok: boolean, ms: number, summary: string) => {
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
    })
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
  const tool = ((name: string, config: never, cb: never) => {
    const cfg = config as unknown as { inputSchema?: z.ZodRawShape }
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
    /* `agent_name` stays required where the identity IS the call */
    for (const key of IDENTITY_TOOLS.has(name) ? (['canvas_id'] as const) : (['canvas_id', 'agent_name'] as const)) {
      const field = registered[key]
      if (field instanceof z.ZodString) registered[key] = field.optional()
    }
    registry.set(name, { inputSchema: declared, run: cb as unknown as ToolHandler })
    return server.registerTool(
      name as never,
      { ...(config as object), inputSchema: registered } as never,
      (async (args: never, extra: never) => {
        const started = Date.now()
        const used = applySessionContext(args, declared)
        const stopped = stoppedResult(args)
        if (stopped) {
          recordToolCall(name, false, Date.now() - started, 'stopped')
          recordRunEvent(name, args, false, Date.now() - started, 'refused: the work was stopped')
          return stopped
        }
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
           substitutions are reported again rather than baked into the record.
           It runs after the stop check, so a stopped agent is refused whether
           or not the call is a retry. */
        const opKey = opIdOf(name, args)
        if (opKey) {
          const replayed = recall(opIdOwner(name), opKey)
          if (replayed) {
            replayed.content.push({ type: 'text' as const, text: JSON.stringify({ idempotent_replay: true }) })
            recordToolCall(name, true, Date.now() - started)
            recordRunEvent(name, args, true, Date.now() - started, 'idempotent replay')
            return contextNotices(args, interruptedResult(args, replayed), used, declared)
          }
        }
        try {
          const result = await (cb as unknown as ToolHandler)(args, extra)
          recordToolCall(name, !result?.isError, Date.now() - started)
          recordRunEvent(name, args, !result?.isError, Date.now() - started, resultSummary(result))
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
      title: 'Search design inspiration',
      description:
        'Search a curated gallery of real, well-designed live websites by category and SEE thumbnails of each, with pre-distilled style facts (one-line mood north star, named palette, fonts). Call it FIRST when writing a design brief — it is the required inspiration step, especially for landing pages: query the page archetype plus the register you want ("law firm landing page, editorial", "dark fintech dashboard"), not just the product noun. Study the thumbnails, pick the ONE exemplar that fits the brief best and follow it — do not blend several — and name it in the brief. Do not embed these screenshots in a frame.',
      inputSchema: {
        query: z
          .string()
          .describe('Page archetype + register, e.g. "grocery delivery landing page, warm", "dark fintech dashboard"'),
        count: z.number().min(1).max(6).optional().describe('Exemplars to return, default 4'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }, extra) => {
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (searchHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= SEARCHES_PER_MIN) return err('rate_limited', 'search rate limit — wait a minute')
      hits.push(now)
      searchHits.set(limitKey, hits)
      try {
        await progress(extra, 0, `Searching real designs for “${query}”…`)
        const results = await searchInspiration(query, count ?? 4)
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'inspiration search failed')
      }
    },
  )

  tool(
    'list_canvases',
    {
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
      description:
        'Get a canvas: its name, its ordered pages, and every frame with position, size and metadata (not the HTML — use get_frame for that). Use this to see the current layout before adding or editing frames. Pass your agent_name so any human feedback waiting for you is delivered with the result.',
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
      arrive(canvas_id, agent_name)
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
        ...(notes.length ? { note: notes.join(' ') } : {}),
      }
      return withFeedback(structured(view), canvas_id, agent_name ? actorFrom(agent_name) : undefined)
    },
  )

  tool(
    'list_frames',
    {
      description:
        "Page through a canvas's frames without pulling their HTML: id, name, page, position, size, who last touched each one and when, plus a public image_url. Use it when get_canvas reported frames_truncated, or to poll a busy canvas for what changed since you last looked (updated_since).",
      annotations: { readOnlyHint: true },
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
      arrive(canvas_id, agent_name)
      const all = c.frames
        .filter((f) => !f.demo)
        .filter((f) => pageId === undefined || f.pageId === pageId)
        .filter((f) => since === undefined || f.updatedAt > since)
      const frames = all.slice(offset, offset + limit)
      const hasMore = offset + frames.length < all.length
      return withFeedback(
        structured({
          frames: frames.map((f) =>
            frameSummary(
              f,
              c.pages?.find((p) => p.id === f.pageId),
            ),
          ),
          total: all.length,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + frames.length } : {}),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  tool(
    'list_guidelines',
    {
      description:
        "List a canvas's style guides (named markdown guidelines — brand rules, style recipes) with one-line summaries. Fetch the full text of the relevant ones with get_guidelines before designing. Pass agent_name: it is how human feedback reaches you — a call without it never receives the notes people leave for you.",
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
      return withFeedback(
        structured({
          guidelines: docs.map((d) => ({
            name: d.name,
            title: actions.guidelineTitle(d),
            summary: actions.guidelineSummary(d),
            bytes: d.markdown.length,
            updatedAt: new Date(d.updatedAt).toISOString(),
            updatedBy: d.updatedBy,
          })),
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  tool(
    'get_guidelines',
    {
      description:
        "Read one of the canvas's style guides in full: the style rules (palettes, fonts, layout recipes, asset URLs) every frame must follow. If get_canvas listed style guides, read the relevant ones with this BEFORE creating or restyling frames. Pass agent_name: it is how human feedback reaches you — a call without it never receives the notes people leave for you.",
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
      return withFeedback(
        {
          content: [{ type: 'text' as const, text: doc.markdown }],
          structuredContent: { canvas_id, name: doc.name, title: actions.guidelineTitle(doc), markdown: doc.markdown },
        },
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'set_guidelines',
    {
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
        return withFeedback(
          text(
            doc
              ? { ok: true, name: doc.name, title: actions.guidelineTitle(doc), bytes: doc.markdown.length }
              : { ok: true, deleted: true },
          ),
          canvas_id,
          actor,
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
      description:
        'Read a pinned style reference in full: the HTML of a design a human marked as an exemplar ("more designs like this"). References are listed by get_canvas. Match its palette, typography and spacing when designing on this canvas — it is the ground truth for the canvas\'s style. Pass agent_name: it is how human feedback reaches you — a call without it never receives the notes people leave for you.',
      inputSchema: {
        canvas_id: z.string(),
        reference_id: z.string().describe('Reference id from get_canvas'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, reference_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
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
      return withFeedback(
        text({
          id: ref.id,
          title: ref.title,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          html: ref.html,
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  tool(
    'save_decision',
    {
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
        return withFeedback(
          text(
            saved
              ? { ok: true, note: 'Saved to the canvas Memory. Recurring preferences become suggested style rules.' }
              : { ok: true, note: 'Already in Memory — this exact decision was recorded before.' },
          ),
          canvas_id,
          actor,
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
        'The identity your tool calls run as: the account behind the connection, the agent name you are posting under, and what that means for your work. Agent names are free text — two accounts can both call themselves the same thing — so this is how you tell which identity is yours when a canvas shows a name you did not expect.',
      annotations: { readOnlyHint: true },
      inputSchema: { agent_name: agentName.optional() },
      outputSchema: {
        account: z.string().optional(),
        account_id: z.string().optional(),
        agent_name: z.string(),
        note: z.string(),
      },
    },
    async ({ agent_name }) => {
      const identity = actions.resolveActor({ name: agent_name, kind: 'agent', owner, ownerId })
      return structured({
        ...(owner ? { account: owner } : {}),
        ...(ownerId ? { account_id: ownerId } : {}),
        agent_name: identity.name,
        note: ownerId
          ? 'Your work, claims and stops are scoped to this account — another account using the same agent name is a different agent here.'
          : 'This connection has no account behind it, so your agent name is the only thing identifying you on a canvas.',
      })
    },
  )

  tool(
    'get_agents',
    {
      title: 'List agents and pipelines',
      description:
        'The resident design team this canvas can be worked by, and who is live on it right now: the roles with what each one is for, the ready-made pipelines (an ordered list of role ids), and every agent currently present on the canvas. Use it to address work to a specific agent, or to see whether the agent you expected is actually connected before you hand something back.',
      annotations: { readOnlyHint: true },
      inputSchema: { canvas_id: z.string(), agent_name: agentName.optional() },
      outputSchema: {
        roles: z.array(z.object({ id: z.string(), name: z.string(), blurb: z.string() })),
        pipelines: z.array(z.object({ id: z.string(), label: z.string(), roles: z.array(z.string()) })),
        connected: z.array(
          z.object({ agent: z.string(), owner: z.string().optional(), working_on: z.string().optional() }),
        ),
      },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      /* Two sources, because an agent shows up in one of them depending on how
         it works: a card/status row it claimed, or presence alone (an external
         agent that has only called set_status once). Tasks are read first —
         they are the authoritative record of what an agent is doing — and
         presence only fills what a task row lacks. Deduped by name: the canvas
         shows one worker per name. */
      const connected = new Map<string, { agent: string; owner?: string; working_on?: string }>()
      const record = (name: string, owner?: string, status?: string | null) => {
        const entry = connected.get(name) ?? { agent: name }
        if (!entry.owner && owner) entry.owner = owner
        if (!entry.working_on && status) entry.working_on = status
        connected.set(name, entry)
      }
      for (const t of actions
        .getTasks(canvas_id)
        .filter((t) => t.agentName && !t.endedAt && !t.failedAt && !t.cancelledAt))
        record(t.agentName, t.owner, t.status)
      for (const p of actions.listAgentPresence(canvas_id)) record(p.name, p.owner, p.status)
      return withFeedback(
        structured({
          roles: AGENT_ROLES.map((r) => ({ id: r.id, name: r.name, blurb: r.blurb })),
          pipelines: PIPELINE_PRESETS.map((p) => ({ id: p.id, label: p.label, roles: p.roles })),
          connected: [...connected.values()],
        }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  tool(
    'set_status',
    {
      description:
        'Broadcast a one-line status of what you are working on right now — everyone viewing the canvas sees it live next to your name (e.g. "Sketching a mobile onboarding flow", "Fixing contrast on the pricing table"). Set it when you START a task, update it whenever your focus shifts to something new, and clear it with an empty string when you are done. Keep it under ~80 characters, present tense, specific.',
      inputSchema: {
        canvas_id: z.string(),
        status: z
          .string()
          .max(140)
          .describe('What you are working on, one line, present tense. Empty string clears your status.'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, status, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      actions.setAgentStatus(canvas_id, actorFrom(agent_name), status)
      /* who else is on this canvas right now — a human gets this free from the
         working-now strip, an agent otherwise has no way to know */
      const others = actions
        .getTasks(canvas_id)
        .filter((t) => t.agentName && !t.endedAt && !t.failedAt && !t.cancelledAt && t.agentName !== agent_name)
        .map((t) => ({ agent: t.agentName, working_on: t.status }))
      return withFeedback(
        text({ ok: true, status: status.trim() || null, agents_working_now: others }),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'stop_work',
    {
      title: 'Stop agent work',
      description:
        "Stop an agent's work on a canvas — for when a run is going wrong: a redesign that drifted from the brief, work on the wrong frame, or an agent looping. Pass target_agent to stop another agent (the name you see on the canvas), or omit it to stop yourself: its live stream closes and its board card is marked stopped instead of failed, so a human can retry it. Pass card_id instead to stop just that one board card — the agent's other cards and its tool calls keep running. Frames already written stay on the canvas and are yours to edit. Use this instead of deleting a frame out from under a working agent.",
      annotations: { destructiveHint: true },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName,
        target_agent: z
          .string()
          .optional()
          .describe('The agent to stop, as named on the canvas. Omit to stop your own run.'),
        card_id: z
          .string()
          .optional()
          .describe(
            'Stop only this board card, leaving the agent’s other cards and calls running. Takes precedence over target_agent.',
          ),
      },
    },
    async ({ canvas_id, agent_name, target_agent, card_id }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      /* Card scope: one card goes to cancelled, nothing else changes — no
         agent-level stop, so the agent keeps its other cards and its next call
         is not refused. */
      if (card_id !== undefined) {
        const card = actions.getTasks(canvas_id).find((t) => t.id === card_id)
        if (!card) return err('not_found', `no card with id ${card_id} on this canvas`)
        if (!card.queuedBy) return err('invalid_input', `${card_id} is not a board card — pass an id from list_cards`)
        const stopped = actions.cancelCard(canvas_id, card_id, actorFrom(agent_name).name)
        if (!stopped || stopped.cancelledAt === undefined)
          return err('invalid_input', 'that card is already finished or stopped')
        return text({
          ok: true,
          stopped_card: card_id,
          ...(card.agentName ? { agent: card.agentName } : {}),
          note: card.agentName
            ? `${card.agentName} is stopped on this card only — its other cards and tool calls keep running. A human can retry this card from the board.`
            : 'Stopped. No agent had claimed this card, so nothing else changed.',
        })
      }
      /* ?? keeps an empty string: a blank target must not fall back to
         agent_name or worse, abort whatever run happens to be live */
      const target = (target_agent ?? agent_name).trim()
      if (!target)
        return err('invalid_input', 'target_agent is empty — name the agent to stop, or omit it to stop yourself')
      /* An agent name is typed by the caller, so stopping "Claude" must not
         stop a different account's Claude. The canvas owner and its members
         may stop anyone on their canvas; everyone else only their own agent. */
      const targetOwners = new Set(
        actions
          .getTasks(canvas_id)
          .filter((t) => t.agentName === target && !t.endedAt && !t.cancelledAt && t.ownerId !== undefined)
          .map((t) => t.ownerId as string),
      )
      const foreign = [...targetOwners].some((id) => id !== ownerId)
      const privileged = ownerId !== undefined && (c.ownerId === ownerId || (c.memberIds ?? []).includes(ownerId))
      if (foreign && !privileged)
        return err(
          'forbidden',
          `${target} belongs to another account — only the canvas owner or a member can stop it`,
          {
            target_agent: target,
            hint: 'stop your own agent, or ask the canvas owner to stop that one',
          },
        )
      /* The record has to name the account the stop is AIMED AT, not the
         account that issued it: an owner stopping another account's agent
         must silence that agent, not their own namesake. One account behind
         the name → scope to it; several → scope to the caller, matching the
         old read-everyone behaviour for an ambiguous name. */
      const aimedAt = foreign && targetOwners.size === 1 ? [...targetOwners][0] : ownerId
      const stopped = actions.cancelAgentWork(canvas_id, target, actorFrom(agent_name).name, aimedAt)
      return text({
        ok: stopped > 0,
        stopped_agent: target,
        tasks_stopped: stopped,
        note:
          stopped > 0
            ? `${target} was stopped. Its card is stopped, not failed — a human can retry it from the board. Frames it already wrote stay on the canvas.`
            : `${target} had nothing running on this canvas.`,
      })
    },
  )

  tool(
    'get_comments',
    {
      description:
        'Read element-pinned comments and replies on a canvas, newest first, including author, text, frame, CSS selector, HTML snippet, parentId thread links, and claim/failure/resolution metadata. Includes resolved comments by default so complete conversations remain readable; set include_resolved to false for unresolved comments only. Returns the retained comment history (up to 100 entries per canvas), not an archive; paged, so follow has_more. Reading does not claim feedback or comments, or mark them resolved. To answer or close a comment, use reply_to_comment and resolve_comment.',
      annotations: { readOnlyHint: true },
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
      arrive(canvas_id, agent_name)
      const all = actions
        .getComments(canvas_id)
        .filter((comment) => frame_id === undefined || comment.frameId === frame_id)
        .filter((comment) => include_resolved || comment.resolvedAt === undefined)
      const comments = all.slice(offset, offset + limit).map((comment) => ({
        ...comment,
        anchor: anchorState(store.getFrame(comment.frameId)?.html ?? '', comment),
      }))
      const hasMore = offset + comments.length < all.length
      // Deliberately omit withFeedback: inspecting comments must not claim work.
      return structured({
        comments,
        total: all.length,
        has_more: hasMore,
        ...(hasMore ? { next_offset: offset + comments.length } : {}),
      })
    },
  )

  tool(
    'add_comment',
    {
      title: 'Pin a comment to an element',
      description:
        "Leave a note pinned to one element inside a frame — use it to record what you changed and why, or to ask a human a question about a specific element. selector is a CSS selector for the element: get one from inspect_frame's elements[].selector, or from an existing comment. Pass snippet (the element's outerHTML excerpt) when you have it so the pin still makes sense if the element moves. Humans see this as a pin on the canvas.",
      annotations: { readOnlyHint: false },
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
      return withFeedback(structured(payload as ElementComment), f.canvasId, actorFrom(agent_name))
    },
  )

  tool(
    'reply_to_comment',
    {
      title: 'Reply in a comment thread',
      description:
        "Reply inside an existing element-comment thread. The reply inherits the thread's element anchor, so it stays pinned to the same thing the conversation is about. Use this to answer a human's question on your work, or to record what you did about their note. Resolve the thread with resolve_comment once the note is addressed.",
      annotations: { readOnlyHint: false },
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
      return withFeedback(text(reply), found.canvasId, actorFrom(agent_name))
    },
  )

  tool(
    'resolve_comment',
    {
      title: 'Resolve a comment thread',
      description:
        'Mark an element-comment thread as resolved — do this once the note it carries has actually been addressed in the design. Resolving a root comment closes its whole thread. Humans can see who resolved it; nothing is deleted, and the conversation stays readable with get_comments.',
      annotations: { readOnlyHint: false },
      inputSchema: { comment_id: z.string(), agent_name: agentName },
    },
    async ({ comment_id, agent_name }) => {
      const found = actions.findComment(comment_id)
      if (!found) return err('not_found', `no comment with id ${comment_id}`)
      if (!canvasFor(found.canvasId)) return noCanvas(found.canvasId)
      const resolved = actions.resolveComment(comment_id, actorFrom(agent_name))
      if (!resolved) return err('not_found', `no comment with id ${comment_id}`)
      return withFeedback(
        text({ ok: true, id: resolved.id, resolved: resolved.resolvedAt !== undefined }),
        found.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'get_feedback',
    {
      description:
        'Fetch and claim any open human feedback requests on a canvas. Feedback normally arrives automatically inside your other tool results, so you rarely need this — use it when you are specifically checking for feedback, e.g. an agent whose job is to poll the canvas every few minutes and address whatever humans have requested. Claiming assigns the requests to you: address each one, then review with get_frame_screenshot.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const fbs = actions.takeFeedbackFor(canvas_id, actorFrom(agent_name).name, undefined, ownerId)
      if (fbs.length === 0) return text({ feedback: [], note: 'No open feedback requests right now.' })
      const tasks = actions.getTasks(canvas_id)
      return text({
        feedback: fbs.map((f) => {
          const task = tasks.find((t) => t.id === f.taskId)
          return {
            from: f.from,
            text: f.text,
            about: task ? `${task.agentName}: “${task.status}”` : undefined,
            at: new Date(f.at).toISOString(),
          }
        }),
        note: "These requests are now assigned to you. Address each one (a human request overrides the don't-touch-others'-frames etiquette), review with get_frame_screenshot, and update your set_status.",
      })
    },
  )

  tool(
    'get_focus',
    {
      title: 'See what the humans are looking at',
      description:
        'What every connected human on this canvas is looking at right now: the frame, the element selector and the page, with how recently each moved. Use it when a human says "fix this" or "this one" — it is how you find out which element they mean. An empty humans array means nobody is connected, not an error.',
      annotations: { readOnlyHint: true },
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
      arrive(canvas_id, agent_name)
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
      return withFeedback(
        structured({ humans, latest: humans[0] ?? null }),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
    },
  )

  tool(
    'list_cards',
    {
      title: 'List board cards',
      description:
        "Open board cards on this canvas — work humans have queued for agents. Each card's text is the full prompt. Call take_card to claim one and work it, or get going on the queue. Structured import cards (GitHub recon) are handled by the resident team and never listed here.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName.optional(),
      },
      outputSchema: { cards: z.array(z.object(boardCardShape)), note: z.string().optional() },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const cards = actions
        .getTasks(canvas_id)
        .filter((t) => t.queuedBy && !t.agentName && !t.failedAt && !t.endedAt && !t.cancelledAt && !t.kind)
        .map((t) => ({
          id: t.id,
          title: t.status,
          queued_by: t.queuedBy,
          queued_at: new Date(t.startedAt).toISOString(),
          stage: t.stage ?? 0,
          waiting_for: roleName(actions.pipelineOf(t)[Math.min(t.stage ?? 0, actions.pipelineOf(t).length - 1)]),
          attachments: t.attachments ?? [],
          target_frames: t.targetFrameIds ?? [],
          ...(t.targetSelector ? { target_selector: t.targetSelector } : {}),
          ...(t.targetPageId ? { target_page_id: t.targetPageId } : {}),
        }))
      if (cards.length === 0) return structured({ cards: [], note: 'No open board cards right now.' })
      return structured({
        cards,
        note: 'Each card is a queued request from a human. take_card claims one and delivers its brief (plus reference-image attachments, if any).',
      })
    },
  )

  tool(
    'take_card',
    {
      title: 'Claim a board card',
      description:
        'Claim an open board card so you can work on it: the card moves to "in progress" under your name and the result carries the full brief. Reference-image attachments arrive as images in the result — they are source material; do not edit or delete those frames. target_frames are the frames the card is ABOUT: edit them in place. When done, call complete_card.',
      inputSchema: {
        card_id: z.string(),
        agent_name: agentName,
      },
    },
    async ({ card_id, agent_name }) => {
      const canvasId = actions.taskCanvasId(card_id)
      if (!canvasId) return err('not_found', `no card with id ${card_id}`)
      if (!canvasFor(canvasId)) return noCanvas(canvasId)
      arrive(canvasId, agent_name)
      actions.clearStop(canvasId, agent_name, ownerId)
      let card: AgentTask
      try {
        card = actions.claimCard(canvasId, card_id, agent_name)
      } catch (e) {
        return err(
          'conflict',
          e instanceof Error ? e.message : 'card not claimable (use list_cards to see what is open)',
        )
      }
      type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      const content: ResultBlock[] = [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              card: {
                id: card.id,
                title: card.status,
                queued_by: card.queuedBy,
                target_frames: card.targetFrameIds ?? [],
                ...(card.targetSelector ? { target_selector: card.targetSelector } : {}),
                ...(card.targetPageId ? { target_page_id: card.targetPageId } : {}),
              },
            },
            null,
            2,
          ),
        },
        {
          type: 'text',
          text: 'The card text above is your full brief. Reference-image attachments (if any) follow as images — source material, leave those frames alone. target_frames are what the card is ABOUT: edit them in place. Set your set_status, do the work, review with get_frame_screenshot, then complete_card.',
        },
      ]
      for (const id of card.attachments ?? []) {
        const f = frameFor(id)
        if (!f) {
          content.push({ type: 'text', text: `attachment frame ${id} not found on this canvas` })
          continue
        }
        try {
          const png = await renderFrame(f, 1)
          content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
          content.push({ type: 'text', text: `Attachment “${f.name}” (${f.width}×${f.height})` })
        } catch {
          content.push({
            type: 'text',
            text: `attachment frame ${id} could not be rendered — call get_frame_screenshot on it`,
          })
        }
      }
      return withFeedback({ content }, canvasId, actorFrom(agent_name))
    },
  )

  tool(
    'complete_card',
    {
      title: 'Complete a board card',
      description:
        'Mark a board card you claimed with take_card as done — it moves to the board\'s "done" column and everyone sees you finished. Pass summary for a one-line closing note in the activity feed. Only call this on a card you claimed; a card you cannot finish stays in progress until a human stops or retries it.',
      inputSchema: {
        card_id: z.string(),
        summary: z
          .string()
          .max(500)
          .optional()
          .describe(
            'One-line closing summary for the activity feed, e.g. "Pricing table redesigned, dark editorial style"',
          ),
        agent_name: agentName,
      },
    },
    async ({ card_id, summary, agent_name }) => {
      const canvasId = actions.taskCanvasId(card_id)
      if (!canvasId) return err('not_found', `no card with id ${card_id}`)
      if (!canvasFor(canvasId)) return noCanvas(canvasId)
      arrive(canvasId, agent_name)
      const card = actions.getTasks(canvasId).find((t) => t.id === card_id)
      if (!card) return err('not_found', `no card with id ${card_id}`)
      if (card.agentName !== agent_name)
        return err('forbidden', 'only the agent that claimed this card can complete it')
      const unverified = await reviewRefusal(canvasId, actorFrom(agent_name).name)
      if (unverified) return unverified
      if (summary?.trim()) actions.agentSummary(canvasId, actorFrom(agent_name), summary)
      const done = actions.completeCard(canvasId, card_id)
      if (!done || done.endedAt === undefined) return err('not_found', 'card not found or already closed')
      return withFeedback(
        text({
          ok: true,
          card: { id: done.id, title: done.status, completed_at: new Date(done.endedAt).toISOString() },
          note: 'Card closed. Set your status to "" (empty) so watchers see you are between tasks.',
        }),
        canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'create_frame',
    {
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
      return withGuidelinesNudge(
        withStatusNudge(withFeedback(result, canvas_id, actorFrom(agent_name)), canvas_id, actorFrom(agent_name)),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'create_page',
    {
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
      arrive(canvas_id, agent_name)
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
        withStatusNudge(
          withFeedback(
            structured(payload as { id: string; name: string; position: number }),
            canvas_id,
            actorFrom(agent_name),
          ),
          canvas_id,
          actorFrom(agent_name),
        ),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'rename_page',
    {
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
      arrive(found.canvas.id, agent_name)
      const page = actions.renamePage(page_id, pageName(name, 'Untitled'), actorFrom(agent_name))
      if (!page) return err('not_found', 'could not rename the page')
      return withGuidelinesNudge(
        withStatusNudge(
          withFeedback(
            text({ id: page.id, name: page.name, position: page.position }),
            found.canvas.id,
            actorFrom(agent_name),
          ),
          found.canvas.id,
          actorFrom(agent_name),
        ),
        found.canvas.id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'delete_page',
    {
      description:
        'Deletes the page AND every frame on it. The canvas keeps ≥1 page — deleting the last one is refused. Rescue frames you still need with move_frame first.',
      inputSchema: { page_id: z.string(), agent_name: agentName.optional() },
    },
    async ({ page_id, agent_name }) => {
      const found = pageForId(page_id)
      if (!found) return err('not_found', `no page with id ${page_id} accessible to this account`)
      arrive(found.canvas.id, agent_name)
      const result = actions.deletePage(page_id, actorFrom(agent_name))
      if (!result)
        return err(
          'invalid_input',
          'cannot delete the only page on this canvas — a canvas always keeps at least one page',
        )
      return withGuidelinesNudge(
        withStatusNudge(
          withFeedback(
            text({ ok: true, deletedPageId: result.page.id, deletedFrameIds: result.deletedFrameIds }),
            found.canvas.id,
            actorFrom(agent_name),
          ),
          found.canvas.id,
          actorFrom(agent_name),
        ),
        found.canvas.id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'move_frame',
    {
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
      arrive(f.canvasId, agent_name)
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
        withStatusNudge(
          withFeedback(
            text({
              ok: true,
              frame: frameSummary(
                frame,
                c?.pages?.find((p) => p.id === frame.pageId),
              ),
            }),
            f.canvasId,
            actorFrom(agent_name),
          ),
          f.canvasId,
          actorFrom(agent_name),
        ),
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'duplicate_frame',
    {
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
      arrive(f.canvasId, agent_name)
      const frame = actions.duplicateFrame(frame_id, { name, x, y }, actorFrom(agent_name))
      if (!frame) return err('not_found', 'could not duplicate the frame')
      const c = store.getCanvas(f.canvasId)
      return withGuidelinesNudge(
        withStatusNudge(
          withFeedback(
            text({
              ok: true,
              frame: frameSummary(
                frame,
                c?.pages?.find((p) => p.id === frame.pageId),
              ),
            }),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'get_frame',
    {
      description:
        'Get a frame including its full HTML content. Pass agent_name: it is how human feedback reaches you — a call without it never receives the notes people leave for you. On a large or imported frame prefer get_frame_html (a bounded slice or a query) and inspect_frame (the rendered result) over pulling the whole document.',
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
      arrive(f.canvasId, agent_name)
      /* A whole imported document in one result is the most common way an
         agent runs out of context mid-design — clamp and say so. */
      const truncated = f.html.length > MAX_HTML_READ_CHARS
      return withFeedback(
        structured({
          ...frameSummary(f),
          html: truncated ? f.html.slice(0, MAX_HTML_READ_CHARS) : f.html,
          ...(truncated
            ? {
                html_truncated: true,
                note: `HTML truncated at ${MAX_HTML_READ_CHARS} of ${f.html.length} characters. Read the rest with get_frame_html({ frame_id, offset, limit }) or query it with get_frame_html({ frame_id, query }).`,
              }
            : {}),
        }),
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'get_frame_history',
    {
      description:
        "List the saved versions of a frame, newest first — every durable write is snapshotted, so this is how you see what a frame looked like before an edit (yours or anyone else's) and pick a version to restore. Returns metadata only, never the HTML: read one version's document with get_frame_version, restore it with revert_frame.",
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)
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
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)
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
      return withFeedback(
        structured({ ok: true as const, frame: frameSummary(frame), restored_from: version_id }),
        frame.canvasId,
        actor,
      )
    },
  )

  tool(
    'undo_last_change',
    {
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

      return withStatusNudge(
        withFeedback(structured({ ok: true as const, frames: undone, skipped }), canvas_id, actor),
        canvas_id,
        actor,
      )
    },
  )

  tool(
    'begin_frame_edit',
    {
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
    'get_tokens',
    {
      title: 'Read the canvas design tokens',
      description:
        "The canvas's design tokens — the named colors, fonts, spacing scale and radii every frame on it should use — plus the ready-to-paste :root block. Read this BEFORE designing on an existing canvas: reusing its tokens is what makes a new frame look like it belongs. Returns null tokens when the canvas has none yet, in which case set them with set_tokens before you start.",
      annotations: { readOnlyHint: true },
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
      arrive(canvas_id, agent_name)
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
      return withFeedback(
        structured({ ok: true as const, tokens: stored, css: cssForTokens(stored) }),
        canvas_id,
        actor,
      )
    },
  )

  tool(
    'set_breakpoints',
    {
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
      return withFeedback(structured({ ok: true as const, breakpoints: stored }), canvas_id, actor)
    },
  )

  tool(
    'lint_frame',
    {
      title: 'Lint a frame against the design tokens',
      description:
        "Check the RENDERED frame for values that drift off the canvas's design tokens: colors that are not one of them, fonts outside the token set, and radii or spacing off the declared scales. Each violation names the selector, the value found, and the token it should have used. Run it after building a frame so the canvas stays coherent instead of accumulating near-miss shades and one-off paddings. With no tokens set it reports tokens_present: false rather than inventing a scale.",
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)
      const resolved = resolveViewport(device, viewport)
      const tokens = store.getCanvas(f.canvasId)?.tokens
      let report
      try {
        await progress(extra, 0, `Rendering “${f.name}” to check it against the canvas tokens…`)
        report = await lintFrame(f, tokens, resolved ? { viewport: resolved } : {})
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for linting')
      }
      const total = Object.values(report.counts).reduce((sum, n) => sum + n, 0)
      const nudge = report.tokens_present
        ? total > 0
          ? `${total} value(s) drift off the canvas tokens — read them with get_tokens and use those exact colors, fonts and scales so this frame matches the rest of the canvas.`
          : undefined
        : 'No design tokens on this canvas yet — define them with set_tokens so every frame shares one palette, type and scale.'
      return withFeedback(
        nudge ? structuredWithNudge(report, nudge) : structured(report),
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'audit_frame',
    {
      title: 'Audit a frame’s accessibility',
      description:
        'Check the RENDERED frame against the accessibility rules a design review is responsible for: text contrast (WCAG ratios, computed from the real composited background), image alt text, heading order, focus order and tabindex, tap-target sizes, landmarks, form labels and the document language. Each issue names the CSS selector to fix. Run it before calling a design done — contrast in particular is the checkpoint the review workflow asks you to judge, and this measures it instead of guessing. Pass device/viewport to audit the layout at a phone or tablet width.',
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)
      const resolved = resolveViewport(device, viewport) ?? (width ? { width, height: f.height } : undefined)
      let report: A11yReport
      try {
        await progress(extra, 0, `Rendering “${f.name}” for the audit…`)
        report = await auditFrame(f, {
          ...(resolved ? { viewport: resolved } : {}),
          ...(state ? { state } : {}),
        })
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
      return withFeedback(result, f.canvasId, actorFrom(agent_name))
    },
  )

  tool(
    'diff_frame',
    {
      title: 'Compare a frame against another render',
      description:
        "Measure how far a frame's CURRENT render is from another one, and see WHERE: a magenta-marked image plus the changed-pixel ratio. Compare against a previous version (get_frame_history), a pinned reference, another frame, or a live URL. Use it to confirm a fix actually landed, to check a redesign against the source it came from, or to match a pinned exemplar. identical: true means the two renders are the same design.",
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)

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
      return withFeedback(
        {
          content: [
            { type: 'image' as const, data: diff.diff_png.toString('base64'), mimeType: 'image/png' },
            { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
          ],
          structuredContent: payload,
        },
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'inspect_frame',
    {
      title: 'Inspect a rendered frame',
      description:
        "Inspect the RENDERED page instead of its source: a compact semantic element outline with each element's CSS selector, the visible text, geometry, and the computed colors, typography, radii, shadows and CSS variables actually in effect. Use this instead of get_frame on large or imported frames — it is a fraction of the size and shows what the design really looks like. Pair it with get_frame_screenshot for layout.",
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)
      try {
        const resolved = resolveViewport(device, viewport)
        return withFeedback(
          structured(await inspectFrame(f, resolved ? { viewport: resolved } : {})),
          f.canvasId,
          actorFrom(agent_name),
        )
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
      annotations: { readOnlyHint: true },
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
      arrive(f.canvasId, agent_name)
      const read = readFrameHtml(f.html, { query, offset, limit })
      if ('error' in read) return err('invalid_input', read.error)
      return withFeedback(
        {
          content: [{ type: 'text' as const, text: read.text }],
          structuredContent: { frame_id, html_bytes: f.html.length, text: read.text },
        },
        f.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'set_frame_html',
    {
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
        withStatusNudge(
          withFeedback(
            withEscapeNote(structuredWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE), html),
            frame.canvasId,
            actorFrom(agent_name),
          ),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'set_frame_css',
    {
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
      return withStatusNudge(
        withFeedback(
          structured({ ok: true as const, frame: frameSummary(frame), css_bytes: css.length }),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'get_frame_css',
    {
      title: 'Read the frame stylesheet',
      description:
        "Read back the frame's own stylesheet (the <style data-doop-css> block), or an empty string when it has none. Read it before set_frame_css if you are adding to what is already there — set_frame_css replaces the whole block.",
      annotations: { readOnlyHint: true },
      inputSchema: { frame_id: z.string(), agent_name: agentName.optional() },
      outputSchema: { css: z.string() },
    },
    async ({ frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      const budget = takeRender(agent_name)
      if (budget) return budget
      try {
        return withFeedback(
          structured(await getFrameCss(f)),
          f.canvasId,
          agent_name ? actorFrom(agent_name) : undefined,
        )
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
      annotations: { readOnlyHint: true },
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
      arrive(canvas_id, agent_name)
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
      return withFeedback(structured({ results }), canvas_id, agent_name ? actorFrom(agent_name) : undefined)
    },
  )

  tool(
    'export_frame',
    {
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
      /* the only read tool that was missing agent_name: without it a call
         cannot deliver pending human feedback, so an agent could export in a
         loop and never hear the human telling it what is wrong */
      arrive(f.canvasId, agent_name)
      const actor = agent_name ? actorFrom(agent_name) : undefined
      if (format === 'html') return withFeedback(structured({ format: 'html', html: f.html }), f.canvasId, actor)

      if (format === 'spec') {
        /* this renders a Chromium page, like every other render tool */
        const budget = takeRender()
        if (budget) return budget
        const probe = await specProbe(f)
        if (!probe) return err('upstream_failed', 'could not render this frame to measure it')
        const [report] = await persist.listFrameReviews(frame_id, 1)
        return withFeedback(
          structured({ format: 'spec', spec_md: specMd(f, report, probe, canvasFor(f.canvasId)?.tokens) }),
          f.canvasId,
          actor,
        )
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
        return withFeedback(
          structured({
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
                ? [
                    `${react.external.length} third-party URL(s) stay external: ${react.external.slice(0, 5).join(', ')}`,
                  ]
                : []),
            ],
          }),
          f.canvasId,
          actor,
        )
      }

      const ext = format === 'jpg' ? 'jpg' : 'png'
      const q = ext === 'jpg' ? `&quality=${quality ?? 90}` : ''
      return withFeedback(
        structured({
          format: ext,
          image_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}`,
          download_url: `${PUBLIC_ORIGIN}/i/${frame_id}.${ext}?scale=2${q}&download`,
          width: f.width * 2,
          height: f.height * 2,
          note: 'Public URL, no auth needed. To publish: fetch the URL and upload the bytes to the target platform (e.g. WordPress POST /wp/v2/media), or hotlink it directly — it always shows the current design.',
        }),
        f.canvasId,
        actor,
      )
    },
  )

  tool(
    'export_canvas',
    {
      title: 'Export a whole canvas',
      description:
        "Hand a canvas to a human's machine in one piece. format: 'manifest' returns the frame list with file names and the canvas tokens. format: 'html' returns one self-contained document containing every frame, with each frame's stylesheet scoped to it (frames that style html/body or use :root are noted, since that cannot be scoped perfectly). format: 'zip' returns the same document plus every frame's original HTML as an archive, base64-encoded so you can write it to disk and unzip it.",
      inputSchema: {
        canvas_id: z.string(),
        page: z.string().optional().describe('Only frames on this page (name or id, from get_canvas)'),
        format: z
          .enum(['html', 'manifest', 'zip', 'tokens'])
          .optional()
          .describe(
            'default manifest; "tokens" returns the design tokens as JSON + plain CSS + a Tailwind v4 @theme block',
          ),
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
        archive_base64: z.string().optional(),
        bytes: z.number().optional(),
        notes: z.array(z.string()),
      },
    },
    async ({ canvas_id, page, format, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      if (agent_name) arrive(canvas_id, agent_name)
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
      return structured({
        format: 'zip',
        ...base,
        filename: `${base.filename}.zip`,
        archive_base64: archive.toString('base64'),
        bytes: archive.length,
        notes: [
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
            ? [
                `${externalInExport.length} third-party URL(s) stay external: ${externalInExport.slice(0, 5).join(', ')}`,
              ]
            : []),
          ...(bundle.fontsCss ? ['fonts.css carries the frames’ @font-face rules and linked stylesheets.'] : []),
          'archive_base64 is a ZIP file: decode it and write it to disk, then unzip.',
        ],
      })
    },
  )

  tool(
    'upload_asset',
    {
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
        return withFeedback(
          text({
            ok: true,
            upload_url,
            command: `curl -sS -T "<path-to-your-file>" ${upload_url}`,
            expires_at: new Date(expiresAt).toISOString(),
            note: 'One-time upload URL (single use, 15 min). Run the curl command in your shell with your real file path — its JSON response contains the permanent public url to use in frame HTML. Request a fresh ticket for each file.',
          }),
          canvas_id,
          actorFrom(agent_name),
        )
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
        return withFeedback(structured(payload), canvas_id, actorFrom(agent_name))
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'upload failed')
      }
    },
  )

  tool(
    'search_images',
    {
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
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, orientation, count, canvas_id, agent_name }) => {
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'photo search failed')
      }
    },
  )

  tool(
    'list_backgrounds',
    {
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
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, tone, style, slot, count, canvas_id, agent_name }) => {
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'background search failed')
      }
    },
  )

  tool(
    'search_icons',
    {
      title: 'Search icons',
      description:
        'Search 200,000+ open-source UI icons (Iconify: Material, Lucide, Tabler, Phosphor, …) and get hotlinkable SVG URLs for frame HTML. Search one concept per call ("shopping cart", "arrow right") — multi-concept queries return nothing; call once per icon. Results are semantically named ids — pick by name. For company/brand logos use search_logos instead.',
      inputSchema: {
        query: z.string().describe('A single icon concept, e.g. "light bulb"'),
        limit: z.number().min(1).max(48).optional().describe('Max results, default 24'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, limit, canvas_id, agent_name }) => {
      try {
        const icons = await imageSearch.searchIcons(query, { limit })
        const result = text({
          ok: true,
          icons,
          ...(icons.length === 0 ? { note: `No results for "${query}" — try a synonym or broader concept.` } : {}),
          usage: imageSearch.ICON_USAGE_NOTE,
        })
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'icon search failed')
      }
    },
  )

  tool(
    'search_logos',
    {
      title: 'Search company logos',
      description:
        'Find a company\'s logo by brand name or domain — returns the company\'s real mark as a hotlinkable URL (a thumbnail is included when possible so you can confirm the brand), plus open-source vector marks (SVG) for well-known brands. One company per call — for a logo wall, call once per brand. The exact domain ("acme.io") resolves far more reliably than a name ("Acme"). Use for customer-logo walls, "works with" integration rows, testimonial cards, press bars. Mind each result\'s size guidance: favicon-sourced logos are small rasters — never scale them up.',
      inputSchema: {
        query: z.string().describe('A single company name or domain, e.g. "vercel.com"'),
        count: z.number().min(1).max(8).optional().describe('Candidates to return, default 5'),
        canvas_id: z.string().optional().describe('The canvas you are designing on (lets human feedback reach you)'),
        agent_name: agentName,
      },
    },
    async ({ query, count, canvas_id, agent_name }) => {
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
        return canvas_id ? withFeedback(result, canvas_id, actorFrom(agent_name)) : result
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
      annotations: { readOnlyHint: true, openWorldHint: true },
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

        /* as_reference: the page is source material, not a frame to keep — pin
           it to Memory and take the frame back off the canvas, so a reference
           import never litters the board with the thing it references. */
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
          return withStatusNudge(withFeedback({ content }, canvas_id, actor), canvas_id, actor)
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
        return withStatusNudge(withFeedback(result, canvas_id, actor), canvas_id, actor)
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
            createdAt: 0,
            updatedAt: 0,
            updatedBy: actor.name,
          })
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
      return withFeedback(
        structured({
          tokens: system.tokens,
          markdown,
          evidence: system.evidence as unknown as Record<string, unknown>,
          notes: system.notes,
          applied: !!apply,
        }),
        canvas_id,
        actor,
      )
    },
  )

  tool(
    'get_frame_content',
    {
      title: 'Read a frame as structured content',
      description:
        'Read what a frame SAYS, separately from how it looks: title and meta description, the heading outline with selectors, sections with their text, nav links, calls to action with hrefs, form fields with their labels, and images with their alt text and real pixel size. Use this on an imported page or an existing frame before rewriting its copy, and to check that a design has real content rather than placeholders.',
      annotations: { readOnlyHint: true },
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
      arrive(canvas_id, agent_name)
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
        'Read the state of a job started by import_site: status, how many pages are done, and each page’s frame id or the reason it failed. Poll this until status is done or failed.',
      annotations: { readOnlyHint: true },
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
        ...(job.error ? { error: job.error } : {}),
        results: job.results,
      })
    },
  )

  tool(
    'get_frame_screenshot',
    {
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
      arrive(f.canvasId, agent_name)
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
        const width = resolved?.width ?? f.width
        const height = resolved?.height ?? f.height
        return withFeedback(
          {
            content: [
              { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text' as const,
                text: `Screenshot of “${f.name}” (${width}×${height}@${scale ?? 1}x${full_page ? ', full page' : ''}${clip ? `, clip ${clip.x},${clip.y} ${clip.width}×${clip.height}` : ''}${state ? `, ${stateLabel(state)}` : ''}, html ${f.html.length} bytes)`,
              },
            ],
          },
          f.canvasId,
          actorFrom(agent_name),
        )
      } catch (e) {
        if (e instanceof StateRenderError) return err(e.code, e.message)
        return err('upstream_failed', `screenshot failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  )

  tool(
    'append_frame_html',
    {
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
      return withStatusNudge(
        withFeedback(nudged, frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'edit_frame_html',
    {
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
      return withStatusNudge(
        withFeedback(
          textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE),
          frame.canvasId,
          actorFrom(agent_name),
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
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
      annotations: { readOnlyHint: true },
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
      return withStatusNudge(
        withFeedback(
          outcome.ambiguous.length
            ? structuredWithNudge(
                payload,
                `these selectors matched more than one element and every match was changed: ${outcome.ambiguous.join(', ')} — use a tighter selector if that was not what you meant`,
              )
            : structured(payload),
          canvas_id,
          actorFrom(agent_name),
        ),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'insert_element',
    {
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
      return withStatusNudge(
        withFeedback(
          structured({ ok: true as const, frame: frameSummary(frame), selector: outcome.selector }),
          canvas_id,
          actorFrom(agent_name),
        ),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'delete_element',
    {
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
      return withStatusNudge(
        withFeedback(structured({ ok: true as const, frame: frameSummary(frame) }), canvas_id, actorFrom(agent_name)),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'update_frame',
    {
      description: 'Update frame metadata: rename it or move/resize it on the canvas.',
      inputSchema: {
        frame_id: z.string(),
        name: z.string().max(200).optional(),
        x: z.number().min(-1_000_000).max(1_000_000).optional(),
        y: z.number().min(-1_000_000).max(1_000_000).optional(),
        width: z.number().min(1).max(20_000).optional(),
        height: z.number().min(1).max(20_000).optional(),
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
      return withFeedback(text({ ok: true, frame: frameSummary(frame) }), frame.canvasId, actorFrom(agent_name))
    },
  )

  tool(
    'delete_frame',
    {
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
    'delete_frame',
    'duplicate_frame',
    'revert_frame',
    'undo_last_change',
    'create_page',
    'rename_page',
    'delete_page',
    'add_comment',
    'set_guidelines',
    'save_decision',
    'set_tokens',
    'set_status',
    'update_elements',
    'insert_element',
    'delete_element',
    'restore_release',
    'publish_canvas',
    'unpublish_canvas',
  ])

  /* Ops whose effect is a line in a log a human may already have read — a
     comment, a decision, a status. A failed batch cannot take those back, so it
     names them in `not_rolled_back` instead of pretending it undid them. Every
     other batchable op changes canvas content, which the pre-image restores. */
  const APPEND_ONLY_OPS: Record<string, true> = { add_comment: true, save_decision: true, set_status: true }

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
   *  appended comments, decisions and status lines are `not_rolled_back`.
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
    /* A frame the batch deleted comes back through createFrame, which mints a
       new id — the old one went with the frame. Named here so the caller is
       not left looking for an id that no longer exists. */
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
        const back = actions.createFrame(canvasId, { ...was }, actor)
        if (back) {
          restored.push(back.id)
          recreated.push({ name: was.name, from: id, to: back.id })
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
    'set_plan',
    {
      title: 'Publish your plan for this canvas',
      description:
        'Record the steps you intend to work through, in order, so the human watching can see the plan and a later session (or a compacted context) can pick up where you left off. Use it when a task needs more than about three frames or ten tool calls. Re-publishing keeps the progress of steps whose text is unchanged, and marks new or changed steps pending again.',
      inputSchema: {
        canvas_id: z.string(),
        steps: z
          .array(z.object({ id: z.string().max(64), text: z.string().max(200) }))
          .min(1)
          .max(20)
          .describe('Ordered steps: a short stable id plus what the step does'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), plan: planShape },
    },
    async ({ canvas_id, steps, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      try {
        return withFeedback(
          structured({ ok: true as const, plan: actions.setPlan(canvas_id, actor.name, steps, actor) }),
          canvas_id,
          actor,
        )
      } catch (e) {
        return err('invalid_input', e instanceof Error ? e.message : 'invalid plan')
      }
    },
  )

  tool(
    'update_plan_step',
    {
      title: 'Move a step of your plan',
      description:
        'Mark a plan step active when you start it, done when it is finished, blocked when you cannot continue. Update as you go — that is what makes the plan useful to the human watching and to a session that resumes later. An optional note records what you learned or what is blocking you.',
      inputSchema: {
        canvas_id: z.string(),
        step_id: z.string().describe('The step id you passed to set_plan'),
        status: z.enum(['pending', 'active', 'done', 'blocked']),
        note: z.string().max(500).optional().describe('Short note for yourself and the human'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), plan: planShape },
    },
    async ({ canvas_id, step_id, status, note, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      let plan
      try {
        plan = actions.updatePlanStep(canvas_id, actor.name, step_id, status, note, actor)
      } catch (e) {
        return err('invalid_input', e instanceof Error ? e.message : 'invalid note')
      }
      if (!plan) return err('not_found', `no plan step “${step_id}” for ${actor.name} on this canvas`)
      return withFeedback(structured({ ok: true as const, plan }), canvas_id, actor)
    },
  )

  tool(
    'get_plan',
    {
      title: 'Read the plans on this canvas',
      description:
        'Every plan published on this canvas, newest first — your own and any other agent working here. Call it after a context compaction, or when you join a canvas another agent is already working on, to see what has been done and what is next.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName.optional(),
      },
      outputSchema: { plans: z.array(planShape) },
    },
    async ({ canvas_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (agent_name) arrive(canvas_id, agent_name)
      return structured({ plans: actions.getPlans(canvas_id) })
    },
  )

  tool(
    'apply_ops',
    {
      title: 'Apply several edits in one call',
      annotations: { readOnlyHint: false },
      description:
        'Run a sequence of Doop edits in one round trip: create frames, write their HTML, position them, comment, update status. Each op is `{ op: "<tool name>", ...that tool\'s arguments }` — the same fields the named tool takes (see its own schema). Use this to lay out a multi-frame flow, or to apply a review pass across several frames, instead of paying a round trip per call. Ops run in array order; with atomic: false (the default) a failing op is reported at its index and the rest still run, while atomic: true validates every op first and applies nothing if any would fail — and if an op still fails while applying (another agent took a lock in between), the batch stops and the ops that landed are rolled back from a pre-image taken before the first one: the error reports `rolled_back`, `restored` and how many ops landed before it. Appended comments, decisions and status lines cannot be taken back, and are named in `not_rolled_back`. With dry_run: true nothing is written at all: every op is validated, each op that can diff its own write returns `diff`, `bytes_before` and `bytes_after`, and the rest report that they cleared pre-flight.',
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
                    'set_status',
                    'update_elements',
                    'insert_element',
                    'delete_element',
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
                  .map((f) => `“${f.name}” came back as ${f.to} (a deleted frame cannot keep its id)`)
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
           steering the individual tool added (feedback, review nudge) — keep
           those, because they are how the human's words reach the agent */
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
           cleanup cannot take back (comments, decisions, status). */
        ...(firstFailure === -1
          ? {}
          : {
              applied_before_failure: results.slice(0, firstFailure).filter((r) => r.ok).length,
              not_rolled_back: results.filter((r) => r.ok && APPEND_ONLY_OPS[r.op]).map((r) => r.index),
            }),
      }
      const summary = `${payload.applied} of ${results.length} op(s) applied${payload.failed ? `, ${payload.failed} failed — see the results array for the index and reason` : ''}`
      return withFeedback(
        {
          content: [
            { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
            ...(nudges.length ? [{ type: 'text' as const, text: nudges.join('\n\n') }] : []),
            ...(payload.failed ? [{ type: 'text' as const, text: summary }] : []),
          ],
          structuredContent: payload,
        },
        canvas_id,
        actor,
      )
    },
  )

  /* ---- resources ----
     A client can attach a canvas as context without spending a tool call on it,
     which is what makes Doop usable from a chat client that reads resources.
     Every read resolves through the same canvasFor closure the tools use, so
     canAccessCanvas stays the single authorization answer. */
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
      title: 'Get server capabilities',
      description:
        'Which optional integrations are actually configured on this server (screenshot renderer, image/icon/logo search, website capture, model accounts for the resident agent, GitHub), plus the current size and rate limits. Call it ONCE before planning asset-heavy, import-heavy or export-heavy work: it is how you know a feature is available instead of discovering a failure mid-task.',
      inputSchema: {},
      outputSchema: { capabilities: z.record(z.unknown()) },
    },
    async () => {
      const caps = capabilities()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(caps, null, 2) }],
        structuredContent: { capabilities: caps },
      }
    },
  )

  /* ---- ask_human: the blocking question ---- */

  tool(
    'ask_human',
    {
      title: 'Ask the human a question',
      description:
        'Ask the humans on this canvas a question and WAIT for the answer (up to the wait_seconds you pass). Use it when a request is genuinely ambiguous or implies a destructive choice you cannot settle from the canvas — which palette direction, whether replacing a whole frame is intended, whether to delete something. Pass choices (2–6 short options) when the answer is one of a few directions: the client asks with those options, and the canvas shows them as buttons. When your client supports questions in its own UI the user is asked there and you get the answer directly (status "answered", via "elicitation"); otherwise the question appears live on the canvas and in the Review panel for the humans in the room. Either way the exchange is recorded on the canvas. If the wait expires you get status "open" plus the question id — carry on with your best judgement and check get_answers later, and do not ask the same question twice. Do not use it for information the canvas already answers.',
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
      arrive(canvas_id, agent_name)
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
      const events =
        waitMs > 0
          ? await agentEvents.wait(canvas_id, {
              agentName: actorFrom(agent_name).name,
              cursor: 0,
              timeoutMs: Math.min(waitMs, remaining),
              kinds: ['question_answer'],
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
      return structured({
        question_id: question.id,
        status: 'open' as const,
        ...(question.choices?.length ? { choices: question.choices } : {}),
        ...(question.multi ? { multi: true } : {}),
        hint: 'Nobody answered yet. Continue with your best judgement; check get_answers later for this question_id.',
      })
    },
  )

  tool(
    'get_answers',
    {
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
      arrive(canvas_id, agent_name)
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

  /* ---- wait_for_events: the idle keep-alive ---- */

  tool(
    'wait_for_events',
    {
      title: 'Wait for human events',
      description:
        'Block until something on this canvas needs you: task feedback, a comment, a stop, an answer to your question, or a new queued card. Pass the cursor from your previous call to only see newer events; an empty cursor means everything pending. Between tasks, call this instead of ending your session — it also keeps your presence alive so the humans see you connected and your claimed card is not swept. Resolves on the first event or on timeout (whichever comes first); a timeout is normal, just call again.',
      inputSchema: {
        canvas_id: z.string(),
        cursor: z
          .number()
          .optional()
          .describe('Cursor from your previous wait_for_events (or get 0 for "everything pending")'),
        timeout_seconds: z.number().min(5).max(120).optional().describe('How long to block, default 60'),
        agent_name: agentName,
      },
      outputSchema: {
        cursor: z.number(),
        timed_out: z.boolean(),
        events: z.array(z.object({ seq: z.number(), kind: z.string(), at: z.number(), summary: z.string() })),
      },
    },
    async ({ canvas_id, cursor, timeout_seconds, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const actor = actorFrom(agent_name)
      /* while parked the agent is legitimately idle: the 60s status TTL
         applies, not the 20s idle sweep, and presence stays live */
      actions.heartbeatAgent(canvas_id, actor)
      actions.markAgentWaiting(canvas_id, actor.name, true)
      const from = cursor ?? agentEvents.cursor(canvas_id)
      const timeoutMs = Math.min(120, Math.max(5, timeout_seconds ?? 60)) * 1000
      const events = await agentEvents.wait(canvas_id, { agentName: actor.name, cursor: from, timeoutMs })
      const visible = events
        .filter((e) => !e.targetAgent || e.targetAgent.toLowerCase() === actor.name.toLowerCase())
        .slice(-20)
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
      title: 'Propose new frame HTML for review',
      description:
        'Propose a full replacement design for a frame WITHOUT touching the canvas. Use it when the canvas is in review mode (direct writes fail with "review mode"); the proposal appears in the human Review panel with a side-by-side render, and lands on the canvas the moment a human accepts. Include a clear summary: it is the first thing the reviewer reads. If the frame changes before your proposal is reviewed, it is marked stale and you will see it in list_change_proposals.',
      inputSchema: {
        canvas_id: z.string(),
        frame_id: z.string(),
        html: z.string().describe(`Full replacement HTML. Max ${MAX_FRAME_HTML_BYTES} characters.`),
        summary: z.string().max(500).describe('One line: what changes and why the reviewer should accept it'),
        expected_updated_at: z.string().optional().describe('The frame updatedAt you based this on (baseUpdatedAt)'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), proposal_id: z.string(), status: z.string() },
    },
    async ({ canvas_id, frame_id, html, summary, expected_updated_at, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id || !canvasFor(canvas_id)) return noFrame(frame_id)
      if (tooLarge(html))
        return err('too_large', `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}.`)
      arrive(canvas_id, agent_name)
      if (!store.getCanvas(canvas_id)?.reviewMode)
        return err('unsupported', 'review mode is off on this canvas — write directly with set_frame_html instead')
      const base = expected_updated_at ? Date.parse(expected_updated_at) : f.updatedAt
      const proposal = actions.addFrameProposal(
        canvas_id,
        { kind: 'replace_html', frameId: frame_id, html, summary, ...(Number.isFinite(base) ? {} : {}) },
        actorFrom(agent_name),
      )
      if (!proposal) return noFrame(frame_id)
      return structured({ ok: true as const, proposal_id: proposal.id, status: proposal.status })
    },
  )

  tool(
    'propose_frame_create',
    {
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
      arrive(canvas_id, agent_name)
      if (!store.getCanvas(canvas_id)?.reviewMode)
        return err('unsupported', 'review mode is off on this canvas — write directly with create_frame instead')
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
      arrive(canvas_id, agent_name)
      if (!store.getCanvas(canvas_id)?.reviewMode)
        return err('unsupported', 'review mode is off on this canvas — write directly with delete_frame instead')
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
      arrive(canvas_id, agent_name)
      const proposals = actions.getFrameProposals(canvas_id, status).map((p) => ({
        proposal_id: p.id,
        kind: p.kind,
        ...(p.frameId ? { frame_id: p.frameId } : {}),
        summary: p.summary,
        status: p.status,
        at: new Date(p.at).toISOString(),
        base_updated_at: new Date(p.baseUpdatedAt).toISOString(),
        ...(p.resolvedBy ? { resolved_by: p.resolvedBy } : {}),
        ...(p.resolutionNote ? { resolution_note: p.resolutionNote } : {}),
      }))
      return structured({ proposals })
    },
  )

  tool(
    'withdraw_proposal',
    {
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
      arrive(canvas_id, agent_name)
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

  /* ---- review_frame: one call, every viewport ---- */

  tool(
    'review_frame',
    {
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
    async ({ canvas_id, frame_id, device, agent_name }) => {
      const budget = takeRender(agent_name)
      if (budget) return budget

      const canvas = canvasFor(canvas_id)
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id || !canvas) return noFrame(frame_id)
      arrive(canvas_id, agent_name)
      /* the canvas's breakpoints are the widths this design claims to support,
         so they are reviewed on top of the device presets rather than instead
         of them — a named width is what makes a finding attributable */
      const breakpoints = canvas.breakpoints ?? []
      const report = await reviewFrame(f, canvas.tokens, {
        ...(device ? { viewports: [VIEWPORTS[device]] } : {}),
        ...(breakpoints.length ? { breakpoints } : {}),
      })
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

  /* ---- import_code: the design→code→design round trip ---- */

  tool(
    'import_code',
    {
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
      arrive(canvas_id, agent_name)
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
      return withFeedback(await withOp, canvas_id, actor)
    },
  )

  /* ---- assets: list and look at what the canvas already has ---- */

  tool(
    'list_assets',
    {
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
      arrive(canvas_id, agent_name)
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
      arrive(canvas_id, agent_name)
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

  /* ---- open_pull_request: the repo handoff ---- */

  tool(
    'open_pull_request',
    {
      title: 'Open a pull request with the canvas design',
      description:
        'Hand the design to a developer: write the exported frames (design/<frame-name>.html, tokens.css, README) to a branch in a connected GitHub repo and open a pull request. Requires a GitHub connection with contents:write and pull_requests:write. Check get_capabilities first — github is "none" when no connection is configured.',
      inputSchema: {
        canvas_id: z.string(),
        repo: z.string().describe('owner/name'),
        branch: z.string().optional().describe('Defaults to doop/<canvas-id>'),
        base: z.string().optional().describe("PR target branch; defaults to the repo connection's own branch"),
        message: z.string().max(200).describe('PR title'),
        release_id: z
          .string()
          .optional()
          .describe('Hand off this frozen release instead of the live frames — the PR then matches the link you sent'),
        op_id: opId,
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), branch: z.string(), commit: z.string(), url: z.string() },
    },
    async ({ canvas_id, repo, branch, base, message, release_id, agent_name, op_id }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const actor = actorFrom(agent_name)
      const withOp = replayAsync(ownerId ?? '', op_id ?? '', async () => {
        const gated = reviewGate(canvas_id)
        if (gated) return gated
        let files
        if (release_id) {
          const release = await persist.getRelease(release_id)
          if (!release || release.canvasId !== canvas_id)
            return err('not_found', `no release ${release_id} on this canvas`)
          files = await designHandoffFiles(c, {
            frames: persist.releaseFrames(release),
            ...(release.tokens ? { tokens: release.tokens } : {}),
          })
        } else {
          files = await designHandoffFiles(c)
        }
        try {
          /* canvasId scopes the credential lookup to this canvas's
             connections: a handoff can never spend another canvas's token. */
          const result = await commitFiles({
            repo,
            branch: branch ?? `doop/${canvas_id}`,
            ...(base ? { base } : {}),
            files,
            message,
            canvasId: canvas_id,
          })
          return structured({ ok: true as const, branch: result.branch, commit: result.commit, url: result.url })
        } catch (e) {
          if (e instanceof GithubWriteError) return err(e.code, e.message)
          return err(codeFor(e), e instanceof Error ? e.message : 'the GitHub handoff failed')
        }
      })
      return withFeedback(await withOp, canvas_id, actor)
    },
  )

  tool(
    'get_pull_request_review',
    {
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
      arrive(canvas_id, agent_name)
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

  /* ---- hand_back: send a card to the specialty that owns it ---- */

  tool(
    'ready_for_review',
    {
      title: 'Check a frame and record the result',
      description:
        'Run the full quality gate on a frame — token conformance, accessibility, layout and content checks at mobile, tablet and desktop widths — and RECORD the result against the exact document it checked. Call this on every frame you changed before complete_card or hand_back: those refuse a delivery whose frames you changed and did not verify. Returns verdict "pass" or "fail" with the blocking findings and their selectors. Fix them and call it again; a report is only valid for the document it was made from, so any later edit means checking again.',
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
    async ({ canvas_id, frame_id, agent_name }) => {
      const f = frameFor(frame_id)
      if (!f || f.canvasId !== canvas_id) return noFrame(frame_id)
      const budget = takeRender(agent_name)
      if (budget) return budget
      arrive(canvas_id, agent_name)
      const report = await reviewFrame(f, canvasFor(canvas_id)?.tokens)
      await persist.saveFrameReview(reviewToRecord(report, canvas_id, actorFrom(agent_name).name))
      return withFeedback(
        structured({
          verdict: report.verdict,
          frame_id: report.frame_id,
          html_sha: report.html_sha,
          reviewed_at: report.reviewed_at,
          blocking: report.blocking,
          failing_viewports: report.failing_viewports,
          summary: report.summary,
        }),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  /* ---- releases: the frozen handoff artifact ---- */

  tool(
    'create_release',
    {
      title: 'Freeze the canvas as a release',
      description:
        'Snapshot every frame as it is right now and return a public, permanent preview URL (/p/<canvas>/<release>). Frames keep changing afterwards, so a handoff needs a frozen artifact: send this URL to a client, attach it to a pull request (open_pull_request accepts release_id) or point a listing at it. The snapshot is stored whole — later edits, renames and deletions on the canvas never change it. Restoring it later is possible with restore_release.',
      inputSchema: {
        canvas_id: z.string(),
        name: z.string().max(120).optional().describe('A label for this release, e.g. "v2 — pricing review"'),
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
    async ({ canvas_id, name, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const frames = c.frames.filter((f) => !f.demo)
      if (frames.length === 0) return err('not_found', 'this canvas has no frames to release')
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
      if (agent_name) arrive(canvas_id, agent_name)
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
    'restore_release',
    {
      title: 'Put a release’s frames back on the canvas',
      description:
        'Write a release’s frames back onto the live canvas, as ordinary edits: each frame is written through the same path as any other edit, so the restore is logged, streamed to the room and reversible frame by frame with get_frame_history + revert_frame. Frames that no longer exist are recreated; frames added after the release are left alone.',
      inputSchema: {
        canvas_id: z.string(),
        release_id: z.string(),
        agent_name: agentName,
      },
      outputSchema: {
        restored: z.array(z.object({ frame_id: z.string(), name: z.string(), created: z.boolean() })),
        skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
      },
    },
    async ({ canvas_id, release_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const release = await persist.getRelease(release_id)
      if (!release || release.canvasId !== canvas_id) return err('not_found', `no release ${release_id} on this canvas`)
      const actor = actorFrom(agent_name)
      const restored: { frame_id: string; name: string; created: boolean }[] = []
      const skipped: { name: string; reason: string }[] = []
      for (const snapshot of release.frames) {
        const live = store.getFrame(snapshot.id)
        if (!live) {
          /* through actions, like every other creation: the room has to see
             the frame appear, and review mode has to be able to refuse it */
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
        if (live.html === snapshot.html) {
          skipped.push({ name: snapshot.name, reason: 'already matches the release' })
          continue
        }
        try {
          actions.updateFrame(
            snapshot.id,
            { html: snapshot.html, name: snapshot.name, width: snapshot.width, height: snapshot.height },
            actor,
          )
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
      return withFeedback(structured({ restored, skipped }), canvas_id, actor)
    },
  )

  /* ---- publishing ---- */

  tool(
    'publish_canvas',
    {
      title: 'List the canvas in the community gallery',
      description:
        'Publish this canvas to the Doop community gallery with a short description and a shelf. Owner-only. The gallery hands out previews and copies — never the source canvas or a seat in its room. Pass release_id to publish the frozen snapshot instead of the live frames.',
      inputSchema: {
        canvas_id: z.string(),
        description: z.string().max(280).optional(),
        category: z.enum(COMMUNITY_CATEGORIES).describe('gallery shelf the canvas is listed under'),
        release_id: z.string().optional().describe('Publish this release rather than the live canvas'),
        agent_name: agentName,
      },
      outputSchema: { published_at: z.number(), description: z.string().optional(), category: z.string() },
    },
    async ({ canvas_id, description, category, release_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
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
      title: 'Take the canvas out of the gallery',
      description: 'Remove this canvas from the community gallery. Owner-only.',
      inputSchema: { canvas_id: z.string(), agent_name: agentName },
      outputSchema: { ok: z.literal(true) },
    },
    async ({ canvas_id, agent_name }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const result = unpublishCanvas(c, { id: ownerId, name: actorFrom(agent_name).name })
      if (!result.ok) return err(result.status === 403 ? 'forbidden' : 'not_found', result.error)
      return structured({ ok: true as const })
    },
  )

  tool(
    'hand_back',
    {
      title: 'Hand a card back to an earlier specialist',
      description:
        'Give a board card back to an agent with the specialty it needs (e.g. the copywriter or the layout specialist) instead of fixing it outside your lane. The reason is shown to the human and to the receiving agent. Only roles that are part of the card pipeline can receive it.',
      inputSchema: {
        canvas_id: z.string(),
        card_id: z.string(),
        to_agent: z.string().describe('Role name from get_agents, e.g. copywriter'),
        reason: z.string().max(500).describe('Why this belongs to the other specialty'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), stage: z.number() },
    },
    async ({ canvas_id, card_id, to_agent, reason, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      arrive(canvas_id, agent_name)
      const unverified = await reviewRefusal(canvas_id, actorFrom(agent_name).name)
      if (unverified) return unverified
      const card = await actions.handBackCard(canvas_id, card_id, to_agent, reason, actorFrom(agent_name))
      if (!card) return err('not_found', `no open card with id ${card_id} on this canvas`)
      if (!card.handback)
        return err(
          'invalid_input',
          `"${to_agent}" is not a stage of this card's pipeline — check the card's pipeline in get_canvas or list your roles with get_agents`,
        )
      return structured({ ok: true as const, stage: card.stage ?? 0 })
    },
  )

  /* ---- run lifecycle: what a run changed, its timeline, and the run undo ---- */

  /* The run timeline ring holds 500 events per canvas; one read of the whole
     ring is what makes the cursor a plain offset, with no server-side state. */
  const RUN_EVENT_SCAN = 500
  /* A journal is written at teardown, after the run's own writes. A frame
     updated later than the journal by more than this is someone else's work,
     and a revert must not discard it. */
  const REVERT_RUN_GRACE_MS = 5_000

  tool(
    'get_run_changes',
    {
      title: 'What a run changed',
      description:
        "A run's change set: the frames it touched, each with the version it started from and the one it produced, plus the run's summary and the decisions it recorded. Pick the run with run_id (from get_run_events) or card_id (from list_cards). Empty frames means the run recorded no frame changes. Undo the whole set with revert_run.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        canvas_id: z.string(),
        run_id: z.string().optional().describe('A run id from get_run_events or get_run_changes'),
        card_id: z.string().optional().describe('A board card id from list_cards — resolves the run that worked it'),
        agent_name: agentName.optional(),
      },
    },
    async ({ canvas_id, run_id, card_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (!run_id && !card_id) return err('invalid_input', 'pass run_id or card_id to pick the run')
      if (agent_name) arrive(canvas_id, agent_name)
      const journal = actions.getRunJournalBy(canvas_id, {
        ...(run_id ? { runId: run_id } : {}),
        ...(card_id ? { cardId: card_id } : {}),
      })
      if (!journal)
        return err(
          'not_found',
          `no run journal for ${run_id ? `run ${run_id}` : `card ${card_id}`} on this canvas — read the timeline with get_run_events`,
        )
      /* the decisions blob is a JSON string the resident wrote: hand it back
         parsed when it is valid JSON, so a reader does not have to parse it */
      let decisions: unknown
      if (journal.decisions !== undefined) {
        try {
          decisions = JSON.parse(journal.decisions)
        } catch {
          decisions = journal.decisions
        }
      }
      const journalRunId = journal.runId ?? journal.id
      return structured({
        run_id: journalRunId,
        ...(journal.cardId ? { card_id: journal.cardId } : {}),
        agent: journal.agentName,
        summary: journal.summary,
        frames: (journal.frames ?? []).map((entry) => ({
          frame_id: entry.frameId,
          name: entry.name,
          ...(entry.beforeVersionId ? { before_version_id: entry.beforeVersionId } : {}),
          ...(entry.afterVersionId ? { after_version_id: entry.afterVersionId } : {}),
        })),
        ...(decisions !== undefined ? { decisions } : {}),
      })
    },
  )

  tool(
    'get_run_events',
    {
      title: 'Read a run’s timeline',
      description:
        'The run timeline, newest first: one entry per model turn, tool call, status line, error and stop, with its agent, outcome and duration. Filter to one run with run_id, or read the canvas’s whole recent history. Page with cursor: pass the previous next_offset back as cursor.',
      annotations: { readOnlyHint: true },
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
      if (agent_name) arrive(canvas_id, agent_name)
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
        })),
        total_shown: events.length,
        has_more: next < all.length,
        ...(next < all.length ? { next_offset: next } : {}),
      })
    },
  )

  tool(
    'revert_run',
    {
      title: 'Undo everything a run changed',
      description:
        'Put every frame a run changed back to the version it started from — the run-level undo, for a redesign that went wrong. Read the change set with get_run_changes first. A frame someone else has edited since the run, or deleted since, is skipped and reported instead of being clobbered.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        canvas_id: z.string(),
        run_id: z.string().describe('The run to undo, from get_run_changes or get_run_events'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, run_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      const gated = reviewGate(canvas_id)
      if (gated) return gated
      const journal = actions.getRunJournalBy(canvas_id, { runId: run_id })
      if (!journal) return err('not_found', `no run journal for ${run_id} on this canvas`)
      const actor = actorFrom(agent_name)
      const entries = journal.frames ?? []
      if (entries.length === 0)
        return withFeedback(
          structured({ reverted: [], skipped: [], note: 'this run recorded no frame changes' }),
          canvas_id,
          actor,
        )
      const reverted: string[] = []
      const skipped: { frame_id: string; reason: string }[] = []
      for (const entry of entries) {
        if (!entry.beforeVersionId) {
          skipped.push({ frame_id: entry.frameId, reason: 'no starting version was recorded for this frame' })
          continue
        }
        const frame = store.getFrame(entry.frameId)
        if (!frame || frame.canvasId !== canvas_id) {
          skipped.push({ frame_id: entry.frameId, reason: 'the frame no longer exists' })
          continue
        }
        if (frame.updatedAt > journal.at + REVERT_RUN_GRACE_MS) {
          skipped.push({
            frame_id: entry.frameId,
            reason: `changed after the run by ${frame.updatedBy} — reverting would discard that work`,
          })
          continue
        }
        try {
          const restored = await actions.revertFrame(entry.frameId, entry.beforeVersionId, actor)
          if (!restored) {
            skipped.push({ frame_id: entry.frameId, reason: 'the recorded version is no longer stored' })
            continue
          }
          reverted.push(entry.frameId)
        } catch (e) {
          const conflict = lockConflict(e)
          if (!conflict) throw e
          skipped.push({
            frame_id: entry.frameId,
            reason: `still locked by another agent — ${conflict.content[0]?.text}`,
          })
        }
      }
      return withFeedback(
        structured({
          reverted,
          skipped,
          note: reverted.length
            ? `${reverted.length} frame(s) restored to their pre-run version.`
            : 'nothing was reverted — see skipped for why.',
        }),
        canvas_id,
        actor,
      )
    },
  )

  /* Pausing acts on another account's agent only for the canvas owner and its
     members — the same rule stop_work applies, since an agent name is typed by
     the caller and two accounts can both be running a "Claude". */
  const foreignAgentRefusal = (c: Canvas, canvasId: string, target: string) => {
    const targetOwners = new Set(
      actions
        .getTasks(canvasId)
        .filter((t) => t.agentName === target && !t.endedAt && !t.cancelledAt && t.ownerId !== undefined)
        .map((t) => t.ownerId as string),
    )
    const foreign = [...targetOwners].some((id) => id !== ownerId)
    const privileged = ownerId !== undefined && (c.ownerId === ownerId || (c.memberIds ?? []).includes(ownerId))
    if (!foreign || privileged) return undefined
    return err('forbidden', `${target} belongs to another account — only the canvas owner or a member can pause it`, {
      target_agent: target,
      hint: 'pause your own agent, or ask the canvas owner to pause that one',
    })
  }

  tool(
    'pause_work',
    {
      title: 'Pause an agent’s run',
      description:
        "Pause an agent's live run without losing its card: the model call aborts, its frame locks are released, and the card goes back to the queue paused instead of failed — resume_work re-claims it, and the run's journal carries the context forward. Pass target_agent to pause another agent (the name you see on the canvas), or omit it to pause yourself.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName,
        target_agent: z
          .string()
          .optional()
          .describe('The agent to pause, as named on the canvas. Omit to pause your own run.'),
      },
    },
    async ({ canvas_id, agent_name, target_agent }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      const target = (target_agent ?? agent_name).trim()
      if (!target)
        return err('invalid_input', 'target_agent is empty — name the agent to pause, or omit it to pause yourself')
      const denied = foreignAgentRefusal(c, canvas_id, target)
      if (denied) return denied
      const paused = actions.pauseAgentWork(canvas_id, target, actorFrom(agent_name).name)
      return structured({
        ok: paused > 0,
        paused_agent: target,
        cards_paused: paused,
        note:
          paused > 0
            ? `${target} was paused. Its card stays open and paused — resume_work re-claims it, and the run's journal carries the context forward.`
            : `${target} had no live card on this canvas to pause.`,
      })
    },
  )

  tool(
    'resume_work',
    {
      title: 'Resume a paused card',
      description:
        "Resume a card a human (or pause_work) paused: the pause clears and the canvas's resident sweep re-fires, so the card is claimed again. Continuity is journal-based — the interrupted message transcript is not replayed, the run's journal and plan are what survive.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        canvas_id: z.string(),
        card_id: z.string().describe('The paused card, from list_cards'),
        agent_name: agentName,
      },
    },
    async ({ canvas_id, card_id, agent_name }) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      if (actions.taskCanvasId(card_id) !== canvas_id)
        return err('not_found', `no card with id ${card_id} on this canvas`)
      const before = actions.getTasks(canvas_id).find((t) => t.id === card_id)
      if (!before) return err('not_found', `no card with id ${card_id} on this canvas`)
      const wasPaused = before.pausedAt !== undefined
      const card = actions.resumeCard(canvas_id, card_id, actorFrom(agent_name).name)
      if (!card) return err('not_found', `no card with id ${card_id} on this canvas`)
      return structured({
        ok: true as const,
        card_id: card.id,
        resumed: wasPaused,
        status: card.status,
        stage: card.stage ?? 0,
        note: wasPaused
          ? 'the card is queued again — the next sweep claims it'
          : 'the card was not paused; nothing changed',
      })
    },
  )

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

/** The base name a frame gets in the handoff, deduped by id when two frames
 *  in the exported set share a name so neither overwrites the other. */
function handoffFileName(frame: Frame, exported: Frame[]): string {
  const safe = (name: string) =>
    name
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'frame'
  const base = safe(frame.name)
  /* the set being exported, not the live canvas: a handoff pinned to a release
     can carry frames that were renamed or deleted since */
  const clash = exported.filter((f) => safe(f.name) === base)
  return clash.length > 1 ? `${base}-${frame.id}` : base
}

/** Everything a developer needs from a canvas, as repository files: each
 *  frame's document, its React component and its build spec, the design system
 *  in three forms, and the assets that could travel as text.
 *
 *  Rendering is required (JSX and specs come from the browser), so this is
 *  async; a frame that cannot be rendered still ships its HTML and says so. */
async function designHandoffFiles(
  c: Canvas,
  opts: { frames?: Frame[]; pageId?: string; tokens?: DesignTokens } = {},
): Promise<{ path: string; content: string }[]> {
  const tokens = opts.tokens ?? c.tokens
  const frames = (opts.frames ?? c.frames.filter((f) => !f.demo)).filter(
    (f) => opts.pageId === undefined || f.pageId === opts.pageId,
  )
  const notes: string[] = []
  const perFrame: { path: string; content: string }[] = []

  for (const frame of frames) {
    const name = handoffFileName(frame, frames)
    const assets = rewriteAssetUrls(frame.html, './')
    perFrame.push({ path: `design/${name}.html`, content: assets.html })
    for (const url of assets.external) {
      if (!notes.includes(url)) notes.push(url)
    }
    try {
      const react = await htmlToReact(frame.html, { name: frame.name, tokens, frameId: frame.id })
      perFrame.push({ path: `design/${name}.jsx`, content: rewriteAssetUrls(react.jsx, './').html })
    } catch {
      notes.push(`no React component for design/${name}.html: the frame could not be rendered`)
    }
    try {
      const probe = await probeFrame(frame)
      const [report] = await persist.listFrameReviews(frame.id, 1)
      perFrame.push({ path: `design/${name}.spec.md`, content: specMd(frame, report, probe, tokens) })
    } catch {
      notes.push(`no spec for design/${name}.html: the frame could not be rendered to measure it`)
    }
  }

  /* assets that are text (SVG, CSS) travel with the branch; binary ones cannot
     go through the commit API as text, so they are named for the developer */
  const binaries: string[] = []
  for (const id of [...new Set(frames.flatMap((f) => [...assets.extractAssetIds(f.html)]))]) {
    const asset = await assets.getCanvasAsset(c.id, id)
    if (!asset) {
      notes.push(`asset ${id} could not be read and is not in this handoff`)
      continue
    }
    const file = asset.url.replace(/^\/a\//, '')
    const text = decodeText(asset.data)
    if (text === undefined) {
      binaries.push(`design/assets/${file}`)
      continue
    }
    perFrame.push({ path: `design/assets/${file}`, content: text })
  }

  return [
    ...perFrame,
    ...(tokens
      ? [
          { path: 'design/tokens.css', content: cssForTokens(tokens) },
          { path: 'design/tokens.dtcg.json', content: tokensDtcg(tokens) },
          { path: 'design/tailwind.css', content: tailwindThemeCss(tokens) },
        ]
      : []),
    {
      path: 'design/DESIGN.md',
      content: designMd(tokens, c, (frame) => `design/${handoffFileName(frame, frames)}.html`),
    },
    { path: 'design/AGENTS.md', content: agentsMd(c, `${PUBLIC_ORIGIN}/mcp`) },
    {
      path: 'design/README.md',
      content: [
        '# Design handoff',
        '',
        `Exported from doop canvas \`${c.id}\` (${c.name}).`,
        '',
        'Each `design/*.html` is a self-contained frame document; open it in a browser to see the design.',
        'The matching `.jsx` is the same design as a React component and `.spec.md` is its build spec:',
        'measurements, the type ramp, the colors, the structure outline and the verification report it passed.',
        '`tokens.dtcg.json` is the design system in W3C Design Tokens form; `DESIGN.md` is the same system in prose.',
        '',
        ...(binaries.length
          ? [
              'These image assets could not be committed as text — add them next to the frames at the same path:',
              ...binaries.map((path) => `- ${path}`),
              '',
            ]
          : []),
        ...(notes.length
          ? ['Third-party URLs these frames load (not bundled):', ...notes.map((url) => `- ${url}`), '']
          : []),
      ].join('\n'),
    },
  ]
}

/** The asset's bytes as text, or undefined when they are not valid UTF-8 —
 *  which is what decides whether a file can go through the commit API. */
function decodeText(data: Buffer): string | undefined {
  const text = data.toString('utf8')
  return text.includes('\uFFFD') ? undefined : text
}

/** Stateless streamable-HTTP MCP endpoint. */
export async function handleMcpRequest(req: Request, res: Response) {
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
  const server = buildMcpServer(owner, session.userId ?? undefined, session.clientId ?? undefined)
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
