import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentQuestion, ElementComment, Frame } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { canComment, checkVerdict, isReadOnly, useStore, type StreamEndReason } from '../lib/store'
import { registerFrameWindow, unregisterFrameWindow } from '../lib/frameBridge'
import { api } from '../lib/api'
import { sendWs } from '../lib/ws'
import { throttle } from '../lib/throttle'
import { timeAgo } from '../lib/time'
import { getIdentity } from '../lib/identity'
import { FRAME_BOOTSTRAP, takeFrameEditRequest } from '../lib/frameRuntime'
import { RichTextToolbar, type FormatCommand } from './RichTextToolbar'
import { stripTokenStyle, withTokenStyle } from '../../shared/tokens'
import { caughtStaleWrite, noteOwnWrite, recordCreate, recordUpdate, recordUpdates, trackSave } from '../lib/history'
import { snapFrame } from '../lib/snap'
import { gesture } from '../lib/gesture'
import { FrameContextMenu } from './FrameContextMenu'
import { CodePanel } from './CodePanel'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import {
  AGENT_ROLES,
  DEFAULT_ROLE_ID,
  mentionedAgent,
  mentionedRole,
  roleByAgentName,
  roleName,
} from '../../shared/agents'
import { posthog } from '../lib/posthog'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Tooltip } from './ui/tooltip'
import { EyeOffIcon, GithubIcon, LockIcon, SyncIcon } from './ui/icons'
import { isSyncedFrame } from '../lib/sync'
import { isGithubFrame, isGithubPlaceholder } from '../lib/github'
import { AgentIcon } from './AgentIcon'
import { RoleMark } from './RoleMark'

/* Counter-scale contract: chrome that keeps constant on-screen size divides
   by the `--zoom` variable the Stage publishes (capped at 2.4× when zoomed
   far out). Preserve these expressions exactly. */
const COUNTER_SCALE = '[transform:scale(min(calc(1/var(--zoom,1)),2.4))]'
const EDITOR_CHIP =
  'inline-flex items-center gap-1 rounded-full px-[7px] py-0.5 text-[10px] font-bold text-white animate-[chip-in_0.25s_ease]'
/* the element toolbar's buttons sit on ink and stay compact */
const EL_TOOLBAR_BTN = 'rounded-[7px] px-2 py-1 text-xs'

/* A stream's end is information: the viewer is told whether the design was
   delivered, the agent went quiet, someone took the frame over, or the agent
   replaced its own document. A takeover is the one case that is about the
   agent that was streaming — a human's edit cut its stream — so it names it. */
function streamEndLabel(name: string, reason: StreamEndReason): string {
  if (reason === 'done') return '✓ finished designing'
  if (reason === 'idle') return 'stream ended (agent silent)'
  if (reason === 'replaced') return 'stream ended'
  return `${name}'s stream was cut`
}

function streamEndTitle(name: string, reason: StreamEndReason): string {
  if (reason === 'done') return `${name} finished designing`
  if (reason === 'idle') return `${name} stopped responding mid-stream — its next write resumes the design`
  if (reason === 'replaced') return `${name} replaced the document it was streaming into`
  return `someone else edited this frame while ${name} was streaming`
}

/* Figma-style ⌥⇧-drag duplicate cursor: a doubled pointer, hotspot on the
   front arrow's tip. `copy` is the fallback where custom cursors fail. */
const DUP_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M9 8v12.6l3.4-2.9 2 4.6 2.3-1-2-4.5 4.5-.4z" fill="#000" stroke="#fff" stroke-width="1.2"/><path d="M4 3v12.6l3.4-2.9 2 4.6 2.3-1-2-4.5 4.5-.4z" fill="#000" stroke="#fff" stroke-width="1.2"/></svg>`
const DUP_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(DUP_CURSOR_SVG)}") 4 3, copy`

/** True while ⌥⇧ is held. The duplicate cursor must be showing BEFORE the
 *  drag starts: Chromium freezes the effective cursor for the duration of a
 *  pointer drag, so a swap at drag-start never paints. */
function useDupModifier(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setHeld(e.altKey && e.shiftKey)
    const reset = () => setHeld(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', reset)
    }
  }, [])
  return held
}

/** Re-render the iframe at most every `ms` — keeps streaming chunk updates smooth. */
function useThrottledValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - Date.now())
    const t = window.setTimeout(() => {
      last.current = Date.now()
      setV(value)
    }, wait)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

interface ProbeHit {
  selector: string
  /** content key from the runtime — the anchor a stale selector falls back to */
  key?: string
  tag: string
  text: string
  snippet: string
  rect: { x: number; y: number; width: number; height: number }
}

/* Where a question without an element selector pins: the frame's top-left
   corner, so it is still findable when nothing anchors it. */
const QUESTION_PIN_POS = { x: 22, y: 22 }

type DragRect = { id: string; x: number; y: number; width: number; height: number }

interface HoverHit {
  tag: string
  rect: { x: number; y: number; width: number; height: number }
}

/* Counter-scaled overlays (labels, pins, popovers) get their scale from the
   `--zoom` CSS variable the Stage sets, so a viewport change never re-renders
   this component — memo holds as long as the frame and raster are unchanged. */
export const FrameView = memo(function FrameView({ frame, raster }: { frame: Frame; raster: number }) {
  const selected = useStore((s) => s.selectedIds.includes(frame.id))
  /* space held: the shield stays up even in edit mode, so the press reaches
     the Stage and pans instead of vanishing into the editable iframe */
  const panMode = useStore((s) => s.panMode)
  const select = useStore((s) => s.select)
  const flash = useStore((s) => s.flashes[frame.id])
  const stream = useStore((s) => s.streams[frame.id])
  const streamEnd = useStore((s) => s.streamEnds[frame.id])
  /* The frame's last check, for the verdict dot in its label. The Checks tab
     fills the same store entry, and a frame nobody opened that tab beside
     still gets one: fetch once, and keep whatever we have if the fetch
     fails — the panel's own load will try again. */
  const review = useStore((s) => s.frameReviews[frame.id])
  const setFrameReview = useStore((s) => s.setFrameReview)
  /* A share-link visitor and a borrowed "view as" session change nothing: the
     frame's geometry and its document are frozen exactly as a locked one's
     are, so the same refusals below cover both. */
  const readOnly = useStore(isReadOnly)
  /* whether this client may leave a note on an element — false for a
     view-only link, true for everyone signed in */
  const canNote = useStore(canComment)
  const askedForReview = useRef(false)
  useEffect(() => {
    /* demo frames are product onboarding: nothing checks them, so asking
       would be one request per onboarding frame for an answer that is always
       the same */
    if (frame.demo || review || askedForReview.current) return
    askedForReview.current = true
    api
      .frameReviews(frame.id, 1)
      .then(([latest]) => {
        if (latest) setFrameReview(frame.id, latest)
      })
      .catch(console.error)
  }, [frame.id, frame.demo, review, setFrameReview])
  const check = review && { verdict: checkVerdict(review, frame), at: review.reviewedAt }
  /* the end notice is transient: "finished designing" is a confirmation, not
     a state, so it clears itself after a beat. The notice is derived from the
     store and only the dismissal is state — a full replace by the streaming
     agent itself is not an end the viewer needs told about (it is still there,
     still working), and a notice is stale once a newer end replaces it. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const endAt = streamEnd?.at
  const endReason = streamEnd?.reason
  useEffect(() => {
    if (endAt === undefined || endReason === 'replaced') return
    const t = window.setTimeout(() => setDismissedAt(endAt), endReason === 'done' ? 2000 : 6000)
    return () => window.clearTimeout(t)
  }, [endAt, endReason])
  const endNotice = streamEnd && endReason !== 'replaced' && dismissedAt !== endAt ? streamEnd : null
  /* select the stable presences map, derive in render — a selector that
     builds a fresh array re-renders every frame on EVERY store update
     (zustand compares by identity), which defeats the memo above */
  const presences = useStore((s) => s.presences)
  const me = getIdentity().clientId
  const editors = Object.values(presences).filter((p) => p.activeFrameId === frame.id && p.clientId !== me)
  const [dragging, setDragging] = useState(false)
  /* ⌥⇧-drag (Figma-style duplicate): the original stays behind, the copy
     rides the cursor — the doubled cursor shows from the moment ⌥⇧ is held */
  const [duping, setDuping] = useState(false)
  const dupKeyHeld = useDupModifier()
  const [editing, setEditing] = useState(false)
  /* after exiting edit mode, hold renders until the final serialized HTML
     lands in the store — otherwise a stale post would morph the edit away */
  const [suspendPost, setSuspendPost] = useState(false)

  /* one throttle per frame, so a group drag broadcasts every member —
     a single throttle would keep only the last frame written each tick */
  const dragSenders = useRef(new Map<string, (f: DragRect) => void>()).current
  function sendDrag(id: string, f: DragRect) {
    let send = dragSenders.get(id)
    if (!send) {
      send = throttle((r: DragRect) => {
        sendWs({ type: 'frame:drag', frameId: r.id, x: r.x, y: r.y, width: r.width, height: r.height })
      }, 50)
      dragSenders.set(id, send)
    }
    send(f)
  }

  function startDrag(e: React.PointerEvent, mode: 'move' | 'resize', probeOnClick = false, panelOnClick = false) {
    if (e.button !== 0) return
    /* space held: let the event reach the Stage, which pans */
    if (useStore.getState().panMode) return
    e.stopPropagation()
    e.preventDefault()
    /* ⌥⇧-drag duplicates: the moment the drag is real, leave a copy of the
       frame at its origin and keep dragging this one — same net effect as
       Figma's "drag off a duplicate", without retargeting the drag */
    const duplicating = mode === 'move' && e.altKey && e.shiftKey
    /* plain ⇧-click adds to (or drops from) the selection; a dropped frame
       does not start a drag */
    if (mode === 'move' && e.shiftKey && !e.altKey) {
      useStore.getState().toggleSelect(frame.id)
      if (!useStore.getState().selectedIds.includes(frame.id)) return
    } else if (!useStore.getState().selectedIds.includes(frame.id)) {
      /* clicking a frame already in a group keeps the group — the drag
         moves all of them */
      select(frame.id)
    }
    /* a locked frame is frozen: the press still selects it, opens its details
       and probes its elements (all read-only), but it never drags, resizes or
       spins up an ⌥⇧ duplicate — the geometry write would be refused by the
       server anyway, so refusing it here keeps the frame from jumping and
       snapping back. A read-only visitor gets the same treatment for every
       frame: someone else's share link is not where they move things. */
    if (frame.locked || readOnly) {
      if (mode === 'move') {
        if (probeOnClick) probeAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY)
        else if (panelOnClick) useStore.getState().setInspectorOpen(true)
      }
      return
    }
    setDragging(true)
    clearHover()
    const start = { x: e.clientX, y: e.clientY }
    const off = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }
    const orig = { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
    /* the drag's baseline: finger position and frame rect the deltas are
       measured from. Starts at pointer-down, and re-anchors while a pinch
       owns the finger so the drag resumes from where the finger is (and at
       the zoom it is now) rather than jumping by the pinch's displacement */
    let base = { x: start.x, y: start.y, rect: orig }
    let moved = false
    let dupDropped = false
    if (duplicating) setDuping(true)
    /* a move carries every selected frame along; a resize is this frame only */
    const frames = useStore.getState().canvas?.frames ?? []
    const selectedIds = mode === 'move' ? useStore.getState().selectedIds : [frame.id]
    const group = frames
      .filter((f) => selectedIds.includes(f.id))
      .map((f) => ({ id: f.id, orig: { x: f.x, y: f.y, width: f.width, height: f.height } }))
    const groupIds = new Set(group.map((g) => g.id))

    function onMove(ev: PointerEvent) {
      if (ev.pointerId !== e.pointerId) return
      /* a second finger turns the gesture into a pinch: the frame stays put */
      if (gesture.pinching) {
        const cur = useStore.getState().canvas?.frames.find((x) => x.id === frame.id)
        base = { x: ev.clientX, y: ev.clientY, rect: cur ? { ...cur } : base.rect }
        return
      }
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) moved = true
      if (duplicating && moved && !dupDropped) {
        dupDropped = true
        for (const g of group) {
          const src = frames.find((f) => f.id === g.id)
          if (!src) continue
          api
            .createFrame(src.canvasId, { name: src.name, html: src.html, ...g.orig })
            .then((f) => {
              posthog.capture('frame_duplicated', { via: 'drag' })
              recordCreate(f)
            })
            .catch(console.error)
        }
      }
      const zoom = useStore.getState().viewport.zoom
      const dx = (ev.clientX - base.x) / zoom
      const dy = (ev.clientY - base.y) / zoom
      const from = base.rect
      const raw =
        mode === 'move'
          ? { ...from, x: Math.round(from.x + dx), y: Math.round(from.y + dy) }
          : {
              ...from,
              width: Math.max(120, Math.round(from.width + dx)),
              height: Math.max(80, Math.round(from.height + dy)),
            }
      /* edges pull onto neighbouring frames' edges/centers; ⌥ drags free.
         Frames riding along in the group are not neighbours. */
      const others = useStore.getState().canvas?.frames.filter((f) => !groupIds.has(f.id)) ?? []
      const snapped = ev.altKey ? { ...raw, guides: [] } : snapFrame(mode, raw, others, zoom)
      useStore.getState().setSnapGuides(snapped.guides)
      if (mode === 'move') {
        /* the snapped delta of the dragged frame moves the whole group */
        const sdx = snapped.x - orig.x
        const sdy = snapped.y - orig.y
        for (const g of group) {
          useStore.getState().patchFrameLocal(g.id, { x: g.orig.x + sdx, y: g.orig.y + sdy })
        }
      } else {
        useStore.getState().patchFrameLocal(frame.id, { width: snapped.width, height: snapped.height })
      }
      const live = useStore.getState().canvas?.frames ?? []
      for (const g of group) {
        const f = live.find((x) => x.id === g.id)
        if (f) sendDrag(f.id, { id: f.id, x: f.x, y: f.y, width: f.width, height: f.height })
      }
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragging(false)
      if (duplicating) setDuping(false)
      useStore.getState().setSnapGuides([])
      const live = useStore.getState().canvas?.frames ?? []
      const updates: { frameId: string; before: typeof orig; after: typeof orig }[] = []
      for (const g of group) {
        const f = live.find((x) => x.id === g.id)
        if (!f) continue
        const after = { x: f.x, y: f.y, width: f.width, height: f.height }
        /* No precondition on a drag: the frames written here are exactly the
           ones the user just moved by hand, and where they were let go IS the
           new truth — a copy that moved under the pointer while the drag was
           in flight is the one that gets superseded, not the drag. The next
           edit after the drag does precondition, on this write's answer. */
        trackSave(api.updateFrame(f.id, after).then(noteOwnWrite).catch(console.error))
        updates.push({ frameId: f.id, before: g.orig, after })
      }
      const [only, ...more] = updates
      if (only && !more.length) recordUpdate(only.frameId, only.before, only.after)
      else recordUpdates(updates)
      /* a click (no drag) on the frame surface targets the element under
         the cursor: probe it and show the element toolbar */
      if (!moved && probeOnClick) probeAt(off.x, off.y)
      else if (moved) closePopovers()
      /* a click (no drag) on the frame name opens the details panel */
      if (!moved && panelOnClick) useStore.getState().setInspectorOpen(true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /* The canvas's design tokens are bound in here, at render time: the stored
     frame HTML stays pure, and changing the tokens restyles every frame
     without rewriting one. */
  const tokens = useStore((s) => s.canvas?.tokens)
  const throttledHtml = useThrottledValue(frame.html, 150)
  const html = useMemo(() => withTokenStyle(throttledHtml, tokens), [throttledHtml, tokens])
  const remoteEditor = editors[0]

  /* The iframe loads a bootstrap once; HTML is posted in and DOM-morphed in
     place, so updates never white-flash the frame with a full reload. */
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  /* where the last right-click landed, in screen coordinates: Paste drops the
     frame there, and the menu's own box is not that point once Radix has
     flipped or shifted it away from a viewport edge */
  const menuAt = useRef({ x: 0, y: 0 })
  const [runtimeReady, setRuntimeReady] = useState(false)
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.data?.type === 'doop:frame-ready' && ev.source === iframeRef.current?.contentWindow) {
        setRuntimeReady(true)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  /* once the runtime answers, the element panel may talk to this document */
  useEffect(() => {
    const win = iframeRef.current?.contentWindow
    if (!runtimeReady || !win) return
    registerFrameWindow(frame.id, win)
    return () => unregisterFrameWindow(frame.id, win)
  }, [runtimeReady, frame.id])
  /* The text tool creates a frame that must open already in edit mode. The
     request rides frameRuntime's queue rather than a prop — FrameView is
     mounted by Stage, which this change does not own — and is spent here, on
     the runtime's own readiness signal, through the same enterEdit() a
     double-click uses: a locked frame or a read-only viewer gets the same
     gates, and the request is claimed exactly once.

     The document is posted first, explicitly: the runtime ignores `doop:html`
     once editing is on (a streamed update must not clobber the element under
     the caret), so a caret session opened on an unseeded frame would show the
     freshly made frame blank. Sending it here keeps that order independent of
     how the two effects are laid out. */
  useEffect(() => {
    if (!runtimeReady) return
    if (!takeFrameEditRequest(frame.id)) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
    enterEdit()
  }, [runtimeReady]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!runtimeReady || editing || suspendPost) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:html', html }, '*')
  }, [runtimeReady, html, editing, suspendPost])

  /* ---- element comments ---- */
  const frameComments = useStore((s) => s.comments).filter((c) => c.frameId === frame.id)
  /* only thread roots get a pin; replies live inside the root's popover */
  const comments = frameComments.filter((c) => !c.parentId && !c.resolvedAt)

  /* ---- agent questions on this frame ---- */
  /* an open question is an agent parked mid-task waiting on a human */
  const openQuestions = useStore((s) => s.questions).filter((q) => q.frameId === frame.id && q.status === 'open')
  const lock = useStore((s) => s.frameLocks[frame.id])
  const [probe, setProbe] = useState<ProbeHit | null>(null)
  /* element selected for text editing inside the iframe (edit mode only) */
  const [activeHit, setActiveHit] = useState<ProbeHit | null>(null)
  const [composing, setComposing] = useState(false)
  const [openThread, setOpenThread] = useState<string | null>(null)
  /* a question can be answered at its pin: the agent is parked on it, so
     sending the reviewer to another tab to type one line is a detour */
  const [answeringId, setAnsweringId] = useState<string | null>(null)
  const [answerDraft, setAnswerDraft] = useState('')
  const [answerBusy, setAnswerBusy] = useState(false)
  const [pinPos, setPinPos] = useState<Record<string, { x: number; y: number } | null>>({})
  const probeReq = useRef(0)
  const probeTimer = useRef<number | null>(null)
  const activeSelRef = useRef<string | null>(null)

  /* ---- hover inspection (paper.design-style element outlines) ---- */
  const [hover, setHover] = useState<HoverHit | null>(null)
  const hoverReq = useRef(0)
  const hoverKey = useRef<string | null>(null)

  const hoverLast = useRef(0)
  function sendHover(x: number, y: number) {
    /* pointermove fires every frame — one probe per ~40ms is plenty */
    const now = Date.now()
    if (now - hoverLast.current < 40) return
    hoverLast.current = now
    hoverReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:hover', reqId: hoverReq.current, x, y }, '*')
  }

  function clearHover() {
    hoverReq.current += 1 // drop any in-flight result
    hoverKey.current = null
    setHover(null)
  }

  /* source view + composer prefill for the element toolbar */
  const [codeView, setCodeView] = useState<string | null>(null)
  const [composePrefill, setComposePrefill] = useState('')
  const codeReq = useRef(0)

  function requestCode(selector: string) {
    codeReq.current += 1
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:code', reqId: codeReq.current, selector }, '*')
  }

  function closePopovers() {
    if (probeTimer.current) {
      window.clearTimeout(probeTimer.current)
      probeTimer.current = null
    }
    setProbe(null)
    setComposing(false)
    setComposePrefill('')
    setCodeView(null)
    setOpenThread(null)
    setAnsweringId(null)
  }

  /** The pin's answer box posts the same call the Review tab's does: the
   *  answer reaches the agent inside its ask_human wait. */
  function answerQuestion(q: AgentQuestion) {
    const text = answerDraft.trim()
    if (!text || answerBusy) return
    setAnswerBusy(true)
    api
      .answerQuestion(q.canvasId, q.id, text)
      .then(() => {
        setAnswerDraft('')
        setAnsweringId(null)
      })
      .catch(console.error)
      .finally(() => setAnswerBusy(false))
  }

  /* delayed slightly so the second click of a double-click (→ edit mode)
     cancels it instead of flashing the toolbar */
  function probeAt(x: number, y: number) {
    if (!frame.html || editing) return
    closePopovers()
    probeTimer.current = window.setTimeout(() => {
      probeTimer.current = null
      probeReq.current += 1
      iframeRef.current?.contentWindow?.postMessage({ type: 'doop:probe', reqId: probeReq.current, x, y }, '*')
    }, 250)
  }

  const commentKey = comments.map((c) => c.id).join(',')
  const questionKey = openQuestions.map((q) => q.id).join(',')
  /* keep comment (and question) pins glued to their elements: re-locate
     whenever the frame's html or the pinned set changes */
  useEffect(() => {
    if (!runtimeReady) return
    for (const c of comments) {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'doop:locate', reqId: c.id, selector: c.selector, key: c.stableKey },
        '*',
      )
    }
    for (const q of openQuestions) {
      if (q.selector)
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'doop:locate', reqId: q.id, selector: q.selector, key: q.stableKey },
          '*',
        )
    }
  }, [runtimeReady, html, commentKey, questionKey]) // eslint-disable-line react-hooks/exhaustive-deps

  /* the selection outline follows its element across html updates (streams,
     agent edits) the same way pins do */
  const probeSel = probe?.selector ?? null
  useEffect(() => {
    if (!runtimeReady || !probeSel) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:locate', reqId: '__probe__', selector: probeSel }, '*')
  }, [runtimeReady, html, probeSel])

  /* deselecting the frame drops its element selection too, so a stale
     outline never reappears when the frame is picked again */
  /* how each pin's anchor resolved: 'key' means the selector went stale and the
     content key found the element, 'lost' that the element is gone */
  const [pinAnchor, setPinAnchor] = useState<Record<string, string>>({})
  const [wasSelected, setWasSelected] = useState(selected)
  if (wasSelected !== selected) {
    setWasSelected(selected)
    if (!selected) setProbe(null)
  }

  /* the outlined element is shared with the Layers panel through the store:
     what is probed here is published, and a row picked there is resolved
     into a probe by asking the runtime for the element behind the selector */
  useEffect(() => {
    const cur = useStore.getState().selectedElement
    if (probeSel) {
      useStore.getState().setSelectedElement({ frameId: frame.id, selector: probeSel })
    } else if (cur?.frameId === frame.id) {
      useStore.getState().setSelectedElement(null)
    }
  }, [probeSel, frame.id])
  const wantedSel = useStore((s) => (s.selectedElement?.frameId === frame.id ? s.selectedElement.selector : null))
  const selectReq = useRef(0)
  useEffect(() => {
    if (!runtimeReady || !wantedSel || wantedSel === probeSel) return
    selectReq.current += 1
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'doop:select', reqId: selectReq.current, selector: wantedSel },
      '*',
    )
  }, [runtimeReady, wantedSel, probeSel])

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:probe-result' && ev.data.reqId === probeReq.current) {
        setProbe(ev.data.hit ?? null)
      }
      if (ev.data?.type === 'doop:select-result' && ev.data.reqId === selectReq.current) {
        const hit = (ev.data.hit ?? null) as ProbeHit | null
        closePopovers()
        if (hit) setProbe(hit)
        else useStore.getState().setSelectedElement(null) // the row's element is gone from the live document
      }
      if (ev.data?.type === 'doop:hover-result' && ev.data.reqId === hoverReq.current) {
        const hit = (ev.data.hit ?? null) as HoverHit | null
        /* only re-render when the outlined element actually changes */
        const key = hit ? hit.tag + JSON.stringify(hit.rect) : null
        if (key !== hoverKey.current) {
          hoverKey.current = key
          setHover(hit)
        }
      }
      if (ev.data?.type === 'doop:active') {
        const hit = (ev.data.hit ?? null) as ProbeHit | null
        /* rect refreshes for the same element keep the composer open;
           switching elements (or deselecting) closes it */
        if ((hit?.selector ?? null) !== activeSelRef.current) setComposing(false)
        activeSelRef.current = hit?.selector ?? null
        setActiveHit(hit)
      }
      if (ev.data?.type === 'doop:code-result' && ev.data.reqId === codeReq.current) {
        setCodeView(typeof ev.data.html === 'string' ? ev.data.html : null)
      }
      if (ev.data?.type === 'doop:located' && typeof ev.data.reqId === 'string') {
        if (ev.data.reqId === '__probe__') {
          /* re-glue the selected element's outline after the html changed */
          const rect = ev.data.rect as ProbeHit['rect'] | null
          setProbe((p) => (p && rect ? { ...p, rect } : rect ? p : null))
          return
        }
        const rect = ev.data.rect as { x: number; y: number; width: number } | null
        setPinPos((m) => ({ ...m, [ev.data.reqId]: rect ? { x: rect.x + rect.width, y: rect.y } : null }))
        /* the anchor moved (the key found it) or is gone; either way the human
           should see which, not lose the pin silently */
        const anchor = typeof ev.data.anchor === 'string' ? (ev.data.anchor as string) : 'selector'
        setPinAnchor((m) => (m[ev.data.reqId] === anchor ? m : { ...m, [ev.data.reqId]: anchor }))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  /* Esc dismisses popovers (edit mode has its own Esc path inside the iframe) */
  useEffect(() => {
    if (!probe && !openThread) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePopovers()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [probe, openThread])

  useEffect(() => {
    if (!selected) {
      closePopovers()
      const s = useStore.getState()
      if (s.ctxMenu?.frameId === frame.id) s.closeCtxMenu()
    }
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- inline text editing ---- */
  /* a locked frame's document is frozen — the same rule the server states
     with a 423 on a content write, said here so the editor never opens on
     one. A read-only visitor's frames are all frozen that way. */
  const canEdit = !!frame.html && !stream && !frame.locked && !readOnly && !/<script/i.test(frame.html)

  function enterEdit() {
    /* double-click, the element toolbar and the text tool all land here:
       one gate, so a locked frame can never reach the editable document */
    if (frame.locked || readOnly) return
    select(frame.id)
    closePopovers()
    clearHover()
    setEditing(true)
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: true }, '*')
  }
  function exitEdit() {
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:edit', on: false }, '*')
    setEditing(false)
    setActiveHit(null)
    setComposing(false)
    activeSelRef.current = null
    setSuspendPost(true)
    window.setTimeout(() => setSuspendPost(false), 500)
  }

  /* The mini toolbar's commands cross into the sandboxed document as messages
     (nothing else can reach it): the runtime applies the command to the element
     being edited and saves the result through the same serialized-edit path a
     keystroke takes — see doop:format. */
  function sendFormat(command: FormatCommand, value?: string) {
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:format', command, ...(value ? { value } : {}) }, '*')
  }

  /* serialized edits stream out of the iframe; save through the human path */
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (ev.data?.type === 'doop:edited' && typeof ev.data.html === 'string') {
        /* the runtime serializes the document it was given, token block
           included — strip it so the injected style never becomes part of the
           frame, in the store, the history or the server */
        const next = stripTokenStyle(ev.data.html)
        /* the live copy is both the document this edit started from and the
           version the write preconditions on: an agent that streamed into the
           frame while the user was typing refuses the edit rather than have
           its design replaced by one built on the old text, and the refusal
           repaints the frame from the server's copy */
        const live = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
        useStore.getState().patchFrameLocal(frame.id, { html: next })
        api
          .updateFrame(frame.id, { html: next }, live ? { expectedUpdatedAt: live.updatedAt } : undefined)
          .then(noteOwnWrite)
          .catch((err: unknown) => {
            const conflict = caughtStaleWrite(err)
            if (conflict) console.error(conflict.error)
          })
        if (live) recordUpdate(frame.id, { html: live.html }, { html: next })
      }
      if (ev.data?.type === 'doop:edit-esc') {
        setEditing(false)
        setSuspendPost(true)
        window.setTimeout(() => setSuspendPost(false), 500)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frame.id])

  /* deselecting the frame ends the edit session. Selection lives in the
     store and the iframe has to be told, so this is a sync with an external
     system rather than derived state. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (!selected && editing) exitEdit()
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  /* When zoomed past 100%, render the iframe k× larger and counter-scale it,
     with a matching CSS zoom inside — same layout, k× the raster density, so
     frames stay crisp instead of looking like scaled-up bitmaps. The factor
     is computed by the Stage from the settled (gesture-idle) zoom. */
  useEffect(() => {
    if (!runtimeReady) return
    iframeRef.current?.contentWindow?.postMessage({ type: 'doop:zoom', zoom: raster }, '*')
  }, [runtimeReady, raster])

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const store = useStore.getState()
        if (!open) return store.closeCtxMenu()
        /* deferPanel: when this right-click is what selects the frame, the
           Inspector waits until the menu closes — it must not slide in
           underneath the menu the user just opened */
        const alreadySelected = store.selectedIds.includes(frame.id)
        /* a right-click inside a group keeps the group, so Delete takes all */
        if (!alreadySelected) select(frame.id)
        closePopovers()
        store.openCtxMenu({ frameId: frame.id, deferPanel: !alreadySelected })
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group absolute',
            stream &&
              "before:pointer-events-none before:absolute before:-inset-[3px] before:rounded-[9px] before:border-2 before:border-dashed before:border-[var(--editing-color,var(--brand))] before:content-[''] before:animate-[stream-pulse_1.1s_ease-in-out_infinite]",
          )}
          style={
            {
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              /* render-only, exactly as the model says: x/y/width/height keep
                 their axis-aligned meaning, so hit testing, snapping and the
                 marquee stay plain boxes while the frame is drawn turned.
                 Both properties are inline (not classes) because they are
                 per-frame values. */
              opacity: frame.opacity,
              transform: `rotate(${frame.rotation}deg)`,
              transformOrigin: 'center',
              '--editing-color': stream?.color ?? remoteEditor?.color ?? flash?.color,
            } as React.CSSProperties
          }
          /* stop the event here so the Stage's background menu — whose trigger
         wraps this one — does not open a second menu behind ours */
          onContextMenu={(e) => {
            /* stop here so the Stage's background trigger, which wraps this
               one, does not open a second menu behind ours */
            e.stopPropagation()
            menuAt.current = { x: e.clientX, y: e.clientY }
          }}
        >
          <div
            className={cn(
              'absolute -top-[26px] left-0 right-0 flex origin-bottom-left cursor-grab select-none items-center gap-2 whitespace-nowrap text-[12px] font-semibold text-ink-soft',
              COUNTER_SCALE,
            )}
            style={duping || dupKeyHeld ? { cursor: DUP_CURSOR } : undefined}
            onPointerDown={(e) => startDrag(e, 'move', false, true)}
          >
            {isSyncedFrame(frame.html) && (
              <Tooltip label="Synced from a live app" side="top" align="start">
                <span className="flex shrink-0 items-center text-brand">
                  <SyncIcon width={11} height={11} />
                </span>
              </Tooltip>
            )}
            {isGithubFrame(frame.html) && (
              <Tooltip
                label={
                  isGithubPlaceholder(frame.html)
                    ? 'Found in the repo — awaiting capture'
                    : 'Imported from a GitHub repo'
                }
                side="top"
                align="start"
              >
                <span
                  className={cn(
                    'flex shrink-0 items-center',
                    isGithubPlaceholder(frame.html) ? 'text-ink-faint' : 'text-brand',
                  )}
                >
                  <GithubIcon width={11} height={11} />
                </span>
              </Tooltip>
            )}
            <span className="overflow-hidden text-ellipsis">{frame.name}</span>
            {/* the frame's own lock state, where its name is: the padlock is
                the reason dragging and editing do nothing here */}
            {frame.locked && (
              <Tooltip label="Locked — unlock it to move, resize or edit this frame" side="top" align="start">
                <span className="flex shrink-0 items-center text-ink-faint" aria-label="Locked">
                  <LockIcon width={11} height={11} />
                </span>
              </Tooltip>
            )}
            {/* a hidden frame is off the stage (Stage filters it out); should
                one ever be rendered anyway, its label says why it looks odd */}
            {frame.hidden && (
              <Tooltip label="Hidden — shown in the Layers rail only" side="top" align="start">
                <span className="flex shrink-0 items-center text-ink-faint" aria-label="Hidden">
                  <EyeOffIcon width={11} height={11} />
                </span>
              </Tooltip>
            )}
            {/* the frame's own answer to "did this pass" — a dot, so the
                verdict sits with the frame and not only in the Checks tab */}
            {check && (
              <Tooltip
                label={
                  check.verdict === 'pass'
                    ? `Checks passed ${timeAgo(check.at)}`
                    : check.verdict === 'fail'
                      ? `Checks failed ${timeAgo(check.at)} — an agent cannot hand this frame back until it passes`
                      : `Checked ${timeAgo(check.at)}, but the frame changed since — the report no longer describes it`
                }
                side="top"
                align="start"
              >
                <span
                  className={cn(
                    'size-[7px] shrink-0 rounded-full',
                    check.verdict === 'pass'
                      ? 'bg-brand'
                      : check.verdict === 'fail'
                        ? 'bg-accent-ink'
                        : 'border border-ink-faint',
                  )}
                />
              </Tooltip>
            )}
            <span className="flex gap-1">
              {stream && (
                <span className={EDITOR_CHIP} style={{ background: stream.color }}>
                  <AgentIcon name={stream.name} size={9} color="#fff" />
                  {stream.name} is designing
                  <span className="after:content-['…'] after:[animation:ellipsis_1.2s_steps(4)_infinite]" />
                </span>
              )}
              {!stream && endNotice && (
                <span
                  className={EDITOR_CHIP}
                  style={{ background: endNotice.reason === 'done' ? endNotice.color : 'var(--ink-soft, #6b7280)' }}
                  title={streamEndTitle(endNotice.name, endNotice.reason as StreamEndReason)}
                >
                  {streamEndLabel(endNotice.name, endNotice.reason as StreamEndReason)}
                </span>
              )}
              {editors
                .filter((p) => p.name !== stream?.name)
                .map((p) => (
                  <span key={p.clientId} className={EDITOR_CHIP} style={{ background: p.color }}>
                    {p.kind === 'agent' ? <AgentIcon name={p.name} size={9} color="#fff" /> : '✎'} {p.name}
                  </span>
                ))}
              {lock && (
                <span
                  className={EDITOR_CHIP}
                  style={{ background: lock.color }}
                  title={`${lock.name} is editing this frame`}
                >
                  ✎ held by {lock.name}
                </span>
              )}
            </span>
          </div>

          <div
            className={cn(
              'absolute inset-0 cursor-grab overflow-hidden rounded-[6px] border border-line bg-white',
              dragging ? 'shadow-pop' : 'shadow-card',
              selected && 'outline-2 outline-offset-1 outline-brand',
              editing && 'cursor-text outline-2 outline-offset-1 outline-dashed outline-brand',
              !stream &&
                remoteEditor &&
                'outline-2 outline-offset-1 outline-solid outline-[var(--editing-color,var(--brand))]',
              stream && 'border-transparent outline-none',
              dragging && 'cursor-grabbing',
            )}
            style={duping || (dupKeyHeld && !editing) ? { cursor: DUP_CURSOR } : undefined}
            onPointerDown={(e) => startDrag(e, 'move', true)}
            onDoubleClick={() => canEdit && !editing && enterEdit()}
            onPointerMove={(e) => {
              if (editing || dragging || !frame.html || !runtimeReady) return
              /* screen px → design px: the frame lives inside the zoomed stage */
              const r = e.currentTarget.getBoundingClientRect()
              const zoom = useStore.getState().viewport.zoom
              sendHover((e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom)
            }}
            onPointerLeave={clearHover}
          >
            <iframe
              ref={iframeRef}
              className="block border-none bg-white"
              title={frame.name}
              sandbox="allow-scripts"
              srcDoc={FRAME_BOOTSTRAP}
              style={{
                width: frame.width * raster,
                height: frame.height * raster,
                transform: `scale(${1 / raster})`,
                transformOrigin: '0 0',
              }}
            />
            {!frame.html && (
              <div className="absolute inset-0 grid place-items-center bg-[repeating-linear-gradient(45deg,transparent_0_10px,rgba(28,26,21,0.025)_10px_20px)] text-[13px] text-ink-faint">
                empty frame — add HTML
              </div>
            )}
            {/* shield keeps pointer events on the canvas, not the iframe;
            lifted while editing so clicks land in the editable document */}
            {(!editing || panMode) && <div className="absolute inset-0" />}
            {hover && !editing && !dragging && (
              <div
                className="pointer-events-none absolute z-[3] bg-[rgba(60,130,246,0.06)] shadow-[inset_0_0_0_calc(1.5px/var(--zoom,1))_#3c82f6]"
                style={{ left: hover.rect.x, top: hover.rect.y, width: hover.rect.width, height: hover.rect.height }}
              >
                <span
                  className={cn(
                    'absolute top-0 left-0 whitespace-nowrap bg-[#3c82f6] px-1.5 py-[3px] text-[10px] font-bold leading-none text-white [font-family:ui-monospace,monospace]',
                    hover.rect.y < 18
                      ? 'origin-top-left rounded-[0_0_4px_0] [transform:translateY(0)_scale(min(calc(1/var(--zoom,1)),2.4))]'
                      : 'origin-bottom-left rounded-[4px_4px_4px_0] [transform:translateY(-100%)_scale(min(calc(1/var(--zoom,1)),2.4))]',
                  )}
                >
                  {hover.tag}
                </span>
              </div>
            )}
            {probe && selected && !editing && !dragging && (
              <div
                className="pointer-events-none absolute z-[3] shadow-[inset_0_0_0_calc(1.5px/var(--zoom,1))_#3c82f6,0_0_0_calc(1.5px/var(--zoom,1))_rgba(60,130,246,0.35)]"
                style={{ left: probe.rect.x, top: probe.rect.y, width: probe.rect.width, height: probe.rect.height }}
              />
            )}
            {flash && (
              <div
                className="pointer-events-none absolute -inset-px rounded-[6px] animate-[frame-flash_1.2s_ease-out_forwards]"
                style={{ '--editing-color': flash.color } as React.CSSProperties}
              />
            )}
          </div>

          {editing && (
            <div
              className={cn(
                'absolute top-[calc(100%_+_10px)] left-0 flex origin-top-left items-center gap-[9px] whitespace-nowrap rounded-full bg-ink py-1 pr-[5px] pl-3 text-[11px] font-semibold text-white shadow-card animate-[chip-in_0.25s_ease]',
                COUNTER_SCALE,
              )}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {/* rich text for the element the caret is in; dim until one is */}
              <RichTextToolbar onFormat={sendFormat} ready={!!activeHit} />
              <span className="h-3.5 w-px bg-white/20" />
              Click any text to edit
              <Button
                variant="primary"
                size="pill"
                className="border-transparent px-2.5 shadow-none hover:translate-x-0 hover:translate-y-0 hover:brightness-110 hover:shadow-none"
                onClick={exitEdit}
                title="Save and finish editing (Esc)"
              >
                ✓ Done
              </Button>
            </div>
          )}

          {/* element comments: pins + element toolbar + composer, all in frame
          coords. The toolbar anchors to the probed element normally, and to
          the actively edited element in edit mode. */}
          {(() => {
            const anchor = editing ? activeHit : probe
            return (
              <div className="pointer-events-none absolute inset-0">
                {comments.map((c) => {
                  const pos = pinPos[c.id]
                  const open = openThread === c.id
                  const replies = frameComments.filter((r) => r.parentId === c.id).reverse() // store is newest-first
                  const thread = [c, ...replies.sort((a, b) => a.at - b.at)]
                  const onReply = (text: string) =>
                    api.replyComment(c.id, text).then(() => posthog.capture('element_comment_replied'))
                  const onResolve = () => {
                    api
                      .resolveComment(c.id)
                      .then(() => posthog.capture('element_comment_resolved'))
                      .catch(console.error)
                    setOpenThread(null)
                  }
                  const onRetry = (id: string) => api.retryComment(id).catch(console.error)
                  /* An anchor that resolves to nothing has no position to draw
                     at. Rather than dropping the pin (and the conversation with
                     it), pin it to the frame's corner and say the element is
                     gone — the thread stays readable and resolvable. */
                  if (!pos) {
                    const anchor = pinAnchor[c.id]
                    if (anchor !== 'lost' && anchor !== 'ambiguous') return null
                    return (
                      <div key={c.id} className="pointer-events-auto absolute bottom-2 left-2 z-[4] max-w-[220px]">
                        <button
                          type="button"
                          className="w-full cursor-pointer truncate rounded-md border border-line bg-paper px-2 py-1 text-left text-[11.5px] text-ink-soft shadow-card"
                          title={`${c.from}: ${c.text} — the element this was pinned to no longer exists`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => {
                            setProbe(null)
                            setComposing(false)
                            setOpenThread(open ? null : c.id)
                          }}
                        >
                          {anchor === 'ambiguous' ? '⚠' : '⌫'} {c.text}
                        </button>
                        {open && (
                          <CommentThread
                            thread={thread}
                            canReply={canNote}
                            onReply={onReply}
                            onResolve={onResolve}
                            onRetry={onRetry}
                          />
                        )}
                      </div>
                    )
                  }
                  /* the pin reflects the newest agent request in the thread */
                  const agentItem = [...thread].reverse().find((x) => x.forAgent && !x.resolvedAt)
                  const working = agentItem?.claimedBy && !agentItem.failedAt
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'pointer-events-auto absolute z-[4] grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-[50%_50%_50%_4px] border-2 border-white text-[13px] text-white [transform:translate(-50%,-50%)_scale(min(calc(1/var(--zoom,1)),2.4))] animate-[chip-in_0.25s_ease]',
                        agentItem?.failedAt
                          ? 'bg-accent-ink! font-extrabold shadow-[0_0_0_3px_rgba(208,52,31,0.2),var(--shadow-card)]'
                          : 'shadow-card',
                        working &&
                          "after:absolute after:-inset-1.5 after:rounded-[inherit] after:border-2 after:border-current after:opacity-50 after:content-[''] after:[animation:stream-pulse_1.1s_ease-in-out_infinite]",
                      )}
                      style={{
                        left: Math.min(Math.max(pos.x, 10), frame.width - 10),
                        top: Math.min(Math.max(pos.y, 10), frame.height - 10),
                        background: colorFor(c.from),
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setProbe(null)
                        setComposing(false)
                        setOpenThread(open ? null : c.id)
                      }}
                      title={`${c.from}: ${c.text}${thread.length > 1 ? ` (${thread.length - 1} replies)` : ''}${
                        pinAnchor[c.id] === 'key' ? ' — the element moved; the pin followed it' : ''
                      }`}
                    >
                      {agentItem?.failedAt ? '!' : working ? '✦' : '💬'}
                      {open && (
                        <CommentThread
                          thread={thread}
                          canReply={canNote}
                          onReply={onReply}
                          onResolve={onResolve}
                          onRetry={onRetry}
                        />
                      )}
                    </div>
                  )
                })}

                {/* open agent questions: an agent is parked mid-task waiting
                on a human, so its pin stays up and takes the answer here —
                the Review tab link stays for the questions that offer choices */}
                {openQuestions.map((q) => {
                  const pos = q.selector ? pinPos[q.id] : QUESTION_PIN_POS
                  if (!pos) return null
                  const x = Math.min(Math.max(pos.x, 10), frame.width - 10)
                  const y = Math.min(Math.max(pos.y, 10), frame.height - 10)
                  return (
                    <div key={q.id}>
                      <div
                        className="pointer-events-auto absolute z-[5] grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-[50%_50%_50%_4px] border-2 border-white bg-accent-ink text-[13px] font-extrabold text-white [transform:translate(-50%,-50%)_scale(min(calc(1/var(--zoom,1)),2.4))] shadow-card animate-[chip-in_0.25s_ease]"
                        style={{ left: x, top: y }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!canNote) return
                          setAnswerDraft('')
                          setAnsweringId(answeringId === q.id ? null : q.id)
                        }}
                        title={`${q.agentName} asks: ${q.text}`}
                      >
                        ?
                      </div>
                      <div
                        className="pointer-events-auto absolute z-[5] flex flex-col items-start gap-1 [transform:translate(-12px,-50%)_scale(min(calc(1/var(--zoom,1)),2.4))]"
                        style={{ left: x, top: y - 20 }}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            className="max-w-[260px] gap-1.5 whitespace-nowrap rounded-full border-line bg-surface px-2.5 py-1 text-[10.5px] font-bold shadow-card hover:bg-surface"
                            title={`${q.agentName} asks: ${q.text}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              /* answering is a write the server takes only from
                                 someone with comment intent: a view-only guest
                                 reads the question and the Review tab link */
                              if (!canNote) return
                              setAnswerDraft('')
                              setAnsweringId(answeringId === q.id ? null : q.id)
                            }}
                          >
                            <span className="truncate">{q.text}</span>
                            {canNote && (
                              <span className="flex-none text-accent-ink">
                                {answeringId === q.id ? 'Cancel' : 'Answer'}
                              </span>
                            )}
                          </Button>
                          {/* the Review tab stays reachable: a question that
                              offered choices is answered there */}
                          <Button
                            variant="bare"
                            className="flex-none px-1 py-0 text-[10px] font-bold text-ink-faint hover:bg-transparent hover:text-ink"
                            title="Answer in the Review tab"
                            onClick={(e) => {
                              e.stopPropagation()
                              useStore.getState().requestPanel('review')
                            }}
                          >
                            Review →
                          </Button>
                        </div>
                        {answeringId === q.id && canNote && (
                          <div className="flex items-center gap-1">
                            <Input
                              inputSize="sm"
                              autoFocus
                              className="h-7 w-[190px] rounded-full border-line px-2.5 text-[11.5px] md:text-[11.5px]"
                              placeholder={`Answer ${q.agentName}…`}
                              value={answerDraft}
                              onChange={(e) => setAnswerDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') answerQuestion(q)
                                if (e.key === 'Escape') setAnsweringId(null)
                              }}
                            />
                            <Button
                              variant="primary"
                              size="sm"
                              className="h-7 flex-none rounded-full px-2.5 text-[11px]"
                              disabled={!answerDraft.trim() || answerBusy}
                              onClick={() => answerQuestion(q)}
                            >
                              Send
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}

                {anchor && selected && (
                  <div
                    className="pointer-events-auto absolute z-[7] origin-top-left [transform:scale(min(calc(1/var(--zoom,1)),2.4))_translateY(calc(-100%_-_8px))]"
                    style={{
                      left: Math.min(Math.max(anchor.rect.x, 4), Math.max(4, frame.width - 60)),
                      top: Math.max(anchor.rect.y, 2),
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    {!composing ? (
                      <>
                        <div className="flex items-center gap-1.5 whitespace-nowrap rounded-[10px] bg-ink px-[7px] py-[5px] shadow-pop animate-[chip-in_0.18s_ease]">
                          <span className="rounded-[5px] bg-white/[0.14] px-[5px] py-px text-[11px] font-bold text-white [font-family:ui-monospace,monospace]">
                            {anchor.tag}
                          </span>
                          {canNote && (
                            <>
                              <Button
                                variant="inverse"
                                className={EL_TOOLBAR_BTN}
                                onClick={() => {
                                  setComposePrefill('')
                                  setComposing(true)
                                }}
                              >
                                💬 Comment
                              </Button>
                              <Button
                                variant="inverse"
                                className={EL_TOOLBAR_BTN}
                                onClick={() => {
                                  /* pre-mentioned → the comment dispatches as an agent
                                 job scoped to this element's selector + snippet */
                                  setComposePrefill(`@${DEFAULT_ROLE_ID} `)
                                  setComposing(true)
                                }}
                              >
                                ✦ Ask AI
                              </Button>
                            </>
                          )}
                          <Button
                            variant="inverse"
                            className={EL_TOOLBAR_BTN}
                            onClick={() => (codeView === null ? requestCode(anchor.selector) : setCodeView(null))}
                          >
                            {'</>'} Code
                          </Button>
                          {!editing && canEdit && anchor.text !== '' && (
                            <Button
                              variant="inverse"
                              className={EL_TOOLBAR_BTN}
                              onClick={() => {
                                enterEdit()
                              }}
                            >
                              ✎ Edit text
                            </Button>
                          )}
                        </div>
                        {codeView !== null && <CodePanel key={anchor.selector} code={codeView} />}
                      </>
                    ) : (
                      <CommentComposer
                        initialText={composePrefill}
                        onSubmit={(text) => {
                          useStore
                            .getState()
                            .postElementComment(frame.id, {
                              selector: anchor.selector,
                              snippet: anchor.snippet,
                              text,
                              ...(anchor.key ? { stableKey: anchor.key } : {}),
                            })
                            .then(() => posthog.capture('element_comment_created'))
                            .catch(console.error)
                          if (editing) setComposing(false)
                          else closePopovers()
                        }}
                        onCancel={() => (editing ? setComposing(false) : closePopovers())}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          <div
            className={cn(
              'absolute -right-[7px] -bottom-[7px] h-3.5 w-3.5 cursor-nwse-resize rounded-[4px] border-[1.5px] border-ink bg-surface opacity-0 [transition:opacity_0.12s] group-hover:opacity-100',
              selected && 'opacity-100',
            )}
            onPointerDown={(e) => startDrag(e, 'resize')}
          />
        </div>
      </ContextMenuTrigger>
      <FrameContextMenu frame={frame} at={menuAt} />
    </ContextMenu>
  )
})

function CommentComposer({
  onSubmit,
  onCancel,
  initialText = '',
}: {
  onSubmit: (text: string) => void
  onCancel: () => void
  initialText?: string
}) {
  const [text, setText] = useState(initialText)
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => taRef.current?.focus(), [])
  const send = () => text.trim() && onSubmit(text)
  /* @mention a role in the comment, or a connected agent by name, to route it
     to that role; without one the comment is a note for the humans in the
     room. Agents connected over MCP are addressable by name too, so the pills
     list them beside the roles — derived from the stable presences map, as
     everywhere else here. */
  const mentioned = mentionedRole(text)
  const presences = useStore((s) => s.presences)
  const outside = Object.values(presences)
    .filter((p) => p.kind === 'agent' && !roleByAgentName(p.name))
    .map((p) => p.name)
  const mentionedOutside = mentioned ? undefined : mentionedAgent(text, outside)
  return (
    <div className="w-[240px] rounded-[10px] border border-line bg-surface p-2 shadow-pop animate-[chip-in_0.18s_ease]">
      <Textarea
        ref={taRef}
        variant="bare"
        className="min-h-[58px] md:text-[13px]"
        value={text}
        placeholder="Leave a comment on this element…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          if (e.key === 'Escape') onCancel()
        }}
      />
      {!mentioned && !mentionedOutside && (
        <div className="mb-2 flex flex-wrap gap-1">
          {AGENT_ROLES.map((role) => (
            <Button
              key={role.id}
              variant="ghost"
              size="pill"
              className="border-dashed px-2 text-[11px] font-semibold text-ink-soft hover:border-brand hover:bg-transparent hover:text-brand"
              title={`${role.name} — ${role.blurb}`}
              onClick={() => setText((t) => (t ? t.replace(/\s*$/, ' ') : '') + `@${role.id} `)}
            >
              <RoleMark role={role} size={13} /> @{role.id}
            </Button>
          ))}
          {outside.map((name) => (
            <Button
              key={name}
              variant="ghost"
              size="pill"
              className="border-dashed px-2 text-[11px] font-semibold text-ink-soft hover:border-brand hover:bg-transparent hover:text-brand"
              title={`${name} — connected over MCP`}
              onClick={() => setText((t) => (t ? t.replace(/\s*$/, ' ') : '') + `@${name} `)}
            >
              @{name}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {mentioned ? (
          <span className="mr-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            <RoleMark role={mentioned} size={13} />
            {mentioned.name} will pick this up
          </span>
        ) : mentionedOutside ? (
          <span className="mr-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand">
            {mentionedOutside} will pick this up
          </span>
        ) : null}
        <Button variant="solid" size="pill" className="px-3.5 py-[5px] text-xs" disabled={!text.trim()} onClick={send}>
          Post
        </Button>
      </div>
    </div>
  )
}

/** Where an @agent request in the thread stands, or null for a human note. */
function agentStatus(c: ElementComment): string | null {
  const target = c.targetAgent ?? roleName(DEFAULT_ROLE_ID)
  if (c.failedAt) return `${target} stopped`
  if (c.resolvedAt) return c.forAgent ? `✓ ${c.resolvedBy ?? target}` : null
  if (c.claimedBy) return `✦ ${c.claimedBy} is on it`
  return c.forAgent ? `✦ waiting for ${target}` : null
}

function CommentThread({
  thread,
  canReply,
  onReply,
  onResolve,
  onRetry,
}: {
  /** root comment first, then its replies oldest → newest */
  thread: ElementComment[]
  /** false for a view-only guest: the thread stays readable, but replying,
   *  resolving and retrying are all writes the server will not take from them */
  canReply: boolean
  /** rejects when the reply did not land — the draft is kept for a retry */
  onReply: (text: string) => Promise<unknown>
  onResolve: () => void
  onRetry: (commentId: string) => void
}) {
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  /* a long conversation opens (and grows) scrolled to its newest message */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [thread.length])
  const send = () => {
    if (!reply.trim() || sending) return
    const submitted = reply
    setSending(true)
    setFailed(false)
    onReply(submitted)
      /* only clear what was sent — text typed meanwhile is a new draft */
      .then(() => setReply((current) => (current === submitted ? '' : current)))
      .catch(() => setFailed(true))
      .finally(() => setSending(false))
  }
  /* the same resolution the server does on submit: a role in the comment, or a
     connected agent's own name — a reply to either is a request to it */
  const mentioned = mentionedRole(reply)
  const presences = useStore((s) => s.presences)
  const mentionedOutside = mentioned
    ? undefined
    : mentionedAgent(
        reply,
        Object.values(presences)
          .filter((p) => p.kind === 'agent' && !roleByAgentName(p.name))
          .map((p) => p.name),
      )
  return (
    <div
      className="absolute top-[calc(100%_+_8px)] left-1/2 w-[250px] -translate-x-1/2 cursor-default rounded-[10px] border border-line bg-surface p-2.5 text-left shadow-pop animate-[chip-in_0.18s_ease]"
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={listRef} className="-mx-1 max-h-[240px] overflow-y-auto px-1">
        {thread.map((c, i) => {
          const status = agentStatus(c)
          return (
            <div key={c.id} className={cn(i > 0 && 'mt-2 border-t border-line-soft pt-2')}>
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <b style={{ color: colorFor(c.from) }}>{c.from}</b>
                {c.fromKind === 'agent' && (
                  <span className="rounded-full border border-current px-[6px] font-mono text-[9px] uppercase tracking-[0.08em] text-accent-ink">
                    agent
                  </span>
                )}
                {status && <span className="whitespace-nowrap text-[11px] font-semibold text-brand">{status}</span>}
              </div>
              <div className="mt-1 break-words text-[13px] leading-[1.45] text-ink">{c.text}</div>
              {c.failedAt ? (
                <div className="mt-1 flex items-center gap-2 text-[11px] leading-[1.4] text-accent-ink">
                  <span>{c.failureReason ?? 'The agent did not finish.'}</span>
                  {canReply && (
                    <Button
                      variant="danger-solid"
                      size="pill"
                      className="shrink-0 px-[9px] py-[3px] text-[11px]"
                      onClick={() => onRetry(c.id)}
                    >
                      ↻ Retry
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {canReply && (
        <>
          <Textarea
            variant="bare"
            className="mt-2 min-h-[38px] md:text-[13px]"
            value={reply}
            placeholder="Reply… (@doop to ask the agent)"
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
            }}
          />
          {failed && (
            <div className="mt-1 text-[11px] leading-[1.4] text-accent-ink">
              That reply did not go through — it may be resolved already. Try again.
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="pill"
              className="px-2.5 text-ink-soft hover:border-ink-soft hover:bg-transparent hover:text-ink"
              onClick={onResolve}
            >
              ✓ Resolve
            </Button>
            {mentioned && (
              <span
                className="ml-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-brand"
                title={`${mentioned.name} will pick this up`}
              >
                <RoleMark role={mentioned} size={13} />
                <span className="truncate">{mentioned.name}</span>
              </span>
            )}
            {mentionedOutside && (
              <span
                className="ml-auto inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-brand"
                title={`${mentionedOutside} will pick this up`}
              >
                <span className="truncate">{mentionedOutside}</span>
              </span>
            )}
            <Button
              variant="solid"
              size="pill"
              className={cn('px-3 py-[4px] text-xs', !mentioned && 'ml-auto')}
              disabled={!reply.trim() || sending}
              onClick={send}
            >
              {sending ? 'Posting…' : 'Reply'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
