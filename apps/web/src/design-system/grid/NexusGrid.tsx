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
import type { ColDef, ColumnPinnedEvent, DefaultMenuItem, GetMainMenuItems, GridApi, GridReadyEvent, MenuItemDef, NewColumnsLoadedEvent } from 'ag-grid-community'

import { gridDensity, gridGeometry, type GridDensityName } from '../tokens/grid'
import { compareSortValues, type SortValue } from './sortValues'
import { fillHandleHit } from './editors/openGesture'
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
  CellClassParams,
  ColDef,
  ColGroupDef,
  ColumnState,
  DefaultMenuItem,
  // The row context menu's callback and item shape. Re-exported because a PAGE supplies the items
  // (they are its actions, not the engine's) and the import boundary forbids a page importing AG
  // directly — so the engine is where the type has to come from.
  GetContextMenuItemsParams,
  GridApi,
  GridReadyEvent,
  GridState,
  ICellRendererParams,
  IRowNode,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  MenuItemDef as AgMenuItemDef,
  SortModelItem,
  ValueGetterParams,
  ValueSetterParams,
} from 'ag-grid-community'

export type GridDensity = GridDensityName
/** `text`: a one-line row. `media`: the identity cell carries a thumbnail (photo · title · sub-line). */
/**
 * Three row kinds, not three densities.
 *
 * `text` is a plain one-line row. `media` is the /products/next shape — a thumbnail beside a STACK
 * (photo · title · sub-line), which is what buys the 52. `media-line` is the studio's: a thumbnail
 * on a ONE-LINE row, because the sheet's identity cell has no stack (SKU and Name are separate
 * columns). 36 = 32px thumbnail + 2 above + 2 below.
 *
 * 🔴 Height driven by a row's CONTENT is a property of the row; density is an operator preference
 * applied across every grid. A fourth density tier would have given the ads console a thumbnail row
 * the moment someone picked "compact" (DS.1 + PES.2, hub #184).
 */
export type GridRowKind = 'text' | 'media' | 'media-line'

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
  /* 🔴 Destructured like its siblings, and for the same reason: `onNewColumnsLoaded` is WRAPPED
     below (it re-runs `keepSelectionFirst`, because new columns can land the selection column back
     behind the first one). Left inside `agProps`, the `{...agProps}` spread further down overwrote
     the wrapper with the caller's raw handler — so the first caller ever to pass one would have
     silently lost checkbox-first ordering, with nothing to see in review. Nobody passes one today
     (found latent by the hub, #323). Taking it out of the spread also removes the `as never` and
     the exhaustive-deps disable the old shape needed. */
  onNewColumnsLoaded,
  /* 🔴 Destructured for the same reason as `onNewColumnsLoaded` above, and a different one on top:
     the fill-handle interception below CALLS it. AG never dispatches `cellDoubleClicked` for a
     gesture that landed on the handle (its own listener stops propagation first), so a host that
     answers a refused double-click — "this column is read-only", ruling 1 — would go silent again
     on exactly the corner this file exists to fix. Left inside `agProps` it would also be handed
     straight to AG by the spread and never reach this call. ONE host path for "a double-click on
     this cell", wherever in the cell it landed. */
  onCellDoubleClicked,
  ...agProps
}: NexusGridProps<T>) {
  const themeMode = useAgThemeMode()
  const contextDensity = useGridDensity()
  const density = densityProp ?? contextDensity
  const tier = gridDensity[density]
  const rowHeight =
    agProps.rowHeight ?? (rows === 'media' ? tier.rowMedia : rows === 'media-line' ? tier.rowMediaLine : tier.rowText)
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
    (e: NewColumnsLoadedEvent<T>) => {
      keepSelectionFirst(e.api)
      onNewColumnsLoaded?.(e)
    },
    [keepSelectionFirst, onNewColumnsLoaded],
  )

  /**
   * 🔴 A DOUBLE-CLICK ON THE FILL HANDLE OPENS THE CELL'S EDITOR. It is the P0 of 2026-09-03 — the
   * Owner's *"I double-click a cell and sometimes no editor opens"* — and the whole mechanism, the
   * measurements and the ruling are in `editors/openGesture.ts`. In one line: AG parents a 6×6px
   * `.ag-fill-handle` INSIDE the selected cell's own bottom-right corner and binds its own
   * `dblclick` that begins `_stopPropagationForAgGrid(e)`, so the cell never sees the gesture and
   * no editor opens; the rest of that handler fills the value down to the last row of the grid,
   * which is a silent unconfirmed overwrite of the column (measured: one corner double-click on
   * `basePrice` armed 20 `PATCH /api/products/bulk` calls onto other rows).
   *
   * 🔴 CAPTURE PHASE, on the wrapper. AG's listener is a native one bound to the handle element
   * itself, in the BUBBLE phase and therefore deeper than anything here; only a capture-phase
   * listener on an ancestor runs before it, and only `stopPropagation()` there keeps the event from
   * reaching it at all. A bubble-phase handler — React's `onDoubleClick` included — would run after
   * the fill had already been dispatched. Native rather than React's `onDoubleClickCapture` so the
   * ordering does not depend on where React's delegated root happens to sit relative to AG's DOM.
   *
   * 🔴 THIS IS IN THE ENGINE, not in a sheet. Every AG grid in the product that turns the fill
   * handle on inherits the same answer — the master sheet, PES.3's channel scopes, the inventory
   * editor, the lab — and the "shared = exactly the same" rule is why a copy per sheet is not an
   * option. `mode: 'fill'` is opt-in per grid, so a grid without a handle never runs this.
   *
   * DRAG-TO-FILL IS UNTOUCHED: that is `mousedown`/`mousemove` on the same element, it is the
   * affordance the sheet's footer advertises, and nothing here listens for it.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null)
  /* Through a ref so the listener is installed ONCE per mount: a handler prop that re-identifies
     would otherwise add and remove a document listener on every render of the host. */
  const onCellDoubleClickedRef = useRef(onCellDoubleClicked)
  onCellDoubleClickedRef.current = onCellDoubleClicked
  useEffect(() => {
    const root = wrapRef.current
    if (!root) return
    const onDblClickCapture = (e: MouseEvent) => {
      const hit = fillHandleHit(e.target)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      const api = apiRef.current
      if (!api || api.isDestroyed()) return
      /* `startEditingCell` honours `colDef.editable` and returns silently when the cell is not
         editable — the same answer a double-click on the cell body gets, which is what "the same
         column always opens the same way" requires. It takes no `key`, so `cellEditorSelector`
         sees no `eventKey` and the column's ORDINARY editor opens, never the `=` one. */
      api.startEditingCell({ rowIndex: hit.rowIndex, colKey: hit.colKey, rowPinned: hit.rowPinned })
      /* …and tell the host the same thing AG would have told it. `startEditingCell` returns in
         silence when the cell is not editable, so without this a corner double-click on a LOCKED
         cell would be the one gesture left with nothing to say — the defect's own shape, reopened
         by its fix. The host decides what to say; the engine only guarantees it is asked. */
      const column = api.getColumn(hit.colKey)
      /* AG names the two pinned sections separately — there is no `getPinnedRow(section, i)`, and
         reaching for one typechecks nowhere and would have been a runtime `undefined` if it had. */
      const node = hit.rowPinned === 'top'
        ? api.getPinnedTopRow(hit.rowIndex)
        : hit.rowPinned === 'bottom'
          ? api.getPinnedBottomRow(hit.rowIndex)
          : api.getDisplayedRowAtIndex(hit.rowIndex)
      if (column && node) {
        const event = {
          ...node.data !== undefined ? { data: node.data } : {},
          node, column, colDef: column.getColDef(), value: api.getCellValue({ rowNode: node, colKey: hit.colKey }),
          api, context: api.getGridOption('context'), event: e, type: 'cellDoubleClicked',
        } as never
        column.getColDef().onCellDoubleClicked?.(event)
        onCellDoubleClickedRef.current?.(event)
      }
    }
    root.addEventListener('dblclick', onDblClickCapture, { capture: true })
    return () => root.removeEventListener('dblclick', onDblClickCapture, { capture: true })
  }, [])
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
      /**
       * 🔴 Publish the row height the grid is ACTUALLY using, overriding AG's own
       * `--ag-row-height` on this wrapper.
       *
       * AG's variable is a Theming API **input**, not a readback: it holds the theme's expression
       * (measured `calc(max(16px,13px) + 8px*3.25*1)` = 42px) while the rendered row was 28,
       * because the real height goes to AG through the `rowHeight` grid OPTION in JS and nothing
       * writes it back. So it looks like a readback, resembles a plausible number, and is wrong.
       *
       * That cost a real defect: a thumbnail cap written as
       * `min(thumb, calc(var(--ag-row-height) - 4px))` was silently inert — no error, no warning,
       * a sensible-looking rule that never bound. Setting it here closes the CLASS rather than
       * patching that one expression: any CSS in any consumer can now trust `--ag-row-height` to
       * mean what the grid rendered. (DS.1 + UX.1's durable fix, 2026-09-02.)
       */
      ['--ag-row-height' as string]: `${rowHeight}px`,
    }),
    [agProps.domLayout, height, fill, headerHeight, rowHeight],
  )

  return (
    <>
      <div
        ref={wrapRef}
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
          onCellDoubleClicked={onCellDoubleClicked}
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
