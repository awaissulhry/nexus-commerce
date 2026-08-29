/**
 * GDS — column presets: `ColDef` fragments a page spreads into its own registry.
 *
 *   { colId: 'price', headerName: 'Price', ...moneyColumn('basePrice') }
 *
 * Each one pairs a renderer from `../renderers` with the AG options that renderer needs (alignment,
 * tabular figures, sortability, the pinned-right lock for actions). A page still owns its column
 * ids, labels and widths — those are the page's; the CELL is the design system's.
 */
import type { ColDef, IRowNode, RowSelectionOptions } from 'ag-grid-community'

import { gridGeometry } from '../../tokens/grid'
import { numericColumn } from '../NexusGrid'
import {
  ActionsCell,
  BadgeCell,
  DateCell,
  LockedCell,
  NumericCell,
  StockCell,
  type ActionsCellParams,
  type BadgeCellParams,
  type DateCellParams,
  type LockedCellParams,
  type NumericCellParams,
  type StockCellParams,
} from '../renderers/cells'
import type { FormatOptions } from '../renderers/format'

/* ── selection ────────────────────────────────────────────────────────────────────────────── */

export interface GridSelectionOptions<T = unknown> {
  /** Under SSRM `currentPage` is the honest reach (the bulk endpoints are capped). Default `currentPage`. */
  selectAll?: 'all' | 'filtered' | 'currentPage'
  /** Group rows, footers and pinned rows are not selectable — say which. */
  isRowSelectable?: (node: IRowNode<T>) => boolean
}

/** The ONE selection contract: checkboxes, header select-all, no click-to-select, hidden disabled boxes. */
export function gridSelection<T = unknown>(opts: GridSelectionOptions<T> = {}): RowSelectionOptions<T> {
  return {
    mode: 'multiRow',
    checkboxes: true,
    headerCheckbox: true,
    enableClickSelection: false,
    selectAll: opts.selectAll ?? 'currentPage',
    isRowSelectable: opts.isRowSelectable ?? ((n) => !n.rowPinned),
    hideDisabledCheckboxes: true,
  }
}

/** The 43px checkbox column, unresizable. `NexusGrid` already merges this; spread it to override. */
export const selectionColumn = {
  width: gridGeometry.selectColW,
  maxWidth: gridGeometry.selectColW,
  resizable: false,
} as const

/**
 * A field is a path into T (`'sales.units'`). AG types it as a recursive template literal that
 * TypeScript cannot instantiate through a generic preset (TS2589), so the preset takes the string
 * and casts once, here. The page's `value`/`groupValue` closures are where the row type is checked.
 */
type Field<T> = string & { __row?: T }
const fieldOf = <T,>(field: Field<T>) => field as unknown as ColDef<T>['field']

/* ── numbers ──────────────────────────────────────────────────────────────────────────────── */

const numeric = <T,>(field: Field<T>, params: NumericCellParams): ColDef<T> => ({
  field: fieldOf<T>(field),
  ...numericColumn,
  cellRenderer: NumericCell,
  cellRendererParams: params,
})

export const integerColumn = <T,>(field: Field<T>, opts: FormatOptions & Pick<NumericCellParams, 'zeroTitle' | 'muted'> = {}): ColDef<T> =>
  numeric(field, { kind: 'integer', ...opts })

/** CENTS in, `€1,234` out. `decimals: true` for `€1,234.56`. */
export const moneyColumn = <T,>(field: Field<T>, opts: FormatOptions & Pick<NumericCellParams, 'zeroTitle' | 'muted'> & { decimals?: boolean } = {}): ColDef<T> => {
  const { decimals, ...rest } = opts
  return numeric(field, { kind: decimals ? 'money2' : 'money', ...rest })
}

/** A FRACTION in (0.153), `15.3%` out. */
export const percentColumn = <T,>(field: Field<T>, opts: FormatOptions & Pick<NumericCellParams, 'zeroTitle' | 'muted'> = {}): ColDef<T> =>
  numeric(field, { kind: 'percent', ...opts })

/** EUROS in (a decimal), `€1,234.56` out — the catalogue's `basePrice`. */
export const euroColumn = <T,>(field: Field<T>, opts: FormatOptions & Pick<NumericCellParams, 'zeroTitle' | 'muted'> = {}): ColDef<T> =>
  numeric(field, { kind: 'eur', ...opts })

export const deltaColumn = <T,>(field: Field<T>, opts: FormatOptions = {}): ColDef<T> => numeric(field, { kind: 'delta', ...opts })

/* ── dates, status, text ──────────────────────────────────────────────────────────────────── */

export const dateColumn = <T,>(field: Field<T>, opts: DateCellParams = {}): ColDef<T> => ({
  field: fieldOf<T>(field),
  cellClass: 'nds-ag-cell',
  cellRenderer: DateCell,
  cellRendererParams: opts,
})

export const statusColumn = <T,>(field: Field<T>, params: BadgeCellParams): ColDef<T> => ({
  field: fieldOf<T>(field),
  cellClass: 'nds-ag-cell',
  cellRenderer: BadgeCell,
  cellRendererParams: params,
})

export const textColumn = <T,>(field: Field<T>): ColDef<T> => ({
  field: fieldOf<T>(field),
  cellClass: 'nds-ag-cell',
})

export const stockColumn = <T,>(field: Field<T>, params: StockCellParams = {}): ColDef<T> => ({
  field: fieldOf<T>(field),
  ...numericColumn,
  cellRenderer: StockCell,
  cellRendererParams: params,
})

/* ── locked ───────────────────────────────────────────────────────────────────────────────── */

/**
 * A column the operator cannot edit OR move: the FBA quantity, a synced price. The lock is on the
 * column DEFINITION (decision 10), never in a renderer that could be swapped.
 */
export const lockedColumn = <T,>(field: Field<T>, params: LockedCellParams = {}): ColDef<T> => ({
  field: fieldOf<T>(field),
  editable: false,
  suppressMovable: true,
  ...(params.kind && params.kind !== 'text' && params.kind !== 'date' ? numericColumn : { cellClass: 'nds-ag-cell' }),
  cellRenderer: LockedCell,
  cellRendererParams: params,
})

/** Hold a column at its end: cannot be hidden, moved, or (when `pinned`) unpinned. */
export const holdColumn = <T,>(col: ColDef<T>, end: 'left' | 'right', pinned = false): ColDef<T> => ({
  ...col,
  lockVisible: true,
  suppressMovable: true,
  lockPosition: end,
  ...(pinned ? { pinned: end, lockPinned: true } : {}),
})

/* ── actions ──────────────────────────────────────────────────────────────────────────────── */

export interface ActionsColumnOptions<T> extends ActionsCellParams<T> {
  width?: number
  /** Pin to the right edge so the verbs stay reachable however wide the metric set gets. */
  pinned?: boolean
  /** Shown in the Customise dialog; the header itself is blank. */
  prefsLabel?: string
}

export const actionsColumn = <T,>({ width = 120, pinned = false, prefsLabel: _prefsLabel, ...params }: ActionsColumnOptions<T>): ColDef<T> =>
  holdColumn<T>(
    {
      colId: 'actions',
      headerName: '',
      width,
      sortable: false,
      resizable: false,
      suppressHeaderMenuButton: true,
      cellClass: 'nds-ag-cell',
      cellRenderer: ActionsCell,
      cellRendererParams: params,
    },
    'right',
    pinned,
  )
