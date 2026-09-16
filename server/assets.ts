import { nanoid } from 'nanoid'
import { and, count, desc, eq, inArray, or } from 'drizzle-orm'
import sharp from 'sharp'
import { db } from './db/index.ts'
import * as t from './db/schema.ts'
import * as storage from './storage.ts'

/**
 * Uploaded image assets: bytes in object storage (server/storage.ts), one
 * metadata row per asset in the assets table (including the canvas it was
 * uploaded for). Frame HTML is the ground truth for which assets are still
 * in use, tracked as a projection in asset_refs: every durable frame write
 * re-extracts that frame's /a/<id> references (db/persist.ts), and boot
 * rebuilds the whole table from hydrated frames — so a failed fire-and-
 * forget write self-heals. Deletion is explicit (deleteAsset), and a caller
 * that must not break a live URL checks framesReferencingAsset first.
 */

export const MAX_ASSET_BYTES = 5 * 1024 * 1024

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  /* brand faces ride the same store: upload_font puts the bytes here and the
     frame's @font-face points at /a/<id>.woff2. Three sfnt flavours, because
     a face arrives in whichever one the foundry shipped. */
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  /* not an image, but the same store serves it: export_canvas's zip is
     archived here so the tool can hand back a URL instead of a base64 blob
     the agent would have to carry in context. */
  'application/zip': 'zip',
} as const

type AssetMime = keyof typeof MIME_EXT

/* trust the bytes, not the sender: content sniffing decides the type */
function sniffMime(buf: Buffer): AssetMime | undefined {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 6 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  /* zip local-file / end-of-central-directory / spanned signatures */
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7))
    return 'application/zip'
  /* Font signatures: wOF2 and wOFF are the two WOFF wrappers, 0x00010000 the
     sfnt version a TrueType face opens with. They sit with the other magic
     numbers, above the text sniff, which would read these bytes as mojibake. */
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'wOF2') return 'font/woff2'
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'wOFF') return 'font/woff'
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00) return 'font/ttf'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1500)).trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return undefined
}

/* One-time upload tickets: a local file can't ride an MCP tool call (every
   byte of a tool argument streams through the model — slow, and corruptible
   past a few KB), so upload_asset hands out a capability URL instead and the
   agent curls the bytes to PUT /u/<token>. In-memory on purpose: single
   process, short TTL, single use. */
const TICKET_TTL_MS = 15 * 60 * 1000

interface UploadTicket {
  canvasId: string
  ownerId?: string
  uploadedBy: string
  expiresAt: number
  inFlight: boolean
}
const tickets = new Map<string, UploadTicket>()

export function createUploadTicket(meta: { canvasId: string; ownerId?: string; uploadedBy: string }): {
  token: string
  expiresAt: number
} {
  for (const [k, v] of tickets) if (v.expiresAt < Date.now()) tickets.delete(k)
  const token = nanoid(24)
  const expiresAt = Date.now() + TICKET_TTL_MS
  tickets.set(token, { ...meta, expiresAt, inFlight: false })
  return { token, expiresAt }
}

/** Claim a ticket for an upload attempt. Returns null when the token is
 *  unknown, expired, already consumed, or mid-upload elsewhere. */
export function beginTicketUpload(token: string): Omit<UploadTicket, 'inFlight'> | null {
  const t = tickets.get(token)
  if (!t || t.expiresAt < Date.now() || t.inFlight) return null
  t.inFlight = true
  return t
}

/** Success consumes the ticket; failure releases it for a retry until TTL. */
export function endTicketUpload(token: string, success: boolean): void {
  if (success) tickets.delete(token)
  else {
    const t = tickets.get(token)
    if (t) t.inFlight = false
  }
}

/** Asset ids referenced by a piece of frame HTML (/a/<id>.<ext> URLs). */
export function extractAssetIds(html: string): Set<string> {
  const ids = new Set<string>()
  for (const [, id] of html.matchAll(/\/a\/([A-Za-z0-9_-]+)\.[a-z0-9]+/g)) if (id) ids.add(id)
  return ids
}

export interface AssetMeta {
  id: string
  mime: string
  ext: string
  size: number
}

export async function createAsset(
  buf: Buffer,
  meta: { canvasId?: string; ownerId?: string; uploadedBy: string },
): Promise<AssetMeta> {
  if (buf.length === 0) throw new Error('empty file')
  if (buf.length > MAX_ASSET_BYTES)
    throw new Error(`file is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`)
  const mime = sniffMime(buf)
  if (!mime) throw new Error('unsupported file type — png, jpg, webp, gif, svg, zip, woff2, woff and ttf are accepted')
  const ext = MIME_EXT[mime]
  const id = nanoid(10)
  /* object first, row second: an orphaned object is swept later, but a row
     without bytes would serve 404s forever */
  await storage.putObject(`${id}.${ext}`, buf, mime)
  await db.insert(t.assets).values({
    id,
    canvasId: meta.canvasId ?? null,
    ownerId: meta.ownerId ?? null,
    mime,
    ext,
    size: buf.length,
    uploadedBy: meta.uploadedBy,
    createdAt: Date.now(),
  })
  return { id, mime, ext, size: buf.length }
}

export async function getAsset(id: string): Promise<{ meta: AssetMeta; buf: Buffer } | null> {
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
  if (!row) return null
  const buf = await storage.getObject(`${row.id}.${row.ext}`)
  if (!buf) return null
  return { meta: { id: row.id, mime: row.mime, ext: row.ext, size: row.size }, buf }
}

/** Remove an asset: metadata row first, then the bytes — the same invariant
 *  createAsset states from the other side, because a row without bytes would
 *  serve 404s forever while an object without a row is an orphan a sweep can
 *  find. asset_refs is deliberately left alone: it mirrors frame HTML, and a
 *  frame that still points at this URL still references it. Returns the
 *  removed asset, or undefined when there was nothing to remove. */
export async function deleteAsset(id: string): Promise<AssetMeta | undefined> {
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, id))
  if (!row) return undefined
  await db.delete(t.assets).where(eq(t.assets.id, id))
  await storage.deleteObject(`${row.id}.${row.ext}`)
  /* ids are unique per upload, so a stale entry could never be served — but
     the memo is bounded and an eviction is free, and dropping it here is what
     keeps "deleted" meaning "not cached either" */
  dimensionsCache.delete(id)
  return { id: row.id, mime: row.mime, ext: row.ext, size: row.size }
}

/** Fetch a remote image through the SSRF guard, validating every redirect
 *  hop, with a hard size cap enforced while streaming. */
export async function fetchRemote(rawUrl: string): Promise<Buffer> {
  const { fetchPinnedPublicUrl, parsePublicHttpUrl } = await import('./publicUrl.ts')
  let url = parsePublicHttpUrl(rawUrl)
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetchPinnedPublicUrl(url, {
      redirect: 'manual',
      headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'DoopAssets/1.0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error('redirect without a location')
      url = parsePublicHttpUrl(new URL(loc, url).href)
      continue
    }
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`)
    if (Number(res.headers.get('content-length') || 0) > MAX_ASSET_BYTES) throw new Error('file exceeds the 5 MB limit')
    if (!res.body) throw new Error('empty response')
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel()
        throw new Error('file exceeds the 5 MB limit')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }
  throw new Error('too many redirects')
}

/** Rebuild the asset_refs projection from a full set of frames — called at
 *  boot with the frames hydrate just loaded (no extra I/O), which both
 *  backfills pre-existing content and heals any drift from failed
 *  write-through. Incremental upkeep afterwards lives in db/persist.ts. */
export async function reconcileAssetRefs(frames: { id: string; html: string }[]): Promise<number> {
  const rows: { assetId: string; frameId: string }[] = []
  for (const f of frames) for (const assetId of extractAssetIds(f.html)) rows.push({ assetId, frameId: f.id })
  await db.delete(t.assetRefs)
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .insert(t.assetRefs)
      .values(rows.slice(i, i + 1000))
      .onConflictDoNothing()
  }
  return rows.length
}

/** The canvas's frames whose HTML points at this asset, by id. HTML is the
 *  ground truth (asset_refs is a projection of it), so this reads the frames
 *  rather than the ledger — a delete that skipped a stale ref would still be
 *  refused here. Sorted for a stable report. */
export async function framesReferencingAsset(canvasId: string, assetId: string): Promise<string[]> {
  const rows = await db
    .select({ id: t.frames.id, html: t.frames.html })
    .from(t.frames)
    .where(eq(t.frames.canvasId, canvasId))
  return rows
    .filter((row) => extractAssetIds(row.html).has(assetId))
    .map((row) => row.id)
    .sort()
}

/* ------------------------------------------------------------------ */
/* Listing — the read side of the ledger                               */

export interface AssetSummary {
  id: string
  /** the public path the asset is served from (`/a/<id>.<ext>`) */
  url: string
  mime: string
  bytes: number
  /** pixel size of an image, absent for anything else — and absent for an
   *  image whose bytes cannot be read or decoded (see measureAsset) */
  width?: number
  height?: number
  at: number
}

/* Pixel dimensions, derived at read time instead of stored: the assets table
   has no width/height columns, so recording them would mean a migration plus a
   backfill for every existing row, when the bytes already know. sharp reads a
   raster header without decoding pixels, but a listing asks about up to 200
   assets at once and the panel re-lists on every upload, so the answers are
   memoized per asset id. Bounded FIFO (not LRU): a listing walks a page in
   order, which is what eviction should follow, and the ceiling is what keeps a
   long-lived process from holding every asset it ever listed. A miss costs one
   object read; a hit costs nothing. */
const DIMENSIONS_CACHE_MAX = 500
const dimensionsCache = new Map<string, AssetDimensions>()

interface AssetDimensions {
  width?: number
  height?: number
}

/* The raster types sharp can read a size out of. Gated on the stored mime
   (sniffed from the bytes at upload) rather than attempted blindly: handing a
   woff2 to sharp throws, and a font or a zip has no size to report anyway. */
const MEASURABLE_IMAGE_MIMES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true,
}

/** An SVG's intrinsic size, from its root tag: a px `width`/`height` pair,
 *  else the `viewBox`. Percentages, ems and calc() carry no intrinsic size and
 *  are ignored, falling through to the viewBox. Only the start of the document
 *  is read — the root tag is at the top, and an SVG may be 5 MB. */
function svgDimensions(text: string): AssetDimensions {
  const root = text.slice(0, 4096).match(/<svg\b[^>]*>/i)?.[0]
  if (!root) return {}
  /* the `i` flag covers case; quoting covers both attribute styles */
  const attr = (name: string) => root.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1]
  const px = (raw: string | undefined): number | undefined => {
    const value = Number(raw?.trim().replace(/px$/i, '') ?? NaN)
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const width = px(attr('width'))
  const height = px(attr('height'))
  if (width && height) return { width, height }
  const parts = (attr('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const boxWidth = parts[2] ?? NaN
  const boxHeight = parts[3] ?? NaN
  if (Number.isFinite(boxWidth) && Number.isFinite(boxHeight) && boxWidth > 0 && boxHeight > 0)
    return { width: boxWidth, height: boxHeight }
  return {}
}

function rememberDimensions(id: string, dims: AssetDimensions): AssetDimensions {
  if (dimensionsCache.size >= DIMENSIONS_CACHE_MAX) {
    const oldest = dimensionsCache.keys().next().value
    if (oldest !== undefined) dimensionsCache.delete(oldest)
  }
  dimensionsCache.set(id, dims)
  return dims
}

/** One asset's pixel size, or `{}` when it has none to report.
 *
 *  Never throws: the listing is the payload and the dimensions are its
 *  decoration, so an unreadable object, a decode failure or a type sharp
 *  cannot measure all resolve to an absent width/height. Only a decode result
 *  is memoized — a storage read that failed is left uncached, because a bucket
 *  that is briefly unreachable must not pin "no dimensions" on an asset for
 *  the life of the process. */
async function measureAsset(id: string, ext: string, mime: string): Promise<AssetDimensions> {
  const cached = dimensionsCache.get(id)
  if (cached) return cached
  const svg = mime === 'image/svg+xml'
  if (!svg && !MEASURABLE_IMAGE_MIMES[mime]) return {}
  let buf: Buffer | null
  try {
    buf = await storage.getObject(`${id}.${ext}`)
  } catch {
    return {}
  }
  if (!buf) return rememberDimensions(id, {})
  if (svg) return rememberDimensions(id, svgDimensions(buf.toString('utf8')))
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata()
    return rememberDimensions(id, meta.width && meta.height ? { width: meta.width, height: meta.height } : {})
  } catch {
    return rememberDimensions(id, {})
  }
}

const ASSET_PAGE_DEFAULT = 50
const ASSET_PAGE_MAX = 200

/** Everything the ledger says belongs to a canvas: assets uploaded for it,
 *  plus anything a frame of its references — canvas_id is a housekeeping hint,
 *  the refs are what keep a URL copied into another canvas alive (see the
 *  module header). Newest first.
 *
 *  Cost: one object read per image row to derive its dimensions (see
 *  measureAsset), memoized per asset id, so only the first listing after boot
 *  — or after an asset is evicted from the memo — pays for it. Rows that are
 *  not images cost nothing. */
function canvasAssetScope(canvasId: string) {
  const referenced = db
    .selectDistinct({ assetId: t.assetRefs.assetId })
    .from(t.assetRefs)
    .innerJoin(t.frames, eq(t.frames.id, t.assetRefs.frameId))
    .where(eq(t.frames.canvasId, canvasId))
  return or(eq(t.assets.canvasId, canvasId), inArray(t.assets.id, referenced))
}

export async function listAssets(
  canvasId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ assets: AssetSummary[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? ASSET_PAGE_DEFAULT), 1), ASSET_PAGE_MAX)
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0)
  const scope = canvasAssetScope(canvasId)
  const rows = await db
    .select({
      id: t.assets.id,
      mime: t.assets.mime,
      ext: t.assets.ext,
      size: t.assets.size,
      createdAt: t.assets.createdAt,
    })
    .from(t.assets)
    .where(scope)
    .orderBy(desc(t.assets.createdAt))
    .limit(limit)
    .offset(offset)
  const [counted] = await db.select({ total: count() }).from(t.assets).where(scope)
  /* one dimension read per row, in parallel: they are independent object
     reads, and the page is already capped at ASSET_PAGE_MAX */
  const assets = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      url: `/a/${row.id}.${row.ext}`,
      mime: row.mime,
      bytes: row.size,
      ...(await measureAsset(row.id, row.ext, row.mime)),
      at: row.createdAt,
    })),
  )
  return { assets, total: counted?.total ?? 0 }
}

export interface AssetWithBytes {
  id: string
  url: string
  mime: string
  bytes: number
  data: Buffer
}

/** One asset of a canvas, with its bytes — `get_asset` serves image mimes from
 *  this. Named getCanvasAsset because getAsset(id) above is the storage-level
 *  read the /a/ route serves from. */
export async function getCanvasAsset(canvasId: string, assetId: string): Promise<AssetWithBytes | undefined> {
  /* id first: the PK lookup is the cheap one, the ledger scope is the access
     check on top of it */
  const [row] = await db.select().from(t.assets).where(eq(t.assets.id, assetId))
  if (!row) return undefined
  const [inScope] = await db
    .select({ id: t.assets.id })
    .from(t.assets)
    .where(and(eq(t.assets.id, assetId), canvasAssetScope(canvasId)))
  if (!inScope) return undefined
  const buf = await storage.getObject(`${row.id}.${row.ext}`)
  if (!buf) return undefined
  return {
    id: row.id,
    url: `/a/${row.id}.${row.ext}`,
    mime: row.mime,
    bytes: row.size,
    data: buf,
  }
}

/* ------------------------------------------------------------------ */
/* Orphan sweep — reap assets nothing can serve and nothing references */

/** How long an asset may sit unreferenced before the sweep treats it as an
 *  orphan. Upload and use are two steps: upload_asset hands an agent a URL and
 *  the frame pointing at it is written afterwards — sometimes minutes later,
 *  or after a human drags the file in. A day is far longer than any real gap
 *  and far shorter than a leak's lifetime. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000

/** An uploaded asset's key: `<id>.<ext>`, with no prefix. Only keys of this
 *  shape can belong to an assets row, and checking it is what keeps a derived
 *  thumbnail (`thumb/`) or a curated background (`bg/`) out of reach of a
 *  sweep: both live in the same store, neither is ever named by this table. */
const ASSET_KEY_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]+$/

export interface OrphanSweepResult {
  /** assets rows examined */
  scanned: number
  /** ids classified as orphans — in a dry run, what would be deleted */
  orphans: string[]
  /** how many were actually removed; always 0 in a dry run */
  deleted: number
  /** rows the sweep declined to touch: still referenced, still inside the
   *  grace window, whose object could not be checked, or whose stored key is
   *  not a plain asset key */
  skipped: number
}

/**
 * Reap asset rows nothing can serve and nothing references.
 *
 * Why this reads the assets table and not object storage: server/storage.ts
 * has no list operation — it can put, get and delete a key it is handed, and
 * nothing more — so nothing here can enumerate what is actually in the bucket.
 * The sweep the plan's ledger was built for (an object whose asset id has no
 * row) is therefore out of reach, and that limitation is real:
 *  - on disk (`./data/assets`, dev) the sweep never opens the directory, so an
 *    object left by a failed upload is invisible to it;
 *  - on S3 the same holds, and there is no way around it without a
 *    ListObjectsV2 page walk added to storage.ts. Objects stranded by a
 *    bucket-side delete, an interrupted PUT, or a database restored from an
 *    older backup stay stranded until such an operation exists.
 *
 * What it does find, from the rows:
 *  1. An unreferenced row whose object is gone — `getObject` returns null, so
 *     getAsset() returns null, /a/<id> 404s, and the row is dead weight the
 *     listing keeps reporting.
 *  2. An unreferenced row whose object is still there but which is older than
 *     ORPHAN_GRACE_MS — a genuine leak (an upload never placed, a diff image,
 *     an export zip).
 *
 * A row that asset_refs still points at is never deleted, whatever its age or
 * whether its bytes are readable: frame HTML still names that URL, and dropping
 * the row would turn a recoverable state (a bucket that comes back, a re-upload
 * under the same id) into a permanently nameless one. `asset_refs` is left
 * alone even for the rows this does delete — it mirrors frame HTML, exactly as
 * deleteAsset documents.
 *
 * `dryRun` defaults to true: it logs the ids it would remove and deletes
 * nothing. Deleting goes through `deleteAsset`, so an orphan loses its row
 * first and its object second like every other removal, and an object that is
 * already gone is a tolerated no-op there.
 *
 * Cost: every assets row and every asset_refs row, plus one object read per
 * unreferenced row (existence is checked by fetching the bytes — storage has
 * no HEAD). Referenced rows cost nothing beyond the two table reads.
 *
 * Not wired to boot: the caller is the ASSET_GC path in server/index.ts.
 */
export async function sweepOrphanAssets(opts: { dryRun?: boolean } = {}): Promise<OrphanSweepResult> {
  const dryRun = opts.dryRun ?? true
  const rows = await db.select({ id: t.assets.id, ext: t.assets.ext, createdAt: t.assets.createdAt }).from(t.assets)
  const referenced = new Set(
    (await db.selectDistinct({ assetId: t.assetRefs.assetId }).from(t.assetRefs)).map((row) => row.assetId),
  )
  const cutoff = Date.now() - ORPHAN_GRACE_MS
  const orphans: string[] = []
  let skipped = 0
  for (const row of rows) {
    if (!ASSET_KEY_RE.test(`${row.id}.${row.ext}`) || referenced.has(row.id)) {
      skipped += 1
      continue
    }
    /* null is "the object is gone"; undefined is "the read itself failed",
       which is not evidence of absence and must never trigger a delete */
    const bytes = await storage.getObject(`${row.id}.${row.ext}`).catch(() => undefined)
    if (bytes === undefined || (bytes !== null && row.createdAt > cutoff)) {
      skipped += 1
      continue
    }
    orphans.push(row.id)
  }
  let deleted = 0
  for (const id of orphans) {
    if (dryRun) continue
    try {
      await deleteAsset(id)
      deleted += 1
    } catch (e) {
      /* one unreachable object must not abort the sweep */
      console.error(`[assets] orphan sweep could not delete ${id}`, e)
    }
  }
  const listed =
    orphans.length > 25 ? `${orphans.slice(0, 25).join(', ')}, … +${orphans.length - 25} more` : orphans.join(', ')
  console.log(
    orphans.length === 0
      ? `[assets] orphan sweep${dryRun ? ' (dry run)' : ''}: scanned ${rows.length} row(s), no orphans`
      : `[assets] orphan sweep${dryRun ? ' (dry run)' : ''}: scanned ${rows.length} row(s), ` +
          `${dryRun ? 'would delete' : 'deleted'} ${dryRun ? orphans.length : deleted}: ${listed}`,
  )
  return { scanned: rows.length, orphans, deleted, skipped }
}
