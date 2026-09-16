import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { store } from '../server/store.ts'
import type { Canvas } from '../shared/types.ts'

/* A multi-page import takes minutes, so the tool hands back a job and the
   capture runs on. The importer is stubbed: what is under test is the job
   contract — return immediately, report per-page results, and land one frame
   per page on the canvas. */

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

const pages = [
  { url: 'https://acme.test/', title: 'Acme' },
  { url: 'https://acme.test/pricing', title: 'Pricing' },
  { url: 'https://acme.test/about', title: 'About' },
]

/** Holds the captures open so a test can prove the tool answered while the
 *  capture was still running. */
let captureGate: { promise: Promise<void>; release: () => void } | null = null

function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

vi.mock('../server/importer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/importer.ts')>()
  return {
    ...actual,
    discoverSitePages: async () => ({ siteUrl: 'https://acme.test/', pages, truncated: false }),
    importPage: async (url: string) => {
      if (captureGate) await captureGate.promise
      if (url.endsWith('/about')) throw new Error('capture failed: 503')
      return {
        title: pages.find((p) => p.url === url)?.title ?? 'Page',
        width: 1200,
        height: 900,
        html: `<!doctype html><html><body><h1>${url}</h1></body></html>`,
      }
    },
  }
})

const { buildMcpServer } = await import('../server/mcp.ts')

const OWNER_ID = 'jobs-owner'
const CANVAS_ID = 'c-jobs'

interface CallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

async function connect(ownerId: string | undefined = OWNER_ID) {
  const server = buildMcpServer('Test Owner', ownerId)
  const client = new Client({ name: 'doop-jobs-test', version: '1.0.0' })
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

/** Wait for the background capture to finish: the job module exposes the
 *  promise it settles on, so the test never guesses at a duration. */
async function settle(jobId: string) {
  const { jobSettled } = await import('../server/jobs.ts')
  const job = await jobSettled(jobId)
  if (!job) throw new Error(`no job ${jobId}`)
  return job
}

beforeEach(() => {
  captureGate = null
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
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Jobs',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: 'p-jobs', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
})

describe('import_site', () => {
  it('returns a job immediately and lands one frame per page', async () => {
    /* the first capture is held open: the tool has to answer while the
       capture is still in flight, not after it finishes */
    captureGate = deferred()
    const { client, close } = await connect()
    try {
      const started = await callTool(client, 'import_site', {
        canvas_id: CANVAS_ID,
        url: 'acme.test',
        max_pages: 3,
        agent_name: 'Claude',
      })
      expect(started.isError).toBeFalsy()
      expect(started.parsed.total).toBe(3)
      /* the response is here while the capture is not: no page has landed */
      expect(store.getCanvas(CANVAS_ID)!.frames).toHaveLength(0)
      expect((started.parsed.pages as unknown as unknown[]).length).toBe(3)
      captureGate.release()
      captureGate = null

      const job = await settle(started.parsed.job_id as unknown as string)
      expect(job.status).toBe('done')
      expect(job.completed).toBe(3)
      /* two pages landed, the third failed and says why */
      expect(job.results.map((r) => r.ok)).toEqual([true, true, false])
      expect(job.results[2]?.detail).toContain('503')

      const canvas = store.getCanvas(CANVAS_ID)!
      expect(canvas.frames.map((f) => f.name).sort()).toEqual(['Acme', 'Pricing'])
      /* the captured frames sit on a page named after the site */
      const sitePage = canvas.pages!.find((page) => page.name === 'acme.test')
      expect(sitePage).toBeDefined()
      expect(canvas.frames.every((f) => f.pageId === sitePage!.id)).toBe(true)
    } finally {
      await close()
    }
  })

  it('reports the job through get_job, and only to the account that started it', async () => {
    const { client, close } = await connect()
    try {
      const started = await callTool(client, 'import_site', {
        canvas_id: CANVAS_ID,
        url: 'acme.test',
        max_pages: 1,
        agent_name: 'Claude',
      })
      const jobId = started.parsed.job_id as unknown as string
      await settle(jobId)

      const mine = await callTool(client, 'get_job', { job_id: jobId })
      expect(mine.parsed.status).toBe('done')
      expect(mine.parsed.completed).toBe(1)

      const other = await connect('someone-else')
      try {
        const theirs = await callTool(other.client, 'get_job', { job_id: jobId })
        expect(theirs.isError).toBe(true)
        expect((theirs.parsed.error as unknown as { code: string }).code).toBe('not_found')
      } finally {
        await other.close()
      }
    } finally {
      await close()
    }
  })

  it('names an unknown job instead of failing obscurely', async () => {
    const { client, close } = await connect()
    try {
      const { parsed, isError } = await callTool(client, 'get_job', { job_id: 'nope' })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { message: string }).message).toContain('30 minutes')
    } finally {
      await close()
    }
  })

  it('refuses a site it cannot read', async () => {
    const importer = await import('../server/importer.ts')
    const spy = vi.spyOn(importer, 'discoverSitePages').mockRejectedValueOnce(new Error('connection refused'))
    const { client, close } = await connect()
    try {
      const { isError, parsed } = await callTool(client, 'import_site', {
        canvas_id: CANVAS_ID,
        url: 'acme.test',
        agent_name: 'Claude',
      })
      expect(isError).toBe(true)
      expect((parsed.error as unknown as { code: string }).code).toBe('upstream_failed')
    } finally {
      spy.mockRestore()
      await close()
    }
  })
})
