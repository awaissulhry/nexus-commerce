import type { FillOperationParams, ProcessCellForExportParams } from 'ag-grid-community'

/** Locate the repeating source cell in displayed order, so sorting/filtering cannot change its meaning. */
export function formulaFillSourceIndex(target: number, current: number, count: number, direction: 'up' | 'down' | 'left' | 'right'): number {
  const distance = current + count - current % count
  return direction === 'down' || direction === 'right' ? target - distance : target + distance
}

/** Copy/fill carries the expression; the existing cell-save handler evaluates it for each target row. */
export function formulaTransfer<TRow>(input: {
  exprFor: (row: TRow, column: string) => string | null
  canEditRow?: (row: TRow) => boolean
}) {
  return {
    processCellForClipboard: (p: ProcessCellForExportParams<TRow>) => {
      const expr = p.node?.data ? input.exprFor(p.node.data, p.column.getColId()) : null
      return expr ? `=${expr}` : p.formatValue(p.value) ?? p.value
    },
    cellSelection: { handle: { mode: 'fill' as const, setFillValue: (p: FillOperationParams<TRow>) => {
      const count = p.initialValues.length
      if (!count || !p.rowNode.data || input.canEditRow?.(p.rowNode.data) === false) return false
      const vertical = p.direction === 'up' || p.direction === 'down'
      const columns = p.api.getAllDisplayedColumns()
      const target = vertical ? p.rowNode.rowIndex : columns.indexOf(p.column)
      if (target == null || target < 0) return false
      const sourceIndex = formulaFillSourceIndex(target, p.currentIndex, count, p.direction)
      const sourceNode = vertical ? p.api.getDisplayedRowAtIndex(sourceIndex) : p.rowNode
      const sourceColumn = vertical ? p.column : columns[sourceIndex]
      if (!sourceNode?.data || !sourceColumn) return false
      const expr = input.exprFor(sourceNode.data, sourceColumn.getColId())
      return expr ? `=${expr}` : false
    } } },
  }
}
