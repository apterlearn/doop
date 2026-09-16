import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sql } from 'drizzle-orm'
import { db } from './db/index.ts'
import { store } from './store.ts'

/**
 * Deep health for a load balancer: liveness is "this process is answering",
 * readiness is "it can also serve what it is here to serve".
 *
 * Mounting — server/index.ts, replacing the `/healthz` line that only says
 * ok:true, and adding the readiness route beside it:
 *
 *   import { healthReport, livenessReport, markStoreHydrated } from './health.ts'
 *   markStoreHydrated()   // optional but wanted: right after store.init(data.canvases)
 *   app.get('/healthz', (_req, res) => res.json(livenessReport()))
 *   app.get('/readyz', async (_req, res) => {
 *     const report = await healthReport()
 *     res.status(report.ok ? 200 : 503).json(report)
 *   })
 *
 * Only /readyz may touch the database: a liveness probe that waits on it
 * would restart a healthy process because its database is briefly slow, and
 * restarting is exactly what does not fix a slow database. A failing
 * readiness probe takes the instance out of rotation instead, which does.
 */

export interface HealthReport {
  ok: boolean
  uptimeMs: number
  build: string
  db: { ok: boolean; error?: string }
  store: { hydrated: boolean; canvases: number; frames: number }
}

/** How long the readiness ping may take before it is reported as failed. A
 *  probe that waits for a wedged database is a probe that hangs with it, and
 *  a load balancer reads a probe that never answers as a dead instance. */
const DB_PING_TIMEOUT_MS = 2_000

/** The same identifier index.ts computes and hands clients to detect a stale
 *  bundle: the hash of the built client's index.html, and 'dev' when there is
 *  no build (a source-run server). Read from the same file the same way, once
 *  — a probe runs every few seconds and must not re-read it. */
const BUILD = (() => {
  try {
    return createHash('sha1')
      .update(readFileSync(path.join(process.cwd(), 'dist', 'index.html')))
      .digest('hex')
      .slice(0, 12)
  } catch {
    return 'dev'
  }
})()

/** Set by markStoreHydrated(), which index.ts calls once boot hydration has
 *  put the database's canvases in the store. */
let hydratedAtMs: number | null = null

/** Record that boot hydration finished — call once, right after
 *  store.init(data.canvases). Idempotent: the first call is the boot, and a
 *  later one would only move the clock. */
export function markStoreHydrated(): void {
  hydratedAtMs ??= Date.now()
}

/** `select 1` with a deadline. Resolves the failure's message, or null when
 *  the database answered. A timeout is a resolved value rather than a
 *  rejection so the losing half of the race can never surface later as an
 *  unhandled rejection, and the timer is unref'd so a probe that is already
 *  answered never holds the event loop open behind it. */
function pingDb(): Promise<string | null> {
  const ping = db.execute(sql`select 1`).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
  return Promise.race([ping, delay(DB_PING_TIMEOUT_MS, `no answer within ${DB_PING_TIMEOUT_MS}ms`, { ref: false })])
}

/**
 * What a readiness probe reports: the database, and the store the routes
 * actually read from. The store exposes no loaded flag and no frame count, so
 * hydration is the marker index.ts sets (a live map with canvases in it is
 * taken as the same evidence, for a mount that skipped the marker), and the
 * counts come from the map the store does expose — its canvases, each holding
 * its own frames. Trashed content is counted nowhere: it is not what a
 * request will be served.
 */
export async function healthReport(): Promise<HealthReport> {
  const dbError = await pingDb()

  let frames = 0
  for (const canvas of store.canvases.values()) frames += canvas.frames.length
  const storeFacts = {
    hydrated: hydratedAtMs !== null || store.canvases.size > 0,
    canvases: store.canvases.size,
    frames,
  }

  return {
    ok: dbError === null && storeFacts.hydrated,
    uptimeMs: Math.round(process.uptime() * 1000),
    build: BUILD,
    db: dbError === null ? { ok: true } : { ok: false, error: dbError },
    store: storeFacts,
  }
}

/** Liveness: the process is alive and its event loop is turning. No database,
 *  no store, nothing that can fail for a reason a restart would not fix. */
export function livenessReport(): { ok: true; uptimeMs: number } {
  return { ok: true, uptimeMs: Math.round(process.uptime() * 1000) }
}
