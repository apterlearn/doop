import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { ElementEditError, getElement, getFrameCss, setFrameCss, updateElements } from '../server/elementEdit.ts'
import { probeFrame } from '../server/domProbe.ts'
import { loadFramePage } from '../server/screenshot.ts'
import { ELEMENT_KEY_SRC, ELEMENT_PATH_SRC } from '../shared/selector.ts'
import { FRAME_BOOTSTRAP } from '../src/lib/frameRuntime.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Element-level editing, and the one thing that makes it work: an element has
   to have the same name in the panel, in the frame runtime and in the server's
   probe. The parity check at the bottom is the reason the shared selector
   module exists. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  hydrate: () => {},
  saveCanvas: () => {},
  saveCanvasCopy: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  setFramePage: () => {},
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
  deleteComponentRow: () => {},
  releaseFrames: () => [],
  freezeFrames: () => [],
  MAX_CANVAS_VERSIONS: 50,
  saveCanvasVersion: () => {},
  listCanvasVersions: async () => [],
  getCanvasVersion: async () => undefined,
  summarizeCanvasVersion: () => ({ id: '', cause: 'auto', createdAt: 0, createdBy: '', frameCount: 0 }),
  deleteCanvasVersion: () => {},
  pruneCanvasVersions: () => {},
  restoreFrameRow: () => {},
  restoreCanvasRow: () => {},
  hardDeleteFrame: () => {},
  hardDeleteCanvas: () => {},
  purgeTrash: () => {},
  TRASH_RETENTION_DAYS: 30,
}))

const OWNER_ID = 'element-owner'
const CANVAS_ID = 'c-element'
const browser = findBrowserPath()

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-element-test', version: '1.0.0' })
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
  const result = (await client.callTool({ name, arguments: args })) as unknown as CallResult
  const raw = result.content.find((block) => block.type === 'text')?.text ?? ''
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, isError: result.isError }
}

const FIXTURE = `<!doctype html>
<html><head><style>
  .card { background: #ffffff; border-radius: 8px; padding: 16px; }
  .card h3 { font-size: 18px; margin: 0 0 8px; }
</style></head>
<body>
  <main>
    <section class="card"><h3>First</h3><p>one</p></section>
    <section class="card"><h3>Second</h3><p>two</p></section>
    <section class="card" id="third"><h3>Third</h3><p>three</p></section>
  </main>
</body></html>`

function seedFrame(html = FIXTURE): Frame {
  const frame: Frame = {
    id: 'f-element',
    canvasId: CANVAS_ID,
    name: 'Element fixture',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
    pageId: 'p-element',
  }
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Element',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [frame],
    pages: [{ id: 'p-element', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frame
}

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  seedFrame()
})

describe.skipIf(!browser)('element tools', () => {
  it('reads one element with the computed view the human panel shows', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: '#third',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed).toMatchObject({ matched: 1, tag: 'section', id: 'third' })
      expect(parsed.text).toContain('Third')

      /* the computed view is the rendered one, not the declared one: the
         heading inside the section resolves its own font-size */
      const heading = await callTool(client, 'get_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: '#third > h3',
        agent_name: 'Claude',
      })
      expect((heading.parsed.computed as unknown as { fontSize: string }).fontSize).toBe('18px')
      expect((heading.parsed.computed as unknown as { box: { height: number } }).box.height).toBeGreaterThan(0)
    } finally {
      await close()
    }
  })

  it('names the selector when nothing matches', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: '.nope',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('not_found')
      expect((parsed.error as unknown as { message: string }).message).toContain('.nope')
    } finally {
      await close()
    }
  })

  it('changes exactly the elements a selector names, and nothing else', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'update_elements', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        edits: [{ selector: 'section:nth-of-type(2) > h3', style: { 'background-color': 'rgb(1, 2, 3)' } }],
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.applied).toBe(1)

      const stored = store.getFrame('f-element')!.html
      /* one heading carries the change… */
      expect(stored.match(/background-color: rgb\(1, 2, 3\)/g) ?? []).toHaveLength(1)
      /* …and it is the second one */
      expect(stored).toMatch(/<h3 style="[^"]*background-color: rgb\(1, 2, 3\)[^"]*">Second<\/h3>/)
    } finally {
      await close()
    }
  })

  it('applies nothing when one selector in the batch does not resolve', async () => {
    const { client, close } = await connect()
    try {
      const before = store.getFrame('f-element')!.html
      const { isError } = await callTool(client, 'update_elements', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        edits: [
          { selector: 'h3', style: { color: 'rgb(9, 9, 9)' } },
          { selector: '.missing', style: { color: 'rgb(9, 9, 9)' } },
        ],
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect(store.getFrame('f-element')!.html).toBe(before)
    } finally {
      await close()
    }
  })

  it('reports a selector that hits several elements', async () => {
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'update_elements', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        edits: [{ selector: '.card', style: { padding: '24px' } }],
        agent_name: 'Claude',
      })
      expect(parsed.applied).toBe(3)
      expect(parsed.ambiguous).toEqual(['.card'])
    } finally {
      await close()
    }
  })

  it('inserts and deletes an element, leaving the frame where it started', async () => {
    const { client, close } = await connect()
    try {
      const before = store.getFrame('f-element')!.html
      const inserted = await callTool(client, 'insert_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        parent_selector: 'main',
        position: 'append',
        html: '<section class="card"><h3>Fourth</h3></article>'.replace('</article>', '<p>four</p></section>'),
        agent_name: 'Claude',
      })
      expect(inserted.isError).toBeFalsy()
      expect(store.getFrame('f-element')!.html).toContain('Fourth')

      const removed = await callTool(client, 'delete_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: inserted.parsed.selector as unknown as string,
        agent_name: 'Claude',
      })
      expect(removed.isError).toBeFalsy()
      /* the round trip lands back on the same document, byte for byte: an
         insert and its matching delete are a no-op on the stored HTML */
      expect(store.getFrame('f-element')!.html).toBe(before)
    } finally {
      await close()
    }
  })

  it('refuses markup that would run code inside every viewer’s frame', async () => {
    const { client, close } = await connect()
    try {
      const before = store.getFrame('f-element')!.html
      const { parsed, isError } = await callTool(client, 'insert_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        parent_selector: 'main',
        position: 'append',
        html: '<img src="x" onerror="alert(1)">',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('invalid_input')
      expect(store.getFrame('f-element')!.html).toBe(before)
    } finally {
      await close()
    }
  })

  it('refuses to delete the document root', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'delete_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: 'body',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('invalid_input')
    } finally {
      await close()
    }
  })

  it('refuses element writes in review mode', async () => {
    actions.setCanvasReviewMode(
      CANVAS_ID,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    try {
      const before = store.getFrame('f-element')!.html
      const { parsed, isError } = await callTool(client, 'update_elements', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        edits: [{ selector: 'h3', style: { color: 'rgb(9, 9, 9)' } }],
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('unsupported')
      expect(store.getFrame('f-element')!.html).toBe(before)
    } finally {
      await close()
    }
  })

  it('runs an element edit inside a batch', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        ops: [
          {
            op: 'update_elements',
            frame_id: 'f-element',
            edits: [{ selector: '#third > h3', text: 'Third!' }],
            agent_name: 'Claude',
          },
          { op: 'delete_element', frame_id: 'f-element', selector: 'section:nth-of-type(1)', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(parsed.applied, JSON.stringify(parsed.results)).toBe(2)
      expect(isError).toBeFalsy()

      const stored = store.getFrame('f-element')!.html
      expect(stored).toContain('Third!')
      expect(stored).not.toContain('First')
    } finally {
      await close()
    }
  })

  it('refuses an element edit inside a batch on a review-mode canvas', async () => {
    actions.setCanvasReviewMode(
      CANVAS_ID,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    try {
      const before = store.getFrame('f-element')!.html
      const { parsed, isError } = await callTool(client, 'apply_ops', {
        canvas_id: CANVAS_ID,
        atomic: true,
        ops: [
          {
            op: 'update_elements',
            frame_id: 'f-element',
            edits: [{ selector: 'h3', style: { color: 'red' } }],
            agent_name: 'Claude',
          },
          { op: 'delete_frame', frame_id: 'f-element', agent_name: 'Claude' },
        ],
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('unsupported')
      expect(store.getFrame('f-element')!.html).toBe(before)
    } finally {
      await close()
    }
  })
})

describe.skipIf(!browser)('one selector, three consumers', () => {
  it('the frame runtime boots the same algorithm the panel and the server use', () => {
    expect(FRAME_BOOTSTRAP).toContain(ELEMENT_PATH_SRC)
    expect(FRAME_BOOTSTRAP).toContain('var cssPath = globalThis.doopElementPath')
  })

  it('the probe names elements exactly the way the shared algorithm does', async () => {
    const frame = seedFrame()
    const loaded = await loadFramePage(frame)
    /* how many elements each path names, read in the page so the comparison
       below is against the browser's own view of the document */
    const paths = await (async () => {
      try {
        await loaded.page.evaluate('globalThis.__name = (target) => target')
        await loaded.page.evaluate(ELEMENT_PATH_SRC)
        return await loaded.page.evaluate(() => {
          const out: Record<string, number> = {}
          const path = (globalThis as unknown as { doopElementPath: (el: Element) => string }).doopElementPath
          for (const el of Array.from(document.querySelectorAll('*'))) {
            const key = path(el)
            out[key] = (out[key] ?? 0) + 1
          }
          return out
        })
      } finally {
        await loaded.close()
      }
    })()

    const probe = await probeFrame(frame)
    expect(probe.elements.length).toBeGreaterThan(3)
    for (const el of probe.elements) {
      /* a selector the probe reports has to be one the panel and the frame
         runtime produce too — otherwise the agent's selector selects nothing
         when a human clicks the same element — and it has to resolve to
         exactly one element */
      expect(paths[el.selector], `${el.selector} is not a path the panel produces`).toBe(1)
    }
  })

  it('produces the same string as the panel-side algorithm for nested siblings', async () => {
    const frame = seedFrame()
    const loaded = await loadFramePage(frame)
    try {
      await loaded.page.evaluate(ELEMENT_PATH_SRC)
      const inPage = await loaded.page.evaluate(() =>
        (globalThis as unknown as { doopElementPath: (el: Element) => string }).doopElementPath(
          document.querySelector('section:nth-of-type(2)')!,
        ),
      )
      expect(inPage).toBe('body:nth-of-type(1) > main:nth-of-type(1) > section:nth-of-type(2)')
    } finally {
      await loaded.close()
    }
  })
})

describe.skipIf(!browser)('comment anchors', () => {
  it('keeps the pin on the element when a sibling is inserted above it', async () => {
    const { client, close } = await connect()
    try {
      /* anchor a comment on the second card's heading, with the key the probe
         publishes for it */
      const heading = await callTool(client, 'get_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: 'section:nth-of-type(2) > h3',
        agent_name: 'Claude',
      })
      const key = heading.parsed.key as unknown as string
      expect(key).toContain('Second')
      await callTool(client, 'add_comment', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: 'section:nth-of-type(2) > h3',
        stable_key: key,
        text: 'check this copy',
        agent_name: 'Claude',
      })

      /* insert a card above it: the stored selector now names the wrong card */
      await callTool(client, 'insert_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        parent_selector: 'main',
        position: 'prepend',
        html: '<section class="card"><h3>Zeroth</h3><p>zero</p></section>',
        agent_name: 'Claude',
      })

      const comments = await callTool(client, 'get_comments', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
      })
      const stored = (comments.parsed.comments as unknown as { stableKey?: string; selector?: string }[])[0]
      expect(stored?.stableKey).toBe(key)

      /* and the runtime's resolution follows the key, not the stale path */
      const frame = store.getFrame('f-element')!
      const loaded = await loadFramePage(frame)
      try {
        await loaded.page.evaluate('globalThis.__name = (target) => target')
        await loaded.page.evaluate(ELEMENT_PATH_SRC)
        await loaded.page.evaluate(ELEMENT_KEY_SRC)
        const resolved = await loaded.page.evaluate(
          (args: { selector: string; key: string }) => {
            const key = (globalThis as unknown as { doopElementKey: (el: Element) => string }).doopElementKey
            const bySelector = document.querySelector(args.selector)
            const matches = Array.from(document.querySelectorAll('*')).filter((el) => key(el) === args.key)
            return {
              selectorHits: bySelector?.textContent ?? null,
              keyMatches: matches.length,
              keyText: matches[0]?.textContent ?? null,
            }
          },
          { selector: stored!.selector!, key },
        )
        /* the stale selector now names the wrong card: the inserted one took
           position 1, so position 2 is the card that used to be first */
        expect(resolved.selectorHits).toContain('First')
        /* …and the key finds exactly the element the comment is about */
        expect(resolved.keyMatches).toBe(1)
        expect(resolved.keyText).toContain('Second')
      } finally {
        await loaded.close()
      }
    } finally {
      await close()
    }
  })
})

/* Three things an element edit cannot express as an inline style or a
   whole-text replacement: the frame's own stylesheet (media queries, states,
   motion), a change to part of a sentence, and the text a long element is
   actually carrying. */

const TEXT_FIXTURE = `<!doctype html>
<html><head></head><body>
  <main>
    <p id="copy">Ship the release <em>today</em> with the new tokens.</p>
    <p id="repeat">check this, check this again</p>
    <p id="markup">Buy the ticket now.</p>
  </main>
</body></html>`

describe.skipIf(!browser)('frame stylesheet', () => {
  it('writes one block and reads it back', async () => {
    const frame = seedFrame()
    const css = '.card { padding: 24px; }\n@media (max-width: 600px) { .card { padding: 8px; } }'
    const { html } = await setFrameCss(frame, css)
    expect(html.match(/data-doop-css/g) ?? []).toHaveLength(1)
    /* the frame the write produced is the frame the read parses */
    expect((await getFrameCss({ ...frame, html })).css).toBe(css)
  })

  it('replaces the block instead of stacking a second one', async () => {
    const frame = seedFrame()
    const first = await setFrameCss(frame, '.card { padding: 24px; }')
    const second = await setFrameCss({ ...frame, html: first.html }, '.card { padding: 4px; }')
    expect(second.html.match(/data-doop-css/g) ?? []).toHaveLength(1)
    expect(second.html).toContain('padding: 4px')
    expect(second.html).not.toContain('padding: 24px')
    expect((await getFrameCss({ ...frame, html: second.html })).css).toBe('.card { padding: 4px; }')
  })

  it('gives a frame with no stylesheet one inside <head>', async () => {
    const frame = seedFrame()
    expect(frame.html).not.toContain('data-doop-css')
    const { html } = await setFrameCss(frame, '.card { color: rgb(1, 2, 3); }')
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    expect(head).toContain('data-doop-css')
    expect(head).toContain('.card { color: rgb(1, 2, 3); }')
    expect(await getFrameCss({ ...frame, html })).toEqual({ css: '.card { color: rgb(1, 2, 3); }' })
  })

  it('reads an empty stylesheet from a frame that has none', async () => {
    expect(await getFrameCss(seedFrame())).toEqual({ css: '' })
  })

  it('refuses @import, which would fetch inside every viewer’s frame', async () => {
    const error = await setFrameCss(seedFrame(), '@import url("https://fonts.example/x.css");').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('invalid_input')
    expect((error as ElementEditError).message).toContain('@import')
  })

  it('refuses a stylesheet over 100 KB', async () => {
    const error = await setFrameCss(seedFrame(), `.card { color: red; }\n/*${'x'.repeat(100_001)}*/`).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('too_large')
  })
})

describe.skipIf(!browser)('partial text replacement', () => {
  it('replaces one phrase inside a sentence and leaves the markup around it alone', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const { html, applied } = await updateElements(frame, [
      { selector: '#copy', text_replace: { old_str: 'the release', new_str: 'the hotfix' } },
    ])
    expect(applied).toBe(1)
    expect(html).toContain('Ship the hotfix <em>today</em> with the new tokens.')
  })

  it('replaces the element’s own text only, never its children’s', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    /* “today” is inside the <em>, not in the paragraph's own text */
    const error = await updateElements(frame, [
      { selector: '#copy', text_replace: { old_str: 'today', new_str: 'tomorrow' } },
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('not_found')
    expect((error as ElementEditError).message).toContain('today')
  })

  it('applies nothing when the text is not there', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const error = await updateElements(frame, [
      { selector: '#markup', style: { color: 'rgb(9, 9, 9)' } },
      { selector: '#copy', text_replace: { old_str: 'yesterday', new_str: 'tomorrow' } },
    ]).catch((e: unknown) => e)
    /* the batch is refused, so the style edit that would have landed beside it
       did not land either */
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('not_found')
    expect((error as ElementEditError).message).toContain('yesterday')
  })

  it('refuses a phrase that occurs twice, and changes nothing', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const error = await updateElements(frame, [
      { selector: '#repeat', text_replace: { old_str: 'check this', new_str: 'checked' } },
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('invalid_input')
    expect((error as ElementEditError).message).toContain('occurs 2 times')
  })

  it('inserts inline markup when html is set', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const { html } = await updateElements(frame, [
      { selector: '#markup', text_replace: { old_str: 'ticket', new_str: '<strong>ticket</strong>', html: true } },
    ])
    expect(html).toContain('Buy the <strong>ticket</strong> now.')
  })

  it('refuses markup that would run code inside every viewer’s frame', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const error = await updateElements(frame, [
      {
        selector: '#markup',
        text_replace: { old_str: 'ticket', new_str: '<script>alert(1)</script>', html: true },
      },
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('invalid_input')
  })

  it('refuses a tag outside the inline allowlist', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const error = await updateElements(frame, [
      { selector: '#markup', text_replace: { old_str: 'ticket', new_str: '<section>x</section>', html: true } },
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('invalid_input')
    expect((error as ElementEditError).message).toContain('<section>')
  })

  it('refuses a link whose href is not a safe target', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const error = await updateElements(frame, [
      {
        selector: '#markup',
        text_replace: { old_str: 'ticket', new_str: '<a href="javascript:alert(1)">ticket</a>', html: true },
      },
    ]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElementEditError)
    expect((error as ElementEditError).code).toBe('invalid_input')
  })

  it('escapes the replacement when html is not set', async () => {
    const frame = seedFrame(TEXT_FIXTURE)
    const { html } = await updateElements(frame, [
      { selector: '#markup', text_replace: { old_str: 'ticket', new_str: '<strong>ticket</strong>' } },
    ])
    expect(html).toContain('Buy the &lt;strong&gt;ticket&lt;/strong&gt; now.')
  })
})

describe.skipIf(!browser)('reading element text', () => {
  it('says when the text was clipped, and returns all of it on request', async () => {
    const words = Array.from({ length: 200 }, (_, n) => `word${n}`).join(' ')
    const frame = seedFrame(
      `<!doctype html><html><head></head><body><p id="long">${words}</p><p id="short">brief</p></body></html>`,
    )
    const clipped = await getElement(frame, '#long')
    expect(clipped.text).toHaveLength(400)
    expect(clipped.text_truncated).toBe(true)

    const whole = await getElement(frame, '#long', { full_text: true })
    expect(whole.text).toBe(words)
    expect(whole.text_truncated).toBeUndefined()

    const short = await getElement(frame, '#short')
    expect(short.text_truncated).toBeUndefined()
  })

  it('reports the clipped text through the tool as well', async () => {
    const words = Array.from({ length: 200 }, (_, n) => `word${n}`).join(' ')
    seedFrame(`<!doctype html><html><head></head><body><p id="long">${words}</p></body></html>`)
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_element', {
        canvas_id: CANVAS_ID,
        frame_id: 'f-element',
        selector: '#long',
        agent_name: 'Claude',
      })
      expect(isError).toBeFalsy()
      expect(parsed.text_truncated).toBe(true)
      expect(parsed.text as unknown as string).toHaveLength(400)
    } finally {
      await close()
    }
  })
})
