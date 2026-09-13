/**
 * Limits for content that becomes a frame, and the per-user request rates the
 * MCP surface enforces.
 *
 * A frame is stored whole, broadcast whole to every viewer on each edit, and
 * returned whole to agents on every get_frame call. Every path that turns
 * outside content into a frame is bounded here, in one place, so the numbers
 * are set against each other rather than picked in isolation — and the rate
 * limits live beside them so the capabilities tool can report what is
 * actually enforced.
 */

/** The largest HTML document any acquisition path turns into a frame: a
 *  webpage import, a Context.dev capture, or a snippet snapshot. */
export const MAX_FRAME_HTML_BYTES = 3_000_000

/** CSS that stays in an imported frame after unused rules are pruned. Sized
 *  to leave room for the page's own markup under MAX_FRAME_HTML_BYTES. */
export const MAX_IMPORT_CSS_BYTES = 2_000_000

/** Raw stylesheet bytes fetched from a site before pruning. Bounds what an
 *  untrusted host can make the server download, and must fit one bundled
 *  stylesheet since real sites ship one multi-megabyte sheet per product. */
export const MAX_IMPORT_CSS_FETCH_BYTES = 8_000_000

/** Sitemap and HTML bytes read per document while discovering a site's pages. */
export const MAX_DISCOVERY_BYTES = 2_000_000

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/*                                                                     */
/* The MCP layer enforces these per connecting user, and capabilities() */
/* reports them back to the agent. One definition here, so the number   */
/* an agent is told is the number it is actually held to.               */
/* ------------------------------------------------------------------ */

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** Every render (screenshot, inspect, lint, audit, review, diff, image
 *  export) boots a Chromium page; one shared budget keeps an agent from
 *  holding the browser hostage. Override with DOOP_RENDERS_PER_MIN. */
export const RENDERS_PER_MIN = positiveInt(process.env.DOOP_RENDERS_PER_MIN, 60)

/** Photo search burns the shared Pexels quota (200 req/hour on the free tier). */
export const SEARCHES_PER_MIN = 12

/** Image generation is the one call that spends money per result and takes
 *  tens of seconds, so it gets a tighter per-user rate than search. Override
 *  with DOOP_IMAGES_PER_MIN. */
export const IMAGES_PER_MIN = positiveInt(process.env.DOOP_IMAGES_PER_MIN, 6)

/** Uploads write into the asset store, mirroring the browser upload route. */
export const UPLOADS_PER_MIN = 15

/** Importing writes a potentially large HTML frame, so keep it at the same
 *  conservative per-user rate as the browser UI's import endpoint. */
export const IMPORTS_PER_MIN = 5
