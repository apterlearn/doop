import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'
import { findBrowserPath } from '../server/screenshot.ts'

const PORT = 4960

let server: Server
let author: Client
let visitor: Client

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}` })
  author = new Client(server)
  await author.signUp('author@test.dev', 'Ada Author')
  visitor = new Client(server)
  await visitor.signUp('visitor@test.dev', 'Vic Visitor')
}, 60_000)

afterAll(() => server?.stop())

async function canvasWithFrame(client: Client, name: string) {
  const canvas = await (await client.post('/api/canvases', { name })).json()
  const frame = await (await client.post(`/api/canvases/${canvas.id}/frames`, { name: 'Hero' })).json()
  await client.patch(`/api/frames/${frame.id}`, { html: '<h1>hello</h1>' })
  return { canvas, frame }
}

it('lists a published canvas for others to copy without opening the source', async () => {
  const { canvas, frame } = await canvasWithFrame(author, 'Launch page')

  /* the gallery is opt-in: nothing shows before the owner publishes */
  expect(await (await visitor.get('/api/community')).json()).toEqual([])

  const published = await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ description: 'A bold hero.', category: 'website' }),
  })
  expect(published.status).toBe(200)
  expect(await published.json()).toMatchObject({ description: 'A bold hero.', category: 'website' })

  const listing = await (await visitor.get('/api/community')).json()
  expect(listing).toMatchObject([
    {
      id: canvas.id,
      name: 'Launch page',
      description: 'A bold hero.',
      category: 'website',
      authorName: 'Ada Author',
      copyCount: 0,
      frames: [{ id: frame.id, name: 'Hero' }],
    },
  ])
  /* previews only — the HTML stays on the owner's canvas */
  expect(JSON.stringify(listing)).not.toContain('hello')

  /* publishing does not open the canvas itself */
  expect((await visitor.get(`/api/canvases/${canvas.id}`)).status).toBe(403)
  expect((await visitor.post(`/api/canvases/${canvas.id}/duplicate`)).status).toBe(403)

  const copied = await visitor.post(`/api/community/${canvas.id}/copy`)
  const copy = await copied.json()
  expect(copied.status, JSON.stringify(copy)).toBe(200)
  expect(copy.id).not.toBe(canvas.id)
  expect(copy.name).toBe('Launch page')
  expect(copy.frames).toHaveLength(1)
  expect(copy.frames[0].html).toBe('<h1>hello</h1>')
  expect(copy.publishedAt).toBeUndefined()

  /* the copy is the visitor's own private canvas now */
  expect((await visitor.get(`/api/canvases/${copy.id}`)).status).toBe(200)
  expect((await author.get(`/api/canvases/${copy.id}`)).status).toBe(403)

  /* and the source counted it */
  const [after] = await (await visitor.get('/api/community')).json()
  expect(after.copyCount).toBe(1)

  /* only the owner may list or delist */
  const stranger = await visitor.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'app' }),
  })
  expect(stranger.status).toBe(403)

  expect((await author.delete(`/api/canvases/${canvas.id}/publish`)).status).toBe(200)
  expect(await (await visitor.get('/api/community')).json()).toEqual([])
  expect((await visitor.post(`/api/community/${canvas.id}/copy`)).status).toBe(404)
}, 60_000)

it('lists every real frame of a large design, oldest first', async () => {
  const canvas = await (await author.post('/api/canvases', { name: 'Big system' })).json()
  const names = Array.from({ length: 15 }, (_, i) => `Screen ${i + 1}`)
  for (const name of names) await author.post(`/api/canvases/${canvas.id}/frames`, { name })
  await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'app' }),
  })

  const listing: { id: string; frames: { name: string }[] }[] = await (await visitor.get('/api/community')).json()
  const item = listing.find((i) => i.id === canvas.id)!
  expect(item.frames.map((f) => f.name)).toEqual(names)

  await author.delete(`/api/canvases/${canvas.id}/publish`)
}, 60_000)

it('refuses listings without real content or a valid shelf', async () => {
  const blank = await (await author.post('/api/canvases', { name: 'Blank' })).json()
  const noFrames = await author.req(`/api/canvases/${blank.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'website' }),
  })
  expect(noFrames.status).toBe(400)

  const { canvas } = await canvasWithFrame(author, 'Odd shelf')
  const badShelf = await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'memes' }),
  })
  expect(badShelf.status).toBe(400)
}, 60_000)

it('keeps a listing across a restart', async () => {
  const { canvas } = await canvasWithFrame(author, 'Durable')
  await author.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ description: 'Survives reboots.', category: 'dashboard' }),
  })
  await visitor.post(`/api/community/${canvas.id}/copy`)

  const dataDir = server.dataDir
  server.stop({ keepData: true })
  await server.stopped
  server = await startServer(PORT + 1, { BETTER_AUTH_URL: `http://localhost:${PORT + 1}` }, dataDir)

  const back = new Client(server)
  await back.post('/api/auth/sign-in/email', { email: 'visitor@test.dev', password: 'password12345' })
  const listing = await (await back.get('/api/community')).json()
  expect(listing).toMatchObject([
    { id: canvas.id, description: 'Survives reboots.', category: 'dashboard', copyCount: 1 },
  ])
}, 60_000)

/** A bearer token for an MCP connection, obtained the way a real client does:
 *  register the client, approve it in the browser (the session cookie stands in
 *  for the human clicking Allow), then exchange the code with PKCE. */
async function mcpToken(client: Client): Promise<string> {
  const redirect = 'http://localhost:9999/callback'
  const registered = await (
    await fetch(`${server.base}/api/auth/mcp/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirect],
        client_name: 'test client',
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
  return token.access_token as string
}

/** One MCP tool call over HTTP, as an agent would make it. */
async function mcpCall(token: string, name: string, args: Record<string, unknown>) {
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
  const payload = body.startsWith('event:') ? JSON.parse(body.split('data: ')[1]!.trim()) : JSON.parse(body)
  const text = payload.result.content.find((b: { type: string }) => b.type === 'text')?.text ?? '{}'
  return JSON.parse(text) as Record<string, never>
}

/* Rendering the release needs the shared headless browser, like every other
   render-backed assertion in this repo. */
it.skipIf(!findBrowserPath())(
  'serves a release to anyone with the link, frozen against later edits',
  async () => {
    /* a client for the CURRENT server: the restart test above replaced it */
    const owner = new Client(server)
    await owner.post('/api/auth/sign-in/email', { email: 'author@test.dev', password: 'password12345' })
    const { canvas, frame } = await canvasWithFrame(owner, 'Handoff')

    /* the release is created by an agent over MCP, through the same OAuth path a
     real client uses */
    const token = await mcpToken(owner)
    /* releases ship the whole canvas, and this frame was never reviewed: force
       keeps this test about the link. The gate has its own coverage in
       tests/mcpReviewMode.test.ts */
    const created = await mcpCall(token, 'create_release', {
      force: true,
      canvas_id: canvas.id,
      name: 'v1',
      agent_name: 'Claude',
    })
    const releaseId = created.release_id as unknown as string
    expect(String(created.url)).toContain(`/p/${canvas.id}/${releaseId}`)

    /* no session at all: the link is the credential */
    const preview = await fetch(`${server.base}/p/${canvas.id}/${releaseId}`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('cache-control')).toContain('immutable')
    /* frame HTML the server did not author, served from its own origin: an
       inline handler in any frame would otherwise run with the viewer's
       session when the link is opened */
    const csp = preview.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("default-src 'none'")
    const html = await preview.text()
    expect(html).toContain('hello')

    /* the canvas moves on; the link does not */
    await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>changed later</h1>' })
    const again = await (await fetch(`${server.base}/p/${canvas.id}/${releaseId}`)).text()
    expect(again).toContain('hello')
    expect(again).not.toContain('changed later')

    /* an id under another canvas does not resolve */
    expect((await fetch(`${server.base}/p/not-this-canvas/${releaseId}`)).status).toBe(404)
  },
  60_000,
)

it('shows and hands out the release a listing is pinned to, not the live canvas', async () => {
  const owner = new Client(server)
  await owner.post('/api/auth/sign-in/email', { email: 'author@test.dev', password: 'password12345' })
  /* the restart test above replaced the server, so the visitors of the first
     one are pointed at a port nothing listens on */
  const guest = new Client(server)
  await guest.post('/api/auth/sign-in/email', { email: 'visitor@test.dev', password: 'password12345' })
  const { canvas, frame } = await canvasWithFrame(owner, 'Pinned page')
  const token = await mcpToken(owner)
  const created = await mcpCall(token, 'create_release', {
    /* as above: the fixture canvas is deliberately unverified */
    force: true,
    canvas_id: canvas.id,
    name: 'v1',
    agent_name: 'Claude',
  })
  const releaseId = created.release_id as unknown as string
  const published = await mcpCall(token, 'publish_canvas', {
    force: true,
    canvas_id: canvas.id,
    description: 'A frozen hero.',
    category: 'website',
    release_id: releaseId,
    agent_name: 'Claude',
  })
  expect(published.error).toBeUndefined()

  /* the canvas moves on: the frame is renamed and rewritten */
  await owner.patch(`/api/frames/${frame.id}`, { html: '<h1>changed later</h1>', name: 'Hero v2' })

  /* what the visitor sees is the snapshot, so a later edit cannot change the
     listing under them */
  const [listing] = await (await guest.get('/api/community')).json()
  expect(listing.id).toBe(canvas.id)
  expect(listing.frames).toEqual([{ id: frame.id, name: 'Hero', width: frame.width, height: frame.height }])

  /* and the copy they take is that snapshot too */
  const copied = await guest.post(`/api/community/${canvas.id}/copy`)
  const copy = await copied.json()
  expect(copied.status, JSON.stringify(copy)).toBe(200)
  expect(copy.frames[0].html).toBe('<h1>hello</h1>')

  /* delisting drops the pin: the next listing is the live canvas again */
  expect((await owner.delete(`/api/canvases/${canvas.id}/publish`)).status).toBe(200)
  await owner.req(`/api/canvases/${canvas.id}/publish`, {
    method: 'PUT',
    body: JSON.stringify({ category: 'website' }),
  })
  const [live] = await (await guest.get('/api/community')).json()
  expect(live.frames[0].name).toBe('Hero v2')
}, 60_000)
