'use client'

/**
 * W4.3 — Group-by column.
 *
 * Operators want to group thousands of SKUs by Brand / ProductType /
 * Status to scan the catalog in chunks. Implementation pattern:
 *
 *   1. Apply sort + filter as today.
 *   2. If a group-by column is set, walk the rows once and emit a
 *      stream that intersperses synthetic GROUP_HEADER rows between
 *      the data rows. Collapsing a group hides every row beneath it.
 *   3. The virtualizer treats the synthetic rows as plain rows
 *      (uniform height) — no special TanStack plumbing needed.
 *
 * Pure functions. Caller owns the state (groupByColumnId,
 * collapsedGroupKeys) and the row-render branch that recognises the
 * synthetic header type.
 */

import { readRowValue } from './multi-sort'

/**
 * Synthetic group header row inserted between data rows. The grid's
 * row renderer dispatches on `__group: true` to swap the editable-
 * cell row out for a single-cell header strip.
 */
export interface GroupHeader {
  __group: true
  /** Stable id for React keys. Built from columnId + value. */
  id: string
  columnId: string
  value: unknown
  /** Display label for the value (already stringified). */
  label: string
  /** Number of data rows in this group. */
  count: number
  /** True when the operator has this group collapsed; the row
   *  list omits the children but keeps this header visible. */
  collapsed: boolean
}

export function isGroupHeader(row: unknown): row is GroupHeader {
  return (
    !!row &&
    typeof row === 'object' &&
    (row as Record<string, unknown>).__group === true
  )
}

/**
 * Bucket rows by columnId value, preserving the input order within
 * each bucket. Used by the row pipeline AND any aggregate widgets
 * (group counts in the toolbar, etc.).
 */
export function bucketByColumn<T extends Record<string, unknown>>(
  rows: T[],
  columnId: string,
): Map<string, T[]> {
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const v = readRowValue(row, columnId)
    const key = v === null || v === undefined || v === '' ? '∅' : String(v)
    let arr = buckets.get(key)
    if (!arr) {
      arr = []
      buckets.set(key, arr)
    }
    arr.push(row)
  }
  return buckets
}

/**
 * Build the visible row stream when grouping is on. Emits one
 * GroupHeader per bucket followed (when not collapsed) by the
 * bucket's data rows. Empty input → empty output (caller already
 * has this case via filteredProducts.length === 0).
 */
export function buildGroupedRows<T extends Record<string, unknown>>(
  rows: T[],
  columnId: string,
  collapsedGroupKeys: Set<string>,
): Array<GroupHeader | T> {
  const buckets = bucketByColumn(rows, columnId)
  const out: Array<GroupHeader | T> = []
  for (const [key, bucketRows] of buckets) {
    const collapsed = collapsedGroupKeys.has(key)
    out.push({
      __group: true,
      id: `__grp:${columnId}:${key}`,
      columnId,
      value: key === '∅' ? null : key,
      label: key === '∅' ? '(empty)' : key,
      count: bucketRows.length,
      collapsed,
    })
    if (!collapsed) {
      for (const r of bucketRows) out.push(r)
    }
  }
  return out
}

/**
 * Toggle one group's collapsed state. Returns a new Set so React
 * setState picks up the change.
 */
export function toggleGroup(
  current: Set<string>,
  key: string,
): Set<string> {
  const next = new Set(current)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
