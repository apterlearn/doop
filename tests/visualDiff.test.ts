import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import { compareRgba } from '../server/visualDiff.ts'
import { initDb, closeDb } from '../server/db/index.ts'
import type { Canvas, Frame } from '../shared/types.ts'

/* Visual diff: the pixel accounting is verified directly on RGBA buffers (no
   browser), and the tool end to end against real renders where Chromium exists. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveJournal: () => {},
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

const OWNER_ID = 'diff-owner'
const CANVAS_ID = 'c-diff'

/* The diff image is stored through the real asset pipeline, so this file boots
   the real PGlite database (as the server does) rather than mocking it. */
const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-visual-diff-'))

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-diff-test', version: '1.0.0' })
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
  return { parsed: JSON.parse(raw) as Record<string, never>, raw, content: result.content, isError: result.isError }
}

/** A solid white 100x100 image with a black square of the given size. */
function solidWithBlock(blockSize: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ffffff"/><rect width="${blockSize}" height="${blockSize}" fill="#000000"/></svg>`
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
}

const RGBA = { width: 100, height: 100 }

describe('compareRgba', () => {
  it('counts only the pixels that changed and reports the ratio', async () => {
    const plain = await solidWithBlock(0)
    const withBlock = await solidWithBlock(30)

    const same = await compareRgba({ data: plain, ...RGBA }, { data: Buffer.from(plain), ...RGBA })
    expect(same.identical).toBe(true)
    expect(same.changed_pixels).toBe(0)
    expect(same.changed_ratio).toBe(0)
    expect(same.max_delta).toBe(0)

    const diff = await compareRgba({ data: plain, ...RGBA }, { data: withBlock, ...RGBA })
    expect(diff.identical).toBe(false)
    expect(diff.changed_pixels).toBe(900)
    expect(diff.changed_ratio).toBeCloseTo(0.09, 5)
    expect(diff.max_delta).toBe(255)
    /* the diff image is a real PNG the agent can look at */
    const meta = await sharp(diff.diff_png).metadata()
    expect(meta.format).toBe('png')
    expect([meta.width, meta.height]).toEqual([100, 100])
  })

  it('ignores sub-threshold noise and honours a raised threshold', async () => {
    const left = await solidWithBlock(0)
    /* a 10/255 shift on a 10x10 patch: below the default threshold */
    const right = Buffer.from(left)
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        const offset = (y * 100 + x) * 4
        right[offset] = 245
        right[offset + 1] = 245
        right[offset + 2] = 245
      }
    }
    const quiet = await compareRgba({ data: left, ...RGBA }, { data: right, ...RGBA })
    expect(quiet.identical).toBe(true)
    expect(quiet.max_delta).toBe(10)

    const loud = await compareRgba({ data: left, ...RGBA }, { data: right, ...RGBA }, 5)
    expect(loud.identical).toBe(false)
    expect(loud.changed_pixels).toBe(100)
  })
})

function seedCanvas(htmls: string[]): Frame[] {
  const frames: Frame[] = htmls.map((html, i) => ({
    id: `f-diff-${i}`,
    canvasId: CANVAS_ID,
    name: `Frame ${i}`,
    x: i * 700,
    y: 0,
    width: 400,
    height: 300,
    html,
    createdAt: 0,
    updatedAt: 1 + i,
    updatedBy: 'alice',
    pageId: 'p-diff',
  }))
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Diff',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames,
    pages: [{ id: 'p-diff', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return frames
}

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;background:#fff}</style></head><body>${body}</body></html>`

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

describe.skipIf(!findBrowserPath())('diff_frame over real renders', () => {
  it('reports identical for the same design and a changed ratio for a different one', async () => {
    seedCanvas([
      page('<div style="width:100px;height:100px;background:#000"></div>'),
      page('<div style="width:100px;height:100px;background:#000"></div>'),
      page('<div style="width:200px;height:200px;background:#000"></div>'),
    ])
    const { client, close } = await connect()
    try {
      const identical = await callTool(client, 'diff_frame', {
        frame_id: 'f-diff-0',
        against: { frame_id: 'f-diff-1' },
        agent_name: 'Claude',
      })
      expect(identical.isError).toBeFalsy()
      expect(identical.parsed.identical).toBe(true)
      expect(identical.parsed.changed_pixels).toBe(0)
      expect(identical.parsed.against).toContain('Frame 1')

      const different = await callTool(client, 'diff_frame', {
        frame_id: 'f-diff-0',
        against: { frame_id: 'f-diff-2' },
        agent_name: 'Claude',
      })
      expect(different.parsed.identical).toBe(false)
      /* 100x100 of black vs 200x200: 30000 extra pixels over 400x300 */
      expect(different.parsed.changed_pixels).toBe(30_000)
      expect(different.parsed.changed_ratio).toBeCloseTo(0.25, 3)
      expect(different.parsed.diff_image_url).toMatch(/^https?:\/\/.+\/a\/.+\.png$/)
      /* the marked-up image rides in the result so the agent can see where */
      expect(different.content.some((block) => block.type === 'image' && block.mimeType === 'image/png')).toBe(true)
    } finally {
      await close()
    }
  }, 30_000)

  it('requires exactly one comparison target', async () => {
    seedCanvas([page('<p>a</p>'), page('<p>b</p>')])
    const { client, close } = await connect()
    try {
      const none = await callTool(client, 'diff_frame', {
        frame_id: 'f-diff-0',
        against: {},
        agent_name: 'Claude',
      })
      expect(none.isError).toBe(true)
      expect(none.parsed.error).toMatchObject({ code: 'invalid_input' })

      const both = await callTool(client, 'diff_frame', {
        frame_id: 'f-diff-0',
        against: { frame_id: 'f-diff-1', reference_id: 'r1' },
        agent_name: 'Claude',
      })
      expect(both.isError).toBe(true)
      expect(both.parsed.error).toMatchObject({ code: 'invalid_input' })
    } finally {
      await close()
    }
  }, 30_000)

  it('compares against a pinned Memory reference', async () => {
    const frames = seedCanvas([page('<div style="width:100px;height:100px;background:#000"></div>')])
    const source = frames[0]!
    store.addReference(
      CANVAS_ID,
      { ...source, html: page('<div style="width:300px;height:300px;background:#000"></div>') },
      'alice',
    )
    const ref = store.getReferences(CANVAS_ID)[0]!
    const { client, close } = await connect()
    try {
      const { parsed } = await callTool(client, 'diff_frame', {
        frame_id: source.id,
        against: { reference_id: ref.id },
        agent_name: 'Claude',
      })
      expect(parsed.identical).toBe(false)
      expect(parsed.against).toContain('reference')
    } finally {
      await close()
    }
  }, 30_000)
})
