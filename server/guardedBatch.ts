/** Execute a batch in priority order, but return results in the caller's
 *  original order. Whenever the guard reports a reason for an operation, that
 *  operation is represented by a skipped result instead of running
 *  speculatively. `stopped` aborts the batch between items — a run a human
 *  stopped must not spend another tool call. */
export async function executeGuardedBatch<T, R>(
  items: readonly T[],
  options: {
    execute: (item: T) => Promise<R>
    blocked: (item: T) => string | undefined
    skipped: (item: T, reason: string) => R
    priority?: (item: T) => number
    stopped?: () => boolean
  },
): Promise<R[]> {
  const order = items.map((item, index) => ({ item, index }))
  const priority = options.priority
  if (priority) {
    order.sort((a, b) => priority(b.item) - priority(a.item) || a.index - b.index)
  }

  const results = new Array<R>(items.length)
  for (const { item, index } of order) {
    if (options.stopped?.()) break
    const reason = options.blocked(item)
    results[index] = reason ? options.skipped(item, reason) : await options.execute(item)
  }
  return results
}
