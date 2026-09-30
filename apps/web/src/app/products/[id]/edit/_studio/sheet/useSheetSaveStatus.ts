import { useCallback, useEffect, useRef, useState } from 'react'
import type { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { productSheetRowKey, type ProductSheetRowIdentity } from './productSheetRows'

export function useSheetSaveStatus<Row extends ProductSheetRowIdentity>(writer: SheetWriter<Row>, tracker: CellSaveTracker, rows: Row[], columns?: Array<{ key: string }>) {
  const [state, setState] = useState<Status>({ pending: 0, refused: 0, warned: 0, retryable: 0, refusedRowIds: new Set<string>() as ReadonlySet<string>, offline: false, saving: false })
  const live = useRef({ writer, tracker, rows, columns })
  live.current = { writer, tracker, rows, columns }
  const refreshCounts = useCallback(() => {
    const { writer, tracker, rows, columns } = live.current
    const next = countSaveStatus(writer, tracker, rows, columns ?? [])
    // P2 (I4-4) — a writer event that changes no count keeps the state: every new object re-rendered the whole sheet.
    setState(previous => sameStatus(previous, next) ? previous : next)
  }, [])
  useEffect(() => { refreshCounts(); return subscribeCoalesced(writer, refreshCounts) }, [writer, refreshCounts])
  useEffect(refreshCounts, [rows, columns, refreshCounts])
  return { ...state, refreshCounts }
}

type Status = { pending: number; refused: number; warned: number; retryable: number; refusedRowIds: ReadonlySet<string>; offline: boolean; saving: boolean }

/**
 * The status line's counts over the cells the sheet SHOWS (its rows × its columns). Warnings are counted here too, not
 * from the whole tracker: a warned cell whose column or row left the sheet (a language chip turned off, another listing
 * chosen) no longer says "with 1 warning" about a cell nobody can see (audit A11).
 */
export function countSaveStatus(writer: Pick<SheetWriter<unknown>, 'pending' | 'failedCount' | 'unreachable' | 'busy'>, tracker: Pick<CellSaveTracker, 'get'>,
  rows: readonly ProductSheetRowIdentity[], columns: ReadonlyArray<{ key: string }>): Status {
  const refusedRowIds = new Set<string>()
  let refused = 0, warned = 0
  for (const row of rows) {
    const id = productSheetRowKey(row)
    for (const column of columns) {
      const entry = tracker.get(id, column.key)
      if (!entry) continue
      if (entry.state === 'refused') { refused++; refusedRowIds.add(id) }
      // P1 — values the server stored WITH a warning (the status line says "Saved … with N warnings").
      else if (entry.state === 'saved' && entry.warning) warned++
    }
  }
  return { pending: writer.pending, refused, warned, retryable: writer.failedCount, refusedRowIds, offline: writer.unreachable, saving: writer.busy }
}

/**
 * Audit B26 — the writer emits once per queued cell and once per settled row, all in the same turn: a 105 × 5 paste
 * is 631 emits, and recounting rows × columns on each held the main thread ~1.8 s. The recount now runs ONCE per turn,
 * after the burst, on the state the burst left.
 */
export function subscribeCoalesced(source: { subscribe: (fn: () => void) => () => void }, run: () => void): () => void {
  let queued = false, live = true
  const unsubscribe = source.subscribe(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => { queued = false; if (live) run() })
  })
  return () => { live = false; unsubscribe() }
}

/** The same counts and the same refused rows. */
export function sameStatus(a: Status, b: Status): boolean {
  return a.pending === b.pending && a.refused === b.refused && a.warned === b.warned && a.retryable === b.retryable && a.offline === b.offline &&
    a.saving === b.saving && a.refusedRowIds.size === b.refusedRowIds.size && [...a.refusedRowIds].every(id => b.refusedRowIds.has(id))
}
