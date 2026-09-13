import express from 'express'
import { store } from './store.ts'
import { getUserName } from './auth.ts'
import * as persist from './db/persist.ts'
import { isCommunityCategory, type Canvas, type CommunityItem, type Frame } from '../shared/types.ts'

/**
 * The community gallery, mounted at /api/community (behind the session gate
 * in index.ts). Owners opt a canvas in from the share modal; everyone
 * signed in can browse the listings and copy one into their own account.
 *
 * Deliberately NOT a change to canAccessCanvas: a published canvas is still
 * private to its collaborators. The gallery hands out frame ids (which the
 * public /i/ image pipeline already renders for anyone holding one) and
 * fresh copies — never the source canvas, its HTML, or a seat in its room.
 */
export const communityRouter = express.Router()

const MAX_DESCRIPTION = 280

/** What a canvas must have to be worth listing: at least one frame the
 *  owner (or their agents) actually made, not just the welcome tour. */
export function publishableFrames(canvas: Canvas) {
  return canvas.frames.filter((frame) => !frame.demo)
}

/** The one place a canvas becomes (or stops being) a gallery listing.
 *
 *  The owner check lives here rather than at each caller: the REST route and
 *  the MCP tool must not be able to disagree about who may publish. `release`
 *  pins the listing to a frozen snapshot — its preview and its copies then come
 *  from the release, so editing the canvas afterwards cannot change what a
 *  visitor sees. */
export function publishCanvas(
  canvas: Canvas | undefined,
  listing: { description: string; category: CommunityItem['category'] },
  actor: { id?: string; name: string },
  release?: { id: string; frames: Frame[] },
): { ok: true; canvas: Canvas } | { ok: false; status: number; error: string } {
  if (!canvas) return { ok: false, status: 404, error: 'no such canvas' }
  /* a caller with no id is nobody's owner: an ownerless canvas must not match it */
  if (!actor.id || canvas.ownerId !== actor.id)
    return {
      ok: false,
      status: 403,
      error: `only the owner can publish a canvas — this one belongs to another account`,
    }
  /* the frames the listing will actually show, not the live ones: a release
     with no frames is as unpublishable as an empty canvas */
  if (!(release ? release.frames : publishableFrames(canvas)).length)
    return {
      ok: false,
      status: 400,
      error: 'add a frame before publishing — the gallery lists designs, not empty canvases',
    }
  const published = store.publishCanvas(canvas.id, listing, release?.id)
  if (!published) return { ok: false, status: 404, error: 'no such canvas' }
  return { ok: true, canvas: published }
}

/** Take a canvas out of the gallery. Owner-only, same as publishing. */
export function unpublishCanvas(
  canvas: Canvas | undefined,
  actor: { id?: string; name: string },
): { ok: true } | { ok: false; status: number; error: string } {
  if (!canvas) return { ok: false, status: 404, error: 'no such canvas' }
  if (!actor.id || canvas.ownerId !== actor.id)
    return { ok: false, status: 403, error: 'only the owner can unpublish a canvas' }
  store.unpublishCanvas(canvas.id)
  return { ok: true }
}

export function parseListing(body: unknown): { description: string; category: CommunityItem['category'] } | string {
  const { description, category } = (body ?? {}) as { description?: unknown; category?: unknown }
  if (!isCommunityCategory(category)) return 'category must be one of the gallery shelves'
  if (description !== undefined && typeof description !== 'string') return 'description must be text'
  const clean = (description ?? '').trim()
  if (clean.length > MAX_DESCRIPTION) return `description must be ${MAX_DESCRIPTION} characters or fewer`
  return { description: clean, category }
}

/** The frames a listing shows: the release it is pinned to, or the live ones.
 *  A release-published canvas is frozen end to end, so a later rename or
 *  deletion on the canvas never reaches a visitor. */
async function listingFrames(canvas: Canvas): Promise<Frame[]> {
  if (canvas.publishedReleaseId) {
    const release = await persist.getRelease(canvas.publishedReleaseId)
    if (release && release.canvasId === canvas.id) return persist.releaseFrames(release)
  }
  return publishableFrames(canvas)
}

async function toItem(canvas: Canvas): Promise<CommunityItem | undefined> {
  /* every real frame, oldest first — the preview modal promises the whole
     design, and ids plus sizes are cheap enough to ship for all of them */
  const frames = (await listingFrames(canvas)).slice().sort((a, b) => a.createdAt - b.createdAt)
  /* a listing with nothing to show is not a listing: a release-published
     canvas whose snapshot is gone falls back to the live frames, and an empty
     canvas is skipped by the caller */
  if (!frames.length) return undefined
  return {
    id: canvas.id,
    name: canvas.name,
    ...(canvas.description ? { description: canvas.description } : {}),
    category: canvas.category ?? 'other',
    authorName: (canvas.ownerId && (await getUserName(canvas.ownerId))) || 'Unknown',
    publishedAt: canvas.publishedAt ?? canvas.createdAt,
    updatedAt: canvas.updatedAt,
    copyCount: canvas.copyCount ?? 0,
    frames: frames.map((frame) => ({ id: frame.id, name: frame.name, width: frame.width, height: frame.height })),
  }
}

/** Every listing, newest first. Sorting by trend is the client's choice —
 *  the whole gallery is small enough to ship at once. */
communityRouter.get('/', async (_req, res) => {
  const items = await Promise.all(store.listPublished().map(toItem))
  res.json(items.filter((item) => item !== undefined))
})

/** Copy a listing into the caller's account. The copy keeps the listing's
 *  name and drops the welcome tour; the source stays untouched apart from
 *  its copy count. A release-published listing copies the snapshot, so what a
 *  visitor gets is what the listing showed them. */
communityRouter.post('/:id/copy', async (req, res) => {
  const source = store.getCanvas(req.params.id)
  if (!source || source.publishedAt === undefined) return res.status(404).json({ error: 'not in the gallery' })
  try {
    const frozen = source.publishedReleaseId ? await listingFrames(source) : undefined
    const copy = await store.duplicateCanvas(source.id, req.user!.id, req.user!.name, {
      name: source.name,
      dropDemo: true,
      ...(frozen?.length ? { frames: frozen } : {}),
    })
    if (!copy) return res.status(404).json({ error: 'not in the gallery' })
    store.recordCommunityCopy(source.id)
    res.json(copy)
  } catch (error) {
    console.error('[community] copy failed', error)
    res.status(500).json({ error: 'could not copy this design' })
  }
})
