import { findBrowserPath } from './screenshot.ts'
import { contextDevConfigured } from './contextDev.ts'
import { MAX_FRAME_HTML_BYTES } from './limits.ts'
import { MAX_ASSET_BYTES } from './assets.ts'
import { listConnections, type GithubConnection } from './github.ts'

/**
 * Which optional integrations are actually live on THIS server. Agents fail
 * at runtime today when a key is missing (image search returns nothing, the
 * screenshot renderer throws); this is the one call that says what exists
 * before an agent plans asset- or import-heavy work.
 */

export interface ServerCapabilities {
  screenshot: boolean
  image_search: 'pexels' | 'none'
  website_import: 'context_dev' | 'chromium' | 'none'
  resident_agent: boolean
  github: 'app' | 'pat' | 'none'
  limits: {
    frame_html_bytes: number
    asset_bytes: number
    renders_per_min: number
    searches_per_min: number
    uploads_per_min: number
    imports_per_min: number
  }
}

const RENDERS_PER_MIN = 60
const SEARCHES_PER_MIN = 20
const UPLOADS_PER_MIN = 12
const IMPORTS_PER_MIN = 10

/** The chromium probe is expensive; ask once per process. */
let screenshotCache: Promise<boolean> | undefined
function screenshotCapability(): Promise<boolean> {
  screenshotCache ??= Promise.resolve(findBrowserPath() !== null)
  return screenshotCache
}

export async function capabilities(): Promise<ServerCapabilities> {
  return {
    screenshot: await screenshotCapability(),
    image_search: process.env.PEXELS_API_KEY ? 'pexels' : 'none',
    website_import: contextDevConfigured() ? 'context_dev' : 'chromium',
    resident_agent: !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY,
    github: await githubMode(),
    limits: {
      frame_html_bytes: MAX_FRAME_HTML_BYTES,
      asset_bytes: MAX_ASSET_BYTES,
      renders_per_min: RENDERS_PER_MIN,
      searches_per_min: SEARCHES_PER_MIN,
      uploads_per_min: UPLOADS_PER_MIN,
      imports_per_min: IMPORTS_PER_MIN,
    },
  }
}

/** GitHub surface: the App (installation tokens), a stored PAT, or nothing. */
async function githubMode(): Promise<'app' | 'pat' | 'none'> {
  const conns = await listConnections('').catch(() => [] as GithubConnection[])
  if (!conns.length) return 'none'
  return conns.some((c) => c.installationId) ? 'app' : 'pat'
}

export const LIMITS = { RENDERS_PER_MIN, SEARCHES_PER_MIN, UPLOADS_PER_MIN, IMPORTS_PER_MIN }
