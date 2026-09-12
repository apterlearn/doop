import { desc, eq } from 'drizzle-orm'
import { db } from './db/index.ts'
import { githubConnections } from './db/schema.ts'
import * as githubApp from './githubApp.ts'
import type { McpErrorCode } from './mcpErrors.ts'

/**
 * The write side of the GitHub surface: commit a set of files to a branch and
 * open a pull request — the handoff step that turns a canvas export into
 * something a repository can review. Read-only repo access lives in
 * github.ts (import source); this module only ever adds commits and PRs, so
 * every failure it reports is one of three things the caller can act on:
 * no connection configured, credential lacking the write scopes, or GitHub
 * refusing the request.
 *
 * Credentials are reused from the existing connection rows (github.ts): an
 * App installation mints a short-lived token through githubApp, a fine-grained
 * PAT is used as stored. No new credential material is ever created here.
 */

const GH_API = 'https://api.github.com'

export interface CommitFilesInput {
  /** "owner/name", as stored on the connection */
  repo: string
  /** the branch to commit to — created from `base` when it does not exist */
  branch: string
  /** the branch (or commit) the new branch starts from, and the PR target */
  base: string
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
 *  token (which fails loudly when the install is gone). */
async function credentialFor(repo: string, canvasId?: string): Promise<string> {
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
  if (conn.installationId) return githubApp.installationToken(conn.installationId)
  return conn.token!
}

/** One GitHub API call. Failures always carry GitHub's message; a 403 on a
 *  write names the missing scopes, and an exhausted rate limit reports as 429
 *  so the caller gets a retryable error. */
async function ghRequest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(GH_API + path, {
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
  return (text ? JSON.parse(text) : undefined) as T
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

/** A pull request for this head/base pair already exists on a re-run: report
 *  that one instead of failing the handoff. */
async function openPullRequest(
  token: string,
  repo: string,
  input: { branch: string; base: string; message: string },
): Promise<PullResponse> {
  const title = input.message.split('\n')[0]?.trim() || 'Design update from Doop'
  try {
    return await ghRequest<PullResponse>(token, 'POST', `/repos/${repo}/pulls`, {
      title,
      head: input.branch,
      base: input.base,
      body: input.message,
    })
  } catch (error) {
    if (!(error instanceof GithubWriteError) || error.status !== 422) throw error
    const owner = repo.split('/')[0] ?? ''
    const existing = await ghRequest<PullResponse[]>(
      token,
      'GET',
      `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.branch}`)}&base=${encodeURIComponent(input.base)}&state=open`,
    )
    if (existing.length > 0) return existing[0]!
    throw error
  }
}

/** Commit `files` to `branch` (creating it from `base` when missing) and open
 *  a pull request against `base`. */
export async function commitFiles(input: CommitFilesInput): Promise<CommitFilesResult> {
  const repo = normalizeRepo(input.repo)
  const branch = input.branch.trim()
  const base = input.base.trim()
  if (!branch) throw new GithubWriteError(0, 'branch is required', { code: 'invalid_input' })
  if (!base) throw new GithubWriteError(0, 'base is required', { code: 'invalid_input' })
  if (branch === base)
    throw new GithubWriteError(
      0,
      'branch must differ from base — committing to the base branch directly is not a pull request',
      {
        code: 'invalid_input',
      },
    )
  if (input.files.length === 0) throw new GithubWriteError(0, 'no files to commit', { code: 'invalid_input' })
  if (input.files.some((file) => !file.path || file.path.startsWith('/')))
    throw new GithubWriteError(0, 'file paths must be relative repository paths', { code: 'invalid_input' })

  const token = await credentialFor(repo, input.canvasId)
  const baseCommit = await refCommit(token, repo, base)
  if (!baseCommit) throw new GithubWriteError(404, `base branch "${base}" not found in ${repo}`, { path: 'refs/heads' })
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

  const existing = await refCommit(token, repo, branch)
  if (existing) {
    /* a re-run on the same branch: fast-forward it onto the new commit rather
       than rebuilding the branch from base and losing the earlier commits */
    await ghRequest(token, 'PATCH', `/repos/${repo}/git/refs/heads/${refPath(branch)}`, { sha: commit.sha })
  } else {
    await ghRequest(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
  }

  const pull = await openPullRequest(token, repo, { branch, base, message: input.message })
  return { branch, commit: commit.sha, url: pull.html_url }
}
