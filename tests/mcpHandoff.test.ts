import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, db, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { githubConnections } from '../server/db/schema.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* The handoff is the end of the workflow: what the PR actually contains, and
   whether a reviewer's comment can find its way back to the frame it is about.
   The GitHub side is stubbed; the file set, the naming and the path-to-frame
   mapping are the real code. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-handoff-'))
const OWNER_ID = 'handoff-owner'
const CANVAS_ID = 'c-handoff-mcp'
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
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await db.delete(githubConnections)
})

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Owner', OWNER_ID)
  const client = new Client({ name: 'doop-handoff-test', version: '1.0.0' })
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
  let parsed: Record<string, never> = {} as Record<string, never>
  try {
    parsed = JSON.parse(raw) as Record<string, never>
  } catch {
    /* not a JSON payload */
  }
  return { parsed, raw, isError: result.isError }
}

/** A GitHub that answers the calls commitFiles makes and records every blob,
 *  so the test can see exactly which files the pull request would contain. */
function stubCommitFlow(): { files: { path: string; content: string }[] } {
  const captured = { files: [] as { path: string; content: string }[] }
  const blobs: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/git/ref/heads/main')) return json({ object: { sha: 'base-sha', type: 'commit' } })
    if (url.includes('/git/ref/heads/doop/')) return json({}, 404)
    if (url.includes('/git/commits/base-sha')) return json({ tree: { sha: 'base-tree' } })
    if (url.endsWith('/git/blobs')) {
      const sha = `blob-${blobs.length}`
      blobs.push(sha)
      captured.files.push({ path: '', content: String(body?.content ?? '') })
      return json({ sha })
    }
    if (url.endsWith('/git/trees')) {
      for (const entry of (body?.tree ?? []) as { path: string; sha: string }[]) {
        const index = blobs.indexOf(entry.sha)
        if (index >= 0) captured.files[index]!.path = entry.path
      }
      return json({ sha: 'new-tree' })
    }
    if (url.endsWith('/git/commits')) return json({ sha: 'new-commit' })
    if (url.endsWith('/git/refs')) return json({ ref: 'refs/heads/doop/c-handoff-mcp' })
    if (url.endsWith('/pulls')) return json({ number: 7, html_url: 'https://github.com/acme/app/pull/7' })
    if (url.includes(`/pulls/7/comments`)) {
      return json([
        {
          id: 1,
          user: { login: 'dev' },
          body: 'hero is too tall',
          /* the reviewer comments on the file the handoff actually wrote —
             two frames share a name, so it carries the frame id */
          path: `design/home-${frames[0]!.id}.html`,
          line: 4,
          created_at: '2026-09-13T10:00:00Z',
        },
        {
          id: 2,
          user: { login: 'dev' },
          body: 'unrelated to a frame',
          path: 'README.md',
          line: 1,
          created_at: '2026-09-13T10:05:00Z',
        },
      ])
    }
    if (url.includes('/issues/7/comments')) return json([])
    if (url.includes('/pulls/7/reviews')) return json([])
    if (url.includes('/pulls/7/files')) return json([{ filename: `design/home-${frames[0]!.id}.html` }])
    if (url.endsWith('/pulls/7')) {
      return json({
        number: 7,
        title: 'Design handoff',
        state: 'open',
        html_url: 'https://github.com/acme/app/pull/7',
        head: { ref: 'doop/c-handoff-mcp' },
        base: { ref: 'main' },
      })
    }
    return json({ message: `unexpected ${method} ${url}` }, 500)
  })
  return captured
}

let frames: Frame[] = []
let counter = 0

beforeEach(() => {
  counter += 1
  actions.wire(
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    tasks: new Map(),
    feedback: new Map(),
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
    plans: new Map(),
  })
  /* the canvas is installed directly rather than created through the store:
     the fixture needs a known id, and this keeps the fire-and-forget writes to
     the frames alone */
  const canvasId = `${CANVAS_ID}-${counter}`
  const canvas: Canvas = {
    id: canvasId,
    name: `Handoff ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
    tokens: {
      colors: { ink: '#111110' },
      fonts: { body: 'Inter' },
      spacing: [4, 8],
      radii: [8],
      shadows: [],
      type: { size: [16], weight: [400], leading: [1.5] },
      updatedAt: 0,
      updatedBy: 'Owner',
    },
  }
  store.init([canvas])
  frames = [
    store.createFrame(canvasId, { name: 'Home', html: PAGE('<h1>Home</h1>'), width: 1440, height: 900 }, 'Owner')!,
    store.createFrame(canvasId, { name: 'Home', html: PAGE('<h1>Second</h1>'), width: 1440, height: 900 }, 'Owner')!,
  ]
})

function PAGE(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>body{margin:0;font-family:Inter,system-ui;color:#111110;background:#fff}h1{font-size:32px;line-height:1.25}</style></head><body><main style="min-height:700px">${body}</main></body></html>`
}

function connection() {
  return {
    id: `conn-${counter}`,
    canvasId: `${CANVAS_ID}-${counter}`,
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

describe.skipIf(!findBrowserPath())('the pull request handoff', () => {
  it('commits the documents, the components, the specs and the design system', async () => {
    await db.insert(githubConnections).values(connection())
    const captured = stubCommitFlow()
    const { client, close } = await connect()
    try {
      const opened = await callTool(client, 'open_pull_request', {
        canvas_id: `${CANVAS_ID}-${counter}`,
        repo: REPO,
        message: 'Design handoff',
        agent_name: 'Claude',
      })
      expect(opened.isError).toBeFalsy()
      expect(opened.parsed.url).toBe('https://github.com/acme/app/pull/7')

      const paths = captured.files.map((file) => file.path)
      /* two frames share a name, so the handoff has to keep them apart */
      expect(paths).toContain(`design/home-${frames[0]!.id}.html`)
      expect(paths).toContain(`design/home-${frames[1]!.id}.html`)
      expect(paths).toContain(`design/home-${frames[0]!.id}.jsx`)
      expect(paths).toContain(`design/home-${frames[0]!.id}.spec.md`)
      expect(paths).toContain('design/tokens.css')
      expect(paths).toContain('design/tokens.dtcg.json')
      expect(paths).toContain('design/tailwind.css')
      expect(paths).toContain('design/DESIGN.md')
      expect(paths).toContain('design/AGENTS.md')

      /* the files carry the design, not a placeholder */
      const spec = captured.files.find((file) => file.path.endsWith('.spec.md'))!
      expect(spec.content).toContain('# Home — build spec')
      expect(spec.content).toContain('## Type ramp')
      const jsx = captured.files.find((file) => file.path.endsWith('.jsx'))!
      expect(jsx.content).toContain('export function')
      expect(jsx.content).toContain('<h1>')
      const dtcg = captured.files.find((file) => file.path === 'design/tokens.dtcg.json')!
      expect(JSON.parse(dtcg.content).color.ink).toEqual({ $type: 'color', $value: '#111110' })
      const agents = captured.files.find((file) => file.path === 'design/AGENTS.md')!
      expect(agents.content).toContain('ready_for_review')
    } finally {
      await close()
    }
  }, 60_000)
})
