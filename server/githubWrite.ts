import { desc, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { githubConnections } from './db/schema.ts'
import * as githubApp from './githubApp.ts'
import type { GithubConnection } from './github.ts'
import type { McpErrorCode } from './mcpErrors.ts'

/**
 * The write side of the GitHub surface: commit a set of files to a branch,
 * open a pull request, and answer the review on it — the handoff step that
 * turns a canvas export into something a repository can review, and the way
 * the reviewer's feedback gets a reply. Read-only repo access lives in
 * github.ts (import source); this module only ever adds commits, pull requests
 * and comments, so every failure it reports is one of three things the caller
 * can act on: no connection configured, credential lacking the write scopes,
 * or GitHub refusing the request.
 *
 * Credentials are reused from the existing connection rows (github.ts): an
 * App installation mints a short-lived token through githubApp, a fine-grained
 * PAT is used as stored. No new credential material is ever created here.
 */

const GH_API = 'https://api.github.com'

/** GitHub caps `per_page` at 100, so a busy pull request can spill past one
 *  page. Ten pages is a thousand items — beyond that the read reports itself
 *  as partial instead of quietly returning half a review. */
const MAX_PAGES = 10

export interface CommitFilesInput {
  /** "owner/name", as stored on the connection */
  repo: string
  /** the branch to commit to — created from `base` when it does not exist */
  branch: string
  /** the PR target; defaults to the connection's branch */
  base?: string
  files: { path: string; content: string }[]
  /** the commit message; its first line becomes the pull request title */
  message: string
  /** narrows the credential lookup to the connections of one canvas */
  canvasId?: string
}

export interface CommitFilesResult {
  branch: string
  commit: string
  url: string
}

/** Carries the HTTP status and GitHub's own message so the MCP layer can map
 *  the failure: `code` is what mcpErrors.codeFor reads. `status` is 0 when the
 *  failure happened before any request was made. */
export class GithubWriteError extends Error {
  readonly status: number
  readonly code: McpErrorCode
  readonly path: string

  constructor(status: number, message: string, options: { code?: McpErrorCode; path?: string } = {}) {
    super(message)
    this.name = 'GithubWriteError'
    this.status = status
    this.path = options.path ?? ''
    this.code = options.code ?? codeForStatus(status)
  }
}

function codeForStatus(status: number): McpErrorCode {
  if (status === 0) return 'unsupported'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 422) return 'invalid_input'
  if (status === 429) return 'rate_limited'
  return 'upstream_failed'
}

/** The repos are stored normalized ("owner/name"); accept a pasted GitHub URL
 *  or a .git suffix the way createConnection does. */
function normalizeRepo(raw: string): string {
  const repo = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new GithubWriteError(0, 'repository must be "owner/name"', { code: 'invalid_input' })
  return repo
}

/** Ref paths keep their slashes (a branch may be "doop/design-1"); only the
 *  segments are encoded. */
function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

/** The newest connection for the repo wins: it is the one the user configured
 *  last, and App installations are preferred implicitly by re-minting their
 *  token (which fails loudly when the install is gone). A canvasId narrows the
 *  lookup to one canvas's connections, so a handoff can never spend a
 *  credential the caller was never granted. */
async function connectionFor(repo: string, canvasId?: string): Promise<GithubConnection> {
  const rows = canvasId
    ? await db
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.canvasId, canvasId))
        .orderBy(desc(githubConnections.createdAt))
    : await db.select().from(githubConnections).orderBy(desc(githubConnections.createdAt))
  const conn = rows.find((row) => row.repo.toLowerCase() === repo.toLowerCase() && (row.installationId || row.token))
  if (!conn)
    throw new GithubWriteError(0, `no GitHub connection for ${repo} — connect the repository to this canvas first`, {
      code: 'unsupported',
    })
  return conn
}

/** The credential a connection should spend right now. */
async function credentialFor(conn: GithubConnection): Promise<string> {
  if (conn.installationId) return githubApp.installationToken(conn.installationId)
  return conn.token!
}

/** One GitHub API call. Failures always carry GitHub's message; a 403 on a
 *  write names the missing scopes, and an exhausted rate limit reports as 429
 *  so the caller gets a retryable error. */
async function ghRequest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  return (await ghRequestPage<T>(token, method, path, body)).data
}

/** ghRequest, but keeping the `Link` header: a paginated read needs to know
 *  whether another page exists. `path` may be absolute, which is the form
 *  GitHub hands back in that header. */
async function ghRequestPage<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; link: string | null }> {
  const res = await fetch(path.startsWith('http') ? path : GH_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'doop-export',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) {
    let message = ''
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? ''
    } catch {
      /* a proxy answered with HTML: fall back to the status line */
    }
    const rateLimited = res.headers.get('x-ratelimit-remaining') === '0'
    const status = rateLimited ? 429 : res.status
    if (!message) message = `GitHub request failed with HTTP ${res.status}`
    if (status === 403) message += ' — the connection needs the contents:write and pull_requests:write permissions'
    throw new GithubWriteError(status, message, { path })
  }
  return { data: (text ? JSON.parse(text) : undefined) as T, link: res.headers.get('link') }
}

/** Every page of a paginated list, following `Link: <url>; rel="next"` until
 *  GitHub stops handing one out or MAX_PAGES is reached. `truncated` says the
 *  cap cut the read short, so a caller never mistakes a partial list for the
 *  whole thing. */
async function ghRequestAll<T>(token: string, path: string): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let next: string | undefined = path
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const { data, link } = await ghRequestPage<T[]>(token, 'GET', next)
    items.push(...data)
    const header: string = link ?? ''
    next = header
      .split(',')
      .map((part: string) => /<([^>]+)>\s*;\s*rel="next"/.exec(part)?.[1])
      .find((url: string | undefined) => url !== undefined)
  }
  return { items, truncated: next !== undefined }
}

interface RefResponse {
  object: { sha: string; type: string }
}

interface BlobResponse {
  sha: string
}

interface TreeResponse {
  sha: string
}

interface CommitResponse {
  sha: string
}

interface PullResponse {
  number: number
  html_url: string
}

/** The commit SHA a branch points at, or undefined when the ref does not
 *  exist yet. */
async function refCommit(token: string, repo: string, branch: string): Promise<string | undefined> {
  try {
    const ref = await ghRequest<RefResponse>(token, 'GET', `/repos/${repo}/git/ref/heads/${refPath(branch)}`)
    return ref.object.sha
  } catch (error) {
    if (error instanceof GithubWriteError && error.status === 404) return undefined
    throw error
  }
}

/** Open the pull request for `headRef` → `baseRef`, or report the one that is
 *  already open for that pair: a re-run of a handoff updates the same pull
 *  request instead of failing because it exists. `created` says which of the
 *  two happened, so a caller can tell "opened" from "found". */
async function ensurePullRequestCore(
  token: string,
  repo: string,
  input: { baseRef: string; headRef: string; title: string; body: string },
): Promise<{ number: number; url: string; created: boolean }> {
  try {
    const pull = await ghRequest<PullResponse>(token, 'POST', `/repos/${repo}/pulls`, {
      title: input.title,
      head: input.headRef,
      base: input.baseRef,
      body: input.body,
    })
    return { number: pull.number, url: pull.html_url, created: true }
  } catch (error) {
    /* GitHub answers a duplicate with 422 and no body worth reading: look the
       open pull request up by its head/base pair and report that one. */
    if (!(error instanceof GithubWriteError) || error.status !== 422) throw error
    const owner = repo.split('/')[0] ?? ''
    const existing = await ghRequest<PullResponse[]>(
      token,
      'GET',
      `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.headRef}`)}&base=${encodeURIComponent(input.baseRef)}&state=open`,
    )
    const [found] = existing
    if (found) return { number: found.number, url: found.html_url, created: false }
    throw error
  }
}

/** A comment or review on a pull request, as the handoff reads it back. */
export interface PullRequestComment {
  id: number
  author: string
  body: string
  /** file the comment is attached to; absent on a conversation comment */
  path?: string
  /** line in the file's new version, when GitHub supplies one */
  line?: number
  createdAt: string
  /** the commit the comment was made against */
  commitId?: string
  /** API URL of the comment itself */
  url: string
}

export interface PullRequestReview {
  author: string
  state: string
  body: string
  submittedAt?: string
}

export interface PullRequestReviewSummary {
  number: number
  title: string
  state: string
  url: string
  head: string
  base: string
  /** conversation comments, then inline review comments, then reviews */
  comments: PullRequestComment[]
  reviews: PullRequestReview[]
  /** files the pull request touches */
  files: string[]
  /** true when a list hit the pagination cap and the read is partial */
  truncated?: boolean
}

interface GithubCommentResponse {
  id: number
  user?: { login?: string } | null
  body?: string | null
  path?: string
  line?: number | null
  original_line?: number | null
  created_at?: string
  commit_id?: string
  html_url?: string
}

function toComment(raw: GithubCommentResponse): PullRequestComment {
  const line = raw.line ?? raw.original_line ?? undefined
  return {
    id: raw.id,
    author: raw.user?.login ?? 'unknown',
    body: raw.body ?? '',
    ...(raw.path ? { path: raw.path } : {}),
    ...(line === undefined || line === null ? {} : { line }),
    createdAt: raw.created_at ?? '',
    ...(raw.commit_id ? { commitId: raw.commit_id } : {}),
    url: raw.html_url ?? '',
  }
}

/** Everything a reviewer said about a pull request: the conversation, the
 *  inline comments and the review verdicts. Read-only, and scoped to the same
 *  canvas connection `open_pull_request` wrote through. */
export async function readPullRequest(
  repo: string,
  pull: number,
  canvasId?: string,
): Promise<PullRequestReviewSummary> {
  const normalized = normalizeRepo(repo)
  if (!Number.isInteger(pull) || pull <= 0)
    throw new GithubWriteError(0, 'pull must be a pull request number', { code: 'invalid_input' })
  const conn = await connectionFor(normalized, canvasId)
  /* the same resolution commitFiles uses: a connection may carry an
     installation instead of a stored token, and the token column is nullable */
  const token = await credentialFor(conn)
  const base = `/repos/${normalized}/pulls/${pull}`
  const [detail, issueComments, reviewComments, reviews, files] = await Promise.all([
    ghRequest<{
      number: number
      title: string
      state: string
      html_url: string
      head?: { ref?: string }
      base?: { ref?: string }
    }>(token, 'GET', base),
    /* the conversation lives on the issue behind the pull request */
    ghRequestAll<GithubCommentResponse>(token, `/repos/${normalized}/issues/${pull}/comments?per_page=100`),
    /* the inline comments on the diff */
    ghRequestAll<GithubCommentResponse>(token, `/repos/${normalized}/pulls/${pull}/comments?per_page=100`),
    ghRequestAll<{ user?: { login?: string } | null; state?: string; body?: string | null; submitted_at?: string }>(
      token,
      `${base}/reviews?per_page=100`,
    ),
    ghRequestAll<{ filename: string }>(token, `${base}/files?per_page=100`),
  ])
  const truncated = [issueComments, reviewComments, reviews, files].some((page) => page.truncated)
  return {
    number: detail.number,
    title: detail.title,
    state: detail.state,
    url: detail.html_url,
    head: detail.head?.ref ?? '',
    base: detail.base?.ref ?? '',
    comments: [...issueComments.items.map(toComment), ...reviewComments.items.map(toComment)].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
    reviews: reviews.items.map((review) => ({
      author: review.user?.login ?? 'unknown',
      state: review.state ?? '',
      body: review.body ?? '',
      ...(review.submitted_at ? { submittedAt: review.submitted_at } : {}),
    })),
    files: files.items.map((file) => file.filename),
    ...(truncated ? { truncated: true } : {}),
  }
}

/** The file set every commit path must carry: a handoff of nothing, or of a
 *  path GitHub cannot place inside the repository, is a caller mistake. */
function assertCommitFiles(files: { path: string; content: string }[]): void {
  if (files.length === 0) throw new GithubWriteError(0, 'no files to commit', { code: 'invalid_input' })
  if (files.some((file) => !file.path || file.path.startsWith('/')))
    throw new GithubWriteError(0, 'file paths must be relative repository paths', { code: 'invalid_input' })
}

/** A pull request needs two distinct refs: committing onto the base branch is
 *  a push, not a handoff. */
function assertDistinctRefs(baseRef: string, headRef: string): void {
  if (baseRef === headRef)
    throw new GithubWriteError(
      0,
      'branch must differ from base — committing to the base branch directly is not a pull request',
      {
        code: 'invalid_input',
      },
    )
}

/** The git half of the handoff: blobs → tree → commit → ref, with no pull
 *  request. It takes the token rather than resolving a connection so a caller
 *  that already holds one (commitFiles) looks its credential up only once. */
async function commitToBranchCore(
  token: string,
  repo: string,
  input: { baseRef: string; headRef: string; files: { path: string; content: string }[]; message: string },
): Promise<{ commitSha: string; branch: string }> {
  const baseCommit = await refCommit(token, repo, input.baseRef)
  if (!baseCommit)
    throw new GithubWriteError(404, `base branch "${input.baseRef}" not found in ${repo}`, { path: 'refs/heads' })
  /* base_tree needs a tree sha; the commit object carries it next to the sha
     we already resolved */
  const baseCommitInfo = await ghRequest<{ tree: { sha: string } }>(
    token,
    'GET',
    `/repos/${repo}/git/commits/${encodeURIComponent(baseCommit)}`,
  )

  const blobs: string[] = []
  for (const file of input.files) {
    const blob = await ghRequest<BlobResponse>(token, 'POST', `/repos/${repo}/git/blobs`, {
      content: file.content,
      encoding: 'utf-8',
    })
    blobs.push(blob.sha)
  }
  const tree = await ghRequest<TreeResponse>(token, 'POST', `/repos/${repo}/git/trees`, {
    base_tree: baseCommitInfo.tree.sha,
    tree: input.files.map((file, index) => ({ path: file.path, mode: '100644', type: 'blob', sha: blobs[index] })),
  })
  const commit = await ghRequest<CommitResponse>(token, 'POST', `/repos/${repo}/git/commits`, {
    message: input.message,
    tree: tree.sha,
    parents: [baseCommit],
  })

  const existing = await refCommit(token, repo, input.headRef)
  if (existing) {
    /* a re-run on the same branch: fast-forward it onto the new commit rather
       than rebuilding the branch from base and losing the earlier commits */
    await ghRequest(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(input.headRef)}`, { sha: commit.sha })
  } else {
    await ghRequest(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${input.headRef}`, sha: commit.sha })
  }
  return { commitSha: commit.sha, branch: input.headRef }
}

export interface CommitToBranchInput {
  /** "owner/name", as stored on the connection */
  repo: string
  /** the branch the commit is based on — resolved to a tree, never written */
  baseRef: string
  /** the branch to commit to — created from `baseRef` when it does not exist */
  headRef: string
  files: { path: string; content: string }[]
  message: string
  /** narrows the credential lookup to the connections of one canvas */
  canvasId?: string
}

/** Commit `files` to `headRef` (creating it from `baseRef` when missing) and
 *  stop there — the pull request is `ensurePullRequest`'s job, so an export
 *  step can put a commit on a branch without one. */
export async function commitToBranch(input: CommitToBranchInput): Promise<{ commitSha: string; branch: string }> {
  const repo = normalizeRepo(input.repo)
  const baseRef = input.baseRef.trim()
  const headRef = input.headRef.trim()
  if (!headRef) throw new GithubWriteError(0, 'branch is required', { code: 'invalid_input' })
  if (!baseRef) throw new GithubWriteError(0, 'base branch is required', { code: 'invalid_input' })
  assertDistinctRefs(baseRef, headRef)
  assertCommitFiles(input.files)
  const conn = await connectionFor(repo, input.canvasId)
  const token = await credentialFor(conn)
  return commitToBranchCore(token, repo, { baseRef, headRef, files: input.files, message: input.message })
}

export interface EnsurePullRequestInput {
  /** "owner/name", as stored on the connection */
  repo: string
  /** the branch the pull request merges into */
  baseRef: string
  /** the branch holding the commits */
  headRef: string
  title: string
  body: string
  /** narrows the credential lookup to the connections of one canvas */
  canvasId?: string
}

/** Open the pull request for `headRef` → `baseRef`. A pull request already open
 *  for that pair is reported with `created: false` instead of failing, so a
 *  re-run (or an update on top of an earlier handoff) keeps one pull request. */
export async function ensurePullRequest(
  input: EnsurePullRequestInput,
): Promise<{ number: number; url: string; created: boolean }> {
  const repo = normalizeRepo(input.repo)
  const baseRef = input.baseRef.trim()
  const headRef = input.headRef.trim()
  if (!headRef) throw new GithubWriteError(0, 'branch is required', { code: 'invalid_input' })
  if (!baseRef) throw new GithubWriteError(0, 'base branch is required', { code: 'invalid_input' })
  assertDistinctRefs(baseRef, headRef)
  const conn = await connectionFor(repo, input.canvasId)
  const token = await credentialFor(conn)
  return ensurePullRequestCore(token, repo, { baseRef, headRef, title: input.title, body: input.body })
}

/** Commit `files` to `branch` (creating it from `base` when missing) and open
 *  a pull request against `base` — the two halves above, composed. Both halves
 *  run on the one connection resolved here: resolving again could hand the
 *  commit and the pull request different credentials. */
export async function commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
  const repo = normalizeRepo(input.repo)
  const branch = input.branch.trim()
  if (!branch) throw new GithubWriteError(0, 'branch is required', { code: 'invalid_input' })
  assertCommitFiles(input.files)

  const conn = await connectionFor(repo, input.canvasId)
  /* The connection's branch is the repo's default branch unless the user
     pinned another one when connecting — never a hard-coded "main". */
  const base = input.base?.trim() || conn.branch || 'main'
  assertDistinctRefs(base, branch)
  const token = await credentialFor(conn)
  const commit = await commitToBranchCore(token, repo, {
    baseRef: base,
    headRef: branch,
    files: input.files,
    message: input.message,
  })
  const pull = await ensurePullRequestCore(token, repo, {
    baseRef: base,
    headRef: branch,
    /* the commit message's first line is the pull request title */
    title: input.message.split('\n')[0]?.trim() || 'Design update from Doop',
    body: input.message,
  })
  return { branch, commit: commit.commitSha, url: pull.url }
}

export interface CommentPullRequestInput {
  /** "owner/name", as stored on the connection */
  repo: string
  prNumber: number
  body: string
  /** answer this inline review comment instead of adding to the conversation */
  inReplyTo?: number
  /** narrows the credential lookup to the connections of one canvas */
  canvasId?: string
}

interface CommentResponse {
  id: number
}

/** Say something back on a handoff pull request: a comment in the conversation,
 *  or — with `inReplyTo` — an answer on one of the inline review comments, which
 *  is what keeps a reviewer's thread attached to the file and line it is about. */
export async function commentPullRequest(input: CommentPullRequestInput): Promise<{ commentId: number }> {
  const repo = normalizeRepo(input.repo)
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0)
    throw new GithubWriteError(0, 'prNumber must be a pull request number', { code: 'invalid_input' })
  if (!input.body.trim()) throw new GithubWriteError(0, 'comment body is required', { code: 'invalid_input' })
  if (input.inReplyTo !== undefined && (!Number.isInteger(input.inReplyTo) || input.inReplyTo <= 0))
    throw new GithubWriteError(0, 'inReplyTo must be a comment id', { code: 'invalid_input' })
  const conn = await connectionFor(repo, input.canvasId)
  const token = await credentialFor(conn)
  /* the conversation lives on the issue behind the pull request; a reply has to
     go through the pull request's own comment thread to stay inline */
  const path = input.inReplyTo
    ? `/repos/${repo}/pulls/${input.prNumber}/comments/${input.inReplyTo}/replies`
    : `/repos/${repo}/issues/${input.prNumber}/comments`
  const created = await ghRequest<CommentResponse>(token, 'POST', path, { body: input.body })
  return { commentId: created.id }
}
