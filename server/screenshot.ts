import fs from 'node:fs'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { DesignTokens, Frame } from '../shared/types.ts'
import { withTokenStyle } from '../shared/tokens.ts'
import { store } from './store.ts'
import { guardPublicPageRequests } from './publicUrl.ts'

/**
 * Render a frame's HTML in headless Chrome so agents can *see* their work.
 * Uses the system browser via puppeteer-core — no bundled download.
 */

/* how much frame source an agent may read in one go: the cap that keeps a
   60 KB imported document from filling the context window */
export const MAX_HTML_READ_CHARS = 30_000

/** Bounded read of a frame's source HTML for agents: literal-text snippets or a
 *  paged range. Shared by the resident team's get_frame_html and the MCP
 *  get_frame_html so the two can never drift. */
export function readFrameHtml(
  html: string,
  opts: { query?: string; offset?: number; limit?: number },
): { text: string } | { error: string } {
  const limit = Math.max(1000, Math.min(Number(opts.limit) || 20_000, MAX_HTML_READ_CHARS))
  const query = String(opts.query ?? '').trim()
  if (query) {
    const haystack = html.toLowerCase()
    const needle = query.toLowerCase()
    const matches: number[] = []
    let cursor = 0
    while (matches.length < 5) {
      const index = haystack.indexOf(needle, cursor)
      if (index < 0) break
      matches.push(index)
      cursor = index + Math.max(needle.length, 1)
    }
    if (matches.length === 0) return { error: `query not found in frame HTML: ${query}` }
    const perMatch = Math.max(1000, Math.floor(limit / matches.length))
    const snippets = matches.map((index, match) => {
      const start = Math.max(0, index - Math.floor(perMatch / 2))
      const end = Math.min(html.length, start + perMatch)
      return `--- match ${match + 1} at ${index}, chars ${start}-${end} ---\n${html.slice(start, end)}`
    })
    return {
      text: `Frame HTML: ${html.length} characters; ${matches.length} match(es) for "${query}".\n${snippets.join('\n')}`,
    }
  }
  const offset = Math.max(0, Math.min(Number(opts.offset) || 0, html.length))
  const end = Math.min(html.length, offset + limit)
  return {
    text:
      `Frame HTML: ${html.length} characters. Returning chars ${offset}-${end}.` +
      (end < html.length ? ` Continue with offset=${end}, or use query for a targeted snippet.` : '') +
      `\n\n${html.slice(offset, end)}`,
  }
}

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((p): p is string => !!p)

/** The first usable local browser executable, or null when there is none. */
export function findBrowserPath(): string | null {
  for (const p of CHROME_PATHS) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      /* keep looking */
    }
  }
  return null
}

function findBrowser(): string {
  const path = findBrowserPath()
  if (!path) throw new Error('No Chrome/Chromium found. Set CHROME_PATH to a browser executable.')
  return path
}

let browserPromise: Promise<Browser> | null = null

export async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const b = await browserPromise
    if (b.connected) return b
    browserPromise = null
  }
  browserPromise = puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: [
      '--no-first-run',
      '--disable-extensions',
      '--disable-quic',
      '--disable-webrtc-multiple-routes',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--hide-scrollbars',
      /* containers: no user namespaces for the sandbox, tiny /dev/shm */
      ...(process.env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
  })
  return browserPromise
}

export interface IsolatedPage {
  page: Page
  close: () => Promise<void>
}

/** External pages never share cookies, cache or service workers across users
 *  or imports. Closing the wrapper tears down the entire browser context. */
export async function openIsolatedPage(): Promise<IsolatedPage> {
  const browser = await getBrowser()
  const context = await browser.createBrowserContext()
  try {
    const page = await context.newPage()
    let closed = false
    return {
      page,
      close: async () => {
        if (closed) return
        closed = true
        await context.close().catch(() => {})
      },
    }
  } catch (error) {
    await context.close().catch(() => {})
    throw error
  }
}

/** Render an element in the state a human only sees while interacting with it.
 *  `selector` names the element; `pseudo` is the state to force on it. */
export interface InteractionState {
  selector: string
  pseudo: 'hover' | 'focus' | 'active'
}

/** A state render whose selector matches nothing. The tools map this to their
 *  own `not_found` refusal, the same code a missing element already gets. */
export class StateRenderError extends Error {
  readonly code = 'not_found' as const

  constructor(message: string) {
    super(message)
    this.name = 'StateRenderError'
  }
}

/**
 * Ask the browser to render the element as if it were hovered/focused/active.
 *
 * Injecting a rule is not an option: a synthetic class would lose to the
 * frame's own selectors and show a design nobody sees, and rewriting `:hover`
 * into a class changes specificity. `CSS.forcePseudoState` forces the state on
 * the node itself, so the render is the frame's own cascade in that state.
 */
async function forcePseudoState(page: Page, state: InteractionState): Promise<void> {
  const cdp = await page.createCDPSession()
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: 1 })
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: state.selector })
  if (!nodeId)
    throw new StateRenderError(
      `no element matches “${state.selector}” — call inspect_frame or get_element to find the current selector`,
    )
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [state.pseudo] })
}

/** Device presets for responsive checks — one definition, so the screenshot,
 *  inspection and audit tools all mean the same thing by "mobile". */
export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
} as const

export type DeviceName = keyof typeof VIEWPORTS

/** Load a frame into an isolated page. The viewport override is how the same
 *  design gets checked at a phone width without resizing the frame itself.
 *
 *  The canvas's design tokens are bound into the document here, at render
 *  time: every screenshot, lint, review, diff and export sees the same token
 *  values the browser shows, and no frame's stored HTML is touched. Pass
 *  `tokens: null` to render the frame's own document verbatim. */
export async function loadFramePage(
  frame: Frame,
  opts: {
    viewport?: { width: number; height: number }
    tokens?: DesignTokens | null
    /** force a pseudo-class on `selector` before anything reads the page */
    state?: InteractionState
  } = {},
): Promise<IsolatedPage> {
  const loaded = await openIsolatedPage()
  const { page } = loaded
  try {
    const assetOrigin = new URL(process.env.BETTER_AUTH_URL || 'http://localhost:4300').origin
    await guardPublicPageRequests(page, {
      allowUrl: (url) => url.origin === assetOrigin && url.pathname.startsWith('/a/'),
    })
    await page.setViewport({
      width: Math.max(1, Math.round(opts.viewport?.width ?? frame.width)),
      /* A viewport does not need to span an entire imported landing page for
         layout/computed-style inspection; full-page content remains in the DOM. */
      height: Math.max(1, Math.min(Math.round(opts.viewport?.height ?? frame.height), 4000)),
      deviceScaleFactor: 1,
    })
    const tokens = opts.tokens === undefined ? store.getCanvas(frame.canvasId)?.tokens : opts.tokens
    try {
      await page.setContent(withTokenStyle(frame.html || '<!doctype html><html><body></body></html>', tokens), {
        waitUntil: 'load',
        timeout: 8000,
      })
    } catch {
      /* Slow external resources: inspect whatever has rendered. */
    }
    /* Web fonts load after `load`, so a probe or screenshot taken straight away
       measures the fallback face and reports text that reflows a moment later.
       Wait for the font set, but never longer than 3s: a dead font CDN must
       not hold a render hostage — the probe reports which families failed. */
    try {
      await page.evaluate(() =>
        Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]),
      )
    } catch {
      /* no font API, or the page navigated away — carry on */
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (opts.state) await forcePseudoState(page, opts.state)
    return loaded
  } catch (error) {
    await loaded.close()
    throw error
  }
}

export async function renderFrame(
  frame: Frame,
  /* output pixel density — fractional values downscale huge frames */
  scale: number = 1,
  opts: {
    type?: 'png' | 'jpeg'
    quality?: number
    maxHeight?: number
    /** render at this width/height instead of the frame's own size */
    viewport?: { width: number; height: number }
    /** capture the full document height, not just the viewport */
    fullPage?: boolean
    /** capture this region of the frame, in frame pixels */
    clip?: { x: number; y: number; width: number; height: number }
    /** render the element `selector` names in this pseudo-class state */
    state?: InteractionState
  } = {},
): Promise<Buffer> {
  const width = Math.max(1, Math.round(opts.viewport?.width ?? frame.width))
  const height = Math.max(1, Math.round(opts.viewport?.height ?? frame.height))
  const loaded = await loadFramePage(frame, { viewport: { width, height } })
  const { page } = loaded
  try {
    await page.setViewport({ width, height, deviceScaleFactor: scale })
    /* after the viewport, so the forced state is not lost to a resize */
    if (opts.state) await forcePseudoState(page, opts.state)
    const type = opts.type ?? 'png'
    const clip =
      opts.clip !== undefined
        ? {
            x: Math.round(opts.clip.x),
            y: Math.round(opts.clip.y),
            width: Math.max(1, Math.round(opts.clip.width)),
            height: Math.max(1, Math.round(opts.clip.height)),
          }
        : opts.maxHeight && height > opts.maxHeight
          ? { x: 0, y: 0, width, height: Math.round(opts.maxHeight) }
          : undefined
    const buf = await page.screenshot({
      type,
      ...(type === 'jpeg' ? { quality: opts.quality ?? 90 } : {}),
      ...(clip ? { clip } : {}),
      ...(opts.fullPage ? { fullPage: true } : {}),
    })
    return Buffer.from(buf)
  } finally {
    await loaded.close()
  }
}
