import { once } from 'node:events'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The design-workflow routes against the REAL server (see ./harness.ts): the
 * two the Settings card reads its whole state out of, and the brief route the
 * composer starts a run through. What matters here is what each surface
 * renders from — the pair the user picked, the model list pulled live from the
 * operator's provider, an unreachable provider still rendering the saved pair
 * instead of blanking the card, and a brief answered with the run its canvas
 * and the Run tab now hold.
 *
 * The only fake is the provider itself — an HTTP stub serving the model list
 * and the two completions a run makes, because the alternative is a real
 * third-party endpoint. Everything else (session gate, PGlite rows, the
 * engine, the action layer) is the deployed code path.
 *
 * 4989-4992 are clear of every other test file's ports; the stub provider and
 * the dead port bind OS-assigned ports, so they can never collide.
 */

const PORT = 4989
const PORT_OFFLINE = 4990
/** the same server with no endpoint at all: the operator who never set one,
 *  whose brief route has to refuse in the words the card renders */
const PORT_UNCONFIGURED = 4992

const IMPLEMENTER = 'deepseek-v4.1-flash'
const JUDGE = 'kimi-k3'

/** The provider's list, in the order it sends them. */
const MODELS = [{ id: JUDGE }, { id: IMPLEMENTER }]

/** The second account: invited to a canvas as a viewer, so a brief has to be
 *  refused it. */
const VIEWER_EMAIL = 'viewer@test.dev'

/** What the implementer answers a run with: the document the brief route has
 *  to leave on the canvas. */
const DESIGNED_HTML =
  '<!doctype html><html><body><h1>Pricing</h1><p>Three tiers, one clear call to action</p></body></html>'

/** What the judge answers: the one object the engine parses out of the reply. */
function judgeReply(verdict: 'pass' | 'fail', summary: string, issues: string[] = []): string {
  return JSON.stringify({ verdict, summary, issues })
}

/** What the client renders from: prefs first, provider list alongside. */
interface WorkflowView {
  configured: boolean
  implementerModel: string
  judgeModel: string
  models: { id: string }[]
  modelsError?: string
}

/** What a brief run answers with: the run id the caller was told to watch, and
 *  the engine's own report on how it went. */
interface BriefRun {
  runId: string
  ok: boolean
  attempts: number
  frameId: string
  judgeVerdict: 'pass' | 'fail'
  judgeSummary: string
}

let provider: HttpServer
let providerAuth: string | undefined
/** What the provider answers each model with, keyed by the model the request
 *  names — the whole reason one stub can play both parts of a run. */
const replies: Record<string, string> = {}
/** Every completion asked for, in order: what tells a brief refused at the door
 *  from one that spent two model calls getting there. */
const completionCalls: string[] = []
let server: Server
let offline: Server
let unconfigured: Server
let user: Client
let offlineUser: Client
let unconfiguredUser: Client
let viewer: Client

/** A port nothing is listening on: bind one, read it, give it back. */
async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  probe.close()
  await once(probe, 'close')
  return port
}

beforeAll(async () => {
  provider = createServer((req, res) => {
    providerAuth = req.headers.authorization
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: MODELS }))
      return
    }
    /* the engine's two calls: the implementer writes the document the brief
       route was asked for, the judge answers the verdict that ends the run.
       Both are scripted by the test, because a real model is exactly what this
       stub stands in for — and a model with nothing scripted answers 500, so a
       run that reaches one it should not have has failed loudly. */
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const { model } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string }
        const content = model === undefined ? undefined : replies[model]
        if (model !== undefined) completionCalls.push(model)
        if (content === undefined) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `no scripted reply for ${model ?? 'an unnamed model'}` } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'no such route' } }))
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const providerBase = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`

  const auth = { BETTER_AUTH_SECRET: 'test-secret-not-for-real-use' }
  server = await startServer(PORT, {
    ...auth,
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    DESIGN_LLM_BASE_URL: providerBase,
    DESIGN_LLM_API_KEY: 'test-key',
    DOOP_IMPLEMENTER_MODEL: IMPLEMENTER,
    DOOP_JUDGE_MODEL: JUDGE,
  })
  user = await new Client(server).signUp('workflow@test.dev', 'Wanda Workflow')
  viewer = await new Client(server).signUp(VIEWER_EMAIL, 'Vic Viewer')

  /* the same server pointed at nothing: an operator whose provider is down */
  const deadPort = await freePort()
  offline = await startServer(PORT_OFFLINE, {
    ...auth,
    BETTER_AUTH_URL: `http://localhost:${PORT_OFFLINE}`,
    DESIGN_LLM_BASE_URL: `http://127.0.0.1:${deadPort}/v1`,
    DESIGN_LLM_API_KEY: 'test-key',
    DOOP_IMPLEMENTER_MODEL: IMPLEMENTER,
    DOOP_JUDGE_MODEL: JUDGE,
  })
  offlineUser = await new Client(offline).signUp('offline@test.dev', 'Ollie Offline')

  /* and the server that was never pointed anywhere. The endpoint is set to the
     empty string rather than left out: startServer inherits this process's
     environment, and a machine that has one of its own must not quietly
     configure the instance that is supposed to have none. */
  unconfigured = await startServer(PORT_UNCONFIGURED, {
    ...auth,
    BETTER_AUTH_URL: `http://localhost:${PORT_UNCONFIGURED}`,
    DESIGN_LLM_BASE_URL: '',
    DESIGN_LLM_API_KEY: '',
  })
  unconfiguredUser = await new Client(unconfigured).signUp('unconfigured@test.dev', 'Una Unconfigured')
}, 120_000)

afterAll(() => {
  server?.stop()
  offline?.stop()
  unconfigured?.stop()
  provider?.close()
})

it('hands a fresh account the env defaults and the provider model list', async () => {
  const res = await user.get('/api/design-workflow')
  expect(res.status).toBe(200)
  const view = (await res.json()) as WorkflowView
  expect(view).toMatchObject({ configured: true, implementerModel: IMPLEMENTER, judgeModel: JUDGE, models: MODELS })
  expect(view.modelsError).toBeUndefined()
  /* the key is the credential: a provider sees it or refuses the call */
  expect(providerAuth).toBe('Bearer test-key')
}, 30_000)

it('saves the picked pair so it survives the next page load', async () => {
  const saved = await user.patch('/api/design-workflow', { implementerModel: IMPLEMENTER, judgeModel: 'glm-5.3' })
  expect(saved.status).toBe(200)
  expect((await saved.json()) as WorkflowView).toMatchObject({
    implementerModel: IMPLEMENTER,
    judgeModel: 'glm-5.3',
  })

  const reread = (await (await user.get('/api/design-workflow')).json()) as WorkflowView
  expect(reread.implementerModel).toBe(IMPLEMENTER)
  expect(reread.judgeModel).toBe('glm-5.3')
  /* the list still rides along, so the picker stays populated after a save */
  expect(reread.models).toEqual(MODELS)
}, 30_000)

it('refuses an empty pick and leaves the saved pair alone', async () => {
  await user.patch('/api/design-workflow', { implementerModel: IMPLEMENTER, judgeModel: JUDGE })

  for (const body of [{ implementerModel: '', judgeModel: JUDGE }, {}]) {
    const res = await user.patch('/api/design-workflow', body)
    expect(res.status, JSON.stringify(body)).toBe(400)
    const refusal = (await res.json()) as { error?: unknown }
    expect(typeof refusal.error, JSON.stringify(body)).toBe('string')
  }

  const kept = (await (await user.get('/api/design-workflow')).json()) as WorkflowView
  expect(kept.implementerModel).toBe(IMPLEMENTER)
  expect(kept.judgeModel).toBe(JUDGE)
}, 30_000)

it('renders the saved pair when the provider is unreachable', async () => {
  const res = await offlineUser.get('/api/design-workflow')
  expect(res.status).toBe(200)
  const view = (await res.json()) as WorkflowView
  expect(view).toMatchObject({ configured: true, implementerModel: IMPLEMENTER, judgeModel: JUDGE, models: [] })
  expect(view.modelsError).toEqual(expect.any(String))

  /* and the pair can still be changed while it is down */
  const saved = await offlineUser.patch('/api/design-workflow', {
    implementerModel: IMPLEMENTER,
    judgeModel: 'glm-5.3',
  })
  expect(saved.status).toBe(200)

  const reread = (await (await offlineUser.get('/api/design-workflow')).json()) as WorkflowView
  expect(reread.judgeModel).toBe('glm-5.3')
  expect(reread.modelsError).toEqual(expect.any(String))
}, 30_000)

it('requires a session', async () => {
  const res = await fetch(`${server.base}/api/design-workflow`)
  expect(res.status).toBe(401)
  expect((await res.json()) as { error: string }).toMatchObject({ error: 'unauthorized' })
}, 30_000)

/* ------------------------------------------------------------------ */
/* The brief route: the composer's door onto the engine.               */
/* ------------------------------------------------------------------ */

it('runs the brief the owner wrote and answers with the run the canvas now holds', async () => {
  /* the route runs the pair this account picked in Settings, so it is picked
     here first — the run below is the MCP tool's own loop, on the same pair */
  const saved = await user.patch('/api/design-workflow', { implementerModel: IMPLEMENTER, judgeModel: JUDGE })
  expect(saved.status).toBe(200)

  const canvas = (await (await user.post('/api/canvases', { name: 'Brief' })).json()) as { id: string }
  replies[IMPLEMENTER] = DESIGNED_HTML
  replies[JUDGE] = judgeReply('pass', 'three tiers, one clear call to action')
  completionCalls.length = 0

  const res = await user.post(`/api/canvases/${canvas.id}/brief`, { brief: 'a pricing card with three tiers' })
  expect(res.status).toBe(200)
  const run = (await res.json()) as BriefRun

  expect(run.ok).toBe(true)
  expect(run.attempts).toBe(1)
  expect(run.judgeVerdict).toBe('pass')
  expect(run.judgeSummary).toBe('three tiers, one clear call to action')
  expect(run.runId).toEqual(expect.any(String))
  /* both models, in the order the loop runs them: this route is a door onto
     the engine, not a second runtime that answers on its own */
  expect(completionCalls).toEqual([IMPLEMENTER, JUDGE])

  /* the design landed as a frame the canvas really holds, under the engine's
     own name for it */
  const view = (await (await user.get(`/api/canvases/${canvas.id}`)).json()) as {
    frames: { id: string; name: string; html: string }[]
  }
  expect(view.frames.map((frame) => frame.id)).toEqual([run.frameId])
  expect(view.frames[0]?.name).toBe('Design workflow')
  expect(view.frames[0]?.html).toContain('Three tiers, one clear call to action')

  /* and the runId in the answer is the id the engine's lines carry, so the
     caller can watch the run it was just told had finished. The route answers a
     page of them; what sits behind that page is covered in
     tests/runEventsPaging.test.ts, where the rows are waited for. */
  const page = (await (await user.get(`/api/canvases/${canvas.id}/run-events?run_id=${run.runId}`)).json()) as {
    events: { kind: string; summary: string }[]
  }
  expect(page.events.map((event) => `${event.kind}: ${event.summary}`)).toEqual([
    'ended: three tiers, one clear call to action',
    'status: judge reviewing attempt 1',
    'status: implementing attempt 1/3',
  ])
}, 60_000)

it('refuses a brief from a viewer member, before any model is asked', async () => {
  const canvas = (await (await user.post('/api/canvases', { name: 'Read only' })).json()) as { id: string }
  const added = await user.post(`/api/canvases/${canvas.id}/members`, { email: VIEWER_EMAIL, role: 'viewer' })
  expect(added.status, await added.text()).toBe(200)
  replies[IMPLEMENTER] = DESIGNED_HTML
  completionCalls.length = 0

  const res = await viewer.post(`/api/canvases/${canvas.id}/brief`, { brief: 'a pricing card with three tiers' })
  expect(res.status).toBe(403)
  expect((await res.json()) as { error: string }).toMatchObject({
    error: 'this canvas is read-only — ask the owner for edit access',
  })
  /* the refusal is a door, not a bad run: no model was asked and the canvas is
     exactly as the viewer found it */
  expect(completionCalls).toEqual([])
  const view = (await (await user.get(`/api/canvases/${canvas.id}`)).json()) as { frames: unknown[] }
  expect(view.frames).toEqual([])
}, 30_000)

it('refuses a brief on a server with no endpoint, in the off state the card renders', async () => {
  /* the Settings card and the brief box both read this: with no endpoint on
     the server there is nothing to run and nothing to pick */
  const card = (await (await unconfiguredUser.get('/api/design-workflow')).json()) as WorkflowView
  expect(card).toMatchObject({ configured: false, models: [] })

  const canvas = (await (await unconfiguredUser.post('/api/canvases', { name: 'No endpoint' })).json()) as {
    id: string
  }
  const res = await unconfiguredUser.post(`/api/canvases/${canvas.id}/brief`, { brief: 'a pricing card' })
  expect(res.status).toBe(400)
  const refusal = (await res.json()) as { error: string }
  /* the operator's own fix is the actionable part, so the sentence names the
     env var — the same one the card's "Design workflow off" note names */
  expect(refusal.error).toContain('DESIGN_LLM_BASE_URL')
  expect(refusal.error).toContain('not configured')

  /* the refusal is the whole answer: no frame, no run on the timeline */
  const view = (await (await unconfiguredUser.get(`/api/canvases/${canvas.id}`)).json()) as { frames: unknown[] }
  expect(view.frames).toEqual([])
  const page = (await (await unconfiguredUser.get(`/api/canvases/${canvas.id}/run-events`)).json()) as unknown
  expect(page).toEqual({ events: [], has_more: false })
}, 30_000)
