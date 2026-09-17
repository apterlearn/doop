# The agentic design process — implementation roadmap

This is the execution strategy for the gaps recorded in
[../specs/agent-process-features.md](../specs/agent-process-features.md) (F1-F8 and the
second-wave G1-G12). The spec says what is missing and why; this says in what order it gets
built, what each step has to prove, and what the standing rules are. Read the spec first: every
entry here is a spec feature, and the reasoning lives there.

## The shape of the work

Two tracks, one order. The **trust floor** comes first because everything after it keys on it:
a durable agent identity (F2/G3), a per-agent permission level (F3/G4), a stop that actually
interrupts a running design (G1), and an event bus that survives a restart (G2). Then the
**loop completion** work — the recovery surface (F5/F6/G5), the timeline a human audits with
(F8/G6), and the agent-side awareness tools (G8, G9) — and finally the **supervision surface**
(G7, G10, G11, G12) that lets a person watch and correct the loop without leaving the canvas.

The order is not a preference. Identity before permissions, because a level is granted to an
agent and there was no agent to grant it to. Signals before durable signals, because the engine
had to consult the registry at all before persisting what it holds. Timeline detail last among
the server work, because it is read-side and independent.

## Phases and where they stand

**Phase 0 — land the trust floor's first half.** F1 (intent-enforced MCP authorization) and F4
(the human brief composer) were in the tree uncommitted, with F1 pinned by `tests/mcpIntent.test.ts`
and the brief route unpinned. The route gained three tests (`tests/designWorkflowRoutes.test.ts`:
an owner's brief runs and answers with the run the canvas holds, a viewer member is refused before
any model is asked, and an unconfigured server refuses in the off state the settings card shows).
Landed.

**Phase 1 — durable agent identity (F2/G3).** An `agents` table keyed on owner + name, minted and
heartbeated by `arrive()`, `agent_id` on `whoami` and `get_agents`, the name-only dedupe replaced
by identity keying, and revoking an OAuth client revoking its agents. Pinned by
`tests/mcpAgentIdentity.test.ts`. Landed. Known residual: the browser's presence stack still keys
on `clientId`, so two same-named agents of two accounts collapse in the avatar stack even though
the server separates them.

**Phase 2 — per-agent permission level (F3/G4).** An `agent_levels` table keyed
`(canvas_id, agent_id)` where `full` means "no row", the owner's controls in the Review panel, the
REST routes, and the wrapper gate that composes the level with the tool's declared intent —
most-restrictive-wins. A `propose` level also opens the proposal path on a canvas whose review
mode is off, so a propose-only agent is a per-agent review mode rather than a contradiction.
Pinned by `tests/mcpAgentPerms.test.ts`. Landed.

**Phase 3 — recovery (F5/F6/G5).** `list_trash`, `restore_frame`, `restore_page`,
`create_canvas_version`, `list_canvas_versions`, `restore_canvas_version` and the verdict read-back
`get_frame_review`, all thin layers over the actions layer that REST already used, so a restore is
an ordinary edit — versioned, logged, broadcast. A canvas-version restore now reports per-frame
refusals in `skipped` with a reason instead of failing whole. Pinned by `tests/mcpRecovery.test.ts`.
Landed.

**Phase 4 — the run obeys and the bus remembers (G1/G2).** The design engine checks the stop
registry at each attempt boundary and before the judge call, drains steers into the next
implementer prompt, and records the ending as a stop; the engine also mails a stopped run as
stopped rather than failed. `agentEvents` writes events and signals through to `agent_events` and
`agent_signals`, `hydrate()` seeds cursors from the durable maximum (the stale-cursor deafness bug
is gone) and refiles untaken signals under every spelling a lookup may use. Pinned by
`tests/designWorkflow.test.ts`, `tests/agentEventsDurable.test.ts`, `tests/notifications.test.ts`.
Landed.

**Phase 5 — the timeline a human audits with (F8/G6).** `run_events` gained the tool arguments
(cut at 2048 bytes), the actor kind and the agent id; `get_run_events` and the REST route carry
them; older pages now come from the durable table rather than stopping at the live ring; and the
Run tab expands a step to show its arguments and diff the frame versions it produced. Pinned by
`tests/runLogArgs.test.ts`, `tests/runEventsPaging.test.ts`, `tests/mcpRunEventsFields.test.ts`.
Landed.

**Phase 6 — the supervision surface (G7/G10/G11/G12).** Group-level accept/reject over the existing
resolve clients with per-item failure reporting; an actor-kind tag on run rows so a person's run
reads as theirs; a Claims tab grouping failed, in-progress and waiting-for-a-role notes; Stop and
Steer available for a run whose newest step is non-terminal; presence tiles carrying how long ago
an agent was last seen. Pinned by `tests/mcpHygiene.test.ts` for the tool half and by the browser
smoke below for the surface. Landed.

**Phase 7 — awareness (G8/G9).** `list_frame_locks`, `post_status`, `get_inbox` and
`get_frames_html` close the four "the agent cannot see this" gaps. Pinned by
`tests/mcpAgentTools.test.ts`. Landed.

## Standing rules for anything added here

- **A new MCP tool is registered through the single `tool()` wrapper and lands in four places**:
  `MUTATING_TOOLS` if it writes, `TOOL_DOMAINS` always, the README tool table always, and the
  `get_capabilities` catalog comes for free. `tests/mcpCapabilities.test.ts` asserts the domain map
  covers the registry exactly and `bun run doc-lint` (Rule 13) asserts the README table matches the
  registry — a tool that skips either fails the suite.
- **Schema changes are generated, never hand-written**: `bunx drizzle-kit generate`, applied at
  boot by `server/db/index.ts`. Migrations so far: 0038 agents, 0039 agent events and signals,
  0040 agent levels, 0041 run-event arguments, 0042 run-event actor identity.
- **A write goes through the actions layer** so it is versioned, logged and broadcast like any
  other edit. A tool that writes to the store directly is a bug even when it works.
- **Idempotency is bounded and honest**: the `op_id` replay cache is in-process with a ten-minute
  TTL, so a retry after a restart re-runs the write. Do not promise more than that in a tool
  description.
- **Verification is the narrowest thing that can fail** (`AGENTS.md`): the test file the change
  touches while building, the full gates once at the end. A feature that cannot be pinned by a
  test needs a browser or scripted smoke, and the smoke is the evidence.

## Known residuals

Honest edges left in place, each with the reason it was not closed here:

- **A stop lands between attempts, not inside one.** The engine checks the registry at each
  attempt boundary and again before the judge call, so a stop costs at most one attempt (about two
  model calls) rather than the whole run. Aborting a single in-flight model request needs a signal
  threaded through the provider call; the timeline and the tests pin the bounded behaviour.
- **Two same-named agents of two accounts collapse in the browser's presence stack**, because the
  presence wire carries `clientId` and no agent id. The server separates them (`get_agents` returns
  two rows, a stop aimed at one id reaches it, an ambiguous name is refused with 409); the avatar
  stack is the remaining surface that does not.
- **Idempotency is in-process.** `op_id` replay lives in memory with a ten-minute TTL, so a retry
  after a restart re-runs the write. A durable ledger is a data-model decision with its own cost,
  not a line of this work.

## Not on this roadmap

The product and operator surfaces the spec lists as deliberately out of scope: a durable
idempotency ledger, canvas templates and a brief library, the notification centre, operator
observability and backup scheduling, mobile element editing and desktop auto-update, PDF export,
and documenting the read-only `/mcp` endpoint. Each is real; none blocks the human↔agent loop, and
each needs its own decision about cost rather than a line in this plan.
