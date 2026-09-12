import * as actions from './actions.ts'
import type { Actor, AgentPlan, PlanStep } from '../shared/types.ts'

/**
 * Agent plans: the one surface both the MCP `set_plan` / `update_plan_step` /
 * `get_plan` tools and the resident agent's loop call, so plan state has a
 * single owner (actions.planLog) and one set of semantics.
 *
 * The MCP tools name each step explicitly, because an external agent already
 * has its own ids. The resident loop publishes a plain ordered list; ids are
 * generated from the position ("s1", "s2", …) so re-publishing the same list
 * in the same order keeps each step's progress — exactly the rule
 * actions.setPlan applies to a re-published step whose text is unchanged.
 *
 * `AgentPlan` carries no title field, so there is nowhere for a caller's title
 * to live; the step texts are all the display text a plan has.
 */

const STEP_STATUSES = ['pending', 'active', 'done', 'blocked'] as const

/** What one `advancePlanStep` call targets: a step id (what the MCP tools
 *  use), or its position in the published plan, and the move to make. */
export interface PlanStepPatch {
  /** the step's stable id, as `set_plan` named it */
  stepId?: string
  /** or its zero-based position in the published plan */
  index?: number
  /** defaults to 'active' — the common "I am on this step now" move */
  status?: string
  note?: string
}

function asStepStatus(raw: string): PlanStep['status'] {
  const match = STEP_STATUSES.find((status) => status === raw)
  if (!match) throw new Error(`unknown plan step status “${raw}” — use ${STEP_STATUSES.join(', ')}`)
  return match
}

/** Publish (or replace) an agent's plan for a canvas. Throws on invalid input
 *  with a message meant for the caller's error channel, like actions.setPlan. */
export function publishPlan(canvasId: string, agentName: string, steps: string[], actor: Actor): AgentPlan {
  return actions.setPlan(
    canvasId,
    agentName,
    steps.map((text, i) => ({ id: `s${i + 1}`, text })),
    actor,
  )
}

/** Move one step of an agent's plan. Returns undefined when the agent has no
 *  plan on this canvas or the targeted step is gone. */
export function advancePlanStep(
  canvasId: string,
  agentName: string,
  opts: PlanStepPatch,
  actor: Actor,
): AgentPlan | undefined {
  const plan = actions.getPlan(canvasId, agentName)
  if (!plan) return undefined
  const step = opts.stepId !== undefined ? plan.steps.find((s) => s.id === opts.stepId) : plan.steps[opts.index ?? 0]
  if (!step) return undefined
  const status = opts.status === undefined ? 'active' : asStepStatus(opts.status)
  return actions.updatePlanStep(canvasId, agentName, step.id, status, opts.note, actor)
}

/** The plan this agent published on this canvas, if any. */
export function readPlan(canvasId: string, agentName: string): AgentPlan | undefined {
  return actions.getPlan(canvasId, agentName)
}
