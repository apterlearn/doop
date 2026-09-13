/**
 * What a model turn cost, in the unit a human actually budgets in.
 *
 * Providers report tokens, never money, so a dollar figure has to come from a
 * table — and a table is only trustworthy when whoever pays the bill can
 * correct it without waiting for a release. These are the list prices of the
 * models this repo runs: the `AGENT_MODELS` tiers a ChatGPT sign-in or an [OI]
 * key reaches (`server/openaiAgent.ts`), and the Anthropic models the resident
 * agent and the distiller default to. USD per million tokens.
 *
 * `DOOP_MODEL_PRICES` replaces or extends the table at boot — one JSON object
 * of the same shape, keyed by model id or by any substring a model string
 * carries (the run loop records a DISPLAY label like "ChatGPT (gpt-5.6-terra)",
 * not a bare id). Every entry needs all four numbers; a partial one is dropped
 * rather than completed with a guess. Malformed JSON is ignored the same way,
 * so a typo degrades to the built-in prices instead of taking the server down:
 *
 *   DOOP_MODEL_PRICES='{"gpt-5.6-terra":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}}'
 *
 * A model that is in neither table prices as null — never as a guess. An
 * unpriced run reports no cost, which is honest; an invented number would be
 * worse than the tokens it replaced.
 */

/** USD per million tokens, in the four buckets a provider bills. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** What one turn or one run spent, as the provider reported it. */
export interface ModelUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** model id or the display label a run records, e.g. "Doop (…)" */
  model?: string
}

/* cache writes cost 1.25x the input rate and cache reads a tenth of it —
   the ratio every provider here uses, so the four numbers stay consistent */
const BUILT_IN: Record<string, ModelPrice> = {
  'gpt-5.6-sol': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'gpt-5.6-terra': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'gpt-5.6-luna': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

/** One USD figure from the override object: a finite, non-negative number. */
function asUsd(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asPrice(value: unknown): ModelPrice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const input = asUsd(raw.input)
  const output = asUsd(raw.output)
  const cacheRead = asUsd(raw.cacheRead)
  const cacheWrite = asUsd(raw.cacheWrite)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null
  return { input, output, cacheRead, cacheWrite }
}

/** The self-hoster's corrections, or nothing when unset, malformed, or partial. */
function fromEnv(): Record<string, ModelPrice> {
  const raw = process.env.DOOP_MODEL_PRICES
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('[modelPrices] DOOP_MODEL_PRICES is not valid JSON — using the built-in prices')
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const overrides: Record<string, ModelPrice> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const price = asPrice(value)
    if (price) overrides[key.trim().toLowerCase()] = price
  }
  return overrides
}

const PRICES: Record<string, ModelPrice> = { ...BUILT_IN, ...fromEnv() }

/** The price of one model, or null when neither table names it. */
export function priceFor(model: string | undefined): ModelPrice | null {
  const key = model?.trim().toLowerCase()
  if (!key) return null
  const exact = PRICES[key]
  if (exact) return exact
  /* A dated variant ("…-20251001") and a display label both carry the family
     they were built from; the longest match wins, so a future
     "gpt-5.6-terra-mini" entry beats its parent. */
  let best: ModelPrice | null = null
  let bestLength = 0
  for (const [name, price] of Object.entries(PRICES)) {
    if (name.length > bestLength && key.includes(name)) {
      best = price
      bestLength = name.length
    }
  }
  return best
}

/** What this usage cost in USD, or null when the model has no known price. */
export function costOf(usage: ModelUsage): number | null {
  const price = priceFor(usage.model)
  if (!price) return null
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  )
}
