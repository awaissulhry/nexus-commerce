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
 *   - the DS theme + light/dark mode attribute, so a grid looks like this product;
 *   - row and header heights MEASURED off the retiring grid, so density is not a regression;
 *   - a default comparator that sinks blanks in BOTH directions (KT.3). AG's default leads them
 *     ascending, which turns "sort by spend ascending" into a list of everything never measured.
 *     A null must never read as a zero here — that rule is older than the grid.
 *   - tabular figures on numeric columns, which the DS learned the hard way it must state.
 *
 * Everything else is AG's. `columnDefs`, `treeData`, `getDataPath`, `masterDetail`, `sideBar`,
 * `rowSelection`, `cellSelection`, `initialState` — pass them straight through.
 */
import { useCallback, useMemo } from 'react'
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react'
import type { ColDef, ColumnPinnedEvent, DefaultMenuItem, GetMainMenuItems, GridApi, MenuItemDef } from 'ag-grid-community'

import { compareSortValues, type SortValue } from '../sortValues'
import { registerGridModules } from './modules'
import { workspaceGridTheme } from './theme'
import { useAgThemeMode } from './useAgThemeMode'
import './ag-grid.css'

registerGridModules()

/**
 * The AG types a page needs, re-exported. A page imports these from HERE, never from
 * `ag-grid-community` — `scripts/check-ag-grid-import-boundary.mjs` fails the push otherwise.
 * That is the point of the boundary: exactly one file in the product knows AG's package names,
 * so an upgrade or a swap is one file's problem.
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
  SortModelItem,
  ValueGetterParams,
  ValueSetterParams,
} from 'ag-grid-community'

export type GridDensity = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/**
 * MEASURED off the DS grid in /design/grid-lab on 2026-08-28, not derived from the stylesheet.
 * Deriving is how the workspace theme shipped a 6.95px error on every row: it read `padding` from
 * `workspace-grid.css` lines 24 and 32 while lines 186 and 189 overrode both.
 *
 *   size   header   row        (raw: xs 27.5/28.25 · sm 32.25/33.75 · md 38.25/42.5
 *   lg     46       49          lg 46.25/48.5 · xl 56.25/58.5)
 *
 * Rows are integers: AG virtualises off a fixed row height and a fraction accumulates down a list.
 */
const ROW_HEIGHT: Record<GridDensity, number> = { xs: 28, sm: 34, md: 43, lg: 49, xl: 59 }
const HEADER_HEIGHT: Record<GridDensity, number> = { xs: 28, sm: 32, md: 38, lg: 46, xl: 56 }

/** KT.3 — a blank sinks to the BOTTOM in both directions, pre-inverted for AG's descending flip. */
const blankSafeComparator = (a: SortValue, b: SortValue, _na: unknown, _nb: unknown, desc: boolean) => {
  const cmp = compareSortValues(a, b, desc ? 'desc' : 'asc')
  return desc ? -cmp : cmp
}

export interface NexusGridProps<T> extends AgGridReactProps<T> {
  /** DS density. Drives row and header height; nothing else. */
  size?: GridDensity
  /** Container height for the normal (virtualised) layout. Ignored under `domLayout="autoHeight"`,
   *  where the grid grows with its rows and the page scrolls instead. */
  height?: number | string
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
  size = 'md',
  height = 640,
  className,
  flatTree = false,
  columnDialog,
  defaultColDef,
  selectionColumnDef,
  onColumnPinned,
  ...agProps
}: NexusGridProps<T>) {
  const themeMode = useAgThemeMode()

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
  const mergedSelectionColumnDef = useMemo(
    () => ({ lockPosition: 'left' as const, lockPinned: true, ...selectionColumnDef }),
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

  return (
    <>
      <div
        // `nds-ag-nexus` marks the DS grid: ag-grid.css keys the DataGrid tokens on it, so EVERY
        // NexusGrid — in a card, in a modal, anywhere — speaks the same header and body tokens.
        className={['nds-ag-wrap', 'nds-ag-nexus', flatTree ? 'nds-ag-flat-tree' : '', className].filter(Boolean).join(' ')}
        // An auto-height grid sizes itself to its rows and hands scrolling to the page; a fixed
        // wrapper height would clip it. Only the normal layout is bounded.
        style={{ height: agProps.domLayout === 'autoHeight' ? undefined : height, width: '100%' }}
        data-ag-theme-mode={themeMode}
        // Read by ag-grid.css for the per-density knobs the Theming API sets once globally
        // (cell horizontal padding tightens at `xs`, as the DS grid's does).
        data-size={size}
      >
        <AgGridReact<T>
          theme={workspaceGridTheme}
          rowHeight={ROW_HEIGHT[size]}
          headerHeight={HEADER_HEIGHT[size]}
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
