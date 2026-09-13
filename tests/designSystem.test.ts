import { describe, expect, it } from 'vitest'
import { deriveDesignSystem, designSystemMarkdown } from '../server/designSystem.ts'
import type { Probe, ProbeElement } from '../server/domProbe.ts'

/* Deriving a design system is a pure function over a probe, so the rules are
   pinned here without a browser: what becomes a token, what is dropped, and
   what the written guide promises. */

function probe(overrides: {
  colors?: [string, number][]
  fonts?: [string, number][]
  fontSizes?: [string, number][]
  fontWeights?: [string, number][]
  lineHeights?: [string, number][]
  leading?: [string, number][]
  spacing?: [string, number][]
  radii?: [string, number][]
  shadows?: [string, number][]
  cssVariables?: Record<string, string>
  fontsFailed?: string[]
}): Probe {
  const usage = (pairs: [string, number][] = []) => pairs.map(([value, count]) => ({ value, count }))
  return {
    document: {
      title: 'Fixture',
      description: '',
      width: 800,
      height: 600,
      htmlChars: 100,
      lang: 'en',
      viewportMeta: '',
      fonts: [],
      fontsFailed: overrides.fontsFailed ?? [],
    },
    design: {
      colors: [],
      backgrounds: [],
      fonts: [],
      fontSizes: [],
      radii: [],
      shadows: [],
      cssVariables: overrides.cssVariables ?? {},
    },
    designEvidence: {
      colors: usage(overrides.colors),
      backgrounds: [],
      fonts: usage(overrides.fonts),
      fontSizes: usage(overrides.fontSizes),
      fontWeights: usage(overrides.fontWeights),
      lineHeights: usage(overrides.lineHeights),
      leading: usage(overrides.leading),
      spacing: usage(overrides.spacing),
      radii: usage(overrides.radii),
      shadows: usage(overrides.shadows),
    },
    content: {
      title: 'Fixture',
      description: '',
      headings: [],
      sections: [],
      nav: [],
      ctas: [],
      forms: [],
      images: [],
      truncated: false,
    },
    cssText: '',
    elements: [] as ProbeElement[],
  }
}

describe('deriveDesignSystem', () => {
  it('names colors after the CSS variables they come from, in usage order', () => {
    const system = deriveDesignSystem(
      probe({
        colors: [
          ['rgb(17, 17, 16)', 40],
          ['rgb(255, 107, 61)', 12],
        ],
        cssVariables: { '--ink': '#111110', '--accent': 'rgb(255, 107, 61)' },
      }),
    )
    /* the value a designer recognises, under the name they gave it */
    expect(system.tokens.colors).toEqual({ ink: '#111110', accent: '#ff6b3d' })
    expect(system.evidence.colors[0]).toEqual({ value: 'rgb(17, 17, 16)', count: 40 })
  })

  it('falls back to positional names when no variable matches', () => {
    const system = deriveDesignSystem(probe({ colors: [['rgb(1, 2, 3)', 5]] }))
    expect(system.tokens.colors).toEqual({ 'color-1': '#010203' })
  })

  it('derives a type scale and drops values that are not on it', () => {
    const system = deriveDesignSystem(
      probe({
        fonts: [
          ['Inter, sans-serif', 30],
          ['JetBrains Mono, monospace', 4],
        ],
        fontSizes: [
          ['16px', 20],
          ['40px', 2],
          ['17.3333px', 1],
        ],
        fontWeights: [
          ['400', 20],
          ['600', 3],
          ['bolder', 1],
        ],
        lineHeights: [
          ['24px', 18],
          ['48px', 2],
        ],
        leading: [
          ['1.5', 18],
          ['1.2', 2],
          ['4', 1],
        ],
      }),
    )
    expect(system.tokens.fonts).toEqual({ body: 'Inter', mono: 'JetBrains Mono' })
    expect(system.tokens.type?.size).toEqual([16, 17.3333, 40])
    expect(system.tokens.type?.weight).toEqual([400, 600])
    /* leading is the counted ratio, not a reconstruction; 4 is out of range */
    expect(system.tokens.type?.leading).toEqual([1.2, 1.5])
  })

  it('keeps the spacing and radius scales sorted and deduped', () => {
    const system = deriveDesignSystem(
      probe({
        spacing: [
          ['16px', 9],
          ['4px', 12],
          ['16px', 3],
        ],
        radii: [
          ['8px', 5],
          ['0px', 1],
        ],
      }),
    )
    expect(system.tokens.spacing).toEqual([4, 16])
    expect(system.tokens.radii).toEqual([0, 8])
  })

  it('says what it could not derive, and why', () => {
    const system = deriveDesignSystem(probe({ fontsFailed: ['Inter'] }))
    expect(system.notes.join(' ')).toContain('no painted colors')
    expect(system.notes.join(' ')).toContain('Inter')
  })

  it('writes a guide that names every token it derived', () => {
    const system = deriveDesignSystem(
      probe({
        colors: [['rgb(17, 17, 16)', 40]],
        fonts: [['Inter, sans-serif', 30]],
        fontSizes: [['16px', 20]],
        spacing: [['8px', 4]],
        radii: [['8px', 5]],
      }),
    )
    const markdown = designSystemMarkdown(system, 'frame “Hero”')
    expect(markdown).toContain('# Design system — frame “Hero”')
    expect(markdown).toContain('`--color-color-1`')
    expect(markdown).toContain('Inter')
    expect(markdown).toContain('16px')
    expect(markdown).toContain(':root {')
    expect(markdown).toContain('var(--color-')
  })
})
