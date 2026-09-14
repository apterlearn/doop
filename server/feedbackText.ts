/**
 * The one wording for "a human asked you for something".
 *
 * Feedback reaches an agent one way: an MCP agent is told on its next tool
 * result — MCP is pull-based, so there is no channel between turns. One
 * wording, so an agent that has seen the block once recognizes it next time.
 */
export interface PendingFeedbackLine {
  from: string
  text: string
  /** what the feedback is about, when it is attached to a card */
  about?: string
}

/** How the MCP surface's tools are named in the block. The names are a
 *  parameter (defaulting to the MCP set), so the block never tells an agent to
 *  call a tool it does not have — that is a turn wasted on a failed call. */
export interface FeedbackToolNames {
  /** the call(s) that find and read the frame the feedback is about */
  locate: string
  /** the call that renders it back for review */
  review: string
}

const MCP_FEEDBACK_TOOLS: FeedbackToolNames = { locate: 'get_canvas / get_frame', review: 'get_frame_screenshot' }

export function feedbackBlock(lines: PendingFeedbackLine[], tools: FeedbackToolNames = MCP_FEEDBACK_TOOLS): string {
  const rendered = lines.map((line) => `- ${line.from}${line.about ?? ''}: ${line.text}`)
  return `HUMAN FEEDBACK — open request(s) on this canvas, now assigned to YOU:\n${rendered.join('\n')}\nAddress this NOW, before continuing your plan: locate the frame in question (${tools.locate}), make the change, and review with ${tools.review}. If it concerns another agent's frame, edit it anyway — a human request overrides the don't-touch-others'-frames etiquette. Update your set_status to say what you're picking up.`
}

/** How the feedback's subject reads in that line. */
export function feedbackAbout(input: { taskStatus?: string; mine: boolean; agentName?: string }): string {
  if (!input.taskStatus) return ''
  const whose = input.mine ? 'your' : `${input.agentName}'s`
  return ` (about ${whose} work: “${input.taskStatus}”)`
}

/** The message shape an agent's conversation keeps: an Anthropic conversation.
 *  The content is opaque here because this module only ever appends a text block
 *  to it — the caller owns the block types. */
export interface LoopMessage {
  /** the SDK's own role union, so the caller's message array is assignable here
   *  without a cast; this module only ever pushes `user` */
  role: 'user' | 'assistant' | 'system'
  content: string | unknown[]
}

/** Put the feedback block in front of the model on the very next turn.
 *
 *  It rides with the message the caller is about to send: after a turn that
 *  used tools, that message is the tool results, and the protocol requires
 *  those to be answered before anything else — a second user message in a row
 *  would break the alternation the Messages API expects. */
export function injectFeedback(messages: LoopMessage[], block: string): void {
  const last = messages[messages.length - 1]
  if (last?.role === 'user') {
    last.content =
      typeof last.content === 'string'
        ? [
            { type: 'text', text: last.content },
            { type: 'text', text: block },
          ]
        : [...(last.content as unknown[]), { type: 'text', text: block }]
    return
  }
  messages.push({ role: 'user', content: block })
}
