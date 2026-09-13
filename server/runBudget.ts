/**
 * What a resident run is allowed to spend.
 *
 * Two ceilings, both in tokens — the unit providers actually report:
 *
 *  - `DOOP_RUN_TOKEN_BUDGET` (default 250 000): input + output for ONE run. A
 *    run that crosses it stops at the next turn boundary and hands the card
 *    back with a reason a human can act on, instead of grinding through turns
 *    nobody asked for.
 *  - `DOOP_ACCOUNT_DAILY_TOKENS` (default unset = no cap): everything billed to
 *    one account in a rolling day. Once crossed, new runs for that account are
 *    refused before they start, naming the cap.
 *
 * Money would be the friendlier unit, but nothing in this repo knows a model's
 * price: the providers report tokens, and only some of them report cost. A
 * cap in the unit we can actually measure beats a dollar figure derived from a
 * price table we would have to invent.
 *
 * In-process and per-day on purpose: this is a guard rail for a self-hosted
 * canvas, not a billing ledger. The counters reset when the process restarts,
 * which is the same lifetime every other per-process meter here has.
 */
const DEFAULT_RUN_TOKEN_BUDGET = 250_000

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Tokens one run may spend, input + output, before it stops at a turn boundary. */
export function runTokenBudget(): number {
  return positiveInt(process.env.DOOP_RUN_TOKEN_BUDGET) ?? DEFAULT_RUN_TOKEN_BUDGET
}

/** Tokens one account may spend per day. `undefined` means uncapped. */
export function dailyTokenCap(): number | undefined {
  return positiveInt(process.env.DOOP_ACCOUNT_DAILY_TOKENS)
}

/** Total tokens a turn used, as the budget counts them. */
export function tokensUsed(usage: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

interface Spend {
  day: string
  tokens: number
}

const spent = new Map<string, Spend>()

function today(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** Tokens this account has spent today, as far as this process knows. */
export function spentToday(accountKey: string, now = Date.now()): number {
  const record = spent.get(accountKey)
  if (!record || record.day !== today(now)) return 0
  return record.tokens
}

/** Add a finished run's tokens to the account's day. */
export function recordSpend(accountKey: string, tokens: number, now = Date.now()): number {
  const day = today(now)
  const record = spent.get(accountKey)
  const total = (record && record.day === day ? record.tokens : 0) + Math.max(0, tokens)
  spent.set(accountKey, { day, tokens: total })
  return total
}

/** The cap this account has already crossed, if any — checked before a run
 *  starts so a capped account does not pay for work it cannot finish. */
export function dailyCapReached(accountKey: string, now = Date.now()): { cap: number; spent: number } | undefined {
  const cap = dailyTokenCap()
  if (cap === undefined) return undefined
  const total = spentToday(accountKey, now)
  return total >= cap ? { cap, spent: total } : undefined
}

/** Test-only: forget every counter. */
export function clearSpend(): void {
  spent.clear()
}
