import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as actions from '../server/actions.ts'
import { store } from '../server/store.ts'
import { closeDb, initDb } from '../server/db/index.ts'
import * as persist from '../server/db/persist.ts'
import type { Canvas, ServerMessage } from '../shared/types.ts'

/* Canvas-level proposals are persisted, so this file drives the real database:
   a PGlite cluster in a temp directory, migrated at boot exactly as the server
   does. What it proves is the part mocks cannot — that a pending proposal
   survives as a row with the value it replaces, that accepting it applies the
   payload through the setters a human edit uses, and that a decision already
   made (or made on another canvas) is refused rather than replayed. */

const dataRoot = mkdtempSync(path.join(tmpdir(), 'doop-canvas-proposals-'))
const OWNER_ID = 'proposals-owner'
/* the human who reads the review queue, and the agent that proposed into it */
const OWNER = actions.resolveActor({ name: 'Owner', kind: 'user', ownerId: OWNER_ID })
const REVIEWER = { userId: OWNER_ID, agentName: 'Owner' }
const AGENT = { userId: OWNER_ID, agentName: 'ux lead' }

let canvasId = ''
let otherId = ''
let seq = 0
const sent: ServerMessage[] = []

beforeAll(async () => {
  process.chdir(dataRoot)
  await initDb()
})

afterAll(async () => {
  /* the same drain the server runs on shutdown: frame writes are debounced, and
     a pending one would be in flight while the database closes */
  await persist.flush((id) => store.getFrame(id))
  await closeDb()
  process.chdir(tmpdir())
  rmSync(dataRoot, { recursive: true, force: true })
})

beforeEach(() => {
  /* a fresh canvas per case: the proposal rows outlive the in-memory store, so
     a shared canvas id would let one case read the previous case's queue */
  seq += 1
  canvasId = `c-proposals-${seq}`
  otherId = `c-proposals-other-${seq}`
  sent.length = 0
  actions.wire(
    (_id, msg) => sent.push(msg),
    () => {},
    () => {},
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  const main: Canvas = {
    id: canvasId,
    name: 'Proposals',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `${canvasId}-p1`, canvasId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  const other: Canvas = {
    id: otherId,
    name: 'Other canvas',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    pages: [{ id: `${otherId}-p1`, canvasId: otherId, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([main, other])
})

describe('canvas proposals', () => {
  it('stores a pending row with the tokens it replaces, and leaves the canvas alone', async () => {
    actions.setTokens(canvasId, { colors: { ink: '#111110' } }, OWNER)
    const current = store.getCanvas(canvasId)!.tokens
    sent.length = 0

    const proposal = await actions.proposeCanvasChange(canvasId, 'tokens', { colors: { ink: '#333333' } }, AGENT)

    expect(proposal.status).toBe('pending')
    expect(proposal.before).toEqual(current)
    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === proposal.id)!
    expect(stored.status).toBe('pending')
    expect(stored.payload).toEqual({ colors: { ink: '#333333' } })
    expect(stored.before).toEqual(current)
    expect(stored.proposedBy).toBe('ux lead')
    expect(stored.proposedByUser).toBe(OWNER_ID)
    /* nothing lands before a human says so */
    expect(store.getCanvas(canvasId)!.tokens).toEqual(current)
    expect(store.getCanvas(canvasId)!.tokens!.colors.ink).toBe('#111110')
    expect(sent.map((m) => m.type)).toContain('canvasProposal')
  })

  it('applies the payload on accept, and records the note', async () => {
    actions.setTokens(canvasId, { colors: { ink: '#111110' } }, OWNER)
    const next = { colors: { ink: '#333333' }, spacing: [4, 8] }
    const proposal = await actions.proposeCanvasChange(canvasId, 'tokens', next, AGENT)
    sent.length = 0

    const resolved = await actions.resolveCanvasProposal(canvasId, proposal.id, {
      accept: true,
      note: 'matches the new brand sheet',
      actor: REVIEWER,
    })

    expect(resolved.status).toBe('accepted')
    expect(resolved.resolutionNote).toBe('matches the new brand sheet')
    const tokens = store.getCanvas(canvasId)!.tokens!
    expect(tokens.colors).toEqual(next.colors)
    expect(tokens.spacing).toEqual(next.spacing)
    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === proposal.id)!
    expect(stored.status).toBe('accepted')
    expect(stored.resolutionNote).toBe('matches the new brand sheet')
    expect(stored.resolvedAt).toBeGreaterThan(0)
    expect(sent.some((m) => m.type === 'canvasProposal')).toBe(true)
    expect(actions.getActivity(canvasId)[0]!.message).toMatch(/accepted .*design-token proposal/)
  })

  it('leaves the canvas alone on reject, and records why', async () => {
    actions.setTokens(canvasId, { colors: { ink: '#111110' } }, OWNER)
    const current = store.getCanvas(canvasId)!.tokens
    const proposal = await actions.proposeCanvasChange(canvasId, 'tokens', { colors: { ink: '#ff0000' } }, AGENT)

    const resolved = await actions.resolveCanvasProposal(canvasId, proposal.id, {
      accept: false,
      note: 'too loud for a checkout page',
      actor: REVIEWER,
    })

    expect(resolved.status).toBe('rejected')
    expect(store.getCanvas(canvasId)!.tokens).toEqual(current)
    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === proposal.id)!
    expect(stored.status).toBe('rejected')
    expect(stored.resolutionNote).toBe('too loud for a checkout page')
    expect(actions.getActivity(canvasId)[0]!.message).toMatch(/rejected .*design-token proposal/)
  })

  it('refuses a proposal that is not pending', async () => {
    const proposal = await actions.proposeCanvasChange(canvasId, 'tokens', { colors: { ink: '#111110' } }, AGENT)
    await actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER })

    await expect(
      actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER }),
    ).rejects.toThrow(/no pending proposal/)
    expect(store.getCanvas(canvasId)!.tokens!.colors.ink).toBe('#111110')
  })

  it('refuses a proposal made on another canvas', async () => {
    const proposal = await actions.proposeCanvasChange(otherId, 'tokens', { colors: { ink: '#111110' } }, AGENT)

    await expect(
      actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER }),
    ).rejects.toThrow(/no pending proposal/)
    expect(store.getCanvas(canvasId)!.tokens).toBeUndefined()
    expect(store.getCanvas(otherId)!.tokens).toBeUndefined()
    /* it is still waiting on the canvas it belongs to */
    const stored = (await persist.listCanvasProposals(otherId)).find((p) => p.id === proposal.id)!
    expect(stored.status).toBe('pending')
  })

  it('stores a clear as a null payload, and applies it as a clear', async () => {
    actions.setTokens(canvasId, { colors: { ink: '#111110' } }, OWNER)
    const proposal = await actions.proposeCanvasChange(canvasId, 'tokens', null, AGENT)

    /* a clear round-trips as a JSON null — the payload column is nullable, so
       the row holds exactly what the proposer asked for */
    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === proposal.id)!
    expect(stored.payload).toBeNull()
    expect(stored.before).toEqual(store.getCanvas(canvasId)!.tokens)
    expect(store.getCanvas(canvasId)!.tokens!.colors.ink).toBe('#111110')

    await actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER })

    expect(store.getCanvas(canvasId)!.tokens).toBeUndefined()
  })

  it('applies a guide proposal through the ordinary setter', async () => {
    actions.setGuideline(canvasId, 'brand', '# Brand\n\nquiet, no accent colours', OWNER)
    const proposal = await actions.proposeCanvasChange(
      canvasId,
      'guidelines',
      { name: 'brand', markdown: '# Brand\n\nloud, one accent colour' },
      AGENT,
    )

    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === proposal.id)!
    expect(stored.before).toBe('# Brand\n\nquiet, no accent colours')
    expect(store.getGuidelines(canvasId).find((d) => d.name === 'brand')!.markdown).toContain('quiet')

    await actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER })

    expect(store.getGuidelines(canvasId).find((d) => d.name === 'brand')!.markdown).toContain('loud')
  })

  it('applies a breakpoint proposal, and an empty list clears them', async () => {
    const list = [
      { name: 'mobile', min_width: 390 },
      { name: 'desktop', min_width: 1440 },
    ]
    const proposal = await actions.proposeCanvasChange(canvasId, 'breakpoints', list, AGENT)
    expect(proposal.payload).toEqual(list)

    await actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER })
    expect(store.getCanvas(canvasId)!.breakpoints).toEqual(list)

    const clearing = await actions.proposeCanvasChange(canvasId, 'breakpoints', [], AGENT)
    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === clearing.id)!
    expect(stored.before).toEqual(list)

    await actions.resolveCanvasProposal(canvasId, clearing.id, { accept: true, actor: REVIEWER })
    expect(store.getCanvas(canvasId)!.breakpoints).toBeUndefined()
  })

  it('applies a page proposal through the page actions', async () => {
    const before = store.getCanvas(canvasId)!.pages
    const proposal = await actions.proposeCanvasChange(canvasId, 'pages', { op: 'create', name: 'Checkout' }, AGENT)

    const stored = (await persist.listCanvasProposals(canvasId)).find((p) => p.id === proposal.id)!
    expect(stored.before).toEqual(before)
    expect(store.getCanvas(canvasId)!.pages!.map((p) => p.name)).toEqual(['Page 1'])

    await actions.resolveCanvasProposal(canvasId, proposal.id, { accept: true, actor: REVIEWER })

    expect(store.getCanvas(canvasId)!.pages!.map((p) => p.name)).toEqual(['Page 1', 'Checkout'])
    expect(sent.some((m) => m.type === 'pages')).toBe(true)
  })

  it('refuses a payload that does not fit its kind, storing nothing', async () => {
    await expect(
      actions.proposeCanvasChange(canvasId, 'tokens', { colors: { ink: 'blue-ish' } }, AGENT),
    ).rejects.toThrow(/invalid color/)
    await expect(
      actions.proposeCanvasChange(canvasId, 'guidelines', { name: 'Brand!', markdown: 'x' }, AGENT),
    ).rejects.toThrow(/invalid doc name/)
    await expect(
      actions.proposeCanvasChange(canvasId, 'breakpoints', [{ name: 'mobile', min_width: -1 }], AGENT),
    ).rejects.toThrow(/invalid breakpoint width/)
    await expect(
      actions.proposeCanvasChange(canvasId, 'pages', { op: 'delete', pageId: 'nope' }, AGENT),
    ).rejects.toThrow(/no page with id/)
    await expect(
      actions.proposeCanvasChange('no-such-canvas', 'tokens', { colors: { ink: '#111110' } }, AGENT),
    ).rejects.toThrow(/no canvas/)

    expect(await persist.listCanvasProposals(canvasId)).toHaveLength(0)
  })
})
