import { Fragment, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'

/** The commands the frame runtime applies to the element being edited; `link`
 *  carries its href as the message's `value`. */
export type FormatCommand = 'bold' | 'italic' | 'underline' | 'link' | 'insertUnorderedList' | 'insertOrderedList'

/* One row of the edit-mode chip. Buttons keep the iframe's focus (mousedown is
   prevented, the click still fires) — the runtime also remembers the selection,
   so a command never lands on a collapsed caret. */
const TOOL_BTN = 'size-6 rounded-[6px] p-0 text-[12px] leading-none'
const TOOL_DIVIDER = 'mx-0.5 h-3.5 w-px bg-white/20'

const TOOLS: { command: FormatCommand; label: string; title: string; cls?: string; startGroup?: boolean }[] = [
  { command: 'bold', label: 'B', title: 'Bold', cls: 'font-bold' },
  { command: 'italic', label: 'I', title: 'Italic', cls: 'font-serif italic' },
  { command: 'underline', label: 'U', title: 'Underline', cls: 'underline' },
  { command: 'link', label: '🔗', title: 'Link' },
  { command: 'insertUnorderedList', label: '•', title: 'Bulleted list', cls: 'pb-1 text-[17px]', startGroup: true },
  { command: 'insertOrderedList', label: '1.', title: 'Numbered list', cls: 'font-mono text-[10.5px]' },
]

/** The rich-text mini toolbar shown while a frame is in edit mode. It renders
 *  in the parent document but acts on the iframe, so every button is a message
 *  the runtime applies to the element the caret is in (see doop:format). Link
 *  asks for its href in a field that unfolds in place, because there is nothing
 *  else to open a dialog over an editable document from. */
export function RichTextToolbar({
  onFormat,
  ready,
}: {
  /** true once a text element inside the frame is being edited */
  ready: boolean
  onFormat: (command: FormatCommand, value?: string) => void
}) {
  const [linking, setLinking] = useState(false)
  const [href, setHref] = useState('')

  function applyLink() {
    const typed = href.trim()
    if (!typed) return
    /* a bare domain is what people type; without a scheme the browser reads it
       as a relative path and the link goes nowhere */
    onFormat('link', /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`)
    setHref('')
    setLinking(false)
  }

  const hint = ready ? undefined : 'Click some text in the frame first'

  return (
    <div className="flex items-center" onPointerDown={(e) => e.stopPropagation()}>
      {TOOLS.map((tool) => (
        <Fragment key={tool.command}>
          {tool.startGroup && <span className={TOOL_DIVIDER} />}
          {tool.command === 'link' ? (
            <Button
              variant="inverse"
              className={cn(TOOL_BTN, 'text-[13px]', linking && 'bg-white/15')}
              title={hint ?? tool.title}
              aria-label={tool.title}
              aria-pressed={linking}
              disabled={!ready}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setLinking((open) => !open)}
            >
              {tool.label}
            </Button>
          ) : (
            <Button
              variant="inverse"
              className={cn(TOOL_BTN, tool.cls)}
              title={hint ?? tool.title}
              aria-label={tool.title}
              disabled={!ready}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onFormat(tool.command)}
            >
              {tool.label}
            </Button>
          )}
        </Fragment>
      ))}
      {linking && (
        <div className="ml-1 flex items-center gap-1">
          <Input
            variant="bare"
            inputSize="sm"
            autoFocus
            className="h-6 w-[150px] rounded-full bg-white/10 px-2.5 text-[11.5px] text-white placeholder:text-white/40 md:text-[11.5px]"
            placeholder="Paste a link…"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink()
              if (e.key === 'Escape') setLinking(false)
            }}
          />
          <Button
            variant="inverse"
            className="rounded-[7px] px-2 py-1 text-[11px]"
            disabled={!href.trim()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={applyLink}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  )
}
