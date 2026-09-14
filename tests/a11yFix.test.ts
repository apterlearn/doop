import { describe, expect, it } from 'vitest'
import { planA11yFixes } from '../server/a11yFix.ts'

/* The fixer is pure over a frame's HTML string, so it is pinned against
   literal documents: the mechanical findings a review blocks on are settled
   here, and everything that needs a decision about content or layout comes
   back as `skipped` rather than guessed at. No browser, no store. */

const FRAME = `<!doctype html>
<html>
<head>
<style>
  body { margin: 0; }
</style>
</head>
<body>
  <a href="/pricing">Pricing</a>
  <button>Buy</button>
  <img src="/hero.png">
  <input name="email">
</body>
</html>`

/* What audit_frame + inspect_frame report for that document: no lang, no
   title, no interaction states, an image with no alt and a field with no
   label. The duplicate missing_state entries are the two the content lint
   emits per control — no :hover rule and no :focus-visible rule. */
const FINDINGS = [
  { rule: 'html_lang', selector: 'html' },
  { rule: 'no_title', selector: 'html' },
  { rule: 'missing_state', selector: 'body > a:nth-of-type(1)' },
  { rule: 'missing_state', selector: 'body > a:nth-of-type(1)' },
  { rule: 'missing_state', selector: 'body > button:nth-of-type(1)' },
  { rule: 'missing_alt', selector: 'body > img:nth-of-type(1)' },
  { rule: 'form_label', selector: 'body > input:nth-of-type(1)' },
]

describe('planA11yFixes', () => {
  it('adds the language, the title and the interaction states in one pass', () => {
    const plan = planA11yFixes(FRAME, 'Home', FINDINGS)
    const fixed = plan.fixedHtml!

    expect(fixed.startsWith('<!doctype html>')).toBe(true)
    expect(fixed).not.toBe(FRAME)
    expect(plan.applied.map((entry) => entry.slice(0, entry.indexOf(':')))).toEqual([
      'html_lang',
      'no_title',
      'missing_state',
    ])

    /* the language, with the document's own attributes left alone */
    expect(fixed).toContain('<html lang="en">')

    /* the title, from the frame's name */
    expect(fixed).toContain('<title>Home</title>')
    expect(fixed.indexOf('<title>Home</title>')).toBeLessThan(fixed.indexOf('</head>'))

    /* both states for both controls, in one block of its own — the frame's own
       stylesheet is untouched */
    expect(fixed).toContain('body > a:nth-of-type(1):hover')
    expect(fixed).toContain('body > a:nth-of-type(1):focus-visible')
    expect(fixed).toContain('body > button:nth-of-type(1):hover')
    expect(fixed).toContain('body > button:nth-of-type(1):focus-visible')
    expect(fixed.match(/outline: 2px solid currentColor;/g)).toHaveLength(2)
    expect(fixed.match(/data-doop-css/g)).toHaveLength(1)
    expect(fixed).toContain('body { margin: 0; }')
  })

  it('leaves the decisions to a human, with the decision named', () => {
    const plan = planA11yFixes(FRAME, 'Home', FINDINGS)

    expect(plan.skipped).toEqual([
      { rule: 'missing_alt', reason: "alt text needs the image's meaning" },
      { rule: 'form_label', reason: "form labels need the field's purpose" },
    ])
  })

  it('applies nothing on a second pass over its own output', () => {
    const first = planA11yFixes(FRAME, 'Home', FINDINGS)
    const second = planA11yFixes(first.fixedHtml!, 'Home', FINDINGS)

    expect(second.fixedHtml).toBeNull()
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(first.skipped)
  })

  it('touches a frame that already has all three', () => {
    const done = `<!doctype html>
<html lang="en">
<head>
<title>Home</title>
<style data-doop-css>
body > a:nth-of-type(1):hover,
body > button:nth-of-type(1):hover { outline: 2px solid currentColor; outline-offset: 2px; }
body > a:nth-of-type(1):focus-visible,
body > button:nth-of-type(1):focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
</style>
</head>
<body></body>
</html>`
    const plan = planA11yFixes(done, 'Home', FINDINGS)

    expect(plan.fixedHtml).toBeNull()
    expect(plan.applied).toEqual([])
    expect(plan.skipped.map((entry) => entry.rule)).toEqual(['missing_alt', 'form_label'])
  })

  it('keeps the frame’s existing <html> attributes and fills an empty lang', () => {
    const attributes = `<!doctype html><html class="tall" data-frame="home"><head></head><body></body></html>`
    const withAttributes = planA11yFixes(attributes, 'Home', [{ rule: 'html_lang' }])
    expect(withAttributes.fixedHtml).toContain('<html lang="en" class="tall" data-frame="home">')

    const empty = `<!doctype html><html lang=""><head></head><body></body></html>`
    const filled = planA11yFixes(empty, 'Home', [{ rule: 'html_lang' }])
    expect(filled.fixedHtml).toContain('<html lang="en">')
    expect(filled.fixedHtml).not.toContain('lang=""')
  })

  it('writes into the frame’s own stylesheet block when it has one', () => {
    const styled = `<!doctype html><html><head><style data-doop-css>
  .btn { padding: 8px; }
</style></head><body><button class="btn">Buy</button></body></html>`
    const plan = planA11yFixes(styled, 'Home', [{ rule: 'missing_state', selector: 'body > button:nth-of-type(1)' }])
    const fixed = plan.fixedHtml!

    expect(fixed.match(/data-doop-css/g)).toHaveLength(1)
    expect(fixed).toContain('.btn { padding: 8px; }')
    expect(fixed).toContain('body > button:nth-of-type(1):hover')
    /* the block's own closing tag still closes it */
    expect(fixed.indexOf('body > button:nth-of-type(1):hover')).toBeLessThan(fixed.indexOf('</style>'))
  })

  it('escapes the frame name it writes into the title', () => {
    const plan = planA11yFixes('<!doctype html><html><head></head><body></body></html>', 'Tom & <b>Jerry</b>', [
      { rule: 'no_title' },
    ])

    expect(plan.fixedHtml).toContain('<title>Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;</title>')
  })
})
