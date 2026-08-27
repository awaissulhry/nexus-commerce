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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, ICellRendererParams } from 'ag-grid-community'
import type { ReactNode } from 'react'

import { registerGridModules } from './modules'
import { workspaceGridTheme } from './theme'
import type { GridColumn } from '../WorkspaceGrid'
import './ag-grid.css'

// Module scope, not an effect: the registry has to be populated before the first grid mounts,
// and an effect runs after the first render.
registerGridModules()

/** The sentinel row behind the pinned Total row. Never rendered as data — see `isTotalRow`. */
const TOTAL_ROW = Object.freeze({ __wsgridTotal: true })
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
  const aBlank = a === null || a === undefined
  const bBlank = b === null || b === undefined
  if (aBlank && bBlank) return 0
  if (aBlank) return isDescending ? -1 : 1
  if (bBlank) return isDescending ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
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
}: AgWorkspaceGridProps<T>) {
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
      cellRenderer: (p: ICellRendererParams<T>) =>
        isTotalRow(p) ? (totalFirst ?? null) : p.data ? renderFirst(p.data) : null,
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
          return p.data ? col.render(p.data) : null
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
    enableColumnResize,
    enableSetFilters,
    firstColLabel,
    firstSortValue,
    renderFirst,
    rows,
    totalFirst,
  ])

  const getRowId = useCallback((p: GetRowIdParams<T>) => rowId(p.data), [rowId])

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

  return (
    <div
      className="nds-ag-wrap"
      style={{ height, width: '100%' }}
      data-ag-theme-mode={themeMode}
    >
      <AgGridReact<T>
        theme={workspaceGridTheme}
        rowData={rows}
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
        animateRows={false}
      />
    </div>
  )
}

/**
 * AG Grid resolves its light/dark mode from a `data-ag-theme-mode` attribute, which has to be a
 * real attribute — it is read by the style system, not matched by a selector. The app's own dark
 * mode is the `dark` class on `<html>` (lib/theme/use-theme.ts), set by an effect and also
 * flipped by the OS listener, so this observes the class rather than re-deriving the preference.
 * Re-deriving it would give two answers whenever the two mechanisms disagreed.
 */
function useAgThemeMode(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    const root = document.documentElement
    const read = () => setMode(root.classList.contains('dark') ? 'dark' : 'light')
    read()
    const mo = new MutationObserver(read)
    mo.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => mo.disconnect()
  }, [])

  return mode
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
