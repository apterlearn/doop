/**
 * The design team a board card names. Every card lists one or more of these
 * roles and walks them in order, one stage at a time; a connected MCP agent
 * takes whichever stage is queued.
 *
 * A role IS an agent identity: `name` is what shows up in presence, in the
 * activity feed and in @mentions, and colorFor(name) gives it its colour, so
 * two roles never look like the same worker on the canvas. `color` is the
 * role's crew colour, used only to tint its Doop mark.
 */

export interface AgentRole {
  id: string
  /** the identity this agent works under — presence, @mentions, comments */
  name: string
  /** the crew colour from doop.design's team section — tints the role's mark */
  color: string
  /** one line for the picker */
  blurb: string
  /** extra @mention spellings beyond the id and the squashed name */
  aliases?: string[]
}

/** The design roles work is organised by. A human @mentions one in an element
 *  comment and a connected agent working that role picks the note up — the
 *  role is routing vocabulary, not a running agent. */
export const AGENT_ROLES: AgentRole[] = [
  {
    id: 'doop',
    name: 'Doop',
    color: '#E8432E',
    blurb: 'Generalist designer — makes the thing',
    aliases: ['design', 'designer'],
  },
  {
    id: 'ux',
    name: 'UX Lead',
    color: '#2743EE',
    blurb: 'Flow, hierarchy, states, affordances',
    aliases: ['usability'],
  },
  {
    id: 'copy',
    name: 'Copywriter',
    color: '#8B5CF6',
    blurb: 'Headlines, microcopy, labels, CTAs',
    aliases: ['content', 'words'],
  },
  {
    id: 'brand',
    name: 'Brand Compliance',
    color: '#D98E04',
    blurb: 'Palette, type, logo, tone of voice',
    aliases: ['branding'],
  },
  {
    id: 'a11y',
    name: 'Accessibility',
    color: '#0E8FA0',
    blurb: 'Contrast, semantics, focus, target size',
    aliases: ['accessible', 'accessibility'],
  },
  {
    id: 'polish',
    name: 'Visual Polish',
    color: '#0E9F6E',
    blurb: 'Spacing rhythm, alignment, final detail',
    aliases: ['polish', 'detail'],
  },
]

export const DEFAULT_ROLE_ID = 'doop'

const byId = new Map(AGENT_ROLES.map((r) => [r.id, r]))
const byName = new Map(AGENT_ROLES.map((r) => [r.name.toLowerCase(), r]))

export function roleById(id: string | undefined): AgentRole | undefined {
  return id ? byId.get(id) : undefined
}

/** The role an agent name belongs to — undefined for outside agents (MCP). */
export function roleByAgentName(name: string | undefined): AgentRole | undefined {
  return name ? byName.get(name.toLowerCase()) : undefined
}

export function roleName(id: string | undefined): string {
  return roleById(id)?.name ?? roleById(DEFAULT_ROLE_ID)!.name
}

/** Every spelling that addresses a role in a comment: @doop, @UXLead, @ux… */
function mentionsFor(role: AgentRole): string[] {
  return [role.id, role.name.replace(/\s+/g, ''), ...(role.aliases ?? [])].map((m) => m.toLowerCase())
}

/** The role a piece of text @mentions, if any. First mention wins. */
export function mentionedRole(text: string): AgentRole | undefined {
  let best: { role: AgentRole; at: number } | undefined
  for (const role of AGENT_ROLES) {
    for (const mention of mentionsFor(role)) {
      const re = new RegExp(`@${mention}\\b`, 'i')
      const at = text.search(re)
      if (at >= 0 && (!best || at < best.at)) best = { role, at }
    }
  }
  return best?.role
}

/** The connected agent a piece of text @mentions, if any — the live agent
 *  names, not roles (roles resolve through mentionedRole). Longest name first,
 *  so "@Alex Smith" is not cut short to "@Alex"; casing comes from `names`. */
export function mentionedAgent(text: string, names: string[]): string | undefined {
  const candidates = names.filter((n) => n.length > 0).sort((a, b) => b.length - a.length)
  let best: { name: string; at: number } | undefined
  for (const name of candidates) {
    const re = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const at = text.search(re)
    if (at >= 0 && (!best || at < best.at)) best = { name, at }
  }
  return best?.name
}
