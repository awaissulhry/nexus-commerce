/**
 * Base price on the Matrix — the Shared column's save line (2026-10-13, one save line for every grid).
 *
 * Every edit of the column (typed, pasted, filled, ⌘Z's own write-back, the bulk Edit's rows) goes to the master writer,
 * and its ⌘Z step is the sheet's ledger step (`SheetUndoHistory.edit`, the Information page's own road): recorded as the
 * edit is handed to the writer, kept only when the save stores it — a row the server refused or never answered leaves the
 * history, as a refused Matrix cell does (`forgetUnsaved`).
 *
 * The bulk Edit's rows are NO ⌘Z step: the bulk Edit's own Undo (its receipt, then its toast) is their one way back. A
 * toast Undo that took a ⌘Z step of its own made ⌘Z re-apply the bulk change afterwards. A bulk row waits here for its
 * save's answer, so the dialog says what the server did, never what was asked.
 */
import type { SheetCellOutcome } from '@/design-system/grid'

import type { SheetCellChange } from '../sheet/sheetUndo'

/** The source the bulk Edit writes the grid with (`setDataValue`): its rows are saved, never a ⌘Z step. */
export const BULK_EDIT_SOURCE = 'bulk-edit'

/** A bulk row's answer: its save's outcome, or `unchanged` (the grid already held the value: nothing to save). */
export type BaseRowAnswer = SheetCellOutcome | 'unchanged'

export interface BaseLineDeps<Row> {
  /** The page's ⌘Z history (`SheetUndoHistory.edit`). */
  history: { edit: (change: SheetCellChange, unconfirmed: boolean, step?: boolean) => (outcome: SheetCellOutcome) => void }
  /** The master writer (`SheetWriter.set`). */
  writer: { set: (rowId: string, colId: string, value: unknown, opts: { row?: Row; onOutcome?: (outcome: SheetCellOutcome) => void }) => void }
  /** The cell shows an edit the server did not store (refused, or no answer): its "before" is what the server holds. */
  unconfirmed: (rowId: string, colId: string) => boolean
}

export interface BaseLine<Row> {
  /** An edit of the column reached the page (AG's `cellValueChanged`): saved, its ⌘Z step kept only if the save stores it. */
  changed: (e: { rowId: string; colId: string; before: unknown; after: unknown; source?: string; row?: Row }) => void
  /** A bulk row about to be written: resolves with its save's answer. */
  awaitRow: (rowId: string) => Promise<BaseRowAnswer>
  /** These bulk rows reached no save (the grid reported no change for them): they answer `unchanged`. */
  settleUnchanged: (rowIds: Iterable<string>) => void
}

export function createBaseLine<Row>(deps: BaseLineDeps<Row>): BaseLine<Row> {
  const waiting = new Map<string, (answer: BaseRowAnswer) => void>()
  return {
    changed(e) {
      const bulk = e.source === BULK_EDIT_SOURCE
      const replay = e.source === 'undo' || e.source === 'redo'
      // The ledger hears every save (what the server holds is the next edit's "before"); only an operator's edit is a step.
      const kept = deps.history.edit({ rowId: e.rowId, colId: e.colId, before: e.before, after: e.after }, deps.unconfirmed(e.rowId, e.colId), !bulk && !replay)
      const answer = bulk ? waiting.get(e.rowId) : undefined
      if (answer) waiting.delete(e.rowId)
      deps.writer.set(e.rowId, e.colId, e.after, { row: e.row, onOutcome: (outcome) => { kept(outcome); answer?.(outcome) } })
    },
    awaitRow(rowId) {
      return new Promise((resolve) => { waiting.set(rowId, resolve) })
    },
    settleUnchanged(rowIds) {
      for (const id of rowIds) {
        const answer = waiting.get(id)
        if (!answer) continue
        waiting.delete(id)
        answer('unchanged')
      }
    },
  }
}

/** A bulk row's answer in the dialog's words: saved, or why not (`reasonOf` = the cell's refusal mark, when it has one). */
export function baseRowResult(rowId: string, answer: BaseRowAnswer | undefined, reasonOf: (rowId: string) => string | undefined): { rowId: string; ok: boolean; reason?: string } {
  if (answer === 'saved' || answer === 'unchanged') return { rowId, ok: true }
  const reason = reasonOf(rowId)
    ?? (answer === 'unknown' ? 'No answer came — refresh to see whether it saved' : answer === 'dropped' ? 'A later edit of this cell replaced it' : 'Not saved')
  return { rowId, ok: false, reason }
}
