'use client'

/**
 * AG.4 — the Enterprise feature lab. Every AG Grid capability, on a test page, on frozen data.
 *
 * WHY THIS IMPORTS `ag-grid-react` DIRECTLY
 * AG.1 established that `engine/AgWorkspaceGrid.tsx` is the only file allowed to import the React
 * binding, and that rule is what keeps the migration's seam to ONE file and a rollback to one
 * change. It is about PRODUCTION call sites. This is a design-system route that no page links to
 * and no product surface depends on, and routing it through the parity wrapper would defeat the
 * point: that wrapper implements a deliberately narrow slice of `WorkspaceGridProps`, so a
 * showcase built on it could only show the features it already supports.
 *
 * The exception is therefore narrow and enforced rather than promised —
 * `scripts/check-ag-grid-import-boundary.mjs` fails the push if any file outside the engine and
 * this lab imports the binding. The invariant is now machine-checked, which it was not before.
 *
 * WHY ITS OWN FIXTURE
 * `fixture.ts` is the parity baseline and stays frozen — the numbers in the parity table are only
 * comparable across sessions while it does. See `featureFixture.ts`.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react'
import type { ColDef, GridApi, GridReadyEvent, IServerSideDatasource } from 'ag-grid-community'

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import { Button, Input } from '@/design-system/primitives'
import { registerGridModules } from '@/design-system/patterns/workspace-grid/engine/modules'
import { workspaceGridTheme } from '@/design-system/patterns/workspace-grid/engine/theme'
import { useAgThemeMode } from '@/design-system/patterns/workspace-grid/engine/useAgThemeMode'
import { BIG_ROWS, FEATURE_ROWS, type AdGroupRow, type FeatureRow } from './featureFixture'

registerGridModules()

const eur = (v: number | null | undefined) => (v == null ? '—' : `€${Number(v).toFixed(2)}`)

/** One demo: a heading, a sentence saying what to try, and the grid itself. */
function Demo({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <h3 className="text-lg font-heading" style={{ margin: 0 }}>{title}</h3>
      <p className="text-md" style={{ margin: 0, maxWidth: 900, color: 'var(--nds-text-2)' }}>{hint}</p>
      {children}
    </section>
  )
}

/** Generic on purpose: `React.ComponentProps<typeof AgGridReact>` collapses the row type to
 *  `unknown`, which makes every `ColDef<FeatureRow>` below unassignable. */
function Grid<T>({ height = 380, ...props }: { height?: number } & AgGridReactProps<T>) {
  const mode = useAgThemeMode()
  return (
    <div className="nds-ag-wrap" style={{ height, width: '100%' }} data-ag-theme-mode={mode}>
      <AgGridReact<T> theme={workspaceGridTheme} animateRows={false} {...props} />
    </div>
  )
}

/** Export reads the grid's CURRENT state — sort, filters, column order and visibility. */
function ExportDemo() {
  const api = useRef<GridApi<FeatureRow> | null>(null)
  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="secondary" size="sm" onClick={() => api.current?.exportDataAsExcel()}>Export Excel</Button>
        <Button variant="secondary" size="sm" onClick={() => api.current?.exportDataAsCsv()}>Export CSV</Button>
      </div>
      <Grid<FeatureRow>
        height={320}
        rowData={FEATURE_ROWS}
        onGridReady={(e) => { api.current = e.api }}
        columnDefs={[
          { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1 },
          { field: 'market', headerName: 'Market', filter: 'agSetColumnFilter' },
          { field: 'status', headerName: 'Status', filter: 'agSetColumnFilter' },
          { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
        ]}
        defaultColDef={{ sortable: true, resizable: true, floatingFilter: true }}
      />
    </>
  )
}

/** Integrated charts: `enableCharts` plus a chart created from a cell range. */
function ChartDemo() {
  const api = useRef<GridApi<FeatureRow> | null>(null)
  return (
    <>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            api.current?.createRangeChart({
              chartType: 'groupedColumn',
              cellRange: { rowStartIndex: 0, rowEndIndex: 7, columns: ['name', 'spend', 'sales'] },
              chartContainer: document.getElementById('gl-chart') ?? undefined,
            })
          }
        >
          Chart the first 8 rows
        </Button>
      </div>
      <Grid<FeatureRow>
        height={300}
        rowData={FEATURE_ROWS}
        enableCharts
        cellSelection
        onGridReady={(e) => { api.current = e.api }}
        columnDefs={[
          { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1, chartDataType: 'category' },
          { field: 'spend', headerName: 'Spend', chartDataType: 'series' },
          { field: 'sales', headerName: 'Sales', chartDataType: 'series' },
        ]}
        defaultColDef={{ sortable: true, resizable: true }}
      />
      <div id="gl-chart" style={{ height: 320, width: '100%' }} />
    </>
  )
}

/** Server-Side Row Model over a fake datasource — blocks fetched as you scroll. */
function ServerSideDemo() {
  const datasource = useMemo<IServerSideDatasource>(
    () => ({
      getRows: (params) => {
        const { startRow = 0, endRow = 100 } = params.request
        // A real source would sort/filter here; the point is that the grid ASKS rather than holds.
        params.success({ rowData: BIG_ROWS.slice(startRow, endRow), rowCount: BIG_ROWS.length })
      },
    }),
    [],
  )
  return (
    <Grid<FeatureRow>
      height={420}
      rowModelType="serverSide"
      serverSideDatasource={datasource}
      cacheBlockSize={100}
      rowNumbers
      columnDefs={[
        { field: 'name', headerName: 'Campaign', minWidth: 280, flex: 1 },
        { field: 'market', headerName: 'Market' },
        { field: 'status', headerName: 'Status' },
        { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
      ]}
      defaultColDef={{ sortable: true, resizable: true }}
    />
  )
}

export function GridFeatureLab() {
  /* ── 1. Row grouping · aggregation · pivot ─────────────────────────────────────────────── */
  const [pivot, setPivot] = useState(false)
  const groupCols = useMemo<ColDef<FeatureRow>[]>(
    () => [
      { field: 'market', headerName: 'Market', rowGroup: true, hide: true, enablePivot: true },
      { field: 'kind', headerName: 'Type', rowGroup: true, hide: true, enableRowGroup: true, pivotIndex: pivot ? 0 : undefined },
      { field: 'name', headerName: 'Campaign', minWidth: 260, flex: 1 },
      { field: 'spend', headerName: 'Spend', aggFunc: 'sum', valueFormatter: (p) => eur(p.value), enableValue: true },
      { field: 'sales', headerName: 'Sales', aggFunc: 'sum', valueFormatter: (p) => eur(p.value), enableValue: true },
      { field: 'clicks', headerName: 'Clicks', aggFunc: 'sum', enableValue: true },
      { field: 'orders', headerName: 'Orders', aggFunc: 'sum', enableValue: true },
    ],
    [pivot],
  )

  /* ── 2. Filters ────────────────────────────────────────────────────────────────────────── */
  const [advanced, setAdvanced] = useState(false)
  const filterCols = useMemo<ColDef<FeatureRow>[]>(
    () => [
      { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1, filter: 'agTextColumnFilter' },
      { field: 'status', headerName: 'Status', filter: 'agSetColumnFilter' },
      { field: 'market', headerName: 'Market', filter: 'agSetColumnFilter' },
      { field: 'kind', headerName: 'Type', filter: 'agMultiColumnFilter' },
      { field: 'spend', headerName: 'Spend', filter: 'agNumberColumnFilter', valueFormatter: (p) => eur(p.value) },
      { field: 'acos', headerName: 'ACoS', filter: 'agNumberColumnFilter' },
    ],
    [],
  )

  /* ── 3. Find ───────────────────────────────────────────────────────────────────────────── */
  const findApi = useRef<GridApi<FeatureRow> | null>(null)
  const [find, setFind] = useState('')
  const onFindReady = useCallback((e: GridReadyEvent<FeatureRow>) => { findApi.current = e.api }, [])

  return (
    <div style={{ display: 'grid', gap: 28 }}>
      <Demo
        title="Row grouping, aggregation and pivot"
        hint="Grouped by Market then Type, with sums rolled up the tree. Drag a column into the grey panel above the grid to regroup it, or into Values in the Columns tool panel to aggregate it. Toggle pivot to turn Type into columns — none of this exists in the hand-rolled stack."
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant={pivot ? 'primary' : 'secondary'} size="sm" onClick={() => setPivot((p) => !p)}>
            {pivot ? 'Pivot mode: on' : 'Pivot mode: off'}
          </Button>
        </div>
        <Grid<FeatureRow>
          height={420}
          rowData={FEATURE_ROWS}
          columnDefs={groupCols}
          defaultColDef={{ sortable: true, resizable: true }}
          autoGroupColumnDef={{ headerName: 'Group', minWidth: 240, pinned: 'left' }}
          rowGroupPanelShow="always"
          pivotMode={pivot}
          pivotPanelShow="always"
          groupDefaultExpanded={1}
          sideBar={{ toolPanels: ['columns', 'filters'] }}
          statusBar={{
            statusPanels: [
              { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
              { statusPanel: 'agSelectedRowCountComponent', align: 'center' },
              { statusPanel: 'agAggregationComponent', align: 'right' },
            ],
          }}
          cellSelection
          rowSelection={{ mode: 'multiRow' }}
        />
      </Demo>

      <Demo
        title="Filters — Set, Multi, Number, Text, and the Advanced Filter"
        hint="Every column carries a real filter: Status and Market are Set filters (checkbox lists built from the data), Type is a Multi filter (set + text in one popover), the numerics are range filters. Toggle Advanced Filter for a query bar that expresses AND/OR across columns — the hand-rolled FilterPopover is 675 lines and does none of this."
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant={advanced ? 'primary' : 'secondary'} size="sm" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? 'Advanced filter: on' : 'Advanced filter: off'}
          </Button>
        </div>
        <Grid<FeatureRow>
          rowData={FEATURE_ROWS}
          columnDefs={filterCols}
          defaultColDef={{ sortable: true, resizable: true, floatingFilter: !advanced }}
          enableAdvancedFilter={advanced}
          sideBar={{ toolPanels: ['filters'] }}
        />
      </Demo>

      <Demo
        title="Find"
        hint="Type to highlight matches across every cell, including columns scrolled out of view. Community grids usually reimplement this as a search box that filters rows — Find highlights in place, so you keep the surrounding context."
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* DS `Input`, not a raw one: `.nds-input` is not a class this stylesheet defines, and a
              bare <input> would also raise the raw-primitives ratchet on a file that is at zero. */}
          <Input
            style={{ maxWidth: 260 }}
            placeholder="Find in grid…"
            value={find}
            onChange={(e) => { setFind(e.target.value); findApi.current?.setGridOption('findSearchValue', e.target.value) }}
            aria-label="Find in grid"
          />
        </div>
        <Grid<FeatureRow>
          height={300}
          rowData={FEATURE_ROWS}
          onGridReady={onFindReady}
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 260, flex: 1 },
            { field: 'status', headerName: 'Status' },
            { field: 'market', headerName: 'Market' },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Tree data"
        hint="The same campaigns as a real hierarchy — Market › Type › Campaign — built from a path on each row. `WorkspaceGridProps.hierarchy` exists for this today and is one of the props the parity wrapper has not mapped."
      >
        <Grid<FeatureRow>
          rowData={FEATURE_ROWS}
          treeData
          getDataPath={(d) => d.path}
          groupDefaultExpanded={1}
          autoGroupColumnDef={{ headerName: 'Market / Type / Campaign', minWidth: 320, pinned: 'left' }}
          columnDefs={[
            { field: 'status', headerName: 'Status' },
            { field: 'spend', headerName: 'Spend', aggFunc: 'sum', valueFormatter: (p) => eur(p.value) },
            { field: 'sales', headerName: 'Sales', aggFunc: 'sum', valueFormatter: (p) => eur(p.value) },
            { field: 'clicks', headerName: 'Clicks', aggFunc: 'sum' },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Master / detail"
        hint="Expand a campaign to open a fully independent grid of its ad groups — its own columns, its own sorting. The current stack has no equivalent; a nested level means a second page or a drawer."
      >
        <Grid<FeatureRow>
          height={420}
          rowData={FEATURE_ROWS}
          masterDetail
          detailRowAutoHeight
          columnDefs={[
            { field: 'name', headerName: 'Campaign', cellRenderer: 'agGroupCellRenderer', minWidth: 280, flex: 1 },
            { field: 'market', headerName: 'Market' },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
          ]}
          detailCellRendererParams={{
            detailGridOptions: {
              theme: workspaceGridTheme,
              columnDefs: [
                { field: 'name', headerName: 'Ad group', flex: 1 },
                { field: 'spend', headerName: 'Spend' },
                { field: 'sales', headerName: 'Sales' },
                { field: 'clicks', headerName: 'Clicks' },
              ] as ColDef<AdGroupRow>[],
              defaultColDef: { sortable: true, resizable: true },
            },
            getDetailRowData: (p: { data: FeatureRow; successCallback: (rows: AdGroupRow[]) => void }) =>
              p.successCallback(p.data.adGroups),
          }}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Cell selection, fill handle and clipboard"
        hint="Drag across cells to select a range, then drag the small square at its corner to fill — the spreadsheet gesture. Ctrl/Cmd-C copies the range with headers and a block can be pasted straight back in. Measured earlier: the current stack has zero implementations of any of these."
      >
        <Grid<FeatureRow>
          rowData={FEATURE_ROWS}
          cellSelection={{ handle: { mode: 'fill' } }}
          rowNumbers
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1 },
            { field: 'spend', headerName: 'Spend', editable: true },
            { field: 'sales', headerName: 'Sales', editable: true },
            { field: 'clicks', headerName: 'Clicks', editable: true },
            { field: 'orders', headerName: 'Orders', editable: true },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Editing — every editor, with undo/redo"
        hint="Status is a rich select with a searchable list, Type a plain select, Spend a number editor, Campaign a large-text popup. Ctrl/Cmd-Z and Ctrl/Cmd-Y walk the edit history. The hand-rolled editMode carries its own draft state and has no undo at all."
      >
        <Grid<FeatureRow>
          rowData={FEATURE_ROWS}
          undoRedoCellEditing
          undoRedoCellEditingLimit={25}
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1, editable: true, cellEditor: 'agLargeTextCellEditor', cellEditorPopup: true },
            { field: 'status', headerName: 'Status', editable: true, cellEditor: 'agRichSelectCellEditor', cellEditorParams: { values: ['Enabled', 'Paused', 'Archived'], allowTyping: true, searchType: 'matchAny' } },
            { field: 'kind', headerName: 'Type', editable: true, cellEditor: 'agSelectCellEditor', cellEditorParams: { values: ['SP', 'SB', 'SD'] } },
            { field: 'spend', headerName: 'Spend', editable: true, cellEditor: 'agNumberCellEditor' },
            { field: 'live', headerName: 'Live', editable: true, cellEditor: 'agCheckboxCellEditor', cellRenderer: 'agCheckboxCellRenderer' },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Sparklines"
        hint="A 12-point spend series drawn inside the cell, at row height, with no charting code at the call site. Today a trend beside a number means a separate chart surface, or nothing."
      >
        <Grid<FeatureRow>
          height={340}
          rowData={FEATURE_ROWS}
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1 },
            { field: 'history', headerName: 'Spend trend', minWidth: 220, cellRenderer: 'agSparklineCellRenderer', cellRendererParams: { sparklineOptions: { type: 'line' } } },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
          ]}
          defaultColDef={{ resizable: true }}
        />
      </Demo>

      <Demo
        title="Export — Excel and CSV, from the grid"
        hint="Exports what the operator is actually looking at: current sort, current filters, current column order and visibility. The repo hand-rolls this in 4 exceljs files and 31 CSV writers, none of which know the grid's state."
      >
        <ExportDemo />
      </Demo>

      <Demo
        title="Virtualisation — 5,000 rows"
        hint="Neither WorkspaceGrid nor DataGrid virtualises; they page, which is why catalog/drafts carries a `take: 2000` safety cap with a comment about not loading an unbounded catalog. Scroll this: only the visible rows are ever in the DOM."
      >
        <Grid<FeatureRow>
          height={420}
          rowData={BIG_ROWS}
          rowNumbers
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 280, flex: 1 },
            { field: 'market', headerName: 'Market', filter: 'agSetColumnFilter' },
            { field: 'status', headerName: 'Status', filter: 'agSetColumnFilter' },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
            { field: 'clicks', headerName: 'Clicks' },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
          statusBar={{ statusPanels: [{ statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' }] }}
        />
      </Demo>

      <Demo
        title="Integrated charts"
        hint="Select a range of cells and chart it without leaving the grid — or right-click a range and use Chart Range. The chart stays linked to the data, so a filter or an edit moves it. This is the AG Charts runtime the sparklines above also needed."
      >
        <ChartDemo />
      </Demo>

      <Demo
        title="Server-Side Row Model"
        hint="Rows fetched in blocks as you scroll, with sorting and filtering handed to the source rather than done in the browser. Exactly ONE consumer uses the current `server` prop, so today large tables are all client-side — this is the row model that removes that ceiling. Backed here by a fake datasource over the same 5,000 rows."
      >
        <ServerSideDemo />
      </Demo>

      <Demo
        title="Total rows — grand and per-group"
        hint="A pinned grand total plus a total line under every group, computed by the same aggregations, not assembled by the page. The hand-rolled grid has a single Total row that its caller has to build."
      >
        <Grid<FeatureRow>
          height={420}
          rowData={FEATURE_ROWS}
          columnDefs={[
            { field: 'market', headerName: 'Market', rowGroup: true, hide: true },
            { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1 },
            { field: 'spend', headerName: 'Spend', aggFunc: 'sum', valueFormatter: (p) => eur(p.value) },
            { field: 'sales', headerName: 'Sales', aggFunc: 'sum', valueFormatter: (p) => eur(p.value) },
            { field: 'clicks', headerName: 'Clicks', aggFunc: 'sum' },
          ]}
          autoGroupColumnDef={{ headerName: 'Market', minWidth: 220 }}
          groupDefaultExpanded={1}
          grandTotalRow="bottom"
          groupTotalRow="bottom"
          suppressAggFuncInHeader
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Cell spanning"
        hint="Market spans the rows it repeats across, so the column reads as one block per market instead of the same word twelve times. Sort by Market to see the spans re-form."
      >
        <Grid<FeatureRow>
          height={420}
          rowData={[...FEATURE_ROWS].sort((a, b) => a.market.localeCompare(b.market))}
          enableCellSpan
          columnDefs={[
            { field: 'market', headerName: 'Market', spanRows: true, width: 120 },
            { field: 'name', headerName: 'Campaign', minWidth: 260, flex: 1 },
            { field: 'status', headerName: 'Status' },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
          ]}
          defaultColDef={{ resizable: true }}
        />
      </Demo>

      <Demo
        title="Calculated columns"
        hint="A column defined by an expression over other columns rather than by a value getter in the page — ACoS here is spend ÷ sales, evaluated by the grid. Today every derived metric is a function at the call site, which is why the same ratio is written more than once across the ads tree."
      >
        <Grid<FeatureRow>
          height={340}
          rowData={FEATURE_ROWS}
          calculatedColumns
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1 },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
            { field: 'sales', headerName: 'Sales', valueFormatter: (p) => eur(p.value) },
            { colId: 'calcAcos', headerName: 'ACoS (calculated)', calculatedExpression: '[spend] / [sales] * 100' },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="Toolbar and editable column headers"
        hint="A grid-owned toolbar carrying quick filter, find and the row-group panel — the chrome the page hand-rolls today. Double-click a header to rename the column in place."
      >
        <Grid<FeatureRow>
          height={380}
          rowData={FEATURE_ROWS}
          toolbar={{ items: ['agQuickFilterToolbarItem', 'separator', 'agFindToolbarItem', 'agRowGroupPanelToolbarItem'] }}
          columnHeaderEdit={{ applyMode: 'live' }}
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 240, flex: 1, enableRowGroup: true },
            { field: 'market', headerName: 'Market', enableRowGroup: true },
            { field: 'status', headerName: 'Status', enableRowGroup: true },
            { field: 'spend', headerName: 'Spend', valueFormatter: (p) => eur(p.value) },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>

      <Demo
        title="New Filters tool panel"
        hint="The redesigned filters panel — every column's filter in one scrollable surface with the active ones summarised at the top, rather than one popover at a time."
      >
        <Grid<FeatureRow>
          height={380}
          rowData={FEATURE_ROWS}
          enableFilterHandlers
          sideBar={{
            // Both entries spelled out: mixing a shorthand string with an object widens the array
            // to `(string | {...})[]`, which is not assignable to SideBarDef.
            toolPanels: [
              { id: 'columns', labelKey: 'columns', labelDefault: 'Columns', iconKey: 'columns', toolPanel: 'agColumnsToolPanel' },
              { id: 'filters', labelKey: 'filters', labelDefault: 'Filters', iconKey: 'filter', toolPanel: 'agNewFiltersToolPanel' },
            ],
            defaultToolPanel: 'filters',
          }}
          columnDefs={[
            { field: 'name', headerName: 'Campaign', minWidth: 220, flex: 1, filter: 'agTextColumnFilter' },
            { field: 'market', headerName: 'Market', filter: 'agSetColumnFilter' },
            { field: 'status', headerName: 'Status', filter: 'agSetColumnFilter' },
            { field: 'spend', headerName: 'Spend', filter: 'agNumberColumnFilter', valueFormatter: (p) => eur(p.value) },
          ]}
          defaultColDef={{ sortable: true, resizable: true }}
        />
      </Demo>
    </div>
  )
}
