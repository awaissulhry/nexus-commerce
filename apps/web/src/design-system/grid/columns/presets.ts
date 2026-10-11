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
import { ChangeCell, type ChangeCellParams } from '../renderers/ChangeCell'
import { asChangeValueData, changeSummaryText, changeTooltipText } from '../renderers/changeValue'
import { actionsColumnWidth, isMultiVerb } from '../renderers/rowVerbs'
import { rendererOwnsKeyboard } from '../rendererKeyboard'
import { SwitchCell, SWITCH_WORDS, suppressSwitchKeys, switchWord, type SwitchCellParams, type SwitchWords } from '../renderers/SwitchCell'
import { ModeCell, modeHandlerOf, type ModeCellParams } from '../renderers/ModeCell'
import {
  MODE_STEPS, compareModes, modeOptions, modeWord, readMode, suppressModeKeys,
  type ModeCellValue, type ModeStep,
} from '../renderers/modeModel'
import { SelectPanelEditor } from '../editors/SelectPanelEditor'
import { EntityLinksCell, entityRefsOf, type EntityLinksCellParams } from '../renderers/EntityLinksCell'
import { entityLinksKeys } from '../renderers/entityLinksKeys'
import { compareEntityLinks, entityLinksText } from '../../components/entityLinksModel'

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

/**
 * Before → after (gap G1, 2026-10-05): the cell value is `ChangeLine[]` or `{ changes, more }` — a `valueGetter`
 * builds it from the row. One line per row with "+N more"; the full list is the column's tooltip, and the CSV, the
 * clipboard and the quick filter read the same words (`changeValue.ts`). Not sortable: a list of changes has no order.
 */
export const changeColumn = <T,>(field: Field<T>, params: ChangeCellParams = {}): ColDef<T> => ({
  field: fieldOf<T>(field),
  cellClass: 'nds-ag-cell',
  cellRenderer: ChangeCell,
  cellRendererParams: params,
  sortable: false,
  valueFormatter: (p) => changeSummaryText(asChangeValueData(p.value)),
  tooltipValueGetter: (p) => changeTooltipText(asChangeValueData(p.value)) || undefined,
  getQuickFilterText: (p) => changeSummaryText(asChangeValueData(p.value)),
})

export const stockColumn = <T,>(field: Field<T>, params: StockCellParams = {}): ColDef<T> => ({
  field: fieldOf<T>(field),
  ...numericColumn,
  cellRenderer: StockCell,
  cellRendererParams: params,
})

/* ── switch ───────────────────────────────────────────────────────────────────────────────── */

export interface SwitchColumnOptions<T> {
  /** "Brain", "Locked", "Protect", "May change it". */
  header: string
  /** Accessible name of each row's switch: "Keep JACKET-A under the brain". */
  label(row: T): string
  /** Default "On" / "Off". */
  words?: SwitchWords
  /** Shown as title and aria-description; null = the switch may move. */
  disabledReason?(row: T): string | null
  /** The "Not saved" tag while the page's draft holds a change for this row. */
  pending?(row: T): boolean
}

/**
 * An on/off column (ads brain page D2, 2026-10-10). The value is the row's boolean at `field`; a flip goes to the grid's
 * `context.current.onSwitch(row, next, field)` and changes a DRAFT — never the server (the page's `EditModeBar` saves).
 * Space and Enter on a focused switch cell flip it instead of selecting the row (`suppressKeyboardEvent`) — in a grid whose
 * cells take focus (`suppressCellFocus={false}`; NexusGrid's default focuses rows only). A held switch keeps its focus
 * and says why. It sorts Off before On, and the CSV, the clipboard, the quick filter and the column filter read the same
 * words.
 */
export const switchColumn = <T,>(field: Field<T>, opts: SwitchColumnOptions<T>): ColDef<T> => {
  const words = opts.words ?? SWITCH_WORDS
  const params: SwitchCellParams<T> = {
    field,
    label: (row) => opts.label(row),
    words,
    disabledReason: opts.disabledReason ? (row) => opts.disabledReason!(row) : undefined,
    pending: opts.pending ? (row) => opts.pending!(row) : undefined,
  }
  return {
    field: fieldOf<T>(field),
    headerName: opts.header,
    editable: false,
    cellClass: 'nds-ag-cell',
    cellRenderer: SwitchCell,
    cellRendererParams: params,
    valueFormatter: (p) => switchWord(p.value, words),
    filterValueGetter: (p) => switchWord(p.getValue(field), words),
    getQuickFilterText: (p) => switchWord(p.value, words),
    comparator: (a, b) => Number(a === true) - Number(b === true),
    suppressKeyboardEvent: suppressSwitchKeys,
  }
}

/* ── entity links ─────────────────────────────────────────────────────────────────────────── */

export interface EntityLinksColumnOptions<T> extends EntityLinksCellParams<T> {
  header: string
}

/**
 * The portfolios, campaigns or ad groups a row works on (bid page DS lane, 2026-10-10). The value at `field` is
 * `EntityRef[]` (`{ id, name, href? }`): none → a dash named "No campaigns", one → a direct link, several → a count that
 * opens a small list of links. `total(row)` gives the true count when the list is capped ("153 campaigns", polish round
 * 2); it also sorts by it. Enter on the focused cell follows the one link or opens the list (`entityLinksKeys`) —
 * in a grid whose cells take focus (`suppressCellFocus={false}`); the links and the count are clickable either way.
 * Sorts by how many; the CSV, clipboard and quick filter read the names.
 */
export const entityLinksColumn = <T,>(field: Field<T>, opts: EntityLinksColumnOptions<T>): ColDef<T> => {
  const { header, ...params } = opts
  return {
    field: fieldOf<T>(field),
    headerName: header,
    cellClass: 'nds-ag-cell',
    cellRenderer: EntityLinksCell,
    cellRendererParams: params,
    valueFormatter: (p) => entityLinksText(entityRefsOf(p.value)),
    getQuickFilterText: (p) => entityLinksText(entityRefsOf(p.value)),
    filterValueGetter: (p) => entityLinksText(entityRefsOf(p.getValue(field))),
    comparator: (a, b, na, nb) => compareEntityLinks(entityRefsOf(a), entityRefsOf(b), na?.data ? params.total?.(na.data) : null, nb?.data ? params.total?.(nb.data) : null),
    suppressKeyboardEvent: entityLinksKeys,
  }
}

/* ── mode ─────────────────────────────────────────────────────────────────────────────────── */

export interface ModeColumnOptions<T> {
  /** "Mode", "Level". */
  header: string
  /** The scale, lowest first. Default `MODE_STEPS`: Off · Watch · Ask me · Auto. */
  steps?: readonly ModeStep[]
  /** The row's mode when it is not the plain value at `field`: the set step, or `{ set, acts, heldBy }`. */
  value?(row: T): ModeCellValue
  /** A step this row cannot take, and why ("Needs 14 clean days first"); null = it may. Shown held in the list. */
  heldOption?(row: T, step: string): string | null
  /** The whole picker is locked for this row, and why; null = it may change. Focusable, never disabled. */
  lockReason?(row: T): string | null
  /** The "Not saved" tag while the page's draft holds a change for this row. */
  pending?(row: T): boolean
}

/**
 * A step-choice column (bid page DS lane, 2026-10-10): the rule level Off · Watch · Ask me · Auto, which a switch cannot
 * hold (the old Bid toggle wrote Ask me for Off). The value at `field` is the set step (`'ASK'`) or `{ set, acts, heldBy }`;
 * when `acts` is lower than `set` the cell shows the held mark with what holds it.
 *
 * DRAFT ONLY: the list is the DS `SelectPanelEditor` in AG's popup, and the column's `valueSetter` hands a pick to the
 * grid's `context.current.onMode(row, next, field)` and stores NOTHING (it returns false, so AG fires no change event and
 * the row keeps its value until the page feeds its draft back). Without a handler the cell only shows; a locked row says
 * why. Space opens the list and never ticks the row (`suppressKeyboardEvent`); Enter is AG's own open. Sorts by the scale;
 * CSV, clipboard, quick filter and the column filter read the set step's word.
 *
 * Keyboard needs a grid whose CELLS take focus: `<NexusGrid suppressCellFocus={false}>` (NexusGrid's default focuses
 * rows only, so no cell key would ever arrive). A click opens the list either way.
 */
export const modeColumn = <T,>(field: Field<T>, opts: ModeColumnOptions<T>): ColDef<T> => {
  const steps = opts.steps ?? MODE_STEPS
  const read = (row: T): ModeCellValue => (opts.value ? opts.value(row) : (row as Record<string, unknown> | null)?.[field] as ModeCellValue)
  const lock = (row: T) => (opts.lockReason ? opts.lockReason(row) : null)
  const params: ModeCellParams<T> = {
    field,
    steps,
    read,
    lockReason: opts.lockReason ? (row) => opts.lockReason!(row) : undefined,
    pending: opts.pending ? (row) => opts.pending!(row) : undefined,
  }
  return {
    colId: field,
    headerName: opts.header,
    cellClass: 'nds-ag-cell',
    // The SET step's value: what the editor opens on and what sorting, filters and the CSV read.
    valueGetter: (p) => (p.data ? readMode(read(p.data)).set : null),
    valueFormatter: (p) => modeWord(steps, p.value as string | null),
    getQuickFilterText: (p) => modeWord(steps, p.value as string | null),
    filterValueGetter: (p) => (p.data ? modeWord(steps, readMode(read(p.data)).set) : ''),
    comparator: (a, b) => compareModes(steps, a as ModeCellValue, b as ModeCellValue),
    cellRenderer: ModeCell,
    cellRendererParams: params,
    editable: (p) => !!(p.data && modeHandlerOf(p.context) && !lock(p.data)),
    cellEditor: SelectPanelEditor,
    cellEditorParams: (p: { data?: T }) => ({
      options: p.data ? modeOptions(steps, readMode(read(p.data)), opts.heldOption ? (step) => opts.heldOption!(p.data as T, step) : undefined) : [],
    }),
    // Required: AG must know before it mounts the editor that it is a popup (see `selectEditor`).
    cellEditorPopup: true,
    cellEditorPopupPosition: 'under',
    valueSetter: (p) => {
      const next = typeof p.newValue === 'string' ? p.newValue : null
      if (p.data && next && next !== readMode(read(p.data)).set) modeHandlerOf<T>(p.context)?.(p.data, next, field)
      return false
    },
    suppressKeyboardEvent: suppressModeKeys,
  }
}

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

/**
 * Hold a column at its end: cannot be hidden, moved, or (when `pinned`) unpinned.
 *
 * Unpinned says `pinned: null`, not nothing (polish round 2, audit M8): `pinned` is AG column STATE, and a column
 * definition that leaves it out keeps whatever the column had. A page that swaps its columns for a phone set (the Bid
 * page's rules table: desktop ⋯ pinned right, phone ⋯ `pinned: false`) kept the right pin — measured at 390, the ⋯
 * column sat pinned at x 303–359 and left the Mode column 66px.
 */
export const holdColumn = <T,>(col: ColDef<T>, end: 'left' | 'right', pinned = false): ColDef<T> => ({
  ...col,
  lockVisible: true,
  suppressMovable: true,
  lockPosition: end,
  ...(pinned ? { pinned: end, lockPinned: true } : { pinned: null }),
})

/* ── actions ──────────────────────────────────────────────────────────────────────────────── */

export interface ActionsColumnOptions<T> extends ActionsCellParams<T> {
  /** Overrides the shape-derived default (56 for a `⋯`-only column, 120 with one `primary` verb, 200 with two or a per-row function). */
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
       *
       * 2026-10-05 (gap G2): the rule moved to `actionsColumnWidth` (`renderers/rowVerbs.ts`), and it IS tested now —
       * `rowVerbs.vitest.test.ts`, and this preset itself in `presets.verbs.vitest.test.ts` (it parses in node today):
       * 56 / 120 unchanged, and 200 for two verbs or a per-row function that may return two.
       */
      width: width ?? actionsColumnWidth(params.primary),
      sortable: false,
      resizable: false,
      suppressHeaderMenuButton: true,
      cellClass: 'nds-ag-cell',
      cellRenderer: ActionsCell,
      cellRendererParams: params,
      /* Two verbs + ⋯ are three Tab stops in one cell (gap G2, 2026-10-05): the cell's controls keep their own keys, so
         Tab walks Approve → Reject → ⋯ instead of AG jumping to the next cell. The single-verb shape is unchanged. */
      ...(isMultiVerb(params.primary) ? { suppressKeyboardEvent: rendererOwnsKeyboard } : {}),
    },
    'right',
    pinned,
  )
