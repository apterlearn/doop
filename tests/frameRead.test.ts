import { describe, expect, it } from 'vitest'
import { MAX_HTML_READ_CHARS, readFrameHtml } from '../server/screenshot.ts'

/**
 * The one bounded reader both the resident team and the MCP surface use to look
 * at a frame's source. Its whole reason to exist is that a 60 KB imported
 * document must not land in an agent's context whole, so the caps are the
 * contract: they are the only thing standing between an agent and an
 * out-of-context failure mid-design.
 */

const doc = `<html><body><h1 class="hero">Hero</h1>${'x'.repeat(5000)}<p>hero again</p></body></html>`

describe('readFrameHtml', () => {
  it('returns a window around each query match instead of the whole document', () => {
    /* a document far larger than one read may return */
    const big = `<h1>hero</h1>${'x'.repeat(MAX_HTML_READ_CHARS * 4)}<p>hero again</p>`
    const read = readFrameHtml(big, { query: 'hero' })
    if ('error' in read) throw new Error(read.error)

    expect(read.text).toContain(`Frame HTML: ${big.length} characters; 2 match(es) for "hero".`)
    expect(read.text).toContain('--- match 1 at 4')
    expect(read.text).toContain('--- match 2 at')
    /* two bounded windows, not the 120 KB document */
    expect(read.text.length).toBeLessThan(MAX_HTML_READ_CHARS + 1000)
  })

  it('matches the query case-insensitively', () => {
    const read = readFrameHtml(doc, { query: 'HERO' })
    if ('error' in read) throw new Error(read.error)
    expect(read.text).toContain('3 match(es)')
  })

  it('reports a query that is not in the frame', () => {
    expect(readFrameHtml(doc, { query: 'not-here' })).toEqual({ error: 'query not found in frame HTML: not-here' })
  })

  it('pages a range and says how to continue', () => {
    const read = readFrameHtml(doc, { offset: 0, limit: 1000 })
    if ('error' in read) throw new Error(read.error)

    expect(read.text).toContain(`Frame HTML: ${doc.length} characters. Returning chars 0-1000.`)
    expect(read.text).toContain('Continue with offset=1000')
    expect(read.text).toContain(doc.slice(0, 1000))
    expect(read.text).not.toContain(doc.slice(1000))
  })

  it('stops offering the continue hint at the end of the document', () => {
    const read = readFrameHtml('short', {})
    if ('error' in read) throw new Error(read.error)
    expect(read.text).not.toContain('Continue with offset')
    expect(read.text).toContain('short')
  })

  it('clamps an oversized limit to the cap and floors a uselessly small one', () => {
    const huge = 'y'.repeat(MAX_HTML_READ_CHARS * 2)

    const clamped = readFrameHtml(huge, { limit: MAX_HTML_READ_CHARS * 10 })
    if ('error' in clamped) throw new Error(clamped.error)
    expect(clamped.text).toContain(`Returning chars 0-${MAX_HTML_READ_CHARS}.`)

    const floored = readFrameHtml(huge, { limit: 1 })
    if ('error' in floored) throw new Error(floored.error)
    expect(floored.text).toContain('Returning chars 0-1000.')
  })
})
