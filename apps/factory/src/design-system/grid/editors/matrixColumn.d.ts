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
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { type FulfilmentMethod, type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixCopy } from '../matrix/contract';
import { type FormulaWiring } from './FormulaCellEditor';
import { CellSaveTracker } from './roundTrip';
export interface MatrixColumnOptions<T> {
    /** `<coordinateKey>.<kind>` — the page's addressing, and what Export and the chips key on. */
    colId: string;
    coordinate: MatrixCoordinate;
    /** This row's cells for this coordinate, read at paint time. Stable identity required. */
    cells: (data: T | undefined) => MatrixCells | null;
    /** The round-trip marks (`saving`/`saved`/`refused`) the sheet already uses. Needs `rowIdOf`. */
    tracker?: CellSaveTracker;
    rowIdOf?: (data: T) => string;
    onJump?: (params: ICellRendererParams) => void;
    onPickFulfilment?: (method: FulfilmentMethod, params: ICellRendererParams) => void;
    /**
     * Write the filled/typed value back into `params.data` — AG discards it otherwise. Optional: the
     * default is `matrixApplyValue` on the object `cells(data)` returns, which IS the row's own.
     */
    applyValue?: (data: T, kind: MatrixCellKind, value: unknown) => void;
    /** The sheet's formula wiring. When present, `price` opens the formula-aware editor (#775). Needs `rowIdOf`. */
    formula?: FormulaWiring<T>;
    /** The copy table; the engine default is Appendix A verbatim. */
    copy?: MatrixCopy;
    /** The clock `Sent <ago>` is measured against — injectable so a screenshot compares to itself. */
    now?: () => number;
}
/** ONE ColDef per kind. */
export declare function matrixColumnDef<T>(kind: MatrixCellKind, opts: MatrixColumnOptions<T>): ColDef<T>;
