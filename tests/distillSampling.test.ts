import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, ServerMessage } from '../shared/types.ts'

/* The distiller used to need ANTHROPIC_API_KEY, so on a self-hosted instance
   with no server key a canvas never learned from feedback even though the
   connected client had a model. A client that declares `sampling` now stands in
   for that key: the same prompt, answered by the client's model, parsed by the
   same parser. Verified here through the real MCP surface because the wiring is
   the subtle part — the SDK's ServerOptions.oninitialized is declared but never
   called, so this pins the notification handler that actually runs. */

delete process.env.ANTHROPIC_API_KEY

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-distill-sampling-'))
const OWNER_ID = 'distill-sampling-owner'
const CANVAS_ID = 'c-distill-sampling'

const VERDICT =
  '{"has_rule":true,"guide_name":"style-notes","guide_title":"Style notes","rule":"- Prefer blue accent buttons","rationale":"The human keeps asking for blue accents."}'

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
  canvasId = `${CANVAS_ID}-${counter}`
  const canvas: Canvas = {
    id: canvasId,
    name: `Distill ${counter}`,
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `p-${canvasId}`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
})

/** `sampling: false` is a client that cannot be asked for a model at all. */
async function connect(sampling: boolean, onSample: (prompt: string) => string) {
  const server = buildMcpServer('Owner', OWNER_ID)
  const client = new Client(
    { name: 'doop-distill-test', version: '1.0.0' },
    { capabilities: sampling ? { sampling: {} } : {} },
  )
  if (sampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const message = request.params.messages.at(-1)
      const block = Array.isArray(message?.content) ? message?.content[0] : message?.content
      return {
        model: 'test-model',
        role: 'assistant' as const,
        content: { type: 'text' as const, text: onSample(block && block.type === 'text' ? block.text : '') },
      }
    })
  }
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

describe('distiller borrows the client model through MCP sampling', () => {
  it('proposes a rule when no server key is set but the client can sample', async () => {
    const prompts: string[] = []
    const { client, close } = await connect(true, (prompt) => {
      prompts.push(prompt)
      return prompt.includes('Reply with ONLY a JSON object') ? VERDICT : 'Prefer blue accent buttons'
    })
    /* the proposal is broadcast when it lands, so the test waits on the real
       event rather than on a guessed duration */
    let resolveLanded: (message: ServerMessage) => void = () => {}
    const landed = new Promise<ServerMessage>((resolve) => {
      resolveLanded = resolve
    })
    actions.wire(
      (_canvasId, message) => {
        if (message.type === 'proposal') resolveLanded(message)
      },
      () => {},
    )
    try {
      await client.callTool({
        name: 'save_decision',
        arguments: { canvas_id: canvasId, decision: 'make it blue, not so claude-esque', agent_name: 'Claude' },
      })
      const message = await landed
      expect(message.type === 'proposal' && message.proposal.rule).toContain('blue accent buttons')
      /* the judge is asked with the JSON-only instruction a sampling client
         needs, since there is no tool_choice on that wire */
      expect(prompts.some((prompt) => prompt.includes('Reply with ONLY a JSON object'))).toBe(true)
      expect(actions.getProposals(canvasId)).toHaveLength(1)
    } finally {
      await close()
    }
  }, 20_000)
})
