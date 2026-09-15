import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesignLlmError,
  designComplete,
  designLlmConfigured,
  designModelsStatus,
  listDesignModels,
} from '../server/designLlm.ts'

/**
 * The design workflow's provider client. The provider itself is stubbed; every
 * other layer — env gating, URL building, the model-list cache, payload
 * parsing — is the real code path. Each case runs against its own base URL so
 * the 60s list cache can never answer a different case's request.
 */

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A provider that answers every call with `respond`'s response, recording the
 *  calls — so a test can assert both what came back and what went out. */
function stubFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    }
    calls.push(call)
    return respond(call)
  })
  return calls
}

function stubProvider(base: string, key = 'design-secret'): void {
  vi.stubEnv('DESIGN_LLM_BASE_URL', base)
  vi.stubEnv('DESIGN_LLM_API_KEY', key)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('designLlmConfigured', () => {
  it('needs both the endpoint and the key', () => {
    vi.stubEnv('DESIGN_LLM_BASE_URL', '')
    vi.stubEnv('DESIGN_LLM_API_KEY', '')
    expect(designLlmConfigured()).toBe(false)

    vi.stubEnv('DESIGN_LLM_BASE_URL', 'https://provider.example/v1')
    expect(designLlmConfigured()).toBe(false)

    vi.stubEnv('DESIGN_LLM_BASE_URL', '   ')
    vi.stubEnv('DESIGN_LLM_API_KEY', 'design-secret')
    expect(designLlmConfigured()).toBe(false)

    vi.stubEnv('DESIGN_LLM_BASE_URL', 'https://provider.example/v1')
    expect(designLlmConfigured()).toBe(true)
  })

  it('fails a completion before reaching the wire when the endpoint is unset, and calls it permanent', async () => {
    vi.stubEnv('DESIGN_LLM_BASE_URL', '')
    vi.stubEnv('DESIGN_LLM_API_KEY', 'design-secret')
    const calls = stubFetch(() => jsonResponse({}))

    /* Missing configuration is permanent, not transient: no retry conjures an
       env var, and the loop ends a run on a permanent error instead of paying
       for three attempts that fail identically. */
    const noEndpoint = await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 }).catch(
      (thrown: unknown) => thrown,
    )
    expect(noEndpoint).toBeInstanceOf(DesignLlmError)
    expect((noEndpoint as DesignLlmError).permanent).toBe(true)
    expect((noEndpoint as Error).message).toBe('design workflow: DESIGN_LLM_BASE_URL is not set')
    expect(calls).toHaveLength(0)

    vi.stubEnv('DESIGN_LLM_BASE_URL', 'https://provider.example/v1')
    vi.stubEnv('DESIGN_LLM_API_KEY', '  ')
    const noKey = await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 }).catch(
      (thrown: unknown) => thrown,
    )
    expect(noKey).toBeInstanceOf(DesignLlmError)
    expect((noKey as DesignLlmError).permanent).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('listDesignModels', () => {
  it('reads the ids out of the { data: [...] } envelope', async () => {
    stubProvider('https://envelope.example/v1/')
    const calls = stubFetch(() => jsonResponse({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'kimi-k3' }] }))

    expect(await listDesignModels()).toEqual([{ id: 'deepseek-v4.1-flash' }, { id: 'kimi-k3' }])
    /* the trailing slash on the configured base must not double up */
    expect(calls[0]!.url).toBe('https://envelope.example/v1/models')
  })

  it('requests a bare array at {base}/models with the bearer key, dropping rows that name no model', async () => {
    stubProvider('https://bare.example/v1', '  design-secret  ')
    const calls = stubFetch(() =>
      jsonResponse([{ id: 'kimi-k3' }, { id: '  kimi-k3-mini  ' }, { id: '' }, { id: 7 }, {}, 'kimi']),
    )

    expect(await listDesignModels()).toEqual([{ id: 'kimi-k3' }, { id: 'kimi-k3-mini' }])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://bare.example/v1/models')
    expect(calls[0]!.headers.authorization).toBe('Bearer design-secret')
    expect(calls[0]!.headers.accept).toBe('application/json')
  })

  it('surfaces the provider message when the list call is rejected', async () => {
    stubProvider('https://models-down.example/v1')
    stubFetch(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))

    await expect(listDesignModels()).rejects.toThrow('design workflow: invalid api key')
  })

  it('falls back to the status line when the body is not a usable answer', async () => {
    stubProvider('https://models-garbled.example/v1')
    stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }))

    await expect(listDesignModels()).rejects.toThrow(/^design workflow: 502/)
  })

  it('serves a successful list from cache', async () => {
    stubProvider('https://cached.example/v1')
    const calls = stubFetch(() => jsonResponse({ data: [{ id: 'kimi-k3' }] }))

    expect(await listDesignModels()).toEqual([{ id: 'kimi-k3' }])
    expect(await listDesignModels()).toEqual([{ id: 'kimi-k3' }])
    expect(calls).toHaveLength(1)
  })

  it('never caches a failure, so a recovered provider is seen', async () => {
    stubProvider('https://recovering.example/v1')
    let answering = false
    const calls = stubFetch(() =>
      answering
        ? jsonResponse({ data: [{ id: 'kimi-k3' }] })
        : jsonResponse({ error: { message: 'upstream is down' } }, 503),
    )

    await expect(listDesignModels()).rejects.toThrow('design workflow: upstream is down')
    answering = true
    expect(await listDesignModels()).toEqual([{ id: 'kimi-k3' }])
    expect(calls).toHaveLength(2)
  })
})

describe('designModelsStatus', () => {
  it('hands the Settings card the list, with no error, when the provider answers', async () => {
    stubProvider('https://status.example/v1')
    stubFetch(() => jsonResponse({ data: [{ id: 'kimi-k3' }] }))

    expect(await designModelsStatus()).toEqual({ models: [{ id: 'kimi-k3' }] })
  })

  it('reports an unreachable provider instead of throwing', async () => {
    stubProvider('https://status-down.example/v1')
    stubFetch(() => jsonResponse({ error: { message: 'upstream is down' } }, 503))

    expect(await designModelsStatus()).toEqual({ models: [], error: 'design workflow: upstream is down' })
  })
})

describe('designComplete', () => {
  it('sends the chosen model, both messages and the token budget, and returns the reply', async () => {
    stubProvider('https://complete.example/v1/')
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: '<h1>Pricing</h1>' }, finish_reason: 'stop' }] }),
    )

    const reply = await designComplete({
      model: 'deepseek-v4.1-flash',
      system: 'You design frames.',
      prompt: 'a pricing card with three tiers',
      maxTokens: 32_000,
    })

    expect(reply).toEqual({ text: '<h1>Pricing</h1>', truncated: false })
    const call = calls[0]!
    expect(call.url).toBe('https://complete.example/v1/chat/completions')
    expect(call.method).toBe('POST')
    expect(call.headers.authorization).toBe('Bearer design-secret')
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.body).toEqual({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You design frames.' },
        { role: 'user', content: 'a pricing card with three tiers' },
      ],
      max_tokens: 32_000,
    })
  })

  /* a reasoning model stopped at its budget answers with half a document, and
     half a document looks like a document until something parses it — the
     provider's finish_reason is the only thing that says which this is */
  it('reports a reply the provider stopped at the token budget as truncated', async () => {
    stubProvider('https://cutoff.example/v1')
    stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: '<!doctype html><html><head>' }, finish_reason: 'length' }],
      }),
    )

    expect(await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 32_000 })).toEqual({
      text: '<!doctype html><html><head>',
      truncated: true,
    })
  })

  it('treats a reply the provider never labelled as finished', async () => {
    stubProvider('https://nofinish.example/v1')
    stubFetch(() => jsonResponse({ choices: [{ message: { content: '<h1>ok</h1>' } }] }))

    expect(await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 })).toEqual({
      text: '<h1>ok</h1>',
      truncated: false,
    })
  })

  it('refuses a whitespace-only reply rather than writing an empty frame', async () => {
    stubProvider('https://blank.example/v1')
    stubFetch(() => jsonResponse({ choices: [{ message: { content: '   ' } }] }))

    await expect(designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(
      'design workflow: the model returned an empty reply',
    )
  })

  it('refuses a reply with no choices at all', async () => {
    stubProvider('https://choiceless.example/v1')
    stubFetch(() => jsonResponse({}))

    await expect(designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(
      'design workflow: the model returned an empty reply',
    )
  })

  it('surfaces the provider message when the completion is rejected', async () => {
    stubProvider('https://complete-down.example/v1')
    stubFetch(() => jsonResponse({ error: { message: 'unknown model "kimi-k9"' } }, 400))

    await expect(designComplete({ model: 'kimi-k9', system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(
      'design workflow: unknown model "kimi-k9"',
    )
  })

  /* Whether an error is worth another paid attempt is decided here, from the
     provider's own status code, and the loop trusts this flag — so the mapping
     is what the tests pin, not the loop's handling of a hand-built error. */
  describe('what a failure says about retrying', () => {
    const classified = async (status: number): Promise<DesignLlmError> => {
      stubProvider(`https://status-${status}.example/v1`)
      stubFetch(() => jsonResponse({ error: { message: `status ${status}` } }, status))
      const error = await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 }).catch(
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(DesignLlmError)
      return error as DesignLlmError
    }

    it('treats a refused request as permanent: the key, the model, the body', async () => {
      /* the real one: a model this key is not scoped to serve */
      expect((await classified(403)).permanent).toBe(true)
      expect((await classified(400)).permanent).toBe(true)
      expect((await classified(404)).permanent).toBe(true)
    })

    it('treats a bad moment as transient, including the 4xx two that mean try later', async () => {
      expect((await classified(500)).permanent).toBe(false)
      expect((await classified(502)).permanent).toBe(false)
      expect((await classified(503)).permanent).toBe(false)
      expect((await classified(408)).permanent).toBe(false)
      expect((await classified(429)).permanent).toBe(false)
    })

    it('treats a request that never got an answer as transient', async () => {
      stubProvider('https://unreachable.example/v1')
      stubFetch(() => {
        throw new TypeError('fetch failed')
      })

      const error = await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 }).catch(
        (thrown: unknown) => thrown,
      )
      expect(error).toBeInstanceOf(DesignLlmError)
      expect((error as DesignLlmError).permanent).toBe(false)
    })

    it('treats an empty reply as transient, since nothing about the request was wrong', async () => {
      stubProvider('https://empty.example/v1')
      stubFetch(() => jsonResponse({ choices: [{ message: { content: '  ' } }] }))

      const error = await designComplete({ model: 'm', system: 's', prompt: 'p', maxTokens: 10 }).catch(
        (thrown: unknown) => thrown,
      )
      expect((error as DesignLlmError).permanent).toBe(false)
    })
  })
})
