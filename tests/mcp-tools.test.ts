import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { buildMcpServer } from '../server/mcp.ts'

interface ToolInputSchema {
  properties?: Record<string, unknown>
  required?: string[]
}

describe('MCP website tool contract', () => {
  it('separates read-only website viewing from editable webpage imports', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const view = tools.find((tool) => tool.name === 'view_website')
      const importWebpage = tools.find((tool) => tool.name === 'import_webpage')

      expect(view).toBeDefined()
      expect(importWebpage).toBeDefined()
      expect(view!.annotations?.readOnlyHint).toBe(true)
      expect(importWebpage!.annotations?.readOnlyHint).toBe(false)

      const viewSchema = view!.inputSchema as ToolInputSchema
      expect(viewSchema.properties).not.toHaveProperty('save_reference')
      expect(viewSchema.properties).not.toHaveProperty('canvas_id')
      expect(new Set(viewSchema.required)).toEqual(new Set(['url', 'agent_name']))

      const importSchema = importWebpage!.inputSchema as ToolInputSchema
      expect(importSchema.properties).toEqual(
        expect.objectContaining({
          url: expect.any(Object),
          canvas_id: expect.any(Object),
          agent_name: expect.any(Object),
        }),
      )
      expect(new Set(importSchema.required)).toEqual(new Set(['url', 'canvas_id', 'agent_name']))

      expect(client.getInstructions()).toContain('call import_webpage FIRST')
      expect(client.getInstructions()).toContain('view_website is only for read-only inspection')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('exposes the inspection, stop and comment tools with their contracts', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const schema = (name: string) => byName.get(name)!.inputSchema as ToolInputSchema

      for (const name of [
        'inspect_frame',
        'get_frame_html',
        'stop_work',
        'add_comment',
        'reply_to_comment',
        'resolve_comment',
      ]) {
        expect(byName.has(name), `${name} should be registered`).toBe(true)
      }

      /* reading a frame must never be mistaken for a mutation */
      expect(byName.get('inspect_frame')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('get_frame_html')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('stop_work')!.annotations?.readOnlyHint).not.toBe(true)

      expect(new Set(schema('get_frame_html').required)).toEqual(new Set(['frame_id', 'agent_name']))
      expect(schema('get_frame_html').properties).toHaveProperty('query')
      expect(schema('get_frame_html').properties).toHaveProperty('limit')

      /* agent_name is how human feedback reaches an agent: without it on these
         reads the feedback channel goes silent with no error */
      for (const name of ['get_frame', 'get_frame_screenshot', 'get_guidelines', 'list_guidelines', 'get_reference']) {
        expect(new Set(schema(name).required), `${name} should require agent_name`).toContain('agent_name')
      }
      /* reading comments must never claim work, so it stays canvas-only */
      expect(new Set(schema('get_comments').required)).toEqual(new Set(['canvas_id']))

      expect(client.getInstructions()).toContain('call stop_work')
      expect(client.getInstructions()).toContain('inspect_frame')
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('publishes output schemas and returns structured content alongside the text block', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      for (const name of [
        'get_guide',
        'get_canvas',
        'get_frame',
        'get_frame_html',
        'inspect_frame',
        'get_comments',
        'list_cards',
        'list_canvases',
        'list_guidelines',
        'get_guidelines',
        'export_frame',
      ]) {
        expect(byName.get(name)?.outputSchema, `${name} should publish an outputSchema`).toBeDefined()
      }

      const result = (await client.callTool({ name: 'get_guide', arguments: { topic: 'review' } })) as unknown as {
        content: Array<{ type: string; text?: string }>
        structuredContent?: Record<string, unknown>
      }
      expect(result.structuredContent).toBeDefined()
      expect(result.structuredContent!.guide).toBe(result.content[0]!.text)
      expect(result.structuredContent!.topic).toBe('review')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
