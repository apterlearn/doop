/**
 * Per-tool MCP telemetry.
 *
 * In-process only: the MCP endpoint is stateless per request, and the numbers
 * exist to answer "which tools do agents actually use, and which fail" — for
 * the admin surface and one throttled analytics event, not for billing.
 */
import type { McpErrorCode } from './mcpErrors.ts'

export interface ToolStats {
  name: string
  calls: number
  errors: number
  p50: number
  p95: number
}

interface Counter {
  calls: number
  errors: number
  /** Bounded ring of recent latencies (ms) — enough for a stable p95 without
   *  unbounded growth on a long-lived server. */
  latencies: number[]
  lastCode?: McpErrorCode
}

const MAX_SAMPLES = 256
const started = Date.now()
const counters = new Map<string, Counter>()

export function recordToolCall(name: string, ok: boolean, ms: number, code?: McpErrorCode): void {
  let c = counters.get(name)
  if (!c) {
    c = { calls: 0, errors: 0, latencies: [] }
    counters.set(name, c)
  }
  c.calls += 1
  if (!ok) {
    c.errors += 1
    if (code) c.lastCode = code
  }
  c.latencies.push(ms)
  if (c.latencies.length > MAX_SAMPLES) c.latencies.splice(0, c.latencies.length - MAX_SAMPLES)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

export function getStats(): { tools: ToolStats[]; since: number } {
  const tools: ToolStats[] = []
  for (const [name, c] of counters) {
    const sorted = [...c.latencies].sort((a, b) => a - b)
    tools.push({
      name,
      calls: c.calls,
      errors: c.errors,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
    })
  }
  tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
  return { tools, since: started }
}
