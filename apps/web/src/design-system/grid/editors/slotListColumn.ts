/**
 * Step 4.3 #3 (A-52; R-55, R-56) — the ONE cell over a slot group, as ONE ColDef from the engine, returned whole by BOTH
 * sheet builders (`reference_two_column_builders_drift`: two builders that each assemble a column drift apart).
 *
 * It is a VIEW: the value is the positions read from the slot cells, and an edit writes the CHANGED positions back into
 * those slot cells through each slot column's own setter (so a position edited here is exactly a slot typed there — the
 * same provenance, the same write). The column itself is never a write field; the sheet's change handler turns the one
 * cell's change into one slot write per changed position.
 *
 * Shaped like VT.2's `variationThemeColumnDef` for the same reasons, each learned on a sheet:
 *   · `cellEditorSelector: undefined` — a selector beats `cellEditor`; the channel builder gives every column one.
 *     Formulas stay on the slots (`=` opens this same editor; there is nothing for a formula to produce here).
 *   · `suppressFillHandle` — the fill handle swallows the open gesture and would write ten slots onto every row below.
 *   · no `valueParser`, and a setter that refuses anything but a positions array: pasted text and Delete write nothing
 *     (Delete on the one cell never clears ten bullets).
 *   · the setter MUTATES `params.data` — AG re-reads the getter the moment it returns.
 *   · `equals` is the write gate's structural comparison — an untouched edit sends nothing.
 */
import type { ColDef, ValueFormatterParams, ValueGetterParams, ValueSetterParams } from 'ag-grid-community'

import type { CellProvenance } from '../renderers/provenance'
import type { CellSaveTracker } from './roundTrip'
import { SlotListEditor, SlotListValue, slotListSaveState, slotListSummary, type SlotCellLike, type SlotListEditorParams } from './SlotListEditor'
import { slotListChanges, slotListKey, slotListText, slotListValue, suppressSlotListKeys, type SlotGroup } from './slotList'
import { sameValue } from './writeGate'

export interface SlotListColumnOptions<T> {
  /** The header — the list's own name (`Bullet points`). */
  label: string
  /** One position's name (`Bullet`). */
  itemLabel?: string
  width?: number
  headerTooltip?: string
  /** A slot cell of a row, as the builder reads it. */
  cellOf: (row: T, key: string) => SlotCellLike | null | undefined
  /** Write ONE slot exactly as that slot's own column writes it — the builder passes the slot column's own setter. MUTATES the row. */
  setSlot: (row: T, key: string, value: string | null) => boolean
  rowIdOf: (row: T) => string
  tracker?: CellSaveTracker
  /** One slot's provenance, from the builder's own classifier. */
  provenanceOf?: (row: T, key: string) => CellProvenance
  /** Is the list required on this row (the requirement lives on position 1)? */
  required?: (row: T) => boolean
}

/** Every slot cell present, editable and writable — one locked position locks the one cell (its reason is said on open). */
export function slotListEditable<T>(row: T | undefined, group: SlotGroup, cellOf: SlotListColumnOptions<T>['cellOf']): boolean {
  if (!row) return false
  return group.keys.every((k) => {
    const cell = cellOf(row, k)
    return !!cell && cell.editable !== false && cell.writable !== false
  })
}

export function slotListColumnDef<T>(group: SlotGroup, options: SlotListColumnOptions<T>): ColDef<T> {
  const colId = slotListKey(group.of, group.locale)
  const valueOf = (row: T | undefined): string[] | null => (row ? slotListValue(group.keys.map((k) => options.cellOf(row, k)?.value), group.max) : null)
  const editable = (row: T | undefined) => slotListEditable(row, group, options.cellOf)
  /* ONE params object per column: its identity is part of the ColDef, and churn re-runs AG's column model. */
  const editorParams: Pick<SlotListEditorParams, 'slotList'> = {
    slotList: { mode: 'slots', max: group.max, maxLength: group.maxLength ?? null, itemLabel: options.itemLabel ?? 'Bullet', label: options.label },
  }
  const saveState = (p: { data?: T }) => (p.data ? slotListSaveState(options.tracker, options.rowIdOf(p.data), group.keys).state : null)
  return {
    colId,
    headerName: options.label,
    headerTooltip: options.headerTooltip ?? `${options.label} — all ${group.max} positions in one cell. Each position is also a column in Customise.`,
    width: options.width ?? 240,
    cellDataType: false,
    sortable: false,
    cellClass: (p) => `nds-ag-cell ${editable(p.data ?? undefined) ? 'nds-cell-is-editable' : 'nds-cell-is-locked'}`,
    /* The positions' round-trip states, read together: the worst one is this cell's. */
    cellClassRules: {
      'nds-cell-is-saving': (p) => saveState(p) === 'saving',
      'nds-cell-is-saved': (p) => saveState(p) === 'saved',
      'nds-cell-is-refused': (p) => saveState(p) === 'refused',
      'nds-cell-is-waiting': (p) => saveState(p) === 'waiting',
      'nds-cell-is-unknown': (p) => saveState(p) === 'unknown',
    },
    valueGetter: (p: ValueGetterParams<T>) => valueOf(p.data ?? undefined),
    valueFormatter: (p: ValueFormatterParams<T>) => slotListText(p.value),
    filterValueGetter: (p: ValueGetterParams<T>) => slotListText(valueOf(p.data ?? undefined)),
    equals: (a: unknown, b: unknown) => sameValue(a, b),
    valueSetter: (p: ValueSetterParams<T>) => {
      if (!p.data || !Array.isArray(p.newValue)) return false
      const changes = slotListChanges(valueOf(p.data), p.newValue, group.max)
      let changed = false
      for (const c of changes) changed = options.setSlot(p.data, group.keys[c.position - 1], c.value) || changed
      return changed
    },
    editable: (p) => editable(p.data ?? undefined),
    cellEditor: SlotListEditor,
    cellEditorPopup: true,
    cellEditorParams: editorParams,
    cellEditorSelector: undefined,
    suppressKeyboardEvent: suppressSlotListKeys as ColDef<T>['suppressKeyboardEvent'],
    suppressFillHandle: true,
    cellRenderer: SlotListValue,
    cellRendererParams: { group, cellOf: options.cellOf, rowIdOf: options.rowIdOf, tracker: options.tracker, provenanceOf: options.provenanceOf, required: options.required },
    tooltipValueGetter: (p) => {
      const values = valueOf(p.data ?? undefined)
      if (!values || !p.data) return ''
      const summary = slotListSummary(values, group.max)
      const refused = slotListSaveState(options.tracker, options.rowIdOf(p.data), group.keys).reasons
      return [...refused, `${options.label}: ${summary.filled} of ${group.max}`, slotListText(values)].filter(Boolean).join('\n')
    },
  }
}
