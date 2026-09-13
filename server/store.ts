import { nanoid } from 'nanoid'
import * as persist from './db/persist.ts'
import type {
  Canvas,
  CommunityCategory,
  DesignTokens,
  Frame,
  GuidelineDoc,
  MemoryReference,
  Page,
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

class Store {
  canvases = new Map<string, Canvas>()
  private frameIndex = new Map<string, string>() // frameId -> canvasId

  init(canvases: Canvas[]) {
    for (const c of canvases) {
      this.canvases.set(c.id, c)
      for (const f of c.frames) this.frameIndex.set(f.id, c.id)
    }
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
    const frames = sourceFrames.map((frame) => ({
      ...frame,
      id: frameIds.get(frame.id)!,
      canvasId,
      ...(frame.pageId ? { pageId: pageIdMap.get(frame.pageId)! } : {}),
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
    }))
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

  /** Remove a canvas and its frames from memory + database. */
  deleteCanvas(id: string): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    for (const f of c.frames) this.frameIndex.delete(f.id)
    this.canvases.delete(id)
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

  /** Owner-set link policy ('none' is the default and stored as unset).
   *  Deliberately does not bump updatedAt — a privacy toggle is not a
   *  design edit. */
  setLinkAccess(id: string, mode: 'edit' | 'none'): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (mode === 'edit') c.linkAccess = 'edit'
    else delete c.linkAccess
    persist.saveCanvas(c)
    return c
  }

  /* ---- community gallery ---- */

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

  /** Invite a user to collaborate. Idempotent; the owner is never listed. */
  addMember(canvasId: string, userId: string, addedBy: string): Canvas | undefined {
    const c = this.canvases.get(canvasId)
    if (!c || c.ownerId === userId) return c
    if (!(c.memberIds ??= []).includes(userId)) {
      c.memberIds.push(userId)
      persist.saveMember(canvasId, userId, addedBy, Date.now())
    }
    return c
  }

  removeMember(canvasId: string, userId: string): boolean {
    const c = this.canvases.get(canvasId)
    const idx = c?.memberIds?.indexOf(userId) ?? -1
    if (!c || idx === -1) return false
    c.memberIds!.splice(idx, 1)
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

  /** Owner-set review policy: agent frame writes become proposals. Like
   *  setLinkAccess, this is not a design edit, so updatedAt is left alone. */
  setReviewMode(id: string, on: boolean): Canvas | undefined {
    const c = this.canvases.get(id)
    if (!c) return undefined
    if (on) c.reviewMode = true
    else delete c.reviewMode
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
   *  callers surface that as a 409. */
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
    for (const f of frames) this.frameIndex.delete(f.id)
    for (const f of frames) persist.deleteFrame(f.id)
    persist.deletePage(pageId)
    c.updatedAt = Date.now()
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
    const frames = c.frames
      .filter((f) => f.pageId === pageId)
      .map((f) => ({
        ...f,
        id: nanoid(10),
        pageId: page.id,
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
    patch: Partial<Pick<Frame, 'name' | 'x' | 'y' | 'width' | 'height' | 'html' | 'pageId'>>,
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

  deleteFrame(frameId: string): Frame | undefined {
    const canvasId = this.frameIndex.get(frameId)
    if (!canvasId) return undefined
    const c = this.canvases.get(canvasId)
    if (!c) return undefined
    const idx = c.frames.findIndex((f) => f.id === frameId)
    if (idx === -1) return undefined
    const [frame] = c.frames.splice(idx, 1)
    c.updatedAt = Date.now()
    this.frameIndex.delete(frameId)
    persist.deleteFrame(frameId)
    persist.saveCanvas(c)
    return frame
  }
}

export const store = new Store()
