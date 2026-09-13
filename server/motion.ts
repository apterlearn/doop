import type { Frame } from '../shared/types.ts'
import { probeFrame, type Probe, type ProbeElement } from './domProbe.ts'

/**
 * Motion: what a frame does over time, as opposed to what it looks like.
 *
 * `set_frame_css` can author a transition, a keyframe or a media query, and
 * until now nothing could read one back — a screenshot is one frame of an
 * animation, so the moving half of a design was invisible to every check. The
 * probe already carries the raw evidence (the computed transition and
 * animation properties of each element, and the frame's own stylesheet text);
 * this module is the analysis over it, the way `designLint` is the analysis
 * over computed colors.
 */

export interface MotionReport {
  keyframes: { name: string; steps: number }[]
  media_queries: { prelude: string; rules: number }[]
  /** elements that actually run a transition, capped */
  transitions: { selector: string; property: string; duration: number }[]
  /** elements that actually run an animation, capped */
  animations: { selector: string; name: string; duration: number; iterations: string }[]
  reduced_motion: boolean
  /** short observations a reader would otherwise have to derive */
  notes: string[]
}

/** Entries each per-element list carries. Motion is a summary of a design, not
 *  an inventory of every element in it. */
const MAX_MOTION_ENTRIES = 40
/** A duration past which motion reads as broken rather than as animation. */
export const MOTION_LONG_DURATION_MS = 1000

/** A computed style's comma-separated list: `transition-property` and its
 *  siblings are lists even when they hold one value. */
function cssList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/** The value a repeating CSS list uses at `index`: the lists are cycled to the
 *  longest one, so a single duration applies to every property. */
function pick(list: string[], index: number): string | undefined {
  return list.length ? list[index % list.length] : undefined
}

/** A computed duration in milliseconds. Anything that is not a time (`normal`,
 *  an absent property) is no motion at all. */
export function motionDurationMs(value: string | undefined): number {
  const match = (value || '').trim().match(/^(-?[\d.]+)(ms|s)$/)
  if (!match) return 0
  const amount = Number.parseFloat(match[1]!)
  return match[2] === 's' ? amount * 1000 : amount
}

export interface ElementMotion {
  transitions: { property: string; duration: number }[]
  animations: { name: string; duration: number; iterations: string }[]
}

/** What one element actually runs. A transition needs a duration to exist: the
 *  browser's computed default is `all 0s ease 0s`, so every element reports a
 *  non-`none` property and only the duration separates motion from none. An
 *  animation is the opposite — its name is `none` until one is declared. */
export function elementMotion(el: ProbeElement): ElementMotion {
  const properties = cssList(el.style.transitionProperty)
  const durations = cssList(el.style.transitionDuration)
  const transitions: ElementMotion['transitions'] = []
  properties.forEach((property, index) => {
    if (property === 'none') return
    const duration = motionDurationMs(pick(durations, index))
    if (duration > 0) transitions.push({ property, duration })
  })
  const names = cssList(el.style.animationName).filter((name) => name !== 'none')
  const animationDurations = cssList(el.style.animationDuration)
  const iterations = cssList(el.style.animationIterationCount)
  return {
    transitions,
    animations: names.map((name, index) => ({
      name,
      duration: motionDurationMs(pick(animationDurations, index)),
      iterations: pick(iterations, index) ?? '1',
    })),
  }
}

/** The report over a chosen set of elements: one shape, so a scoped read and a
 *  whole-frame read can never disagree about how they are built. The published
 *  lists are capped; the counts the notes quote are not, so a frame with more
 *  moving elements than the cap still reports how many there are. */
function report(probe: Probe, elements: ProbeElement[]): MotionReport {
  const transitions: MotionReport['transitions'] = []
  const animations: MotionReport['animations'] = []
  const moving = new Set<string>()
  let long = 0
  let forever = 0
  for (const el of elements) {
    const motion = elementMotion(el)
    if (motion.transitions.length || motion.animations.length) moving.add(el.selector)
    for (const entry of motion.transitions) {
      if (entry.duration > MOTION_LONG_DURATION_MS) long += 1
      if (transitions.length < MAX_MOTION_ENTRIES) transitions.push({ selector: el.selector, ...entry })
    }
    for (const entry of motion.animations) {
      if (entry.duration > MOTION_LONG_DURATION_MS) long += 1
      if (entry.iterations === 'infinite') forever += 1
      if (animations.length < MAX_MOTION_ENTRIES) animations.push({ selector: el.selector, ...entry })
    }
  }
  const reducedMotion = probe.motion?.reducedMotion ?? false
  const notes: string[] = []
  if (moving.size === 0) notes.push('nothing in this frame transitions or animates')
  else {
    if (!reducedMotion)
      notes.push(`no prefers-reduced-motion query while ${moving.size} element${moving.size === 1 ? '' : 's'} animate`)
    if (long) notes.push(`${long} duration${long === 1 ? '' : 's'} run past ${MOTION_LONG_DURATION_MS}ms`)
    if (forever) notes.push(`${forever} animation${forever === 1 ? '' : 's'} repeat forever`)
  }
  return {
    keyframes: probe.motion?.keyframes ?? [],
    media_queries: probe.motion?.mediaQueries ?? [],
    transitions,
    animations,
    reduced_motion: reducedMotion,
    notes,
  }
}

/** The motion a probe declares: the keyframes and media queries in the frame's
 *  own CSS, and the transitions and animations its elements run. Pure over a
 *  probe, so the report is verifiable without a browser. */
export function motionProbe(probe: Probe): MotionReport {
  return report(probe, probe.elements)
}

/** The motion a rendered frame declares. `selector` scopes the element lists to
 *  one element and its descendants, using the same selector syntax every other
 *  tool takes. */
export async function motionFrame(frame: Frame, opts: { selector?: string } = {}): Promise<MotionReport> {
  const probe = await probeFrame(frame)
  if (!opts.selector) return motionProbe(probe)
  const selector = opts.selector
  const scoped = probe.elements.filter((el) => el.selector === selector || el.selector.startsWith(`${selector} > `))
  /* a selector that matches nothing is reported as such: "nothing animates"
     would read as a fact about the frame the caller never asked about */
  if (!scoped.length) return { ...report(probe, []), notes: [`selector ${selector} matched no element in this frame`] }
  return report(probe, scoped)
}
