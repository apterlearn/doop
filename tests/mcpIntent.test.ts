import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Reach is not authority. A viewer-role member and a live view share link both
   REACH a canvas — that is what lets their agent read it — and the tools used
   to fire anyway, because the MCP gate asked only whether the canvas was
   reachable. What a tool needs is now its own declaration (TOOL_INTENT), and
   the wrapper refuses a call the connection's intent does not cover, so a
   handler cannot be written past it. The refusal names both intents: the one
   the connection holds and the one the tool needs.

   The memberships below are made the way the member route makes them —
   store.addMember, which is what POST /api/canvases/:id/members calls — so the
   role the gate reads is the role the owner set. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-intent-'))

const OWNER_ID = 'intent-owner'
const VIEWER_ID = 'intent-viewer'
const COMMENTER_ID = 'intent-commenter'
const STRANGER_ID = 'intent-stranger'

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  /* the same drain the server runs on shutdown: frame writes are debounced, and
     a pending one would be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

type Payload = Record<string, unknown>

function obj(value: unknown): Payload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The typed code of a refused call — `''` when the call succeeded. */
function errorCode(parsed: Payload): string {
  return str(obj(parsed.error).code)
}

async function connect(ownerName: string, ownerId: string) {
  const server = buildMcpServer(ownerName, ownerId)
  const client = new Client({ name: `doop-intent-${ownerId}`, version: '1.0.0' })
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
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content.find((b) => b.type === 'text')?.text ?? ''
  let parsed: Payload = {}
  try {
    const decoded: unknown = JSON.parse(raw)
    parsed = obj(decoded)
  } catch {
    /* a schema refusal arrives as a plain string, not our JSON payload */
  }
  return { parsed, raw, isError: result.isError }
}

const WRITE = { html: '<h1>replaced</h1>', agent_name: 'Claude' }

let counter = 0
let canvas: Canvas
let frame: Frame

beforeEach(() => {
  counter += 1
  vi.restoreAllMocks()
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
  canvas = store.createCanvas(`Intent ${counter}`, OWNER_ID)
  frame = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>hi</h1>', width: 800, height: 600 }, 'Owner')!
})

describe('intent-enforced MCP authorization', () => {
  it('lets a viewer-role member read and refuses its write, naming both intents', async () => {
    store.addMember(canvas.id, VIEWER_ID, OWNER_ID, 'viewer')
    const viewer = await connect('Vic', VIEWER_ID)
    try {
      const read = await callTool(viewer.client, 'get_canvas', { canvas_id: canvas.id })
      expect(read.isError).toBeFalsy()

      const write = await callTool(viewer.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBe(true)
      expect(errorCode(write.parsed)).toBe('forbidden')
      const message = str(obj(write.parsed.error).message)
      expect(message).toContain('view')
      expect(message).toContain('edit')
      /* the refusal is a refusal: the frame is exactly as it was */
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')
    } finally {
      await viewer.close()
    }
  })

  it('lets a commenter-role member comment and refuses its write', async () => {
    store.addMember(canvas.id, COMMENTER_ID, OWNER_ID, 'commenter')
    const commenter = await connect('Cam', COMMENTER_ID)
    try {
      const commented = await callTool(commenter.client, 'add_comment', {
        frame_id: frame.id,
        selector: 'h1',
        text: 'this heading is doing two jobs',
        agent_name: 'Cam',
      })
      expect(commented.isError).toBeFalsy()

      const write = await callTool(commenter.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBe(true)
      expect(errorCode(write.parsed)).toBe('forbidden')
      expect(str(obj(write.parsed.error).message)).toContain('comment')
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')
    } finally {
      await commenter.close()
    }
  })

  it('still lands a write for the owner', async () => {
    const owner = await connect('Owner', OWNER_ID)
    try {
      const write = await callTool(owner.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBeFalsy()
      expect(store.getFrame(frame.id)?.html).toBe('<h1>replaced</h1>')
    } finally {
      await owner.close()
    }
  })

  it('keeps the existing not_found for a connection with no access at all', async () => {
    const stranger = await connect('Sam', STRANGER_ID)
    try {
      const write = await callTool(stranger.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBe(true)
      expect(errorCode(write.parsed)).toBe('not_found')
      expect(str(obj(write.parsed.error).message)).toBe(`no frame with id ${frame.id} accessible to this account`)
    } finally {
      await stranger.close()
    }
  })
})
