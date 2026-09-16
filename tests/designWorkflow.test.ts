import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as actions from '../server/actions.ts'
import { runDesignWorkflow } from '../server/designWorkflow.ts'
import { DesignLlmError } from '../server/designLlm.ts'
import * as review from '../server/review.ts'
import * as runLog from '../server/runLog.ts'
import { store } from '../server/store.ts'
import type { Actor, Canvas, DesignTokens, ServerMessage } from '../shared/types.ts'

/* The engine is the loop itself — implementer, deterministic review, judge —
   driven against the real store and the real action layer, so a frame that the
   loop writes is a frame every other surface would see. The two models and the
   review are stubbed: the loop is what is under test, and a real attempt would
   call a provider and boot Chromium. */

/* The real persist surface with the writes that would reach Postgres stubbed:
   the store and the action layer are real, so a canvas created here never
   leaves a row behind. */
vi.mock('../server/db/persist.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    saveCanvas: () => {},
    savePage: () => {},
    saveFrame: () => {},
    deleteFrame: () => {},
    saveReference: () => {},
    deleteReference: () => {},
    saveComponent: () => {},
    saveComment: () => {},
    saveActivity: () => {},
    saveQuestion: () => {},
    saveDecision: () => {},
    saveProposal: () => {},
    saveFrameProposal: () => {},
    saveRunEvent: () => {},
  }
})

/* Only the call itself is stubbed: the module's own error class stays real, so
   the engine's `instanceof DesignLlmError` keeps working. A queue entry is the
   reply text, `{ text, truncated: true }` for a provider that stopped the model
   at its token budget, or `{ throws }` for a call that fails outright. */
const scripted = vi.hoisted(() => ({
  implementer: 'deepseek-v4.1-flash',
  judge: 'kimi-k3',
  replies: {
    implementer: [] as (string | { text: string; truncated: boolean })[],
    judge: [] as (string | { text: string; truncated: boolean })[],
  },
  throws: { implementer: [] as unknown[], judge: [] as unknown[] },
  calls: [] as { model: string; system: string; prompt: string; maxTokens: number }[],
  hold: null as Promise<void> | null,
}))

vi.mock('../server/designLlm.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/designLlm.ts')),
  designComplete: async (input: { model: string; system: string; prompt: string; maxTokens: number }) => {
    scripted.calls.push(input)
    if (scripted.hold) await scripted.hold
    const role = input.model === scripted.implementer ? 'implementer' : 'judge'
    const thrown = scripted.throws[role].shift()
    if (thrown !== undefined) throw thrown
    const reply = scripted.replies[role].shift()
    if (reply === undefined) throw new Error(`no scripted reply for ${input.model}`)
    return typeof reply === 'string' ? { text: reply, truncated: false } : reply
  },
}))

/* One blocking finding, canned: the engine only has to hand the judge what the
   review found, and a real review of a real document needs a browser. */
vi.mock('../server/review.ts', () => ({
  reviewFrame: async (frame: { id: string; updatedAt: number }) => ({
    frame_id: frame.id,
    html_sha: 'stub-sha',
    frame_updated_at: frame.updatedAt,
    reviewed_at: Date.now(),
    viewports: [],
    summary: {
      critical: 1,
      serious: 0,
      errors: 0,
      warnings: 0,
      off_token: 0,
      off_token_font: 0,
      off_token_type: 0,
      content_errors: 0,
      content_warnings: 0,
    },
    blocking: [{ rule: 'missing_alt', selector: 'img.hero', detail: 'the hero image has no alt text', source: 'a11y' }],
    advisory: [],
    failing_viewports: ['mobile'],
    verdict: 'fail',
  }),
}))

/* Whether this host can render is a property of the machine, and the engine
   has to behave on one that cannot. Stubbed so a test can say so — everything
   else in the module (the viewport presets the prompt names) stays real. */
const renderer = vi.hoisted(() => ({ path: '/usr/bin/chromium' as string | null }))
vi.mock('../server/screenshot.ts', async (importOriginal) => ({
  ...((await importOriginal()) as typeof import('../server/screenshot.ts')),
  findBrowserPath: () => renderer.path,
}))

const OWNER_ID = 'design-owner'
const OWNER: Actor = { name: 'Owner', kind: 'user', color: '#111111' }
const AGENT: Actor = { name: 'Claude', kind: 'agent', color: '#7c3aed', owner: 'Test Owner', ownerId: OWNER_ID }
const TOKENS: DesignTokens = {
  colors: { ink: '#111110', paper: '#ffffff' },
  spacing: [8, 16],
  updatedAt: 0,
  updatedBy: 'Owner',
}

/** What the room was told, so a run can be seen landing on the timeline. */
let room: { canvasId: string; message: ServerMessage }[] = []

function seed(canvasId: string, tokens?: DesignTokens, policy?: Partial<Canvas>): void {
  const canvas: Canvas = {
    id: canvasId,
    name: 'Design',
    ownerId: OWNER_ID,
    createdAt: 0,
    updatedAt: 0,
    frames: [],
    ...(tokens ? { tokens } : {}),
    ...policy,
  }
  store.init([canvas])
  runLog.forgetCanvas(canvasId)
}

function judgeReply(verdict: 'pass' | 'fail', summary: string, issues: string[] = []): string {
  return JSON.stringify({ verdict, summary, issues })
}

beforeEach(() => {
  /* a test that fails mid-way does not get to its own mockRestore calls, and
     the next test would inherit its spies and count their calls as its own */
  vi.restoreAllMocks()
  actions.wire(
    () => {},
    () => {},
  )
  actions.wirePresence(() => [])
  actions.hydrateLogs({
    comments: new Map(),
    activity: new Map(),
    decisions: new Map(),
    proposals: new Map(),
  })
  room = []
  runLog.wireBroadcast((canvasId, message) => room.push({ canvasId, message }))
  renderer.path = '/usr/bin/chromium'
  /* the beat tests arm timers and one of them moves the clock: every test
     starts on real time with nothing held open */
  vi.useRealTimers()
  scripted.hold = null
  scripted.replies.implementer.length = 0
  scripted.replies.judge.length = 0
  scripted.throws.implementer.length = 0
  scripted.throws.judge.length = 0
  scripted.calls.length = 0
})

describe('the design workflow loop', () => {
  it('feeds the judge’s issues back to the implementer until the design passes', async () => {
    const canvasId = 'c-pass'
    seed(canvasId, TOKENS)
    scripted.replies.implementer.push('<h1>first</h1>', '<h1>second</h1>')
    scripted.replies.judge.push(
      judgeReply('fail', 'the headline is lost', ['make the headline larger']),
      /* fenced on purpose: models wrap the JSON whatever the prompt says */
      '```json\n' + judgeReply('pass', 'the design meets the brief') + '\n```',
    )

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.judgeVerdict).toBe('pass')
    expect(result.judgeSummary).toBe('the design meets the brief')
    expect(result.issues).toEqual([{ attempt: 1, judgeFeedback: 'make the headline larger' }])
    expect(result.htmlBytes).toBe(Buffer.byteLength('<h1>second</h1>'))
    /* the frame the humans see holds the attempt the judge accepted */
    expect(store.getFrame(result.frameId)?.html).toBe('<h1>second</h1>')

    const implementerCalls = scripted.calls.filter((call) => call.model === scripted.implementer)
    expect(implementerCalls).toHaveLength(2)
    expect(implementerCalls[0]?.prompt).toContain('a hero with one headline')
    expect(implementerCalls[0]?.prompt).toContain('--color-ink: #111110')
    /* the judge marks the design down for not fitting the frame, so the
       implementer is told the frame it is designing into — and the widths it
       is reviewed at, where a stacked layout grows past that height */
    expect(implementerCalls[0]?.prompt).toContain('1280 × 1600 px')
    expect(implementerCalls[0]?.prompt).toContain('390 × 1600, 834 × 1600, 1440 × 1600 px')
    expect(implementerCalls[0]?.prompt).not.toContain('make the headline larger')
    expect(implementerCalls[1]?.prompt).toContain('make the headline larger')
    expect(implementerCalls[0]?.maxTokens).toBe(32_000)

    const judgeCalls = scripted.calls.filter((call) => call.model === scripted.judge)
    expect(judgeCalls).toHaveLength(2)
    /* the judge reads the frame and the deterministic findings, never a render */
    expect(judgeCalls[0]?.prompt).toContain('<h1>first</h1>')
    expect(judgeCalls[0]?.prompt).toContain('missing_alt')
    /* and it is told which artboard it is judging, so it cannot mistake a
       viewport preset's height for the frame's */
    expect(judgeCalls[0]?.prompt).toContain('1280 × 1600 px')
    /* the two kinds of finding arrive in separate fields, because only one of
       them can fail a design — flattened into one list, the judge could not
       tell a blocker from a judgement call */
    const evidence = JSON.parse(judgeCalls[0]!.prompt.split('## Review findings\n')[1]!) as {
      blocking: { rule: string }[]
      advisory: { rule: string }[]
    }
    expect(evidence.blocking.map((f) => f.rule)).toEqual(['missing_alt'])
    expect(evidence.advisory).toEqual([])
    /* and the judge is told what may not fail a design: a frame that passes the
       checks must be able to pass the judge, or the loop cannot converge */
    expect(judgeCalls[0]?.system).toContain('advisory findings are never blockers')
    expect(judgeCalls[0]?.system).toContain('empty space and not a defect')

    /* the engine's own lines: what each attempt is doing as it does it, then
       how the run ended. The MCP wrapper records its own kind: 'tool' event on
       top of these — this is about the engine's half. */
    const events = runLog.getRunEvents(canvasId)
    expect(events.map((event) => `${event.kind}: ${event.summary}`)).toEqual([
      'status: the design meets the brief',
      'status: judge reviewing attempt 2',
      'status: implementing attempt 2/3',
      'status: judge reviewing attempt 1',
      'status: implementing attempt 1/3',
    ])
    expect(events[0]?.ok).toBe(true)
    expect(room.filter((entry) => entry.message.type === 'run:event')).toHaveLength(events.length)

    const pinned = actions.getComments(canvasId).filter((comment) => comment.frameId === result.frameId)
    expect(pinned).toHaveLength(1)
    expect(pinned[0]?.text).toContain('judge verdict pass after 2 attempts')
  })

  it('keeps the last attempt and reports the judge when the budget runs out', async () => {
    const canvasId = 'c-exhausted'
    seed(canvasId)
    scripted.replies.implementer.push('<h1>one</h1>', '<h1>two</h1>')
    scripted.replies.judge.push(
      judgeReply('fail', 'still cramped', ['loosen the spacing']),
      judgeReply('fail', 'still cramped', ['loosen the spacing', 'raise the contrast']),
    )

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 2,
    })

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(2)
    expect(result.judgeVerdict).toBe('fail')
    expect(result.judgeSummary).toBe('still cramped')
    expect(result.issues).toEqual([
      { attempt: 1, judgeFeedback: 'loosen the spacing' },
      { attempt: 2, judgeFeedback: 'loosen the spacing\nraise the contrast' },
    ])
    /* a failed run still leaves its last design on the canvas for a human */
    expect(store.getFrame(result.frameId)?.html).toBe('<h1>two</h1>')
    const implementerCalls = scripted.calls.filter((call) => call.model === scripted.implementer)
    expect(implementerCalls[1]?.prompt).toContain('loosen the spacing')

    /* a failed run reports through the frame comment and its result, and its
       last line on the timeline is the error that ended it */
    const events = runLog.getRunEvents(canvasId)
    expect(events.map((event) => `${event.kind}: ${event.summary}`)).toEqual([
      'error: still cramped',
      'status: judge reviewing attempt 2',
      'status: implementing attempt 2/2',
      'status: judge reviewing attempt 1',
      'status: implementing attempt 1/2',
    ])
    expect(events[0]?.ok).toBe(false)
    expect(room.filter((entry) => entry.message.type === 'run:event')).toHaveLength(events.length)
  })

  it('refuses a reply the provider cut off at the token budget instead of writing half a document', async () => {
    const canvasId = 'c-truncated'
    seed(canvasId)
    /* a reasoning model spends its budget on the trace and is stopped
       mid-document; the HTML that did arrive is a valid opening, which is
       exactly why the text alone cannot be trusted */
    scripted.replies.implementer.push(
      { text: '<!doctype html>\n<html lang="en"><head><title>Pricing</title>', truncated: true },
      '<!doctype html>\n<html lang="en"><body><h1>Pricing</h1></body></html>',
    )
    scripted.replies.judge.push(judgeReply('pass', 'a three-tier pricing section'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a pricing section',
      frameName: 'Pricing',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    /* the cut-off attempt never reached the canvas or the judge */
    expect(store.getFrame(result.frameId)?.html).toContain('<h1>Pricing</h1>')
    expect(scripted.calls.filter((call) => call.model === scripted.judge)).toHaveLength(1)
    expect(result.issues[0]?.judgeFeedback).toContain('cut off at the 32000-token budget')
  })

  it('reads the document out of a reply that introduces it with a sentence', async () => {
    const canvasId = 'c-chatty'
    seed(canvasId)
    /* the shape the real provider returns: a sentence, then a fenced document */
    scripted.replies.implementer.push(
      'Here\'s a complete HTML document for a three-tier pricing section.\n```html\n<!doctype html>\n<html lang="en"><body><h1>Pricing</h1></body></html>\n```\n\nTell me if you want the annual toggle added.',
    )
    scripted.replies.judge.push(judgeReply('pass', 'clear pricing'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a pricing section',
      frameName: 'Pricing',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
    })

    expect(result.ok).toBe(true)
    const html = store.getFrame(result.frameId)?.html ?? ''
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<h1>Pricing</h1>')
    /* neither the model's introduction nor its offer to keep going is part of
       the document */
    expect(html).not.toContain("Here's a complete HTML document")
    expect(html).not.toContain('Tell me if you want')
    expect(html).not.toContain('```')
  })

  it('reviews at the canvas’s own breakpoints, so its pass matches review_frame’s', async () => {
    const canvasId = 'c-breakpoints'
    seed(canvasId, undefined, { breakpoints: [{ name: 'compact', min_width: 600 }] })
    const reviewSpy = vi.spyOn(review, 'reviewFrame')
    scripted.replies.implementer.push('<h1>one</h1>')
    scripted.replies.judge.push(judgeReply('pass', 'fine'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
    })

    expect(result.ok).toBe(true)
    /* the workflow's own review has to be the review the surface runs, or it
       can pass — and pin a pass comment on — a frame that the next
       review_frame fails at a width the canvas itself declares */
    expect(reviewSpy.mock.calls[0]?.[2]).toEqual({ breakpoints: [{ name: 'compact', min_width: 600 }] })
    /* and the implementer is told that width, since it is part of the budget */
    const implementerCalls = scripted.calls.filter((call) => call.model === scripted.implementer)
    expect(implementerCalls[0]?.prompt).toContain('600 × 1600 (compact)')
    reviewSpy.mockRestore()
  })

  it('counts an implementer reply with no HTML as an attempt without writing the frame', async () => {
    const canvasId = 'c-empty'
    seed(canvasId)
    const existing = actions.createFrame(canvasId, { name: 'Hero', html: '<p>existing</p>' }, OWNER)!
    scripted.replies.implementer.push('   ')

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
      frameId: existing.id,
    })

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.frameId).toBe(existing.id)
    expect(result.htmlBytes).toBe(0)
    expect(result.issues).toEqual([{ attempt: 1, judgeFeedback: 'implementer returned no HTML' }])
    expect(result.judgeSummary).toBe('implementer returned no HTML')
    expect(store.getFrame(existing.id)?.html).toBe('<p>existing</p>')
    /* nothing was written, so there was nothing to judge */
    expect(scripted.calls.filter((call) => call.model === scripted.judge)).toHaveLength(0)
  })

  it('ends on an error line when the judge never answers', async () => {
    const canvasId = 'c-silent-judge'
    seed(canvasId)
    scripted.replies.implementer.push('<h1>written</h1>')
    /* the model answered with nothing at all */
    scripted.replies.judge.push('')

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
    })

    expect(result.ok).toBe(false)
    expect(result.judgeVerdict).toBe('fail')
    expect(result.issues).toEqual([{ attempt: 1, judgeFeedback: 'judge reply was not valid JSON: ' }])
    /* the design still landed for a human to look at */
    expect(store.getFrame(result.frameId)?.html).toBe('<h1>written</h1>')
    /* the judge never answered, so the run's last line is the error saying so */
    const events = runLog.getRunEvents(canvasId)
    expect(events.map((event) => `${event.kind}: ${event.summary}`)).toEqual([
      'error: judge reply was not valid JSON:',
      'status: judge reviewing attempt 1',
      'status: implementing attempt 1/1',
    ])
    expect(room.filter((entry) => entry.message.type === 'run:event')).toHaveLength(events.length)
  })

  it('hands the judge the HTML alone when the host has no renderer', async () => {
    const canvasId = 'c-no-renderer'
    seed(canvasId)
    renderer.path = null
    const reviewSpy = vi.spyOn(review, 'reviewFrame')
    scripted.replies.implementer.push('<h1>bare</h1>')
    scripted.replies.judge.push(judgeReply('pass', 'judged the HTML alone'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
    })

    /* a host that cannot render still runs the workflow: the judge gets the
       document, and is told the checks did not run rather than being handed
       findings nobody measured */
    expect(result.ok).toBe(true)
    expect(reviewSpy).not.toHaveBeenCalled()
    const judgeCalls = scripted.calls.filter((call) => call.model === scripted.judge)
    expect(judgeCalls).toHaveLength(1)
    expect(judgeCalls[0]?.prompt).toContain('<h1>bare</h1>')
    expect(judgeCalls[0]?.prompt).toContain('deterministic checks did not run')
    expect(judgeCalls[0]?.prompt).not.toContain('missing_alt')
    reviewSpy.mockRestore()
  })

  it('degrades the same way when a render fails at run time', async () => {
    const canvasId = 'c-render-failed'
    seed(canvasId)
    const reviewSpy = vi.spyOn(review, 'reviewFrame').mockRejectedValueOnce(new Error('no browser'))
    scripted.replies.implementer.push('<h1>bare</h1>')
    scripted.replies.judge.push(judgeReply('pass', 'judged the HTML alone'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
    })

    /* the attempt is already paid for when the render fails, so the run
       finishes on the HTML instead of dying there */
    expect(result.ok).toBe(true)
    const judgeCalls = scripted.calls.filter((call) => call.model === scripted.judge)
    expect(judgeCalls[0]?.prompt).toContain('deterministic checks did not run')
    reviewSpy.mockRestore()
  })

  it('holds the agent’s presence through every model call and clears the beat when the run ends', async () => {
    const canvasId = 'c-beat'
    seed(canvasId)
    const beat = vi.spyOn(actions, 'heartbeatAgent')
    /* the beat is a timer, so the timers the loop arms are the thing to watch:
       presence dropping off mid-design is a beat that stopped, and a run that
       ends with one still armed is a timer outliving the work */
    const armed = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    scripted.replies.implementer.push('<h1>one</h1>', '<h1>two</h1>')
    scripted.replies.judge.push(judgeReply('fail', 'not yet', ['tighten the spacing']), judgeReply('pass', 'good'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
    })

    expect(result.attempts).toBe(2)
    /* two attempts, each an implementer call and a judge call */
    const modelCalls = scripted.calls.length
    expect(modelCalls).toBe(4)
    /* presence expires in ~20s and any one of these calls can outlast it, so
       every model call opens with a beat */
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(modelCalls)
    expect(beat).toHaveBeenCalledWith(canvasId, AGENT)

    /* one timer per model call, on a period shorter than the presence TTL... */
    const handles: unknown[] = armed.mock.results.map((entry) => entry.value)
    expect(handles).toHaveLength(modelCalls)
    expect(armed.mock.calls.every((call) => call[1] === 15_000)).toBe(true)
    /* ...and every one of them is cleared before the run returns: dropping the
       helper's finally would leave the last beat on this agent's presence */
    expect(cleared.mock.calls.length).toBe(handles.length)
    expect(handles.every((handle) => cleared.mock.calls.some((call) => call[0] === handle))).toBe(true)

    beat.mockRestore()
    armed.mockRestore()
    cleared.mockRestore()
  })

  it('keeps beating while a model call is still in flight', async () => {
    const canvasId = 'c-beat-live'
    seed(canvasId)
    const beat = vi.spyOn(actions, 'heartbeatAgent')
    /* the call that outruns the TTL is the case the beat exists for, and
       waiting 15 real seconds for it would make this suite a slow one: the
       clock is moved instead */
    vi.useFakeTimers()
    let release: () => void = () => {}
    scripted.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    scripted.replies.implementer.push('<h1>one</h1>')
    scripted.replies.judge.push(judgeReply('pass', 'good'))

    const run = runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
    })
    /* the implementer is still working 30s in: the beat that opened the call
       plus two ticks is what keeps the agent on the canvas meanwhile */
    await vi.advanceTimersByTimeAsync(30_000)
    expect(scripted.calls).toHaveLength(1)
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(3)

    release()
    scripted.hold = null
    const result = await run
    expect(result.ok).toBe(true)
    /* and the timer is gone with the call it was covering */
    expect(vi.getTimerCount()).toBe(0)
    beat.mockRestore()
  })

  /* A provider's bad night and a provider's refusal are different answers, and
     the difference is money: the retry that fixes a timeout is a paid call that
     cannot fix a model the key cannot reach. */
  it('retries a transient provider failure and passes on the next attempt', async () => {
    const canvasId = 'c-transient'
    seed(canvasId)
    scripted.throws.implementer.push(
      new DesignLlmError('design workflow: The operation was aborted due to timeout', false),
    )
    scripted.replies.implementer.push('<h1>recovered</h1>')
    scripted.replies.judge.push(judgeReply('pass', 'fine now'))

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 3,
    })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.issues).toEqual([
      {
        attempt: 1,
        judgeFeedback: 'implementer call failed: design workflow: The operation was aborted due to timeout',
      },
    ])
    /* the frame holds the attempt that worked, not the one that failed */
    expect(store.getFrame(result.frameId)?.html).toBe('<h1>recovered</h1>')
  })

  it('stops on the first permanent provider refusal instead of paying for retries', async () => {
    const canvasId = 'c-permanent'
    seed(canvasId)
    scripted.throws.implementer.push(
      new DesignLlmError('design workflow: This key is not scoped to any available provider for model x', true),
    )

    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 3,
    })

    expect(result.ok).toBe(false)
    /* one attempt, one call: the other two would be told the same thing */
    expect(result.attempts).toBe(1)
    expect(scripted.calls.filter((call) => call.model === scripted.implementer)).toHaveLength(1)
    expect(result.judgeSummary).toContain('not scoped to any available provider')
    expect(result.frameId).toBe('')
  })

  it('spends the attempt on a transient call failure, and leaves no beat behind', async () => {
    const canvasId = 'c-beat-failure'
    seed(canvasId)
    const beat = vi.spyOn(actions, 'heartbeatAgent')
    vi.useFakeTimers()
    /* a transient provider failure — a timeout, a connection that dropped — is
       mapped to a spent attempt: the only cure the caller has is the retry the
       loop already knows how to do. The beat may not outlive the attempt. */
    scripted.throws.implementer.push(new DesignLlmError('design workflow: the request timed out', false))
    const result = await runDesignWorkflow({
      canvasId,
      brief: 'a hero with one headline',
      frameName: 'Hero',
      implementerModel: scripted.implementer,
      judgeModel: scripted.judge,
      actor: AGENT,
      maxAttempts: 1,
    })

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(1)
    expect(result.judgeVerdict).toBe('fail')
    expect(result.issues[0]?.judgeFeedback).toContain('implementer call failed:')
    expect(result.judgeSummary).toContain('implementer call failed:')
    expect(result.frameId).toBe('')
    expect(beat).toHaveBeenCalledWith(canvasId, AGENT)
    expect(vi.getTimerCount()).toBe(0)
    beat.mockRestore()
  })

  it('lets an unexpected failure out of the run instead of billing it as an attempt', async () => {
    const canvasId = 'c-bug'
    seed(canvasId)
    /* anything that is not the provider talking is a bug in this process: it
       must surface, not be retried three times at the operator's expense */
    scripted.throws.implementer.push(new TypeError('cannot read properties of undefined'))

    await expect(
      runDesignWorkflow({
        canvasId,
        brief: 'a hero with one headline',
        frameName: 'Hero',
        implementerModel: scripted.implementer,
        judgeModel: scripted.judge,
        actor: AGENT,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('cannot read properties of undefined')
    expect(scripted.calls.filter((call) => call.model === scripted.implementer)).toHaveLength(1)
  })
})

describe('the gate an agent checks before spending a model call', () => {
  it('reports the canvases whose policy would refuse the workflow’s writes', () => {
    seed('c-plain')
    seed('c-review', undefined, { reviewMode: true })
    seed('c-destructive', undefined, { reviewPolicy: 'destructive', approvalTools: ['update_frame'] })
    const writes = ['create_frame', 'append_frame_html', 'update_frame']
    /* a plain canvas is seeded, so "not gated" is about its policy rather than
       a canvas that was never there */
    expect(store.getCanvas('c-plain')).toBeDefined()

    expect(actions.agentWritesGated('c-plain', writes)).toBe(false)
    expect(actions.agentWritesGated('c-review', writes)).toBe(true)
    /* destructive gates only the tools the owner listed, so an unlisted write
       still runs the workflow */
    expect(actions.agentWritesGated('c-destructive', ['create_frame', 'append_frame_html'])).toBe(false)
    expect(actions.agentWritesGated('c-destructive', ['update_frame'])).toBe(true)
    /* a canvas that is gone is not gated — the write itself reports that */
    expect(actions.agentWritesGated('c-missing', writes)).toBe(false)
  })
})
