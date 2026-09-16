import type { ClientMessage, Component, ComponentSummary, ServerMessage } from '../../shared/types'
import { getIdentity } from './identity'
import { isReadOnly, useStore } from './store'

let socket: WebSocket | null = null
let currentCanvasId: string | null = null
/* the share-link ticket this client joined with, when it has no session;
   kept beside the canvas id so a reconnect rejoins the same way */
let currentTicket: string | null = null
/* the ticket whose renewal this page has already spent. A room that refuses
   the ticket it just minted would otherwise be asked again on every close,
   which is a refresh loop with a reload's consequences; keying it by the
   ticket string rather than a flag is what lets a genuinely new ticket — the
   next link open, a rejoin — be renewed in its turn. */
let refreshedTicket: string | null = null
let retryTimer: number | null = null
/* the server build this page first connected under; survives reconnects */
let loadedBuild: string | null = null

/** Open the room for a canvas. A signed-out visitor passes the ticket its
 *  share link minted — the join is otherwise cookie-only, and the server
 *  takes a ticket holder as a reader. */
export function connect(canvasId: string, ticket?: string) {
  currentCanvasId = canvasId
  currentTicket = ticket ?? null
  open()
}

export function disconnect() {
  currentCanvasId = null
  currentTicket = null
  if (retryTimer) window.clearTimeout(retryTimer)
  socket?.close()
  socket = null
}

/* Messages that only say where this client is or what it is dragging. A
   read-only visitor must not send them at all: the room ignores a ticket
   holder's anyway, so sending them would only claim a presence it does not
   have. Everything else (there is nothing else today) goes through. */
const PRESENCE_ONLY: ClientMessage['type'][] = ['cursor', 'editing', 'focus', 'frame:drag']

export function sendWs(msg: ClientMessage) {
  if (PRESENCE_ONLY.includes(msg.type) && isReadOnly(useStore.getState())) return
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
    sendWs({
      type: 'join',
      canvasId,
      clientId,
      name,
      kind: 'user',
      ...(currentTicket ? { ticket: currentTicket } : {}),
    })
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
    /* the retry this socket scheduled has already been spent — dropping the
       handle here is what keeps a terminal close below from being followed
       by one more attempt */
    if (retryTimer) {
      window.clearTimeout(retryTimer)
      retryTimer = null
    }
    if (ev.code === 4401) {
      /* 4401 is the room finding neither a session nor a ticket that still
         verifies, and a ticket holder is the one caller that can be let back
         in without the sign-in page: the ticket is the credential, the server
         re-checks the link's live mode before minting another, and no password
         is ever held here. Once per ticket — the fallthrough below is where a
         refused renewal, and every session user, still lands. */
      const ticket = currentTicket
      const canvasId = currentCanvasId
      if (ticket && canvasId && refreshedTicket !== ticket) {
        void refreshTicket(s, canvasId, ticket)
        return
      }
      /* session expired or missing — reload lands on the sign-in page */
      currentCanvasId = null
      location.reload()
      return
    }
    /* 4403: the owner locked this canvas. 4404: the canvas is gone from the
       server's store — deleted, or sitting in the trash. Neither is worth a
       retry (an open tab would hammer the room every 1.2s forever), and
       neither has a tab to come back to, so both land on the dashboard. */
    if (ev.code === 4403 || ev.code === 4404) {
      currentCanvasId = null
      location.href = '/'
      return
    }
    /* 4409: this client sent a message past the room's payload cap, so the two
       ends no longer agree on the protocol — and the same client would be
       refused the same way on every reconnect. The socket state is dropped and
       nothing is retried; `connected` is already false above, which is the
       page's own connection line, and the reason is logged for whoever has to
       put this client back in step. */
    if (ev.code === 4409) {
      currentCanvasId = null
      currentTicket = null
      socket = null
      console.error(
        `doop: the room closed this connection (4409${ev.reason ? ` ${ev.reason}` : ''}) — a message was past its size cap, so reconnecting would only be refused again`,
      )
      return
    }
    if (currentCanvasId) {
      retryTimer = window.setTimeout(open, 1200)
    }
  }
}

/** Trade the ticket this page joined with for another half hour, then reopen
 *  the room under it. The route is public and session-free — the ticket is the
 *  whole credential — so this is a bare fetch, the same shape the share link
 *  itself was opened with. `dead` is the socket whose close asked for this: if
 *  it is no longer the current one by the time the answer lands, something
 *  else already reconnected this page and this answer is stale, exactly as the
 *  socket's own handlers decide. */
async function refreshTicket(dead: WebSocket, canvasId: string, ticket: string) {
  let next: string | null = null
  try {
    const res = await fetch(`/api/public/canvases/${canvasId}/guest-ticket/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    if (res.ok) {
      const body = (await res.json()) as { ticket?: unknown }
      if (typeof body.ticket === 'string') next = body.ticket
    } else {
      /* 401 the link is off or the ticket was refused, 403 the link's mode was
         narrowed below this ticket's, 429 this address has asked too often —
         none of them is worth a second request */
      const detail = (await res.json().catch(() => null)) as { code?: string } | null
      console.error(
        `doop: the room would not renew this link's ticket (${res.status}${detail?.code ? ` ${detail.code}` : ''}) — reloading lands on the sign-in page`,
      )
    }
  } catch (err) {
    console.error("doop: could not reach the server to renew this link's ticket — reloading", err)
  }
  if (socket !== dead) return
  if (!next) {
    /* every refusal ends where 4401 always ended: nothing left to show, and a
       reload that lands on the sign-in page (or back on the link that brought
       this visitor here) */
    currentCanvasId = null
    location.reload()
    return
  }
  /* the new ticket is the guard as well as the credential: were the room to
     refuse it too, the next 4401 finds it already renewed and reloads instead
     of asking again */
  refreshedTicket = next
  currentTicket = next
  /* the ws join is not the only carrier of this credential: the public
     comment route reads the ticket off the stored guest session, so without
     this the visitor's next comment would still send the refused string */
  useStore.getState().setGuestTicket(next)
  open()
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
      s.setRunEvents(msg.runEvents ?? [])
      s.setMessages(msg.messages ?? [])
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
    case 'frames:reordered':
      s.applyFrameOrderLocal(msg.pageId, msg.frames)
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
    case 'agentMessage':
      /* the chat's one live case: a posted message, or a delete (message
         null, id on the message either way) */
      s.upsertMessage(msg.message, msg.messageId)
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
    case 'run:event':
      s.pushRunEvent(msg.event)
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
