import Anthropic from '@anthropic-ai/sdk'
import { store } from './store.ts'
import * as actions from './actions.ts'

/**
 * The Memory distiller: when enough undistilled design decisions pile up on a
 * canvas, a small model reads them and — if a durable preference shows through
 * — proposes ONE rule to add to a style guide. The proposal is only ever
 * pending: a human accepts it into the guide (versioned like any edit) or
 * dismisses it. Auto-committed memory goes noisy; curated memory stays trusted.
 *
 * Event-driven, not scheduled: captureDecision pokes maybeDistill, so quiet
 * canvases cost nothing. Enabled when ANTHROPIC_API_KEY is set; silently
 * disabled otherwise — unless a connected MCP client declares the `sampling`
 * capability, in which case its model stands in and a
 * self-hosted instance with no server key still learns from feedback.
 */

const MODEL = process.env.DOOP_DISTILL_MODEL || ''
/** most recent unconsumed decisions the judge sees per run */
const MAX_WINDOW = 15

/** The connected MCP client's model, via MCP sampling. Set by buildMcpServer
 *  when the client declares the capability and cleared when it does not, so a
 *  sampler never outlives the connection that offered it. */
type Sampler = (prompt: string, system: string) => Promise<string>
let sampler: Sampler | null = null

export function setSampler(fn: Sampler | null): void {
  sampler = fn
}

let client: Anthropic | null = null

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null
  if (!client) client = new Anthropic()
  return client
}

/** A model is reachable: the server's own key, or the connected client's. */
function enabled(): boolean {
  return getClient() !== null || sampler !== null
}

/** A plain-text completion from whichever model is available. Callers gate on
 *  enabled() first, so a throw here is a genuine transport failure. */
async function complete(prompt: string, maxTokens: number): Promise<string> {
  const anthropic = getClient()
  if (anthropic) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.content
      .filter((b): b is (typeof res.content)[number] & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
  }
  if (sampler) return (await sampler(prompt, '')).trim()
  throw new Error('no model available for distillation')
}

const running = new Set<string>()

/** A decision was captured: generalize its raw words into a short preference
 *  ("more white and blue, not so claude-esque" → "Prefer white and blue…"),
 *  then check whether enough decisions accumulated to propose a rule. */
export function onDecision(canvasId: string, decisionId: string) {
  if (!enabled()) return
  summarizeDecision(canvasId, decisionId)
    .catch((err) => console.error('[distill] summarize failed', err))
    .finally(() => maybeDistill(canvasId))
}

async function summarizeDecision(canvasId: string, decisionId: string) {
  if (!enabled()) return
  const decision = actions.getDecisions(canvasId).find((d) => d.id === decisionId)
  if (!decision || decision.summary) return
  const summary = (
    await complete(
      `Raw design feedback a human gave an agent on a shared canvas (the agent carried it out):
"${decision.text}"

Rewrite it as ONE short, general style preference for this project's design memory. Generalize from the specific instance to the underlying taste — e.g. "make this button blue like the others" becomes "Prefer blue accent buttons". Imperative, under 90 characters, no quotes, no trailing period. Reply with the preference only.`,
      100,
    )
  )
    .replace(/^["“]+|["”.]+$/g, '')
    .slice(0, 120)
  if (summary) {
    actions.setDecisionSummary(canvasId, decisionId, summary)
    console.log(`[distill] summarized canvas=${canvasId} "${decision.text.slice(0, 40)}…" -> "${summary}"`)
  }
}

/* Every captured decision gets judged — no "wait for N" gate. Whether one
   decision warrants a rule is a semantic question ("never use italics" is a
   standing rule on its own; "nudge this button left" is not), so the bar
   lives in the judge prompt, not in a counter. Decisions are only consumed
   when a rule IS proposed, so slow-building patterns keep their evidence. */
export function maybeDistill(canvasId: string) {
  if (!enabled() || running.has(canvasId)) return
  if (actions.undistilledDecisions(canvasId).length === 0) return
  /* one open proposal at a time — a stack of pending cards reads as spam */
  if (actions.getProposals(canvasId).some((p) => p.status === 'pending')) return
  running.add(canvasId)
  distill(canvasId)
    .catch((err) => console.error('[distill] run failed', err))
    .finally(() => running.delete(canvasId))
}

const DISTILL_TOOL: Anthropic.Tool = {
  name: 'distill_result',
  description: 'Report whether the decisions contain a durable style rule worth adding to a guide.',
  input_schema: {
    type: 'object',
    properties: {
      has_rule: {
        type: 'boolean',
        description: 'true only if a durable, recurring preference shows through — not a one-off request',
      },
      guide_name: {
        type: 'string',
        description:
          'Slug of the guide the rule belongs in — an existing one when it fits, else a new slug (a-z, 0-9, hyphens)',
      },
      guide_title: { type: 'string', description: 'Pretty display name for the guide if it is new' },
      rule: {
        type: 'string',
        description:
          'The rule as one markdown bullet an agent can execute, e.g. "- Buttons: always fully rounded (border-radius: 999px)"',
      },
      rationale: { type: 'string', description: 'One sentence: which decisions show this and why it is a rule' },
    },
    required: ['has_rule'],
  },
}

/** The verdict as JSON for a client that samples for us: there is no
 *  tool_choice on that wire, so the prompt asks for the same object the
 *  distill_result tool returns. The field list is generated from the tool
 *  definition so the two transports cannot drift. */
const DISTILL_FIELDS = (DISTILL_TOOL.input_schema.properties ?? {}) as Record<string, { description?: string }>
const SAMPLING_INSTRUCTION = `\n\nReply with ONLY a JSON object — no prose, no code fences — using these fields:\n${Object.entries(
  DISTILL_FIELDS,
)
  .map(([key, spec]) => `- ${key}: ${spec.description ?? ''}`)
  .join('\n')}\nAlways include has_rule; include the others only when it is true.`

/** A sampling client has no tool description on the wire, so the tool's own
 *  description becomes the system prompt. */
const DISTILL_SYSTEM = `You maintain the design memory of a shared canvas. ${DISTILL_TOOL.description}`

interface DistillVerdict {
  has_rule?: boolean
  guide_name?: string
  guide_title?: string
  rule?: string
  rationale?: string
}

/** The judge's verdict, from either transport: with the server key the reply is
 *  the distill_result tool's input object, with sampling it is JSON text. One
 *  parser, so the two transports cannot drift on what a valid verdict is. */
function parseVerdict(reply: { input?: unknown } | string): DistillVerdict {
  if (typeof reply !== 'string') return (reply.input ?? {}) as DistillVerdict
  /* tolerate prose or a code fence around the object: take the outermost braces */
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  try {
    return JSON.parse(reply.slice(start, end + 1)) as DistillVerdict
  } catch {
    return {}
  }
}

async function distill(canvasId: string) {
  if (!enabled()) return
  const decisions = actions.undistilledDecisions(canvasId).slice(0, MAX_WINDOW)
  if (decisions.length === 0) return
  const guides = store.getGuidelines(canvasId)

  const guideList = guides.length
    ? guides.map((g) => `- ${g.name} ("${actions.guidelineTitle(g)}"): ${actions.guidelineSummary(g)}`).join('\n')
    : '(none yet)'
  const decisionList = decisions
    .map((d) =>
      d.summary
        ? `- [${d.id}] ${d.summary} (${d.from}'s words: "${d.text}")`
        : `- [${d.id}] ${d.from} asked${d.agentName ? ` ${d.agentName}` : ''}: "${d.text}"`,
    )
    .join('\n')
  /* what was already pitched: never re-propose a dismissed rule, don't repeat
     an accepted one (it lives in a guide now anyway) */
  const priorProposals = actions
    .getProposals(canvasId)
    .filter((p) => p.status !== 'pending')
    .slice(0, 5)
  const proposalList = priorProposals.length
    ? priorProposals.map((p) => `- [${p.status}] ${p.rule}`).join('\n')
    : '(none)'

  const prompt = `You maintain the design memory of a shared canvas. Humans gave agents the following feedback, and each item below was carried out — they are settled decisions, newest first:

${decisionList}

Style guides already on this canvas:
${guideList}

Rules previously suggested from this memory (dismissed = the human rejected it; never re-propose it or a trivial variant):
${proposalList}

If these decisions reveal a durable style preference, distill it into ONE markdown bullet for the most fitting guide. Judge by substance, not count:
- ONE decision is enough when it is stated as a standing preference — "never/always …", "keep that as our signature style", "prefer X over Y", or a general taste like "less claude-esque, more white and blue".
- Several decisions correcting in the same direction are enough even if each was phrased as a one-off.
- A single tweak scoped to one design ("nudge this button left", "fix this heading") is NOT a rule — report has_rule: false and wait for more evidence.
Do not restate anything a guide already covers. Prefer an existing guide's slug; invent a new slug only when nothing fits.`

  console.log(`[distill] run canvas=${canvasId} decisions=${decisions.length}`)
  /* With the server key the model is handed the distill_result tool and returns
     its verdict as an object; a sampling client has no tool_choice, so the same
     prompt carries a JSON-only instruction and the text goes through the one
     parser above. */
  const anthropic = getClient()
  let reply: { input?: unknown } | string
  if (anthropic) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      tools: [DISTILL_TOOL],
      tool_choice: { type: 'tool', name: 'distill_result' },
      messages: [{ role: 'user', content: prompt }],
    })
    reply = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use') ?? {}
  } else {
    reply = await sampler!(prompt + SAMPLING_INSTRUCTION, DISTILL_SYSTEM)
  }
  const input = parseVerdict(reply)
  if (!input.has_rule || !input.rule?.trim()) {
    console.log(`[distill] no rule canvas=${canvasId}`)
    return
  }
  const slug = (input.guide_name ?? 'style-notes')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  const proposal = actions.addProposal(canvasId, {
    guideName: actions.GUIDELINE_NAME_RE.test(slug) ? slug : 'style-notes',
    guideTitle: input.guide_title?.trim().slice(0, 80) || undefined,
    rule: input.rule.trim(),
    rationale: input.rationale?.trim() || 'Distilled from recent feedback.',
    basedOn: decisions.map((d) => d.id),
  })
  /* evidence is consumed only when it turns into a proposal — a "no rule yet"
     verdict leaves the decisions in the window so a slow-building pattern is
     never buried. Re-runs only happen on NEW captures, so this cannot loop. */
  actions.markDecisionsDistilled(
    canvasId,
    decisions.map((d) => d.id),
  )
  console.log(`[distill] proposed canvas=${canvasId} guide=${proposal.guideName} rule=${proposal.rule.slice(0, 80)}`)
}
