/**
 * AGW — the WorkspaceGrid props contract, unchanged.
 *
 * Every interface below is the one `patterns/workspace-grid/WorkspaceGrid.tsx` declared for the
 * hand-rolled `<table>`; the 56 ads-console call sites speak exactly this vocabulary and keep doing
 * so. The engine underneath is AG Grid now (`./WorkspaceGrid.tsx`); nothing here is engine-shaped,
 * which is what makes the seam a seam. The three additions at the bottom of `WorkspaceGridProps`
 * (`rowHeight`, `chromeless`, `prefs`/`onPrefsChange`) are ADDITIVE — every existing consumer is
 * byte-identical — and exist for the Ad Manager, which keeps its own chrome (design doc §7).
 */
import type { ReactNode } from 'react'
import type { ColumnLayoutPreferences } from '../preferencesLayout'

/** SGX3 — what the Customize dialog persists per `storageKey`: the visible columns IN ORDER,
 *  plus whether the identity column and the right-pinned set actually stick. `widths` is the
 *  AG-era addition: a header resize survives a reload. Absent on every view saved before it. */
export interface GridPrefs extends ColumnLayoutPreferences {
  visible: string[]
  stickyFirst: boolean
  stickyLast: boolean
  widths?: Record<string, number>
}

export interface GridColumn<T> {
  key: string
  label: string
  /** Column groups in the Nexus customization modal. Omit for one Columns group. */
  group?: string
  groupKey?: string
  tip?: string
  /** right-aligned numeric look (default true); false renders a left "settings" cell */
  metric?: boolean
  sortable?: boolean
  render: (row: T) => ReactNode
  /**
   * KT.3 — may return `null` / `undefined` for "this row has no value". A blank then sinks in BOTH
   * sort directions rather than being reversed with everything else, so ascending a sparse column
   * surfaces the smallest MEASURED row. Prefer this over a sentinel like `NEGATIVE_INFINITY`.
   */
  sortValue?: (row: T) => number | string | null | undefined
  /** numeric accessor used by range filters keyed on this column */
  filterValue?: (row: T) => number
  /** Total-row cell. ER4 F2: pass a FUNCTION to compute it from the currently
   *  filtered rows (totals then react to the filter panel + search); a plain
   *  ReactNode stays static exactly as before. */
  total?: ReactNode | ((visibleRows: T[]) => ReactNode)
  defaultHidden?: boolean
  /**
   * WG.1 — supersedes `metric` and is the DS `Column.align` under its real name. Both are honoured:
   * `align` wins where it is set, so no existing call site changes behaviour.
   */
  align?: 'left' | 'right' | 'center'
  /**
   * SG.2 — pin this column to the RIGHT edge during horizontal scroll (H10's decision columns).
   * Requires `width`. Offsets are computed over the VISIBLE pinned set, so hiding one via
   * Customize re-packs the rest.
   */
  freezeRight?: boolean
  /** fixed width in px — required with freezeRight (also applied as the column's width) */
  width?: number
}

export interface GridRangeFilter { key: string; label: string; kind: 'range'; unit?: '€' | '%' | ''; tip?: string; value?: (row: unknown) => number }
export interface GridSelectFilter { key: string; label: string; kind: 'select'; options: Array<{ value: string; label: string; title?: string }>; placeholder?: string; wide?: boolean; searchable?: boolean; value?: (row: unknown) => string; tip?: string; disabled?: boolean; note?: string }
export interface GridMultiSelectFilter { key: string; label: string; kind: 'multiselect'; options: Array<{ value: string; label: string; title?: string }>; placeholder?: string; wide?: boolean; searchable?: boolean; value?: (row: unknown) => string; tip?: string; disabled?: boolean; note?: string }

export type GridFilter = GridRangeFilter | GridSelectFilter | GridMultiSelectFilter

/** One inline-editable field (H10 "Edit Groups"). `key` is a column key, or '__first'
 *  for the sticky first column. `initial` seeds the draft; `render` draws the bound input. */
export interface GridEditField<T> {
  key: string
  initial: (row: T) => string
  render: (value: string, set: (v: string) => void, row: T) => ReactNode
  /** optional editor for the hover-edit popover (defaults to `render`); use an inline control
   *  here when `render` is a floating dropdown that would z-fight the popover. */
  renderPopover?: (value: string, set: (v: string) => void, row: T) => ReactNode
}
/** Inline edit mode: the grid renders an Edit toggle that swaps the toolbar for
 *  Discard/Apply and turns the configured cells into inputs; onApply persists the diffs. */
export interface GridEditMode<T> {
  label: string
  fields: GridEditField<T>[]
  onApply: (edits: Array<{ id: string; values: Record<string, string> }>) => Promise<void> | void
  /** show the bulk Edit toggle + Discard/Apply toolbar (default true). false ⇒ hover-edit only. */
  bulk?: boolean
}

export type RangeVal = { min: string; max: string }
export type FilterState = Record<string, RangeVal | string | string[]>

/** GX.2 — what the grid needs in order to draw a tree it does not own. */
export interface GridHierarchy<T> {
  /** 0 for a root row; each level down adds one. Drives the indent. */
  depthOf: (row: T) => number
  /** False on a leaf — the grid must never draw a chevron that opens nothing. */
  expandableOf: (row: T) => boolean
  /** Row ids currently open, by the same `rowId` the grid uses everywhere else. */
  expanded: Set<string>
  /** Row ids whose children are in flight, so the chevron can say so instead of looking inert. */
  loading?: Set<string>
  onToggle: (row: T, next: boolean) => void
  /** Marks a row as a computed remainder so it can be styled and made unselectable. */
  isRemainder?: (row: T) => boolean
}

export interface WorkspaceGridProps<T> {
  rows: T[]
  loading?: boolean
  rowId: (row: T) => string
  /** noun for the count text + Customize lock label, e.g. "Ad Group" */
  noun: string
  /** sticky first column */
  firstColLabel: string
  renderFirst: (row: T) => ReactNode
  firstSortValue?: (row: T) => string
  /** metric / settings columns, in display order */
  columns: GridColumn<T>[]
  /** optional filter panel; range filters read column.filterValue (matched by key) or filter.value */
  filters?: GridFilter[]
  /** toolbar slots (left = beside the count, right = before Customize) */
  toolbarLeft?: ReactNode
  toolbarRight?: ReactNode
  exportable?: boolean
  onExport?: () => void
  customizable?: boolean
  /** localStorage key for column visibility; omit ⇒ not persisted */
  storageKey?: string
  /**
   * GX.2 — DRILL-DOWN MODE. Rows arrive FLAT, in tree order, each reporting its own depth. The grid
   * draws the chevron and the indent and tells you what was clicked; the consumer owns which nodes
   * are open and fetches their children. Tree order is the ONLY order: client sort, filter, search
   * and paging are bypassed exactly as they are in `server` mode.
   */
  hierarchy?: GridHierarchy<T>
  /** selection */
  selectable?: boolean
  selected?: Set<string>
  onSelectedChange?: (s: Set<string>) => void
  /** pinned Total row */
  showTotal?: boolean
  totalFirst?: ReactNode
  /** footer + empty */
  reportLabel?: string
  emptyLabel?: string
  /** richer empty-state (CTA button etc.) — overrides emptyLabel when there are no rows */
  emptyNode?: ReactNode
  /** initial sort (H10 grids default to Spend ↓); the matching header renders active */
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  /**
   * SF.1 — return the row's live state (a boolean, or a status string like ENABLED/PAUSED/ARCHIVED)
   * and the grid puts the live rows at the top of the DEFAULT view. The chosen sort still orders
   * rows *within* each band. Clicking a column header hands ordering entirely to that column;
   * clearing the sort (third click) brings this back. See `enabledRank` for the vocabulary.
   */
  enabledFirst?: (row: T) => unknown
  /** inline edit mode (H10 "Edit Groups"): editable cells + Discard/Apply toolbar */
  editMode?: GridEditMode<T>
  /** bulk-action buttons shown in the toolbar when rows are selected. Receives the selected row
   *  ids + a clear-selection callback. */
  selectionActions?: (ids: string[], clear: () => void) => ReactNode
  /** H10 rules grid: a collapsed 🔍 next to the count that expands to an input and
   *  filters rows by `searchValue` (defaults to firstSortValue). */
  searchable?: boolean
  searchPlaceholder?: string
  searchValue?: (row: T) => string
  /** center the pager (H10 rules grid) instead of right-aligning it. */
  pagerCentered?: boolean
  /** initial filters-panel open state (H10 rules grid loads collapsed). */
  filtersDefaultOpen?: boolean
  /** ER3.1 — Filter Library: saveable named presets persisted in localStorage under this key. */
  filterPresetsKey?: string
  /** ER3.3 — seed the filter state on mount (deep links like ?status=LIMITED). */
  initialFilters?: FilterState
  /** ER3.5 — optional extra class per row (e.g. digest deep-link highlight). */
  rowClassName?: (row: T) => string | undefined
  /** optional row grouping: returns the group key + label for a row. `order` decides the SEQUENCE
   *  of the groups; without it they fall back to alphabetical. */
  groupBy?: (row: T) => { key: string; label: string; order?: number }
  /** optional row click (e.g. open a detail drawer). Clicks landing on an interactive
   *  child (checkbox / link / button / select) are ignored so they keep their own behavior. */
  onRowClick?: (row: T) => void
  /** opt in to keyboard navigation: j/↓ + k/↑ move a focused row, Enter/o fires onRowClick,
   *  any other key is forwarded to onRowKey. Ignored while a field is focused. Only enable on ONE
   *  grid at a time (a document-level listener). */
  keyboardNav?: boolean
  onRowKey?: (row: T, key: string) => void
  /**
   * BID.S0 — read the sort and the filters back OUT. Passing either callback also turns on
   * re-sync: when the seed props change (the back button, a pasted link), the grid follows them.
   * 🔴 The re-sync keys off `defaultSort?.key` / `?.dir` PRIMITIVES, never the object.
   */
  onSortChange?: (sort: { key: string; dir: 'asc' | 'desc' } | null) => void
  onFilterChange?: (filters: Record<string, unknown>) => void
  /** S4.1 — the other half of the URL bridge: page and search. */
  initialPage?: number
  onPageChange?: (page: number) => void
  initialSearch?: string
  onSearchChange?: (q: string) => void
  /**
   * FB.1 — hand the filter STATE to the page. Passing `filterState` also disables the BID.S0
   * seed/emit bridge above. `hideFilterPanel` suppresses the grid's own copy of the panel.
   */
  filterState?: FilterState
  onFilterStateChange?: (next: FilterState) => void
  hideFilterPanel?: boolean
  /**
   * R3 — SERVER-DRIVEN mode: the grid renders `rows` VERBATIM — no filtering, no search, no sort,
   * no slicing — and takes the result size from `total`. Clicking a header still cycles the sort
   * and still calls `onSortChange`; typing still calls `onSearchChange`; paging still calls
   * `onPageChange`.
   */
  server?: {
    /** Rows across the WHOLE result, not the page in `rows`. Drives the count and the pager. */
    total: number
    /** Page size the query used. Owned by the consumer, since it is a query parameter. */
    rowsPerPage: number
    onRowsPerPageChange: (n: number) => void
  }
  /**
   * AGW (additive) — the data row's height in px. AG Grid needs one number per grid; the legacy
   * table sized rows by content. The default is the measured norm of the console (45: 12 + 20 + 12
   * + 1 for a row whose tallest content is the chip row). A page whose cells are taller — the Ad
   * Manager's Toggle cells measure 50 — passes its own. A totals row is a data row's height; a
   * group band and a skeleton row are the engine's.
   */
  rowHeight?: number
  /**
   * AGW (additive) — the grid renders ONLY the `.nds-wsgrid` card: no filter bar, no toolbar, no
   * pager, no footer, no Customize dialog. Rows are rendered VERBATIM (the page filters, searches,
   * sorts and pages); header sort clicks still emit `onSortChange` and `defaultSort` still seeds the
   * indicator. The Ad Manager's mode (design §7): it keeps its own chrome and hands the grid its
   * already-paged rows.
   */
  chromeless?: boolean
  /**
   * AGW (additive) — CONTROLLED column preferences. When passed, `storageKey` is neither read nor
   * written and the grid's own Customize dialog is not offered (`customizable` is ignored); a header
   * drag or resize is reported through `onPrefsChange` and the page decides what to keep.
   */
  prefs?: GridPrefs
  onPrefsChange?: (next: GridPrefs) => void
  /**
   * AGW (additive) — what the header checkbox selects when the grid holds only a PAGE of the consumer's
   * result (`chromeless`): the ids of the whole filtered set. The hand-rolled Ad Manager's select-all
   * took every filtered campaign across pages; the shared grid's took the page (and still does when this
   * is absent). Off clears the whole selection, as it did.
   */
  selectAllIds?: readonly string[]
}
