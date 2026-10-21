export type Diff = { text: string; added: number; removed: number }

type Op = { t: ' ' | '-' | '+'; line: string }

// LCS beyond this many cells falls back to "all removed, then all added".
const MAX_CELLS = 1_000_000

const linesOf = (text: string | null): string[] =>
  text === null || text === '' ? [] : text.replace(/\n$/, '').split('\n')

function ops(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++

  const A = a.slice(head, a.length - tail)
  const B = b.slice(head, b.length - tail)
  const mid: Op[] = []

  if (A.length * B.length <= MAX_CELLS) {
    const n = A.length
    const m = B.length
    const w = m + 1
    const lcs = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * w + j] =
          A[i] === B[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        mid.push({ t: ' ', line: A[i]! })
        i++
        j++
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) mid.push({ t: '-', line: A[i++]! })
      else mid.push({ t: '+', line: B[j++]! })
    }
    while (i < n) mid.push({ t: '-', line: A[i++]! })
    while (j < m) mid.push({ t: '+', line: B[j++]! })
  } else {
    for (const line of A) mid.push({ t: '-', line })
    for (const line of B) mid.push({ t: '+', line })
  }

  const same = (line: string): Op => ({ t: ' ', line })
  return [...a.slice(0, head).map(same), ...mid, ...a.slice(a.length - tail).map(same)]
}

/** A replaced run of the base's lines: [start, end) becomes `lines`. */
type Chunk = { start: number; end: number; lines: string[] }

function chunks(base: string[], other: string[]): Chunk[] {
  const out: Chunk[] = []
  let at = 0
  let open: Chunk | undefined
  for (const op of ops(base, other)) {
    if (op.t === ' ') {
      if (open) out.push(open)
      open = undefined
      at++
      continue
    }
    open ??= { start: at, end: at, lines: [] }
    if (op.t === '-') open.end = ++at
    else open.lines.push(op.line)
  }
  if (open) out.push(open)
  return out
}

const sameChunk = (a: Chunk, b: Chunk) =>
  a.start === b.start && a.end === b.end && a.lines.join('\n') === b.lines.join('\n')

/**
 * Three-way merge of `ours` and `theirs` from their common `base`, or undefined
 * on a conflict (both sides touching the same or adjacent lines differently).
 */
export function merge3(base: string, ours: string, theirs: string): string | undefined {
  const lines = linesOf(base)
  const all = [
    ...chunks(lines, linesOf(ours)),
    ...chunks(lines, linesOf(theirs)),
  ].sort((a, b) => a.start - b.start || a.end - b.end)

  const picked: Chunk[] = []
  for (const chunk of all) {
    const last = picked[picked.length - 1]
    if (last && chunk.start <= last.end) {
      if (sameChunk(last, chunk)) continue
      return undefined
    }
    picked.push(chunk)
  }

  const out: string[] = []
  let at = 0
  for (const chunk of picked) {
    out.push(...lines.slice(at, chunk.start), ...chunk.lines)
    at = chunk.end
  }
  out.push(...lines.slice(at))
  return out.length ? out.join('\n') + '\n' : ''
}

/** Unified diff hunks (no file header) between two texts; null means the file is absent. */
export function unifiedDiff(before: string | null, after: string | null, context = 3): Diff {
  const list = ops(linesOf(before), linesOf(after))

  // Lines of a and b consumed before each op.
  const aBefore: number[] = []
  const bBefore: number[] = []
  let ai = 0
  let bi = 0
  for (const op of list) {
    aBefore.push(ai)
    bBefore.push(bi)
    if (op.t !== '+') ai++
    if (op.t !== '-') bi++
  }

  const changed = list.flatMap((op, k) => (op.t === ' ' ? [] : [k]))
  const out: string[] = []
  let added = 0
  let removed = 0

  let g = 0
  while (g < changed.length) {
    let last = g
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * context) last++
    const start = Math.max(0, changed[g]! - context)
    const end = Math.min(list.length, changed[last]! + context + 1)

    const body: string[] = []
    let aCount = 0
    let bCount = 0
    for (let k = start; k < end; k++) {
      const op = list[k]!
      body.push(op.t + op.line)
      if (op.t !== '+') aCount++
      if (op.t !== '-') bCount++
      if (op.t === '+') added++
      if (op.t === '-') removed++
    }
    const aStart = aCount ? aBefore[start]! + 1 : aBefore[start]!
    const bStart = bCount ? bBefore[start]! + 1 : bBefore[start]!
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body)
    g = last + 1
  }

  return { text: out.join('\n'), added, removed }
}
