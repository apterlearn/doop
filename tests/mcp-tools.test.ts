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
  saveActivity: () => {},
  saveComponent: () => {},
  saveComment: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  saveProposal: () => {},
  saveDecision: () => {},
  /* review_canvas and the ship gate read and write stored reports; the store
     and the renderer are real here, the database is not */
  saveFrameReview: () => {},
  listFrameReviews: async () => [],
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

  it('exposes the inspection and comment tools with their contracts', async () => {
    const server = buildMcpServer('Test Owner', 'test-owner-id')
    const client = new Client({ name: 'doop-tool-contract-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const schema = (name: string) => byName.get(name)!.inputSchema as ToolInputSchema

      for (const name of ['inspect_frame', 'get_frame_html', 'add_comment', 'reply_to_comment', 'resolve_comment']) {
        expect(byName.has(name), `${name} should be registered`).toBe(true)
      }

      /* reading a frame must never be mistaken for a mutation */
      expect(byName.get('inspect_frame')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('get_frame_html')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('add_comment')!.annotations?.readOnlyHint).not.toBe(true)

      expect(new Set(schema('get_frame_html').required)).toEqual(new Set(['frame_id']))
      expect(schema('get_frame_html').properties).toHaveProperty('query')
      expect(schema('get_frame_html').properties).toHaveProperty('limit')

      /* agent_name is the attribution and the address a comment is routed to.
         These reads used to demand it; now the session supplies the name the
         agent already used, so it is optional on the wire — the tools where the
         identity IS the call still refuse without it, and a canvas-scoped read
         that resolves no name at all is nudged (asserted in the sticky-context
         tests below). */
      for (const name of ['get_frame', 'get_frame_screenshot', 'get_guidelines', 'list_guidelines', 'get_reference']) {
        expect(schema(name).properties, `${name} should declare agent_name`).toHaveProperty('agent_name')
      }
      for (const name of ['claim_comment', 'ask_human', 'wait_for_events']) {
        expect(new Set(schema(name).required), `${name} should require agent_name`).toContain('agent_name')
      }
      /* reading comments must never claim work, so it stays canvas-only */
      expect(new Set(schema('get_comments').required)).toEqual(new Set())

      /* the instructions name the work channel (a human's note reaches an agent
         only on a call it makes) and the tool a big frame is read with */
      expect(client.getInstructions()).toContain('claim_comment takes the notes addressed to your role')
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

      /* export_frame is the one read that takes an agent_name: the export is
         attributed to whoever asked for it */
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

  it('lists the design roles and who is live on the canvas', async () => {
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
      /* nobody has called yet: presence is the whole record of who is here */
      expect(fresh.structured.connected).toEqual([])

      /* presence is read per name, so an agent its client reports twice is
         listed once — with the first owner it was seen under */
      actions.wirePresence(() => [
        { name: 'Codex', owner: 'Sam', lastSeen: Date.now() },
        { name: 'Claude', owner: 'Sam', lastSeen: Date.now() },
        { name: 'Claude', owner: 'Test Owner', lastSeen: Date.now() },
      ])
      const merged = await call(client, 'get_agents', { canvas_id: canvas.id })
      expect(merged.structured.connected).toEqual([
        { agent: 'Codex', owner: 'Sam' },
        { agent: 'Claude', owner: 'Sam' },
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

/* The canvas-wide half of the surface: the sweep that judges a whole design,
   the fixer for a11y/content findings, the canvas-wide rename, the release
   diff and the two pull-request tools that update a handoff. */
describe('MCP ship and verify tool contract', () => {
  const browser = findBrowserPath()

  beforeEach(() => {
    actions.wirePresence(() => [])
  })

  const NEW_TOOLS = [
    'review_canvas',
    'fix_frame_a11y',
    'replace_in_frames',
    'diff_release',
    'update_pull_request',
    'comment_pull_request',
    'propose_canvas_change',
    'list_canvas_proposals',
    'resolve_canvas_proposal',
  ]

  it('registers the sweep, the fixer, the rename, the diff and the handoff tools', async () => {
    const { client, close } = await connect()
    try {
      const { tools } = await client.listTools()
      const byName = new Map(tools.map((tool) => [tool.name, tool]))
      const schema = (name: string) => byName.get(name)!.inputSchema as ToolInputSchema

      for (const name of NEW_TOOLS) expect(byName.has(name), `${name} should be registered`).toBe(true)

      /* the two that only read must say so — a client auto-approves on it */
      expect(byName.get('diff_release')!.annotations?.readOnlyHint).toBe(true)
      expect(byName.get('list_canvas_proposals')!.annotations?.readOnlyHint).toBe(true)
      /* and the ones that write must never claim to be reads: review_canvas
         stores a report per frame, the fixer edits the frame, the rename and
         the pull-request pair change state on two surfaces */
      for (const name of [
        'review_canvas',
        'fix_frame_a11y',
        'replace_in_frames',
        'update_pull_request',
        'comment_pull_request',
        'propose_canvas_change',
        'resolve_canvas_proposal',
      ])
        expect(byName.get(name)!.annotations?.readOnlyHint, `${name} writes`).not.toBe(true)

      /* every new tool publishes the shape it returns */
      for (const name of NEW_TOOLS) expect(byName.get(name)!.outputSchema, `${name} outputSchema`).toBeDefined()

      /* the writes carry the idempotency key the wrapper replays on */
      for (const name of ['review_canvas', 'fix_frame_a11y', 'replace_in_frames', 'update_pull_request'])
        expect(schema(name).properties, `${name} takes op_id`).toHaveProperty('op_id')

      /* canvas_id is optional on the wire: the session supplies the canvas the
         agent is already working on, and a call that resolves none is refused
         by the handler rather than by the protocol */
      expect(new Set(schema('replace_in_frames').required)).toEqual(new Set(['find', 'replace']))
      expect(schema('replace_in_frames').properties).toHaveProperty('canvas_id')
      expect(schema('replace_in_frames').properties).toHaveProperty('dry_run')
      expect(schema('replace_in_frames').properties).toHaveProperty('frame_ids')
      expect(schema('fix_frame_a11y').properties).toHaveProperty('only')
      expect(schema('fix_frame_a11y').properties).toHaveProperty('dry_run')
      expect(new Set(schema('review_canvas').required)).toEqual(new Set())
      expect(schema('review_canvas').properties).toHaveProperty('page')
      expect(new Set(schema('diff_release').required)).toEqual(new Set(['release_id']))
      expect(new Set(schema('comment_pull_request').required)).toEqual(new Set(['repo', 'pull', 'body']))

      /* the export format gained the developer handoff, and open_pull_request
         gained the gate's override */
      const formatField = (schema('export_canvas').properties ?? {}) as Record<string, { enum?: string[] }>
      expect(formatField.format!.enum).toContain('code')
      expect(schema('open_pull_request').properties).toHaveProperty('force')
      for (const name of ['publish_canvas', 'create_release', 'restore_release'])
        expect(schema(name).properties, `${name} takes force`).toHaveProperty('force')
    } finally {
      await close()
    }
  })

  it('renames a string across every frame of a canvas', async () => {
    const canvas = store.createCanvas('Canvas rename', OWNER_ID)
    const hero = store.createFrame(
      canvas.id,
      { name: 'Hero', html: '<h1>Acme</h1><p>Acme ships today</p>', width: 800, height: 600 },
      'alice',
    )!
    const pricing = store.createFrame(
      canvas.id,
      { name: 'Pricing', html: '<h1>Acme pricing</h1>', width: 800, height: 600 },
      'alice',
    )!
    const { client, close } = await connect()
    try {
      const dry = await call(client, 'replace_in_frames', {
        canvas_id: canvas.id,
        find: 'Acme',
        replace: 'Doop',
        dry_run: true,
        agent_name: 'Claude',
      })
      expect(dry.isError, dry.text).toBe(false)
      expect(dry.structured.total_matches).toBe(3)
      expect(dry.structured.dry_run).toBe(true)
      /* a rehearsal counts and writes nothing */
      expect(store.getFrame(hero.id)!.html).toContain('Acme')

      const applied = await call(client, 'replace_in_frames', {
        canvas_id: canvas.id,
        find: 'Acme',
        replace: 'Doop',
        agent_name: 'Claude',
      })
      expect(applied.isError, applied.text).toBe(false)
      expect(applied.structured.total_matches).toBe(3)
      expect(applied.structured.frames).toEqual([
        { frame_id: hero.id, name: 'Hero', matches: 2, applied: true },
        { frame_id: pricing.id, name: 'Pricing', matches: 1, applied: true },
      ])
      expect(store.getFrame(hero.id)!.html).toBe('<h1>Doop</h1><p>Doop ships today</p>')
      expect(store.getFrame(pricing.id)!.html).toBe('<h1>Doop pricing</h1>')

      /* a pattern that will not compile is refused before anything is read */
      const bad = await call(client, 'replace_in_frames', {
        canvas_id: canvas.id,
        find: '([',
        replace: 'x',
        regex: true,
        agent_name: 'Claude',
      })
      expect(bad.isError).toBe(true)
      expect(bad.structured).toMatchObject({ error: { code: 'invalid_input' } })
    } finally {
      await close()
    }
  })

  it.skipIf(!browser)(
    'fixes the a11y findings that need no judgement and names the rest',
    async () => {
      const canvas = store.createCanvas('A11y fixer', OWNER_ID)
      const frame = store.createFrame(
        canvas.id,
        {
          name: 'Landing',
          html: '<!doctype html><html><head><meta charset="utf-8"></head><body><button class="cta">Buy</button><p>Lorem ipsum dolor sit amet</p></body></html>',
          width: 800,
          height: 600,
        },
        'alice',
      )!
      const { client, close } = await connect()
      try {
        const dry = await call(client, 'fix_frame_a11y', {
          canvas_id: canvas.id,
          frame_id: frame.id,
          dry_run: true,
          agent_name: 'Claude',
        })
        expect(dry.isError, dry.text).toBe(false)
        expect(dry.structured.would_apply).toBe(true)
        const planned = dry.structured.applied as string[]
        for (const rule of ['html_lang', 'no_title', 'missing_state'])
          expect(
            planned.some((entry) => entry.startsWith(`${rule}:`)),
            `${rule} should be planned`,
          ).toBe(true)
        /* the judgement calls are named, not guessed at */
        const skipped = dry.structured.skipped as { rule: string }[]
        expect(skipped.map((entry) => entry.rule)).toContain('placeholder_text')
        /* a rehearsal writes nothing */
        expect(store.getFrame(frame.id)!.html).not.toContain('lang=')

        const applied = await call(client, 'fix_frame_a11y', {
          canvas_id: canvas.id,
          frame_id: frame.id,
          agent_name: 'Claude',
        })
        expect(applied.isError, applied.text).toBe(false)
        expect(applied.structured.changed).toBe(true)
        const html = store.getFrame(frame.id)!.html
        expect(html).toContain('lang="en"')
        expect(html).toContain('<title>Landing</title>')
        expect(html).toContain(':focus-visible')
        expect(html).toContain('Lorem ipsum')

        /* running it again is quiet: nothing left to fix is not a failure */
        const again = await call(client, 'fix_frame_a11y', {
          canvas_id: canvas.id,
          frame_id: frame.id,
          only: ['html_lang', 'no_title', 'missing_state'],
          agent_name: 'Claude',
        })
        expect(again.isError, again.text).toBe(false)
        expect(again.structured.changed).toBe(false)
        expect(again.structured.applied).toEqual([])
      } finally {
        await close()
      }
    },
    120_000,
  )

  it.skipIf(!browser)(
    'sweeps a whole canvas and fails it on one failing frame',
    async () => {
      const canvas = store.createCanvas('Sweep', OWNER_ID)
      /* one frame with an image that has no alt text: a blocking finding, so the
       canvas verdict has to be fail — not merely "not pass yet" */
      const broken = store.createFrame(
        canvas.id,
        {
          name: 'Broken',
          html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Broken</title></head><body><main><h1>Hello</h1><img src="hero.png"></main></body></html>',
          width: 800,
          height: 600,
        },
        'alice',
      )!
      const { client, close } = await connect()
      try {
        const result = await call(client, 'review_canvas', { canvas_id: canvas.id, agent_name: 'Claude' })
        expect(result.isError, result.text).toBe(false)
        expect(result.structured.verdict).toBe('fail')
        const rows = result.structured.frames as { frame_id: string; verdict: string; blocking: number }[]
        const totals = result.structured.totals as { fail: number }
        expect(rows.map((row) => row.frame_id)).toEqual([broken.id])
        expect(rows[0]).toMatchObject({ verdict: 'fail' })
        expect(rows[0]!.blocking).toBeGreaterThan(0)
        expect(totals.fail).toBe(1)

        /* the result points at the per-frame gate for the fix, not at another
         sweep: review_frame/ready_for_review stay how one frame is cleared */
        const nudge = (await client.callTool({
          name: 'review_canvas',
          arguments: { canvas_id: canvas.id, agent_name: 'Claude' },
        })) as unknown as { content: Array<{ type: string; text?: string }> }
        const prose = nudge.content.map((block) => block.text ?? '').join(' ')
        expect(prose).toContain('ready_for_review')
        expect(prose).toContain('not shipping clean')

        /* the sweep is canvas-wide: a page filter is the only narrowing */
        const page = store.getCanvas(canvas.id)!.pages![0]!.id
        const scoped = await call(client, 'review_canvas', {
          canvas_id: canvas.id,
          page,
          agent_name: 'Claude',
        })
        expect(scoped.isError, scoped.text).toBe(false)
        const scopedRows = scoped.structured.frames as unknown[]
        expect(scopedRows.length).toBe(1)

        const unknown = await call(client, 'review_canvas', { canvas_id: 'nope', agent_name: 'Claude' })
        expect(unknown.isError).toBe(true)
        expect(unknown.structured).toMatchObject({ error: { code: 'not_found' } })
      } finally {
        await close()
      }
    },
    180_000,
  )
})
