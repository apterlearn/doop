/**
 * Which MCP tools a server instance exposes.
 *
 * One all-or-nothing toolset forces a reviewer or a monitoring agent to be
 * handed write access it should never have, so the surface is filtered two
 * ways, both read once at module load:
 *
 *  - DOOP_MCP_DENY_TOOLS removes named tools outright, read-only or not.
 *  - The read-only surface (the /mcp/readonly endpoint, and
 *    DOOP_MCP_READONLY_TOOLS for the main one) registers only tools that
 *    declare `readOnlyHint`. A disabled tool is never registered at all, so it
 *    cannot appear in `tools/list` — the boundary is the registration, not a
 *    hint a client could ignore.
 *
 * A tool that must stay reachable on the read-only surface even though it is
 * not marked read-only (a write-free tool that nonetheless changes state)
 * belongs in DOOP_MCP_READONLY_TOOLS.
 */

export interface ToolPolicy {
  /** kept on the read-only surface even though the tool does not declare readOnlyHint */
  allow: Set<string>
  /** never registered, whatever the surface */
  deny: Set<string>
}

/** Comma-separated names, trimmed; empty entries dropped. */
function parseToolList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
}

export function parseToolPolicy(env: NodeJS.ProcessEnv): ToolPolicy {
  return {
    allow: parseToolList(env.DOOP_MCP_READONLY_TOOLS),
    deny: parseToolList(env.DOOP_MCP_DENY_TOOLS),
  }
}

/** The policy for this process, parsed once like RESIDENT_TASK_LIMIT. */
export const TOOL_POLICY: ToolPolicy = parseToolPolicy(process.env)

/**
 * Whether a tool is registered at all. `deny` always wins; on the read-only
 * surface a tool is kept only when it declares itself read-only, or is
 * explicitly allow-listed there.
 */
export function toolEnabled(
  name: string,
  policy: ToolPolicy,
  opts: { readonly: boolean; readOnlyHint?: boolean },
): boolean {
  if (policy.deny.has(name)) return false
  if (!opts.readonly) return true
  return opts.readOnlyHint === true || policy.allow.has(name)
}
