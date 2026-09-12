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
  /** Overrides the shape-derived default (56 for a `⋯`-only column, 120 with a `primary` button). */
  width?: number
  /**
   * Freeze at the right edge. **Defaults to `true`** — see `actionsColumn` for why the old `false`
   * default was a bug that only appeared on wide grids.
   */
  pinned?: boolean
  /** Shown in the Customise dialog; the header itself is blank. */
  prefsLabel?: string
}

/**
 * The `⋯` column, frozen right by default.
 *
 * 🔴 It used to default to `pinned = false`, which is harmless on a 12-column grid and a BUG on a
 * 100-column one: unpinned only sets `lockPosition: 'right'`, so the column is last in the order and
 * scrolls off the end. PES.3 measured it shipping **invisible** on the channel sheet — present in
 * the column model, absent from the rendered col-id set, with an empty pinned-right container. A
 * verb an operator must scroll a hundred columns to reach is not offered.
 *
 * The default flipped rather than being documented louder, because the asymmetry is one-sided: on a
 * narrow grid pinning changes nothing an operator can perceive (there is no horizontal scroll to be
 * frozen against), while on a wide one it is the difference between a working control and an
 * invisible one. A default should be wrong in the cheap direction, and this one was wrong in the
 * expensive direction. `pinned: false` is still available for a grid that genuinely wants it to
 * scroll away (ruling #146).
 */
export const actionsColumn = <T,>({ width, pinned = true, prefsLabel: _prefsLabel, ...params }: ActionsColumnOptions<T>): ColDef<T> =>
  holdColumn<T>(
    {
      colId: 'actions',
      headerName: '',
      /**
       * 🔴 THE WIDTH FOLLOWS THE SHAPE (#690, hub-ruled 2026-09-02). It was a flat 120.
       *
       * 120 is right for the shape this column was written for — an "Edit" button beside the ⋯ —
       * and wrong for the one that only takes `items`. Measured on screen (Amazon·IT sheet, 1440):
       * a `⋯`-only cell renders ONE `.nds-btn.sm.icon` at **28px** inside 9px/9px cell padding, in
       * a **120px** column: **74px of empty pinned column on every row**, on the scope that had the
       * least width to spare (it cost that sheet a required column at 1440).
       *
       * 56 = 28 + 2 × `--nds-grid-cell-pad-x` (14). Derived, not chosen by eye, and it is a DEFAULT
       * — a caller that wants another number still passes `width`.
       *
       * Call sites enumerated before this changed rather than after: four outside the DS, and only
       * the `items`-only one moves (grid-lab :145/:413 and `products/next/columns.tsx:252` all pass
       * `primary`, so they keep 120). ⚠ No node test guards this: `presets.ts` imports
       * `renderers/cells.tsx`, and `apps/web`'s vitest is node-only, so a test file here dies at
       * PARSE. The evidence is the screen pair and that enumeration — stated so nobody reads the
       * green suite as covering it.
       */
      width: width ?? (params.primary ? 120 : 56),
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
