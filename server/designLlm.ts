/**
 * The one [OI]-compatible endpoint the design workflow runs on: an implementer
 * model that writes a frame from a brief, and a judge model that critiques it.
 * The operator configures the endpoint (base URL + key) in the server's
 * environment; WHICH model plays which part is per user, picked in Settings
 * from the list fetched live here.
 *
 * Plain fetch, no SDK: a models list and chat completions are the whole wire,
 * and `imageGen.ts` talks to its provider the same way. Every failure is an
 * Error prefixed `design workflow: ` — the MCP layer turns a throw into
 * `upstream_failed`, so the provider's own words reach the agent.
 */

const MODELS_TIMEOUT_MS = 30_000
/* a frame is a long generation: an image already budgets 120s, and this writes
   a whole document, so the completion timeout is the widest in the server */
const COMPLETION_TIMEOUT_MS = 180_000
/* the Settings card asks for the list whenever it opens; a minute of staleness
   is invisible there and keeps a slow provider off the page's critical path */
const MODELS_TTL_MS = 60_000

interface ErrorBody {
  error?: { message?: unknown }
}

/* Provider payloads are cast, never trusted: every field read out of one goes
   through text(), which turns a missing or wrong-typed field into ''. */
type ModelsPayload = { data?: unknown } | unknown[]

interface CompletionBody extends ErrorBody {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]
}

/** The base URL as configured right now, trailing slashes gone. Read per call,
 *  not at import: the server is long-lived, and an operator fixing the env
 *  should not need a restart for the next call to use it. */
function endpoint(): string {
  const base = (process.env.DESIGN_LLM_BASE_URL ?? '').trim().replace(/\/+$/, '')
  /* Configuration, not a bad night: no retry can conjure the env var, and the
     loop treats a permanent error as the end of the run rather than three paid
     calls that fail identically. */
  if (!base) throw new DesignLlmError('design workflow: DESIGN_LLM_BASE_URL is not set', true)
  return base
}

function apiKey(): string {
  const key = (process.env.DESIGN_LLM_API_KEY ?? '').trim()
  if (!key) throw new DesignLlmError('design workflow: DESIGN_LLM_API_KEY is not set', true)
  return key
}

/** A string field off a provider payload: anything else reads as the empty
 *  string, so callers test one thing instead of a type and a value. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Whether this server can run the design workflow at all. Both values are
 *  needed for either call, so one check answers for the whole feature — an
 *  unconfigured server reports the capability off rather than failing calls. */
export function designLlmConfigured(): boolean {
  return !!process.env.DESIGN_LLM_BASE_URL?.trim() && !!process.env.DESIGN_LLM_API_KEY?.trim()
}

/* One success per endpoint, so reopening Settings does not re-ask. The base
   URL rides along because a list fetched from a different endpoint is not an
   answer to this one. Failures are never stored. */
let modelCache: { base: string; at: number; models: { id: string }[] } | null = null

/** A provider answer the caller can tell apart from a bad night: a model the
 *  key cannot reach, a rejected request — retrying those spends the operator's
 *  money to be told the same thing, while a timeout or a 5xx is worth another
 *  attempt. `permanent` is the difference, and it is the provider's own status
 *  code that decides. */
export class DesignLlmError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message)
    this.name = 'DesignLlmError'
  }
}

/** The provider's own error text when it sent one; a bare status line leaves
 *  the agent guessing at a fix it could have been told. A 4xx is the provider
 *  refusing this request — the key's scope, a model that does not exist, a
 *  malformed body — and no retry changes it. 408 and 429 are the exceptions:
 *  the request was fine and the moment was not. */
function failure(res: Response, body: unknown): Error {
  const detail = text((body as ErrorBody | null)?.error?.message)
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429
  return new DesignLlmError(`design workflow: ${detail || `${res.status} ${res.statusText}`.trim()}`, permanent)
}

/** A fetch that threw rather than answered: a timeout, a refused connection,
 *  a DNS blip. Transient by nature — the same call may well work next time. */
function transportFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new DesignLlmError(`design workflow: ${detail}`, false)
}

/** `GET {base}/models` → the ids to choose from, in the provider's own order.
 *  The answer is either a bare array or the `{ data: [...] }` envelope; a row
 *  that names no model is dropped, because a nameless option in the Settings
 *  dropdown is worse than a missing one. Throws with the provider's text —
 *  designModelsStatus is the never-throwing form the UI uses. */
export async function listDesignModels(): Promise<{ id: string }[]> {
  const base = endpoint()
  const authorization = `Bearer ${apiKey()}`
  const cached = modelCache
  if (cached && cached.base === base && Date.now() - cached.at < MODELS_TTL_MS) return cached.models
  const res = await fetch(`${base}/models`, {
    headers: { authorization, accept: 'application/json' },
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  }).catch((error: unknown): never => {
    throw transportFailure(error)
  })
  const body = (await res.json().catch(() => null)) as ModelsPayload | null
  if (!res.ok) throw failure(res, body)
  const rows = Array.isArray(body) ? body : body?.data
  if (!Array.isArray(rows)) throw failure(res, body)
  const models = rows.flatMap((row) => {
    const id = text((row as { id?: unknown } | null)?.id)
    return id ? [{ id }] : []
  })
  modelCache = { base, at: Date.now(), models }
  return models
}

/** The model list for the Settings card: never throws, because a provider that
 *  is down must still render the card — with the user's saved choice and a
 *  line saying why the dropdown is empty. */
export async function designModelsStatus(): Promise<{ models: { id: string }[]; error?: string }> {
  try {
    return { models: await listDesignModels() }
  } catch (err) {
    return { models: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** One chat completion. `model` is the caller's per-user choice, and the reply
 *  is its raw text plus whether the provider stopped it at the budget:
 *  `truncated` is the difference between a design and half of one, and the
 *  caller cannot recover it from the text alone — a document cut mid-element
 *  looks like a document until something parses it. */
export async function designComplete(input: {
  model: string
  system: string
  prompt: string
  maxTokens: number
}): Promise<{ text: string; truncated: boolean }> {
  const base = endpoint()
  const authorization = `Bearer ${apiKey()}`
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      max_tokens: input.maxTokens,
    }),
    signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
  }).catch((error: unknown): never => {
    throw transportFailure(error)
  })
  const body = (await res.json().catch(() => null)) as CompletionBody | null
  if (!res.ok) throw failure(res, body)
  const choice = body?.choices?.[0]
  const content = text(choice?.message?.content)
  /* a provider can answer 200 with nothing in it — a filter, a cut-off stream;
     an empty string would silently become an empty frame. Nothing about the
     request was wrong, so this is worth another attempt. */
  if (!content) throw new DesignLlmError('design workflow: the model returned an empty reply', false)
  /* 'length' is the provider saying it stopped at the token budget. Anything
     else (stop, tool_calls, a provider that omits it) is a finished reply. */
  return { text: content, truncated: choice?.finish_reason === 'length' }
}
