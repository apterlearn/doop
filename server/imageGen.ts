import { getAccount } from './modelAccounts.ts'
import type { ModelAccount } from './modelAccounts.ts'

/**
 * Image generation for design agents: the provider behind the generate_image
 * tool in mcp.ts. Search (server/imageSearch.ts) finds a photo
 * that already exists; this makes one that does not.
 *
 * The credential comes from the same place a model turn's does: the caller's
 * own connected account first, this server's key second. A connected
 * ChatGPT subscription is deliberately NOT a credential here — that token is
 * scoped to the Codex backend, and the Images API only answers a plain
 * api.openai.com key (the `openai-key` account kind) or the server's own
 * OPENAI_API_KEY.
 *
 * gpt-image-1 always answers with base64 PNG, so no image re-encoding happens
 * on this path (that is why `sharp` is not involved). The request shape is
 * gpt-image's — `output_format`, `n`, and references through /images/edits —
 * so DOOP_IMAGE_MODEL must name a gpt-image model.
 */

const IMAGES_URL = process.env.OPENAI_IMAGES_URL || 'https://api.openai.com/v1/images/generations'
const IMAGE_EDITS_URL = process.env.OPENAI_IMAGE_EDITS_URL || 'https://api.openai.com/v1/images/edits'
const IMAGE_MODEL = process.env.DOOP_IMAGE_MODEL || 'gpt-image-1'
/* generation is slower than any other call this server makes: a 1024px image
   is tens of seconds, and a batch of four is minutes */
const FETCH_TIMEOUT_MS = 120_000
const MAX_COUNT = 4
const MAX_REFERENCES = 3

export type ImageSize = '1024x1024' | '1536x1024' | '1024x1536'

const SIZES: readonly string[] = ['1024x1024', '1536x1024', '1024x1536'] satisfies ImageSize[]

/** What generateImage throws when nothing can pay for the call. The MCP layer
 *  turns this into `unsupported`, so the wording names both ways to fix it. */
export const IMAGE_NOT_CONFIGURED =
  'image generation is not configured — connect an [OI] API key in Settings, or set OPENAI_API_KEY on the server'

/** The credential one call runs on: the caller's connected key, or the
 *  server's own. */
export interface ImageCredential {
  apiKey: string
  /** whose bill it lands on, for the caller's report */
  source: 'account' | 'server'
}

/** Whether THIS SERVER can generate images at all. A per-caller connected
 *  account is resolved inside generateImage, so this is the capability to
 *  report, not the final answer for a particular agent. */
export function imageProvider(): 'openai' | 'none' {
  return process.env.OPENAI_API_KEY ? 'openai' : 'none'
}

/**
 * Resolve the credential for one caller. A connected account wins outright:
 * someone who has just linked their own key expects the very next call to run
 * on it. Only the `openai-key` kind is usable — a ChatGPT OAuth token is not
 * accepted by the Images API — and the server key is the fallback, not the
 * default.
 */
export async function resolveImageCredential(payerId?: string): Promise<ImageCredential | null> {
  if (payerId) {
    const account: ModelAccount | null = await getAccount(payerId).catch((err) => {
      console.error('[doop-image] could not read the connected model account', err)
      return null
    })
    if (account?.kind === 'openai-key' && account.apiKey) return { apiKey: account.apiKey, source: 'account' }
  }
  const key = process.env.OPENAI_API_KEY
  return key ? { apiKey: key, source: 'server' } : null
}

interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[]
  error?: { message?: string }
}

/** Read the provider's own error text when it sent one; a bare status line
 *  leaves the agent guessing at a fix it could have been told. */
async function failure(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as ImagesResponse | null
  const detail = body?.error?.message
  return new Error(`image generation failed: ${detail ? `${detail} (HTTP ${res.status})` : `HTTP ${res.status}`}`)
}

/** Build the multipart body for /images/edits, where references ride along. */
function formBody(input: { prompt: string; size: ImageSize; count: number; references: Buffer[] }): FormData {
  const form = new FormData()
  form.set('model', IMAGE_MODEL)
  form.set('prompt', input.prompt)
  form.set('size', input.size)
  form.set('n', String(input.count))
  form.set('output_format', 'png')
  /* keeps a supplied reference recognisable instead of merely similar */
  if (IMAGE_MODEL.startsWith('gpt-image')) form.set('input_fidelity', 'high')
  input.references.forEach((buf, i) => {
    form.append('image[]', new Blob([new Uint8Array(buf)], { type: 'image/png' }), `reference-${i + 1}.png`)
  })
  return form
}

/** Whatever the response carries, hand back PNG bytes. gpt-image answers with
 *  b64_json PNG; a URL only appears for a non-gpt-image model, and that image
 *  is fetched and accepted only when it really is a PNG. */
async function toPng(datum: { b64_json?: string; url?: string }): Promise<Buffer> {
  if (datum.b64_json) return Buffer.from(datum.b64_json, 'base64')
  if (!datum.url) throw new Error('the image provider returned no image')
  const res = await fetch(datum.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`could not fetch the generated image: HTTP ${res.status}`)
  const mime = res.headers.get('content-type')?.split(';')[0] || ''
  if (mime !== 'image/png') throw new Error(`the image provider returned ${mime || 'an unknown type'}, not PNG`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Generate images for a prompt. `referenceImages` are sent as image inputs
 * when the model has an edits path and ignored otherwise; `style` is folded
 * into the prompt because gpt-image-1 has no style field. `payerId` picks the
 * credential: their connected key, else the server's.
 */
export async function generateImage(input: {
  prompt: string
  size: ImageSize
  count: number
  style?: string
  referenceImages?: Buffer[]
  /** the human whose bill the result lands on; omit for the server key */
  payerId?: string
}): Promise<{ png: Buffer }[]> {
  if (!SIZES.includes(input.size)) {
    throw new Error(`unsupported image size "${input.size}" — use one of ${SIZES.join(', ')}`)
  }
  const credential = await resolveImageCredential(input.payerId)
  if (!credential) throw new Error(IMAGE_NOT_CONFIGURED)
  const count = Math.max(1, Math.min(Math.trunc(input.count), MAX_COUNT))
  const prompt = input.style ? `${input.prompt}\n\nStyle: ${input.style}` : input.prompt
  /* a reference only reaches the provider on an edits-capable model: dall-e-3
     has no /images/edits path, so references are dropped there rather than
     failing the call */
  const references = IMAGE_MODEL.startsWith('dall-e') ? [] : (input.referenceImages ?? []).slice(0, MAX_REFERENCES)
  const headers = { authorization: `Bearer ${credential.apiKey}` }
  const res = references.length
    ? await fetch(IMAGE_EDITS_URL, {
        method: 'POST',
        headers,
        body: formBody({ prompt, size: input.size, count, references }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    : await fetch(IMAGES_URL, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: input.size, n: count, output_format: 'png' }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
  if (!res.ok) throw await failure(res)
  const body = (await res.json()) as ImagesResponse
  const images = await Promise.all((body.data ?? []).map(toPng))
  if (images.length === 0) throw new Error('the image provider returned no image')
  return images.map((png) => ({ png }))
}
