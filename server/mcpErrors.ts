/**
 * Structured tool errors for the MCP surface.
 *
 * Agents branch on `code`, not on prose: a `conflict` is retried after a
 * re-read, a `rate_limited` after a wait, a `forbidden` never. The human
 * message stays verbatim inside the JSON payload so existing readers (and the
 * resident prompt guidance that quotes these strings) keep working.
 */
export type McpErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'invalid_input'
  | 'conflict'
  | 'rate_limited'
  | 'too_large'
  | 'upstream_failed'
  | 'unsupported'
  | 'stopped'
  | 'internal'

export interface McpErrorPayload {
  error: {
    code: McpErrorCode
    message: string
    retryable: boolean
    [key: string]: unknown
  }
}

const RETRYABLE: ReadonlySet<McpErrorCode> = new Set(['rate_limited', 'conflict', 'upstream_failed'])

export function mcpErrorPayload(code: McpErrorCode, message: string, extra?: Record<string, unknown>): McpErrorPayload {
  return { error: { code, message, retryable: RETRYABLE.has(code), ...extra } }
}

/** An `isError` tool result whose single text block is a JSON McpErrorPayload. */
export function err(code: McpErrorCode, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(mcpErrorPayload(code, message, extra), null, 2) }],
    isError: true as const,
  }
}

/** Normalise a caught exception into an error code without losing the message. */
export function codeFor(e: unknown): McpErrorCode {
  if (e instanceof Error && 'code' in e && typeof (e as { code?: unknown }).code === 'string') {
    return (e as { code: McpErrorCode }).code
  }
  return 'upstream_failed'
}

/**
 * A resource read failed. `resources/read` has no result envelope to carry a
 * code, so the code travels inside the thrown message as the same JSON payload
 * a tool would return — one taxonomy for both surfaces.
 */
export class ResourceError extends Error {
  readonly code: McpErrorCode

  constructor(code: McpErrorCode, message: string) {
    super(JSON.stringify(mcpErrorPayload(code, message), null, 2))
    this.name = 'ResourceError'
    this.code = code
  }
}
