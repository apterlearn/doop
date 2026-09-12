import { describe, expect, it } from 'vitest'
import { groupClients } from '../server/mcpClients.ts'

/**
 * One MCP connection legitimately owns several oauth_access_token rows: refresh
 * token rotation inserts a new row without deleting the old one. The connected-
 * agents list is therefore per CLIENT — otherwise a five-row connection would
 * look like five agents and revoking one would silently leave four alive.
 */

const now = Date.UTC(2026, 0, 1)
const live = new Date(now + 3_600_000)
const dead = new Date(now - 3_600_000)

describe('groupClients', () => {
  it('collapses several tokens for one client into one entry', () => {
    expect(
      groupClients(
        [
          { clientId: 'a', expiresAt: live },
          { clientId: 'a', expiresAt: live },
        ],
        new Map(),
        now,
      ),
    ).toEqual([{ clientId: 'a', name: 'Unnamed client', expiresAt: live.getTime(), liveTokens: 2, lastUsedAt: 0 }])
  })

  it('names a client from its registration', () => {
    const names = new Map([['a', 'Claude Desktop']])
    expect(groupClients([{ clientId: 'a', expiresAt: live }], names, now)[0]?.name).toBe('Claude Desktop')
  })

  it('keeps an expired client listed so it stays revocable', () => {
    const [client] = groupClients([{ clientId: 'a', expiresAt: dead }], new Map(), now)
    expect(client?.liveTokens).toBe(0)
    expect(client?.expiresAt).toBe(dead.getTime())
  })

  it('reports the newest expiry and counts only unexpired tokens as live', () => {
    const [client] = groupClients(
      [
        { clientId: 'a', expiresAt: dead },
        { clientId: 'a', expiresAt: live },
      ],
      new Map(),
      now,
    )
    expect(client?.liveTokens).toBe(1)
    expect(client?.expiresAt).toBe(live.getTime())
  })

  it('treats a token with no expiry as not live', () => {
    expect(groupClients([{ clientId: 'a', expiresAt: null }], new Map(), now)[0]?.liveTokens).toBe(0)
  })

  it('orders clients by newest expiry', () => {
    const clients = groupClients(
      [
        { clientId: 'old', expiresAt: dead },
        { clientId: 'new', expiresAt: live },
      ],
      new Map(),
      now,
    )
    expect(clients.map((c) => c.clientId)).toEqual(['new', 'old'])
  })
})
