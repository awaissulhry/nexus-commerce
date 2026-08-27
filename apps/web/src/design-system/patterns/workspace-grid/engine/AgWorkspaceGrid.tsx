'use client'

/**
 * AG.1 — the AG Grid engine, behind the EXISTING WorkspaceGrid vocabulary.
 *
 * This is the only file in the repo allowed to import `ag-grid-react`. Everything else keeps
 * talking in `GridColumn` / `renderFirst` / `freezeRight`, exactly as it does today. That is the
 * whole bet of the migration: 65 `AdsDataGrid` call sites, 74 `DataGrid` sites and 18 grid-lens
 * workspaces do not get rewritten against a new API — the engine underneath them is swapped, and
 * the props contract is the seam.
 *
 * SPIKE SCOPE (Phase 1). Deliberately a SUBSET of `WorkspaceGridProps`: the props needed to put
 * the same data through both engines side by side and measure the difference. Not yet mapped —
 * `filters`, `editMode`, `hierarchy`, `groupBy`, `server`, saved views, the Customize dialog.
 * Those are Phases 3–4 and each one needs its own parity case, not a hopeful `any`.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT
 * A grid that renders is not a grid that is CORRECT. Two behaviours here are load-bearing and
 * differ from AG Grid's defaults; both are implemented deliberately and commented at the site:
 *   1. a blank sorts to the BOTTOM in both directions (see `sinkBlanks`)
 *   2. `null` is never coerced to `0` (see `readSortValue`)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { CellClickedEvent, ColDef, GetRowIdParams, GridApi, GridReadyEvent, ICellRendererParams } from 'ag-grid-community'
import type { ReactNode } from 'react'

import { registerGridModules } from './modules'
import { workspaceGridTheme } from './theme'
import { useAgThemeMode } from './useAgThemeMode'
import type { FilterState, GridColumn, GridFilter } from '../WorkspaceGrid'
import { AdsFilterBar } from '../AdsFilterBar'
import { filterRows } from '../filterRows'
import { compareForAgGrid } from '../sortValues'
import { isInteractiveChild } from '../rowInteraction'
import { collectEdits, draftValue, type EditDrafts } from '../editDrafts'
import type { GridEditField, GridEditMode } from '../WorkspaceGrid'
import { Button } from '@/design-system/primitives'
import './ag-grid.css'

// Module scope, not an effect: the registry has to be populated before the first grid mounts,
// and an effect runs after the first render.
registerGridModules()

/** The sentinel row behind the pinned Total row. Never rendered as data — see `isTotalRow`. */
const TOTAL_ROW = Object.freeze({ __wsgridTotal: true })
/** Stable id for the pinned Total row — see `getRowId`. */
const TOTAL_ROW_ID = '__wsgrid_total__'
const isTotalRow = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === 'bottom'

/**
 * KT.3 parity — a blank sinks in BOTH sort directions.
 *
 * `GridColumn.sortValue` is documented to return `null`/`undefined` for "this row has no value",
 * and the contract operators rely on is that ascending a sparse column surfaces the smallest
 * MEASURED row rather than a wall of blanks.
 *
 * AG Grid's default does the opposite: it treats null as an ordinary low value, so it leads
 * ascending and trails descending — it REVERSES with the sort, which is precisely the behaviour
 * KT.3 rejected. AG Grid negates a comparator's result for a descending sort, so returning
 * `isDescending ? -1 : 1` survives that negation and still lands the blank last.
 */
function sinkBlanks(
  a: unknown,
  b: unknown,
  _nodeA: unknown,
  _nodeB: unknown,
  isDescending: boolean,
): number {
  // Delegates to ../sortValues so this engine and the hand-rolled grid cannot disagree about
  // where a blank belongs. The AG-Grid-specific part — surviving the negation AG applies to a
  // descending comparator — is documented at `compareForAgGrid`.
  return compareForAgGrid(a, b, isDescending)
}

/**
 * Read a column's sort value WITHOUT inventing one.
 *
 * `null` stays `null`. This codebase has repeatedly been bitten by the opposite: a rounded 0.00%
 * that was really "no data", a `Number(null)` that became 0 and matched every `lte`, a Decimal
 * that read as a silent zero. A value getter is exactly where that damage gets done, so it is
 * refused here rather than papered over downstream.
 */
function readSortValue<T>(col: GridColumn<T>, row: T | undefined): unknown {
  if (row === undefined) return null
  const v = col.sortValue?.(row)
  return v === undefined ? null : v
}

export interface AgWorkspaceGridProps<T> {
  rows: T[]
  rowId: (row: T) => string
  columns: GridColumn<T>[]

  /** The identity column. Pinned left, same as `.nds-wsgrid td.nm.fz` today. */
  firstColLabel: string
  renderFirst: (row: T) => ReactNode
  firstSortValue?: (row: T) => string

  loading?: boolean
  selectable?: boolean
  selected?: Set<string>
  onSelectedChange?: (next: Set<string>) => void
  showTotal?: boolean
  totalFirst?: ReactNode
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  emptyLabel?: string

  /** Container height. AG Grid virtualises, so unlike the current grid this must be bounded. */
  height?: number | string

  /**
   * Phase-7 features, off by default so the parity comparison is like-for-like. The lab turns
   * them on one at a time to show what the hand-rolled stack cannot do.
   */
  enableSideBar?: boolean
  enableSetFilters?: boolean
  enableColumnResize?: boolean

  /**
   * AG.3 — the filter panel. Deliberately the SAME `AdsFilterBar` component and the SAME
   * `filterRows` pipeline the hand-rolled grid uses, not an AG Grid filter model: parity is the
   * point of this phase, and a second filter implementation would be a second set of answers.
   * (`enableSetFilters` is a different thing — that is AG Grid's own per-column Set Filter, a
   * Phase-7 capability the lab toggles to show what the current stack cannot do.)
   *
   * Controlled when `filterState` is passed, uncontrolled otherwise — same contract as
   * WorkspaceGrid, so a call site can move between engines without changing how it holds state.
   */
  filters?: GridFilter[]
  filterState?: FilterState
  onFilterStateChange?: (next: FilterState) => void
  filtersDefaultOpen?: boolean
  /** For a page that renders its own copy of the bar at the top (the RA one-bar layout). */
  hideFilterPanel?: boolean

  /** Bulk-action buttons shown when rows are selected. Receives the ids + a clear callback. */
  selectionActions?: (ids: string[], clear: () => void) => ReactNode

  /**
   * Row click, usually opening a detail drawer. Two rows are deliberately NOT clicks:
   * a click that landed on a control inside the row (see ../rowInteraction — selecting a row
   * must not also navigate away from it), and the pinned Total row, which is arithmetic rather
   * than an entity and has nothing to open.
   */
  onRowClick?: (row: T) => void

  /**
   * Inline edit mode. The `fields` contract is the caller's — `render(value, set, row)` supplies
   * the actual input — so both engines draw the IDENTICAL control, and the diff handed to
   * `onApply` comes from ../editDrafts, which both engines share.
   *
   * 🔴 NOT mapped yet: `bulk: false` (the per-cell hover-edit pencil + popover). That surface is
   * built on `.h10-editpen` / `.h10-editpop` from ads.css, a cascade this engine deliberately
   * stays out of, and it needs its own parity case rather than a hopeful approximation. A caller
   * passing `bulk: false` gets no editing here, not a silently different editing.
   */
  editMode?: GridEditMode<T>
}

/**
 * Editing state reaches cells through context, NOT through `colDefs`.
 *
 * `colDefs` is memoised, and rebuilding it on every keystroke makes AG Grid reconcile its column
 * state — which destroys the focus of the input being typed into. A context lets the one cell
 * being edited re-render while the column definitions stay identical.
 */
interface EditCtx {
  editing: boolean
  drafts: EditDrafts
  setDraft: (id: string, key: string, value: string) => void
}
const EditContext = createContext<EditCtx>({ editing: false, drafts: {}, setDraft: () => {} })

/** One editable cell. Reads context so a keystroke re-renders THIS cell and nothing else. */
function EditableCell<T>({
  row,
  id,
  field,
  fallback,
}: {
  row: T
  id: string
  field: GridEditField<T>
  fallback: ReactNode
}) {
  const { editing, drafts, setDraft } = useContext(EditContext)
  if (!editing) return <>{fallback}</>
  const value = draftValue(drafts, id, field, row)
  return <>{field.render(value, (v) => setDraft(id, field.key, v), row)}</>
}

export function AgWorkspaceGrid<T>({
  rows,
  rowId,
  columns,
  firstColLabel,
  renderFirst,
  firstSortValue,
  loading = false,
  selectable = false,
  selected,
  onSelectedChange,
  showTotal = false,
  totalFirst,
  defaultSort,
  emptyLabel = 'No rows',
  height = 560,
  enableSideBar = false,
  enableSetFilters = false,
  enableColumnResize = true,
  filters,
  filterState,
  onFilterStateChange,
  filtersDefaultOpen,
  hideFilterPanel = false,
  selectionActions,
  onRowClick,
  editMode,
}: AgWorkspaceGridProps<T>) {
  const [ownFstate, setOwnFstate] = useState<FilterState>({})
  const filtersControlled = filterState !== undefined
  const fstate = filtersControlled ? filterState : ownFstate
  const setFstate = useCallback(
    (next: FilterState) => {
      if (!filtersControlled) setOwnFstate(next)
      onFilterStateChange?.(next)
    },
    [filtersControlled, onFilterStateChange],
  )

  /**
   * Filtering happens BEFORE the rows reach AG Grid rather than through its filter model. The
   * engine is being proven against the current grid, and the only way that comparison means
   * anything is if both are fed by the same function — see ../filterRows for the three rules
   * (NaN is "not measured", an empty filter is not a filter, a filter with no accessor is inert)
   * that no engine default gets right on its own.
   */
  const visibleRows = useMemo(
    () => filterRows(rows, filters, fstate, columns),
    [rows, filters, fstate, columns],
  )

  const selectedIds = useMemo(() => (selected ? [...selected] : []), [selected])
  const clearSelection = useCallback(() => onSelectedChange?.(new Set()), [onSelectedChange])

  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<EditDrafts>({})
  const [applying, setApplying] = useState(false)
  const setDraft = useCallback((id: string, key: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }))
  }, [])
  const editCtx = useMemo<EditCtx>(() => ({ editing, drafts, setDraft }), [editing, drafts, setDraft])
  const editFieldFor = useMemo(() => {
    const m = new Map<string, GridEditField<T>>()
    for (const f of editMode?.fields ?? []) m.set(f.key, f)
    return m
  }, [editMode])

  const handleCellClicked = useCallback(
    (e: CellClickedEvent<T>) => {
      if (!onRowClick) return
      if (isTotalRow(e)) return
      if (isInteractiveChild(e.event?.target)) return
      if (e.data) onRowClick(e.data)
    },
    [onRowClick],
  )

  const apiRef = useRef<GridApi<T> | null>(null)
  // Guards the controlled-selection effect against re-emitting what it just applied.
  const applyingSelection = useRef(false)
  const themeMode = useAgThemeMode()

  const colDefs = useMemo<ColDef<T>[]>(() => {
    const identity: ColDef<T> = {
      colId: '__first',
      headerName: firstColLabel,
      pinned: 'left',
      // `.nds-wsgrid td.nm { max-width: 360px }`
      width: 360,
      sortable: !!firstSortValue,
      sort: defaultSort?.key === '__first' ? defaultSort.dir : undefined,
      valueGetter: (p) => (p.data && firstSortValue ? firstSortValue(p.data) : null),
      comparator: sinkBlanks,
      cellRenderer: (p: ICellRendererParams<T>) => {
        if (isTotalRow(p)) return totalFirst ?? null
        if (!p.data) return null
        const f = editFieldFor.get('__first')
        const drawn = renderFirst(p.data)
        return f ? <EditableCell row={p.data} id={rowId(p.data)} field={f} fallback={drawn} /> : drawn
      },
      cellClass: 'nds-ag-cell nds-ag-cell-first',
      filter: enableSetFilters ? 'agSetColumnFilter' : false,
    }

    const rest = columns.map<ColDef<T>>((col) => {
      // WG.1 — `align` first, `metric` as the legacy spelling. Transcribed from
      // WorkspaceGrid.tsx:527 so the two engines cannot disagree about a column's alignment.
      const align =
        col.align === 'center'
          ? 'center'
          : col.align === 'left'
            ? 'left'
            : col.align === 'right'
              ? 'right'
              : col.metric === false
                ? 'left'
                : 'right'

      return {
        colId: col.key,
        headerName: col.label,
        headerTooltip: col.tip,
        // `freezeRight` requires `width` by contract; honour both.
        pinned: col.freezeRight ? 'right' : undefined,
        width: col.width,
        // AG Grid hides via column state, which is also what the Columns tool panel writes —
        // so `defaultHidden` and the Customize dialog end up speaking the same language.
        hide: col.defaultHidden,
        sortable: !!col.sortable && !!col.sortValue,
        sort: defaultSort?.key === col.key ? defaultSort.dir : undefined,
        valueGetter: (p) => readSortValue(col, p.data),
        comparator: sinkBlanks,
        cellRenderer: (p: ICellRendererParams<T>) => {
          if (isTotalRow(p)) {
            return typeof col.total === 'function' ? col.total(rows) : (col.total ?? null)
          }
          if (!p.data) return null
          const f = editFieldFor.get(col.key)
          const drawn = col.render(p.data)
          return f ? <EditableCell row={p.data} id={rowId(p.data)} field={f} fallback={drawn} /> : drawn
        },
        cellClass: [
          'nds-ag-cell',
          align === 'right' ? 'nds-ag-num' : align === 'center' ? 'nds-ag-ctr' : 'nds-ag-ed',
        ],
        headerClass: align === 'right' ? 'nds-ag-head-num' : undefined,
        filter: enableSetFilters ? 'agSetColumnFilter' : false,
        resizable: enableColumnResize,
      }
    })

    return [identity, ...rest]
  }, [
    columns,
    defaultSort,
    editFieldFor,
    enableColumnResize,
    enableSetFilters,
    firstColLabel,
    firstSortValue,
    renderFirst,
    rowId,
    rows,
    totalFirst,
  ])

  /**
   * The pinned Total row is a frozen sentinel, not an entity, so `rowId` (e.g. `r => r.id`) reads
   * `undefined` off it — which AG Grid reports as warning #25, "the getRowId callback must return
   * a string". It has fired on every mount since AG.1 and was unreadable because ValidationModule
   * was not registered, so the console only ever showed a number.
   *
   * A row without a stable id is not cosmetic: AG keys row state (selection, expansion, editing)
   * by it, so an `undefined` id is a row whose state cannot be tracked reliably.
   */
  const getRowId = useCallback(
    (p: GetRowIdParams<T>) =>
      (p.data as { __wsgridTotal?: boolean } | undefined)?.__wsgridTotal ? TOTAL_ROW_ID : rowId(p.data),
    [rowId],
  )

  const onGridReady = useCallback((e: GridReadyEvent<T>) => {
    apiRef.current = e.api
  }, [])

  // --- controlled selection: external Set<string> -> grid ---
  useEffect(() => {
    const api = apiRef.current
    if (!api || !selectable || !selected) return
    applyingSelection.current = true
    api.forEachNode((node) => {
      const want = node.id !== undefined && selected.has(node.id)
      if (node.isSelected() !== want) node.setSelected(want)
    })
    applyingSelection.current = false
  }, [selected, selectable, rows])

  // --- grid -> external ---
  const onSelectionChanged = useCallback(() => {
    if (applyingSelection.current || !onSelectedChange) return
    const api = apiRef.current
    if (!api) return
    const next = new Set<string>()
    for (const node of api.getSelectedNodes()) if (node.id !== undefined) next.add(node.id)
    onSelectedChange(next)
  }, [onSelectedChange])

  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    if (loading) api.setGridOption('loading', true)
    else api.setGridOption('loading', false)
  }, [loading])

  const filterBar =
    filters?.length && !hideFilterPanel ? (
      <AdsFilterBar filters={filters} value={fstate} onChange={setFstate} defaultOpen={filtersDefaultOpen} />
    ) : null

  const dirtyEdits = useMemo(
    () => (editMode ? collectEdits(visibleRows, rowId, editMode.fields, drafts) : []),
    [editMode, visibleRows, rowId, drafts],
  )

  const applyEdits = useCallback(async () => {
    if (!editMode || !dirtyEdits.length || applying) return
    setApplying(true)
    try {
      await editMode.onApply(dirtyEdits)
      setDrafts({})
      setEditing(false)
    } finally {
      setApplying(false)
    }
  }, [editMode, dirtyEdits, applying])

  // `bulk: false` is hover-edit only, which is not mapped here — see the prop docblock. Rendering
  // the bulk toolbar for it would offer an editing mode this engine cannot actually perform.
  const editBar =
    editMode && editMode.bulk !== false ? (
      <div className="nds-ag-selbar">
        {editing ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => { setDrafts({}); setEditing(false) }}>
              Discard Changes
            </Button>
            <Button variant="primary" size="sm" disabled={!dirtyEdits.length || applying} onClick={applyEdits}>
              {applying ? 'Applying…' : 'Apply Changes'}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={() => { setDrafts({}); setEditing(true) }}>
            {editMode.label}
          </Button>
        )}
      </div>
    ) : null

  const selectionBar =
    selectable && selectionActions && selectedIds.length > 0 ? (
      <div className="nds-ag-selbar">{selectionActions(selectedIds, clearSelection)}</div>
    ) : null

  return (
    <>
    {filterBar}
    {editBar}
    {selectionBar}
    <EditContext.Provider value={editCtx}>
    <div
      className="nds-ag-wrap"
      style={{ height, width: '100%' }}
      data-ag-theme-mode={themeMode}
    >
      <AgGridReact<T>
        theme={workspaceGridTheme}
        rowData={visibleRows}
        columnDefs={colDefs}
        getRowId={getRowId}
        onGridReady={onGridReady}
        onSelectionChanged={onSelectionChanged}
        rowSelection={
          selectable
            ? { mode: 'multiRow', checkboxes: true, headerCheckbox: true, enableClickSelection: false }
            : undefined
        }
        pinnedBottomRowData={showTotal ? [TOTAL_ROW as unknown as T] : undefined}
        overlayNoRowsTemplate={`<span class="nds-ag-empty">${escapeHtml(emptyLabel)}</span>`}
        suppressCellFocus
        // The current grid never wraps a cell; `white-space: nowrap` is set on every td.
        suppressMovableColumns={false}
        sideBar={enableSideBar ? { toolPanels: ['columns', 'filters'] } : false}
        onCellClicked={onRowClick ? handleCellClicked : undefined}
        rowClass={onRowClick ? 'nds-ag-clickable' : undefined}
        animateRows={false}
      />
    </div>
    </EditContext.Provider>
    </>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
