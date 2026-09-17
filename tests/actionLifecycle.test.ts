import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import * as agentEvents from '../server/agentEvents.ts'
import * as persistModule from '../server/db/persist.ts'
import { store } from '../server/store.ts'
import { DEFAULT_ROLE_ID, roleName } from '../shared/agents.ts'
import type { CanvasVersion } from '../server/db/persist.ts'

/**
 * The action layer's own rules, on the live store: a canvas-version restore
 * that reports the frames it could not put back instead of aborting, and the
 * three lifecycle mutations whose actor has to be the record's own — editing a
 * comment, releasing a claim, withdrawing a question.
 *
 * The store is the live truth these paths work on, and the two snapshot helpers
 * are pure; everything persist writes to the database is stubbed, and a version
 * is read back exactly as `snapshotCanvas` wrote it, so a restore replays what
 * was really frozen.
 */
const savedVersions = vi.hoisted(() => new Map<string, CanvasVersion>())

vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof persistModule>()
  const stubbed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(actual)) {
    stubbed[key] = typeof value === 'function' ? () => undefined : value
  }
  return {
    ...stubbed,
    freezeFrames: actual.freezeFrames,
    releaseFrames: actual.releaseFrames,
    saveCanvasVersion: (version: CanvasVersion) => savedVersions.set(version.id, version),
    getCanvasVersion: async (id: string) => savedVersions.get(id),
  }
})

const AGENT = roleName(DEFAULT_ROLE_ID)
const OWNER = 'lifecycle-owner'

/** Mutations take an Actor, not a bare name: who did this is part of what the
 *  room is told, and the account behind the name is what tells two callers of
 *  the same name apart. */
const human = (name: string, ownerId?: string) => actions.resolveActor({ name, kind: 'user', ownerId })
const agent = (name: string, ownerId?: string) => actions.resolveActor({ name, kind: 'agent', ownerId })

beforeEach(() => {
  actions.wire(
    () => {},
    () => {},
  )
  savedVersions.clear()
})

/** A canvas the way the app makes one, with two frames to roll back. */
function canvasWithTwoFrames(name: string) {
  const canvas = store.createCanvas(name, OWNER)
  const hero = actions.createFrame(canvas.id, { name: 'Hero', html: '<h1>alpha</h1>' }, human('Owner'))!
  const footer = actions.createFrame(canvas.id, { name: 'Footer', html: '<p>alpha</p>' }, human('Owner'))!
  return { canvas, hero, footer }
}

describe('restoring a canvas version around a frame that is refused', () => {
  it('rolls back every frame it can and names the one another agent holds', async () => {
    const { canvas, hero, footer } = canvasWithTwoFrames('Rollback')
    const version = actions.snapshotCanvas(canvas.id, 'manual', 'Owner')!
    actions.updateFrame(hero.id, { html: '<h1>bravo</h1>' }, human('Owner'))
    actions.updateFrame(footer.id, { html: '<p>bravo</p>' }, human('Owner'))
    /* the rival is mid-edit on the footer: rolling the canvas back under its
       hands is what the lock exists to refuse, and refusing it must not cost
       the hero its rollback */
    actions.acquireFrameLock(footer.id, agent('Rival'))

    const result = (await actions.restoreCanvasVersion(canvas.id, version.id, agent('Doop')))!

    expect(result.restored).toBe(1)
    expect(result.created).toBe(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.frame_id).toBe(footer.id)
    expect(result.skipped[0]!.reason).toContain('Rival')
    expect(store.getFrame(hero.id)!.html).toBe('<h1>alpha</h1>')
    expect(store.getFrame(footer.id)!.html).toBe('<p>bravo</p>')
  })

  it('leaves a frame its user locked alone, naming the lock', async () => {
    const { canvas, hero, footer } = canvasWithTwoFrames('Locked rollback')
    const version = actions.snapshotCanvas(canvas.id, 'manual', 'Owner')!
    actions.updateFrame(hero.id, { html: '<h1>bravo</h1>' }, human('Owner'))
    actions.updateFrame(footer.id, { html: '<p>bravo</p>' }, human('Owner'))
    actions.updateFrame(footer.id, { locked: true }, human('Owner'))

    const result = (await actions.restoreCanvasVersion(canvas.id, version.id, agent('Doop')))!

    expect(result.restored).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.frame_id).toBe(footer.id)
    expect(result.skipped[0]!.reason).toContain('Footer')
    expect(store.getFrame(hero.id)!.html).toBe('<h1>alpha</h1>')
    expect([store.getFrame(footer.id)!.html, store.getFrame(footer.id)!.locked]).toEqual(['<p>bravo</p>', true])
  })

  it('reports the frames the canvas review policy gates, and only the ones it would have written', async () => {
    const { canvas, hero, footer } = canvasWithTwoFrames('Reviewed rollback')
    const version = actions.snapshotCanvas(canvas.id, 'manual', 'Owner')!
    actions.updateFrame(hero.id, { html: '<h1>bravo</h1>' }, human('Owner'))
    store.setReviewPolicy(canvas.id, 'destructive', ['restore_canvas_version'])

    const result = (await actions.restoreCanvasVersion(canvas.id, version.id, agent('Doop')))!

    expect(result.restored).toBe(0)
    /* the footer still matches the snapshot, so nothing was refused for it */
    expect(result.skipped.map((s) => s.frame_id)).toEqual([hero.id])
    expect(result.skipped[0]!.reason).toContain('review')
    expect(store.getFrame(hero.id)!.html).toBe('<h1>bravo</h1>')
    expect(store.getFrame(footer.id)!.html).toBe('<p>alpha</p>')
  })

  it('answers undefined for a version that is not this canvas’s, and for one that does not exist', async () => {
    const { canvas } = canvasWithTwoFrames('Unknown version')
    const other = canvasWithTwoFrames('Someone else’s')
    const version = actions.snapshotCanvas(other.canvas.id, 'manual', 'Owner')!

    expect(await actions.restoreCanvasVersion(canvas.id, version.id, agent('Doop'))).toBeUndefined()
    expect(await actions.restoreCanvasVersion(canvas.id, 'no-such-version', agent('Doop'))).toBeUndefined()
  })

  it('counts a frame the snapshot revives as both restored and created', async () => {
    const { canvas, hero, footer } = canvasWithTwoFrames('Revived')
    const version = actions.snapshotCanvas(canvas.id, 'manual', 'Owner')!
    actions.deleteFrame(footer.id, human('Owner'))
    actions.updateFrame(hero.id, { html: '<h1>bravo</h1>' }, human('Owner'))

    const result = (await actions.restoreCanvasVersion(canvas.id, version.id, agent('Doop')))!

    expect([result.restored, result.created, result.skipped]).toEqual([2, 1, []])
    /* back under the id its comments and history point at, not a fresh one */
    expect(store.getFrame(footer.id)!.html).toBe('<p>alpha</p>')
    expect(store.getFrame(hero.id)!.html).toBe('<h1>alpha</h1>')
  })
})

describe('editing a comment', () => {
  it('rewrites the text for its author and refuses everyone else', () => {
    const { hero } = canvasWithTwoFrames('Editing')
    const note = actions.addElementComment(
      hero.id,
      { selector: '.hero h1', snippet: '<h1>alpha</h1>', text: 'Too small' },
      human('alice'),
      'alice',
    )!

    const edited = actions.updateElementComment(note.id, '  Too large  ', human('alice'))!

    expect(edited.text).toBe('Too large')
    expect(actions.findComment(note.id)!.text).toBe('Too large')
    /* the same pin, not a new one: the id, the anchor and its place in the
       thread all stay */
    expect([edited.id, edited.selector, edited.at]).toEqual([note.id, note.selector, note.at])

    expect(() => actions.updateElementComment(note.id, 'Mine now', human('bob'))).toThrow(actions.NotCommentAuthorError)
    expect(actions.findComment(note.id)!.text).toBe('Too large')
    expect(actions.updateElementComment('no-such-comment', 'Hello', human('alice'))).toBeUndefined()
    /* nothing to store is refused the way an empty comment is, and the note
       keeps what it said */
    expect(actions.updateElementComment(note.id, '   ', human('alice'))).toBeUndefined()
    expect(actions.findComment(note.id)!.text).toBe('Too large')
  })

  it('keeps two people of the same name apart by the account that wrote it', () => {
    const { hero } = canvasWithTwoFrames('Accounts')
    const alice = human('alice', 'account-1')
    const namesake = human('alice', 'account-2')
    const note = actions.addElementComment(
      hero.id,
      { selector: '.hero h1', snippet: '<h1>alpha</h1>', text: 'Too small' },
      alice,
      'account-1',
    )!

    expect(() => actions.updateElementComment(note.id, 'Mine now', namesake)).toThrow(actions.NotCommentAuthorError)
    expect(actions.updateElementComment(note.id, 'Too large', alice)!.text).toBe('Too large')
  })
})

describe('releasing a claim', () => {
  it('gives the note back for the agent holding it and refuses anyone else', () => {
    const { canvas, hero } = canvasWithTwoFrames('Claims')
    actions.addElementComment(
      hero.id,
      { selector: '.hero h1', snippet: '<h1>alpha</h1>', text: `@${DEFAULT_ROLE_ID} make it 48px` },
      human('alice'),
      'alice',
    )
    const [claimed] = actions.takeAgentCommentsFor(canvas.id, AGENT, 'alice', 'account-1')
    expect([claimed!.claimedBy, claimed!.claimedByOwner]).toEqual([AGENT, 'account-1'])

    /* the same name on another account did not take it, so it cannot give it
       back */
    expect(() => actions.unclaimComment(claimed!.id, agent(AGENT, 'account-2'))).toThrow(
      actions.NotCommentClaimantError,
    )
    expect(actions.findComment(claimed!.id)!.claimedBy).toBe(AGENT)

    const released = actions.unclaimComment(claimed!.id, agent(AGENT, 'account-1'))!

    expect([released.claimedBy, released.claimedByOwner, released.claimedAt]).toEqual([undefined, undefined, undefined])
    /* back in the queue: the claim path picks it up again */
    expect(actions.takeAgentCommentsFor(canvas.id, AGENT, 'alice').map((c) => c.id)).toEqual([claimed!.id])
    expect(() => actions.unclaimComment(claimed!.id, agent('Rival'))).toThrow(actions.NotCommentClaimantError)
    expect(actions.unclaimComment('no-such-comment', agent(AGENT))).toBeUndefined()
  })
})

describe('withdrawing a question', () => {
  it('closes the asker’s own question and refuses everyone else', () => {
    const { canvas } = canvasWithTwoFrames('Questions')
    const asked = actions.askQuestion(canvas.id, { text: 'Which palette direction?', waitSeconds: 60 }, agent('Doop'))!
    expect(asked.status).toBe('open')

    expect(() => actions.withdrawQuestion(asked.id, agent('Rival'))).toThrow(actions.NotQuestionAskerError)
    expect(actions.findQuestion(asked.id)!.status).toBe('open')

    const withdrawn = actions.withdrawQuestion(asked.id, agent('Doop'))!

    expect(withdrawn.status).toBe('withdrawn')
    expect(actions.getQuestions(canvas.id, 'open')).toEqual([])
    /* closed to answering, and withdrawing it twice reports it as it stands */
    expect(actions.answerQuestion(canvas.id, asked.id, 'Go bold', human('alice'))!.status).toBe('withdrawn')
    expect(actions.withdrawQuestion(asked.id, agent('Doop'))!.status).toBe('withdrawn')
    expect(actions.withdrawQuestion('no-such-question', agent('Doop'))).toBeUndefined()
  })

  it('wakes a parked wait with the same event an answer rides', async () => {
    const { canvas } = canvasWithTwoFrames('Parked')
    const asked = actions.askQuestion(canvas.id, { text: 'Which palette direction?', waitSeconds: 60 }, agent('Doop'))!
    const parked = agentEvents.wait(canvas.id, {
      agentName: 'Doop',
      cursor: 0,
      timeoutMs: 500,
      kinds: ['question_answer'],
    })

    actions.withdrawQuestion(asked.id, agent('Doop'))

    expect(await parked).toMatchObject([
      { kind: 'question_answer', data: { questionId: asked.id, withdrawn: true, by: 'Doop' } },
    ])
  })
})
