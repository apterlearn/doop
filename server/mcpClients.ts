/** An MCP client holding a token for the signed-in account. Mirrored
 *  verbatim in src/lib/api.ts (the client cannot import from server/). */
export interface ConnectedAgent {
  clientId: string
  /** what the client called itself at dynamic client registration */
  name: string
  /** newest access-token expiry across this client's rows, ms epoch */
  expiresAt: number
  /** how many of its tokens for this user are still live */
  liveTokens: number
  /** last authenticated MCP call this process saw, ms epoch — 0 = never used */
  lastUsedAt: number
}

/** lastUsedAt is per process (it answers "is this client active", not
 *  "when did it first connect"), so an in-memory map is the right store. */
const lastUsed = new Map<string, number>()

export function touchClient(clientId: string): void {
  lastUsed.set(clientId, Date.now())
}

/** Collapse one user's token rows into one entry per OAuth client.
 *
 *  Grouping is per client, not per token row: better-auth's refresh-token
 *  rotation inserts a new oauth_access_token row without deleting the old one,
 *  so one connection legitimately owns several rows. Expired rows still yield
 *  an entry (with liveTokens: 0) so a client that connected once stays
 *  revocable — and so this list agrees with allowance.hasOwnAgent, which counts
 *  expired rows as proof of a connection. */
export function groupClients(
  tokens: { clientId: string; expiresAt: Date | null }[],
  names: Map<string, string>,
  now = Date.now(),
): ConnectedAgent[] {
  const grouped = new Map<string, ConnectedAgent>()
  for (const r of tokens) {
    const at = r.expiresAt ? new Date(r.expiresAt).getTime() : 0
    const g = grouped.get(r.clientId) ?? {
      clientId: r.clientId,
      name: names.get(r.clientId) ?? 'Unnamed client',
      expiresAt: 0,
      liveTokens: 0,
      lastUsedAt: lastUsed.get(r.clientId) ?? 0,
    }
    g.expiresAt = Math.max(g.expiresAt, at)
    if (at > now) g.liveTokens++
    grouped.set(r.clientId, g)
  }
  return [...grouped.values()].sort((a, b) => b.expiresAt - a.expiresAt)
}
