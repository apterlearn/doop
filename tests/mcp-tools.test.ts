import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { store } from '../server/store.ts'

/* The new tool contracts below run against the real store and the real action
   machinery; only the database writes are stubbed, so a canvas created here
   never reaches Postgres and no test leaves a row behind. */
vi.mock('../server/db/persist.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/db/persist.ts')),
  saveCanvas: () => {},
  savePage: () => {},
  saveFrame: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteFrame: () => {},
  saveTask: () => {},
  saveActivity: () => {},
  saveComponent: () => {},
  saveFeedback: () => {},
  saveComment: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  saveProposal: () => {},
  saveDecision: () => {},
  deleteTask: () => {},
}))

/* The webpage importer drives a real browser at a real URL. The import itself
   is covered by tests/webpageImport.test.ts; here only the as_reference branch
   is under test, so the capture is stubbed and the frame it would have created
   is real. The store is imported inside the factory because vi.mock is hoisted
   above this file's imports, so a static one would not be initialised yet. */
vi.mock('../server/webpageImport.ts', async () => {
  const { store } = await import('../server/store.ts')
  return {
    createImportedWebpageFrame: async (input: { canvasId: string; actor: { name: string } }) => {
      const html = '<html><body><h1>Acme</h1></body></html>'
      const frame = store.createFrame(
        input.canvasId,
        { name: 'Acme', html, width: 1200, height: 3000 },
        input.actor.name,
      )
      return {
        imported: {
          title: 'Acme',
          width: 1200,
          height: 3000,
          html,
          preview: {
            screenshot: Buffer.from('preview'),
            finalUrl: 'https://acme.io/',
            description: 'Acme',
            text: 'Acme',
            textTruncated: false,
            shotCropped: false,
            pageHeight: 3000,
          },
        },
        frame,
      }
    },
  }
})

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
      /* agent_name is optional at the protocol level: the session remembers the
         name the agent already used, and a call that resolves none is nudged
         rather than refused (see the sticky-context tests) */
      expect(new Set(viewSchema.required)).toEqual(new Set(['url']))

      const importSchema = importWebpage!.inputSchema as ToolInputSchema
      expect(importSchema.properties).toEqual(
        expect.objectContaining({
          url: expect.any(Object),
          canvas_id: expect.any(Object),
          agent_name: expect.any(Object),
        }),
      )
      expect(new Set(importSchema.required)).toEqual(new Set(['url']))

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

      expect(new Set(schema('get_frame_html').required)).toEqual(new Set(['frame_id']))
      expect(schema('get_frame_html').properties).toHaveProperty('query')
      expect(schema('get_frame_html').properties).toHaveProperty('limit')

      /* agent_name is how human feedback reaches an agent. These reads used to
         demand it; now the session supplies the name the agent already used, so
         it is optional on the wire — the tools where the identity IS the call
         still refuse without it, and a canvas-scoped read that resolves no name
         at all is nudged (asserted in the sticky-context tests below). */
      for (const name of ['get_frame', 'get_frame_screenshot', 'get_guidelines', 'list_guidelines', 'get_reference']) {
        expect(schema(name).properties, `${name} should declare agent_name`).toHaveProperty('agent_name')
      }
      for (const name of ['set_status', 'get_feedback', 'take_card', 'complete_card', 'stop_work']) {
        expect(new Set(schema(name).required), `${name} should require agent_name`).toContain('agent_name')
      }
      /* reading comments must never claim work, so it stays canvas-only */
      expect(new Set(schema('get_comments').required)).toEqual(new Set())

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

const OWNER_ID = 'test-owner-id'

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
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

interface ToolResult {
  isError: boolean
  structured: Record<string, unknown>
  text: string
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }
  const text = result.content?.find((block) => block.type === 'text')?.text ?? ''
  /* a few results are a JSON payload plus prose (import_webpage adds the
     captured page's text after its JSON), so the fallback is best-effort */
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return {
    isError: result.isError === true,
    structured: result.structuredContent ?? parsed,
    text,
  }
}

/* The tools an agent uses to find work, point at a frame and set a frame's
   stylesheet — the contracts a client auto-approves on, plus the state they
   read and write. */
describe('MCP phase-0 tool contract', () => {
  const browser = findBrowserPath()

  beforeEach(() => {
    /* presence is wired by index.ts at boot; a test wires its own reader */
    actions.wirePresence(() => [])
  })

  it('registers the agent, stylesheet, search and breakpoint tools', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const schema = (name: string) => byName.get(name)!.inputSchema as ToolInputSchema

      for (const name of ['get_agents', 'get_frame_css', 'set_frame_css', 'search_frames', 'set_breakpoints']) {
        expect(byName.has(name), `${name} should be registered`).toBe(true)
      }
      for (const name of ['get_agents', 'get_frame_css', 'search_frames']) {
        expect(byName.get(name)!.annotations?.readOnlyHint, `${name} is a read`).toBe(true)
      }

      /* the redesign prompt tells the agent to import with as_reference: the
         parameter has to exist for that instruction to be followable */
      expect(schema('import_webpage').properties).toHaveProperty('as_reference')
      expect(new Set(schema('import_webpage').required)).toEqual(new Set(['url']))

      /* export_frame was the one read that could not carry human feedback */
      expect(schema('export_frame').properties).toHaveProperty('agent_name')
      expect(new Set(schema('export_frame').required)).toEqual(new Set(['frame_id']))

      expect(new Set(schema('set_frame_css').required)).toEqual(new Set(['frame_id', 'css']))
      expect(new Set(schema('get_frame_css').required)).toEqual(new Set(['frame_id']))
      expect(new Set(schema('get_agents').required)).toEqual(new Set())

      /* the edits object strips keys it does not declare, so text_replace has
         to be declared or it never reaches the primitive */
      const editProps =
        (schema('update_elements').properties as Record<string, { items?: ToolInputSchema }>).edits!.items!
          .properties ?? {}
      expect(editProps).toHaveProperty('text_replace')
      expect(schema('get_element').properties).toHaveProperty('full_text')
      expect(byName.get('get_element')!.outputSchema?.properties).toHaveProperty('text_truncated')

      /* paging parity: every paged list publishes next_offset */
      expect(byName.get('list_assets')!.outputSchema?.properties).toHaveProperty('next_offset')
      expect(byName.get('list_assets')!.outputSchema?.properties).toHaveProperty('has_more')
    } finally {
      await close()
    }
  })

  it('lists the design roles, the pipelines and who is live on the canvas', async () => {
    const canvas = store.createCanvas('Agents', OWNER_ID)
    const { client, close } = await connect()
    try {
      const fresh = await call(client, 'get_agents', { canvas_id: canvas.id })
      expect(fresh.isError).toBe(false)
      expect((fresh.structured.roles as Array<{ id: string }>).map((role) => role.id)).toEqual([
        'doop',
        'ux',
        'copy',
        'brand',
        'a11y',
        'polish',
      ])
      expect((fresh.structured.roles as Array<{ name: string; blurb: string }>)[0]).toEqual({
        id: 'doop',
        name: 'Doop',
        blurb: 'Generalist designer — makes the thing',
      })
      expect((fresh.structured.pipelines as Array<{ id: string }>).map((p) => p.id)).toEqual([
        'solo',
        'ship',
        'full',
        'audit',
      ])
      expect(fresh.structured.connected).toEqual([])

      /* a status post is the lightest sign of life an agent can give: it must
         be enough to appear as connected */
      await call(client, 'set_status', { canvas_id: canvas.id, agent_name: 'Claude', status: 'Sketching a hero' })
      const after = await call(client, 'get_agents', { canvas_id: canvas.id })
      expect(after.structured.connected).toEqual([
        { agent: 'Claude', owner: 'Test Owner', working_on: 'Sketching a hero' },
      ])

      /* an agent that has only ever been seen by presence — no task row —
         still counts, and a name seen in both sources is listed once */
      actions.wirePresence(() => [
        { name: 'Codex', owner: 'Sam', status: 'Reviewing', lastSeen: Date.now() },
        { name: 'Claude', owner: 'Sam', status: null, lastSeen: Date.now() },
      ])
      const merged = await call(client, 'get_agents', { canvas_id: canvas.id })
      expect(merged.structured.connected).toEqual([
        { agent: 'Claude', owner: 'Test Owner', working_on: 'Sketching a hero' },
        { agent: 'Codex', owner: 'Sam', working_on: 'Reviewing' },
      ])

      const unknown = await call(client, 'get_agents', { canvas_id: 'nope' })
      expect(unknown.isError).toBe(true)
      expect(unknown.structured).toMatchObject({ error: { code: 'not_found' } })
    } finally {
      await close()
    }
  })

  it('stores the canvas breakpoints and reports them from get_canvas', async () => {
    const canvas = store.createCanvas('Breakpoints', OWNER_ID)
    const { client, close } = await connect()
    try {
      const set = await call(client, 'set_breakpoints', {
        canvas_id: canvas.id,
        agent_name: 'Claude',
        breakpoints: [
          { name: 'desktop', min_width: 1280 },
          { name: 'mobile', min_width: 390 },
        ],
      })
      expect(set.isError).toBe(false)
      /* ascending by width: the order review_frame renders in is not the
         caller's to decide */
      expect(set.structured.breakpoints).toEqual([
        { name: 'mobile', min_width: 390 },
        { name: 'desktop', min_width: 1280 },
      ])

      const view = await call(client, 'get_canvas', { canvas_id: canvas.id })
      expect(view.structured.breakpoints).toEqual([
        { name: 'mobile', min_width: 390 },
        { name: 'desktop', min_width: 1280 },
      ])

      const resource = await client.readResource({ uri: `doop://canvas/${canvas.id}` })
      const read = JSON.parse(String((resource.contents[0] as { text: string }).text)) as { breakpoints?: unknown }
      expect(read.breakpoints).toEqual([
        { name: 'mobile', min_width: 390 },
        { name: 'desktop', min_width: 1280 },
      ])

      const clash = await call(client, 'set_breakpoints', {
        canvas_id: canvas.id,
        agent_name: 'Claude',
        breakpoints: [
          { name: 'mobile', min_width: 390 },
          { name: 'Mobile', min_width: 1280 },
        ],
      })
      expect(clash.isError).toBe(true)
      expect(clash.structured).toMatchObject({ error: { code: 'invalid_input' } })
      /* the refusal changed nothing */
      expect(store.getCanvas(canvas.id)!.breakpoints).toHaveLength(2)

      /* an empty list clears them, and the canvas stops reporting any */
      await call(client, 'set_breakpoints', { canvas_id: canvas.id, agent_name: 'Claude', breakpoints: [] })
      expect(store.getCanvas(canvas.id)!.breakpoints).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('saves a component at the size its caller declares', async () => {
    const canvas = store.createCanvas('Components', OWNER_ID)
    const { client, close } = await connect()
    try {
      const sized = await call(client, 'create_component', {
        canvas_id: canvas.id,
        agent_name: 'Claude',
        name: 'Pricing card',
        html: '<div class="card">Pro</div>',
        width: 320,
        height: 480,
      })
      expect(sized.isError, sized.text).toBe(false)
      const component = sized.structured.component as { id: string; width: number; height: number }
      /* the declared size is the component's own artboard: the library panel
         and insert_component both read it, so a card saved as 320x480 must not
         come back as the default frame size */
      expect(component).toMatchObject({ width: 320, height: 480 })

      const listed = await call(client, 'list_components', { canvas_id: canvas.id })
      expect(listed.structured.components).toEqual([
        expect.objectContaining({ id: component.id, width: 320, height: 480 }),
      ])

      /* a caller with no size in mind gets the size a new frame gets */
      const defaulted = await call(client, 'create_component', {
        canvas_id: canvas.id,
        agent_name: 'Claude',
        name: 'Nav bar',
        html: '<nav>Doop</nav>',
      })
      expect(defaulted.structured.component).toMatchObject({ width: 640, height: 480 })
    } finally {
      await close()
    }
  })

  it('finds a substring across the frames of a canvas', async () => {
    const canvas = store.createCanvas('Search', OWNER_ID)
    const hero = store.createFrame(
      canvas.id,
      { name: 'Hero', html: '<h1>Hello</h1><p>Start free today</p>', width: 800, height: 600 },
      'alice',
    )!
    const pricing = store.createFrame(
      canvas.id,
      { name: 'Pricing', html: '<h1>Pricing</h1><p>Start free today</p>', width: 800, height: 600 },
      'alice',
    )!
    const { client, close } = await connect()
    try {
      const found = await call(client, 'search_frames', { canvas_id: canvas.id, query: 'pricing' })
      expect(found.isError).toBe(false)
      expect(found.structured.results).toEqual([
        {
          frame_id: pricing.id,
          name: 'Pricing',
          matches: 2,
          snippets: [{ before: '<h1>', match: 'Pricing', after: '</h1><p>Start free today</p>' }],
        },
      ])

      const both = await call(client, 'search_frames', { canvas_id: canvas.id, query: 'Start free' })
      expect((both.structured.results as Array<{ frame_id: string }>).map((r) => r.frame_id).sort()).toEqual(
        [hero.id, pricing.id].sort(),
      )

      const limited = await call(client, 'search_frames', {
        canvas_id: canvas.id,
        query: 'Start free',
        limit: 1,
      })
      expect(limited.structured.results).toHaveLength(1)

      /* a miss is an empty result, not an error */
      const miss = await call(client, 'search_frames', { canvas_id: canvas.id, query: 'nothing here' })
      expect(miss.isError).toBe(false)
      expect(miss.structured.results).toEqual([])
    } finally {
      await close()
    }
  })

  it('pins an imported page to Memory instead of leaving a source frame', async () => {
    const canvas = store.createCanvas('Reference import', OWNER_ID)
    const { client, close } = await connect()
    try {
      const result = await call(client, 'import_webpage', {
        canvas_id: canvas.id,
        url: 'https://acme.io/',
        agent_name: 'Claude',
        as_reference: true,
      })
      expect(result.isError, result.text).toBe(false)
      const payload = result.structured as {
        reference: { reference_id: string; title: string; width: number; height: number }
        source_url: string
      }
      expect(payload.reference).toMatchObject({ title: 'Acme', width: 1200, height: 3000 })
      expect(payload.reference.reference_id).toEqual(expect.any(String))
      expect(payload.source_url).toBe('https://acme.io/')

      /* the reference is on the canvas, the source frame is not */
      const view = await call(client, 'get_canvas', { canvas_id: canvas.id })
      expect((view.structured.references as Array<{ id: string }>).map((r) => r.id)).toEqual([
        payload.reference.reference_id,
      ])
      expect(view.structured.frames).toEqual([])
      expect(store.getCanvas(canvas.id)!.frames).toHaveLength(0)

      /* the default is unchanged: without as_reference the frame stays */
      await call(client, 'import_webpage', { canvas_id: canvas.id, url: 'https://acme.io/', agent_name: 'Claude' })
      expect(store.getCanvas(canvas.id)!.frames).toHaveLength(1)
      expect(store.getCanvas(canvas.id)!.references).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('hands a card’s target element to the agent that reads the board', async () => {
    const canvas = store.createCanvas('Targets', OWNER_ID)
    const frame = store.createFrame(
      canvas.id,
      { name: 'Hero', html: '<button class="cta">Buy</button>', width: 800, height: 600 },
      'alice',
    )!
    /* a real page id: the card's page is validated against the canvas, so a
       page id from elsewhere would send the agent looking in the wrong place */
    const pageId = store.getCanvas(canvas.id)!.pages![0]!.id
    actions.addQueuedCard(
      canvas.id,
      'Make the CTA bigger',
      'alice',
      undefined,
      undefined,
      undefined,
      [frame.id],
      '.cta',
      pageId,
    )
    const { client, close } = await connect()
    try {
      const listed = await call(client, 'list_cards', { canvas_id: canvas.id })
      expect(listed.isError).toBe(false)
      expect(listed.structured.cards).toEqual([
        expect.objectContaining({
          title: 'Make the CTA bigger',
          target_frames: [frame.id],
          /* "fix THIS element" only survives the queue if the selector travels
             with the card — the frame id alone is not the instruction */
          target_selector: '.cta',
          target_page_id: pageId,
        }),
      ])

      /* a card queued without a selection simply has neither field */
      actions.addQueuedCard(canvas.id, 'Try a new hero', 'alice', undefined, undefined, undefined, [frame.id])
      const again = await call(client, 'list_cards', { canvas_id: canvas.id })
      const plain = (again.structured.cards as Array<Record<string, unknown>>).find(
        (card) => card.title === 'Try a new hero',
      )!
      expect(plain).not.toHaveProperty('target_selector')
      expect(plain).not.toHaveProperty('target_page_id')
    } finally {
      await close()
    }
  })

  it.skipIf(!browser)('writes and reads back the frame stylesheet over MCP', async () => {
    const canvas = store.createCanvas('Stylesheet', OWNER_ID)
    const frame = store.createFrame(
      canvas.id,
      {
        name: 'Sheet',
        html: '<html><head></head><body><p class="x">Hi</p></body></html>',
        width: 800,
        height: 600,
      },
      'alice',
    )!
    const { client, close } = await connect()
    try {
      const css = '@media (max-width: 600px){.x{color:red}}'
      const set = await call(client, 'set_frame_css', {
        canvas_id: canvas.id,
        frame_id: frame.id,
        agent_name: 'Claude',
        css,
      })
      expect(set.isError, set.text).toBe(false)
      expect(set.structured.css_bytes).toBe(css.length)

      const read = await call(client, 'get_frame_css', { frame_id: frame.id })
      expect(read.isError).toBe(false)
      expect(read.structured.css).toBe(css)

      /* a second write replaces the block instead of stacking rules */
      const next = '.x{color:blue}'
      await call(client, 'set_frame_css', {
        canvas_id: canvas.id,
        frame_id: frame.id,
        agent_name: 'Claude',
        css: next,
      })
      const reread = await call(client, 'get_frame_css', { frame_id: frame.id })
      expect(reread.structured.css).toBe(next)
      expect(store.getFrame(frame.id)!.html.match(/data-doop-css/g)).toHaveLength(1)

      /* a frame stylesheet must not fetch anything: every viewer renders it */
      const refused = await call(client, 'set_frame_css', {
        canvas_id: canvas.id,
        frame_id: frame.id,
        agent_name: 'Claude',
        css: '@import url("https://acme.io/x.css");',
      })
      expect(refused.isError).toBe(true)
      expect(refused.structured).toMatchObject({ error: { code: 'invalid_input' } })
    } finally {
      await close()
    }
  })

  it.skipIf(!browser)('replaces part of an element’s text over MCP', async () => {
    const canvas = store.createCanvas('Replace', OWNER_ID)
    const frame = store.createFrame(
      canvas.id,
      {
        name: 'Copy',
        html: '<html><body><p class="lede">Ship faster today</p></body></html>',
        width: 800,
        height: 600,
      },
      'alice',
    )!
    const { client, close } = await connect()
    try {
      const result = await call(client, 'update_elements', {
        canvas_id: canvas.id,
        frame_id: frame.id,
        agent_name: 'Claude',
        edits: [
          {
            selector: '.lede',
            text_replace: { old_str: 'faster', new_str: '<strong>faster</strong>', html: true },
          },
        ],
      })
      expect(result.isError).toBe(false)
      expect(result.structured.applied).toBe(1)
      /* the rest of the sentence survives — the whole point of the primitive */
      expect(store.getFrame(frame.id)!.html).toContain('Ship <strong>faster</strong> today')
    } finally {
      await close()
    }
  })
})
