import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as actions from '../server/actions.ts'
import { getAsset } from '../server/assets.ts'
import { PUBLIC_ORIGIN } from '../server/auth.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { buildMcpServer, MUTATING_TOOLS, TOOL_DOMAINS } from '../server/mcp.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* get_capabilities is the one call an agent makes before it plans anything, so
   the catalog it returns has to describe the surface that actually exists: one
   entry per registered tool with a domain, the annotation contract complete,
   and the resources and prompts it can attach. The zip half of export_canvas is
   the largest payload the surface could emit, so what it hands back is asserted
   against the real asset store rather than a fake. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-capabilities-'))
const OWNER_ID = 'capabilities-owner'
const CANVAS_ID = 'c-capabilities'

/** The catalog's own contract, parsed rather than asserted: a field the tool
 *  stops sending is a failure here, not a silently undefined read. */
const CatalogEntrySchema = z.object({
  name: z.string(),
  domain: z.string(),
  read_only: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  summary: z.string(),
})

const CapabilitiesSchema = z.object({
  screenshot: z.boolean(),
  github: z.string(),
  limits: z.record(z.string(), z.number().nullable()),
  tools: z.array(CatalogEntrySchema),
  resources: z.array(z.string()),
  prompts: z.array(z.string()),
  annotations_coverage: z.object({ with_read_only: z.number(), total: z.number() }),
})

const ZipExportSchema = z.object({
  format: z.string(),
  filename: z.string(),
  zip_url: z.string().optional(),
  archive_base64: z.string().optional(),
  bytes: z.number().optional(),
})

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

let counter = 0
let canvasId = CANVAS_ID

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
  canvasId = `${CANVAS_ID}-${counter}`
  const canvas: Canvas = {
    id: canvasId,
    name: `Capabilities ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  store.createFrame(canvasId, { name: 'Home', html: PAGE('<h1>Home</h1>'), width: 1440, height: 900 }, 'Owner')
})

function PAGE(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>body{margin:0;font-family:Inter,system-ui;color:#111110;background:#fff}h1{font-size:32px;line-height:1.25}</style></head><body><main style="min-height:700px">${body}</main></body></html>`
}

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Owner', OWNER_ID)
  const client = new Client({ name: 'doop-capabilities-test', version: '1.0.0' })
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
  return { raw, isError: result.isError }
}

/** The catalog payload as the tool serialises it into its text block. */
async function capabilitiesOf(client: Client): Promise<z.infer<typeof CapabilitiesSchema>> {
  const res = await callTool(client, 'get_capabilities', {})
  expect(res.isError).toBeFalsy()
  return CapabilitiesSchema.parse(JSON.parse(res.raw))
}

async function zipExportOf(client: Client, args: Record<string, unknown>): Promise<z.infer<typeof ZipExportSchema>> {
  const res = await callTool(client, 'export_canvas', { canvas_id: canvasId, format: 'zip', ...args })
  expect(res.isError).toBeFalsy()
  return ZipExportSchema.parse(JSON.parse(res.raw))
}

describe('get_capabilities catalogues the registered surface', () => {
  it('lists every tool the server publishes, each with a domain and a summary', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const caps = await capabilitiesOf(client)

      expect(caps.tools.length).toBe(tools.length)
      expect([...caps.tools.map((t) => t.name)].sort()).toEqual([...tools.map((t) => t.name)].sort())
      /* the domain map is the taxonomy the catalog is derived from, so it has to
         name every tool: a missing entry would silently read as "other" */
      expect(Object.keys(TOOL_DOMAINS).length).toBe(tools.length)
      for (const tool of caps.tools) {
        expect(TOOL_DOMAINS[tool.name], `${tool.name} has no domain`).toBeDefined()
        expect(tool.summary.length).toBeGreaterThan(0)
      }
    } finally {
      await close()
    }
  })

  it('names the domain a tool belongs to, not a generic bucket', async () => {
    const { client, close } = await connect()
    try {
      const caps = await capabilitiesOf(client)
      const domainOf = (name: string) => caps.tools.find((t) => t.name === name)?.domain
      expect(domainOf('get_canvas')).toBe('canvas')
      expect(domainOf('delete_frame')).toBe('frame')
      expect(domainOf('get_element')).toBe('element')
      expect(domainOf('review_frame')).toBe('verify')
      expect(domainOf('upload_asset')).toBe('assets')
      expect(domainOf('import_webpage')).toBe('web')
      expect(domainOf('open_pull_request')).toBe('handoff')
      expect(domainOf('list_cards')).toBe('board')
      expect(domainOf('get_run_events')).toBe('run')
      expect(domainOf('propose_frame_html')).toBe('review')
      expect(domainOf('get_capabilities')).toBe('discovery')
    } finally {
      await close()
    }
  })

  it('reports read-only, destructive and retryable from the annotations it registered', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const caps = await capabilitiesOf(client)

      for (const entry of caps.tools) {
        const declared = tools.find((t) => t.name === entry.name)!.annotations
        /* the catalog is a view of the registration, not a second opinion */
        expect(entry.read_only, `${entry.name} read_only`).toBe(declared?.readOnlyHint === true)
        expect(entry.destructive, `${entry.name} destructive`).toBe(declared?.destructiveHint === true)
      }

      /* the contract is complete: every tool declares readOnlyHint, so a client
         can decide what to auto-approve from the catalog alone */
      expect(caps.annotations_coverage.total).toBe(tools.length)
      expect(caps.annotations_coverage.with_read_only).toBe(tools.length)
      expect(caps.annotations_coverage.with_read_only).toBeGreaterThan(90)
      expect(caps.tools.filter((t) => t.read_only).length).toBeGreaterThan(0)

      const destructive = caps.tools.filter((t) => t.destructive).map((t) => t.name)
      for (const name of [
        'delete_frame',
        'delete_page',
        'delete_element',
        'revert_frame',
        'revert_run',
        'restore_release',
        'unpublish_canvas',
        'withdraw_proposal',
        'resolve_comment',
        /* stopping a live run is the one non-delete a client should confirm */
        'stop_work',
      ]) {
        expect(destructive, `${name} must be marked destructive`).toContain(name)
      }
      /* and nothing that only reads is claimed to destroy */
      const canvasRead = caps.tools.find((t) => t.name === 'get_canvas')!
      expect(canvasRead.destructive).toBe(false)
      expect(canvasRead.read_only).toBe(true)
    } finally {
      await close()
    }
  })

  /* A write the wrapper does not replay is a write an agent cannot safely
     retry, and a catalog that calls it retryable is worse than one that does
     not: the drift is invisible until a retry duplicates work. So the rule is
     asserted rather than remembered — every registered tool is either a read,
     replayed by the wrapper, or declares itself not idempotent. */
  it('leaves no state-changing tool outside the replay contract', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const caps = await capabilitiesOf(client)

      for (const tool of tools) {
        const declared = tool.annotations
        expect(
          declared?.readOnlyHint === true || MUTATING_TOOLS[tool.name] === true || declared?.idempotentHint === false,
          `${tool.name} is neither read-only, replayed by op_id, nor declared non-idempotent`,
        ).toBe(true)
      }
      /* the tools that DO change state under some arguments, named here so a
         rename or a dropped key fails loudly instead of quietly */
      for (const name of ['extract_design_system', 'review_frame', 'get_feedback']) {
        expect(caps.tools.find((t) => t.name === name)!.idempotent, `${name} must be retryable`).toBe(true)
      }
      /* ...and the one write-shaped tool that must NOT be replayed: its result
         is a time window, so answering a retry with the first answer is wrong */
      expect(caps.tools.find((t) => t.name === 'wait_for_events')!.idempotent).toBe(false)
      /* every name in the list is a tool that exists: a stale key would mean a
         tool was renamed and its replay silently stopped covering it */
      for (const name of Object.keys(MUTATING_TOOLS)) {
        expect(
          tools.map((t) => t.name),
          `${name} is in MUTATING_TOOLS but is not registered`,
        ).toContain(name)
      }
      /* and the wrapper actually publishes the key it replays on */
      const write = tools.find((t) => t.name === 'set_frame_html')!
      expect(Object.keys((write.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toContain(
        'op_id',
      )
    } finally {
      await close()
    }
  })

  it('keeps the integrations and limits, and names the resources and prompts it registers', async () => {
    const { client, close } = await connect()
    try {
      const caps = await capabilitiesOf(client)
      expect(['app', 'pat', 'none']).toContain(caps.github)
      expect(caps.limits.renders_per_min).toBeGreaterThan(0)
      expect(caps.limits.frame_html_bytes).toBeGreaterThan(0)

      /* prompts are named one-for-one in the protocol, so the catalog has to
         match them exactly */
      const { prompts } = await client.listPrompts()
      expect([...caps.prompts].sort()).toEqual(prompts.map((p) => p.name).sort())
      /* a resource template expands to one entry per canvas, so the client sees
         the instances while the catalog names the registrations: every
         registered name must be there, and the instances must be at least as
         many */
      const { resources } = await client.listResources()
      expect(caps.resources).toContain('doop-guide')
      expect(caps.resources).toContain('doop-canvas')
      expect(caps.resources).toContain('doop-canvas-tokens')
      expect(resources.length).toBeGreaterThanOrEqual(caps.resources.length)
    } finally {
      await close()
    }
  })
})

describe.skipIf(!findBrowserPath())('export_canvas zip hands back a URL', () => {
  it('stores the archive and returns a public zip URL instead of base64', async () => {
    const { client, close } = await connect()
    try {
      const payload = await zipExportOf(client, {})
      expect(payload.archive_base64).toBeUndefined()
      expect(payload.zip_url).toMatch(new RegExp(`^${PUBLIC_ORIGIN}/a/[A-Za-z0-9_-]+\\.zip$`))

      /* the URL is only worth returning if it actually serves the archive */
      const id = payload.zip_url!.slice(payload.zip_url!.lastIndexOf('/a/') + 3).replace(/\.zip$/, '')
      const stored = await getAsset(id)
      expect(stored?.meta.mime).toBe('application/zip')
      expect(stored?.meta.ext).toBe('zip')
      expect(stored!.buf.subarray(0, 2).toString('latin1')).toBe('PK')
      expect(payload.bytes).toBe(stored!.buf.length)
    } finally {
      await close()
    }
  }, 120_000)

  it('still returns the archive inline when the caller asks for it', async () => {
    const { client, close } = await connect()
    try {
      const payload = await zipExportOf(client, { inline: true })
      expect(payload.zip_url).toBeUndefined()
      expect(Buffer.from(payload.archive_base64!, 'base64').subarray(0, 2).toString('latin1')).toBe('PK')
    } finally {
      await close()
    }
  }, 120_000)
})
