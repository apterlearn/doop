export interface Frame {
  id: string
  canvasId: string
  name: string
  x: number
  y: number
  width: number
  height: number
  html: string
  createdAt: number
  updatedAt: number
  updatedBy: string
  /** the page this frame sits on (Canvas.pages); always set after boot backfill */
  pageId?: string
  /** product-made onboarding/example content (welcome demo, seeded frames) —
   *  not the user's work; agents must never read it as the canvas's style */
  demo?: boolean
}

/** A page: an ordered sub-canvas grouping frames. Pages are filters over the
 *  canvas's frames, not coordinate offsets — every canvas keeps ≥1 page. */
export interface Page {
  id: string
  canvasId: string
  name: string
  /** dense 0..n-1 order within Canvas.pages, renumbered on reorder */
  position: number
  createdAt: number
  updatedAt: number
}
/* ---- MCP tool payloads ---- */

/** A canvas's design tokens: the named values every frame should use, so an
 *  agent has one palette/type/scale to conform to instead of inventing one per
 *  frame. Deliberately small — a design system for a canvas, not a theme
 *  editor. `cssForTokens` renders it as a :root block, which the server
 *  injects into every render (see shared/tokens.ts). */
export interface DesignTokens {
  /** token name -> CSS color, e.g. { ink: '#111110' } */
  colors: Record<string, string>
  fonts?: { display?: string; body?: string; mono?: string }
  /** px spacing scale, ascending */
  spacing?: number[]
  radii?: number[]
  shadows?: string[]
  /** type scale: px sizes, numeric weights (100–900) and unitless line heights */
  type?: { size?: number[]; weight?: number[]; leading?: number[] }
  updatedAt: number
  updatedBy: string
}

/** One saved state of a frame, restorable with revert_frame. */
export interface FrameVersion {
  id: string
  frameId: string
  canvasId: string
  name: string
  html: string
  x: number
  y: number
  width: number
  height: number
  savedAt: number
  savedBy: string
}

/** A stored verification report for one frame, as the checks panel and the
 *  delivery gate read it. `htmlSha` names the exact document it describes: a
 *  report whose hash no longer matches the frame is not evidence about it. */
export interface FrameReview {
  id: string
  frameId: string
  canvasId: string
  htmlSha: string
  frameUpdatedAt: number
  verdict: 'pass' | 'fail'
  summary: Record<string, number>
  /** the full per-viewport report, for the checks panel */
  report: unknown
  reviewedAt: number
  reviewedBy: string
}

/** A step of an agent's published plan. */
export interface PlanStep {
  id: string
  text: string
  status: 'pending' | 'active' | 'done' | 'blocked'
  note?: string
  updatedAt?: number
}

/** An agent's plan for one canvas — the record a resumed or compacted run
 *  reads back to know where it left off. */
export interface AgentPlan {
  canvasId: string
  agentName: string
  /** display name of the account whose token authorized the agent */
  owner?: string
  /** the account id behind `owner` — the half of an agent's identity that
   *  cannot be typed by the caller, so work routing keys on it */
  ownerId?: string
  steps: PlanStep[]
  updatedAt: number
}

/** What every frame-listing MCP tool returns per frame: enough to decide
 *  whether and how to read the frame, never the HTML itself. */
export interface FrameSummary {
  id: string
  name: string
  /** page display name, when the frame sits on one */
  page?: string
  /** product-made content, hidden from agents in practice */
  demo?: true
  x: number
  y: number
  width: number
  height: number
  /** ISO 8601 — also the value to pass back as expected_updated_at */
  updatedAt: string
  updatedBy: string
  htmlBytes: number
  /** the document is big enough that pulling it whole risks the context window */
  large?: true
  image_url: string
}

/** A canvas row on the dashboard list, as MCP reports it. */
export type CanvasListItem = CanvasMeta & { guidelinesCount: number }

/** A reusable piece of design: the canvas's component library. An instance is
 *  an element in a frame carrying `data-doop-component="<id>"` (and optional
 *  `data-doop-overrides`), so the frame HTML stays the only document and there
 *  is no second store to reconcile. */
export interface Component {
  id: string
  canvasId: string
  name: string
  description?: string
  /** the component's markup, self-contained: what gets inserted on the canvas */
  html: string
  width: number
  height: number
  /** free-form prop declarations an agent may read to know what it can vary */
  props?: unknown
  /** the component this one is a variant of, when it was derived from another */
  variantOf?: string
  createdBy: string
  updatedBy: string
  createdAt: number
  updatedAt: number
}

/** A component as listed — metadata and how widely it is used, never the HTML. */
export interface ComponentSummary {
  id: string
  name: string
  description?: string
  width: number
  height: number
  variantOf?: string
  /** frames on this canvas holding at least one instance */
  instanceCount: number
  updatedAt: string
  updatedBy: string
  htmlBytes: number
}

/** Something durable an agent learned about this user's taste, kept across
 *  canvases so a new canvas does not start from zero. */
export interface UserMemory {
  id: string
  userId: string
  kind: 'preference' | 'brand' | 'workflow'
  text: string
  sourceCanvasId?: string
  createdAt: number
}

/** The `get_canvas` payload — the canvas picture an agent plans from. */
export interface CanvasView {
  id: string
  name: string
  frames: FrameSummary[]
  /** total frames on the canvas, which may exceed `frames` when truncated */
  frame_total: number
  frames_truncated?: true
  pages: { id: string; name: string; position: number; frameCount: number }[]
  guidelines: GuidelineSummary[]
  references: { id: string; title: string; size: string; htmlBytes: number; pinnedBy: string }[]
  /** how real users navigate between synced screens */
  flow?: string[]
  /** whether the canvas has design tokens to conform to (read them with get_tokens) */
  tokens_present: boolean
  note?: string
}

/** A style guide as listed — metadata only; the markdown comes from get_guidelines. */
export interface GuidelineSummary {
  name: string
  title: string
  summary: string
  bytes: number
  updatedAt?: string
  updatedBy?: string
}

/** An open board card, as `list_cards` reports it. */
export interface BoardCardSummary {
  id: string
  title: string
  queued_by: string
  queued_at: string
  stage: number
  waiting_for: string
  attachments: string[]
  target_frames: string[]
}

export interface CanvasMeta {
  id: string
  name: string
  /** user id of the creator; unset for legacy/seeded canvases (visible to everyone) */
  ownerId?: string
  /** true when this canvas is on the list because the user was invited */
  shared?: boolean
  createdAt: number
  updatedAt: number
  frameCount: number
  /** most recently updated frame — render /i/<id>.jpg for a canvas preview */
  previewFrameId?: string
  /** agents that have worked on this canvas (most recent first) */
  agents?: { name: string; owner?: string; lastAt?: number }[]
}

/** The dashboard/gallery preview render (`/i/<id>.jpg?preview`) clips a
 *  frame at this many frame pixels of height — a tall page's thumbnail is
 *  its top section, not the whole page. Anything sizing a tile around that
 *  image must assume this cap, not the frame's real height. */
export const PREVIEW_MAX_HEIGHT = 1200

/* ---- community gallery ---- */

export const COMMUNITY_CATEGORIES = ['website', 'app', 'dashboard', 'mobile', 'marketing', 'other'] as const
export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number]

export function isCommunityCategory(value: unknown): value is CommunityCategory {
  return typeof value === 'string' && (COMMUNITY_CATEGORIES as readonly string[]).includes(value)
}

export const COMMUNITY_CATEGORY_LABELS: Record<CommunityCategory, string> = {
  website: 'Websites',
  app: 'Web apps',
  dashboard: 'Dashboards',
  mobile: 'Mobile',
  marketing: 'Marketing',
  other: 'Other',
}

/** One gallery card: what the community sees of a published canvas.
 *  Frames are listed by id and size only — previews render through the
 *  public /i/ image pipeline, the HTML never leaves the owner's canvas. */
export interface CommunityItem {
  id: string
  name: string
  description?: string
  category: CommunityCategory
  authorName: string
  publishedAt: number
  updatedAt: number
  copyCount: number
  frames: { id: string; name: string; width: number; height: number }[]
}

export interface Canvas {
  id: string
  name: string
  ownerId?: string
  /** what the share link grants people who are not the owner or invited:
   *  'edit' (anyone with the link collaborates) or 'none' (private — the
   *  default; unset means 'none'). */
  linkAccess?: 'edit' | 'none'
  /** user ids invited to collaborate (the owner is not listed) */
  memberIds?: string[]
  /** set while the owner lists this canvas in the community gallery. The
   *  gallery shows previews and hands out copies — it never opens the
   *  canvas itself, so publishing does not change who can edit it. */
  publishedAt?: number
  /** gallery blurb; meaningful only while published */
  description?: string
  /** gallery shelf; meaningful only while published */
  category?: CommunityCategory
  /** the release this listing is pinned to. When set, the gallery's preview
   *  and the copies it hands out come from that frozen snapshot, so editing
   *  the canvas afterwards does not change what a visitor sees or gets. */
  publishedReleaseId?: string
  /** copies handed out by the gallery — its "trending" signal */
  copyCount?: number
  createdAt: number
  updatedAt: number
  frames: Frame[]
  /** named design docs (brand rules, style recipes) every actor on the canvas follows */
  guidelines?: GuidelineDoc[]
  /** frames pinned to Memory as style exemplars — HTML snapshotted at pin time */
  references?: MemoryReference[]
  /** ordered sub-canvases; the server guarantees ≥1 page after boot backfill */
  pages?: Page[]
  /** the canvas's design tokens — the palette, type and scale every frame should use */
  tokens?: DesignTokens
  /** widths this canvas is designed at; verification renders one pass per
   *  entry and labels findings with its name. Unset = device presets only */
  breakpoints?: { name: string; min_width: number }[]
  /** when on, agent frame writes land as pending proposals a human must
   *  accept; unset/false means agent edits land canonically (the default) */
  reviewMode?: boolean
  /** what an agent write must clear before it lands. `off` (the default) gates
   *  nothing, `destructive` gates only writes a tool declares destructive plus
   *  every tool named in `approvalTools`, `all_writes` gates every write.
   *  `reviewMode` is the older all-or-nothing switch and reads as `all_writes`. */
  reviewPolicy?: ReviewPolicy
  /** tool names gated under the `destructive` policy, on top of the tools that
   *  declare themselves destructive */
  approvalTools?: string[]
}

export type ReviewPolicy = 'off' | 'destructive' | 'all_writes'

/* ---- design memory ---- */

/** A frame pinned to Memory as a style reference: "more like this one".
 *  The HTML is snapshotted at pin time, so later edits to (or deletion of)
 *  the frame never change what the exemplar shows. */
export interface MemoryReference {
  id: string
  /** the frame it was pinned from; the frame may no longer exist */
  frameId: string
  title: string
  html: string
  width: number
  height: number
  pinnedBy: string
  pinnedAt: number
}

/** A resolved design decision, captured automatically when an agent addresses
 *  human feedback or an @agent element comment gets resolved. Raw material
 *  the distiller condenses into rule proposals. */
export interface DesignDecision {
  id: string
  /** the human's words — what they asked to change */
  text: string
  /** the generalized preference distilled from the raw words shortly after
   *  capture (e.g. "Prefer white and blue; no italic serif") — what the UI
   *  leads with; absent until the summarizer has run (or without an API key) */
  summary?: string
  /** where the decision came from: task feedback, an @agent element comment,
   *  or the human's own conversation with a connected agent (save_decision) */
  source: 'feedback' | 'comment' | 'chat'
  frameId?: string
  /** the human who gave the feedback */
  from: string
  /** the agent that addressed it */
  agentName?: string
  at: number
  /** consumed by a distiller run (whether or not it yielded a proposal) */
  distilledAt?: number
}

/** A rule edit the distiller proposes from accumulated decisions. Nothing is
 *  written to a guide until a human accepts — memory is curated, not scraped. */
export interface MemoryProposal {
  id: string
  /** slug of the guide the rule should land in (existing or new) */
  guideName: string
  /** pretty display name, used when the guide doesn't exist yet */
  guideTitle?: string
  /** markdown to append to the guide (usually one bullet) */
  rule: string
  /** why the distiller thinks this is a rule, in one sentence */
  rationale: string
  /** decision ids this was distilled from */
  basedOn: string[]
  at: number
  status: 'pending' | 'accepted' | 'dismissed'
  resolvedBy?: string
  resolvedAt?: number
}

/** A frame change an agent proposed while the canvas is in review mode.
 *  Nothing touches the canvas until a human accepts. `baseUpdatedAt` is the
 *  optimistic-concurrency guard: accepting after the frame changed again
 *  marks the proposal stale instead of overwriting the newer design. */
export interface FrameProposal {
  id: string
  kind: 'replace_html' | 'create_frame' | 'delete_frame'
  /** target frame for replace_html / delete_frame */
  frameId?: string
  /** proposed frame name (create_frame; or a rename alongside the design) */
  name?: string
  /** proposed document for replace_html / create_frame */
  html?: string
  /** proposed placement/size for create_frame */
  x?: number
  y?: number
  width?: number
  height?: number
  /** how the proposal delivers its change. `replace` (the default) carries the
   *  whole document in `html`; `patch` carries `edits` applied to the frame's
   *  document as it stood at `baseUpdatedAt`, so a reviewer can resolve the
   *  change hunk by hunk. */
  mode?: 'replace' | 'patch'
  /** patch mode: the exact replacements to apply, in order */
  edits?: { old_str: string; new_str: string }[]
  /** the document the agent read, so a reviewer (and the rebase path) can see
   *  the change against what it was proposed from. Clamped like any read. */
  baseHtml?: string
  /** render diff against `baseHtml`, computed once when the proposal is
   *  created: the PNG a reviewer looks at, and how much of the frame moved */
  diff?: { png: string; changed_ratio: number }
  /** frame.updatedAt the agent read before proposing; the stale guard */
  baseUpdatedAt: number
  /** one-line what-and-why, shown in the review list */
  summary: string
  agentName: string
  owner?: string
  ownerId?: string
  color: string
  at: number
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'stale'
  resolvedBy?: string
  resolvedAt?: number
  /** why a human rejected it (or their note on accept), so the agent can fix
   *  the right thing instead of guessing */
  resolutionNote?: string
}

/** A blocking question an agent asked via ask_human. Open questions surface
 *  on the canvas and in the Review tab; the agent receives the answer inside
 *  its wait (or on its next tool result when it timed out and moved on). */
export interface AgentQuestion {
  id: string
  canvasId: string
  agentName: string
  owner?: string
  ownerId?: string
  color: string
  frameId?: string
  /** element selector the question is about, from inspect_frame */
  selector?: string
  /** content key of that element — the anchor a stale selector falls back to */
  stableKey?: string
  text: string
  /** offered answers when the asker framed a choice; unset = free text */
  choices?: string[]
  /** the choices are multi-select (default: single) */
  multi?: boolean
  /** an answer outside choices is allowed (default: not) */
  allowOther?: boolean
  at: number
  status: 'open' | 'answered' | 'expired'
  answer?: string
  answeredBy?: string
  answeredAt?: number
  /** after this the wait returns open; the record stays answerable */
  expiresAt: number
}

/** One step of a resident agent's run: a model turn, a tool call, a status
 *  line, an error, or a stop. The Run tab replays these so a human can see
 *  what the agent actually did. */
export interface RunEvent {
  id: string
  canvasId: string
  runId: string
  agentName: string
  at: number
  kind: 'turn' | 'tool' | 'status' | 'error' | 'stop'
  /** tool name for kind 'tool' */
  name?: string
  ok?: boolean
  ms?: number
  /** one-line result/turn summary (≤200 chars) */
  summary?: string
  /** the frame this step wrote, when it wrote one */
  frameId?: string
  /** the frame version the step started from and the one it produced — what
   *  makes a step diffable against its predecessor with diff_frame */
  beforeVersionId?: string
  afterVersionId?: string
}

/** What an agent did on one past run — the resident's cross-run memory. */
export interface RunJournal {
  id: string
  canvasId: string
  agentName: string
  cardId?: string
  /** the run's own id in the run timeline (runLog) — how a run is resolved
   *  back to the frames it changed */
  runId?: string
  summary: string
  /** JSON string of what the run touched (frames, guides read) */
  decisions?: string
  /** the frames the run changed, each with the version it started from and the
   *  one it produced — the run's revertible change set */
  frames?: { frameId: string; name: string; beforeVersionId?: string; afterVersionId?: string }[]
  /** when the run's first turn started and when it stopped; both absent on a
   *  journal written before these were recorded */
  startedAt?: number
  endedAt?: number
  /** model turns taken, tool calls made, tokens spent and the money those
   *  tokens cost (`null` when no price is known for the model) */
  turns?: number
  toolCalls?: number
  tokens?: number
  costUsd?: number | null
  at: number
}

/** What wakes an agent parked in wait_for_events / ask_human. */
export type AgentEventKind =
  | 'feedback'
  | 'comment'
  | 'stop'
  | 'question_answer'
  | 'frame_proposal'
  | 'card'
  /** a human wrote to a frame an agent had just written — the agent must
   *  re-read it before its next write lands on a base it never saw */
  | 'frame_edited'

/** A buffered event an agent receives from a long-poll call. `targetAgent`
 *  scopes it to one agent; unset means every agent on the canvas may see it. */
export interface AgentEvent {
  seq: number
  at: number
  kind: AgentEventKind
  targetAgent?: string
  data?: unknown
}

/** A named design markdown attached to a canvas — palettes, fonts, layout
 *  recipes, asset URLs. Written for agents, readable by humans. Rendered as
 *  a pinned "style guide" card on the canvas next to the frames. */
export interface GuidelineDoc {
  /** slug, unique per canvas (e.g. "feature-image") */
  name: string
  /** pretty display name (e.g. "Featured Images"); fall back to the slug */
  title?: string
  markdown: string
  updatedAt: number
  updatedBy: string
  /** world position of the card on the canvas; unset = auto-placed */
  x?: number
  y?: number
}

export type ActorKind = 'user' | 'agent'

export interface Actor {
  name: string
  kind: ActorKind
  color: string
  clientId?: string
  /** for agents: display name of the user whose OAuth token authorized it */
  owner?: string
  /** the account id behind `owner` — the half of an agent's identity that a
   *  caller cannot type, so work routing keys on it */
  ownerId?: string
}

export interface Presence {
  clientId: string
  name: string
  color: string
  kind: ActorKind
  cursor?: { x: number; y: number }
  activeFrameId?: string | null
  /** one-line "what I'm working on right now" (agents set this via set_status) */
  status?: string
  /** for agents: whose token they connected with */
  owner?: string
  /** when this client last did anything on the canvas. A live connection that
   *  has gone quiet is how a human tells "thinking" from "stuck". */
  lastSeen?: number
}

/** What a connected client is looking at: the frame, the element inside it and
 *  the page. Nulls mean nothing is selected. This is how a human points an
 *  agent at "this" — the server keeps one per client and the MCP surface reads
 *  them back. */
export interface CanvasFocus {
  clientId: string
  /** the client's display name, as the room knows it */
  name: string
  frameId: string | null
  selector: string | null
  pageId: string | null
  at: number
}

/** A unit of work an agent announced via set_status. A new status completes the previous task.
 *  Board cards are the same object: a human queues one (queuedBy set, agentName empty)
 *  and an agent claims it — cards stay open until explicitly completed. */
export interface AgentTask {
  id: string
  /** empty string while a queued card waits for an agent */
  agentName: string
  /** whose token the agent connected with */
  owner?: string
  /** that owner's account id — what makes two agents with the same name on
   *  different accounts different agents */
  ownerId?: string
  color: string
  status: string
  startedAt: number
  endedAt?: number
  /** inferred by the server from frame edits (agent never called set_status) */
  auto?: boolean
  /** human who queued this as a board card */
  queuedBy?: string
  /** account id of that human — decides which model credential runs the card */
  queuedByUserId?: string
  claimedAt?: number
  /** unsuccessful agent attempt; failed work waits for an explicit human retry */
  failedAt?: number
  failureReason?: string
  /** board cards: ordered agent-role ids the card walks through, one at a time.
   *  Absent on status tasks and on cards queued before pipelines existed. */
  pipeline?: string[]
  /** board cards: ids of reference image frames uploaded with the prompt */
  attachments?: string[]
  /** index into pipeline of the stage that is queued or running right now */
  stage?: number
  /** structured board cards the resident runner dispatches on, instead of
   *  handing the title to the chat agent. Absent on prompt cards. */
  kind?: RepoCardKind
  payload?: RepoCardPayload
  /** a human stopped this card's run (or the agent went silent mid-run). Terminal,
   *  exactly like endedAt: it needs an explicit retry, never an automatic one. */
  cancelledAt?: number
  /** the human who stopped it; absent when the agent merely went away (TTL expiry) */
  cancelledBy?: string
  /** frames the human had selected when they queued the card — "make THIS
   *  bigger", not "design something like this". Unlike attachments (reference
   *  material the agent must leave alone), these are the card's subject and the
   *  agent edits them in place. */
  targetFrameIds?: string[]
  /** element selector on that frame the human pointed at — "fix THIS element" */
  targetSelector?: string
  /** page the target frame lives on, so the agent needs no lookup to reach it */
  targetPageId?: string
  /** a human paused this card's run: the run was aborted and the card is
   *  skipped by the sweep until explicitly resumed. Not terminal like
   *  cancelledAt — a resume is one click, not a metered retry. */
  pausedAt?: number
  pausedBy?: string
  /** queue ordering: higher first; then position; then arrival */
  priority?: number
  position?: number
  /** the finishing agent's one-line note handed to the next pipeline stage */
  stageSummary?: string
  /** a specialist sent the card back to an earlier stage, with its reason */
  handback?: { fromAgent: string; reason: string; at: number }
  /** the sweep must not start this card before this time; unset means it is
   *  due as soon as it reaches the front of the queue */
  scheduledAt?: number
  /** what the card's run cost, as the provider reported it */
  usage?: TaskUsage
}

/** Provider-reported token usage for one card's run. */
export interface TaskUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model?: string
  /** what those tokens cost in USD, priced from `model` by modelPrices.ts;
   *  null (or absent, on usage recorded before prices existed) means the
   *  model had no known price — no cost, never a guessed one */
  costUsd?: number | null
}

export type RepoCardKind = 'sketch' | 'design-system'

/** A screen of a connected GitHub repository, as the import manifest lists it. */
export interface RepoScreenRef {
  kind: 'page' | 'story' | 'component' | 'static'
  route: string
  sourcePath: string
  title: string
  /** where the pixels come from: repo HTML, or the agent's sketch of the code */
  source: 'static' | 'placeholder'
}

/** What a repo card carries: enough to run it from any process, later. The
 *  connection is looked up by id at run time, so no credential is ever here. */
export interface RepoCardPayload {
  connectionId: string
  repo: string
  /** one import = one click; groups the cards it queued on the board */
  importId: string
  /** the screen to sketch — absent on a design-system card */
  screen?: RepoScreenRef
}

/** Human feedback left on an agent task: an open request on the canvas that ANY
 *  agent can pick up — delivered inside the next identified agent tool result. */
export interface TaskFeedback {
  id: string
  taskId: string
  canvasId: string
  /** whose work the feedback is about (the task's agent), not who must handle it */
  agentName: string
  /** the resident agent this is routed to; unset = open to any agent */
  targetAgent?: string
  from: string
  /** account id of the human who left it — decides which model credential runs it */
  fromUserId?: string
  text: string
  at: number
  /** set once the feedback has been included in some agent's tool result */
  deliveredAt?: number
  /** the agent that picked it up */
  claimedBy?: string
  /** the account that agent's token belonged to — what stops an agent on
   *  another account from inheriting a claim by typing the same name */
  claimedByOwner?: string
  /** resident Doop finished handling this feedback */
  completedAt?: number
  /** unsuccessful resident-agent attempt; never retried automatically */
  failedAt?: number
  failureReason?: string
}

/** A comment pinned to a specific element inside a frame. Comments that
 *  mention @Doop are routed to the resident agent; others are notes for
 *  the humans in the room. */
export interface ElementComment {
  id: string
  canvasId: string
  frameId: string
  /** CSS selector of the anchored element, resolved at comment time */
  selector: string
  /** Content key of the anchored element (shared/selector.ts). A selector is a
   *  positional path, so inserting a sibling above the element moves it; the
   *  key is what lets the pin follow the content instead. */
  stableKey?: string
  /** outerHTML excerpt of the element, for agent context and dead-anchor display */
  snippet: string
  from: string
  /** account id of the human who left it — decides which model credential runs it */
  fromUserId?: string
  text: string
  at: number
  /** true when the text @mentions a resident agent — that agent picks it up */
  forAgent?: boolean
  /** which resident agent was mentioned; defaults to Doop */
  targetAgent?: string
  claimedBy?: string
  /** the account that agent's token belonged to — see TaskFeedback.claimedByOwner */
  claimedByOwner?: string
  claimedAt?: number
  /** unsuccessful agent attempt; the comment remains paused until retried */
  failedAt?: number
  failureReason?: string
  resolvedBy?: string
  resolvedAt?: number
  /** set on a reply: the root comment of its thread. Replies inherit the
   *  root's anchor and are listed under its pin instead of getting their own */
  parentId?: string
  /** 'agent' when an agent wrote this through MCP — the UI badges it, and a
   *  human reply to it reads as a reply to the agent, not to a person */
  fromKind?: ActorKind
}

export interface ActivityItem {
  id: string
  actorName: string
  actorKind: ActorKind
  actorColor: string
  message: string
  frameId?: string
  at: number
}

/* ---- websocket protocol ---- */

export type ClientMessage =
  | { type: 'join'; canvasId: string; clientId: string; name: string; kind: ActorKind }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'editing'; frameId: string | null }
  | { type: 'frame:drag'; frameId: string; x: number; y: number; width: number; height: number }
  /** what this client is looking at right now — frame, element selector and
   *  page; nulls clear it. Lets a human point an agent at "this" */
  | { type: 'focus'; frameId: string | null; selector: string | null; pageId: string | null }

/** Who holds a frame's edit lock, as the server broadcasts it. */
export interface FrameLockHolder {
  name: string
  color: string
  kind: ActorKind
}

export type ServerMessage =
  | {
      type: 'init'
      canvas: Canvas
      presences: Presence[]
      activity: ActivityItem[]
      tasks: AgentTask[]
      feedback: TaskFeedback[]
      comments: ElementComment[]
      decisions: DesignDecision[]
      proposals: MemoryProposal[]
      /** every agent plan published on this canvas, newest first */
      plans: AgentPlan[]
      selfColor: string
      /** pending agent frame-change proposals awaiting review */
      frameProposals: FrameProposal[]
      /** open agent questions awaiting a human answer */
      questions: AgentQuestion[]
      /** whether agent frame writes must be approved before they land */
      reviewMode: boolean
      /** what agent writes must clear before they land, and the extra tool
       *  names gated under the `destructive` policy */
      reviewPolicy?: ReviewPolicy
      approvalTools?: string[]
      /** the canvas component library, as the components panel lists it */
      components?: ComponentSummary[]
      /** per-agent tool-call timeline, newest first (a bounded recent window) */
      runEvents: RunEvent[]
      /** frames an agent is mid-edit on, so a client joining now sees the holder */
      frameLocks: Record<string, FrameLockHolder>
      serverBuild: string
    }
  | { type: 'presence:join'; presence: Presence }
  | { type: 'presence:leave'; clientId: string }
  | { type: 'cursor'; clientId: string; x: number; y: number }
  | { type: 'editing'; clientId: string; frameId: string | null }
  | { type: 'status'; clientId: string; status: string | null }
  | { type: 'task'; task: AgentTask }
  | { type: 'task:deleted'; taskId: string }
  | { type: 'feedback'; feedback: TaskFeedback }
  | { type: 'comment'; comment: ElementComment }
  | { type: 'frame:drag'; clientId: string; frameId: string; x: number; y: number; width: number; height: number }
  | { type: 'frame:created'; frame: Frame; actor: Actor }
  | { type: 'frame:updated'; frame: Frame; actor: Actor }
  | { type: 'frame:deleted'; frameId: string; actor: Actor }
  | {
      type: 'frame:streaming'
      frameId: string
      active: boolean
      actor: Actor
      /** why the stream ended: the agent delivered, went silent, replaced its
       *  own document, was taken over by another writer, or was stopped
       *  (absent while active) */
      reason?: 'done' | 'idle' | 'taken over' | 'stopped' | 'replaced'
    }
  | { type: 'canvas:renamed'; name: string; actor: Actor }
  /** a style-guide doc was written, moved (doc set) or deleted (doc null) */
  | { type: 'guidelines'; name: string; doc: GuidelineDoc | null; actor: Actor }
  | { type: 'tokens'; tokens: DesignTokens | null; actor: Actor }
  | { type: 'plan'; plan: AgentPlan }
  /** a frame was pinned to (reference set) or unpinned from (null) Memory */
  | { type: 'reference'; id: string; reference: MemoryReference | null; actor: Actor }
  /** a design decision was captured into Memory */
  | { type: 'decision'; decision: DesignDecision }
  /** the distiller proposed a rule, or a proposal was accepted/dismissed */
  | { type: 'proposal'; proposal: MemoryProposal }
  | { type: 'canvas:deleted' }
  /** the ordered page list changed (create/rename/reorder/delete/duplicate) —
   *  carries the full list so clients can replace canvas.pages wholesale */
  | { type: 'pages'; pages: Page[]; actor: Actor }
  | { type: 'activity'; item: ActivityItem }
  /** an agent proposed a frame change (review mode), or it was resolved */
  | { type: 'frameProposal'; proposal: FrameProposal }
  | { type: 'frameProposal:deleted'; proposalId: string }
  /** an agent asked a question, or a human answered it */
  | { type: 'question'; question: AgentQuestion }
  /** a resident agent emitted a run-timeline event (tool call, turn, stop) */
  | { type: 'run:event'; event: RunEvent }
  /** review mode was toggled */
  | { type: 'canvas:reviewMode'; reviewMode: boolean; actor: Actor }
  /** the canvas review policy changed (what agent writes must clear) */
  | { type: 'canvas:reviewPolicy'; reviewPolicy: ReviewPolicy; approvalTools: string[]; actor: Actor }
  /** a component was created or updated (component set) or deleted (null) —
   *  `componentId` is always present so a deletion can be applied without the
   *  body it no longer has */
  | { type: 'component'; componentId: string; component: Component | null; actor: Actor }
  /** a frame edit lock was taken, released or expired (holder null = free) */
  | { type: 'frame:lock'; frameId: string; holder: { name: string; color: string; kind: ActorKind } | null }
  /** another client's selection moved (nulls = cleared); sent to the canvas room */
  | { type: 'focus'; clientId: string; frameId: string | null; selector: string | null; pageId: string | null }

export const CURSOR_PALETTE = [
  '#2743EE', // cursor blue — the brand accent leads
  '#0E9F6E', // green
  '#8B5CF6', // violet
  '#D0341F', // vermillion
  '#C77800', // amber
  '#D62A7E', // magenta
  '#0E8A8A', // teal
  '#8E2E5C', // plum
]

export function colorFor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  /* the modulo keeps the index in range */
  return CURSOR_PALETTE[h % CURSOR_PALETTE.length]!
}
