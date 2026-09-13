import { useCallback, useEffect, useRef, useState } from 'react'
import type { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { productSheetRowKey, type ProductSheetRowIdentity } from './productSheetRows'

export function useSheetSaveStatus<Row extends ProductSheetRowIdentity>(writer: SheetWriter<Row>, tracker: CellSaveTracker, rows: Row[], columns?: Array<{ key: string }>) {
  const [state, setState] = useState({ pending: 0, refused: 0, refusedRowIds: new Set<string>() as ReadonlySet<string>, offline: false, saving: false })
  const live = useRef({ writer, tracker, rows, columns })
  live.current = { writer, tracker, rows, columns }
  const refreshCounts = useCallback(() => {
    const { writer, tracker, rows, columns } = live.current
    const refusedRowIds = new Set<string>()
    let refused = 0
    for (const row of rows) for (const column of columns ?? []) {
      const id = productSheetRowKey(row)
      if (tracker.get(id, column.key)?.state === 'refused') { refused++; refusedRowIds.add(id) }
    }
    setState({ pending: writer.pending, refused, refusedRowIds, offline: writer.unreachable, saving: writer.busy })
  }, [])
  useEffect(() => { refreshCounts(); return writer.subscribe(refreshCounts) }, [writer, refreshCounts])
  useEffect(refreshCounts, [rows, columns, refreshCounts])
  return { ...state, refreshCounts }
}
