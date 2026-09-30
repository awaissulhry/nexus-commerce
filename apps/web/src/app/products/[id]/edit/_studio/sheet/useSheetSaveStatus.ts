import { useCallback, useEffect, useRef, useState } from 'react'
import type { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { productSheetRowKey, type ProductSheetRowIdentity } from './productSheetRows'

export function useSheetSaveStatus<Row extends ProductSheetRowIdentity>(writer: SheetWriter<Row>, tracker: CellSaveTracker, rows: Row[], columns?: Array<{ key: string }>) {
  const [state, setState] = useState({ pending: 0, refused: 0, warned: 0, retryable: 0, refusedRowIds: new Set<string>() as ReadonlySet<string>, offline: false, saving: false })
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
    // P1 — values the server stored WITH a warning (the status line says "Saved … with N warnings").
    const next = { pending: writer.pending, refused, warned: tracker.warnedCount, retryable: writer.failedCount, refusedRowIds, offline: writer.unreachable, saving: writer.busy }
    // P2 (I4-4) — a writer event that changes no count keeps the state: every new object re-rendered the whole sheet.
    setState(previous => sameStatus(previous, next) ? previous : next)
  }, [])
  useEffect(() => { refreshCounts(); return writer.subscribe(refreshCounts) }, [writer, refreshCounts])
  useEffect(refreshCounts, [rows, columns, refreshCounts])
  return { ...state, refreshCounts }
}

type Status = { pending: number; refused: number; warned: number; retryable: number; refusedRowIds: ReadonlySet<string>; offline: boolean; saving: boolean }
/** The same counts and the same refused rows. */
export function sameStatus(a: Status, b: Status): boolean {
  return a.pending === b.pending && a.refused === b.refused && a.warned === b.warned && a.retryable === b.retryable && a.offline === b.offline &&
    a.saving === b.saving && a.refusedRowIds.size === b.refusedRowIds.size && [...a.refusedRowIds].every(id => b.refusedRowIds.has(id))
}
