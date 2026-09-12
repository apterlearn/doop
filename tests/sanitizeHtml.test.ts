import { describe, expect, it } from 'vitest'

import { sanitizeImportedHtml } from '../server/sanitizeHtml.ts'

const DOCUMENT = [
  '<!doctype html>',
  '<html><head>',
  '<meta charset="utf-8">',
  '<meta http-equiv="refresh" content="5">',
  '<script>alert(1)</script>',
  '<title>Docs</title>',
  '</head><body>',
  '<h1>Pricing</h1>',
  '<img src="/images/chart.png" alt="chart" onerror="x()">',
  '<a href="javascript:void(0)">bad</a>',
  '<a href="/plans.html">Plans</a>',
  '<iframe src="https://evil.test/frame"></iframe>',
  '<p>footer</p>',
  '</body></html>',
].join('\n')

describe('sanitizeImportedHtml', () => {
  it('removes scripts, handlers, javascript: URLs and http-equiv metas', () => {
    const out = sanitizeImportedHtml(DOCUMENT)
    for (const banned of ['alert(1)', 'onerror', 'javascript:', 'http-equiv', 'refresh', '<iframe', '<script'])
      expect(out, banned).not.toContain(banned)
  })

  it('keeps visible text and ordinary attributes', () => {
    const out = sanitizeImportedHtml(DOCUMENT)
    expect(out).toContain('<h1>Pricing</h1>')
    expect(out).toContain('footer')
    expect(out).toContain('<title>Docs</title>')
    expect(out).toContain('src="/images/chart.png"')
    expect(out).toContain('alt="chart"')
    expect(out).toContain('<a href="/plans.html">Plans</a>')
    /* the anchor survives; only its href is gone */
    expect(out).toContain('<a >bad</a>')
  })

  it('absolutizes url() references against the given base', () => {
    const out = sanitizeImportedHtml('<div style="background: url(./a.png)">x</div>', {
      baseUrl: 'https://x.test/dir/page',
    })
    expect(out).toContain('url(https://x.test/dir/a.png)')
  })

  it('leaves absolute, data and fragment url() references alone', () => {
    const css = '<style>a{b:url(https://k.test/p.png)}c{d:url(data:image/png;base64,AA)}e{f:url(#g)}</style>'
    expect(sanitizeImportedHtml(css, { baseUrl: 'https://x.test/page' })).toContain(css)
  })

  it('leaves relative url() references untouched without a base', () => {
    expect(sanitizeImportedHtml('<style>.x{background:url(./b.png)}</style>')).toContain('url(./b.png)')
  })

  it('round-trips a document without <html> unchanged apart from the removals', () => {
    const fragment = '<p>hello</p><img src="k.png" alt="k"><script>alert(2)</script>'
    expect(sanitizeImportedHtml(fragment)).toBe('<p>hello</p><img src="k.png" alt="k">')
  })

  it('drops attributes separated by a slash but not slashes inside a URL value', () => {
    const out = sanitizeImportedHtml('<svg/onload=alert(1)></svg><a href="http://x.test/a/only=1">u</a>')
    expect(out).not.toContain('onload')
    expect(out).toContain('href="http://x.test/a/only=1"')
  })

  it('removes an unclosed stripped element without eating the rest of the document', () => {
    const out = sanitizeImportedHtml('<body><iframe src="x">kept text</body>')
    expect(out).toContain('kept text')
    expect(out).not.toContain('iframe')
  })
})
