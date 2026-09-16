import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { mintGuestTicket } from '../server/auth.ts'
import { Client, startServer, type Server } from './harness.ts'

/**
 * Sharing, agent control and the ops surface, against the REAL server
 * (./harness.ts): a child process on a fresh PGlite database, exercised over
 * HTTP exactly like the browser and MCP clients. No mocks — this is the same
 * surface a self-hoster exposes to the internet.
 *
 * What is pinned here, and why each of them is easy to get wrong:
 *
 *  1. a share link's MODE is its whole meaning — a view visitor reads, a
 *     comment visitor comments, and an expired link is nothing at all;
 *  2. a guest ticket is a bearer credential for ONE canvas: renewable on its
 *     signature once it lapses, and never a way into another canvas;
 *  3. member management is the owner's OR an admin member's, while the owner
 *     row and the canvas itself stay the owner's alone;
 *  4. what a human files for an agent (stop, steer) is visible to a viewer and
 *     writable only by an editor.
 */

/* Base port for this file; the tiny-budget server in the global-limit case
   takes TINY_PORT. tests/admin.test.ts also reaches 4995 transiently through
   its own `PORT + 2`, so a parallel run that lands the two files together
   there leaves this file's server without the bind. */
const PORT = 4995

/** The second instance: a three-call global budget, so a six-call burst
 *  crosses it. Its own port, because the limiter is per-process — and a port
 *  no other test file in the suite holds. */
const TINY_PORT = 4991

/** The guest-ticket key. server/auth.ts signs tickets with
 *  process.env.BETTER_AUTH_SECRET when the deployment has one, so a ticket
 *  minted in THIS process (see mintTicketAt below) is one the server accepts. */
const SECRET = 'doop-sharing-agents-test-secret'

let server: Server
let BASE: string

let owner: Client
let adminMember: Client
let viewer: Client
let invitee: Client
let visitor: Client

let canvasId: string
let frameId: string
let ownerId: string
let adminId: string
let viewerId: string
let inviteeId: string

beforeAll(async () => {
  server = await startServer(PORT, { BETTER_AUTH_URL: `http://localhost:${PORT}`, BETTER_AUTH_SECRET: SECRET })
  BASE = server.base
  owner = new Client(server)
  adminMember = new Client(server)
  viewer = new Client(server)
  invitee = new Client(server)
  visitor = new Client(server)

  await owner.signUp('owner@sharing.test.dev', 'Owner')
  await adminMember.signUp('admin@sharing.test.dev', 'Ada Admin')
  await viewer.signUp('viewer@sharing.test.dev', 'Vic Viewer')
  await invitee.signUp('invitee@sharing.test.dev', 'Ida Invitee')
  await visitor.signUp('visitor@sharing.test.dev', 'Sam Stranger')
  ownerId = (await (await owner.get('/api/me')).json()).id
  adminId = (await (await adminMember.get('/api/me')).json()).id
  viewerId = (await (await viewer.get('/api/me')).json()).id
  inviteeId = (await (await invitee.get('/api/me')).json()).id

  const canvas = await (await owner.post('/api/canvases', { name: 'Sharing' })).json()
  canvasId = canvas.id
  frameId = (await (await owner.post(`/api/canvases/${canvasId}/frames`, { name: 'F1' })).json()).id

  /* The two memberships every role case below leans on: an admin member (the
     owner's delegate for member management) and a plain viewer. Both are added
     now because the link-policy case needs a member who CAN edit the canvas
     and is still refused the owner's link policy. */
  const madeAdmin = await owner.post(`/api/canvases/${canvasId}/members`, {
    email: 'admin@sharing.test.dev',
    role: 'admin',
  })
  const madeViewer = await owner.post(`/api/canvases/${canvasId}/members`, {
    email: 'viewer@sharing.test.dev',
    role: 'viewer',
  })
  expect(madeAdmin.status, await madeAdmin.text()).toBe(200)
  expect(madeViewer.status, await madeViewer.text()).toBe(200)
}, 90_000)

afterAll(() => server?.stop())

/* ------------------------------------------------------------------ */
/* The public link surface: no session, no account — bare fetches.     */
/* ------------------------------------------------------------------ */

function openLink(canvas: string, body: Record<string, unknown> = {}) {
  return fetch(`${BASE}/api/public/canvases/${canvas}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function guestComment(canvas: string, body: Record<string, unknown>) {
  return fetch(`${BASE}/api/public/canvases/${canvas}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function refreshTicket(canvas: string, ticket: string) {
  return fetch(`${BASE}/api/public/canvases/${canvas}/guest-ticket/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
  })
}

/**
 * A ticket signed by the same key the server holds, stamped with a `now` of the
 * caller's choosing — the one parameter the route cannot be asked for, and so
 * the only way to hold a signed-but-lapsed ticket without waiting out the
 * 30-minute TTL. server/auth.ts is importable here without side effects: the
 * better-auth instance is assigned lazily by initAuth(), which only the server
 * calls, so the module is just functions.
 */
function mintTicketAt(canvas: string, mode: 'view' | 'comment' | 'edit', now: number): string {
  /* auth.ts signs a ticket with process.env.BETTER_AUTH_SECRET when the
     deployment has one — so this process must hold the same key the server was
     started with, or the signature would be one the server rejects */
  process.env.BETTER_AUTH_SECRET = SECRET
  return mintGuestTicket(canvas, mode, now).ticket
}

/** The `init` message a room join answers with — the comments a canvas holds
 *  ride along with it. There is no REST route that lists comments; this is the
 *  surface the editor reads them from. */
interface RoomInit {
  canvas: { id: string }
  comments: { id: string; frameId: string; text: string; from: string }[]
}

function joinInit(canvas: string, cookie: string): Promise<RoomInit> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } })
    const join = { type: 'join', canvasId: canvas, clientId: `sa-${Math.random()}`, name: 'test', kind: 'user' }
    ws.on('open', () => ws.send(JSON.stringify(join)))
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as RoomInit & { type: string }
      if (msg.type !== 'init') return
      ws.close()
      resolve(msg)
    })
    /* the server answers a join with `init` or closes the socket with the
       verdict — awaiting either one is the whole wait */
    ws.on('close', (code) => reject(new Error(`ws closed ${code} before init`)))
    ws.on('error', () => {}) // the close event carries the verdict
  })
}

describe('share links', () => {
  it('opens a view link for a signed-out caller and refuses the comment that link cannot make', async () => {
    /* the link policy is the owner's alone: a member who can edit everything
       else on the canvas still cannot open, lock or expire the link */
    expect((await adminMember.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(403)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'sideways' })).status).toBe(400)
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)

    const res = await openLink(canvasId)
    const opened = await res.json()
    expect(res.status, JSON.stringify(opened)).toBe(200)
    expect(opened.access).toBe('view')
    expect(typeof opened.ticket).toBe('string')
    expect(opened.expiresAt).toBeGreaterThan(Date.now())
    expect(opened.canvas.id).toBe(canvasId)
    /* a visitor has no business enumerating the people on the canvas — and the
       one flag about the password it does need */
    expect(opened.canvas.memberIds).toBeUndefined()
    expect(opened.canvas.linkPasswordSet).toBe(false)

    const refused = await guestComment(canvasId, {
      ticket: opened.ticket,
      frameId,
      selector: '.card',
      snippet: '<div class="card">',
      text: 'the card is too far left',
    })
    expect(refused.status).toBe(403)
  })

  it('mints a comment ticket and lands the guest comment on the frame in the room', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'comment' })).status).toBe(200)

    const opened = await (await openLink(canvasId)).json()
    expect(opened.access).toBe('comment')

    const res = await guestComment(canvasId, {
      ticket: opened.ticket,
      frameId,
      selector: '.card',
      snippet: '<div class="card">',
      text: 'the card is too far left',
    })
    const comment = await res.json()
    expect(res.status, JSON.stringify(comment)).toBe(200)
    expect(comment).toMatchObject({ canvasId, frameId, text: 'the card is too far left', from: 'Guest' })

    /* the owner reads it back through the room's own init payload */
    const init = await joinInit(canvasId, owner.header())
    const seen = init.comments.find((c) => c.id === comment.id)
    expect(seen).toMatchObject({ frameId, text: 'the card is too far left', from: 'Guest' })
  })

  it('will not open a password-protected link without the password, and takes the right one', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { password: 'hunter2' })).status).toBe(200)

    const missing = await openLink(canvasId)
    expect(missing.status).toBe(401)
    expect((await missing.json()).code).toBe('password_required')

    const wrong = await openLink(canvasId, { password: 'hunter3' })
    expect(wrong.status).toBe(401)
    expect((await wrong.json()).code).toBe('password_required')

    const ok = await openLink(canvasId, { password: 'hunter2' })
    const opened = await ok.json()
    expect(ok.status, JSON.stringify(opened)).toBe(200)
    expect(typeof opened.ticket).toBe('string')
    /* the mode the password unlocked is still the link's own */
    expect(opened.access).toBe('comment')
    expect(opened.canvas.linkPasswordSet).toBe(true)
  })

  it('treats an expired link as nothing at all, password or not', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { expiresAt: Date.now() - 1_000 })).status).toBe(200)

    const res = await openLink(canvasId, { password: 'hunter2' })
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('link_off')
  })

  it('refreshes a live ticket, refuses a forged and a foreign one, and renews a lapsed ticket', async () => {
    /* back to a live comment link: an expired link is not a link at all, which
       is the one thing the refresh route must still insist on */
    expect((await owner.patch(`/api/canvases/${canvasId}`, { password: null, expiresAt: null })).status).toBe(200)

    const opened = await (await openLink(canvasId)).json()
    expect(opened.access).toBe('comment')

    /* the two refusals first, so the live refresh below cannot land in the
       same millisecond as the mint it renews — a ticket carries its expiry in
       milliseconds, and two mints in one millisecond would be the same string */
    const forged = await refreshTicket(canvasId, 'g1.whatever.comment.9999999999999.not-a-signature')
    expect(forged.status).toBe(401)
    expect((await forged.json()).code).toBe('link_off')

    /* a ticket names ONE canvas: another canvas's ticket is not this one's */
    const elsewhere = await (await owner.post('/api/canvases', { name: 'Elsewhere' })).json()
    const foreign = mintTicketAt(elsewhere.id, 'view', Date.now())
    expect((await refreshTicket(canvasId, foreign)).status).toBe(401)

    const refreshed = await refreshTicket(canvasId, opened.ticket)
    const moved = await refreshed.json()
    expect(refreshed.status, JSON.stringify(moved)).toBe(200)
    expect(moved.ticket).not.toBe(opened.ticket)
    expect(moved.access).toBe('comment')
    /* a renewal never shortens the claim it renews */
    expect(moved.expiresAt).toBeGreaterThanOrEqual(opened.expiresAt)

    /* the point of the route: a ticket whose half-hour has run out renews on
       its signature alone — the expiry is precisely what is being renewed,
       so a past expiry is the one thing it must not refuse on */
    const lapsed = mintTicketAt(canvasId, 'comment', Date.now() - 31 * 60_000)
    const renewed = await refreshTicket(canvasId, lapsed)
    const fresh = await renewed.json()
    expect(renewed.status, JSON.stringify(fresh)).toBe(200)
    expect(fresh.ticket).not.toBe(lapsed)
    expect(fresh.access).toBe('comment')
    expect(fresh.expiresAt).toBeGreaterThan(Date.now())

    /* ...and the ticket it hands back is one the visitor can actually use */
    const used = await guestComment(canvasId, {
      ticket: fresh.ticket,
      frameId,
      selector: '.card',
      snippet: '<div class="card">',
      text: 'still here on the renewed ticket',
    })
    expect(used.status).toBe(200)

    /* narrowing the link to view takes the older, broader ticket with it: a
       stale comment ticket must not launder itself into a fresh one */
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)
    expect((await refreshTicket(canvasId, fresh.ticket)).status).toBe(403)
  })
})

describe('collaborators and invitations', () => {
  it('lets an admin member change a role where a plain viewer cannot', async () => {
    /* the viewer holds no role to hand out — and cannot reach the call at all */
    expect((await viewer.patch(`/api/canvases/${canvasId}/members/${adminId}`, { role: 'admin' })).status).toBe(403)
    const invited = await viewer.post(`/api/canvases/${canvasId}/invites`, { email: 'x@invited.test', role: 'editor' })
    expect(invited.status).toBe(403)

    /* the admin member is the owner's delegate: this is the call that used to
       answer 403 to anyone but the owner */
    const res = await adminMember.patch(`/api/canvases/${canvasId}/members/${viewerId}`, { role: 'commenter' })
    const member = await res.json()
    expect(res.status, JSON.stringify(member)).toBe(200)
    expect(member).toMatchObject({
      userId: viewerId,
      email: 'viewer@sharing.test.dev',
      owner: false,
      role: 'commenter',
    })

    /* and the role the gate reads is the one that was just handed out */
    const people = await (await owner.get(`/api/canvases/${canvasId}/members`)).json()
    expect(people.find((p: { userId: string }) => p.userId === viewerId)?.role).toBe('commenter')
  })

  it('keeps the owner row and the canvas itself out of an admin member reach', async () => {
    /* the owner's own access is not a role anyone can re-issue */
    const reRole = await adminMember.patch(`/api/canvases/${canvasId}/members/${ownerId}`, { role: 'viewer' })
    expect(reRole.status).toBe(400)
    /* the admin's job ends at collaborators: the canvas is the owner's */
    expect((await adminMember.delete(`/api/canvases/${canvasId}`)).status).toBe(403)
    /* ...but reading and issuing invitations is part of the job */
    expect((await adminMember.get(`/api/canvases/${canvasId}/invites`)).status).toBe(200)
    /* an invitation needs an account to land on */
    const missing = await adminMember.post(`/api/canvases/${canvasId}/members`, {
      email: 'nobody@sharing.test.dev',
      role: 'editor',
    })
    expect(missing.status).toBe(404)
  })

  it('applies an invited role when its invitee accepts, and refuses anyone else the token', async () => {
    const created = await owner.post(`/api/canvases/${canvasId}/invites`, {
      email: 'invitee@sharing.test.dev',
      role: 'commenter',
    })
    const invite = await created.json()
    expect(created.status, JSON.stringify(invite)).toBe(200)
    expect(invite).toMatchObject({ email: 'invitee@sharing.test.dev', role: 'commenter' })
    expect(invite.expiresAt).toBeGreaterThan(Date.now())
    expect(invite.url).toContain('/invite/')
    const token = String(invite.url).split('/invite/')[1]

    /* the landing page answers before anyone signs in — that is the whole flow */
    const anon = await fetch(`${BASE}/api/invites/${token}`)
    const landing = await anon.json()
    expect(anon.status, JSON.stringify(landing)).toBe(200)
    expect(landing).toMatchObject({ canvasId, canvasName: 'Sharing', role: 'commenter' })

    /* the token names an address, so another account cannot spend it */
    expect((await adminMember.post(`/api/invites/${token}/accept`)).status).toBe(403)

    const accepted = await invitee.post(`/api/invites/${token}/accept`)
    expect(accepted.status, await accepted.text()).toBe(200)
    expect((await invitee.get(`/api/canvases/${canvasId}`)).status).toBe(200)

    /* the role the invitation named is the one the gate now reads */
    const people = await (await owner.get(`/api/canvases/${canvasId}/members`)).json()
    expect(people.find((p: { userId: string }) => p.userId === inviteeId)?.role).toBe('commenter')

    /* a commenter comments, and still cannot edit */
    const commented = await invitee.post(`/api/frames/${frameId}/comments`, {
      selector: '.card',
      snippet: '<div>',
      text: 'from the invitee',
    })
    expect(commented.status).toBe(200)
    expect((await invitee.patch(`/api/frames/${frameId}`, { name: 'renamed by the invitee' })).status).toBe(403)

    /* spent for everyone else; still a valid handshake for its own invitee */
    expect((await adminMember.post(`/api/invites/${token}/accept`)).status).toBe(404)
    expect((await invitee.post(`/api/invites/${token}/accept`)).status).toBe(200)
    expect((await fetch(`${BASE}/api/invites/${token}`)).status).toBe(404)
  })
})

describe('agent control', () => {
  it('queues a stop and a steer, and reports both for that agent with who asked', async () => {
    const stopped = await adminMember.post(`/api/canvases/${canvasId}/agents/HeaderAgent/stop`, {})
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).ok).toBe(true)

    const steered = await owner.post(`/api/canvases/${canvasId}/agents/HeaderAgent/steer`, {
      message: 'focus on the header',
    })
    expect(steered.status).toBe(200)
    expect((await steered.json()).ok).toBe(true)

    const { signals } = await (await owner.get(`/api/canvases/${canvasId}/agent-signals`)).json()
    expect(signals.find((s: { kind: string }) => s.kind === 'stop')).toMatchObject({
      canvasId,
      agentName: 'HeaderAgent',
      kind: 'stop',
      by: 'Ada Admin',
    })
    expect(signals.find((s: { kind: string }) => s.kind === 'steer')).toMatchObject({
      canvasId,
      agentName: 'HeaderAgent',
      kind: 'steer',
      message: 'focus on the header',
      by: 'Owner',
    })
  })

  it('refuses a steer with no message', async () => {
    expect((await owner.post(`/api/canvases/${canvasId}/agents/HeaderAgent/steer`, {})).status).toBe(400)
    const blank = await owner.post(`/api/canvases/${canvasId}/agents/HeaderAgent/steer`, { message: '   ' })
    expect(blank.status).toBe(400)
  })

  it('lets a view-only link visitor read the signals but not press stop', async () => {
    expect((await owner.patch(`/api/canvases/${canvasId}`, { linkAccess: 'view' })).status).toBe(200)

    /* reading what is queued is a viewer's business... */
    const list = await visitor.get(`/api/canvases/${canvasId}/agent-signals`)
    expect(list.status).toBe(200)
    expect(Array.isArray((await list.json()).signals)).toBe(true)

    /* ...writing one is not */
    expect((await visitor.post(`/api/canvases/${canvasId}/agents/HeaderAgent/stop`, {})).status).toBe(403)
    const steered = await visitor.post(`/api/canvases/${canvasId}/agents/HeaderAgent/steer`, { message: 'x' })
    expect(steered.status).toBe(403)
    /* and a caller with no session at all has no room here */
    expect((await fetch(`${BASE}/api/canvases/${canvasId}/agent-signals`)).status).toBe(401)
  })
})

describe('ops and the destructive-tool list', () => {
  it('lists the destructive tools to a session and refuses an unauthenticated caller', async () => {
    const res = await owner.get('/api/destructive-tools')
    const { tools } = await res.json()
    expect(res.status).toBe(200)
    /* sorted, so the review panel can render it without re-ordering */
    expect(tools).toEqual([...tools].sort())
    expect(tools).toEqual(
      expect.arrayContaining([
        'generate_image',
        'open_pull_request',
        'update_pull_request',
        'comment_pull_request',
        'upload_font',
        'delete_frame',
      ]),
    )
    expect((await fetch(`${BASE}/api/destructive-tools`)).status).toBe(401)
  })

  it('answers liveness and readiness, and echoes a request id it was handed', async () => {
    const health = await fetch(`${BASE}/healthz`)
    expect(health.status).toBe(200)
    expect((await health.json()).ok).toBe(true)

    const ready = await fetch(`${BASE}/readyz`)
    const report = await ready.json()
    expect(ready.status, JSON.stringify(report)).toBe(200)
    expect(report.ok).toBe(true)
    expect(report.store.hydrated).toBe(true)

    /* a proxy that mints its own id gets it back, so its log line correlates */
    const echoed = await fetch(`${BASE}/healthz`, { headers: { 'x-request-id': 'trace-sharing-agents-0001' } })
    expect(echoed.headers.get('x-request-id')).toBe('trace-sharing-agents-0001')
    /* and one that does not still gets an id */
    const minted = await owner.get('/api/me')
    expect(minted.headers.get('x-request-id')).toMatch(/^\S{1,64}$/)
  })

  it('throttles a burst past the global budget with retry-after, and leaves the probes open', async () => {
    /* a second instance with a three-call budget and its own database: the
       limiter is per-process and per-IP, so exhausting it here cannot touch
       anything the cases above pinned on the first server */
    const tiny = await startServer(TINY_PORT, {
      BETTER_AUTH_URL: `http://localhost:${TINY_PORT}`,
      DOOP_GLOBAL_RATE_LIMIT: '3',
    })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) statuses.push((await fetch(`${tiny.base}/api/canvases`)).status)
      /* the first calls are budgeted and reach the session gate; the rest are
         refused before any route sees them */
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401])
      expect(statuses.slice(3)).toEqual([429, 429, 429])

      const refused = await fetch(`${tiny.base}/api/canvases`)
      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)

      /* the probes are not under /api: a busy instance must still be able to
         answer the two questions a load balancer asks it */
      expect((await fetch(`${tiny.base}/healthz`)).status).toBe(200)
      expect((await fetch(`${tiny.base}/readyz`)).status).toBe(200)
    } finally {
      tiny.stop()
    }
  }, 70_000)
})
