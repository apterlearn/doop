import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { eq, inArray, and } from 'drizzle-orm'
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node'
import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { WebSocketServer, WebSocket } from 'ws'
import { store } from './store.ts'
import * as runLog from './runLog.ts'
import * as actions from './actions.ts'
import * as frameLocks from './frameLocks.ts'
import * as notifications from './notifications.ts'
import { getImage, renderHtmlPreview } from './previews.ts'
import { diffFrames } from './visualDiff.ts'
import type {
  AgentQuestion,
  Canvas,
  CanvasProposal,
  CanvasRelease,
  DesignTokens,
  Frame,
  FrameProposal,
} from '../shared/types.ts'

import { canAccessCanvas, hasDurableCanvasAccess, isAdmin } from './access.ts'
import { auth, initAuth, syncAdmins, getUserName, loadOidcConfig, PUBLIC_ORIGIN, loginProvidersConfig } from './auth.ts'
import { adminRouter } from './admin.ts'
import { communityRouter, parseListing, publishCanvas, unpublishCanvas } from './community.ts'
import * as demo from './demo.ts'

import { closeDb, db, initDb } from './db/index.ts'
import * as authSchema from './db/auth-schema.ts'
import * as persist from './db/persist.ts'
import {
  agentsMd,
  designMd,
  handoffFileName,
  handoffFiles,
  htmlBundle,
  rewriteAssetUrls,
  tailwindThemeCss,
  tokensDtcg,
  tokensJson,
} from './codeExport.ts'
import { buildZip } from './zip.ts'
import { reviewCanvas } from './canvasReview.ts'
import { commentPullRequest, commitToBranch, ensurePullRequest } from './githubWrite.ts'
import { nanoid } from 'nanoid'
import { cssForTokens } from '../shared/tokens.ts'
import { SNAPSHOT_CSP } from './snapshotCsp.ts'
import { frameSha, reviewFrame, reviewToRecord } from './review.ts'
import { handleMcpRequest } from './mcp.ts'
import { groupClients } from './mcpClients.ts'
import {
  getAsset,
  getCanvasAsset,
  extractAssetIds,
  reconcileAssetRefs,
  beginTicketUpload,
  endTicketUpload,
  createAsset,
  MAX_ASSET_BYTES,
} from './assets.ts'
import * as ingest from './ingest.ts'
import * as backgrounds from './backgrounds.ts'
import * as storage from './storage.ts'
import * as github from './github.ts'
import * as githubApp from './githubApp.ts'
import { importRepoScreen } from './githubRecon.ts'
import { seed } from './seed.ts'
import * as modelAccounts from './modelAccounts.ts'
import { AGENT_MODELS } from './openaiAgent.ts'
import { colorFor } from '../shared/types.ts'
import type { FrameLockHolder } from '../shared/types.ts'
import type { CanvasFocus, ClientMessage, Presence, ServerMessage } from '../shared/types.ts'

const PORT = Number(process.env.PORT || 4400)

/** Human caller identity for actions: session name, user kind. */
const resolveActorFromReq = (req: express.Request) => actions.resolveActor({ name: req.user!.name, kind: 'user' })
/** Proposal previews are re-renders on demand: one small budget per account. */
const renderPreviewHits = new Map<string, number[]>()

/* Identifies the client bundle this process serves. Hashing dist/index.html
   changes the hash, while server-only deploys and plain restarts do not.
   Clients compare it across reconnects to know their loaded bundle is stale. */
const BUILD_ID = (() => {
  try {
    return createHash('sha1')
      .update(readFileSync(path.join(process.cwd(), 'dist', 'index.html')))
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'dev'
  }
})()

/* boot: connect the DB, hydrate memory, import pre-DB store.json once */

/* A half-configured SSO set is a misconfiguration, and the only useful thing to
   do about it is refuse to run — checked before the database is opened, so a
   self-hoster finds out in a second instead of after a boot's worth of work. */
loadOidcConfig()
await initDb()
await backgrounds.initBackgrounds()
initAuth()
await syncAdmins() // ADMIN_EMAILS -> user.role, for accounts that already exist
let data = await persist.hydrate()
if (data.canvases.length === 0 && (await persist.importLegacyJson())) {
  data = await persist.hydrate()
}
store.init(data.canvases)
actions.hydrateLogs({
  comments: data.comments,
  activity: data.activity,
  decisions: data.decisions,
  proposals: data.proposals,
})
actions.hydrateUserMemory([...(data.userMemory?.values() ?? [])].flat())
store.initComponents([...(data.components?.values() ?? [])].flat())
seed()

/* asset bookkeeping (no deletion): every upload records its canvas, and
   asset_refs tracks which frames reference which assets — kept in sync on
   every durable frame write, rebuilt here from the frames hydrate just
   loaded. Nothing is ever deleted; asset_refs is the ledger any future
   cleanup would be built on. */
{
  const frames = data.canvases.flatMap((c) => c.frames)
  reconcileAssetRefs(frames)
    .then((n) => n && console.log(`[assets] reconciled ${n} asset ref(s)`))
    .catch((e) => console.error('[assets] reconcile failed', e))
}

/* One stray rejection must never take down the multiplayer server: Node's
   default is to exit, which turned a single aborted analytics upload into
   sitewide 502s (2026-08-20). Log loudly instead — a real bug shows up here
   as a stack trace, not an outage. */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandled-rejection]', reason)
})

/* Flush debounced frame writes, then shut the DB down, before the process
   dies — with a hard-exit timeout so a wedged DB can never keep the process
   (and the port) alive. The close matters for PGlite: it holds the cluster in
   memory and syncs it to ./data/pg, so exiting without it can leave pg_control
   naming a checkpoint whose WAL record never reached disk — the next boot then
   PANICs in recovery. */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    setTimeout(() => process.exit(0), 1500).unref()
    persist
      .flush((id) => store.getFrame(id))
      .catch((err) => console.error('flush on shutdown failed', err))
      .then(() => closeDb())
      .catch((err) => console.error('db close on shutdown failed', err))
      .finally(() => process.exit(0))
  })
}

/* ------------------------------------------------- realtime rooms */

interface Conn {
  ws: WebSocket
  canvasId: string
  presence: Presence
  /** an admin viewing as someone else: receives updates, emits nothing.
   *  Showing their borrowed identity as a live cursor would tell the room
   *  the owner is here when they aren't. */
  silent?: boolean
}

const conns = new Map<WebSocket, Conn>()

function room(canvasId: string): Conn[] {
  return [...conns.values()].filter((c) => c.canvasId === canvasId)
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcast(canvasId: string, msg: ServerMessage, excludeClientId?: string) {
  for (const c of room(canvasId)) {
    if (excludeClientId && c.presence.clientId === excludeClientId) continue
    send(c.ws, msg)
  }
}

/* Agents show up in presence while they are actively calling tools. */
interface AgentPresence extends Presence {
  lastSeen: number
  /** set by wait_for_events: the agent is parked but alive, so the 60s
   *  status TTL applies instead of the 20s idle sweep */
  waiting?: boolean
}
const agentPresences = new Map<string, Map<string, AgentPresence>>() // canvasId -> name -> presence

/** What each connected client is looking at: frame, element and page. Kept
 *  per canvas and swept with presence — a client that left is not still
 *  pointing at anything. `at` is what the MCP focus nudge compares against. */
type Focus = Omit<CanvasFocus, 'clientId' | 'name'>
const focusByCanvas = new Map<string, Map<string, Focus>>() // canvasId -> clientId -> focus

function agentTouch(
  canvasId: string,
  agentName: string,
  frameId?: string | null,
  status?: string | null,
  owner?: string,
  ownerId?: string,
) {
  /* presence is keyed by account + name: an agent name is free text, so two
     accounts both running the same name are two agents, not one flickering one */
  const key = `${ownerId ?? ''}::${agentName}`
  let byName = agentPresences.get(canvasId)
  if (!byName) agentPresences.set(canvasId, (byName = new Map()))
  let p = byName.get(key)
  const isNew = !p
  if (!p) {
    p = {
      clientId: `agent:${agentName}`,
      name: agentName,
      color: colorFor(agentName),
      kind: 'agent',
      owner,
      lastSeen: Date.now(),
      activeFrameId: frameId ?? null,
    }
    byName.set(key, p)
  }
  p.lastSeen = Date.now()
  if (frameId !== undefined && frameId !== null) p.waiting = false
  if (owner && !p.owner) p.owner = owner
  if (frameId !== undefined) p.activeFrameId = frameId
  let statusChanged = false
  if (status !== undefined) {
    const next = status?.trim() || undefined
    if (p.status !== next) {
      p.status = next
      statusChanged = true
    }
  }
  if (isNew) {
    broadcast(canvasId, { type: 'presence:join', presence: p })
  } else {
    if (frameId !== undefined) {
      broadcast(canvasId, { type: 'editing', clientId: p.clientId, frameId: p.activeFrameId ?? null })
    }
    if (statusChanged) {
      broadcast(canvasId, { type: 'status', clientId: p.clientId, status: p.status ?? null })
    }
  }
}

setInterval(() => {
  /* a lock that lapses while the room still shows its holder is a lie: the
     sweep is what makes "held by X" disappear when X stops responding */
  actions.sweepExpiredLocks()
}, 5000)

setInterval(() => {
  const now = Date.now()
  for (const [canvasId, byName] of agentPresences) {
    for (const [key, p] of byName) {
      /* an agent with a posted status — or one parked in wait_for_events —
         is alive between calls, not gone: keep it on screen longer */
      if (now - p.lastSeen > (p.status || p.waiting ? 60_000 : 20_000)) {
        byName.delete(key)
        broadcast(canvasId, { type: 'presence:leave', clientId: p.clientId })
      }
    }
  }
  /* focus follows presence: a socket that died without a close event must not
     leave the room — or an agent reading the canvas — pointing at a selection
     nobody is holding any more */
  for (const [canvasId, byClient] of focusByCanvas) {
    const here = new Set(room(canvasId).map((c) => c.presence.clientId))
    for (const clientId of byClient.keys()) if (!here.has(clientId)) byClient.delete(clientId)
    if (byClient.size === 0) focusByCanvas.delete(canvasId)
  }
}, 5000)

/** Mark an agent as parked in a long wait (wait_for_events / ask_human). */
export function markAgentWaiting(canvasId: string, agentName: string, waiting: boolean): void {
  const byName = agentPresences.get(canvasId)
  const key = [...(byName?.keys() ?? [])].find((k) => k.endsWith(`::${agentName}`))
  const p = key ? byName?.get(key) : undefined
  if (p) {
    p.waiting = waiting
    p.lastSeen = Date.now()
  }
}

actions.wire(broadcast, agentTouch, markAgentWaiting)

/* Presence lives here (agentPresences), the MCP surface lives in mcp.ts, and
   neither may import the other: the reader is handed over at boot so
   get_agents can list an agent that has only posted a status. */
actions.wirePresence((canvasId) =>
  [...(agentPresences.get(canvasId)?.values() ?? [])].map((p) => ({
    name: p.name,
    ...(p.owner ? { owner: p.owner } : {}),
    status: p.status ?? null,
    frameId: p.activeFrameId ?? null,
    ...(p.waiting ? { waiting: true } : {}),
    lastSeen: p.lastSeen,
  })),
)

/* What humans are looking at lives here too, and the MCP surface reads it the
   same way: the frame/element/page a person selected is the only way they can
   point an agent at "this". Names come from the room, so a reader never has to
   trust an id. */
actions.wireFocus((canvasId) => {
  const byClient = focusByCanvas.get(canvasId)
  if (!byClient) return []
  const names = new Map(room(canvasId).map((c) => [c.presence.clientId, c.presence.name]))
  return [...byClient]
    .filter(([clientId]) => names.has(clientId))
    .map(([clientId, f]) => ({ clientId, name: names.get(clientId)!, ...f }))
})

/* the Run tab sees tool calls live, and the timeline is a 7-day window */
runLog.wireBroadcast(broadcast)
runLog.pruneOlderThan(7 * 24 * 60 * 60 * 1000)

const app = express()

/* Railway/Fly terminate TLS in front of us; trust the proxy so req.protocol
   and secure cookies see https, and OAuth metadata echoes the right origin */
app.set('trust proxy', 1)

app.get('/healthz', (_req, res) => res.json({ ok: true }))

/* ------------------------------------------------------------------ */
/* PostHog relay: the client sends analytics + session-replay traffic  */
/* to this origin (/relay/...) and we forward it, so ad blockers that  */
/* match PostHog's domains never see a request to block. Mounted       */
/* before express.json — replay payloads are compressed binary and     */
/* must pass through untouched. Cookies are stripped: our auth session */
/* must not leak to a third party.                                     */
/* ------------------------------------------------------------------ */

const PH_INGEST = process.env.POSTHOG_INGEST_HOST || 'https://us.i.posthog.com'
const PH_ASSETS = process.env.POSTHOG_ASSETS_HOST || 'https://us-assets.i.posthog.com'
const PH_DROP_HEADERS = new Set(['host', 'connection', 'cookie', 'content-length', 'accept-encoding'])

app.use('/relay', async (req, res) => {
  /* /static/* is PostHog's CDN (lazy bundles, toolbar); everything else
     (/e, /s, /flags, /array) is the ingestion API */
  const upstream = req.url.startsWith('/static/') ? PH_ASSETS : PH_INGEST

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && !PH_DROP_HEADERS.has(k)) headers[k] = v
  }
  /* keep the incoming XFF chain — its first entry is the real client IP
     and PostHog geolocates from it. Overwriting with req.ip would send
     Railway's edge-PoP address instead (trust proxy only strips one hop).
     Fall back to req.ip when there is no chain (local dev). */
  if (!headers['x-forwarded-for'] && req.ip) headers['x-forwarded-for'] = req.ip

  try {
    /* the body read must sit inside the try: navigating away mid-upload
       aborts big session-replay POSTs, which rejects this stream — left
       uncaught, that single abort would take down the whole process */
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)

    const r = await fetch(upstream + req.url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    /* accept-encoding was stripped, so the body is identity — but drop
       length/encoding headers anyway and let Express size the response */
    res.status(r.status)
    r.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'content-encoding' && k !== 'transfer-encoding' && k !== 'connection')
        res.set(k, v)
    })
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch {
    /* analytics must never surface errors to the app */
    if (!res.headersSent) res.status(502)
    res.end()
  }
})

/* ------------------------------------------------------------------ */
/* Public frame images: /i/<frameId>.png|jpg — shareable/hotlinkable   */
/* (og:image etc). Unauthenticated by the same unguessable-id logic as */
/* canvas share links; renders the CURRENT frame, so embedded images   */
/* stay up to date as the design iterates. Caching, rate limiting and  */
/* render dispatch live in previews.ts — this route is HTTP only.      */
/* ------------------------------------------------------------------ */

app.get('/i/:id.:ext', async (req, res) => {
  const { id, ext } = req.params as { id: string; ext: string }
  if (ext !== 'png' && ext !== 'jpg') return res.status(404).end()
  const frame = store.getFrame(id)
  if (!frame) return res.status(404).end()

  let result: Awaited<ReturnType<typeof getImage>>
  try {
    result = await getImage(frame, {
      ext,
      scale: req.query.scale === '2' ? 2 : 1,
      quality: Math.min(100, Math.max(1, Number(req.query.quality) || 90)),
      /* ?preview — the dashboard-card variant; see previews.ts */
      preview: req.query.preview !== undefined,
      ip: req.ip ?? 'unknown',
      /* the render limit targets anonymous hotlink abuse — a logged-in user
         loading a dashboard of many canvases shouldn't hit it (and behind
         the Railway proxy many users can share one req.ip). Only called
         when the budget is exhausted, so cached serves stay auth-free. */
      isAuthenticated: async () =>
        !!(await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)),
    })
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
  }
  if (result.status === 'rate-limited') {
    res.set('Retry-After', '60')
    return res.status(429).json({ error: 'render rate limit — cached URLs are unaffected' })
  }
  const { buf } = result

  res.set('Content-Type', ext === 'jpg' ? 'image/jpeg' : 'image/png')
  res.set('Cache-Control', 'public, max-age=60')
  if (req.query.download !== undefined) {
    const safe = frame.name.replace(/[^\w\- ]+/g, '').trim() || 'frame'
    res.set('Content-Disposition', `attachment; filename="${safe}.${ext}"`)
  }
  res.send(buf)
})

/* ------------------------------------------------------------------ */
/* Uploaded assets: /a/<assetId>.<ext> — written once by the upload_asset */
/* MCP tool, immutable thereafter, so far-future caching is safe. Public  */
/* by the same unguessable-id logic as /i/ (frame HTML embedding these    */
/* URLs renders for anyone who can see the canvas).                       */
/* ------------------------------------------------------------------ */

app.get('/a/:id.:ext', async (req, res) => {
  const { id, ext } = req.params as { id: string; ext: string }
  try {
    const found = await getAsset(id)
    if (!found || found.meta.ext !== ext) return res.status(404).end()
    res.set('Content-Type', found.meta.mime)
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('X-Content-Type-Options', 'nosniff')
    /* svg can script when opened as a document — neuter it; <img> embeds
       are unaffected */
    if (found.meta.mime === 'image/svg+xml')
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    if (req.query.download !== undefined) res.set('Content-Disposition', `attachment; filename="${id}.${ext}"`)
    res.send(found.buf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'asset fetch failed' })
  }
})

/* Curated background library (server/backgrounds.ts): /bg/<id>.webp and  */
/* /bg/<id>-t.webp straight from object storage. Public and immutable —  */
/* the catalog is checked in, the bytes are put there by the import      */
/* script and never rewritten under the same id.                         */
app.get('/bg/:file', async (req, res) => {
  const key = backgrounds.keyForFile(req.params.file)
  if (!key) return res.status(404).end()
  try {
    const buf = await storage.getObject(key)
    if (!buf) return res.status(404).end()
    res.set('Content-Type', 'image/webp')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.set('X-Content-Type-Options', 'nosniff')
    res.send(buf)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'background fetch failed' })
  }
})

/* ------------------------------------------------------------------ */
/* One-time asset uploads: the upload_asset MCP tool mints a ticket and */
/* the agent curls the file here (curl -T file /u/<token>), so bytes    */
/* go disk -> doop without ever passing through the model. Mounted      */
/* before express.json — the body IS the file. The token is the         */
/* capability: unguessable, single-use, 15-minute TTL.                  */
/* ------------------------------------------------------------------ */

app.put('/u/:token', async (req, res) => {
  const { token } = req.params
  const ticket = beginTicketUpload(token)
  if (!ticket)
    return res
      .status(410)
      .json({ error: 'invalid, expired or already-used upload ticket — request a new one via the upload_asset tool' })
  let success = false
  try {
    /* on any early rejection, destroy the request stream — otherwise curl
       keeps sending a body nobody reads and the connection deadlocks */
    if (Number(req.headers['content-length'] || 0) > MAX_ASSET_BYTES) {
      res.status(413).json({ error: 'file exceeds the 5 MB limit' })
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      total += (chunk as Buffer).length
      if (total > MAX_ASSET_BYTES) {
        res.status(413).json({ error: 'file exceeds the 5 MB limit' })
        req.destroy()
        return
      }
      chunks.push(chunk as Buffer)
    }
    const asset = await createAsset(Buffer.concat(chunks), {
      canvasId: ticket.canvasId,
      ownerId: ticket.ownerId,
      uploadedBy: ticket.uploadedBy,
    })
    success = true
    const url = `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`
    res.json({
      ok: true,
      url,
      mime: asset.mime,
      size_bytes: asset.size,
      usage: `<img src="${url}" alt="">`,
      note: 'Permanent public URL — reference it in frame HTML.',
    })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'upload failed' })
  } finally {
    endTicketUpload(token, success)
  }
})

/* better-auth handles /api/auth/* — mounted before express.json (it reads
   the raw body itself) and before the session gate below. Being mounted
   earlier means it also escapes the read-only rule on /api, so an admin
   who is viewing as someone else is filtered here instead:
     - the MCP OAuth flow authorises off the browser session, so it would
       mint a long-lived agent token belonging to the person being viewed,
       outliving the 15-minute view-as session entirely;
     - every other write (update-user, change-email, revoke-sessions, …)
       would edit the account of the person being viewed while the banner
       says "read only".
   An allowlist, not a blocklist: whatever endpoints a future better-auth
   plugin adds are refused by default rather than discovered later. */
const MCP_OAUTH_PATHS = /^\/api\/auth\/(mcp\/|oauth2\/(authorize|consent|token))/
const VIEW_AS_ALLOWED = /^\/api\/auth\/(sign-out|admin\/stop-impersonating)$/
app.all('/api/auth/*', async (req, res, next) => {
  const restricted = MCP_OAUTH_PATHS.test(req.path) || (req.method !== 'GET' && !VIEW_AS_ALLOWED.test(req.path))
  if (restricted) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null)
    if (session && (session.session as { impersonatedBy?: string | null }).impersonatedBy) {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
  }
  toNodeHandler(auth)(req, res).catch(next)
})

app.use(express.json({ limit: '10mb' }))

/* Public: does an account exist for this email? Drives the login page's
   "no account found — sign up instead" prompt. Existence is already
   observable through signup's "user already exists" error, so this
   endpoint reveals nothing new. */
app.post('/api/account-exists', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const [row] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  res.json({ exists: !!row })
})

/* Public: is SSO configured, and what should the login button say? Static
   build shared across self-hosted deploys can't know this at build time —
   see server/auth.ts loginProvidersConfig for what's safe to expose here. */
app.get('/api/oidc-config', (req, res) => {
  res.json(loginProvidersConfig())
})

/* ------------------------------------------------------------------ */
/* Design sync ingest: the doop-sync snippet on a foreign origin posts */
/* DOM snapshots here. The canvas-scoped write-only secret in the path */
/* is the whole credential (no cookies), so this stays outside the     */
/* /api session gate and answers its own CORS preflight. The route-    */
/* level parser also accepts text/plain — that's what sendBeacon      */
/* sends when a page unloads mid-capture.                              */
/* ------------------------------------------------------------------ */

app.options('/ingest/:key', (_req, res) => {
  ingest.setIngestCors(res)
  res.status(204).end()
})

app.post('/ingest/:key', express.json({ limit: '10mb', type: () => true }), (req, res) => {
  ingest.handleIngest(req, res).catch((err) => {
    console.error('[ingest] failed', err)
    if (!res.headersSent) res.status(500).json({ error: 'sync failed' })
  })
})

/* everything else under /api requires a logged-in user; the session's user
   is authoritative for names — clients don't get to pick who they are */
interface SessionUser {
  id: string
  name: string
  email: string
  role?: string | null
}
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser
      /** admin's user id when this session is a "view as" — see /api/admin */
      impersonatedBy?: string
    }
  }
}
app.use('/api', async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    req.user = session.user
    req.impersonatedBy = (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? undefined
    /* Viewing as someone else is read-only, full stop. Every doop mutation is
       a non-GET REST call — the websocket after `join` carries only cursor,
       editing and frame:drag — so this single rule covers the whole surface.
       better-auth's own routes are mounted earlier (/api/auth/*), so signing
       out and stop-impersonating are unaffected. */
    if (req.impersonatedBy && req.method !== 'GET') {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
    next()
  } catch (err) {
    next(err)
  }
})

app.get('/api/me', async (req, res) => {
  const { id, name, email } = req.user!
  res.json({
    id,
    name,
    email,
    admin: isAdmin(req.user),
    /* the SPA cannot infer this: impersonation swaps the session cookie
       outright, so everything else on this response describes the person
       being viewed, not the admin doing the viewing */
    impersonating: req.impersonatedBy ? { byName: (await getUserName(req.impersonatedBy)) ?? 'an admin' } : undefined,
  })
})

/* Canvas access on the REST surface: resolve the canvas (or the frame's
   canvas) and run it through canAccessCanvas before touching anything.
   Both helpers write the error response themselves and return null. */
function requireCanvas(req: express.Request, res: express.Response, canvasId: string) {
  const c = store.getCanvas(canvasId)
  if (!c) {
    res.status(404).json({ error: 'not found' })
    return null
  }
  if (!canAccessCanvas(req.user!.id, c)) {
    res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
    return null
  }
  return c
}

function requireFrame(req: express.Request, res: express.Response, frameId: string) {
  const frame = store.getFrame(frameId)
  if (!frame) {
    res.status(404).json({ error: 'frame not found' })
    return null
  }
  const c = store.getCanvas(frame.canvasId)
  if (!c || !canAccessCanvas(req.user!.id, c)) {
    res.status(403).json({ error: 'this canvas is private — ask the owner for access' })
    return null
  }
  return frame
}

app.use('/api/admin', adminRouter)
app.use('/api/community', communityRouter)

/* ---- the MCP clients a user has connected.

   The token IS the credential, so deleting the rows is the whole revocation:
   the next tool call gets a 401 and re-runs the approval flow. Never touches
   oauth_application — that row is shared across users. */

app.get('/api/mcp-agents', async (req, res) => {
  const mine = await db
    .select({
      clientId: authSchema.oauthAccessToken.clientId,
      expiresAt: authSchema.oauthAccessToken.accessTokenExpiresAt,
    })
    .from(authSchema.oauthAccessToken)
    .where(eq(authSchema.oauthAccessToken.userId, req.user!.id))
  const clientIds = [...new Set(mine.map((r) => r.clientId))]
  const apps = clientIds.length
    ? await db
        .select({ clientId: authSchema.oauthApplication.clientId, name: authSchema.oauthApplication.name })
        .from(authSchema.oauthApplication)
        .where(inArray(authSchema.oauthApplication.clientId, clientIds))
    : []
  res.json(groupClients(mine, new Map(apps.map((a) => [a.clientId, a.name]))))
})

app.delete('/api/mcp-agents/:clientId', async (req, res) => {
  const revoked = await db
    .delete(authSchema.oauthAccessToken)
    .where(
      and(
        eq(authSchema.oauthAccessToken.clientId, req.params.clientId),
        eq(authSchema.oauthAccessToken.userId, req.user!.id),
      ),
    )
    .returning({ id: authSchema.oauthAccessToken.id })
  res.json({ ok: true, revoked: revoked.length })
})

/* ---- the user's own model account: what the server-side model work runs on
   (image generation, repository recon, distillation). Tokens live server-side
   and are never returned. */

/* Every route that returns an account status returns the SAME shape: the
   client re-renders straight from the response, so dropping the model list on
   a PATCH would collapse the picker until the next reload. */
function accountView(status: modelAccounts.AccountStatus) {
  return { ...status, chatgptEnabled: modelAccounts.chatgptConnectEnabled(), models: AGENT_MODELS }
}

app.get('/api/model-account', (req, res) => {
  modelAccounts
    .getStatus(req.user!.id)
    .then((status) => res.json(accountView(status)))
    .catch(() => res.status(500).json({ error: 'account status unavailable' }))
})

/* which model tier the connected account runs on */
app.patch('/api/model-account', async (req, res) => {
  try {
    res.json(accountView(await modelAccounts.setAccountModel(req.user!.id, String(req.body?.model ?? ''))))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not change the model' })
  }
})

/* OpenAI's only registered redirect is a loopback URL, so the browser's
   callback is reachable by us exactly when the browser is on this machine.
   A forwarded request came through a proxy and is by definition not. */
function isSameMachine(req: express.Request): boolean {
  if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false
  const ip = req.socket.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/* step 1 of the ChatGPT flow: hand back the OpenAI authorize URL to open.
   `catching` tells the client we will pick the redirect up ourselves, so it
   can poll instead of asking the user to copy anything. */
app.post('/api/model-account/chatgpt/authorize', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  const started = modelAccounts.beginChatgptAuth(req.user!.id)
  const catching = isSameMachine(req) ? await modelAccounts.startCallbackCatcher() : false
  res.json({ ...started, catching })
})

/* step 2: the user pastes the redirect URL they landed on; we do the code
   exchange server-side, so the browser never handles a token */
app.post('/api/model-account/chatgpt', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  try {
    res.json(accountView(await modelAccounts.completeChatgptAuth(req.user!.id, String(req.body?.redirect ?? ''))))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not connect that ChatGPT account' })
  }
})

/* device flow: no redirect URI at all, so it works wherever Doop is hosted.
   We poll OpenAI in the background; the browser polls the status below. */
app.post('/api/model-account/chatgpt/device', async (req, res) => {
  if (!modelAccounts.chatgptConnectEnabled()) {
    return res.status(404).json({ error: 'ChatGPT connections are disabled on this server' })
  }
  try {
    res.json(await modelAccounts.beginDeviceAuth(req.user!.id))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not start a device sign-in' })
  }
})

app.get('/api/model-account/chatgpt/device', (req, res) => {
  res.json(modelAccounts.deviceAuthStatus(req.user!.id) ?? { status: 'none' })
})

app.delete('/api/model-account/chatgpt/device', (req, res) => {
  modelAccounts.cancelDeviceAuth(req.user!.id)
  res.json({ ok: true })
})

app.post('/api/model-account/openai-key', async (req, res) => {
  try {
    res.json(accountView(await modelAccounts.connectApiKey(req.user!.id, String(req.body?.apiKey ?? ''))))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not save that API key' })
  }
})

app.delete('/api/model-account', async (req, res) => {
  await modelAccounts.disconnect(req.user!.id)
  res.json(accountView({ connected: false }))
})

app.get('/api/canvases', (req, res) =>
  res.json(
    store.listCanvases(req.user!.id).map((c) => {
      /* which agents have worked on this canvas (most recent first) — the run
         timeline is the record of agent work, newest first, so the first event
         seen for a name is that agent's latest */
      const seen = new Map<string, number>()
      for (const e of runLog.getRunEvents(c.id)) {
        if (!seen.has(e.agentName)) seen.set(e.agentName, e.at)
      }
      return { ...c, agents: [...seen].slice(0, 8).map(([name, lastAt]) => ({ name, lastAt })) }
    }),
  ),
)

app.post('/api/canvases', (req, res) => {
  const name = String(req.body?.name || 'Untitled canvas')
  res.json(store.createCanvas(name, req.user!.id))
})

app.post('/api/canvases/:id/duplicate', async (req, res) => {
  const source = store.getCanvas(req.params.id)
  if (!source) return res.status(404).json({ error: 'not found' })
  if (!hasDurableCanvasAccess(req.user!.id, source)) return res.status(403).json({ error: 'access denied' })
  try {
    const copy = await store.duplicateCanvas(source.id, req.user!.id, req.user!.name)
    res.json(copy)
  } catch (error) {
    console.error('[canvas] duplicate failed', error)
    res.status(500).json({ error: 'could not duplicate canvas' })
  }
})

app.get('/api/canvases/:id', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (c) res.json(c)
})

/* Community gallery listing — the owner's call alone, like link access.
   PUT both lists and re-describes; DELETE takes it down. `releaseId` pins the
   listing to a frozen release (null clears the pin), so what a visitor sees
   stops moving when the canvas does. */
app.put('/api/canvases/:id/publish', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const listing = parseListing(req.body)
  if (typeof listing === 'string') return res.status(400).json({ error: listing })
  const pinned = req.body?.releaseId
  if (pinned !== undefined && pinned !== null && typeof pinned !== 'string')
    return res.status(400).json({ error: 'releaseId must be a release id, or null to unpin' })
  let release: { id: string; frames: Frame[] } | undefined
  if (typeof pinned === 'string') {
    const found = await persist.getRelease(pinned)
    if (!found || found.canvasId !== c.id) return res.status(404).json({ error: 'no such release on this canvas' })
    release = { id: found.id, frames: persist.releaseFrames(found) }
  }
  const result = publishCanvas(c, listing, { id: req.user!.id, name: req.user!.name }, release)
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  const { publishedAt, description, category, publishedReleaseId } = result.canvas
  res.json({ publishedAt, description, category, releaseId: publishedReleaseId ?? null })
})

app.delete('/api/canvases/:id/publish', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const result = unpublishCanvas(c, { id: req.user!.id, name: req.user!.name })
  if (!result.ok) return res.status(result.status).json({ error: result.error })
  res.json({ ok: true })
})

/* ---- releases: the frozen snapshots a handoff link points at ----
   Frames are a projection — id, name and size only — because a list route
   must never ship a canvas's documents (they can be megabytes each); the
   snapshot itself lives in the release row and renders at /p/<canvas>/<release>. */

const releaseView = (release: persist.CanvasRelease): CanvasRelease => ({
  id: release.id,
  canvasId: release.canvasId,
  name: release.name,
  url: `${PUBLIC_ORIGIN}/p/${release.canvasId}/${release.id}`,
  frames: release.frames.map((frame) => ({
    id: frame.id,
    name: frame.name,
    width: frame.width,
    height: frame.height,
  })),
  createdAt: release.createdAt,
  createdBy: release.createdBy,
})

app.get('/api/canvases/:id/releases', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  res.json({ releases: (await persist.listReleases(c.id)).map(releaseView) })
})

/** Freeze the canvas as it is now — the same snapshot the MCP create_release
 *  tool writes, so a release made in the UI and one made by an agent are the
 *  same artifact. */
app.post('/api/canvases/:id/releases', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const frames = c.frames.filter((frame) => !frame.demo)
  if (!frames.length)
    return res.status(400).json({ error: 'add a frame before releasing — there is nothing to freeze' })
  const label = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
  const release: persist.CanvasRelease = {
    id: nanoid(10),
    canvasId: c.id,
    name: label || `Release ${new Date().toISOString().slice(0, 10)}`,
    frames: frames.map((frame) => ({
      id: frame.id,
      name: frame.name,
      width: frame.width,
      height: frame.height,
      x: frame.x,
      y: frame.y,
      html: frame.html,
      ...(frame.pageId ? { pageId: frame.pageId } : {}),
    })),
    ...(c.tokens ? { tokens: c.tokens } : {}),
    createdAt: Date.now(),
    createdBy: req.user!.name,
  }
  await persist.saveRelease(release)
  actions.logActivity(c.id, resolveActorFromReq(req), `released “${release.name}” (${release.frames.length} frames)`)
  res.json(releaseView(release))
})

/** Put a release's frames back on the live canvas, as ordinary edits: every
 *  write goes through the same actions a human edit does, so the restore is
 *  logged, streamed to the room and reversible frame by frame. Frames that no
 *  longer exist are recreated; frames added since are left alone. */
app.post('/api/canvases/:id/releases/:releaseId/restore', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const release = await persist.getRelease(req.params.releaseId)
  if (!release || release.canvasId !== c.id) return res.status(404).json({ error: 'release not found' })
  const actor = resolveActorFromReq(req)
  let restored = 0
  try {
    for (const snapshot of release.frames) {
      const live = store.getFrame(snapshot.id)
      if (!live) {
        actions.createFrame(
          c.id,
          {
            name: snapshot.name,
            html: snapshot.html,
            width: snapshot.width,
            height: snapshot.height,
            ...(snapshot.pageId ? { pageId: snapshot.pageId } : {}),
          },
          actor,
        )
        restored += 1
        continue
      }
      if (live.html === snapshot.html) continue
      actions.updateFrame(
        snapshot.id,
        { html: snapshot.html, name: snapshot.name, width: snapshot.width, height: snapshot.height },
        actor,
      )
      restored += 1
    }
  } catch (e) {
    /* a locked frame or a review-mode refusal: nothing was half-applied that a
       human cannot see in the activity feed, and the reason is theirs to read */
    return res.status(409).json({ error: e instanceof Error ? e.message : 'the restore was refused' })
  }
  if (restored === 0) return res.status(409).json({ error: 'every frame already matches this release' })
  actions.logActivity(c.id, actor, `restored “${release.name}” (${restored} frames)`)
  res.json({ ok: true })
})

/* ---- ship: the download the Export button hands a human, and the design
   opened as a pull request against a connected repo ---- */

/** The canvas as one archive: every frame's document, a single-page render of
 *  all of them, the design system in three forms and the assets the frames
 *  reference, so the download renders offline. */
async function canvasArchive(canvas: Canvas): Promise<Buffer> {
  const frames = canvas.frames.filter((frame) => !frame.demo)
  const tokens = canvas.tokens
  const bundle = await htmlBundle(frames, tokens)
  const bundled: { name: string; content: Buffer }[] = []
  for (const id of [...new Set(frames.flatMap((frame) => [...extractAssetIds(frame.html)]))]) {
    const asset = await getCanvasAsset(canvas.id, id)
    if (asset) bundled.push({ name: `assets/${asset.url.replace(/^\/a\//, '')}`, content: asset.data })
  }
  return buildZip([
    { name: 'canvas.html', content: rewriteAssetUrls(bundle.html, '').html },
    ...(bundle.fontsCss ? [{ name: 'fonts.css', content: bundle.fontsCss }] : []),
    ...bundled,
    ...(tokens
      ? [
          { name: 'tokens.css', content: cssForTokens(tokens) },
          { name: 'tokens.json', content: tokensJson(tokens) },
          { name: 'tokens.dtcg.json', content: tokensDtcg(tokens) },
          { name: 'tailwind.css', content: tailwindThemeCss(tokens) },
        ]
      : []),
    {
      name: 'DESIGN.md',
      content: designMd(tokens, canvas, (frame) => `frames/${handoffFileName(frame, frames)}.html`),
    },
    { name: 'AGENTS.md', content: agentsMd(canvas, `${PUBLIC_ORIGIN}/mcp`) },
    ...frames.map((frame) => ({
      name: `frames/${handoffFileName(frame, frames)}.html`,
      content: rewriteAssetUrls(frame.html, '../').html,
    })),
  ])
}

/** The same archive the MCP `code` export returns: the repository file set
 *  open_pull_request commits — documents, React components, build specs, the
 *  component library and the design system. */
async function codeArchive(canvas: Canvas): Promise<Buffer> {
  const handoff = await handoffFiles(canvas.id)
  return buildZip(handoff.files.map((file) => ({ name: file.path, content: file.content })))
}

app.post('/api/canvases/:id/export', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const format = req.body?.format
  if (format !== 'zip' && format !== 'code') return res.status(400).json({ error: 'format must be "zip" or "code"' })
  if (!c.frames.some((frame) => !frame.demo))
    return res.status(400).json({ error: 'this canvas has no frames to export' })
  try {
    const archive = format === 'code' ? await codeArchive(c) : await canvasArchive(c)
    /* stored exactly as the MCP export stores it: an asset row plus the public
       /a/<id>.<ext> URL the download button opens */
    const asset = await createAsset(archive, { canvasId: c.id, ownerId: req.user!.id, uploadedBy: req.user!.name })
    res.json({ url: `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}` })
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'the export failed' })
  }
})

/** Open the handoff pull request: commit the exported file set to a branch of
 *  a connected repo and open (or find) the pull request for it. The same two
 *  halves the MCP open_pull_request tool runs, on the connection the canvas
 *  has for that repo. */
app.post('/api/canvases/:id/pull-request', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : ''
  if (!repo) return res.status(400).json({ error: 'repo is required — connect the repository first' })
  const base = typeof req.body?.base === 'string' ? req.body.base.trim() : ''
  const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 200) : ''
  const head = `doop/${c.id}`
  try {
    const handoff = await handoffFiles(c.id)
    const connections = await github.listConnections(c.id)
    const baseRef = base || connections.find((conn) => conn.repo.toLowerCase() === repo.toLowerCase())?.branch || 'main'
    const commit = await commitToBranch({
      repo,
      baseRef,
      headRef: head,
      files: handoff.files,
      message: message || handoff.pr.title,
      canvasId: c.id,
    })
    const pull = await ensurePullRequest({
      repo,
      baseRef,
      headRef: head,
      title: message || handoff.pr.title,
      body: handoff.pr.body,
      canvasId: c.id,
    })
    actions.logActivity(c.id, resolveActorFromReq(req), `opened pull request #${pull.number} on ${repo}`)
    res.json({ url: pull.url, number: pull.number, commit: commit.commitSha })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'the handoff failed' })
  }
})

/** Push the canvas's later changes onto the pull request already open: commit
 *  again onto the same branch and say so in the conversation. A canvas with no
 *  open pull request for that branch pair is a 404 — this updates, it does not
 *  open. */
app.post('/api/canvases/:id/pull-request/update', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : ''
  if (!repo) return res.status(400).json({ error: 'repo is required' })
  const message = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 200) : ''
  const head = `doop/${c.id}`
  try {
    const handoff = await handoffFiles(c.id)
    const connections = await github.listConnections(c.id)
    const baseRef =
      (typeof req.body?.base === 'string' ? req.body.base.trim() : '') ||
      connections.find((conn) => conn.repo.toLowerCase() === repo.toLowerCase())?.branch ||
      'main'
    const line = message || `Design update: ${c.name}`
    const commit = await commitToBranch({
      repo,
      baseRef,
      headRef: head,
      files: handoff.files,
      message: line,
      canvasId: c.id,
    })
    const pull = await ensurePullRequest({
      repo,
      baseRef,
      headRef: head,
      title: handoff.pr.title,
      body: handoff.pr.body,
      canvasId: c.id,
    })
    if (pull.created)
      return res.status(404).json({ error: `no pull request was open for ${head} → ${baseRef} on ${repo}` })
    await commentPullRequest({
      repo,
      prNumber: pull.number,
      body: [line, '', handoff.pr.body, '', `Committed \`${commit.commitSha.slice(0, 7)}\` to \`${head}\`.`].join('\n'),
      canvasId: c.id,
    })
    actions.logActivity(c.id, resolveActorFromReq(req), `updated pull request #${pull.number} on ${repo}`)
    res.json({ url: pull.url, number: pull.number, commit: commit.commitSha })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'the pull request update failed' })
  }
})

/* A release is a frozen artifact: the URL a handoff link points at. No
   session, no access check — the id is unguessable and the snapshot cannot
   change, which is exactly what makes it safe to send to someone. */
app.get('/p/:canvasId/:releaseId', async (req, res) => {
  const release = await persist.getRelease(req.params.releaseId)
  if (!release || release.canvasId !== req.params.canvasId) return res.status(404).send('no such release')
  try {
    const bundle = await htmlBundle(persist.releaseFrames(release), release.tokens)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    /* Stored frame HTML on the app's own origin: same lockdown an imported or
       synced snapshot gets, or an inline handler in any frame runs with the
       viewer's session when the link is opened. */
    res.setHeader('Content-Security-Policy', SNAPSHOT_CSP)
    res.send(bundle.html)
  } catch (e) {
    res.status(500).send(e instanceof Error ? e.message : 'could not render this release')
  }
})

app.post('/api/canvases/:id/claim', (req, res) => {
  const c = store.claimCanvas(req.params.id, req.user!.id)
  if (!c) return res.status(409).json({ error: 'not found or already owned' })
  res.json({ ok: true })
})

/* recent activity across all of the user's canvases, for the home dashboard */
app.get('/api/home/activity', (req, res) => {
  const canvases = store.listCanvases(req.user!.id)
  const items = canvases.flatMap((c) =>
    actions
      .getActivity(c.id)
      .slice(0, 20)
      .map((a) => ({ ...a, canvasId: c.id, canvasName: c.name })),
  )
  items.sort((a, b) => b.at - a.at)
  res.json(items.slice(0, 14))
})

app.delete('/api/canvases/:id', (req, res) => {
  const c = store.getCanvas(req.params.id)
  if (!c) return res.status(404).json({ error: 'not found' })
  /* only the owner may delete; unclaimed (legacy) canvases are reachable
     only by direct link and must be claimed before they can be destroyed */
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: c.ownerId ? 'not yours' : 'claim it first' })
  actions.deleteCanvas(c.id)
  res.json({ ok: true })
})

app.patch('/api/canvases/:id', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const { name, linkAccess } = req.body ?? {}
  /* the link policy is the owner's alone — collaborators can rename, not lock */
  if (linkAccess !== undefined) {
    if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can change link access' })
    if (linkAccess !== 'edit' && linkAccess !== 'none')
      return res.status(400).json({ error: 'linkAccess must be "edit" or "none"' })
    store.setLinkAccess(c.id, linkAccess)
  }
  if (typeof name === 'string' && name.trim()) {
    const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
    actions.renameCanvas(c.id, name.trim(), actor)
  }
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* Collaborators: Figma-style invites. The owner invites existing doop */
/* accounts by email; members get full edit access regardless of the   */
/* link setting. Management is owner-only (members may remove          */
/* themselves); the people list is visible to anyone with access.      */
/* ------------------------------------------------------------------ */

app.get('/api/canvases/:id/members', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const ids = [...(c.ownerId ? [c.ownerId] : []), ...(c.memberIds ?? [])]
  const rows = ids.length
    ? await db
        .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
        .from(authSchema.user)
        .where(inArray(authSchema.user.id, ids))
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  res.json(
    ids.map((id) => ({
      userId: id,
      name: byId.get(id)?.name ?? 'Unknown',
      email: byId.get(id)?.email ?? '',
      owner: id === c.ownerId,
    })),
  )
})

app.post('/api/canvases/:id/members', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can invite people' })
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const [row] = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  if (!row) return res.status(404).json({ error: 'no doop account with that email — ask them to sign up first' })
  if (row.id === c.ownerId) return res.status(400).json({ error: 'the owner already has access' })
  store.addMember(c.id, row.id, req.user!.id)
  res.json({ userId: row.id, name: row.name, email: row.email, owner: false })
})

app.delete('/api/canvases/:id/members/:userId', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (c.ownerId !== req.user!.id && req.params.userId !== req.user!.id)
    return res.status(403).json({ error: 'only the owner can remove collaborators' })
  if (!store.removeMember(c.id, req.params.userId)) return res.status(404).json({ error: 'not a collaborator' })
  res.json({ ok: true })
})

/* ---- design-sync keys: mint/list/revoke the write-only snippet creds.
   Owner and invited members only — NOT link-edit visitors. A key is a
   durable bearer credential, so someone whose access is only the share
   link must not be able to mint one (or read an existing secret) and
   keep writing frames after the owner turns the link off. */

function requireDurableCanvas(req: express.Request, res: express.Response, canvasId: string) {
  const c = requireCanvas(req, res, canvasId)
  if (!c) return null
  if (!hasDurableCanvasAccess(req.user!.id, c)) {
    res.status(403).json({ error: 'sync keys are managed by the owner and invited members' })
    return null
  }
  return c
}

app.get('/api/canvases/:id/sync-keys', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const keys = await ingest.listSyncKeys(c.id)
  res.json(keys.map((k) => ({ ...k, frames: ingest.syncedFrameCount(c, k.id) })))
})

app.post('/api/canvases/:id/sync-keys', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const key = await ingest.createSyncKey(c.id, String(req.body?.name ?? ''), req.user!.id)
  res.json({ ...key, frames: 0 })
})

/* the flow map is design insight, not a credential — anyone who can see the
   frames can see how they connect */
app.get('/api/canvases/:id/sync-flow', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  res.json(await ingest.getSyncFlow(c))
})

app.delete('/api/canvases/:id/sync-keys/:keyId', async (req, res) => {
  if (!requireDurableCanvas(req, res, req.params.id)) return
  if (!(await ingest.deleteSyncKey(req.params.id, req.params.keyId)))
    return res.status(404).json({ error: 'sync key not found' })
  res.json({ ok: true })
})

/* ---- GitHub import source: connect a repo, enumerate its screens, land the
   selected ones as frames. Same durable-access rule as sync keys — the
   stored PAT is a standing credential, so link-edit visitors must not be
   able to create or exercise a connection. Tokens never leave the server. */

app.get('/api/canvases/:id/github', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const connections = await github.listConnections(c.id)
  res.json(
    connections.map((conn) => ({ ...github.connectionInfo(conn), frames: github.importedFrameCount(c, conn.id) })),
  )
})

app.post('/api/canvases/:id/github', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  try {
    /* app mode: a signed pass from the install round-trip stands in for the
       token, binding the GitHub App installation to this canvas */
    let installationId: string | undefined
    if (typeof req.body?.pass === 'string') {
      const verified = githubApp.verifyInstallPass(req.body.pass, c.id)
      if (!verified) return res.status(400).json({ error: 'the GitHub install handoff expired — connect again' })
      installationId = verified.installationId
    }
    const conn = await github.createConnection({
      canvasId: c.id,
      repo: String(req.body?.repo ?? ''),
      token: typeof req.body?.token === 'string' ? req.body.token : undefined,
      installationId,
      branch: typeof req.body?.branch === 'string' ? req.body.branch : undefined,
      createdBy: req.user!.id,
    })
    res.json({ ...github.connectionInfo(conn), frames: 0 })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not connect the repository' })
  }
})

/* ---- GitHub App install flow: click Connect on the canvas, pick repos on
   GitHub's install screen, land back on the canvas with a repo picker. The
   signed state/pass pair keeps guessable installation ids from being bound
   to canvases that never started an install (server/githubApp.ts). */

app.get('/api/github/app', (req, res) => {
  res.json({ enabled: githubApp.appEnabled(), slug: githubApp.appSlug() })
})

app.post('/api/canvases/:id/github/app/start', (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  if (!githubApp.appEnabled()) return res.status(400).json({ error: 'the GitHub App is not configured' })
  res.json({ url: githubApp.installUrl(githubApp.signInstallState(c.id, req.user!.id)) })
})

/* GitHub's post-install redirect (the app's callback URL, with "request
   user authorization during installation" on). Verifies the state minted at
   start AND that the OAuth code's user actually owns the installation —
   installation ids are guessable, and without the ownership proof a valid
   state could bind someone else's installation. Then swaps state for a pass
   and returns to the canvas, where the import modal shows the repo picker. */
app.get('/api/github/app/setup', async (req, res) => {
  const rawState = String(req.query.state ?? '')
  const code = String(req.query.code ?? '')
  /* failures land back on the canvas with a visible reason — a silent
     homepage redirect reads as "nothing happened" */
  const fail = (canvasId: string, reason: string) =>
    res.redirect(`/c/${encodeURIComponent(canvasId)}?ghError=${encodeURIComponent(reason)}`)
  const succeed = (canvasId: string, installationId: string) =>
    res.redirect(
      `/c/${encodeURIComponent(canvasId)}?ghInstall=${encodeURIComponent(githubApp.signInstallPass(canvasId, installationId))}`,
    )

  /* return leg of the already-installed bounce: the authorize round-trip
     produced the code the configure screen didn't */
  const oauth = githubApp.verifyOauthState(rawState)
  if (oauth) {
    try {
      if (await githubApp.verifyInstallationOwner(code, oauth.installationId))
        return succeed(oauth.canvasId, oauth.installationId)
    } catch {
      /* fall through to the error redirect */
    }
    return fail(oauth.canvasId, 'GitHub couldn’t confirm you own that installation — try connecting again')
  }

  const state = githubApp.verifyInstallState(rawState)
  if (!state) return res.redirect('/')
  const installationId = String(req.query.installation_id ?? '')
  if (!/^\d+$/.test(installationId))
    return fail(state.canvasId, 'GitHub sent no installation back — try connecting again')

  /* app already installed on that account: GitHub showed the configure
     screen and returned WITHOUT an OAuth code — bounce through authorize
     (instant for an already-authorized user) purely to get one */
  if (!code) return res.redirect(githubApp.oauthBounceUrl(githubApp.signOauthState(state.canvasId, installationId)))

  try {
    if (await githubApp.verifyInstallationOwner(code, installationId)) return succeed(state.canvasId, installationId)
  } catch {
    /* fall through to the error redirect */
  }
  return fail(state.canvasId, 'GitHub couldn’t confirm you own that installation — try connecting again')
})

app.get('/api/canvases/:id/github/app/repos', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const verified = githubApp.verifyInstallPass(String(req.query.pass ?? ''), c.id)
  if (!verified) return res.status(400).json({ error: 'the GitHub install handoff expired — connect again' })
  try {
    res.json(await githubApp.listInstallationRepos(verified.installationId))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not list the installation’s repositories' })
  }
})

app.delete('/api/canvases/:id/github/:connId', async (req, res) => {
  if (!requireDurableCanvas(req, res, req.params.id)) return
  if (!(await github.deleteConnection(req.params.id, req.params.connId)))
    return res.status(404).json({ error: 'connection not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/github/:connId/analyze', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const conn = await github.getConnection(c.id, req.params.connId)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  try {
    res.json(await github.analyzeConnection(conn))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'repository analysis failed' })
  }
})

/* one import at a time per repo connection — see the route */
const connectionLocks = new Map<string, Promise<unknown>>()
async function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = connectionLocks.get(connectionId) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  connectionLocks.set(connectionId, tail)
  try {
    return await run
  } finally {
    if (connectionLocks.get(connectionId) === tail) connectionLocks.delete(connectionId)
  }
}

app.post('/api/canvases/:id/github/:connId/import', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
  if (!c) return
  const conn = await github.getConnection(c.id, req.params.connId)
  if (!conn) return res.status(404).json({ error: 'connection not found' })
  if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
  const rawScreens = Array.isArray(req.body?.screens) ? (req.body.screens as unknown[]) : []
  try {
    /* the selection is resolved against a manifest computed right now — see
       matchSelection for why the client never dictates paths */
    const { screens, rejected } = github.matchSelection((await github.analyzeConnection(conn)).screens, rawScreens)
    const actor = resolveActorFromReq(req)
    /* one import at a time per connection: overlapping imports of the same
       screens would both place frames at the same grid slot */
    const outcome = await withConnectionLock(conn.id, async () => {
      const imported: { id: string; name: string }[] = []
      const needsAgent: string[] = []
      for (const screen of screens) {
        try {
          /* a static screen lands its repo HTML verbatim; one that exists only
             as code comes back as its source closure, for an agent to design
             from through import_repo_screen */
          const landed = await importRepoScreen(c.id, conn, screen, actor)
          if (landed.kind === 'frame') imported.push({ id: landed.frame.id, name: landed.frame.name })
          else needsAgent.push(screen.title)
        } catch {
          /* a fetch failure on one screen must not lose the rest of the import */
          rejected.push(screen.route || screen.sourcePath)
        }
      }
      if (imported.length) github.markSynced(conn.id)
      return { imported, needsAgent }
    })
    res.json({ imported: outcome.imported, rejected, needsAgent: outcome.needsAgent })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'import failed' })
  }
})

/* upsert a named design doc; empty markdown deletes it (same permission
   model as rename: any signed-in user with access) */
/* doc history, newest first — '' markdown rows mark deletions */
app.get('/api/canvases/:id/guidelines/:name/history', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const rows = await persist.listGuidelineVersions(req.params.id, req.params.name.toLowerCase())
  res.json(rows.map((v) => ({ markdown: v.markdown, savedAt: v.savedAt, savedBy: v.savedBy })))
})

app.put('/api/canvases/:id/guidelines/:name', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const { markdown, x, y, title } = req.body ?? {}
  /* no markdown = metadata patch (position/title): content and history untouched */
  if (markdown === undefined) {
    const patch = {
      ...(x !== undefined || y !== undefined ? { x: Number(x), y: Number(y) } : {}),
      ...(typeof title === 'string' ? { title } : {}),
    }
    if (!actions.patchGuideline(req.params.id, req.params.name, patch, actor))
      return res.status(404).json({ error: 'not found' })
    return res.json({ ok: true })
  }
  try {
    const pos = typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined
    const doc = actions.setGuideline(
      req.params.id,
      req.params.name,
      String(markdown ?? ''),
      actor,
      pos,
      typeof title === 'string' ? title : undefined,
    )
    if (doc === undefined) return res.status(404).json({ error: 'not found' })
    res.json(doc ? { ok: true, doc } : { ok: true, deleted: true })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid doc' })
  }
})

/* design memory: pin/unpin reference frames, accept/dismiss rule proposals */
app.post('/api/canvases/:id/references', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  try {
    const ref = actions.pinReference(req.params.id, String(req.body?.frameId ?? ''), actor)
    if (!ref) return res.status(404).json({ error: 'canvas or frame not found' })
    res.json(ref)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'pin failed' })
  }
})

app.delete('/api/canvases/:id/references/:refId', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  if (!actions.unpinReference(req.params.id, req.params.refId, actor))
    return res.status(404).json({ error: 'reference not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/proposals/:pid', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const proposal = actions.resolveProposal(req.params.id, req.params.pid, !!req.body?.accept, actor)
  if (!proposal) return res.status(404).json({ error: 'proposal not found' })
  res.json(proposal)
})

/* Browser asset uploads (paste / drop): raw image bytes in, permanent /a/
   URL out. Same createAsset pipeline as the MCP ticket flow — the bytes are
   sniffed for the real type and capped at 5 MB. express.json ignores the
   image content-type, so express.raw here sees the untouched stream. */
app.post(
  '/api/canvases/:id/assets',
  express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1024 }),
  async (req, res) => {
    const c = requireCanvas(req, res, req.params.id)
    if (!c) return
    try {
      const asset = await createAsset(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), {
        canvasId: c.id,
        ownerId: req.user!.id,
        uploadedBy: req.user!.name,
      })
      /* absolute like the MCP flow: frame HTML renders inside sandboxed
         srcdoc iframes where root-relative URLs don't resolve */
      res.json({ url: `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`, mime: asset.mime, size: asset.size })
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : 'upload failed' })
    }
  },
)

/* ---- pages: ordered sub-canvases on a canvas ---- */

const pageName = (raw: unknown) =>
  String(raw ?? '')
    .trim()
    .slice(0, 80) || 'Untitled'

/** Owner-only canvas policy: which agent writes need approval. `reviewMode`
 *  stays the owner's on/off toggle and reads as `all_writes` while on. */
app.post('/api/canvases/:id/review-policy', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const canvas = store.getCanvas(req.params.id)!
  if (canvas.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can change review policy' })
  const policy = req.body?.policy
  if (policy !== 'off' && policy !== 'destructive' && policy !== 'all_writes')
    return res.status(400).json({ error: "policy must be 'off', 'destructive' or 'all_writes'" })
  const tools = Array.isArray(req.body?.approval_tools)
    ? req.body.approval_tools.filter((t: unknown) => typeof t === 'string' && t).slice(0, 50)
    : []
  const actor = resolveActorFromReq(req)
  const updated = actions.setCanvasReviewPolicy(req.params.id, policy, tools, actor)
  if (!updated) return res.status(404).json({ error: 'canvas not found' })
  res.json({ reviewPolicy: updated.reviewPolicy ?? 'off', approvalTools: updated.approvalTools ?? [] })
})

/** Owner-only canvas setting: agent frame writes land as proposals. */
app.post('/api/canvases/:id/review-mode', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const canvas = store.getCanvas(req.params.id)!
  if (canvas.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can change review mode' })
  const on = !!req.body?.on
  const actor = resolveActorFromReq(req)
  actions.setCanvasReviewMode(req.params.id, on, actor)
  res.json({ reviewMode: on })
})

/** The canvas design tokens. Any collaborator may edit them: they are the
 *  canvas's shared palette/type/scale, and the panel is where a human sets
 *  them without an agent in the loop. Validation errors come back verbatim. */
app.patch('/api/canvases/:id/tokens', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const body = req.body as { tokens?: DesignTokens | null } | undefined
  const tokens = body?.tokens ?? undefined
  /* the body is caller-controlled and `validateTokens` walks it with `?? {}`
     guards that a string sails through, so the shape is checked here */
  if (tokens !== undefined && tokens !== null && (typeof tokens !== 'object' || Array.isArray(tokens)))
    return res.status(400).json({ error: 'tokens must be an object' })
  try {
    const canvas = actions.setTokens(req.params.id, tokens ?? undefined, resolveActorFromReq(req))
    if (!canvas) return res.status(404).json({ error: 'canvas not found' })
    res.json({ tokens: canvas.tokens ?? null })
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'invalid tokens' })
  }
})

/* ---- agent review, questions, run timeline, versions, queue ---- */

/** Pending agent frame-change proposals for review mode. */
app.get('/api/canvases/:id/frame-proposals', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const status = typeof req.query.status === 'string' ? (req.query.status as FrameProposal['status']) : undefined
  res.json(actions.getFrameProposals(req.params.id, status))
})

/** Accept or reject a proposal — any collaborator with canvas access may.
 *  `note` rides back to the agent; `force` applies a proposal the stale guard
 *  would otherwise refuse; `hunks` resolves a patch-mode proposal hunk by hunk,
 *  applying only the accepted ones. */
app.post('/api/canvases/:id/frame-proposals/:pid', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined
  const hunks = Array.isArray(req.body?.hunks)
    ? (req.body.hunks as { index?: unknown; accept?: unknown }[])
        .filter((h) => typeof h?.index === 'number' && Number.isInteger(h.index))
        .map((h) => ({ index: h.index as number, accept: h.accept !== false }))
        .slice(0, 50)
    : undefined
  const outcome = actions.resolveFrameProposalDetailed(
    req.params.id,
    req.params.pid,
    !!req.body?.accept,
    resolveActorFromReq(req),
    {
      ...(note ? { note } : {}),
      ...(req.body?.force ? { force: true } : {}),
      ...(hunks?.length ? { hunks } : {}),
    },
  )
  if (!outcome) return res.status(404).json({ error: 'proposal not found' })
  /* the proposal at the top level, so the existing client read is unchanged,
     with the per-hunk outcome beside it for a reviewer that sent hunks */
  res.json({ ...outcome.proposal, applied: outcome.applied, skipped: outcome.skipped })
})

/** Withdraw one of your own pending proposals. */
app.delete('/api/canvases/:id/frame-proposals/:pid', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const proposal = actions.withdrawFrameProposal(req.params.id, req.params.pid, resolveActorFromReq(req))
  if (!proposal) return res.status(404).json({ error: 'proposal not found' })
  res.json(proposal)
})

/* ---- canvas-level review mode: the proposals that change the canvas itself
   (tokens, a guide doc, the breakpoints, the page set), and the canvas-wide
   verification sweep. */

/** Pending agent canvas-level proposals. Owner-gated resolution mirrors the
 *  frame-proposal pair below, and the MCP resolve_canvas_proposal tool. */
app.get('/api/canvases/:id/canvas-proposals', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const status = typeof req.query.status === 'string' ? (req.query.status as CanvasProposal['status']) : undefined
  res.json({ proposals: await persist.listCanvasProposals(req.params.id, status ? { status } : {}) })
})

/** Accept or reject a canvas-level proposal (owner-only — it changes the
 *  canvas's shared design system, not one frame). Accepting applies the
 *  payload through the ordinary setters, so the change versions, broadcasts
 *  and logs exactly like a human edit. */
app.post('/api/canvases/:id/canvas-proposals/:proposalId', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (c.ownerId !== req.user!.id)
    return res.status(403).json({ error: 'only the owner can resolve a canvas-level proposal' })
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined
  try {
    const proposal = await actions.resolveCanvasProposal(c.id, req.params.proposalId, {
      accept: !!req.body?.accept,
      ...(note ? { note } : {}),
      actor: { userId: req.user!.id, agentName: req.user!.name },
    })
    res.json(proposal)
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : 'proposal not found' })
  }
})

/* A sweep renders every unverified frame on the canvas, so it is the heaviest
   check the UI can ask for: a tighter budget than the per-frame route. */
const canvasReviewHits = new Map<string, number[]>()

/** Run the canvas-wide verification sweep now, on a human's word: one verdict
 *  with a row per frame, and a stored report per frame it actually checked. */
app.post('/api/canvases/:id/reviews', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const hits = (canvasReviewHits.get(req.user!.id) ?? []).filter((t) => Date.now() - t < 60_000)
  if (hits.length >= 3) return res.status(429).json({ error: 'too many sweeps, wait a minute' })
  hits.push(Date.now())
  canvasReviewHits.set(req.user!.id, hits)
  try {
    const summary = await reviewCanvas(c.id, {
      actor: { userId: req.user!.id, agentName: req.user!.name },
    })
    actions.logActivity(c.id, resolveActorFromReq(req), `ran the canvas sweep — ${summary.verdict}`)
    res.json(summary)
  } catch (e) {
    console.error('[canvas-reviews] failed', e)
    res.status(503).json({ error: e instanceof Error ? e.message : 'the sweep failed' })
  }
})

/** Agent questions (ask_human): answer or read them. */
app.get('/api/canvases/:id/questions', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const status = typeof req.query.status === 'string' ? (req.query.status as AgentQuestion['status']) : undefined
  res.json(actions.getQuestions(req.params.id, status))
})

app.post('/api/canvases/:id/questions/:qid', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  let question: AgentQuestion | undefined
  try {
    question = actions.answerQuestion(
      req.params.id,
      req.params.qid,
      String(req.body?.answer ?? ''),
      resolveActorFromReq(req),
    )
  } catch (e) {
    /* the answer was not one of the choices the asker offered: nothing is
       recorded, and the question stays open for a valid answer */
    if (e instanceof actions.InvalidAnswerError) return res.status(400).json({ error: e.message, choices: e.choices })
    throw e
  }
  if (!question) return res.status(404).json({ error: 'question not found' })
  res.json(question)
})

/** A canvas's component library, newest-updated first. */
app.get('/api/canvases/:id/components', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  res.json(actions.listComponentSummaries(req.params.id))
})

/** Delete one component. Refused with 409 while frames still hold instances,
 *  unless `force` is passed — the instances' markup is left alone either way,
 *  it simply stops being bound to a library entry. */
app.delete('/api/components/:id', (req, res) => {
  const component = store.getComponent(req.params.id)
  if (!component) return res.status(404).json({ error: 'component not found' })
  if (!requireCanvas(req, res, component.canvasId)) return
  const outcome = actions.deleteComponent(req.params.id, resolveActorFromReq(req), {
    force: req.query.force === 'true',
  })
  if (!outcome) return res.status(404).json({ error: 'component not found' })
  if (!outcome.deleted) return res.status(409).json({ error: outcome.reason })
  res.json({ ok: true })
})

/** A run's tool-call timeline, newest first. */
app.get('/api/canvases/:id/run-events', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const runId = typeof req.query.run_id === 'string' ? req.query.run_id : undefined
  res.json(runLog.getRunEvents(req.params.id, { runId, limit: Math.min(500, Number(req.query.limit) || 200) }))
})

/** Frame version history for the Inspector's History section. */
app.get('/api/frames/:frameId/versions', async (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
  res.json(await persist.listFrameVersions(frame.id, limit))
})

/** The verification reports for a frame, newest first — what the checks panel
 *  reads. A report carries the hash of the HTML it describes, so the panel can
 *  say whether it is still current rather than showing a stale pass. */
app.get('/api/frames/:frameId/reviews', async (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5))
  const reviews = await persist.listFrameReviews(frame.id, limit)
  const canvas = store.getCanvas(frame.canvasId)
  const current = frameSha(frame, canvas?.tokens)
  res.json(reviews.map((review) => ({ ...review, current: review.htmlSha === current })))
})

/* Checks are three renders each, so this budget is the preview route's shape
   at a tighter rate — enough for a reviewer working through a canvas,
   not enough to hold the shared browser hostage. */
const frameReviewHits = new Map<string, number[]>()

/** Run the quality gate on a frame now, on a human's word. The same checks and
 *  the same stored report ready_for_review produces, so a reviewer can ask for
 *  a fresh verdict without waiting for an agent to re-run it. */
app.post('/api/frames/:frameId/reviews', async (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  const hits = (frameReviewHits.get(req.user!.id) ?? []).filter((t) => Date.now() - t < 60_000)
  if (hits.length >= 6) return res.status(429).json({ error: 'too many checks, wait a minute' })
  hits.push(Date.now())
  frameReviewHits.set(req.user!.id, hits)
  const actor = resolveActorFromReq(req)
  const canvas = store.getCanvas(frame.canvasId)
  try {
    const report = await reviewFrame(frame, canvas?.tokens)
    const record = reviewToRecord(report, frame.canvasId, actor.name)
    await persist.saveFrameReview(record)
    actions.logActivity(frame.canvasId, actor, `ran checks on "${frame.name}" — ${report.verdict}`, frame.id)
    res.json({ ...record, current: record.htmlSha === frameSha(frame, canvas?.tokens) })
  } catch (err) {
    console.error('[frame-reviews] failed', err)
    res.status(503).json({ error: 'renderer unavailable' })
  }
})

app.get('/api/frames/:frameId/versions/:versionId', async (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  const version = await persist.getFrameVersion(req.params.versionId)
  if (!version || version.frameId !== frame.id) return res.status(404).json({ error: 'version not found' })
  res.json(version)
})

/** Revert a frame to a saved version — itself a new version, so it is undoable. */
app.post('/api/frames/:frameId/revert', async (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  const versionId = String(req.body?.version_id ?? '')
  if (!versionId) return res.status(400).json({ error: 'version_id is required' })
  const updated = await actions.revertFrame(frame.id, versionId, resolveActorFromReq(req))
  if (!updated) return res.status(404).json({ error: 'frame not found' })
  res.json(updated)
})

/** Visual diff of the frame's current html against a saved version. */
app.post('/api/frames/:frameId/diff', async (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  const versionId = String(req.body?.version_id ?? '')
  const version = versionId ? await persist.getFrameVersion(versionId) : undefined
  if (!version || version.frameId !== frame.id) return res.status(404).json({ error: 'version not found' })
  try {
    const diff = await diffFrames(frame, { ...frame, html: version.html, width: version.width, height: version.height })
    const asset = await createAsset(diff.diff_png, {
      canvasId: frame.canvasId,
      ownerId: frame.canvasId,
      uploadedBy: req.user!.name,
    })
    res.json({
      png: `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}`,
      changed_ratio: Number(diff.changed_ratio.toFixed(4)),
    })
  } catch (err) {
    console.error('[diff] failed', err)
    res.status(503).json({ error: 'renderer unavailable' })
  }
})

/** Render arbitrary html for a proposal preview — never stored, rate limited. */
app.post('/api/frames/render-preview', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  const html = String(req.body?.html ?? '')
  const width = Math.max(120, Math.min(2000, Number(req.body?.width) || 1280))
  const height = Math.max(120, Math.min(6000, Number(req.body?.height) || 800))
  if (!html || html.length > 3_000_000) return res.status(400).json({ error: 'html is required (max 3 MB)' })
  const hits = (renderPreviewHits.get(req.user.id) ?? []).filter((t) => Date.now() - t < 60_000)
  if (hits.length >= 12) return res.status(429).json({ error: 'too many previews, wait a minute' })
  hits.push(Date.now())
  renderPreviewHits.set(req.user.id, hits)
  try {
    const png = await renderHtmlPreview(html, { width, height })
    res.type('png').send(png)
  } catch (err) {
    console.error('[render-preview] failed', err)
    res.status(503).json({ error: 'renderer unavailable' })
  }
})

/** Every live lock on this canvas, as the room's clients store it. */
function locksForCanvas(canvasId: string): Record<string, FrameLockHolder> {
  const out: Record<string, FrameLockHolder> = {}
  for (const lock of frameLocks.activeLocks()) {
    if (lock.canvasId !== canvasId) continue
    out[lock.frameId] = { name: lock.agentName, color: colorFor(lock.agentName), kind: 'agent' }
  }
  return out
}

/** Take a frame's edit lock away from a stuck agent. */
app.post('/api/frames/:frameId/unlock', (req, res) => {
  const frame = requireFrame(req, res, req.params.frameId)
  if (!frame) return
  /* the lock is held by the agent, not by a human: "unlock" means "release
     whoever holds it", which is the human's escape hatch from a stuck agent */
  const held = frameLocks.activeLocks().find((lock) => lock.frameId === frame.id)
  actions.releaseAllFrameLocks(frame.id)
  if (held) {
    actions.logActivity(
      frame.canvasId,
      { name: req.user!.name, kind: 'user', color: colorFor(req.user!.name) },
      `took the edit lock back from ${held.agentName}`,
    )
  }
  res.json({ unlocked: true, held_by: held?.agentName ?? null })
})

/** Per-user email preference for agent events. */
app.get('/api/settings/notifications', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  res.json({ agentEmail: await notifications.getNotificationPref(req.user.id) })
})

app.post('/api/settings/notifications', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  const agentEmail = !!req.body?.agentEmail
  notifications.setNotificationPref(req.user.id, agentEmail)
  res.json({ agentEmail })
})

app.post('/api/canvases/:id/pages', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const { name } = req.body ?? {}
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const page = actions.createPage(req.params.id, pageName(name), actor)
  if (!page) return res.status(404).json({ error: 'canvas not found' })
  res.status(201).json(page)
})

app.patch('/api/pages/:id', (req, res) => {
  const found = store.getPage(req.params.id)
  if (!found) return res.status(404).json({ error: 'page not found' })
  if (!requireCanvas(req, res, found.canvas.id)) return
  if (!found.canvas.pages?.some((p) => p.id === req.params.id)) return res.status(404).json({ error: 'page not found' })
  const { name, position } = req.body ?? {}
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  if (typeof name === 'string') actions.renamePage(req.params.id, pageName(name), actor)
  if (position !== undefined) {
    const pos = Number(position)
    if (!Number.isInteger(pos)) return res.status(400).json({ error: 'position must be an integer' })
    actions.reorderPage(req.params.id, pos, actor)
  }
  res.json({ pages: store.getCanvas(found.canvas.id)!.pages })
})

app.delete('/api/pages/:id', (req, res) => {
  const found = store.getPage(req.params.id)
  if (!found) return res.status(404).json({ error: 'page not found' })
  if (!requireCanvas(req, res, found.canvas.id)) return
  if (!found.canvas.pages || found.canvas.pages.length < 2)
    return res.status(409).json({ error: 'cannot delete the only page' })
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const result = actions.deletePage(req.params.id, actor)
  if (!result) return res.status(404).json({ error: 'page not found' })
  res.json({ ok: true, deletedFrameIds: result.deletedFrameIds })
})

app.post('/api/pages/:id/duplicate', (req, res) => {
  const found = store.getPage(req.params.id)
  if (!found) return res.status(404).json({ error: 'page not found' })
  if (!requireCanvas(req, res, found.canvas.id)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const result = actions.duplicatePage(req.params.id, actor)
  if (!result) return res.status(404).json({ error: 'page not found' })
  res.status(201).json(result)
})
app.post('/api/canvases/:id/frames', (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const { name, x, y, width, height, html, pageId } = req.body ?? {}
  if (pageId !== undefined && !store.getCanvas(req.params.id)?.pages?.some((p) => p.id === pageId))
    return res.status(404).json({ error: 'page not found' })
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const frame = actions.createFrame(
    req.params.id,
    {
      name: String(name || 'Frame'),
      x,
      y,
      width,
      height,
      html,
      ...(pageId !== undefined ? { pageId } : {}),
    },
    actor,
  )
  if (!frame) return res.status(404).json({ error: 'canvas not found' })
  res.json(frame)
})

app.patch('/api/frames/:id', (req, res) => {
  if (!requireFrame(req, res, req.params.id)) return
  const { actor: _ignored, ...patch } = req.body ?? {}
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const allowed = ['name', 'x', 'y', 'width', 'height', 'html', 'pageId'] as const
  const clean: Record<string, unknown> = {}
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k]
  const frame = actions.updateFrame(req.params.id, clean, actor)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json(frame)
})

app.post('/api/frames/:id/append', (req, res) => {
  if (!requireFrame(req, res, req.params.id)) return
  const { html_chunk, start, done } = req.body ?? {}
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const frame = actions.appendFrameHtml(req.params.id, String(html_chunk ?? ''), actor, {
    start: !!start,
    done: !!done,
  })
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true, htmlBytes: frame.html.length })
})

app.delete('/api/frames/:id', (req, res) => {
  if (!requireFrame(req, res, req.params.id)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const frame = actions.deleteFrame(req.params.id, actor)
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true })
})

app.post('/api/frames/:id/comments', (req, res) => {
  if (!requireFrame(req, res, req.params.id)) return
  const { selector, snippet, text, stableKey } = req.body ?? {}
  const comment = actions.addElementComment(
    req.params.id,
    {
      selector: String(selector ?? ''),
      snippet: String(snippet ?? ''),
      text: String(text ?? ''),
      ...(stableKey ? { stableKey: String(stableKey) } : {}),
    },
    actions.resolveActor({ name: req.user!.name, kind: 'user' }),
    req.user!.id,
  )
  if (!comment) return res.status(404).json({ error: 'frame not found or empty text' })
  res.json(comment)
})

app.post('/api/comments/:id/replies', (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId)) return
  const text = String(req.body?.text ?? '')
  if (!text.trim() || !actions.openThread(req.params.id)) {
    return res.status(404).json({ error: 'thread resolved or empty text' })
  }
  const reply = actions.replyToComment(
    req.params.id,
    text,
    actions.resolveActor({ name: req.user!.name, kind: 'user' }),
    req.user!.id,
  )
  if (!reply) {
    return res.status(409).json({ error: 'thread resolved meanwhile' })
  }
  res.json(reply)
})

app.post('/api/comments/:id/resolve', (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId)) return
  res.json(actions.resolveComment(req.params.id, actions.resolveActor({ name: req.user!.name, kind: 'user' })))
})

app.post('/api/comments/:id/retry', (req, res) => {
  const found = actions.findComment(req.params.id)
  if (!found) return res.status(404).json({ error: 'comment not found' })
  if (!requireCanvas(req, res, found.canvasId)) return
  res.json(actions.retryComment(req.params.id, req.user!.name))
})

/* Import one page immediately, or discover + import a user-reviewed set of
   same-site pages. Discovery and capture are separate requests on purpose:
   nothing gets added to the canvas until the user confirms the page list. */
const importHits = new Map<string, number[]>()
function takeImportSlot(userId: string): boolean {
  const now = Date.now()
  const hits = (importHits.get(userId) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= 5) return false
  hits.push(now)
  importHits.set(userId, hits)
  return true
}

app.post('/api/canvases/:id/import/discover', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  try {
    const { discoverSitePages, assertPublicHttpUrl } = await import('./importer.ts')
    const url = String(req.body?.url ?? '')
    assertPublicHttpUrl(url)
    if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
    res.json(await discoverSitePages(url))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'page discovery failed' })
  }
})

app.post('/api/canvases/:id/import', async (req, res) => {
  const canvas = requireCanvas(req, res, req.params.id)
  if (!canvas) return
  try {
    const { importPage, importSitePages, assertPublicHttpUrl, isSameSiteUrl, MAX_SITE_PAGES } =
      await import('./importer.ts')
    const requested: string[] | null = Array.isArray(req.body?.urls)
      ? (req.body.urls as unknown[]).map((value) => String(value))
      : null

    if (requested) {
      if (!requested.length) return res.status(400).json({ error: 'select at least one page' })
      if (requested.length > MAX_SITE_PAGES) {
        return res.status(400).json({ error: `a website import is limited to ${MAX_SITE_PAGES} pages` })
      }
      /* Validate the whole batch before consuming a slot or opening Chromium. */
      const validated = requested.map((url) => assertPublicHttpUrl(url))
      const [first, ...rest] = validated
      if (first && rest.some((url) => !isSameSiteUrl(url, first))) {
        return res.status(400).json({ error: 'all selected pages must belong to the same website' })
      }
      const urls = [...new Set(validated.map((url) => url.href))]
      if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })

      const captures = await importSitePages(urls)
      const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
      const frames = []
      const failures: { url: string; error: string }[] = []
      const rightmost = canvas.frames.reduce((right, frame) => Math.max(right, frame.x + frame.width), 0)
      const startX = canvas.frames.length ? rightmost + 80 : 120
      const columns = 3
      let column = 0
      let y = 120
      let rowHeight = 0

      for (const capture of captures) {
        if (!capture.page) {
          failures.push({ url: capture.url, error: capture.error ?? 'import failed' })
          continue
        }
        const imported = capture.page
        const frame = actions.createFrame(
          canvas.id,
          {
            name: imported.title.slice(0, 80),
            x: startX + column * (imported.width + 80),
            y,
            width: imported.width,
            height: imported.height,
            html: imported.html,
          },
          actor,
        )
        if (!frame) {
          failures.push({ url: capture.url, error: 'canvas not found' })
          continue
        }
        frames.push(frame)
        rowHeight = Math.max(rowHeight, imported.height)
        column++
        if (column === columns) {
          column = 0
          y += rowHeight + 80
          rowHeight = 0
        }
      }
      return res.json({ frames, failures })
    }

    const url = String(req.body?.url ?? '')
    /* Validate before consuming a rate-limit slot — typos shouldn't burn quota. */
    assertPublicHttpUrl(url)
    if (!takeImportSlot(req.user!.id)) return res.status(429).json({ error: 'too many imports — wait a minute' })
    const imported = await importPage(url)
    const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
    const frame = actions.createFrame(
      canvas.id,
      { name: imported.title.slice(0, 80), width: imported.width, height: imported.height, html: imported.html },
      actor,
    )
    if (!frame) return res.status(404).json({ error: 'canvas not found' })
    res.json(frame)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'import failed' })
  }
})

app.get('/api/frames/:id/screenshot.png', async (req, res) => {
  const frame = requireFrame(req, res, req.params.id)
  if (!frame) return
  try {
    const { renderFrame } = await import('./screenshot.ts')
    const png = await renderFrame(frame, req.query.scale === '2' ? 2 : 1)
    res.type('png').send(png)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
  }
})

/** A component's thumbnail, rendered from its own markup through the frame
 *  renderer: a component is a document fragment, so it is measured as a
 *  frame of its declared size. */
app.get('/api/components/:id/screenshot.png', async (req, res) => {
  const component = store.getComponent(req.params.id)
  if (!component) return res.status(404).json({ error: 'component not found' })
  if (!requireCanvas(req, res, component.canvasId)) return
  try {
    const { renderFrame } = await import('./screenshot.ts')
    const png = await renderFrame(
      {
        id: `component-${component.id}`,
        canvasId: component.canvasId,
        name: component.name,
        x: 0,
        y: 0,
        width: component.width,
        height: component.height,
        html: component.html,
        createdAt: component.createdAt,
        updatedAt: component.updatedAt,
        updatedBy: component.updatedBy,
      },
      req.query.scale === '2' ? 2 : 1,
    )
    res.type('png').send(png)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'render failed' })
  }
})

/* MCP endpoint — point any MCP-capable AI at http://localhost:PORT/mcp.
   Protected by OAuth: unauthenticated calls get 401 + discovery pointers.
   /mcp/readonly registers only tools that declare readOnlyHint, so a reviewer
   or monitoring agent can be connected without being handed write access. */
app.all('/mcp', (req, res) => handleMcpRequest(req, res))
app.all('/mcp/readonly', (req, res) => handleMcpRequest(req, res, { readonly: true }))

/* OAuth discovery metadata at the root, where MCP clients look for it
   (better-auth serves these under /api/auth; we bridge the web-standard
   handlers into Express) */
function bridge(handler: (req: globalThis.Request) => Promise<globalThis.Response>) {
  return async (req: express.Request, res: express.Response) => {
    const out = await handler(new globalThis.Request(`${req.protocol}://${req.get('host')}${req.originalUrl}`))
    res.status(out.status)
    out.headers.forEach((v, k) => res.setHeader(k, v))
    res.send(await out.text())
  }
}
app.get('/.well-known/oauth-authorization-server', (req, res) => bridge(oAuthDiscoveryMetadata(auth))(req, res))

/* Protected-resource metadata must echo the origin the CLIENT used (RFC 9728
   — clients verify `resource` against the URL they connected to), while the
   authorization server stays on the canonical origin. In dev the app may be
   reached via :4300, :4301 (vite port bump) or :4400 — all must validate. */
function protectedResourceMetadata(req: express.Request, res: express.Response) {
  res.json({
    resource: `${req.protocol}://${req.get('host')}`,
    authorization_servers: [PUBLIC_ORIGIN],
    jwks_uri: `${PUBLIC_ORIGIN}/api/auth/mcp/jwks`,
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_signing_alg_values_supported: ['RS256'],
  })
}
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata)
/* path-aware variant some clients probe for a resource at /mcp */
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata)

/* robots + minimal sitemap for every deployment */
app.get('/robots.txt', (_req, res) => {
  res
    .type('text/plain')
    .send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /c/\n\nSitemap: ${PUBLIC_ORIGIN}/sitemap.xml\n`)
})
app.get('/sitemap.xml', (_req, res) => {
  res
    .type('application/xml')
    .send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${PUBLIC_ORIGIN}/</loc></url>\n</urlset>\n`,
    )
})

/* production: serve the built client */
if (process.env.NODE_ENV === 'production') {
  const dist = path.join(process.cwd(), 'dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

/* ------------------------------------------------- websocket */

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (ws, upgradeReq) => {
  /* the session cookie rides the upgrade request; resolve it once */
  const sessionPromise = auth.api.getSession({ headers: fromNodeHeaders(upgradeReq.headers) }).catch(() => null)

  ws.on('message', async (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const conn = conns.get(ws)

    if (msg.type === 'join') {
      const session = await sessionPromise
      if (!session) {
        ws.close(4401, 'unauthorized')
        return
      }
      const canvas = store.getCanvas(msg.canvasId)
      if (!canvas) return
      if (!canAccessCanvas(session.user.id, canvas)) {
        ws.close(4403, 'no access')
        return
      }
      const presence: Presence = {
        clientId: msg.clientId,
        name: session.user.name, // session identity, not whatever the client claims
        color: colorFor(msg.clientId),
        kind: 'user',
        activeFrameId: null,
      }
      const silent = !!(session.session as { impersonatedBy?: string | null }).impersonatedBy
      conns.set(ws, { ws, canvasId: msg.canvasId, presence, silent })
      const others = room(msg.canvasId)
        .filter((c) => c.ws !== ws && !c.silent)
        .map((c) => c.presence)
      const agents = [...(agentPresences.get(msg.canvasId)?.values() ?? [])]
      send(ws, {
        type: 'init',
        canvas,
        presences: [...others, ...agents],
        activity: actions.getActivity(msg.canvasId),
        comments: actions.getComments(msg.canvasId),
        decisions: actions.getDecisions(msg.canvasId),
        proposals: actions.getProposals(msg.canvasId),
        frameProposals: actions.getFrameProposals(msg.canvasId),
        canvasProposals: await persist.listCanvasProposals(msg.canvasId, { status: 'pending' }),
        questions: actions.getQuestions(msg.canvasId),
        reviewMode: !!canvas.reviewMode,
        reviewPolicy: canvas.reviewPolicy ?? (canvas.reviewMode ? 'all_writes' : 'off'),
        approvalTools: canvas.approvalTools ?? [],
        components: actions.listComponentSummaries(msg.canvasId),
        runEvents: runLog.getRunEvents(msg.canvasId, { limit: 200 }),
        frameLocks: locksForCanvas(msg.canvasId),
        selfColor: presence.color,
        serverBuild: BUILD_ID,
      })
      /* An admin looking at a canvas must not act on it. Announcing presence
         would impersonate the owner in the room, and maybePlay would have the
         demo agent perform on an untouched signup canvas. Both are things the
         owner's own visit is supposed to trigger, not a support session. */
      if (silent) return
      broadcast(msg.canvasId, { type: 'presence:join', presence }, presence.clientId)
      demo.maybePlay(msg.canvasId) // first visit to a fresh signup canvas: the demo agent performs
      return
    }

    if (!conn) return
    if (conn.silent) return // view-as connections receive updates but never emit
    const { canvasId, presence } = conn

    switch (msg.type) {
      case 'cursor':
        presence.cursor = { x: msg.x, y: msg.y }
        broadcast(canvasId, { type: 'cursor', clientId: presence.clientId, x: msg.x, y: msg.y }, presence.clientId)
        break
      case 'editing':
        presence.activeFrameId = msg.frameId
        broadcast(canvasId, { type: 'editing', clientId: presence.clientId, frameId: msg.frameId }, presence.clientId)
        break
      case 'frame:drag':
        broadcast(
          canvasId,
          {
            type: 'frame:drag',
            clientId: presence.clientId,
            frameId: msg.frameId,
            x: msg.x,
            y: msg.y,
            width: msg.width,
            height: msg.height,
          },
          presence.clientId,
        )
        break
      case 'focus': {
        const next: Focus = { frameId: msg.frameId, selector: msg.selector, pageId: msg.pageId, at: Date.now() }
        let byClient = focusByCanvas.get(canvasId)
        if (!byClient) focusByCanvas.set(canvasId, (byClient = new Map()))
        const prev = byClient.get(presence.clientId)
        /* only a real change is worth a message: the client re-announces its
           selection on every page/zoom settle, and panning is not part of the
           tuple, so a human scrolling produces no traffic at all */
        if (prev && prev.frameId === next.frameId && prev.selector === next.selector && prev.pageId === next.pageId) {
          prev.at = next.at
          break
        }
        byClient.set(presence.clientId, next)
        broadcast(
          canvasId,
          {
            type: 'focus',
            clientId: presence.clientId,
            frameId: next.frameId,
            selector: next.selector,
            pageId: next.pageId,
          },
          presence.clientId,
        )
        break
      }
    }
  })

  ws.on('close', () => {
    const conn = conns.get(ws)
    if (!conn) return
    conns.delete(ws)
    if (conn.silent) return // never announced a join, so nothing to leave
    broadcast(conn.canvasId, { type: 'presence:leave', clientId: conn.presence.clientId })
    /* a departed client is not still looking at anything */
    const byClient = focusByCanvas.get(conn.canvasId)
    byClient?.delete(conn.presence.clientId)
    if (byClient?.size === 0) focusByCanvas.delete(conn.canvasId)
  })
})

server.listen(PORT, () => {
  console.log(`⟡ doop server     http://localhost:${PORT}`)
  console.log(`⟡ mcp endpoint      http://localhost:${PORT}/mcp`)
  console.log(`⟡ websocket         ws://localhost:${PORT}/ws`)
})
