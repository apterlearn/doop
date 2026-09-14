import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { db } from './index.ts'
import * as t from './schema.ts'
import { user as authUser } from './auth-schema.ts'
import { extractAssetIds } from '../assets.ts'
import { isCommunityCategory } from '../../shared/types.ts'
import type {
  ActivityItem,
  AgentQuestion,
  Canvas,
  CanvasProposal,
  Component,
  DesignDecision,
  ElementComment,
  DesignTokens,
  Frame,
  FrameProposal,
  FrameReview,
  FrameVersion,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  Page,
  RunEvent,
  UserMemory,
} from '../../shared/types.ts'

/**
 * Write-through persistence: the in-memory maps stay the source of truth and
 * the hot path; every committed mutation is mirrored here asynchronously.
 * Nothing on the live path (presence, cursors, reveal ticks) awaits the DB.
 */

function swallow(p: Promise<unknown>) {
  p.catch((err) => console.error('[db] write failed', err))
}

/** every mutable canvas column, so insert and upsert can't drift apart */
function canvasColumns(c: Canvas) {
  return {
    name: c.name,
    ownerId: c.ownerId ?? null,
    linkAccess: c.linkAccess ?? null,
    publishedAt: c.publishedAt ?? null,
    description: c.description ?? null,
    category: c.category ?? null,
    publishedReleaseId: c.publishedReleaseId ?? null,
    copyCount: c.copyCount ?? 0,
    tokens: c.tokens ?? null,
    breakpoints: c.breakpoints ?? null,
    reviewMode: c.reviewMode ?? false,
    reviewPolicy: c.reviewPolicy ?? 'off',
    approvalTools: c.approvalTools ?? null,
    updatedAt: c.updatedAt,
  }
}

export function saveCanvas(c: Canvas) {
  swallow(
    db
      .insert(t.canvases)
      .values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })
      .onConflictDoUpdate({ target: t.canvases.id, set: canvasColumns(c) }),
  )
}

/** Persist a newly duplicated canvas as one unit. Unlike ordinary live edits,
 * duplication must not report success until every copied row is durable. */
export async function saveCanvasCopy(c: Canvas): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(t.canvases).values({ id: c.id, ...canvasColumns(c), createdAt: c.createdAt })

    if (c.pages?.length) {
      await tx.insert(t.pages).values(
        c.pages.map((page) => ({
          id: page.id,
          canvasId: c.id,
          name: page.name,
          position: page.position,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        })),
      )
    }

    if (c.frames.length) {
      await tx.insert(t.frames).values(
        c.frames.map((frame) => ({
          id: frame.id,
          canvasId: frame.canvasId,
          name: frame.name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height,
          html: frame.html,
          createdAt: frame.createdAt,
          updatedAt: frame.updatedAt,
          updatedBy: frame.updatedBy,
          demo: frame.demo ?? null,
          pageId: frame.pageId ?? null,
        })),
      )
    }

    if (c.guidelines?.length) {
      await tx.insert(t.guidelines).values(
        c.guidelines.map((doc) => ({
          canvasId: c.id,
          name: doc.name,
          markdown: doc.markdown,
          title: doc.title ?? null,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
          x: doc.x ?? null,
          y: doc.y ?? null,
        })),
      )
    }

    if (c.references?.length) {
      await tx.insert(t.memoryReferences).values(
        c.references.map((ref) => ({
          id: ref.id,
          canvasId: c.id,
          frameId: ref.frameId,
          title: ref.title,
          html: ref.html,
          width: ref.width,
          height: ref.height,
          pinnedBy: ref.pinnedBy,
          pinnedAt: ref.pinnedAt,
        })),
      )
    }

    const refs = c.frames.flatMap((frame) =>
      [...extractAssetIds(frame.html)].map((assetId) => ({ assetId, frameId: frame.id })),
    )
    if (refs.length) await tx.insert(t.assetRefs).values(refs)
  })
}

export function saveMember(canvasId: string, userId: string, addedBy: string, addedAt: number) {
  swallow(db.insert(t.canvasMembers).values({ canvasId, userId, addedBy, addedAt }).onConflictDoNothing())
}

export function deleteMember(canvasId: string, userId: string) {
  swallow(
    db.delete(t.canvasMembers).where(and(eq(t.canvasMembers.canvasId, canvasId), eq(t.canvasMembers.userId, userId))),
  )
}

/* Single-shot writes (one save per explicit edit) — no debounce needed. */
export function saveGuideline(canvasId: string, doc: GuidelineDoc) {
  const row = {
    canvasId,
    name: doc.name,
    markdown: doc.markdown,
    title: doc.title ?? null,
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    x: doc.x ?? null,
    y: doc.y ?? null,
  }
  swallow(
    db
      .insert(t.guidelines)
      .values(row)
      .onConflictDoUpdate({
        target: [t.guidelines.canvasId, t.guidelines.name],
        set: {
          markdown: row.markdown,
          title: row.title,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
          x: row.x,
          y: row.y,
        },
      }),
  )
}

export function deleteGuideline(canvasId: string, name: string) {
  swallow(db.delete(t.guidelines).where(and(eq(t.guidelines.canvasId, canvasId), eq(t.guidelines.name, name))))
}

export function savePage(canvasId: string, page: Page) {
  swallow(
    db
      .insert(t.pages)
      .values({
        id: page.id,
        canvasId,
        name: page.name,
        position: page.position,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      })
      .onConflictDoUpdate({
        target: t.pages.id,
        set: { name: page.name, position: page.position, updatedAt: page.updatedAt },
      }),
  )
}

export function deletePage(pageId: string) {
  swallow(db.delete(t.pages).where(eq(t.pages.id, pageId)))
}

export function setFramePage(frameId: string, pageId: string) {
  swallow(db.update(t.frames).set({ pageId }).where(eq(t.frames.id, frameId)))
}

/* Append-only doc history: a snapshot per save, '' marks a deletion. */
const MAX_GUIDELINE_VERSIONS = 50

export function saveGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  swallow(appendGuidelineVersion(canvasId, name, markdown, by, at))
}

async function appendGuidelineVersion(canvasId: string, name: string, markdown: string, by: string, at: number) {
  await db.insert(t.guidelineVersions).values({ id: nanoid(10), canvasId, name, markdown, savedAt: at, savedBy: by })
  const excess = await db
    .select({ id: t.guidelineVersions.id })
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
    .offset(MAX_GUIDELINE_VERSIONS)
  if (excess.length) {
    await db.delete(t.guidelineVersions).where(
      inArray(
        t.guidelineVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

/** Newest first. Cold path — read straight from the database on demand. */
export function listGuidelineVersions(canvasId: string, name: string) {
  return db
    .select()
    .from(t.guidelineVersions)
    .where(and(eq(t.guidelineVersions.canvasId, canvasId), eq(t.guidelineVersions.name, name)))
    .orderBy(desc(t.guidelineVersions.savedAt))
}

/* Append-only frame history: one snapshot per durable write, capped per frame.
   Written from writeFrame, which is already debounced per frame, so a
   streaming burst lands as one version rather than one per chunk. */
const MAX_FRAME_VERSIONS = 50

export function listFrameVersions(frameId: string, limit = 20): Promise<FrameVersion[]> {
  return db
    .select()
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, frameId))
    .orderBy(desc(t.frameVersions.savedAt))
    .limit(limit)
}

export async function getFrameVersion(versionId: string): Promise<FrameVersion | undefined> {
  const [row] = await db.select().from(t.frameVersions).where(eq(t.frameVersions.id, versionId)).limit(1)
  return row
}

/* Verification reports: append-only, capped per frame. Written from the
   review_frame and review_canvas tools, read by the checks panel and by the
   completion gate (complete_card, hand_back) when it decides whether a
   delivery may complete. */
const MAX_FRAME_REVIEWS = 20

export async function saveFrameReview(review: FrameReview): Promise<void> {
  await db.insert(t.frameReviews).values({
    id: review.id,
    frameId: review.frameId,
    canvasId: review.canvasId,
    htmlSha: review.htmlSha,
    frameUpdatedAt: review.frameUpdatedAt,
    verdict: review.verdict,
    summary: review.summary,
    report: review.report as object,
    reviewedAt: review.reviewedAt,
    reviewedBy: review.reviewedBy,
  })
  const excess = await db
    .select({ id: t.frameReviews.id })
    .from(t.frameReviews)
    .where(eq(t.frameReviews.frameId, review.frameId))
    .orderBy(desc(t.frameReviews.reviewedAt))
    .offset(MAX_FRAME_REVIEWS)
  if (excess.length) {
    await db.delete(t.frameReviews).where(
      inArray(
        t.frameReviews.id,
        excess.map((row) => row.id),
      ),
    )
  }
}

/** The report summary as stored: a jsonb column is `unknown` at the boundary,
 *  so it is narrowed here rather than cast. */
function numericRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') out[key] = entry
  }
  return out
}

/* ---- releases ---- */

/** The frames a release froze: the fields a render needs, and nothing that
 *  can change afterwards. */
export interface ReleaseFrame {
  id: string
  name: string
  width: number
  height: number
  x: number
  y: number
  html: string
  pageId?: string
}

export interface CanvasRelease {
  id: string
  canvasId: string
  name: string
  frames: ReleaseFrame[]
  tokens?: DesignTokens
  createdAt: number
  createdBy: string
}

/** A release's frozen frames as ordinary frames, so every path that reads a
 *  snapshot — the public preview, a handoff, a gallery listing, a copy — reads
 *  it the same way. `updatedAt` is the release time: the snapshot is the
 *  canvas as it stood then. */
export function releaseFrames(release: CanvasRelease): Frame[] {
  return release.frames.map((frame) => ({
    id: frame.id,
    canvasId: release.canvasId,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    html: frame.html,
    createdAt: 0,
    updatedAt: release.createdAt,
    updatedBy: release.createdBy,
    ...(frame.pageId ? { pageId: frame.pageId } : {}),
  }))
}

/** Store a release. Frames are copied into the row, so a later edit to the
 *  canvas cannot reach it. */
export async function saveRelease(release: CanvasRelease): Promise<void> {
  await db.insert(t.canvasReleases).values({
    id: release.id,
    canvasId: release.canvasId,
    name: release.name,
    frames: release.frames as unknown as object,
    tokens: (release.tokens ?? null) as object | null,
    createdAt: release.createdAt,
    createdBy: release.createdBy,
  })
}

/** A canvas's releases, newest first. */
export async function listReleases(canvasId: string, limit = 50): Promise<CanvasRelease[]> {
  const rows = await db
    .select()
    .from(t.canvasReleases)
    .where(eq(t.canvasReleases.canvasId, canvasId))
    .orderBy(desc(t.canvasReleases.createdAt))
    .limit(limit)
  return rows.map(toRelease)
}

/** One release, by id — the public preview route and the restore path both
 *  need it without a canvas id in hand. */
export async function getRelease(id: string): Promise<CanvasRelease | undefined> {
  const [row] = await db.select().from(t.canvasReleases).where(eq(t.canvasReleases.id, id))
  return row ? toRelease(row) : undefined
}

/** Relabel a release. Only the name moves — the frozen frames and the tokens
 *  a handoff link serves are the snapshot, and stay exactly as stored. */
export async function renameRelease(id: string, name: string): Promise<void> {
  await db.update(t.canvasReleases).set({ name }).where(eq(t.canvasReleases.id, id))
}

export async function deleteRelease(id: string): Promise<void> {
  await db.delete(t.canvasReleases).where(eq(t.canvasReleases.id, id))
}

function toRelease(row: typeof t.canvasReleases.$inferSelect): CanvasRelease {
  return {
    id: row.id,
    canvasId: row.canvasId,
    name: row.name,
    frames: row.frames as unknown as ReleaseFrame[],
    ...(row.tokens ? { tokens: row.tokens as unknown as DesignTokens } : {}),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export async function listFrameReviews(frameId: string, limit = 10): Promise<FrameReview[]> {
  const rows = await db
    .select()
    .from(t.frameReviews)
    .where(eq(t.frameReviews.frameId, frameId))
    .orderBy(desc(t.frameReviews.reviewedAt))
    .limit(limit)
  return rows.map((row) => ({
    id: row.id,
    frameId: row.frameId,
    canvasId: row.canvasId,
    htmlSha: row.htmlSha,
    frameUpdatedAt: row.frameUpdatedAt,
    verdict: row.verdict === 'pass' ? 'pass' : 'fail',
    summary: numericRecord(row.summary),
    report: row.report,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
  }))
}

async function appendFrameVersion(f: Frame) {
  const [newest] = await db
    .select({ html: t.frameVersions.html })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, f.id))
    .orderBy(desc(t.frameVersions.savedAt))
    .limit(1)
  /* an unchanged re-save (a rename, a drag) is not a design version */
  if (newest?.html === f.html) return
  await db.insert(t.frameVersions).values({
    id: nanoid(10),
    frameId: f.id,
    canvasId: f.canvasId,
    name: f.name,
    html: f.html,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    savedAt: f.updatedAt,
    savedBy: f.updatedBy,
  })
  const excess = await db
    .select({ id: t.frameVersions.id })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, f.id))
    .orderBy(desc(t.frameVersions.savedAt))
    .offset(MAX_FRAME_VERSIONS)
  if (excess.length) {
    await db.delete(t.frameVersions).where(
      inArray(
        t.frameVersions.id,
        excess.map((e) => e.id),
      ),
    )
  }
}

/* Design memory: single-shot writes, like guidelines. */
export function saveReference(canvasId: string, ref: MemoryReference) {
  swallow(
    db
      .insert(t.memoryReferences)
      .values({
        id: ref.id,
        canvasId,
        frameId: ref.frameId,
        title: ref.title,
        html: ref.html,
        width: ref.width,
        height: ref.height,
        pinnedBy: ref.pinnedBy,
        pinnedAt: ref.pinnedAt,
      })
      .onConflictDoNothing(),
  )
}

export function deleteReference(id: string) {
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.id, id)))
}

/* Components: the canvas's reusable design pieces. Single-shot writes, like
   references — the frame HTML holds the instances, so there is no projection
   to keep in step. */
function componentColumns(c: Component) {
  return {
    canvasId: c.canvasId,
    name: c.name,
    description: c.description ?? null,
    html: c.html,
    width: c.width,
    height: c.height,
    props: c.props ?? null,
    variantOf: c.variantOf ?? null,
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

export function saveComponent(c: Component) {
  swallow(
    db
      .insert(t.components)
      .values({ id: c.id, ...componentColumns(c) })
      .onConflictDoUpdate({ target: t.components.id, set: componentColumns(c) }),
  )
}

export function deleteComponentRow(id: string) {
  swallow(db.delete(t.components).where(eq(t.components.id, id)))
}

export async function loadComponents(): Promise<Component[]> {
  const rows = await db.select().from(t.components)
  return rows.map((r) => ({
    id: r.id,
    canvasId: r.canvasId,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    html: r.html,
    width: r.width,
    height: r.height,
    ...(r.props != null ? { props: r.props } : {}),
    ...(r.variantOf ? { variantOf: r.variantOf } : {}),
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

/* Cross-canvas memory: what a user taught doop about their taste. Keyed by
   user, never by canvas — that is the whole point of it. */
export function saveUserMemory(row: UserMemory) {
  swallow(
    db
      .insert(t.userMemory)
      .values({
        id: row.id,
        userId: row.userId,
        kind: row.kind,
        text: row.text,
        sourceCanvasId: row.sourceCanvasId ?? null,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing(),
  )
}

export function deleteUserMemory(id: string) {
  swallow(db.delete(t.userMemory).where(eq(t.userMemory.id, id)))
}

export async function loadUserMemory(): Promise<UserMemory[]> {
  const rows = await db.select().from(t.userMemory).orderBy(desc(t.userMemory.createdAt))
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    kind: r.kind === 'brand' || r.kind === 'workflow' ? r.kind : 'preference',
    text: r.text,
    ...(r.sourceCanvasId ? { sourceCanvasId: r.sourceCanvasId } : {}),
    createdAt: r.createdAt,
  }))
}

export function saveDecision(canvasId: string, d: DesignDecision) {
  const row = {
    id: d.id,
    canvasId,
    text: d.text,
    summary: d.summary ?? null,
    source: d.source,
    frameId: d.frameId ?? null,
    fromName: d.from,
    agentName: d.agentName ?? null,
    at: d.at,
    distilledAt: d.distilledAt ?? null,
  }
  swallow(
    db
      .insert(t.decisions)
      .values(row)
      .onConflictDoUpdate({ target: t.decisions.id, set: { summary: row.summary, distilledAt: row.distilledAt } }),
  )
}

export function saveProposal(canvasId: string, p: MemoryProposal) {
  const row = {
    id: p.id,
    canvasId,
    guideName: p.guideName,
    guideTitle: p.guideTitle ?? null,
    rule: p.rule,
    rationale: p.rationale,
    basedOn: p.basedOn.join(','),
    at: p.at,
    status: p.status,
    resolvedBy: p.resolvedBy ?? null,
    resolvedAt: p.resolvedAt ?? null,
  }
  swallow(
    db
      .insert(t.memoryProposals)
      .values(row)
      .onConflictDoUpdate({
        target: t.memoryProposals.id,
        set: { status: row.status, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt },
      }),
  )
}

/* ---- review mode, questions, run timeline, notification prefs ---- */

export function saveFrameProposal(canvasId: string, p: FrameProposal) {
  const row = {
    id: p.id,
    canvasId,
    kind: p.kind,
    frameId: p.frameId ?? null,
    name: p.name ?? null,
    html: p.html ?? null,
    x: p.x ?? null,
    y: p.y ?? null,
    width: p.width ?? null,
    height: p.height ?? null,
    baseUpdatedAt: p.baseUpdatedAt,
    summary: p.summary,
    agentName: p.agentName,
    owner: p.owner ?? null,
    ownerId: p.ownerId ?? null,
    color: p.color,
    at: p.at,
    status: p.status,
    resolvedBy: p.resolvedBy ?? null,
    resolvedAt: p.resolvedAt ?? null,
    resolutionNote: p.resolutionNote ?? null,
  }
  swallow(
    db
      .insert(t.frameProposals)
      .values(row)
      .onConflictDoUpdate({
        target: t.frameProposals.id,
        set: {
          status: row.status,
          resolvedBy: row.resolvedBy,
          resolvedAt: row.resolvedAt,
          resolutionNote: row.resolutionNote,
        },
      }),
  )
}

function toCanvasProposal(row: typeof t.canvasProposals.$inferSelect): CanvasProposal {
  return {
    id: row.id,
    canvasId: row.canvasId,
    kind: row.kind as CanvasProposal['kind'],
    payload: row.payload,
    before: row.before,
    proposedBy: row.proposedBy,
    proposedByUser: row.proposedByUser,
    status: row.status as CanvasProposal['status'],
    ...(row.resolutionNote != null ? { resolutionNote: row.resolutionNote } : {}),
    createdAt: row.createdAt,
    ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
  }
}

/** Persist a canvas-level proposal (and, through the same upsert, the
 *  resolution the accept/reject path writes onto it). */
export async function saveCanvasProposal(p: CanvasProposal): Promise<void> {
  const row = {
    id: p.id,
    canvasId: p.canvasId,
    kind: p.kind,
    payload: (p.payload ?? null) as object | null,
    before: (p.before ?? null) as object | null,
    proposedBy: p.proposedBy,
    proposedByUser: p.proposedByUser,
    status: p.status,
    resolutionNote: p.resolutionNote ?? null,
    createdAt: p.createdAt,
    resolvedAt: p.resolvedAt ?? null,
  }
  await db
    .insert(t.canvasProposals)
    .values(row)
    .onConflictDoUpdate({
      target: t.canvasProposals.id,
      set: { status: row.status, resolutionNote: row.resolutionNote, resolvedAt: row.resolvedAt },
    })
}

/** A canvas's proposals, newest first — cold path, read from the DB. */
export async function listCanvasProposals(
  canvasId: string,
  opts: { status?: CanvasProposal['status'] } = {},
): Promise<CanvasProposal[]> {
  const rows = await db
    .select()
    .from(t.canvasProposals)
    .where(
      opts.status
        ? and(eq(t.canvasProposals.canvasId, canvasId), eq(t.canvasProposals.status, opts.status))
        : eq(t.canvasProposals.canvasId, canvasId),
    )
    .orderBy(desc(t.canvasProposals.createdAt))
  return rows.map(toCanvasProposal)
}

/** Record a proposal's resolution without re-writing the row's payload. */
export async function resolveCanvasProposal(
  id: string,
  patch: { status: CanvasProposal['status']; note?: string; resolvedAt: number },
): Promise<void> {
  await db
    .update(t.canvasProposals)
    .set({ status: patch.status, resolutionNote: patch.note ?? null, resolvedAt: patch.resolvedAt })
    .where(eq(t.canvasProposals.id, id))
}

export function saveQuestion(q: AgentQuestion) {
  const row = {
    id: q.id,
    canvasId: q.canvasId,
    agentName: q.agentName,
    owner: q.owner ?? null,
    ownerId: q.ownerId ?? null,
    color: q.color,
    frameId: q.frameId ?? null,
    selector: q.selector ?? null,
    stableKey: q.stableKey ?? null,
    text: q.text,
    choices: q.choices ?? null,
    multi: q.multi ?? null,
    allowOther: q.allowOther ?? null,
    at: q.at,
    status: q.status,
    answer: q.answer ?? null,
    answeredBy: q.answeredBy ?? null,
    answeredAt: q.answeredAt ?? null,
    expiresAt: q.expiresAt,
  }
  swallow(
    db
      .insert(t.agentQuestions)
      .values(row)
      .onConflictDoUpdate({
        target: t.agentQuestions.id,
        set: { status: row.status, answer: row.answer, answeredBy: row.answeredBy, answeredAt: row.answeredAt },
      }),
  )
}

export function saveRunEvent(e: RunEvent) {
  swallow(
    db.insert(t.runEvents).values({
      id: e.id,
      canvasId: e.canvasId,
      runId: e.runId,
      agentName: e.agentName,
      at: e.at,
      kind: e.kind,
      name: e.name ?? null,
      ok: e.ok ?? null,
      ms: e.ms ?? null,
      summary: e.summary ?? null,
    }),
  )
}

/** Delete run events older than a cutoff — the timeline is a recent window,
 *  not an audit log, so the table is pruned at boot. */
export function pruneRunEvents(before: number) {
  swallow(db.delete(t.runEvents).where(lt(t.runEvents.at, before)))
}

export function saveNotificationPref(userId: string, agentEmail: boolean) {
  const now = Date.now()
  swallow(
    db
      .insert(t.notificationPrefs)
      .values({ userId, agentEmail, updatedAt: now })
      .onConflictDoUpdate({ target: t.notificationPrefs.userId, set: { agentEmail, updatedAt: now } }),
  )
}

export async function getNotificationPrefs(): Promise<Map<string, boolean>> {
  const rows = await db.select().from(t.notificationPrefs)
  return new Map(rows.map((r) => [r.userId, r.agentEmail]))
}

/* Streaming appends update a frame's html on every chunk — debounce per frame
   so the DB sees one row write per burst, not one per keystroke of the reveal. */
const frameTimers = new Map<string, NodeJS.Timeout>()
const FRAME_DEBOUNCE_MS = 400

export function saveFrame(f: Frame, immediate = false) {
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing)
  if (immediate) {
    frameTimers.delete(f.id)
    swallow(writeFrame(f))
    return
  }
  frameTimers.set(
    f.id,
    setTimeout(() => {
      frameTimers.delete(f.id)
      swallow(writeFrame(f)) // f is mutated in place by the store, so the ref holds the latest state
    }, FRAME_DEBOUNCE_MS),
  )
}

async function writeFrame(f: Frame) {
  const row = {
    id: f.id,
    canvasId: f.canvasId,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    html: f.html,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
    demo: f.demo ?? null,
    pageId: f.pageId ?? null,
  }
  const { id, createdAt, ...set } = row
  await db.insert(t.frames).values(row).onConflictDoUpdate({ target: t.frames.id, set })
  await appendFrameVersion(f)
  await syncAssetRefs(f.id, f.html)
}

/* asset_refs is a projection of frame HTML: recompute this frame's full ref
   set on every durable write (never increment/decrement — nothing to drift).
   Boot reconciles the whole table, so a lost write here self-heals. */
async function syncAssetRefs(frameId: string, html: string) {
  const ids = [...extractAssetIds(html)]
  await db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId))
  if (ids.length) {
    await db
      .insert(t.assetRefs)
      .values(ids.map((assetId) => ({ assetId, frameId })))
      .onConflictDoNothing()
  }
}

export function deleteCanvas(canvasId: string) {
  /* refs must go before the frames rows the subquery reads */
  swallow(
    db
      .delete(t.assetRefs)
      .where(
        inArray(
          t.assetRefs.frameId,
          db.select({ id: t.frames.id }).from(t.frames).where(eq(t.frames.canvasId, canvasId)),
        ),
      )
      .then(() => db.delete(t.frames).where(eq(t.frames.canvasId, canvasId))),
  )
  swallow(db.delete(t.comments).where(eq(t.comments.canvasId, canvasId)))
  swallow(db.delete(t.activity).where(eq(t.activity.canvasId, canvasId)))
  swallow(db.delete(t.guidelines).where(eq(t.guidelines.canvasId, canvasId)))
  swallow(db.delete(t.guidelineVersions).where(eq(t.guidelineVersions.canvasId, canvasId)))
  swallow(db.delete(t.frameVersions).where(eq(t.frameVersions.canvasId, canvasId)))
  swallow(db.delete(t.frameReviews).where(eq(t.frameReviews.canvasId, canvasId)))
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.canvasId, canvasId)))
  swallow(db.delete(t.decisions).where(eq(t.decisions.canvasId, canvasId)))
  swallow(db.delete(t.memoryProposals).where(eq(t.memoryProposals.canvasId, canvasId)))
  swallow(db.delete(t.pages).where(eq(t.pages.canvasId, canvasId)))
  swallow(db.delete(t.canvasMembers).where(eq(t.canvasMembers.canvasId, canvasId)))
  swallow(db.delete(t.canvases).where(eq(t.canvases.id, canvasId)))
}

export function deleteFrame(frameId: string) {
  const timer = frameTimers.get(frameId)
  if (timer) {
    clearTimeout(timer)
    frameTimers.delete(frameId)
  }
  swallow(db.delete(t.frames).where(eq(t.frames.id, frameId)))
  swallow(db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId)))
  swallow(db.delete(t.frameVersions).where(eq(t.frameVersions.frameId, frameId)))
  swallow(db.delete(t.frameReviews).where(eq(t.frameReviews.frameId, frameId)))
}

/** The email behind an account id, for agent-event notifications. */
export async function getUserEmail(userId: string): Promise<string | undefined> {
  const [row] = await db.select({ email: authUser.email }).from(authUser).where(eq(authUser.id, userId)).limit(1)
  return row?.email ?? undefined
}

export function saveComment(c: ElementComment) {
  const row = {
    id: c.id,
    canvasId: c.canvasId,
    frameId: c.frameId,
    selector: c.selector,
    stableKey: c.stableKey ?? null,
    snippet: c.snippet,
    fromName: c.from,
    fromUserId: c.fromUserId ?? null,
    text: c.text,
    at: c.at,
    forAgent: c.forAgent ?? false,
    targetAgent: c.targetAgent ?? null,
    claimedBy: c.claimedBy ?? null,
    claimedByOwner: c.claimedByOwner ?? null,
    claimedAt: c.claimedAt ?? null,
    failedAt: c.failedAt ?? null,
    failureReason: c.failureReason ?? null,
    resolvedBy: c.resolvedBy ?? null,
    resolvedAt: c.resolvedAt ?? null,
    parentId: c.parentId ?? null,
    fromKind: c.fromKind ?? null,
  }
  swallow(
    db
      .insert(t.comments)
      .values(row)
      .onConflictDoUpdate({
        target: t.comments.id,
        set: {
          claimedBy: row.claimedBy,
          claimedByOwner: row.claimedByOwner,
          claimedAt: row.claimedAt,
          failedAt: row.failedAt,
          failureReason: row.failureReason,
          resolvedBy: row.resolvedBy,
          resolvedAt: row.resolvedAt,
        },
      }),
  )
}

export function saveActivity(canvasId: string, item: ActivityItem) {
  swallow(
    db.insert(t.activity).values({
      id: item.id,
      canvasId,
      actorName: item.actorName,
      actorKind: item.actorKind,
      actorColor: item.actorColor,
      message: item.message,
      frameId: item.frameId ?? null,
      at: item.at,
    }),
  )
}

/** Flush pending debounced frame writes (called on shutdown). */
export async function flush(getFrame: (id: string) => Frame | undefined): Promise<void> {
  const ids = [...frameTimers.keys()]
  for (const [, timer] of frameTimers) clearTimeout(timer)
  frameTimers.clear()
  await Promise.allSettled(
    ids.map((id) => {
      const f = getFrame(id)
      return f ? writeFrame(f) : Promise.resolve()
    }),
  )
}

/* ------------------------------------------------------------------ */
/* Boot hydration                                                     */
/* ------------------------------------------------------------------ */

export interface Hydrated {
  canvases: Canvas[]
  comments: Map<string, ElementComment[]>
  activity: Map<string, ActivityItem[]>
  decisions: Map<string, DesignDecision[]>
  proposals: Map<string, MemoryProposal[]>
  /** canvasId -> proposals, newest first */
  frameProposals: Map<string, FrameProposal[]>
  /** canvasId -> canvas-level proposals (tokens, guidelines, breakpoints,
   *  pages), newest first — the review queue must survive a restart, or a
   *  pending proposal would be un-resolvable */
  canvasProposals: Map<string, CanvasProposal[]>
  /** canvasId -> questions, newest first */
  questions: Map<string, AgentQuestion[]>
  /** canvasId -> run events, newest first */
  runEvents: Map<string, RunEvent[]>
  /** userId -> wants email on agent events */
  notificationPrefs: Map<string, boolean>
  /** the canvas component library, keyed by canvas — absent on a hydrate
   *  written before components existed, so callers must tolerate undefined */
  components?: Map<string, Component[]>
  /** userId -> cross-canvas memory, newest first */
  userMemory?: Map<string, UserMemory[]>
}

const LOG_CAP = 100

export async function hydrate(): Promise<Hydrated> {
  const [
    canvasRows,
    frameRows,
    commentRows,
    activityRows,
    guidelineRows,
    referenceRows,
    decisionRows,
    proposalRows,
    memberRows,
    pageRows,
    frameProposalRows,
    canvasProposalRows,
    questionRows,
    runEventRows,
    notificationRows,
    componentRows,
    userMemoryRows,
  ] = await Promise.all([
    db.select().from(t.canvases),
    db.select().from(t.frames),
    db.select().from(t.comments).orderBy(desc(t.comments.at)),
    db.select().from(t.activity).orderBy(desc(t.activity.at)),
    db.select().from(t.guidelines).orderBy(t.guidelines.name),
    db.select().from(t.memoryReferences).orderBy(desc(t.memoryReferences.pinnedAt)),
    db.select().from(t.decisions).orderBy(desc(t.decisions.at)),
    db.select().from(t.memoryProposals).orderBy(desc(t.memoryProposals.at)),
    db.select().from(t.canvasMembers).orderBy(t.canvasMembers.addedAt),
    db.select().from(t.pages).orderBy(t.pages.position),
    db.select().from(t.frameProposals).orderBy(desc(t.frameProposals.at)),
    db.select().from(t.canvasProposals).orderBy(desc(t.canvasProposals.createdAt)),
    db.select().from(t.agentQuestions).orderBy(desc(t.agentQuestions.at)),
    db.select().from(t.runEvents).orderBy(desc(t.runEvents.at)),
    db.select().from(t.notificationPrefs),
    db.select().from(t.components),
    db.select().from(t.userMemory).orderBy(desc(t.userMemory.createdAt)),
  ])

  const canvases: Canvas[] = canvasRows.map((c) => ({
    id: c.id,
    name: c.name,
    ownerId: c.ownerId ?? undefined,
    linkAccess: c.linkAccess === 'edit' ? 'edit' : undefined,
    ...(c.publishedAt != null ? { publishedAt: c.publishedAt } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(isCommunityCategory(c.category) ? { category: c.category } : {}),
    ...(c.publishedReleaseId ? { publishedReleaseId: c.publishedReleaseId } : {}),
    ...(c.copyCount ? { copyCount: c.copyCount } : {}),
    ...(c.tokens ? { tokens: c.tokens as DesignTokens } : {}),
    ...(c.breakpoints ? { breakpoints: c.breakpoints as { name: string; min_width: number }[] } : {}),
    ...(c.reviewMode ? { reviewMode: true } : {}),
    ...(c.reviewPolicy === 'destructive' || c.reviewPolicy === 'all_writes' ? { reviewPolicy: c.reviewPolicy } : {}),
    ...(c.approvalTools ? { approvalTools: c.approvalTools } : {}),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    frames: [],
  }))
  const byId = new Map(canvases.map((c) => [c.id, c]))
  for (const m of memberRows) {
    const c = byId.get(m.canvasId)
    if (c) (c.memberIds ??= []).push(m.userId)
  }
  for (const f of frameRows) {
    const { pageId, ...rest } = f
    byId.get(f.canvasId)?.frames.push({ ...rest, demo: f.demo ?? undefined, ...(pageId ? { pageId } : {}) })
  }
  for (const r of referenceRows) {
    const c = byId.get(r.canvasId)
    if (!c) continue
    ;(c.references ??= []).push({
      id: r.id,
      frameId: r.frameId,
      title: r.title,
      html: r.html,
      width: r.width,
      height: r.height,
      pinnedBy: r.pinnedBy,
      pinnedAt: r.pinnedAt,
    })
  }
  for (const g of guidelineRows) {
    const c = byId.get(g.canvasId)
    if (!c) continue
    ;(c.guidelines ??= []).push({
      name: g.name,
      markdown: g.markdown,
      ...(g.title != null ? { title: g.title } : {}),
      updatedAt: g.updatedAt,
      updatedBy: g.updatedBy,
      ...(g.x != null ? { x: g.x } : {}),
      ...(g.y != null ? { y: g.y } : {}),
    })
  }

  /* Pages backfill: every canvas keeps ≥1 page and every frame carries a
     pageId. Canvases written before the pages table (or frames whose page
     row vanished) get a default "Page 1"; the fix is written back so the
     next boot reads clean. */
  {
    const now = Date.now()
    for (const c of canvases) {
      const rows = pageRows.filter((p) => p.canvasId === c.id)
      c.pages = rows.map((p) => ({
        id: p.id,
        canvasId: p.canvasId,
        name: p.name,
        position: p.position,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }))
      if (!c.pages.length) {
        const page: Page = {
          id: nanoid(10),
          canvasId: c.id,
          name: 'Page 1',
          position: 0,
          createdAt: now,
          updatedAt: now,
        }
        c.pages.push(page)
        swallow(db.insert(t.pages).values({ ...page }))
      }
      const firstPageId = c.pages[0]!.id
      const validIds = new Set(c.pages.map((p) => p.id))
      for (const f of c.frames) {
        if (!f.pageId || !validIds.has(f.pageId)) {
          f.pageId = firstPageId
          swallow(db.update(t.frames).set({ pageId: firstPageId }).where(eq(t.frames.id, f.id)))
        }
      }
    }
  }
  const now = Date.now()
  const interruptedReason = 'The agent stopped before finishing. Retry when you are ready.'

  const comments = new Map<string, ElementComment[]>()
  for (const row of commentRows) {
    const list = comments.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    const interrupted = row.claimedBy != null && row.resolvedAt == null && row.failedAt == null
    const failedAt = row.failedAt ?? (interrupted ? now : undefined)
    const failureReason = row.failureReason ?? (interrupted ? interruptedReason : undefined)
    if (interrupted) swallow(db.update(t.comments).set({ failedAt, failureReason }).where(eq(t.comments.id, row.id)))
    list.push({
      id: row.id,
      canvasId: row.canvasId,
      frameId: row.frameId,
      selector: row.selector,
      ...(row.stableKey != null ? { stableKey: row.stableKey } : {}),
      snippet: row.snippet,
      from: row.fromName,
      ...(row.fromUserId != null ? { fromUserId: row.fromUserId } : {}),
      text: row.text,
      at: row.at,
      ...(row.forAgent ? { forAgent: true } : {}),
      ...(row.targetAgent != null ? { targetAgent: row.targetAgent } : {}),
      ...(row.claimedBy != null ? { claimedBy: row.claimedBy } : {}),
      ...(row.claimedByOwner != null ? { claimedByOwner: row.claimedByOwner } : {}),
      ...(row.claimedAt != null ? { claimedAt: row.claimedAt } : {}),
      ...(failedAt !== undefined ? { failedAt } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
      ...(row.parentId != null ? { parentId: row.parentId } : {}),
      ...(row.fromKind === 'agent' ? { fromKind: 'agent' as const } : {}),
    })
    comments.set(row.canvasId, list)
  }

  const activity = new Map<string, ActivityItem[]>()
  for (const row of activityRows) {
    const list = activity.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      actorName: row.actorName,
      actorKind: row.actorKind as ActivityItem['actorKind'],
      actorColor: row.actorColor,
      message: row.message,
      frameId: row.frameId ?? undefined,
      at: row.at,
    })
    activity.set(row.canvasId, list)
  }

  const decisions = new Map<string, DesignDecision[]>()
  for (const row of decisionRows) {
    const list = decisions.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      text: row.text,
      ...(row.summary != null ? { summary: row.summary } : {}),
      source: row.source as DesignDecision['source'],
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      from: row.fromName,
      ...(row.agentName != null ? { agentName: row.agentName } : {}),
      at: row.at,
      ...(row.distilledAt != null ? { distilledAt: row.distilledAt } : {}),
    })
    decisions.set(row.canvasId, list)
  }

  const proposals = new Map<string, MemoryProposal[]>()
  for (const row of proposalRows) {
    const list = proposals.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      guideName: row.guideName,
      ...(row.guideTitle != null ? { guideTitle: row.guideTitle } : {}),
      rule: row.rule,
      rationale: row.rationale,
      basedOn: row.basedOn.split(',').filter(Boolean),
      at: row.at,
      status: row.status as MemoryProposal['status'],
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
    })
    proposals.set(row.canvasId, list)
  }

  const frameProposals = new Map<string, FrameProposal[]>()
  for (const row of frameProposalRows) {
    const list = frameProposals.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      kind: row.kind as FrameProposal['kind'],
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      ...(row.name != null ? { name: row.name } : {}),
      ...(row.html != null ? { html: row.html } : {}),
      ...(row.x != null ? { x: row.x } : {}),
      ...(row.y != null ? { y: row.y } : {}),
      ...(row.width != null ? { width: row.width } : {}),
      ...(row.height != null ? { height: row.height } : {}),
      baseUpdatedAt: row.baseUpdatedAt,
      summary: row.summary,
      agentName: row.agentName,
      ...(row.owner != null ? { owner: row.owner } : {}),
      ...(row.ownerId != null ? { ownerId: row.ownerId } : {}),
      color: row.color,
      at: row.at,
      status: row.status as FrameProposal['status'],
      ...(row.resolvedBy != null ? { resolvedBy: row.resolvedBy } : {}),
      ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
      ...(row.resolutionNote != null ? { resolutionNote: row.resolutionNote } : {}),
    })
    frameProposals.set(row.canvasId, list)
  }

  const canvasProposals = new Map<string, CanvasProposal[]>()
  for (const row of canvasProposalRows) {
    const list = canvasProposals.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push(toCanvasProposal(row))
    canvasProposals.set(row.canvasId, list)
  }

  const questions = new Map<string, AgentQuestion[]>()
  for (const row of questionRows) {
    const list = questions.get(row.canvasId) ?? []
    if (list.length >= LOG_CAP) continue
    list.push({
      id: row.id,
      canvasId: row.canvasId,
      agentName: row.agentName,
      ...(row.owner != null ? { owner: row.owner } : {}),
      ...(row.ownerId != null ? { ownerId: row.ownerId } : {}),
      color: row.color,
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      ...(row.selector != null ? { selector: row.selector } : {}),
      ...(row.stableKey != null ? { stableKey: row.stableKey } : {}),
      text: row.text,
      ...(row.choices?.length ? { choices: row.choices } : {}),
      ...(row.multi != null ? { multi: row.multi } : {}),
      ...(row.allowOther != null ? { allowOther: row.allowOther } : {}),
      at: row.at,
      status: row.status as AgentQuestion['status'],
      ...(row.answer != null ? { answer: row.answer } : {}),
      ...(row.answeredBy != null ? { answeredBy: row.answeredBy } : {}),
      ...(row.answeredAt != null ? { answeredAt: row.answeredAt } : {}),
      expiresAt: row.expiresAt,
    })
    questions.set(row.canvasId, list)
  }

  const runEvents = new Map<string, RunEvent[]>()
  for (const row of runEventRows) {
    const list = runEvents.get(row.canvasId) ?? []
    if (list.length >= 200) continue
    list.push({
      id: row.id,
      canvasId: row.canvasId,
      runId: row.runId,
      agentName: row.agentName,
      at: row.at,
      kind: row.kind as RunEvent['kind'],
      ...(row.name != null ? { name: row.name } : {}),
      ...(row.ok != null ? { ok: row.ok } : {}),
      ...(row.ms != null ? { ms: row.ms } : {}),
      ...(row.summary != null ? { summary: row.summary } : {}),
      ...(row.frameId != null ? { frameId: row.frameId } : {}),
      ...(row.beforeVersionId != null ? { beforeVersionId: row.beforeVersionId } : {}),
      ...(row.afterVersionId != null ? { afterVersionId: row.afterVersionId } : {}),
    })
    runEvents.set(row.canvasId, list)
  }

  const notificationPrefs = new Map<string, boolean>(notificationRows.map((r) => [r.userId, r.agentEmail]))

  const components = new Map<string, Component[]>()
  for (const row of componentRows) {
    const list = components.get(row.canvasId) ?? []
    list.push({
      id: row.id,
      canvasId: row.canvasId,
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      html: row.html,
      width: row.width,
      height: row.height,
      ...(row.props != null ? { props: row.props } : {}),
      ...(row.variantOf ? { variantOf: row.variantOf } : {}),
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    components.set(row.canvasId, list)
  }

  const userMemory = new Map<string, UserMemory[]>()
  for (const row of userMemoryRows) {
    const list = userMemory.get(row.userId) ?? []
    list.push({
      id: row.id,
      userId: row.userId,
      kind: row.kind === 'brand' || row.kind === 'workflow' ? row.kind : 'preference',
      text: row.text,
      ...(row.sourceCanvasId ? { sourceCanvasId: row.sourceCanvasId } : {}),
      createdAt: row.createdAt,
    })
    userMemory.set(row.userId, list)
  }

  return {
    canvases,
    comments,
    activity,
    decisions,
    proposals,
    frameProposals,
    canvasProposals,
    questions,
    runEvents,
    notificationPrefs,
    components,
    userMemory,
  }
}

/** One-time import of the pre-DB data/store.json so existing canvases survive. */
export async function importLegacyJson(): Promise<Canvas[] | null> {
  const file = path.join(process.cwd(), 'data', 'store.json')
  let parsed: Canvas[]
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  for (const c of parsed) {
    await db
      .insert(t.canvases)
      .values({ id: c.id, name: c.name, createdAt: c.createdAt, updatedAt: c.updatedAt })
      .onConflictDoNothing()
    for (const f of c.frames) await writeFrame(f)
  }
  fs.renameSync(file, `${file}.imported`)
  console.log(`[db] imported ${parsed.length} canvas(es) from legacy store.json`)
  return parsed
}
