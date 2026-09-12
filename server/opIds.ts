/**
 * Replay-safe creates.
 *
 * A create is not idempotent: an agent whose connection dropped mid-call has
 * no way to know whether the frame landed, and retrying duplicates it. With an
 * `op_id`, the retry returns the first payload instead. Keyed per account, so
 * one agent's ids can never collide with another's.
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

/** Test-only: drop remembered payloads. */
export function clearOpIds(): void {
  payloads.clear()
}
