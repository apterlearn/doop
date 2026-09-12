import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Request, Response } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import { z } from 'zod'
import { store } from './store.ts'
import * as persist from './db/persist.ts'
import * as actions from './actions.ts'
import { canAccessCanvas } from './access.ts'
import { auth, getUserName, isBanned, PUBLIC_ORIGIN } from './auth.ts'
import { capture, captureThrottled } from './analytics.ts'
import { MAX_HTML_READ_CHARS, readFrameHtml, renderFrame, VIEWPORTS } from './screenshot.ts'
import { inspectFrame } from './domProbe.ts'
import { auditFrame, type A11yReport } from './a11y.ts'
import { diffFrames } from './visualDiff.ts'
import { cssForTokens, lintFrame } from './designLint.ts'
import { DOOP_GUIDE, guideFor, GUIDE_TOPICS } from './guide.ts'
import { describeInspiration, INSPIRATION_USAGE_NOTE, searchInspiration } from './inspiration.ts'
import { ESCAPED_HTML_NOTE, looksEscapedHtml } from './escapedHtml.ts'
import { describeSyncFlow, getSyncFlow } from './ingest.ts'
import * as assets from './assets.ts'
import * as imageSearch from './imageSearch.ts'
import * as backgrounds from './backgrounds.ts'
import { viewWebsite } from './website.ts'
import { createImportedWebpageFrame } from './webpageImport.ts'
import { importPage, normalizeImportUrl } from './importer.ts'
import { websiteAccessErrorMessage } from './websiteAccess.ts'
import { MAX_FRAME_HTML_BYTES } from './limits.ts'
import { roleName } from '../shared/agents.ts'
import { err, mcpErrorPayload, type McpErrorPayload } from './mcpErrors.ts'
import * as frameLocks from './frameLocks.ts'
import { replay, replayAsync } from './opIds.ts'
import { htmlBundle, htmlToReact } from './codeExport.ts'
import { buildZip } from './zip.ts'
import { recordToolCall } from './mcpStats.ts'
import type { AgentTask, CanvasView, ElementComment, Frame, Page } from '../shared/types.ts'

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
  frameLocks.releaseAll(frameId)
  frameLocks.acquire(frameId, canvasId, actor.name, actor.owner)
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
  const lines = pending.map((f) => {
    const task = tasks.find((t) => t.id === f.taskId)
    const mine = task && task.agentName === actor.name
    const about = task ? ` (about ${mine ? 'your' : `${task.agentName}’s`} work: “${task.status}”)` : ''
    return `- ${f.from}${about}: ${f.text}`
  })
  result.content.push({
    type: 'text' as const,
    text: `HUMAN FEEDBACK — open request(s) on this canvas, now assigned to YOU:\n${lines.join('\n')}\nAddress this NOW, before continuing your plan: locate the frame in question (get_canvas / get_frame), make the change, and review with get_frame_screenshot. If it concerns another agent's frame, edit it anyway — a human request overrides the don't-touch-others'-frames etiquette. Update your set_status to say what you're picking up.`,
  })
  return result
}

const STOPPED_NOTE =
  'STOPPED — a human stopped your work on this canvas. Stop now: do not call any more frame tools and do not start new work. Reply with one short sentence about where you left off. The work is not lost — a human can retry the card.'

/** Tells an agent its work was stopped. Fires on every call until the next run
 *  clears the record, so a long agent session cannot miss it. */
function withStopped<T extends { content: { type: 'text' | 'image'; [k: string]: unknown }[] }>(
  result: T,
  canvasId: string,
  actor?: Actor,
): T {
  if (!actor) return result
  if (!actions.wasStopped(canvasId, actor.name, actor.ownerId)) return result
  result.content.push({ type: 'text' as const, text: STOPPED_NOTE })
  return result
}

/* upload rate limit per connecting user, mirroring the page-import route */
const uploadHits = new Map<string, number[]>()
const UPLOADS_PER_MIN = 15

/* photo search burns the shared Pexels quota (200 req/hour on the free tier) */
const searchHits = new Map<string, number[]>()
const SEARCHES_PER_MIN = 12

/* importing writes a potentially large HTML frame, so keep it at the same
   conservative per-user rate as the browser UI's import endpoint */
const importHits = new Map<string, number[]>()
const IMPORTS_PER_MIN = 5

/* One definition of "check this at a phone width": the screenshot, inspection
   and audit tools must agree on what mobile/tablet/desktop mean. */
const deviceName = z
  .enum(['mobile', 'tablet', 'desktop'])
  .optional()
  .describe('Render at a device preset (mobile 390x844, tablet 834x1112, desktop 1440x900) instead of the frame\'s own size')
const viewportOverride = z
  .object({ width: z.number().int().min(1).max(20_000), height: z.number().int().min(1).max(20_000) })
  .optional()
  .describe('Explicit viewport, overriding device and the frame size')

const opId = z
  .string()
  .max(120)
  .optional()
  .describe(
    'Idempotency key: a retry of the same call with the same op_id returns the original result instead of creating a second one. Use a fresh value per intended create.',
  )

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
  agents: z.array(z.object({ name: z.string(), owner: z.string().optional(), lastAt: z.number().optional() })).optional(),
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

const commentShape = {
  id: z.string(),
  canvasId: z.string(),
  frameId: z.string(),
  selector: z.string(),
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
}

/* The three agent HTML write paths share one ceiling: a frame is stored whole,
   broadcast whole, and rendered whole, so an unbounded document costs every
   viewer and every later reader, not just the caller. */
function tooLarge(html: string): boolean {
  return html.length > MAX_FRAME_HTML_BYTES
}

function frameSummary(f: {
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
}, page?: { name: string }) {
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

/** owner is the connecting user's display name (for attribution); ownerId is
 *  their user id — canvases the agent creates or lists are scoped to it, the
 *  same isolation the web UI gets. */
export function buildMcpServer(owner?: string, ownerId?: string): McpServer {
  const actorFrom = (agent_name?: string) =>
    actions.resolveActor({ name: agent_name, kind: 'agent', owner, ownerId })
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
  const server = new McpServer({ name: 'doop-canvas', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  /* Every tool call lands here: one place that records outcome and latency for
     the whole surface, so the 43 handlers stay readable. It also keeps each
     tool's own input schema and handler, which is what lets apply_ops batch a
     tool without restating its arguments anywhere. */
  type RegisterTool = McpServer['registerTool']
  type ToolHandler = (args: never, extra: never) => Promise<CallToolResult>
  interface RegisteredTool {
    inputSchema: z.ZodRawShape
    run: ToolHandler
  }
  const registry = new Map<string, RegisteredTool>()
  const tool = ((name: string, config: never, cb: never) => {
    const cfg = config as unknown as { inputSchema?: z.ZodRawShape }
    registry.set(name, {
      inputSchema: cfg.inputSchema ?? {},
      run: cb as unknown as ToolHandler,
    })
    return server.registerTool(name as never, config, (async (args: never, extra: never) => {
      const started = Date.now()
      try {
        const result = await (cb as unknown as ToolHandler)(args, extra)
        recordToolCall(name, !result?.isError, Date.now() - started)
        return result
      } catch (e) {
        recordToolCall(name, false, Date.now() - started, 'internal')
        throw e
      }
    }) as never)
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
          ? [
              'This canvas has design tokens — read them with get_tokens and use those exact colors, fonts and scales.',
            ]
          : []),
      ]
      const view: CanvasView = {
        id: c.id,
        name: c.name,
        frames: shown.map((f) => frameSummary(f, c.pages?.find((p) => p.id === f.pageId))),
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
        tokens_present: !!c.tokens,
        ...(notes.length ? { note: notes.join(' ') } : {}),
      }
      return withFeedback(
        structured(view),
        canvas_id,
        agent_name ? actorFrom(agent_name) : undefined,
      )
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
          frames: frames.map((f) => frameSummary(f, c.pages?.find((p) => p.id === f.pageId))),
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
      return withStopped(
        withFeedback(
          text({ ok: true, status: status.trim() || null, agents_working_now: others }),
          canvas_id,
          actorFrom(agent_name),
        ),
        canvas_id,
        actorFrom(agent_name),
      )
    },
  )

  tool(
    'stop_work',
    {
      description:
        "Stop an agent's work on a canvas — for when a run is going wrong: a redesign that drifted from the brief, work on the wrong frame, or an agent looping. Pass target_agent to stop another agent (the name you see on the canvas), or omit it to stop yourself. Its live stream closes and its board card is marked stopped instead of failed, so a human can retry it. Frames already written stay on the canvas and are yours to edit. Use this instead of deleting a frame out from under a working agent.",
      annotations: { destructiveHint: true },
      inputSchema: {
        canvas_id: z.string(),
        agent_name: agentName,
        target_agent: z
          .string()
          .optional()
          .describe('The agent to stop, as named on the canvas. Omit to stop your own run.'),
      },
    },
    async ({ canvas_id, agent_name, target_agent }) => {
      const c = canvasFor(canvas_id)
      if (!c) return noCanvas(canvas_id)
      /* ?? keeps an empty string: a blank target must not fall back to
         agent_name or worse, abort whatever run happens to be live */
      const target = (target_agent ?? agent_name).trim()
      if (!target) return err('invalid_input', 'target_agent is empty — name the agent to stop, or omit it to stop yourself')
      /* An agent name is typed by the caller, so stopping "Claude" must not
         stop a different account's Claude. The canvas owner and its members
         may stop anyone on their canvas; everyone else only their own agent. */
      const foreign = actions
        .getTasks(canvas_id)
        .some((t) => t.agentName === target && t.ownerId !== undefined && t.ownerId !== ownerId && !t.endedAt && !t.cancelledAt)
      const privileged = ownerId !== undefined && (c.ownerId === ownerId || (c.memberIds ?? []).includes(ownerId))
      if (foreign && !privileged)
        return err('forbidden', `${target} belongs to another account — only the canvas owner or a member can stop it`, {
          target_agent: target,
          hint: 'stop your own agent, or ask the canvas owner to stop that one',
        })
      const stopped = actions.cancelAgentWork(canvas_id, target, actorFrom(agent_name).name, ownerId)
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
      const comments = all.slice(offset, offset + limit)
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
        snippet: z.string().max(10_000).optional().describe("The element's outerHTML excerpt, for context"),
        text: z.string().max(10_000).describe('The comment text'),
        op_id: opId,
        agent_name: agentName,
      },
    },
    async ({ frame_id, selector, snippet, text: body, agent_name, op_id }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const payload = replay(ownerId ?? '', op_id, () => {
        const comment = actions.addElementComment(
          frame_id,
          { selector, snippet: snippet ?? '', text: body },
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
        return err('invalid_input', 'the thread is resolved or the text is empty — resolve_comment cannot be undone by replying')
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
        return err('conflict', e instanceof Error ? e.message : 'card not claimable (use list_cards to see what is open)')
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
      return withStopped(withFeedback({ content }, canvasId, actorFrom(agent_name)), canvasId, actorFrom(agent_name))
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
      if (card.agentName !== agent_name) return err('forbidden', 'only the agent that claimed this card can complete it')
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
          frame: frameSummary(frame, c.pages?.find((p) => p.id === frame.pageId)),
        }
      })
      if (!payload.ok) return noCanvas(canvas_id)
      const result = withEscapeNote(
        html.length > 0 ? structuredWithNudge(payload, REVIEW_NUDGE) : structured(payload),
        html,
      )
      return withGuidelinesNudge(
        withStatusNudge(
          withStopped(withFeedback(result, canvas_id, actorFrom(agent_name)), canvas_id, actorFrom(agent_name)),
          canvas_id,
          actorFrom(agent_name),
        ),
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
          withStopped(
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
          withStopped(
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
        return err('invalid_input', 'cannot delete the only page on this canvas — a canvas always keeps at least one page')
      return withGuidelinesNudge(
        withStatusNudge(
          withStopped(
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
          withStopped(
            withFeedback(
              text({ ok: true, frame: frameSummary(frame, c?.pages?.find((p) => p.id === frame.pageId)) }),
              f.canvasId,
              actorFrom(agent_name),
            ),
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
          withStopped(
            withFeedback(
              text({ ok: true, frame: frameSummary(frame, c?.pages?.find((p) => p.id === frame.pageId)) }),
              frame.canvasId,
              actorFrom(agent_name),
            ),
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
        "Read one saved version of a frame in full, including its HTML — the document to compare against or to restore with revert_frame. Get version ids from get_frame_history.",
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
        "Restore a frame to a version from get_frame_history. The restore is an ordinary edit — everyone sees it land live, it is logged, and it becomes a new version itself, so a revert is never a dead end. Use this instead of rebuilding a frame that was better before: an agent that made it worse, or a redesign you want to undo.",
      inputSchema: {
        frame_id: z.string(),
        version_id: z.string().describe('Version id from get_frame_history'),
        expected_updated_at: z
          .string()
          .optional()
          .describe("The frame's updatedAt from when you read it — refuses the revert if someone else changed it since"),
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
          { html: version.html, name: version.name, x: version.x, y: version.y, width: version.width, height: version.height },
          actor,
        )
      } catch (e) {
        const conflict = lockConflict(e)
        if (conflict) return conflict
        throw e
      }
      if (!frame) return noFrame(frame_id)
      return withStopped(
        withFeedback(
          structured({ ok: true as const, frame: frameSummary(frame), restored_from: version_id }),
          frame.canvasId,
          actor,
        ),
        frame.canvasId,
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
      const lock = frameLocks.acquire(frame_id, f.canvasId, actor.name, actor.owner, (ttl_seconds ?? 120) * 1000)
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
      const released = frameLocks.release(frame_id, actorFrom(agent_name).name)
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
            'Fold these values into the existing tokens instead of replacing them: colors and fonts merge key by key, spacing/radii/shadows replace the whole list when given',
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
            }
          : tokens
      try {
        actions.setTokens(canvas_id, { ...next, updatedAt: 0, updatedBy: actor.name }, actor)
      } catch (e) {
        return err('invalid_input', e instanceof Error ? e.message : 'invalid tokens')
      }
      const stored = store.getCanvas(canvas_id)!.tokens!
      return withFeedback(
        structured({ ok: true as const, tokens: stored, css: cssForTokens(stored) }),
        canvas_id,
        actor,
      )
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
        "Check the RENDERED frame against the accessibility rules a design review is responsible for: text contrast (WCAG ratios, computed from the real composited background), image alt text, heading order, focus order and tabindex, tap-target sizes, landmarks, form labels and the document language. Each issue names the CSS selector to fix. Run it before calling a design done — contrast in particular is the checkpoint the review workflow asks you to judge, and this measures it instead of guessing. Pass device/viewport to audit the layout at a phone or tablet width.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        frame_id: z.string(),
        device: deviceName,
        viewport: viewportOverride,
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
      },
    },
    async ({ frame_id, device, viewport, agent_name }, extra) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      const resolved = resolveViewport(device, viewport)
      let report: A11yReport
      try {
        await progress(extra, 0, `Rendering “${f.name}” for the audit…`)
        report = await auditFrame(f, resolved ? { viewport: resolved } : {})
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render this frame for audit')
      }
      const nudge =
        report.counts.critical > 0
          ? `${report.counts.critical} critical issue(s) — the review checkpoints require contrast you can defend. Fix these in the frame HTML and run audit_frame again.`
          : undefined
      const result = nudge ? structuredWithNudge(report, nudge) : structured(report)
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
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const keys = Object.keys(against).filter((k) => against[k as keyof typeof against] !== undefined)
      if (keys.length !== 1)
        return err('invalid_input', `pass exactly one of frame_id, version_id, reference_id or url — got ${keys.length}`)
      arrive(f.canvasId, agent_name)

      let other: Frame | undefined
      let label: string
      if (against.frame_id !== undefined) {
        other = frameFor(against.frame_id)
        if (!other) return noFrame(against.frame_id)
        label = `frame ${other.name}`
      } else if (against.version_id !== undefined) {
        const version = await persist.getFrameVersion(against.version_id)
        if (!version) return err('not_found', `no frame version with id ${against.version_id}`)
        if (version.frameId !== frame_id)
          return err('invalid_input', `version ${against.version_id} belongs to frame ${version.frameId}, not ${frame_id}`)
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
            websiteAccessErrorMessage(e, 'connected-agent') ?? (e instanceof Error ? e.message : 'could not capture that URL'),
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
          .describe(`Full replacement HTML. Max ${MAX_FRAME_HTML_BYTES} characters — stream larger designs with append_frame_html.`),
        expected_updated_at: z
          .string()
          .optional()
          .describe('The frame\'s updatedAt from when you read it — refuses the write if someone else changed it since'),
        takeover: z.boolean().optional().describe('Overwrite even if another agent holds the frame lock'),
        agent_name: agentName,
      },
      outputSchema: { ok: z.literal(true), frame: z.object(frameSummaryShape) },
    },
    async ({ frame_id, html, agent_name, expected_updated_at, takeover }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      if (tooLarge(html))
        return err(
          'too_large',
          `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}. Stream the design with append_frame_html instead.`,
        )
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
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
          withStopped(
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
        ),
        frame.canvasId,
        actorFrom(agent_name),
      )
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
        format: z.enum(['png', 'jpg', 'html', 'react']).optional().describe('default png'),
        quality: z.number().min(1).max(100).optional().describe('jpg only, default 90'),
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
        tokens_css: z.string().optional(),
        notes: z.array(z.string()).optional(),
        note: z.string().optional(),
      },
    },
    async ({ frame_id, format, quality }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      if (format === 'html') return structured({ format: 'html', html: f.html })

      if (format === 'react') {
        let exported
        try {
          exported = await htmlToReact(f.html, f.name, store.getCanvas(f.canvasId)?.tokens)
        } catch (e) {
          return err('upstream_failed', e instanceof Error ? e.message : 'could not convert this frame to React')
        }
        return structured({ format: 'react', ...exported })
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
      title: 'Export a whole canvas',
      description:
        "Hand a canvas to a human's machine in one piece. format: 'manifest' returns the frame list with file names and the canvas tokens. format: 'html' returns one self-contained document containing every frame, with each frame's stylesheet scoped to it (frames that style html/body or use :root are noted, since that cannot be scoped perfectly). format: 'zip' returns the same document plus every frame's original HTML as an archive, base64-encoded so you can write it to disk and unzip it.",
      inputSchema: {
        canvas_id: z.string(),
        page: z.string().optional().describe('Only frames on this page (name or id, from get_canvas)'),
        format: z.enum(['html', 'manifest', 'zip']).optional().describe('default manifest'),
        agent_name: agentName.optional(),
      },
      outputSchema: {
        format: z.string(),
        filename: z.string(),
        frames: z.array(z.object({ id: z.string(), name: z.string(), file: z.string(), width: z.number(), height: z.number() })),
        tokens_css: z.string(),
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
      const base = {
        filename: `${c.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'canvas'}.doop`,
        frames: manifest,
        tokens_css: tokens ? cssForTokens(tokens) : '',
      }
      if (format === undefined || format === 'manifest')
        return structured({ format: 'manifest', ...base, notes: [] })

      if (format === 'html') {
        let bundle
        try {
          bundle = await htmlBundle(frames, tokens)
        } catch (e) {
          return err('upstream_failed', e instanceof Error ? e.message : 'could not render the frames for export')
        }
        return structured({ format: 'html', ...base, filename: `${base.filename}.html`, html: bundle.html, notes: bundle.notes })
      }

      let bundle
      try {
        bundle = await htmlBundle(frames, tokens)
      } catch (e) {
        return err('upstream_failed', e instanceof Error ? e.message : 'could not render the frames for export')
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
      ].join('\n')
      const archive = buildZip([
        { name: 'canvas.html', content: bundle.html },
        { name: 'README.md', content: index },
        ...(tokens ? [{ name: 'tokens.css', content: cssForTokens(tokens) }] : []),
        ...frames.map((f, index) => ({
          name: `frames/${manifest[index]!.file}`,
          content: f.html,
          time: f.updatedAt,
        })),
      ])
      return structured({
        format: 'zip',
        ...base,
        filename: `${base.filename}.zip`,
        archive_base64: archive.toString('base64'),
        bytes: archive.length,
        notes: [...bundle.notes, 'archive_base64 is a ZIP file: decode it and write it to disk, then unzip.'],
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
        'Import ONE public webpage into a canvas as an editable HTML snapshot. The rendered DOM is captured, scripts/iframes are removed, stylesheets are inlined, and the resulting source frame appears on the canvas for comparison or editing. Use this when a referenced or redesign-target page should be visible to everyone; leave the imported source frame unchanged and make the new design in a separate frame. For inspection without changing the canvas, use view_website.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      inputSchema: {
        url: z.string().describe('The page URL — a bare domain like "acme.io" is loaded over https'),
        canvas_id: z.string().describe('Canvas that should receive the imported source frame'),
        agent_name: agentName,
      },
    },
    async ({ url, canvas_id, agent_name }, extra) => {
      if (!canvasFor(canvas_id)) return noCanvas(canvas_id)
      await progress(extra, 0, `Fetching ${url}…`)
      let normalizedUrl: string
      try {
        normalizedUrl = normalizeImportUrl(url).href
      } catch (e) {
        return err('invalid_input', e instanceof Error ? e.message : 'invalid webpage URL')
      }
      const now = Date.now()
      const limitKey = ownerId ?? agent_name
      const hits = (importHits.get(limitKey) ?? []).filter((t) => now - t < 60_000)
      if (hits.length >= IMPORTS_PER_MIN) return err('rate_limited', 'webpage import rate limit — wait a minute')
      hits.push(now)
      importHits.set(limitKey, hits)
      try {
        const actor = actorFrom(agent_name)
        const { imported, frame } = await createImportedWebpageFrame({
          canvasId: canvas_id,
          url: normalizedUrl,
          actor,
          includePreview: true,
        })
        if (!frame) return noCanvas(canvas_id)

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
        full_page: z.boolean().optional().describe('Capture the whole document height, not just the viewport'),
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
    async ({ frame_id, scale, device, viewport, full_page, clip, agent_name }, extra) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      arrive(f.canvasId, agent_name)
      await progress(extra, 0, `Rendering “${f.name}”…`)
      const resolved = resolveViewport(device, viewport)
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
        })
        const width = resolved?.width ?? f.width
        const height = resolved?.height ?? f.height
        return withFeedback(
          {
            content: [
              { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
              {
                type: 'text' as const,
                text: `Screenshot of “${f.name}” (${width}×${height}@${scale ?? 1}x${full_page ? ', full page' : ''}${clip ? `, clip ${clip.x},${clip.y} ${clip.width}×${clip.height}` : ''}, html ${f.html.length} bytes)`,
              },
            ],
          },
          f.canvasId,
          actorFrom(agent_name),
        )
      } catch (e) {
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
        takeover: z.boolean().optional().describe('Stream into a frame another agent holds the lock on'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, html_chunk, start, done, agent_name, takeover }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
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
        withStopped(withFeedback(nudged, frame.canvasId, actorFrom(agent_name)), frame.canvasId, actorFrom(agent_name)),
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
        takeover: z.boolean().optional().describe('Edit a frame another agent holds the lock on'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, old_str, new_str, agent_name, takeover }) => {
      const f = frameFor(frame_id)
      if (!f) return noFrame(frame_id)
      const count = f.html.split(old_str).length - 1
      if (count === 0) return err('invalid_input', 'old_str not found in the frame HTML. Call get_frame to see the current content.')
      if (count > 1)
        return err('invalid_input', `old_str occurs ${count} times — include more surrounding context so it matches exactly once.`)
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
        withStopped(
          withFeedback(
            textWithNudge({ ok: true, frame: frameSummary(frame) }, REVIEW_NUDGE),
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
          .describe('The frame\'s updatedAt from when you read it — refuses the write if someone else changed it since'),
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
      return withStopped(
        withFeedback(text({ ok: true, frame: frameSummary(frame) }), frame.canvasId, actorFrom(agent_name)),
        frame.canvasId,
        actorFrom(agent_name),
      )
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
          .describe('The frame\'s updatedAt from when you read it — refuses the delete if someone else changed it since'),
        takeover: z.boolean().optional().describe('Delete a frame another agent holds the lock on'),
        agent_name: agentName,
      },
    },
    async ({ frame_id, agent_name, expected_updated_at, takeover }) => {
      const before = frameFor(frame_id)
      if (!before) return noFrame(frame_id)
      const stale = staleConflict(before, expected_updated_at)
      if (stale) return stale
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
      return withStopped(text({ ok: true, deleted: frame.name }), frame.canvasId, actorFrom(agent_name))
    },
  )

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
  const html = typeof args.html === 'string' ? args.html : typeof args.html_chunk === 'string' ? args.html_chunk : undefined
  if (html !== undefined && tooLarge(html))
    return { error: mcpErrorPayload('too_large', `html is ${html.length} characters; the limit is ${MAX_FRAME_HTML_BYTES}`) }

  if (typeof args.frame_id === 'string') {
    const frame = frameFor(args.frame_id)
    if (!frame) return { error: mcpErrorPayload('not_found', `no frame with id ${args.frame_id} accessible to this account`) }
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
      description:
        'Run a sequence of Doop edits in one round trip: create frames, write their HTML, position them, comment, update status. Each op is `{ op: "<tool name>", ...that tool\'s arguments }` — the same fields the named tool takes (see its own schema). Use this to lay out a multi-frame flow, or to apply a review pass across several frames, instead of paying a round trip per call. Ops run in array order; with atomic: false (the default) a failing op is reported at its index and the rest still run, while atomic: true validates every op first and applies nothing if any would fail.',
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
          }),
        ),
        applied: z.number(),
        failed: z.number(),
        stopped_at: z.number().optional(),
      },
    },
    async ({ canvas_id, ops, atomic, agent_name }, extra) => {
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
            error: mcpErrorPayload('invalid_input', `op ${index} targets canvas ${String(rest.canvas_id)}, not ${canvas_id}`),
          })
          continue
        }
        const parsed = z.object(entry.inputSchema).safeParse({ ...rest, canvas_id })
        if (!parsed.success) {
          prepared.push({
            index,
            op,
            args: {},
            error: mcpErrorPayload('invalid_input', `op ${index} (${op}) is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'} ${i.message}`).join('; ')}`),
          })
          continue
        }
        prepared.push({ index, op, args: parsed.data as Record<string, unknown> })
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
          results.push({ index: entry.index, op: entry.op, ok: false, error: parseToolError(textBlocks[0]?.text) })
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

      const payload = {
        results,
        applied: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
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
      if (!c) throw new Error(`no canvas with id ${canvasId} accessible to this account`)
      const visible = c.frames.filter((f) => !f.demo)
      const view: CanvasView = {
        id: c.id,
        name: c.name,
        frames: visible.map((f) => frameSummary(f, c.pages?.find((p) => p.id === f.pageId))),
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
        tokens_present: !!c.tokens,
      }
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }] }
    },
  )

  server.registerResource(
    'doop-canvas-tokens',
    new ResourceTemplate('doop://canvas/{canvasId}/tokens', { list: undefined }),
    {
      title: 'Canvas design tokens',
      description: 'The canvas tokens as a CSS :root block.',
      mimeType: 'text/css',
    },
    async (uri, variables) => {
      const canvasId = String(variables.canvasId ?? '')
      const c = canvasFor(canvasId)
      if (!c) throw new Error(`no canvas with id ${canvasId} accessible to this account`)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/css',
            text: c.tokens
              ? cssForTokens(c.tokens)
              : '/* this canvas has no design tokens yet — set them with set_tokens */',
          },
        ],
      }
    },
  )

  return server
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
  const server = buildMcpServer(owner, session.userId ?? undefined)
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
