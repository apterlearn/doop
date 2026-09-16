import { useEffect, useMemo, useRef, useState } from 'react'
import type { Frame, FrameVersion } from '../../shared/types'
import { isReadOnly, useStore } from '../lib/store'
import { api } from '../lib/api'
import { moveFrameInStack, type ZDir } from '../lib/frameOrder'
import { MOD_KEY } from '../lib/keys'
import { caughtStaleWrite, deleteFrameTracked, noteOwnWrite, recordUpdate } from '../lib/history'
import { timeAgo } from '../lib/time'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { cn } from '@/lib/utils'
import { Panel, PanelClose, PanelDisclosure, PanelHeader } from './ui/panel'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Field } from './ui/field'
import { Textarea } from './ui/textarea'
import { ConfirmDialog } from './ui/alert-dialog'
import { Toast } from './ui/toast'
import { ListItem, ListMeta, ListTitle } from './ui/list'
import { LockIcon } from './ui/icons'

const HTML_OPEN_KEY = 'doop:inspector-html'

/* the export row's buttons: the standard button, tightened, and tall enough
   to hit on a phone */
const exportBtn = 'px-[11px] py-[5px] text-xs no-underline max-md:min-h-9'

/* the four stacking buttons: the grid stretches them to equal widths, at the
   History row's chip size */
const arrangeBtn = 'px-0 py-[4px] text-[11.5px]'

export function Inspector({
  frame,
  surface = 'floating',
  className,
}: {
  frame: Frame
  /* 'inline' when the inspector is filling a mobile Sheet */
  surface?: 'floating' | 'inline'
  className?: string
}) {
  const select = useStore((s) => s.select)
  /* an agent editing the frame holds its lock: the human watches, or takes over */
  const lock = useStore((s) => s.frameLocks[frame.id])
  /* a share-link visitor (or an admin's borrowed session) may look at every
     value here and change none of them */
  const readOnly = useStore(isReadOnly)
  const canvas = useStore((s) => s.canvas)
  /* the stacking buttons read the frame's own page — a frame keeps its page
     whichever tab is open — and frontmost means the highest z there. A frame
     alone on its page has nowhere to go, so every button reads as reached. */
  const { frontmost, backmost, alone } = useMemo(() => {
    const page = canvas?.frames.filter((f) => f.pageId === frame.pageId) ?? []
    if (page.length < 2) return { frontmost: true, backmost: true, alone: true }
    let front = -Infinity
    let back = Infinity
    for (const f of page) {
      if (f.z > front) front = f.z
      if (f.z < back) back = f.z
    }
    return { frontmost: frame.z >= front, backmost: frame.z <= back, alone: false }
  }, [canvas, frame.pageId, frame.z])
  /* the raw HTML editor is a power tool — collapsed by default so the panel
     reads as frame properties, not a code dump; the choice sticks */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showHtml, setShowHtml] = useState(() => localStorage.getItem(HTML_OPEN_KEY) === '1')
  const [draft, setDraft] = useState(frame.html)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saved' | 'error'>('idle')
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [creating, setCreating] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<number | null>(null)
  const frameId = useRef(frame.id)

  /* switching frames resets the draft; otherwise pull in remote html
     updates unless the user is typing */
  useEffect(() => {
    const switched = frameId.current !== frame.id
    frameId.current = frame.id
    const typing = document.activeElement === textareaRef.current
    if (switched || (!typing && frame.html !== draft)) {
      setDraft(frame.html)
      setSaveState('idle')
    }
  }, [frame.id, frame.html, draft])

  /* a locked frame's content is read-only here, the same refusal the server
     makes: the switches below stay live so it can be unlocked again. A
     read-only visitor's frames are all that way, and for them there is nothing
     to unlock — the canvas belongs to someone else. */
  const contentLocked = frame.locked || readOnly

  function onHtmlChange(value: string) {
    setDraft(value)
    setSaveState('dirty')
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const current = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)
      /* a frame locked since the keystroke keeps its html: the server refuses
         the write anyway, and a refused write must not read as saved. A
         read-only visitor never reaches this (the field is disabled); the
         check is the same refusal said twice. */
      if (!current || current.locked || readOnly) return
      recordUpdate(frame.id, { html: current.html }, { html: value })
      /* The document this draft was typed into is the version the write
         preconditions on: an agent that streamed into the frame in the
         meantime wins, and the editor repaints its html rather than save over
         a design that is no longer there. A rejected write must not read as
         saved: the debounce re-arms on the next keystroke, so a transient
         failure heals itself. */
      await api
        .updateFrame(frame.id, { html: value }, { expectedUpdatedAt: current.updatedAt })
        .then((saved) => {
          noteOwnWrite(saved)
          setSaveState('saved')
        })
        .catch((err: unknown) => {
          const conflict = caughtStaleWrite(err)
          setSaveState('error')
          if (conflict) showToast(conflict.error)
        })
      window.setTimeout(() => setSaveState((s) => (s === 'saved' || s === 'error' ? 'idle' : s)), 1500)
    }, 700)
  }

  function commitMeta(patch: Partial<Frame>) {
    if (contentLocked) return
    recordUpdate(frame.id, frame, patch)
    useStore.getState().patchFrameLocal(frame.id, patch)
    /* the field was committed against the frame as this panel renders it, so
       that is the version the write preconditions on — a frame somebody else
       changed since refuses the value rather than overwrite their change, and
       the fields repaint from the server's copy */
    api
      .updateFrame(frame.id, patch, { expectedUpdatedAt: frame.updatedAt })
      .then(noteOwnWrite)
      .catch((err: unknown) => {
        const conflict = caughtStaleWrite(err)
        if (conflict) showToast(conflict.error)
      })
  }

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 2400)
  }

  /** This frame's markup as a library entry — its html and its size, exactly
   *  as they stand. `variantOf` derives it from the component the frame
   *  instances, keeping the family together in the library; without it the
   *  frame becomes a component of its own. The frame is untouched either way:
   *  a definition is not linked back to the frame it was cut from. */
  function createComponent(variantOf?: string) {
    if (creating || contentLocked) return
    setCreating(true)
    api
      .createComponent(frame.canvasId, {
        name: frame.name,
        html: frame.html,
        width: frame.width,
        height: frame.height,
        ...(variantOf ? { variantOf } : {}),
      })
      .then(() => showToast(variantOf ? `Saved “${frame.name}” as a variant` : `“${frame.name}” is now a component`))
      .catch((err: unknown) => {
        console.error(err)
        showToast('Couldn’t save the component')
      })
      .finally(() => setCreating(false))
  }

  /* restacking is the shared frame-order module's job: it owns the write, the
     page's fresh z, the undo entry for the move, and its own error logging.
     A frame that may not be written does not get there. */
  function arrange(dir: ZDir) {
    if (contentLocked) return
    void moveFrameInStack(frame, dir)
  }

  /* the component this frame is an instance of, when it is one: the wrapper
     attribute every instance carries, and the only thing a variant can be a
     variation on */
  const instanceOf = frame.html.match(/data-doop-component="([^"]+)"/)?.[1]

  return (
    <>
      <Panel
        surface={surface}
        className={cn(
          surface === 'floating' && 'right-3 top-3 max-h-[calc(100%-24px)] w-[340px] transition-[right] duration-150',
          'max-md:overflow-y-auto max-md:overscroll-contain',
          className,
        )}
      >
        <PanelHeader>
          Frame
          <PanelClose onClick={() => select(null)} />
        </PanelHeader>
        <div className="grid grid-cols-2 gap-2.5 border-b border-line-soft px-4 py-3.5">
          <Field label="Name" className="col-span-full">
            <NumberlessInput
              key={frame.id}
              value={frame.name}
              disabled={contentLocked}
              onCommit={(v) => v.trim() && commitMeta({ name: v.trim() })}
            />
          </Field>
          <Field label="X">
            <NumInput value={frame.x} disabled={contentLocked} onCommit={(v) => commitMeta({ x: v })} />
          </Field>
          <Field label="Y">
            <NumInput value={frame.y} disabled={contentLocked} onCommit={(v) => commitMeta({ y: v })} />
          </Field>
          <Field label="Width">
            <NumInput
              value={frame.width}
              disabled={contentLocked}
              onCommit={(v) => commitMeta({ width: Math.max(120, v) })}
            />
          </Field>
          <Field label="Height">
            <NumInput
              value={frame.height}
              disabled={contentLocked}
              onCommit={(v) => commitMeta({ height: Math.max(80, v) })}
            />
          </Field>
        </div>
        {contentLocked && (
          <div className="flex items-center gap-2 border-b border-line-soft bg-paper px-3.5 py-2.5 text-[12px] text-ink-soft">
            <LockIcon width={13} height={13} className="flex-none text-ink-faint" />
            <span className="leading-[1.4]">
              {readOnly ? 'Read only — sign in to edit this canvas' : 'Locked — unlock to edit'}
            </span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2.5 border-b border-line-soft px-4 py-3.5">
          <Field label="Arrange" className="col-span-full">
            <div className="grid grid-cols-4 gap-1.5">
              <Button
                className={arrangeBtn}
                disabled={contentLocked || frontmost}
                title={`Bring to front (${MOD_KEY}⇧])`}
                onClick={() => arrange('front')}
              >
                Front
              </Button>
              <Button
                className={arrangeBtn}
                disabled={contentLocked || alone}
                title={`Forward (${MOD_KEY}])`}
                onClick={() => arrange('forward')}
              >
                Forward
              </Button>
              <Button
                className={arrangeBtn}
                disabled={contentLocked || alone}
                title={`Backward (${MOD_KEY}[)`}
                onClick={() => arrange('backward')}
              >
                Backward
              </Button>
              <Button
                className={arrangeBtn}
                disabled={contentLocked || backmost}
                title={`Send to back (${MOD_KEY}⇧[)`}
                onClick={() => arrange('back')}
              >
                Back
              </Button>
            </div>
          </Field>
          <Field label="Rotation">
            <NumInput
              value={frame.rotation}
              min={-360}
              max={360}
              disabled={contentLocked}
              onCommit={(v) => commitMeta({ rotation: v })}
            />
          </Field>
          <Field label="Opacity">
            <OpacityInput value={frame.opacity} disabled={contentLocked} onCommit={(v) => commitMeta({ opacity: v })} />
          </Field>
          <label className="relative col-span-full flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink">
            <Checkbox
              checked={frame.locked}
              disabled={readOnly}
              onChange={(e) => commitMeta({ locked: e.target.checked })}
            />
            Locked — blocks edits to this frame
          </label>
          <label className="relative col-span-full flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink">
            <Checkbox
              checked={frame.hidden}
              disabled={readOnly}
              onChange={(e) => commitMeta({ hidden: e.target.checked })}
            />
            Hidden — keeps its row in Layers, off the stage
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
          <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Export</span>
          <Button asChild className={exportBtn} title="Download as PNG (2×)">
            <a href={`/i/${frame.id}.png?scale=2&download`}>PNG</a>
          </Button>
          <Button asChild className={exportBtn} title="Download as JPG (2×)">
            <a href={`/i/${frame.id}.jpg?scale=2&download`}>JPG</a>
          </Button>
          <Button
            className={exportBtn}
            disabled={contentLocked}
            title="Add to design memory — will be used as reference"
            onClick={() => api.pinReference(frame.canvasId, frame.id).catch(console.error)}
          >
            ☆ Pin
          </Button>
          <Button
            className={exportBtn}
            title="Public image URL — always renders the current design; paste it as og:image or a blog featured image"
            onClick={() => {
              navigator.clipboard.writeText(`${location.origin}/i/${frame.id}.png?scale=2`).then(() => {
                setCopiedUrl(true)
                window.setTimeout(() => setCopiedUrl(false), 1500)
              }, console.error)
            }}
          >
            {copiedUrl ? '✓ copied' : 'Copy image URL'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2.5">
          <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Component</span>
          <Button
            className={exportBtn}
            disabled={creating || contentLocked}
            title="Save this frame's markup to the canvas's component library, so agents and the Components tab can instance it"
            onClick={() => createComponent()}
          >
            {creating ? 'Saving…' : 'Create component'}
          </Button>
          {instanceOf && (
            <Button
              className={exportBtn}
              disabled={creating || contentLocked}
              title="Save this frame as a variation of the component it instances"
              onClick={() => createComponent(instanceOf)}
            >
              Save as variant
            </Button>
          )}
        </div>
        {lock && (
          <div className="flex items-center gap-2.5 border-b border-line-soft bg-paper px-3.5 py-2.5 text-[12px] text-ink-soft">
            <span className="size-2 flex-none rounded-full" style={{ background: lock.color }} />
            <span className="min-w-0 flex-1 leading-[1.4]">
              Held by <b className="font-semibold text-ink">{lock.name}</b> — the HTML editor is paused while it works.
            </span>
            <Button
              size="sm"
              className="flex-none text-[11.5px]"
              disabled={readOnly}
              onClick={() => api.unlockFrame(frame.id).catch(console.error)}
            >
              Take over
            </Button>
          </div>
        )}
        <Collapsible
          className="flex min-h-0 flex-col"
          open={showHtml}
          onOpenChange={(next) => {
            setShowHtml(next)
            localStorage.setItem(HTML_OPEN_KEY, next ? '1' : '0')
          }}
        >
          <PanelDisclosure>
            <span>{'</>'} HTML</span>
          </PanelDisclosure>
          <CollapsibleContent className="flex min-h-0 flex-col">
            <Textarea
              ref={textareaRef}
              variant="bare"
              className="h-[320px] flex-none bg-[#17171b] p-3.5 font-mono text-xs leading-[1.55] text-[#e9e9ee] [tab-size:2] max-md:h-auto max-md:min-h-[160px] max-md:flex-1 md:text-xs"
              value={draft}
              spellCheck={false}
              placeholder="<!doctype html>…"
              disabled={!!lock || contentLocked}
              onChange={(e) => onHtmlChange(e.target.value)}
            />
          </CollapsibleContent>
        </Collapsible>
        <Collapsible className="flex min-h-0 flex-col" open={historyOpen} onOpenChange={setHistoryOpen}>
          <PanelDisclosure>
            <span>History</span>
          </PanelDisclosure>
          <CollapsibleContent className="flex min-h-0 flex-col">
            <HistoryList frame={frame} readOnly={readOnly} />
          </CollapsibleContent>
        </Collapsible>
        <footer className="flex items-center justify-between border-t border-line-soft px-4 py-2.5">
          <span className="font-mono text-[11px] text-ink-faint">
            {saveState === 'dirty'
              ? 'saving…'
              : saveState === 'saved'
                ? 'saved ✓'
                : saveState === 'error'
                  ? 'couldn’t save — check your connection'
                  : `last edit by ${frame.updatedBy}`}
          </span>
          {!readOnly && (
            <Button variant="bare-danger" size="sm" onClick={() => deleteFrameTracked(frame)}>
              Delete frame
            </Button>
          )}
        </footer>
      </Panel>
      {/* outside the panel: the toast is fixed over the app, and the
          panel scrolls */}
      {toast && <Toast>{toast}</Toast>}
    </>
  )
}

function NumberlessInput({
  value,
  disabled,
  onCommit,
}: {
  value: string
  disabled?: boolean
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  /* a committed or remote value replaces whatever was being typed */
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return (
    <Input
      variant="mono"
      inputSize="sm"
      className="font-sans font-semibold max-md:min-h-10"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumInput({
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  value: number
  /* the range the field is willing to commit; a rotated frame stops at ±360 */
  min?: number
  max?: number
  disabled?: boolean
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(String(value))
  }
  return (
    <Input
      variant="mono"
      inputSize="sm"
      className="max-md:min-h-10"
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const raw = draft.trim()
        /* an emptied field goes back to what the frame has, rather than
           rounding to 0 and then clamping 0 into the range */
        if (raw === '' || Number.isNaN(Number(raw))) {
          setDraft(String(value))
          return
        }
        let n = Math.round(Number(raw))
        if (min !== undefined) n = Math.max(min, n)
        if (max !== undefined) n = Math.min(max, n)
        if (n !== value) onCommit(n)
        else setDraft(String(value))
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** Opacity as the rail speaks it: a 0–100 slider over a 0..1 frame value. The
 *  slider moves per pixel while the commit waits for the handle to settle, so
 *  one drag is one save (and one undo entry, since they coalesce anyway). */
function OpacityInput({
  value,
  disabled,
  onCommit,
}: {
  value: number
  disabled?: boolean
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(Math.round(value * 100))
  const [seen, setSeen] = useState(value)
  const timer = useRef<number | null>(null)
  /* the gesture still in flight, so a panel closed mid-drag still saves */
  const pending = useRef<{ value: number; commit: (v: number) => void } | null>(null)
  if (seen !== value) {
    setSeen(value)
    setDraft(Math.round(value * 100))
  }
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
      const inflight = pending.current
      if (inflight) inflight.commit(inflight.value)
    },
    [],
  )
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      <input
        type="range"
        min={0}
        max={100}
        aria-label="Opacity"
        disabled={disabled}
        className="h-6 min-w-0 flex-1 accent-ink"
        value={draft}
        onChange={(e) => {
          if (disabled) return
          const percent = Number(e.target.value)
          setDraft(percent)
          pending.current = { value: percent / 100, commit: onCommit }
          if (timer.current) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => {
            const inflight = pending.current
            pending.current = null
            if (inflight) inflight.commit(inflight.value)
          }, 200)
        }}
      />
      <span className="w-9 flex-none text-right font-mono text-[11px] text-ink-soft">{draft}%</span>
    </div>
  )
}

const versionBtn = 'px-[9px] py-[4px] text-[11.5px]'

function formatBytes(chars: number): string {
  if (chars < 1024) return `${chars} B`
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} kB`
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`
}

/** The frame's saved versions: who wrote them, when, how big, and what you
   can do with each — peek at it, diff it against now, or go back to it.
   Reverting is itself an update, so the revert shows up as a newer version.
   A read-only visitor still gets the peek and the diff; going back is a
   write, and the button is not offered. */
function HistoryList({ frame, readOnly = false }: { frame: Frame; readOnly?: boolean }) {
  const versions = useStore((s) => s.frameVersions[frame.id])
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ versionId: string; png: string; ratio: number } | null>(null)
  const [revertId, setRevertId] = useState<string | null>(null)
  const previewed = versions?.find((v) => v.id === previewId)
  const previewUrl = useHtmlPreview(previewed?.html, previewed?.width ?? frame.width, previewed?.height ?? frame.height)

  useEffect(() => {
    void api
      .frameVersions(frame.id)
      .then((list) => useStore.getState().setFrameVersions(frame.id, list))
      .catch(console.error)
    /* refetch after an edit or a revert so a new version shows up */
  }, [frame.id, frame.updatedAt])

  function showDiff(version: FrameVersion) {
    api
      .frameDiff(frame.id, version.id)
      .then((r) => setDiff({ versionId: version.id, png: r.png, ratio: r.changed_ratio }))
      .catch(console.error)
  }

  function revert() {
    if (!revertId) return
    const versionId = revertId
    setRevertId(null)
    recordUpdate(frame.id, frame, { html: frame.html })
    api.revertFrame(frame.id, versionId).catch(console.error)
  }

  return (
    <div className="flex min-h-0 flex-col">
      {versions === undefined ? (
        <div className="px-4 py-3 text-[12px] text-ink-faint">Loading versions…</div>
      ) : versions.length === 0 ? (
        <div className="px-4 py-3 text-[12px] text-ink-faint">
          No saved versions yet. Every edit an agent makes is kept here, so you can compare or go back.
        </div>
      ) : (
        versions.map((v) => (
          <ListItem key={v.id} className="gap-1.5 py-2.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <ListTitle className="min-w-0 flex-1 truncate">{v.savedBy}</ListTitle>
              <ListMeta className="flex-none">{timeAgo(v.savedAt)}</ListMeta>
              <ListMeta className="flex-none font-mono">{formatBytes(v.html.length)}</ListMeta>
            </span>
            <span className="mt-0.5 flex flex-wrap gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className={versionBtn}
                onClick={() => setPreviewId(previewId === v.id ? null : v.id)}
              >
                Preview
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={versionBtn}
                onClick={() => (diff?.versionId === v.id ? setDiff(null) : showDiff(v))}
              >
                Diff
              </Button>
              {!readOnly && (
                <Button variant="ghost" size="sm" className={versionBtn} onClick={() => setRevertId(v.id)}>
                  Revert
                </Button>
              )}
            </span>
            {previewId === v.id &&
              (previewUrl ? (
                <img
                  src={previewUrl}
                  alt={`Preview of the version from ${timeAgo(v.savedAt)}`}
                  className="w-full rounded-[8px] border border-line bg-white"
                />
              ) : (
                <ListMeta>rendering…</ListMeta>
              ))}
            {diff?.versionId === v.id && (
              <span className="mt-1 block">
                <img
                  src={diff.png}
                  alt={`Difference against the version from ${timeAgo(v.savedAt)}`}
                  className="w-full rounded-[8px] border border-line bg-white"
                />
                <ListMeta>
                  {(diff.ratio * 100).toFixed(diff.ratio > 0 && diff.ratio < 0.01 ? 2 : 1)}% of pixels changed (magenta)
                </ListMeta>
              </span>
            )}
          </ListItem>
        ))
      )}
      <ConfirmDialog
        open={revertId !== null}
        onOpenChange={(open) => !open && setRevertId(null)}
        title="Revert this frame?"
        description="The frame goes back to the version you picked. The revert itself is saved as a newer version, so this is undoable from the same list."
        confirmLabel="Revert"
        onConfirm={revert}
      />
    </div>
  )
}
