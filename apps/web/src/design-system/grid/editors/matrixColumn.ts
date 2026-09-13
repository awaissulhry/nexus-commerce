/**
 * MX.G — `matrixColumnDef(kind, opts)`: ONE function that returns the `ColDef` for a Matrix cell
 * kind. The page (`_studio/matrix/columns.tsx`) calls it once per coordinate × kind and nothing
 * else about a Matrix column is decided anywhere else — width, header, renderer, editor,
 * editability, fill rule, setter, classes, tooltip, copy/export text, comparator.
 *
 * `reference_two_column_builders_drift` is why this is a function and not a block a page spreads:
 * the Information sheet's two builders assembled their columns separately once and the channel
 * silently lacked six things master had. The Matrix has ONE builder by construction.
 *
 * ## What each piece reads from
 *
 *   width      `MATRIX_CELL_WIDTHS[kind]`         header   `MATRIX_CELL_LABELS[kind]`
 *   renderer   `MATRIX_CELL_RENDERERS[kind]`      classes  `matrixCellClasses` (+ validation, + round trip)
 *   editable   `matrixCellEditable`               tooltip  `matrixCellTooltip`
 *   text       `matrixCellText`                   compare  `matrixCompare`
 *   fill       `matrixFillAllowed`                value    `matrixCellValue` / `matrixApplyValue`
 *
 * ## The AG facts this file is built around (all measured, all in memory)
 *
 * · `cellRendererParams` and `cellEditorParams` are built ONCE per call and never inline — an
 *   inline literal re-runs the whole column model on every render.
 * · `valueSetter` MUTATES `params.data` and returns `true`, or AG discards the value
 *   (`reference_ag_value_setter_must_mutate_params_data`). The default mutation is
 *   `matrixApplyValue` on the row's own `MatrixCells` object; a host may supply `applyValue`.
 * · The fill handle is REFUSED on `fulfilment`, `listing`, `syncState`, `salePrice`
 *   (`MATRIX_FILLABLE_KINDS`, design §3.1 rule 5) — refused outright, not defended against, because
 *   its double-click swallows the open gesture AND fills the column down
 *   (`reference_ag_fill_handle_swallows_dblclick`).
 * · `fulfilment` is a real select (the DS listbox opens on every open gesture) whose CHOICE is
 *   routed to `onPickFulfilment` by the setter, which then returns `false`: AG fires no
 *   `cellValueChanged`, touches no data, and the `set-fulfilment` preflight is the only consequence.
 *   The select never writes inline — §3.4's rule, kept at the one place a value could enter.
 * · `price` takes the sheet's formula-aware editor when the host wires `formula` (`=` opens the
 *   formula editor, anything else the number editor — #775's `formulaCellEditorSelector`), and the
 *   plain number editor otherwise.
 * · `cellEditorSelector` beats `cellEditor` in AG (measured by VT.2), so the two are never both set
 *   on one kind here.
 */
import type { CellClassParams, ColDef, GetQuickFilterTextParams, ICellRendererParams, ValueFormatterParams, ValueGetterParams, ValueSetterParams } from 'ag-grid-community'

import { MATRIX_CELL_LABELS, MATRIX_CELL_WIDTHS, type FulfilmentMethod, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixCopy } from '../matrix/contract'
import { MATRIX_CELL_RENDERERS, type MatrixCellParams } from '../renderers/MatrixCellViews'
import {
  MATRIX_CELL_CLASSES,
  matrixApplyValue,
  matrixCellClasses,
  matrixCellEditable,
  matrixCellText,
  matrixCellTooltip,
  matrixCellValue,
  matrixCoerceValue,
  matrixCompare,
  matrixFillAllowed,
} from '../renderers/matrixCells'
import { formulaCellEditorSelector, type FormulaWiring } from './FormulaCellEditor'
import { CellSaveTracker, roundTripClassRules } from './roundTrip'
import { SaleCellEditor } from './SaleCellEditor'
import { selectEditor, SELECT_CELL_CLASS } from './SelectCellEditor'
import { sheetClassRules } from './sheet'
import { sheetValidationFor } from './sheetColumn'
import { sameValue } from './writeGate'

export interface MatrixColumnOptions<T> {
  /** `<coordinateKey>.<kind>` — the page's addressing, and what Export and the chips key on. */
  colId: string
  coordinate: MatrixCoordinate
  /** This row's cells for this coordinate, read at paint time. Stable identity required. */
  cells: (data: T | undefined) => MatrixCells | null
  /** The round-trip marks (`saving`/`saved`/`refused`) the sheet already uses. Needs `rowIdOf`. */
  tracker?: CellSaveTracker
  rowIdOf?: (data: T) => string
  onJump?: (params: ICellRendererParams) => void
  onPickFulfilment?: (method: FulfilmentMethod, params: ICellRendererParams) => void
  /**
   * Write the filled/typed value back into `params.data` — AG discards it otherwise. Optional: the
   * default is `matrixApplyValue` on the object `cells(data)` returns, which IS the row's own.
   */
  applyValue?: (data: T, kind: MatrixCellKind, value: unknown) => void
  /** The sheet's formula wiring. When present, `price` opens the formula-aware editor (#775). Needs `rowIdOf`. */
  formula?: FormulaWiring<T>
  /** The copy table; the engine default is Appendix A verbatim. */
  copy?: MatrixCopy
  /** The clock `Sent <ago>` is measured against — injectable so a screenshot compares to itself. */
  now?: () => number
}

/* ── STABLE, module-level editor params — an inline literal re-runs AG's column model ─────── */

/** `numericEditor({ precision: 0 })`'s own values, whole units, no stepper buttons. */
const QTY_EDITOR_PARAMS = Object.freeze({ min: 0, max: undefined, step: 1, precision: 0, showStepperButtons: false })
/** `numericEditor({ precision: 2, step: 0.01 })`'s own values — money. */
const PRICE_EDITOR_PARAMS = Object.freeze({ min: 0, max: undefined, step: 0.01, precision: 2, showStepperButtons: false })
const MODE_OPTIONS = [
  { value: 'FOLLOW', label: 'Follow' },
  { value: 'PINNED', label: 'Pinned' },
] as const

const NUMERIC_KINDS: readonly MatrixCellKind[] = ['syncQty', 'syncBuffer', 'price', 'salePrice']

/** The editor fragment per kind. `fulfilment` is a select the setter intercepts; facts have none. */
function editorFor<T>(kind: MatrixCellKind, opts: MatrixColumnOptions<T>): Partial<ColDef<T>> {
  switch (kind) {
    case 'syncMode':
      return selectEditor([...MODE_OPTIONS]) as Partial<ColDef<T>>
    case 'fulfilment': {
      const vocab = opts.coordinate.vocabulary.fulfilment
      if (!vocab || vocab.length === 0) return {}
      return selectEditor(vocab.map((m) => ({ value: m, label: m }))) as Partial<ColDef<T>>
    }
    case 'syncQty':
    case 'syncBuffer':
      return { cellEditor: 'agNumberCellEditor', cellEditorParams: QTY_EDITOR_PARAMS }
    case 'price': {
      const fallback = { component: 'agNumberCellEditor', params: PRICE_EDITOR_PARAMS }
      if (opts.formula && opts.rowIdOf) {
        return formulaCellEditorSelector<T>(opts.formula, { key: opts.colId, kind: 'number', formulaWritable: true }, fallback, opts.rowIdOf) as Partial<ColDef<T>>
      }
      return { cellEditor: 'agNumberCellEditor', cellEditorParams: PRICE_EDITOR_PARAMS }
    }
    case 'salePrice':
      return {
        cellEditor: SaleCellEditor as never,
        cellEditorPopup: true,
        cellEditorPopupPosition: 'under',
        cellEditorParams: { currency: opts.coordinate.currency },
      }
    case 'listing':
    case 'syncState':
      return {}
  }
}

/** ONE ColDef per kind. */
export function matrixColumnDef<T>(kind: MatrixCellKind, opts: MatrixColumnOptions<T>): ColDef<T> {
  const { colId, coordinate, cells } = opts
  const copy = opts.copy
  const now = opts.now
  const data = (p: { data?: T | null }): T | undefined => (p.data ?? undefined) as T | undefined

  /* STABLE — built once per call, handed to AG as one object. */
  const rendererParams: MatrixCellParams = {
    kind,
    coordinate,
    facts: (p) => cells(p.data as T | undefined),
    onJump: opts.onJump,
    onPickFulfilment: opts.onPickFulfilment,
    copy,
    now,
  }

  const editable = (row: T | undefined) => matrixCellEditable(kind, cells(row)).editable

  /* The validation tint (`nds-cell-is-invalid` / `-warned`) through the engine's ONE gate, with the
     Matrix branch `sheetColumn.ts` grew for these kinds. */
  const validation = sheetValidationFor<T>(
    { kind, requiredBy: [], options: kind === 'fulfilment' ? [...(coordinate.vocabulary.fulfilment ?? [])] : undefined, mode: 'strict' },
    () => true,
  )

  /* The five Matrix classes, each a rule reading the pure function — in THE precedence it decides. */
  const matrixRules: Record<string, (p: CellClassParams<T>) => boolean> = {}
  for (const cls of MATRIX_CELL_CLASSES) {
    matrixRules[cls] = (p) => matrixCellClasses(kind, cells(data(p)), coordinate).includes(cls)
  }
  if (kind === 'fulfilment' || kind === 'syncMode') matrixRules[SELECT_CELL_CLASS] = (p) => editable(data(p))

  /* The round trip, when the host has a tracker. `nds-cell-is-refused` is BOTH the tracker's class
     and the Matrix's own on `syncState` (a failed queue), so the two are OR-ed rather than one
     shadowing the other — the collision `sheetColumn.ts` records from 2026-09-04. */
  const roundTrip = opts.tracker && opts.rowIdOf ? roundTripClassRules<T>(opts.tracker, opts.rowIdOf) : {}
  const trackerRefused = roundTrip['nds-cell-is-refused']
  const matrixRefused = matrixRules['nds-cell-is-refused']!
  const classRules: Record<string, (p: CellClassParams<T>) => boolean> = {
    ...(sheetClassRules<T>(validation) as Record<string, (p: CellClassParams<T>) => boolean>),
    ...matrixRules,
    ...(roundTrip as Record<string, (p: CellClassParams<T>) => boolean>),
    'nds-cell-is-refused': (p) => matrixRefused(p) || (typeof trackerRefused === 'function' ? trackerRefused(p) : false),
  }

  const numeric = NUMERIC_KINDS.includes(kind)
  const text = (row: T | undefined) => matrixCellText(kind, cells(row), coordinate, copy, now?.())

  return {
    colId,
    headerName: MATRIX_CELL_LABELS[kind],
    headerTooltip: `${MATRIX_CELL_LABELS[kind]} — ${coordinate.label}`,
    headerClass: numeric ? 'nds-ag-head-num' : undefined,
    width: MATRIX_CELL_WIDTHS[kind],
    minWidth: MATRIX_CELL_WIDTHS[kind],
    sortable: true,
    resizable: true,
    suppressMovable: true,
    suppressHeaderMenuButton: true,
    /* An object for `salePrice`, a scalar elsewhere — AG must not infer a type and coerce. */
    cellDataType: false,
    /* `nds-cell-is-locked` is a RULE below, never in `cellClass`: a class present in both is added
       and removed in the same paint (VT.2's measured mechanism). */
    cellClass: (p) => ['nds-ag-cell', numeric ? 'nds-ag-num' : '', editable(data(p)) ? 'nds-cell-is-editable' : ''].filter(Boolean).join(' '),
    cellClassRules: classRules,
    cellRenderer: MATRIX_CELL_RENDERERS[kind],
    cellRendererParams: rendererParams,
    ...editorFor(kind, opts),
    editable: (p) => editable(data(p)),
    suppressFillHandle: !matrixFillAllowed(kind),
    valueGetter: (p: ValueGetterParams<T>) => matrixCellValue(kind, cells(data(p))),
    /* 🔴 MUTATE `params.data`, or AG discards the value. `fulfilment` is the one kind whose setter
       never mutates: the choice opens the preflight and `false` keeps AG silent. */
    valueSetter: (p: ValueSetterParams<T>) => {
      if (!p.data) return false
      if (kind === 'fulfilment') {
        const method = matrixCoerceValue('fulfilment', p.newValue) as FulfilmentMethod | undefined
        if (method && opts.onPickFulfilment) opts.onPickFulfilment(method, p as unknown as ICellRendererParams)
        return false
      }
      if (opts.applyValue) {
        if (matrixCoerceValue(kind, p.newValue) === undefined) return false
        opts.applyValue(p.data, kind, p.newValue)
        return true
      }
      return matrixApplyValue(cells(p.data), kind, p.newValue)
    },
    /* Structural equality: the sale compound is an object, and an unchanged edit must send nothing. */
    equals: (a: unknown, b: unknown) => sameValue(a, b),
    /* Copy, export, the text filter and the quick filter all read the ONE text. */
    valueFormatter: (p: ValueFormatterParams<T>) => text(data(p)),
    filterValueGetter: (p: ValueGetterParams<T>) => text(data(p)),
    getQuickFilterText: (p: GetQuickFilterTextParams<T>) => text(data(p)),
    tooltipValueGetter: (p) => matrixCellTooltip(kind, cells(data(p)), coordinate, copy, now?.()) ?? undefined,
    comparator: (a: unknown, b: unknown) => matrixCompare(kind, a, b),
  } as ColDef<T>
}
