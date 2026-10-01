import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { productSheetRowKey, type ProductSheetRowIdentity } from './productSheetRows'
import { createSheetSaveStatusStore } from './sheetSaveStatusStore'
export { sameStatus } from './sheetSaveStatusStore'

export function useSheetSaveStatus<Row extends ProductSheetRowIdentity>(writer: SheetWriter<Row>, tracker: CellSaveTracker, rows: Row[], columns?: Array<{ key: string }>) {
  const live = useRef({ writer, tracker, rows, columns })
  live.current = { writer, tracker, rows, columns }
  const saveStatus = useMemo(() => createSheetSaveStatusStore(() => {
    const { writer, tracker, rows, columns } = live.current
    const refusedRowIds = new Set<string>()
    let refused = 0
    for (const row of rows) for (const column of columns ?? []) {
      const id = productSheetRowKey(row)
      if (tracker.get(id, column.key)?.state === 'refused') { refused++; refusedRowIds.add(id) }
    }
    // P1 — values the server stored WITH a warning (the status line says "Saved … with N warnings").
    return { pending: writer.pending, refused, warned: tracker.warnedCount, retryable: writer.failedCount, refusedRowIds, offline: writer.unreachable, saving: writer.busy }
  }), [writer])
  const refreshCounts = saveStatus.refreshCounts
  useEffect(() => { refreshCounts(); return writer.subscribe(refreshCounts) }, [writer, refreshCounts])
  useEffect(refreshCounts, [rows, columns, refreshCounts])
  const refused = useSyncExternalStore(saveStatus.subscribe, saveStatus.getRefusedSnapshot, saveStatus.getRefusedSnapshot)
  return { ...refused, saveStatus, refreshCounts }
}
