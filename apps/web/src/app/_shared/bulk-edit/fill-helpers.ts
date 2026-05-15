// Excel-style autofill helpers. Pure functions — given a source
// rectangle, target cell, and the table's row/column models, compute
// where the fill extension lands and what value goes in each cell.

import type { Column, Row } from '@tanstack/react-table'
import type { BulkProduct, CellCoord, FillExtension } from './types'

/**
 * Pick the largest axis distance from any edge of `source` to
 * `target`. Returns the rectangular extension on that axis, or null
 * when target is inside source (no fill).
 */
export function computeFillExtension(
  source: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  target: CellCoord,
): FillExtension | null {
  const dDown = target.rowIdx - source.maxRow
  const dUp = source.minRow - target.rowIdx
  const dRight = target.colIdx - source.maxCol
  const dLeft = source.minCol - target.colIdx
  const maxD = Math.max(dDown, dUp, dRight, dLeft)
  if (maxD <= 0) return null
  if (maxD === dDown) {
    return {
      minRow: source.maxRow + 1,
      maxRow: target.rowIdx,
      minCol: source.minCol,
      maxCol: source.maxCol,
      axis: 'row',
    }
  }
  if (maxD === dUp) {
    return {
      minRow: target.rowIdx,
      maxRow: source.minRow - 1,
      minCol: source.minCol,
      maxCol: source.maxCol,
      axis: 'row',
    }
  }
  if (maxD === dRight) {
    return {
      minRow: source.minRow,
      maxRow: source.maxRow,
      minCol: source.maxCol + 1,
      maxCol: target.colIdx,
      axis: 'col',
    }
  }
  return {
    minRow: source.minRow,
    maxRow: source.maxRow,
    minCol: target.colIdx,
    maxCol: source.minCol - 1,
    axis: 'col',
  }
}

/** Detect a constant-step linear pattern across a numeric source.
 *  Returns null for non-numeric, length<2, or non-constant diffs. */
export function detectLinearStep(values: unknown[]): number | null {
  if (values.length < 2) return null
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return null
  }
  const step = (values[1] as number) - (values[0] as number)
  if (step === 0) return null
  for (let i = 2; i < values.length; i++) {
    if ((values[i] as number) - (values[i - 1] as number) !== step) return null
  }
  return step
}

export function computeFillValueAlongAxis(
  values: unknown[],
  d: number,
): unknown {
  const len = values.length
  if (len === 0) return null
  if (len === 1) return values[0]
  const step = detectLinearStep(values)
  if (step !== null) {
    return (values[0] as number) + step * d
  }
  // Cyclic fallback — works for both forward and backward drags.
  const idx = ((d % len) + len) % len
  return values[idx]
}

/** Compute the value to write into one extension cell, based on the
 *  source values along the relevant axis and the cell's distance from
 *  the source's leading edge. */
export function computeFillValue(
  source: { minRow: number; maxRow: number; minCol: number; maxCol: number },
  ext: FillExtension,
  target: CellCoord,
  tableRows: Row<BulkProduct>[],
  cols: Column<BulkProduct, unknown>[],
): unknown {
  const sourceValues: unknown[] = []
  if (ext.axis === 'row') {
    const col = cols[target.colIdx]
    if (!col) return undefined
    for (let r = source.minRow; r <= source.maxRow; r++) {
      const row = tableRows[r]
      if (!row) {
        sourceValues.push(null)
        continue
      }
      try {
        sourceValues.push(row.getValue(col.id))
      } catch {
        sourceValues.push(null)
      }
    }
    const d = target.rowIdx - source.minRow
    return computeFillValueAlongAxis(sourceValues, d)
  }
  const row = tableRows[target.rowIdx]
  if (!row) return undefined
  for (let c = source.minCol; c <= source.maxCol; c++) {
    const col = cols[c]
    if (!col) {
      sourceValues.push(null)
      continue
    }
    try {
      sourceValues.push(row.getValue(col.id))
    } catch {
      sourceValues.push(null)
    }
  }
  const d = target.colIdx - source.minCol
  return computeFillValueAlongAxis(sourceValues, d)
}
