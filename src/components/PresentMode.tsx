import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, visibleFrames } from '../lib/store'
import { FRAME_BOOTSTRAP } from '../lib/frameRuntime'
import { withTokenStyle } from '../../shared/tokens'
import { Button } from './ui/button'
import { XIcon } from './ui/icons'

/* Which way a key steps the deck; 0 means "not a stepping key". ←/→ work with
   or without ⇧; Space/⇧Space and PageUp/PageDown are the presenter's other two
   habits. A ⌘/⌥ chord belongs to the browser or the app, not to the deck. */
function stepDirection(e: KeyboardEvent): number {
  if (e.metaKey || e.ctrlKey || e.altKey) return 0
  if (e.key === 'ArrowRight' || e.key === 'PageDown') return 1
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') return -1
  if (e.key === ' ' || e.key === 'Spacebar') return e.shiftKey ? -1 : 1
  return 0
}

/* One step, wrapping at both ends: the frame after the last is the first, so
   ←/→ never go dead once a presenter reaches the end of the page. A step from
   an out-of-range position (the deck shrank under the show) lands in range
   first, which is what keeps a deleted frame from presenting nothing. */
function stepped(index: number, dir: number, total: number): number {
  if (!total) return index
  return (Math.min(index, total - 1) + dir + total) % total
}

/* Full-screen presentation of the frames on the page being viewed, in page
   order: the current one fills the viewport (letterboxed on ink) at native
   resolution scaled to fit, still connected to the room so edits streaming in
   render live. ←/→ (⇧Space back, Space forward, PageUp/PageDown) step through
   the page's frames, with the frame's name and its position in the deck on
   screen; frames the canvas has hidden are left out, so the deck is exactly
   what the canvas is showing. Stepping posts the next frame's html into the
   live document — the iframe is never remounted, so the token binding and
   everything the deck has already loaded stay put. Esc closes. */
export function PresentMode({ frameId, onClose }: { frameId: string; onClose: () => void }) {
  /* The deck derives from the canvas and the page id rather than from a
     selector that builds the list: a selector returning a fresh array
     re-renders on every store update (the trap FrameView documents). */
  const canvas = useStore((s) => s.canvas)
  const activePageId = useStore((s) => s.activePageId)
  const pages = canvas?.pages
  const deck = useMemo(() => visibleFrames({ canvas, activePageId }).filter((f) => !f.hidden), [canvas, activePageId])
  /* Seeded once from the frame the canvas opened us on; every step after that
     is internal, so the caller keeps its single `presenting` flag. */
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      deck.findIndex((f) => f.id === frameId),
    ),
  )
  /* the deck shrinks under us when a frame is deleted or hidden mid-show */
  const at = Math.min(index, Math.max(0, deck.length - 1))
  const frame = deck[at] ?? null
  /* a one-page canvas has nowhere to go, so the control only shows when there
     is more than one page to present. An unset active page reads as the first
     one, the same fallback the page tabs use */
  const showPages = (pages?.length ?? 0) > 1
  const shownPageId = activePageId ?? pages?.[0]?.id ?? ''
  /* switching page restarts the deck: the index counts frames of the page
     being viewed, so carrying it over would land the show mid-page (or past
     the new page's last frame). setActivePage is the frame tabs' own call, so
     the canvas behind the deck follows and keeps its selection */
  function changePage(pageId: string) {
    setIndex(0)
    useStore.getState().setActivePage(pageId)
  }
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:frame-ready') setReady(true)
      /* Escape with focus inside the frame (after clicking into it) never
         reaches this window as a key event; the runtime relays it */
      if (ev.data?.type === 'doop:esc') onClose()
      /* …and it relays the stepping keys the same way, so clicking the deck
         does not cost the presenter their arrows */
      if (ev.data?.type === 'doop:present-key' && (ev.data.dir === 1 || ev.data.dir === -1)) {
        setIndex((i) => stepped(i, ev.data.dir, deck.length))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [onClose, deck.length])

  /* presented the same way the canvas shows it: tokens bound at render time */
  const tokens = useStore((s) => s.canvas?.tokens)
  const html = useMemo(() => withTokenStyle(frame?.html ?? '', tokens), [frame?.html, tokens])
  useEffect(() => {
    if (!ready) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
  }, [ready, html])

  /* the runtime relays keys only while it knows it is the deck, which is what
     keeps a canvas frame's own arrow-scrolling intact */
  useEffect(() => {
    if (!ready) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:present', on: true }, '*')
  }, [ready])

  useEffect(() => {
    function onResize() {
      setViewport({ w: window.innerWidth, h: window.innerHeight })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* capture phase so Esc close, and the arrows step, without also reaching the
     canvas page, where Esc would clear the selection underneath and an arrow
     would nudge the selected frame */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      const dir = stepDirection(e)
      if (!dir) return
      e.preventDefault()
      e.stopPropagation()
      setIndex((i) => stepped(i, dir, deck.length))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, deck.length])

  /* every frame went away (deleted, or moved off the page under us) — nothing
     left to present */
  useEffect(() => {
    if (!frame) onClose()
  }, [frame, onClose])

  const scale = useMemo(() => {
    if (!frame) return 1
    return Math.min(viewport.w / frame.width, viewport.h / frame.height)
  }, [frame, viewport])

  if (!frame) return null

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-ink"
      role="dialog"
      aria-label={`Presenting ${frame.name}`}
    >
      <div
        className="relative overflow-hidden bg-white"
        style={{ width: Math.round(frame.width * scale), height: Math.round(frame.height * scale) }}
      >
        <iframe
          ref={iframeRef}
          className="block border-none bg-white"
          title={frame.name}
          sandbox="allow-scripts"
          srcDoc={FRAME_BOOTSTRAP}
          style={{ width: frame.width, height: frame.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}
        />
      </div>
      {/* the deck's own position readout, out of the way of clicks on the frame */}
      <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11.5px] font-semibold text-white/75">
        <span className="max-w-[240px] truncate text-white">{frame.name}</span>
        <span className="rounded-full bg-white/15 px-1.5 py-px font-mono text-[10.5px] tabular-nums">
          {at + 1} / {deck.length}
        </span>
        {deck.length > 1 && <span className="text-white/45">←/→</span>}
        {/* the only clickable thing in a container that is otherwise
            click-through, so the frame keeps every click that misses it */}
        {showPages && (
          <select
            aria-label="Presented page"
            className="pointer-events-auto cursor-pointer rounded-full bg-white/15 px-2 py-px font-mono text-[10.5px] font-medium text-white outline-none"
            value={shownPageId}
            onChange={(event) => changePage(event.target.value)}
          >
            {(pages ?? []).map((page) => (
              <option key={page.id} value={page.id} className="bg-ink text-white">
                {page.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <Button
        variant="inverse"
        size="icon"
        className="absolute top-3 right-3 rounded-full opacity-60 hover:opacity-100"
        aria-label="Exit presentation"
        title="Exit presentation (Esc)"
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  )
}
