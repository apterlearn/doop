import type { ClientMessage, Component, ComponentSummary, ServerMessage } from '../../shared/types'
import { getIdentity } from './identity'
import { useStore } from './store'

let socket: WebSocket | null = null
let currentCanvasId: string | null = null
let retryTimer: number | null = null
/* the server build this page first connected under; survives reconnects */
let loadedBuild: string | null = null

export function connect(canvasId: string) {
  currentCanvasId = canvasId
  open()
}

export function disconnect() {
  currentCanvasId = null
  if (retryTimer) window.clearTimeout(retryTimer)
  socket?.close()
  socket = null
}

export function sendWs(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
}

/** Tell the room what this client is looking at: the frame, the element inside
 *  it and the page. Debounced by the caller — the server drops repeats anyway,
 *  so a burst costs a little bandwidth, never a message. */
export function sendFocus(focus: { frameId: string | null; selector: string | null; pageId: string | null }) {
  sendWs({ type: 'focus', ...focus })
}

/** The row a component message stands for. The canvas counts instances, which
 *  the message does not carry, so a component already listed keeps its count;
 *  a newly created one starts at zero until the next list load. */
function summarizeComponent(c: Component, listed: ComponentSummary[]): ComponentSummary {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    width: c.width,
    height: c.height,
    variantOf: c.variantOf,
    instanceCount: listed.find((x) => x.id === c.id)?.instanceCount ?? 0,
    updatedAt: new Date(c.updatedAt).toISOString(),
    updatedBy: c.updatedBy,
    htmlBytes: c.html.length,
  }
}

function open() {
  if (!currentCanvasId) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const s = new WebSocket(`${proto}://${location.host}/ws`)
  socket = s
  const canvasId = currentCanvasId

  s.onopen = () => {
    if (socket !== s) return
    const { clientId, name } = getIdentity()
    useStore.getState().setConnected(true)
    sendWs({ type: 'join', canvasId, clientId, name, kind: 'user' })
  }

  s.onmessage = (ev) => {
    if (socket !== s) return
    let msg: ServerMessage
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    handle(msg)
  }

  s.onclose = (ev) => {
    /* a superseded socket must not trigger reconnects */
    if (socket !== s) return
    useStore.getState().setConnected(false)
    if (ev.code === 4401) {
      /* session expired or missing — reload lands on the sign-in page */
      currentCanvasId = null
      location.reload()
      return
    }
    if (ev.code === 4403) {
      /* the owner locked this canvas — retrying would loop forever */
      currentCanvasId = null
      location.href = '/'
      return
    }
    if (currentCanvasId) {
      retryTimer = window.setTimeout(open, 1200)
    }
  }
}

function handle(msg: ServerMessage) {
  const s = useStore.getState()
  const me = getIdentity().clientId
  switch (msg.type) {
    case 'init':
      /* a reconnect that lands on a different build means this page is
         running a stale bundle — offer a reload instead of forcing one,
         so in-progress work is never yanked away */
      if (msg.serverBuild !== 'dev') {
        if (loadedBuild === null) loadedBuild = msg.serverBuild
        else if (loadedBuild !== msg.serverBuild) s.setUpdateReady(true)
      }
      s.setCanvas(msg.canvas)
      /* land on the first page tab on a fresh load, and repair a tab left
         over from a previously viewed canvas */
      if (!msg.canvas.pages?.some((p) => p.id === s.activePageId)) s.setActivePage(msg.canvas.pages?.[0]?.id)
      s.setPresences(msg.presences)
      s.setActivity(msg.activity)
      s.setComments(msg.comments)
      s.setDecisions(msg.decisions)
      s.setProposals(msg.proposals)
      s.setFrameProposals(msg.frameProposals)
      s.setCanvasProposals(msg.canvasProposals ?? [])
      s.setQuestions(msg.questions)
      s.setReviewModeLocal(msg.reviewMode)
      s.setReviewPolicyLocal(msg.reviewPolicy ?? (msg.reviewMode ? 'all_writes' : 'off'), msg.approvalTools ?? [])
      s.setComponents(msg.components ?? [])
      s.setFrameLocks(msg.frameLocks ?? {})
      break
    case 'presence:join':
      if (msg.presence.clientId !== me) s.upsertPresence(msg.presence)
      break
    case 'presence:leave':
      s.removePresence(msg.clientId)
      break
    case 'cursor':
      s.setCursor(msg.clientId, msg.x, msg.y)
      break
    case 'editing':
      s.setEditing(msg.clientId, msg.frameId)
      break
    case 'focus':
      s.setFocus(msg.clientId, { frameId: msg.frameId, selector: msg.selector, pageId: msg.pageId })
      break
    case 'status':
      s.setStatus(msg.clientId, msg.status)
      break
    case 'comment':
      s.upsertComment(msg.comment)
      break
    case 'frame:drag':
      s.patchFrameLocal(msg.frameId, { x: msg.x, y: msg.y, width: msg.width, height: msg.height })
      break
    case 'frame:created':
      s.upsertFrame(msg.frame)
      if (msg.actor.clientId !== me) s.flash(msg.frame.id, msg.actor.color)
      break
    case 'frame:updated':
      s.upsertFrame(msg.frame)
      /* during a live stream the marching border replaces per-chunk flashes */
      if (msg.actor.clientId !== me && !s.streams[msg.frame.id]) s.flash(msg.frame.id, msg.actor.color)
      break
    case 'frame:streaming':
      s.setStream(
        msg.frameId,
        msg.active ? { name: msg.actor.name, color: msg.actor.color, isAgent: msg.actor.kind === 'agent' } : null,
        msg.reason,
      )
      break
    case 'frame:deleted':
      s.removeFrame(msg.frameId)
      break
    case 'canvas:renamed':
      s.renameCanvasLocal(msg.name)
      break
    case 'guidelines':
      s.setGuidelineLocal(msg.name, msg.doc)
      break
    case 'tokens':
      s.setTokensLocal(msg.tokens)
      break
    case 'reference':
      s.setReferenceLocal(msg.id, msg.reference)
      break
    case 'decision':
      s.pushDecision(msg.decision)
      break
    case 'proposal':
      s.upsertProposal(msg.proposal)
      break
    case 'frameProposal':
      s.upsertFrameProposal(msg.proposal)
      break
    case 'frameProposal:deleted':
      s.removeFrameProposal(msg.proposalId)
      break
    case 'canvasProposal':
      s.upsertCanvasProposal(msg.proposal)
      break
    case 'question':
      s.upsertQuestion(msg.question)
      break
    case 'canvas:reviewMode':
      s.setReviewModeLocal(msg.reviewMode)
      break
    case 'canvas:reviewPolicy':
      s.setReviewPolicyLocal(msg.reviewPolicy, msg.approvalTools)
      break
    case 'component':
      /* a component broadcast carries the whole record while the panel lists
         summaries, so the row is built here; the id is on the message either
         way, which is how a deletion names the row it removes */
      s.upsertComponent(msg.component ? summarizeComponent(msg.component, s.components) : null, msg.componentId)
      break
    case 'frame:lock':
      s.setFrameLock(msg.frameId, msg.holder)
      break
    case 'canvas:deleted':
      /* the room only receives this for the canvas it's viewing */
      location.href = '/'
      break
    case 'pages':
      s.setPagesLocal(msg.pages)
      break
    case 'activity':
      s.pushActivity(msg.item)
      break
  }
}
