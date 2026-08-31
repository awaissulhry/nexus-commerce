'use client'

/**
 * `?tab=modules` — the AG Grid Enterprise module catalogue.
 *
 * A study found we register 9 of the 40 enterprise modules. The other 31 are capability we hold
 * and have never switched on. This page exists so that decision can be made by LOOKING rather than
 * by reading a changelog: every module is listed with AG Grid's own feature name, what it does, and
 * what it would mean on our surfaces — and the ones where seeing it is what decides it have a live
 * grid running on the lab's fixtures, with that module actually turned on.
 *
 * The lab registers `AllEnterpriseModule`, so these demos are the real features, not mock-ups.
 * Nothing here is registered for production: `design-system/grid/modules.ts` is still the curated
 * list, and adopting a module means adding one line to it.
 */
import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'

import { Button, Input, Pill, SegmentedControl } from '@/design-system/primitives'
import { NexusGrid, type ColDef, type GridApi, type GridReadyEvent } from '@/design-system/grid'

import { registerLabModules } from './labModules'
import { CATALOGUE, REPORT, type CatalogueRow, type ReportRow } from './gdsFixtures'
import { GRID_MODULES, MODULE_GROUPS, type DemoKey, type GridModule } from './moduleCatalog'

registerLabModules()

const money = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

/* ── the demos ──────────────────────────────────────────────────────────────────────────────
 * Each is a real grid with the named modules switched on. They share the lab's fixtures so the
 * data is the same shape as the consoles these features would land on.
 */

function FilteringDemo() {
  // Switching advanced filter ON REPLACES every column filter — AG treats them as alternatives, not
  // as layers. That is the actual decision, so the demo makes you flip between them rather than
  // implying you can have both.
  const [advanced, setAdvanced] = useState(false)
  const cols = useMemo<ColDef<CatalogueRow>[]>(() => [
    { field: 'sku', headerName: 'SKU', width: 150, filter: 'agTextColumnFilter' },
    { field: 'name', headerName: 'Product', flex: 1, minWidth: 200, filter: 'agMultiColumnFilter', headerTooltip: 'MultiFilterModule — a checkbox list AND a text match on one column' },
    { field: 'brand', headerName: 'Brand', width: 130, filter: 'agSetColumnFilter', headerTooltip: 'SetFilterModule — the Excel checkbox filter' },
    { field: 'status', headerName: 'Status', width: 120, filter: 'agSetColumnFilter' },
    { field: 'priceCents', headerName: 'Price', width: 120, filter: 'agNumberColumnFilter', valueFormatter: (p) => money(p.value), type: 'rightAligned' },
    { field: 'stock', headerName: 'Stock', width: 110, filter: 'agNumberColumnFilter', type: 'rightAligned' },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, floatingFilter: true }), [])
  const rows = useMemo(() => CATALOGUE.filter((r) => r.parentId === null).slice(0, 40), [])
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <SegmentedControl
          size="sm"
          ariaLabel="Filtering style"
          options={[
            { value: 'columns', label: 'Column filters (Set + Multi)' },
            { value: 'advanced', label: 'Advanced filter' },
          ]}
          value={advanced ? 'advanced' : 'columns'}
          onChange={(v) => setAdvanced(v === 'advanced')}
        />
        <span className="nds-cell-muted text-xs">
          {advanced
            ? 'One expression across all columns. Note the column menus have lost their filters — advanced filter replaces them.'
            : 'Open the Brand menu for the Excel checkbox list, or Product for two filter types stacked on one column.'}
        </span>
      </div>
      <NexusGrid<CatalogueRow>
        key={advanced ? 'adv' : 'cols'}
        height={330} rowData={rows} columnDefs={cols} defaultColDef={defaultColDef}
        enableAdvancedFilter={advanced}
        density="compact"
      />
    </div>
  )
}

function SidebarDemo() {
  const cols = useMemo<ColDef<CatalogueRow>[]>(() => [
    { field: 'sku', headerName: 'SKU', width: 150 },
    { field: 'name', headerName: 'Product', flex: 1, minWidth: 180 },
    { field: 'brand', headerName: 'Brand', width: 120, filter: 'agSetColumnFilter' },
    { field: 'status', headerName: 'Status', width: 110, filter: 'agSetColumnFilter' },
    { field: 'priceCents', headerName: 'Price', width: 110, valueFormatter: (p) => money(p.value), type: 'rightAligned' },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, filter: true }), [])
  const sideBar = useMemo(() => ({ toolPanels: ['columns', 'filters'], defaultToolPanel: 'columns' }), [])
  const rows = useMemo(() => CATALOGUE.filter((r) => r.parentId === null).slice(0, 30), [])
  return <NexusGrid<CatalogueRow> height={330} rowData={rows} columnDefs={cols} defaultColDef={defaultColDef} sideBar={sideBar} density="compact" />
}

function PivotDemo() {
  // The pivot drop zone only appears in pivot MODE, and nothing in a bare grid turns that on — so
  // the demo carries the switch rather than asking you to find one that is not there.
  const [pivotMode, setPivotMode] = useState(false)
  const cols = useMemo<ColDef<ReportRow>[]>(() => [
    { field: 'kind', headerName: 'Type', enableRowGroup: true, enablePivot: true, width: 110 },
    { field: 'targeting', headerName: 'Targeting', enableRowGroup: true, enablePivot: true, width: 120 },
    { field: 'campaign', headerName: 'Campaign', flex: 1, minWidth: 200 },
    { field: 'spendCents', headerName: 'Spend', aggFunc: 'sum', enableValue: true, valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130 },
    { field: 'salesCents', headerName: 'Sales', aggFunc: 'sum', enableValue: true, valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130 },
    { field: 'clicks', headerName: 'Clicks', aggFunc: 'sum', enableValue: true, type: 'rightAligned', width: 110 },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), [])
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <SegmentedControl
          size="sm"
          ariaLabel="Grid mode"
          options={[{ value: 'group', label: 'Grouping' }, { value: 'pivot', label: 'Pivot mode' }]}
          value={pivotMode ? 'pivot' : 'group'}
          onChange={(v) => setPivotMode(v === 'pivot')}
        />
        <span className="nds-cell-muted text-xs">
          {pivotMode
            ? 'Drag Type into the row-group zone and Targeting into the pivot zone: its values become columns.'
            : 'Drag Type or Targeting into the grey bar to group by it. Drag a second to nest.'}
        </span>
      </div>
      <NexusGrid<ReportRow>
        height={360} rowData={REPORT} columnDefs={cols} defaultColDef={defaultColDef}
        rowGroupPanelShow="always" pivotPanelShow="always" pivotMode={pivotMode} density="compact"
      />
    </div>
  )
}

function AccessoriesDemo() {
  const cols = useMemo<ColDef<ReportRow>[]>(() => [
    { field: 'campaign', headerName: 'Campaign', flex: 1, minWidth: 220 },
    { field: 'spendCents', headerName: 'Spend', valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130 },
    { field: 'salesCents', headerName: 'Sales', valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130 },
    { field: 'acos', headerName: 'ACoS', valueFormatter: (p) => pct(p.value), type: 'rightAligned', width: 110 },
    { field: 'clicks', headerName: 'Clicks', type: 'rightAligned', width: 110 },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), [])
  const statusBar = useMemo(() => ({
    statusPanels: [
      { statusPanel: 'agTotalAndFilteredRowCountComponent', align: 'left' },
      { statusPanel: 'agSelectedRowCountComponent', align: 'left' },
      { statusPanel: 'agAggregationComponent', align: 'right' },
    ],
  }), [])
  const cellSelection = useMemo(() => ({ handle: { mode: 'range' as const } }), [])
  return (
    <NexusGrid<ReportRow>
      height={330} rowData={REPORT} columnDefs={cols} defaultColDef={defaultColDef}
      statusBar={statusBar} rowNumbers cellSelection={cellSelection} density="compact"
    />
  )
}

function ChartsDemo() {
  const cols = useMemo<ColDef<ReportRow>[]>(() => [
    { field: 'campaign', headerName: 'Campaign', flex: 1, minWidth: 200, chartDataType: 'category' },
    { field: 'spendCents', headerName: 'Spend', valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130, chartDataType: 'series' },
    { field: 'salesCents', headerName: 'Sales', valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130, chartDataType: 'series' },
    {
      headerName: 'Clicks trend', width: 170, sortable: false,
      cellRenderer: 'agSparklineCellRenderer',
      cellRendererParams: { sparklineOptions: { type: 'bar', direction: 'vertical' } },
      valueGetter: (p) => {
        // A deterministic 12-point series off the row's own numbers — a stand-in for real history.
        const base = p.data?.clicks ?? 0
        return Array.from({ length: 12 }, (_, i) => Math.max(0, Math.round(base * (0.5 + ((i * 7 + base) % 11) / 11))))
      },
    },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ resizable: true }), [])
  const cellSelection = useMemo(() => ({ handle: { mode: 'range' as const } }), [])
  return (
    <NexusGrid<ReportRow>
      height={340} rowData={REPORT.slice(0, 12)} columnDefs={cols} defaultColDef={defaultColDef}
      enableCharts cellSelection={cellSelection} density="cozy"
    />
  )
}

function FindDemo() {
  const [term, setTerm] = useState('Giacca')
  const cols = useMemo<ColDef<CatalogueRow>[]>(() => [
    { field: 'sku', headerName: 'SKU', width: 150 },
    { field: 'name', headerName: 'Product', flex: 1, minWidth: 220 },
    { field: 'brand', headerName: 'Brand', width: 130 },
    { field: 'status', headerName: 'Status', width: 120 },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), [])
  const rows = useMemo(() => CATALOGUE.filter((r) => r.parentId === null).slice(0, 40), [])
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Find in every cell…" aria-label="Find" style={{ width: 260 }} />
        <span className="nds-cell-muted text-xs">Matches stay in place and highlight — nothing is hidden. Compare with the quick filter, which removes rows.</span>
      </div>
      <NexusGrid<CatalogueRow> height={300} rowData={rows} columnDefs={cols} defaultColDef={defaultColDef} findSearchValue={term} density="compact" />
    </div>
  )
}

function EditingDemo() {
  const cols = useMemo<ColDef<CatalogueRow>[]>(() => [
    { field: 'sku', headerName: 'SKU', width: 150 },
    { field: 'name', headerName: 'Product', flex: 1, minWidth: 200, editable: true },
    {
      field: 'brand', headerName: 'Brand', width: 160, editable: true,
      cellEditor: 'agRichSelectCellEditor',
      cellEditorParams: { values: ['XAVIA', 'Nordwind', 'Ferro', 'Aurelia'], searchType: 'matchAny', allowTyping: true, filterList: true },
      headerTooltip: 'RichSelectModule — a searchable, virtualised dropdown editor',
    },
    { field: 'status', headerName: 'Status', width: 130, editable: true, cellEditor: 'agRichSelectCellEditor', cellEditorParams: { values: ['ACTIVE', 'DRAFT', 'INACTIVE'] } },
    { field: 'priceCents', headerName: 'Price', width: 130, editable: true, valueFormatter: (p) => money(p.value), type: 'rightAligned' },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), [])
  const rows = useMemo(() => CATALOGUE.filter((r) => r.parentId === null).slice(0, 20).map((r) => ({ ...r })), [])
  return <NexusGrid<CatalogueRow> height={320} rowData={rows} columnDefs={cols} defaultColDef={defaultColDef} density="compact" />
}

function ExportDemo() {
  const [api, setApi] = useState<GridApi<ReportRow> | null>(null)
  const cols = useMemo<ColDef<ReportRow>[]>(() => [
    { field: 'campaign', headerName: 'Campaign', flex: 1, minWidth: 220 },
    { field: 'kind', headerName: 'Type', width: 100 },
    { field: 'spendCents', headerName: 'Spend', valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130 },
    { field: 'salesCents', headerName: 'Sales', valueFormatter: (p) => money(p.value), type: 'rightAligned', width: 130 },
    { field: 'acos', headerName: 'ACoS', valueFormatter: (p) => pct(p.value), type: 'rightAligned', width: 110 },
  ], [])
  const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true }), [])
  const onGridReady = (e: GridReadyEvent<ReportRow>) => setApi(e.api)
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" onClick={() => api?.exportDataAsExcel({ fileName: 'campaigns.xlsx', sheetName: 'Campaigns' })}>Download .xlsx</Button>
        <Button size="sm" onClick={() => api?.exportDataAsCsv({ fileName: 'campaigns.csv' })}>Download .csv (what we ship today)</Button>
        <span className="nds-cell-muted text-xs">Open both. The xlsx keeps column widths, number formats and the sheet name; the CSV is text.</span>
      </div>
      <NexusGrid<ReportRow> height={280} rowData={REPORT.slice(0, 15)} columnDefs={cols} defaultColDef={defaultColDef} onGridReady={onGridReady} density="compact" />
    </div>
  )
}

const DEMOS: Record<DemoKey, { title: string; blurb: string; modules: string[]; render: () => JSX.Element }> = {
  filtering: {
    title: 'Filtering', modules: ['SetFilterModule', 'MultiFilterModule', 'AdvancedFilterModule', 'GroupFilterModule'],
    blurb: 'These are alternatives, not layers: switching the advanced filter on removes every column filter. Flip between them below.',
    render: () => <FilteringDemo />,
  },
  sidebar: {
    title: 'The side bar and its panels', modules: ['SideBarModule', 'ColumnsToolPanelModule', 'FiltersToolPanelModule', 'NewFiltersToolPanelModule'],
    blurb: 'Tabs on the right edge. Columns is close to our own Customise dialog; Filters is the thing we do not have — every active filter in one place.',
    render: () => <SidebarDemo />,
  },
  pivot: {
    title: 'Grouping and pivoting', modules: ['RowGroupingPanelModule', 'PivotModule', 'ShowValuesAsModule'],
    blurb: 'Drag a column into the grey bar to group by it. Switch to pivot mode for a second drop zone that turns a field\u2019s values into columns.',
    render: () => <PivotDemo />,
  },
  accessories: {
    title: 'Status bar and row numbers', modules: ['StatusBarModule', 'RowNumbersModule', 'ContextMenuModule', 'MenuModule'],
    blurb: 'Drag-select a block of Spend cells and read the sum, average, min and max at the bottom right. Rows are numbered; right-click a cell for the context menu.',
    render: () => <AccessoriesDemo />,
  },
  editing: {
    title: 'Editors', modules: ['RichSelectModule', 'BatchEditModule', 'CalculatedColumnsModule', 'FormulaModule'],
    blurb: 'Double-click a Brand cell: the rich select is searchable and virtualised, unlike a plain dropdown.',
    render: () => <EditingDemo />,
  },
  find: {
    title: 'Find', modules: ['FindModule', 'NotesModule'],
    blurb: 'Type and watch matches highlight where they sit. Our quick filter removes non-matching rows instead — a different job.',
    render: () => <FindDemo />,
  },
  charts: {
    title: 'Sparklines and charts', modules: ['SparklinesModule', 'IntegratedChartsModule', 'GridChartsModule'],
    blurb: 'A trend column drawn inside the cell. Select a range of Spend or Sales, right-click, and choose Chart Range to build a live chart from it.',
    render: () => <ChartsDemo />,
  },
  export: {
    title: 'Excel export', modules: ['ExcelExportModule'],
    blurb: 'Both buttons download the same rows. The difference is what your colleague sees when they open the file.',
    render: () => <ExportDemo />,
  },
}

/* ── the catalogue ──────────────────────────────────────────────────────────────────────── */

function ModuleRow({ m, onDemo }: { m: GridModule; onDemo: (k: DemoKey) => void }) {
  return (
    <div className="gmc-row">
      <div className="gmc-status">
        {m.status === 'registered'
          ? <Pill tone="success" size="sm"><Check size={11} /> In use</Pill>
          : <Pill tone="neutral" size="sm">Not on</Pill>}
      </div>
      <div>
        <div className="gmc-name">
          <strong>{m.feature}</strong>
          <code className="gmc-id">{m.id}</code>
          {m.gridOption && <code className="gmc-opt">{m.gridOption}</code>}
        </div>
        <p className="gmc-what">{m.what}</p>
        <p className="gmc-here">{m.here}</p>
      </div>
      <div className="gmc-demo">
        {m.demo && <Button size="sm" onClick={() => onDemo(m.demo!)}>See it</Button>}
      </div>
    </div>
  )
}

export function GridModuleCatalog() {
  const [filter, setFilter] = useState<'all' | 'available' | 'registered'>('available')
  const [openDemo, setOpenDemo] = useState<DemoKey | null>(null)
  const [q, setQ] = useState('')

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return GRID_MODULES.filter((m) => {
      if (filter !== 'all' && m.status !== filter) return false
      if (!needle) return true
      return `${m.feature} ${m.id} ${m.what} ${m.here}`.toLowerCase().includes(needle)
    })
  }, [filter, q])

  const counts = useMemo(() => ({
    all: GRID_MODULES.length,
    registered: GRID_MODULES.filter((m) => m.status === 'registered').length,
    available: GRID_MODULES.filter((m) => m.status === 'available').length,
  }), [])

  const groups = useMemo(
    () => MODULE_GROUPS.map((g) => ({ group: g, items: shown.filter((m) => m.group === g) })).filter((g) => g.items.length > 0),
    [shown],
  )

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <style>{`
        .gmc-row { display: grid; grid-template-columns: 96px minmax(0,1fr) 84px; gap: 0 16px;
          padding: 14px 0; border-top: 1px solid var(--nds-border-subtle); align-items: start; }
        .gmc-name { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 4px; }
        .gmc-name strong { font-size: 14.5px; color: var(--nds-text); }
        .gmc-id { font-size: 11px; color: var(--nds-text-3); font-family: ui-monospace, monospace; }
        .gmc-opt { font-size: 11px; color: var(--nds-primary); font-family: ui-monospace, monospace; }
        .gmc-what { margin: 0 0 4px; font-size: 13px; color: var(--nds-text-2); max-width: 78ch; }
        .gmc-here { margin: 0; font-size: 13px; color: var(--nds-text-3); max-width: 78ch; font-style: italic; }
        .gmc-demo { text-align: right; }
        .gmc-group { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
          color: var(--nds-text-3); margin: 22px 0 2px; }
        @media (max-width: 720px) { .gmc-row { grid-template-columns: 1fr; gap: 6px; } .gmc-demo { text-align: left; } }
      `}</style>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <SegmentedControl
          size="sm"
          ariaLabel="Which modules"
          options={[
            { value: 'available', label: `Not switched on (${counts.available})` },
            { value: 'registered', label: `In use (${counts.registered})` },
            { value: 'all', label: `All (${counts.all})` },
          ]}
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
        />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalogue…" aria-label="Search modules" style={{ width: 240 }} />
        <span className="nds-cell-muted text-xs">
          Enterprise modules only — the 18 community modules we also register carry no decision.
        </span>
      </div>

      {openDemo && (
        <section style={{ border: '1px solid var(--nds-border)', borderRadius: 6, padding: 16, background: 'var(--nds-surface)', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong className="text-md">{DEMOS[openDemo].title}</strong>
            {DEMOS[openDemo].modules.map((id) => <code key={id} className="gmc-id">{id}</code>)}
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="link" onClick={() => setOpenDemo(null)}>Close</Button>
          </div>
          <p className="text-sm" style={{ margin: 0, color: 'var(--nds-text-2)', maxWidth: '90ch' }}>{DEMOS[openDemo].blurb}</p>
          {DEMOS[openDemo].render()}
        </section>
      )}

      <div>
        {groups.map(({ group, items }) => (
          <div key={group}>
            <div className="gmc-group">{group}</div>
            {items.map((m) => <ModuleRow key={m.id} m={m} onDemo={setOpenDemo} />)}
          </div>
        ))}
        {groups.length === 0 && <p className="nds-cell-muted" style={{ padding: '20px 0' }}>Nothing matches “{q}”.</p>}
      </div>

      <div style={{ borderTop: '1px solid var(--nds-border-subtle)', paddingTop: 14 }}>
        <p className="text-sm" style={{ margin: 0, color: 'var(--nds-text-2)', maxWidth: '84ch' }}>
          Adopting one is a single line in <code>design-system/grid/modules.ts</code>. That file is curated on purpose:
          every module registered there is bundled into the first route that renders a grid, so the cost of a module we
          do not use is paid by every page that shows a table.
        </p>
      </div>
    </div>
  )
}
