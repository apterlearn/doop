import { useEffect, useState } from 'react'
import { api, type ConnectedAgent } from '../lib/api'
import { timeAgo } from '../lib/time'
import { Button } from './ui/button'
import { Note } from './ui/note'
import { Skeleton } from './ui/skeleton'
import { Card, CardDescription, CardHeader, CardRow, CardTitle } from './ui/card'

/* settings fields are a fixed column on desktop and full width on a phone */
const settingsCard = 'mt-4 max-w-[1000px] overflow-hidden sm:mt-5'

/** The "Connected agents" pane of /settings: the MCP clients holding a token
 *  for this account, and the way to cut one off. */
export function ConnectedAgents() {
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

  async function revoke(clientId: string) {
    try {
      await api.revokeMcpAgent(clientId)
      setNote('Revoked.')
      window.setTimeout(() => setNote(''), 4000)
      /* the revoked client must leave the list, or the row offers a revoke
         that can only fail */
      const list = await api.listMcpAgents().catch(() => null)
      if (list) setClients(list)
    } catch (err) {
      console.error(err)
      setNote('Couldn’t revoke that client — try again.')
    }
  }

  return (
    <Card className={settingsCard}>
      <CardHeader>
        <CardTitle>Connected agents</CardTitle>
        <CardDescription>
          Agents you connected over MCP. They act as you — same canvases, same permissions. Revoking cuts a client off
          immediately: its next tool call is refused and it has to be approved again.
        </CardDescription>
        {note && (
          <div className="mt-[11px]">
            <Note tone={note === 'Revoked.' ? 'success' : 'error'}>{note}</Note>
          </div>
        )}
      </CardHeader>

      {clients === null ? (
        <>
          <CardRow>
            <Skeleton className="h-4 w-[180px]" />
          </CardRow>
          <CardRow>
            <Skeleton className="h-4 w-[140px]" />
          </CardRow>
        </>
      ) : failed ? (
        <CardRow>
          <Note tone="error">Couldn’t load connected agents.</Note>
        </CardRow>
      ) : clients.length === 0 ? (
        <CardRow>
          <Note>No agents connected yet. Add one from a canvas’s “Connect AI agent” dialog.</Note>
        </CardRow>
      ) : (
        clients.map((c) => (
          <CardRow
            key={c.clientId}
            label={c.name}
            action={
              <Button variant="danger-solid" size="sm" onClick={() => void revoke(c.clientId)}>
                Revoke
              </Button>
            }
          >
            <span className="font-mono text-[13px]">
              {c.liveTokens} live token{c.liveTokens === 1 ? '' : 's'}
            </span>
            <Note>{c.lastUsedAt ? `last used ${timeAgo(c.lastUsedAt)}` : 'never used'}</Note>
          </CardRow>
        ))
      )}
    </Card>
  )
}
