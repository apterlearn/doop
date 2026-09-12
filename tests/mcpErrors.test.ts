import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* Structured tool errors: an agent branches on error.code, so the code and the
   retryable flag are part of the contract, while the human message stays
   verbatim inside the payload for everything that reads prose. */
vi.mock('../server/db/persist.ts', () => ({
  hydrate: () => {},
  saveCanvas: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  saveTask: () => {},
  deleteTask: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteCanvas: () => {},
}))

const OWNER_ID = 'errors-owner'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerId: string | undefined = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-mcp-errors-test', version: '1.0.0' })
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

interface ErrorPayload {
  error: { code: string; message: string; retryable: boolean; [k: string]: unknown }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ raw: string; payload: ErrorPayload; isError?: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { raw, payload: JSON.parse(raw) as ErrorPayload, isError: result.isError }
}

function seedCanvas(): Canvas {
  const canvas: Canvas = {
    id: 'c-errors',
    name: 'Errors',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: 'p-errors', canvasId: 'c-errors', name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
}

beforeEach(() => {
  vi.restoreAllMocks()
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
  })
})

describe('structured MCP errors', () => {
  it('reports a missing canvas as not_found and keeps the human message intact', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const { payload, raw, isError } = await callTool(client, 'get_comments', { canvas_id: 'missing' })
      expect(isError).toBe(true)
      expect(payload.error.code).toBe('not_found')
      expect(payload.error.retryable).toBe(false)
      expect(payload.error.message).toBe('no canvas with id missing accessible to this account')
      expect(raw).toContain('no canvas with id missing')
    } finally {
      await close()
    }
  })

  it('reports a missing frame as not_found', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const { payload } = await callTool(client, 'get_frame', { frame_id: 'nope', agent_name: 'Claude' })
      expect(payload.error.code).toBe('not_found')
      expect(payload.error.message).toContain('no frame with id nope')
    } finally {
      await close()
    }
  })

  it('reports an oversized document as too_large and names the streaming tool', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const { payload } = await callTool(client, 'create_frame', {
        canvas_id: 'c-errors',
        name: 'Huge',
        html: 'x'.repeat(3_000_001),
        agent_name: 'Claude',
      })
      expect(payload.error.code).toBe('too_large')
      expect(payload.error.retryable).toBe(false)
      expect(payload.error.message).toContain('append_frame_html')
    } finally {
      await close()
    }
  })

  it('reports an impossible edit as invalid_input', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      const { payload } = await callTool(client, 'update_frame', { frame_id: 'nope', agent_name: 'Claude' })
      expect(payload.error.code).toBe('invalid_input')
      expect(payload.error.message).toBe('nothing to update')
    } finally {
      await close()
    }
  })

  it('reports a rate limit as retryable', async () => {
    seedCanvas()
    const { client, close } = await connect()
    try {
      /* upload_asset with local_file returns a ticket without touching the
         network, so the per-minute cap is reachable offline. */
      for (let i = 0; i < 15; i += 1) {
        const ok = await callTool(client, 'upload_asset', {
          canvas_id: 'c-errors',
          local_file: true,
          agent_name: 'Claude',
        })
        expect(ok.isError).toBeFalsy()
      }
      const { payload, isError } = await callTool(client, 'upload_asset', {
        canvas_id: 'c-errors',
        local_file: true,
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(payload.error.code).toBe('rate_limited')
      expect(payload.error.retryable).toBe(true)
      expect(payload.error.message).toBe('upload rate limit — wait a minute')
    } finally {
      await close()
    }
  })

})
