import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer, TOOL_DOMAINS } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { closeDb, db, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { githubConnections } from '../server/db/schema.ts'
import { githubFrameMarker } from '../server/github.ts'
import type { Canvas } from '../shared/types.ts'

/* Reading a repository over MCP: what its recon finds, and landing one of its
   screens as a frame. The GitHub side is stubbed — the tree, the screen
   enumeration and the frame the import actually creates are the real code. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-repo-'))
const OWNER_ID = 'repo-owner'
const CANVAS_ID = 'c-repo-mcp'
const REPO = 'acme/app'

/** The fixture repository: a Next.js app with a component library and one
 *  committed HTML page, so every screen kind the recon enumerates is present. */
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '18' } }),
  'app/globals.css': ':root{--brand:#2743ee}\nbody{margin:0;font-family:Inter,system-ui}',
  'app/page.tsx': 'export default function Home() {\n  return <main><h1>Home</h1></main>\n}\n',
  'app/pricing/page.tsx':
    "import { Button } from '@/components/Button'\n\nexport default function Pricing() {\n  return <main><h1>Pricing</h1><Button /></main>\n}\n",
  'src/components/Button.tsx': 'export function Button() {\n  return <button>Buy</button>\n}\n',
  'public/landing.html':
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Landing</title></head><body><main><h1>Landing</h1></main></body></html>',
}

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
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
  const client = new Client({ name: 'doop-repo-test', version: '1.0.0' })
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

/** A GitHub that answers the tree and content calls the recon makes. */
function stubGithub() {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', async (url: string) => {
    const target = String(url)
    if (target.includes('/git/trees/'))
      return json({ tree: Object.keys(FILES).map((file) => ({ path: file, type: 'blob' })), truncated: false })
    const contents = target.match(/\/contents\/([^?]+)\?ref=/)
    if (contents) {
      const text = FILES[decodeURIComponent(contents[1]!)]
      return text === undefined ? new Response('not found', { status: 404 }) : new Response(text)
    }
    return json({ message: `unexpected ${target}` }, 500)
  })
}

let counter = 0
let canvasId = CANVAS_ID

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
  canvasId = `${CANVAS_ID}-${counter}`
  const canvas: Canvas = {
    id: canvasId,
    name: `Repo ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
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
    createdBy: OWNER_ID,
    createdAt: Date.now(),
    lastSyncedAt: null,
  }
}

describe('reading a connected repository over MCP', () => {
  it('publishes both tools with their contract', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const toolNamed = (name: string) => tools.find((tool) => tool.name === name)
      expect(toolNamed('list_repo_screens'), 'list_repo_screens should be registered').toBeDefined()
      expect(toolNamed('import_repo_screen'), 'import_repo_screen should be registered').toBeDefined()
      expect(toolNamed('list_repo_screens')!.annotations?.readOnlyHint).toBe(true)
      expect(toolNamed('import_repo_screen')!.annotations?.readOnlyHint).toBe(false)
      expect(toolNamed('import_repo_screen')!.annotations?.destructiveHint).toBe(false)

      const importSchema = toolNamed('import_repo_screen')!.inputSchema as {
        properties: Record<string, unknown>
        required?: string[]
      }
      expect(Object.keys(importSchema.properties).sort()).toEqual([
        'agent_name',
        'canvas_id',
        'file',
        'html',
        /* every mutating tool takes the idempotency key, injected by the wrapper */
        'op_id',
        'repo',
        'route',
      ])
      /* a session fills these in; the caller still names exactly one selector */
      expect(importSchema.required ?? []).not.toContain('route')
      expect(importSchema.required ?? []).not.toContain('file')

      /* the catalog is derived from the registry, so a tool without a domain
         would read as "other" and the two would drift apart */
      const caps = await callTool(client, 'get_capabilities', {})
      const catalog = JSON.parse(caps.raw) as {
        tools: { name: string; domain: string; read_only: boolean }[]
        annotations_coverage: { total: number }
      }
      expect(catalog.tools.length).toBe(tools.length)
      expect(Object.keys(TOOL_DOMAINS).length).toBe(tools.length)
      expect(catalog.annotations_coverage.total).toBe(tools.length)
      expect(catalog.tools.find((tool) => tool.name === 'list_repo_screens')).toMatchObject({
        domain: 'web',
        read_only: true,
      })
      expect(catalog.tools.find((tool) => tool.name === 'import_repo_screen')).toMatchObject({
        domain: 'web',
        read_only: false,
      })
    } finally {
      await close()
    }
  })

  it('refuses both tools when the canvas has no connection for the repo', async () => {
    stubGithub()
    const { client, close } = await connect()
    try {
      const listed = await callTool(client, 'list_repo_screens', { canvas_id: canvasId, repo: REPO })
      expect(listed.isError).toBe(true)
      expect(listed.parsed).toMatchObject({ error: { code: 'unsupported' } })

      const imported = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        route: '/pricing',
        agent_name: 'Claude',
      })
      expect(imported.isError).toBe(true)
      expect(imported.parsed).toMatchObject({ error: { code: 'unsupported' } })
      expect(imported.raw).toContain('open_pull_request')
    } finally {
      await close()
    }
  })

  it('lists the screens the repo recon finds, with the file each comes from', async () => {
    await db.insert(githubConnections).values(connection())
    stubGithub()
    const { client, close } = await connect()
    try {
      const listed = await callTool(client, 'list_repo_screens', { canvas_id: canvasId, repo: REPO })
      expect(listed.isError).toBeFalsy()
      const payload = listed.parsed as unknown as {
        repo: string
        framework: string
        truncated: boolean
        screens: { route: string; file: string; kind: string }[]
      }
      expect(payload.repo).toBe(REPO)
      expect(payload.framework).toBe('next')
      expect(payload.truncated).toBe(false)
      const screenAt = (route: string) => payload.screens.find((screen) => screen.route === route)
      expect(screenAt('/pricing')).toMatchObject({ file: 'app/pricing/page.tsx', kind: 'page' })
      expect(screenAt('/')).toMatchObject({ file: 'app/page.tsx', kind: 'page' })
      expect(screenAt('src/components/Button.tsx')).toMatchObject({ kind: 'component' })
      expect(screenAt('/public/landing.html')).toMatchObject({ file: 'public/landing.html', kind: 'static' })
    } finally {
      await close()
    }
  })

  it('requires exactly one of route and file', async () => {
    await db.insert(githubConnections).values(connection())
    stubGithub()
    const { client, close } = await connect()
    try {
      for (const selector of [{}, { route: '/pricing', file: 'app/pricing/page.tsx' }]) {
        const res = await callTool(client, 'import_repo_screen', {
          canvas_id: canvasId,
          repo: REPO,
          agent_name: 'Claude',
          ...selector,
        })
        expect(res.isError).toBe(true)
        expect(res.parsed).toMatchObject({ error: { code: 'invalid_input' } })
      }
      /* an unknown route is reported against the list, not silently imported */
      const missing = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        route: '/nope',
        agent_name: 'Claude',
      })
      expect(missing.isError).toBe(true)
      expect(missing.parsed).toMatchObject({ error: { code: 'not_found' } })
      expect(store.getCanvas(canvasId)!.frames).toEqual([])
    } finally {
      await close()
    }
  })

  it('lands a static screen as a frame carrying the import marker', async () => {
    const conn = connection()
    await db.insert(githubConnections).values(conn)
    stubGithub()
    const { client, close } = await connect()
    try {
      const imported = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        file: 'public/landing.html',
        agent_name: 'Claude',
      })
      expect(imported.isError).toBeFalsy()
      const payload = imported.parsed as unknown as {
        ok: boolean
        screen: { route: string; file: string; kind: string }
        frame: { id: string; name: string; width: number; height: number }
      }
      expect(payload.screen).toMatchObject({
        route: '/public/landing.html',
        file: 'public/landing.html',
        kind: 'static',
      })

      const frame = store.getFrame(payload.frame.id)
      expect(frame).toBeDefined()
      expect(frame!.name).toBe('Landing')
      /* repo HTML lands verbatim at the import's page size */
      expect(frame!.width).toBe(1280)
      expect(frame!.height).toBe(900)
      expect(frame!.html).toContain('<h1>Landing</h1>')
      /* the marker is what keeps the frame traceable to its route and source */
      expect(githubFrameMarker(frame!.html)).toEqual({
        connectionId: conn.id,
        kind: 'static',
        route: '/public/landing.html',
        sourcePath: 'public/landing.html',
      })
      expect(store.getCanvas(canvasId)!.frames.map((f) => f.id)).toContain(frame!.id)
    } finally {
      await close()
    }
  })

  it('hands back a code screen’s source, then lands the document designed from it', async () => {
    const conn = connection()
    await db.insert(githubConnections).values(conn)
    stubGithub()
    const { client, close } = await connect()
    try {
      const read = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        route: '/pricing',
        agent_name: 'Claude',
      })
      expect(read.isError).toBeFalsy()
      const source = read.parsed as unknown as {
        ok: boolean
        frame: null
        source: { path: string; text: string }[]
      }
      /* the closure the import's own sketch lane feeds its model: the screen's
         file, its styling context and the component it imports */
      expect(source.frame).toBeNull()
      expect(source.source.map((file) => file.path).sort()).toEqual([
        'app/globals.css',
        'app/pricing/page.tsx',
        'src/components/Button.tsx',
      ])
      expect(source.source.find((file) => file.path === 'app/pricing/page.tsx')!.text).toContain('<h1>Pricing</h1>')
      expect(store.getCanvas(canvasId)!.frames).toEqual([])

      const designed = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        route: '/pricing',
        html: '<!doctype html><html><head><style>body{margin:0}</style></head><body><h1>Pricing</h1></body></html>\n<!-- doop-height: 1400 -->',
        agent_name: 'Claude',
      })
      expect(designed.isError).toBeFalsy()
      const payload = designed.parsed as unknown as { frame: { id: string; width: number; height: number } }
      const frame = store.getFrame(payload.frame.id)
      expect(frame).toBeDefined()
      expect(frame!.name).toBe('Pricing')
      /* a page screen, sized by the height its document declares */
      expect(frame!.width).toBe(1280)
      expect(frame!.height).toBe(1400)
      expect(githubFrameMarker(frame!.html)).toEqual({
        connectionId: conn.id,
        kind: 'page',
        route: '/pricing',
        sourcePath: 'app/pricing/page.tsx',
      })

      /* a document with no HTML in it is a bad argument, not a broken import */
      const empty = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        route: '/pricing',
        html: 'no markup here, just prose',
        agent_name: 'Claude',
      })
      expect(empty.isError).toBe(true)
      expect(empty.parsed).toMatchObject({ error: { code: 'invalid_input' } })
      expect(store.getCanvas(canvasId)!.frames).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('refuses to land a frame while the canvas is in review mode', async () => {
    await db.insert(githubConnections).values(connection())
    stubGithub()
    store.getCanvas(canvasId)!.reviewMode = true
    const { client, close } = await connect()
    try {
      const imported = await callTool(client, 'import_repo_screen', {
        canvas_id: canvasId,
        repo: REPO,
        file: 'public/landing.html',
        agent_name: 'Claude',
      })
      expect(imported.isError).toBe(true)
      expect(imported.parsed).toMatchObject({ error: { code: 'unsupported' } })
      expect(store.getCanvas(canvasId)!.frames).toEqual([])
    } finally {
      await close()
    }
  })
})
