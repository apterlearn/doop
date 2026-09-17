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
import * as runLog from '../server/runLog.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* The Run tab's detail pane is worth opening because a step says WHAT it was
   called with and WHO made it. Both ride the recorded event: the arguments as
   the caller's own JSON (cut at the write boundary, since a document is not a
   summary), and the actor as the durable identity behind the display name —
   which is what tells two accounts' "Claude" apart. get_run_events is where an
   agent reads that back, so it has to surface the fields it records.

   Real database here, not a stub: the agent id is a row, and a fake persistence
   layer would hand the gate an identity it could not resolve. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-run-fields-'))

const OWNER_ID = 'runfields-owner'
const AGENT = 'Claude'

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

type Payload = Record<string, unknown>

function obj(value: unknown): Payload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : {}
}

async function connect(clientId?: string) {
  const server = buildMcpServer('Test Owner', OWNER_ID, clientId)
  const client = new Client({ name: 'doop-run-fields-test', version: '1.0.0' })
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

/** The steps get_run_events reports, newest first. */
async function eventsOf(client: Client, canvasId: string): Promise<Payload[]> {
  const read = await callTool(client, 'get_run_events', { canvas_id: canvasId, agent_name: AGENT })
  expect(read.isError).toBeFalsy()
  return (read.parsed.events as Payload[] | undefined) ?? []
}

let counter = 0
let canvas: Canvas

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
  canvas = store.createCanvas(`Run fields ${counter}`, OWNER_ID)
  runLog.forgetCanvas(canvas.id)
})

describe('the fields a run step carries back to an agent', () => {
  it('reports the arguments the step was called with', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'create_frame', {
        canvas_id: canvas.id,
        name: 'Hero',
        width: 1200,
        height: 900,
        html: '<h1>timeline-marker</h1>',
        agent_name: AGENT,
      })

      const events = await eventsOf(client, canvas.id)
      const step = events.find((event) => event.name === 'create_frame')
      expect(step).toBeDefined()
      const args = JSON.parse(String(step!.args)) as Payload
      expect(args.name).toBe('Hero')
      expect(args.html).toBe('<h1>timeline-marker</h1>')
      expect(args.canvas_id).toBe(canvas.id)
    } finally {
      await close()
    }
  })

  it('cuts arguments that exceed the cap, and leaves the short ones whole', async () => {
    const { client, close } = await connect()
    try {
      const html = `<h1>${'x'.repeat(4000)}</h1>`
      await callTool(client, 'create_frame', {
        canvas_id: canvas.id,
        name: 'Huge',
        width: 1200,
        height: 900,
        html,
        agent_name: AGENT,
      })

      const events = await eventsOf(client, canvas.id)
      const step = events.find((event) => event.name === 'create_frame')
      const args = String(step!.args)
      /* the cut is the write boundary's (runLog.ARGS_CAP bytes), not the
         caller's — and it is a cut, not a summary: what lands is the head of
         the argument JSON, so the document inside it is a prefix of the one
         that was sent and stops short of its end */
      expect(Buffer.byteLength(args, 'utf8')).toBeLessThanOrEqual(runLog.ARGS_CAP)
      expect(args).toContain('"name":"Huge"')
      const document = /"html":"([\s\S]*)$/.exec(args)?.[1] ?? ''
      expect(document.length).toBeGreaterThan(0)
      expect(document.length).toBeLessThan(html.length)
      expect(html.startsWith(document)).toBe(true)
    } finally {
      await close()
    }
  })

  it('reports the actor as an agent, with the durable id behind its name', async () => {
    const { client, close } = await connect()
    try {
      await callTool(client, 'get_canvas', { canvas_id: canvas.id, agent_name: AGENT })

      const events = await eventsOf(client, canvas.id)
      const step = events.find((event) => event.name === 'get_canvas')
      expect(step?.actor_kind).toBe('agent')
      const agent = (await store.listAgentsForOwner(OWNER_ID)).find((row) => row.name === AGENT)
      expect(agent).toBeDefined()
      expect(step?.agent_id).toBe(agent!.id)
      /* the display name is still there: the id joins to the row, it does not
         replace what a human reads */
      expect(step?.agentName).toBe(AGENT)
    } finally {
      await close()
    }
  })

  it('stamps a call the handler never arrived on, on a fresh session', async () => {
    /* a NEW connection: nothing has arrived on its session, and
       get_capabilities is a tool whose handler never calls arrive — so the id
       on this step is the one the wrapper resolved for the call itself */
    const { client, close } = await connect('client-run-fields-1')
    try {
      await callTool(client, 'get_capabilities', { canvas_id: canvas.id, agent_name: 'Ada' })

      const events = await eventsOf(client, canvas.id)
      const step = events.find((event) => event.name === 'get_capabilities')
      expect(step?.actor_kind).toBe('agent')
      const ada = (await store.listAgentsForOwner(OWNER_ID)).find((row) => row.name === 'Ada')
      expect(ada).toBeDefined()
      expect(step?.agent_id).toBe(ada!.id)
    } finally {
      await close()
    }
  })
})
