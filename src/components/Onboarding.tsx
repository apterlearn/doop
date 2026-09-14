import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../lib/store'
import { roleByAgentName } from '../../shared/agents'
import { useIsMobile } from '../hooks/use-mobile'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from './ui/sheet'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'

const obHint = 'text-[12px] leading-[1.45] text-ink-soft'
/* the copy-this-command affordance inside a step */
const obCopy =
  'self-start rounded-md border-line bg-paper-deep px-[9px] py-1 font-mono text-[11.5px] font-normal text-ink shadow-none hover:translate-x-0 hover:translate-y-0 hover:border-ink-soft hover:bg-paper-deep hover:shadow-none'

/**
 * Getting-started checklist. No "next" buttons: the step checks itself off
 * from live canvas state (an MCP agent joining presence). Progress persists in
 * localStorage so a completed step stays checked across canvases and sessions.
 */

const LS_KEY = 'doop:onboarding'

interface Progress {
  dismissed?: boolean
  connected?: boolean
}

function load(): Progress {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function save(p: Progress) {
  localStorage.setItem(LS_KEY, JSON.stringify(p))
}

export function Onboarding() {
  const isMobile = useIsMobile()
  const presences = useStore((s) => s.presences)
  const [progress, setProgress] = useState<Progress>(load)
  const [copied, setCopied] = useState(false)

  /* live detection — flips only ever go false -> true. "Connected" means an
     agent over MCP, not the role names a comment can route to. */
  const agentHere = useMemo(
    () => Object.values(presences).some((p) => p.kind === 'agent' && !roleByAgentName(p.name)),
    [presences],
  )

  /* a step, once seen live, stays done: fold the live signal into the stored
     progress as it lights up */
  if (agentHere && !progress.connected) setProgress({ ...progress, connected: true })

  useEffect(() => save(progress), [progress])

  if (progress.dismissed) return null

  function dismiss() {
    setProgress({ ...progress, dismissed: true })
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, console.error)
  }

  const mcpCmd = `claude mcp add --transport http doop "${location.origin}/mcp"`

  const checklist = (
    <>
      <Step done={!!progress.connected} label="Connect your own agent">
        {!progress.connected && (
          <>
            <Button size="sm" className={obCopy} onClick={() => copy(mcpCmd)}>
              {copied ? '✓ copied' : 'copy the [CC] command'}
            </Button>
            <p className={obHint}>
              Run it in a terminal, then inside [CC] type <code>/mcp</code>, pick <strong>doop</strong> and authenticate
              (a browser window opens). This step checks itself off when your agent first reads the canvas.
            </p>
          </>
        )}
      </Step>

      {progress.connected && (
        <div className="flex flex-col gap-2.5 border-t border-line-soft pt-2.5">
          <p className="text-[12.5px] leading-[1.5] text-ink-soft">
            That's the loop. To ask for work, comment on an element and <b>@mention a role</b> — a connected agent picks
            the comment up and answers on the frame.
          </p>
          <Button className="self-start" onClick={dismiss}>
            Got it
          </Button>
        </div>
      )}
    </>
  )

  if (isMobile) {
    return (
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            className="absolute left-3 top-3 z-30 h-10 gap-2 rounded-full bg-surface px-3 text-xs font-semibold shadow-card"
          >
            <span className="text-brand">✦</span> Getting started
            <span className="font-mono text-[10px] text-ink-faint">{progress.connected ? '1/1' : '0/1'}</span>
          </Button>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[min(78svh,620px)] gap-0 overflow-y-auto rounded-t-2xl border-line bg-surface p-0 shadow-pop"
        >
          <div className="border-b border-line-soft px-5 py-4 pr-14">
            <SheetTitle className="font-display text-lg font-extrabold">Getting started</SheetTitle>
            <SheetDescription className="mt-1 text-xs text-ink-soft">
              Connect your agent, then brief it in a comment.
            </SheetDescription>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5">{checklist}</div>
          <Button
            variant="link"
            size="sm"
            className="mx-5 mb-5 self-start px-0 text-xs text-ink-faint"
            onClick={dismiss}
          >
            Dismiss checklist
          </Button>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div className="absolute right-4 bottom-4 z-40 md:right-[72px] flex w-[300px] flex-col gap-2.5 rounded-[12px] border border-line bg-surface px-4 pt-3.5 pb-4 shadow-pop">
      <header className="flex items-center justify-between">
        <span className="font-display text-[14px] font-semibold tracking-[-0.01em]">Getting started</span>
        <Button variant="bare" size="icon-sm" className="text-xs" onClick={dismiss} title="Dismiss">
          ✕
        </Button>
      </header>

      {checklist}
    </div>
  )
}

function Step({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className={cn('w-3.5 flex-none text-[13px]', done ? 'text-[#1e7a4c]' : 'text-ink-faint')}>
        {done ? '✓' : '○'}
      </span>
      <div className="flex flex-col gap-[5px]">
        <span
          className={cn('text-[13px] font-semibold', done ? 'text-ink-faint line-through decoration-1' : 'text-ink')}
        >
          {label}
        </span>
        {children}
      </div>
    </div>
  )
}
