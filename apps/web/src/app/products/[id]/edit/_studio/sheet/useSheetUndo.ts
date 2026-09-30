import { useCallback, useMemo } from 'react'
import type { GridApi, IRowNode, SheetWriter } from '@/design-system/grid'

import { operationFence } from './bulkOperation'
import { wholeListWriteField } from './channel/provenance'
import { SheetUndoHistory, undoShortcut, withPriorProvenance, type ApplyCellValues, type CellWriteBack, type SheetCellChange } from './sheetUndo'

type CellRow = { values?: Record<string, unknown> }
const listField = (writeField: string) => !!wholeListWriteField(writeField)

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
      for (const change of values) {
        const node = api.getRowNode(change.rowId)
        if (!node) continue
        if (change.reset) resetCell(api, node, change as Required<Pick<CellWriteBack, 'reset'>> & CellWriteBack)
        else node.setDataValue(change.colId, change.value, direction)
      }
    } finally {
      setTimeout(() => writer.endOperation(), 0)
    }
  }, [writer, getGridApi])

  /* A5/A8 — back to the inherited value: the cell as it was painted at once when the history kept it (the read after the
     save settles it either way), and a reset through the writer — the same intent the cell menu's reset sends. */
  const resetCell = (api: GridApi<Row>, node: IRowNode<Row>, change: CellWriteBack & Required<Pick<CellWriteBack, 'reset'>>) => {
    const row = node.data as (Row & CellRow) | undefined
    if (!row) return
    if (change.reset.cell && row.values) {
      row.values = { ...row.values, [change.colId]: change.reset.cell }
      api.refreshCells({ rowNodes: [node], columns: [change.colId], force: true })
    }
    if (!change.reset.covered) writer.set(change.rowId, change.colId, null, { row, intent: change.reset.intent })
  }

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
    // A05 — the cell's value setter remembered the cell it replaced: an inherited one makes this step's undo a reset.
    const current = (getGridApi()?.getRowNode(change.rowId)?.data as CellRow | undefined)?.values?.[change.colId]
    history.record(withPriorProvenance(change, current, listField))
  }, [history, getGridApi])

  /**
   * P1 — the sheet's own multi-cell writes (Clear on Delete, Set every row…) as ONE undo step and ONE save, exactly like
   * the grid's fill and paste: `run` writes through the grid (`setDataValue`), and the fence closes on the next turn,
   * after AG has reported every change. `run` records what the grid does not report itself (A08: a reset writes through
   * the writer, not the grid).
   */
  const operation = useCallback((run: (recordChange: (change: SheetCellChange) => void) => void) => {
    writer.beginOperation()
    history.begin()
    try {
      run(change => history.record(change))
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

  return { history, record, onKeyDown, gridProps, operation }
}
