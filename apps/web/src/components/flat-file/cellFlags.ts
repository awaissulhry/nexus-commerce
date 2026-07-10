import type { BaseRow, FlatFileColumn } from './FlatFileGrid.types'

// Pure per-cell flag resolution for the shared flat-file grid (UFX Phase 2).
// Kept free of React so the write-guard and applicability rules are unit-testable.

/**
 * UFX P2b — central read-only skip for the grid's single bulk-write path
 * (commitCells). Drops every change that targets a cell the per-cell
 * `getCellReadOnly` predicate locks. Changes whose column or row can't be
 * resolved are kept — the caller's own guards (isWritableCol, row existence)
 * already handle those.
 */
export function dropReadOnlyCellChanges<C extends { rowId: string; colId: string }>(
  changes: C[],
  colById: Map<string, FlatFileColumn>,
  rowById: Map<string, BaseRow>,
  getCellReadOnly?: (col: FlatFileColumn, row: BaseRow) => boolean,
): C[] {
  if (!getCellReadOnly) return changes
  return changes.filter((ch) => {
    const col = colById.get(ch.colId)
    const row = rowById.get(ch.rowId)
    if (!col || !row) return true
    return !getCellReadOnly(col, row)
  })
}
