import { useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import type { AgentMessage } from '../../shared/types'
import { colorFor } from '../../shared/types'
import { AGENT_ROLES, roleFor } from '../../shared/agents'
import { ApiError, api } from '../lib/api'
import { getIdentity } from '../lib/identity'
import { isReadOnly, useStore } from '../lib/store'
import { timeAgo } from '../lib/time'
import { cn } from '@/lib/utils'
import { AgentIcon } from './AgentIcon'
import { Avatar } from './ui/avatar'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { ChevronDownIcon } from './ui/icons'
import { ListHint, ListItem, ListMeta, ListTitle } from './ui/list'
import { PanelBody } from './ui/panel'
import { Textarea } from './ui/textarea'

/* The Chat tab: the canvas's free-form human↔agent channel. Distinct from an
   element comment (pinned to a thing in a frame and resolved) and from a
   question (which blocks the agent until a human answers): this is the queue an
   agent reads when it has nothing else to do, and how a person parks a thought
   for an agent that is not connected yet. Nothing here is a control surface
   except the send — the room pushes every message, so the list is the store's,
   not this panel's copy of it.

   One rule shapes the composer: the picker and the @mention do the same job.
   The picker sets `to` explicitly, a mention in the body lets the server route
   the message the way it routes a comment, and the suggestion row offers the
   spellings that resolve — the connected agents by name, and the role
   vocabulary from shared/agents.ts. */

const selectCls =
  'h-7 cursor-pointer appearance-none rounded-md border border-line bg-surface pl-2 pr-6 text-base font-medium text-ink outline-none transition-[border-color] focus:border-ink md:text-[11.5px]'

const rowGlyph = 'grid size-[30px] flex-none place-items-center rounded-[9px] border bg-surface'

export function ChatPanel() {
  const canvasId = useStore((s) => s.canvas?.id)
  const messages = useStore((s) => s.messages)
  const presences = useStore((s) => s.presences)
  const setMessages = useStore((s) => s.setMessages)
  const upsertMessage = useStore((s) => s.upsertMessage)
  /* a viewer reads the channel and posts nothing to it */
  const readOnly = useStore(isReadOnly)

  const [draft, setDraft] = useState('')
  /* '' is Everyone — no `to`, so the message goes to the whole channel */
  const [recipient, setRecipient] = useState('')
  const [sending, setSending] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  /* the marker that scrolls the log to its end, and whether the reader is
     still at that end */
  const end = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)

  /* The room's init carries the recent conversation, so opening this tab
     usually has nothing to fetch. It asks the route only when the store has
     nothing to show — a client that joined before the canvas sent messages —
     and re-checks after the await, because a message can arrive while the
     request is in flight and that live arrival must not be replaced by a
     snapshot taken without it. */
  useEffect(() => {
    if (!canvasId || useStore.getState().messages.length > 0) return
    let live = true
    api
      .agentMessages(canvasId)
      .then((list) => {
        if (live && useStore.getState().messages.length === 0) setMessages(list)
      })
      .catch(() => {
        /* no banner for this: the room still pushes every message that lands
           from here on, and the log is simply the shorter for it */
      })
    return () => {
      live = false
    }
  }, [canvasId, setMessages])

  /* A chat opens at its newest message and follows the conversation. A reader
     who scrolled back up is left where they are — an arrival is not a reason
     to yank them off the message they were reading. */
  useEffect(() => {
    if (atEnd.current) end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  /* The agents on this canvas right now. A role is not a connection: it is
     routing vocabulary, so the two lists are offered separately and only the
     live ones can be stopped or steered (see the Run tab). */
  const agents = useMemo(() => {
    const names = new Set<string>()
    for (const p of Object.values(presences)) if (p.kind === 'agent') names.add(p.name)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [presences])

  /* The @mention being typed at the end of the draft, when there is one: the
     token the suggestion row completes. A name with spaces is matched whole
     ("@Alex Sm"), which is the spelling a live agent is mentioned by. */
  const mentionQuery = /(?:^|\s)@([\w -]*)$/.exec(draft)?.[1]
  const suggestions = useMemo(() => {
    if (mentionQuery === undefined) return []
    const needle = mentionQuery.toLowerCase()
    const candidates: { mention: string; keys: string[] }[] = agents.map((name) => ({
      mention: name,
      keys: [name, name.replace(/\s+/g, '')],
    }))
    for (const role of AGENT_ROLES) {
      /* a role's mention spelling is its squashed display name (`UXLead`) —
         the spelling `mentionsFor` in shared/agents.ts recognises */
      const mention = role.name.replace(/\s+/g, '')
      candidates.push({ mention, keys: [mention, role.name, role.id, ...(role.aliases ?? [])] })
    }
    /* six is the row: a mention is being completed, not browsed */
    return candidates.filter((c) => c.keys.some((k) => k.toLowerCase().startsWith(needle))).slice(0, 6)
  }, [mentionQuery, agents])

  function completeMention(mention: string) {
    setDraft((d) => d.replace(/(^|\s)@[\w -]*$/, (_whole, lead: string) => `${lead}@${mention} `))
    field.current?.focus()
  }

  /* Send: the message goes up optimistically under a local id, so the row is
     there the moment Enter is pressed. The POST's reply then replaces that row
     with the server's own — and the store's upsert folds it into the broadcast
     if that arrived first, since both carry the same id. A failed send takes
     the row back out and puts the text back in the field: nothing typed is lost
     and nothing is shown as sent that was not. */
  async function send() {
    const body = draft.trim()
    if (!canvasId || !body || sending) return
    const me = getIdentity()
    const optimistic: AgentMessage = {
      id: `pending:${nanoid(8)}`,
      canvasId,
      authorName: me.name,
      authorKind: 'user',
      authorColor: colorFor(me.name),
      ...(recipient ? { to: recipient } : {}),
      body,
      at: Date.now(),
    }
    setDraft('')
    setError('')
    setSending(true)
    upsertMessage(optimistic, optimistic.id)
    try {
      const saved = await api.postAgentMessage(canvasId, body, recipient || undefined)
      upsertMessage(saved, optimistic.id)
    } catch (err) {
      upsertMessage(null, optimistic.id)
      setDraft(body)
      setError(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t send that.')
    } finally {
      setSending(false)
    }
  }

  async function remove(id: string) {
    if (!canvasId || deleting) return
    setDeleting(id)
    setError('')
    try {
      await api.deleteAgentMessage(canvasId, id)
      /* the room broadcasts the deletion too; dropping the row here as well
         makes the click land now, and removing it twice is a no-op */
      upsertMessage(null, id)
    } catch (err) {
      setError(err instanceof ApiError && typeof err.body.error === 'string' ? err.body.error : 'Couldn’t delete that.')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <>
      <PanelBody
        className="py-2"
        onScroll={(e) => {
          const el = e.currentTarget
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
        }}
      >
        {messages.length === 0 && (
          <ListHint>
            Nothing said yet. Agents read this channel when they connect, so a thought parked here reaches them then.
            @mention a role — @ux, @copy, @a11y — to route a message to whoever works it.
          </ListHint>
        )}
        {messages.map((m) => (
          <ChatRow
            key={m.id}
            message={m}
            canWrite={!readOnly}
            busy={deleting === m.id}
            onDelete={() => void remove(m.id)}
          />
        ))}
        <div ref={end} />
      </PanelBody>

      {readOnly ? (
        <div className="shrink-0 border-t border-line-soft px-4 py-3 text-[11.5px] leading-[1.45] text-ink-soft">
          Read only — the channel is readable on this link, and posting needs an account.
        </div>
      ) : (
        <div className="shrink-0 border-t border-line-soft px-4 pt-2.5 pb-3">
          <label className="flex items-center gap-1.5 pb-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            To
            <span className="relative flex items-center">
              <select
                aria-label="Send to"
                className={selectCls}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              >
                <option value="">Everyone</option>
                {agents.length > 0 && (
                  <optgroup label="Connected agents">
                    {agents.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Roles">
                  {AGENT_ROLES.map((role) => (
                    <option key={role.id} value={role.id} title={role.blurb}>
                      {role.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <ChevronDownIcon
                width={10}
                height={10}
                className="pointer-events-none absolute right-[7px] text-ink-faint"
              />
            </span>
          </label>

          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1 pb-1.5">
              {suggestions.map((s) => (
                <Button
                  key={s.mention}
                  variant="ghost"
                  size="pill"
                  className="text-[11px]"
                  title={`Mention @${s.mention}`}
                  /* the click must not pull focus out of the field the mention
                     is being typed into */
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => completeMention(s.mention)}
                >
                  @{s.mention}
                </Button>
              ))}
            </div>
          )}

          <Textarea
            ref={field}
            className="min-h-[62px] text-[13px]"
            value={draft}
            placeholder={recipient ? `Message @${recipient}…` : 'Message the agents on this canvas…'}
            onChange={(e) => {
              setDraft(e.target.value)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <ListMeta>Enter sends · ⇧Enter for a new line</ListMeta>
            <Button
              variant="primary"
              size="sm"
              className="text-[11.5px]"
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
            >
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
          {error && <div className="mt-1.5 text-[11.5px] text-accent-ink">{error}</div>}
        </div>
      )}
    </>
  )
}

/** One message. An agent wears its own mark in the colour the canvases know it
 *  by; a person wears the initials disc every other surface shows them as. A
 *  `to` renders as the mention chip, spelled the way the body would spell it —
 *  a role's display name (`@Copywriter`) rather than the id it is stored as. */
function ChatRow({
  message,
  canWrite,
  busy,
  onDelete,
}: {
  message: AgentMessage
  canWrite: boolean
  busy: boolean
  onDelete: () => void
}) {
  const role = message.to ? roleFor(message.to) : undefined
  return (
    <ListItem className="gap-1.5 py-2.5">
      <div className="flex items-start gap-2">
        {message.authorKind === 'agent' ? (
          <span className={rowGlyph} style={{ borderColor: message.authorColor, color: message.authorColor }}>
            <AgentIcon name={message.authorName} size={15} color={message.authorColor} />
          </span>
        ) : (
          <Avatar name={message.authorName} color={message.authorColor} kind="user" className="flex-none" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <ListTitle className="min-w-0 truncate">{message.authorName}</ListTitle>
            {message.to && (
              <Badge tone="outline" title={role ? role.blurb : `To ${message.to}`}>
                @{role?.name ?? message.to}
              </Badge>
            )}
          </div>
          {/* the body keeps its own line breaks: a multi-line thought is how it
              was written, not a paragraph to re-wrap */}
          <div className="mt-1 text-[12.5px] leading-[1.45] break-words whitespace-pre-wrap text-ink">
            {message.body}
          </div>
          <div className="mt-1 flex items-center gap-1">
            <ListMeta>{timeAgo(message.at)}</ListMeta>
            {canWrite && (
              <Button
                variant="bare-danger"
                size="pill"
                className={cn('text-[11px]', busy && 'opacity-45')}
                disabled={busy}
                title="Delete this message"
                onClick={onDelete}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      </div>
    </ListItem>
  )
}
