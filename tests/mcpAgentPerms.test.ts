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

/* Access is the account's; a LEVEL is the owner's leash on ONE agent on ONE
   canvas. A level narrows what that agent's calls may do — view reads, comment
   reads and leaves notes, propose reads, comments and proposes (and nothing
   else writes), full is today's surface — and `propose` has to work with
   review mode OFF, or an agent the owner leashed to proposing could not land a
   change at all.

   The levels are set the way the panel sets them (store.setAgentLevel against
   the agent's durable row, minted the way the MCP connection mints it), and
   the calls are made over a real MCP connection against the real database:
   the gate this covers lives in the wrapper, so a fake would not exercise it. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-agent-perms-'))

const OWNER_ID = 'perms-owner'
const AGENT = 'Claude'

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

async function connect(ownerName: string, ownerId: string, clientId?: string) {
  const server = buildMcpServer(ownerName, ownerId, clientId)
  const client = new Client({ name: `doop-perms-${ownerId}`, version: '1.0.0' })
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

/** The owner's leash on one agent, set the way the REST route sets it: the
 *  agent's durable row first (the same (account, name) pair its calls arrive
 *  under, so the ids match), then the level filed against that id. */
async function leash(canvasId: string, name: string, level: persist.AgentLevel) {
  const agent = await store.upsertAgent({ ownerId: OWNER_ID, name })
  await store.setAgentLevel({ canvasId, agentId: agent.id, level, setBy: 'Owner' })
  return agent
}

const WRITE = { html: '<h1>replaced</h1>', agent_name: AGENT }

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
  canvas = store.createCanvas(`Perms ${counter}`, OWNER_ID)
  frame = store.createFrame(canvas.id, { name: 'Hero', html: '<h1>hi</h1>', width: 800, height: 600 }, 'Owner')!
})

describe('per-agent permission levels', () => {
  it('propose: refuses the direct write with the propose path named, and the proposal lands on accept', async () => {
    await leash(canvas.id, AGENT, 'propose')
    const agent = await connect('Claude', OWNER_ID)
    try {
      /* a proposal is how a leashed agent lands a change, so a write is refused
         in the shape review mode produces — naming the propose tools */
      const write = await callTool(agent.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBe(true)
      expect(errorCode(write.parsed)).toBe('unsupported')
      const message = str(obj(write.parsed.error).message)
      expect(message).toContain('propose')
      expect(message).toContain('propose_frame_html')
      expect(obj(write.parsed.error).agent_level).toBe('propose')
      expect(obj(write.parsed.error).required_intent).toBe('edit')
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')

      /* a batch is not a way around the leash: apply_ops needs edit like the
         tool it would stand in for */
      const batched = await callTool(agent.client, 'apply_ops', {
        canvas_id: canvas.id,
        ops: [{ op: 'set_frame_html', frame_id: frame.id, html: '<h1>batched</h1>' }],
        agent_name: AGENT,
      })
      expect(batched.isError).toBe(true)
      expect(errorCode(batched.parsed)).toBe('unsupported')
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')

      /* and what the level DOES confer is untouched: it reads, and it comments */
      const read = await callTool(agent.client, 'get_canvas', { canvas_id: canvas.id, agent_name: AGENT })
      expect(read.isError).toBeFalsy()
      const commented = await callTool(agent.client, 'add_comment', {
        frame_id: frame.id,
        selector: 'h1',
        text: 'the heading and the lede say the same thing',
        agent_name: AGENT,
      })
      expect(commented.isError).toBeFalsy()

      /* review mode is OFF on this canvas: the propose path has to work anyway */
      expect(store.getCanvas(canvas.id)?.reviewMode).toBeFalsy()
      const proposed = await callTool(agent.client, 'propose_frame_html', {
        canvas_id: canvas.id,
        frame_id: frame.id,
        html: '<h1>proposed</h1>',
        summary: 'swap the hero copy',
        agent_name: AGENT,
      })
      expect(proposed.isError).toBeFalsy()
      const { proposal_id: proposalId, status } = proposed.parsed as { proposal_id: string; status: string }
      expect(status).toBe('pending')
      /* nothing has changed yet: a proposal is a question, not a write */
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')

      /* and a human can resolve it, which is what lands the change */
      const accepted = actions.resolveFrameProposal(
        canvas.id,
        proposalId,
        true,
        actions.resolveActor({ name: 'Owner', kind: 'user', ownerId: OWNER_ID }),
      )
      expect(accepted?.status).toBe('accepted')
      expect(store.getFrame(frame.id)?.html).toContain('proposed')
    } finally {
      await agent.close()
    }
  })

  it('comment: leaves a note and is refused the write', async () => {
    await leash(canvas.id, AGENT, 'comment')
    const agent = await connect('Claude', OWNER_ID)
    try {
      const commented = await callTool(agent.client, 'add_comment', {
        frame_id: frame.id,
        selector: 'h1',
        text: 'this heading is doing two jobs',
        agent_name: AGENT,
      })
      expect(commented.isError).toBeFalsy()

      const write = await callTool(agent.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBe(true)
      expect(errorCode(write.parsed)).toBe('forbidden')
      const message = str(obj(write.parsed.error).message)
      expect(message).toContain('comment')
      expect(message).toContain('edit')
      expect(obj(write.parsed.error).agent_level).toBe('comment')
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')
    } finally {
      await agent.close()
    }
  })

  it('view: reads, and is refused both a write and a comment', async () => {
    await leash(canvas.id, AGENT, 'view')
    const agent = await connect('Claude', OWNER_ID)
    try {
      const read = await callTool(agent.client, 'get_canvas', { canvas_id: canvas.id, agent_name: AGENT })
      expect(read.isError).toBeFalsy()

      const write = await callTool(agent.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBe(true)
      expect(errorCode(write.parsed)).toBe('forbidden')
      expect(obj(write.parsed.error).agent_level).toBe('view')
      expect(store.getFrame(frame.id)?.html).toBe('<h1>hi</h1>')

      const commented = await callTool(agent.client, 'add_comment', {
        frame_id: frame.id,
        selector: 'h1',
        text: 'a viewer may not leave this',
        agent_name: AGENT,
      })
      expect(commented.isError).toBe(true)
      expect(errorCode(commented.parsed)).toBe('forbidden')
      expect(str(obj(commented.parsed.error).message)).toContain('comment')
      expect(actions.getComments(canvas.id)).toEqual([])
    } finally {
      await agent.close()
    }
  })

  it('full by default: an agent with no row writes exactly as before', async () => {
    const agent = await connect('Claude', OWNER_ID)
    try {
      const write = await callTool(agent.client, 'set_frame_html', { frame_id: frame.id, ...WRITE })
      expect(write.isError).toBeFalsy()
      expect(store.getFrame(frame.id)?.html).toBe('<h1>replaced</h1>')
    } finally {
      await agent.close()
    }
  })

  it('reports the caller’s level for the canvas it names, and omits it otherwise', async () => {
    await leash(canvas.id, AGENT, 'comment')
    const agent = await connect('Claude', OWNER_ID, 'client-perms-caps')
    try {
      const held = await callTool(agent.client, 'get_capabilities', {
        canvas_id: canvas.id,
        agent_name: AGENT,
      })
      expect(held.isError).toBeFalsy()
      /* the text block is the payload itself, the catalog included */
      expect(held.parsed.agent_level).toBe('comment')
    } finally {
      await agent.close()
    }

    /* a connection that has never named a canvas: this call names none either,
       so there is no level to resolve and the field is absent rather than
       defaulted to one the call never established */
    const fresh = await connect('Claude', OWNER_ID, 'client-perms-anonymous')
    try {
      const anonymous = await callTool(fresh.client, 'get_capabilities', { agent_name: AGENT })
      expect(anonymous.isError).toBeFalsy()
      expect(anonymous.parsed).not.toHaveProperty('agent_level')
      expect(anonymous.parsed.tools).toBeDefined()
    } finally {
      await fresh.close()
    }
  })

  it('reports full for an agent the owner has not leashed', async () => {
    const agent = await connect('Claude', OWNER_ID)
    try {
      const held = await callTool(agent.client, 'get_capabilities', {
        canvas_id: canvas.id,
        agent_name: AGENT,
      })
      expect(held.parsed.agent_level).toBe('full')
    } finally {
      await agent.close()
    }
  })
})
