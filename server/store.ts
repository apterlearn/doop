import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import * as access from './access.ts'
import { extractAssetIds } from './assets.ts'
import type { CanvasRole } from './access.ts'
import type {
  Canvas,
  Component,
  CommunityCategory,
  DesignTokens,
  Frame,
  GuidelineDoc,
  MemoryReference,
  Page,
  ReviewPolicy,
} from '../shared/types.ts'

/**
 * In-memory canvas/frame state — the hot path for reads, reveals and
 * broadcasts. Every committed mutation is mirrored to the database via
 * the write-through helpers in db/persist.ts; boot hydrates from there.
 */

/** A fresh page row for in-memory use; the caller mirrors it via persist. */
function newPage(canvasId: string, name: string, now: number): Page {
  return { id: nanoid(10), canvasId, name, position: 0, createdAt: now, updatedAt: now }
}

/** The first free stacking slot on a page: one past its frontmost frame, or 0
 *  when the page has none. A caller placing a run of frames spaces them out
 *  from here. */
function topZ(frames: Frame[], pageId: string | undefined): number {
  let max = -1
  for (const f of frames) if (f.pageId === pageId) max = Math.max(max, f.z ?? 0)
  return max + 1
}

/** The page's frames in front-to-back order: `z` is the authority (higher
 *  paints in front) and array order is the tiebreak among equal z — which is
 *  what keeps a canvas whose frames all still carry z 0 in the stacking it has
 *  always rendered in. */
function orderedPageFrames(frames: Frame[], pageId: string): Frame[] {
  return frames
    .map((frame, index) => ({ frame, index }))
    .filter((e) => e.frame.pageId === pageId)
    .sort((a, b) => (b.frame.z ?? 0) - (a.frame.z ?? 0) || b.index - a.index)
    .map((e) => e.frame)
}

class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId

  /** The trash: canvases and frames that were deleted but are still
   *  recoverable. They are out of every live structure above, which is what
   *  "deleted" means to a reader — requireCanvas, listCanvases, the gallery
   *  and the ws join all read the map the canvas left. Loaded at boot, so the
   *  trash survives a restart and the purge job has a clock to read. */
  private trashedCanvases = new Map<string, { canvas: Canvas; deletedAt: number }>()
  private trashedFrames = new Map<string, { frame: Frame; deletedAt: number }>()

  /** canvasId -> version summaries, newest first. A ring, capped like the
   *  canvas_versions table it mirrors, so the History tab never waits on the
   *  database for the timeline. */
  private canvasVersions = new Map<string, persist.CanvasVersionSummary[]>()

  /** canvasId -> durable frame writes since the last snapshot: the auto-
   *  snapshot cadence counts from here and resets when it fires. */
  private frameWrites = new Map<string, number>()

  init(canvases: Canvas[]) {
    for (const c of canvases) {
      this.canvases.set(c.id, c)
      for (const f of c.frames) this.frameIndex.set(f.id, c.id)
    }
  }

  /** Load the trash at boot. */
  initTrash(canvases: { canvas: Canvas; deletedAt: number }[], frames: { frame: Frame; deletedAt: number }[]) {
    for (const entry of canvases) this.trashedCanvases.set(entry.canvas.id, entry)
    for (const entry of frames) this.trashedFrames.set(entry.frame.id, entry)
  }

  /** Load the version rings at boot (newest first, already capped). */
  initCanvasVersions(rows: Map<string, persist.CanvasVersionSummary[]>) {
    for (const [canvasId, list] of rows) this.canvasVersions.set(canvasId, [...list])
  }

  /** The canvas's history, newest first. */
  getCanvasVersions(canvasId: string): persist.CanvasVersionSummary[] {
    return this.canvasVersions.get(canvasId) ?? []
  }

  /** Record a snapshot the timeline should show at once — the store's ring is
   *  what GET .../versions reads, the table is the durable copy. */
  addCanvasVersion(canvasId: string, summary: persist.CanvasVersionSummary) {
    const list = this.canvasVersions.get(canvasId) ?? []
    list.unshift(summary)
    if (list.length > persist.MAX_CANVAS_VERSIONS) list.length = persist.MAX_CANVAS_VERSIONS
    this.canvasVersions.set(canvasId, list)
  }

  /** Count a durable frame write and answer with the running total; the caller
   *  owns the cadence. A snapshot never writes a frame, so the count cannot
   *  feed itself. */
  countFrameWrite(canvasId: string): number {
    const next = (this.frameWrites.get(canvasId) ?? 0) + 1
    this.frameWrites.set(canvasId, next)
    return next
  }

  clearFrameWrites(canvasId: string) {
    this.frameWrites.delete(canvasId)
  }

  /* ---- trash ---- */

  getTrashedCanvas(id: string) {
    return this.trashedCanvases.get(id)
  }

  getTrashedFrame(id: string) {
    return this.trashedFrames.get(id)
  }

  /** The user's trash: the canvases they own and the frames sitting on those
   *  canvases, newest deletion first. A frame trashed on someone else's canvas
   *  is not theirs to see or restore. */
  listTrash(userId: string) {
    const canvases = [...this.trashedCanvases.values()]
      .filter((entry) => entry.canvas.ownerId === userId)
      .sort((a, b) => b.deletedAt - a.deletedAt)
      .map((entry) => ({
        id: entry.canvas.id,
        name: entry.canvas.name,
        deletedAt: entry.deletedAt,
        frameCount: entry.canvas.frames.length,
      }))
    const frames = [...this.trashedFrames.values()]
      .flatMap((entry) => {
        const canvas = this.canvases.get(entry.frame.canvasId)
        if (!canvas || canvas.ownerId !== userId) return []
        return [{ entry, canvas }]
      })
      .sort((a, b) => b.entry.deletedAt - a.entry.deletedAt)
      .map(({ entry, canvas }) => ({
        id: entry.frame.id,
        canvasId: canvas.id,
        canvasName: canvas.name,
        name: entry.frame.name,
        deletedAt: entry.deletedAt,
      }))
    return { canvases, frames }
  }

  /** Put a trashed canvas back where it was: the same object, its frames
   *  reindexed, and the flag cleared in the row. A frame whose page was itself
   *  deleted since is re-homed onto the canvas's first page, so nothing comes
   *  back invisible. */
  restoreCanvas(id: string): Canvas | undefined {
    const entry = this.trashedCanvases.get(id)
    if (!entry) return undefined
    this.trashedCanvases.delete(id)
    const c = entry.canvas
    const pages = c.pages ?? []
    const valid = new Set(pages.map((p) => p.id))
    for (const f of c.frames) {
      if ((!f.pageId || !valid.has(f.pageId)) && pages[0]) f.pageId = pages[0].id
      this.frameIndex.set(f.id, c.id)
    }
    c.updatedAt = Date.now()
    this.canvases.set(c.id, c)
    persist.restoreCanvasRow(c.id)
    persist.saveCanvas(c)
    return c
  }

  /** Put a trashed frame back on its canvas, with the id it always had — that
   *  is what makes the frame's comments, history and agent references still
   *  point at it. */
  restoreFrame(id: string): Frame | undefined {
    const entry = this.trashedFrames.get(id)
    if (!entry) return undefined
    const c = this.canvases.get(entry.frame.canvasId)
    if (!c) return undefined
    this.trashedFrames.delete(id)
    const frame = entry.frame
    const pages = c.pages ?? []
    if ((!frame.pageId || !pages.some((p) => p.id === frame.pageId)) && pages[0]) frame.pageId = pages[0].id
    frame.updatedAt = Date.now()
    c.frames.push(frame)
    c.updatedAt = frame.updatedAt
    this.frameIndex.set(frame.id, c.id)
    persist.restoreFrameRow(id)
    persist.saveFrame(frame, true)
    persist.saveCanvas(c)
    return frame
  }

  /** Drop every in-memory trace of a canvas: the maps keyed by canvas id, the
   *  frame index, its trashed frames, and its access state. Shared by the two
   *  hard deletes below, which differ only in where the canvas came from. */
  private forget(c: Canvas): void {
    for (const f of c.frames) this.frameIndex.delete(f.id)
    for (const [frameId, entry] of this.trashedFrames) {
      if (entry.frame.canvasId === c.id) this.trashedFrames.delete(frameId)
    }
    this.canvases.delete(c.id)
    this.canvasVersions.delete(c.id)
    this.frameWrites.delete(c.id)
    this.components.delete(c.id)
    /* a role kept for a canvas that no longer exists is a map entry nothing
       can ever read or clean up, and the link hash is a credential */
    for (const userId of c.memberIds ?? []) access.clearMemberRole(c.id, userId)
    this.linkHashes.delete(c.id)
  }

  /** Empty one canvas out of the trash for good. */
  purgeCanvas(id: string): Canvas | undefined {
    const entry = this.trashedCanvases.get(id)
    if (!entry) return undefined
    this.trashedCanvases.delete(id)
    this.forget(entry.canvas)
    persist.hardDeleteCanvas(id)
    return entry.canvas
  }

  /** Remove a LIVE canvas for good, with no trip through the trash: the
   *  account wipe is the only caller, and the trash would be a state nobody
   *  could ever empty — the one account that could reach it is the one being
   *  deleted in the same breath. */
  hardDeleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    this.forget(c)
    persist.hardDeleteCanvas(id)
    return c
  }

  /** Empty one frame out of the trash for good. */
  purgeFrame(id: string): Frame | undefined {
    const entry = this.trashedFrames.get(id)
    if (!entry) return undefined
    this.trashedFrames.delete(id)
    persist.hardDeleteFrame(id)
    return entry.frame
  }

  /** The canvas's component library, keyed by canvas. Kept out of the Canvas
   *  object itself so a component write never touches canvas.updatedAt. */
  components = new Map<string, Component[]>()

  /** Load every component row at boot. */
  initComponents(rows: Component[]) {
    for (const row of rows) {
      const list = this.components.get(row.canvasId) ?? []
      list.push(row)
      this.components.set(row.canvasId, list)
    }
  }

  /** The canvas's components, newest-updated first. */
  listComponents(canvasId: string): Component[] {
    return [...(this.components.get(canvasId) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** No component index of its own — components are few and canvas-bound, so
   *  the lookup scans the map, the way getPage finds a page. */
  getComponent(componentId: string): Component | undefined {
    for (const list of this.components.values()) {
      const component = list.find((c) => c.id === componentId)
      if (component) return component
    }
    return undefined
  }

  createComponent(
    canvasId: string,
    input: {
      name: string
      html: string
      description?: string
      width: number
      height: number
      props?: unknown
      variantOf?: string
    },
    by: string,
  ): Component | undefined {
    if (!this.canvases.has(canvasId)) return undefined
    const now = Date.now()
    const component: Component = {
      id: nanoid(10),
      canvasId,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      html: input.html,
      width: input.width,
      height: input.height,
      ...(input.props !== undefined ? { props: input.props } : {}),
      ...(input.variantOf ? { variantOf: input.variantOf } : {}),
      createdBy: by,
      updatedBy: by,
      createdAt: now,
      updatedAt: now,
    }
    const list = this.components.get(canvasId) ?? []
    list.push(component)
    this.components.set(canvasId, list)
    persist.saveComponent(component)
    return component
  }

  updateComponent(
    componentId: string,
    patch: Partial<Pick<Component, 'name' | 'description' | 'html' | 'width' | 'height' | 'props' | 'variantOf'>>,
    by: string,
  ): Component | undefined {
    const component = this.getComponent(componentId)
    if (!component) return undefined
    Object.assign(component, patch)
    component.updatedAt = Date.now()
    component.updatedBy = by
    persist.saveComponent(component)
    return component
  }

  deleteComponent(componentId: string): Component | undefined {
    for (const [canvasId, list] of this.components) {
      const idx = list.findIndex((c) => c.id === componentId)
      if (idx === -1) continue
      const [component] = list.splice(idx, 1)
      if (list.length === 0) this.components.delete(canvasId)
      persist.deleteComponentRow(componentId)
      return component
    }
    return undefined
  }

  /** The dashboard row for one canvas. `viewerId` decides only whether the
   *  canvas is marked as shared-with-me; pass undefined for views that have
   *  no viewer-relative meaning (the admin index). */
  private toMeta(c: Canvas, viewerId?: string) {
    return {
      id: c.id,
      name: c.name,
      ownerId: c.ownerId,
      shared: viewerId !== undefined ? c.ownerId !== viewerId || undefined : undefined,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      frameCount: c.frames.length,
      /* the share link's policy, in the shape every canvas payload uses:
         'none' when unset, the password as a flag (never the hash), and the
         expiry so the dashboard can mark a link that is about to lapse */
      linkAccess: c.linkAccess ?? 'none',
      linkPasswordSet: !!this.linkHashes.get(c.id),
      ...(c.linkExpiresAt !== undefined ? { linkExpiresAt: c.linkExpiresAt } : {}),
      /* most recently touched frame — the home dashboard renders it as the
         canvas preview via the public /i/ image pipeline */
      previewFrameId: c.frames.length ? c.frames.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)).id : undefined,
    }
  }

  /** Canvases visible to a user: their own plus ones they were invited to.
   *  Unowned (legacy/seeded) canvases are NOT listed — listing them to
   *  everyone leaked one user's work onto every other user's dashboard.
   *  They remain reachable by their unguessable id and claimable there. */
  listCanvases(userId: string) {
    return [...this.canvases.values()]
      .filter((c) => c.ownerId === userId || c.memberIds?.includes(userId))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => this.toMeta(c, userId))
  }

  /** Every canvas on the instance, for the admin index only. Access is the
   *  caller's problem — the only caller is server/admin.ts, behind isAdmin.
   *  A deliberately separate method rather than a flag on listCanvases: a
   *  boolean parameter is the kind of thing that eventually gets passed
   *  `true` from a route that shouldn't. */
  listAllCanvases(limit = 200) {
    const all = [...this.canvases.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      total: all.length,
      canvases: all.slice(0, limit).map((c) => ({
        ...this.toMeta(c),
        linkAccess: c.linkAccess ?? 'none',
        memberCount: c.memberIds?.length ?? 0,
      })),
    }
  }

  createCanvas(name: string, ownerId?: string): Canvas {
    const now = Date.now()
    const canvas: Canvas = { id: nanoid(10), name, ownerId, createdAt: now, updatedAt: now, frames: [] }
    canvas.pages = [newPage(canvas.id, 'Page 1', now)]
    this.canvases.set(canvas.id, canvas)
    persist.saveCanvas(canvas)
    for (const page of canvas.pages) persist.savePage(canvas.id, page)
    return canvas
  }

  /** Copy reusable design content into a new private canvas. Collaboration,
   * activity, tasks, external connections and the gallery listing belong to
   * the source only. `name` defaults to "<source> copy"; `dropDemo` leaves
   * product-made onboarding frames behind (a gallery copy is the design,
   * not the welcome tour that happened to sit next to it). */
  async duplicateCanvas(
    id: string,
    ownerId: string,
    by: string,
    options: { name?: string; dropDemo?: boolean; frames?: Frame[] } = {},
  ): Promise<Canvas | undefined> {
    const source = this.canvases.get(id)
    if (!source) return undefined
    const now = Date.now()
    const canvasId = nanoid(10)
    /* `frames` is how the gallery copies a release-published listing: the copy
       must be the snapshot a visitor was shown, not whatever the canvas holds
       now */
    const sourceFrames =
      options.frames ?? (options.dropDemo ? source.frames.filter((frame) => !frame.demo) : source.frames)
    const frameIds = new Map(sourceFrames.map((frame) => [frame.id, nanoid(10)]))
    const pages = source.pages?.map((page) => ({
      id: nanoid(10),
      canvasId,
      name: page.name,
      position: page.position,
      createdAt: now,
      updatedAt: now,
    }))
    const pageIdMap = new Map(source.pages?.map((page, i) => [page.id, pages![i]!.id]) ?? [])
    /* each destination page is new and empty, so every copied frame gets a
       fresh dense run from 0, in source order — the copy stacks the way the
       source did, not the way its interleaved z numbers happened to sit. A
       frame whose source page is unknown groups under the empty key (no page id
       is ever ''), so it still gets a run of its own. */
    const zByPage = new Map<string, number>()
    const frames = sourceFrames.map((frame) => {
      const targetPage = frame.pageId ? pageIdMap.get(frame.pageId) : undefined
      const z = zByPage.get(targetPage ?? '') ?? 0
      zByPage.set(targetPage ?? '', z + 1)
      return {
        ...frame,
        id: frameIds.get(frame.id)!,
        canvasId,
        z,
        ...(frame.pageId ? { pageId: targetPage! } : {}),
        createdAt: now,
        updatedAt: now,
        updatedBy: by,
      }
    })
    const guidelines = source.guidelines?.map((doc) => ({ ...doc, updatedAt: now, updatedBy: by }))
    const references = source.references?.map((ref) => ({
      ...ref,
      id: nanoid(10),
      frameId: frameIds.get(ref.frameId) ?? ref.frameId,
      pinnedBy: by,
      pinnedAt: now,
    }))
    const canvas: Canvas = {
      id: canvasId,
      name: options.name ?? `${source.name} copy`,
      ownerId,
      createdAt: now,
      updatedAt: now,
      frames,
      ...(guidelines?.length ? { guidelines } : {}),
      ...(references?.length ? { references } : {}),
      ...(pages?.length ? { pages } : {}),
    }
    await persist.saveCanvasCopy(canvas)
    this.canvases.set(canvas.id, canvas)
    for (const frame of frames) this.frameIndex.set(frame.id, canvas.id)
    return canvas
  }

  getCanvas(id: string) {
    return this.canvases.get(id)
  }

  /** The canvas's live frames whose HTML embeds this asset id, sorted.
   *
   *  The in-memory counterpart of persist's `asset_refs` ledger, and the one
   *  that is never stale: that ledger is a projection written after the frame
   *  row is flushed, so it lags a just-made edit by the frame-write debounce.
   *  A caller deciding whether an asset may be deleted or replaced must ask
   *  BOTH — the ledger can still name a frame this process has not written
   *  yet, and this cannot see a frame another process wrote. HTML is the
   *  ground truth either way (see assets.framesReferencingAsset). */
  framesReferencingAsset(canvasId: string, assetId: string): string[] {
    const c = this.canvases.get(canvasId)
    if (!c) return []
    return c.frames
      .filter((f) => extractAssetIds(f.html).has(assetId))
      .map((f) => f.id)
      .sort()
  }

  /** Move a canvas to the trash: out of the live map (so every read path —
   *  requireCanvas, the dashboard, the gallery, the ws join — stops seeing it
   *  at once) and into the trash, where restore brings it back whole. Nothing
   *  is unlinked here: the frames, pages, components and history ride along,
   *  because deleting a canvas is a container-level action, not an edit to
   *  each frame. */
  deleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    for (const f of c.frames) this.frameIndex.delete(f.id)
    this.canvases.delete(id)
    this.trashedCanvases.set(id, { canvas: c, deletedAt: Date.now() })
    persist.deleteCanvas(id)
    return c
  }

  /** Take ownership of a pre-auth (unowned) canvas. No-op if already owned. */
  claimCanvas(id: string, userId: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c || c.ownerId) return undefined
    c.ownerId = userId
    persist.saveCanvas(c)
    return c
  }

  /* ---- share link ---- */

  /** canvasId -> share-link password hash (scrypt, from server/auth.ts).
   *  Beside the canvases rather than on them: every canvas payload that leaves
   *  the server is shaped by shared/types.ts, and a hash must never ride one. */
  private linkHashes = new Map<string, string>()

  /** Load the hashes at boot, trashed canvases included — a restored canvas
   *  comes back with the link it had. */
  initLinkHashes(rows: Map<string, string>) {
    for (const [canvasId, hash] of rows) this.linkHashes.set(canvasId, hash)
  }

  /** The hash the public link routes compare a posted password against, or
   *  undefined when the link has no password. */
  getLinkHash(canvasId: string): string | undefined {
    return this.linkHashes.get(canvasId)
  }

  /** Owner-set link policy, in one call: the mode, the optional password and
   *  the optional expiry are one decision, and a half-applied policy (mode
   *  changed, password still pending) is a canvas briefly open to whoever
   *  holds the link. `passwordHash`/`expiresAt` are only touched when the
   *  caller passes the key at all — omitted keeps the current value, null
   *  clears it, which is what lets the share modal save its mode without
   *  restating the password.
   *
   *  Deliberately does not bump updatedAt — a privacy toggle is not a design
   *  edit. The password hash never enters the Canvas object (it is a
   *  credential, not canvas state): it lives beside the canvases, keyed by id,
   *  with its own writer in persist. */
  setLink(
    id: string,
    patch: {
      access: 'none' | 'view' | 'comment' | 'edit'
      passwordHash?: string | null
      expiresAt?: number | null
    },
  ): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (patch.access === 'none') delete c.linkAccess
    else c.linkAccess = patch.access
    if ('expiresAt' in patch) {
      if (patch.expiresAt == null) delete c.linkExpiresAt
      else c.linkExpiresAt = patch.expiresAt
    }
    if ('passwordHash' in patch) {
      if (patch.passwordHash) this.linkHashes.set(id, patch.passwordHash)
      else this.linkHashes.delete(id)
      persist.saveLinkPassword(id, patch.passwordHash ?? null)
    }
    persist.saveCanvas(c)
    return c
  }

  /** List (or re-describe) a canvas in the gallery. Keeps the original
   *  publish date on edits so "newest" stays honest. Not a design edit, so
   *  updatedAt is left alone. `releaseId` pins the listing to a frozen
   *  snapshot; omitting it lists the live frames. */
  publishCanvas(
    id: string,
    listing: { description: string; category: CommunityCategory },
    releaseId?: string,
  ): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.publishedAt ??= Date.now()
    c.category = listing.category
    if (listing.description) c.description = listing.description
    else delete c.description
    if (releaseId) c.publishedReleaseId = releaseId
    else delete c.publishedReleaseId
    persist.saveCanvas(c)
    return c
  }

  unpublishCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    delete c.publishedAt
    delete c.description
    delete c.category
    delete c.publishedReleaseId
    persist.saveCanvas(c)
    return c
  }

  /** Every published canvas, newest listing first. Access is deliberately
   *  not a question here: publishing is the owner's opt-in, and the gallery
   *  exposes previews and copies, never the canvas itself. */
  listPublished(): Canvas[] {
    return [...this.canvases.values()]
      .filter((c) => c.publishedAt !== undefined)
      .sort((a, b) => b.publishedAt! - a.publishedAt!)
  }

  /** A gallery copy went out — the trending signal. */
  recordCommunityCopy(id: string) {
    const c = this.canvases.get(id)
    if (!c) return
    c.copyCount = (c.copyCount ?? 0) + 1
    persist.saveCanvas(c)
  }

  /** Invite a user to collaborate. Idempotent; the owner is never listed.
   *  `role` defaults to editor — the role column's backfill default, and what
   *  this call has always meant. An existing membership keeps the role it
   *  already holds: re-inviting someone is not a silent demotion. */
  addMember(canvasId: string, userId: string, addedBy: string, role: CanvasRole = 'editor'): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!(c.memberIds ??= []).includes(userId)) {
      c.memberIds.push(userId)
      access.setMemberRole(canvasId, userId, role)
      persist.saveMember(canvasId, userId, addedBy, Date.now(), role)
    }
    return c
  }

  /** Change what an existing member may do. The gate reads the role on its
   *  next question, so a demotion to viewer takes effect immediately. */
  setMemberRole(canvasId: string, userId: string, role: CanvasRole): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || !c.memberIds?.includes(userId)) return undefined
    access.setMemberRole(canvasId, userId, role)
    persist.saveMemberRole(canvasId, userId, role)
    return c
  }

  /** What this member may do, for the people list. The roles themselves are
   *  owned by the gate (server/access.ts) so it is always the same map the
   *  access decision reads. */
  roleOf(canvasId: string, userId: string): CanvasRole {
    return access.memberRole(canvasId, userId)
  }

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    c.memberIds!.splice(idx, 1)
    access.clearMemberRole(canvasId, userId)
    persist.deleteMember(canvasId, userId)
    return true
  }

  renameCanvas(id: string, name: string) {
    const c = this.canvases.get(id)
    if (!c) return undefined
    c.name = name
    c.updatedAt = Date.now()
    persist.saveCanvas(c)
    return c
  }

  /** Owner-set review mode: agent frame writes become proposals. Kept as the
   *  legacy all-or-nothing switch — the policy store (setReviewPolicy) is the
   *  scoped replacement, and the gate reads a `reviewMode` canvas as
   *  `all_writes`, so this stays true to what it always did. Like setLink,
   *  not a design edit, so updatedAt is left alone. */
  setReviewMode(id: string, on: boolean): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (on) c.reviewMode = true
    else delete c.reviewMode
    persist.saveCanvas(c)
    return c
  }

  /** Owner-set review policy: what an agent write must clear before it lands.
   *  `off` (or undefined) is the unset default and clears both fields; the
   *  empty approval list clears `approvalTools` the way `off` does. The legacy
   *  boolean is mirrored here — one switch, so the room's review chip and the
   *  gate can never disagree. Not a design edit, so updatedAt is left alone. */
  setReviewPolicy(canvasId: string, policy: ReviewPolicy | undefined, approvalTools?: string[]): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    if (policy && policy !== 'off') {
      c.reviewPolicy = policy
      if (approvalTools?.length) c.approvalTools = [...approvalTools]
      else delete c.approvalTools
      if (policy === 'all_writes') c.reviewMode = true
      else delete c.reviewMode
    } else {
      delete c.reviewPolicy
      delete c.approvalTools
      delete c.reviewMode
    }
    persist.saveCanvas(c)
    return c
  }

  getGuidelines(canvasId: string): GuidelineDoc[] {
    return this.canvases.get(canvasId)?.guidelines ?? []
  }

  /** Upsert a design doc by name. New docs without a position are auto-placed
   *  as a card to the left of the frames, stacked downward. */
  setGuideline(
    canvasId: string,
    name: string,
    markdown: string,
    by: string,
    pos?: { x: number; y: number },
    title?: string,
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const docs = (c.guidelines ??= [])
    const now = Date.now()
    let doc = docs.find((d) => d.name === name)
    if (doc) {
      doc.markdown = markdown
      doc.updatedAt = now
      doc.updatedBy = by
      if (pos) Object.assign(doc, pos)
      if (title !== undefined) doc.title = title || undefined
    } else {
      const placed = pos ?? this.placeGuideline(c, docs.length)
      doc = { name, markdown, ...(title ? { title } : {}), updatedAt: now, updatedBy: by, ...placed }
      docs.push(doc)
      docs.sort((a, b) => a.name.localeCompare(b.name))
    }
    c.updatedAt = now
    persist.saveGuideline(canvasId, doc)
    persist.saveCanvas(c)
    return doc
  }

  private placeGuideline(c: Canvas, index: number): { x: number; y: number } {
    const CARD_W = 360
    if (!c.frames.length) return { x: 120, y: 120 + index * 380 }
    const minX = Math.min(...c.frames.map((f) => f.x))
    const minY = Math.min(...c.frames.map((f) => f.y))
    return { x: minX - CARD_W - 100, y: minY + index * 380 }
  }

  /** Patch card position / display title; content and history stay untouched. */
  patchGuideline(
    canvasId: string,
    name: string,
    patch: { x?: number; y?: number; title?: string },
  ): GuidelineDoc | undefined {
    const c = this.canvases.get(canvasId)
    const doc = c?.guidelines?.find((d) => d.name === name)
    if (!c || !doc) return undefined
    if (patch.x !== undefined) doc.x = patch.x
    if (patch.y !== undefined) doc.y = patch.y
    if (patch.title !== undefined) doc.title = patch.title || undefined
    persist.saveGuideline(canvasId, doc)
    return doc
  }

  deleteGuideline(canvasId: string, name: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.guidelines?.findIndex((d) => d.name === name) ?? -1
    if (!c || idx === -1) return false
    c.guidelines!.splice(idx, 1)
    c.updatedAt = Date.now()
    persist.deleteGuideline(canvasId, name)
    persist.saveCanvas(c)
    return true
  }

  /** Replace (or clear, with undefined) the canvas's design tokens. */
  setTokens(canvasId: string, tokens: DesignTokens | undefined, by: string): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const now = Date.now()
    c.tokens = tokens ? { ...tokens, updatedAt: now, updatedBy: by } : undefined
    c.updatedAt = now
    persist.saveCanvas(c)
    return c
  }

  /** Replace (or clear, with undefined) the canvas's responsive breakpoints —
   *  the widths `review_frame` renders a frame at. `by` is accepted for
   *  call-site symmetry with setTokens; a breakpoint list carries no author.
   *  Order and bounds are the caller's contract, not the store's. */
  setBreakpoints(
    canvasId: string,
    breakpoints: { name: string; min_width: number }[] | undefined,
    _by: string,
  ): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    c.breakpoints = breakpoints ? breakpoints.map((b) => ({ ...b })) : undefined
    c.updatedAt = Date.now()
    persist.saveCanvas(c)
    return c
  }

  getReferences(canvasId: string): MemoryReference[] {
    return this.canvases.get(canvasId)?.references ?? []
  }

  /** Pin a frame to Memory: snapshot its HTML now, decoupled from the frame. */
  addReference(canvasId: string, frame: Frame, by: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const ref: MemoryReference = {
      id: nanoid(10),
      frameId: frame.id,
      title: frame.name,
      html: frame.html,
      width: frame.width,
      height: frame.height,
      pinnedBy: by,
      pinnedAt: Date.now(),
    }
    ;(c.references ??= []).unshift(ref)
    persist.saveReference(canvasId, ref)
    return ref
  }

  deleteReference(canvasId: string, id: string): MemoryReference | undefined {
    const c = this.canvases.get(canvasId)
    const idx = c?.references?.findIndex((r) => r.id === id) ?? -1
    if (!c || idx === -1) return undefined
    const [ref] = c.references!.splice(idx, 1)
    persist.deleteReference(id)
    return ref
  }

  getPage(pageId: string): { canvas: Canvas; page: Page } | undefined {
    for (const c of this.canvases.values()) {
      const page = c.pages?.find((p) => p.id === pageId)
      if (page) return { canvas: c, page }
    }
    return undefined
  }

  createPage(canvasId: string, name: string): Page | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const page = { ...newPage(canvasId, name, Date.now()), position: c.pages?.length ?? 0 }
    this.renumber((c.pages ??= []))
    c.pages.push(page)
    this.renumber(c.pages)
    c.updatedAt = Date.now()
    persist.savePage(canvasId, page)
    persist.saveCanvas(c)
    return page
  }

  renamePage(pageId: string, name: string): Page | undefined {
    const found = this.getPage(pageId)
    if (!found) return undefined
    found.page.name = name
    found.page.updatedAt = Date.now()
    found.canvas.updatedAt = found.page.updatedAt
    persist.savePage(found.canvas.id, found.page)
    persist.saveCanvas(found.canvas)
    return found.page
  }

  reorderPage(pageId: string, position: number): Page[] | undefined {
    const found = this.getPage(pageId)
    if (!found) return undefined
    const pages = found.canvas.pages!
    const from = pages.indexOf(found.page)
    const to = Math.max(0, Math.min(pages.length - 1, position))
    if (from === to) return pages
    pages.splice(from, 1)
    pages.splice(to, 0, found.page)
    this.renumber(pages)
    found.canvas.updatedAt = Date.now()
    for (const p of pages) persist.savePage(found.canvas.id, p)
    persist.saveCanvas(found.canvas)
    return pages
  }

  /** Remove a page and every frame on it. Refuses the canvas's only page —
   *  callers surface that as a 409. The frames are trashed rather than
   *  destroyed: deleting a page is one action to take back, so each frame on
   *  it stays restorable on its own from /api/trash. */
  deletePage(pageId: string): { canvas: Canvas; page: Page; frames: Frame[] } | undefined {
    const found = this.getPage(pageId)
    if (!found) return undefined
    const c = found.canvas
    if (!c.pages || c.pages.length < 2) return undefined
    const idx = c.pages.indexOf(found.page)
    c.pages.splice(idx, 1)
    this.renumber(c.pages)
    const frames = c.frames.filter((f) => f.pageId === pageId)
    c.frames = c.frames.filter((f) => f.pageId !== pageId)
    const deletedAt = Date.now()
    for (const f of frames) {
      this.frameIndex.delete(f.id)
      this.trashedFrames.set(f.id, { frame: f, deletedAt })
      persist.deleteFrame(f.id)
    }
    persist.deletePage(pageId)
    c.updatedAt = deletedAt
    persist.saveCanvas(c)
    return { canvas: c, page: found.page, frames }
  }

  /** Copy a page and every frame on it to a new page appended at the end. */
  duplicatePage(pageId: string, name: string): { page: Page; frames: Frame[] } | undefined {
    const found = this.getPage(pageId)
    if (!found) return undefined
    const c = found.canvas
    const now = Date.now()
    const page: Page = { ...newPage(c.id, name, now), position: c.pages!.length }
    /* the copies keep the source page's stacking, packed into a fresh dense run
       from the front of the new page (created empty, so the base is 0): frame
       order is already the tiebreak, so the source order renders the same */
    const baseZ = topZ(c.frames, page.id)
    const frames = c.frames
      .filter((f) => f.pageId === pageId)
      .map((f, i) => ({
        ...f,
        id: nanoid(10),
        pageId: page.id,
        z: baseZ + i,
        createdAt: now,
        updatedAt: now,
        updatedBy: f.updatedBy,
      }))
    c.pages!.push(page)
    for (const f of frames) {
      c.frames.push(f)
      this.frameIndex.set(f.id, c.id)
      persist.saveFrame(f, true)
    }
    persist.savePage(c.id, page)
    c.updatedAt = now
    persist.saveCanvas(c)
    return { page, frames }
  }

  moveFrameToPage(frameId: string, pageId: string): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    const c = this.canvases.get(frame.canvasId)!
    if (!c.pages?.some((p) => p.id === pageId)) return undefined
    frame.pageId = pageId
    frame.updatedAt = Date.now()
    c.updatedAt = frame.updatedAt
    persist.saveFrame(frame)
    persist.saveCanvas(c)
    return frame
  }

  /** Restack a page: `orderedIds` lists the page's frames front-to-back (index
   *  0 = frontmost) and `z` is renumbered densely to match, so the frontmost
   *  frame carries the highest z — the convention createFrame's topZ slot
   *  follows. An id that is not a frame of this page is ignored, and a frame
   *  the caller left out keeps its current relative order behind the ones it
   *  named, so a partial order is never a way to lose a frame. The page's
   *  frames are put back into their own slots in `c.frames` — array order is
   *  the paint tiebreak, not the order itself, so other pages' frames never
   *  move. Returns the page's frames front-to-back, or undefined when the
   *  canvas or page is gone. */
  applyFrameOrder(canvasId: string, pageId: string, orderedIds: string[], by: string): Frame[] | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    if (!c.pages?.some((p) => p.id === pageId)) return undefined
    const onPage = c.frames.filter((f) => f.pageId === pageId)
    const byId = new Map(onPage.map((f) => [f.id, f]))
    const ordered: Frame[] = []
    const seen = new Set<string>()
    for (const id of orderedIds) {
      const frame = byId.get(id)
      if (!frame || seen.has(id)) continue
      seen.add(id)
      ordered.push(frame)
    }
    for (const frame of orderedPageFrames(c.frames, pageId)) if (!seen.has(frame.id)) ordered.push(frame)
    const now = Date.now()
    const changed: Frame[] = []
    ordered.forEach((frame, i) => {
      const z = ordered.length - 1 - i
      if (frame.z === z) return
      frame.z = z
      frame.updatedAt = now
      frame.updatedBy = by
      changed.push(frame)
    })
    /* the page's frames take their slots back in the new order, so the array
       reads front-to-back too and a reload rebuilds the same stacking */
    const slots: number[] = []
    c.frames.forEach((f, i) => {
      if (f.pageId === pageId) slots.push(i)
    })
    slots.forEach((slot, i) => {
      const frame = ordered[i]
      if (frame) c.frames[slot] = frame
    })
    if (changed.length) {
      c.updatedAt = now
      for (const frame of changed) persist.saveFrame(frame)
      persist.saveCanvas(c)
    }
    return ordered
  }

  /** Move one frame within its page's stack: front/back go all the way,
   *  forward/backward one slot, and an end is a no-op that still answers with
   *  the page's current order. The renumbering and the persistence are
   *  applyFrameOrder's. */
  moveFrameZ(
    canvasId: string,
    frameId: string,
    dir: 'front' | 'back' | 'forward' | 'backward',
    by: string,
  ): Frame[] | undefined {
    const frame = this.getFrame(frameId)
    if (!frame || frame.canvasId !== canvasId || !frame.pageId) return undefined
    const list = orderedPageFrames(this.canvases.get(canvasId)!.frames, frame.pageId)
    const from = list.findIndex((f) => f.id === frameId)
    if (from === -1) return undefined
    const to =
      dir === 'front'
        ? 0
        : dir === 'back'
          ? list.length - 1
          : dir === 'forward'
            ? Math.max(0, from - 1)
            : Math.min(list.length - 1, from + 1)
    const ids = list.map((f) => f.id)
    if (to !== from) {
      ids.splice(from, 1)
      ids.splice(to, 0, frameId)
    }
    return this.applyFrameOrder(canvasId, frame.pageId, ids, by)
  }

  /** Keep positions dense 0..n-1 after any insertion/removal/reorder. */
  private renumber(pages: Page[]) {
    pages.forEach((p, i) => (p.position = i))
  }

  getFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    return this.canvases.get(canvasId)?.frames.find((f) => f.id === frameId)
  }

  createFrame(
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
      /** Presentation a copy or a snapshot restore brings along: a duplicate
       *  keeps the original's lock, visibility, rotation and opacity, and a
       *  frame recreated from a release comes back in the stacking it was
       *  frozen in. Omitted fields take the fresh defaults — and `z` defaults
       *  to the front of the destination page, so an ordinary create always
       *  lands on top. */
      z?: number
      locked?: boolean
      hidden?: boolean
      rotation?: number
      opacity?: number
    },
    by: string,
  ): Frame | undefined {
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const now = Date.now()
    const pageId = input.pageId ?? c.pages?.[0]?.id
    // auto-place: to the right of the right-most frame on the same page
    let x = input.x
    let y = input.y
    if (x === undefined || y === undefined) {
      const pageFrames = c.frames.filter((f) => f.pageId === pageId)
      const rightmost = pageFrames.reduce((mx, f) => Math.max(mx, f.x + f.width), 0)
      x ??= pageFrames.length ? rightmost + 80 : 120
      y ??= 120
    }
    const frame: Frame = {
      id: nanoid(10),
      canvasId,
      name: input.name,
      x,
      y,
      width: input.width ?? 640,
      height: input.height ?? 480,
      html: input.html ?? '',
      z: input.z ?? topZ(c.frames, pageId),
      locked: input.locked ?? false,
      hidden: input.hidden ?? false,
      rotation: input.rotation ?? 0,
      opacity: input.opacity ?? 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      ...(pageId ? { pageId } : {}),
    }
    if (input.demo) frame.demo = true
    c.frames.push(frame)
    c.updatedAt = now
    this.frameIndex.set(frame.id, canvasId)
    persist.saveFrame(frame, true)
    persist.saveCanvas(c)
    return frame
  }

  updateFrame(
    frameId: string,
    patch: Partial<
      Pick<
        Frame,
        'name' | 'x' | 'y' | 'width' | 'height' | 'html' | 'pageId' | 'z' | 'locked' | 'hidden' | 'rotation' | 'opacity'
      >
    >,
    by: string,
  ): Frame | undefined {
    const frame = this.getFrame(frameId)
    if (!frame) return undefined
    Object.assign(frame, patch)
    frame.updatedAt = Date.now()
    frame.updatedBy = by
    const c = this.canvases.get(frame.canvasId)!
    c.updatedAt = frame.updatedAt
    persist.saveFrame(frame) // debounced: streaming appends land as one write per burst
    persist.saveCanvas(c)
    return frame
  }

  /** Move a frame to the trash: out of its canvas and out of the frame index
   *  (so requireFrame 404s and nothing broadcasts it), with its row and its
   *  history kept so a restore brings back the same frame, not a copy. */
  deleteFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    const [frame] = c.frames.splice(idx, 1)
    if (!frame) return undefined
    c.updatedAt = Date.now()
    this.frameIndex.delete(frameId)
    this.trashedFrames.set(frameId, { frame, deletedAt: Date.now() })
    persist.deleteFrame(frameId)
    persist.saveCanvas(c)
    return frame
  }

  /** Recreate a frame a snapshot froze, keeping the id it was frozen under.
   *  Refuses when the id is live — the caller takes the update path instead.
   *  The id may be sitting in the trash instead, and that is the case this
   *  exists for: a version restore after an accidental delete has to bring
   *  back the same frame (its id is what its comments, history and version rows
   *  point at), so the trash entry is consumed rather than left to duplicate
   *  it. */
  restoreFrameFromSnapshot(frame: Frame, by: string): Frame | undefined {
    if (this.frameIndex.has(frame.id)) return undefined
    const c = this.canvases.get(frame.canvasId)
    if (!c) return undefined
    this.trashedFrames.delete(frame.id)
    const pages = c.pages ?? []
    const live: Frame = {
      ...frame,
      pageId: frame.pageId && pages.some((p) => p.id === frame.pageId) ? frame.pageId : pages[0]?.id,
      updatedAt: Date.now(),
      updatedBy: by,
    }
    c.frames.push(live)
    c.updatedAt = live.updatedAt
    this.frameIndex.set(live.id, c.id)
    persist.restoreFrameRow(live.id)
    persist.saveFrame(live, true)
    persist.saveCanvas(c)
    return live
  }
}

export const store = new Store()
