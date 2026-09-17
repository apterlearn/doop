import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import { eq, inArray, and, ne, isNotNull } from 'drizzle-orm'
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node'
import { oAuthDiscoveryMetadata } from 'better-auth/plugins'
import { WebSocketServer, WebSocket } from 'ws'
import sharp from 'sharp'
import { store } from './store.ts'
import * as runLog from './runLog.ts'
import * as agentEvents from './agentEvents.ts'
import * as actions from './actions.ts'
import * as frameLocks from './frameLocks.ts'
import { getImage, renderHtmlPreview } from './previews.ts'
import { compareRgba, diffFrames } from './visualDiff.ts'
import type {
  AgentQuestion,
  Canvas,
  CanvasProposal,
  CanvasRelease,
  DesignTokens,
  Frame,
  FrameProposal,
  RunEvent,
} from '../shared/types.ts'
/* the per-kind mail switches are the storage's own record — persist declares
   them, index.ts reads and writes them through it */
import type { NotificationPrefs } from './db/persist.ts'

import {
  canAccessCanvas,
  canvasAccess,
  hasDurableCanvasAccess,
  initMemberRoles,
  intentAtLeast,
  isAdmin,
  isCanvasRole,
  linkIntent,
  memberRole,
} from './access.ts'
import type { CanvasIntent, CanvasRole } from './access.ts'
import {
  auth,
  initAuth,
  syncAdmins,
  getUserName,
  hashLinkPassword,
  loadOidcConfig,
  mintGuestTicket,
  PUBLIC_ORIGIN,
  loginProvidersConfig,
  readGuestTicket,
  readGuestTicketIgnoringExpiry,
  refreshGuestTicket,
  verifyLinkPassword,
} from './auth.ts'
import { sendMail } from './mailer.ts'
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
import type { ZipEntry } from './zip.ts'
import { reviewCanvas } from './canvasReview.ts'
import { FRAME_HEIGHT, FRAME_WIDTH, runDesignWorkflow } from './designWorkflow.ts'
import { commentPullRequest, commitToBranch, ensurePullRequest } from './githubWrite.ts'
import { nanoid } from 'nanoid'
import { cssForTokens } from '../shared/tokens.ts'
import { SNAPSHOT_CSP } from './snapshotCsp.ts'
import { frameSha, reviewFrame, reviewToRecord } from './review.ts'
import { handleMcpRequest, wireBroadcast as wireMcpBroadcast, forgetAgentArrivals } from './mcp.ts'
import { replaceInFrames } from './findReplace.ts'
import { groupClients } from './mcpClients.ts'
import { DESTRUCTIVE_TOOLS } from './mcpPolicy.ts'
import {
  getAsset,
  getCanvasAsset,
  extractAssetIds,
  reconcileAssetRefs,
  beginTicketUpload,
  endTicketUpload,
  createAsset,
  deleteAsset,
  framesReferencingAsset,
  listAssets,
  sweepOrphanAssets,
  MAX_ASSET_BYTES,
} from './assets.ts'
import type { AssetMeta, AssetWithBytes } from './assets.ts'
import { assets as assetsTable } from './db/schema.ts'
import { renderCanvasImage, CANVAS_IMAGE_PADDING, isRenderableForCanvas } from './canvasImage.ts'
import { errorHandler, requestId } from './httpErrors.ts'
import { healthReport, livenessReport, markStoreHydrated } from './health.ts'
import { GLOBAL_RATE_WINDOW_MS, globalLimitKey, sweepGlobalLimits, takeGlobalSlot } from './rateLimit.ts'
import * as ingest from './ingest.ts'
import * as backgrounds from './backgrounds.ts'
import * as storage from './storage.ts'
import * as github from './github.ts'
import * as githubApp from './githubApp.ts'
import { importRepoScreen } from './githubRecon.ts'
import { seed } from './seed.ts'
import * as modelAccounts from './modelAccounts.ts'
import * as designWorkflowSettings from './designWorkflowSettings.ts'
import { designLlmConfigured, designModelsStatus } from './designLlm.ts'
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
/* /readyz reports whether the store has been filled from the database. An
   instance with no canvases yet is ready all the same — the marker is what
   says "the read that fills the store has run", not "there was something in
   it". */
markStoreHydrated()
store.initTrash(data.trashedCanvases, data.trashedFrames, data.trashedPages ?? [], data.trashedComponents ?? [])
store.initCanvasVersions(data.canvasVersions)
store.initLinkHashes(data.linkHashes ?? new Map())
initMemberRoles(data.memberRoles ?? [])
actions.hydrateLogs({
  comments: data.comments,
  activity: data.activity,
  decisions: data.decisions,
  proposals: data.proposals,
})
runLog.hydrate(data.runEvents)
/* the agent↔human bus: the seq each canvas resumes from, and the stops and
   steers a human queued before the restart */
await agentEvents.hydrate()
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

/* Asset GC: the sweep that ledger was built for, run here because this is
   where the reference projection has just been rebuilt from the frames. It
   reaps a row nothing can serve and nothing references — an upload never
   placed, a failed diff render — and never one a frame still points at.

   Off unless ASSET_GC is set (any non-empty value; the plan's own switch is
   `ASSET_GC=true`), and off means one dry run at boot whose log line names
   what a sweep would have deleted: a self-hoster sees the exposure before
   anything is destroyed. On means that same pass deletes, and one runs a day
   after it. The interval is unref'd like the trash and presence sweeps, so a
   timer never keeps the process alive on its own.

   A failure is logged, never thrown: an unreachable bucket must not stop the
   server from serving the canvases it already has — the same rule the
   reconcile above follows, and for the same reason. */
const ASSET_GC = !!process.env.ASSET_GC
const runAssetGc = () =>
  sweepOrphanAssets({ dryRun: !ASSET_GC }).catch((e) => console.error('[assets] orphan sweep failed', e))
void runAssetGc()
if (ASSET_GC) setInterval(runAssetGc, 24 * 60 * 60 * 1000).unref()

/* The trash's retention clock: a boot sweep, then one a day. Rows and frames
   past TRASH_RETENTION_DAYS are removed for good — the same in-process timer
   convention the run-event pruning uses, which fits the single-instance
   architecture this server is built as.

   The bus's own seven-day window rides the same clock: agent_events and the
   signals queued on it are trimmed here rather than by a timer of their own,
   so a stopped server prunes nothing and a running one prunes daily. */
const purgeTrash = () => {
  agentEvents.pruneOlderThan(7 * 24 * 60 * 60 * 1000)
  return persist
    .purgeTrash()
    .then((purged) => {
      const total = purged.canvases + purged.frames + purged.pages + purged.components + purged.guidelines
      if (total) console.log(`[trash] purged ${JSON.stringify(purged)}`)
    })
    .catch((e) => console.error('[trash] purge failed', e))
}
void purgeTrash()
setInterval(purgeTrash, 24 * 60 * 60 * 1000).unref()

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
  /** a guest on a share link: receives updates, emits nothing, and is not a
   *  participant of the room (no presence, no cursors). The REST surface is
   *  what a guest writes through — the link's comment route — so its socket
   *  carries no writing at all. */
  reader?: boolean
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
  /** the account whose token the agent connected with — half of its identity,
   *  and the half that separates two accounts both working as "Claude" */
  ownerId?: string
  /** set by wait_for_events: the agent is parked but alive, so the 60s TTL
   *  applies instead of the 20s idle sweep */
  waiting?: boolean
}
const agentPresences = new Map<string, Map<string, AgentPresence>>() // canvasId -> owner::name -> presence

/** An agent presence as the ROOM sees it. The account id behind the agent is
 *  the MCP surface's half of its identity — the join key for the agents table
 *  and for a per-agent level — and is not something a share-link visitor, who
 *  is deliberately not told who is on the canvas, is handed. */
function presenceWire(p: AgentPresence): Presence {
  const { ownerId: _ownerId, ...wire } = p
  return wire
}

/** What each connected client is looking at: frame, element and page. Kept
 *  per canvas and swept with presence — a client that left is not still
 *  pointing at anything. `at` is what the MCP focus nudge compares against. */
type Focus = Omit<CanvasFocus, 'clientId' | 'name'>
const focusByCanvas = new Map<string, Map<string, Focus>>() // canvasId -> clientId -> focus

function agentTouch(canvasId: string, agentName: string, frameId?: string | null, owner?: string, ownerId?: string) {
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
      ownerId,
      lastSeen: Date.now(),
      activeFrameId: frameId ?? null,
    }
    byName.set(key, p)
  }
  p.lastSeen = Date.now()
  if (frameId !== undefined && frameId !== null) p.waiting = false
  if (owner && !p.owner) p.owner = owner
  if (ownerId && !p.ownerId) p.ownerId = ownerId
  if (frameId !== undefined) p.activeFrameId = frameId
  if (isNew) {
    broadcast(canvasId, { type: 'presence:join', presence: presenceWire(p) })
  } else if (frameId !== undefined) {
    broadcast(canvasId, { type: 'editing', clientId: p.clientId, frameId: p.activeFrameId ?? null })
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
      /* an agent parked in wait_for_events is alive between calls, not gone:
         keep it on screen longer */
      if (now - p.lastSeen > (p.waiting ? 60_000 : 20_000)) {
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
   get_agents can list who is here. */
actions.wirePresence((canvasId) =>
  [...(agentPresences.get(canvasId)?.values() ?? [])].map((p) => ({
    name: p.name,
    ...(p.owner ? { owner: p.owner } : {}),
    /* the account behind the name: what tells two same-named agents of two
       accounts apart, and the key the durable identity is looked up by */
    ...(p.ownerId ? { ownerId: p.ownerId } : {}),
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
/* an agent's own chat message (the send_message tool) reaches the same panel
   the REST route writes to, through the same room broadcast */
wireMcpBroadcast(broadcast)

const app = express()

/* Every request gets a correlation id first, so everything mounted after it —
   the relay, the asset routes, the API, the ws upgrade — carries one, and the
   error handler at the bottom of this file can name the request it failed. */
app.use(requestId())

/* Railway/Fly terminate TLS in front of us; trust the proxy so req.protocol
   and secure cookies see https, and OAuth metadata echoes the right origin */
app.set('trust proxy', 1)

/* Liveness: the process is answering, and nothing else. A probe that waited on
   the database would have a load balancer restart a healthy instance whose
   database is briefly slow — which is the one thing a restart cannot fix.
   Readiness, which is allowed to look at the database, is /readyz below. */
app.get('/healthz', (_req, res) => res.json(livenessReport()))

/** Readiness: the database answers and the store has been hydrated. A probe
 *  that fails here takes the instance out of rotation instead of restarting
 *  it, which is what a wedged database needs. */
app.get('/readyz', async (_req, res) => {
  const report = await healthReport()
  res.status(report.ok ? 200 : 503).json(report)
})

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

/* The global request budget, on top of — never instead of — the per-route
   limits below: those bound what one account may spend on one capability,
   this bounds how fast any caller may ask for anything under /api at all, so a
   client in a retry loop cannot turn one slow route into a busy server. It
   sits here because express.json has already drained the body: a 429 written
   under a request still streaming its upload would leave the client waiting on
   a connection nobody reads.

   Nothing outside /api is budgeted, and that is the exemption list: /healthz,
   /readyz, the built client's static files, /i/, /a/, /bg/, /relay, /u/ and
   /ingest are all mounted elsewhere — and /api/auth/* is registered above, so
   a throttled sign-in or token call (which would turn a rate limit into a
   lockout) never reaches this line. */
app.use('/api', (req, res, next) => {
  const slot = takeGlobalSlot(globalLimitKey({ ip: req.ip, userId: req.user?.id }))
  if (!slot.ok) {
    res.set('retry-after', String(slot.retryAfterSeconds))
    return res
      .status(429)
      .json({ error: 'too many requests — slow down and try again', retryAfterSeconds: slot.retryAfterSeconds })
  }
  next()
})

/* The limiter's own windows are swept opportunistically every thousand calls;
   an instance that goes quiet with callers still in the map would hold them
   until the next one, so a timer drops the expired ones on the window's own
   cadence. Unref'd, like every other in-process sweep here. */
setInterval(() => sweepGlobalLimits(), GLOBAL_RATE_WINDOW_MS).unref()

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
/* Public share links: no session, no account.                         */
/*                                                                     */
/* A visitor proves themselves with the link's own credentials — the   */
/* optional password and then a short-lived guest ticket minted here.  */
/* Mounted ABOVE the /api session gate below, because the entire point */
/* of a share link is that the person opening it has no account.       */
/* ------------------------------------------------------------------ */

/** Password attempts allowed per IP per minute. scrypt is deliberately slow
 *  (~100 ms), which is the real brake on guessing; this stops a caller from
 *  holding the CPU with concurrent attempts and bounds the log noise. */
const LINK_ATTEMPTS_PER_MIN = 10
const linkAttemptHits = new Map<string, number[]>()

function takeLinkAttempt(ip: string): boolean {
  const now = Date.now()
  const hits = (linkAttemptHits.get(ip) ?? []).filter((t) => now - t < 60_000)
  if (hits.length >= LINK_ATTEMPTS_PER_MIN) return false
  hits.push(now)
  linkAttemptHits.set(ip, hits)
  return true
}

/** Every place a canvas leaves the server for a client goes through here: the
 *  link's password appears as a FLAG — never the hash, and this is the last
 *  place it could escape — and the expiry rides along so the share modal can
 *  render the policy it saved. Called per response: a projection that has to be
 *  remembered is one that eventually gets forgotten. */
function canvasForClient(c: Canvas): Canvas {
  return {
    ...c,
    linkPasswordSet: !!store.getLinkHash(c.id),
    ...(c.linkExpiresAt !== undefined ? { linkExpiresAt: c.linkExpiresAt } : {}),
  }
}

/** The canvas as a link visitor receives it: the client projection minus the
 *  things that belong to the room rather than the design — the collaborator
 *  ids, which a visitor has no business enumerating. */
function publicCanvas(c: Canvas): Canvas {
  const { memberIds: _memberIds, ...rest } = canvasForClient(c)
  return rest
}

/** Open a share link: hand the visitor a guest ticket if the link is live and
 *  they can satisfy its password. */
app.post('/api/public/canvases/:id', async (req, res) => {
  const c = store.getCanvas(req.params.id)
  /* a link that is off, expired or never existed is the same answer: nothing
     here should tell a stranger which canvases exist */
  const intent = c ? linkIntent(c) : null
  if (!c || !intent) return res.status(404).json({ error: 'this link is not open', code: 'link_off' })
  const hash = store.getLinkHash(c.id)
  if (hash) {
    if (!takeLinkAttempt(req.ip ?? req.socket.remoteAddress ?? ''))
      return res.status(429).json({ error: 'too many attempts — wait a minute' })
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!password || !(await verifyLinkPassword(password, hash)))
      return res.status(401).json({ error: 'this link needs a password', code: 'password_required' })
  }
  const { ticket, expiresAt } = mintGuestTicket(c.id, intent)
  res.json({ canvas: publicCanvas(c), access: intent, ticket, expiresAt })
})

/** A visitor's ticket has run its half-hour and the room closed the socket on
 *  it (4401). Without this the client reloads and re-opens the link — which on
 *  a password-protected one means asking for the password again, for a visitor
 *  who never lost their claim to it. Holding the ticket IS the proof: it was
 *  minted here, for this canvas, after the password was satisfied, and its
 *  signature is what the caller cannot forge. The EXPIRY is the one thing this
 *  must not refuse on — it is precisely what the caller is renewing — so the
 *  ticket is read without it and the live link is what still has to hold. */
app.post('/api/public/canvases/:id/guest-ticket/refresh', (req, res) => {
  /* the same IP brake as the open route, first: this signs a ticket, and a
     caller looping it burns the CPU for nothing either way */
  if (!takeLinkAttempt(req.ip ?? req.socket.remoteAddress ?? ''))
    return res.status(429).json({ error: 'too many attempts — wait a minute' })
  const c = store.getCanvas(req.params.id)
  const ticket = readGuestTicketIgnoringExpiry(req.body?.ticket)
  /* link and ticket must BOTH still hold, and be about the same canvas: the
     owner turning the link off closes this door without waiting for anything,
     and a ticket for another canvas is not a credential for this one */
  const intent = c ? linkIntent(c) : null
  if (!c || !intent || !ticket || ticket.canvasId !== c.id)
    return res.status(401).json({ error: 'this link is not open', code: 'link_off' })
  /* narrowing an edit link to view takes the edit ticket with it: the visitor's
     older, broader ticket must not be laundered into a fresh one */
  if (!intentAtLeast(intent, ticket.mode)) return res.status(403).json({ error: 'this link is read-only' })
  /* the mint re-runs every check above against the same canvas, so no caller
     can ever mint from a lapsed link; the status split stays here, because
     mapping a refusal onto 401 vs 403 is the HTTP layer's job */
  const fresh = refreshGuestTicket(req.body?.ticket, c)
  if (!fresh) return res.status(401).json({ error: 'this link is not open', code: 'link_off' })
  /* the mode is the caller's own, re-minted: a refresh never widens it */
  res.json({ ...fresh, access: ticket.mode })
})

/** Comment on a frame through a comment-or-edit link. The ticket names the
 *  canvas and the mode it was minted for; the link is re-checked here so
 *  turning it off closes the door the ticket was for, without waiting for the
 *  ticket's own half-hour to run out. */
app.post('/api/public/canvases/:id/comments', async (req, res) => {
  const c = store.getCanvas(req.params.id)
  const ticket = readGuestTicket(req.body?.ticket)
  const intent = c ? linkIntent(c) : null
  if (!c || !intent || !ticket || ticket.canvasId !== c.id)
    return res.status(401).json({ error: 'this link is not open', code: 'link_off' })
  if (!intentAtLeast(ticket.mode, 'comment') || !intentAtLeast(intent, 'comment'))
    return res.status(403).json({ error: 'this link is read-only' })
  const frame = store.getFrame(String(req.body?.frameId ?? ''))
  if (!frame || frame.canvasId !== c.id) return res.status(404).json({ error: 'frame not found' })
  const { selector, snippet, text, stableKey } = req.body ?? {}
  const comment = actions.addElementComment(
    frame.id,
    {
      selector: String(selector ?? ''),
      snippet: String(snippet ?? ''),
      text: String(text ?? ''),
      ...(stableKey ? { stableKey: String(stableKey) } : {}),
    },
    /* no account to name: the thread says Guest, which is exactly what the
       owner is looking at when a stranger leaves a note on their link */
    actions.resolveActor({ name: 'Guest', kind: 'user' }),
  )
  if (!comment) return res.status(404).json({ error: 'frame not found or empty text' })
  res.json(comment)
})

/* The invite landing page reads this before anyone signs in — the whole flow
   is "you were invited, here is what it is, sign in or sign up to accept", so
   the token must answer without a session. The accept route below the gate
   does the part that needs an account. */
app.get('/api/invites/:token', async (req, res) => {
  const invite = await persist.getInvite(req.params.token)
  if (!invite || invite.acceptedAt !== undefined || invite.expiresAt <= Date.now())
    return res.status(404).json({ error: 'this invitation is no longer valid' })
  const canvas = store.getCanvas(invite.canvasId)
  if (!canvas) return res.status(404).json({ error: 'this invitation is no longer valid' })
  res.json({ canvasId: canvas.id, canvasName: canvas.name, role: invite.role, email: invite.email })
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
      /** the session row behind this request, for the account session list */
      sessionId?: string
    }
  }
}

/** The canvas a state-changing request is about, or undefined when it is not
 *  about one (account, settings, model account, …). Resolved from the path the
 *  same way the routes themselves are: the canvas in the path, or the canvas
 *  the frame/page/comment/component in the path belongs to. */
function canvasAddressedBy(req: express.Request): Canvas | undefined {
  const path = (req.originalUrl.split('?')[0] ?? '').replace(/^\/api/, '')
  const canvas = /^\/canvases\/([^/]+)/.exec(path)
  if (canvas) return store.getCanvas(canvas[1]!)
  const frame = /^\/frames\/([^/]+)/.exec(path)
  if (frame) {
    const f = store.getFrame(frame[1]!)
    return f ? store.getCanvas(f.canvasId) : undefined
  }
  const page = /^\/pages\/([^/]+)/.exec(path)
  if (page) return store.getPage(page[1]!)?.canvas
  const comment = /^\/comments\/([^/]+)/.exec(path)
  if (comment) {
    const found = actions.findComment(comment[1]!)
    return found ? store.getCanvas(found.canvasId) : undefined
  }
  const component = /^\/components\/([^/]+)/.exec(path)
  if (component) {
    const found = store.getComponent(component[1]!)
    return found ? store.getCanvas(found.canvasId) : undefined
  }
  return undefined
}

/** State-changing routes that are really reads: they build a new artifact for
 *  the CALLER out of content the caller can already read, and change nothing
 *  about this canvas. A viewer — a viewer-role member, or a view-mode link
 *  visitor — must be able to take the design away with them, so these sit below
 *  the edit bar. Each is gated elsewhere regardless: duplicate needs durable
 *  access, export, the image export and the version diff need the canvas gate. */
const READS_THAT_STORE = /^\/canvases\/[^/]+\/(export(-image)?|duplicate|versions\/[^/]+\/diff)$/

/** How far a state-changing /api call must reach on the canvas it addresses.
 *  `null` = the route does not write canvas content. Commenting is the one
 *  lower bar, deliberately: leaving a note on someone's design is exactly what
 *  a 'comment' link and a commenter-role member are FOR. Everything else that
 *  is not a read is a write. */
function requiredCanvasIntent(method: string, path: string): CanvasIntent | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  const path_ = path.replace(/^\/api/, '')
  if (READS_THAT_STORE.test(path_)) return null
  if (/^\/(comments\/|frames\/[^/]+\/comments$)/.test(path_)) return 'comment'
  return 'edit'
}

/* everything else under /api requires a logged-in user; the session's user
   is authoritative for names — clients don't get to pick who they are */
app.use('/api', async (req, res, next) => {
  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) })
    if (!session) return res.status(401).json({ error: 'unauthorized' })
    req.user = session.user
    req.sessionId = session.session.id
    req.impersonatedBy = (session.session as { impersonatedBy?: string | null }).impersonatedBy ?? undefined
    /* Viewing as someone else is read-only, full stop. Every doop mutation is
       a non-GET REST call — the websocket after `join` carries only cursor,
       editing and frame:drag — so this single rule covers the whole surface.
       better-auth's own routes are mounted earlier (/api/auth/*), so signing
       out and stop-impersonating are unaffected. */
    if (req.impersonatedBy && req.method !== 'GET') {
      return res.status(403).json({ error: 'viewing as another user — read only' })
    }
    /* Access is a property of the canvas, so "may this call write?" is decided
       once, here, from the path and the method — the same discipline as the
       impersonation rule above, and for the same reason: a new route inherits
       the rule instead of having to remember it. A member whose role is viewer
       or commenter, and a link visitor whose mode is view or comment, are
       refused the write here and served the read as usual. */
    const need = requiredCanvasIntent(req.method, req.originalUrl.split('?')[0] ?? '')
    if (need) {
      const canvas = canvasAddressedBy(req)
      const intent = canvas ? canvasAccess(req.user.id, canvas) : null
      if (canvas && (!intent || !intentAtLeast(intent, need))) {
        return res.status(403).json({
          error:
            need === 'comment'
              ? 'this canvas is read-only — ask the owner for comment access'
              : 'this canvas is read-only — ask the owner for edit access',
        })
      }
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
   Both helpers write the error response themselves and return null.

   This is the COARSE gate — "may this caller reach the canvas at all". How
   far they may go (view vs comment vs edit) is settled once per request by
   the /api gate above, from the caller's access path and the HTTP method, so
   a read that reaches this point is a read the caller is entitled to. */
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

/* ------------------------------------------------------------------ */
/* Account security: devices, data export, deletion.                   */
/*                                                                     */
/* Read and revoked straight from `session` rather than through        */
/* better-auth's /list-sessions and /revoke-session endpoints: both go */
/* through freshSessionMiddleware, which refuses a session older than  */
/* session.freshAge (24h by default). A device list you may only open  */
/* on the day you signed in is not a security feature, and the moment  */
/* you most want to revoke another device is exactly when this one is  */
/* old. Deleting the row IS revocation — the cookie stops resolving on */
/* the next request.                                                   */
/* ------------------------------------------------------------------ */

app.get('/api/account/sessions', async (req, res) => {
  const rows = await db.select().from(authSchema.session).where(eq(authSchema.session.userId, req.user!.id))
  const now = Date.now()
  res.json({
    sessions: rows
      .filter((s) => s.expiresAt.getTime() > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((s) => ({
        id: s.id,
        ...(s.ipAddress ? { ipAddress: s.ipAddress } : {}),
        ...(s.userAgent ? { userAgent: s.userAgent } : {}),
        createdAt: s.createdAt.getTime(),
        expiresAt: s.expiresAt.getTime(),
        current: s.id === req.sessionId,
      })),
  })
})

/** End one of your other devices. Refusing the current session is the whole
 *  guard rail: "sign out" is a different button, and a revoke that silently
 *  signs the caller out mid-flow is a bug report, not a feature. */
app.delete('/api/account/sessions/:id', async (req, res) => {
  if (req.params.id === req.sessionId)
    return res.status(400).json({ error: 'that is this session — use sign out to end it' })
  const rows = await db
    .delete(authSchema.session)
    .where(and(eq(authSchema.session.id, req.params.id), eq(authSchema.session.userId, req.user!.id)))
    .returning({ id: authSchema.session.id })
  if (!rows.length) return res.status(404).json({ error: 'session not found' })
  res.json({ ok: true })
})

/** End every device but this one — what you press when you think someone else
 *  has your password. */
app.post('/api/account/sessions/revoke-others', async (req, res) => {
  const rows = await db
    .delete(authSchema.session)
    .where(and(eq(authSchema.session.userId, req.user!.id), ne(authSchema.session.id, req.sessionId ?? '')))
    .returning({ id: authSchema.session.id })
  res.json({ ok: true, revoked: rows.length })
})

/* The review panel suggests which tools an owner means to put behind
   approval. Recalling exact tool names is the part people get wrong — one
   typo and the destructive call sails through as an unlisted tool — so the
   names come from the tools themselves: the registrations that declare
   `destructiveHint`. A logged-in account is the whole bar: it is a list of
   tool names, not a credential or anyone's data. */
app.get('/api/destructive-tools', (_req, res) => {
  res.json({ tools: [...DESTRUCTIVE_TOOLS] })
})

/** A canvas name as a filename inside an export zip: safe on every
 *  filesystem, and never empty. */
const entryName = (name: string, id: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || `canvas-${id}`

/** Everything this account has, as one zip: a per-canvas archive built by the
 *  same code the export button uses (`canvasArchive`), plus the account-level
 *  data — design memory, the canvases index, and the model account's METADATA
 *  (kind, plan, model — never a token or a key; those are credentials, not
 *  data). */
app.get('/api/account/export', async (req, res) => {
  try {
    const user = req.user!
    const mine = [...store.canvases.values()].filter((c) => c.ownerId === user.id)
    const entries: ZipEntry[] = []
    for (const canvas of mine) {
      entries.push({
        name: `canvases/${entryName(canvas.name, canvas.id)}.zip`,
        content: await canvasArchive(canvas),
        time: canvas.updatedAt,
      })
    }
    entries.push({
      name: 'canvases.json',
      content: JSON.stringify(
        mine.map((c) => ({
          id: c.id,
          name: c.name,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          frames: c.frames.length,
          linkAccess: c.linkAccess ?? 'none',
        })),
        null,
        2,
      ),
    })
    entries.push({ name: 'memory.json', content: JSON.stringify(actions.getUserMemory(user.id), null, 2) })
    entries.push({
      name: 'model-accounts.json',
      content: JSON.stringify(await modelAccounts.getStatus(user.id), null, 2),
    })
    entries.push({
      name: 'account.json',
      content: JSON.stringify({ id: user.id, name: user.name, email: user.email, exportedAt: Date.now() }, null, 2),
    })
    res.setHeader('content-type', 'application/zip')
    res.setHeader('content-disposition', 'attachment; filename="doop-export.zip"')
    res.send(buildZip(entries))
  } catch (e) {
    console.error('[account] export failed', e)
    /* the reason matters here: an export that fails for an environmental
       reason (no browser to render the canvas archives with, say) has to say
       so, or the person trying to take their data away has nothing to act on */
    res.status(500).json({ error: e instanceof Error ? e.message : 'the export failed' })
  }
})

/** Delete this account for good. Irreversible, so it asks for the exact phrase
 *  as well as the session: a stray DELETE (a retry, a stale tab) must not be
 *  able to take an account with it. */
app.delete('/api/account', async (req, res) => {
  if (String(req.body?.confirm ?? '') !== 'delete my account')
    return res.status(400).json({ error: 'confirm must be exactly "delete my account"' })
  const user = req.user!
  /* An admin viewing as this user holds an impersonation session, and every
     write in it is already refused above — but a deletion made *through* that
     borrowed identity would be an admin destroying an account they are merely
     looking at. Refuse while one is live. */
  const impersonating = await db
    .select({ id: authSchema.session.id })
    .from(authSchema.session)
    .where(and(eq(authSchema.session.userId, user.id), isNotNull(authSchema.session.impersonatedBy)))
  if (impersonating.length)
    return res.status(409).json({ error: 'an admin is currently viewing this account — ask them to stop first' })
  try {
    await actions.deleteAccountData(user.id)
    await persist.hardDeleteUser(user.id, user.email)
  } catch (e) {
    console.error('[account] delete failed', e)
    return res.status(500).json({ error: 'the account could not be deleted' })
  }
  /* the session rows went with the user, so the browser's cookie is already
     dead — the client lands on the login page on its next call */
  res.json({ ok: true })
})

/** How far a caller must be able to go on a canvas, checked against the one
 *  access function. A caller with no access at all is refused here as well, so
 *  this and the coarse gate can never disagree about who is allowed in. */
function requireIntent(req: express.Request, res: express.Response, canvas: Canvas, need: CanvasIntent): boolean {
  const have = canvasAccess(req.user!.id, canvas)
  if (have && intentAtLeast(have, need)) return true
  res.status(403).json({
    error:
      need === 'comment'
        ? 'this canvas is read-only — ask the owner for comment access'
        : 'this canvas is read-only — ask the owner for edit access',
  })
  return false
}

/** The gate every mutating canvas route adds: requireCanvas says the caller may
 *  reach the canvas, this says they may write to it. A member whose role is
 *  viewer or commenter, and a link visitor whose mode is view or comment, are
 *  refused the write and served the read as usual. */
function requireCanvasIntent(
  req: express.Request,
  res: express.Response,
  canvasId: string,
  need: CanvasIntent,
): Canvas | null {
  const c = requireCanvas(req, res, canvasId)
  if (!c) return null
  return requireIntent(req, res, c, need) ? c : null
}

/** The same gate for a frame route: the frame's canvas decides. Commenting is
 *  the one place `need` is 'comment' rather than 'edit' — leaving a note is
 *  exactly what a comment-link visitor and a commenter-role member are for. */
function requireFrameIntent(
  req: express.Request,
  res: express.Response,
  frameId: string,
  need: CanvasIntent,
): Frame | null {
  const frame = requireFrame(req, res, frameId)
  if (!frame) return null
  const canvas = store.getCanvas(frame.canvasId)!
  return requireIntent(req, res, canvas, need) ? frame : null
}

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
  /* Disconnecting a client is meant to stop the agent, so the identities that
     connected through it are stamped revoked with it — the token rows are what
     the next call is refused by, and the agent rows are what the owner's panel
     reads as "no longer connected". */
  await store.revokeAgentsForClient(req.user!.id, req.params.clientId)
  /* ...and the connection it made is no longer an arrival, so re-approving the
     client writes its identity back rather than replaying a stale memo */
  forgetAgentArrivals(req.user!.id, req.params.clientId)
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

/* ---- the design workflow's model pair: an implementer and a judge, both on
   the operator's single [OI]-compatible endpoint. The credential is server
   env; a user only picks which of its models plays each part. */

/* The status and the model list travel together, like accountView: the client
   re-renders straight from the response. An unreachable provider is a 200
   with `modelsError` — the saved pair still has to render. */
async function designWorkflowView(userId: string) {
  const prefs = await designWorkflowSettings.getDesignWorkflowPrefs(userId)
  if (!prefs.configured) return { ...prefs, models: [] }
  const { models, error } = await designModelsStatus()
  return { ...prefs, models, ...(error ? { modelsError: error } : {}) }
}

app.get('/api/design-workflow', (req, res) => {
  designWorkflowView(req.user!.id)
    .then((view) => res.json(view))
    .catch(() => res.status(500).json({ error: 'design workflow settings unavailable' }))
})

app.patch('/api/design-workflow', async (req, res) => {
  try {
    await designWorkflowSettings.setDesignWorkflowPrefs(req.user!.id, {
      implementerModel: String(req.body?.implementerModel ?? ''),
      judgeModel: String(req.body?.judgeModel ?? ''),
    })
    res.json(await designWorkflowView(req.user!.id))
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not save the design workflow models' })
  }
})

/* The brief ceiling and the frame a brief creates when the caller named no
   page for it: both are the MCP tool's own values, restated so the two doors
   onto the engine take the same briefs and create the same frame. */
const BRIEF_MAX_CHARS = 4000
const BRIEF_FRAME_NAME = 'Design workflow'

/* The same loop as `run_design_workflow`, started by the person in front of
   the canvas rather than by a connected agent: this route is a door onto the
   engine, not a second runtime. The brief goes straight into runDesignWorkflow,
   the frame it writes streams onto the canvas from there, and the engine's
   lines land in the Run tab as a run. The actor is the human who asked, so
   presence and attribution read as a human-initiated run; the refusals below
   repeat the MCP tool's words, because both doors stand between a paid model
   call and work the canvas would never take. */
app.post('/api/canvases/:id/brief', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const brief = String(req.body?.brief ?? '').trim()
  if (!brief) return res.status(400).json({ error: 'a brief is required' })
  if (brief.length > BRIEF_MAX_CHARS)
    return res.status(400).json({ error: `the brief is too long — keep it under ${BRIEF_MAX_CHARS} characters` })
  /* The engine writes every attempt through actions.ts with this request's
     actor — a human, whom the approval gate never stops — so review mode would
     promise the humans in the room an approval the run cannot honour. The
     canvas is asked the same question the tool asks, and answers in the same
     words. */
  if (actions.agentWritesGated(c.id, ['create_frame', 'update_frame', 'append_frame_html']))
    return res.status(409).json({
      error:
        'this canvas gates agent writes — turn review mode off (or clear the approval list) before running the design workflow, or the implementer’s writes would land as proposals',
    })
  if (!designLlmConfigured())
    return res.status(400).json({
      error:
        'the design workflow is not configured on this server — set DESIGN_LLM_BASE_URL and pick models in Settings',
    })
  /* the model pair is per user, so there is no anonymous answer to "which
     models": the engine has to know whose Settings to read */
  const prefs = await designWorkflowSettings.getDesignWorkflowPrefs(req.user!.id)
  if (!prefs.implementerModel || !prefs.judgeModel)
    return res.status(409).json({
      error: 'no design workflow models are picked — choose an implementer and a judge in Settings',
    })
  const frameId = typeof req.body?.frameId === 'string' ? req.body.frameId : ''
  const pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : ''
  /* a redesign target is only meaningful on the canvas the caller named: the
     engine drives THAT canvas's tokens and broadcasts to its viewers, so a
     frame from another canvas would be judged against the wrong design system */
  if (frameId && store.getFrame(frameId)?.canvasId !== c.id) return res.status(404).json({ error: 'frame not found' })
  if (pageId && !c.pages?.some((page) => page.id === pageId)) return res.status(404).json({ error: 'page not found' })
  /* The person running the brief, as the timeline records them. Their account id
     is the half of the identity a reader cannot type: the engine stamps it on
     the run's lines when the run is not the canvas owner's own, which is what
     tells a brief a member started from the owner's. */
  const actor = { ...resolveActorFromReq(req), ownerId: req.user!.id }
  /* The engine opens its frame on the canvas's first page. A human composing
     while looking at another page means that page, so the frame is created
     here — the same one the engine would have made, at the engine's own size
     and name — and handed over as the frame to write into. */
  const target =
    frameId ||
    (pageId
      ? (actions.createFrame(
          c.id,
          { name: BRIEF_FRAME_NAME, html: '', width: FRAME_WIDTH, height: FRAME_HEIGHT, pageId },
          actor,
        )?.id ?? '')
      : '')
  /* the run id is minted here rather than inside the engine, so the answer can
     name the run whose lines the caller is about to watch */
  const runId = randomUUID()
  try {
    const result = await runDesignWorkflow({
      canvasId: c.id,
      brief,
      frameName: BRIEF_FRAME_NAME,
      implementerModel: prefs.implementerModel,
      judgeModel: prefs.judgeModel,
      actor,
      ...(target ? { frameId: target } : {}),
      runId,
    })
    res.json({ runId, ...result })
  } catch (error) {
    /* the provider's own words are the actionable part of a failed run */
    console.error('[design-workflow] brief run failed', error)
    res.status(502).json({ error: error instanceof Error ? error.message : 'the design workflow failed' })
  }
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
  res.json(canvasForClient(store.createCanvas(name, req.user!.id)))
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
  if (c) res.json(canvasForClient(c))
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
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const frames = c.frames.filter((frame) => !frame.demo)
  if (!frames.length)
    return res.status(400).json({ error: 'add a frame before releasing — there is nothing to freeze' })
  const label = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
  const release: persist.CanvasRelease = {
    id: nanoid(10),
    canvasId: c.id,
    name: label || `Release ${new Date().toISOString().slice(0, 10)}`,
    frames: persist.freezeFrames(frames),
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
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const release = await persist.getRelease(req.params.releaseId)
  if (!release || release.canvasId !== c.id) return res.status(404).json({ error: 'release not found' })
  const actor = resolveActorFromReq(req)
  let restored = 0
  try {
    for (const [i, snapshot] of release.frames.entries()) {
      const live = store.getFrame(snapshot.id)
      /* the release froze stacking, lock, visibility, rotation and opacity
         alongside the document. A release predating those fields carries none,
         and a missing one leaves the live frame as it is rather than resetting
         it to the column default. */
      const presentation = (frame: Frame) => ({
        z: snapshot.z ?? frame.z,
        locked: snapshot.locked ?? frame.locked,
        hidden: snapshot.hidden ?? frame.hidden,
        rotation: snapshot.rotation ?? frame.rotation,
        opacity: snapshot.opacity ?? frame.opacity,
      })
      if (!live) {
        actions.createFrame(
          c.id,
          {
            name: snapshot.name,
            html: snapshot.html,
            width: snapshot.width,
            height: snapshot.height,
            ...(snapshot.pageId ? { pageId: snapshot.pageId } : {}),
            /* a release stored before frames carried stacking has no z: its
               array order is the stacking it was released with */
            z: snapshot.z ?? i,
            locked: snapshot.locked ?? false,
            hidden: snapshot.hidden ?? false,
            rotation: snapshot.rotation ?? 0,
            opacity: snapshot.opacity ?? 1,
          },
          actor,
        )
        restored += 1
        continue
      }
      const next = {
        name: snapshot.name,
        html: snapshot.html,
        width: snapshot.width,
        height: snapshot.height,
        ...presentation(live),
      }
      const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => live[k] !== next[k])
      if (!changed) continue
      actions.updateFrame(snapshot.id, next, actor)
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

/* ---- canvas history: the snapshots the canvas can be rolled back to ----
   The timeline is served from the store's ring (hydrated at boot, appended on
   every snapshot), so opening the History tab never waits on the database; the
   snapshot itself is read from the row only when someone restores it. */

app.get('/api/canvases/:id/versions', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  res.json({ versions: store.getCanvasVersions(c.id) })
})

/** Freeze the canvas as it is now — the manual "save version" of the History
 *  tab. Same snapshot the auto cadence and a delete take. */
app.post('/api/canvases/:id/versions', (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const actor = resolveActorFromReq(req)
  const summary = actions.snapshotCanvas(c.id, 'manual', actor.name)
  if (!summary) return res.status(404).json({ error: 'not found' })
  actions.logActivity(c.id, actor, `saved a version of “${c.name}” (${summary.frameCount} frames)`)
  res.json(summary)
})

app.get('/api/canvases/:id/versions/:versionId', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const version = await persist.getCanvasVersion(req.params.versionId)
  /* a version belongs to exactly one canvas: asking for another canvas's
     snapshot with this canvas in the path is a 404, not a cross-canvas read */
  if (!version || version.canvasId !== c.id) return res.status(404).json({ error: 'version not found' })
  res.json(version)
})

app.post('/api/canvases/:id/versions/:versionId/restore', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const result = await actions.restoreCanvasVersion(c.id, req.params.versionId, resolveActorFromReq(req))
  if (!result) return res.status(404).json({ error: 'version not found' })
  res.json({ ok: true, restored: result.restored, created: result.created })
})

/** What restoring a version would change, as two renders of one page: the
 *  canvas as it stands now, and the version's frozen frames. A read like the
 *  image export below — it draws what is already there and stores the bytes for
 *  the caller, changes no design data and takes no version — so a read-only
 *  visitor may look (see READS_THAT_STORE above).
 *
 *  The page is resolved the way the export route resolves it: the one the
 *  caller asked for, else the canvas's first. Both sides are handed to the
 *  compositor in the stage's paint order, `z` with array order as the tiebreak. */
app.post('/api/canvases/:id/versions/:versionId/diff', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const version = await persist.getCanvasVersion(req.params.versionId)
  /* a version belongs to exactly one canvas: asking for another canvas's
     snapshot with this canvas in the path is a 404, not a cross-canvas read */
  if (!version || version.canvasId !== c.id) return res.status(404).json({ error: 'version not found' })
  const requested = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined
  if (requested !== undefined && !c.pages?.some((page) => page.id === requested))
    return res.status(404).json({ error: 'page not found' })
  const pageId = requested ?? c.pages?.[0]?.id
  const onPage = (frames: Frame[]) =>
    frames
      .filter((frame) => frame.pageId === pageId)
      .slice()
      .sort((a, b) => a.z - b.z)
  const current = onPage(c.frames)
  const frozen = onPage(persist.releaseFrames(version))
  /* nothing to draw on either side: there is no picture to compare, and saying
     so is the answer rather than two blank PNGs */
  if (!current.some(isRenderableForCanvas) || !frozen.some(isRenderableForCanvas)) return res.json({ empty: true })
  try {
    /* sequentially, never in parallel: the compositor documents one Chromium
       page per frame and a peak-memory bound, and two concurrent canvas renders
       would double it */
    const live = await renderCanvasImage(current, c.tokens, { scale: 0.5 })
    const past = await renderCanvasImage(frozen, version.tokens ?? c.tokens, { scale: 0.5 })
    const liveAsset = await createAsset(live.png, { canvasId: c.id, ownerId: req.user!.id, uploadedBy: req.user!.name })
    const pastAsset = await createAsset(past.png, { canvasId: c.id, ownerId: req.user!.id, uploadedBy: req.user!.name })
    /* The ratio only means something between images of the same size: a page
       that grew or shrank is answered by the two pictures themselves, so the
       field is left off rather than computed against a padded box. */
    const liveRaw = await sharp(live.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pastRaw = await sharp(past.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const sameSize = liveRaw.info.width === pastRaw.info.width && liveRaw.info.height === pastRaw.info.height
    const comparison = sameSize
      ? await compareRgba(
          { data: liveRaw.data, width: liveRaw.info.width, height: liveRaw.info.height },
          { data: pastRaw.data, width: pastRaw.info.width, height: pastRaw.info.height },
        )
      : undefined
    res.json({
      current: `${PUBLIC_ORIGIN}/a/${liveAsset.id}.${liveAsset.ext}`,
      version: `${PUBLIC_ORIGIN}/a/${pastAsset.id}.${pastAsset.ext}`,
      ...(comparison ? { changedRatio: Number(comparison.changed_ratio.toFixed(4)) } : {}),
    })
  } catch (e) {
    /* a page past the pixel guard, or a frame the renderer could not load:
       the message names the reason rather than an opaque failure */
    res.status(400).json({ error: e instanceof Error ? e.message : 'the diff failed' })
  }
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

/** A positive number out of a request body, held inside a range: an export
 *  asked for at scale 0 or 1e6 is a caller's arithmetic to fix, not 40 MP of
 *  pixels to allocate before the guard notices. */
function inRange(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** One PNG of a page's frames, composited server-side. A read: it draws what
 *  the canvas already shows and stores the bytes for the caller, and changes
 *  no design data — so any access that reaches the canvas may take the picture
 *  away, link visitors included (see READS_THAT_STORE above).
 *
 *  The page is resolved the way the stage resolves it: the one the caller
 *  asked for, else the canvas's first, else the whole canvas (no pages at all
 *  means one implicit page). The bytes are stored through the same pipeline
 *  the zip export uses — an asset row plus the public /a/<id>.png URL — which
 *  is what makes the answer a URL the client can open, download or drop into a
 *  frame like any other image. */
app.post('/api/canvases/:id/export-image', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const requested = typeof req.body?.pageId === 'string' ? req.body.pageId : undefined
  if (requested !== undefined && !c.pages?.some((page) => page.id === requested))
    return res.status(404).json({ error: 'page not found' })
  const pageId = requested ?? c.pages?.[0]?.id
  /* stacking order is `z` (ties by array order), exactly as the stage paints
     it: the compositor draws in the order it is handed, so an unsorted page
     would put a restacked frame behind the one it now covers */
  const frames = (pageId ? c.frames.filter((frame) => frame.pageId === pageId) : c.frames)
    .slice()
    .sort((a, b) => a.z - b.z)
  /* a colour by name, hex or function — sharp parses it and refuses what it
     does not understand, so the field only needs a length bound */
  const background = typeof req.body?.background === 'string' ? req.body.background.trim().slice(0, 64) : ''
  try {
    const image = await renderCanvasImage(frames, c.tokens, {
      scale: inRange(req.body?.scale, 1, 0.25, 4),
      padding: inRange(req.body?.padding, CANVAS_IMAGE_PADDING, 0, 400),
      ...(background ? { background } : {}),
    })
    const asset = await createAsset(image.png, { canvasId: c.id, ownerId: req.user!.id, uploadedBy: req.user!.name })
    res.json({ url: `${PUBLIC_ORIGIN}/a/${asset.id}.${asset.ext}` })
  } catch (e) {
    /* a page past the pixel guard, or a frame the renderer could not load:
       the message names the reason rather than an opaque failure */
    res.status(400).json({ error: e instanceof Error ? e.message : 'the image export failed' })
  }
})

/** Open the handoff pull request: commit the exported file set to a branch of
 *  a connected repo and open (or find) the pull request for it. The same two
 *  halves the MCP open_pull_request tool runs, on the connection the canvas
 *  has for that repo. */
app.post('/api/canvases/:id/pull-request', async (req, res) => {
  const c = requireDurableCanvas(req, res, req.params.id)
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
  const c = requireDurableCanvas(req, res, req.params.id)
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
  actions.deleteCanvas(c.id, req.user!.name)
  res.json({ ok: true })
})

/* ---- trash: deleted canvases, frames, pages and components, still
   recoverable ----
   A trashed canvas is out of the store's live map (so it is out of every read
   path at once — requireCanvas, the dashboard, the gallery, the ws join) and a
   trashed frame, page or component is out of its canvas and the frame index.
   All of them are listed here and put back here, until the retention window
   passes and the purge job removes the rows for good. Every route is
   owner-scoped: a canvas by its owner, a frame/page/component by the owner of
   the canvas it sits on. Anything else is a 404 — the trash is not a way to
   discover someone else's deleted work. */

app.get('/api/trash', (req, res) => {
  res.json(store.listTrash(req.user!.id))
})

app.post('/api/trash/canvases/:id/restore', (req, res) => {
  const entry = store.getTrashedCanvas(req.params.id)
  if (!entry || entry.canvas.ownerId !== req.user!.id) return res.status(404).json({ error: 'not found' })
  actions.restoreCanvas(entry.canvas.id)
  res.json({ ok: true })
})

/** Empty the canvas out of the trash for good. The rows go with it, and so does
 *  its version history — this is the one irreversible action in the flow. */
app.delete('/api/trash/canvases/:id', (req, res) => {
  const entry = store.getTrashedCanvas(req.params.id)
  if (!entry || entry.canvas.ownerId !== req.user!.id) return res.status(404).json({ error: 'not found' })
  actions.purgeCanvas(entry.canvas.id)
  res.json({ ok: true })
})

app.post('/api/trash/frames/:id/restore', (req, res) => {
  const entry = store.getTrashedFrame(req.params.id)
  const canvas = entry ? store.getCanvas(entry.frame.canvasId) : undefined
  if (!entry || canvas?.ownerId !== req.user!.id) return res.status(404).json({ error: 'not found' })
  actions.restoreFrame(entry.frame.id, resolveActorFromReq(req))
  res.json({ ok: true })
})

app.delete('/api/trash/frames/:id', (req, res) => {
  const entry = store.getTrashedFrame(req.params.id)
  const canvas = entry ? store.getCanvas(entry.frame.canvasId) : undefined
  if (!entry || canvas?.ownerId !== req.user!.id) return res.status(404).json({ error: 'not found' })
  actions.purgeFrame(entry.frame.id, resolveActorFromReq(req))
  res.json({ ok: true })
})

/** A page or a component still sits on a LIVE canvas — that is why it was
 *  trashed on its own rather than with a canvas — so a restore puts it back
 *  and tells the room, exactly as the frame restore does. */
app.post('/api/trash/pages/:id/restore', (req, res) => {
  const entry = store.getTrashedPage(req.params.id)
  const canvas = entry ? store.getCanvas(entry.page.canvasId) : undefined
  if (!entry || canvas?.ownerId !== req.user!.id) return res.status(404).json({ error: 'not found' })
  actions.restorePage(entry.page.id, resolveActorFromReq(req))
  res.json({ ok: true })
})

app.post('/api/trash/components/:id/restore', (req, res) => {
  const entry = store.getTrashedComponent(req.params.id)
  const canvas = entry ? store.getCanvas(entry.component.canvasId) : undefined
  if (!entry || canvas?.ownerId !== req.user!.id) return res.status(404).json({ error: 'not found' })
  actions.restoreComponent(entry.component.id, resolveActorFromReq(req))
  res.json({ ok: true })
})

const LINK_MODES = ['none', 'view', 'comment', 'edit'] as const

app.patch('/api/canvases/:id', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const { name, linkAccess, password, expiresAt } = req.body ?? {}
  /* the link policy is the owner's alone — collaborators can rename, not lock.
     One request carries the whole policy, because mode, password and expiry are
     one decision and a half-applied one is a canvas briefly open to whoever
     holds the link. */
  if (linkAccess !== undefined || password !== undefined || expiresAt !== undefined) {
    if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can change link access' })
    if (linkAccess !== undefined && !(LINK_MODES as readonly unknown[]).includes(linkAccess))
      return res.status(400).json({ error: 'linkAccess must be "none", "view", "comment" or "edit"' })
    if (password !== undefined && password !== null && typeof password !== 'string')
      return res.status(400).json({ error: 'password must be a string, or null to remove it' })
    if (expiresAt !== undefined && expiresAt !== null && !Number.isFinite(expiresAt))
      return res.status(400).json({ error: 'expiresAt must be epoch milliseconds, or null' })
    const patch: { access: (typeof LINK_MODES)[number]; passwordHash?: string | null; expiresAt?: number | null } = {
      access: (linkAccess ?? c.linkAccess ?? 'none') as (typeof LINK_MODES)[number],
    }
    if (password !== undefined) patch.passwordHash = password ? await hashLinkPassword(password) : null
    if (expiresAt !== undefined) patch.expiresAt = expiresAt ?? null
    store.setLink(c.id, patch)
  }
  if (typeof name === 'string' && name.trim()) {
    const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
    actions.renameCanvas(c.id, name.trim(), actor)
  }
  /* the updated canvas, never the hash: `linkPasswordSet` is the flag the
     client renders, and `linkExpiresAt` the time it shows */
  res.json(canvasForClient(store.getCanvas(c.id)!))
})

/* ------------------------------------------------------------------ */
/* Collaborators: Figma-style invites. The owner invites existing doop */
/* accounts by email; each member carries the role the owner gave     */
/* them, which is what the gate reads. Roles and invitations are the  */
/* owner's and their admins' to hand out — an admin may manage        */
/* collaborators, while the canvas-level decisions that go with       */
/* ownership (the share link's policy, deleting the canvas) stay the  */
/* owner's alone. The people list is visible to anyone with access.   */
/* ------------------------------------------------------------------ */

/** A member row as the client's CanvasMember: the account, whether it is the
 *  owner, and what it may do. The owner is always 'admin' — they set the
 *  roles, so no role below them can describe them. */
function memberView(c: Canvas, id: string, account: { name: string; email: string } | undefined) {
  return {
    userId: id,
    name: account?.name ?? 'Unknown',
    email: account?.email ?? '',
    owner: id === c.ownerId,
    role: id === c.ownerId ? ('admin' as const) : store.roleOf(c.id, id),
  }
}

/** The owner, or a member the owner made an admin: who may hand out roles and
 *  invitations. Anything above that (deleting the canvas, the share link's
 *  policy) stays the owner's alone. */
function canManageMembers(c: Canvas, userId: string): boolean {
  return c.ownerId === userId || (c.memberIds?.includes(userId) === true && memberRole(c.id, userId) === 'admin')
}

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
  res.json(ids.map((id) => memberView(c, id, byId.get(id))))
})

/** Change a member's role. Owner or admin: a member who could re-role
 *  themselves holds no role at all, and one who could re-role others holds
 *  every role — which is exactly what handing the job to an admin means. */
app.patch('/api/canvases/:id/members/:userId', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (!canManageMembers(c, req.user!.id))
    return res.status(403).json({ error: 'only the owner or an admin can change roles' })
  const role = req.body?.role
  if (!isCanvasRole(role)) return res.status(400).json({ error: 'role must be viewer, commenter, editor or admin' })
  if (req.params.userId === c.ownerId)
    return res.status(400).json({ error: 'the owner’s own access cannot be changed' })
  if (!store.setMemberRole(c.id, req.params.userId, role)) return res.status(404).json({ error: 'not a collaborator' })
  const [account] = await db
    .select({ name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.id, req.params.userId))
    .limit(1)
  res.json(memberView(c, req.params.userId, account))
})

app.post('/api/canvases/:id/members', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (!canManageMembers(c, req.user!.id))
    return res.status(403).json({ error: 'only the owner or an admin can invite people' })
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email) return res.status(400).json({ error: 'email required' })
  const role: CanvasRole = isCanvasRole(req.body?.role) ? req.body.role : 'editor'
  const [row] = await db
    .select({ id: authSchema.user.id, name: authSchema.user.name, email: authSchema.user.email })
    .from(authSchema.user)
    .where(eq(authSchema.user.email, email))
  if (!row) return res.status(404).json({ error: 'no doop account with that email — ask them to sign up first' })
  if (row.id === c.ownerId) return res.status(400).json({ error: 'the owner already has access' })
  store.addMember(c.id, row.id, req.user!.id, role)
  res.json(memberView(c, row.id, row))
})

app.delete('/api/canvases/:id/members/:userId', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  /* anyone may remove THEMSELVES — leaving a canvas is not a permission */
  if (!canManageMembers(c, req.user!.id) && req.params.userId !== req.user!.id)
    return res.status(403).json({ error: 'only the owner or an admin can remove collaborators' })
  if (!store.removeMember(c.id, req.params.userId)) return res.status(404).json({ error: 'not a collaborator' })
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ */
/* Email invitations: for people who may not have an account yet.      */
/*                                                                     */
/* The row is the whole invitation and the token in the URL is the     */
/* credential, so a person can be invited before they exist. Accepting */
/* is under the session gate (below the door the invitee walks through */
/* by signing up) and adds the membership the invite names.            */
/* ------------------------------------------------------------------ */

/** A pending invitation as the client's CanvasInvite — with the URL, always:
 *  it is what the owner copies when SMTP is not configured, and what the
 *  invited person opens from their inbox when it is. */
function inviteView(invite: persist.CanvasInviteRow) {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    invitedBy: invite.createdBy,
    url: `${PUBLIC_ORIGIN}/invite/${invite.token}`,
  }
}

app.get('/api/canvases/:id/invites', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (!canManageMembers(c, req.user!.id))
    return res.status(403).json({ error: 'only the owner or an admin can see invitations' })
  res.json((await persist.listInvites(c.id)).map(inviteView))
})

app.post('/api/canvases/:id/invites', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (!canManageMembers(c, req.user!.id))
    return res.status(403).json({ error: 'only the owner or an admin can invite people' })
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'a valid email is required' })
  const role = req.body?.role
  if (!isCanvasRole(role)) return res.status(400).json({ error: 'role must be viewer, commenter, editor or admin' })
  const now = Date.now()
  const invite: persist.CanvasInviteRow = {
    id: nanoid(10),
    canvasId: c.id,
    email,
    role,
    token: persist.newInviteToken(),
    createdBy: req.user!.id,
    createdAt: now,
    expiresAt: now + persist.INVITE_TTL_MS,
  }
  /* one live invitation per person per canvas: the newest link is the only
     one that works, so the list the owner reads has no dead entries in it */
  persist.clearPendingInvites(c.id, email)
  persist.saveInvite(invite)
  const view = inviteView(invite)
  /* The mail is a convenience, never the delivery: without SMTP the mailer
     logs the link, and either way the response carries the URL for the owner
     to copy. A failed send must not fail the invitation. */
  sendMail({
    to: email,
    subject: `${req.user!.name || 'Someone'} invited you to “${c.name}” on doop`,
    text: `Hi,\n\n${req.user!.name || 'Someone'} invited you to collaborate on the doop canvas “${c.name}” as ${role}.\n\nOpen this link to accept (valid for 7 days):\n\n${view.url}\n\nIf you don't have a doop account yet, the page will walk you through creating one.`,
  }).catch((err) => console.error('[invites] mail failed', err))
  res.json(view)
})

app.delete('/api/canvases/:id/invites/:inviteId', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  if (!canManageMembers(c, req.user!.id))
    return res.status(403).json({ error: 'only the owner or an admin can revoke invitations' })
  if (!(await persist.deleteInvite(c.id, req.params.inviteId)))
    return res.status(404).json({ error: 'no such invitation' })
  res.json({ ok: true })
})

/** Accept an invitation: the token names the canvas, the email and the role,
 *  and the session names the account. Idempotent for the same email — opening
 *  the link twice, or after already being a member, is not an error. */
app.post('/api/invites/:token/accept', async (req, res) => {
  const invite = await persist.getInvite(req.params.token)
  if (!invite) return res.status(404).json({ error: 'this invitation is no longer valid' })
  if (invite.acceptedAt !== undefined) {
    /* already accepted, and by whom decides what happens: the same person
       re-opens their link, or the owner sends a fresh one. Either way the
       membership is the answer. */
    if (invite.acceptedBy === req.user!.id) return res.json({ ok: true, canvasId: invite.canvasId })
    return res.status(404).json({ error: 'this invitation has already been accepted' })
  }
  if (invite.expiresAt <= Date.now()) return res.status(404).json({ error: 'this invitation has expired' })
  const email = req.user!.email.toLowerCase()
  if (email !== invite.email)
    return res
      .status(403)
      .json({ error: `this invitation is for ${invite.email} — sign in with that address to accept it` })
  const canvas = store.getCanvas(invite.canvasId)
  if (!canvas) return res.status(404).json({ error: 'this canvas no longer exists' })
  const role: CanvasRole = isCanvasRole(invite.role) ? invite.role : 'editor'
  if (canvas.ownerId !== req.user!.id) {
    /* an ACCEPTED invitation is an explicit grant: it applies the role it
       names, even to someone who is already a member (re-inviting as editor
       promotes them — unlike addMember, which never demotes by accident) */
    if (canvas.memberIds?.includes(req.user!.id)) store.setMemberRole(canvas.id, req.user!.id, role)
    else store.addMember(canvas.id, req.user!.id, invite.createdBy, role)
  }
  await persist.acceptInvite(invite.id, req.user!.id, Date.now())
  res.json({ ok: true, canvasId: canvas.id })
})

/* ---- design-sync keys: mint/list/revoke the write-only snippet creds.
   Owner and invited members only — NOT link-edit visitors. A key is a
   durable bearer credential, so someone whose access is only the share
   link must not be able to mint one (or read an existing secret) and
   keep writing frames after the owner turns the link off. Editor-and-up
   for the same reason: minting a credential that outlives the visit is
   not something a viewer or commenter's role should reach. */

function requireDurableCanvas(req: express.Request, res: express.Response, canvasId: string) {
  /* the edit gate first: a viewer- or commenter-role member is refused here,
     with the message that says which access they are missing */
  const c = requireCanvasIntent(req, res, canvasId, 'edit')
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
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  if (!actions.unpinReference(req.params.id, req.params.refId, actor))
    return res.status(404).json({ error: 'reference not found' })
  res.json({ ok: true })
})

app.post('/api/canvases/:id/proposals/:pid', (req, res) => {
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
    const c = requireCanvasIntent(req, res, req.params.id, 'edit')
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

/** A whole number out of a query string, floor and cap included: a missing,
 *  empty, junk or negative value reads as the default, and anything past `max`
 *  is held at it rather than pasted into a query. */
function queryInt(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.trunc(n), max)
}

/** The canvas's image library, newest first, a page at a time. A read — the
 *  panel opens it as soon as the tab does, so it is gated on access to the
 *  canvas rather than on the right to write to it, and the POST above keeps
 *  its raw-body upload contract untouched. `has_more` is what the panel's
 *  "load more" reads, computed here because the module answers a page and a
 *  total rather than guessing at the caller's next page. */
app.get('/api/canvases/:id/assets', async (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  const limit = queryInt(req.query.limit, 60, 200)
  const offset = queryInt(req.query.offset, 0, 1_000_000)
  try {
    const { assets, total } = await listAssets(c.id, { limit, offset })
    res.json({ assets, total, has_more: offset + assets.length < total })
  } catch (e) {
    /* the listing reads the assets table and one object per image row: a
       database or bucket hiccup has to answer, not leave the panel waiting on
       a request that will never settle */
    console.error('[assets] listing failed', e)
    res.status(500).json({ error: 'the image library could not be read' })
  }
})

/** Forget an image for good. Refused while a frame of its canvas still embeds
 *  the URL: deleting it would leave that frame showing nothing, and the count
 *  is what the panel tells the person to go and fix. */
app.delete('/api/assets/:id', async (req, res) => {
  const assetId = req.params.id
  try {
    const [row] = await db
      .select({ canvasId: assetsTable.canvasId, ownerId: assetsTable.ownerId })
      .from(assetsTable)
      .where(eq(assetsTable.id, assetId))
    if (!row) return res.status(404).json({ error: 'asset not found' })
    /* the canvas the upload belongs to decides the gate. An asset with no
       canvas hint — the MCP ticket flow can upload without one — has no canvas
       whose members could be asked, so its uploader is the one who may delete
       it. */
    if (row.canvasId) {
      if (!requireCanvasIntent(req, res, row.canvasId, 'edit')) return
      /* both views: the ledger can name a frame this process has not flushed
         yet, and the live store cannot see another process's frame */
      const frames = [
        ...new Set([
          ...(await framesReferencingAsset(row.canvasId, assetId)),
          ...store.framesReferencingAsset(row.canvasId, assetId),
        ]),
      ]
      if (frames.length) {
        const names = frames
          .slice(0, 5)
          .map((frameId) => `“${store.getFrame(frameId)?.name ?? frameId}”`)
          .join(', ')
        return res.status(409).json({
          error:
            `still embedded by ${frames.length} frame${frames.length === 1 ? '' : 's'} (${names}` +
            `${frames.length > 5 ? ', …' : ''}) — remove the image from ${frames.length === 1 ? 'that frame' : 'those frames'} first`,
        })
      }
    } else if (row.ownerId && row.ownerId !== req.user!.id) {
      return res.status(403).json({ error: 'this asset belongs to another account' })
    }
    if (!(await deleteAsset(assetId))) return res.status(404).json({ error: 'asset not found' })
    res.json({ ok: true })
  } catch (e) {
    /* a read that decides the answer failing is not a deletion refusal: say so
       and change nothing */
    console.error('[assets] delete failed', e)
    res.status(500).json({ error: 'the image could not be deleted' })
  }
})

/** Swap the bytes behind an image the canvas already has. The replacement
 *  keeps the asset id — that URL is what frames embed, and it is the reason a
 *  replace exists at all — while the extension follows the type the bytes
 *  actually are, so a png replaced by a webp is served as a webp. When the
 *  extension moves, every frame still naming the old URL is rewritten through
 *  the canvas find/replace machinery: each write goes through
 *  actions.updateFrame, so it versions, broadcasts and is refused by a lock
 *  exactly like any other html edit. A frame whose URL did not move needs no
 *  write — it is already pointing at the replacement — and is still counted,
 *  because the panel's answer is "how many frames show these bytes now". */
app.post(
  '/api/canvases/:id/assets/:assetId/replace',
  express.raw({ type: () => true, limit: MAX_ASSET_BYTES + 1024 }),
  async (req, res) => {
    const c = requireCanvasIntent(req, res, req.params.id, 'edit')
    if (!c) return
    const assetId = req.params.assetId
    /* the canvas scope is the access check and the byte read at once: an asset
       of another canvas, or one whose object is gone, is unknown here */
    let current: AssetWithBytes | undefined
    try {
      current = await getCanvasAsset(c.id, assetId)
    } catch (e) {
      /* a bucket that will not answer is not a missing asset, and the caller
         has to hear about it rather than wait on a request that never settles */
      console.error('[assets] replace could not read the asset', e)
      return res.status(500).json({ error: 'the image could not be read' })
    }
    if (!current) return res.status(404).json({ error: 'asset not found' })
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    let fresh: AssetMeta
    try {
      /* the upload route's own pipeline, which is what sniffs the type, refuses
         an empty file and enforces the 5 MB cap. It stores under an id of its
         own first: that is what tells us the real extension, and the temporary
         row goes as soon as the bytes are in their place below. */
      fresh = await createAsset(buf, { canvasId: c.id, ownerId: req.user!.id, uploadedBy: req.user!.name })
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'replace failed' })
    }
    const url = `/a/${assetId}.${fresh.ext}`
    try {
      /* bytes first, then the row, then the frames that name the URL — the
         order createAsset states from the other side: an object without a row
         is an orphan a sweep reaps, while a row without bytes serves 404s
         forever. The temporary asset the sniff created is dropped once its
         extension has been read; should that cleanup itself fail, what is left
         is one unreferenced row the GC sweep reaps in its own time. */
      await storage.putObject(`${assetId}.${fresh.ext}`, buf, fresh.mime)
      await deleteAsset(fresh.id)
      await db
        .update(assetsTable)
        .set({ mime: fresh.mime, ext: fresh.ext, size: fresh.size })
        .where(eq(assetsTable.id, assetId))
      /* the bytes at the old extension are unreachable now (/a/ serves the
         row's own ext), so they go rather than sitting in the bucket forever */
      if (current.url !== url) await storage.deleteObject(current.url.replace(/^\/a\//, ''))
    } catch (e) {
      /* nothing here is half-visible: an object at the new key with an
         untouched row means the old URL still serves the old image */
      console.error('[assets] replace could not store the new bytes', e)
      return res.status(500).json({ error: 'the replacement could not be stored' })
    }

    let frames: number
    try {
      const referencing = [
        ...new Set([...(await framesReferencingAsset(c.id, assetId)), ...store.framesReferencingAsset(c.id, assetId)]),
      ]
      frames = referencing.length
      if (current.url !== url) {
        const outcome = await replaceInFrames(c.id, {
          find: current.url,
          replace: url,
          frameIds: referencing,
          kind: 'user',
          actor: { name: req.user!.name, userId: req.user!.id },
        })
        frames = outcome.frames.filter((row) => row.applied).length
        for (const row of outcome.frames) {
          /* a frame another agent is holding the lock on keeps the old URL, and
             that URL no longer serves — loud enough that it is not discovered
             as a broken-image report */
          if (!row.applied && row.matches > 0)
            console.warn(`[assets] replace left “${row.name}” on the old url — ${row.skippedReason ?? 'not applied'}`)
        }
      }
    } catch (e) {
      console.error('[assets] replace could not rewrite the frames', e)
      return res
        .status(500)
        .json({ error: 'the image was replaced, but the frames embedding it could not be rewritten' })
    }
    res.json({ url: `${PUBLIC_ORIGIN}${url}`, mime: fresh.mime, size: fresh.size, frames })
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

/** Owner-only: how each agent on this canvas is held back — a leash per
 *  identity, where review mode is a leash on the canvas.
 *
 *  Every agent the canvas knows is listed: the ones live on it right now,
 *  plus any that already carries a level here. `full` is the default and is
 *  stored as no row at all, so it is reported rather than looked up, and an
 *  agent narrowed here and since disconnected stays listed — its id is the
 *  only way back to that row. */
app.get('/api/canvases/:id/agent-levels', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can see agent levels' })
  const levels = await store.listAgentLevels(c.id)
  const narrowed = new Map(levels.map((l) => [l.agentId, l]))
  /* Presence says WHO is here; the agents table says what each of them is,
     which is the id a level hangs off. Two accounts can run the same name, so
     the join is (account, name), never the name alone. */
  const present = actions.listAgentPresence(c.id)
  const live = new Map(present.map((p) => [`${p.ownerId ?? ''}\u0000${p.name}`, p.owner]))
  const owners = [...new Set(present.map((p) => p.ownerId).filter((id): id is string => !!id))]
  const known = new Map<string, persist.AgentRow>()
  for (const row of (await Promise.all(owners.map((ownerId) => store.listAgentsForOwner(ownerId)))).flat()) {
    if (live.has(`${row.ownerId}\u0000${row.name}`)) known.set(row.id, row)
  }
  for (const l of levels) {
    if (known.has(l.agentId)) continue
    const row = await persist.getAgent(l.agentId)
    if (row) known.set(row.id, row)
  }
  const names = new Map(
    await Promise.all(
      [...new Set([...known.values()].map((row) => row.ownerId))].map(
        async (id) => [id, await getUserName(id)] as const,
      ),
    ),
  )
  res.json({
    levels: [...known.values()].map((row) => {
      const level = narrowed.get(row.id)
      return {
        agent_id: row.id,
        name: row.name,
        owner: names.get(row.ownerId) ?? live.get(`${row.ownerId}\u0000${row.name}`) ?? '',
        level: level?.level ?? 'full',
        set_at: level?.setAt ?? 0,
      }
    }),
  })
})

/** Owner-only: hold one agent back on this canvas. `full` is the default, so
 *  it clears the row instead of storing one — either way the answer is the
 *  level now in force, which is what the panel re-renders from. */
app.put('/api/canvases/:id/agents/:agentId/level', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  if (c.ownerId !== req.user!.id) return res.status(403).json({ error: 'only the owner can set an agent level' })
  const level = req.body?.level
  if (level !== 'full' && level !== 'propose' && level !== 'comment' && level !== 'view')
    return res.status(400).json({ error: "level must be 'full', 'propose', 'comment' or 'view'" })
  const { agentId } = req.params
  /* a level is filed against a real identity: an id the agents table does not
     know would be a row no panel could ever list or clear */
  if (!(await persist.getAgent(agentId))) return res.status(404).json({ error: 'no such agent' })
  const at = Date.now()
  const row = await store.setAgentLevel({ canvasId: c.id, agentId, level, setBy: req.user!.name, at })
  res.json({ agent_id: agentId, level, set_at: row?.setAt ?? at })
})

/** The canvas design tokens. Any collaborator may edit them: they are the
 *  canvas's shared palette/type/scale, and the panel is where a human sets
 *  them without an agent in the loop. Validation errors come back verbatim. */
app.patch('/api/canvases/:id/tokens', (req, res) => {
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
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
  if (!requireCanvasIntent(req, res, req.params.id, 'comment')) return
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

/** A component's artboard size, coerced the way the MCP create_component tool
 *  coerces it: a positive whole number of pixels, capped at 20 000. Anything
 *  that is not a usable number reads as "not given", which leaves the store's
 *  own default — 640×480, the size a new frame gets — in place. */
function componentSize(raw: unknown): number | undefined {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.min(Math.round(n), 20_000)
}

/** Save a piece of a design as a reusable component. The html is the
 *  component's whole design — what an insert stamps into a frame — so the
 *  action bounds its size and refuses an empty name, and those messages are
 *  what the panel shows. */
app.post('/api/canvases/:id/components', (req, res) => {
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const html = typeof req.body?.html === 'string' ? req.body.html : ''
  if (!name || !html) return res.status(400).json({ error: 'name and html are required' })
  const description = typeof req.body?.description === 'string' ? req.body.description : undefined
  const variantOf = typeof req.body?.variantOf === 'string' ? req.body.variantOf : undefined
  const width = componentSize(req.body?.width)
  const height = componentSize(req.body?.height)
  try {
    const component = actions.createComponent(
      req.params.id,
      {
        name,
        html,
        ...(description !== undefined ? { description } : {}),
        ...(variantOf ? { variantOf } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      },
      resolveActorFromReq(req),
    )
    if (!component) return res.status(404).json({ error: 'canvas not found' })
    res.json(component)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not save the component' })
  }
})

/** Delete one component. Refused with 409 while frames still hold instances,
 *  unless `force` is passed — the instances' markup is left alone either way,
 *  it simply stops being bound to a library entry. */
app.delete('/api/components/:id', (req, res) => {
  const component = store.getComponent(req.params.id)
  if (!component) return res.status(404).json({ error: 'component not found' })
  if (!requireCanvasIntent(req, res, component.canvasId, 'edit')) return
  const outcome = actions.deleteComponent(req.params.id, resolveActorFromReq(req), {
    force: req.query.force === 'true',
  })
  if (!outcome) return res.status(404).json({ error: 'component not found' })
  if (!outcome.deleted) return res.status(409).json({ error: outcome.reason })
  res.json({ ok: true })
})

/** Edit a library component in place. The markup is the part that reaches
 *  further than the library: changing it rewrites every frame carrying an
 *  instance, and the answer says which frames took the change and which could
 *  not, with the reason — the panel prints both. */
app.patch('/api/components/:id', (req, res) => {
  const component = store.getComponent(req.params.id)
  if (!component) return res.status(404).json({ error: 'component not found' })
  if (!requireCanvasIntent(req, res, component.canvasId, 'edit')) return
  const html = req.body?.html
  if (html !== undefined && typeof html !== 'string') return res.status(400).json({ error: 'html must be a string' })
  const name = typeof req.body?.name === 'string' ? req.body.name : undefined
  const description = typeof req.body?.description === 'string' ? req.body.description : undefined
  const width = componentSize(req.body?.width)
  const height = componentSize(req.body?.height)
  /* actions.updateComponent edits the markup, the name and the description;
     the artboard size the panel edits beside them has no field there, so it
     lands on the same record first — before the action reads the component for
     its broadcast, so the message clients receive carries the new size. */
  if (width !== undefined || height !== undefined)
    store.updateComponent(
      component.id,
      { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) },
      req.user!.name,
    )
  try {
    const outcome = actions.updateComponent(
      component.id,
      {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(html !== undefined ? { html } : {}),
      },
      resolveActorFromReq(req),
    )
    if (!outcome) return res.status(404).json({ error: 'component not found' })
    res.json(outcome)
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'could not update the component' })
  }
})

/** A component's full record — the markup an insert needs, which the summary list omits. */
app.get('/api/components/:id', (req, res) => {
  const component = store.getComponent(req.params.id)
  if (!component) return res.status(404).json({ error: 'component not found' })
  if (!requireCanvas(req, res, component.canvasId)) return
  res.json(component)
})

/** A timeline page's size, and the ceiling on what a caller may ask for. The
 *  ring's own cap is the same 500, so no page is bigger than the live window
 *  one offset can address. */
const RUN_EVENT_PAGE = 200
const RUN_EVENT_PAGE_MAX = 500

/** A timeline page as the Run tab reads it: the steps, the server's own answer
 *  on whether older ones exist, and the offset to ask for next. Same
 *  vocabulary as the other paged reads (get_run_events, and the asset list's
 *  own `has_more`): `next_offset` rides only when there is something behind it,
 *  so a client follows it instead of guessing from a length. */
function runEventPage(events: RunEvent[], hasMore: boolean, nextOffset: number) {
  return {
    events,
    has_more: hasMore,
    ...(hasMore ? { next_offset: nextOffset } : {}),
  }
}

/** A run's tool-call timeline, newest first, one page at a time. Offset 0 is
 *  served from the live ring: it holds the freshest steps, including ones whose
 *  write-behind row has not landed yet, and it is what the Run tab's window was
 *  seeded from. Everything behind it comes out of the durable table, so a
 *  canvas whose history is longer than the ring stays reachable — the ring is
 *  hydrated from the newest rows only, and a busy canvas has far more than it
 *  can hold.
 *
 *  The offset counts steps from the newest across both reads, so `next_offset`
 *  is the continuation of what the caller already holds. An offset past the
 *  last durable row answers an empty page with `has_more: false` — the end of
 *  the retained history, which the retention pass has pruned to a week. */
app.get('/api/canvases/:id/run-events', async (req, res) => {
  if (!requireCanvas(req, res, req.params.id)) return
  const canvasId = req.params.id
  const runId = typeof req.query.run_id === 'string' ? req.query.run_id : undefined
  const limit = Math.min(Math.max(Number(req.query.limit) || RUN_EVENT_PAGE, 1), RUN_EVENT_PAGE_MAX)
  const offset = Math.max(Math.floor(Number(req.query.offset) || 0), 0)
  if (offset === 0) {
    const live = runLog.getRunEvents(canvasId, { runId, limit })
    /* a ring page with anything in it is page 0. Whether there is something
       behind it is the durable table's answer, not the ring's: the ring holds
       the newest rows, not all of them, so a full page from it is not the end
       of the history — and a ring with nothing to answer with at all still has
       the table behind it, which is what the fall-through reads. */
    if (live.length > 0) {
      const behind = await persist.listRunEvents(canvasId, { runId, limit: 1, offset: live.length })
      return res.json(runEventPage(live, behind.events.length > 0, live.length))
    }
  }
  const durable = await persist.listRunEvents(canvasId, { runId, limit, offset })
  res.json(runEventPage(durable.events, durable.hasMore, offset + durable.events.length))
})

/** The run an agent is on right now: the newest timeline event recorded under
 *  its name on this canvas. A stop or steer is filed against that run so the
 *  people watching the Run tab see the intervention where it happened; an
 *  agent that has recorded nothing yet has no run to file against, and the
 *  entry is skipped rather than invented from a name. */
function currentRunId(canvasId: string, agentName: string): string | undefined {
  const name = agentName.trim().toLowerCase()
  return runLog.getRunEvents(canvasId).find((e) => e.agentName.trim().toLowerCase() === name)?.runId
}

/** Express has already percent-decoded the path segment, and an agent name is
 *  free text — a lone `%` is legal in it, so the client's own encoding must
 *  not throw on the way back out. */
function decodeAgentName(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** The durable identities behind the agents working this canvas right now.
 *  Presence says who is here, the agents table says what each of them is, and
 *  the join is (account, name) — never the name alone, because two accounts can
 *  both run an agent called "Claude". */
async function agentsOnCanvas(canvasId: string): Promise<persist.AgentRow[]> {
  const present = actions.listAgentPresence(canvasId)
  const live = new Set(present.map((p) => `${p.ownerId ?? ''}\u0000${p.name}`))
  const owners = [...new Set(present.map((p) => p.ownerId).filter((id): id is string => !!id))]
  const rows = (await Promise.all(owners.map((ownerId) => store.listAgentsForOwner(ownerId)))).flat()
  return rows.filter((row) => live.has(`${row.ownerId}\u0000${row.name}`))
}

/** What the `:agentName` segment of a stop or steer names, as the identity
 *  behind it.
 *
 *  The segment is an agent id or the name a human reads on the canvas, and both
 *  have to land on ONE agent. An id is the identity itself and wins outright; a
 *  name resolves only while exactly one agent here carries it — two of them make
 *  the press ambiguous rather than a coin flip, because stopping the wrong agent
 *  is worse than refusing. A name no identity carries resolves to nothing, and
 *  the registry's own name-keyed behaviour takes over, which is how a stop for
 *  an actor that never connected through MCP (the person who started a brief
 *  run) still lands. */
async function resolveAgentTarget(
  canvas: Canvas,
  raw: string,
): Promise<{ id: string; name: string } | { candidates: persist.AgentRow[] } | undefined> {
  const wanted = raw.trim()
  if (!wanted) return undefined
  const known = await agentsOnCanvas(canvas.id)
  const byId =
    known.find((row) => row.id === wanted) ??
    /* an id the table knows is the identity itself even when the agent is not
       live here right now: the run it names may still be going, and the press
       is aimed at that identity wherever it is */
    (await persist.getAgent(wanted).catch(() => undefined))
  if (byId && canvasAccess(byId.ownerId, canvas) !== null) return { id: byId.id, name: byId.name }
  const byName = known.filter((row) => row.name.trim().toLowerCase() === wanted.toLowerCase())
  if (byName.length === 1) return { id: byName[0]!.id, name: byName[0]!.name }
  if (byName.length > 1) return { candidates: byName }
  return undefined
}

/** The candidates an ambiguous press has to name back: what the humans need to
 *  pick the agent they meant, which is the id and whose account it is. */
async function candidateRows(rows: persist.AgentRow[]): Promise<{ agent_id: string; name: string; owner: string }[]> {
  return Promise.all(
    rows.map(async (row) => ({ agent_id: row.id, name: row.name, owner: (await getUserName(row.ownerId)) ?? '' })),
  )
}

/** The kinds that end a run: a stop a human pressed, the error it failed with,
 *  and the engine's own ending for a run the judge passed. Everything else — a
 *  tool call, a status line — happens while a run is still going. */
const TERMINAL_RUN_KINDS: Record<RunEvent['kind'], true | undefined> = {
  tool: undefined,
  status: undefined,
  stop: true,
  error: true,
  ended: true,
}

/** Whether a design run is still going for this agent — what decides which side
 *  mails when a human presses Stop.
 *
 *  The engine mails a run's ending itself (`<agent> stopped the design run for
 *  “<frame>”`), so the route's own mail must not go out for the same press. The
 *  route cannot ask the engine — the run is a model call away — but the timeline
 *  already says it: the newest line the engine wrote for this agent is a status
 *  line that declares the run's actor, the line it writes before every model
 *  call, and nothing terminal (a stop, or the error the run failed with) has
 *  been recorded since. A plain MCP agent records no such line — its steps are
 *  tool rows the engine never mails about — so a stop on it keeps the route's
 *  mail, exactly as before. */
function designRunLive(canvasId: string, agentName: string): boolean {
  const name = agentName.trim().toLowerCase()
  const events = runLog.getRunEvents(canvasId).filter((event) => event.agentName.trim().toLowerCase() === name)
  const engine = events.findIndex((event) => event.kind === 'status' && event.actorKind !== undefined)
  if (engine === -1) return false
  return !events.slice(0, engine).some((event) => TERMINAL_RUN_KINDS[event.kind] === true)
}

/* The human↔agent chat: the queue an agent reads when it has nothing else to
   do, and how a person parks a thought for an agent that is not connected
   yet. Reading is a read — a link visitor follows the conversation like any
   other part of the canvas — and posting or deleting is a write. The author
   is always the session: the body's own `actor` field is ignored here exactly
   as the neighbouring routes ignore it. */

app.get('/api/canvases/:id/agent-messages', (req, res) => {
  const c = requireCanvas(req, res, req.params.id)
  if (!c) return
  /* both knobs are caller-supplied: junk falls back to the default window
     rather than answering 400 or handing the store a NaN limit */
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit)) || 100))
  const since = Number(req.query.since)
  res.json({ messages: persist.getAgentMessages(c.id, { limit, ...(Number.isFinite(since) ? { since } : {}) }) })
})

app.post('/api/canvases/:id/agent-messages', (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : ''
  if (!body) return res.status(400).json({ error: 'body is required' })
  const to = typeof req.body?.to === 'string' && req.body.to.trim() ? req.body.to.trim() : undefined
  const message = persist.recordAgentMessage({
    id: nanoid(10),
    canvasId: c.id,
    authorName: req.user!.name,
    authorKind: 'user',
    authorColor: colorFor(req.user!.id),
    ...(to ? { to } : {}),
    body,
    at: Date.now(),
  })
  broadcast(c.id, { type: 'agentMessage', message, messageId: message.id })
  res.json(message)
})

app.delete('/api/canvases/:id/agent-messages/:messageId', (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  /* scoped by canvas: another canvas's message is not this caller's to delete */
  if (!persist.deleteAgentMessage(c.id, req.params.messageId))
    return res.status(404).json({ error: 'message not found' })
  broadcast(c.id, { type: 'agentMessage', message: null, messageId: req.params.messageId })
  res.json({ ok: true })
})

/* Stop or redirect a connected agent: the stop lands on its next tool call,
   the steer is read there. Same write bar as every other canvas edit — a
   viewer cannot end someone's run — and both are recorded on the run timeline
   so the humans see the intervention, not just the silence that follows.
   The same block also lists what is still queued: a stop waiting for the
   agent's next call, and steers it has not read yet. */

/** What the canvas is holding for its agents right now — an `AgentSignal[]`,
 *  oldest first, in the shape the requests above filed: a pending stop, and
 *  every steer not yet drained. Reads only: what is queued is the humans'
 *  business, including a viewer's. */
app.get('/api/canvases/:id/agent-signals', (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'view')
  if (!c) return
  res.json({ signals: agentEvents.listSignals(c.id) })
})

app.post('/api/canvases/:id/agents/:agentName/stop', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const aimed = decodeAgentName(req.params.agentName)
  const target = await resolveAgentTarget(c, aimed)
  if (target && 'candidates' in target)
    return res.status(409).json({
      error: `${aimed} names ${target.candidates.length} agents on this canvas — stop the one you mean by its id`,
      candidates: await candidateRows(target.candidates),
    })
  /* the durable id is what the signal is filed against when the press resolved
     to one; the name is the fallback for an actor the agents table does not know
     (a brief run's human). Either way the registry pairs the id and the name, so
     the agent's own call finds the stop under the spelling it carries. */
  if (target) agentEvents.aliasAgent(c.id, target.id, target.name)
  const key = target ? target.id : aimed
  const agentName = target ? target.name : aimed
  agentEvents.requestStop(c.id, key, req.user!.name)
  const runId = currentRunId(c.id, agentName)
  /* read before this press writes its own line: the route's stop line is the
     newest step the moment it lands, and it is terminal */
  const engineWillMail = designRunLive(c.id, agentName)
  if (runId) runLog.recordStatus(c.id, runId, agentName, 'stop', `${req.user!.name} stopped the run`)
  /* One stop, one mail. A design run's ending is the engine's to report — it is
     the only side that knows the run was live — so the route stays quiet for
     one, and this mail is for the stop that has nothing else reporting it: an
     agent with no run going, or one the engine never started. */
  if (!engineWillMail)
    import('./notifications.ts')
      .then((n) => n.notifyAgentEvent(c.id, 'stop', `${req.user!.name} stopped ${agentName}`))
      .catch(() => {})
  res.json({ ok: true })
})

app.post('/api/canvases/:id/agents/:agentName/steer', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const aimed = decodeAgentName(req.params.agentName)
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!message) return res.status(400).json({ error: 'message is required' })
  const target = await resolveAgentTarget(c, aimed)
  if (target && 'candidates' in target)
    return res.status(409).json({
      error: `${aimed} names ${target.candidates.length} agents on this canvas — steer the one you mean by its id`,
      candidates: await candidateRows(target.candidates),
    })
  if (target) agentEvents.aliasAgent(c.id, target.id, target.name)
  const key = target ? target.id : aimed
  const agentName = target ? target.name : aimed
  agentEvents.requestSteer(c.id, key, message, req.user!.name)
  const runId = currentRunId(c.id, agentName)
  if (runId) runLog.recordStatus(c.id, runId, agentName, 'status', `${req.user!.name} steered the run`)
  res.json({ ok: true })
})

/** Take back everything one run wrote. Each frame the run touched returns to
 *  the version it was on when the run first wrote it — the run's own later
 *  writes to the same frame fold into that one base. A frame someone else has
 *  written since is refused rather than clobbered, and every refusal is
 *  reported per frame: one frame the run cannot take back must not abort the
 *  rest of the undo. */
app.post('/api/canvases/:id/runs/:runId/revert', async (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const actor = resolveActorFromReq(req)
  /* the ring holds the whole run (500 is its per-canvas cap), newest first:
     the newest afterVersionId is the version the frame should still be on,
     and the oldest beforeVersionId is the one it started from */
  const events = runLog.getRunEvents(c.id, { runId: req.params.runId, limit: 500 })
  const targets = new Map<string, { base?: string; latest?: string }>()
  for (const event of events) {
    /* only a step that wrote a frame names one (a failed step, and a read
       that merely mentions a frame, carry no id) */
    if (!event.frameId) continue
    const known = targets.get(event.frameId)
    targets.set(event.frameId, {
      /* the newest step wins, so this is the version the run left behind —
         the one the frame must still be on to be takeable back */
      latest: known?.latest ?? event.afterVersionId,
      /* overwritten on every step, so the LAST write — the oldest step, the
         one the run started from — is what survives */
      base: event.beforeVersionId,
    })
  }

  const reverted: { frameId: string; name: string }[] = []
  const skipped: { frameId: string; name: string; reason: string }[] = []
  /* newest touch first above, so the answer reads in the order the run worked */
  for (const [frameId, target] of [...targets].reverse()) {
    const frame = store.getFrame(frameId)
    if (!frame) {
      /* a frame the run wrote and that is no longer here cannot be taken back
         — its name still lives in the version the run produced */
      const gone = await persist.getFrameVersion(target.latest ?? target.base ?? '')
      skipped.push({ frameId, name: gone?.name ?? frameId, reason: 'frame is gone' })
      continue
    }
    /* the run wrote it and no version was captured for the write: there is
       nothing to return it to, and the frame is left exactly as it is */
    if (!target.latest) {
      skipped.push({ frameId, name: frame.name, reason: 'the run produced no version for it' })
      continue
    }
    /* someone wrote after the run: their work is never discarded by an undo
       aimed at the run's, so this frame is reported and left alone */
    const [newest] = await persist.listFrameVersions(frameId, 1)
    if (newest?.id !== target.latest) {
      skipped.push({ frameId, name: frame.name, reason: 'changed since the run' })
      continue
    }
    if (!target.base) {
      skipped.push({ frameId, name: frame.name, reason: 'the version it started from was never captured' })
      continue
    }
    try {
      const landed = await actions.revertFrame(frameId, target.base, actor)
      if (landed) reverted.push({ frameId, name: landed.name })
      else skipped.push({ frameId, name: frame.name, reason: 'the version it started from is gone' })
    } catch (e) {
      /* a user lock, another agent's edit lock or the review gate refuses this
         one frame, not the revert: its message is what the panel shows beside
         the frame it refused */
      if (
        e instanceof actions.FrameLockedByUserError ||
        e instanceof frameLocks.FrameLockedError ||
        e instanceof actions.ReviewModeError
      ) {
        skipped.push({ frameId, name: frame.name, reason: e.message })
        continue
      }
      throw e
    }
  }
  res.json({ reverted, skipped })
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
  const frame = requireFrameIntent(req, res, req.params.frameId, 'edit')
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
  const frame = requireFrameIntent(req, res, req.params.frameId, 'edit')
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
  const frame = requireFrameIntent(req, res, req.params.frameId, 'edit')
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

/** Per-user email preferences for agent events, one switch per kind: a
 *  question waiting on a human, a run that finished, a run that failed. All
 *  opt-in — an agent works unattended, so the default is to interrupt nobody —
 *  which is also why a key the caller did not send keeps its stored value
 *  rather than being read as "off". Read and written straight through persist,
 *  whose per-kind columns ARE the record; a user with no row is all false. */
const NOTIFICATION_PREF_KEYS = ['agentEmail', 'agentFinishEmail', 'agentFailEmail'] as const

const NO_NOTIFICATION_PREFS: NotificationPrefs = {
  agentEmail: false,
  agentFinishEmail: false,
  agentFailEmail: false,
}

app.get('/api/settings/notifications', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  const prefs = await persist.getNotificationPrefs()
  res.json(prefs.get(req.user.id) ?? NO_NOTIFICATION_PREFS)
})

app.post('/api/settings/notifications', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Partial<NotificationPrefs> = {}
  for (const key of NOTIFICATION_PREF_KEYS) {
    if (typeof body[key] === 'boolean') patch[key] = body[key]
  }
  /* the answer is the caller's own record settled here rather than read back:
     the row write is write-behind, so a read straight after it could still
     serve the pre-patch record to the settings panel that just changed it */
  const stored = (await persist.getNotificationPrefs()).get(req.user.id)
  persist.saveNotificationPref(req.user.id, patch)
  res.json({ ...(stored ?? NO_NOTIFICATION_PREFS), ...patch })
})

app.post('/api/canvases/:id/pages', (req, res) => {
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
  const { name } = req.body ?? {}
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const page = actions.createPage(req.params.id, pageName(name), actor)
  if (!page) return res.status(404).json({ error: 'canvas not found' })
  res.status(201).json(page)
})

app.patch('/api/pages/:id', (req, res) => {
  const found = store.getPage(req.params.id)
  if (!found) return res.status(404).json({ error: 'page not found' })
  if (!requireCanvasIntent(req, res, found.canvas.id, 'edit')) return
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
  if (!requireCanvasIntent(req, res, found.canvas.id, 'edit')) return
  if (!found.canvas.pages || found.canvas.pages.length < 2)
    return res.status(409).json({ error: 'cannot delete the only page' })
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  let result: actions.DeletedPage | undefined
  try {
    result = actions.deletePage(req.params.id, actor)
  } catch (e) {
    /* deleting a page deletes its frames, so a locked frame on it refuses the
       whole operation — same answer as a locked frame write */
    if (e instanceof actions.FrameLockedByUserError) {
      return res.status(423).json({ error: e.message, code: 'frame_locked' })
    }
    throw e
  }
  if (!result) return res.status(404).json({ error: 'page not found' })
  res.json({ ok: true, deletedFrameIds: result.deletedFrameIds })
})

app.post('/api/pages/:id/duplicate', (req, res) => {
  const found = store.getPage(req.params.id)
  if (!found) return res.status(404).json({ error: 'page not found' })
  if (!requireCanvasIntent(req, res, found.canvas.id, 'edit')) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const result = actions.duplicatePage(req.params.id, actor)
  if (!result) return res.status(404).json({ error: 'page not found' })
  res.status(201).json(result)
})
app.post('/api/canvases/:id/frames', (req, res) => {
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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

/** Canvas-wide find and replace, the ⌘F modal's one call: a dry run counts what
 *  would change, the apply lands the same sweep. Both read the body the same
 *  way, so the preview a human approved is the edit that arrives. */
app.post('/api/canvases/:id/find-replace', async (req, res) => {
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
  const { find, replace, pageId, frameIds, regex, caseSensitive, dryRun } = req.body ?? {}
  try {
    const result = await replaceInFrames(req.params.id, {
      find: String(find ?? ''),
      replace: String(replace ?? ''),
      regex: !!regex,
      caseSensitive: !!caseSensitive,
      dryRun: !!dryRun,
      ...(pageId !== undefined ? { pageId: String(pageId) } : {}),
      ...(Array.isArray(frameIds) ? { frameIds: frameIds.map(String) } : {}),
      kind: 'user',
      actor: { name: req.user!.name, userId: req.user!.id },
    })
    res.json(result)
  } catch (e) {
    /* an empty find string or a pattern that will not compile is the caller's
       mistake, and the message says which */
    res.status(400).json({ error: e instanceof Error ? e.message : 'the replace was refused' })
  }
})

/** The human-write freshness guard, the same contract the MCP tools' optional
 *  `expected_updated_at` carries: a caller that read the frame at `updatedAt`
 *  hands that value back, and a write whose base has moved on is refused whole
 *  rather than landed on top of someone else's work. Absent = no check, so
 *  every existing caller is unaffected. Answers 409 with the frame as the
 *  server has it — what the editor needs to repaint before retrying — and
 *  returns true: nothing was written. */
function staleFrameWrite(res: express.Response, frame: Frame, expected: unknown): boolean {
  if (expected === undefined || expected === null) return false
  /* epoch ms — the frame's own `updatedAt` the caller last saw — or the ISO
     timestamp the MCP tools pass for the same guard */
  const raw = typeof expected === 'number' ? expected : String(expected).trim()
  const at = typeof raw === 'number' ? raw : /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
  if (at === frame.updatedAt) return false
  res.status(409).json({
    error: `frame “${frame.name}” changed since you read it — now ${new Date(frame.updatedAt).toISOString()} by ${frame.updatedBy}`,
    code: 'stale_frame',
    current: frame,
  })
  return true
}

app.patch('/api/frames/:id', (req, res) => {
  const current = requireFrameIntent(req, res, req.params.id, 'edit')
  if (!current) return
  const { actor: _ignored, expected_updated_at: expected, ...patch } = req.body ?? {}
  if (staleFrameWrite(res, current, expected)) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const allowed = [
    'name',
    'x',
    'y',
    'width',
    'height',
    'html',
    'pageId',
    'z',
    'locked',
    'hidden',
    'rotation',
    'opacity',
  ] as const
  const clean: Record<string, unknown> = {}
  for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k]
  let frame: Frame | undefined
  try {
    frame = actions.updateFrame(req.params.id, clean, actor)
  } catch (e) {
    /* the user locked this frame: 423 answers the client's own lock rule, so
       the editor can refuse the drag locally and offer to unlock */
    if (e instanceof actions.FrameLockedByUserError) {
      return res.status(423).json({ error: e.message, code: 'frame_locked' })
    }
    throw e
  }
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json(frame)
})

/* Stacking: the answer is the page's frames front-to-back, each carrying its
   new z — the same list the ws 'frames:reordered' broadcast hands every other
   client, so the caller paints from the server's settled order. */
app.post('/api/frames/:id/z', (req, res) => {
  if (!requireFrameIntent(req, res, req.params.id, 'edit')) return
  const dir = req.body?.dir
  if (dir !== 'front' && dir !== 'back' && dir !== 'forward' && dir !== 'backward')
    return res.status(400).json({ error: 'dir must be front, back, forward or backward' })
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const frames = actions.reorderFrame(req.params.id, dir, actor)
  if (!frames) return res.status(404).json({ error: 'frame not found' })
  res.json(frames)
})

app.post('/api/canvases/:id/z-order', (req, res) => {
  const c = requireCanvasIntent(req, res, req.params.id, 'edit')
  if (!c) return
  const { pageId, order } = req.body ?? {}
  if (typeof pageId !== 'string' || !c.pages?.some((p) => p.id === pageId))
    return res.status(404).json({ error: 'page not found' })
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of frame ids' })
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  const frames = actions.setFrameOrder(c.id, pageId, order.map(String), actor)
  if (!frames) return res.status(404).json({ error: 'page not found' })
  res.json(frames)
})

app.post('/api/frames/:id/append', (req, res) => {
  const current = requireFrameIntent(req, res, req.params.id, 'edit')
  if (!current) return
  /* a streaming call whose base moved on is refused as a whole, before any of
     the chunk lands */
  if (staleFrameWrite(res, current, req.body?.expected_updated_at)) return
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
  if (!requireFrameIntent(req, res, req.params.id, 'edit')) return
  const actor = actions.resolveActor({ name: req.user!.name, kind: 'user' })
  let frame: Frame | undefined
  try {
    frame = actions.deleteFrame(req.params.id, actor)
  } catch (e) {
    /* a delete destroys the document, so a locked frame answers exactly like a
       refused content write: 423, with the code the editor's lock rule uses */
    if (e instanceof actions.FrameLockedByUserError) {
      return res.status(423).json({ error: e.message, code: 'frame_locked' })
    }
    throw e
  }
  if (!frame) return res.status(404).json({ error: 'frame not found' })
  res.json({ ok: true })
})

app.post('/api/frames/:id/comments', (req, res) => {
  if (!requireFrameIntent(req, res, req.params.id, 'comment')) return
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
  /* replying is COMMENT intent, not edit — which is what the /api gate above
     already required of this request */
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
  if (!requireCanvasIntent(req, res, req.params.id, 'edit')) return
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
  const canvas = requireCanvasIntent(req, res, req.params.id, 'edit')
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
        z: 0,
        locked: false,
        hidden: false,
        rotation: 0,
        opacity: 1,
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

/* The last middleware in the chain, after every route and the SPA fallback:
   the handler Express reaches when a route throws or calls next(err). It logs
   the failure against the request's id and answers without the stack — the
   routes above that answer a 4xx or a 500 themselves keep their own body. */
app.use(errorHandler())

/* ------------------------------------------------- websocket */

/* The close codes this socket uses, past the 1000-2999 the protocol reserves:
   4401 unauthorized (no session), 4403 no access (a session, no seat at this
   canvas), 4404 canvas not found (never existed, or in the trash) and 4409
   message too large (a payload past MAX_WS_PAYLOAD, closed before it is
   parsed). */
const MAX_WS_PAYLOAD = 1024 * 1024

/* Two tiers on purpose. The transport refuses an absurd frame before the
   library buffers it (the ws default is 100 MiB, which is not a ceiling); the
   check in the handler answers the messages that are merely oversized with
   4409, the code this server documents and src/lib/ws.ts shows the client. A
   frame between the two is read and refused; one past the transport cap never
   reaches us, and the library's 1009 is the honest answer for a client that
   sent it. */
const MAX_WS_FRAME = 4 * MAX_WS_PAYLOAD

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_FRAME })

wss.on('connection', (ws, upgradeReq) => {
  /* The library enforces maxPayload itself — a frame past the transport cap is
     refused at its length header, the socket is closed with 1009, and the
     failure surfaces here as an 'error' event. An EventEmitter with no 'error'
     listener throws, and this is a server: one absurd frame must not become an
     outage. Logged, and nothing else — the socket is already gone, so the close
     handler below runs and drops the connection from the room. Every other
     thing ws reports about this socket lands here too, for the same reason. */
  ws.on('error', (e) => console.error(`[ws] socket error: ${e.message}`))

  /* the session cookie rides the upgrade request; resolve it once */
  const sessionPromise = auth.api.getSession({ headers: fromNodeHeaders(upgradeReq.headers) }).catch(() => null)

  ws.on('message', async (raw) => {
    /* A message this large is not one of ours: a cursor, a focus or a drag is
       a few dozen bytes, so a megabyte is already generous — the REST surface
       takes a 10mb body, and nothing on the socket has any business being
       near it. Refused before JSON.parse, so a runaway client cannot make the
       server materialize the payload on its way to ignoring it. */
    const size = Array.isArray(raw) ? raw.reduce((n, chunk) => n + chunk.length, 0) : raw.byteLength
    if (size > MAX_WS_PAYLOAD) {
      ws.close(4409, 'message too large')
      return
    }
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    const conn = conns.get(ws)

    if (msg.type === 'join') {
      const session = await sessionPromise
      const canvas = store.getCanvas(msg.canvasId)
      /* A canvas in the trash is not joinable — it left the live map with
         everything else that reads it, and the same refusal covers a canvas
         that never existed. The socket is CLOSED rather than left open with no
         room: a client that waits forever on an answer that will never come
         cannot tell a trashed canvas from a slow one, and the code says which
         it was. */
      if (!canvas) {
        ws.close(4404, 'canvas not found')
        return
      }
      const memberIntent = session ? canvasAccess(session.user.id, canvas) : null
      /* A guest ticket is how a signed-out visitor reaches the room. It is
         consulted only when the session grants nothing: a member who happens to
         open the share link must join as themselves rather than be demoted to a
         reader by the URL they arrived on. The ticket is checked against the
         link as well as its own signature, so turning the link off closes the
         door it was minted for without waiting out the ticket's half hour. */
      const ticket = memberIntent ? null : readGuestTicket(msg.ticket)
      const guest = !!ticket && ticket.canvasId === canvas.id && linkIntent(canvas) !== null
      if (!memberIntent && !guest) {
        ws.close(session ? 4403 : 4401, session ? 'no access' : 'unauthorized')
        return
      }
      /* A ticket is not an account: the room sees Guest, never a borrowed
         identity. */
      const identified = memberIntent ? session!.user : null
      const presence: Presence = {
        clientId: msg.clientId,
        name: identified?.name ?? 'Guest',
        color: colorFor(msg.clientId),
        kind: 'user',
        activeFrameId: null,
      }
      const silent = !!(session && (session.session as { impersonatedBy?: string | null }).impersonatedBy)
      conns.set(ws, { ws, canvasId: msg.canvasId, presence, silent, reader: !identified })
      /* a reader is not a participant: it is left out of the presence lists and
         announces nothing when it arrives or leaves, which is what keeps the
         room's people list honest about who is actually here */
      const others = room(msg.canvasId)
        .filter((c) => c.ws !== ws && !c.silent && !c.reader)
        .map((c) => c.presence)
      const agents = [...(agentPresences.get(msg.canvasId)?.values() ?? [])].map(presenceWire)
      send(ws, {
        type: 'init',
        canvas: canvasForClient(canvas),
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
        /* the recent chat, so a client joining now reads the conversation it
           missed — a guest on a share link gets the same list: chat is part of
           what the link shows */
        messages: persist.getAgentMessages(msg.canvasId, { limit: 100 }),
        runEvents: runLog.getRunEvents(msg.canvasId, { limit: 200 }),
        frameLocks: locksForCanvas(msg.canvasId),
        selfColor: presence.color,
        serverBuild: BUILD_ID,
      })
      /* An admin looking at a canvas must not act on it. Announcing presence
         would impersonate the owner in the room, and maybePlay would have the
         demo agent perform on an untouched signup canvas. Both are things the
         owner's own visit is supposed to trigger, not a support session. */
      /* A reader (a guest on a share link) receives broadcasts and nothing
         more: its cursor, editing, focus and drag messages are dropped rather
         than relayed, because a connection that cannot write has no business
         telling the room it is editing. It also announces nothing: presence is
         for the people who are actually here. */
      if (silent || !identified) return
      broadcast(msg.canvasId, { type: 'presence:join', presence }, presence.clientId)
      demo.maybePlay(msg.canvasId) // first visit to a fresh signup canvas: the demo agent performs
      return
    }

    if (!conn) return
    if (conn.silent || conn.reader) return
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
