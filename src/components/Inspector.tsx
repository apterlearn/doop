import { useEffect, useRef, useState } from 'react'
import type { Frame, FrameVersion } from '../../shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { deleteFrameTracked, recordUpdate } from '../lib/history'
import { timeAgo } from '../lib/time'
import { useHtmlPreview } from '../lib/useHtmlPreview'
import { cn } from '@/lib/utils'
import { Panel, PanelClose, PanelDisclosure, PanelHeader } from './ui/panel'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Field } from './ui/field'
import { Textarea } from './ui/textarea'
import { ConfirmDialog } from './ui/alert-dialog'
import { ListItem, ListMeta, ListTitle } from './ui/list'

const HTML_OPEN_KEY = 'doop:inspector-html'

/* the export row's buttons: the standard button, tightened, and tall enough
   to hit on a phone */
const exportBtn = 'px-[11px] py-[5px] text-xs no-underline max-md:min-h-9'

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
  /* the raw HTML editor is a power tool — collapsed by default so the panel
     reads as frame properties, not a code dump; the choice sticks */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showHtml, setShowHtml] = useState(() => localStorage.getItem(HTML_OPEN_KEY) === '1')
  const [draft, setDraft] = useState(frame.html)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saved' | 'error'>('idle')
  const [copiedUrl, setCopiedUrl] = useState(false)
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

  function onHtmlChange(value: string) {
    setDraft(value)
    setSaveState('dirty')
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(async () => {
      const before = useStore.getState().canvas?.frames.find((f) => f.id === frame.id)?.html
      if (before !== undefined) recordUpdate(frame.id, { html: before }, { html: value })
      /* a rejected write must not read as saved: the debounce re-arms on the
         next keystroke, so a transient failure heals itself */
      await api
        .updateFrame(frame.id, { html: value })
        .then(() => setSaveState('saved'))
        .catch((err) => {
          console.error(err)
          setSaveState('error')
        })
      window.setTimeout(() => setSaveState((s) => (s === 'saved' || s === 'error' ? 'idle' : s)), 1500)
    }, 700)
  }

  function commitMeta(patch: Partial<Frame>) {
    recordUpdate(frame.id, frame, patch)
    useStore.getState().patchFrameLocal(frame.id, patch)
    api.updateFrame(frame.id, patch).catch(console.error)
  }

  return (
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
            onCommit={(v) => v.trim() && commitMeta({ name: v.trim() })}
          />
        </Field>
        <Field label="X">
          <NumInput value={frame.x} onCommit={(v) => commitMeta({ x: v })} />
        </Field>
        <Field label="Y">
          <NumInput value={frame.y} onCommit={(v) => commitMeta({ y: v })} />
        </Field>
        <Field label="Width">
          <NumInput value={frame.width} onCommit={(v) => commitMeta({ width: Math.max(120, v) })} />
        </Field>
        <Field label="Height">
          <NumInput value={frame.height} onCommit={(v) => commitMeta({ height: Math.max(80, v) })} />
        </Field>
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
      {lock && (
        <div className="flex items-center gap-2.5 border-b border-line-soft bg-paper px-3.5 py-2.5 text-[12px] text-ink-soft">
          <span className="size-2 flex-none rounded-full" style={{ background: lock.color }} />
          <span className="min-w-0 flex-1 leading-[1.4]">
            Held by <b className="font-semibold text-ink">{lock.name}</b> — the HTML editor is paused while it works.
          </span>
          <Button
            size="sm"
            className="flex-none text-[11.5px]"
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
            disabled={!!lock}
            onChange={(e) => onHtmlChange(e.target.value)}
          />
        </CollapsibleContent>
      </Collapsible>
      <Collapsible className="flex min-h-0 flex-col" open={historyOpen} onOpenChange={setHistoryOpen}>
        <PanelDisclosure>
          <span>History</span>
        </PanelDisclosure>
        <CollapsibleContent className="flex min-h-0 flex-col">
          <HistoryList frame={frame} />
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
        <Button variant="bare-danger" size="sm" onClick={() => deleteFrameTracked(frame)}>
          Delete frame
        </Button>
      </footer>
    </Panel>
  )
}

function NumberlessInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
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
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function NumInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
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
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Math.round(Number(draft))
        if (!Number.isNaN(n) && n !== value) onCommit(n)
        else setDraft(String(value))
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
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
   Reverting is itself an update, so the revert shows up as a newer version. */
function HistoryList({ frame }: { frame: Frame }) {
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
              <Button variant="ghost" size="sm" className={versionBtn} onClick={() => setRevertId(v.id)}>
                Revert
              </Button>
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
