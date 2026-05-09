'use client'

/**
 * W3.1 — Find / Replace search helpers for the bulk-ops grid.
 *
 * Pure functions only. No DOM, no React, no TanStack — they operate
 * over plain {rowIdx, colIdx, value, columnId} cell tuples that the
 * caller assembles from the live table. Keeping the search logic
 * here means:
 *   - W3.2's UI shell can ship without touching this file
 *   - the query options (regex / case / whole-word) can be unit-
 *     tested standalone
 *   - the replacement preview path in W3.4 reuses `findMatches`
 *     verbatim instead of duplicating the scan
 *
 * Excel parity targets:
 *   - case-sensitive toggle
 *   - whole-word toggle
 *   - regex mode (raw RE supplied by the operator)
 *   - scope: within selection / per column / entire grid
 *   - Replace All counts only cells that actually changed
 */

export interface FindOptions {
  /** Search needle. Empty string returns no matches. */
  query: string
  /** When true, query and cell value are compared as-is. */
  caseSensitive: boolean
  /** When true, the match must be flanked by non-word characters
   *  (or the cell boundary). Implemented via \b in regex mode. */
  wholeWord: boolean
  /** When true, query is interpreted as a JS regular expression
   *  source. Invalid patterns return [] without throwing — the UI
   *  surfaces an "Invalid regex" hint instead. */
  regex: boolean
}

export interface FindScope {
  kind: 'all' | 'selection' | 'column'
  /** For kind='selection' — inclusive bounds the caller provides. */
  bounds?: {
    minRow: number
    maxRow: number
    minCol: number
    maxCol: number
  }
  /** For kind='column' — the column id to scope to. */
  columnId?: string
}

/**
 * Cell tuple the search functions operate on. The caller assembles
 * these from `table.getRowModel().rows` × `getVisibleLeafColumns()`.
 * Coordinates are visible-leaf indices, NOT the raw column registry
 * order — same convention used by selection / drag-fill.
 */
export interface FindCell {
  rowIdx: number
  colIdx: number
  rowId: string
  columnId: string
  value: unknown
}

export interface FindMatch {
  rowIdx: number
  colIdx: number
  rowId: string
  columnId: string
  /** The cell value coerced to string (what the search ran against). */
  display: string
}

/**
 * Build the RegExp the search runs against. Returns null when the
 * caller's query is empty or the regex source is invalid.
 */
export function buildSearchRegex(opts: FindOptions): RegExp | null {
  if (!opts.query) return null
  const flags = opts.caseSensitive ? 'g' : 'gi'
  let source: string
  if (opts.regex) {
    source = opts.query
  } else {
    // Escape every regex metachar — operators paste raw text and
    // expect literal matching unless they explicitly toggled regex.
    source = opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  if (opts.wholeWord) {
    // \b on each side. Works for ASCII word chars; catalogue copy
    // is mostly Latin so this is fine. Unicode-aware boundaries
    // would need /u + lookarounds and aren't worth the perf hit
    // for this scale.
    source = `\\b(?:${source})\\b`
  }
  try {
    return new RegExp(source, flags)
  } catch {
    return null
  }
}

/**
 * Scan a flat list of cells against the find options, returning
 * every match in row-major order (so Enter / Shift+Enter cycle in a
 * predictable direction).
 */
export function findMatches(
  cells: FindCell[],
  opts: FindOptions,
): FindMatch[] {
  const re = buildSearchRegex(opts)
  if (!re) return []
  const out: FindMatch[] = []
  for (const c of cells) {
    if (c.value === null || c.value === undefined) continue
    const s = String(c.value)
    if (s.length === 0) continue
    // We only need to know whether the cell matches at all — the
    // replace path runs the same regex per cell when it's time to
    // mutate. Reset lastIndex because the regex carries `g`.
    re.lastIndex = 0
    if (re.test(s)) {
      out.push({
        rowIdx: c.rowIdx,
        colIdx: c.colIdx,
        rowId: c.rowId,
        columnId: c.columnId,
        display: s,
      })
    }
  }
  return out
}

/**
 * Filter a flat list of cells to the ones inside the given scope.
 * The caller assembles the cells once per render and we walk the
 * filtered window per query — keeps the per-keystroke search cost
 * bounded by the visible-leaf × selected-rows window, not the full
 * grid.
 */
export function applyScope(
  cells: FindCell[],
  scope: FindScope,
): FindCell[] {
  if (scope.kind === 'all') return cells
  if (scope.kind === 'selection') {
    const b = scope.bounds
    if (!b) return [] // selection scope without a selection = no rows
    return cells.filter(
      (c) =>
        c.rowIdx >= b.minRow &&
        c.rowIdx <= b.maxRow &&
        c.colIdx >= b.minCol &&
        c.colIdx <= b.maxCol,
    )
  }
  if (scope.kind === 'column') {
    if (!scope.columnId) return []
    return cells.filter((c) => c.columnId === scope.columnId)
  }
  return cells
}

/**
 * Apply the replacement to a single string. Returns the new string
 * (which may equal the original if nothing matched — caller should
 * skip writing in that case so the changes Map / history stack stay
 * clean of no-ops).
 */
export function replaceInString(
  source: string,
  opts: FindOptions,
  replacement: string,
): string {
  const re = buildSearchRegex(opts)
  if (!re) return source
  re.lastIndex = 0
  return source.replace(re, replacement)
}

/**
 * Precompute the set of (rowIdx, colIdx) keys for a match list so the
 * grid's overlay layer can highlight them in O(1) per cell.
 */
export function matchKeySet(matches: FindMatch[]): Set<string> {
  const out = new Set<string>()
  for (const m of matches) {
    out.add(`${m.rowIdx}:${m.colIdx}`)
  }
  return out
}
