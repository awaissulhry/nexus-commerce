'use client'

/**
 * The grid. One engine, AG Grid Enterprise, configured once.
 *
 * WHY THIS IS THIN
 * It does not invent a column type. Callers pass AG's own `ColDef[]` and AG's own options, because
 * every abstraction over them is a thing to maintain, and maintaining fewer things is the entire
 * point of standardising. `AgWorkspaceGrid` and `AgDataGrid` each re-expressed AG through an older
 * in-house contract (`WorkspaceGridProps`, `DataGridProps`) — that is what forced a flat
 * parent→child→footer row list and the `postSortRows` gymnastics to keep families together while
 * sorting, and the sort still came out wrong. Hand AG a tree and it sorts a tree. The bug did not
 * need fixing; it needed the compatibility layer removed.
 *
 * WHAT IT DOES ADD, and why each earns its place:
 *   - the DS theme (`theme/theme.ts`, bound to `--nds-grid-*`) + light/dark mode attribute;
 *   - density: ONE vocabulary (compact / cozy / spacious, `tokens/grid.ts`) and a row KIND (text /
 *     media), so the row and header heights a page gets are the measured ones and a modal follows
 *     its page through `GridDensityProvider`;
 *   - a default comparator that sinks blanks in BOTH directions (KT.3). AG's default leads them
 *     ascending, which turns "sort by spend ascending" into a list of everything never measured.
 *     A null must never read as a zero here — that rule is older than the grid.
 *   - the DS Customise dialog in place of AG's column chooser, and the selection column kept first.
 *
 * Everything else is AG's. `columnDefs`, `treeData`, `getDataPath`, `masterDetail`, `sideBar`,
 * `rowSelection`, `cellSelection`, `initialState` — pass them straight through.
 */
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react'
import type { ColDef, ColumnPinnedEvent, DefaultMenuItem, GetMainMenuItems, GridApi, GridReadyEvent, MenuItemDef } from 'ag-grid-community'

import { gridDensity, gridGeometry, type GridDensityName } from '../tokens/grid'
import { compareSortValues, type SortValue } from './sortValues'
import { registerGridModules } from './modules'
import { workspaceGridTheme } from './theme/theme'
import { useAgThemeMode } from './hooks/useAgThemeMode'
import { useGridDensity } from './hooks/useGridDensity'
import './theme/grid.css'

registerGridModules()

/**
 * The AG types a page needs, re-exported. A page imports these from HERE (or the `grid` barrel),
 * never from `ag-grid-community` — `scripts/check-ag-grid-import-boundary.mjs` fails the push
 * otherwise. That is the point of the boundary: exactly one folder in the product knows AG's
 * package names, so an upgrade or a swap is one folder's problem.
 */
export type {
  ColDef,
  ColGroupDef,
  ColumnState,
  GridApi,
  GridReadyEvent,
  GridState,
  ICellRendererParams,
  IRowNode,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  SortModelItem,
  ValueGetterParams,
  ValueSetterParams,
} from 'ag-grid-community'

export type GridDensity = GridDensityName
/** `text`: a one-line row. `media`: the identity cell carries a thumbnail (photo · title · sub-line). */
export type GridRowKind = 'text' | 'media'

/** KT.3 — a blank sinks to the BOTTOM in both directions, pre-inverted for AG's descending flip. */
const blankSafeComparator = (a: SortValue, b: SortValue, _na: unknown, _nb: unknown, desc: boolean) => {
  const cmp = compareSortValues(a, b, desc ? 'desc' : 'asc')
  return desc ? -cmp : cmp
}

export interface NexusGridProps<T> extends AgGridReactProps<T> {
  /**
   * Row and header height tier. Omit it and the grid follows the nearest `GridDensityProvider`
   * (a modal follows its page); with no provider, Spacious. Every number comes from
   * `tokens/grid.ts`, so what the grid draws is what the spec prints.
   */
  density?: GridDensity
  /** What a row holds — drives the row height. Default `text`. */
  rows?: GridRowKind
  /** Container height for the normal (virtualised) layout. Ignored under `domLayout="autoHeight"`,
   *  where the grid grows with its rows and the page scrolls instead. */
  height?: number | string
  /** Take the host's remaining height (`GridSheet`): a flex child, no fixed height. */
  fill?: boolean
  className?: string
  /**
   * A tree whose child rows read as children the DS way: a tint and a 3px rail on every row
   * below the top level, transcribed from `.nds-grid tbody tr.nds-grid-kid`. Nothing moves.
   *
   * It does not touch AG's indent. A page whose children must line up under their parent — the
   * products grid, where a variation's price belongs under the same Price header as its
   * parent's — owns the tree column's cell with `autoGroupColumnDef.cellRenderer`, which is
   * AG's own way to draw a custom group cell: no chevron slot, no level step, nothing to undo.
   */
  flatTree?: boolean
  /**
   * The page's own column dialog, offered from every header menu.
   *
   * AG's header menu ends in "Choose Columns" and "Reset Columns", which open AG's column chooser
   * — a second column dialog next to the DS `PreferencesModal`, and one that positions itself
   * against the grid's own box (under `autoHeight` that box can run past the viewport, so the
   * chooser opened below the fold — measured at y=1059 in a 906px window). A page that has a
   * Customise dialog hands it in here; the two AG items are replaced by "Customise columns…" and
   * "Reset columns" that call these. Omit it and AG's items stay.
   */
  columnDialog?: { customise?: () => void; reset?: () => void }
}

/** AG's own icon markup, so a custom item sits in the menu like a built-in one. */
const agIcon = (name: string) => `<span class="ag-icon ag-icon-${name}" unselectable="on" role="presentation"></span>`

/* No `toolbar` prop on purpose: AG already has one (`toolbar`, used in the feature lab), and a
 * page that wants a filter bar or bulk strip above the grid can simply render it above the grid.
 * A prop that only forwards children is surface with no job. */

export function NexusGrid<T>({
  density: densityProp,
  rows = 'text',
  height = 640,
  fill = false,
  className,
  flatTree = false,
  columnDialog,
  defaultColDef,
  selectionColumnDef,
  onColumnPinned,
  onGridReady,
  ...agProps
}: NexusGridProps<T>) {
  const themeMode = useAgThemeMode()
  const contextDensity = useGridDensity()
  const density = densityProp ?? contextDensity
  const tier = gridDensity[density]
  const rowHeight = agProps.rowHeight ?? (rows === 'media' ? tier.rowMedia : tier.rowText)
  const headerHeight = agProps.headerHeight ?? tier.header

  /**
   * A pinned (totals) row is the HEADER's height, never a data row's (IE.4): it reads as a footer,
   * and the spec's conformance runner holds every grid to it. AG has no pinned-row-height option —
   * only `getRowHeight` — so the engine supplies one unless the page brings its own (the products
   * page does, for its 48px family footer). Under SSRM a row-height FUNCTION disables block purging
   * when `maxBlocksInCache` is also set (AG #203); a page that sets that passes its own function.
   */
  const pinnedAwareRowHeight = useCallback(
    (p: { node: { rowPinned?: string | null } }) => (p.node.rowPinned ? headerHeight : rowHeight),
    [headerHeight, rowHeight],
  )
  const getRowHeight = agProps.getRowHeight ?? pinnedAwareRowHeight


  /**
   * The checkbox column stays at the EXTREME left. AG pins a column by moving it into the
   * left-pinned area, which sits before the unpinned columns — so pinning Product put the
   * checkboxes to its right, mid-grid. Whenever any other column is pinned left, the selection
   * column is pinned left too and locked first; when none is, it is left alone, so the default
   * grid gains no pinned divider it did not have.
   */
  const keepSelectionFirst = useCallback((api: GridApi<T>) => {
    if (api.isDestroyed()) return
    // `getAllGridColumns`, not `getColumns`: only the former includes AG's own selection column.
    const cols = api.getAllGridColumns() ?? []
    const sel = cols.find((c) => c.getColId() === 'ag-Grid-SelectionColumn')
    if (!sel) return
    const othersLeft = cols.some((c) => c !== sel && c.getPinned() === 'left')
    const want = othersLeft ? 'left' : null
    if ((sel.getPinned() ?? null) === want) return
    // Applied on the next tick: measured, a state change made INSIDE AG's own columnPinned
    // dispatch was dropped, while the same call a moment later took effect.
    setTimeout(() => {
      if (!api.isDestroyed()) api.applyColumnState({ state: [{ colId: 'ag-Grid-SelectionColumn', pinned: want }] })
    }, 0)
  }, [])
  const handleColumnPinned = useCallback((e: ColumnPinnedEvent<T>) => {
    keepSelectionFirst(e.api)
    onColumnPinned?.(e)
  }, [keepSelectionFirst, onColumnPinned])

  /**
   * AG caches every row's height; changing `rowHeight` / `getRowHeight` as an option does not
   * re-measure the rows it already holds. When the density moves, the engine asks it to — measured:
   * without this the totals row kept its Spacious 46px after a switch to Compact.
   */
  const apiRef = useRef<GridApi<T> | null>(null)
  const handleGridReady = useCallback(
    (e: GridReadyEvent<T>) => {
      apiRef.current = e.api
      // A column pinned in its DEFINITION (a reporting grid's campaign column) sits in the pinned
      // area from the first render, ahead of an unpinned selection column — the `columnPinned`
      // hook only sees pins made at runtime. Measured: checkboxes after the first column.
      keepSelectionFirst(e.api)
      onGridReady?.(e)
    },
    [onGridReady, keepSelectionFirst],
  )
  const handleNewColumnsLoaded = useCallback(
    (e: { api: GridApi<T> }) => {
      keepSelectionFirst(e.api)
      agProps.onNewColumnsLoaded?.(e as never)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keepSelectionFirst, agProps.onNewColumnsLoaded],
  )
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.resetRowHeights()
    // Pinned rows are measured when their data is set, not by `resetRowHeights` — re-set them.
    for (const key of ['pinnedTopRowData', 'pinnedBottomRowData'] as const) {
      const data = api.getGridOption(key)
      if (data && data.length) api.setGridOption(key, [...data])
    }
  }, [rowHeight, headerHeight, getRowHeight])
  // The DS grid's checkbox column measures 43px (`gridGeometry.selectColW`); AG's default is 50.
  const mergedSelectionColumnDef = useMemo(
    () => ({
      lockPosition: 'left' as const,
      lockPinned: true,
      width: gridGeometry.selectColW,
      maxWidth: gridGeometry.selectColW,
      resizable: false,
      ...selectionColumnDef,
    }),
    [selectionColumnDef],
  )

  const getMainMenuItems = useMemo<GetMainMenuItems<T> | undefined>(() => {
    if (!columnDialog) return undefined
    return (p) => {
      const kept: (DefaultMenuItem | MenuItemDef<T>)[] = p.defaultItems.filter((i) => i !== 'columnChooser' && i !== 'resetColumns')
      while (kept[kept.length - 1] === 'separator') kept.pop()
      const own: MenuItemDef<T>[] = []
      if (columnDialog.customise) own.push({ name: 'Customise columns…', icon: agIcon('columns'), action: columnDialog.customise })
      if (columnDialog.reset) own.push({ name: 'Reset columns', action: columnDialog.reset })
      return own.length ? [...kept, 'separator', ...own] : kept
    }
  }, [columnDialog])

  const mergedDefaultColDef = useMemo<ColDef<T>>(
    () => ({
      sortable: true,
      resizable: true,
      // A filterable column gets its filter from the column menu ("Filter"), not from a second
      // header button: the extra funnel cost each header ~22px and turned "Status" into "St…"
      // and "Price" into "Pri…" on the products grid. The header still shows the active-filter
      // mark when a filter is set.
      suppressHeaderFilterButton: true,
      // The caller's defaults win — this only supplies what it has not stated.
      comparator: blankSafeComparator,
      ...defaultColDef,
    }),
    [defaultColDef],
  )

  const wrapStyle = useMemo<CSSProperties>(
    () => ({
      // An auto-height grid sizes itself to its rows and hands scrolling to the page; a fixed
      // wrapper height would clip it. Only the normal layout is bounded.
      height: agProps.domLayout === 'autoHeight' || fill ? undefined : height,
      width: '100%',
      // The theme's header partition is 30% of the HEADER ROW (`theme/theme.ts`), and a theme
      // param cannot know the row's height — a spanning cell under a column-group strip is taller
      // than the row. The wrapper tells it.
      ['--nds-grid-header-h' as string]: `${headerHeight}px`,
    }),
    [agProps.domLayout, height, fill, headerHeight],
  )

  return (
    <>
      <div
        // `nds-ag-nexus` marks the DS grid: the column-group strip and the DataGrid-parity rules
        // in grid.css key on it, so EVERY NexusGrid — in a card, in a modal, anywhere — reads
        // the same.
        className={['nds-ag-wrap', 'nds-ag-nexus', flatTree ? 'nds-ag-flat-tree' : '', fill ? 'nds-ag-fill' : '', className].filter(Boolean).join(' ')}
        style={wrapStyle}
        data-ag-theme-mode={themeMode}
        // Read by grid.css for the per-density knobs the Theming API sets once globally
        // (cell horizontal padding tightens at `compact`, as the DS grid's does).
        data-density={density}
        data-rows={rows}
      >
        <AgGridReact<T>
          theme={workspaceGridTheme}
          rowHeight={rowHeight}
          headerHeight={headerHeight}
          getRowHeight={getRowHeight}
          onGridReady={handleGridReady}
          onNewColumnsLoaded={handleNewColumnsLoaded}
          defaultColDef={mergedDefaultColDef}
          animateRows={false}
          suppressCellFocus
          getMainMenuItems={getMainMenuItems}
          selectionColumnDef={mergedSelectionColumnDef}
          onColumnPinned={handleColumnPinned}
          // Popups (header menus, dialogs, tooltips) go on the document, not inside the grid. AG
          // fits a popup to its popup parent's box; under `autoHeight` that box is the whole
          // grid and can run past the viewport, so a header menu opened low on the page ended
          // 15px below the window's edge with "Reset columns" cut off, and a dialog centred
          // itself below the fold. Against the document, AG fits them to the window.
          popupParent={typeof document !== 'undefined' ? document.body : undefined}
          {...agProps}
        />
      </div>
    </>
  )
}

/** Right-aligned with tabular figures — the DS sets `font-variant-numeric` on no selector at all,
 *  and a money column that loses proportional-digit alignment is the one defect a grid cannot
 *  afford. Spread it into a ColDef rather than remembering two class names. */
export const numericColumn = {
  type: 'rightAligned',
  cellClass: ['nds-ag-cell', 'nds-ag-num'],
  headerClass: 'nds-ag-head-num',
} satisfies Partial<ColDef>
