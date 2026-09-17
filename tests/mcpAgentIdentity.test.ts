import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, initDb } from '../server/db/index.ts'
import { store } from '../server/store.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Durable agent identity, against the REAL server (./harness.ts): a child
 * process on a fresh PGlite database, called over HTTP exactly like an MCP
 * client and a browser. No mocks.
 *
 * What is pinned here, and why each is easy to get wrong:
 *
 *  1. an agent name is free text, so two accounts both working as "Claude" are
 *     two agents — two rows, two ids, never one flickering row;
 *  2. the id an agent answers with is its identity, not its connection: it
 *     survives a reconnect through a new OAuth client, and a restart;
 *  3. what a human presses stop against is a NAME on a canvas, so a stop aimed
 *     at one agent leaves a differently-named one alone; a name two agents
 *     share is refused with both candidates rather than guessed, and the same
 *     press aimed at an id reaches exactly the agent it names;
 *  4. disconnecting an OAuth client revokes the identities that connected
 *     through it, in the store rather than only in the token rows.
 */

/* Port for this file; 4983 is not held by any other test file's server. */
const PORT = 4983
const ROOT = process.cwd()

let server: Server
let owner: Client
let member: Client

let ownerId: string
let canvasId: string
let ownerClaudeToken: string
let ownerScoutToken: string
let memberClaudeToken: string

/** The owner's own "Claude" id, established in setup so no case depends on
 *  another having run first. */
let claudeId: string

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  owner = new Client(server)
  member = new Client(server)
  await owner.signUp('owner@agent-identity.test.dev', 'Owner Alice')
  await member.signUp('member@agent-identity.test.dev', 'Member Bob')
  ownerId = (await (await owner.get('/api/me')).json()).id

  const canvas = await (await owner.post('/api/canvases', { name: 'Identity' })).json()
  canvasId = canvas.id
  /* the second account works on the same canvas: two same-named agents can
     only meet on one canvas, and that meeting is the point of the file */
  const added = await owner.post(`/api/canvases/${canvasId}/members`, {
    email: 'member@agent-identity.test.dev',
    role: 'editor',
  })
  expect(added.status, await added.text()).toBe(200)

  ownerClaudeToken = (await mcpToken(owner)).token
  ownerScoutToken = (await mcpToken(owner)).token
  memberClaudeToken = (await mcpToken(member)).token
  claudeId = (await mcpCall(ownerClaudeToken, 'whoami', { agent_name: 'Claude' })).data.agent_id as string
}, 90_000)

afterAll(() => server?.stop())

/** A bearer token for an MCP connection, obtained the way a real client does:
 *  register the client, approve it in the browser (the session cookie stands in
 *  for the human clicking Allow), then exchange the code with PKCE. Each call
 *  registers its OWN client, because the client is what a disconnect revokes —
 *  pass `existing` to be approved again through a client that was disconnected,
 *  which is what a re-approval looks like. */
async function mcpToken(client: Client, existing?: string): Promise<{ token: string; clientId: string }> {
  const redirect = 'http://localhost:9999/callback'
  const registered = existing
    ? { client_id: existing }
    : await (
        await fetch(`${server.base}/api/auth/mcp/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            redirect_uris: [redirect],
            client_name: 'identity test client',
            token_endpoint_auth_method: 'none',
          }),
        })
      ).json()
  const verifier = 'a'.repeat(64)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = await client.get(
    `/api/auth/mcp/authorize?client_id=${registered.client_id}&redirect_uri=${encodeURIComponent(redirect)}` +
      `&response_type=code&code_challenge=${challenge}&code_challenge_method=s256`,
  )
  const code = new URL(authorize.headers.get('location')!).searchParams.get('code')!
  const token = await (
    await fetch(`${server.base}/api/auth/mcp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: registered.client_id,
        redirect_uri: redirect,
      }),
    })
  ).json()
  return { token: token.access_token as string, clientId: registered.client_id as string }
}

interface ToolCall {
  /** the typed payload: the text block with the session's substitutions merged */
  data: Record<string, unknown>
  /** the tool's own refusal, when it failed: the shape every error answers with */
  error?: { code?: string; message?: string }
  isError: boolean
  raw: string
}

/** One MCP tool call over HTTP, as an agent would make it. */
async function mcpCall(token: string, name: string, args: Record<string, unknown>): Promise<ToolCall> {
  const res = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const body = await res.text()
  const payload = JSON.parse(body.startsWith('event:') ? body.split('data: ')[1]!.trim() : body) as {
    result?: {
      content?: { type: string; text?: string }[]
      structuredContent?: Record<string, unknown>
      isError?: boolean
    }
  }
  const result = payload.result ?? {}
  const raw = result.content?.find((b) => b.type === 'text')?.text ?? ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = { raw }
  }
  /* the refusal is read here, where the raw JSON is: `error` is a documented
     part of this server's tool payloads, not a shape worth a validator */
  const error = parsed.error as { code?: string; message?: string } | undefined
  return {
    data: { ...parsed, ...(result.structuredContent ?? {}) },
    ...(error ? { error } : {}),
    isError: !!result.isError,
    raw,
  }
}

interface Connected {
  agent: string
  owner?: string
  agent_id?: string
}

/** The `connected` rows of a get_agents payload. */
function connected(call: ToolCall): Connected[] {
  return (call.data.connected ?? []) as Connected[]
}

describe('agent identity is durable and per account', () => {
  it('lists two accounts’ same-named agents as two agents with their own ids', async () => {
    expect((await mcpCall(ownerClaudeToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })).isError).toBe(
      false,
    )
    expect(
      (await mcpCall(memberClaudeToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })).isError,
    ).toBe(false)

    const list = await mcpCall(ownerClaudeToken, 'get_agents', { canvas_id: canvasId, agent_name: 'Claude' })
    expect(list.isError, list.raw).toBe(false)
    const claudes = connected(list).filter((c) => c.agent === 'Claude')
    expect(claudes).toHaveLength(2)
    expect(claudes.map((c) => c.owner).sort()).toEqual(['Member Bob', 'Owner Alice'])
    const ids = claudes.map((c) => c.agent_id)
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true)
    expect(new Set(ids).size).toBe(2)
  })

  it('answers whoami with one stable id per identity, across reconnects', async () => {
    const first = await mcpCall(ownerClaudeToken, 'whoami', { agent_name: 'Claude' })
    const second = await mcpCall(ownerClaudeToken, 'whoami', { agent_name: 'Claude' })
    expect(first.isError, first.raw).toBe(false)
    expect(first.data.agent_name).toBe('Claude')
    expect(first.data.account_id).toBe(ownerId)
    expect(first.data.agent_id).toBe(claudeId)
    expect(second.data.agent_id).toBe(claudeId)

    /* a fresh connection — new OAuth client, same account and name — is the
       same agent, which is the whole point of an id that is not a connection */
    const reconnected = await mcpCall((await mcpToken(owner)).token, 'whoami', { agent_name: 'Claude' })
    expect(reconnected.data.agent_id).toBe(claudeId)

    /* ...and the other account's Claude is a different agent, not the same one */
    const theirs = await mcpCall(memberClaudeToken, 'whoami', { agent_name: 'Claude' })
    expect(theirs.data.agent_id).toBeTruthy()
    expect(theirs.data.agent_id).not.toBe(claudeId)

    /* the id get_agents reports is the one whoami answers with */
    const list = await mcpCall(ownerClaudeToken, 'get_agents', { canvas_id: canvasId, agent_name: 'Claude' })
    expect(
      connected(list)
        .filter((c) => c.agent === 'Claude')
        .map((c) => c.agent_id),
    ).toContain(claudeId)
  })

  it('files a stop against the name a human aimed at, and no other', async () => {
    expect((await mcpCall(ownerScoutToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Scout' })).isError).toBe(
      false,
    )

    expect((await owner.post(`/api/canvases/${canvasId}/agents/Scout/stop`, {})).status).toBe(200)

    const stopped = await mcpCall(ownerScoutToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Scout' })
    expect(stopped.isError).toBe(true)
    expect(stopped.error?.code).toBe('stopped')

    /* a stop is a message to one agent — Claude is not the one it names */
    const fine = await mcpCall(ownerClaudeToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
    expect(fine.isError, fine.raw).toBe(false)
  })

  it('refuses an ambiguous name and stops exactly one agent when aimed by id', async () => {
    /* Two accounts both work as "Claude" on this canvas, so a stop aimed at the
       name is a stop aimed at two agents. The route refuses it and names both
       rather than guessing: stopping the wrong agent's run is not recoverable. */
    const ambiguous = await owner.post(`/api/canvases/${canvasId}/agents/Claude/stop`, {})
    expect(ambiguous.status).toBe(409)
    const body = (await ambiguous.json()) as { candidates: { agent_id: string; owner: string }[] }
    expect(body.candidates).toHaveLength(2)
    expect(body.candidates.map((c) => c.agent_id)).toContain(claudeId)

    /* Aimed by id, the same press reaches the one it names. */
    expect((await owner.post(`/api/canvases/${canvasId}/agents/${claudeId}/stop`, {})).status).toBe(200)

    const memberCall = await mcpCall(memberClaudeToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
    expect(memberCall.isError, memberCall.raw).toBe(false)

    const ownerCall = await mcpCall(ownerClaudeToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
    expect(ownerCall.isError).toBe(true)
    expect(ownerCall.error?.code).toBe('stopped')

    /* delivered once: the run it ended is not the next run's refusal */
    const after = await mcpCall(ownerClaudeToken, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })
    expect(after.isError, after.raw).toBe(false)
  })

  it('lists every agent the canvas knows and narrows one by id', async () => {
    const res = await owner.get(`/api/canvases/${canvasId}/agent-levels`)
    const { levels } = (await res.json()) as {
      levels: { agent_id: string; name: string; owner: string; level: string; set_at: number }[]
    }
    expect(res.status, JSON.stringify(levels)).toBe(200)
    const claudes = levels.filter((l) => l.name === 'Claude')
    expect(claudes).toHaveLength(2)
    expect(new Set(claudes.map((l) => l.agent_id)).size).toBe(2)
    expect(claudes.map((l) => l.owner).sort()).toEqual(['Member Bob', 'Owner Alice'])
    /* `full` is the default and is stored as no row, so it is what an agent
       with nothing set reports */
    expect(claudes.map((l) => l.level)).toEqual(['full', 'full'])
    expect(claudes.map((l) => l.set_at)).toEqual([0, 0])

    const theirs = claudes.find((l) => l.owner === 'Member Bob')!
    const put = await owner.req(`/api/canvases/${canvasId}/agents/${theirs.agent_id}/level`, {
      method: 'PUT',
      body: JSON.stringify({ level: 'view' }),
    })
    const set = (await put.json()) as { agent_id: string; level: string; set_at: number }
    expect(put.status, JSON.stringify(set)).toBe(200)
    expect(set).toMatchObject({ agent_id: theirs.agent_id, level: 'view' })
    expect(set.set_at).toBeGreaterThan(0)

    const narrowed = (await (await owner.get(`/api/canvases/${canvasId}/agent-levels`)).json()).levels.find(
      (l: { agent_id: string }) => l.agent_id === theirs.agent_id,
    )
    expect(narrowed).toMatchObject({ level: 'view', set_at: set.set_at })

    /* back to the default: the row goes, the agent stays listed — its id is
       the only way a panel can ever put the chip back */
    const cleared = await owner.req(`/api/canvases/${canvasId}/agents/${theirs.agent_id}/level`, {
      method: 'PUT',
      body: JSON.stringify({ level: 'full' }),
    })
    expect((await cleared.json()) as { level: string }).toMatchObject({ agent_id: theirs.agent_id, level: 'full' })
    const back = (await (await owner.get(`/api/canvases/${canvasId}/agent-levels`)).json()).levels.find(
      (l: { agent_id: string }) => l.agent_id === theirs.agent_id,
    )
    expect(back).toMatchObject({ level: 'full', set_at: 0 })

    /* the owner's leash, and only a level the server knows */
    const asMember = await member.req(`/api/canvases/${canvasId}/agents/${theirs.agent_id}/level`, {
      method: 'PUT',
      body: JSON.stringify({ level: 'view' }),
    })
    expect(asMember.status).toBe(403)
    expect((await member.get(`/api/canvases/${canvasId}/agent-levels`)).status).toBe(403)
    const junk = await owner.req(`/api/canvases/${canvasId}/agents/${theirs.agent_id}/level`, {
      method: 'PUT',
      body: JSON.stringify({ level: 'sideways' }),
    })
    expect(junk.status).toBe(400)
    const unknown = await owner.req(`/api/canvases/${canvasId}/agents/not-an-agent/level`, {
      method: 'PUT',
      body: JSON.stringify({ level: 'view' }),
    })
    expect(unknown.status).toBe(404)
  })

  it('revokes a disconnected client’s identities, and a re-arrival resurrects one', async () => {
    /* one client that stays disconnected, and one that is disconnected and then
       re-approved — the two halves of what a revocation means */
    const doomed = await mcpToken(owner)
    const retiredId = (await mcpCall(doomed.token, 'whoami', { agent_name: 'Retired' })).data.agent_id as string
    expect(retiredId).toBeTruthy()

    const revived = await mcpToken(owner)
    const rebornId = (await mcpCall(revived.token, 'whoami', { agent_name: 'Reborn' })).data.agent_id as string
    expect(rebornId).toBeTruthy()

    for (const client of [doomed, revived]) {
      const res = await owner.delete(`/api/mcp-agents/${client.clientId}`)
      expect(res.status, await res.text()).toBe(200)
    }

    /* the same registered client is approved again — the app row survives the
       disconnect; only its tokens are gone — and the agent arrives as itself:
       the same id, now live again rather than still revoked */
    const again = await mcpToken(owner, revived.clientId)
    const back = await mcpCall(again.token, 'whoami', { agent_name: 'Reborn' })
    expect(back.isError, back.raw).toBe(false)
    expect(back.data.agent_id).toBe(rebornId)

    /* The store is where a revocation lives, so it is read directly: the server
       is stopped (its PGlite cluster is on disk) and the same database opened
       here — which also shows the ids are durable rather than remembered by the
       running process. */
    const dataDir = server.dataDir
    server.stop({ keepData: true })
    await server.stopped
    process.chdir(dataDir)
    await initDb()
    try {
      const rows = await store.listAgentsForOwner(ownerId)
      expect(rows.find((r) => r.id === retiredId)?.revokedAt).toBeGreaterThan(0)
      /* a fresh arrival is the one thing that resurrects an identity, so the
         agent that came back is live while the one that stayed away is not */
      expect(rows.find((r) => r.id === rebornId)?.revokedAt).toBeUndefined()
      expect(rows.find((r) => r.name === 'Claude')?.id).toBe(claudeId)
    } finally {
      await closeDb()
      process.chdir(ROOT)
      /* this database was kept alive on purpose; nothing else will read it */
      rmSync(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
