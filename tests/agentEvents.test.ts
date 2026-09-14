import { describe, expect, it } from 'vitest'
import * as agentEvents from '../server/agentEvents.ts'
import type { AgentEvent } from '../shared/types.ts'

/** A comment event as postComment pushes it: `targetAgent` is whatever the
 *  human's @mention named — a ROLE name for `@a11y`, or an agent's own name
 *  for `@Claude`. */
function commentEvent(targetAgent?: string): AgentEvent {
  return {
    seq: 1,
    at: Date.now(),
    kind: 'comment',
    ...(targetAgent ? { targetAgent } : {}),
    data: { commentId: 'c1', text: 'the heading contrast is too low' },
  }
}

/** A fresh canvas id per case: the bus is module-level state. */
let n = 0
const canvas = () => `canvas-${++n}`

describe('addressing a parked agent', () => {
  it('wakes an agent working the role a human @mentioned', () => {
    /* the human clicked @a11y, which stores the role's NAME — an MCP agent
       with a name of its own must still be woken, or the only channel that
       reaches it between calls goes silent */
    expect(agentEvents.addressedTo(commentEvent('Accessibility'), { agentName: 'Claude', role: 'a11y' })).toBe(true)
    /* either spelling of the role */
    expect(agentEvents.addressedTo(commentEvent('a11y'), { agentName: 'Claude', role: 'a11y' })).toBe(true)
    /* by id or by name */
    expect(agentEvents.addressedTo(commentEvent('Accessibility'), { agentName: 'Claude', role: 'Accessibility' })).toBe(
      true,
    )
  })

  it('still wakes an agent @mentioned by its own name', () => {
    expect(agentEvents.addressedTo(commentEvent('Claude'), { agentName: 'Claude', role: 'a11y' })).toBe(true)
  })

  it('leaves an agent alone when the note is for another role', () => {
    expect(agentEvents.addressedTo(commentEvent('Accessibility'), { agentName: 'Claude', role: 'copy' })).toBe(false)
    /* declaring no role is not a licence to see everything */
    expect(agentEvents.addressedTo(commentEvent('Accessibility'), { agentName: 'Claude' })).toBe(false)
  })

  it('treats an agent whose own name is a role as that role', () => {
    /* a solo worker that connected as "a11y" keeps working with no role arg */
    expect(agentEvents.addressedTo(commentEvent('Accessibility'), { agentName: 'a11y' })).toBe(true)
  })

  it('delivers an unaddressed event to everyone', () => {
    expect(agentEvents.addressedTo(commentEvent(), { agentName: 'Claude' })).toBe(true)
    expect(agentEvents.addressedTo(commentEvent(), { agentName: 'Claude', role: 'a11y' })).toBe(true)
  })
})

describe('wait_for_events wake-up', () => {
  it('resolves on a note addressed to the role the agent is working', async () => {
    const id = canvas()
    const parked = agentEvents.wait(id, { agentName: 'Claude', role: 'a11y', cursor: 0, timeoutMs: 5000 })
    agentEvents.push(id, { kind: 'comment', targetAgent: 'Accessibility', data: { commentId: 'c1' } })
    const events = await parked
    expect(events.map((e) => e.kind)).toEqual(['comment'])
  })

  it('resolves for the role an agent declares by name', async () => {
    const id = canvas()
    const parked = agentEvents.wait(id, { agentName: 'Claude', role: 'Accessibility', cursor: 0, timeoutMs: 5000 })
    agentEvents.push(id, { kind: 'comment', targetAgent: 'Accessibility', data: {} })
    expect((await parked).length).toBe(1)
  })

  it('times out rather than waking for a role the agent is not working', async () => {
    const id = canvas()
    const parked = agentEvents.wait(id, { agentName: 'Claude', role: 'copy', cursor: 0, timeoutMs: 30 })
    agentEvents.push(id, { kind: 'comment', targetAgent: 'Accessibility', data: {} })
    expect(await parked).toEqual([])
  })

  it('returns an already-pending match without parking', async () => {
    const id = canvas()
    agentEvents.push(id, { kind: 'comment', targetAgent: 'Accessibility', data: {} })
    const events = await agentEvents.wait(id, { agentName: 'Claude', role: 'a11y', cursor: 0, timeoutMs: 5000 })
    expect(events.length).toBe(1)
  })

  it('does not re-deliver an event before the cursor', async () => {
    const id = canvas()
    agentEvents.push(id, { kind: 'comment', targetAgent: 'Accessibility', data: {} })
    const from = agentEvents.cursor(id)
    const parked = agentEvents.wait(id, { agentName: 'Claude', role: 'a11y', cursor: from, timeoutMs: 30 })
    expect(await parked).toEqual([])
  })
})
