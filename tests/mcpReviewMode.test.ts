import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { buildMcpServer } from '../server/mcp.ts'
import { store } from '../server/store.ts'
import type { Canvas, CanvasProposal, Frame } from '../shared/types.ts'

/* Review-mode MCP tools run against the real actions machinery: persist and
   broadcasts are stubbed, the proposal state is real. Canvas-level
   proposals are the one thing the actions layer reads back through persist, so
   the stub keeps them in an array — the row's semantics (upsert on save,
   resolve in place) without a database. */
vi.mock('../server/db/persist.ts', () => {
  const canvasProposals: CanvasProposal[] = []
  return {
    getUserEmail: async () => undefined,
    getNotificationPrefs: async () => new Map(),
    saveNotificationPref: () => {},
    pruneRunEvents: () => {},
    saveRunEvent: () => {},
    saveQuestion: () => {},
    saveFrameProposal: () => {},
    saveComment: () => {},
    saveActivity: () => {},
    saveDecision: () => {},
    saveProposal: () => {},
    saveFrame: () => {},
    deleteFrame: () => {},
    saveCanvas: () => {},
    savePage: () => {},
    saveCanvasProposal: async (proposal: CanvasProposal) => {
      const at = canvasProposals.findIndex((row) => row.id === proposal.id)
      if (at === -1) canvasProposals.push({ ...proposal })
      else canvasProposals[at] = { ...canvasProposals[at]!, ...proposal }
    },
    listCanvasProposals: async (canvasId: string, opts: { status?: CanvasProposal['status'] } = {}) =>
      canvasProposals
        .filter((row) => row.canvasId === canvasId && (opts.status === undefined || row.status === opts.status))
        .sort((a, b) => b.createdAt - a.createdAt),
    resolveCanvasProposal: async (
      id: string,
      patch: { status: CanvasProposal['status']; note?: string; resolvedAt: number },
    ) => {
      const row = canvasProposals.find((proposal) => proposal.id === id)
      if (!row) return
      row.status = patch.status
      if (patch.note) row.resolutionNote = patch.note
      row.resolvedAt = patch.resolvedAt
    },
    /* the ship gate reads the newest stored review per frame; nothing is
       verified here, which is the state the gate refuses */
    listFrameReviews: async () => [],
    saveFrameReview: () => {},
    saveRelease: () => {},
  }
})

const OWNER_ID = 'owner-1'

let canvas: Canvas
let frame: Frame

function wireBroadcasts() {
  actions.wire(
    () => {},
    () => {},
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  // hydrateLogs only overwrites the canvases it is given, so each case works
  // on its own canvas — a shared one would carry the previous case's state
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  wireBroadcasts()
  canvas = store.createCanvas(`review-${Math.random().toString(36).slice(2, 8)}`, OWNER_ID)
  frame = store.createFrame(
    canvas.id,
    { name: 'Hero', html: '<html><body style="background:#fff"><h1>Hi</h1></body></html>', width: 640, height: 480 },
    'alice',
  )!
})

async function connect() {
  const server = buildMcpServer('Test Owner', OWNER_ID)
  const client = new Client({ name: 'doop-review-test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const raw = result.content?.find((b) => b.type === 'text')?.text ?? ''
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* plain text result */
  }
  return { parsed, raw, isError: result.isError }
}

describe('review mode', () => {
  it('off by default: set_frame_html writes directly', async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'set_frame_html', {
      frame_id: frame.id,
      html: '<html><body><h1>direct</h1></body></html>',
      agent_name: 'ux lead',
    })
    expect(res.isError).toBeFalsy()
    await close()
  })

  it('on: set_frame_html is refused with the propose path named', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const res = await callTool(client, 'set_frame_html', {
      frame_id: frame.id,
      html: '<html><body><h1>overwritten</h1></body></html>',
      agent_name: 'ux lead',
    })
    expect(res.isError).toBe(true)
    expect((res.parsed as { error: { code: string } }).error.code).toBe('unsupported')
    await close()
  })

  it('on: propose_frame_html is pending, and accept lands the change', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const proposed = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body style="background:#eee"><h1>Proposed</h1></body></html>',
      summary: 'swap the hero copy',
      agent_name: 'ux lead',
    })
    expect(proposed.isError).toBeFalsy()
    const { proposal_id: proposalId, status } = proposed.parsed as { proposal_id: string; status: string }
    expect(status).toBe('pending')
    await close()

    const accepted = actions.resolveFrameProposal(
      canvas.id,
      proposalId,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    expect(accepted?.status).toBe('accepted')
    expect(store.getFrame(frame.id)?.html).toContain('Proposed')
  })

  it('accepting after the frame moved again marks the proposal stale', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const proposed = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body><p>v2-proposed</p></body></html>',
      summary: 'refresh hero',
      agent_name: 'ux lead',
    })
    const { proposal_id: proposalId } = proposed.parsed as { proposal_id: string }
    await close()

    // the frame moves on while the proposal is pending
    store.updateFrame(frame.id, { html: '<html><body><p>human edit</p></body></html>' }, 'alice')

    const accepted = actions.resolveFrameProposal(
      canvas.id,
      proposalId,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    expect(accepted?.status).toBe('stale')
    expect(store.getFrame(frame.id)?.html).toContain('human edit')
  })

  it('rejecting with a note carries it back through list_change_proposals', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const proposed = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body><p>too loud</p></body></html>',
      summary: 'swap the hero copy',
      agent_name: 'ux lead',
    })
    const { proposal_id: proposalId } = proposed.parsed as { proposal_id: string }

    const rejected = actions.resolveFrameProposal(
      canvas.id,
      proposalId,
      false,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
      { note: 'too busy — keep the quiet hero' },
    )
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.resolutionNote).toBe('too busy — keep the quiet hero')

    const listed = await callTool(client, 'list_change_proposals', {
      canvas_id: canvas.id,
      status: 'rejected',
      agent_name: 'ux lead',
    })
    const { proposals } = listed.parsed as {
      proposals: { proposal_id: string; resolution_note?: string; base_updated_at?: string }[]
    }
    const row = proposals.find((p) => p.proposal_id === proposalId)!
    expect(row.resolution_note).toBe('too busy — keep the quiet hero')
    expect(typeof row.base_updated_at).toBe('string')
    /* the rejection really did not land the html */
    expect(store.getFrame(frame.id)?.html).toContain('<h1>Hi</h1>')
    await close()
  })

  it('force-accepting a stale proposal lands the html and marks it accepted', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const proposed = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body><p>forced</p></body></html>',
      summary: 'refresh hero',
      agent_name: 'ux lead',
    })
    const { proposal_id: proposalId } = proposed.parsed as { proposal_id: string }
    await close()

    /* the frame moves on while the proposal is pending */
    store.updateFrame(frame.id, { html: '<html><body><p>human edit</p></body></html>' }, 'alice')

    const accepted = actions.resolveFrameProposal(
      canvas.id,
      proposalId,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
      { force: true },
    )
    expect(accepted?.status).toBe('accepted')
    expect(store.getFrame(frame.id)?.html).toContain('forced')
  })

  it('review mode off: propose tools are refused', async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'propose_frame_html', {
      canvas_id: canvas.id,
      frame_id: frame.id,
      html: '<html><body><p>x</p></body></html>',
      summary: 'no-op',
      agent_name: 'ux lead',
    })
    expect(res.isError).toBe(true)
    expect((res.parsed as { error: { code: string } }).error.code).toBe('unsupported')
    await close()
  })

  it('on: every write path is refused, including the ones with no early gate', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const { client, close } = await connect()
    const page = store.getCanvas(canvas.id)!.pages![0]!
    const writes: [string, Record<string, unknown>][] = [
      ['set_frame_html', { frame_id: frame.id, html: '<html><body><p>x</p></body></html>' }],
      ['append_frame_html', { frame_id: frame.id, html_chunk: '<p>streamed</p>', start: true, done: true }],
      ['edit_frame_html', { frame_id: frame.id, old_str: '<h1>Hi</h1>', new_str: '<h1>Changed</h1>' }],
      ['update_frame', { frame_id: frame.id, name: 'Renamed' }],
      ['duplicate_frame', { frame_id: frame.id }],
      ['move_frame', { frame_id: frame.id, page: page.name }],
      ['delete_frame', { frame_id: frame.id }],
      ['create_frame', { canvas_id: canvas.id, name: 'New', html: '<html><body>n</body></html>' }],
      ['create_page', { canvas_id: canvas.id, name: 'Page 2' }],
      ['rename_page', { page_id: page.id, name: 'Renamed page' }],
      ['set_tokens', { canvas_id: canvas.id, tokens: { colors: { ink: '#111111' } } }],
      ['set_guidelines', { canvas_id: canvas.id, name: 'brand', markdown: '# Brand' }],
      ['save_decision', { canvas_id: canvas.id, decision: 'keep it dark' }],
      ['add_comment', { frame_id: frame.id, selector: 'h1', text: 'note' }],
    ]
    for (const [name, args] of writes) {
      const res = await callTool(client, name, { ...args, agent_name: 'ux lead' })
      expect(res.isError, `${name} must be refused in review mode`).toBe(true)
      expect((res.parsed as { error: { code: string } }).error.code, name).toBe('unsupported')
    }
    /* nothing landed */
    expect(store.getFrame(frame.id)?.name).toBe('Hero')
    expect(store.getFrame(frame.id)?.html).toContain('<h1>Hi</h1>')
    expect(store.getCanvas(canvas.id)?.tokens).toBeUndefined()
    expect(actions.getComments(canvas.id)).toHaveLength(0)
    await close()
  })

  it('on: a human write still lands', async () => {
    actions.setCanvasReviewMode(
      canvas.id,
      true,
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const human = actions.resolveActor({ name: 'alice', kind: 'user', ownerId: OWNER_ID })
    const updated = actions.updateFrame(frame.id, { html: '<html><body><p>human</p></body></html>' }, human)
    expect(updated?.html).toContain('human')
  })
})

describe('canvas-level proposals', () => {
  const ownerActor = () => actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID })

  it('propose → list → resolve over MCP', async () => {
    actions.setCanvasReviewMode(canvas.id, true, ownerActor())
    const { client, close } = await connect()
    try {
      const proposed = await callTool(client, 'propose_canvas_change', {
        canvas_id: canvas.id,
        kind: 'tokens',
        payload: { colors: { ink: '#111111' } },
        summary: 'one ink, on the record',
        agent_name: 'ux lead',
      })
      expect(proposed.isError).toBeFalsy()
      const {
        proposal_id: proposalId,
        kind,
        status,
      } = proposed.parsed as {
        proposal_id: string
        kind: string
        status: string
      }
      expect(kind).toBe('tokens')
      expect(status).toBe('pending')
      /* nothing touched the canvas yet — that is the whole point of the queue */
      expect(store.getCanvas(canvas.id)?.tokens).toBeUndefined()

      const listed = await callTool(client, 'list_canvas_proposals', {
        canvas_id: canvas.id,
        status: 'pending',
        agent_name: 'ux lead',
      })
      const { proposals } = listed.parsed as {
        proposals: { proposal_id: string; kind: string; before: unknown; resolution_note?: string }[]
      }
      expect(proposals.map((entry) => entry.proposal_id)).toEqual([proposalId])
      expect(proposals[0]!.kind).toBe('tokens')
      expect(proposals[0]!.before).toBeNull()

      const resolved = await callTool(client, 'resolve_canvas_proposal', {
        canvas_id: canvas.id,
        proposal_id: proposalId,
        action: 'accept',
        note: 'good call',
        agent_name: 'owner',
      })
      expect(resolved.isError).toBeFalsy()
      expect((resolved.parsed as { status: string }).status).toBe('accepted')
      /* accepting applied it through the ordinary setter */
      expect(store.getCanvas(canvas.id)?.tokens).toMatchObject({ colors: { ink: '#111111' } })

      const after = await callTool(client, 'list_canvas_proposals', {
        canvas_id: canvas.id,
        status: 'accepted',
        agent_name: 'ux lead',
      })
      const accepted = (after.parsed as { proposals: { proposal_id: string; resolution_note?: string }[] }).proposals
      expect(accepted).toHaveLength(1)
      expect(accepted[0]!.resolution_note).toBe('good call')

      /* a resolved proposal is not a replayable command */
      const again = await callTool(client, 'resolve_canvas_proposal', {
        canvas_id: canvas.id,
        proposal_id: proposalId,
        action: 'reject',
        agent_name: 'owner',
      })
      expect(again.isError).toBe(true)
      expect((again.parsed as { error: { code: string } }).error.code).toBe('not_found')
    } finally {
      await close()
    }
  })

  it('refuses a canvas-level proposal while review mode is off', async () => {
    const { client, close } = await connect()
    try {
      const res = await callTool(client, 'propose_canvas_change', {
        canvas_id: canvas.id,
        kind: 'breakpoints',
        payload: [{ name: 'mobile', min_width: 390 }],
        agent_name: 'ux lead',
      })
      expect(res.isError).toBe(true)
      expect((res.parsed as { error: { code: string } }).error.code).toBe('unsupported')
      expect(store.getCanvas(canvas.id)?.breakpoints).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('rejects a payload its kind could not apply', async () => {
    actions.setCanvasReviewMode(canvas.id, true, ownerActor())
    const { client, close } = await connect()
    try {
      const res = await callTool(client, 'propose_canvas_change', {
        canvas_id: canvas.id,
        kind: 'tokens',
        payload: { colors: { ink: 'not-a-colour' } },
        agent_name: 'ux lead',
      })
      expect(res.isError).toBe(true)
      expect((res.parsed as { error: { code: string } }).error.code).toBe('invalid_input')
    } finally {
      await close()
    }
  })
})

describe('the ship gate', () => {
  it('refuses an unverified canvas, and force: true ships it anyway', async () => {
    const { client, close } = await connect()
    try {
      /* the seeded frame has never been reviewed, so the canvas is not
         verified end to end — whoever wrote the frame */
      const refused = await callTool(client, 'publish_canvas', {
        canvas_id: canvas.id,
        category: 'website',
        agent_name: 'ux lead',
      })
      expect(refused.isError).toBe(true)
      const refusal = refused.parsed as { error: { code: string; message: string; frames?: { name: string }[] } }
      expect(refusal.error.code).toBe('conflict')
      expect(refusal.error.message).toContain('review_canvas')
      expect(refusal.error.message).toContain('force: true')
      expect(refusal.error.frames?.map((entry) => entry.name)).toEqual(['Hero'])
      expect(store.getCanvas(canvas.id)?.publishedAt).toBeUndefined()

      const forced = await callTool(client, 'publish_canvas', {
        canvas_id: canvas.id,
        category: 'website',
        force: true,
        agent_name: 'ux lead',
      })
      expect(forced.isError, forced.raw).toBeFalsy()
      expect(store.getCanvas(canvas.id)?.publishedAt).toBeDefined()

      /* the gate is on every ship path, not just this one */
      const release = await callTool(client, 'create_release', {
        canvas_id: canvas.id,
        agent_name: 'ux lead',
      })
      expect(release.isError).toBe(true)
      expect((release.parsed as { error: { code: string } }).error.code).toBe('conflict')
    } finally {
      await close()
    }
  })
})

describe('ask_human', () => {
  it('returns the answer when a human answers during the wait', { timeout: 20000 }, async () => {
    const { client, close } = await connect()
    const pending = callTool(client, 'ask_human', {
      canvas_id: canvas.id,
      text: 'dark or light palette?',
      wait_seconds: 10,
      agent_name: 'ux lead',
    })
    // the tool parks in the wait; poll the question log with vi.waitFor,
    // then answer — the parked tool resolves through the event bus
    await vi.waitFor(() => expect(actions.getQuestions(canvas.id).length).toBe(1))
    const question = actions.getQuestions(canvas.id)[0]!
    expect(question.text).toBe('dark or light palette?')
    actions.answerQuestion(
      canvas.id,
      question.id,
      'use the dark palette',
      actions.resolveActor({ name: 'owner', kind: 'user', ownerId: OWNER_ID }),
    )
    const res = await pending
    expect(res.parsed).toMatchObject({ status: 'answered', answer: 'use the dark palette' })
    await close()
  })

  it('times out open, and get_answers then returns the question', { timeout: 20000 }, async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'ask_human', {
      canvas_id: canvas.id,
      text: 'which logo?',
      wait_seconds: 0,
      agent_name: 'ux lead',
    })
    expect(res.isError).toBeFalsy()
    expect(res.parsed).toMatchObject({ status: 'open' })
    const answers = await callTool(client, 'get_answers', { canvas_id: canvas.id, agent_name: 'ux lead' })
    expect(answers.raw).toContain('which logo?')
    await close()
  })
})

describe('wait_for_events', () => {
  it('returns a comment pushed while parked, with a cursor', { timeout: 30000 }, async () => {
    const { client, close } = await connect()
    const cursor0 = (
      await callTool(client, 'wait_for_events', {
        canvas_id: canvas.id,
        timeout_seconds: 5,
        agent_name: 'ux lead',
      })
    ).parsed as { cursor: number; timed_out: boolean }
    /* the parked call blocks in real time — an integration-style wait that
       cannot be faked, so this suite needs the extended timeout */
    expect(cursor0.timed_out).toBe(true)

    const pending = callTool(client, 'wait_for_events', {
      canvas_id: canvas.id,
      cursor: cursor0.cursor,
      timeout_seconds: 10,
      agent_name: 'ux lead',
    })
    /* the human's channel is a comment that @mentions the agent's role */
    const text = '@ux lead make the hero bigger'
    const comment = actions.addElementComment(
      frame.id,
      { selector: 'h1', snippet: '<h1>Hi</h1>', text },
      actions.resolveActor({ name: 'alice', kind: 'user', ownerId: OWNER_ID }),
    )
    /* the mention is what routes the note to the role the parked agent fills */
    expect(comment?.targetAgent).toBe('UX Lead')

    const res = await pending
    const parsed = res.parsed as {
      cursor: number
      timed_out: boolean
      events: { seq: number; kind: string; summary: string }[]
    }
    /* the comment arrives while parked, and the cursor moves past it */
    expect(parsed.timed_out).toBe(false)
    expect(
      parsed.events.map((e) => [e.kind, e.summary]),
      'events seen while parked',
    ).toContainEqual(['comment', text])
    expect(parsed.cursor).toBe(parsed.events[parsed.events.length - 1]!.seq)
    expect(parsed.cursor).toBeGreaterThan(cursor0.cursor)
    await close()
  })

  /* The realistic shape: an MCP agent has a name of its own and works a role.
     Humans address work to ROLES, so without the role argument the parked call
     times out while the note meant for it sits unread. The test above passes
     on the name-IS-a-role compat path, so it would stay green even if `role`
     were dropped from the tool entirely — this is the coverage for it. */
  it('wakes an agent that parked under the role it works', { timeout: 30000 }, async () => {
    const { client, close } = await connect()
    const cursor0 = (
      await callTool(client, 'wait_for_events', {
        canvas_id: canvas.id,
        timeout_seconds: 5,
        agent_name: 'Claude',
        role: 'a11y',
      })
    ).parsed as { cursor: number; timed_out: boolean }
    expect(cursor0.timed_out).toBe(true)

    const pending = callTool(client, 'wait_for_events', {
      canvas_id: canvas.id,
      cursor: cursor0.cursor,
      timeout_seconds: 10,
      agent_name: 'Claude',
      role: 'a11y',
    })
    /* the human clicked @a11y, which stores the role's NAME — not "Claude" */
    const text = '@a11y check the heading contrast'
    const comment = actions.addElementComment(
      frame.id,
      { selector: 'h1', snippet: '<h1>Hi</h1>', text },
      actions.resolveActor({ name: 'alice', kind: 'user', ownerId: OWNER_ID }),
    )
    expect(comment?.targetAgent).toBe('Accessibility')

    const parsed = (await pending).parsed as {
      timed_out: boolean
      events: { kind: string; summary: string }[]
    }
    expect(parsed.timed_out, 'a role mention must wake the agent working that role').toBe(false)
    expect(parsed.events.map((e) => [e.kind, e.summary])).toContainEqual(['comment', text])
    await close()
  })

  it('refuses a role that does not exist', { timeout: 20000 }, async () => {
    const { client, close } = await connect()
    const res = await callTool(client, 'wait_for_events', {
      canvas_id: canvas.id,
      timeout_seconds: 5,
      agent_name: 'Claude',
      role: 'wizard',
    })
    expect(res.isError).toBe(true)
    expect(res.raw).toContain('wizard')
    await close()
  })
})
