import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { store } from '../server/store.ts'
import type { Canvas, ServerMessage } from '../shared/types.ts'

/* A design stream is visible on the frame as a marching border and a chip. What
   ends it, and why, has to reach the room: a border that vanishes with no
   explanation, or lingers after the agent is gone, is worse than no indicator. */

vi.mock('../server/db/persist.ts', () => ({
  getUserEmail: async () => undefined,
  getNotificationPrefs: async () => new Map(),
  saveNotificationPref: () => {},
  pruneRunEvents: () => {},
  saveRunEvent: () => {},
  saveQuestion: () => {},
  saveFrameProposal: () => {},
  hydrate: () => {},
  saveCanvas: () => {},
  saveCanvasCopy: () => {},
  saveFrame: () => {},
  deleteFrame: () => {},
  savePage: () => {},
  deletePage: () => {},
  setFramePage: () => {},
  saveComment: () => {},
  saveActivity: () => {},
  saveDecision: () => {},
  saveProposal: () => {},
  saveGuideline: () => {},
  saveGuidelineVersion: () => {},
  deleteGuideline: () => {},
  saveMember: () => {},
  deleteMember: () => {},
  saveReference: () => {},
  deleteReference: () => {},
  deleteCanvas: () => {},
  saveFrameReview: async () => {},
  listFrameReviews: async () => [],
  listFrameVersions: async () => [],
  getFrameVersion: async () => undefined,
}))

const CANVAS_ID = 'c-stream'
const FRAME_ID = 'f-stream'

function seed(): Canvas {
  const canvas: Canvas = {
    id: CANVAS_ID,
    name: 'Stream',
    ownerId: 'stream-owner',
    createdAt: 0,
    updatedAt: 0,
    frames: [
      {
        id: FRAME_ID,
        canvasId: CANVAS_ID,
        name: 'Hero',
        x: 0,
        y: 0,
        width: 1200,
        height: 900,
        html: '',
        createdAt: 0,
        updatedAt: 1,
        updatedBy: 'alice',
        pageId: 'p-stream',
      },
    ],
    pages: [{ id: 'p-stream', canvasId: CANVAS_ID, name: 'Page 1', position: 0, createdAt: 0, updatedAt: 0 }],
  }
  store.init([canvas])
  return canvas
}

let room: ServerMessage[] = []
const agent = () => actions.resolveActor({ name: 'Claude', kind: 'agent', ownerId: 'stream-owner' })
const human = () => actions.resolveActor({ name: 'alice', kind: 'user' })

const streamEnds = () => room.filter((m) => m.type === 'frame:streaming' && !m.active)

beforeEach(() => {
  room = []
  actions.wire(
    (_canvasId, msg) => room.push(msg),
    () => {},
  )
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  seed()
})

describe('stream end reporting', () => {
  it('says the design was delivered when the agent finishes', () => {
    actions.appendFrameHtml(FRAME_ID, '<section>one</section>', agent(), { start: true })
    room = []
    actions.appendFrameHtml(FRAME_ID, '<section>two</section>', agent(), { done: true })
    expect(streamEnds()).toEqual([
      { type: 'frame:streaming', frameId: FRAME_ID, active: false, actor: expect.anything(), reason: 'done' },
    ])
  })

  it('says a human took the frame over when their edit cuts the stream', () => {
    actions.appendFrameHtml(FRAME_ID, '<section>one</section>', agent(), { start: true })
    room = []
    actions.updateFrame(FRAME_ID, { html: '<section>by alice</section>' }, human())
    expect(streamEnds()).toHaveLength(1)
    expect((streamEnds()[0] as { reason?: string }).reason).toBe('taken over')
  })

  it('says an agent took over when it replaces the streaming document', () => {
    actions.appendFrameHtml(FRAME_ID, '<section>one</section>', agent(), { start: true })
    room = []
    actions.updateFrame(
      FRAME_ID,
      { html: '<section>by pixel</section>' },
      actions.resolveActor({ name: 'Pixel', kind: 'agent' }),
    )
    expect((streamEnds()[0] as { reason?: string }).reason).toBe('taken over')
  })

  it('says the agent went silent when its stream times out', () => {
    actions.appendFrameHtml(FRAME_ID, '<section>one</section>', agent(), { start: true })
    room = []
    /* the sweep runs on the server's tick: past the idle window the stream is
       closed with the reason the chip renders as "agent silent" */
    expect(actions.sweepIdleStreams(Date.now() + 31_000)).toBe(1)
    expect(streamEnds().map((m) => (m as { reason?: string }).reason)).toEqual(['idle'])
  })

  it('says the agent replaced the document when it rewrites its own stream whole', () => {
    actions.appendFrameHtml(FRAME_ID, '<section>one</section>', agent(), { start: true })
    room = []
    actions.updateFrame(FRAME_ID, { html: '<section>rewritten whole</section>' }, agent())
    expect((streamEnds()[0] as { reason?: string }).reason).toBe('replaced')
  })
})
