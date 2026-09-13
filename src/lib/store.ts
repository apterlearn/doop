import { create } from 'zustand'
import type {
  ActivityItem,
  AgentPlan,
  AgentQuestion,
  AgentTask,
  Canvas,
  CanvasFocus,
  DesignDecision,
  DesignTokens,
  ElementComment,
  Frame,
  FrameLockHolder,
  FrameProposal,
  FrameVersion,
  GuidelineDoc,
  MemoryProposal,
  MemoryReference,
  Page,
  Presence,
  RunEvent,
  TaskFeedback,
} from '../../shared/types'
import type { SnapGuide } from './snap'

/** Why a frame's design stream ended, as the server reports it. */
export type StreamEndReason = 'done' | 'idle' | 'taken over' | 'stopped' | 'replaced'

/** Which tab the side panel shows. */
export type PanelTab = 'tasks' | 'activity' | 'memory' | 'tokens' | 'agents' | 'review' | 'checks' | 'run'

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
  /** agent task history (newest first) — every set_status becomes a task */
  tasks: AgentTask[]
  /** human feedback on tasks (newest first) */
  feedback: TaskFeedback[]
  /** element-anchored comments (newest first) */
  comments: ElementComment[]
  /** design decisions captured into Memory (newest first) */
  decisions: DesignDecision[]
  /** distiller rule proposals (newest first) */
  proposals: MemoryProposal[]
  /** agent plans on the open canvas, newest first — each one is an agent's
   *  published list of steps, shown alongside its live task */
  plans: AgentPlan[]
  /** agent frame changes waiting for approval while review mode is on */
  frameProposals: FrameProposal[]
  /** questions agents asked; open ones surface on their frame and in Review */
  questions: AgentQuestion[]
  /** the resident agents' tool-call timeline, newest first */
  runEvents: RunEvent[]
  /** frameId -> saved versions, loaded on demand by the Inspector's History */
  frameVersions: Record<string, FrameVersion[]>
  /** frameId -> the actor editing it right now; agents hold these, humans
   *  never do, and a human sees the chip so they know why a frame is busy */
  frameLocks: Record<string, FrameLockHolder>
  /** the canvas refuses agent frame writes until a human approves them */
  reviewMode: boolean
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
  /** the free-tier wall is showing — in the store so any surface that hits
   *  the resident-task limit (board, prompt bar, element comment) can raise it */
  limitWall: boolean
  /** bumped whenever the allowance could have changed (a model account was
   *  connected or dropped) so every meter on screen re-reads it */
  allowanceVersion: number
  /** a request for the Stage to glide the camera to a frame — the prompt bar
   *  raises it so a first deliverable streams in on-screen, never off-canvas */
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
  setStatus(clientId: string, status: string | null): void
  setActivity(items: ActivityItem[]): void
  pushActivity(item: ActivityItem): void
  setTasks(tasks: AgentTask[]): void
  upsertTask(task: AgentTask): void
  removeTask(taskId: string): void
  setFeedback(feedback: TaskFeedback[]): void
  upsertFeedback(fb: TaskFeedback): void
  setComments(comments: ElementComment[]): void
  upsertComment(c: ElementComment): void
  upsertFrame(f: Frame): void
  patchFrameLocal(frameId: string, patch: Partial<Frame>): void
  removeFrame(frameId: string): void
  renameCanvasLocal(name: string): void
  /** upsert (doc set) or remove (doc null) a style guide on the open canvas */
  setGuidelineLocal(name: string, doc: GuidelineDoc | null): void
  setTokensLocal(tokens: DesignTokens | null): void
  setPlanLocal(plan: AgentPlan): void
  setPlans(plans: AgentPlan[]): void
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
  setQuestions(questions: AgentQuestion[]): void
  upsertQuestion(question: AgentQuestion): void
  setRunEvents(events: RunEvent[]): void
  pushRunEvent(event: RunEvent): void
  setFrameVersions(frameId: string, versions: FrameVersion[]): void
  setStream(
    frameId: string,
    actor: { name: string; color: string; isAgent: boolean } | null,
    reason?: StreamEndReason,
  ): void
  setFrameLock(frameId: string, holder: FrameLockHolder | null): void
  setFrameLocks(locks: Record<string, FrameLockHolder>): void
  setReviewModeLocal(on: boolean): void
  /** open the side panel on a tab from anywhere (a question pin, a toast) */
  requestPanel(tab: PanelTab): void
  clearPanelRequest(): void
  setLimitWall(v: boolean): void
  allowanceChanged(): void
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
  tasks: [],
  feedback: [],
  comments: [],
  decisions: [],
  proposals: [],
  plans: [],
  panelTab: 'tasks',
  limitWall: false,
  allowanceVersion: 0,
  flyTo: null,
  frameProposals: [],
  questions: [],
  runEvents: [],
  frameVersions: {},
  frameLocks: {},
  reviewMode: false,
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
    set(
      canvas
        ? { canvas, streams: {}, streamEnds: {} }
        : { canvas: null, streams: {}, frameLocks: {}, frameVersions: {}, streamEnds: {} },
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
  setCursor: (clientId, x, y) => set((s) => ({ cursors: { ...s.cursors, [clientId]: { x, y } } })),
  setEditing: (clientId, frameId) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, activeFrameId: frameId } } }
    }),
  setStatus: (clientId, status) =>
    set((s) => {
      const p = s.presences[clientId]
      if (!p) return {}
      return { presences: { ...s.presences, [clientId]: { ...p, status: status ?? undefined } } }
    }),
  setActivity: (activity) => set({ activity }),
  pushActivity: (item) =>
    set((s) => (s.activity.some((a) => a.id === item.id) ? {} : { activity: [item, ...s.activity].slice(0, 100) })),
  setTasks: (tasks) => set({ tasks }),
  upsertTask: (task) =>
    set((s) => {
      const tasks = s.tasks.some((t) => t.id === task.id)
        ? s.tasks.map((t) => (t.id === task.id ? task : t))
        : [task, ...s.tasks].slice(0, 100)
      return { tasks }
    }),
  removeTask: (taskId) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) })),
  setFeedback: (feedback) => set({ feedback }),
  setComments: (comments) => set({ comments }),
  upsertComment: (c) =>
    set((s) => {
      const comments = s.comments.some((x) => x.id === c.id)
        ? s.comments.map((x) => (x.id === c.id ? c : x))
        : [c, ...s.comments].slice(0, 100)
      return { comments }
    }),
  upsertFeedback: (fb) =>
    set((s) => {
      const feedback = s.feedback.some((f) => f.id === fb.id)
        ? s.feedback.map((f) => (f.id === fb.id ? fb : f))
        : [fb, ...s.feedback].slice(0, 100)
      return { feedback }
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
  setQuestions: (questions) => set({ questions: (questions ?? []).slice(0, 100) }),
  upsertQuestion: (question) =>
    set((s) => {
      const questions = s.questions.some((q) => q.id === question.id)
        ? s.questions.map((q) => (q.id === question.id ? question : q))
        : [question, ...s.questions].slice(0, 100)
      return { questions }
    }),
  setRunEvents: (runEvents) => set({ runEvents: (runEvents ?? []).slice(0, 500) }),
  pushRunEvent: (event) =>
    set((s) =>
      s.runEvents.some((e) => e.id === event.id) ? {} : { runEvents: [event, ...s.runEvents].slice(0, 500) },
    ),
  setFrameVersions: (frameId, versions) => set((s) => ({ frameVersions: { ...s.frameVersions, [frameId]: versions } })),
  setFrameLock: (frameId, holder) =>
    set((s) => {
      const frameLocks = { ...s.frameLocks }
      if (holder) frameLocks[frameId] = holder
      else delete frameLocks[frameId]
      return { frameLocks }
    }),
  setReviewModeLocal: (reviewMode) => set({ reviewMode }),
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
  setPlans: (plans) => set({ plans }),
  setPlanLocal: (plan) =>
    set((s) => {
      const others = s.plans.filter((p) => !(p.canvasId === plan.canvasId && p.agentName === plan.agentName))
      return { plans: [plan, ...others] }
    }),
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
  setLimitWall: (limitWall) => set({ limitWall }),
  allowanceChanged: () => set((s) => ({ allowanceVersion: s.allowanceVersion + 1 })),
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
