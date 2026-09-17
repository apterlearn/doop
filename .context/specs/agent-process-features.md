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

## Beyond the eight — the second-wave gaps

F1 and F4 shipped. G1, G2, G11 and G12 are implemented in this branch. The rest are in flight or open.

### G1. Interruptible design runs — P0

#### Gap (evidence)

`server/designWorkflow.ts` never imported `agentEvents` (imports at :1-14 were `actions`, `designLlm`,
`frameLocks`, `limits`), so the loop that spends up to five attempts (`MAX_ATTEMPTS`, :61) of two
180-second model calls each (`COMPLETION_TIMEOUT_MS`, `server/designLlm.ts:16-17`) never read the
stop/steer registry: `requestStop` filed a signal nothing consumed, so a Stop pressed during a
`run_design_workflow` landed — if at all — after the run had already returned half an hour later.
F4 sharpened it: a person could now start a run from the Brief composer and had no way to interrupt
one.

#### Decision

The engine consults the registry at the boundaries it owns: the top of every attempt (`takeStop()`,
`server/designWorkflow.ts:391-403`) and again before the judge call (:553). A pending stop ends the
run with `judgeSummary = "stopped by <name>"`, `ok: false`, one terminal `stop` line in the
timeline, and no further model call. `takeSteers` is drained into the next implementer prompt from
the second attempt on (:419-424), so a steer arrives as a mid-run course correction rather than a
nudge for the next call. Each signal is consumed as it is acted on (`clearStop`), so the stop that
ended this run cannot refuse the next run's first call. A stop still cannot interrupt a model call
already in flight — MCP is pull-based and the endpoint is stateless — so the bound is one attempt,
which is the honest bound.

#### Acceptance

A stop queued mid-run ends the run with the stopped summary and no further model calls; a steer
queued mid-run appears in the next attempt's prompt; a run with no signals behaves exactly as
before. `tests/designWorkflow.test.ts` pins all three.

#### Touches

`server/designWorkflow.ts`, `tests/designWorkflow.test.ts`.

### G2. A durable event bus and durable stop/steer signals — P0

#### Gap (evidence)

`server/agentEvents.ts` was entirely in-process — the ring, the cursors and the stop/steer maps all
lived in the module — so a restart lost every pending signal, which F7 states on its own. The
sharper half was the sequence: `nextSeq` restarted the per-canvas counter at 1 while connected
agents still held pre-restart cursors, and every read path filters with `e.seq <= waiter.cursor`
(:144, :159), so a parked agent's `wait`/`matching` dropped every event published after the
restart. The agent was not merely missing a stop; it had gone silently deaf with no error to
notice.

#### Decision

Mirror `runLog`'s write-behind pattern, which already solves the same problem for the run timeline:
`agent_events` (canvas_id, seq, kind, at, summary, target_agent — server/db/schema.ts:838) and
`agent_signals` (canvas_id, target, kind, message, by, at, taken_at — :862). `push` writes through
(`writeBehind`, server/agentEvents.ts:85); `hydrate()` at boot (:237) seeds each canvas cursor from
the durable maximum — so a cursor an agent took before the restart still means "everything up to
here" — and refiles untaken stops and steers under every spelling `signalKeys` answers to, exactly
as the live paths file them. The in-process ring stays the read path; a seven-day prune rides the
sweep `runLog` already has.

#### Acceptance

A stop queued before a restart is still returned by `pendingStop` after it; a cursor taken before a
restart still matches events published after it; a stop already taken does not come back.
`tests/agentEventsDurable.test.ts` pins all three against a restarted store.

#### Touches

`server/agentEvents.ts`, `server/db/schema.ts` plus migration, `server/db/persist.ts`,
`server/store.ts`, `server/index.ts`, `tests/agentEventsDurable.test.ts`.

### G3. Durable agent identity — P0

#### Gap (evidence)

F2 above is the body of this gap — no agent table, name-keyed stop targets, a `get_agents` that
dropped the owner half — and nothing new surfaced in the second pass.

#### Decision

F2's decision stands as written. What is worth recording is the shape it landed in, because the
later entries key on it: an `agents` table (server/db/schema.ts:791) carrying id, ownerId, clientId,
name, createdAt, lastSeenAt, revokedAt, unique on `(ownerId, name)`; `arrive()` upserts and
heartbeats it; `whoami` and `get_agents` report the durable `agent_id` (server/mcp.ts:2455, :2467,
:2555-2573) and the name-only dedupe is replaced by identity keying; revoking an OAuth client
revokes its agents (`server/index.ts:1309` → `store.revokeAgentsForClient`, server/store.ts:1331).

#### Acceptance

F2's acceptance stands — two accounts posting as "Claude" stay distinct rows, and a stop aimed at
one leaves the other running — with `tests/mcpAgentIdentity.test.ts` pinning it and the migration
applying cleanly to both PGlite and Postgres. Delivering the stop needed one more step than the
table: the registry paired an id with the agent's name so a name-carrying call could find it, and a
name two accounts share then delivered one agent's stop to the other. It now counts who answers to
a name, looks up by identity whenever the caller has one, and lets the name stand in for an id only
when it addresses that agent alone — an unregistered name keys by spelling as before.

#### Touches

`server/db/schema.ts` plus migration, `server/store.ts`, `server/db/persist.ts`,
`server/agentEvents.ts`, `server/index.ts`, `server/mcp.ts`, `tests/mcpAgentIdentity.test.ts`.

### G4. Per-agent permission level — P0

#### Gap (evidence)

F3 above is the body of this gap: nothing granted an agent anything, and restriction was
process-wide (`DOOP_MCP_DENY_TOOLS` / `DOOP_MCP_READONLY_TOOLS`) or per canvas.

#### Decision

F3's decision stands. The storage shape that landed is worth recording because it removes two
operations from the design: `agent_levels` (server/db/schema.ts:816) is keyed `(canvas_id,
agent_id)` and `level = 'full'` means "no row" — `store.setAgentLevel` normalises `full` to a clear
(server/store.ts:1348-1356, `AgentLevel`, server/db/persist.ts:1255-1281). The default therefore
needs no backfill, and clearing a restriction is the same write as setting one.

#### Acceptance

F3's acceptance stands: an agent set to `propose` gets the review-mode-style `unsupported` naming
the proposal tools while `propose_frame_html` succeeds, and the composition order (level ∩ intent ∩
review policy) is pinned by `tests/mcpAgentPerms.test.ts`.

#### Touches

`server/db/schema.ts` plus migration, `server/store.ts`, `server/db/persist.ts`, `server/mcp.ts`,
`server/index.ts`, `src/components/ReviewPanel.tsx`, `tests/mcpAgentPerms.test.ts`.

### G5. A recovery surface for agents — P1

#### Gap (evidence)

REST has the whole recovery surface and the MCP layer has none of it: `GET /api/trash` plus the
per-kind restore routes (server/index.ts:2063-2130) and the canvas-version routes (:1711-1745),
against zero hits for `list_trash`, `restore_frame`, `restore_page` or any `canvas_version` tool in
`server/mcp.ts`. An agent can therefore delete a frame and never undo it — `delete_canvas`'s own
description says restoring from the trash is not something an agent can do — and can revert a frame
or a run but never the whole canvas, so an agent asked to try a direction across many frames has no
one-step recovery to offer. F5 and F6 state the two halves of this gap separately; what the second
pass adds is that the two are one surface, and that the restore must not fail whole when one frame
in it cannot be touched.

#### Decision

Thin tools over actions that already exist, not a second implementation: `list_trash` (canvas-scoped,
optional kind filter), `restore_frame` / `restore_page` through `actions.restoreFrame`
(server/actions.ts:1480) and `actions.restorePage` (:1504) so each restore is versioned, logged and
broadcast like any other edit, and `create_canvas_version` / `list_canvas_versions` /
`restore_canvas_version` over `actions.snapshotCanvas` (:1364) and `actions.restoreCanvasVersion`
(:1415). A restore reports per-frame refusals — a lock held by another agent, the review policy — as
`skipped` entries with a reason each rather than failing the whole operation. Owner-only canvas
restore stays REST: it is rare and heavyweight.

#### Acceptance

Delete a frame, `list_trash` shows it, `restore_frame` brings it back with a new version and an
activity row; a destination frame locked by another agent is named in `skipped` while the other
frames still restore; a viewer token is refused on all of them. Extends the trash and version
coverage in `tests/hardDelete.test.ts` and `tests/mcpVersions.test.ts`.

#### Touches

`server/mcp.ts`, `server/actions.ts` (reuse), `server/store.ts` (reuse), `tests/`.

### G6. Run timeline detail — P2

#### Gap (evidence)

F8 states the arguments half of this gap and stands. What F8 did not cover is the client half:
`run_events` carries the frame a step touched and the versions it started from and produced
(server/db/schema.ts:665-685) but no tool arguments, so a step reads as "set_frame_html, 1.4s, ok"
in both `get_run_events` (server/mcp.ts:10889) and the Run tab, while the Run tab renders only the
websocket ring, capped per canvas, and never called the paged REST route
(`GET /api/canvases/:id/run-events`, server/index.ts:3260) that exists for exactly this. A long run
therefore scrolls off the client's window with no way back to it.

#### Decision

An `args` column on `run_events` (:679), written by `record` (server/runLog.ts:52) as truncated
JSON with a 2048-byte cap and null for non-tool kinds; `get_run_events` returns it per event; the
Run tab expands a step to show the arguments and, when the step carries a version pair, a diff
affordance over the existing frame-diff path. Read steps carry neither and render as they do today.
The client gains a `runEvents` call (src/lib/api.ts:781) and a "Load older" control that merges
paged results into the slice it already holds, so the timeline is bounded by the run, not by the
ring.

#### Acceptance

A `set_frame_html` step shows its arguments (truncated at the cap) and opens a working diff; a read
step shows neither; "Load older" pulls steps the ring no longer holds.

#### Touches

`server/db/schema.ts` plus migration, `server/runLog.ts`, `server/mcp.ts`, `shared/types.ts`,
`src/lib/api.ts`, `src/components/ActivityPanel.tsx`.

### G7. The supervision surface: bulk decisions, actor kind, claims list — P2

#### Gap (evidence)

Proposals had to be resolved one card at a time even when a group shared a frame and a verdict;
run rows carried no indication of whether a human or an agent started the run, so a Brief run read
exactly like an agent run; a claim was visible only on the pin that held it, so "what work is in
flight" had no surface at all; and a live human-initiated run offered no Stop, because the control
gate required a live agent presence carrying the run's name (src/components/ActivityPanel.tsx:503)
— a name no presence ever carries for a run a person started.

#### Decision

Group-level accept/reject over the existing `resolveFrameProposal` / `resolveCanvasProposal`
clients (src/lib/api.ts:703, :719), with per-item failures reported inline — no new endpoints, and
one refusal must not hold up the rest of the group. `RunEvent` (shared/types.ts:526) gains an
optional actor kind, rendered on the run row the way the Activity tab already tags an actor. A
Claims tab, fed by the comments the client already holds (src/lib/store.ts:93), groups failed /
in-progress / waiting-for-a-role, with a rail count for the failed ones. The control gate accepts a
run whose newest step is non-terminal as well as one with a matching presence, which is what a
Brief run needs.

#### Acceptance

Three proposals resolve as a group with any per-item failure named; a Brief run shows the human
marker and offers Stop; a failed claim appears in the Claims tab and in the rail count.

#### Touches

`src/components/ReviewPanel.tsx`, `src/components/ActivityPanel.tsx`, `src/components/SideRail.tsx`,
`src/lib/store.ts`, `shared/types.ts`.

### G8. Agent situational awareness — P2

#### Gap (evidence)

Nothing let an agent see a held frame lock before colliding (the only signal was a failed
`begin_frame_edit`), read a stored verification verdict without paying for a fresh render, learn
which of its account's canvases needed it, or load several frames' HTML in one call — one round
trip per frame, and the canvas inbox question ("which canvas needs me?") had no answer at all.

#### Decision

`list_frame_locks` over `frameLocks.activeLocks()` (server/frameLocks.ts:40) joined to frame names,
so contention is planned around rather than discovered. `get_frame_review` over the stored reports
`canvasReview` already reads back without re-rendering (server/canvasReview.ts:52-66). `get_inbox`,
account-scoped and naming no canvas, counting open questions, unclaimed role-addressed comments,
messages addressed to the caller and its own pending proposals across the canvases it can reach.
`get_frames_html` (≤20 ids) reusing `get_frame_html`'s clamping (server/mcp.ts:4839,
`MAX_FRAME_HTML_BYTES` :1143), with an unknown id reported per entry rather than failing the batch.

#### Acceptance

A lock held by another agent is named before the collision; a stored verdict reads back without a
render; an unclaimed note on a second canvas appears in the inbox without the caller naming a
canvas; two frames load in one call with an unknown id reported per-entry.

#### Touches

`server/mcp.ts`, `tests/`.

### G9. Agent progress reporting — P2

#### Gap (evidence)

The run timeline's `status` kind exists and only the engine and the stop/steer routes wrote it
(server/designWorkflow.ts:405, server/index.ts:3357, :3375), so a plain MCP agent doing forty
minutes of work produced only tool rows: the human watching saw no "step 3/7" and no "waiting on
you", and a quiet stretch was indistinguishable from a stuck agent.

#### Decision

`post_status`, one status line into the caller's own run through `runLog.recordStatus`
(server/runLog.ts:92), registered as a mutating tool with edit intent so it goes through the same
wrapper and lands in the same run id as the caller's tool rows. The summary is already flattened
and cut at 200 characters, so an agent cannot push a paragraph into the timeline.

#### Acceptance

The status row lands in the caller's run alongside its tool rows and reads back through
`get_run_events`; a viewer token is refused.

#### Touches

`server/mcp.ts`, `tests/`.

### G10. Comment and question hygiene — P2

#### Gap (evidence)

A comment could be added, replied to, claimed, resolved or failed, and never edited. A claim could
be reported failed or claimed done, and never released (the write path at server/actions.ts:804-838
only ever sets or deletes the fields as part of one of those transitions). A question could not be
withdrawn, so stale open questions accumulated in `get_answers` and in the Review queue
(`agent_questions.status`, server/db/schema.ts:636-661) with no way for the asker to take one back.

#### Decision

`edit_comment` (author only) through a store mutation plus broadcast in the shape `add_comment`
uses; `unclaim_comment` clearing claimed_by / claimed_by_owner / claimed_at and pushing the comment
event the claim path pushes, so the release is visible to the room; `withdraw_question` (asker only)
setting status `withdrawn` and pushing the question event a parked waiter sees. All three are
comment-intent mutating tools, so they inherit F1's intent check and F3's level.

#### Acceptance

An author's edit lands and a non-author's is refused; a released claim returns the note to the
waiting list; a withdrawn question leaves the open queue.

#### Touches

`server/actions.ts`, `server/mcp.ts`, `tests/`.

### G11. Stop notifications tell the truth — P2

#### Gap (evidence)

`NotificationPhase` was `'finished' | 'failed'` (server/notifications.ts:21), so the engine had no
way to say a run ended because a human stopped it and mailed a deliberately stopped run as a
failure: the person who pressed Stop got an inbox telling them their run failed.

#### Decision

A `stopped` phase, riding the same failure switch (`switchFor`, :46-52) and the same wording the
REST stop route already uses (`EVENT_LABELS.stop`, :35-38), with the engine reporting it
(server/designWorkflow.ts:325, :344). Known follow-up, recorded rather than solved: the REST stop
route also mails when Stop is pressed (server/index.ts:3361-3363), so a stop on a live design run
sends two mails, and the two carry no shared run identifier — deduplicating them needs one, which is
a separate decision.

#### Acceptance

A stopped run mails the stopped wording and never the failure wording; `tests/notifications.test.ts`
pins it.

#### Touches

`server/notifications.ts`, `server/designWorkflow.ts`, `tests/notifications.test.ts`.

### G12. Presence freshness — P2

#### Gap (evidence)

`Presence.lastSeen` exists and documents the signal — the last thing the room heard from an agent
(shared/types.ts:626-637) — but nothing rendered it, so an agent thinking and an agent stuck looked
identical in the presence stack, which is the one place a human goes to find out.

#### Decision

The agent tile carries how long ago the agent was last seen, through the existing relative-time
helper, with an idle treatment past a minute (src/pages/CanvasPage.tsx:149-162). People are always
here by definition, so a human's tile renders unchanged.

#### Acceptance

An agent last seen two minutes ago reads as such and carries the idle treatment; a human's tile is
unchanged.

#### Touches

`src/pages/CanvasPage.tsx`.

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
- **A durable idempotency ledger** — the `op_id` replay cache is in-process with a 10-minute TTL
  (server/opIds.ts), so a retry after a restart re-runs a write. Real, but a separate decision with
  its own cost: it needs a durable table, a retention story, and a rule for what "the same write"
  means across a restart. Not worth paying for the loop's current single-instance shape.
- **Canvas templates and a brief/prompt library** — an onboarding surface, not a loop blocker: the
  loop works from a blank canvas and a typed brief, and a library only shortens the first five
  minutes of it.
- **Operator observability and backup scheduling** — a self-hoster surface. Metrics, tracing and
  scheduled backups serve whoever runs the server, not the person and the agent designing on a
  canvas.
- **Mobile element editing and desktop auto-update** — a platform surface. Touch editing needs a
  different interaction model, and the desktop build's update channel is a release concern; neither
  changes what the loop can do.
- **PDF/print export** — a delivery format for finished work. The canvas is the working surface;
  export is what happens after the design is agreed.
- **Documenting the read-only `/mcp` endpoint** — a docs gap, not a capability gap. The endpoint
  exists and registers no writes; what is missing is a page saying so, which belongs with the other
  user-facing documentation.
