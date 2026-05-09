'use client'

/**
 * W1.6 — pure helpers backing the copy / paste effects in
 * BulkOperationsClient. Lifted out of the monolith so:
 *   - the TSV serialisation can be unit-tested without a TanStack
 *     table instance;
 *   - the paste-plan builder can grow column-mapping support in W3
 *     (Find/Replace) without reopening BulkOperationsClient.
 *
 * Pure functions only. State setters + DOM event wiring stay in the
 * caller — these helpers don't reach for window / document.
 */

import type { Table, Row, Column } from '@tanstack/react-table'
import type { FieldDef } from '../components/ColumnSelector'
import type { BulkProduct } from './types'
import type { PasteCell, PasteError } from '../PastePreviewModal'
import { toTsvCell, parseTsv, coercePasteValue } from './tsv-helpers'

export interface RangeBounds {
  minRow: number
  maxRow: number
  minCol: number
  maxCol: number
}

/**
 * Serialise the cells inside `bounds` to a TSV string suitable for
 * pasting into Excel / Google Sheets. Columns outside the visible
 * leaf set are emitted as empty cells so the row geometry stays
 * intact.
 */
export function selectionToTsv(
  table: Table<BulkProduct>,
  bounds: RangeBounds,
): string {
  const tableRows = table.getRowModel().rows
  const cols = table.getVisibleLeafColumns()
  const tsvRows: string[] = []
  for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
    const row = tableRows[r]
    if (!row) continue
    const cells: string[] = []
    for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
      const col = cols[c]
      if (!col) {
        cells.push('')
        continue
      }
      let v: unknown
      try {
        v = row.getValue(col.id)
      } catch {
        v = undefined
      }
      cells.push(toTsvCell(v))
    }
    tsvRows.push(cells.join('\t'))
  }
  return tsvRows.join('\n')
}

export interface BuildPastePlanOptions {
  table: Table<BulkProduct>
  allFields: FieldDef[]
  /** Selection's active cell — origin for the paste anchor when no
   *  range is active, otherwise the rangeBounds top-left wins. */
  active: { rowIdx: number; colIdx: number }
  /** Selection's range bounds, or null when only a single cell is
   *  active. Used to detect "1×1 source onto multi-cell selection"
   *  (Excel fill-range behaviour). */
  rangeBounds: RangeBounds | null
  /** Raw clipboard text. */
  text: string
}

export interface PastePlanResult {
  plan: PasteCell[]
  errors: PasteError[]
}

/**
 * Build the cell-by-cell paste plan for a clipboard payload. Returns
 * `{plan: [], errors: []}` when nothing in the payload could land
 * (caller should not open the preview modal in that case).
 *
 * Excel-equivalent rules:
 *   - 1×1 source over multi-cell selection → fill the entire range
 *   - otherwise the source dimensions drive the target rectangle
 *   - read-only / type-mismatch cells go to `errors` and skip plan
 */
export function buildPastePlan(opts: BuildPastePlanOptions): PastePlanResult {
  const { table, allFields, active, rangeBounds, text } = opts
  const sourceGrid = parseTsv(text)
  if (sourceGrid.length === 0) return { plan: [], errors: [] }

  const tableRows = table.getRowModel().rows
  const visibleCols = table.getVisibleLeafColumns()
  const startRow = active.rowIdx
  const startCol = active.colIdx

  const isSingleSource =
    sourceGrid.length === 1 && sourceGrid[0].length === 1
  const rangeRows = rangeBounds
    ? rangeBounds.maxRow - rangeBounds.minRow + 1
    : 1
  const rangeCols = rangeBounds
    ? rangeBounds.maxCol - rangeBounds.minCol + 1
    : 1
  const fillRange =
    isSingleSource && rangeBounds && (rangeRows > 1 || rangeCols > 1)
  const sourceRows = fillRange ? rangeRows : sourceGrid.length
  const sourceCols = fillRange
    ? rangeCols
    : Math.max(...sourceGrid.map((r) => r.length))
  const anchorRow = fillRange ? rangeBounds!.minRow : startRow
  const anchorCol = fillRange ? rangeBounds!.minCol : startCol

  const plan: PasteCell[] = []
  const errors: PasteError[] = []
  for (let dr = 0; dr < sourceRows; dr++) {
    const targetRow = anchorRow + dr
    if (targetRow >= tableRows.length) break
    const row = tableRows[targetRow]
    if (!row) continue
    for (let dc = 0; dc < sourceCols; dc++) {
      const targetCol = anchorCol + dc
      if (targetCol >= visibleCols.length) break
      const col: Column<BulkProduct, unknown> | undefined = visibleCols[targetCol]
      if (!col) continue
      const fieldDef = allFields.find((f) => f.id === col.id)
      const sku = (row as Row<BulkProduct>).original.sku ?? ''
      const fieldLabel = fieldDef?.label ?? col.id
      if (!fieldDef?.editable) {
        errors.push({
          rowIdx: targetRow,
          colIdx: targetCol,
          sku,
          fieldLabel,
          reason: 'Read-only',
        })
        continue
      }
      const sourceR = fillRange ? 0 : dr
      const sourceC = fillRange ? 0 : dc
      const raw = sourceGrid[sourceR]?.[sourceC] ?? ''
      const coerced = coercePasteValue(raw, fieldDef)
      if (coerced.error) {
        errors.push({
          rowIdx: targetRow,
          colIdx: targetCol,
          sku,
          fieldLabel,
          reason: coerced.error,
        })
        continue
      }
      let oldValue: unknown
      try {
        oldValue = row.getValue(col.id)
      } catch {
        oldValue = undefined
      }
      plan.push({
        rowIdx: targetRow,
        colIdx: targetCol,
        rowId: row.original.id,
        columnId: col.id,
        oldValue,
        newValue: coerced.value,
        sku,
        fieldLabel,
      })
    }
  }
  return { plan, errors }
}

/**
 * Decide whether a synthetic copy / paste should fire for the given
 * focus context. Skip when an INPUT / TEXTAREA / contenteditable is
 * focused so the browser's native clipboard semantics for editable
 * fields are preserved.
 */
export function shouldInterceptClipboard(): boolean {
  const ae = document.activeElement as HTMLElement | null
  if (!ae) return true
  const tag = ae.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || ae.isContentEditable) {
    return false
  }
  return true
}
