import { useCallback, useMemo } from 'react'
import type { GridApi, SheetWriter } from '@/design-system/grid'

import { operationFence } from './bulkOperation'
import { SheetUndoHistory, undoShortcut, type ApplyCellValues, type SheetCellChange } from './sheetUndo'

/**
 * The sheet's undo, wired: a history that survives the sheet's re-reads (`sheetUndo.ts`), ⌘Z / ⌘⇧Z on a focused cell,
 * and the grid's operation events as ONE fence for both the history (one step) and the writer (one save).
 */
export function useSheetUndo<Row>(writer: SheetWriter<Row>, getGridApi: () => GridApi<Row> | null) {
  const history = useMemo(() => new SheetUndoHistory(), [])

  /* Each value goes back through the grid, so it takes the typed-edit road (write gate, formula check, save); the
     writer fence around them makes the whole step ONE request. Rows the sheet no longer holds are skipped.
     🔴 AG reports `cellValueChanged` AFTER the current turn (only fillStart/pasteStart are synchronous, AG 36.1), so
     the fence closes on the next turn — after the grid has reported every change — and the source names the change
     (`undo` / `redo`) so `record` can tell it from an operator's edit. */
  const apply = useCallback<ApplyCellValues>((values, direction) => {
    const api = getGridApi()
    if (!api || api.isDestroyed()) return
    writer.beginOperation()
    try {
      for (const { rowId, colId, value } of values) api.getRowNode(rowId)?.setDataValue(colId, value, direction)
    } finally {
      setTimeout(() => writer.endOperation(), 0)
    }
  }, [writer, getGridApi])

  /** True when the key was an undo/redo and was handled. An open editor keeps its own text undo. */
  const onKeyDown = useCallback((event: Event | null | undefined): boolean => {
    const key = event as KeyboardEvent | null | undefined
    if (!key || typeof key.key !== 'string') return false
    const action = undoShortcut(key)
    if (!action || (getGridApi()?.getEditingCells().length ?? 0) > 0) return false
    key.preventDefault()
    if (action === 'undo') history.undo(apply)
    else history.redo(apply)
    return true
  }, [history, apply, getGridApi])

  /** An operator's edit (never the undo's or redo's own write-back, which AG reports later with that source). */
  const record = useCallback((change: SheetCellChange, source?: string) => {
    if (source === 'undo' || source === 'redo') return
    history.record(change)
  }, [history])

  /* The grid's fill / paste / range-delete events open ONE step and ONE save together. AG's own undo is off (it forgets
     everything on each re-read); ⌘Z is handled by `onKeyDown` instead. */
  const gridProps = useMemo(() => ({
    undoRedoCellEditing: false,
    ...operationFence({
      beginOperation: () => { writer.beginOperation(); history.begin() },
      endOperation: () => { history.end(); writer.endOperation() },
    }),
  }), [writer, history])

  return { history, record, onKeyDown, gridProps }
}
