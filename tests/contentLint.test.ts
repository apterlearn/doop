import { describe, expect, it } from 'vitest'
import { contentProbe } from '../server/contentLint.ts'
import type { Probe, ProbeElement } from '../server/domProbe.ts'

/* The content rules are pure over a probe, so they are pinned against
   hand-built fixtures: a stand-in asset name is a string a generator writes by
   accident, which is exactly what the checks exist to catch. No browser, no
   server. */

function element(over: Partial<ProbeElement> & { selector: string }): ProbeElement {
  return {
    tag: 'div',
    directText: '',
    rect: { x: 0, y: 0, width: 100, height: 40 },
    top: 0,
    style: {
      color: 'rgb(17, 17, 16)',
      background: 'rgba(0, 0, 0, 0)',
      effectiveBackground: 'rgb(255, 255, 255)',
      font: 'system-ui',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: 'normal',
      backgroundImage: '',
      borderRadius: '0px',
      margin: '0px',
      padding: '0px',
      gap: 'normal',
    },
    fontSizePx: 16,
    fontWeight: 400,
    opacity: 1,
    attrs: { hiddenFromAT: false, focusable: false, wrappedInLabel: false },
    ...over,
    /* `over` is a Partial, so the spread makes every field optional in the
       inferred type; the required ones are restated to keep the result a
       ProbeElement */
    key: over.key ?? over.selector,
  }
}

function probeOf(elements: ProbeElement[]): Probe {
  return {
    document: {
      title: 'fixture',
      description: 'a fixture page',
      lang: 'en',
      viewportMeta: 'width=device-width, initial-scale=1',
      fonts: [],
      fontsFailed: [],
      width: 800,
      height: 600,
      htmlChars: 100,
    },
    design: { colors: [], backgrounds: [], fonts: [], fontSizes: [], radii: [], shadows: [], cssVariables: {} },
    /* these fixtures exist to pin the content rules, which read `elements`
       only; the derived-evidence fields are empty on purpose */
    designEvidence: {
      colors: [],
      backgrounds: [],
      fonts: [],
      fontSizes: [],
      fontWeights: [],
      lineHeights: [],
      leading: [],
      spacing: [],
      radii: [],
      shadows: [],
    },
    content: {
      title: 'fixture',
      description: 'a fixture page',
      headings: [],
      sections: [],
      nav: [],
      ctas: [],
      forms: [],
      images: [],
      truncated: false,
    },
    /* both state rules present, so the interaction check stays out of the way */
    cssText: ':hover{} :focus-visible{}',
    elements,
  }
}

function img(src: string, alt?: string): ProbeElement {
  return element({
    selector: '#img',
    tag: 'img',
    image: { src, naturalWidth: 64, naturalHeight: 64, complete: true },
    attrs: {
      hiddenFromAT: false,
      focusable: false,
      wrappedInLabel: false,
      ...(alt === undefined ? {} : { alt }),
    },
  })
}

function text(value: string): ProbeElement {
  return element({ selector: '#text', directText: value })
}

function rulesFor(el: ProbeElement): string[] {
  return contentProbe(probeOf([el])).issues.map((issue) => issue.rule)
}

describe('contentProbe', () => {
  it('fails a bare stand-in file name', () => {
    for (const src of ['placeholder.png', 'dummy.jpg', 'logo.png', 'img_2.png', 'image3.png']) {
      const report = contentProbe(probeOf([img(src)]))
      expect(report.issues).toContainEqual(
        expect.objectContaining({ rule: 'placeholder_image', severity: 'error', selector: '#img' }),
      )
      expect(report.counts.errors).toBe(1)
    }
  })

  it('leaves a real asset path or URL alone', () => {
    expect(rulesFor(img('/missing-image.png'))).not.toContain('placeholder_image')
    expect(rulesFor(img('hero-image-2.png'))).not.toContain('placeholder_image')
    expect(rulesFor(img('https://acme.io/logo.png', 'Acme logo'))).not.toContain('placeholder_image')
  })

  it('does not read the word "image" in an alt text as a stand-in', () => {
    expect(rulesFor(img('https://acme.io/team.jpg', 'Image of the team'))).not.toContain('placeholder_image')
  })

  it('flags a real src whose alt text calls itself a stand-in', () => {
    expect(rulesFor(img('https://acme.io/hero.jpg', 'placeholder image'))).toContain('placeholder_image')
  })

  it('flags placeholder copy but not the word "todo" in real copy', () => {
    expect(rulesFor(text('Lorem ipsum dolor sit amet'))).toContain('placeholder_text')
    expect(rulesFor(text('TODO'))).toContain('placeholder_text')
    expect(rulesFor(text('Todo list'))).not.toContain('placeholder_text')
    expect(rulesFor(text('ver todo'))).not.toContain('placeholder_text')
  })
})
