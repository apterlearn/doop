import * as actions from './actions.ts'
import * as frameLocks from './frameLocks.ts'
import { store } from './store.ts'
import type { Frame } from '../shared/types.ts'

/**
 * Canvas-wide find and replace: the exact text edit `edit_frame_html` makes,
 * swept over a canvas in one call. Renaming a string that repeats across a
 * flow — a product name, a nav label, a price — is otherwise a per-frame loop
 * with a screenshot per frame.
 *
 * Every write goes through `actions.updateFrame`, the seam the MCP tool uses,
 * so version history, review-mode gating and run-journal events all apply
 * exactly as they do for a single edit, and a frame another agent is holding
 * the lock on is reported and stepped over: one busy frame must not cost the
 * sweep the rest of the canvas, and the caller still learns what did not land.
 */

export interface ReplaceResult {
  frames: { frameId: string; name: string; matches: number; applied: boolean; skippedReason?: string }[]
  totalMatches: number
}

/** How one find string is counted and applied to a document. */
interface Pattern {
  /** Occurrences in the document. */
  count(html: string): number
  /** The document with every occurrence replaced. */
  replace(html: string): string
}

/**
 * Compile the find string once, before any frame is read: a pattern that will
 * not compile is a caller bug, and it is refused whole rather than half-way
 * through a canvas.
 *
 * Literal mode mirrors `edit_frame_html` exactly — a case-sensitive substring,
 * with the replacement read the way `String.replace` reads it. Regex mode is
 * one global `RegExp`, case-insensitive unless `caseSensitive` says otherwise
 * (`$1` group references work there as they do anywhere else). `caseSensitive`
 * is a regex flag, so it does not change the literal path, which is the exact
 * match the per-frame tool performs.
 */
function compilePattern(find: string, replace: string, opts: { regex: boolean; caseSensitive: boolean }): Pattern {
  if (find.length === 0) throw new Error('find must not be empty — there is nothing to search for')
  if (opts.regex) {
    const flags = opts.caseSensitive ? 'g' : 'gi'
    let re: RegExp
    try {
      re = new RegExp(find, flags)
    } catch (e) {
      throw new Error(`find is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    }
    return {
      count: (html) => html.match(re)?.length ?? 0,
      replace: (html) => html.replace(re, replace),
    }
  }
  return {
    /* the same count the per-frame tool takes of the same find string */
    count: (html) => html.split(find).length - 1,
    replace: (html) => html.replaceAll(find, replace),
  }
}

export async function replaceInFrames(
  canvasId: string,
  opts: {
    find: string
    replace: string
    frameIds?: string[]
    pageId?: string
    regex?: boolean
    caseSensitive?: boolean
    dryRun?: boolean
    /** Who the sweep resolves as. An agent's canvas sweep is gated by the
     *  canvas's review policy, so that is the default; the human ⌘F replace
     *  passes 'user', because a policy that approves agent writes must not
     *  approve-gate the human's own edit. */
    kind?: 'user' | 'agent'
    actor: { name: string; userId?: string }
  },
): Promise<ReplaceResult> {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new Error(`no canvas with id ${canvasId}`)
  const pattern = compilePattern(opts.find, opts.replace, {
    regex: opts.regex ?? false,
    caseSensitive: opts.caseSensitive ?? false,
  })
  /* A canvas sweep resolves as its caller: an agent's edit is gated by the
     canvas's review policy and answers to the frame's lock, exactly as the MCP
     edit does; a human's ⌘F replace is their own write and is never gated. The
     caller's userId, when it has one, is the account the sweep works for — the
     half of an actor's identity that routes its work. */
  const actor = actions.resolveActor({
    name: opts.actor.name,
    kind: opts.kind ?? 'agent',
    ownerId: opts.actor.userId,
  })
  /* The frames the canvas shows, in canvas order — the list every canvas tool
     reads. Demo frames are product onboarding content, never the design being
     worked on, so they are not a target even when their id is listed. An id
     that is not on this canvas is ignored: the sweep answers for the canvas it
     was handed, and a stale id from another canvas is not a reason to fail. */
  const wanted = opts.frameIds ? new Set(opts.frameIds) : undefined
  const frames = canvas.frames.filter(
    (frame) =>
      !frame.demo && (wanted ? wanted.has(frame.id) : opts.pageId === undefined || frame.pageId === opts.pageId),
  )

  const rows: ReplaceResult['frames'] = []
  let totalMatches = 0
  /* Deliberately no await in the loop: the sweep holds no browser and no I/O
     it has to yield for, so a canvas replaces in one uninterrupted pass — the
     count a frame is reported with is the count the write acted on. */
  for (const frame of frames) {
    const matches = pattern.count(frame.html)
    totalMatches += matches
    if (matches === 0 || opts.dryRun) {
      rows.push({ frameId: frame.id, name: frame.name, matches, applied: false })
      continue
    }
    /* a lock the caller already held is its own — renewed for this write, and
       left standing below; only the claim the sweep takes is given back */
    const held = frameLocks.activeLocks().some((lock) => lock.frameId === frame.id && lock.agentName === actor.name)
    const lock = actions.acquireFrameLock(frame.id, actor)
    if ('heldBy' in lock) {
      rows.push({
        frameId: frame.id,
        name: frame.name,
        matches,
        applied: false,
        skippedReason: `locked by ${lock.heldBy.agentName} until ${new Date(lock.heldBy.expiresAt).toISOString()}`,
      })
      continue
    }
    let updated: Frame | undefined
    let refused: string | undefined
    try {
      /* the frame object is live store state, so this reads the document the
         count above was taken from */
      updated = actions.updateFrame(frame.id, { html: pattern.replace(frame.html) }, actor)
    } catch (e) {
      /* the user locked this frame in the editor: the sweep reports it and
         moves on, exactly as it steps over another agent's lock — one locked
         frame must not cost the canvas the rest of the rename */
      if (!(e instanceof actions.FrameLockedByUserError)) throw e
      refused = e.message
    } finally {
      /* the sweep's claim lasts exactly as long as its write: a canvas rename
         is over when the call returns, and a claim left behind would show the
         agent as editing every frame it touched for the rest of the lock's
         TTL, refusing collaborators work nobody is doing */
      if (!held) actions.releaseFrameLock(frame.id, actor.name)
    }
    rows.push(
      updated
        ? { frameId: frame.id, name: frame.name, matches, applied: true }
        : {
            frameId: frame.id,
            name: frame.name,
            matches,
            applied: false,
            skippedReason: refused ?? 'the frame no longer exists',
          },
    )
  }
  return { frames: rows, totalMatches }
}
