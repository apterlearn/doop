import { once } from 'node:events'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

/**
 * The design-workflow settings routes against the REAL server (see
 * ./harness.ts). The Settings card reads its whole state out of these two
 * routes, so what matters here is the shape it renders from: the pair the user
 * picked, the model list pulled live from the operator's provider, and the
 * fact that an unreachable provider still renders the saved pair instead of
 * blanking the card.
 *
 * The only fake is the provider itself — a two-line HTTP stub, because the
 * alternative is a real third-party endpoint. Everything else (session gate,
 * PGlite row, model fetch) is the deployed code path.
 *
 * 4989/4990 are clear of every other test file's ports; the stub provider and
 * the dead port bind OS-assigned ports, so they can never collide.
 */

const PORT = 4989
const PORT_OFFLINE = 4990

const IMPLEMENTER = 'deepseek-v4.1-flash'
const JUDGE = 'kimi-k3'

/** The provider's list, in the order it sends them. */
const MODELS = [{ id: JUDGE }, { id: IMPLEMENTER }]

/** What the client renders from: prefs first, provider list alongside. */
interface WorkflowView {
  configured: boolean
  implementerModel: string
  judgeModel: string
  models: { id: string }[]
  modelsError?: string
}

let provider: HttpServer
let providerAuth: string | undefined
let server: Server
let offline: Server
let user: Client
let offlineUser: Client

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
}, 120_000)

afterAll(() => {
  server?.stop()
  offline?.stop()
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
