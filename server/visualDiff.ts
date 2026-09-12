import sharp from 'sharp'
import type { Frame } from '../shared/types.ts'
import { renderFrame } from './screenshot.ts'

/**
 * Pixel diff between two renders.
 *
 * The agent's loop is "change it, look at it, decide if it is better" — and
 * "look at it" cannot answer "did my fix land" or "is this close to the
 * reference" without a comparison. Both sides are rendered by the same
 * pipeline, decoded with sharp (already a dependency) and compared per pixel;
 * the result also carries a marked-up image so the agent can see WHERE the
 * difference is, not just how much.
 */

export interface DiffResult {
  changed_pixels: number
  total_pixels: number
  changed_ratio: number
  max_delta: number
  /** PNG of the first render, desaturated, with changed pixels marked */
  diff_png: Buffer
  identical: boolean
}

/** Per-channel delta a pixel must exceed to count as changed. Absorbs
 *  antialiasing and font-rasterization noise, which differ run to run even
 *  when the design is byte-identical. */
export const DEFAULT_DIFF_THRESHOLD = 12

const MARKER: [number, number, number] = [255, 0, 255]

export interface Rgba {
  data: Buffer
  width: number
  height: number
}

export interface Comparison {
  changed_pixels: number
  total_pixels: number
  changed_ratio: number
  max_delta: number
  /** desaturated first image with changed pixels marked in magenta */
  diff_png: Buffer
  identical: boolean
}

/** The comparison itself, over two RGBA buffers of the same size. Pure, so the
 *  pixel accounting is verifiable without a browser. */
export async function compareRgba(left: Rgba, right: Rgba, threshold = DEFAULT_DIFF_THRESHOLD): Promise<Comparison> {
  const total = left.width * left.height
  /* desaturated base with the changed pixels marked, built in one pass so the
     channel count is never in question */
  const marked = Buffer.alloc(total * 4)
  let changed = 0
  let maxDelta = 0
  for (let i = 0; i < total; i += 1) {
    const offset = i * 4
    const r = left.data[offset]!
    const g = left.data[offset + 1]!
    const b = left.data[offset + 2]!
    const delta = Math.max(
      Math.abs(r - right.data[offset]!),
      Math.abs(g - right.data[offset + 1]!),
      Math.abs(b - right.data[offset + 2]!),
    )
    if (delta > maxDelta) maxDelta = delta
    const isChanged = delta > threshold
    if (isChanged) changed += 1
    if (isChanged) {
      marked[offset] = MARKER[0]
      marked[offset + 1] = MARKER[1]
      marked[offset + 2] = MARKER[2]
    } else {
      /* Rec. 601 luma: the unchanged design stays readable under the marks */
      const grey = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      marked[offset] = grey
      marked[offset + 1] = grey
      marked[offset + 2] = grey
    }
    marked[offset + 3] = 255
  }
  const diff_png = await sharp(marked, { raw: { width: left.width, height: left.height, channels: 4 } })
    .png()
    .toBuffer()

  return {
    changed_pixels: changed,
    total_pixels: total,
    changed_ratio: total === 0 ? 0 : changed / total,
    max_delta: maxDelta,
    diff_png,
    identical: changed === 0,
  }
}

async function decode(frame: Frame, width: number, height: number): Promise<Rgba> {
  const png = await renderFrame(frame, 1, { viewport: { width, height } })
  const { data, info } = await sharp(png)
    .resize(width, height, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** Compare two frames rendered at the first frame's size. */
export async function diffFrames(a: Frame, b: Frame, opts: { threshold?: number } = {}): Promise<DiffResult> {
  const width = Math.max(1, Math.round(a.width))
  const height = Math.max(1, Math.round(a.height))
  const [left, right] = await Promise.all([decode(a, width, height), decode(b, width, height)])
  return compareRgba(left, right, opts.threshold ?? DEFAULT_DIFF_THRESHOLD)
}
