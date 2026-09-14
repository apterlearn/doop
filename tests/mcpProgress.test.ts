import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* progress() is best-effort and easy to leave at zero: a tool that reports
   progress but never a completion fraction leaves the client's progress bar
   stuck at the start. This drives a rendering tool with a progress token and
   asserts the fractions climb to 1 — the contract every reporting tool shares.
   Rendering needs a browser, so the whole suite is skipped without one. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-progress-'))
const OWNER_ID = 'progress-owner'
const CANVAS_ID = 'c-progress'

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
let frameId = ''

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
    name: `Progress ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  frameId = store.createFrame(
    canvasId,
    { name: 'Home', html: PAGE('<h1>Home</h1>'), width: 1440, height: 900 },
    'Owner',
  )!.id
})

function PAGE(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>body{margin:0;font-family:Inter,system-ui;color:#111110;background:#fff}h1{font-size:32px;line-height:1.25}</style></head><body><main style="min-height:700px">${body}</main></body></html>`
}

async function connect() {
  const server = buildMcpServer('Owner', OWNER_ID)
  const client = new Client({ name: 'doop-progress-test', version: '1.0.0' })
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

/** The server awaits each notification before it returns the tool result, and
 *  the in-memory transport delivers synchronously, so every fraction has been
 *  handled by the time callTool resolves — no polling needed. */

describe.skipIf(!findBrowserPath())('progress notifications report completion', () => {
  it('audit_frame climbs to 1 and never goes backwards', async () => {
    const { client, close } = await connect()
    const fractions: number[] = []
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      fractions.push(notification.params.progress)
    })
    try {
      const result = (await client.callTool({
        name: 'audit_frame',
        arguments: { frame_id: frameId, agent_name: 'Tester' },
        _meta: { progressToken: 'p1' },
      })) as unknown as { isError?: boolean }
      expect(result.isError).toBeFalsy()

      expect(fractions.at(-1)).toBe(1)
      for (let i = 1; i < fractions.length; i += 1) {
        expect(fractions[i]!, `fraction ${i} went backwards`).toBeGreaterThan(fractions[i - 1]!)
      }
      expect(fractions).toEqual([0, 0.5, 1])
    } finally {
      await close()
    }
  }, 120_000)
})
