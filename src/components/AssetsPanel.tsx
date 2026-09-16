import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { AssetSummary } from '../lib/api'
import { ApiError, api } from '../lib/api'
import { isReadOnly, useStore } from '../lib/store'
import { cn } from '@/lib/utils'
import { PanelBody } from './ui/panel'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/alert-dialog'
import { Toast } from './ui/toast'
import { ListHint, ListMeta, ListSection } from './ui/list'

/* The Assets tab: every image stored on this canvas. They arrive by paste, by
   drop and by upload; each one is a permanent /a/ URL that frames embed by
   reference, which is why deleting one has to know whether a frame still
   shows it and why replacing one can update those frames in place. The panel
   is a view onto that library and nothing more — it holds no copy of it.

   It loads once when it opens and again after every change it makes, so the
   grid never refetches on a render it did not cause.

   Adding, replacing and deleting are all asset writes, so a read-only viewer
   gets the library as a read: no drop zone, no picker, no Replace and no
   Delete — while the thumbnails, the sizes and the permanent URL a frame
   embeds stay. */

/** How many thumbnails a page of the grid asks for. Big enough that most
    canvases fit in one screenful, small enough that a canvas full of imported
    screens does not paint every one of them to open the tab. */
const PAGE = 30

/** The drop target's tile: dashes while idle, ink while a drag is over it. */
const dropZone = 'mx-3 mt-2 flex flex-col items-center gap-1.5 rounded-[10px] border border-dashed px-3 py-3.5'

const thumb = 'h-20 w-full rounded-[8px] border border-line bg-white object-contain'

/** An asset's size, at the scale a thumbnail is read at. */
function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** What a tile says under its thumbnail: size, and the pixel dimensions when
 *  the server decoded them at upload. An asset from before that carries none,
 *  and the line simply does not mention them. */
function describe(a: AssetSummary): string {
  const dims = a.width && a.height ? ` · ${a.width}×${a.height}` : ''
  return `${bytes(a.bytes)}${dims}`
}

export function AssetsPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  /* a viewer with no session of their own, and an admin borrowing one, have no
     write that could land: everything below that writes an asset is hidden
     rather than disabled, and the tab keeps what it can actually do */
  const readOnly = useStore(isReadOnly)
  const [assets, setAssets] = useState<AssetSummary[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AssetSummary | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)
  /* which row the one shared replace picker is standing in for */
  const replaceTarget = useRef<AssetSummary | null>(null)

  const load = useCallback(() => {
    if (!canvasId) return
    api
      .listAssets(canvasId, { limit: PAGE })
      .then((page) => {
        setAssets(page.assets)
        setTotal(page.total)
        setHasMore(page.has_more)
        setLoaded(true)
        setError(null)
      })
      .catch((err: unknown) => {
        console.error(err)
        setLoaded(true)
        setError('Couldn’t load the assets.')
      })
  }, [canvasId])

  useEffect(() => {
    load()
  }, [load])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  /** Whatever went wrong, in the server's own words when it has any — a
   *  refused delete explains which frames still use the image, and a status
   *  code would not. */
  function report(err: unknown, fallback: string) {
    console.error(err)
    setError(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : fallback)
  }

  async function upload(files: File[]) {
    if (!canvasId || !files.length) return
    setBusy(true)
    setError(null)
    try {
      for (const file of files) await api.uploadAsset(canvasId, file)
      showToast(files.length === 1 ? 'Image uploaded' : `${files.length} images uploaded`)
      load()
    } catch (err) {
      report(err, 'Couldn’t upload that file.')
    } finally {
      setBusy(false)
    }
  }

  async function replace(asset: AssetSummary, file: File) {
    if (!canvasId) return
    setBusy(true)
    setError(null)
    try {
      const { frames } = await api.replaceAsset(canvasId, asset.id, file)
      /* the frames were rewritten server-side; the canvas hears about it the
         way it hears about any other frame write, so only the count is worth
         saying here */
      showToast(frames ? `Replaced — ${frames} frame${frames === 1 ? '' : 's'} updated` : 'Replaced — no frame used it')
      load()
    } catch (err) {
      report(err, 'Couldn’t replace that image.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(asset: AssetSummary) {
    setDeleting(null)
    setBusy(true)
    setError(null)
    try {
      await api.deleteAsset(asset.id)
      showToast('Image deleted')
      load()
    } catch (err) {
      report(err, 'Couldn’t delete that image.')
    } finally {
      setBusy(false)
    }
  }

  function loadMore() {
    if (!canvasId) return
    api
      .listAssets(canvasId, { limit: PAGE, offset: assets.length })
      .then((page) => {
        setAssets((prev) => [...prev, ...page.assets])
        setTotal(page.total)
        setHasMore(page.has_more)
      })
      .catch((err: unknown) => report(err, 'Couldn’t load more assets.'))
  }

  /* the drop target: image files dragged in from the desktop land in the
     library. The canvas has its own drop handling for the same files — this is
     the panel saying "put it in the library" rather than "put it on the
     page". */
  const onDropFiles = (e: DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    setDragOver(false)
    if (!files.length) return
    e.preventDefault()
    void upload(files)
  }

  return (
    <>
      <PanelBody className="flex flex-col py-2">
        <ListSection>
          <span>Assets</span>
          <span>{total}</span>
        </ListSection>
        {readOnly ? (
          <ListHint>Read only — sign in to add images to this canvas.</ListHint>
        ) : (
          <div
            className={cn(dropZone, dragOver ? 'border-ink bg-paper' : 'border-line')}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDropFiles}
          >
            <span className="text-[12px] leading-[1.45] text-ink-faint">
              Drop images here to add them to this canvas&rsquo;s library.
            </span>
            <Button variant="bare" size="pill" disabled={busy || !canvasId} onClick={() => uploadRef.current?.click()}>
              {busy ? 'Uploading…' : 'Upload images'}
            </Button>
          </div>
        )}
        {error && <ListHint className="text-accent-ink">{error}</ListHint>}
        {loaded && assets.length === 0 && !error && (
          <ListHint>
            No images yet. Anything pasted onto the canvas lands here too — frames keep the image by URL, so one upload
            can be used by many frames.
          </ListHint>
        )}
        {assets.length > 0 && (
          <div className="grid grid-cols-2 gap-2 px-3 py-2">
            {assets.map((a) => (
              <div key={a.id} className="flex min-w-0 flex-col gap-1.5">
                <img className={thumb} src={a.url} alt="" loading="lazy" />
                <ListMeta className="truncate" title={a.url}>
                  {describe(a)}
                </ListMeta>
                <div className="flex flex-wrap items-center gap-0.5">
                  <Button
                    variant="bare"
                    size="pill"
                    title="Copy the permanent URL frames embed"
                    onClick={() => {
                      navigator.clipboard.writeText(new URL(a.url, location.origin).href).then(
                        () => {
                          setCopiedId(a.id)
                          window.setTimeout(() => setCopiedId((id) => (id === a.id ? null : id)), 1500)
                        },
                        (err: unknown) => report(err, 'Couldn’t copy the URL.'),
                      )
                    }}
                  >
                    {copiedId === a.id ? 'Copied' : 'Copy URL'}
                  </Button>
                  {!readOnly && (
                    <>
                      <Button
                        variant="bare"
                        size="pill"
                        disabled={busy}
                        title="Swap the image behind this URL, updating every frame that uses it"
                        onClick={() => {
                          replaceTarget.current = a
                          replaceRef.current?.click()
                        }}
                      >
                        Replace
                      </Button>
                      <Button
                        variant="bare-danger"
                        size="pill"
                        disabled={busy}
                        title="Delete this image, if no frame still uses it"
                        onClick={() => setDeleting(a)}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {hasMore && (
          <div className="flex justify-center px-3 pb-2">
            <Button variant="bare" size="pill" disabled={busy} onClick={loadMore}>
              Load {Math.min(PAGE, total - assets.length)} more
            </Button>
          </div>
        )}
      </PanelBody>
      {/* the two pickers and the dialogs live outside the scrolling body, so
          they are never clipped by it. A read-only viewer gets neither picker:
          the drop zone and Replace were the only things that opened them */}
      {!readOnly && (
        <>
          <input
            ref={uploadRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              /* clearing the value lets the same file be chosen twice in a row */
              e.target.value = ''
              void upload(files)
            }}
          />
          <input
            ref={replaceRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              const asset = replaceTarget.current
              e.target.value = ''
              replaceTarget.current = null
              if (file && asset) void replace(asset, file)
            }}
          />
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this image?"
        description="It goes from the library for good, and anything still pointing at its URL breaks. A frame that still uses it has to stop first — the server refuses the delete until then."
        confirmLabel="Delete image"
        destructive
        onConfirm={() => deleting && void remove(deleting)}
      />
      {toast && <Toast>{toast}</Toast>}
    </>
  )
}
