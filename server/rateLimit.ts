/**
 * The global request budget, on top of — never instead of — the per-route
 * limits in limits.ts. Those bound what a caller may spend on one capability
 * (renders, uploads, image generation) and are keyed on the account that
 * spends it; this bounds how fast any caller may ask for anything at all, so
 * a client in a retry loop or a script walking the API cannot turn one slow
 * route into a busy server.
 *
 * Per-process, like every other limit in this server: the architecture is a
 * single instance, and a Map in memory is what that buys. A second instance
 * would enforce its own budget — a shared limit across instances belongs at
 * the proxy in front of them, not here.
 *
 * Mounting — server/index.ts, one app.use, right after express.json() and
 * above the /api session gate, so unauthenticated /api traffic is budgeted
 * too:
 *
 *   import { globalLimitKey, takeGlobalSlot } from './rateLimit.ts'
 *   app.use('/api', (req, res, next) => {
 *     const slot = takeGlobalSlot(globalLimitKey({ ip: req.ip, userId: req.user?.id }))
 *     if (!slot.ok) {
 *       res.set('retry-after', String(slot.retryAfterSeconds))
 *       return res.status(429).json({ error: 'too many requests — slow down and try again' })
 *     }
 *     next()
 *   })
 *
 * What is exempt, and why it is exempt by where it is mounted rather than by
 * a path list: /healthz, /readyz, the built client's static assets, /i/, /a/,
 * /bg/, /relay, /u/ and /ingest are not under /api at all, and better-auth's
 * `app.all('/api/auth/*')` is registered earlier in the stack, so an
 * /api/auth request is answered before this middleware could ever see it.
 * That last one is the important one: a throttled sign-in, OAuth authorize or
 * token call turns a rate limit into a lockout, and the person who needs it
 * most is the one whose account is being used by someone else. Same reasoning
 * for the two probes — a refused liveness probe is an instance a load
 * balancer kills for being busy, which is the opposite of what a limit is
 * for. If this is ever mounted globally instead of under /api, skip those
 * paths, plus GET/HEAD for the asset routes: a canvas opening a hundred
 * thumbnails is one page view, not a hundred requests.
 *
 * req.user is unset that high in the stack, so the budget is keyed on the
 * client IP in practice; globalLimitKey still prefers a user id, which is the
 * better key the moment the mount sits below the /api session gate.
 */

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : fallback
}

/** Calls allowed per window per caller. Override with DOOP_GLOBAL_RATE_LIMIT. */
export const GLOBAL_RATE_LIMIT = positiveInt(process.env.DOOP_GLOBAL_RATE_LIMIT, 300)

/** The window's length. Override with DOOP_GLOBAL_RATE_WINDOW_MS. */
export const GLOBAL_RATE_WINDOW_MS = positiveInt(process.env.DOOP_GLOBAL_RATE_WINDOW_MS, 60_000)

/** One caller's current window: how many calls it has taken, and when the
 *  window they are counted in ends. A count and a reset instant rather than a
 *  list of timestamps — the per-route limiters in index.ts keep arrays
 *  because they are read a handful of times a minute, while this one is read
 *  on every /api request, where a structure that grows with traffic is the
 *  wrong shape. The window is fixed, not sliding: it resets whole, which is
 *  what makes the arithmetic here O(1). */
interface GlobalWindow {
  count: number
  resetAt: number
}

const windows = new Map<string, GlobalWindow>()

/** How many calls pass between opportunistic sweeps. A sweep walks the whole
 *  map, so it must not run per request; every kilocall is often enough that a
 *  caller who stopped is forgotten within seconds of a busy instance's
 *  traffic, and rare enough that the walk is never on the hot path. */
const SWEEP_EVERY = 1_024
let sinceSweep = 0

/** Drop every window that has already expired, and return how many went. An
 *  unswept per-key map is a leak that only shows up as memory, so this runs
 *  both opportunistically (above) and, for an instance that goes quiet with
 *  entries still in it, from a timer — See the mounting note: the timer
 *  belongs beside the other in-process sweeps in index.ts. */
export function sweepGlobalLimits(now = Date.now()): number {
  let dropped = 0
  for (const [key, window] of windows) {
    if (window.resetAt <= now) {
      windows.delete(key)
      dropped++
    }
  }
  return dropped
}

/** Charge one call to `key`, or refuse it with how long until its next
 *  window. The key comes from globalLimitKey; this does not care who a caller
 *  is, only that each one is always the same string. */
export function takeGlobalSlot(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now()
  if (++sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0
    sweepGlobalLimits(now)
  }
  const current = windows.get(key)
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + GLOBAL_RATE_WINDOW_MS })
    return { ok: true }
  }
  if (current.count >= GLOBAL_RATE_LIMIT) {
    /* never 0: a caller told to retry in no seconds retries immediately */
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
  }
  current.count++
  return { ok: true }
}

/** Who a request is charged to: the signed-in user when the mount sits below
 *  the session gate, else the client IP. index.ts sets `trust proxy`, so
 *  req.ip is the client the proxy forwarded for rather than the proxy itself.
 *  Everyone behind one NAT shares an IP budget, which is why a user id wins
 *  whenever there is one. */
export function globalLimitKey(req: { ip?: string; userId?: string }): string {
  return req.userId ? `u:${req.userId}` : `i:${req.ip ?? 'unknown'}`
}

/** What a status surface reports: how many callers hold a live window, and
 *  how many of them are currently refused. Counted from the map on demand
 *  rather than on the hot path — an expired-but-unswept window is not a live
 *  key, and a second structure kept in step with the first is one that
 *  eventually drifts. */
export function globalLimitStats(): { keys: number; limited: number } {
  const now = Date.now()
  let keys = 0
  let limited = 0
  for (const window of windows.values()) {
    if (window.resetAt <= now) continue
    keys++
    if (window.count >= GLOBAL_RATE_LIMIT) limited++
  }
  return { keys, limited }
}
