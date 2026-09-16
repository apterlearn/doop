import sharp from 'sharp'
import type { DesignTokens, Frame } from '../shared/types.ts'
import { renderFrame } from './screenshot.ts'

/**
 * One PNG of a whole page: every frame of `frames` rendered through the usual
 * frame pipeline (server/screenshot.ts) and laid onto a single background at
 * its own x/y. This is the server half of "Export canvas image"; the route
 * that calls it belongs to the canvas export surface.
 *
 * Layout is pure arithmetic over the frames' boxes, so it is testable without
 * a browser — `layoutCanvas` is exported for exactly that, and it is the only
 * place the numbers are decided: the renderer composites at the positions it
 * returns and reports its width/height, so the PNG and the reported size can
 * never disagree. A frame lands at `x - minX + padding` (same for y), scaled;
 * the image is the union of those boxes plus `padding` on every side.
 *
 * Deliberate simplifications:
 *  - `rotation` is ignored. The stage rotates with a CSS transform, so a
 *    rotated frame's layout box is still its unrotated one and compositing it
 *    unrotated is where the box actually is.
 *  - `opacity` is ignored: the frame is drawn as the browser rasterizes it.
 *  - `z` is ignored. Frames are opaque rectangles at distinct positions on a
 *    page; if two overlap, the later one in `frames` wins.
 *
 * Cost: one isolated Chromium page per renderable frame, sequentially — a
 * page of ten frames is ten page loads and ten PNG encodes. Callers are
 * user-initiated exports, not a hot path, and rendering them concurrently
 * would multiply the peak memory the pixel guard exists to bound.
 */

/** 40 megapixels. A 8000×5000 canvas is 160 MB as RGBA in this process and
 *  more than that inside libvips; refusing with the computed dimensions beats
 *  being OOM-killed halfway through the export. */
export const MAX_CANVAS_PIXELS = 40_000_000

/** Design-px margin around the frames' bounding box, so a frame flush with
 *  the page edge is not flush with the exported image. */
export const CANVAS_IMAGE_PADDING = 40

export interface CanvasImageOptions {
  /** output pixel density; multiplies frame sizes and offsets alike */
  scale?: number
  /** design-px margin around the frames' bounding box */
  padding?: number
  /** CSS colour behind the frames — the default is white, since a frame's own
   *  background is usually transparent */
  background?: string
  /** refuse above this many output pixels (see MAX_CANVAS_PIXELS) */
  maxPixels?: number
}

/** The frames' box in design px, before padding. */
export interface CanvasBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasPlacement {
  frame: Frame
  /** the frame's output-pixel box on the canvas */
  left: number
  top: number
  width: number
  height: number
}

export interface CanvasLayout {
  /** output-pixel size of the PNG */
  width: number
  height: number
  scale: number
  /** where to draw each frame, in the same order as `frames` */
  placements: CanvasPlacement[]
  /** the frames' own extent, without padding — what a caller would report as
   *  "the page is this big"; all zeros when nothing is drawable */
  bounds: CanvasBounds
}

/** Whether the compositor has anything to draw for this frame: hidden frames
 *  are left out by design, and a frame with non-finite geometry has no box to
 *  draw in. `renderCanvasImage` reports both kinds in `skipped`. */
export function isRenderableForCanvas(frame: Frame): boolean {
  return (
    !frame.hidden &&
    Number.isFinite(frame.x) &&
    Number.isFinite(frame.y) &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height)
  )
}

/** A positive, finite scale, or the fallback — 0 and NaN would collapse the
 *  image to nothing rather than fail loudly. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The page's layout: bounding box, output size and per-frame placement. No
 * I/O, no browser — the arithmetic the compositor and any test of it share.
 *
 * A page with nothing to draw still gets a canvas (`padding` on each side of
 * a zero-size box) rather than a zero-pixel image sharp would reject.
 */
export function layoutCanvas(frames: Frame[], opts: { scale?: number; padding?: number } = {}): CanvasLayout {
  const scale = positiveOr(opts.scale, 1)
  const padding = opts.padding === undefined ? CANVAS_IMAGE_PADDING : Math.max(0, positiveOr(opts.padding, 0))
  const drawable = frames.filter(isRenderableForCanvas)
  const empty: CanvasBounds = { x: 0, y: 0, width: 0, height: 0 }
  if (drawable.length === 0) {
    const side = Math.max(1, Math.round(2 * padding * scale))
    return { width: side, height: side, scale, placements: [], bounds: empty }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const frame of drawable) {
    if (frame.x < minX) minX = frame.x
    if (frame.y < minY) minY = frame.y
    if (frame.x + frame.width > maxX) maxX = frame.x + frame.width
    if (frame.y + frame.height > maxY) maxY = frame.y + frame.height
  }
  /* the box the frames occupy is padded on both sides: minX - padding is the
     canvas origin, so a frame's own left is (x - minX + padding) */
  const originX = minX - padding
  const originY = minY - padding
  const placements: CanvasPlacement[] = []
  for (const frame of drawable) {
    placements.push({
      frame,
      left: Math.round((frame.x - originX) * scale),
      top: Math.round((frame.y - originY) * scale),
      width: Math.max(1, Math.round(frame.width * scale)),
      height: Math.max(1, Math.round(frame.height * scale)),
    })
  }
  /* Rubber-band the canvas to the placements. Rounding the box and rounding
     each placement are independent, so the furthest frame can land a pixel
     past the box; sharp crops any overlay that exceeds the base image, and
     growing the base by that pixel keeps the last frame intact. */
  let width = Math.max(1, Math.round((maxX - minX + 2 * padding) * scale))
  let height = Math.max(1, Math.round((maxY - minY + 2 * padding) * scale))
  for (const p of placements) {
    if (p.left + p.width > width) width = p.left + p.width
    if (p.top + p.height > height) height = p.top + p.height
  }
  return {
    width,
    height,
    scale,
    placements,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  }
}

/**
 * Every renderable frame of a page, composited onto one PNG.
 *
 * `tokens` are the canvas's design tokens as the caller knows them: pass the
 * live canvas's tokens for a current export, or the tokens a snapshot was
 * frozen under (releases, canvas versions) — they are bound into each frame
 * by `renderFrame`. `undefined` falls back to the store's current tokens for
 * the frame's canvas, which is only right for the live case.
 *
 * Hidden frames (and frames without finite geometry) are not drawn; their ids
 * come back in `skipped`, so an export can say what it left out instead of
 * silently dropping it. A page where nothing is drawable yields a small blank
 * image — the callers are export buttons, and a blank PNG is a better answer
 * than a throw.
 *
 * Throws when the result would exceed `maxPixels` (default
 * MAX_CANVAS_PIXELS), naming the computed size, before anything is rendered.
 */
export async function renderCanvasImage(
  frames: Frame[],
  tokens: DesignTokens | undefined,
  opts: CanvasImageOptions = {},
): Promise<{ png: Buffer; width: number; height: number; skipped: string[] }> {
  const layout = layoutCanvas(frames, opts)
  const pixels = layout.width * layout.height
  const maxPixels = positiveOr(opts.maxPixels, MAX_CANVAS_PIXELS)
  if (pixels > maxPixels) {
    throw new Error(
      `canvas image would be ${layout.width}×${layout.height} px ` +
        `(${(pixels / 1_000_000).toFixed(1)} MP) — the limit is ${(maxPixels / 1_000_000).toFixed(0)} MP. ` +
        `Lower the scale or export fewer frames.`,
    )
  }
  const skipped = frames.filter((frame) => !isRenderableForCanvas(frame)).map((frame) => frame.id)
  const overlays: sharp.OverlayOptions[] = []
  for (const placement of layout.placements) {
    const png = await renderFrame(placement.frame, layout.scale, { type: 'png', tokens })
    overlays.push({ input: png, left: placement.left, top: placement.top })
  }
  const png = await sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 4,
      background: opts.background ?? '#ffffff',
    },
  })
    .composite(overlays)
    .png()
    .toBuffer()
  return { png, width: layout.width, height: layout.height, skipped }
}
