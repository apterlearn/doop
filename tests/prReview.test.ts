import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, db, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { githubConnections } from '../server/db/schema.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The review loop back: a reviewer's comment has to reach the agent that
   opened the pull request, with the file and line it is about, and a comment
   on a frame's file has to name the frame so the agent can act on it. No
   render is involved, so this file needs no browser. GitHub is stubbed; the
   path-to-frame mapping and the credential scoping are the real code. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-pr-review-'))
const OWNER_ID = 'pr-review-owner'
const REPO = 'acme/app'

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
  /* the same drain the server runs on shutdown: frame writes are debounced, and
     a pending one would be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
}, 60_000)

afterEach(async () => {
  globalThis.fetch = realFetch
  await db.delete(githubConnections)
})

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Owner', OWNER_ID)
  const client = new Client({ name: 'doop-pr-review-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

/** A GitHub that answers only the reads `get_pull_request_review` makes. */
const realFetch = globalThis.fetch

function stubPullRequest(paths: { onFrame: string; other: string }) {
  globalThis.fetch = (async (url: string) => {
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/pulls/7')) {
      return json({
        number: 7,
        title: 'Design handoff',
        state: 'open',
        html_url: 'https://github.com/acme/app/pull/7',
        head: { ref: 'doop/c-pr-review' },
        base: { ref: 'main' },
      })
    }
    if (url.includes('/issues/7/comments')) {
      return json([{ id: 3, user: { login: 'pm' }, body: 'ship it after that', created_at: '2026-09-13T09:00:00Z' }])
    }
    if (url.includes('/pulls/7/comments')) {
      return json([
        {
          id: 1,
          user: { login: 'dev' },
          body: 'hero is too tall',
          path: paths.onFrame,
          line: 4,
          created_at: '2026-09-13T10:00:00Z',
        },
        {
          id: 2,
          user: { login: 'dev' },
          body: 'unrelated to a frame',
          path: paths.other,
          line: 1,
          created_at: '2026-09-13T10:05:00Z',
        },
      ])
    }
    if (url.includes('/pulls/7/reviews')) {
      return json([
        {
          user: { login: 'dev' },
          state: 'CHANGES_REQUESTED',
          body: 'needs work',
          submitted_at: '2026-09-13T11:00:00Z',
        },
      ])
    }
    if (url.includes('/pulls/7/files')) return json([{ filename: paths.onFrame }])
    return json({ message: `unexpected ${url}` })
  }) as unknown as typeof fetch
}

let frames: Frame[] = []
let canvasId = ''
let counter = 0

beforeEach(() => {
  counter += 1
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  canvasId = `c-pr-review-${counter}`
  const canvas: Canvas = {
    id: canvasId,
    name: `Review ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  /* two frames with the SAME name: the handoff disambiguates them by id, and a
     comment has to map back to the right one */
  frames = [
    store.createFrame(canvasId, { name: 'Home', html: '<h1>Home</h1>', width: 1440, height: 900 }, 'Owner')!,
    store.createFrame(canvasId, { name: 'Home', html: '<h1>Second</h1>', width: 1440, height: 900 }, 'Owner')!,
  ]
})

function connection() {
  return {
    id: `conn-${counter}`,
    canvasId,
    repo: REPO,
    branch: 'main',
    token: 'ghp_token',
    installationId: null,
    deployUrl: null,
    createdBy: 'owner',
    createdAt: Date.now(),
    lastSyncedAt: null,
  }
}

describe('get_pull_request_review', () => {
  it('brings a reviewer’s inline comment back with the frame it is about', async () => {
    await db.insert(githubConnections).values(connection())
    const onFrame = `design/home-${frames[0]!.id}.html`
    stubPullRequest({ onFrame, other: 'README.md' })
    const { client, close } = await connect()
    try {
      const review = await callTool(client, 'get_pull_request_review', {
        canvas_id: canvasId,
        repo: REPO,
        pull: 7,
        agent_name: 'Claude',
      })
      expect(review.isError).toBeFalsy()
      const comments = review.parsed.comments as unknown as {
        author: string
        body: string
        path?: string
        line?: number
        frame_id?: string
      }[]
      /* oldest first: a reviewer reads the thread in the order it happened */
      expect(comments.map((comment) => comment.author)).toEqual(['pm', 'dev', 'dev'])

      const onTheFrame = comments.find((comment) => comment.path === onFrame)!
      expect(onTheFrame.body).toBe('hero is too tall')
      expect(onTheFrame.line).toBe(4)
      /* the frame the file belongs to, so the agent can act on the comment */
      expect(onTheFrame.frame_id).toBe(frames[0]!.id)

      /* a comment on a file that is not a frame names no frame */
      const other = comments.find((comment) => comment.path === 'README.md')!
      expect(other.frame_id).toBeUndefined()

      expect(review.parsed.files).toEqual([onFrame])
      expect(review.parsed.reviews).toEqual([{ author: 'dev', state: 'CHANGES_REQUESTED', body: 'needs work' }])
    } finally {
      await close()
    }
  }, 60_000)

  it('names the frame by the file the handoff actually wrote, not by guesswork', async () => {
    await db.insert(githubConnections).values(connection())
    /* a frame whose name is unique gets no id suffix, so the mapping has to
       work for both shapes of handoff file name */
    store.createFrame(canvasId, { name: 'Pricing', html: '<h1>Pricing</h1>' }, 'Owner')
    const unique = store.getCanvas(canvasId)!.frames.find((f) => f.name === 'Pricing')!
    stubPullRequest({ onFrame: 'design/pricing.spec.md', other: 'design/not-a-frame.txt' })
    const { client, close } = await connect()
    try {
      const review = await callTool(client, 'get_pull_request_review', {
        canvas_id: canvasId,
        repo: REPO,
        pull: 7,
        agent_name: 'Claude',
      })
      const comments = review.parsed.comments as unknown as { path?: string; frame_id?: string }[]
      expect(comments.find((c) => c.path === 'design/pricing.spec.md')?.frame_id).toBe(unique.id)
      /* a path that is not a frame document names no frame */
      expect(comments.find((c) => c.path === 'design/not-a-frame.txt')?.frame_id).toBeUndefined()
    } finally {
      await close()
    }
  }, 60_000)

  it('refuses when the canvas has no connection for that repo', async () => {
    /* no connection row at all: the read must not fall back to any other
       canvas's credential */
    stubPullRequest({ onFrame: 'design/home.html', other: 'README.md' })
    const { client, close } = await connect()
    try {
      const review = await callTool(client, 'get_pull_request_review', {
        canvas_id: canvasId,
        repo: REPO,
        pull: 7,
        agent_name: 'Claude',
      })
      expect(review.isError).toBe(true)
      /* no connection for this repo on this canvas: the capability is not
         available, which is what `unsupported` means */
      expect((review.parsed.error as unknown as { code: string }).code).toBe('unsupported')
      expect((review.parsed.error as unknown as { message: string }).message).toContain(REPO)
    } finally {
      await close()
    }
  }, 60_000)
})
