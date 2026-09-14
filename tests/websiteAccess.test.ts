import { describe, expect, it, vi } from 'vitest'
import { TimeoutError, type HTTPResponse, type Page } from 'puppeteer-core'
import {
  assertWebsiteResponseAccessible,
  navigateWebsitePage,
  trackMainDocumentResponse,
  WebsiteCaptureUnavailableError,
  websiteAccessErrorMessage,
} from '../server/websiteAccess.ts'

function response(
  status: number,
  headers: Record<string, string> = {},
  options: { statusText?: string; navigation?: boolean; frame?: object } = {},
): HTTPResponse {
  return {
    status: () => status,
    statusText: () => options.statusText ?? '',
    headers: () => headers,
    request: () => ({
      isNavigationRequest: () => options.navigation ?? true,
      frame: () => options.frame,
    }),
  } as unknown as HTTPResponse
}

function pageHarness(goto: () => Promise<HTTPResponse | null>) {
  const mainFrame = {}
  let responseListener: ((response: HTTPResponse) => void) | undefined
  const page = {
    mainFrame: () => mainFrame,
    goto: vi.fn(goto),
    on: vi.fn((_event: string, listener: (response: HTTPResponse) => void) => {
      responseListener = listener
      return page
    }),
    off: vi.fn((_event: string, listener: (response: HTTPResponse) => void) => {
      if (responseListener === listener) responseListener = undefined
      return page
    }),
  } as unknown as Page
  return {
    page,
    mainFrame,
    emitResponse: (value: HTTPResponse) => responseListener?.(value),
  }
}

describe('website automated-access detection', () => {
  it('rejects Cloudflare challenge responses even when the HTTP status is 200', () => {
    expect(() => assertWebsiteResponseAccessible(response(200, { 'CF-Mitigated': 'Challenge' }))).toThrow(
      WebsiteCaptureUnavailableError,
    )
  })

  it.each([401, 403, 407, 423, 429])('rejects access-blocking HTTP %s responses', (status) => {
    expect(() => assertWebsiteResponseAccessible(response(status))).toThrow(WebsiteCaptureUnavailableError)
  })

  it('allows an ordinary successful response and reports other HTTP errors plainly', () => {
    expect(() => assertWebsiteResponseAccessible(response(200))).not.toThrow()
    expect(() => assertWebsiteResponseAccessible(null)).not.toThrow()
    expect(() => assertWebsiteResponseAccessible(response(404, {}, { statusText: 'Not Found' }))).toThrow(
      'website returned HTTP 404 Not Found',
    )
  })

  it('gives connected agents and users recovery instructions suited to their capabilities', () => {
    const error = new WebsiteCaptureUnavailableError('The site blocked automated access')
    expect(websiteAccessErrorMessage(error, 'connected-agent')).toContain('another browser or web-access tool')
    expect(websiteAccessErrorMessage(error, 'connected-agent')).toContain('upload_asset')
    expect(websiteAccessErrorMessage(error, 'user')).toContain('use screenshots as references')
  })

  it('tracks only the latest main-document response', () => {
    const harness = pageHarness(async () => null)
    const tracker = trackMainDocumentResponse(harness.page)
    const subresource = response(403, { 'cf-mitigated': 'challenge' }, { navigation: false })
    const redirect = response(302, {}, { frame: harness.mainFrame })
    const final = response(200, {}, { frame: harness.mainFrame })

    harness.emitResponse(subresource)
    expect(tracker.latest()).toBeNull()
    harness.emitResponse(redirect)
    harness.emitResponse(final)
    expect(tracker.latest()).toBe(final)
    tracker.stop()
  })

  it('surfaces a tracked Cloudflare challenge when navigation later times out', async () => {
    const harness = pageHarness(async () => {
      const challenge = response(200, { 'cf-mitigated': 'challenge' }, { frame: harness.mainFrame })
      harness.emitResponse(challenge)
      throw new TimeoutError('navigation timeout')
    })

    await expect(
      navigateWebsitePage(
        harness.page,
        'https://example.com',
        { waitUntil: 'networkidle2', timeout: 100 },
        { tolerateTimeout: true },
      ),
    ).rejects.toThrow(WebsiteCaptureUnavailableError)
  })

  it('turns import timeouts into an actionable automated-access error', async () => {
    const harness = pageHarness(async () => {
      throw new TimeoutError('navigation timeout')
    })

    await expect(
      navigateWebsitePage(harness.page, 'https://example.com', { waitUntil: 'networkidle2', timeout: 100 }),
    ).rejects.toThrow('did not finish loading')
  })

  it('turns other navigation failures into an actionable automated-access error', async () => {
    const harness = pageHarness(async () => {
      throw new Error('net::ERR_CONNECTION_RESET')
    })

    await expect(
      navigateWebsitePage(harness.page, 'https://example.com', { waitUntil: 'networkidle2', timeout: 100 }),
    ).rejects.toThrow(WebsiteCaptureUnavailableError)
  })
})
