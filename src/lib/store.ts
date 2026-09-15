import { create } from 'zustand'
import type {
  ActivityItem,
  AgentQuestion,
  Canvas,
  CanvasFocus,
  CanvasProposal,
  ComponentSummary,
  DesignDecision,
  DesignTokens,
  ElementComment,
  Frame,
  FrameLockHolder,
  FrameProposal,
  FrameReview,
  FrameVersion,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  Page,
  Presence,
  ReviewPolicy,
  RunEvent,
} from '../../shared/types'
import type { SnapGuide } from './snap'

/** Why a frame's design stream ended, as the server reports it. */
export type StreamEndReason = 'done' | 'idle' | 'taken over' | 'replaced'

/** Which tab the side panel shows. */
export type PanelTab = 'activity' | 'memory' | 'tokens' | 'agents' | 'review' | 'checks' | 'components' | 'run'

export interface Viewport {
  x: number
  y: number
  zoom: number
}

interface State {
  canvas: Canvas | null
  presences: Record<string, Presence>
  /** what each connected client is looking at, keyed by clientId — how a
   *  human points at "this" element without typing a selector */
  focus: Record<string, Omit<CanvasFocus, 'clientId'>>
  cursors: Record<string, { x: number; y: number }>
  activity: ActivityItem[]
  /** element-anchored comments (newest first) */
  comments: ElementComment[]
  /** design decisions captured into Memory (newest first) */
  decisions: DesignDecision[]
  /** distiller rule proposals (newest first) */
  proposals: MemoryProposal[]
  /** agent frame changes waiting for approval while review mode is on */
  frameProposals: FrameProposal[]
  /** agent canvas-level changes (tokens, a guideline doc, the breakpoints, the
   *  page set) waiting for approval while review mode is on */
  canvasProposals: CanvasProposal[]
  /** questions agents asked; open ones surface on their frame and in Review */
  questions: AgentQuestion[]
  /** frameId -> saved versions, loaded on demand by the Inspector's History */
  frameVersions: Record<string, FrameVersion[]>
  /** frameId -> the newest stored check for that frame, as the Checks tab and
   *  the frame's own label read it. One copy, so a verdict can never differ
   *  between the two surfaces. */
  frameReviews: Record<string, FrameReview & { current: boolean }>
  /** frameId -> the actor editing it right now; agents hold these, humans
   *  never do, and a human sees the chip so they know why a frame is busy */
  frameLocks: Record<string, FrameLockHolder>
  /** the canvas refuses agent frame writes until a human approves them */
  reviewMode: boolean
  /** what an agent write must clear before it lands, and the tool names gated
   *  on top of the tools that declare themselves destructive */
  reviewPolicy: ReviewPolicy
  approvalTools: string[]
  /** the canvas component library — reusable pieces agents can instance into
   *  frames, listed by the Components tab */
  components: ComponentSummary[]
  /** the agent run timeline: one entry per MCP tool call, newest first */
  runEvents: RunEvent[]
  /** which tab the side panel shows — in the store so a Memory-suggestion
   *  toast anywhere in the app can jump straight to the Memory tab */
  panelTab: PanelTab
  /** a request for the side panel to open on a tab, raised by a question pin
   *  or a toast and consumed by CanvasPage — the flyTo pattern for the panel */
  panelRequest: { tab: PanelTab; at: number } | null
  /** every selected frame, in selection order — marquee and ⇧-click build
   *  this up; a plain click collapses it to one */
  selectedIds: string[]
  /** the primary selection (the last frame added) — what the Inspector,
   *  presence, and the flow overlay follow */
  selectedId: string | null
  /** space bar held: the stage pans on drag instead of drawing a marquee */
  panMode: boolean
  /** the Inspector panel is showing — opened by clicking a frame's name, not
   *  by mere selection, so clicking around a frame doesn't slide the panel in */
  inspectorOpen: boolean
  /** open frame context menu; deferPanel hides the Inspector until it closes
   *  (right-click selecting a frame must not slide a panel in under the menu) */
  ctxMenu: { frameId: string; deferPanel: boolean } | null
  /** the element outlined inside the selected frame — a click on the frame
   *  surface and a click on a Layers row both land here, so the outline in
   *  the frame and the highlighted row stay in step */
  selectedElement: { frameId: string; selector: string } | null
  /** the element properties panel is showing — opened by a Layers row, it
   *  then follows whatever element is selected until it is closed */
  elementPanelOpen: boolean
  /** the Layers rail is showing (desktop); the choice sticks across visits */
  layersOpen: boolean
  viewport: Viewport
  /** live alignment guide lines while a frame drag is snapped to a neighbour */
  snapGuides: SnapGuide[]
  connected: boolean
  /** a reconnect revealed a newer client bundle on the server — offer a reload */
  updateReady: boolean
  /** frameId -> color, set briefly when a remote actor updates a frame */
  flashes: Record<string, { color: string; at: number }>
  /** frameId -> actor currently streaming a design into it. `isAgent` is what
   *  the Stop control keys off: a human's stream is not stoppable. */
  streams: Record<string, { name: string; color: string; isAgent: boolean }>
  /** frameId -> how the last stream into it ended, so the frame can say so
   *  instead of dropping its border unexplained */
  streamEnds: Record<string, { name: string; color: string; isAgent: boolean; reason: StreamEndReason; at: number }>
  /** a request for the Stage to glide the camera to a frame — an Activity row
   *  and a Layers row raise it so the frame they name is in view */
  flyTo: { frameId: string; at: number } | null
  /** the page tab being viewed — every frame surface filters to it; unset
   *  means show all frames (back-compat with canvases before pages) */
  activePageId?: string

  setCanvas(c: Canvas | null): void
  setConnected(v: boolean): void
  setUpdateReady(v: boolean): void
  setPresences(list: Presence[]): void
  upsertPresence(p: Presence): void
  removePresence(clientId: string): void
  /** record (or clear, with null) what another client is looking at */
  setFocus(
    clientId: string,
    focus: { frameId: string | null; selector: string | null; pageId: string | null } | null,
  ): void
  setCursor(clientId: string, x: number, y: number): void
  setEditing(clientId: string, frameId: string | null): void
  setActivity(items: ActivityItem[]): void
  pushActivity(item: ActivityItem): void
  setComments(comments: ElementComment[]): void
  upsertComment(c: ElementComment): void
  upsertFrame(f: Frame): void
  patchFrameLocal(frameId: string, patch: Partial<Frame>): void
  removeFrame(frameId: string): void
  renameCanvasLocal(name: string): void
  /** upsert (doc set) or remove (doc null) a style guide on the open canvas */
  setGuidelineLocal(name: string, doc: GuidelineDoc | null): void
  setTokensLocal(tokens: DesignTokens | null): void
  /** pin (reference set) or unpin (null) a Memory reference on the open canvas */
  setReferenceLocal(id: string, reference: MemoryReference | null): void
  setDecisions(decisions: DesignDecision[]): void
  pushDecision(decision: DesignDecision): void
  setProposals(proposals: MemoryProposal[]): void
  upsertProposal(proposal: MemoryProposal): void
  setPanelTab(tab: PanelTab): void
  setFrameProposals(proposals: FrameProposal[]): void
  upsertFrameProposal(proposal: FrameProposal): void
  removeFrameProposal(proposalId: string): void
  setCanvasProposals(proposals: CanvasProposal[]): void
  upsertCanvasProposal(proposal: CanvasProposal): void
  setQuestions(questions: AgentQuestion[]): void
  upsertQuestion(question: AgentQuestion): void
  setFrameVersions(frameId: string, versions: FrameVersion[]): void
  /** record the newest check for a frame (a run, or a load) */
  setFrameReview(frameId: string, review: FrameReview & { current: boolean }): void
  /** merge checks by frame, newest report per frame — a bulk load, or the
   *  per-frame refresh a canvas sweep comes back with */
  setFrameReviews(reviews: (FrameReview & { current: boolean })[]): void
  setStream(
    frameId: string,
    actor: { name: string; color: string; isAgent: boolean } | null,
    reason?: StreamEndReason,
  ): void
  setFrameLock(frameId: string, holder: FrameLockHolder | null): void
  setFrameLocks(locks: Record<string, FrameLockHolder>): void
  setReviewModeLocal(on: boolean): void
  /** the review policy and its extra gated tools, as the canvas last reported */
  setReviewPolicyLocal(policy: ReviewPolicy, approvalTools: string[]): void
  setComponents(list: ComponentSummary[]): void
  /** upsert a component by id (summary set), or drop it when it was deleted
   *  (summary null) — newest-updated first either way */
  upsertComponent(summary: ComponentSummary | null, id: string): void
  setRunEvents(events: RunEvent[]): void
  /** prepend one timeline entry, keeping the list bounded like the server's ring */
  pushRunEvent(event: RunEvent): void
  /** open the side panel on a tab from anywhere (a question pin, a toast) */
  requestPanel(tab: PanelTab): void
  clearPanelRequest(): void
  requestFlyTo(frameId: string): void
  setActivePage(id?: string): void
  /** replace canvas.pages wholesale (a ws 'pages' broadcast); repairs the
   *  active tab when the new list no longer contains it */
  setPagesLocal(pages: Page[]): void
  select(id: string | null): void
  /** ⇧-click: add the frame to the selection, or drop it if already in */
  toggleSelect(id: string): void
  /** marquee: replace the selection with these frames */
  selectMany(ids: string[]): void
  setPanMode(v: boolean): void
  setInspectorOpen(v: boolean): void
  openCtxMenu(menu: { frameId: string; deferPanel: boolean }): void
  closeCtxMenu(): void
  setSelectedElement(el: { frameId: string; selector: string } | null): void
  setElementPanelOpen(v: boolean): void
  setLayersOpen(v: boolean): void
  setViewport(v: Viewport): void
  setSnapGuides(guides: SnapGuide[]): void
  flash(frameId: string, color: string): void
}

/** Frames the current surface shows: the active page's frames, or all of them
 *  when no page is active (unset tab, or a canvas that has no pages). */
export function visibleFrames(s: { canvas: Canvas | null; activePageId?: string }): Frame[] {
  const c = s.canvas
  if (!c) return []
  if (!s.activePageId || !c.pages?.length) return c.frames
  return c.frames.filter((f) => f.pageId === s.activePageId)
}

/** What a stored check says right now: its verdict, or `stale` when the frame
 *  has been edited since it was run. The server's `current` flag is the
 *  authority as of the fetch; a frame changed after that is stale by
 *  definition. Both the Checks tab and a frame's own label read this, so a
 *  verdict cannot differ between the two surfaces. */
export function checkVerdict(review: FrameReview & { current: boolean }, frame: Frame): 'pass' | 'fail' | 'stale' {
  if (!review.current || review.frameUpdatedAt !== frame.updatedAt) return 'stale'
  return review.verdict
}

const LAYERS_OPEN_KEY = 'doop:layers-open'

function readLayersOpen(): boolean {
  try {
    return localStorage.getItem(LAYERS_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export const useStore = create<State>((set, get) => ({
  canvas: null,
  presences: {},
  focus: {},
  cursors: {},
  activity: [],
  comments: [],
  decisions: [],
  proposals: [],
  panelTab: 'activity',
  flyTo: null,
  frameProposals: [],
  canvasProposals: [],
  questions: [],
  frameVersions: {},
  frameReviews: {},
  frameLocks: {},
  reviewMode: false,
  reviewPolicy: 'off',
  approvalTools: [],
  components: [],
  runEvents: [],
  panelRequest: null,
  selectedIds: [],
  selectedId: null,
  panMode: false,
  inspectorOpen: false,
  ctxMenu: null,
  selectedElement: null,
  elementPanelOpen: false,
  layersOpen: readLayersOpen(),
  viewport: { x: 0, y: 0, zoom: 1 },
  snapGuides: [],
  connected: false,
  updateReady: false,
  flashes: {},
  streams: {},
  streamEnds: {},

  /* leaving a canvas drops its per-frame state: locks and loaded version
     lists belong to frames that no longer exist on screen */
  setCanvas: (canvas) =>
    set((s) =>
      canvas
        ? {
            canvas,
            streams: {},
            streamEnds: {},
            runEvents: [],
            /* a verdict belongs to the frames it was run on, so opening a
               different canvas starts clean rather than showing another
               canvas's checks beside its frames */
            ...(s.canvas && s.canvas.id !== canvas.id ? { frameReviews: {} } : {}),
          }
        : {
            canvas: null,
            streams: {},
            frameLocks: {},
            frameVersions: {},
            frameReviews: {},
            streamEnds: {},
            runEvents: [],
          },
    ),
  setFrameLocks: (frameLocks) => set({ frameLocks }),
  setActivePage: (activePageId) => set({ activePageId }),
  setPagesLocal: (pages) =>
    set((s) => {
      if (!s.canvas) return {}
      return {
        canvas: { ...s.canvas, pages },
        /* a page another actor deleted must not leave this client on a
           ghost tab: fall back to the first page (or none) */
        activePageId: pages.some((p) => p.id === s.activePageId) ? s.activePageId : pages[0]?.id,
      }
    }),
  setConnected: (connected) => set({ connected }),
  setUpdateReady: (updateReady) => set({ updateReady }),
  setPresences: (list) => set({ presences: Object.fromEntries(list.map((p) => [p.clientId, p])) }),
  upsertPresence: (p) => set((s) => ({ presences: { ...s.presences, [p.clientId]: p } })),
  removePresence: (clientId) =>
    set((s) => {
      const presences = { ...s.presences }
      const cursors = { ...s.cursors }
      const focus = { ...s.focus }
      delete presences[clientId]
      delete cursors[clientId]
      /* someone who left is not still looking at anything */
      delete focus[clientId]
      return { presences, cursors, focus }
    }),
  setFocus: (clientId, f) =>
    set((s) => {
      const focus = { ...s.focus }
      if (f) {
        /* the name comes from presence: a client is in the room before it can
           point at anything, so the entry is always addressable */
        focus[clientId] = { name: s.presences[clientId]?.name ?? clientId, ...f, at: Date.now() }
      } else delete focus[clientId]
      return { focus }
    }),
  /* Every live message from a client is evidence it is alive: `lastSeen` is
     what the silence indicator reads, and a value frozen at join time would
     report a working agent as stuck. */
  setCursor: (clientId, x, y) =>
    set((s) => {
      const p = s.presences[clientId]
      return {
        cursors: { ...s.cursors, [clientId]: { x, y } },
        presences: p ? { ...s.presences, [clientId]: { ...p, lastSeen: Date.now() } } : s.presences,
      }
    }),
  setEditing: (clientId, frameId) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, activeFrameId: frameId, lastSeen: Date.now() } } }
    }),
  setActivity: (activity) => set({ activity }),
  pushActivity: (item) =>
    set((s) => (s.activity.some((a) => a.id === item.id) ? {} : { activity: [item, ...s.activity].slice(0, 100) })),
  setComments: (comments) => set({ comments }),
  upsertComment: (c) =>
    set((s) => {
      const comments = s.comments.some((x) => x.id === c.id)
        ? s.comments.map((x) => (x.id === c.id ? c : x))
        : [c, ...s.comments].slice(0, 100)
      return { comments }
    }),
  upsertFrame: (f) =>
    set((s) => {
      if (!s.canvas) return {}
      const frames = s.canvas.frames.some((x) => x.id === f.id)
        ? s.canvas.frames.map((x) => (x.id === f.id ? f : x))
        : [...s.canvas.frames, f]
      return { canvas: { ...s.canvas, frames } }
    }),
  patchFrameLocal: (frameId, patch) =>
    set((s) => {
      if (!s.canvas) return {}
      return {
        canvas: {
          ...s.canvas,
          frames: s.canvas.frames.map((f) => (f.id === frameId ? { ...f, ...patch } : f)),
        },
      }
    }),
  removeFrame: (frameId) =>
    set((s) => {
      if (!s.canvas) return {}
      const selectedIds = s.selectedIds.filter((id) => id !== frameId)
      const frameLocks = { ...s.frameLocks }
      delete frameLocks[frameId]
      return {
        canvas: { ...s.canvas, frames: s.canvas.frames.filter((f) => f.id !== frameId) },
        selectedIds,
        /* losing the primary promotes the last surviving member, so a group
           never sits selected with nothing driving the Inspector/presence */
        selectedId: s.selectedId === frameId ? (selectedIds[selectedIds.length - 1] ?? null) : s.selectedId,
        /* an open Inspector must not silently retarget onto the promoted frame */
        inspectorOpen: s.selectedId === frameId ? false : s.inspectorOpen,
        ctxMenu: s.ctxMenu?.frameId === frameId ? null : s.ctxMenu,
        frameLocks,
      }
    }),
  setFrameProposals: (frameProposals) => set({ frameProposals: (frameProposals ?? []).slice(0, 100) }),
  upsertFrameProposal: (proposal) =>
    set((s) => {
      const frameProposals = s.frameProposals.some((p) => p.id === proposal.id)
        ? s.frameProposals.map((p) => (p.id === proposal.id ? proposal : p))
        : [proposal, ...s.frameProposals].slice(0, 100)
      return { frameProposals }
    }),
  removeFrameProposal: (proposalId) =>
    set((s) => ({ frameProposals: s.frameProposals.filter((p) => p.id !== proposalId) })),
  setCanvasProposals: (canvasProposals) => set({ canvasProposals: (canvasProposals ?? []).slice(0, 100) }),
  upsertCanvasProposal: (proposal) =>
    set((s) => {
      const canvasProposals = s.canvasProposals.some((p) => p.id === proposal.id)
        ? s.canvasProposals.map((p) => (p.id === proposal.id ? proposal : p))
        : [proposal, ...s.canvasProposals].slice(0, 100)
      return { canvasProposals }
    }),
  setQuestions: (questions) => set({ questions: (questions ?? []).slice(0, 100) }),
  upsertQuestion: (question) =>
    set((s) => {
      const questions = s.questions.some((q) => q.id === question.id)
        ? s.questions.map((q) => (q.id === question.id ? question : q))
        : [question, ...s.questions].slice(0, 100)
      return { questions }
    }),
  setFrameVersions: (frameId, versions) => set((s) => ({ frameVersions: { ...s.frameVersions, [frameId]: versions } })),
  setFrameReview: (frameId, review) => set((s) => ({ frameReviews: { ...s.frameReviews, [frameId]: review } })),
  /* A sweep and a manual run can land in either order, so the newer report
     wins rather than the one that arrived last. */
  setFrameReviews: (reviews) =>
    set((s) => {
      const frameReviews = { ...s.frameReviews }
      for (const review of reviews) {
        const held = frameReviews[review.frameId]
        if (!held || review.reviewedAt >= held.reviewedAt) frameReviews[review.frameId] = review
      }
      return { frameReviews }
    }),
  setFrameLock: (frameId, holder) =>
    set((s) => {
      const frameLocks = { ...s.frameLocks }
      if (holder) frameLocks[frameId] = holder
      else delete frameLocks[frameId]
      return { frameLocks }
    }),
  setReviewModeLocal: (reviewMode) => set({ reviewMode }),
  setReviewPolicyLocal: (reviewPolicy, approvalTools) => set({ reviewPolicy, approvalTools }),
  setComponents: (components) => set({ components }),
  /* A component arrives whole on the wire while the panel lists summaries, so
     the caller builds the summary and this only places it: replace by id, or
     drop it when it was deleted, then keep the newest-updated first. */
  upsertComponent: (summary, id) =>
    set((s) => {
      const rest = s.components.filter((c) => c.id !== id)
      const components = summary ? [summary, ...rest] : rest
      components.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      return { components }
    }),
  setRunEvents: (runEvents) => set({ runEvents: (runEvents ?? []).slice(0, 200) }),
  /* the server sends the timeline newest-first, so a live entry goes on the
     front and the oldest falls off the end of the same bounded window */
  pushRunEvent: (event) => set((s) => ({ runEvents: [event, ...s.runEvents].slice(0, 200) })),
  requestPanel: (tab) => set({ panelRequest: { tab, at: Date.now() } }),
  clearPanelRequest: () => set({ panelRequest: null }),
  renameCanvasLocal: (name) => set((s) => (s.canvas ? { canvas: { ...s.canvas, name } } : {})),
  setGuidelineLocal: (name, doc) =>
    set((s) => {
      if (!s.canvas) return {}
      const docs = (s.canvas.guidelines ?? []).filter((d) => d.name !== name)
      if (doc) {
        docs.push(doc)
        docs.sort((a, b) => a.name.localeCompare(b.name))
      }
      return { canvas: { ...s.canvas, guidelines: docs } }
    }),
  setTokensLocal: (tokens) => set((s) => (s.canvas ? { canvas: { ...s.canvas, tokens: tokens ?? undefined } } : {})),
  setReferenceLocal: (id, reference) =>
    set((s) => {
      if (!s.canvas) return {}
      const refs = (s.canvas.references ?? []).filter((r) => r.id !== id)
      if (reference) refs.unshift(reference)
      return { canvas: { ...s.canvas, references: refs } }
    }),
  setDecisions: (decisions) => set({ decisions }),
  pushDecision: (decision) =>
    set((s) => {
      /* upsert by id — the summarizer re-broadcasts the same decision with
         its generalized summary attached a moment after capture */
      const decisions = s.decisions.some((d) => d.id === decision.id)
        ? s.decisions.map((d) => (d.id === decision.id ? decision : d))
        : [decision, ...s.decisions].slice(0, 100)
      return { decisions }
    }),
  setProposals: (proposals) => set({ proposals }),
  upsertProposal: (proposal) =>
    set((s) => {
      const proposals = s.proposals.some((p) => p.id === proposal.id)
        ? s.proposals.map((p) => (p.id === proposal.id ? proposal : p))
        : [proposal, ...s.proposals].slice(0, 100)
      return { proposals }
    }),
  setPanelTab: (panelTab) => set({ panelTab }),
  requestFlyTo: (frameId) => set({ flyTo: { frameId, at: Date.now() } }),
  /* selecting a different frame (or deselecting) closes the Inspector — the
     panel must not follow surface clicks, paste, or undo onto another frame.
     Re-selecting the same frame keeps an open panel open. */
  select: (selectedId) =>
    set((s) => {
      const selectedIds = selectedId ? [selectedId] : []
      return s.selectedId === selectedId
        ? { selectedId, selectedIds }
        : { selectedId, selectedIds, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    }),
  toggleSelect: (id) =>
    set((s) => {
      const selectedIds = s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
      const selectedId = selectedIds[selectedIds.length - 1] ?? null
      return selectedId === s.selectedId
        ? { selectedIds }
        : { selectedIds, selectedId, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    }),
  selectMany: (ids) =>
    set((s) => {
      const selectedId = ids[ids.length - 1] ?? null
      return selectedId === s.selectedId
        ? { selectedIds: ids }
        : { selectedIds: ids, selectedId, inspectorOpen: false, selectedElement: null, elementPanelOpen: false }
    }),
  setPanMode: (panMode) => set({ panMode }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  openCtxMenu: (ctxMenu) => set({ ctxMenu }),
  closeCtxMenu: () => set({ ctxMenu: null }),
  setSelectedElement: (selectedElement) =>
    set((s) =>
      s.selectedElement?.frameId === selectedElement?.frameId &&
      s.selectedElement?.selector === selectedElement?.selector
        ? s
        : { selectedElement },
    ),
  setElementPanelOpen: (elementPanelOpen) => set({ elementPanelOpen }),
  setLayersOpen: (layersOpen) => {
    try {
      localStorage.setItem(LAYERS_OPEN_KEY, layersOpen ? '1' : '0')
    } catch {
      /* private mode: the choice just doesn't stick */
    }
    set({ layersOpen })
  },
  setViewport: (viewport) => set({ viewport }),
  /* fires on every pointermove during a drag — skip the no-op transitions
     so unsnapped drags don't render the (empty) guide layer each frame */
  setSnapGuides: (snapGuides) =>
    set((s) => (snapGuides.length === 0 && s.snapGuides.length === 0 ? s : { snapGuides })),
  setStream: (frameId, actor, reason) =>
    set((s) => {
      const streams = { ...s.streams }
      const streamEnds = { ...s.streamEnds }
      if (actor) {
        streams[frameId] = actor
        delete streamEnds[frameId]
      } else {
        const ending = streams[frameId]
        delete streams[frameId]
        /* the actor is gone from `streams` by design, so the end is recorded
           here: the frame needs the name and color to say who finished */
        /* the server always names the reason; a missing one is not evidence
           the agent went silent, and "agent silent" is an alarm the viewer
           should only ever get on purpose */
        if (ending) streamEnds[frameId] = { ...ending, reason: reason ?? 'done', at: Date.now() }
      }
      return { streams, streamEnds }
    }),
  flash: (frameId, color) => {
    set((s) => ({ flashes: { ...s.flashes, [frameId]: { color, at: Date.now() } } }))
    setTimeout(() => {
      const cur = get().flashes[frameId]
      if (cur && Date.now() - cur.at >= 1150) {
        set((s) => {
          const flashes = { ...s.flashes }
          delete flashes[frameId]
          return { flashes }
        })
      }
    }, 1200)
  },
}))
