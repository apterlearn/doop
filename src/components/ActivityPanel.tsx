import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { api, type ConnectedAgent } from '../lib/api'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { MemoryPanel } from './MemoryPanel'
import { ReviewPanel } from './ReviewPanel'
import { TokensPanel } from './TokensPanel'
import { ChecksPanel } from './ChecksPanel'
import { ComponentsPanel } from './ComponentsPanel'
import { Panel, PanelBody, PanelHeader, PanelTab, PanelTabPanel, PanelTabs, PanelTabsRoot } from './ui/panel'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'
import { PanelCollapseRightIcon } from './ui/icons'
import { Dot } from './ui/dot'

const emptyNote = 'px-4 py-6 text-center text-[13px] text-ink-faint'

export function ActivityPanel({
  onClose,
  surface = 'floating',
}: {
  onClose: () => void
  /* 'inline' when the panel is filling a mobile Sheet rather than floating */
  surface?: 'floating' | 'inline'
}) {
  const tab = useStore((s) => s.panelTab)
  const setTab = useStore((s) => s.setPanelTab)
  const [, tick] = useState(0)

  /* refresh relative timestamps and running durations */
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 5000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <Panel surface={surface} className={cn(surface === 'floating' && 'inset-y-3 right-3 w-[300px]')}>
      <PanelTabsRoot value={tab} onValueChange={(next) => setTab(next as typeof tab)}>
        <PanelHeader>
          <PanelTabs>
            <PanelTab value="activity">Activity</PanelTab>
            <PanelTab
              value="memory"
              title="Design memory — references, rules and decisions every agent on this canvas designs with"
            >
              Memory
            </PanelTab>
            <PanelTab
              value="tokens"
              title="The canvas design system — palette, type and scales every frame renders with"
            >
              Tokens
            </PanelTab>
            <PanelTab value="review" title="Agent changes waiting for your approval, and their questions">
              Review
            </PanelTab>
            <PanelTab
              value="components"
              title="The canvas component library — reusable pieces every agent can instance into frames"
            >
              Components
            </PanelTab>
            <PanelTab value="checks" title="What the automated quality checks found on each frame">
              Checks
            </PanelTab>
            <PanelTab value="agents" title="MCP clients connected to your account — revoke one to cut it off">
              Clients
            </PanelTab>
          </PanelTabs>
          <Tooltip label="Collapse panel" side="bottom" align="end">
            <Button
              variant="bare"
              size="icon-sm"
              className="shrink-0 text-ink-faint hover:bg-paper-deep hover:text-ink"
              aria-label="Collapse panel"
              onClick={onClose}
            >
              <PanelCollapseRightIcon width={13} height={13} />
            </Button>
          </Tooltip>
        </PanelHeader>
        <PanelTabPanel value="activity">
          <ActivityList />
        </PanelTabPanel>
        <PanelTabPanel value="tokens">
          <TokensPanel />
        </PanelTabPanel>
        <PanelTabPanel value="review">
          <ReviewPanel />
        </PanelTabPanel>
        <PanelTabPanel value="components">
          <ComponentsPanel />
        </PanelTabPanel>
        <PanelTabPanel value="checks">
          <ChecksPanel />
        </PanelTabPanel>
        <PanelTabPanel value="memory">
          <MemoryPanel />
        </PanelTabPanel>
        <PanelTabPanel value="agents">
          <ClientsList />
        </PanelTabPanel>
      </PanelTabsRoot>
    </Panel>
  )
}

const activityRow = 'flex animate-[chip-in_0.25s_ease] gap-2.5 px-4 py-[9px] text-[12.5px] leading-[1.45]'

/* The feed names the frame an entry is about; when that frame still exists the
   row is a button that flies the canvas to it, so a note is one click from the
   thing it describes. */
function ActivityList() {
  const activity = useStore((s) => s.activity)
  const frames = useStore((s) => s.canvas?.frames)
  return (
    <PanelBody className="py-2">
      {activity.length === 0 && <div className={emptyNote}>No activity yet. Add a frame, or connect an agent.</div>}
      {activity.map((a) => {
        const frameId = a.frameId
        const jumpable = !!frameId && !!frames?.some((f) => f.id === frameId)
        const body = (
          <>
            <Dot className="mt-[5px]" style={{ background: a.actorColor }} />
            <div>
              <div>
                <span className="font-bold">
                  {a.actorName}
                  <span className="ml-[5px] font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                    {a.actorKind}
                  </span>
                </span>{' '}
                <span className="text-ink-soft">{a.message}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-ink-faint">{timeAgo(a.at)}</div>
            </div>
          </>
        )
        if (!jumpable) {
          return (
            <div key={a.id} className={activityRow}>
              {body}
            </div>
          )
        }
        return (
          <button
            key={a.id}
            type="button"
            title="Go to this frame"
            className={cn(activityRow, 'w-full text-left hover:bg-paper-deep')}
            onClick={() => {
              useStore.getState().select(frameId)
              useStore.getState().requestFlyTo(frameId)
            }}
          >
            {body}
          </button>
        )
      })}
    </PanelBody>
  )
}

/* The MCP clients acting as this account. Revoking deletes their tokens, which
   is what cuts a client off: its next call is refused and it must be approved
   again. This is the tab that answers "who can work on this canvas". */
function ClientsList() {
  const [clients, setClients] = useState<ConnectedAgent[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    let live = true
    api
      .listMcpAgents()
      .then((list) => {
        if (!live) return
        setClients(list)
        setFailed(false)
      })
      .catch(() => {
        if (!live) return
        setClients([])
        setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  if (clients === null) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>Loading connected clients…</div>
      </PanelBody>
    )
  }
  if (failed) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>Couldn&rsquo;t load connected clients. {note}</div>
      </PanelBody>
    )
  }
  if (clients.length === 0) {
    return (
      <PanelBody className="py-2">
        <div className={emptyNote}>
          No clients connected. Connect one from a canvas&rsquo;s &ldquo;Connect AI agent&rdquo; dialog.
        </div>
      </PanelBody>
    )
  }
  return (
    <PanelBody className="py-2">
      {clients.map((c) => (
        <div key={c.clientId} className={cn(activityRow, 'items-center justify-between')}>
          <div className="min-w-0">
            <div className="truncate font-bold">{c.name}</div>
            <div className="mt-0.5 text-[11px] text-ink-faint">
              {c.liveTokens} live token{c.liveTokens === 1 ? '' : 's'} ·{' '}
              {c.lastUsedAt ? `last used ${timeAgo(c.lastUsedAt)}` : 'never used'}
            </div>
          </div>
          <Button
            variant="danger-solid"
            size="pill"
            className="flex-none"
            title="Revoke this client's access"
            onClick={() => {
              setNote('')
              api
                .revokeMcpAgent(c.clientId)
                .then(async () => {
                  /* the revoked client must leave the list, or the row offers a
                     revoke that can only fail */
                  const list = await api.listMcpAgents().catch(() => null)
                  if (list) setClients(list)
                })
                .catch(() => setNote(`Couldn't revoke ${c.name} — try again.`))
            }}
          >
            Revoke
          </Button>
        </div>
      ))}
    </PanelBody>
  )
}
