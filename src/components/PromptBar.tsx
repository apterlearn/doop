import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { cn } from '../lib/utils'
import { posthog } from '../lib/posthog'
import { uploadImageFrames } from '../lib/frameClipboard'
import { AGENT_ROLES, DEFAULT_ROLE_ID, PIPELINE_PRESETS, roleById, roleName } from '../../shared/agents'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Note } from './ui/note'
import { DoopMark } from './Logo'
import { RoleMark } from './RoleMark'

/**
 * The canvas's front door to the board: a prompt bar that queues a card
 * without anyone having to discover the board first. A connected MCP agent
 * claims the card from there.
 *
 * Screenshots and images attach via the paperclip (or a paste into the
 * input); on send they land on the canvas as reference frames and the card
 * carries their ids so the agent looks at them before designing.
 *
 * The bar also names the card's pipeline — who works on it and in what order
 * — so a prompt can be addressed to the Copywriter or the Accessibility pass
 * without a detour through the board.
 */

const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // mirrors the server's asset cap

/** How long after a submit a newly created frame still gets the camera. */
const FLY_WINDOW_MS = 3 * 60_000

function openFlyWindow(extraKnown: string[] = []): { known: Set<string>; until: number } {
  return {
    known: new Set([...(useStore.getState().canvas?.frames ?? []).map((f) => f.id), ...extraKnown]),
    until: Date.now() + FLY_WINDOW_MS,
  }
}

interface Attachment {
  file: File
  /** object URL for the thumbnail, revoked on removal/submit */
  preview: string
}

export function PromptBar({ canvasId }: { canvasId: string }) {
  const frames = useStore((s) => s.canvas?.frames)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  /* the frame named in the "on it" note — captured at submit, so dismissing
     the target chip afterwards does not rewrite what was just confirmed */
  const [sentTarget, setSentTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /* the card's pipeline: who works on it, in click order. Never empty — a
     card always names someone, so the default comes back when the last role
     is dropped. */
  const [agents, setAgents] = useState<string[]>([DEFAULT_ROLE_ID])
  const [pickerOpen, setPickerOpen] = useState(false)
  /* what the card is about: the frame (and element) selected on the canvas.
     Dismissible per selection, so "design something new" stays one ✕ away. */
  const selectedId = useStore((s) => s.selectedId)
  const selectedElement = useStore((s) => s.selectedElement)
  const targetFrame = useStore((s) => s.canvas?.frames.find((f) => f.id === s.selectedId))
  const [targetDismissed, setTargetDismissed] = useState(false)
  const selectionKey = `${selectedId ?? ''}|${selectedElement?.selector ?? ''}`
  const [lastSelectionKey, setLastSelectionKey] = useState(selectionKey)
  if (selectionKey !== lastSelectionKey) {
    setLastSelectionKey(selectionKey)
    setTargetDismissed(false)
  }
  const target = targetDismissed ? undefined : targetFrame
  const inputRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const barRef = useRef<HTMLFormElement>(null)

  /* after a submit, the first frame that wasn't on the canvas before gets a
     camera flight — the deliverable must stream in on-screen, never somewhere
     off-canvas the user has to go find */
  const awaiting = useRef<{ known: Set<string>; until: number } | null>(null)
  useEffect(() => {
    const a = awaiting.current
    if (!a || !frames) return
    if (Date.now() > a.until) {
      awaiting.current = null
      return
    }
    const arrived = frames.find((f) => !a.known.has(f.id))
    if (arrived) {
      awaiting.current = null
      useStore.getState().requestFlyTo(arrived.id)
    }
  }, [frames])

  /* previews are object URLs — release whatever is still held on unmount
     (via a ref: an empty-deps cleanup would close over the first render) */
  const attachmentsRef = useRef(attachments)
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])
  useEffect(() => () => attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.preview)), [])

  /* the picker opens upward over the canvas, so a click anywhere else — or
     Escape — has to put it away again */
  useEffect(() => {
    if (!pickerOpen) return
    const away = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [pickerOpen])

  function showError(msg: string) {
    setError(msg)
    window.setTimeout(() => setError(null), 5000)
  }

  function addFiles(list: Iterable<File>) {
    const images = [...list].filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const oversize = images.find((f) => f.size > MAX_ATTACHMENT_BYTES)
    const fitting = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES)
    const room = MAX_ATTACHMENTS - attachments.length
    if (oversize) showError(`“${oversize.name}” exceeds the 5 MB limit`)
    else if (fitting.length > room) showError(`Up to ${MAX_ATTACHMENTS} images per request`)
    const ok = fitting.slice(0, Math.max(0, room))
    if (ok.length)
      setAttachments((cur) => [...cur, ...ok.map((file) => ({ file, preview: URL.createObjectURL(file) }))])
  }

  function removeAttachment(preview: string) {
    URL.revokeObjectURL(preview)
    setAttachments((cur) => cur.filter((a) => a.preview !== preview))
  }

  /* clicking a chip appends it to the pipeline, so click order = run order —
     the board's compose-box rule, with the last role staying put */
  function toggleAgent(id: string) {
    setAgents((prev) => {
      if (!prev.includes(id)) return [...prev, id]
      const rest = prev.filter((x) => x !== id)
      return rest.length > 0 ? rest : [DEFAULT_ROLE_ID]
    })
  }

  async function submit(prompt: string) {
    const clean = prompt.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      /* attachments first: each becomes a reference frame on the canvas, and
         the card carries the frame ids so the agent views them before
         designing. Known-ids include them so the camera saves its flight for
         the agent's deliverable, not the user's own screenshots. */
      const refFrames = await uploadImageFrames(
        canvasId,
        attachments.map((a) => a.file),
        'Attached image',
      )
      /* the target frame stays OUT of the attachments: attachments are
         described to the agent as source material it must not edit. The
         element selector and page ride along so "fix this element" arrives as
         an address, not a guess. */
      await api.addCard(
        canvasId,
        clean,
        agents,
        refFrames.map((f) => f.id),
        target ? [target.id] : undefined,
        target
          ? {
              ...(selectedElement?.frameId === target.id ? { selector: selectedElement.selector } : {}),
              ...(target.pageId ? { pageId: target.pageId } : {}),
            }
          : undefined,
      )
      posthog.capture('prompt_bar_submitted', { attachments: refFrames.length })
      awaiting.current = openFlyWindow(refFrames.map((f) => f.id))
      attachments.forEach((a) => URL.revokeObjectURL(a.preview))
      setAttachments([])
      setText('')
      /* the picker returns to the default with the input */
      setAgents([DEFAULT_ROLE_ID])
      setPickerOpen(false)
      setSentTarget(target?.name ?? null)
      setSent(true)
      window.setTimeout(() => setSent(false), 5000)
    } catch (err) {
      console.error(err)
      showError(err instanceof Error ? err.message : 'Something went wrong — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="absolute bottom-[68px] left-1/2 z-30 flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 max-md:bottom-[calc(76px+env(safe-area-inset-bottom))] max-md:w-[calc(100vw-16px)] max-md:gap-1.5">
      {target && (
        <div className="flex items-center gap-1.5 self-start rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] shadow-card">
          <span className="font-mono text-brand">→</span>
          <span className="font-semibold">{target.name}</span>
          {selectedElement?.frameId === target.id && (
            <span className="font-mono text-ink-faint">{selectedElement.selector}</span>
          )}
          <Button
            variant="bare"
            className="ml-0.5 size-4 justify-center rounded-full p-0 text-xs text-ink-faint hover:bg-paper-deep hover:text-ink"
            aria-label="Clear target"
            title="Design something new instead"
            onClick={() => setTargetDismissed(true)}
          >
            ×
          </Button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex gap-2 px-0.5">
          {attachments.map((a) => (
            <div
              key={a.preview}
              className="relative h-[52px] w-[52px] overflow-hidden rounded-[8px] border border-line bg-surface shadow-card"
            >
              <img src={a.preview} alt={a.file.name} className="block h-full w-full object-cover" />
              <Button
                variant="bare"
                className="absolute right-0.5 top-0.5 size-4 justify-center rounded-full bg-black/55 p-0 text-xs leading-none text-white hover:bg-black/70 hover:text-white"
                aria-label={`Remove ${a.file.name}`}
                disabled={busy}
                onClick={() => removeAttachment(a.preview)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      )}
      <form
        ref={barRef}
        className="relative flex items-center gap-2 rounded-[12px] border border-line bg-surface p-1.5 shadow-pop max-md:gap-[3px] max-md:p-[5px]"
        onSubmit={(e) => {
          e.preventDefault()
          void submit(text)
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files ?? [])
            e.target.value = '' // same file can be re-picked after removal
          }}
        />
        <Button
          variant="bare"
          className="ml-0 size-10 justify-center p-2 text-ink-faint hover:bg-paper hover:text-ink-soft sm:ml-0.5 sm:size-auto sm:p-1.5"
          aria-label="Attach images"
          title="Attach screenshots or images"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </Button>
        {/* who the card is addressed to: the pipeline as its role marks, one
            click away from every preset and every role */}
        <Button
          variant="bare"
          className="flex flex-none items-center gap-[3px] rounded-full px-1.5 py-1.5 text-ink-faint hover:bg-paper hover:text-ink-soft"
          aria-label={`Pipeline: ${agents.map(roleName).join(' → ')}`}
          aria-expanded={pickerOpen}
          title={`Pipeline: ${agents.map(roleName).join(' → ')}`}
          disabled={busy}
          onClick={() => setPickerOpen((open) => !open)}
        >
          {agents.map((id) => (
            <RoleMark key={id} role={roleById(id)} size={15} />
          ))}
          <svg
            className={cn('size-[10px] transition-transform duration-[120ms]', pickerOpen && 'rotate-180')}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 15l6-6 6 6" />
          </svg>
        </Button>
        <Input
          ref={inputRef}
          variant="bare"
          inputSize="auto"
          className="flex-1 px-1 py-1.5 md:px-2 md:text-sm"
          value={text}
          disabled={busy}
          placeholder="Describe what an agent should design…"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
            if (images.length) {
              e.preventDefault()
              addFiles(images)
            }
          }}
        />
        <Button
          variant="primary"
          className="min-h-10 flex-none rounded-lg border-transparent px-2.5 py-2 shadow-none hover:translate-x-0 hover:translate-y-0 hover:shadow-none sm:min-h-0 sm:px-3.5 sm:py-[7px]"
          type="submit"
          disabled={busy || !text.trim()}
        >
          {busy ? '…' : 'Design it'}
        </Button>
        {pickerOpen && (
          <div
            role="group"
            aria-label="Assign to"
            className="absolute bottom-[calc(100%+10px)] left-0 right-0 z-40 flex flex-col gap-2 rounded-[12px] border border-line bg-surface p-2.5 shadow-pop"
          >
            <div className="flex flex-wrap gap-[3px]">
              {PIPELINE_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  variant="bare"
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10.5px] font-[650]',
                    agents.join(',') === p.roles.join(',') && 'bg-paper-deep text-accent-ink',
                  )}
                  onClick={() => setAgents(p.roles)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {AGENT_ROLES.map((role) => {
                const at = agents.indexOf(role.id)
                return (
                  <Button
                    key={role.id}
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'gap-1 rounded-full px-2 py-1 text-[11.5px] text-ink-soft hover:border-ink-soft hover:bg-transparent',
                      at >= 0 && 'border-ink bg-ink text-white hover:border-ink hover:bg-ink hover:text-white',
                    )}
                    title={role.blurb}
                    onClick={() => toggleAgent(role.id)}
                  >
                    <RoleMark role={role} size={13} />
                    {role.name}
                    {at >= 0 && agents.length > 1 && (
                      <span className="grid h-[13px] min-w-[13px] place-items-center rounded-full bg-white/25 font-mono text-[9.5px]">
                        {at + 1}
                      </span>
                    )}
                  </Button>
                )
              })}
            </div>
          </div>
        )}
      </form>
      <div className="flex min-h-4 justify-center">
        {error ? (
          <Note tone="error" size="sm" className="text-xs">
            {error}
          </Note>
        ) : sent ? (
          <Note size="sm" className="text-xs text-ink-soft">
            <DoopMark size={11} />{' '}
            {sentTarget
              ? `Queued — a connected agent can claim “${sentTarget}”`
              : 'Queued — a connected agent can claim it from the board'}
          </Note>
        ) : null}
      </div>
    </div>
  )
}
