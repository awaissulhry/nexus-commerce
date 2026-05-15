'use client'

/**
 * W4.1 — multi-key sort helper.
 *
 * Power users in spreadsheet workflows expect "sort by Status, then
 * by Stock desc, then by SKU" — TanStack's built-in `getSortedRowModel`
 * supports this but requires plugging into the table state. The grid
 * already runs hierarchy + filter pipelines BEFORE handing rows to
 * TanStack, so we keep the sort outside the table too: walk the rows
 * once and stable-sort against the supplied key list.
 *
 * Pure functions only. The UI (header click handlers, sort manager
 * popover) lives in BulkOperationsClient and reads from useState.
 */

export interface SortKey {
  columnId: string
  direction: 'asc' | 'desc'
}

/**
 * Cycle a column through the standard "asc → desc → unsorted" three
 * states a header click should produce. shift=true means the click
 * was a Shift+click — we add to / remove from the multi-key list
 * instead of replacing it.
 */
export function cycleSortKey(
  current: SortKey[],
  columnId: string,
  shift: boolean,
): SortKey[] {
  const idx = current.findIndex((k) => k.columnId === columnId)
  const existing = idx >= 0 ? current[idx] : null

  // Plain click without modifier: replace the whole list.
  if (!shift) {
    if (!existing) return [{ columnId, direction: 'asc' }]
    if (existing.direction === 'asc') return [{ columnId, direction: 'desc' }]
    // desc → unsorted
    return []
  }

  // Shift+click: add / cycle / remove WITHIN the multi-key list.
  if (!existing) {
    return [...current, { columnId, direction: 'asc' }]
  }
  if (existing.direction === 'asc') {
    return current.map((k) =>
      k.columnId === columnId ? { ...k, direction: 'desc' } : k,
    )
  }
  // desc → remove from list (preserve order of the rest)
  return current.filter((k) => k.columnId !== columnId)
}

/**
 * Read a sort-comparable value off a row. Falls back to walking nested
 * jsonb paths used by ATTRIBUTE_UPDATE — `categoryAttributes.material`
 * resolves to row.categoryAttributes.material.
 */
export function readRowValue(
  row: Record<string, unknown>,
  columnId: string,
): unknown {
  if (columnId in row) return row[columnId]
  // dot-paths into a single jsonb column
  const dot = columnId.indexOf('.')
  if (dot > 0) {
    const head = columnId.slice(0, dot)
    const tail = columnId.slice(dot + 1)
    const inner = row[head]
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return (inner as Record<string, unknown>)[tail]
    }
  }
  return undefined
}

/**
 * Three-way compare with stable null/undefined/empty handling. Empty
 * cells always sort to the end regardless of direction so operators
 * see the missing-data block in one place rather than scattered
 * across the top + bottom of the grid (Excel + Sheets convention).
 */
export function compareValues(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === ''
  const bEmpty = b === null || b === undefined || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1
  // Numbers compare numerically
  if (typeof a === 'number' && typeof b === 'number') return a - b
  // Try numeric on coerced strings — '10' > '9' should NOT be string-
  // sorted to the wrong place when the column actually carries digits
  if (typeof a !== 'object' && typeof b !== 'object') {
    const na = typeof a === 'number' ? a : parseFloat(String(a))
    const nb = typeof b === 'number' ? b : parseFloat(String(b))
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      // Only choose numeric compare when BOTH parse cleanly (no
      // trailing letters); otherwise fall through to string compare.
      if (
        String(na) === String(a).trim() &&
        String(nb) === String(b).trim()
      ) {
        return na - nb
      }
    }
  }
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/**
 * Stable multi-key sort. Returns a new array (does NOT mutate
 * `rows`). Empty key list → array returned as-is (preserves the
 * grid's hierarchy / filter ordering verbatim).
 */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  keys: SortKey[],
): T[] {
  if (keys.length === 0) return rows
  // Decorate-sort-undecorate so the sort is stable across ties (Array
  // .prototype.sort is stable in modern engines but explicit indices
  // future-proof against engines that aren't, and let us stop early
  // when every key compares equal).
  const indexed = rows.map((row, idx) => ({ row, idx }))
  indexed.sort((x, y) => {
    for (const k of keys) {
      const av = readRowValue(x.row, k.columnId)
      const bv = readRowValue(y.row, k.columnId)
      const cmp = compareValues(av, bv)
      if (cmp !== 0) return k.direction === 'desc' ? -cmp : cmp
    }
    return x.idx - y.idx
  })
  return indexed.map((x) => x.row)
}
