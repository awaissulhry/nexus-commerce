/**
 * G5 (2026-10-13) — a formula edit is a step of the sheet's ⌘Z like any other edit (`sheetUndo.ts`): recorded when it is
 * sent, kept only if it is stored — a refused, unanswered or discarded formula write leaves the history, the rule #607
 * gave every other cell.
 *
 * Before, the formula branch of both sheets returned before the history heard of it: ⌘Z skipped the formula and undid an
 * older, unrelated step, and after a paste over formula cells ⌘Z left the pasted values and the formulas were gone.
 *
 * The history holds a cell that holds a formula as its expression (`=…`). A replay of it goes back through the grid,
 * where the formula road (`isFormulaDraft`) saves that formula again; a replay of a plain value onto a cell that holds a
 * formula replaces the formula with that value (`useCellFormulas().replace`). So undo puts back exactly the formula or
 * the value the cell held. A cell that inherited before the formula is put back by its reset (`stateBefore`), after the
 * formula is removed (the scopes' `resetCellBack`).
 */
import { exprOf, isFormulaDraft, type SheetCellOutcome } from '@/design-system/grid'

import type { FormulaWriteResult } from '../formulaWrites'
import type { SheetCellChange } from './sheetUndo'

/** How the history holds a formula: as it is typed, so its replay takes the formula road. */
export const formulaHistoryValue = (expr: string): string => `=${expr}`

/**
 * A formula write's result as the history hears it. A formula stored without a value (it did not evaluate: `=$typo`)
 * is STORED — the server holds it and the sheet shows it — so it stays a step, while its cell says refused.
 */
export function formulaWriteOutcome(result: FormulaWriteResult): SheetCellOutcome {
  return result.dropped ? 'dropped' : result.ok || result.stored ? 'saved' : 'refused'
}

/** The part of `useCellFormulas()` a formula edit is sent through. */
export interface FormulaEditSender {
  exprFor: (rowId: string, colId: string) => string | null
  save: (rowId: string, colId: string, expr: string) => Promise<FormulaWriteResult>
  replace: (rowId: string, colId: string, value: unknown) => Promise<FormulaWriteResult>
}

/** The sheet's history for one edit (`useSheetUndo().edit`): records it and returns the handler its save's outcome goes to. */
export type RecordSheetEdit = (change: SheetCellChange, source?: string) => (outcome: SheetCellOutcome) => void

export interface FormulaEdit {
  rowId: string
  colId: string
  /** The edit's new value: a typed `=…` saves that formula; anything else replaces the cell's formula with the value. */
  value: unknown
  /** The cell's "before" when it holds no formula — what the scope records for any edit (`stateBefore`). */
  before: unknown
  /** AG's source: an undo's or redo's own write-back is no step (`useSheetUndo().edit`). */
  source?: string
}

/**
 * Send one formula edit — a formula typed (`save`) or a value over a cell's formula (`replace`) — and record it in the
 * sheet's history: before = the formula the cell held (`=…`) or `before`; after = the value as typed (a typed `=…` is
 * the formula; on a refusal the cell shows exactly it). The history keeps it only when the write reports it stored.
 */
export function sendFormulaEdit(edit: FormulaEdit, formulas: FormulaEditSender, record: RecordSheetEdit): Promise<FormulaWriteResult> {
  const { rowId, colId, value } = edit
  const typed = typeof value === 'string' && isFormulaDraft(value) ? exprOf(value) : null
  const held = formulas.exprFor(rowId, colId)
  const onOutcome = typed !== null || held
    ? record({ rowId, colId, before: held ? formulaHistoryValue(held) : edit.before, after: value }, edit.source)
    : () => undefined
  const write = typed !== null ? formulas.save(rowId, colId, typed) : formulas.replace(rowId, colId, value)
  return write.then((result) => { onOutcome(formulaWriteOutcome(result)); return result },
    (error: unknown) => { onOutcome('unknown'); throw error })
}
