import { createAsset } from './assets.ts'
import * as actions from './actions.ts'
import { store } from './store.ts'
import {
  fetchRepoBinary,
  fetchRepoFile,
  fetchTreePaths,
  githubFrameMarker,
  wrapGeneratedHtml,
  wrapRepoHtml,
  type GithubConnection,
} from './github.ts'
import type { Actor, Frame, RepoScreenRef } from '../shared/types.ts'

/**
 * Reading a connected GitHub repository: the source closure a screen is
 * designed from, the tree the designer investigates, the repo's real assets,
 * and where an imported frame lands. A repo import records its screens as
 * board cards (actions.planRepoCards / addRepoCards); an agent brings one onto
 * the canvas with import_repo_screen, handing over the document it designed.
 *
 * This is the one-time, code-only contract: everything the model sees comes
 * from the repository. Nothing here touches the live site.
 */

/** Bounded source closure: the screen's file, its resolvable local imports
 *  (depth-first, small), and the styling context that shapes every screen. */
const MAX_CLOSURE_FILES = 10
const MAX_CLOSURE_BYTES = 80_000
const MAX_TREE_LINES = 400

const RESOLVE_EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '.css', '/index.tsx', '/index.ts', '/index.jsx', '/index.js']

function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

/** Resolve one import specifier against the repo tree, or undefined. `@/x`
 *  and `~/x` map to the conventional src root nearest the importing file. */
export function resolveImport(spec: string, fromPath: string, paths: Set<string>): string | undefined {
  let base: string | undefined
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = normalize(`${dirOf(fromPath)}/${spec}`)
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    /* alias roots to try, closest to the importing file first */
    const root = fromPath.includes('/src/') ? fromPath.slice(0, fromPath.indexOf('/src/') + 5) : 'src/'
    for (const prefix of [root, 'src/', '']) {
      const candidate = resolveImport('./' + spec.slice(2), prefix + 'x', paths)
      if (candidate) return candidate
    }
    return undefined
  } else {
    return undefined /* a package — the model knows the ecosystem */
  }
  for (const ext of RESOLVE_EXTS) {
    if (paths.has(base + ext)) return base + ext
  }
  return undefined
}

const IMPORT_RE = /import\s[^'"]*?['"]([^'"]+)['"]|from\s+['"]([^'"]+)['"]/g

/** Collect the screen's bounded source closure as prompt-ready sections. */
export async function collectClosure(
  conn: GithubConnection,
  screen: RepoScreenRef,
  paths: string[],
): Promise<{ path: string; text: string }[]> {
  const pathSet = new Set(paths)
  const files: { path: string; text: string }[] = []
  let budget = MAX_CLOSURE_BYTES
  const queue: string[] = [screen.sourcePath]
  const seen = new Set<string>(queue)

  /* styling and copy context first-class: the app shell, global styles,
     theme modules and the page's locale files shape what the screen ACTUALLY
     looks and reads like — without them the model invents a brand */
  const root = screen.sourcePath.includes('/app/')
    ? screen.sourcePath.slice(0, screen.sourcePath.indexOf('/app/') + 5)
    : screen.sourcePath.includes('/pages/')
      ? screen.sourcePath.slice(0, screen.sourcePath.indexOf('/pages/') + 7)
      : ''
  const slug = (screen.route.split('/').filter(Boolean).pop() ?? 'index').toLowerCase()
  const clean = (p: string) => !p.includes('node_modules')
  for (const context of [
    root + 'layout.tsx',
    root.replace(/pages\/$/, 'pages/') + '_app.tsx',
    root.replace(/pages\/$/, 'pages/') + '_document.tsx',
    ...paths.filter((p) => clean(p) && /(^|\/)(globals?|app|main|index)\.css$/.test(p)).slice(0, 2),
    ...paths.filter((p) => clean(p) && /(^|\/)tailwind\.config\.[jt]s$/.test(p)).slice(0, 1),
    ...paths.filter((p) => clean(p) && /(^|\/)(theme|tokens|colors)\.[jt]sx?$/i.test(p)).slice(0, 2),
    /* i18n: the page's own locale file first, else the default English pack */
    ...paths
      .filter(
        (p) =>
          clean(p) &&
          /(locales?|i18n|translations?|lang)\//i.test(p) &&
          /\.(json|[jt]s)$/.test(p) &&
          (p.toLowerCase().includes(slug) || /(^|\/|\.)en(-us)?(\.|\/)/i.test(p)),
      )
      .slice(0, 3),
  ]) {
    if (pathSet.has(context) && !seen.has(context)) {
      seen.add(context)
      queue.push(context)
    }
  }

  while (queue.length && files.length < MAX_CLOSURE_FILES && budget > 0) {
    const path = queue.shift()!
    let text: string
    try {
      text = await fetchRepoFile(conn, path)
    } catch {
      continue /* deleted/oversized — the model works from what resolves */
    }
    if (text.length > budget) text = text.slice(0, budget) + '\n/* …truncated… */'
    budget -= text.length
    files.push({ path, text })
    for (const match of text.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(match[1] ?? match[2] ?? '', path, pathSet)
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved)
        queue.push(resolved)
      }
    }
  }
  return files
}

/** The tree excerpt the model investigates from: design- and content-relevant
 *  paths first, then the rest, capped. */
export function treeExcerpt(paths: string[], sourcePath: string): string {
  const clean = paths.filter((p) => !p.includes('node_modules/') && !/\.(ico|woff2?|ttf|otf|mp4|webm)$/i.test(p))
  const near = dirOf(sourcePath)
  const score = (p: string) =>
    (p.startsWith(near) ? 4 : 0) +
    (/(theme|token|color|style|css|scss|tailwind|chakra)/i.test(p) ? 3 : 0) +
    (/\.(png|jpe?g|webp|svg|gif)$/i.test(p) && /(logo|brand|hero|screenshot|public|assets|images)/i.test(p) ? 2 : 0) +
    (/(locales?|i18n|translations?|content|copy)/i.test(p) ? 3 : 0) +
    (/(component|layout|common|shared|ui)/i.test(p) ? 1 : 0)
  return clean
    .sort((a, b) => score(b) - score(a))
    .slice(0, MAX_TREE_LINES)
    .sort()
    .join('\n')
}

/** A line that begins with a tag — where a bare fragment starts. Commentary
 *  lines never begin with `<`, so a tag mentioned mid-sentence is skipped. */
const FRAGMENT_START = /^[ \t]*<[a-z][a-z0-9-]*[\s>/]/im

/** Turn whatever the model returned into a full document string: a
 *  `<!doctype>` document as-is, a bare `<html>` document with a doctype
 *  added, or a component fragment wrapped in a minimal document. `undefined`
 *  when none of those appear in `raw`. */
function normalizeToDocument(raw: string): string | undefined {
  const doctypeAt = raw.search(/<!doctype/i)
  if (doctypeAt !== -1) return raw.slice(doctypeAt)

  const htmlAt = raw.search(/<html[\s>]/i)
  if (htmlAt !== -1) return `<!doctype html>\n${raw.slice(htmlAt)}`

  const fragmentAt = raw.search(FRAGMENT_START)
  if (fragmentAt !== -1) {
    /* the empty <head> is where wrapGeneratedHtml injects the marker and CSP */
    return `<!doctype html><html><head></head><body>\n${raw.slice(fragmentAt).trimStart()}\n</body></html>`
  }

  return undefined
}

export function extractHtml(blocks: { type: string; text?: string }[]): { html: string; height: number } {
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1]! : text).trim()
  const html = normalizeToDocument(raw)
  if (!html) throw new Error('the model returned no HTML document')
  const height = Math.min(8000, Math.max(480, Number(html.match(/doop-height:\s*(\d+)/)?.[1]) || 900))
  return { html, height }
}

const REPO_REF_RE = /(["'(])repo:([^"')\s]+)(["')])/g
const MAX_TRANSPLANTED_ASSETS = 12
const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
/* same env read as server/auth.ts — asset URLs must be absolute inside
   sandboxed frame iframes */
const ORIGIN = process.env.BETTER_AUTH_URL || 'http://localhost:4300'

/** Transplant the repository's real image assets: every src="repo:<path>"
 *  the model emitted is fetched through the connection and re-hosted in
 *  doop's asset store, so private-repo logos and screenshots render for
 *  every viewer. Unresolvable refs collapse to a transparent pixel rather
 *  than a broken image. */
export async function resolveRepoAssets(conn: GithubConnection, html: string, pathSet: Set<string>): Promise<string> {
  const wanted = [...new Set([...html.matchAll(REPO_REF_RE)].map((m) => m[2]!))]
    .filter((p) => pathSet.has(p))
    .slice(0, MAX_TRANSPLANTED_ASSETS)
  const urls = new Map<string, string>()
  for (const p of wanted) {
    try {
      const asset = await createAsset(await fetchRepoBinary(conn, p), {
        canvasId: conn.canvasId,
        uploadedBy: 'Doop',
      })
      urls.set(p, `${ORIGIN}/a/${asset.id}.${asset.ext}`)
    } catch (err) {
      console.error(`[github-recon] asset ${p} failed`, err)
    }
  }
  return html.replace(REPO_REF_RE, (_full, pre, p, post) => pre + (urls.get(p) ?? TRANSPARENT_PX) + post)
}

/* ------------------------------------------------------------------ */
/* Frame placement                                                     */

const PAGE_W = 1280
const COMPONENT_W = 640
const STATIC_H = 900
const GAP = 80
/** how wide a repo's import grid grows before a new row starts */
const ROW_WIDTH = 3200

/** Where the next frame from this connection goes: frames flow in rows
 *  from the import's origin — right of the row's last frame while it fits,
 *  else a fresh row under everything the connection has landed so far. The
 *  grid is derived from the frames on the canvas, not remembered, so it
 *  survives restarts and frames finishing in any order. */
export function nextRepoFramePosition(
  frames: Pick<Frame, 'x' | 'y' | 'width' | 'height' | 'html'>[],
  connectionId: string,
  width: number,
): { x: number; y: number } {
  const siblings = frames.filter((f) => githubFrameMarker(f.html)?.connectionId === connectionId)
  if (!siblings.length) {
    const rightmost = frames.reduce((right, f) => Math.max(right, f.x + f.width), 0)
    return { x: frames.length ? rightmost + GAP : 120, y: 120 }
  }
  const originX = Math.min(...siblings.map((f) => f.x))
  const rowY = Math.max(...siblings.map((f) => f.y))
  const rowRight = Math.max(...siblings.filter((f) => f.y === rowY).map((f) => f.x + f.width))
  if (rowRight + GAP + width <= originX + ROW_WIDTH) return { x: rowRight + GAP, y: rowY }
  const bottom = Math.max(...siblings.map((f) => f.y + f.height))
  return { x: originX, y: bottom + GAP }
}

function isCompact(screen: RepoScreenRef): boolean {
  return screen.kind === 'component' || screen.kind === 'story'
}

/** Slug of the guideline a repo's design-system card writes. */
export function designSystemSlug(repo: string): string {
  return `${repo
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')}-design-system`
}

/** Land one frame for a screen at the connection's next grid slot. */
function placeRepoFrame(
  canvasId: string,
  conn: GithubConnection,
  screen: RepoScreenRef,
  html: string,
  width: number,
  height: number,
  actor: Actor,
): Frame {
  const canvas = store.getCanvas(canvasId)
  if (!canvas) throw new Error('canvas not found')
  const at = nextRepoFramePosition(canvas.frames, conn.id, width)
  const frame = actions.createFrame(canvasId, { name: screen.title.slice(0, 80), ...at, width, height, html }, actor)
  if (!frame) throw new Error('canvas not found')
  return frame
}

/** What an out-of-band screen import produced: the landed frame, or — for a
 *  screen that exists only as code, when no document was supplied — the
 *  bounded source closure to design one from. */
export type RepoScreenImport =
  { kind: 'frame'; frame: Frame } | { kind: 'source'; files: { path: string; text: string }[] }

/**
 * Land one screen as a frame, through the same placement, wrapper and marker
 * every imported screen gets. A static screen lands its repo HTML verbatim; a
 * screen that exists only as code needs a document from the caller — the
 * calling agent is the designer — so without one this hands back the source
 * closure to design from rather than inventing a document.
 */
export async function importRepoScreen(
  canvasId: string,
  conn: GithubConnection,
  screen: RepoScreenRef,
  actor: Actor,
  designed?: string,
): Promise<RepoScreenImport> {
  if (designed !== undefined) {
    let document: { html: string; height: number }
    try {
      document = extractHtml([{ type: 'text', text: designed }])
    } catch {
      throw new Error(
        'the html carries no renderable document — send a complete document, or a fragment that starts with a tag',
      )
    }
    return {
      kind: 'frame',
      frame: placeRepoFrame(
        canvasId,
        conn,
        screen,
        wrapGeneratedHtml(document.html, conn, screen),
        isCompact(screen) ? COMPONENT_W : PAGE_W,
        document.height,
        actor,
      ),
    }
  }
  if (screen.source === 'static')
    return {
      kind: 'frame',
      frame: placeRepoFrame(
        canvasId,
        conn,
        screen,
        wrapRepoHtml(await fetchRepoFile(conn, screen.sourcePath), conn, screen),
        PAGE_W,
        STATIC_H,
        actor,
      ),
    }
  return { kind: 'source', files: await collectClosure(conn, screen, await fetchTreePaths(conn)) }
}
