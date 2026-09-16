import type {
  ActivityItem,
  AgentMessage,
  AgentQuestion,
  Canvas,
  CanvasMeta,
  CanvasProposal,
  CanvasRelease,
  CanvasReviewSummary,
  CommunityCategory,
  CommunityItem,
  Component,
  ComponentSummary,
  DesignTokens,
  Frame,
  FrameProposal,
  FrameReview,
  FrameVersion,
  Page,
  ReviewPolicy,
} from '../../shared/types'

export type HomeActivity = ActivityItem & { canvasId: string; canvasName: string }

export interface CanvasMember {
  userId: string
  name: string
  email: string
  owner: boolean
  /** what this collaborator may do: a viewer reads, a commenter also leaves
   *  notes, an editor changes the design. The owner is always an editor. */
  role: CanvasRole
}

/** The link modes a canvas can be shared under, from most closed to most open.
 *  `none` is private; the others are what an uninvited visitor gets. */
export type LinkAccess = 'none' | 'view' | 'comment' | 'edit'

/** What a collaborator may do on a canvas. */
export type CanvasRole = 'viewer' | 'commenter' | 'editor' | 'admin'

/** A pending invitation to somebody who may not have an account yet: the
 *  token is the capability, the email is who it is meant for. */
export interface CanvasInvite {
  id: string
  email: string
  role: CanvasRole
  createdAt: number
  expiresAt: number
  /** who sent it */
  invitedBy: string
  /** the link to send: /invite/<token> */
  url: string
}

/** What an unauthenticated visitor gets for a shared canvas. `ticket` is the
 *  short-lived proof they may read (and comment, under `comment`) without an
 *  account — it is what the ws join carries. */
export interface PublicCanvas {
  canvas: Canvas
  access: Exclude<LinkAccess, 'none'>
  ticket: string
  expiresAt: number
}

/** One signed-in browser/device on this account, as Settings lists it. */
export interface AccountSession {
  id: string
  ipAddress?: string
  userAgent?: string
  createdAt: number
  expiresAt: number
  /** the session this page is running under */
  current: boolean
}

/** Which agent moments this account wants emailed about. All opt-in: agents
 *  work unattended, so the default is to interrupt nobody. */
export interface NotificationPrefs {
  /** an agent is blocked on a question only a human can answer */
  agentEmail: boolean
  /** a run (design workflow) finished */
  agentFinishEmail: boolean
  /** a run failed */
  agentFailEmail: boolean
}

/** A write-only design-sync key: apps embed its secret in the doop-sync
 *  snippet to push their live screens onto this canvas. */
export interface SyncKeyInfo {
  id: string
  secret: string
  canvasId: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  /** synced frames currently on the canvas */
  frames: number
}

/** The flow map of a canvas's synced app(s): link hotspots between frames
 *  and how often users actually navigated each pair. */
export interface SyncFlow {
  links: {
    fromFrameId: string
    toFrameId: string
    x: number
    y: number
    width: number
    height: number
    label: string | null
  }[]
  edges: { fromFrameId: string; toFrameId: string; count: number; lastAt: number }[]
}

/** A GitHub repo connected as an import source. The server keeps the token;
 *  clients only ever see connection metadata. */
export interface GithubConnectionInfo {
  id: string
  canvasId: string
  repo: string
  branch: string
  createdAt: number
  lastSyncedAt: number | null
  /** how the connection authenticates: the GitHub App, or a pasted token */
  via: 'app' | 'token'
  /** frames on the canvas imported through this connection */
  frames: number
}

export interface InstallationRepo {
  fullName: string
  private: boolean
}

export interface RepoScreen {
  kind: 'page' | 'story' | 'component' | 'static'
  route: string
  sourcePath: string
  title: string
  dynamic: boolean
  /** where the pixels come from: repo HTML, or an outline placeholder */
  source: 'static' | 'placeholder'
}

export interface RepoManifest {
  connection: Omit<GithubConnectionInfo, 'frames'>
  framework: string | null
  screens: RepoScreen[]
  truncated: boolean
}

/** An import lands frames on the canvas directly. `needsAgent` lists the
 *  screens Doop cannot import as source — they need an agent to design them
 *  from the repo. `rejected` lists selections the server no longer finds in
 *  the repo manifest, or whose import threw. */
export interface GithubImportResult {
  imported: { id: string; name: string }[]
  rejected: string[]
  needsAgent: string[]
}

export interface DiscoveredPage {
  url: string
  title: string
}

export interface DiscoveredSite {
  siteUrl: string
  pages: DiscoveredPage[]
  truncated: boolean
}

export type ModelAccountKind = 'chatgpt' | 'openai-key'

/** An in-flight device sign-in: the user types `userCode` at `verificationUrl`
 *  and the server polls OpenAI until they approve. */
export interface DeviceFlow {
  userCode: string
  verificationUrl: string
  status: 'pending' | 'connected' | 'error'
  error?: string
}

export interface AgentModelOption {
  id: string
  name: string
  blurb: string
}

export interface ModelAccountStatus {
  connected: boolean
  kind?: ModelAccountKind
  email?: string
  plan?: string
  /** the model tier this account runs on right now */
  model?: string
  connectedAt?: number
  /** false when the server has switched the ChatGPT flow off */
  chatgptEnabled?: boolean
  /** the tiers a user may pick between */
  models?: AgentModelOption[]
}

/** The implementer/judge model pair the design workflow runs on. Both come
 *  from the server's one [OI]-compatible endpoint, so `models` is whatever the
 *  provider lists right now — and `modelsError` is set when it cannot be
 *  reached, which does not stop a saved pair from being edited by hand. */
export interface DesignWorkflowStatus {
  configured: boolean
  implementerModel: string
  judgeModel: string
  models: { id: string }[]
  modelsError?: string
}

/** What a brief run ended with. The server answers with the engine's whole
 *  report, and the composer reads the outcome out of it: `runId` is the run
 *  whose lines the Run tab grouped while it worked, `attempts` how many the
 *  judge spent, `ok` whether it ever passed, and `frameId` the frame the design
 *  landed in — '' when no attempt produced one. */
export interface BriefRun {
  runId: string
  ok: boolean
  attempts: number
  frameId: string
}

export interface WebsiteImportResult {
  frames: Frame[]
  failures: { url: string; error: string }[]
}

/** An MCP client holding a token for the signed-in account. Mirrors
 *  server/mcpClients.ts verbatim (the client cannot import from server/). */
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

/** A stop or a steer a human aimed at a connected agent, pending until the
 *  agent's next tool call reads it. Mirrors `AgentSignal` in
 *  server/agentEvents.ts (the client cannot import from server/): the run
 *  timeline lists these so a press that has not landed is visible. */
export interface AgentSignal {
  canvasId: string
  /** the name the signal was addressed by — what the run timeline groups runs
   *  under, and what the agent calls tools with */
  agentName: string
  kind: 'stop' | 'steer'
  /** what was asked for — a stop has nothing to say beyond itself */
  message?: string
  at: number
  /** who asked: the human's display name, as the timeline shows it */
  by: string
}

/** One frame as a canvas snapshot froze it: the fields a preview reads, plus
 *  the ones a restore writes back. Mirrors `ReleaseFrame` in
 *  server/db/persist.ts (the client cannot import from server/), and neither a
 *  checkpoint's frame nor a release's is a live frame: the frame a snapshot
 *  names may have been deleted since. */
export interface CanvasVersionFrame {
  id: string
  name: string
  width: number
  height: number
  x: number
  y: number
  html: string
  /** stacking, lock, visibility, rotation and opacity travel with the frozen
   *  frame: a restore puts them back, so an undo of that restore has to know
   *  them */
  z: number
  locked: boolean
  hidden: boolean
  rotation: number
  opacity: number
  pageId?: string
}

/** A checkpoint of the whole canvas, as the timeline lists it. `cause` is why
 *  it was taken: automatically while the canvas is edited, before a delete, on
 *  request, or as the state a restore came from. */
export interface CanvasVersionSummary {
  id: string
  cause: 'auto' | 'delete' | 'manual' | 'restore'
  createdAt: number
  createdBy: string
  frameCount: number
}

/** A checkpoint's snapshot: the frames as they stood, plus the canvas tokens
 *  that were in force. */
export interface CanvasVersion extends Omit<CanvasVersionSummary, 'frameCount'> {
  canvasId: string
  frames: CanvasVersionFrame[]
  tokens?: DesignTokens
}

/** What a checkpoint would change, rendered rather than listed: the page as it
 *  stands now and as the checkpoint held it, each one a public image URL, so a
 *  restore can be looked at before it is taken. `changedRatio` is omitted when
 *  the two renders do not share a size — there is no share of pixels to speak
 *  of then — and `empty` marks a comparison with nothing on one side. */
export interface CanvasVersionDiff {
  current: string | null
  version: string | null
  /** changed share of pixels — omitted when the two renders have different sizes */
  changedRatio?: number
  /** one side had no renderable frames */
  empty?: boolean
}

/** A deleted canvas waiting in the trash: restorable, or purgeable for good. */
export interface TrashedCanvas {
  id: string
  name: string
  deletedAt: number
  frameCount: number
}

/** A deleted frame, page or component waiting in the trash, with the canvas it
 *  came from so a row can say where restoring it would put it back. The three
 *  read the same because the trash row is the same row: only the route that
 *  restores it differs. */
export interface TrashedEntry {
  id: string
  canvasId: string
  canvasName: string
  name: string
  deletedAt: number
}

/** Everything the trash holds, as the dashboard lists it. Canvases are their
 *  own shape (they are what the rest of the trash hangs off); the frames,
 *  pages and components of a canvas all list as entries. */
export interface TrashContents {
  canvases: TrashedCanvas[]
  frames: TrashedEntry[]
  pages: TrashedEntry[]
  components: TrashedEntry[]
}
import { getIdentity } from './identity'

function actor() {
  const { clientId, name } = getIdentity()
  return { clientId, name, kind: 'user' as const }
}

export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, text: string) {
    super(`${status} ${text}`)
    this.status = status
    try {
      this.body = JSON.parse(text)
    } catch {
      this.body = {}
    }
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  return res.json()
}

/** A frame write the server refused because the frame had moved on since the
 *  caller read it: the write landed nowhere, and `current` is the frame as the
 *  server has it — what `patchFrameLocal` wants, so the client catches up
 *  instead of keeping a copy nobody else can see. The same contract the MCP
 *  tools' `expected_updated_at` carries. */
export interface StaleFrameConflict {
  code: 'stale_frame'
  /** the server's own words: which frame, when it moved and who moved it */
  error: string
  current: Frame
}

/** The 409 a preconditioned frame write answers with. Anything else — another
 *  status, another code, a body with no usable frame in it — is `undefined`:
 *  a caller is never handed a half-read body to pretend with. */
export function staleFrameConflict(e: unknown): StaleFrameConflict | undefined {
  if (!(e instanceof ApiError) || e.status !== 409) return undefined
  const { code, error, current } = e.body
  if (code !== 'stale_frame') return undefined
  if (typeof current !== 'object' || current === null) return undefined
  const frame = current as Partial<Frame>
  /* the frame the local canvas can actually take: its id is where the copy
     goes, its updatedAt is the fresh precondition every later write needs */
  if (typeof frame.id !== 'string' || typeof frame.updatedAt !== 'number') return undefined
  return {
    code: 'stale_frame',
    error: typeof error === 'string' ? error : 'the frame changed since you read it — reload and try again',
    current: frame as Frame,
  }
}

/** One frame's share of a canvas-wide find & replace: `matches` is what the
 *  find string hit in its document, `applied` whether the write landed, and
 *  `skippedReason` why it did not — an agent holding the frame's lock. */
export interface ReplaceResult {
  frames: { frameId: string; name: string; matches: number; applied: boolean; skippedReason?: string }[]
  totalMatches: number
}

/** What the find-and-replace modal sends. `pageId` unset sweeps every frame
 *  on the canvas; `dryRun` only counts, so the modal can show a diff first. */
export interface ReplaceInput {
  find: string
  replace: string
  pageId?: string
  regex?: boolean
  caseSensitive?: boolean
  dryRun?: boolean
}

/** What a component is built from: the markup that gets instanced onto the
 *  canvas, the size it wants, and where it came from. A component with
 *  `variantOf` is a variation on that other one rather than a fresh entry. */
export interface ComponentInput {
  name: string
  html: string
  width: number
  height: number
  description?: string
  variantOf?: string
}

/** What the fields a component may be edited through. The markup is optional
 *  so a rename does not have to replay every instance. */
export interface ComponentPatch {
  html?: string
  name?: string
  width?: number
  height?: number
  description?: string
}

/** What rewriting a component's instances answered: the frames the new markup
 *  reached, and the ones it did not with the reason — an agent holding the
 *  frame's lock. Mirrors the server's reply verbatim. */
export interface ComponentUpdateResult {
  component: Component
  updated: { frameId: string; name: string }[]
  skipped: { frameId: string; name: string; reason: string }[]
}

/** One image stored on a canvas, as the Assets panel lists it: the permanent
 *  `/a/<id>.<ext>` URL frames embed, and the intrinsic size when the server
 *  decoded it at upload. Assets uploaded before dimensions were recorded
 *  carry neither, so both stay optional. */
export interface AssetSummary {
  id: string
  url: string
  mime: string
  bytes: number
  width?: number
  height?: number
  /** when it was uploaded, epoch ms */
  at: number
}

/** A page of the canvas's image library, newest first. */
export interface AssetPage {
  assets: AssetSummary[]
  total: number
  has_more: boolean
}

/** Raw image bytes POSTed to an asset route: the body is the file itself,
 *  typed by its own mime, and the server sniffs the bytes rather than trusting
 *  the header. Upload and replace answer differently but fail identically, so
 *  they share the one path — including the 413 the 5 MB cap produces, which is
 *  worth saying in words rather than as a status code. */
async function postAssetBytes<T>(url: string, blob: Blob): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  if (!res.ok) {
    if (res.status === 413) throw new Error('image exceeds the 5 MB limit')
    const text = await res.text()
    let msg = `${res.status} ${text}`
    try {
      msg = JSON.parse(text).error || msg
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  listCanvases: () => req<CanvasMeta[]>('/api/canvases'),
  getCanvas: (id: string) => req<Canvas>(`/api/canvases/${id}`),
  deleteCanvas: (id: string) => req(`/api/canvases/${id}`, { method: 'DELETE' }),
  homeActivity: () => req<HomeActivity[]>('/api/home/activity'),
  createCanvas: (name: string) => req<Canvas>('/api/canvases', { method: 'POST', body: JSON.stringify({ name }) }),
  duplicateCanvas: (id: string) => req<Canvas>(`/api/canvases/${id}/duplicate`, { method: 'POST' }),
  claimCanvas: (id: string) => req(`/api/canvases/${id}/claim`, { method: 'POST' }),
  renameCanvas: (id: string, name: string) =>
    req('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify({ name, actor: actor() }) }),
  /* owner-only: what the share link grants people who aren't invited */
  setLinkAccess: (id: string, linkAccess: LinkAccess) =>
    req('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify({ linkAccess }) }),
  /* owner-only link extras: a password gates the link, an expiry closes it
     on its own. null clears either. */
  setLinkSharing: (id: string, patch: { password?: string | null; expiresAt?: number | null }) =>
    req<Canvas>('/api/canvases/' + id, { method: 'PATCH', body: JSON.stringify(patch) }),
  /* collaborators and their roles */
  setMemberRole: (canvasId: string, userId: string, role: CanvasRole) =>
    req<CanvasMember>(`/api/canvases/${canvasId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  /* invitations for people who have no account yet */
  listInvites: (canvasId: string) => req<CanvasInvite[]>(`/api/canvases/${canvasId}/invites`),
  createInvite: (canvasId: string, email: string, role: CanvasRole) =>
    req<CanvasInvite>(`/api/canvases/${canvasId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  revokeInvite: (canvasId: string, inviteId: string) =>
    req(`/api/canvases/${canvasId}/invites/${inviteId}`, { method: 'DELETE' }),
  getInvite: (token: string) =>
    req<{ canvasId: string; canvasName: string; role: CanvasRole; email: string }>(`/api/invites/${token}`),
  acceptInvite: (token: string) =>
    req<{ ok: true; canvasId: string }>(`/api/invites/${token}/accept`, { method: 'POST' }),
  /* the signed-out share-link surface: a password (when the owner set one)
     buys a short-lived ticket, which is what reads and comments then use */
  openPublicCanvas: (id: string, password?: string) =>
    req<PublicCanvas>(`/api/public/canvases/${id}`, {
      method: 'POST',
      body: JSON.stringify(password ? { password } : {}),
    }),
  commentAsGuest: (
    id: string,
    input: { ticket: string; frameId: string; selector: string; snippet: string; text: string; stableKey?: string },
  ) => req(`/api/public/canvases/${id}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  /* this account's own security surface */
  listSessions: () => req<{ sessions: AccountSession[] }>('/api/account/sessions').then((r) => r.sessions),
  revokeSession: (id: string) => req('/api/account/sessions/' + id, { method: 'DELETE' }),
  revokeOtherSessions: () => req('/api/account/sessions/revoke-others', { method: 'POST' }),
  deleteAccount: () =>
    req('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'delete my account' }) }),
  /* community gallery: owner-only listing, open browsing and copying. A
     listing may pin a release, so the gallery shows and hands out that frozen
     snapshot instead of whatever the canvas says today */
  publishCanvas: (
    id: string,
    listing: { description: string; category: CommunityCategory },
    releaseId?: string | null,
  ) =>
    req<Pick<Canvas, 'publishedAt' | 'description' | 'category'>>(`/api/canvases/${id}/publish`, {
      method: 'PUT',
      body: JSON.stringify({ ...listing, ...(releaseId !== undefined ? { releaseId } : {}) }),
    }),
  unpublishCanvas: (id: string) => req(`/api/canvases/${id}/publish`, { method: 'DELETE' }),
  listCommunity: () => req<CommunityItem[]>('/api/community'),
  copyCommunityCanvas: (id: string) => req<Canvas>(`/api/community/${id}/copy`, { method: 'POST' }),
  /* collaborators: the owner plus invited members */
  listMembers: (canvasId: string) => req<CanvasMember[]>(`/api/canvases/${canvasId}/members`),
  /* the role is part of the invite, not a second call: the route takes it and
     falls back to editor when it is left out, so an existing caller that only
     names an email still gets the behaviour it asked for */
  inviteMember: (canvasId: string, email: string, role?: CanvasRole) =>
    req<CanvasMember>(`/api/canvases/${canvasId}/members`, {
      method: 'POST',
      body: JSON.stringify(role ? { email, role } : { email }),
    }),
  removeMember: (canvasId: string, userId: string) =>
    req(`/api/canvases/${canvasId}/members/${userId}`, { method: 'DELETE' }),
  /* design-sync keys for the embeddable snippet */
  listSyncKeys: (canvasId: string) => req<SyncKeyInfo[]>(`/api/canvases/${canvasId}/sync-keys`),
  createSyncKey: (canvasId: string, name: string) =>
    req<SyncKeyInfo>(`/api/canvases/${canvasId}/sync-keys`, { method: 'POST', body: JSON.stringify({ name }) }),
  deleteSyncKey: (canvasId: string, keyId: string) =>
    req(`/api/canvases/${canvasId}/sync-keys/${keyId}`, { method: 'DELETE' }),
  syncFlow: (canvasId: string) => req<SyncFlow>(`/api/canvases/${canvasId}/sync-flow`),
  /* GitHub repos connected as import sources */
  listGithubConnections: (canvasId: string) => req<GithubConnectionInfo[]>(`/api/canvases/${canvasId}/github`),
  connectGithub: (canvasId: string, input: { repo: string; token?: string; pass?: string; branch?: string }) =>
    req<GithubConnectionInfo>(`/api/canvases/${canvasId}/github`, { method: 'POST', body: JSON.stringify(input) }),
  githubAppInfo: () => req<{ enabled: boolean; slug: string }>('/api/github/app'),
  startGithubInstall: (canvasId: string) =>
    req<{ url: string }>(`/api/canvases/${canvasId}/github/app/start`, { method: 'POST' }),
  listInstallationRepos: (canvasId: string, pass: string) =>
    req<InstallationRepo[]>(`/api/canvases/${canvasId}/github/app/repos?pass=${encodeURIComponent(pass)}`),
  deleteGithubConnection: (canvasId: string, connId: string) =>
    req(`/api/canvases/${canvasId}/github/${connId}`, { method: 'DELETE' }),
  analyzeGithub: (canvasId: string, connId: string) =>
    req<RepoManifest>(`/api/canvases/${canvasId}/github/${connId}/analyze`, { method: 'POST' }),
  importGithubScreens: (canvasId: string, connId: string, screens: RepoScreen[]) =>
    req<GithubImportResult>(`/api/canvases/${canvasId}/github/${connId}/import`, {
      method: 'POST',
      body: JSON.stringify({ screens }),
    }),
  guidelineHistory: (canvasId: string, name: string) =>
    req<{ markdown: string; savedAt: number; savedBy: string }[]>(
      `/api/canvases/${canvasId}/guidelines/${encodeURIComponent(name)}/history`,
    ),
  /* empty markdown deletes the guide; title is the pretty display name */
  setGuideline: (canvasId: string, name: string, markdown: string, title?: string) =>
    req(`/api/canvases/${canvasId}/guidelines/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ markdown, ...(title !== undefined ? { title } : {}) }),
    }),
  /* design memory */
  pinReference: (canvasId: string, frameId: string) =>
    req(`/api/canvases/${canvasId}/references`, { method: 'POST', body: JSON.stringify({ frameId }) }),
  unpinReference: (canvasId: string, refId: string) =>
    req(`/api/canvases/${canvasId}/references/${refId}`, { method: 'DELETE' }),
  resolveProposal: (canvasId: string, proposalId: string, accept: boolean) =>
    req(`/api/canvases/${canvasId}/proposals/${proposalId}`, { method: 'POST', body: JSON.stringify({ accept }) }),
  /* review mode: while it is on, agent frame writes wait for a human here */
  setReviewMode: (canvasId: string, on: boolean) =>
    req<{ reviewMode: boolean }>(`/api/canvases/${canvasId}/review-mode`, {
      method: 'POST',
      body: JSON.stringify({ on }),
    }),
  /* owner-only: which agent writes must clear approval, and the extra tool
     names gated under the `destructive` policy */
  setReviewPolicy: (canvasId: string, policy: ReviewPolicy, approvalTools: string[]) =>
    req<{ reviewPolicy: ReviewPolicy; approvalTools: string[] }>(`/api/canvases/${canvasId}/review-policy`, {
      method: 'POST',
      body: JSON.stringify({ policy, approval_tools: approvalTools }),
    }),
  /** the frame's stored verification reports, newest first */
  frameReviews: (frameId: string, limit = 5) =>
    req<(FrameReview & { current: boolean })[]>(`/api/frames/${frameId}/reviews?limit=${limit}`),
  /** run the checks now and store the report — the human's side of
   *  ready_for_review, for when a reviewer does not want to wait for an agent */
  runFrameReviews: (frameId: string) =>
    req<FrameReview & { current: boolean }>(`/api/frames/${frameId}/reviews`, { method: 'POST' }),
  /** the canvas-wide sweep: the per-frame gate aggregated into one verdict
   *  for the whole design, run now rather than per frame */
  runCanvasReviews: (canvasId: string) =>
    req<CanvasReviewSummary>(`/api/canvases/${canvasId}/reviews`, { method: 'POST' }),
  frameProposals: (canvasId: string, status?: FrameProposal['status']) =>
    req<FrameProposal[]>(`/api/canvases/${canvasId}/frame-proposals${status ? `?status=${status}` : ''}`),
  canvasProposals: async (canvasId: string, status?: CanvasProposal['status']) => {
    const { proposals } = await req<{ proposals: CanvasProposal[] }>(
      `/api/canvases/${canvasId}/canvas-proposals${status ? `?status=${status}` : ''}`,
    )
    return proposals
  },
  /* accept applies the proposal through the ordinary setters; a reject may
     carry a note the agent reads back */
  resolveCanvasProposal: (canvasId: string, proposalId: string, accept: boolean, note?: string) =>
    req<CanvasProposal>(`/api/canvases/${canvasId}/canvas-proposals/${proposalId}`, {
      method: 'POST',
      body: JSON.stringify({ accept, ...(note ? { note } : {}) }),
    }),
  /* the canvas design tokens, as the Tokens panel edits them */
  setTokens: (canvasId: string, tokens: DesignTokens | null) =>
    req<{ tokens: DesignTokens | null }>(`/api/canvases/${canvasId}/tokens`, {
      method: 'PATCH',
      body: JSON.stringify({ tokens }),
    }),
  /* a reject may carry a note the agent reads back; force applies a proposal
     the stale guard would otherwise refuse. A patch-mode proposal also carries
     `hunks` — the reviewer's per-edit verdict — so an unchecked hunk is
     dropped instead of applied; the response reports which hunks landed and
     why any did not. */
  resolveFrameProposal: (
    canvasId: string,
    proposalId: string,
    accept: boolean,
    opts?: { note?: string; force?: boolean; hunks?: { index: number; accept: boolean }[] },
  ) =>
    req<FrameProposal & { applied?: number[]; skipped?: { index: number; reason: string }[] }>(
      `/api/canvases/${canvasId}/frame-proposals/${proposalId}`,
      {
        method: 'POST',
        body: JSON.stringify({
          accept,
          ...(opts?.note ? { note: opts.note } : {}),
          ...(opts?.force ? { force: true } : {}),
          ...(opts?.hunks ? { hunks: opts.hunks } : {}),
        }),
      },
    ),
  /* the answer reaches a waiting agent inside its ask_human call */
  answerQuestion: (canvasId: string, questionId: string, answer: string) =>
    req<AgentQuestion>(`/api/canvases/${canvasId}/questions/${questionId}`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    }),
  /* the human↔agent chat: the queue an agent reads when it has nothing else
     to do, and how a person parks a thought for an agent that is not
     connected yet. Newest last. */
  agentMessages: (canvasId: string, limit = 100) =>
    req<{ messages: AgentMessage[] }>(`/api/canvases/${canvasId}/agent-messages?limit=${limit}`).then(
      (r) => r.messages,
    ),
  postAgentMessage: (canvasId: string, body: string, to?: string) =>
    req<AgentMessage>(`/api/canvases/${canvasId}/agent-messages`, {
      method: 'POST',
      body: JSON.stringify({ body, ...(to ? { to } : {}), actor: actor() }),
    }),
  deleteAgentMessage: (canvasId: string, messageId: string) =>
    req(`/api/canvases/${canvasId}/agent-messages/${messageId}`, { method: 'DELETE' }),
  /* stop or redirect a connected agent: the stop lands on its next tool call,
     the steer is read there. `agentName` is the name it calls tools with. */
  stopAgent: (canvasId: string, agentName: string) =>
    req<{ ok: true }>(`/api/canvases/${canvasId}/agents/${encodeURIComponent(agentName)}/stop`, { method: 'POST' }),
  steerAgent: (canvasId: string, agentName: string, message: string) =>
    req<{ ok: true }>(`/api/canvases/${canvasId}/agents/${encodeURIComponent(agentName)}/steer`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  /* what this canvas is still holding for its agents: a stop that has not
     reached a tool call yet, and steers nobody has read. The run timeline
     polls it, because a press that only toasts is invisible until it lands */
  agentSignals: (canvasId: string) => req<{ signals: AgentSignal[] }>(`/api/canvases/${canvasId}/agent-signals`),
  /* take back everything one run did: the frames it touched return to the
     version each was at before the run started. Frames changed by anyone else
     since are refused rather than clobbered, so the response reports both. */
  revertRun: (canvasId: string, runId: string) =>
    req<{
      reverted: { frameId: string; name: string }[]
      skipped: { frameId: string; name: string; reason: string }[]
    }>(`/api/canvases/${canvasId}/runs/${runId}/revert`, { method: 'POST' }),
  /* frame history: the same versions the MCP revert_frame tool restores */
  frameVersions: (frameId: string, limit = 20) => req<FrameVersion[]>(`/api/frames/${frameId}/versions?limit=${limit}`),
  frameVersion: (frameId: string, versionId: string) =>
    req<FrameVersion>(`/api/frames/${frameId}/versions/${versionId}`),
  revertFrame: (frameId: string, versionId: string) =>
    req<Frame>(`/api/frames/${frameId}/revert`, { method: 'POST', body: JSON.stringify({ version_id: versionId }) }),
  /* the pixels a version differs by, marked in magenta, plus how much changed */
  frameDiff: (frameId: string, versionId: string) =>
    req<{ png: string; changed_ratio: number }>(`/api/frames/${frameId}/diff`, {
      method: 'POST',
      body: JSON.stringify({ version_id: versionId }),
    }),
  /* render arbitrary frame HTML and answer with raw PNG bytes, handed back
     as an object URL — callers must revoke it (proposal previews) */
  renderPreview: async (html: string, width: number, height: number) => {
    const res = await fetch('/api/frames/render-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, width, height }),
    })
    if (!res.ok) throw new ApiError(res.status, await res.text())
    return URL.createObjectURL(await res.blob())
  },
  /* an agent holds the frame's edit lock; taking it over frees the frame */
  unlockFrame: (frameId: string) => req(`/api/frames/${frameId}/unlock`, { method: 'POST' }),
  /* raw image bytes -> permanent /a/ URL (5 MB cap, type sniffed server-side) */
  uploadAsset: (canvasId: string, blob: Blob) =>
    postAssetBytes<{ url: string; mime: string; size: number }>(`/api/canvases/${canvasId}/assets`, blob),
  /* the canvas's image library, newest first. A page at a time, because a
     canvas that has been importing screens for a while holds a lot of them:
     `has_more` is what the panel's Load more reads. */
  listAssets: (canvasId: string, opts: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.limit !== undefined) q.set('limit', String(opts.limit))
    if (opts.offset !== undefined) q.set('offset', String(opts.offset))
    const qs = q.toString()
    return req<AssetPage>(`/api/canvases/${canvasId}/assets${qs ? `?${qs}` : ''}`)
  },
  /* forget an image for good — unless a frame still embeds it, which the
     server answers as a 409 rather than leaving the frame broken */
  deleteAsset: (assetId: string) => req<{ ok: true }>(`/api/assets/${assetId}`, { method: 'DELETE' }),
  /* swap the bytes behind an asset's URL, rewriting every frame that embeds
     it; `frames` is how many were updated */
  replaceAsset: (canvasId: string, assetId: string, blob: Blob) =>
    postAssetBytes<{ url: string; mime: string; size: number; frames: number }>(
      `/api/canvases/${canvasId}/assets/${assetId}/replace`,
      blob,
    ),
  /* agent-event email, opt-in per account and per kind: a question an agent
     is blocked on, a run that finished, and a run that failed are different
     reasons to be interrupted */
  notifications: () => req<NotificationPrefs>('/api/settings/notifications'),
  setNotifications: (prefs: Partial<NotificationPrefs>) =>
    req<NotificationPrefs>('/api/settings/notifications', {
      method: 'POST',
      body: JSON.stringify(prefs),
    }),
  createFrame: (canvasId: string, input: Partial<Frame> & { name: string }) =>
    req<Frame>(`/api/canvases/${canvasId}/frames`, {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: actor() }),
    }),
  /* A frame write may carry the `updatedAt` the caller read the frame at:
     the write is then refused whole — 409 `stale_frame`, the frame in the
     body, nothing written — when someone else got there first. See
     staleFrameConflict. No expectation = no check, as every write before
     this contract behaved. */
  updateFrame: (frameId: string, patch: Partial<Frame>, opts?: { expectedUpdatedAt?: number }) =>
    req<Frame>('/api/frames/' + frameId, {
      method: 'PATCH',
      body: JSON.stringify({
        ...patch,
        actor: actor(),
        ...(opts?.expectedUpdatedAt !== undefined ? { expected_updated_at: opts.expectedUpdatedAt } : {}),
      }),
    }),
  deleteFrame: (frameId: string) =>
    req('/api/frames/' + frameId, { method: 'DELETE', body: JSON.stringify({ actor: actor() }) }),
  /* restacking answers with the page's frames front-to-back, with their fresh
     z: the returned order is what the client paints, not an echo of the ask */
  moveFrameZ: (frameId: string, dir: 'front' | 'back' | 'forward' | 'backward') =>
    req<Frame[]>('/api/frames/' + frameId + '/z', { method: 'POST', body: JSON.stringify({ dir, actor: actor() }) }),
  /* a rail drag sends the whole explicit order; the server resolves it to z */
  setFrameOrder: (canvasId: string, pageId: string, order: string[]) =>
    req<Frame[]>('/api/canvases/' + canvasId + '/z-order', {
      method: 'POST',
      body: JSON.stringify({ pageId, order, actor: actor() }),
    }),
  /* one component's full record: the markup the library list leaves out, so a
     row can be instanced onto the canvas as a frame */
  getComponent: (id: string) => req<Component>(`/api/components/${id}`),
  /* the library as the panel lists it — metadata and instance counts, no
     markup. Only the server counts instances (it walks the canvas's frames),
     and a new frame broadcasts no components update, so a row refetches this
     to bring its own count up to date. */
  listComponents: (canvasId: string) => req<ComponentSummary[]>(`/api/canvases/${canvasId}/components`),
  /* a new library entry, built from a frame's markup (the panel and the frame
     menu both start here). The server stores the definition; instances onto
     the canvas are frames wrapping it in data-doop-component, which is what
     insertComponent/the panel's Insert build. */
  createComponent: (canvasId: string, input: ComponentInput) =>
    req<Component>(`/api/canvases/${canvasId}/components`, {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: actor() }),
    }),
  /* edit a component in place. Changing the markup rewrites every instance on
     the canvas — the answer says which frames took the change and which could
     not (an agent holding the frame's lock), so the caller can report both. */
  updateComponent: (componentId: string, patch: ComponentPatch) =>
    req<ComponentUpdateResult>(`/api/components/${componentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, actor: actor() }),
    }),
  /* remove a library entry. Refused with 409 while frames still hold an
     instance of it, unless `force` — the frames keep their markup either way,
     they simply stop being bound to a library entry. */
  deleteComponent: (componentId: string, opts: { force?: boolean } = {}) =>
    req<{ ok: true }>(`/api/components/${componentId}${opts.force ? '?force=true' : ''}`, { method: 'DELETE' }),
  /* pages: ordered sub-canvases grouping the canvas's frames */
  createPage: (canvasId: string, name: string) =>
    req<Page>(`/api/canvases/${canvasId}/pages`, {
      method: 'POST',
      body: JSON.stringify({ name, actor: actor() }),
    }),
  updatePage: (pageId: string, patch: { name?: string; position?: number }) =>
    req<{ pages: Page[] }>('/api/pages/' + pageId, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, actor: actor() }),
    }),
  deletePage: (pageId: string) =>
    req<{ ok: true; deletedFrameIds: string[] }>('/api/pages/' + pageId, { method: 'DELETE' }),
  duplicatePage: (pageId: string) =>
    req<{ page: Page; frames: Frame[] }>(`/api/pages/${pageId}/duplicate`, { method: 'POST' }),
  importPage: (canvasId: string, url: string) =>
    req<Frame>(`/api/canvases/${canvasId}/import`, { method: 'POST', body: JSON.stringify({ url }) }),
  discoverSitePages: (canvasId: string, url: string) =>
    req<DiscoveredSite>(`/api/canvases/${canvasId}/import/discover`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  importSitePages: (canvasId: string, urls: string[]) =>
    req<WebsiteImportResult>(`/api/canvases/${canvasId}/import`, {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),
  /** Canvas-wide find & replace — the REST twin of the MCP `replace_in_frames`
   *  tool. Every write is the same per-frame edit the inspector makes, so each
   *  frame keeps its own version history; `dryRun` counts matches without
   *  writing. The route ignores `actor` here, but every canvas call sends it. */
  findReplace: (canvasId: string, input: ReplaceInput) =>
    req<ReplaceResult>(`/api/canvases/${canvasId}/find-replace`, {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: actor() }),
    }),
  modelAccount: () => req<ModelAccountStatus>('/api/model-account'),
  chatgptAuthorize: () =>
    req<{ url: string; state: string; catching: boolean }>('/api/model-account/chatgpt/authorize', { method: 'POST' }),
  startDeviceAuth: () => req<DeviceFlow>('/api/model-account/chatgpt/device', { method: 'POST' }),
  deviceAuthStatus: () => req<DeviceFlow | { status: 'none' }>('/api/model-account/chatgpt/device'),
  cancelDeviceAuth: () => req('/api/model-account/chatgpt/device', { method: 'DELETE' }),
  connectChatgpt: (redirect: string) =>
    req<ModelAccountStatus>('/api/model-account/chatgpt', { method: 'POST', body: JSON.stringify({ redirect }) }),
  connectOpenAiKey: (apiKey: string) =>
    req<ModelAccountStatus>('/api/model-account/openai-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
  disconnectModelAccount: () => req<ModelAccountStatus>('/api/model-account', { method: 'DELETE' }),
  setAgentModel: (model: string) =>
    req<ModelAccountStatus>('/api/model-account', { method: 'PATCH', body: JSON.stringify({ model }) }),
  designWorkflow: () => req<DesignWorkflowStatus>('/api/design-workflow'),
  setDesignWorkflow: (implementerModel: string, judgeModel: string) =>
    req<DesignWorkflowStatus>('/api/design-workflow', {
      method: 'PATCH',
      body: JSON.stringify({ implementerModel, judgeModel }),
    }),
  /** Start the design workflow from a written brief — the same server-side run
   *  the MCP tool starts, started by the person in front of the canvas. The
   *  frame streams in behind this promise, so it resolves when the run is over,
   *  not when it starts. `frameId` redesigns that frame; `pageId` is the page a
   *  new frame lands on. */
  runBrief: (canvasId: string, brief: string, target: { frameId?: string; pageId?: string } = {}) =>
    req<BriefRun>(`/api/canvases/${canvasId}/brief`, {
      method: 'POST',
      body: JSON.stringify({ brief, ...target }),
    }),
  addComment: (frameId: string, input: { selector: string; snippet: string; text: string; stableKey?: string }) =>
    req(`/api/frames/${frameId}/comments`, { method: 'POST', body: JSON.stringify(input) }),
  replyComment: (commentId: string, text: string) =>
    req(`/api/comments/${commentId}/replies`, { method: 'POST', body: JSON.stringify({ text }) }),
  resolveComment: (commentId: string) => req(`/api/comments/${commentId}/resolve`, { method: 'POST' }),
  retryComment: (commentId: string) => req(`/api/comments/${commentId}/retry`, { method: 'POST' }),
  /* ship: a downloadable archive (or the bare source), and the same design
     opened as a pull request against a connected repo */
  exportCanvas: (canvasId: string, format: 'zip' | 'code') =>
    req<{ url: string }>(`/api/canvases/${canvasId}/export`, { method: 'POST', body: JSON.stringify({ format }) }),
  /* one PNG of the active page's visible frames, composited server-side — the
     whole board as a picture, for a share sheet or a changelog. `pageId` picks
     the page; the server falls back to the canvas's first one. */
  exportCanvasImage: (canvasId: string, pageId?: string) =>
    req<{ url: string }>(`/api/canvases/${canvasId}/export-image`, {
      method: 'POST',
      body: JSON.stringify(pageId ? { pageId } : {}),
    }),
  /* `repo` names the connection to spend: the route requires it, and a canvas
     may have more than one connected repository */
  openPullRequest: (canvasId: string, opts?: { repo?: string; message?: string; base?: string }) =>
    req<{ url: string; number: number }>(`/api/canvases/${canvasId}/pull-request`, {
      method: 'POST',
      body: JSON.stringify({
        ...(opts?.repo ? { repo: opts.repo } : {}),
        ...(opts?.message ? { message: opts.message } : {}),
        ...(opts?.base ? { base: opts.base } : {}),
      }),
    }),
  /* push the canvas's later changes onto the pull request already open */
  updatePullRequest: (canvasId: string, message: string, repo?: string) =>
    req<{ url: string }>(`/api/canvases/${canvasId}/pull-request/update`, {
      method: 'POST',
      body: JSON.stringify({ ...(repo ? { repo } : {}), message }),
    }),
  /* releases: frozen snapshots of the canvas, newest first */
  listReleases: async (canvasId: string) => {
    const { releases } = await req<{ releases: CanvasRelease[] }>(`/api/canvases/${canvasId}/releases`)
    return releases
  },
  createRelease: (canvasId: string, name?: string) =>
    req<CanvasRelease>(`/api/canvases/${canvasId}/releases`, {
      method: 'POST',
      body: JSON.stringify({ ...(name ? { name } : {}) }),
    }),
  restoreRelease: (canvasId: string, releaseId: string) =>
    req<{ ok: true }>(`/api/canvases/${canvasId}/releases/${releaseId}/restore`, { method: 'POST' }),
  /* canvas history: checkpoints the server takes on its own — as the canvas is
     edited and before every delete — that the History tab lists, previews,
     compares and restores. A restore is itself checkpointed, so it stays
     undoable here. */
  listCanvasVersions: async (canvasId: string) => {
    const { versions } = await req<{ versions: CanvasVersionSummary[] }>(`/api/canvases/${canvasId}/versions`)
    return versions
  },
  createCanvasVersion: (canvasId: string) =>
    req<CanvasVersionSummary>(`/api/canvases/${canvasId}/versions`, { method: 'POST' }),
  /* a checkpoint's whole snapshot, frames and tokens — fetched when a timeline
     row is opened, never with the list */
  getCanvasVersion: (canvasId: string, versionId: string) =>
    req<CanvasVersion>(`/api/canvases/${canvasId}/versions/${versionId}`),
  restoreCanvasVersion: (canvasId: string, versionId: string) =>
    req<{ ok: true; restored: number; created: number }>(`/api/canvases/${canvasId}/versions/${versionId}/restore`, {
      method: 'POST',
    }),
  /* what restoring this checkpoint would change, as two renders of one page:
     the diff writes no frame, so it is a POST for the body it takes, not for
     what it does. `pageId` picks the page to render; without it the canvas's
     own active page is used. */
  canvasVersionDiff: (canvasId: string, versionId: string, pageId?: string) =>
    req<CanvasVersionDiff>(`/api/canvases/${canvasId}/versions/${versionId}/diff`, {
      method: 'POST',
      body: JSON.stringify(pageId ? { pageId } : {}),
    }),
  /* trash: deleting a canvas, a frame, a page or a component moves it here
     rather than destroying it, so every delete is recoverable until it is
     purged on purpose */
  listTrash: () => req<TrashContents>('/api/trash'),
  restoreTrashedCanvas: (id: string) => req<{ ok: true }>(`/api/trash/canvases/${id}/restore`, { method: 'POST' }),
  purgeTrashedCanvas: (id: string) => req<{ ok: true }>(`/api/trash/canvases/${id}`, { method: 'DELETE' }),
  restoreTrashedFrame: (id: string) => req<{ ok: true }>(`/api/trash/frames/${id}/restore`, { method: 'POST' }),
  purgeTrashedFrame: (id: string) => req<{ ok: true }>(`/api/trash/frames/${id}`, { method: 'DELETE' }),
  /* pages and components are restorable but not purgeable by hand: the rows
     they hold are reachable again through their canvas, so the retention purge
     is the only thing that ends them */
  restoreTrashedPage: (id: string) => req<{ ok: true }>(`/api/trash/pages/${id}/restore`, { method: 'POST' }),
  restoreTrashedComponent: (id: string) => req<{ ok: true }>(`/api/trash/components/${id}/restore`, { method: 'POST' }),
  listMcpAgents: () => req<ConnectedAgent[]>('/api/mcp-agents'),
  revokeMcpAgent: (clientId: string) => req(`/api/mcp-agents/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
  /* the tools whose own MCP annotation says they destroy something: what a
     `destructive` review policy gates without being told, and what the policy
     editor offers as suggestions. Account-level, not per canvas — there is one
     tool registry, so its declarations read the same everywhere */
  destructiveTools: () => req<{ tools: string[] }>('/api/destructive-tools'),
}

export interface AdminCanvas extends CanvasMeta {
  linkAccess: 'edit' | 'none'
  memberCount: number
  owner?: { id: string; name: string; email: string }
}

export interface AdminUser {
  id: string
  name: string
  email: string
  role: string | null
  banned: boolean | null
  createdAt: number
  canvasCount: number
}

/** Instance-admin surface. Every route 404s for non-admins, so a failure here
 *  is indistinguishable from the feature not existing — which is the point. */
export const adminApi = {
  canvases: () => req<{ total: number; canvases: AdminCanvas[] }>('/api/admin/canvases'),
  stats: () => req<{ users: number; canvases: number; frames: number }>('/api/admin/stats'),
  users: () => req<AdminUser[]>('/api/admin/users'),

  /* better-auth's own endpoints, not ours: they swap the session cookie, so
     every caller reloads afterwards rather than trying to reconcile state. */
  impersonate: (userId: string) =>
    req('/api/auth/admin/impersonate-user', { method: 'POST', body: JSON.stringify({ userId }) }),
  stopImpersonating: () => req('/api/auth/admin/stop-impersonating', { method: 'POST' }),

  /* also better-auth's: banning revokes the user's sessions and blocks
     sign-in; the server refuses their MCP tokens separately */
  ban: (userId: string, banReason?: string) =>
    req('/api/auth/admin/ban-user', { method: 'POST', body: JSON.stringify({ userId, banReason }) }),
  unban: (userId: string) => req('/api/auth/admin/unban-user', { method: 'POST', body: JSON.stringify({ userId }) }),
}
