import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, max, or } from 'drizzle-orm'
import { db } from './index.ts'
import * as t from './schema.ts'
import * as authSchema from './auth-schema.ts'
import { extractAssetIds } from '../assets.ts'
import { isCommunityCategory } from '../../shared/types.ts'
import type {
  ActivityItem,
  AgentMessage,
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

/** Every write nobody awaits, so flush() can wait for them before the database
 *  is closed. Closing over a write still in flight is not merely a lost row:
 *  PGlite's close spins forever in its WASM exit path when it lands mid-query,
 *  so the shutdown's own timeout is the only thing that ends the process, with
 *  ./data/pg left unsynced. */
const inFlightWrites = new Set<Promise<unknown>>()

function swallow(p: Promise<unknown>): void {
  /* the tracked copy cannot reject — a failed write is logged, not thrown at a
     caller that has nowhere to put it, and a rejection here would be unhandled */
  const tracked = p.catch((err) => console.error('[db] write failed', err))
  inFlightWrites.add(tracked)
  void tracked.then(() => inFlightWrites.delete(tracked))
}

/** every mutable canvas column, so insert and upsert can't drift apart */
function canvasColumns(c: Canvas) {
  return {
    name: c.name,
    ownerId: c.ownerId ?? null,
    linkAccess: c.linkAccess ?? null,
    /* link_password_hash is deliberately NOT here: it is written by
       saveLinkPassword alone (a password change is not a canvas edit, and an
       ordinary canvas write must not clobber it with a stale null) */
    linkExpiresAt: c.linkExpiresAt ?? null,
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
          z: frame.z ?? 0,
          locked: frame.locked ?? false,
          hidden: frame.hidden ?? false,
          rotation: frame.rotation ?? 0,
          opacity: frame.opacity ?? 1,
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

export function saveMember(canvasId: string, userId: string, addedBy: string, addedAt: number, role: string) {
  swallow(
    db
      .insert(t.canvasMembers)
      .values({ canvasId, userId, addedBy, addedAt, role })
      /* an existing membership keeps the role it was given: re-inviting
         someone is not a demotion */
      .onConflictDoNothing(),
  )
}

/** Change a member's role. The primary key is (canvas_id, user_id), so this is
 *  an update of a row that exists by construction — the caller has already
 *  refused a user who is not a member. */
export function saveMemberRole(canvasId: string, userId: string, role: string) {
  swallow(
    db
      .update(t.canvasMembers)
      .set({ role })
      .where(and(eq(t.canvasMembers.canvasId, canvasId), eq(t.canvasMembers.userId, userId))),
  )
}

/** The share link's password (a scrypt hash, or null to clear it). Its own
 *  writer, like the other one-column settings, and never part of the canvas
 *  projection: the hash is a credential, not canvas state. */
export function saveLinkPassword(canvasId: string, hash: string | null) {
  swallow(db.update(t.canvases).set({ linkPasswordHash: hash }).where(eq(t.canvases.id, canvasId)))
}

export function deleteMember(canvasId: string, userId: string) {
  swallow(
    db.delete(t.canvasMembers).where(and(eq(t.canvasMembers.canvasId, canvasId), eq(t.canvasMembers.userId, userId))),
  )
}

/* ---- email invitations (canvas_invites) ----
   The invite surface is cold by construction — an owner sends a handful, and
   the accepting side reads exactly one — so it is read straight from the
   database rather than mirrored in memory like the canvas maps. */

/** A pending invitation as the routes read it. */
export interface CanvasInviteRow {
  id: string
  canvasId: string
  email: string
  role: string
  token: string
  createdBy: string
  createdAt: number
  expiresAt: number
  acceptedAt?: number
  acceptedBy?: string
}

/** How long an invitation stays valid. A week is long enough to survive a
 *  weekend and a signup, short enough that a leaked inbox is not permanent. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000

/** The invite token, in the same shape as a design-sync key ('dk_' + nanoid):
 *  a prefixed nanoid, so it is URL-safe, unguessable, and recognisable in a
 *  log or a paste. */
export function newInviteToken(): string {
  return 'ci_' + nanoid(24)
}

export function saveInvite(row: CanvasInviteRow) {
  swallow(db.insert(t.canvasInvites).values({ ...row, acceptedAt: null, acceptedBy: null }))
}

/** Replace any pending invite for this email on this canvas: one live
 *  invitation per person per canvas, so the list an owner sees has no stale
 *  duplicates and the newest link is the one that works. */
export function clearPendingInvites(canvasId: string, email: string) {
  swallow(
    db
      .delete(t.canvasInvites)
      .where(
        and(
          eq(t.canvasInvites.canvasId, canvasId),
          eq(t.canvasInvites.email, email),
          isNull(t.canvasInvites.acceptedAt),
        ),
      ),
  )
}

/** Remove an invitation from a canvas. Answers whether a row by that id was
 *  there — the route turns false into a 404, so an id from another canvas
 *  cannot be used to probe what exists. */
export async function deleteInvite(canvasId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(t.canvasInvites)
    .where(and(eq(t.canvasInvites.canvasId, canvasId), eq(t.canvasInvites.id, id)))
    .returning({ id: t.canvasInvites.id })
  return rows.length > 0
}

function toInvite(row: typeof t.canvasInvites.$inferSelect): CanvasInviteRow {
  return {
    id: row.id,
    canvasId: row.canvasId,
    email: row.email,
    role: row.role,
    token: row.token,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.acceptedAt != null ? { acceptedAt: row.acceptedAt } : {}),
    ...(row.acceptedBy != null ? { acceptedBy: row.acceptedBy } : {}),
  }
}

/** A canvas's invitations, newest first. Accepted and expired rows are left
 *  out: the list is "who is still pending". */
export async function listInvites(canvasId: string, now = Date.now()): Promise<CanvasInviteRow[]> {
  const rows = await db
    .select()
    .from(t.canvasInvites)
    .where(eq(t.canvasInvites.canvasId, canvasId))
    .orderBy(desc(t.canvasInvites.createdAt))
  return rows.map(toInvite).filter((row) => row.acceptedAt === undefined && row.expiresAt > now)
}

/** One invitation by its token, accepted or not — the route decides what an
 *  accepted or expired one means. */
export async function getInvite(token: string): Promise<CanvasInviteRow | undefined> {
  const [row] = await db.select().from(t.canvasInvites).where(eq(t.canvasInvites.token, token)).limit(1)
  return row ? toInvite(row) : undefined
}

/** Stamp an invitation as used. Not swallowing the error: the caller only
 *  answers ok after this resolves, so a failed stamp cannot silently leave an
 *  invitation re-usable. */
export async function acceptInvite(id: string, userId: string, at: number): Promise<void> {
  await db.update(t.canvasInvites).set({ acceptedAt: at, acceptedBy: userId }).where(eq(t.canvasInvites.id, id))
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
    /* a name is a slot, not a row history: saving "brand" again after it was
       deleted revives the same row rather than colliding with the trashed one */
    deletedAt: null,
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
          deletedAt: null,
        },
      }),
  )
}

/** Trash a design doc: the row stays (its name is a primary key) and the purge
 *  job removes it past the retention window. */
export function deleteGuideline(canvasId: string, name: string) {
  swallow(
    db
      .update(t.guidelines)
      .set({ deletedAt: Date.now() })
      .where(and(eq(t.guidelines.canvasId, canvasId), eq(t.guidelines.name, name))),
  )
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

/** Trash a page: the row stays so its frames keep a page to come back to, and
 *  the purge job removes it past the retention window. */
export function deletePage(pageId: string) {
  swallow(db.update(t.pages).set({ deletedAt: Date.now() }).where(eq(t.pages.id, pageId)))
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

/** The newest version row's id for a frame, or undefined when the frame has
 *  never been versioned. What the run timeline records as a step's
 *  before/after — a frame write reaches the database on a debounce, so this
 *  is also how a step learns the id of the version its own write produced. */
export async function latestFrameVersionId(frameId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: t.frameVersions.id })
    .from(t.frameVersions)
    .where(eq(t.frameVersions.frameId, frameId))
    .orderBy(desc(t.frameVersions.savedAt))
    .limit(1)
  return row?.id
}

/* Verification reports: append-only, capped per frame. Written from the
   review_frame and review_canvas tools, read by the checks panel and by the
   ship gates (create_release, publish_canvas, open_pull_request, restore_release)
   when they decide whether a delivery may ship. */
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
  /** stacking, lock, visibility, rotation and opacity travel with the frozen
   *  frame so a restored release — or a copy made from one — comes back looking
   *  exactly as it did when it was released */
  z: number
  locked: boolean
  hidden: boolean
  rotation: number
  opacity: number
  pageId?: string
}

/** What a frozen canvas holds, whatever made it: a release and a canvas version
 *  have the same body and read back through the same `releaseFrames`, so every
 *  path that renders a snapshot behaves identically. */
export interface CanvasSnapshot {
  canvasId: string
  frames: ReleaseFrame[]
  tokens?: DesignTokens
  createdAt: number
  createdBy: string
}

export interface CanvasRelease extends CanvasSnapshot {
  id: string
  name: string
}

/** A release's frozen frames as ordinary frames, so every path that reads a
 *  snapshot — the public preview, a handoff, a gallery listing, a copy, a
 *  restore from canvas history — reads it the same way. `updatedAt` is the
 *  snapshot time: the frames are the canvas as it stood then. */
export function releaseFrames(snapshot: CanvasSnapshot): Frame[] {
  return snapshot.frames.map((frame, i) => ({
    id: frame.id,
    canvasId: snapshot.canvasId,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    html: frame.html,
    /* a snapshot stored before the frame model carried stacking has no z: its
       array order is the stacking it was frozen with, so the index stands in */
    z: frame.z ?? i,
    locked: frame.locked ?? false,
    hidden: frame.hidden ?? false,
    rotation: frame.rotation ?? 0,
    opacity: frame.opacity ?? 1,
    createdAt: 0,
    updatedAt: snapshot.createdAt,
    updatedBy: snapshot.createdBy,
    ...(frame.pageId ? { pageId: frame.pageId } : {}),
  }))
}

/** Freeze live frames into the shape a snapshot stores. Shared by releases and
 *  canvas versions, so a snapshot made by a human, by an agent, by the auto
 *  cadence or on a delete is the same artifact. Product-made onboarding frames
 *  are left out: they are the welcome tour that happened to sit on the canvas,
 *  not part of the canvas. */
export function freezeFrames(frames: Frame[]): ReleaseFrame[] {
  return frames
    .filter((frame) => !frame.demo)
    .map((frame) => ({
      id: frame.id,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      x: frame.x,
      y: frame.y,
      html: frame.html,
      z: frame.z,
      locked: frame.locked,
      hidden: frame.hidden,
      rotation: frame.rotation,
      opacity: frame.opacity,
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

/* ---- canvas versions (history) ---- */

/** Why a snapshot was taken: the cadence, a delete, the History tab's "save
 *  now", or a restore (which records itself so a rollback is itself undoable). */
export type CanvasVersionCause = 'auto' | 'delete' | 'manual' | 'restore'

/** The row a canvas's version history is made of. Same body as a release —
 *  see CanvasSnapshot — plus why and when it was taken. */
export interface CanvasVersion extends CanvasSnapshot {
  id: string
  cause: CanvasVersionCause
}

/** What the timeline renders: everything but the frames, which can be
 *  megabytes each. */
export interface CanvasVersionSummary {
  id: string
  cause: CanvasVersionCause
  createdAt: number
  createdBy: string
  frameCount: number
}

/** Newest per canvas, the same cap frame_versions and guideline_versions keep. */
export const MAX_CANVAS_VERSIONS = 50

export function summarizeCanvasVersion(v: CanvasVersion): CanvasVersionSummary {
  return {
    id: v.id,
    cause: v.cause,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    frameCount: v.frames.length,
  }
}

/** Store a snapshot, then cap the canvas's history. Fire-and-forget like the
 *  other write-through helpers: the in-memory ring already has it. */
export function saveCanvasVersion(v: CanvasVersion) {
  swallow(writeCanvasVersion(v))
}

async function writeCanvasVersion(v: CanvasVersion) {
  await db.insert(t.canvasVersions).values({
    id: v.id,
    canvasId: v.canvasId,
    cause: v.cause,
    frames: v.frames as unknown as object,
    tokens: (v.tokens ?? null) as object | null,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  })
  await pruneCanvasVersions(v.canvasId)
}

/** A canvas's history, newest first, as summaries. Cold path — the History tab
 *  is the only reader, and the store's ring answers the hot reads. */
export async function listCanvasVersions(
  canvasId: string,
  limit = MAX_CANVAS_VERSIONS,
): Promise<CanvasVersionSummary[]> {
  const rows = await db
    .select({
      id: t.canvasVersions.id,
      cause: t.canvasVersions.cause,
      createdAt: t.canvasVersions.createdAt,
      createdBy: t.canvasVersions.createdBy,
      frames: t.canvasVersions.frames,
    })
    .from(t.canvasVersions)
    .where(eq(t.canvasVersions.canvasId, canvasId))
    .orderBy(desc(t.canvasVersions.createdAt))
    .limit(limit)
  return rows.map((row) => ({
    id: row.id,
    /* a stored cause is text at the boundary: an unknown one reads as 'auto'
       rather than leaking past the union */
    cause: row.cause === 'delete' || row.cause === 'manual' || row.cause === 'restore' ? row.cause : 'auto',
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    frameCount: Array.isArray(row.frames) ? row.frames.length : 0,
  }))
}

/** One snapshot in full, frames included. Read on demand — restoring and the
 *  History tab's preview are the only callers. */
export async function getCanvasVersion(id: string): Promise<CanvasVersion | undefined> {
  const [row] = await db.select().from(t.canvasVersions).where(eq(t.canvasVersions.id, id))
  if (!row) return undefined
  return {
    id: row.id,
    canvasId: row.canvasId,
    cause: row.cause === 'delete' || row.cause === 'manual' || row.cause === 'restore' ? row.cause : 'auto',
    frames: row.frames as unknown as ReleaseFrame[],
    ...(row.tokens ? { tokens: row.tokens as unknown as DesignTokens } : {}),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export async function deleteCanvasVersion(id: string): Promise<void> {
  await db.delete(t.canvasVersions).where(eq(t.canvasVersions.id, id))
}

/** Keep the newest MAX_CANVAS_VERSIONS and drop the rest — the cap is per
 *  canvas, exactly like frame_versions. */
export async function pruneCanvasVersions(canvasId: string): Promise<void> {
  const excess = await db
    .select({ id: t.canvasVersions.id })
    .from(t.canvasVersions)
    .where(eq(t.canvasVersions.canvasId, canvasId))
    .orderBy(desc(t.canvasVersions.createdAt))
    .offset(MAX_CANVAS_VERSIONS)
  if (excess.length) {
    await db.delete(t.canvasVersions).where(
      inArray(
        t.canvasVersions.id,
        excess.map((e) => e.id),
      ),
    )
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

/** Trash a component: out of the library at once, hard-deleted by the purge
 *  job past the retention window. */
export function deleteComponentRow(id: string) {
  swallow(db.update(t.components).set({ deletedAt: Date.now() }).where(eq(t.components.id, id)))
}

export async function loadComponents(): Promise<Component[]> {
  const rows = await db.select().from(t.components).where(isNull(t.components.deletedAt))
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

/** Delete run events older than a cutoff — the timeline is a recent window,
 *  not an audit log, so the table is pruned at boot. */
export function pruneRunEvents(before: number) {
  swallow(db.delete(t.runEvents).where(lt(t.runEvents.at, before)))
}

/** A stored run-event row as the in-memory shape, the five version/frame
 *  fields and the actor identity included. Shared by the boot hydrate and the
 *  paged read below, so a step the ring never held reads exactly like one it
 *  did — and a field added here cannot reach one path and miss the other. */
function toRunEvent(row: typeof t.runEvents.$inferSelect): RunEvent {
  return {
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
    ...(row.args != null ? { args: row.args } : {}),
    ...(row.actorKind != null ? { actorKind: row.actorKind as RunEvent['actorKind'] } : {}),
    ...(row.agentId != null ? { agentId: row.agentId } : {}),
    ...(row.frameId != null ? { frameId: row.frameId } : {}),
    ...(row.beforeVersionId != null ? { beforeVersionId: row.beforeVersionId } : {}),
    ...(row.afterVersionId != null ? { afterVersionId: row.afterVersionId } : {}),
  }
}

/** How many rows a timeline page holds unless the caller asks for fewer. */
const DEFAULT_RUN_EVENT_PAGE = 200

/** One page of a canvas's timeline, newest first, with whether a further row
 *  exists behind it — the caller's `has_more` without a second count query. */
export interface RunEventPage {
  events: RunEvent[]
  hasMore: boolean
}

/** A page of a canvas's run timeline out of the durable table, newest first,
 *  optionally one run's. The ring (server/runLog.ts) answers the hot reads and
 *  is hydrated from the newest rows, so it is a prefix of this order; every
 *  step behind that prefix is only here, which is what keeps a busy canvas's
 *  history reachable instead of stopping at the ring's edge.
 *
 *  The order is `at` descending with the row id as a tiebreaker: two steps can
 *  share a millisecond, and an order that is not total would let an offset land
 *  in the middle of such a group twice — a page repeating a row, or skipping
 *  one — while stepping `offset` forward. The id is the primary key, so it
 *  breaks every tie exactly once.
 *
 *  Cold path: a page per press of the Run tab's "Load older", not a per-tick
 *  read. One row past the page is fetched and dropped, which is what answers
 *  `hasMore` in the same query rather than a second count. */
export async function listRunEvents(
  canvasId: string,
  opts: { runId?: string; limit?: number; offset?: number } = {},
): Promise<RunEventPage> {
  const limit = Math.max(opts.limit ?? DEFAULT_RUN_EVENT_PAGE, 1)
  const offset = Math.max(opts.offset ?? 0, 0)
  const rows = await db
    .select()
    .from(t.runEvents)
    .where(
      opts.runId
        ? and(eq(t.runEvents.canvasId, canvasId), eq(t.runEvents.runId, opts.runId))
        : eq(t.runEvents.canvasId, canvasId),
    )
    .orderBy(desc(t.runEvents.at), desc(t.runEvents.id))
    .offset(offset)
    .limit(limit + 1)
  return { events: rows.slice(0, limit).map(toRunEvent), hasMore: rows.length > limit }
}

/** Per-user mail preferences, one switch per class of agent event. All
 *  default off, so a user with no row wants no mail — a caller reads the
 *  absence as all-false rather than as "unset and therefore maybe". */
export interface NotificationPrefs {
  /** mailed about an agent question waiting on a human */
  agentEmail: boolean
  /** mailed when a run finished */
  agentFinishEmail: boolean
  /** mailed when a run failed, or a human stopped it */
  agentFailEmail: boolean
}

/** Upsert exactly the switches the caller passed: a settings route that
 *  accepts a partial body must not reset the ones it did not mention. A row
 *  that does not exist yet gets the schema defaults (all false) for the rest. */
export function saveNotificationPref(userId: string, prefs: Partial<NotificationPrefs>) {
  const now = Date.now()
  const set: Partial<NotificationPrefs> & { updatedAt: number } = { ...prefs, updatedAt: now }
  swallow(
    db
      .insert(t.notificationPrefs)
      .values({ userId, updatedAt: now, ...prefs })
      .onConflictDoUpdate({ target: t.notificationPrefs.userId, set }),
  )
}

export async function getNotificationPrefs(): Promise<Map<string, NotificationPrefs>> {
  const rows = await db.select().from(t.notificationPrefs)
  return new Map(
    rows.map((r) => [
      r.userId,
      { agentEmail: r.agentEmail, agentFinishEmail: r.agentFinishEmail, agentFailEmail: r.agentFailEmail },
    ]),
  )
}

/* ---- agent identities (agents) ----
   An agent arrives once per connection and heartbeats rarely, so this is a cold
   path read straight from the database — the choice the invite surface makes.
   The one awaited write is the arrival, which answers with the id. */

/** One connected agent as the rest of the server reads it. */
export interface AgentRow {
  id: string
  ownerId: string
  /** the OAuth client it connected through; absent for an unauthenticated one */
  clientId?: string
  name: string
  createdAt: number
  lastSeenAt: number
  /** set once the client behind it was disconnected; absent = live */
  revokedAt?: number
}

function toAgent(row: typeof t.agents.$inferSelect): AgentRow {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    ...(row.clientId != null ? { clientId: row.clientId } : {}),
    ...(row.revokedAt != null ? { revokedAt: row.revokedAt } : {}),
  }
}

/** Upsert an agent by (owner_id, name) and answer the row as stored: a name its
 *  owner has used before keeps its id — that id IS the identity — and only the
 *  heartbeat and the client move. The caller mints the id and the timestamp, so
 *  a losing insert costs nothing. Awaited rather than swallowed, unlike the
 *  write-through helpers, because the caller answers with the id. */
export async function upsertAgent(row: {
  id: string
  ownerId: string
  name: string
  clientId?: string
  at: number
}): Promise<AgentRow> {
  const [stored] = await db
    .insert(t.agents)
    .values({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      clientId: row.clientId ?? null,
      createdAt: row.at,
      lastSeenAt: row.at,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [t.agents.ownerId, t.agents.name],
      set: { clientId: row.clientId ?? null, lastSeenAt: row.at, revokedAt: null },
    })
    .returning()
  if (!stored) throw new Error('agent upsert returned no row')
  return toAgent(stored)
}

/** Move the heartbeat. A heartbeat never resurrects a revoked identity — only a
 *  fresh arrival does, because only a fresh arrival proves a live connection. */
export async function heartbeatAgent(id: string, at = Date.now()): Promise<void> {
  await db.update(t.agents).set({ lastSeenAt: at }).where(eq(t.agents.id, id))
}

/** An owner's agents, most recently seen first. */
export async function listAgentsForOwner(ownerId: string): Promise<AgentRow[]> {
  const rows = await db.select().from(t.agents).where(eq(t.agents.ownerId, ownerId)).orderBy(desc(t.agents.lastSeenAt))
  return rows.map(toAgent)
}

/** One agent by id — the join the permissions and attribution paths make. */
export async function getAgent(id: string): Promise<AgentRow | undefined> {
  const [row] = await db.select().from(t.agents).where(eq(t.agents.id, id)).limit(1)
  return row ? toAgent(row) : undefined
}

/** Revoke every identity that connected through one OAuth client — what
 *  disconnecting the client means. Only the first revocation is stamped, so a
 *  second one cannot move the time the identity died. */
export async function revokeAgentsForClient(ownerId: string, clientId: string, at = Date.now()): Promise<void> {
  await db
    .update(t.agents)
    .set({ revokedAt: at })
    .where(and(eq(t.agents.ownerId, ownerId), eq(t.agents.clientId, clientId), isNull(t.agents.revokedAt)))
}

/* ---- per-agent permission levels (agent_levels) ----
   An owner's leash on one agent on one canvas. Cold path, like the identities
   above: the MCP wrapper looks a level up per call and the panel writes one
   when the owner moves a chip, so there is nothing hot enough to mirror. A
   row only ever holds a narrowed level — `full` is the absence of one (see
   store.setAgentLevel) — which keeps "no row" the single spelling of the
   default. */

/** The levels an agent can be held to. `full` is the default and is never
 *  stored: it is what an absent row means. */
export type AgentLevel = 'full' | 'propose' | 'comment' | 'view'

/** One agent's level on one canvas, as the rest of the server reads it. */
export interface AgentLevelRow {
  canvasId: string
  agentId: string
  level: AgentLevel
  /** the owner who set it */
  setBy: string
  setAt: number
}

function toAgentLevel(row: typeof t.agentLevels.$inferSelect): AgentLevelRow {
  return {
    canvasId: row.canvasId,
    agentId: row.agentId,
    level: row.level as AgentLevel,
    setBy: row.setBy,
    setAt: row.setAt,
  }
}

/** Upsert one agent's level and answer the row as stored. Awaited rather than
 *  swallowed: the caller answers the REST route with what was actually
 *  written, and the panel must not show a chip the server did not take. The
 *  caller stamps `at`, so nothing is computed here that a conflict discards. */
export async function setAgentLevel(row: {
  canvasId: string
  agentId: string
  level: AgentLevel
  setBy: string
  at: number
}): Promise<AgentLevelRow> {
  const [stored] = await db
    .insert(t.agentLevels)
    .values({ canvasId: row.canvasId, agentId: row.agentId, level: row.level, setBy: row.setBy, setAt: row.at })
    .onConflictDoUpdate({
      target: [t.agentLevels.canvasId, t.agentLevels.agentId],
      set: { level: row.level, setBy: row.setBy, setAt: row.at },
    })
    .returning()
  if (!stored) throw new Error('agent level upsert returned no row')
  return toAgentLevel(stored)
}

/** Back to the default: the row is dropped, and the agent is `full` again. */
export async function clearAgentLevel(canvasId: string, agentId: string): Promise<void> {
  await db.delete(t.agentLevels).where(and(eq(t.agentLevels.canvasId, canvasId), eq(t.agentLevels.agentId, agentId)))
}

/** One agent's level on one canvas; absent = `full`. */
export async function getAgentLevel(canvasId: string, agentId: string): Promise<AgentLevelRow | undefined> {
  const [row] = await db
    .select()
    .from(t.agentLevels)
    .where(and(eq(t.agentLevels.canvasId, canvasId), eq(t.agentLevels.agentId, agentId)))
    .limit(1)
  return row ? toAgentLevel(row) : undefined
}

/** Every narrowed level on a canvas, most recently set first — the owner's
 *  panel. Agents at `full` are absent by construction. */
export async function listAgentLevels(canvasId: string): Promise<AgentLevelRow[]> {
  const rows = await db
    .select()
    .from(t.agentLevels)
    .where(eq(t.agentLevels.canvasId, canvasId))
    .orderBy(desc(t.agentLevels.setAt))
  return rows.map(toAgentLevel)
}

/** A canvas is gone: the leashes its owner set go with it. */
export function deleteAgentLevelsForCanvas(canvasId: string) {
  swallow(db.delete(t.agentLevels).where(eq(t.agentLevels.canvasId, canvasId)))
}

/* ---- the agent↔human bus (agent_events / agent_signals) ----
   The bus and its stop/steer registry live in server/agentEvents.ts as
   in-process state; these are the durable halves of both. An event is written
   behind, like the run timeline: the ring already holds it, and losing
   durability must not fail the tool call that published it. A signal is never
   deleted on the way out — it is stamped taken — so a restart cannot hand the
   same stop to the agent twice. Both are read once at boot, by
   agentEvents.hydrate. */

/** One published bus event, as the row stores it. */
export interface AgentEventRow {
  canvasId: string
  seq: number
  kind: string
  at: number
  /** the human-readable field the event carried (a comment's text, a steer's
   *  message); absent when the event has none */
  summary?: string
  /** the agent or role the event was addressed to; absent = everyone */
  targetAgent?: string
}

export function saveAgentEvent(row: AgentEventRow) {
  swallow(
    db.insert(t.agentEvents).values({
      canvasId: row.canvasId,
      seq: row.seq,
      kind: row.kind,
      at: row.at,
      summary: row.summary ?? null,
      targetAgent: row.targetAgent ?? null,
    }),
  )
}

/** The highest sequence each canvas ever published — the counter a restart
 *  resumes from, so a seq an agent took before the restart still means "I have
 *  seen up to here". A canvas with no rows is absent from the map: its counter
 *  starts at 1. */
export async function agentEventCursors(): Promise<Map<string, number>> {
  const rows = await db
    .select({ canvasId: t.agentEvents.canvasId, seq: max(t.agentEvents.seq) })
    .from(t.agentEvents)
    .groupBy(t.agentEvents.canvasId)
  const cursors = new Map<string, number>()
  for (const row of rows) if (row.seq != null) cursors.set(row.canvasId, Number(row.seq))
  return cursors
}

/** Retention: drop bus events at or before a cutoff — the same seven-day
 *  window the run timeline keeps. */
export function pruneAgentEvents(before: number) {
  swallow(db.delete(t.agentEvents).where(lte(t.agentEvents.at, before)))
}

/** A canvas is gone: its bus events go with it. */
export function deleteAgentEventsForCanvas(canvasId: string) {
  swallow(db.delete(t.agentEvents).where(eq(t.agentEvents.canvasId, canvasId)))
}

/** One stop or steer, as the row stores it. `target` is the registry key the
 *  in-process map files it under — the agent name trimmed and lowercased, the
 *  same string `signalKeys` looks a signal up by. */
export interface AgentSignalRow {
  canvasId: string
  target: string
  kind: 'stop' | 'steer'
  message?: string
  /** who asked — the human's display name */
  by: string
  at: number
}

export function saveAgentSignal(row: AgentSignalRow) {
  swallow(
    db.insert(t.agentSignals).values({
      canvasId: row.canvasId,
      target: row.target,
      kind: row.kind,
      message: row.message ?? null,
      by: row.by,
      at: row.at,
      takenAt: null,
    }),
  )
}

/** Every signal still waiting for its agent, oldest first — what boot rebuilds
 *  the registry from. */
export async function listPendingAgentSignals(): Promise<AgentSignalRow[]> {
  const rows = await db
    .select()
    .from(t.agentSignals)
    .where(isNull(t.agentSignals.takenAt))
    .orderBy(asc(t.agentSignals.at))
  return rows.map((row) => ({
    canvasId: row.canvasId,
    target: row.target,
    kind: row.kind === 'stop' ? ('stop' as const) : ('steer' as const),
    ...(row.message != null ? { message: row.message } : {}),
    by: row.by,
    at: row.at,
  }))
}

/** Stamp a signal consumed, by the registry keys the caller looked it up
 *  under. A taken row is not deleted: it is what tells this process, and the
 *  next boot, that the signal is done; the retention pass drops it. */
export function markAgentSignalsTaken(
  canvasId: string,
  targets: string[],
  kind: 'stop' | 'steer',
  at = Date.now(),
): void {
  if (targets.length === 0) return
  swallow(
    db
      .update(t.agentSignals)
      .set({ takenAt: at })
      .where(
        and(
          eq(t.agentSignals.canvasId, canvasId),
          eq(t.agentSignals.kind, kind),
          inArray(t.agentSignals.target, targets),
          isNull(t.agentSignals.takenAt),
        ),
      ),
  )
}

/** A canvas is gone: the stops and steers queued for its agents go with it. */
export function deleteAgentSignalsForCanvas(canvasId: string) {
  swallow(db.delete(t.agentSignals).where(eq(t.agentSignals.canvasId, canvasId)))
}

/** Retention: drop signals at or before a cutoff, taken or not — a signal that
 *  old is aimed at a run that ended long ago. */
export function pruneAgentSignals(before: number) {
  swallow(db.delete(t.agentSignals).where(lte(t.agentSignals.at, before)))
}

/* Streaming appends update a frame's html on every chunk — debounce per frame
   so the DB sees one row write per burst, not one per keystroke of the reveal.
   The frame travels with its timer because a caller may need the write to
   happen now (flushFrame): the object is mutated in place by the store, so the
   reference the debounce holds is always the latest state. */
const frameTimers = new Map<string, { timer: NodeJS.Timeout; frame: Frame }>()
const FRAME_DEBOUNCE_MS = 400

export function saveFrame(f: Frame, immediate = false) {
  const existing = frameTimers.get(f.id)
  if (existing) clearTimeout(existing.timer)
  if (immediate) {
    frameTimers.delete(f.id)
    swallow(writeFrame(f))
    return
  }
  frameTimers.set(f.id, {
    frame: f, // mutated in place by the store, so the ref holds the latest state
    timer: setTimeout(() => {
      frameTimers.delete(f.id)
      swallow(writeFrame(f))
    }, FRAME_DEBOUNCE_MS),
  })
}

/** Run a frame's pending debounced write now and wait for it. A no-op when
 *  nothing is pending, so a caller can ask without knowing whether the frame
 *  was just written. What the run timeline uses to read back the version a step
 *  produced: the debounce would otherwise leave that row unwritten for a few
 *  hundred milliseconds past the tool call, and the step would be recorded
 *  against the version before it. */
export async function flushFrame(frameId: string): Promise<void> {
  const pending = frameTimers.get(frameId)
  if (!pending) return
  clearTimeout(pending.timer)
  frameTimers.delete(frameId)
  try {
    await writeFrame(pending.frame)
  } catch (err) {
    /* the same bargain the debounced path makes: the ring already holds the
       change, and losing durability must not fail the call reporting it */
    console.error('[db] write failed', err)
  }
}

/** Every mutable frame column, so insert and update can't drift apart. The
 *  trash flag is deliberately not one of them: a write is a live frame's write,
 *  and an update that reset it would resurrect a frame the user trashed while
 *  the write was in flight. Restoring clears it explicitly
 *  (restoreFrameRow). */
function frameColumns(f: Frame) {
  return {
    canvasId: f.canvasId,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    html: f.html,
    updatedAt: f.updatedAt,
    updatedBy: f.updatedBy,
    demo: f.demo ?? null,
    z: f.z ?? 0,
    locked: f.locked ?? false,
    hidden: f.hidden ?? false,
    rotation: f.rotation ?? 0,
    opacity: f.opacity ?? 1,
    pageId: f.pageId ?? null,
  }
}

async function writeFrame(f: Frame) {
  const columns = frameColumns(f)
  await db
    .insert(t.frames)
    .values({ id: f.id, createdAt: f.createdAt, deletedAt: null, ...columns })
    .onConflictDoUpdate({ target: t.frames.id, set: columns })
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

/** Trash a canvas: one column moves, so the row and everything hanging off it
 *  (frames, pages, components, guidelines, releases, history) survives intact
 *  for a restore. It leaves every read path because the store moves it out of
 *  its live canvas map — that is what the deleted flag means to a reader.
 *  Its child rows keep `deleted_at` null on purpose: they are hidden by their
 *  canvas, not deleted one by one, so restoring the canvas restores all of
 *  them and the purge job removes them with it. */
export function deleteCanvas(canvasId: string) {
  swallow(db.update(t.canvases).set({ deletedAt: Date.now() }).where(eq(t.canvases.id, canvasId)))
}

/** Trash a frame: the row keeps its identity and its history, so a restore
 *  brings the frame back as itself — the id agents hold keeps working. */
export function deleteFrame(frameId: string) {
  const pending = frameTimers.get(frameId)
  if (pending) {
    clearTimeout(pending.timer)
    frameTimers.delete(frameId)
  }
  swallow(db.update(t.frames).set({ deletedAt: Date.now() }).where(eq(t.frames.id, frameId)))
}

/** Undo a trash — the other half of the flag, for a canvas and a frame. */
export function restoreCanvasRow(canvasId: string) {
  swallow(db.update(t.canvases).set({ deletedAt: null }).where(eq(t.canvases.id, canvasId)))
}

export function restoreFrameRow(frameId: string) {
  swallow(db.update(t.frames).set({ deletedAt: null }).where(eq(t.frames.id, frameId)))
}

/** Undo a page's trash flag — the page row a page delete kept. */
export function restorePageRow(pageId: string) {
  swallow(db.update(t.pages).set({ deletedAt: null }).where(eq(t.pages.id, pageId)))
}

/** Undo a component's trash flag — the library row a component delete kept. */
export function restoreComponentRow(id: string) {
  swallow(db.update(t.components).set({ deletedAt: null }).where(eq(t.components.id, id)))
}

/** Remove a canvas row and every dependent row it owns. Only the purge job
 *  calls this — every ordinary delete goes through deleteCanvas, which only
 *  sets the flag. */
export function hardDeleteCanvas(canvasId: string) {
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
  swallow(db.delete(t.canvasVersions).where(eq(t.canvasVersions.canvasId, canvasId)))
  swallow(db.delete(t.memoryReferences).where(eq(t.memoryReferences.canvasId, canvasId)))
  swallow(db.delete(t.decisions).where(eq(t.decisions.canvasId, canvasId)))
  swallow(db.delete(t.memoryProposals).where(eq(t.memoryProposals.canvasId, canvasId)))
  swallow(db.delete(t.components).where(eq(t.components.canvasId, canvasId)))
  swallow(db.delete(t.pages).where(eq(t.pages.canvasId, canvasId)))
  swallow(db.delete(t.canvasMembers).where(eq(t.canvasMembers.canvasId, canvasId)))
  swallow(db.delete(t.canvasInvites).where(eq(t.canvasInvites.canvasId, canvasId)))
  deleteAgentLevelsForCanvas(canvasId)
  /* Credentials follow the canvas they grant access to: a design-sync key is a
     write-only capability for THIS canvas and a GitHub connection is a repo
     import source for it, so a purged canvas must not strand either. The key's
     links and edges are keyed by key id, not canvas id, so they are deleted by
     subquery reading sync_keys — chained, not merely listed first, because the
     subquery is evaluated when each delete runs and the key row has to still be
     there for it to find them. */
  swallow(
    db
      .delete(t.syncLinks)
      .where(
        inArray(
          t.syncLinks.keyId,
          db.select({ id: t.syncKeys.id }).from(t.syncKeys).where(eq(t.syncKeys.canvasId, canvasId)),
        ),
      )
      .then(() =>
        db
          .delete(t.syncEdges)
          .where(
            inArray(
              t.syncEdges.keyId,
              db.select({ id: t.syncKeys.id }).from(t.syncKeys).where(eq(t.syncKeys.canvasId, canvasId)),
            ),
          ),
      )
      .then(() => db.delete(t.syncKeys).where(eq(t.syncKeys.canvasId, canvasId))),
  )
  swallow(db.delete(t.githubConnections).where(eq(t.githubConnections.canvasId, canvasId)))
  forgetAgentMessages(canvasId)
  swallow(db.delete(t.canvases).where(eq(t.canvases.id, canvasId)))
}

/** Remove one frame row and its projections. Purge-only, like
 *  hardDeleteCanvas; the frame's own history goes with it. */
export function hardDeleteFrame(frameId: string) {
  const pending = frameTimers.get(frameId)
  if (pending) {
    clearTimeout(pending.timer)
    frameTimers.delete(frameId)
  }
  swallow(db.delete(t.frames).where(eq(t.frames.id, frameId)))
  swallow(db.delete(t.assetRefs).where(eq(t.assetRefs.frameId, frameId)))
  swallow(db.delete(t.frameVersions).where(eq(t.frameVersions.frameId, frameId)))
  swallow(db.delete(t.frameReviews).where(eq(t.frameReviews.frameId, frameId)))
}

/* ---- trash purge ---- */

/** How long a trashed canvas or frame stays recoverable. Past this the purge
 *  job removes it for good. */
export const TRASH_RETENTION_DAYS = (() => {
  const raw = Number(process.env.TRASH_RETENTION_DAYS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30
})()

export interface PurgedTrash {
  canvases: number
  frames: number
  pages: number
  components: number
  guidelines: number
}

/** Hard-delete everything that has been in the trash longer than the retention
 *  window: whole canvases (with their frames and dependents), individual
 *  frames, and the trashed pages/components/guidelines rows. Runs at boot and
 *  once a day — the same in-process timer convention the run-event pruning
 *  uses, consistent with the single-instance architecture. */
export async function purgeTrash(now = Date.now()): Promise<PurgedTrash> {
  const cutoff = now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const [oldCanvases, oldFrames, oldPages, oldComponents, oldGuidelines] = await Promise.all([
    db
      .select({ id: t.canvases.id })
      .from(t.canvases)
      .where(and(isNotNull(t.canvases.deletedAt), lt(t.canvases.deletedAt, cutoff))),
    /* a frame of a trashed canvas is removed with its canvas, not here */
    db
      .select({ id: t.frames.id })
      .from(t.frames)
      .where(and(isNotNull(t.frames.deletedAt), lt(t.frames.deletedAt, cutoff))),
    db
      .select({ id: t.pages.id })
      .from(t.pages)
      .where(and(isNotNull(t.pages.deletedAt), lt(t.pages.deletedAt, cutoff))),
    db
      .select({ id: t.components.id })
      .from(t.components)
      .where(and(isNotNull(t.components.deletedAt), lt(t.components.deletedAt, cutoff))),
    db
      .select({ canvasId: t.guidelines.canvasId, name: t.guidelines.name })
      .from(t.guidelines)
      .where(and(isNotNull(t.guidelines.deletedAt), lt(t.guidelines.deletedAt, cutoff))),
  ])
  for (const row of oldCanvases) hardDeleteCanvas(row.id)
  for (const row of oldFrames) hardDeleteFrame(row.id)
  if (oldPages.length)
    await db.delete(t.pages).where(
      inArray(
        t.pages.id,
        oldPages.map((p) => p.id),
      ),
    )
  if (oldComponents.length)
    await db.delete(t.components).where(
      inArray(
        t.components.id,
        oldComponents.map((c) => c.id),
      ),
    )
  for (const doc of oldGuidelines) {
    await db.delete(t.guidelines).where(and(eq(t.guidelines.canvasId, doc.canvasId), eq(t.guidelines.name, doc.name)))
  }
  return {
    canvases: oldCanvases.length,
    frames: oldFrames.length,
    pages: oldPages.length,
    components: oldComponents.length,
    guidelines: oldGuidelines.length,
  }
}

/** The email behind an account id, for agent-event notifications. */
export async function getUserEmail(userId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, userId))
    .limit(1)
  return row?.email ?? undefined
}

/** Asset ids this account uploaded. The bytes are removed by assets.ts
 *  (deleteAsset), which knows the storage key; this answers what to sweep. */
export async function listOwnedAssetIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: t.assets.id }).from(t.assets).where(eq(t.assets.ownerId, userId))
  return rows.map((r) => r.id)
}

/* ---- account deletion ---- */

/** Hard-delete everything keyed to a user, then the user row itself.
 *
 *  Account deletion is the one place doop destroys data rather than trashing
 *  it, so this is deliberately total: the caller has already hard-deleted the
 *  canvases this user owned (persist.hardDeleteCanvas) and removed their
 *  memberships on other people's canvases, and anything left pointing at a
 *  user id that no longer exists would be a dangling row nobody could ever
 *  reach or clean up. `email` is needed because a pending invitation is
 *  addressed by email, not by account id. */
export async function hardDeleteUser(userId: string, email: string): Promise<void> {
  await db.delete(t.userMemory).where(eq(t.userMemory.userId, userId))
  /* membership rows survive in the store loop's blind spot: a canvas that is
     itself trashed is no longer in memory, so removing the membership there
     could not reach the row. Sweep by user id instead. */
  await db.delete(t.canvasMembers).where(eq(t.canvasMembers.userId, userId))
  await db.delete(t.modelAccounts).where(eq(t.modelAccounts.userId, userId))
  await db.delete(t.notificationPrefs).where(eq(t.notificationPrefs.userId, userId))
  await db.delete(t.designWorkflowSettings).where(eq(t.designWorkflowSettings.userId, userId))
  /* invitations this account sent die with it, and an invitation to its own
     address is unreachable once the address has no account */
  await db.delete(t.canvasInvites).where(or(eq(t.canvasInvites.createdBy, userId), eq(t.canvasInvites.email, email)))
  /* better-auth's own rows: sessions, credentials, and the MCP OAuth grants an
     agent would otherwise keep using */
  await db.delete(authSchema.session).where(eq(authSchema.session.userId, userId))
  await db.delete(authSchema.account).where(eq(authSchema.account.userId, userId))
  await db.delete(authSchema.oauthAccessToken).where(eq(authSchema.oauthAccessToken.userId, userId))
  await db.delete(authSchema.oauthConsent).where(eq(authSchema.oauthConsent.userId, userId))
  await db.delete(authSchema.user).where(eq(authSchema.user.id, userId))
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

/* ---- canvas chat (agent_messages) ----
   The chat is the work queue an agent reads when it connects and the channel a
   human parks a thought in for an agent that is not connected yet, so its read
   path has to be cheap and its write path has to be durable:
   - the per-canvas ring below is the source of truth for reads (same shape as
     runLog's ring and actions.ts's activity log), filled at boot from the
     table so a restart keeps the recent conversation;
   - each message is mirrored to the database fire-and-forget, and a failed
     write never reaches the caller — the ring already holds it.
   The REST routes and the MCP tools both go through these three writers, so
   there is exactly one place that knows what a chat message is. */

/** Ring size per canvas: the chat panel reads a bounded recent window. */
const MAX_AGENT_MESSAGES = 200

const agentMessageRing = new Map<string, AgentMessage[]>() // canvasId -> messages (oldest first)

/** Append a message to the canvas's ring (newest last, capped) and persist it.
 *  The caller mints the id and the timestamp. */
export function recordAgentMessage(message: AgentMessage): AgentMessage {
  const list = agentMessageRing.get(message.canvasId) ?? []
  list.push(message)
  if (list.length > MAX_AGENT_MESSAGES) list.splice(0, list.length - MAX_AGENT_MESSAGES)
  agentMessageRing.set(message.canvasId, list)
  saveAgentMessage(message)
  return message
}

/** The canvas's chat, oldest first. `since` is an epoch-ms cutoff on `at`, so
 *  an agent can ask for what arrived after its last read; `limit` keeps the
 *  most recent N of that window (still oldest first, the order a conversation
 *  reads in). */
export function getAgentMessages(canvasId: string, opts: { since?: number; limit?: number } = {}): AgentMessage[] {
  const all = agentMessageRing.get(canvasId) ?? []
  const wanted = opts.since === undefined ? all : all.filter((m) => m.at >= opts.since!)
  return opts.limit !== undefined && wanted.length > opts.limit ? wanted.slice(-opts.limit) : wanted
}

/** Remove a message from the canvas's ring and (write-behind) the table.
 *  Answers whether it was there, so a route can 404 an id from another canvas
 *  instead of reporting a deletion that never happened. */
export function deleteAgentMessage(canvasId: string, messageId: string): boolean {
  const list = agentMessageRing.get(canvasId)
  if (!list) return false
  const at = list.findIndex((m) => m.id === messageId)
  if (at === -1) return false
  list.splice(at, 1)
  if (list.length === 0) agentMessageRing.delete(canvasId)
  swallow(db.delete(t.agentMessages).where(eq(t.agentMessages.id, messageId)))
  return true
}

/** Write one message row. Fire-and-forget: the ring is what reads answer from,
 *  and a chat message must not fail because the database is unreachable. */
export function saveAgentMessage(message: AgentMessage) {
  swallow(
    db
      .insert(t.agentMessages)
      .values({
        id: message.id,
        canvasId: message.canvasId,
        authorName: message.authorName,
        authorKind: message.authorKind,
        authorColor: message.authorColor,
        to: message.to ?? null,
        body: message.body,
        at: message.at,
      })
      .onConflictDoNothing(),
  )
}

/** A canvas's chat from the database, oldest first — the cold read a route
 *  uses on a canvas the ring has aged out of, and what the boot path fills the
 *  ring from. Newest-first in the query so a `limit` takes the most recent
 *  messages, reversed on the way out for the reading order. */
export async function listAgentMessages(
  canvasId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(t.agentMessages)
    .where(
      opts.since === undefined
        ? eq(t.agentMessages.canvasId, canvasId)
        : and(eq(t.agentMessages.canvasId, canvasId), gte(t.agentMessages.at, opts.since)),
    )
    .orderBy(desc(t.agentMessages.at))
    .limit(opts.limit ?? MAX_AGENT_MESSAGES)
  return rows.map(toAgentMessage).reverse()
}

/** Drop one message row. Awaited where the caller answers only after the row
 *  is gone; the ring removal is deleteAgentMessage's. */
export async function deleteAgentMessageRow(canvasId: string, messageId: string): Promise<void> {
  await db.delete(t.agentMessages).where(and(eq(t.agentMessages.canvasId, canvasId), eq(t.agentMessages.id, messageId)))
}

function toAgentMessage(row: typeof t.agentMessages.$inferSelect): AgentMessage {
  return {
    id: row.id,
    canvasId: row.canvasId,
    authorName: row.authorName,
    authorKind: row.authorKind as AgentMessage['authorKind'],
    authorColor: row.authorColor,
    ...(row.to != null ? { to: row.to } : {}),
    body: row.body,
    at: row.at,
  }
}

/** Drop a canvas's chat: its ring and its rows. Called when the canvas is
 *  deleted, so nothing is left holding a canvas that is gone. */
export function forgetAgentMessages(canvasId: string): void {
  agentMessageRing.delete(canvasId)
  swallow(db.delete(t.agentMessages).where(eq(t.agentMessages.canvasId, canvasId)))
}

/** Seed the chat rings from the database at boot, oldest first within each
 *  canvas. A canvas with no messages is left out entirely rather than given an
 *  empty list to carry, and the rows are copied so the ring never aliases the
 *  hydrated map. */
export function hydrateAgentMessages(messages: Map<string, AgentMessage[]>): void {
  for (const [canvasId, list] of messages) {
    if (list.length === 0) continue
    agentMessageRing.set(canvasId, list.slice(-MAX_AGENT_MESSAGES))
  }
}

/** Flush pending debounced frame writes, then wait for every write still in
 *  flight (called on shutdown, and by tests before they close the database).
 *  writeFrame itself is only reachable through swallow, so routing the
 *  debounced ones through it too keeps one definition of "in flight". */
export async function flush(getFrame: (id: string) => Frame | undefined): Promise<void> {
  const pending = [...frameTimers.values()]
  for (const [, { timer }] of frameTimers) clearTimeout(timer)
  frameTimers.clear()
  for (const { frame } of pending) swallow(writeFrame(getFrame(frame.id) ?? frame))
  /* one pass is not enough: awaiting can start more work as it settles, and the
     point is to hand the caller a database with nothing outstanding */
  while (inFlightWrites.size) await Promise.allSettled([...inFlightWrites])
}

/* ------------------------------------------------------------------ */
/* Boot hydration                                                     */
/* ------------------------------------------------------------------ */

export interface Hydrated {
  canvases: Canvas[]
  /** Trash entries: canvases that were deleted, with their frames attached,
   *  and the deletion time the UI shows and the purge job measures against.
   *  Out of every live read path, still listed by /api/trash and still
   *  restorable. */
  trashedCanvases: { canvas: Canvas; deletedAt: number }[]
  /** Trashed frames of live canvases (a frame of a trashed canvas rides with
   *  its canvas above instead). */
  trashedFrames: { frame: Frame; deletedAt: number }[]
  /** Trashed pages of live canvases, same rule as trashedFrames: a restore
   *  puts the page (and so its frames' home) back. */
  trashedPages?: { page: Page; deletedAt: number }[]
  /** Trashed library components of live canvases, same rule again. */
  trashedComponents?: { component: Component; deletedAt: number }[]
  /** canvasId -> version summaries, newest first — the History tab's timeline,
   *  ready to serve without a DB round trip. */
  canvasVersions: Map<string, CanvasVersionSummary[]>
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
  /** userId -> mail preferences per class of agent event */
  notificationPrefs: Map<string, NotificationPrefs>
  /** canvasId -> chat messages, oldest first. Already handed to the in-memory
   *  ring by the time hydrate returns — exported so a caller can seed another
   *  process's view of the conversation */
  agentMessages?: Map<string, AgentMessage[]>
  /** the canvas component library, keyed by canvas — absent on a hydrate
   *  written before components existed, so callers must tolerate undefined */
  components?: Map<string, Component[]>
  /** userId -> cross-canvas memory, newest first */
  userMemory?: Map<string, UserMemory[]>
  /** canvasId -> share-link password hash. Kept apart from the Canvas object
   *  on purpose: the hash is a credential, and shared/types.ts is the wire
   *  contract every canvas payload is shaped by. Covers trashed canvases too,
   *  so a restore brings the password back with the canvas. */
  linkHashes?: Map<string, string>
  /** canvas_members.role, flat — server/access.ts indexes it for the gate */
  memberRoles?: { canvasId: string; userId: string; role: string }[]
}

const LOG_CAP = 100

/** A stored canvas row as the in-memory shape. Shared by the live and trashed
 *  partitions of a hydrate, so a canvas restored from the trash is assembled
 *  exactly like one that never left. */
function toCanvas(row: typeof t.canvases.$inferSelect): Canvas {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId ?? undefined,
    linkAccess:
      row.linkAccess === 'edit' || row.linkAccess === 'view' || row.linkAccess === 'comment'
        ? row.linkAccess
        : undefined,
    ...(row.linkExpiresAt != null ? { linkExpiresAt: row.linkExpiresAt } : {}),
    ...(row.publishedAt != null ? { publishedAt: row.publishedAt } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(isCommunityCategory(row.category) ? { category: row.category } : {}),
    ...(row.publishedReleaseId ? { publishedReleaseId: row.publishedReleaseId } : {}),
    ...(row.copyCount ? { copyCount: row.copyCount } : {}),
    ...(row.tokens ? { tokens: row.tokens as DesignTokens } : {}),
    ...(row.breakpoints ? { breakpoints: row.breakpoints as { name: string; min_width: number }[] } : {}),
    ...(row.reviewMode ? { reviewMode: true } : {}),
    ...(row.reviewPolicy === 'destructive' || row.reviewPolicy === 'all_writes'
      ? { reviewPolicy: row.reviewPolicy }
      : {}),
    ...(row.approvalTools ? { approvalTools: row.approvalTools } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    frames: [],
  }
}

/** A stored frame row as the in-memory shape. The five editor fields are NOT
 *  NULL columns with defaults, but a row read back from a database that
 *  predates them (or a partial boot) carries none: the defaults are applied
 *  here, so every in-memory Frame is complete no matter what the row held. */
function toFrame(row: typeof t.frames.$inferSelect): Frame {
  return {
    id: row.id,
    canvasId: row.canvasId,
    name: row.name,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    html: row.html,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    demo: row.demo ?? undefined,
    z: row.z ?? 0,
    locked: row.locked ?? false,
    hidden: row.hidden ?? false,
    rotation: row.rotation ?? 0,
    opacity: row.opacity ?? 1,
    ...(row.pageId ? { pageId: row.pageId } : {}),
  }
}

/** A stored page row as the in-memory shape. Shared by the live and trashed
 *  partitions of a hydrate, so a page restored from the trash is assembled
 *  exactly like one that never left. */
function toPage(row: typeof t.pages.$inferSelect): Page {
  return {
    id: row.id,
    canvasId: row.canvasId,
    name: row.name,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** A stored component row as the in-memory shape. Shared by the live and
 *  trashed partitions of a hydrate, the same way toPage is. */
function toComponent(row: typeof t.components.$inferSelect): Component {
  return {
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
  }
}

export async function hydrate(): Promise<Hydrated> {
  const [
    canvasRows,
    frameRows,
    versionRows,
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
    agentMessageRows,
  ] = await Promise.all([
    db.select().from(t.canvases),
    db.select().from(t.frames),
    db
      .select({
        id: t.canvasVersions.id,
        canvasId: t.canvasVersions.canvasId,
        cause: t.canvasVersions.cause,
        createdAt: t.canvasVersions.createdAt,
        createdBy: t.canvasVersions.createdBy,
        frames: t.canvasVersions.frames,
      })
      .from(t.canvasVersions)
      .orderBy(desc(t.canvasVersions.createdAt)),
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
    /* the same total order the paged read uses (see listRunEvents), so the
       ring the boot builds is a prefix of the pages a client asks for */
    db.select().from(t.runEvents).orderBy(desc(t.runEvents.at), desc(t.runEvents.id)),
    db.select().from(t.notificationPrefs),
    db.select().from(t.components),
    db.select().from(t.userMemory).orderBy(desc(t.userMemory.createdAt)),
    db.select().from(t.agentMessages).orderBy(desc(t.agentMessages.at)),
  ])

  /* Trash is a partition, not a filter: deleted rows must not come back live,
     but they must come back *listable* — a trashed canvas keeps its frames
     inside it (they are hidden by their canvas, not deleted one by one) and a
     trashed frame of a live canvas lands in the trash map ready to restore.
     Pages and components are partitioned the same way as frames, just below:
     a deleted row of a LIVE canvas is the user's to list and restore, while a
     deleted row of a trashed canvas stays out (it comes back with the canvas). */
  const canvases: Canvas[] = []
  const trashedCanvases: { canvas: Canvas; deletedAt: number }[] = []
  const byId = new Map<string, Canvas>()
  const trashedById = new Map<string, Canvas>()
  for (const row of canvasRows) {
    const canvas = toCanvas(row)
    if (row.deletedAt != null) {
      trashedCanvases.push({ canvas, deletedAt: row.deletedAt })
      trashedById.set(canvas.id, canvas)
    } else {
      canvases.push(canvas)
      byId.set(canvas.id, canvas)
    }
  }
  const trashedFrames: { frame: Frame; deletedAt: number }[] = []
  for (const row of frameRows) {
    const trashedCanvas = trashedById.get(row.canvasId)
    if (trashedCanvas) {
      trashedCanvas.frames.push(toFrame(row))
      continue
    }
    if (row.deletedAt != null) {
      trashedFrames.push({ frame: toFrame(row), deletedAt: row.deletedAt })
      continue
    }
    byId.get(row.canvasId)?.frames.push(toFrame(row))
  }
  const trashedPages: { page: Page; deletedAt: number }[] = []
  for (const row of pageRows) {
    if (row.deletedAt == null || !byId.has(row.canvasId)) continue
    trashedPages.push({ page: toPage(row), deletedAt: row.deletedAt })
  }
  const trashedComponents: { component: Component; deletedAt: number }[] = []
  for (const row of componentRows) {
    if (row.deletedAt == null || !byId.has(row.canvasId)) continue
    trashedComponents.push({ component: toComponent(row), deletedAt: row.deletedAt })
  }
  for (const m of memberRows) {
    const c = byId.get(m.canvasId)
    if (c) (c.memberIds ??= []).push(m.userId)
  }

  /* Roles and share-link passwords are read for EVERY canvas row, trashed ones
     included: a canvas restored from the trash must come back with the access
     it had, not with the defaults. */
  const memberRoles = memberRows.map((m) => ({ canvasId: m.canvasId, userId: m.userId, role: m.role }))
  const linkHashes = new Map<string, string>()
  for (const row of canvasRows) if (row.linkPasswordHash) linkHashes.set(row.id, row.linkPasswordHash)

  const canvasVersions = new Map<string, CanvasVersionSummary[]>()
  for (const row of versionRows) {
    const list = canvasVersions.get(row.canvasId) ?? []
    if (list.length >= MAX_CANVAS_VERSIONS) continue
    list.push({
      id: row.id,
      cause: row.cause === 'delete' || row.cause === 'manual' || row.cause === 'restore' ? row.cause : 'auto',
      createdAt: row.createdAt,
      createdBy: row.createdBy,
      frameCount: Array.isArray(row.frames) ? row.frames.length : 0,
    })
    canvasVersions.set(row.canvasId, list)
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
    /* a trashed doc is out of the canvas; saving the same name revives the row */
    if (g.deletedAt != null) continue
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
  const livePageRows = pageRows.filter((p) => p.deletedAt == null)
  {
    const now = Date.now()
    for (const c of canvases) {
      const rows = livePageRows.filter((p) => p.canvasId === c.id)
      c.pages = rows.map(toPage)
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
  /* A trashed canvas keeps the pages it had, so restoring it puts every frame
     back where it was. No backfill and no frame fixups: a trashed canvas is
     not written to, and a frame whose page was itself deleted is re-homed when
     the canvas is restored. */
  for (const entry of trashedCanvases) {
    entry.canvas.pages = livePageRows.filter((p) => p.canvasId === entry.canvas.id).map(toPage)
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
    list.push(toRunEvent(row))
    runEvents.set(row.canvasId, list)
  }

  const notificationPrefs = new Map<string, NotificationPrefs>(
    notificationRows.map((r) => [
      r.userId,
      { agentEmail: r.agentEmail, agentFinishEmail: r.agentFinishEmail, agentFailEmail: r.agentFailEmail },
    ]),
  )

  /* The chat rings are filled here rather than handed to the caller: every
     read path is in this file, so a boot that forgets to seed them would make
     a restart answer "no messages" for a conversation the database still
     holds. Rows arrive newest first; the ring reads oldest first. */
  const agentMessages = new Map<string, AgentMessage[]>()
  for (const row of agentMessageRows) {
    const list = agentMessages.get(row.canvasId) ?? []
    if (list.length >= MAX_AGENT_MESSAGES) continue
    list.push(toAgentMessage(row))
    agentMessages.set(row.canvasId, list)
  }
  for (const [canvasId, list] of agentMessages) {
    list.reverse() // the ring reads oldest first; the rows arrived newest first
    agentMessages.set(canvasId, list)
  }
  hydrateAgentMessages(agentMessages)

  const components = new Map<string, Component[]>()
  for (const row of componentRows) {
    if (row.deletedAt != null) continue
    const list = components.get(row.canvasId) ?? []
    list.push(toComponent(row))
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
    trashedCanvases,
    trashedFrames,
    trashedPages,
    trashedComponents,
    canvasVersions,
    comments,
    activity,
    decisions,
    proposals,
    frameProposals,
    canvasProposals,
    questions,
    runEvents,
    notificationPrefs,
    agentMessages,
    components,
    userMemory,
    linkHashes,
    memberRoles,
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
