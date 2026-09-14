import { pgTable, text, doublePrecision, bigint, boolean, integer, index, primaryKey, jsonb } from 'drizzle-orm/pg-core'

/**
 * One Postgres-dialect schema for every environment: PGlite (embedded, file
 * in ./data) during development, a managed Postgres via DATABASE_URL in
 * production. Timestamps are epoch-ms bigints to match the in-memory types.
 * No FK constraints — memory is the source of truth and writes are async
 * fire-and-forget, so we don't want ordering between them to matter.
 */

export const canvases = pgTable('canvases', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id'),
  /** 'edit' | 'none'; null = 'none' (private — link sharing is opt-in) */
  linkAccess: text('link_access'),
  /** set when the owner has listed this canvas in the community gallery;
   *  null = private to its collaborators. Publishing grants read-only
   *  previews and copies, never access to the canvas itself. */
  publishedAt: bigint('published_at', { mode: 'number' }),
  /** gallery blurb and category — meaningful only while published */
  description: text('description'),
  category: text('category'),
  /** the release the listing is pinned to, or null for the live frames */
  publishedReleaseId: text('published_release_id'),
  /** how many times the gallery has copied this canvas — the "trending" signal */
  copyCount: integer('copy_count').notNull().default(0),
  /** design tokens (DesignTokens): the palette/type/scale every frame should
   *  use; null until an agent or human defines them */
  tokens: jsonb('tokens'),
  /** responsive breakpoints ({ name, min_width }[]): the widths verification
   *  renders a frame at; null until the canvas declares any */
  breakpoints: jsonb('breakpoints'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  /** when on, agent frame writes become frame_proposals instead of landing */
  reviewMode: boolean('review_mode').notNull().default(false),
  /** 'off' | 'destructive' | 'all_writes'; legacy canvases read as 'off' and
   *  review_mode=true is honoured as 'all_writes'. Scoped replacement for the
   *  all-or-nothing boolean above. */
  reviewPolicy: text('review_policy').notNull().default('off'),
  /** tool names that always need approval, whatever their annotations say */
  approvalTools: jsonb('approval_tools').$type<string[]>(),
})

/** Users invited to collaborate on a canvas (the owner is not listed).
 *  Access = owner ∪ members ∪ (everyone, when link_access = 'edit'). */
export const canvasMembers = pgTable(
  'canvas_members',
  {
    canvasId: text('canvas_id').notNull(),
    userId: text('user_id').notNull(),
    addedBy: text('added_by').notNull(),
    addedAt: bigint('added_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.userId] })],
)

export const frames = pgTable(
  'frames',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    html: text('html').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /** product-made onboarding/example content; null = a real user frame */
    demo: boolean('demo'),
    /** the page this frame sits on (pages table id); backfilled at hydrate */
    pageId: text('page_id'),
  },
  (t) => [index('frames_canvas_idx').on(t.canvasId)],
)

/** Canvas pages: ordered sub-canvases grouping frames. A page is a filter over
 *  a canvas's frames (frames carry page_id), not a coordinate offset. Every
 *  canvas keeps ≥1 page — hydrate() backfills "Page 1" for legacy canvases. */
export const pages = pgTable(
  'pages',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    /** dense 0..n-1 order within Canvas.pages, renumbered on reorder */
    position: integer('position').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('pages_canvas_idx').on(t.canvasId)],
)

/** Design-sync keys: the write-only capability behind the /ingest endpoint.
 *  An app embeds the doop-sync snippet with a key's secret, and its live
 *  screens land on ONE canvas as frames — the secret grants no reads and no
 *  other writes, so shipping it in an internal app's bundle is safe. `id` is
 *  the public handle (stamped into synced frame HTML to match page → frame);
 *  the secret never appears in canvas content. Cold path: read per ingest
 *  request, no in-memory mirror. Revocation = row deletion. */
export const syncKeys = pgTable(
  'sync_keys',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    canvasId: text('canvas_id').notNull(),
    /** label shown in the share modal and used as the frames' actor name */
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
  },
  (t) => [index('sync_keys_canvas_idx').on(t.canvasId), index('sync_keys_secret_idx').on(t.secret)],
)

/** Link hotspots a synced page declares: where each same-app link sits in the
 *  snapshot and which page it leads to. Replaced wholesale on every capture
 *  of that page — the set mirrors the CURRENT design, it is not history. */
export const syncLinks = pgTable(
  'sync_links',
  {
    keyId: text('key_id').notNull(),
    page: text('page').notNull(),
    toPage: text('to_page').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    label: text('label'),
  },
  (t) => [index('sync_links_page_idx').on(t.keyId, t.page)],
)

/** Navigations users actually made in the synced app, accumulated per route
 *  pair — the traffic weights on top of the declared link map. */
export const syncEdges = pgTable(
  'sync_edges',
  {
    keyId: text('key_id').notNull(),
    fromPage: text('from_page').notNull(),
    toPage: text('to_page').notNull(),
    count: integer('count').notNull().default(0),
    lastAt: bigint('last_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.fromPage, t.toPage] })],
)

/** A GitHub repo connected to a canvas as an import source. Two credential
 *  modes: a GitHub App installation (`installationId` set, short-lived
 *  tokens minted per call — the preferred flow) or a fine-grained PAT
 *  (`token` set — the paste-a-token fallback). Either way credentials stay
 *  server-side; API responses carry connection metadata only. Revocation =
 *  row deletion (plus uninstalling the app / revoking the PAT on GitHub).
 *  Frames imported through a connection carry a marker meta in their HTML
 *  (see server/github.ts), same provenance pattern as design-sync frames —
 *  no frame column. */
export const githubConnections = pgTable(
  'github_connections',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    /** "owner/name" */
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    token: text('token'),
    installationId: text('installation_id'),
    /** live deployment of this repo; enables the capture lane */
    deployUrl: text('deploy_url'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    lastSyncedAt: bigint('last_synced_at', { mode: 'number' }),
  },
  (t) => [index('github_connections_canvas_idx').on(t.canvasId)],
)

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    frameId: text('frame_id').notNull(),
    selector: text('selector').notNull(),
    /** content key of the anchored element (shared/selector.ts): the anchor a
     *  stale selector falls back to, captured at comment time */
    stableKey: text('stable_key'),
    snippet: text('snippet').notNull(),
    fromName: text('from_name').notNull(),
    fromUserId: text('from_user_id'),
    text: text('text').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    forAgent: boolean('for_agent').notNull().default(false),
    targetAgent: text('target_agent'),
    claimedBy: text('claimed_by'),
    claimedByOwner: text('claimed_by_owner'),
    claimedAt: bigint('claimed_at', { mode: 'number' }),
    failedAt: bigint('failed_at', { mode: 'number' }),
    failureReason: text('failure_reason'),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    parentId: text('parent_id'),
    /** 'agent' when an agent wrote this through MCP — durable so the canvas
     *  still badges agent-authored notes after a restart */
    fromKind: text('from_kind'),
  },
  (t) => [index('comments_canvas_idx').on(t.canvasId)],
)

/** Uploaded image assets: metadata only — bytes live in object storage (or
 *  ./data/assets in dev). canvas_id is a housekeeping hint, not ownership:
 *  liveness comes from asset_refs, so a URL copied to another canvas keeps
 *  its asset alive. */
export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id'),
    ownerId: text('owner_id'),
    mime: text('mime').notNull(),
    ext: text('ext').notNull(),
    size: integer('size').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('assets_canvas_idx').on(t.canvasId)],
)

/** Which frames reference which assets — a projection of frame HTML, synced
 *  on every durable frame write (recomputed from the frame's full HTML, so
 *  it cannot drift like a counter would) and rebuilt at boot. GC is then an
 *  indexed anti-join here instead of a scan over all HTML. */
export const assetRefs = pgTable(
  'asset_refs',
  {
    assetId: text('asset_id').notNull(),
    frameId: text('frame_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.frameId] }), index('asset_refs_frame_idx').on(t.frameId)],
)

/** Named design docs per canvas (brand rules, style recipes) — markdown
 *  written mostly for agents. Small and cold-path; hydrated with the canvas. */
export const guidelines = pgTable(
  'guidelines',
  {
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    markdown: text('markdown').notNull(),
    /* pretty display name; null = show the slug */
    title: text('title'),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    updatedBy: text('updated_by').notNull(),
    /* world position of the card on the canvas; null = auto-placed */
    x: doublePrecision('x'),
    y: doublePrecision('y'),
  },
  (t) => [primaryKey({ columns: [t.canvasId, t.name] })],
)

/** Append-only history of guideline docs: one snapshot per save, an empty
 *  markdown marks a deletion. Capped per doc at write time; read on demand
 *  (cold path — no in-memory mirror). */
export const guidelineVersions = pgTable(
  'guideline_versions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    markdown: text('markdown').notNull(),
    savedAt: bigint('saved_at', { mode: 'number' }).notNull(),
    savedBy: text('saved_by').notNull(),
  },
  (t) => [index('guideline_versions_doc_idx').on(t.canvasId, t.name)],
)

/** Append-only history of frame designs: one snapshot per durable write,
 *  capped per frame at write time. Frames are the thing agents destroy and
 *  rebuild, so this is what makes a bad edit recoverable — cold path, no
 *  in-memory mirror, read on demand. */
export const frameVersions = pgTable(
  'frame_versions',
  {
    id: text('id').primaryKey(),
    frameId: text('frame_id').notNull(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    html: text('html').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    savedAt: bigint('saved_at', { mode: 'number' }).notNull(),
    savedBy: text('saved_by').notNull(),
  },
  (t) => [index('frame_versions_frame_idx').on(t.frameId, t.savedAt)],
)

/** Verification reports, kept after the run that produced them.
 *
 *  A review is only evidence about the exact document it was made from, so the
 *  row carries the hash of that HTML; the completion gate refuses a report
 *  whose hash no longer matches the frame. Persisted because a human reading
 *  the checks panel is usually reading them after the agent disconnected.
 *  Append-only, capped per frame at write time. */
export const frameReviews = pgTable(
  'frame_reviews',
  {
    id: text('id').primaryKey(),
    frameId: text('frame_id').notNull(),
    canvasId: text('canvas_id').notNull(),
    /** sha256 (truncated) of the frame HTML this report describes */
    htmlSha: text('html_sha').notNull(),
    /** the frame's updatedAt when it was reviewed */
    frameUpdatedAt: bigint('frame_updated_at', { mode: 'number' }).notNull(),
    verdict: text('verdict').notNull(),
    summary: jsonb('summary').notNull(),
    report: jsonb('report').notNull(),
    reviewedAt: bigint('reviewed_at', { mode: 'number' }).notNull(),
    reviewedBy: text('reviewed_by').notNull(),
  },
  (t) => [index('frame_reviews_frame_idx').on(t.frameId, t.reviewedAt)],
)

/** A frozen snapshot of a canvas's frames — what a handoff link points at.
 *
 *  Frames keep changing after a design is handed off, so "the version I sent
 *  you" has to be a stored thing, not a timestamp. The frames are denormalized
 *  into the row on purpose: a release must not change when a frame is edited,
 *  renamed or deleted, which is exactly what a foreign key would let happen. */
export const canvasReleases = pgTable(
  'canvas_releases',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    /** the frames as they were: {id, name, width, height, x, y, html, pageId} */
    frames: jsonb('frames').notNull(),
    /** the design tokens at release time, when the canvas had any */
    tokens: jsonb('tokens'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    createdBy: text('created_by').notNull(),
  },
  (t) => [index('canvas_releases_canvas_idx').on(t.canvasId, t.createdAt)],
)

/** Frames pinned to Memory as style exemplars: the HTML is a snapshot taken
 *  at pin time, deliberately decoupled from the (mutable, deletable) frame. */
export const memoryReferences = pgTable(
  'memory_references',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    frameId: text('frame_id').notNull(),
    title: text('title').notNull(),
    html: text('html').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    pinnedBy: text('pinned_by').notNull(),
    pinnedAt: bigint('pinned_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('memory_references_canvas_idx').on(t.canvasId)],
)

/** Resolved design decisions captured from addressed feedback/comments —
 *  the distiller's raw material. */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    text: text('text').notNull(),
    summary: text('summary'),
    source: text('source').notNull(),
    frameId: text('frame_id'),
    fromName: text('from_name').notNull(),
    agentName: text('agent_name'),
    at: bigint('at', { mode: 'number' }).notNull(),
    distilledAt: bigint('distilled_at', { mode: 'number' }),
  },
  (t) => [index('decisions_canvas_idx').on(t.canvasId)],
)

/** Rule edits the distiller proposed; humans accept (→ guide) or dismiss. */
export const memoryProposals = pgTable(
  'memory_proposals',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    guideName: text('guide_name').notNull(),
    guideTitle: text('guide_title'),
    rule: text('rule').notNull(),
    rationale: text('rationale').notNull(),
    /** comma-joined decision ids */
    basedOn: text('based_on').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
  },
  (t) => [index('memory_proposals_canvas_idx').on(t.canvasId)],
)

export const activity = pgTable(
  'activity',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    actorName: text('actor_name').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorColor: text('actor_color').notNull(),
    message: text('message').notNull(),
    frameId: text('frame_id'),
    at: bigint('at', { mode: 'number' }).notNull(),
  },
  (t) => [index('activity_canvas_idx').on(t.canvasId)],
)

/** A user's own model subscription, connected so the Doop Agent keeps running
 *  once their free tasks are gone. Today that is ChatGPT (OAuth against
 *  auth.openai.com, refreshed here) or a plain OpenAI API key — `kind` says
 *  which, and the token columns are empty for the key path. Secrets: these
 *  rows are as sensitive as a password, and never leave the server. */
export const modelAccounts = pgTable('model_accounts', {
  userId: text('user_id').primaryKey(),
  /** 'chatgpt' (subscription, OAuth) | 'openai-key' (pay-as-you-go API key) */
  kind: text('kind').notNull(),
  /** chatgpt: the ChatGPT account the tokens are scoped to */
  accountId: text('account_id'),
  /** display only — whose subscription this is, and which plan */
  email: text('email'),
  plan: text('plan'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  /** epoch ms the access token expires; refreshed ahead of this */
  expiresAt: bigint('expires_at', { mode: 'number' }),
  apiKey: text('api_key'),
  /** the model tier this user picked; null = the server default */
  model: text('model'),
  connectedAt: bigint('connected_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/* The curated background library behind search_backgrounds
   (server/backgrounds.ts). Bytes live in object storage under bg/<id>.webp
   and bg/<id>-t.webp; this row is everything the search ranks on. */
export const backgrounds = pgTable('backgrounds', {
  id: text('id').primaryKey(),
  /** sha1 of the uploaded source file — re-uploads of the same image are skipped */
  source: text('source').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  tone: text('tone').notNull(),
  style: text('style').notNull(),
  avgColor: text('avg_color').notNull(),
  palette: jsonb('palette').$type<string[]>().notNull(),
  tags: jsonb('tags').$type<string[]>().notNull(),
  slots: jsonb('slots').$type<string[]>().notNull(),
  textZone: text('text_zone').notNull(),
  description: text('description').notNull(),
  /** off = kept but hidden from search; new uploads without tags start off */
  enabled: boolean('enabled').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
})

/** A frame change an agent proposed while the canvas is in review mode.
 *  Accepting applies it through the ordinary actions; nothing touches the
 *  canvas until then. `base_updated_at` is the stale guard. */
export const frameProposals = pgTable(
  'frame_proposals',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    kind: text('kind').notNull(),
    frameId: text('frame_id'),
    name: text('name'),
    html: text('html'),
    x: doublePrecision('x'),
    y: doublePrecision('y'),
    width: doublePrecision('width'),
    height: doublePrecision('height'),
    baseUpdatedAt: bigint('base_updated_at', { mode: 'number' }).notNull(),
    summary: text('summary').notNull(),
    agentName: text('agent_name').notNull(),
    owner: text('owner'),
    ownerId: text('owner_id'),
    color: text('color').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    resolvedBy: text('resolved_by'),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
    /** the reviewer's note, on a reject (why) or an accept (what they changed) */
    resolutionNote: text('resolution_note'),
  },
  (t) => [index('frame_proposals_canvas_idx').on(t.canvasId)],
)

/** A canvas-level change an agent proposed while the canvas is in review mode
 *  — the frame-proposal path's counterpart for everything that is not a frame:
 *  the design tokens, a guideline doc, the breakpoint list, the pages. Nothing
 *  touches the canvas until a human accepts; the accept then applies the
 *  payload through the ordinary setters, so it versions, broadcasts and logs
 *  exactly like a human edit. `before` is the value at propose time, so a
 *  reviewer sees the change against what it replaces. */
export const canvasProposals = pgTable(
  'canvas_proposals',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    /** 'tokens' | 'guidelines' | 'breakpoints' | 'pages' */
    kind: text('kind').notNull(),
    /** the change to apply on accept, shaped per kind (see shared/types.ts);
     *  a `tokens` proposal clears the canvas with a JSON null */
    payload: jsonb('payload'),
    /** the canvas value the proposal was made against; null = there was none */
    before: jsonb('before'),
    proposedBy: text('proposed_by').notNull(),
    proposedByUser: text('proposed_by_user').notNull(),
    status: text('status').notNull().default('pending'),
    /** the reviewer's note, on a reject (why) or an accept (what they changed) */
    resolutionNote: text('resolution_note'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    resolvedAt: bigint('resolved_at', { mode: 'number' }),
  },
  (t) => [index('canvas_proposals_canvas_idx').on(t.canvasId)],
)

/** A blocking question an agent asked a human via ask_human. */
export const agentQuestions = pgTable(
  'agent_questions',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    agentName: text('agent_name').notNull(),
    owner: text('owner'),
    ownerId: text('owner_id'),
    color: text('color').notNull(),
    frameId: text('frame_id'),
    selector: text('selector'),
    /** content key of the element the question is about, like comments */
    stableKey: text('stable_key'),
    text: text('text').notNull(),
    /** offered answers when the asker framed a choice; null = free text */
    choices: jsonb('choices').$type<string[]>(),
    multi: boolean('multi'),
    allowOther: boolean('allow_other'),
    at: bigint('at', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    answer: text('answer'),
    answeredBy: text('answered_by'),
    answeredAt: bigint('answered_at', { mode: 'number' }),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('agent_questions_canvas_idx').on(t.canvasId)],
)

/** One step of an agent's run — the Run tab's timeline. */
export const runEvents = pgTable(
  'run_events',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    runId: text('run_id').notNull(),
    agentName: text('agent_name').notNull(),
    at: bigint('at', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    name: text('name'),
    ok: boolean('ok'),
    ms: integer('ms'),
    summary: text('summary'),
    /** the frame this step touched, when it wrote one — the replay cursor */
    frameId: text('frame_id'),
    /** the frame_versions row the step started from / produced, so step N can
     *  be diffed against N+1 with diff_frame */
    beforeVersionId: text('before_version_id'),
    afterVersionId: text('after_version_id'),
  },
  (t) => [index('run_events_canvas_idx').on(t.canvasId)],
)

/** Per-user email notification preference for agent events. */
export const notificationPrefs = pgTable('notification_prefs', {
  userId: text('user_id').primaryKey(),
  agentEmail: boolean('agent_email').notNull().default(false),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

/** A reusable piece of canvas UI — the component library behind
 *  insert_component. `html` is the definition document; an instance is an
 *  element in a frame carrying data-doop-component=<id> (plus
 *  data-doop-overrides), so the frame HTML stays the only document and
 *  there is no second store to reconcile. `variantOf` points at the base
 *  component a variant derives from. */
export const components = pgTable(
  'components',
  {
    id: text('id').primaryKey(),
    canvasId: text('canvas_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    html: text('html').notNull(),
    width: doublePrecision('width').notNull(),
    height: doublePrecision('height').notNull(),
    /** JSON prop schema the component accepts; null = no declared props */
    props: jsonb('props'),
    /** base component id this one is a variant of; null = a root component */
    variantOf: text('variant_of'),
    createdBy: text('created_by').notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('components_canvas_idx').on(t.canvasId)],
)

/** What one user has taught doop about their taste, carried across every
 *  canvas they own (the MCP memory tools read it). Capped per user at write
 *  time. */
export const userMemory = pgTable(
  'user_memory',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    /** 'preference' | 'brand' | 'workflow' */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    /** the canvas the memory was learned on — provenance only, never a scope */
    sourceCanvasId: text('source_canvas_id'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('user_memory_user_idx').on(t.userId)],
)
