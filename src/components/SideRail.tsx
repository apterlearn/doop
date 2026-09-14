import type { ComponentProps } from 'react'
import { useStore, type PanelTab } from '../lib/store'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { BookmarkIcon, ClientsIcon, PanelExpandRightIcon, PulseIcon, ShieldIcon } from './ui/icons'

/** The collapsed side panel: a column of icon buttons pinned to the top-right
 *  of the canvas while the panel is closed. Each opens the panel on its tab;
 *  the panel takes the rail's place until its ✕ closes it. Counts and alerts
 *  ride on the icons so a closed panel still tells you whether anything is
 *  happening. */
export function SideRail({ onOpen }: { onOpen: () => void }) {
  const setTab = useStore((s) => s.setPanelTab)
  /* frame changes + open questions an agent is waiting on */
  const pendingReview = useStore(
    (s) =>
      s.frameProposals.filter((p) => p.status === 'pending').length +
      s.questions.filter((q) => q.status === 'open').length,
  )
  const proposalPending = useStore((s) => s.proposals.some((p) => p.status === 'pending'))

  function show(next: PanelTab) {
    setTab(next)
    onOpen()
  }

  return (
    <nav
      aria-label="Canvas side panel"
      className="absolute top-3 right-3 z-[38] flex w-12 flex-col items-center gap-1.5 rounded-[14px] border border-line bg-surface p-1.5 shadow-card"
    >
      <RailControl label="Expand panel" onClick={onOpen}>
        <PanelExpandRightIcon />
      </RailControl>
      <span aria-hidden className="my-0.5 h-px w-6 bg-line-soft" />
      <RailControl label="Activity" onClick={() => show('activity')}>
        <PulseIcon />
      </RailControl>
      <RailControl
        label={pendingReview ? `Review · ${pendingReview} waiting` : 'Review'}
        className={cn(pendingReview > 0 && 'bg-accent-ink/6 text-accent-ink')}
        onClick={() => show('review')}
      >
        <ShieldIcon className="size-4" />
        {pendingReview > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface bg-accent-ink px-[3px] font-mono text-[8px] font-medium text-white">
            {pendingReview}
          </span>
        )}
      </RailControl>
      <RailControl label="Connected clients" onClick={() => show('agents')}>
        <ClientsIcon />
      </RailControl>
      <RailControl label={proposalPending ? 'Memory · suggestion to review' : 'Memory'} onClick={() => show('memory')}>
        <BookmarkIcon />
        {proposalPending && (
          <span className="absolute top-[5px] right-[5px] size-1.5 rounded-full bg-accent-ink shadow-[0_0_0_2px_var(--surface)]" />
        )}
      </RailControl>
    </nav>
  )
}

function RailControl({ label, className, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip label={label} side="left">
      <Button
        variant="bare"
        size="icon"
        aria-label={label}
        className={cn('relative size-[34px] rounded-lg text-ink-soft hover:bg-paper-deep hover:text-ink', className)}
        {...props}
      />
    </Tooltip>
  )
}
