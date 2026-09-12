import { formulaFillSourceIndex, formulaTransfer } from '@/design-system/grid/editors/formulaTransfer'
import { readMediaClipboard } from './mediaCellTransfer'
import type { MediaCellActions, MediaRow } from './useMediaCellActions'

/** Keep typed media inside its column while preserving the sheet's formula transfer contract. */
export function mediaGridTransfer<Row extends MediaRow>(base: ReturnType<typeof formulaTransfer<Row>>, actions: MediaCellActions) {
  return {
    processCellForClipboard: (p: Parameters<typeof base.processCellForClipboard>[0]) => p.column.getColId() === 'productMedia' ? p.value : base.processCellForClipboard(p),
    processCellFromClipboard: (p: Parameters<typeof base.processCellForClipboard>[0]) => p.column.getColId() !== 'productMedia' && readMediaClipboard(p.value)
      ? p.node ? p.api.getCellValue({ rowNode: p.node, colKey: p.column }) : null : p.value,
    cellSelection: { handle: { ...base.cellSelection.handle, suppressClearOnFillReduction: true, setFillValue: (p: Parameters<typeof base.cellSelection.handle.setFillValue>[0]) => {
      const count = p.initialValues.length, vertical = p.direction === 'up' || p.direction === 'down'
      const columns = p.api.getAllDisplayedColumns(), index = vertical ? p.rowNode.rowIndex : columns.indexOf(p.column)
      if (!count || index == null || index < 0) return p.currentCellValue
      const sourceIndex = formulaFillSourceIndex(index, p.currentIndex, count, p.direction)
      const source = vertical ? p.api.getDisplayedRowAtIndex(sourceIndex) : p.rowNode
      const sourceColumn = vertical ? p.column : columns[sourceIndex]
      if (p.column.getColId() === 'productMedia') return sourceColumn?.getColId() === 'productMedia' && source?.data ? actions.value(source.data) : p.currentCellValue
      if (sourceColumn?.getColId() === 'productMedia') return p.currentCellValue
      return base.cellSelection.handle.setFillValue(p)
    } } },
  }
}
