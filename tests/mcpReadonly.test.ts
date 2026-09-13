import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* Read-only mode is a registration boundary, not a hint: a write tool must be
   absent from tools/list entirely, so a reviewer's or monitoring agent's client
   cannot call it even by name. The default surface still carries the writes. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-readonly-'))
const OWNER_ID = 'readonly-owner'
const CANVAS_ID = 'c-readonly'

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
    name: `Readonly ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  store.createFrame(
    canvasId,
    {
      name: 'Home',
      html: '<!doctype html><html lang="en"><body><h1>Home</h1></body></html>',
      width: 1440,
      height: 900,
    },
    'Owner',
  )
})

async function connect(opts?: { readonly?: boolean }) {
  const server = buildMcpServer('Owner', OWNER_ID, undefined, opts)
  const client = new Client({ name: 'doop-readonly-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  /* captured at the transport: the wire is where a client that cached an older
     tools/list finds out the surface changed */
  const sent: { method?: string }[] = []
  const originalSend = serverTransport.send.bind(serverTransport)
  serverTransport.send = async (message) => {
    sent.push(message as never)
    return originalSend(message)
  }
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    sent,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools()
  return tools.map((tool) => tool.name)
}

describe('read-only MCP surface', () => {
  it('registers reads but not writes in read-only mode', async () => {
    const { client, close } = await connect({ readonly: true })
    try {
      const names = await toolNames(client)
      expect(names).toContain('get_frame')
      expect(names).not.toContain('set_frame_html')
      /* nothing on this surface claims to write — that is what makes the
         boundary hold for a client that only reads the catalog */
      const { tools } = await client.listTools()
      for (const tool of tools) expect(tool.annotations?.readOnlyHint, `${tool.name} is not read-only`).toBe(true)
    } finally {
      await close()
    }
  })

  it('registers both reads and writes by default', async () => {
    const { client, sent, close } = await connect()
    try {
      const names = await toolNames(client)
      expect(names).toContain('get_frame')
      expect(names).toContain('set_frame_html')
      /* nothing was filtered, so the client has no reason to re-list */
      expect(sent.filter((m) => m.method === 'notifications/tools/list_changed')).toEqual([])
    } finally {
      await close()
    }
  })

  it('tells a connected client to re-list when the policy removed tools', async () => {
    const { client, sent, close } = await connect({ readonly: true })
    try {
      await client.listTools()
      expect(sent.filter((m) => m.method === 'notifications/tools/list_changed')).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('reports the filtered surface and the readonly flag from get_capabilities', async () => {
    const { client, close } = await connect({ readonly: true })
    try {
      const result = (await client.callTool({ name: 'get_capabilities', arguments: {} })) as unknown as {
        content: Array<{ type: string; text?: string }>
      }
      const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
      const caps = JSON.parse(raw) as { readonly: boolean; tools: Array<{ name: string; read_only: boolean }> }
      expect(caps.readonly).toBe(true)
      expect(caps.tools.map((tool) => tool.name)).toContain('get_frame')
      expect(caps.tools.map((tool) => tool.name)).not.toContain('set_frame_html')
      expect(caps.tools.every((tool) => tool.read_only)).toBe(true)
    } finally {
      await close()
    }
  })
})
