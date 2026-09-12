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
import { initDb, closeDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { AgentPlan, CanvasView, FrameSummary, FrameVersion } from '../shared/types.ts'

/* The whole agent loop, end to end, over one MCP connection:
   read the guide → define the canvas → plan → build → measure → fix → verify →
   revert → diff → batch → export → close out the plan.
   This is the acceptance proof for the surface, so it runs against the real
   store, the real database and a real browser — nothing is stubbed except the
   model, which is not part of this loop. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-agent-loop-'))
const OWNER_ID = 'loop-owner'
const OWNER = 'Loop Owner'

/* A real hero: one heading, one call to action, and every value on the canvas
   tokens — except the heading's colour, which is the deliberate contrast bug
   the loop has to find and fix. */
const LOW_CONTRAST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: system-ui; background: #ffffff; color: #111110; }
  h1 { color: #777777; font-size: 16px; font-weight: 400; margin: 0; padding: 16px; }
  a { display: inline-block; color: #111110; padding: 16px; }
</style></head><body><main><h1>Quarterly revenue</h1><a href="#report">See the report</a></main></body></html>`

const FIXED = LOW_CONTRAST.replace('color: #777777;', 'color: #111110;')

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
}, 60_000)

afterAll(async () => {
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
}, 60_000)

interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

async function connect() {
  const server = buildMcpServer(OWNER, OWNER_ID)
  const client = new Client({ name: 'doop-agent-loop', version: '1.0.0' })
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

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as CallResult
}

/** The JSON payload of a result, whether it arrived structured or as text. */
function payload<T>(result: CallResult): T {
  if (result.structuredContent) return result.structuredContent as T
  const text = result.content.find((block) => block.type === 'text')?.text ?? ''
  return JSON.parse(text) as T
}

/** The tool's own error payload, if the call failed. */
function failure(result: CallResult): { error: { code: string; message: string; [k: string]: unknown } } | undefined {
  if (!result.isError) return undefined
  const text = result.content.find((block) => block.type === 'text')?.text ?? ''
  try {
    return JSON.parse(text) as { error: { code: string; message: string } }
  } catch {
    return { error: { code: 'internal', message: text } }
  }
}

function textOf(result: CallResult): string {
  return result.content.find((block) => block.type === 'text')?.text ?? ''
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

describe.skipIf(!findBrowserPath())('the agent design loop, end to end', () => {
  it('reads, plans, builds, measures, fixes, reverts, diffs, batches and exports', async () => {
    const { client, close } = await connect()
    try {
      /* ---- 1. the agent learns the workflow ---- */
      const guide = await call(client, 'get_guide', { topic: 'doop-instructions' })
      expect(textOf(guide)).toContain('Review checkpoints')
      expect(textOf(guide)).toContain('set_plan')

      /* ---- 2. a canvas and its design system ---- */
      const created = await call(client, 'create_canvas', { name: 'Q3 dashboard', op_id: 'canvas-1' })
      const canvasId = payload<{ id: string }>(created).id
      expect(failure(created)).toBeUndefined()

      const empty = payload<CanvasView>(await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' }))
      expect(empty.frames).toHaveLength(0)
      expect(empty.pages).toHaveLength(1)
      expect(empty.tokens_present).toBe(false)

      const tokens = payload<{ css: string }>(
        await call(client, 'set_tokens', {
          canvas_id: canvasId,
          tokens: { colors: { ink: '#111110' }, fonts: { body: 'system-ui' }, spacing: [16] },
          agent_name: 'Claude',
        }),
      )
      expect(tokens.css).toContain('--color-ink: #111110;')
      expect(
        payload<CanvasView>(await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' })).tokens_present,
      ).toBe(true)

      /* ---- 3. publish a plan, then start it ---- */
      const plan = payload<{ plan: AgentPlan }>(
        await call(client, 'set_plan', {
          canvas_id: canvasId,
          steps: [
            { id: 'hero', text: 'Build the hero' },
            { id: 'check', text: 'Audit and fix accessibility' },
            { id: 'ship', text: 'Export the result' },
          ],
          agent_name: 'Claude',
        }),
      ).plan
      expect(plan.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending'])
      const active = payload<{ plan: AgentPlan }>(
        await call(client, 'update_plan_step', {
          canvas_id: canvasId,
          step_id: 'hero',
          status: 'active',
          agent_name: 'Claude',
        }),
      ).plan
      expect(active.steps[0]!.status).toBe('active')

      /* ---- 4. build the hero ---- */
      const hero = payload<{ frame: FrameSummary }>(
        await call(client, 'create_frame', {
          canvas_id: canvasId,
          name: 'Hero',
          html: LOW_CONTRAST,
          width: 1280,
          height: 800,
          op_id: 'hero-1',
          agent_name: 'Claude',
        }),
      ).frame
      expect(hero.id).toBeTruthy()

      /* a retry of the same create is not a second frame */
      const replay = payload<{ frame: FrameSummary; idempotent_replay?: boolean }>(
        await call(client, 'create_frame', {
          canvas_id: canvasId,
          name: 'Hero',
          html: LOW_CONTRAST,
          width: 1280,
          height: 800,
          op_id: 'hero-1',
          agent_name: 'Claude',
        }),
      )
      expect(replay.idempotent_replay).toBe(true)
      expect(replay.frame.id).toBe(hero.id)
      expect(store.getCanvas(canvasId)!.frames).toHaveLength(1)

      /* ---- 5. measure it instead of eyeballing it ---- */
      const audit = payload<{ counts: { critical: number }; issues: { rule: string; selector: string; value?: string }[] }>(
        await call(client, 'audit_frame', { frame_id: hero.id, agent_name: 'Claude' }),
      )
      expect(audit.counts.critical).toBeGreaterThanOrEqual(1)
      const contrast = audit.issues.find((i) => i.rule === 'contrast')!
      expect(contrast.value).toBe('4.48')
      expect(contrast.selector).toContain('h1')

      /* ---- 6. fix the measured problem ---- */
      const fixed = await call(client, 'edit_frame_html', {
        frame_id: hero.id,
        old_str: 'color: #777777;',
        new_str: 'color: #111110;',
        agent_name: 'Claude',
      })
      expect(failure(fixed)).toBeUndefined()

      const clean = payload<{ counts: { critical: number }; issues: unknown[] }>(
        await call(client, 'audit_frame', { frame_id: hero.id, agent_name: 'Claude' }),
      )
      expect(clean.counts.critical).toBe(0)
      expect(clean.issues).toEqual([])

      /* ---- 7. and it conforms to the canvas tokens ---- */
      const lint = payload<{ tokens_present: boolean; violations: unknown[] }>(
        await call(client, 'lint_frame', { frame_id: hero.id, agent_name: 'Claude' }),
      )
      expect(lint.tokens_present).toBe(true)
      expect(lint.violations).toEqual([])

      /* ---- 8. see it at a phone width ---- */
      const mobile = await call(client, 'get_frame_screenshot', {
        frame_id: hero.id,
        device: 'mobile',
        agent_name: 'Claude',
      })
      const image = mobile.content.find((block) => block.type === 'image')!
      const meta = await sharp(Buffer.from(image.data!, 'base64')).metadata()
      expect([meta.width, meta.height]).toEqual([390, 844])

      /* ---- 9. a stale write is refused, the retry lands ---- */
      const read = payload<{ updatedAt: string }>(await call(client, 'get_frame', { frame_id: hero.id, agent_name: 'Claude' }))
      actions.updateFrame(hero.id, { html: FIXED }, actions.resolveActor({ name: 'alice', kind: 'user' }))
      const stale = await call(client, 'set_frame_html', {
        frame_id: hero.id,
        html: LOW_CONTRAST,
        expected_updated_at: read.updatedAt,
        agent_name: 'Claude',
      })
      expect(failure(stale)?.error.code).toBe('conflict')
      expect(store.getFrame(hero.id)!.html).toBe(FIXED)

      /* ---- 10. history and revert ---- */
      const fresh = payload<{ updatedAt: string }>(
        await call(client, 'get_frame', { frame_id: hero.id, agent_name: 'Claude' }),
      )
      await call(client, 'set_frame_html', {
        frame_id: hero.id,
        html: LOW_CONTRAST,
        expected_updated_at: fresh.updatedAt,
        agent_name: 'Claude',
      })
      expect(store.getFrame(hero.id)!.html).toBe(LOW_CONTRAST)

      const history = await waitForVersions(hero.id, 2)
      const oldest = history[history.length - 1]!
      const reverted = await call(client, 'revert_frame', {
        frame_id: hero.id,
        version_id: oldest.id,
        agent_name: 'Claude',
      })
      expect(failure(reverted)).toBeUndefined()
      expect(store.getFrame(hero.id)!.html).toBe(oldest.html)

      /* ---- 11. diff against a saved version ---- */
      const diff = payload<{ identical: boolean; against: string; diff_image_url: string }>(
        await call(client, 'diff_frame', {
          frame_id: hero.id,
          against: { version_id: oldest.id },
          agent_name: 'Claude',
        }),
      )
      expect(diff.identical).toBe(true)
      expect(diff.against).toContain('version')
      expect(diff.diff_image_url).toMatch(/\/a\/.+\.png$/)

      /* ---- 12. batch the rest of the flow ---- */
      const batch = payload<{ applied: number; failed: number; results: { ok: boolean }[] }>(
        await call(client, 'apply_ops', {
          canvas_id: canvasId,
          ops: [
            { op: 'create_frame', name: 'Pricing', html: FIXED, width: 1280, height: 800, agent_name: 'Claude' },
            { op: 'create_frame', name: 'Checkout', html: FIXED, width: 1280, height: 800, agent_name: 'Claude' },
            { op: 'set_status', status: 'Three frames drafted', agent_name: 'Claude' },
          ],
          agent_name: 'Claude',
        }),
      )
      expect(batch.applied).toBe(3)
      expect(batch.failed).toBe(0)
      expect(batch.results.every((r) => r.ok)).toBe(true)

      /* ---- 13. the canvas is readable at scale, and paged ---- */
      const list = payload<{ frames: FrameSummary[]; total: number; has_more: boolean }>(
        await call(client, 'list_frames', { canvas_id: canvasId, limit: 2, agent_name: 'Claude' }),
      )
      expect(list.frames).toHaveLength(2)
      expect(list.total).toBe(3)
      expect(list.has_more).toBe(true)
      const page2 = payload<{ frames: FrameSummary[]; has_more: boolean }>(
        await call(client, 'list_frames', { canvas_id: canvasId, limit: 2, offset: 2, agent_name: 'Claude' }),
      )
      expect(page2.frames).toHaveLength(1)
      expect(page2.has_more).toBe(false)

      /* ---- 14. hand it off as code ---- */
      const react = payload<{ component_name: string; jsx: string; css: string; tokens_css: string }>(
        await call(client, 'export_frame', { frame_id: hero.id, format: 'react', agent_name: 'Claude' }),
      )
      expect(react.component_name).toBe('Hero')
      expect(react.jsx).toContain('export function Hero()')
      expect(react.tokens_css).toContain('--color-ink: #111110;')

      const bundle = payload<{ frames: { id: string }[]; html?: string }>(
        await call(client, 'export_canvas', { canvas_id: canvasId, format: 'html', agent_name: 'Claude' }),
      )
      expect(bundle.frames).toHaveLength(3)
      expect(bundle.html).toContain('data-frame=')

      /* ---- 15. close the plan out ---- */
      for (const id of ['hero', 'check', 'ship']) {
        await call(client, 'update_plan_step', {
          canvas_id: canvasId,
          step_id: id,
          status: 'done',
          agent_name: 'Claude',
        })
      }
      const final = payload<{ plans: AgentPlan[] }>(await call(client, 'get_plan', { canvas_id: canvasId }))
      expect(final.plans).toHaveLength(1)
      expect(final.plans[0]!.steps.every((s) => s.status === 'done')).toBe(true)

      /* ---- the canvas is exactly what the loop left behind ---- */
      const view = payload<CanvasView>(await call(client, 'get_canvas', { canvas_id: canvasId, agent_name: 'Claude' }))
      expect(view.frame_total).toBe(3)
      expect(view.tokens_present).toBe(true)
    } finally {
      await close()
    }
  }, 180_000)
})

/** Persistence is fire-and-forget, so wait for the rows rather than a delay. */
async function waitForVersions(frameId: string, count: number): Promise<FrameVersion[]> {
  const deadline = Date.now() + 5000
  for (;;) {
    const rows = await persist.listFrameVersions(frameId, 50)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) throw new Error(`only ${rows.length} version(s) for ${frameId}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
