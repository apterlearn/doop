import { describe, expect, it } from 'vitest'
import { layoutProbe } from '../server/layoutLint.ts'
import type { Probe, ProbeElement } from '../server/domProbe.ts'

/* The layout rules are pure over a probe, so they are pinned against
   hand-built fixtures: a 400px child inside a 200px box is geometry a real
   browser could only produce on purpose, which is exactly what the checks
   exist to catch. No browser, no server. */

function element(over: Partial<ProbeElement> & { selector: string }): ProbeElement {
  return {
    tag: 'div',
    top: 0,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    directText: '',
    style: {
      color: 'rgb(17, 17, 16)',
      background: 'rgba(0, 0, 0, 0)',
      effectiveBackground: 'rgb(255, 255, 255)',
      font: 'system-ui',
      fontSize: '16px',
      fontWeight: '400',
      borderRadius: '0px',
      margin: '0px',
      padding: '0px',
      gap: 'normal',
    },
    fontSizePx: 16,
    fontWeight: 400,
    opacity: 1,
    attrs: { hiddenFromAT: false, focusable: false, wrappedInLabel: false },
    scrollWidth: 100,
    scrollHeight: 40,
    clientWidth: 100,
    clientHeight: 40,
    overflowX: 'visible',
    overflowY: 'visible',
    ...over,
  }
}

function probeOf(elements: ProbeElement[]): Probe {
  return {
    document: { title: 'fixture', lang: 'en', width: 800, height: 600, htmlChars: 100 },
    design: { colors: [], backgrounds: [], fonts: [], fontSizes: [], radii: [], shadows: [], cssVariables: {} },
    elements,
  }
}

describe('layoutProbe', () => {
  it('reports a 400px child in a 200px container as exactly one overflow_x error', () => {
    const report = layoutProbe(
      probeOf([
        element({
          selector: '#wrap',
          rect: { x: 0, y: 0, width: 200, height: 100 },
          scrollWidth: 400,
          scrollHeight: 100,
          clientWidth: 200,
          clientHeight: 100,
          overflowX: 'auto',
        }),
        element({
          selector: '#child',
          parentIndex: 0,
          rect: { x: 0, y: 0, width: 400, height: 100 },
          scrollWidth: 400,
          scrollHeight: 100,
          clientWidth: 400,
          clientHeight: 100,
        }),
      ]),
    )
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ rule: 'overflow_x', severity: 'error', selector: '#wrap' })
    expect(report.errors).toBe(1)
    expect(report.warnings).toBe(0)
  })

  it('warns about overlapping siblings without failing the design', () => {
    const report = layoutProbe(
      probeOf([
        element({
          selector: '#wrap',
          rect: { x: 0, y: 0, width: 300, height: 300 },
          scrollWidth: 300,
          scrollHeight: 300,
          clientWidth: 300,
          clientHeight: 300,
        }),
        element({ selector: '#a', parentIndex: 0, rect: { x: 0, y: 0, width: 100, height: 100 } }),
        element({ selector: '#b', parentIndex: 0, rect: { x: 50, y: 50, width: 100, height: 100 } }),
      ]),
    )
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0]).toMatchObject({ rule: 'sibling_overlap', severity: 'warning', selector: '#b' })
    expect(report.errors).toBe(0)
    expect(report.warnings).toBe(1)
  })

  it('reports a zero-size image with content and no children as an error', () => {
    const report = layoutProbe(
      probeOf([
        element({
          selector: '#wrap',
          rect: { x: 0, y: 0, width: 300, height: 300 },
          scrollWidth: 300,
          scrollHeight: 300,
          clientWidth: 300,
          clientHeight: 300,
        }),
        element({
          selector: '#hero',
          tag: 'img',
          parentIndex: 0,
          rect: { x: 0, y: 0, width: 0, height: 0 },
          scrollWidth: 0,
          scrollHeight: 0,
          clientWidth: 0,
          clientHeight: 0,
        }),
      ]),
    )
    expect(report.issues.map((issue) => issue.rule)).toEqual(['zero_size'])
    expect(report.errors).toBe(1)
  })

  it('leaves a box that is allowed to bleed alone', () => {
    const report = layoutProbe(
      probeOf([
        element({
          selector: '#marquee',
          rect: { x: 0, y: 0, width: 200, height: 40 },
          scrollWidth: 900,
          clientWidth: 200,
          overflowX: 'auto',
          attrs: { hiddenFromAT: false, focusable: false, wrappedInLabel: false, allowOverflow: true },
        }),
      ]),
    )
    expect(report.issues).toEqual([])
    expect(report.errors).toBe(0)
  })

  it('ignores a few pixels of visible overflow as text-metric noise', () => {
    const report = layoutProbe(
      probeOf([
        element({
          selector: '#text',
          rect: { x: 0, y: 0, width: 200, height: 40 },
          scrollWidth: 205,
          clientWidth: 200,
        }),
      ]),
    )
    expect(report.issues).toEqual([])
  })
})
