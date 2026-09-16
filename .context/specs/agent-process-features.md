# The agentic design process — must-have features

Scope: the human↔agent design loop only — what a person and an MCP agent need, end to end, to
design on one canvas together. Every entry below is derived from a gap verified against the
current surface (`server/mcp.ts`, 138 tools), not from a wish list; each names its evidence and
the acceptance that would close it.

Order is priority: P0 (trust floor — nothing else can be relied on first), P1 (complete the loop
without an external MCP client), P2 (supervision reliability).

## F1. Intent-enforced MCP authorization — P0

### Gap (evidence)

Every MCP tool resolves its canvas and frame through `canvasFor` / `frameFor` / `pageForId`
(server/mcp.ts:1244-1263), which gate on `canAccessCanvas` (server/access.ts:111-113) — reach, not
intent. `canvasAccess` (server/access.ts:96-107) returns `view` for a viewer-role member and for a
live view share link; those callers reach the canvas, so the MCP tools fire. `intentAtLeast`
(server/access.ts:29-31) is consulted by REST and auth only and never appears in server/mcp.ts, so
a viewer or commenter token can call `set_frame_html` and the write lands, subject only to review
mode and frame locks.

### Decision

Writes require `intentAtLeast(intent, 'edit')` and comment-writing tools require `'comment'`;
reads stay reach-gated. Enforce centrally in the `tool()` wrapper's write path (the
`MUTATING_TOOLS` set, server/mcp.ts:657-745) so no individual handler can forget; the wrapper
already resolves session context there. A refusal is the structured `forbidden` error naming the
intent the caller holds and the one the tool needs. `/mcp/readonly` is unaffected — it registers
no writes at all.

### Acceptance

With a viewer-role member's OAuth token: `get_canvas` succeeds and `set_frame_html` returns
`forbidden`. With a commenter's: `add_comment` succeeds and `set_frame_html` returns `forbidden`.
New test `tests/mcpIntent.test.ts` pins both directions plus an owner write still landing.

### Touches

`server/mcp.ts`, `server/access.ts` (reuse only, no change), `tests/mcpIntent.test.ts`.

## F2. Durable agent identity — P0

### Gap (evidence)

There is no agent record anywhere: no table (`server/db/schema.ts` has no agent table), and the
only durable traces are denormalised strings on other rows (`frames.updated_by`,
`comments.claimed_by`, `run_events.agent_name`, …). Identity is a free-text `agent_name` plus the
owning account (server/mcp.ts:923-926, `whoami` at :2284-2309). Stop/steer is keyed by canvas plus
lowercased name alone (server/agentEvents.ts:205-232), and `get_agents` collapses live presence
into a map keyed by name, dropping the owner half (server/mcp.ts:2400-2404). Two accounts that both
post as "Claude" therefore share one stop target and one row, and the `comments.claimed_by_owner`
column exists purely to work around it.

### Decision

New `agents` table — `id`, `ownerId`, `clientId`, `name`, `createdAt`, `lastSeenAt`, `revokedAt`,
unique on `(ownerId, name)`. Every canvas-scoped MCP call upserts/heartbeats its record through
the existing `arrive()` hook (server/mcp.ts:1284-1286). Presence, stop/steer, comment claims,
proposals, questions and run attribution carry the agent id while display stays exactly what it is
today (name, plus owner). `whoami` and `get_agents` gain an `agent_id` field. Revoking an OAuth
client (`DELETE /api/mcp-agents/:clientId`) revokes its agents.

### Acceptance

Two accounts posting as "Claude": `get_agents` returns two rows, and a stop aimed at one leaves the
other running. The migration applies cleanly to both PGlite and Postgres.

### Touches

`server/db/schema.ts` plus migration, `server/store.ts`, `server/agentEvents.ts`, `server/index.ts`
(presence keys), `server/mcp.ts`.

## F3. Per-agent permission level — P0

### Gap (evidence)

Nothing grants an agent anything: it inherits its owner's full reach, and tool restriction is
process-wide — `DOOP_MCP_DENY_TOOLS` / `DOOP_MCP_READONLY_TOOLS` parsed once at module load
(server/mcpPolicy.ts) — or per canvas via the review policy (server/actions.ts:358-367). Searches
for `trustLevel|autonomy|agentPermission|agentScope` return nothing, so an owner cannot run one
agent as a propose-only reviewer while another writes freely.

### Decision

A per-canvas, per-agent level: `full` | `propose` | `comment` | `view`, defaulting to `full`
(today's behaviour). Composition is most-restrictive-wins — level ∩ F1's intent check ∩ the canvas
review policy. `propose` routes writes into the existing proposal tools by refusing direct writes
with the same `unsupported` error review mode produces, naming the propose path. The owner sets
the level in the Review panel, through a REST route parallel to the review-policy one;
`get_capabilities` reports the caller's own level.

### Acceptance

An agent set to `propose` on a canvas with review off: `set_frame_html` returns the
review-mode-style `unsupported` naming the proposal tools, and `propose_frame_html` succeeds. New
`tests/mcpAgentPerms.test.ts` pins the composition order against all three inputs.

### Touches

`server/db/schema.ts`, `server/actions.ts` (the gate), `server/mcp.ts`,
`src/components/ReviewPanel.tsx`.

## F4. Human-triggered design workflow — P1

### Gap (evidence)

The implementer/judge loop (`server/designWorkflow.ts`) is reachable only as the MCP tool
`run_design_workflow` (server/mcp.ts:10571) called by a connected agent. A person with no MCP
client connected cannot start it at all: the UI surface is a model-pair settings form
(`src/components/DesignWorkflow.tsx`) fed by `GET/PATCH /api/design-workflow`
(server/index.ts:1391-1407), and no canvas-side trigger exists.

### Decision

A Brief composer on the canvas page, usable by the owner and by edit-intent members, that starts
the same server-side run — `server/designWorkflow.ts` reused verbatim, no second runtime. It
streams into a chosen frame, appears in the Run tab as a run, and notifies through the existing
`agentFinishEmail` / `agentFailEmail` producers (server/notifications.ts). The actor is the
initiating person, so presence and attribution read as a human-initiated run; the existing Stop
control path applies where the run is stoppable.

### Acceptance

With `DESIGN_LLM_BASE_URL` and `DESIGN_LLM_API_KEY` set, a person with no MCP client connected
submits a brief: the frame streams in, the Run tab shows the run, and the finish email arrives when
enabled. Without those env vars the composer shows the same "off" note the settings card shows.

### Touches

`src/pages/CanvasPage.tsx`, `src/lib/api.ts`, `server/index.ts` (one POST route),
`server/designWorkflow.ts`.

## F5. Trash and restore tools — P1

### Gap (evidence)

Agents can delete but never undo a deletion to trash: no `restore_frame`, `restore_page` or
`list_trash` exists in server/mcp.ts, and `delete_canvas`'s own description states that restoring
from the trash is not something an agent can do. The REST layer has the paths; the retention window
(`TRASH_RETENTION_DAYS`, a 30-day default overridable by env — server/db/persist.ts:1382-1385,
swept daily per server/index.ts:213-217) is therefore reachable only by a human in the browser.

### Decision

Three tools: `list_trash` (canvas-scoped, optional kind filter), `restore_frame`, `restore_page`.
Restores go through the ordinary write path, reusing the store's existing restore helpers, so each
is versioned, logged and broadcast like any other edit. They require edit intent and return a
`conflict` naming the holder when the destination frame is locked by another agent. Owner-only
canvas restore stays REST — it is rare and heavyweight.

### Acceptance

An agent deletes a frame, `list_trash` shows it, `restore_frame` brings it back with a new version
and an activity row; a restore into a frame locked by another agent returns `conflict` and changes
nothing. Tests extend the trash coverage already in `tests/hardDelete.test.ts`.

### Touches

`server/mcp.ts`, `server/store.ts` (reuse), `tests/hardDelete.test.ts`.

## F6. Canvas-level versions for agents — P1

### Gap (evidence)

`canvas_versions` exists and REST reads and writes it (server/index.ts:1624-1665), but no MCP tool
touches it — a search for `canvasVersion` in server/mcp.ts returns nothing. Agents can revert a
frame or a run, never the whole canvas, so an agent asked to try a direction across many frames
cannot offer one-step recovery.

### Decision

Three thin tools over machinery that already exists and is REST-exercised: `create_canvas_version`
over `actions.snapshotCanvas(canvasId, 'manual', actor.name)` (server/actions.ts:1362-1394),
`list_canvas_versions` over `store.getCanvasVersions(canvasId)`, and `restore_canvas_version` over
`actions.restoreCanvasVersion(canvasId, versionId, actor)` (server/actions.ts:1412-1421), which
already replays each frame through the ordinary edit path — logged, streamed and reversible frame
by frame. No new snapshot or restore logic; the tool layer adds intent/level gating and reports the
existing `restored` / `created` counts. Restore respects frame locks and the review policy and
reports skipped frames with a reason each instead of failing whole.

### Acceptance

Snapshot, mutate two frames, restore: both frames return with new versions and one activity row
each. A frame locked by another agent is skipped and named in the result rather than blocking.

### Touches

`server/mcp.ts` (three registrations over existing actions), `tests/`.

## F7. Durable stop/steer signals — P2

### Gap (evidence)

The stop/steer registry is in-process state (server/agentEvents.ts:180-300): `requestStop` /
`requestSteer` / `pendingStop` / `takeSteers` live in maps. A server restart silently drops a stop
queued for an agent that is still running, so the human's control evaporates with no record that it
was ever issued.

### Decision

Persist pending stop and steer rows, keyed by agent id (riding F2), delivered on the agent's next
tool call or `wait_for_events` exactly as today; a row is swept when taken or when it expires. The
Run tab's signal read goes through the same store, so a restart no longer changes what it reports.

### Acceptance

Queue a stop, restart the server, and the agent's next tool call returns the stop refusal. Pinned
with the existing stopped-server test pattern.

### Touches

`server/agentEvents.ts`, `server/db/schema.ts`, `tests/sharingAgents.test.ts`.

## F8. Run timeline detail — P2

### Gap (evidence)

`run_events` already carries before/after version ids (server/db/schema.ts:667-672), but neither
`get_run_events` nor the Run tab surfaces tool arguments or any per-step diff: a step reads as
"set_frame_html, 1.4s, ok". A human auditing what an agent did cannot see what it wrote or compare
against the prior state without leaving the timeline by hand.

### Decision

`get_run_events` gains truncated tool arguments (2 KB cap) and, for steps that carry before/after
versions, the version pair. The Run tab renders a diff affordance per such step that opens the
existing `diff_frame` view for that pair. No new event kinds are introduced.

### Acceptance

A `set_frame_html` step shows its arguments and a working diff affordance; read steps without
version pairs show none.

### Touches

`server/mcp.ts` (`get_run_events`), `server/runLog.ts`, `src/components/ActivityPanel.tsx`,
`src/lib/api.ts`.

## Deliberately not on this list

Kept here so the boundary is explicit, not because they are worthless:

- **Notification centre** — transient toasts plus the opt-in emails cover the loop; a durable inbox
  is a product-surface question, not a loop blocker.
- **Agent↔agent direct messages** — canvas chat with `to` routing and role mentions already reaches
  another agent.
- **Installation-defined roles** — the six static roles are routing vocabulary, and the loop works
  with them as they are.
- **Per-tool usage telemetry for agents** — the admin surface serves the operator's need.
- **Frame-version pinning** — releases snapshot durably; the 50-version ring is adequate within a
  run.
- **A task/assignment model** — dropped deliberately in migration 0032 in favour of comment claims;
  reintroducing one would create a second routing convention beside the working one.
