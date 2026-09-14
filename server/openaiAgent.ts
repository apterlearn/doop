import type { ModelAccount } from './modelAccounts.ts'

/**
 * The model catalogue a connected account picks from. Doop runs no agent of its
 * own, so nothing here calls a provider: this is the menu the account picker in
 * Settings renders (`/api/model-accounts` serves it) and the set the account
 * routes validate a stored tier against.
 */

/**
 * The GPT-5.6 tiers, which a ChatGPT sign-in and an API key can both reach.
 * Users pick one in Settings — they are paying for it, and the tiers trade
 * real money against real quality — so this list is the menu, not a detail.
 * Ordered best-first; the default is the middle one.
 */
export const AGENT_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', blurb: 'Flagship — the most detail and polish, and the priciest' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', blurb: 'The everyday workhorse. A good default for design work' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', blurb: 'Fastest and cheapest — fine for small, mechanical edits' },
] as const

export const DEFAULT_OPENAI_MODEL = process.env.DOOP_AGENT_OPENAI_MODEL || 'gpt-5.6-terra'

export function isKnownModel(id: string): boolean {
  return AGENT_MODELS.some((model) => model.id === id)
}

/** What this account runs on: the user's choice, else the server default. */
export function modelFor(account: Pick<ModelAccount, 'model'>): string {
  return account.model || DEFAULT_OPENAI_MODEL
}
