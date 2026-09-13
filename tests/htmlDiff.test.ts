import { describe, expect, it } from 'vitest'
import { htmlDiff } from '../server/htmlDiff.ts'

describe('htmlDiff', () => {
  it('reports nothing for identical inputs', () => {
    expect(htmlDiff('a\nb\nc', 'a\nb\nc')).toEqual({ hunks: [], added: 0, removed: 0 })
    expect(htmlDiff('', '')).toEqual({ hunks: [], added: 0, removed: 0 })
  })

  it('emits a pure insertion with its surrounding context', () => {
    expect(htmlDiff('a\nb\nc', 'a\nX\nb\nc')).toEqual({
      hunks: [{ a_start: 1, b_start: 1, lines: [' a', '+X', ' b', ' c'] }],
      added: 1,
      removed: 0,
    })
  })

  it('emits a pure deletion', () => {
    expect(htmlDiff('a\nb\nc\nd', 'a\nd')).toEqual({
      hunks: [{ a_start: 1, b_start: 1, lines: [' a', '-b', '-c', ' d'] }],
      added: 0,
      removed: 2,
    })
  })

  it('reads a replacement as a removal followed by an addition', () => {
    const diff = htmlDiff('a\nb\nc', 'a\nB\nc')
    expect(diff.hunks).toEqual([{ a_start: 1, b_start: 1, lines: [' a', '-b', '+B', ' c'] }])
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
  })

  it('treats an empty before as additions from line 1', () => {
    expect(htmlDiff('', 'x\ny')).toEqual({
      hunks: [{ a_start: 1, b_start: 1, lines: ['+x', '+y'] }],
      added: 2,
      removed: 0,
    })
  })

  it('treats an empty after as deletions', () => {
    expect(htmlDiff('x\ny', '')).toEqual({
      hunks: [{ a_start: 1, b_start: 1, lines: ['-x', '-y'] }],
      added: 0,
      removed: 2,
    })
  })

  it('splits distant changes into separate hunks with 1-based starts', () => {
    const before = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12'
    const after = '1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\nELEVEN\n12'
    expect(htmlDiff(before, after)).toEqual({
      hunks: [
        { a_start: 1, b_start: 1, lines: [' 1', '-2', '+TWO', ' 3', ' 4', ' 5'] },
        { a_start: 8, b_start: 8, lines: [' 8', ' 9', ' 10', '-11', '+ELEVEN', ' 12'] },
      ],
      added: 2,
      removed: 2,
    })
  })

  it('keeps changes inside one context window in a single hunk', () => {
    const before = '1\n2\n3\n4\n5\n6\n7\n8'
    const after = '1\nTWO\n3\n4\n5\n6\n7\nEIGHT'
    expect(htmlDiff(before, after)).toEqual({
      hunks: [{ a_start: 1, b_start: 1, lines: [' 1', '-2', '+TWO', ' 3', ' 4', ' 5', ' 6', ' 7', '-8', '+EIGHT'] }],
      added: 2,
      removed: 2,
    })
  })

  it('starts a mid-document hunk three lines early, at its real line number', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj'
    const after = 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj'
    expect(htmlDiff(before, after)).toEqual({
      hunks: [{ a_start: 2, b_start: 2, lines: [' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h'] }],
      added: 1,
      removed: 1,
    })
  })

  it('treats a trailing newline as a final empty line', () => {
    expect(htmlDiff('a\n', 'a\nb\n')).toEqual({
      hunks: [{ a_start: 1, b_start: 1, lines: [' a', '+b', ' '] }],
      added: 1,
      removed: 0,
    })
  })

  it('keeps the totals exact when two large documents share no line', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `<p>left ${i}</p>`).join('\n')
    const after = Array.from({ length: 2100 }, (_, i) => `<p>right ${i}</p>`).join('\n')
    const diff = htmlDiff(before, after)
    expect(diff.added).toBe(2100)
    expect(diff.removed).toBe(2100)
    expect(diff.hunks.length).toBe(1)
    expect(diff.hunks[0]!.lines.length).toBe(4200)
  })
})
