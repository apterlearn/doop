import { describe, expect, it } from 'vitest'
import { reportIsCurrent, reviewFrame } from '../server/review.ts'
import { findBrowserPath } from '../server/screenshot.ts'
import type { DesignTokens, Frame } from '../shared/types.ts'

/* review_frame is the verification gate's whole input, so it is checked
   against a real render (skipped where no browser is installed, like the other
   browser-backed suites): the findings must come out of the browser's own
   computed styles, and every viewport must actually be reviewed. */

const TOKENS: DesignTokens = {
  colors: { ink: '#111110', paper: '#ffffff' },
  fonts: { body: 'Inter' },
  spacing: [4, 8, 16, 24],
  radii: [0, 8],
  updatedAt: 0,
  updatedBy: 'alice',
}

function frame(html: string): Frame {
  return {
    id: 'f-review',
    canvasId: 'c-review',
    name: 'Review fixture',
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    html,
    createdAt: 0,
    updatedAt: 1,
    updatedBy: 'alice',
  }
}

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#ffffff}</style></head><body>${body}</body></html>`

describe.skipIf(!findBrowserPath())('reviewFrame over a real render', () => {
  it('reviews all three viewports and surfaces the a11y and token violations', async () => {
    const report = await reviewFrame(
      frame(
        page(`
          <main>
            <h1 style="color:#111110">Dashboard</h1>
            <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40">
            <p style="color:#777777;font-size:16px">Secondary explanation text</p>
            <p style="color:#123456;font-size:16px">Off-palette accent text</p>
          </main>
        `),
      ),
      TOKENS,
    )

    expect(report.frame_id).toBe('f-review')
    expect(report.viewports).toHaveLength(3)
    expect(report.viewports.map((entry) => entry.viewport.width)).toEqual([390, 834, 1440])
    expect(new Set(report.viewports.map((entry) => entry.viewport.width)).size).toBe(3)
    /* the image has no alt text and the body copy sits at 4.48:1 */
    expect(report.summary.critical).toBeGreaterThanOrEqual(1)
    /* #123456 is neither of the two palette colours */
    expect(report.summary.off_token).toBeGreaterThanOrEqual(1)
    expect(report.viewports[0]!.a11y.counts.critical).toBeGreaterThanOrEqual(1)
    expect(report.viewports[0]!.lint.counts.off_token_color).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

describe.skipIf(!findBrowserPath())('review provenance and verdicts', () => {
  it('names the document it describes, so a later edit invalidates it', async () => {
    const html = page('<main><h1>Dashboard</h1><p style="color:#111110">Body copy</p></main>')
    const before = await reviewFrame(frame(html), TOKENS)
    const after = await reviewFrame(frame(html.replace('Dashboard', 'Overview')), TOKENS)
    expect(before.html_sha).not.toBe(after.html_sha)
    expect(reportIsCurrent(before, frame(html), TOKENS)).toBe(true)
    expect(reportIsCurrent(before, frame(html.replace('Dashboard', 'Overview')), TOKENS)).toBe(false)
  })

  it('treats a token change as a change to the document it describes', async () => {
    const html = page('<main><h1 style="color:var(--color-ink)">Dashboard</h1></main>')
    const report = await reviewFrame(frame(html), TOKENS)
    /* the same HTML, a different palette: the render is different, so the
       report is not evidence about it any more */
    const repainted: DesignTokens = { ...TOKENS, colors: { ink: '#0000ff', paper: '#ffffff' } }
    expect(reportIsCurrent(report, frame(html), TOKENS)).toBe(true)
    expect(reportIsCurrent(report, frame(html), repainted)).toBe(false)
  })

  it('fails a frame whose own height exceeds a phone preset, instead of calling it clipped', async () => {
    /* a tall design is not clipped by the frame it is drawn in: the review
       renders it at its own height, so nothing is falsely cut off */
    const tall: Frame = { ...frame(page('<main><h1>Tall</h1></main>')), height: 2400 }
    const report = await reviewFrame(tall, TOKENS)
    expect(report.viewports.map((entry) => entry.viewport.height)).toEqual([2400, 2400, 2400])
    expect(report.blocking.filter((finding) => finding.rule === 'clipped_by_frame')).toEqual([])
  })

  it('reports which viewport failed, not just that something did', async () => {
    /* 500px overflows the phone preset and nothing wider, so the failing set
       is the point of the test rather than a property of the fixture. The rest
       of the document is clean — tokens, hover/focus states, a real tap target
       — so the only blocking finding is the narrow preset's overflow. */
    const wide = `<!doctype html><html lang="en"><head><title>Wide</title>
        <meta name="description" content="A layout that only overflows on the narrow preset.">
        <style>
          body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
          h1 { font-size: 32px; line-height: 1.25; }
          a:hover { text-decoration: underline }
          a:focus-visible { outline: 2px solid #111110 }
        </style></head>
        <body><main style="min-height:600px"><h1>Wide</h1>
        <div style="width:500px;height:40px;background:#111110"></div>
        <a href="/start" style="display:inline-block;min-width:44px;min-height:44px;color:#111110">Start</a>
        </main></body></html>`
    const report = await reviewFrame(frame(wide), TOKENS)
    expect(report.verdict).toBe('fail')
    expect(report.failing_viewports).toEqual(['mobile'])
    expect(report.viewports.find((entry) => entry.viewport.width === 390)?.verdict).toBe('fail')
    /* the wider presets are wide enough for the same content */
    expect(report.viewports.find((entry) => entry.viewport.width === 1440)?.verdict).toBe('pass')
  })

  it('catches the failures the older checks missed', async () => {
    const report = await reviewFrame(
      frame(
        page(`
          <main>
            <h1 style="color:#111110">Dashboard</h1>
            <p style="color:#111110">Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
            <img src="/missing-image.png" alt="Chart" width="40" height="40">
            <button style="color:#111110">Save</button>
          </main>
        `),
      ),
      TOKENS,
    )
    const rules = report.blocking.map((finding) => finding.rule)
    expect(rules).toContain('placeholder_text')
    expect(rules).toContain('broken_image')
    /* the page has no <title> in this fixture */
    expect(rules).toContain('no_title')
    /* the button has no hover/focus rule anywhere in the frame's CSS */
    const content = report.viewports[0]!.content
    expect(content.issues.map((issue) => issue.rule)).toContain('missing_state')
  })

  it('passes a clean, real page', async () => {
    const report = await reviewFrame(
      frame(`<!doctype html><html lang="en"><head><title>Acme</title>
        <meta name="description" content="Acme does things.">
        <style>
          body { margin:0; font-family: Inter, system-ui; background:#ffffff; color:#111110; }
          h1 { font-size: 32px; line-height: 1.25; }
          a:hover { text-decoration: underline }
          a:focus-visible { outline: 2px solid #111110 }
        </style></head>
        <body><main style="min-height:600px"><h1>Acme</h1>
        <p style="color:#111110">We make things that work.</p>
        <a href="/start" style="color:#111110">Start</a>
        </main></body></html>`),
      TOKENS,
    )
    expect(report.blocking).toEqual([])
    expect(report.verdict).toBe('pass')
    expect(report.failing_viewports).toEqual([])
  })
})
