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
/** Row's product type, normalized for comparison ('' when absent/non-string). */
function rowProductType(row: BaseRow): string {
  return typeof row.product_type === 'string' ? row.product_type.trim().toUpperCase() : ''
}

/**
 * UFX P2c — built-in per-type applicability. A column carrying
 * `applicableProductTypes` is 'not-applicable' for a row whose `product_type`
 * (compared uppercased) is not in the list. Rows without a product_type, and
 * columns without the field, get no built-in guidance. The cell stays fully
 * editable either way — this only drives the guidance overlay/tooltip.
 */
export function typeApplicabilityGuidance(
  col: Pick<FlatFileColumn, 'applicableProductTypes'>,
  row: BaseRow,
): 'not-applicable' | null {
  const list = col.applicableProductTypes
  if (!list) return null
  const t = rowProductType(row)
  if (!t) return null
  return list.some((pt) => pt.toUpperCase() === t) ? null : 'not-applicable'
}

/**
 * UFX P2c — per-row required resolution. With `requiredForProductTypes` set,
 * the required marker/styling apply only to rows whose product_type
 * (uppercased) is in the list; rows without a resolvable type get none.
 * Without the field, falls back to the plain `required` flag (legacy columns
 * unchanged).
 */
export function isRequiredForRow(
  col: Pick<FlatFileColumn, 'required' | 'requiredForProductTypes'>,
  row: BaseRow,
): boolean {
  const list = col.requiredForProductTypes
  if (!list) return !!col.required
  const t = rowProductType(row)
  if (!t) return false
  return list.some((pt) => pt.toUpperCase() === t)
}

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
