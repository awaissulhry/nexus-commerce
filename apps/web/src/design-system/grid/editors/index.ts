/**
 * GDS — editors. AG's own number editor, configured once; a DS Listbox as a select editor; and
 * the per-cell server round-trip state the ads bid/budget cells need.
 */
import type { ColDef } from 'ag-grid-community'

export interface NumericEditorOptions {
  min?: number
  max?: number
  step?: number
  /** Decimal places; `0` for whole units (stock), `2` for money. */
  precision?: number
}

/**
 * AG's number editor, the way the inventory editor configured it: no stepper buttons (they are
 * 16px targets nobody hits), whole units by default, a floor at zero.
 */
export const numericEditor = (opts: NumericEditorOptions = {}): Pick<ColDef, 'editable' | 'cellEditor' | 'cellEditorParams'> => ({
  editable: true,
  cellEditor: 'agNumberCellEditor',
  cellEditorParams: { min: opts.min ?? 0, max: opts.max, step: opts.step ?? 1, precision: opts.precision ?? 0, showStepperButtons: false },
})

export const textEditor = (): Pick<ColDef, 'editable' | 'cellEditor'> => ({ editable: true, cellEditor: 'agTextCellEditor' })

export { SelectCellEditor, selectEditor, type SelectEditorParams } from './SelectCellEditor'
export { CellSaveTracker, roundTripClassRules, saveCell, SAVED_FADE_MS, type CellSaveState, type CellSaveEntry, type SaveOutcome } from './roundTrip'
