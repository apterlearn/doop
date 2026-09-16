import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Canvas, Frame, Page, ServerMessage } from '../shared/types'

/* headless store test: no DOM. api/posthog are stubbed before the store (and
   ws, which pulls the store) load, mirroring tests/selection.test.ts. The ws
   message reducer (`handle`) is module-private, so the 'pages'/'init' cases
   are driven for real through connect() with a stubbed WebSocket. */

/* minimal browser-ish globals the ws module reads at connect/identity time */
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
})
vi.stubGlobal('location', { protocol: 'http:', host: 'test' })

class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  sent: string[] = []
  constructor() {
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  /* feed a server message through the real module-private reducer */
  receive(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}
vi.stubGlobal('WebSocket', FakeWebSocket)

vi.mock('../src/lib/api', () => ({
  api: {
    updateFrame: vi.fn(async () => ({})),
    deleteFrame: vi.fn(async () => ({})),
    createFrame: vi.fn(async () => ({})),
  },
}))
vi.mock('../src/lib/posthog', () => ({ posthog: { capture: vi.fn() } }))

/* dynamic imports are required here: vi.mock is hoisted above static imports,
   so the store/ws modules must load after the mocks and globals are registered */
const { useStore, visibleFrames } = await import('../src/lib/store')
const ws = await import('../src/lib/ws')

function page(id: string, name = id, position = 0): Page {
  return { id, canvasId: 'c1', name, position, createdAt: 1, updatedAt: 1 }
}

function frame(id: string, pageId?: string): Frame {
  return {
    id,
    canvasId: 'c1',
    name: id,
    html: '',
    z: 0,
    locked: false,
    hidden: false,
    rotation: 0,
    opacity: 1,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    pageId,
  } as Frame
}

function seed(frames: Frame[], pages?: Page[]) {
  useStore.setState({ canvas: { id: 'c1', name: 'c', frames, pages } as unknown as Canvas })
}

function ids(frames: Frame[]) {
  return frames.map((f) => f.id)
}

beforeEach(() => {
  useStore.setState({ canvas: null, activePageId: undefined, selectedIds: [], selectedId: null })
})

describe('visibleFrames', () => {
  it('filters to the active page', () => {
    seed([frame('a', 'p1'), frame('b', 'p1'), frame('c', 'p2')], [page('p1', 'Page 1', 0), page('p2', 'Page 2', 1)])
    useStore.setState({ activePageId: 'p1' })
    expect(ids(visibleFrames(useStore.getState()))).toEqual(['a', 'b'])
  })

  it('shows all frames when no page is active', () => {
    seed([frame('a', 'p1'), frame('c', 'p2')], [page('p1'), page('p2')])
    expect(ids(visibleFrames(useStore.getState()))).toEqual(['a', 'c'])
  })

  it('shows all frames when the canvas has no pages (back-compat)', () => {
    seed([frame('a'), frame('b')])
    useStore.setState({ activePageId: 'p1' })
    expect(ids(visibleFrames(useStore.getState()))).toEqual(['a', 'b'])
  })
})

describe('setActivePage', () => {
  it('switching pages swaps the visible frame set', () => {
    seed([frame('a', 'p1'), frame('c', 'p2')], [page('p1'), page('p2')])
    useStore.getState().setActivePage('p1')
    expect(ids(visibleFrames(useStore.getState()))).toEqual(['a'])
    useStore.getState().setActivePage('p2')
    expect(ids(visibleFrames(useStore.getState()))).toEqual(['c'])
  })
})

describe('setPagesLocal', () => {
  it('replaces canvas.pages and keeps a still-existing active tab', () => {
    seed([], [page('p1'), page('p2')])
    useStore.setState({ activePageId: 'p2' })
    useStore.getState().setPagesLocal([page('p1', 'Page 1', 0), page('p2', 'Renamed', 1)])
    expect(useStore.getState().canvas?.pages?.map((p) => p.name)).toEqual(['Page 1', 'Renamed'])
    expect(useStore.getState().activePageId).toBe('p2')
  })

  it('repairs a deleted active tab back to the first remaining page', () => {
    seed([], [page('p1'), page('p2')])
    useStore.setState({ activePageId: 'p2' })
    useStore.getState().setPagesLocal([page('p1')])
    expect(useStore.getState().activePageId).toBe('p1')
  })

  it('clears the active tab when the last page goes away', () => {
    seed([], [page('p1')])
    useStore.setState({ activePageId: 'p1' })
    useStore.getState().setPagesLocal([])
    expect(useStore.getState().activePageId).toBeUndefined()
  })

  it('is a no-op without an open canvas', () => {
    expect(() => useStore.getState().setPagesLocal([page('p1')])).not.toThrow()
    expect(useStore.getState().canvas).toBeNull()
  })
})

describe('ws server messages', () => {
  /* one live connection for the whole suite: the ws module keeps its socket at
     module scope, and every receive() routes through the real reducer */
  beforeAll(() => {
    if (FakeWebSocket.instances.length === 0) ws.connect('c1')
  })

  function receive(msg: ServerMessage) {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    socket.receive(msg)
  }

  it('a "pages" broadcast replaces canvas.pages and repairs the active tab', () => {
    seed([], [page('p1'), page('p2')])
    useStore.setState({ activePageId: 'p2' })
    receive({ type: 'pages', pages: [page('p1', 'Page 1')], actor: { clientId: 'x', name: 'X' } } as ServerMessage)
    expect(useStore.getState().canvas?.pages).toHaveLength(1)
    expect(useStore.getState().activePageId).toBe('p1')
  })

  it('init lands on the first page when no tab is set', () => {
    seed([])
    receive({
      type: 'init',
      serverBuild: 'dev',
      canvas: { id: 'c1', name: 'c', frames: [], pages: [page('p1'), page('p2')] },
      presences: [],
      activity: [],
      comments: [],
      decisions: [],
      proposals: [],
    } as unknown as ServerMessage)
    expect(useStore.getState().activePageId).toBe('p1')
  })

  it('init keeps a tab that still exists in the incoming canvas', () => {
    seed([])
    useStore.setState({ activePageId: 'p2' })
    receive({
      type: 'init',
      serverBuild: 'dev',
      canvas: { id: 'c1', name: 'c', frames: [], pages: [page('p1'), page('p2')] },
      presences: [],
      activity: [],
      comments: [],
      decisions: [],
      proposals: [],
    } as unknown as ServerMessage)
    expect(useStore.getState().activePageId).toBe('p2')
  })

  it('init repairs a stale tab left over from a previously viewed canvas', () => {
    seed([])
    useStore.setState({ activePageId: 'gone' })
    receive({
      type: 'init',
      serverBuild: 'dev',
      canvas: { id: 'c1', name: 'c', frames: [], pages: [page('p1')] },
      presences: [],
      activity: [],
      comments: [],
      decisions: [],
      proposals: [],
    } as unknown as ServerMessage)
    expect(useStore.getState().activePageId).toBe('p1')
  })
})
