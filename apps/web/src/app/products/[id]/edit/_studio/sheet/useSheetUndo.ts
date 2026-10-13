import { useCallback, useMemo, useRef } from 'react'
import type { CellSaveTracker, GridApi, SheetCellOutcome, SheetWriter } from '@/design-system/grid'

import { operationFence } from './bulkOperation'
import { routeHistoryValues, SheetUndoHistory, undoShortcut, writeHistoryValues, type ApplyCellValues, type SheetCellChange, type SheetInheritValue } from './sheetUndo'
import { movedValueOf } from './sheetStamps'

/** Puts one cell back to what it inherits (G3): the scope shows the inherited value and saves the reset with `intent`. */
export type ResetCellBack = (rowId: string, colId: string, before: SheetInheritValue, onOutcome: (outcome: SheetCellOutcome) => void) => void

export interface SheetUndoOptions {
  /** The scope's save marks: an edit over a refused or unanswered one takes its "before" from what the server holds. */
  tracker?: Pick<CellSaveTracker, 'get'>
  /** The scope's reset of one cell; without it an inherited "before" is written back as its plain value. */
  resetCell?: ResetCellBack
}

/**
 * The sheet's undo, wired: a history that survives the sheet's re-reads (`sheetUndo.ts`), ⌘Z / ⌘⇧Z on a focused cell,
 * and the grid's operation events as ONE fence for both the history (one step) and the writer (one save).
 */
export function useSheetUndo<Row>(writer: SheetWriter<Row>, getGridApi: () => GridApi<Row> | null, options: SheetUndoOptions = {}) {
  const history = useMemo(() => new SheetUndoHistory(), [])
  const live = useRef(options)
  live.current = options

  /* Each value goes back through the grid, so it takes the typed-edit road (write gate, formula check, save); the
     writer fence around them makes the whole step ONE request. Rows the sheet no longer holds are skipped.
     🔴 AG reports `cellValueChanged` AFTER the current turn (only fillStart/pasteStart are synchronous, AG 36.1), so
     the fence closes on the next turn — after the grid has reported every change — and the source names the change
     (`undo` / `redo`) so `record` can tell it from an operator's edit.
     G3 — an inherited "before" is not a value: the scope resets the cell (one reset per list and row), in the same fence. */
  const apply = useCallback<ApplyCellValues>((values, direction) => {
    const api = getGridApi()
    if (!api || api.isDestroyed()) return
    writer.beginOperation()
    try {
      const { resetCell, tracker } = live.current
      writeHistoryValues(api, routeHistoryValues(values, resetCell && (({ rowId, colId, value }) => {
        // What the cell shows now is what the server holds, unless an earlier edit of it is unsettled (`edit`).
        const node = api.getRowNode(rowId)
        const shown = node ? api.getCellValue({ rowNode: node, colKey: colId }) : undefined
        resetCell(rowId, colId, value, history.edit({ rowId, colId, before: shown, after: value }, unconfirmed(tracker, rowId, colId), false))
      })), direction)
    } finally {
      setTimeout(() => writer.endOperation(), 0)
    }
  }, [writer, getGridApi, history])

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

  /**
   * G2 — an edit about to be saved: recorded with what the server holds as its "before", and kept only if the save
   * stores it. Returns the writer's `onOutcome` for it. An undo's or redo's own write-back is no step, but what it stores
   * is the next edit's "before".
   */
  const edit = useCallback((change: SheetCellChange, source?: string) => {
    const replay = source === 'undo' || source === 'redo'
    /* Field stamps (re-review of #611) — a cell refused because its field moved: the server holds the value its mark
       names, read from the cell the grid holds when the ledger asks (`sheetStamps.ts` `movedValueOf`). */
    const serverValue = () => {
      const data = getGridApi()?.getRowNode(change.rowId)?.data as { values?: Record<string, unknown> } | undefined
      return movedValueOf(data?.values?.[change.colId])
    }
    return history.edit(change, unconfirmed(live.current.tracker, change.rowId, change.colId), !replay, serverValue)
  }, [history, getGridApi])

  /**
   * G2 — an edit that never reached the writer and was not stored (dropped while formulas loaded, a refused formula
   * save): no step, but the next edit of the cell takes `before` — what the server holds — as its "before".
   */
  const unsaved = useCallback((change: SheetCellChange) => { history.unsaved(change) }, [history])

  /**
   * P1 — the sheet's own multi-cell writes (Clear on Delete, Set every row…) as ONE undo step and ONE save, exactly like
   * the grid's fill and paste: `run` writes through the grid (`setDataValue`), and the fence closes on the next turn,
   * after AG has reported every change.
   */
  const operation = useCallback((run: () => void) => {
    writer.beginOperation()
    history.begin()
    try {
      run()
    } finally {
      setTimeout(() => { history.end(); writer.endOperation() }, 0)
    }
  }, [writer, history])

  /* The grid's fill / paste / range-delete events open ONE step and ONE save together. AG's own undo is off (it forgets
     everything on each re-read); ⌘Z is handled by `onKeyDown` instead. */
  const gridProps = useMemo(() => ({
    undoRedoCellEditing: false,
    ...operationFence({
      beginOperation: () => { writer.beginOperation(); history.begin() },
      endOperation: () => { history.end(); writer.endOperation() },
    }),
  }), [writer, history])

  return { history, record, edit, unsaved, onKeyDown, gridProps, operation }
}

/** The cell shows an edit the server did not store: refused, or no answer came. */
function unconfirmed(tracker: SheetUndoOptions['tracker'], rowId: string, colId: string): boolean {
  const state = tracker?.get(rowId, colId)?.state
  return state === 'refused' || state === 'unknown'
}
