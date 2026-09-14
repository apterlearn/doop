import { importPage } from './importer.ts'
import { WebsiteCaptureUnavailableError } from './websiteAccess.ts'

/**
 * Read-only viewer behind the MCP view_website tool. It uses the same
 * acquisition and passive-HTML transformation as import_webpage, then returns
 * the locally rendered preview without adding a frame to the canvas.
 */

export interface WebsiteView {
  /** JPEG screenshot of the top of the page at desktop width. */
  screenshot: Buffer
  finalUrl: string
  title: string
  description: string
  /** Visible body text, whitespace-collapsed, capped at MAX_TEXT_CHARS. */
  text: string
  textTruncated: boolean
  /** True when the page is taller than the screenshot shows. */
  shotCropped: boolean
  pageHeight: number
}

export async function viewWebsite(raw: string): Promise<WebsiteView> {
  const imported = await importPage(raw, { includePreview: true })
  const preview = imported.preview
  if (!preview) throw new WebsiteCaptureUnavailableError('Doop could not render the acquired webpage HTML')
  return { title: imported.title, ...preview }
}

/** URLs and bare domains mentioned in work-request text — the harness nudges
 *  the agent to import source pages before designing. File names are not sites. */
export function referencedUrls(text: string): string[] {
  const NOT_SITES = /\.(png|jpe?g|gif|svg|webp|ico|css|js|ts|tsx|json|html?|md|pdf|txt|mp4|webm|woff2?)$/i
  const matches =
    text.match(/\bhttps?:\/\/[^\s"'<>()]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s"'<>()]*)?/gi) ?? []
  const urls = matches.map((m) => m.replace(/[.,;:!?]+$/, '')).filter((m) => !NOT_SITES.test(m))
  return [...new Set(urls)]
}
