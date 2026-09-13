/**
 * Line-level diff between two HTML strings.
 *
 * A dry run is only useful if the caller can see what would change: `visualDiff.ts`
 * is pixel-based and `distill.ts` summarises design facts, so neither can say
 * "these three lines change". This is a plain LCS diff over lines — no dependency —
 * shaped for the MCP write-preview result: hunks with three lines of context plus
 * the added/removed totals.
 *
 * Line convention: the empty string is zero lines; anything else is split on '\n',
 * so a trailing newline yields a final empty line and `''` → `'a'` is a pure
 * insertion rather than a rewrite of one blank line. Both sides split the same way,
 * so identical inputs always produce no hunks.
 */

export interface HtmlDiffHunk {
  /** 1-based line in `before` where the hunk starts. A hunk with no removed line is
   *  a pure insertion, and this is the 1-based line the additions go before (1 = the
   *  top of the document). */
  a_start: number
  /** 1-based line in `after` where the hunk starts. */
  b_start: number
  /** Prefixed lines: ' ' context, '-' removed, '+' added. */
  lines: string[]
}

export interface HtmlDiffResult {
  hunks: HtmlDiffHunk[]
  added: number
  removed: number
}

/** Unchanged lines kept on each side of a change. */
const CONTEXT = 3

/** Changes separated by more than this many unchanged lines become separate hunks,
 *  the same threshold unified diff uses. */
const MAX_GAP = CONTEXT * 2

/** Guard against a quadratic table when two large documents share almost nothing.
 *  Past it the changed middle is reported as a wholesale replacement — coarse, but
 *  still a correct diff. */
const MAX_CELLS = 4_000_000

interface Op {
  tag: ' ' | '-' | '+'
  line: string
}

/** LCS diff over two line arrays. Ties drop the `before` line first, so a
 *  replacement reads as `-` then `+` rather than the other way round. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const ops: Op[] = []
  if (n * m > MAX_CELLS) {
    for (const line of a) ops.push({ tag: '-', line })
    for (const line of b) ops.push({ tag: '+', line })
    return ops
  }
  // lcs[i * (m + 1) + j] = length of the LCS of a[i..] and b[j..]
  const width = m + 1
  const lcs = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * width
    const next = row + width
    for (let j = m - 1; j >= 0; j--) {
      lcs[row + j] = a[i] === b[j] ? lcs[next + j + 1]! + 1 : Math.max(lcs[next + j]!, lcs[row + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const aLine = a[i]!
    const bLine = b[j]!
    if (aLine === bLine) {
      ops.push({ tag: ' ', line: aLine })
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ tag: '-', line: aLine })
      i++
    } else {
      ops.push({ tag: '+', line: bLine })
      j++
    }
  }
  while (i < n) ops.push({ tag: '-', line: a[i++]! })
  while (j < m) ops.push({ tag: '+', line: b[j++]! })
  return ops
}

export function htmlDiff(before: string, after: string): HtmlDiffResult {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')

  // The unchanged head and tail are context only; diffing just the middle keeps the
  // LCS table proportional to the edit rather than to the document.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++
  }

  const ops: Op[] = []
  for (let i = 0; i < head; i++) ops.push({ tag: ' ', line: a[i]! })
  for (const op of diffLines(a.slice(head, a.length - tail), b.slice(head, b.length - tail))) ops.push(op)
  for (let i = a.length - tail; i < a.length; i++) ops.push({ tag: ' ', line: a[i]! })

  // Lines consumed before each op index, so a hunk can report 1-based starts.
  const aAt = new Int32Array(ops.length + 1)
  const bAt = new Int32Array(ops.length + 1)
  let added = 0
  let removed = 0
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    aAt[i + 1] = aAt[i]! + (op.tag === '+' ? 0 : 1)
    bAt[i + 1] = bAt[i]! + (op.tag === '-' ? 0 : 1)
    if (op.tag === '+') added++
    else if (op.tag === '-') removed++
  }

  const hunks: HtmlDiffHunk[] = []
  let i = 0
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.tag === ' ') i++
    if (i >= ops.length) break
    const start = Math.max(0, i - CONTEXT)
    let last = i
    let j = i
    while (j < ops.length) {
      if (ops[j]!.tag !== ' ') {
        last = j
        j++
        continue
      }
      let k = j
      while (k < ops.length && ops[k]!.tag === ' ') k++
      if (k < ops.length && k - j <= MAX_GAP) {
        j = k
        continue
      }
      break
    }
    const end = Math.min(ops.length, last + CONTEXT + 1)
    hunks.push({
      a_start: aAt[start]! + 1,
      b_start: bAt[start]! + 1,
      lines: ops.slice(start, end).map((op) => op.tag + op.line),
    })
    i = end
  }

  return { hunks, added, removed }
}
