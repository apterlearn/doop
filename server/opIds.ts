import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Replay-safe writes.
 *
 * A write is not idempotent: an agent whose connection dropped mid-call has no
 * way to know whether the frame landed, and retrying duplicates it (a second
 * frame) or re-applies it (a second edit). With an `op_id`, the retry returns
 * the first result instead of running again. Keyed per account, so one agent's
 * ids can never collide with another's.
 */
const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 1000

const payloads = new Map<string, { payload: object; at: number }>()

function sweep(now: number) {
  for (const [key, entry] of payloads) {
    if (now - entry.at > TTL_MS) payloads.delete(key)
  }
  /* the cap is a backstop for a burst of unique ids, not the normal bound */
  while (payloads.size > MAX_ENTRIES) {
    const oldest = payloads.keys().next().value
    if (oldest === undefined) break
    payloads.delete(oldest)
  }
}

/**
 * Produce the payload for this create, or the one this `op_id` already
 * produced — marked `idempotent_replay` so the caller can tell it did not
 * create anything this time. Without an `op_id` the create always runs.
 */
export function replay<T extends object>(ownerId: string, opId: string | undefined, create: () => T): T {
  if (!opId) return create()
  const key = `${ownerId}::${opId}`
  const now = Date.now()
  sweep(now)
  const hit = payloads.get(key)
  if (hit) return { ...hit.payload, idempotent_replay: true } as T
  const payload = create()
  payloads.set(key, { payload, at: now })
  return payload
}

/** `replay` for a create that has to do async work (fetch, store) first. */
export async function replayAsync<T extends object>(
  ownerId: string,
  opId: string | undefined,
  create: () => Promise<T>,
): Promise<T> {
  if (!opId) return create()
  const key = `${ownerId}::${opId}`
  const now = Date.now()
  sweep(now)
  const hit = payloads.get(key)
  if (hit) return { ...hit.payload, idempotent_replay: true } as T
  const payload = await create()
  payloads.set(key, { payload, at: now })
  return payload
}

/**
 * The same record for every other write: the whole tool result, so a replay is
 * indistinguishable from the call it replays (feedback, focus and session
 * notices are re-attached by the wrapper, which is why the result is stored
 * before they are appended).
 *
 * Cloned both ways. The caller keeps editing the result it returns, so storing
 * the live object would let the first call's notices leak into every replay of
 * it; and a caller that edits a replay must not be able to corrupt the record.
 */
export function remember(ownerId: string, opId: string, result: CallToolResult): void {
  const key = `${ownerId}::${opId}`
  const now = Date.now()
  sweep(now)
  payloads.set(key, { payload: structuredClone(result), at: now })
}

/** The result this `op_id` already produced, or undefined. A fresh copy, so
 *  appending to it cannot reach back into the record. */
export function recall(ownerId: string, opId: string): CallToolResult | undefined {
  const key = `${ownerId}::${opId}`
  const now = Date.now()
  sweep(now)
  const hit = payloads.get(key)
  return hit ? structuredClone(hit.payload as CallToolResult) : undefined
}

/** Test-only: drop remembered payloads. */
export function clearOpIds(): void {
  payloads.clear()
}
