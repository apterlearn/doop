import { useState } from 'react'
import { useStore } from '../lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { AuthScreen } from './ui/screen'
import { Wordmark } from './ui/wordmark'
import { LockIcon } from './ui/icons'

/* The one line of copy this bar exists for: a visitor looking at somebody
   else's canvas through a share link is reading, not editing, and the canvas
   gives them no hint of that on its own — the toolbars simply are not there.
   Saying so also names the way out (an account). */
export function GuestBar({ className, onSignIn }: { className?: string; onSignIn?: () => void }) {
  const guest = useStore((s) => s.guest)
  if (!guest) return null
  const canNote = guest.access !== 'view'
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-full border border-line bg-paper px-2.5 py-1 text-[11.5px] leading-none text-ink-soft',
        className,
      )}
      title={
        canNote
          ? 'You opened this canvas through a share link — you can read it and leave notes, not change it.'
          : 'You opened this canvas through a share link — you can read it, not change it.'
      }
    >
      <LockIcon width={11} height={11} className="flex-none text-ink-faint" />
      <span className="truncate">Viewing a shared canvas · read only</span>
      {canNote && <span className="hidden flex-none text-ink-faint sm:inline">notes allowed</span>}
      {onSignIn && (
        <Button variant="link" size="sm" className="h-auto flex-none px-0 py-0 text-[11.5px]" onClick={onSignIn}>
          Sign in
        </Button>
      )}
    </span>
  )
}

/** The card `/c/<id>` shows when the share link is password-protected and the
 *  visitor has not entered it yet: one field, one button, and the failure from
 *  the last attempt. It stands in for the canvas, so it wears the signed-out
 *  shell — the visitor has no account and nothing else to look at. */
export function GuestPasswordPrompt({
  onUnlock,
  error,
  busy,
}: {
  onUnlock: (password: string) => void
  error: string | null
  busy: boolean
}) {
  const [password, setPassword] = useState('')
  return (
    <AuthScreen>
      <form
        className="flex w-[min(400px,100%)] flex-col gap-3.5 rounded-[12px] border border-line bg-surface p-6 pt-[30px] shadow-pop sm:p-9 sm:pb-7"
        onSubmit={(e) => {
          e.preventDefault()
          if (password && !busy) onUnlock(password)
        }}
      >
        <Wordmark className="mb-1.5" />
        <h1 className="font-serif text-[34px] font-normal leading-[1.05] tracking-[-0.015em]">
          This canvas is protected.
        </h1>
        <p className="text-[13px] leading-[1.55] text-ink-soft">
          The person who shared it set a password. Enter it to read the canvas — a comment link also lets you leave
          notes.
        </p>
        <Input
          className="mt-1 rounded-lg bg-paper focus:border-ink-soft focus:ring-0 md:text-sm"
          type="password"
          value={password}
          autoFocus
          autoComplete="off"
          aria-label="Link password"
          placeholder="Link password"
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-[12.5px] leading-[1.45] text-accent-ink">{error}</p>}
        <Button variant="primary" size="lg" type="submit" disabled={busy || !password} className="mt-0.5">
          {busy ? 'Checking…' : 'Open canvas'}
        </Button>
      </form>
    </AuthScreen>
  )
}
