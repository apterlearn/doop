import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { closeDb, db, initDb } from '../server/db/index.ts'
import { githubConnections } from '../server/db/schema.ts'
import {
  commentPullRequest,
  commitFiles,
  commitToBranch,
  ensurePullRequest,
  GithubWriteError,
  readPullRequest,
} from '../server/githubWrite.ts'

/**
 * The PR handoff: the credential has to come from the calling canvas's own
 * connections, and the PR target has to be the repo's real default branch —
 * a hard-coded "main" fails on every repo that uses "master". GitHub itself is
 * stubbed; everything up to the wire is the real code path.
 */

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'doop-ghwrite-'))
  vi.spyOn(process, 'cwd').mockReturnValue(tmp)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  vi.restoreAllMocks()
  await fs.rm(tmp, { recursive: true, force: true })
})

type ConnectionRow = typeof githubConnections.$inferInsert

function connection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: `conn-${Math.random().toString(36).slice(2, 10)}`,
    canvasId: 'c-handoff',
    repo: 'acme/app',
    branch: 'master',
    token: 'ghp_token',
    installationId: null,
    deployUrl: null,
    createdBy: 'owner',
    createdAt: Date.now(),
    lastSyncedAt: null,
    ...overrides,
  }
}

interface Call {
  method: string
  url: string
  body: Record<string, unknown> | undefined
}

/** A GitHub that answers the exact calls commitFiles makes, recording them.
 *  `baseBranch` is the branch ref the repo actually has. */
function stubGithub(baseBranch = 'master'): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    calls.push({ method, url, body })
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (url.endsWith(`/git/ref/heads/${baseBranch}`)) return json({ object: { sha: 'base-sha', type: 'commit' } })
    /* any other ref is missing, the way GitHub answers an unknown branch */
    if (url.includes('/git/ref/heads/')) return json({ message: 'Not Found' }, 404)
    if (url.includes('/git/commits/base-sha')) return json({ tree: { sha: 'base-tree' } })
    if (url.endsWith('/git/blobs')) return json({ sha: `blob-${calls.length}` })
    if (url.endsWith('/git/trees')) return json({ sha: 'new-tree' })
    if (url.endsWith('/git/commits')) return json({ sha: 'new-commit' })
    if (url.endsWith('/git/refs')) return json({ ref: 'refs/heads/doop/c-handoff' })
    if (url.endsWith('/pulls')) return json({ number: 7, html_url: 'https://github.com/acme/app/pull/7' })
    return json({ message: `unexpected ${method} ${url}` }, 500)
  })
  return calls
}

const FILES = [{ path: 'design/home.html', content: '<h1>hi</h1>' }]

/** A GitHub that answers every call with `respond`'s payload, recording them —
 *  for the endpoints a test drives on their own rather than the whole commit
 *  pipeline `stubGithub` replays. */
function stubGithubEndpoints(respond: (call: Call) => { status?: number; payload: unknown }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const call = { method, url, body }
    calls.push(call)
    const { status = 200, payload } = respond(call)
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  return db.delete(githubConnections)
})

describe('open_pull_request credential scoping', () => {
  it('refuses a repo with no connection, naming the repo', async () => {
    stubGithub()
    await expect(
      commitFiles({
        repo: 'acme/app',
        branch: 'doop/c-handoff',
        files: FILES,
        message: 'Design',
        canvasId: 'c-handoff',
      }),
    ).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('acme/app') })
  })

  it('cannot spend another canvas’s connection', async () => {
    await db.insert(githubConnections).values(connection({ canvasId: 'c-somewhere-else' }))
    stubGithub()
    await expect(
      commitFiles({
        repo: 'acme/app',
        branch: 'doop/c-handoff',
        files: FILES,
        message: 'Design',
        canvasId: 'c-handoff',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('open_pull_request base branch', () => {
  it('targets the connection’s own branch, not a hard-coded main', async () => {
    await db.insert(githubConnections).values(connection())
    const calls = stubGithub()
    const result = await commitFiles({
      repo: 'acme/app',
      branch: 'doop/c-handoff',
      files: FILES,
      message: 'Design update',
      canvasId: 'c-handoff',
    })
    expect(result.url).toBe('https://github.com/acme/app/pull/7')
    expect(calls.some((c) => c.url.endsWith('/git/ref/heads/master'))).toBe(true)
    expect(calls.find((c) => c.url.endsWith('/pulls'))?.body).toMatchObject({ base: 'master' })
  })

  it('honours an explicit base over the connection branch', async () => {
    await db.insert(githubConnections).values(connection({ branch: 'master' }))
    const calls = stubGithub('develop')
    await commitFiles({
      repo: 'acme/app',
      branch: 'doop/c-handoff',
      base: 'develop',
      files: FILES,
      message: 'Design update',
      canvasId: 'c-handoff',
    })
    expect(calls.find((c) => c.url.endsWith('/pulls'))?.body).toMatchObject({ base: 'develop' })
  })

  it('reports a missing base branch as not_found rather than a generic failure', async () => {
    await db.insert(githubConnections).values(connection({ branch: 'trunk' }))
    stubGithub()
    await expect(
      commitFiles({ repo: 'acme/app', branch: 'doop/c-handoff', files: FILES, message: 'x', canvasId: 'c-handoff' }),
    ).rejects.toMatchObject({ code: 'not_found', message: /not found/ })
  })
})

/* The handoff split in two: a commit a caller can make without opening a pull
   request, and the pull request a re-run finds instead of duplicating. */
describe('commitToBranch', () => {
  it('commits the files to the branch without opening a pull request', async () => {
    await db.insert(githubConnections).values(connection())
    const calls = stubGithub()
    const result = await commitToBranch({
      repo: 'acme/app',
      baseRef: 'master',
      headRef: 'doop/c-handoff',
      files: FILES,
      message: 'Design update',
      canvasId: 'c-handoff',
    })
    expect(result).toEqual({ commitSha: 'new-commit', branch: 'doop/c-handoff' })
    expect(calls.find((c) => c.url.endsWith('/git/commits'))?.body).toMatchObject({ message: 'Design update' })
    expect(calls.find((c) => c.url.endsWith('/git/refs'))?.body).toMatchObject({
      ref: 'refs/heads/doop/c-handoff',
      sha: 'new-commit',
    })
    expect(calls.some((c) => c.url.endsWith('/pulls'))).toBe(false)
  })
})

describe('ensurePullRequest', () => {
  it('reports a freshly created pull request as created', async () => {
    await db.insert(githubConnections).values(connection())
    const calls = stubGithubEndpoints(() => ({
      status: 201,
      payload: { number: 7, html_url: 'https://github.com/acme/app/pull/7' },
    }))
    const result = await ensurePullRequest({
      repo: 'acme/app',
      baseRef: 'master',
      headRef: 'doop/c-handoff',
      title: 'Design update',
      body: 'Design update\n\nSecond paragraph.',
      canvasId: 'c-handoff',
    })
    expect(result).toEqual({ number: 7, url: 'https://github.com/acme/app/pull/7', created: true })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/app/pulls',
        body: {
          title: 'Design update',
          head: 'doop/c-handoff',
          base: 'master',
          body: 'Design update\n\nSecond paragraph.',
        },
      },
    ])
  })

  it('finds the pull request GitHub already has instead of failing the re-run', async () => {
    await db.insert(githubConnections).values(connection())
    const calls = stubGithubEndpoints((call) =>
      call.method === 'POST'
        ? { status: 422, payload: { message: 'A pull request already exists for acme:doop/c-handoff.' } }
        : { payload: [{ number: 9, html_url: 'https://github.com/acme/app/pull/9' }] },
    )
    const result = await ensurePullRequest({
      repo: 'acme/app',
      baseRef: 'master',
      headRef: 'doop/c-handoff',
      title: 'Design update',
      body: 'Design update',
      canvasId: 'c-handoff',
    })
    expect(result).toEqual({ number: 9, url: 'https://github.com/acme/app/pull/9', created: false })
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/acme/app/pulls?head=acme%3Adoop%2Fc-handoff&base=master&state=open',
    )
  })
})

/* The review loop back: a comment on the pull request has to reach the agent
   that opened it, with the file and line it is about — otherwise the reviewer's
   feedback dies in GitHub. GitHub is stubbed; the parsing and the scoping are
   the real code. */
describe('get_pull_request_review', () => {
  it('returns the conversation, the inline comments and the reviews', async () => {
    await db.insert(githubConnections).values(connection())
    vi.stubGlobal('fetch', async (url: string) => {
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.endsWith('/pulls/7')) {
        return json({
          number: 7,
          title: 'Design handoff',
          state: 'open',
          html_url: 'https://github.com/acme/app/pull/7',
          head: { ref: 'doop/c-handoff' },
          base: { ref: 'main' },
        })
      }
      if (url.endsWith('/pulls/7/comments?per_page=100')) {
        return json([
          {
            id: 1,
            user: { login: 'dev' },
            body: 'the hero is too tall',
            path: 'design/home.html',
            line: 12,
            created_at: '2026-09-13T10:00:00Z',
            html_url: 'https://github.com/acme/app/pull/7#discussion_r1',
          },
        ])
      }
      if (url.endsWith('/issues/7/comments?per_page=100')) {
        return json([{ id: 2, user: { login: 'pm' }, body: 'ship it after that', created_at: '2026-09-13T09:00:00Z' }])
      }
      if (url.endsWith('/pulls/7/reviews?per_page=100')) {
        return json([
          {
            user: { login: 'dev' },
            state: 'CHANGES_REQUESTED',
            body: 'needs work',
            submitted_at: '2026-09-13T11:00:00Z',
          },
        ])
      }
      if (url.endsWith('/pulls/7/files?per_page=100')) return json([{ filename: 'design/home.html' }])
      return json({ message: `unexpected ${url}` })
    })

    const summary = await readPullRequest('acme/app', 7, 'c-handoff')
    expect(summary).toMatchObject({
      number: 7,
      state: 'open',
      head: 'doop/c-handoff',
      base: 'main',
      files: ['design/home.html'],
    })
    /* oldest first: a reviewer reads the thread in the order it happened */
    expect(summary.comments.map((c) => c.author)).toEqual(['pm', 'dev'])
    expect(summary.comments[1]).toMatchObject({ path: 'design/home.html', line: 12, body: 'the hero is too tall' })
    expect(summary.reviews).toEqual([
      { author: 'dev', state: 'CHANGES_REQUESTED', body: 'needs work', submittedAt: '2026-09-13T11:00:00Z' },
    ])
  })

  it('uses the calling canvas’s connection, and says so when there is none', async () => {
    /* the connection belongs to another canvas */
    await db.insert(githubConnections).values(connection({ canvasId: 'c-other' }))
    await expect(readPullRequest('acme/app', 7, 'c-handoff')).rejects.toBeInstanceOf(GithubWriteError)
  })

  it('rejects a pull number that is not a number', async () => {
    await db.insert(githubConnections).values(connection())
    await expect(readPullRequest('acme/app', 0, 'c-handoff')).rejects.toThrow(/pull request number/)
  })
})

/* The other direction of that loop: the agent answers the reviewer, and the
   answer lands in the thread the comment lives in rather than beside it. */
describe('commentPullRequest', () => {
  it('posts a comment into the pull request conversation', async () => {
    await db.insert(githubConnections).values(connection())
    const calls = stubGithubEndpoints(() => ({ status: 201, payload: { id: 41 } }))
    const result = await commentPullRequest({
      repo: 'acme/app',
      prNumber: 7,
      body: 'Fixed the hero height',
      canvasId: 'c-handoff',
    })
    expect(result).toEqual({ commentId: 41 })
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/app/issues/7/comments',
        body: { body: 'Fixed the hero height' },
      },
    ])
  })

  it('answers an inline comment on the pull request’s own thread', async () => {
    await db.insert(githubConnections).values(connection())
    const calls = stubGithubEndpoints(() => ({ status: 201, payload: { id: 42 } }))
    await commentPullRequest({
      repo: 'acme/app',
      prNumber: 7,
      body: 'Good catch — the hero is 480px now',
      inReplyTo: 314,
      canvasId: 'c-handoff',
    })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/app/pulls/7/comments/314/replies')
    expect(calls[0]?.body).toEqual({ body: 'Good catch — the hero is 480px now' })
  })

  it('reports a missing pull request as not_found', async () => {
    await db.insert(githubConnections).values(connection())
    stubGithubEndpoints(() => ({ status: 404, payload: { message: 'Not Found' } }))
    await expect(
      commentPullRequest({ repo: 'acme/app', prNumber: 7, body: 'hello', canvasId: 'c-handoff' }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})
