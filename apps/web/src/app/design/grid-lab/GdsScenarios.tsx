'use client'

/**
 * GDS — every scenario the spec names (docs/2026-08-28-grid-design-system-gds.md §6), rendered from
 * frozen fixtures and MEASURED: `window.__gdsProbe()` returns the numbers each grid actually computed
 * (row / header / strip heights, partition, colours, thumb, selection column) so a person or
 * `scripts/check-grid-chrome.mjs` can hold them against `design-system/grid/spec.json` at every
 * density, in both themes, at a laptop and a monitor width.
 *
 * Rendered OUTSIDE the lab's `.h10-shell` wrapper on purpose: the shell pins the console light, and
 * dark mode can only be measured where the pin does not reach.
 *
 * Lab-only: this folder may import `ag-grid-*` (scripts/check-ag-grid-import-boundary.mjs). Every
 * option object handed to a grid is a module constant or a `useMemo` — the identity guard holds the
 * labs to decision 12 too.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { CellClassParams, CellValueChangedEvent, ColGroupDef, GridApi, GridReadyEvent, ICellRendererParams, IRowNode, ValueGetterParams } from 'ag-grid-community'
import { Download, Search } from 'lucide-react'

import { Button, Input, Pill } from '@/design-system/primitives'
import { Drawer, Modal, Tabs } from '@/design-system/components'
import {
  CellSaveTracker,
  DeltaChip,
  EmptyValue,
  ExpandButton,
  ExpandSlot,
  GridCard,
  GridDensityProvider,
  GridDensityToggle,
  GridFooterSpacer,
  GridFooterStrip,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  GridPager,
  GridPanel,
  GridSearchSlot,
  GridSelectionActions,
  GridToolbar,
  SelectionLabel,
  GroupCell,
  IdentityCell,
  NexusGrid,
  ProgramChip,
  TargetingChip,
  SkuTag,
  actionsColumn,
  dateColumn,
  gridDensity,
  gridGeometry,
  gridSelection,
  integerColumn,
  moneyColumn,
  numericColumn,
  numericEditor,
  percentColumn,
  roundTripClassRules,
  saveCell,
  statusColumn,
  textColumn,
  workspaceGridTheme,
  type ColDef,
  type GridDensityName,
  type GridState,
} from '@/design-system/grid'

import { registerLabModules } from './labModules'
import {
  BIG, CATALOGUE, CATALOGUE_PARENTS, LOCATIONS, LONG_TEXT, MATRIX, REPORT, createCatalogueDatasource, isFamilyParent, reportTotals,
  type CatalogueRow, type MatrixRow, type ReportRow,
} from './gdsFixtures'

registerLabModules()

/* ── scaffolding ──────────────────────────────────────────────────────────────────────────── */

function Scenario({ id, title, hint, children }: { id: string; title: string; hint: ReactNode; children?: ReactNode }) {
  return (
    <section data-gds-scenario={id} style={{ display: 'grid', gap: 8 }}>
      <h3 className="text-lg font-heading" style={{ margin: 0 }}>
        {title} <code className="text-xs" style={{ color: 'var(--nds-text-3)', fontWeight: 500 }}>#{id}</code>
      </h3>
      <p className="text-md" style={{ margin: 0, maxWidth: 960, color: 'var(--nds-text-2)' }}>{hint}</p>
      {children}
    </section>
  )
}

const STATUS_TONES = { ACTIVE: { tone: 'success' as const, label: 'Active' }, DRAFT: { tone: 'neutral' as const, label: 'Draft' }, INACTIVE: { tone: 'danger' as const, label: 'Inactive' } }
const rowId = <T extends { id: string }>(p: { data: T }) => p.data.id
const SELECTION = gridSelection<CatalogueRow>({ isRowSelectable: (n: IRowNode<CatalogueRow>) => !n.rowPinned })
const REPORT_SELECTION = gridSelection<ReportRow>()
const DEFAULT_SORT: GridState = { sort: { sortModel: [{ colId: 'ag-Grid-AutoColumn', sort: 'asc' }] } }

/* ── the catalogue identity cell: expander · SKU-titled media row ─────────────────────────── */

function useExpanded(node: IRowNode): boolean {
  const [expanded, setExpanded] = useState(!!node.expanded)
  useEffect(() => {
    setExpanded(!!node.expanded)
    const on = () => setExpanded(!!node.expanded)
    node.addEventListener('expandedChanged', on)
    return () => node.removeEventListener('expandedChanged', on)
  }, [node])
  return expanded
}

function CatalogueCell(p: ICellRendererParams<CatalogueRow>) {
  const expanded = useExpanded(p.node)
  const d = p.data
  if (!d) return null
  const parent = isFamilyParent(d)
  return (
    <IdentityCell
      leading={parent ? <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand variations', 'Collapse variations']} /> : <ExpandSlot />}
      image={null}
      title={d.name}
      titleAttr={d.name}
      href="#"
      openPill
      sub={
        <>
          <SkuTag>{d.sku}</SkuTag>
          {parent && <span>{d.childCount} variations</span>}
        </>
      }
    />
  )
}

const CATALOGUE_AUTO_GROUP: ColDef<CatalogueRow> = { headerName: 'Product', colId: 'product', minWidth: 320, flex: 1, cellRenderer: CatalogueCell, cellClass: 'nds-ag-cell' }
const CATALOGUE_COLS: ColDef<CatalogueRow>[] = [
  { colId: 'status', headerName: 'Status', width: 96, ...statusColumn<CatalogueRow>('status', { tones: STATUS_TONES }) },
  { colId: 'stock', headerName: 'Available', width: 110, ...integerColumn<CatalogueRow>('stock') },
  { colId: 'salesCents', headerName: 'Sales (7d)', width: 110, ...moneyColumn<CatalogueRow>('salesCents', { zero: 'dash', zeroTitle: 'No sales in the last 7 days' }) },
  { colId: 'units', headerName: 'Units (7d)', width: 92, ...integerColumn<CatalogueRow>('units', { zero: 'dash', zeroTitle: 'No units sold in the last 7 days' }) },
  { colId: 'priceCents', headerName: 'Price', width: 96, ...moneyColumn<CatalogueRow>('priceCents', { decimals: true }) },
  { colId: 'updatedAt', headerName: 'Last updated', width: 132, ...dateColumn<CatalogueRow>('updatedAt') },
  { ...actionsColumn<CatalogueRow>({ primary: { label: 'Edit', href: () => '#' }, items: (r) => [{ id: 'dup', label: `Duplicate ${r.sku}` }] }) },
]
const getGroupKey = (d: CatalogueRow) => d.id

/* ── 1 · 2 · 4 · 7 — the catalogue: SSRM tree, autoHeight + pager, selection swap, export ── */

function CatalogueScenario({ id, familyId, title, hint }: { id: string; familyId?: string; title: string; hint: ReactNode }) {
  const [api, setApi] = useState<GridApi<CatalogueRow> | null>(null)
  const [selected, setSelected] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [pager, setPager] = useState({ page: 1, pageCount: 1 })
  const datasource = useMemo(() => createCatalogueDatasource({ familyId }), [familyId])
  const onGridReady = useCallback((e: GridReadyEvent<CatalogueRow>) => setApi(e.api), [])
  const onSelectionChanged = useCallback((e: { api: GridApi<CatalogueRow> }) => setSelected(e.api.getSelectedNodes().length), [])
  const onPaginationChanged = useCallback((e: { api: GridApi<CatalogueRow> }) => setPager({ page: e.api.paginationGetCurrentPage() + 1, pageCount: Math.max(1, e.api.paginationGetTotalPages()) }), [])
  const onPage = useCallback((n: number) => api?.paginationGoToPage(n - 1), [api])
  const onPageSize = useCallback((n: number) => { setPageSize(n); api?.paginationGoToPage(0) }, [api])
  const clear = useCallback(() => api?.deselectAll(), [api])
  const isGroup = useCallback((d: CatalogueRow) => !familyId && isFamilyParent(d), [familyId])
  return (
    <Scenario id={id} title={title} hint={hint}>
      <GridCard
        toolbar={
          <GridToolbar
            count={selected ? <>Selected <b>{selected}</b> {selected === 1 ? 'product' : 'products'}</> : <><b>{familyId ? CATALOGUE.filter((r) => r.parentId === familyId).length : CATALOGUE_PARENTS.length}</b> products</>}
            right={
              <Button size="sm" onClick={() => api?.exportDataAsCsv({ fileName: `${id}.csv` })}>
                <Download size={13} /> Export
              </Button>
            }
          >
            {selected ? (
              <GridSelectionActions>
                <Button size="sm" variant="primary"><SelectionLabel>Bulk edit</SelectionLabel></Button>
                <Button size="sm"><SelectionLabel>Tag</SelectionLabel></Button>
                <Button size="sm" variant="link" onClick={clear}>Clear</Button>
              </GridSelectionActions>
            ) : (
              <GridSearchSlot>
                <Input leadingIcon={<Search size={13} />} placeholder="Search products…" aria-label="Search" style={{ width: '100%' }} />
              </GridSearchSlot>
            )}
          </GridToolbar>
        }
        footer={<GridPager page={pager.page} pageCount={pager.pageCount} pageSize={pageSize} onPage={onPage} onPageSize={onPageSize} />}
      >
        <NexusGrid<CatalogueRow>
          rows="media"
          domLayout="autoHeight"
          pagination
          paginationPageSize={pageSize}
          paginationPageSizeSelector={false}
          suppressPaginationPanel
          onPaginationChanged={onPaginationChanged}
          rowModelType="serverSide"
          serverSideDatasource={datasource}
          cacheBlockSize={100}
          getRowId={rowId}
          treeData={!familyId}
          flatTree={!familyId}
          isServerSideGroup={isGroup}
          getServerSideGroupKey={getGroupKey}
          autoGroupColumnDef={CATALOGUE_AUTO_GROUP}
          columnDefs={CATALOGUE_COLS}
          rowSelection={SELECTION}
          onSelectionChanged={onSelectionChanged}
          onGridReady={onGridReady}
          initialState={DEFAULT_SORT}
        />
      </GridCard>
    </Scenario>
  )
}

/* ── 3 — row grouping with aggregates ─────────────────────────────────────────────────────── */

function GroupLabel(p: ICellRendererParams<CatalogueRow>) {
  if (!p.node.group) return p.data ? <span>{p.data.name}</span> : null
  return <GroupCell label={String(p.node.key ?? '—')} count={p.node.allChildrenCount ?? 0} noun={['product', 'products']} />
}
const GROUP_AUTO: ColDef<CatalogueRow> = { headerName: 'Brand / product', minWidth: 320, flex: 1, cellRenderer: GroupLabel, cellClass: 'nds-ag-cell' }
const GROUP_COLS: ColDef<CatalogueRow>[] = [
  { colId: 'brand', field: 'brand', headerName: 'Brand', rowGroup: true, hide: true },
  { colId: 'status', headerName: 'Status', width: 96, ...statusColumn<CatalogueRow>('status', { tones: STATUS_TONES }) },
  { colId: 'stock', headerName: 'Available', width: 110, aggFunc: 'sum', ...integerColumn<CatalogueRow>('stock') },
  { colId: 'priceCents', headerName: 'Price', width: 110, aggFunc: 'avg', ...moneyColumn<CatalogueRow>('priceCents', { decimals: true }) },
  { colId: 'salesCents', headerName: 'Sales (7d)', width: 110, aggFunc: 'sum', ...moneyColumn<CatalogueRow>('salesCents', { zero: 'dash', zeroTitle: 'No sales in the last 7 days' }) },
]

/* ── 5/8/16/17 — the editor in a modal: column-group strip, a matrix, pending → apply ─────── */

function MatrixEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pending, setPending] = useState<Map<string, number>>(new Map())
  const [refused, setRefused] = useState<Map<string, string>>(new Map())
  const [message, setMessage] = useState<string | null>(null)
  const apiRef = useRef<GridApi<MatrixRow> | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const refusedRef = useRef(refused)
  refusedRef.current = refused
  const key = (id: string, loc: string) => `${id}:${loc}`
  const onHandOf = (r: MatrixRow, loc: string) => pendingRef.current.get(key(r.id, loc)) ?? r.cells[loc].onHand

  const columnDefs = useMemo<(ColDef<MatrixRow> | ColGroupDef<MatrixRow>)[]>(() => {
    const identity: ColDef<MatrixRow> = {
      colId: 'product', headerName: 'Variation', pinned: 'left', lockPosition: 'left', suppressMovable: true, width: gridGeometry.identityW + (gridDensity.spacious.thumb - gridDensity.compact.thumb), cellClass: 'nds-ag-cell', sortable: false,
      cellRenderer: (p: ICellRendererParams<MatrixRow>) => (p.data ? <IdentityCell image={null} title={<SkuTag>{p.data.sku}</SkuTag>} sub={<span className="nds-cell-muted">{p.data.name}</span>} /> : null),
    }
    const groups: ColGroupDef<MatrixRow>[] = LOCATIONS.map((loc) => ({
      groupId: loc.id,
      headerName: loc.editable ? loc.code : `${loc.code} · locked`,
      marryChildren: true,
      children: [
        {
          colId: `onhand:${loc.id}`, headerName: 'On hand', width: 88, sortable: false,
          ...(loc.editable ? numericEditor({ min: 0 }) : { editable: false }),
          valueGetter: (p: ValueGetterParams<MatrixRow>) => (p.data ? onHandOf(p.data, loc.id) : null),
          valueSetter: (p) => { if (!p.data) return false; const n = Number(p.newValue); if (!Number.isInteger(n) || n < 0) return false; setPending((prev) => new Map(prev).set(key(p.data!.id, loc.id), n)); setRefused((prev) => { const m = new Map(prev); m.delete(key(p.data!.id, loc.id)); return m }); return true },
          cellRenderer: (p: ICellRendererParams<MatrixRow>) => {
            if (!p.data) return null
            const delta = onHandOf(p.data, loc.id) - p.data.cells[loc.id].onHand
            return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'flex-end' }} title={refusedRef.current.get(key(p.data.id, loc.id))}>{p.value}<DeltaChip delta={delta} />{!loc.editable && <span className="nds-cell-lock-glyph" role="img" aria-label="Read-only">🔒</span>}</span>
          },
          cellClassRules: {
            'nds-cell-is-pending': (p: CellClassParams<MatrixRow>) => !!p.data && pendingRef.current.has(key(p.data.id, loc.id)),
            'nds-cell-is-refused': (p: CellClassParams<MatrixRow>) => !!p.data && refusedRef.current.has(key(p.data.id, loc.id)),
            'nds-cell-is-locked': () => !loc.editable,
            'nds-cell-is-editable': () => loc.editable,
          },
          ...numericColumn,
        },
        { colId: `reserved:${loc.id}`, headerName: 'Reserved', width: 84, sortable: false, valueGetter: (p) => p.data?.cells[loc.id].reserved ?? null, cellClass: [...numericColumn.cellClass, 'nds-cell-muted'], headerClass: numericColumn.headerClass, type: 'rightAligned' },
        { colId: `available:${loc.id}`, headerName: 'Available', width: 86, sortable: false, valueGetter: (p) => (p.data ? onHandOf(p.data, loc.id) - p.data.cells[loc.id].reserved : null), ...numericColumn },
      ],
    }))
    return [identity, ...groups]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onGridReady = useCallback((e: GridReadyEvent<MatrixRow>) => { apiRef.current = e.api }, [])
  const rowSelection = useMemo(() => gridSelection<MatrixRow>(), [])
  const defaultColDef = useMemo<ColDef<MatrixRow>>(() => ({ suppressHeaderMenuButton: true, sortable: false }), [])
  const apply = () => {
    const bad = new Map<string, string>()
    for (const [k, v] of pending) if (v > 500) bad.set(k, `Refused: ${v} exceeds the location's capacity (500)`)
    setRefused(bad)
    setPending((prev) => { const m = new Map<string, number>(); for (const [k, v] of prev) if (bad.has(k)) m.set(k, v); return m })
    setMessage(bad.size ? `${pending.size - bad.size} applied · ${bad.size} refused — hover a red cell for why` : `${pending.size} ${pending.size === 1 ? 'change' : 'changes'} applied`)
    apiRef.current?.refreshCells({ force: true })
  }
  useEffect(() => { apiRef.current?.refreshCells({ force: true }) }, [pending, refused])
  return (
    <Modal open={open} onClose={onClose} size="xxl" title="XAVIA AIREON Giacca Da Moto Da Uomo" subtitle="AIREON · 12 variations · 3 locations">
      <GridPanel
        toolbar={<GridToolbar count={pending.size ? <Pill tone="warning" size="sm">{pending.size} {pending.size === 1 ? 'change' : 'changes'} pending</Pill> : <Pill tone="neutral" size="sm">No changes</Pill>} />}
        footer={
          <GridFooterStrip>
            <span className="nds-cell-muted">Reason</span>
            <Input placeholder="Manual adjustment" aria-label="Reason" style={{ width: 200 }} />
            <GridFooterSpacer />
            {message && <span className="nds-cell-muted" role="status">{message}</span>}
            <Button size="sm" variant="secondary" onClick={onClose}>{pending.size ? 'Cancel' : 'Close'}</Button>
            <Button size="sm" variant="primary" disabled={!pending.size} onClick={apply}>{pending.size ? `Apply ${pending.size} ${pending.size === 1 ? 'change' : 'changes'}` : 'Apply'}</Button>
          </GridFooterStrip>
        }
      >
        <NexusGrid<MatrixRow>
          rows="media"
          height={480}
          groupHeaderHeight={gridGeometry.stripH}
          rowData={MATRIX}
          getRowId={rowId}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          rowSelection={rowSelection}
          onGridReady={onGridReady}
          suppressCellFocus={false}
          enterNavigatesVertically
          enterNavigatesVerticallyAfterEdit
          stopEditingWhenCellsLoseFocus
          undoRedoCellEditing
        />
      </GridPanel>
      <p className="nds-cell-muted text-xs" style={{ margin: '10px 0 0' }}>Type into an On hand cell · Enter moves down · Tab moves right · Esc reverts · a value over 500 is refused on Apply and stays red.</p>
    </Modal>
  )
}

/* ── 7 · 11 — reporting: read-only, totals row, export ────────────────────────────────────── */

function CampaignCell(p: ICellRendererParams<ReportRow>) {
  if (!p.data) return null
  if (p.node.rowPinned) return <b>Total</b>
  return (
    <span className="nds-cell-identity" style={{ gap: 7 }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, flex: 'none', background: p.data.live ? 'var(--nds-live)' : 'var(--nds-text-disabled)' }} />
      <TargetingChip targeting={p.data.targeting} />
      <ProgramChip program={p.data.kind} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={p.data.campaign}>{p.data.campaign}</span>
    </span>
  )
}
const REPORT_COLS: ColDef<ReportRow>[] = [
  { colId: 'campaign', field: 'campaign', headerName: 'Campaign', pinned: 'left', width: 320, cellRenderer: CampaignCell, cellClass: 'nds-ag-cell' },
  { colId: 'spendCents', headerName: 'Spend', width: 110, ...moneyColumn<ReportRow>('spendCents', { decimals: true }) },
  { colId: 'salesCents', headerName: 'Sales', width: 120, ...moneyColumn<ReportRow>('salesCents', { decimals: true, zero: 'dash', zeroTitle: 'No attributed sales' }) },
  { colId: 'acos', headerName: 'ACoS', width: 96, ...percentColumn<ReportRow>('acos') },
  { colId: 'impressions', headerName: 'Impressions', width: 120, ...integerColumn<ReportRow>('impressions') },
  { colId: 'clicks', headerName: 'Clicks', width: 96, ...integerColumn<ReportRow>('clicks') },
  { colId: 'ctr', headerName: 'CTR', width: 90, ...percentColumn<ReportRow>('ctr', { dp: 2 }) },
  { colId: 'orders', headerName: 'Orders', width: 90, ...integerColumn<ReportRow>('orders') },
]
const REPORT_TOTALS = [reportTotals(REPORT)]
const REPORT_SORT: GridState = { sort: { sortModel: [{ colId: 'spendCents', sort: 'desc' }] } }

/* ── 12 — per-cell server round trip ──────────────────────────────────────────────────────── */

interface BidRow extends ReportRow {
  bid: number
}
const BID_ROWS: BidRow[] = REPORT.slice(0, 8).map((r) => ({ ...r, bid: r.bidCents / 100 }))

function RoundTripScenario() {
  const tracker = useMemo(() => new CellSaveTracker(), [])
  const [rows] = useState(BID_ROWS)
  const [log, setLog] = useState<string[]>([])
  const cellClassRules = useMemo(() => roundTripClassRules<BidRow>(tracker, (r) => r.id), [tracker])
  const columnDefs = useMemo<ColDef<BidRow>[]>(
    () => [
      { colId: 'campaign', field: 'campaign', headerName: 'Campaign', width: 320, cellRenderer: CampaignCell, cellClass: 'nds-ag-cell' },
      { colId: 'bid', field: 'bid', headerName: 'Bid (€)', width: 110, ...numericEditor({ min: 0.02, precision: 2, step: 0.01 }), ...numericColumn, cellClassRules, cellRenderer: (p: ICellRendererParams<BidRow>) => (p.value == null ? <EmptyValue /> : <span title={tracker.get(p.data!.id, 'bid')?.reason}>{`€${Number(p.value).toFixed(2)}`}</span>), cellClass: [...numericColumn.cellClass, 'nds-cell-is-editable'] },
      { colId: 'spendCents', headerName: 'Spend', width: 110, ...moneyColumn<BidRow>('spendCents', { decimals: true }) },
      { colId: 'acos', headerName: 'ACoS', width: 96, ...percentColumn<BidRow>('acos') },
    ],
    [cellClassRules, tracker],
  )
  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent<BidRow>) => {
      if (e.colDef.colId !== 'bid') return
      const v = Number(e.newValue)
      void saveCell(e.api, tracker, e.data.id, 'bid', () =>
        new Promise((res) => setTimeout(() => res(v > 5 ? { ok: false, reason: 'Refused: above the campaign ceiling (€5.00)' } : { ok: true }), 700)),
      ).then((o) => setLog((l) => [`${e.data.campaign.slice(0, 28)} → €${v.toFixed(2)}: ${o.ok ? 'saved' : o.reason}`, ...l].slice(0, 5)))
    },
    [tracker],
  )
  const defaultColDef = useMemo<ColDef<BidRow>>(() => ({ sortable: false }), [])
  return (
    <Scenario id="roundtrip" title="Editable grid with a server round-trip per cell" hint="Click a bid, type, Enter. The cell turns to the saving wash while the (fake) server answers 700ms later: green ring for saved (fades), red for refused with the reason on hover. A refusal stays until the cell is edited again. Try 6.00.">
      <GridCard>
        <NexusGrid<BidRow> density="cozy" domLayout="autoHeight" rowData={rows} getRowId={rowId} columnDefs={columnDefs} defaultColDef={defaultColDef} onCellValueChanged={onCellValueChanged} singleClickEdit suppressCellFocus={false} />
      </GridCard>
      {log.length > 0 && <pre className="text-xs" style={{ margin: 0, color: 'var(--nds-text-2)' }}>{log.join('\n')}</pre>}
    </Scenario>
  )
}

/* ── 9 — frozen-right actions · 10 — master/detail · 13/14 — 0 and 1 rows · 15 — 10k ─────── */

const ACTIONS_COLS: ColDef<CatalogueRow>[] = [
  { colId: 'sku', headerName: 'SKU', width: 140, pinned: 'left', ...textColumn<CatalogueRow>('sku') },
  { colId: 'name', headerName: 'Product', width: 360, ...textColumn<CatalogueRow>('name') },
  { colId: 'brand', headerName: 'Brand', width: 120, ...textColumn<CatalogueRow>('brand') },
  { colId: 'status', headerName: 'Status', width: 96, ...statusColumn<CatalogueRow>('status', { tones: STATUS_TONES }) },
  { colId: 'stock', headerName: 'Available', width: 110, ...integerColumn<CatalogueRow>('stock') },
  { colId: 'priceCents', headerName: 'Price', width: 110, ...moneyColumn<CatalogueRow>('priceCents', { decimals: true }) },
  { colId: 'salesCents', headerName: 'Sales (7d)', width: 120, ...moneyColumn<CatalogueRow>('salesCents', { zero: 'dash', zeroTitle: 'No sales in the last 7 days' }) },
  { colId: 'units', headerName: 'Units (7d)', width: 100, ...integerColumn<CatalogueRow>('units') },
  { colId: 'updatedAt', headerName: 'Updated', width: 130, ...dateColumn<CatalogueRow>('updatedAt') },
  { ...actionsColumn<CatalogueRow>({ pinned: true, primary: { label: 'Edit', href: () => '#' }, items: () => [{ id: 'a', label: 'Archive' }] }) },
]
const DETAIL_COLS: ColDef<CatalogueRow>[] = [
  { colId: 'name', headerName: 'Product', flex: 1, cellRenderer: 'agGroupCellRenderer', ...textColumn<CatalogueRow>('name') },
  { colId: 'stock', headerName: 'Available', width: 110, ...integerColumn<CatalogueRow>('stock') },
  { colId: 'priceCents', headerName: 'Price', width: 110, ...moneyColumn<CatalogueRow>('priceCents', { decimals: true }) },
]
const DETAIL_PARAMS = {
  detailGridOptions: {
    theme: workspaceGridTheme,
    rowHeight: gridDensity.cozy.rowText,
    headerHeight: gridDensity.cozy.header,
    columnDefs: [
      { colId: 'sku', headerName: 'Variation', width: 200, ...textColumn<CatalogueRow>('sku') },
      { colId: 'stock', headerName: 'Available', width: 110, ...integerColumn<CatalogueRow>('stock') },
      { colId: 'priceCents', headerName: 'Price', width: 110, ...moneyColumn<CatalogueRow>('priceCents', { decimals: true }) },
    ] as ColDef<CatalogueRow>[],
  },
  getDetailRowData: (p: { data: CatalogueRow; successCallback: (rows: CatalogueRow[]) => void }) => p.successCallback(CATALOGUE.filter((r) => r.parentId === p.data.id)),
}
const DETAIL_ROWS = CATALOGUE_PARENTS.slice(0, 8)
const isMaster = (d: CatalogueRow) => isFamilyParent(d)
const EMPTY_ROWS: ReportRow[] = []
const ONE_ROW = REPORT.slice(0, 1)
const NO_ROWS_PARAMS = { title: 'No campaigns match', message: 'Clear a filter, or create the first one.', action: { label: 'New campaign', onClick: () => undefined } }
const LOADING_PARAMS = { rows: 6, media: true }
const LONG_COLS: ColDef<ReportRow>[] = [
  { colId: 'campaign', headerName: 'Campaign', width: 360, ...textColumn<ReportRow>('campaign'), tooltipField: 'campaign' },
  { colId: 'spendCents', headerName: 'Spend', width: 110, ...moneyColumn<ReportRow>('spendCents', { decimals: true }) },
]

/* ── the tab panel scenario ───────────────────────────────────────────────────────────────── */

const TAB_ITEMS = [{ id: 'sp', label: 'Sponsored Products' }, { id: 'sb', label: 'Sponsored Brands' }]

/* ── the probe ────────────────────────────────────────────────────────────────────────────── */

declare global {
  interface Window {
    __gdsProbe?: () => unknown
  }
}

const toHex = (rgb: string): string => {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!m) return rgb
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
}

function probe() {
  const out: Record<string, unknown> = {}
  for (const section of Array.from(document.querySelectorAll<HTMLElement>('[data-gds-scenario]'))) {
    const id = section.dataset.gdsScenario!
    const wrap = section.querySelector<HTMLElement>('.nds-ag-wrap')
    const root = wrap?.querySelector<HTMLElement>('.ag-root-wrapper')
    if (!wrap || !root) continue
    const cs = getComputedStyle(root)
    const v = (n: string) => cs.getPropertyValue(n).trim()
    const headerRow = wrap.querySelector<HTMLElement>('.ag-header-row:not(.ag-header-row-group)')
    const headerCell = wrap.querySelector<HTMLElement>('.ag-header-cell:not([col-id="ag-Grid-SelectionColumn"])')
    const after = headerCell && getComputedStyle(headerCell, '::after')
    const row = wrap.querySelector<HTMLElement>('.ag-row:not(.ag-full-width-row):not(.ag-row-pinned)')
    const cell = row?.querySelector<HTMLElement>('.ag-cell')
    const strip = wrap.querySelector<HTMLElement>('.ag-header-row-group')
    const pinned = wrap.querySelector<HTMLElement>('.ag-row-pinned')
    const thumb = wrap.querySelector<HTMLElement>('.nds-thumb')
    const selCol = wrap.querySelector<HTMLElement>('.ag-header-cell[col-id="ag-Grid-SelectionColumn"]')
    const rowRule = (() => { let n: HTMLElement | null = cell ?? null; while (n && n !== root) { const b = getComputedStyle(n); if (b.borderBottomWidth !== '0px' && !/rgba\(0, 0, 0, 0\)|transparent/.test(b.borderBottomColor)) return toHex(b.borderBottomColor); n = n.parentElement } return null })()
    out[id] = {
      density: wrap.dataset.density, rows: wrap.dataset.rows,
      rowH: row ? Math.round(row.getBoundingClientRect().height * 100) / 100 : null,
      headerH: headerRow ? Math.round(headerRow.getBoundingClientRect().height * 100) / 100 : null,
      stripH: strip ? Math.round(strip.getBoundingClientRect().height * 100) / 100 : null,
      totalsH: pinned ? Math.round(pinned.getBoundingClientRect().height * 100) / 100 : null,
      partitionW: after ? parseFloat(after.width) : null,
      partitionH: after ? Math.round(parseFloat(after.height) * 100) / 100 : null,
      thumbW: thumb ? thumb.getBoundingClientRect().width : null,
      selColW: selCol ? selCol.getBoundingClientRect().width : null,
      cellPadL: cell ? getComputedStyle(cell).paddingLeft : null,
      headerFg: headerCell ? toHex(getComputedStyle(headerCell).color) : null,
      cellFg: cell ? toHex(getComputedStyle(cell).color) : null,
      rowRule,
      bg: toHex(cs.backgroundColor),
      vars: { headerBg: v('--ag-header-background-color'), hover: v('--ag-row-hover-color'), selected: v('--ag-selected-row-background-color'), headerRule: v('--ag-header-row-border'), partition: v('--ag-header-column-border'), totalsBg: v('--ag-pinned-row-background-color') },
      headerFs: headerCell ? getComputedStyle(headerCell).fontSize : null,
      cellFs: cell ? getComputedStyle(cell).fontSize : null,
      stripFg: strip ? toHex(getComputedStyle(strip.querySelector('.ag-header-group-cell')!).color) : null,
      stripBg: strip ? toHex(getComputedStyle(strip).backgroundColor) : null,
    }
  }
  return { viewport: { w: window.innerWidth, h: window.innerHeight }, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', scenarios: out }
}

/* ── the page ─────────────────────────────────────────────────────────────────────────────── */

export function GdsScenarios() {
  const [density, setDensity] = useState<GridDensityName>('spacious')
  const [dark, setDark] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [tab, setTab] = useState('sp')
  const [measured, setMeasured] = useState<string | null>(null)

  useEffect(() => {
    window.__gdsProbe = probe
    return () => { delete window.__gdsProbe }
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    return () => document.documentElement.classList.remove('dark')
  }, [dark])

  const tabRows = useMemo(() => REPORT.filter((r) => r.kind === (tab === 'sp' ? 'SP' : 'SB')), [tab])
  const drawerRows = useMemo(() => REPORT.slice(0, 6), [])
  const groupingSelection = useMemo(() => gridSelection<CatalogueRow>({ isRowSelectable: (n) => !n.group }), [])

  return (
    <GridDensityProvider value={density}>
      <div style={{ display: 'grid', gap: 28 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <GridDensityToggle value={density} onChange={setDensity} />
          <Button size="sm" variant={dark ? 'primary' : 'secondary'} onClick={() => setDark((d) => !d)}>{dark ? 'Dark' : 'Light'}</Button>
          <Button size="sm" variant="secondary" onClick={() => setMeasured(JSON.stringify(probe(), null, 1))}>Measure</Button>
          <span className="nds-cell-muted text-sm">
            <code>window.__gdsProbe()</code> returns what every grid below computed; <code>npm run grid:conformance</code> holds it against <code>design-system/grid/spec.json</code>.
          </span>
        </div>
        {measured && <pre className="text-xs" style={{ margin: 0, maxHeight: 260, overflow: 'auto', background: 'var(--nds-surface-sunken)', padding: 10, borderRadius: 8 }}>{measured}</pre>}

        <CatalogueScenario id="catalogue" title="Catalogue page — SSRM, tree, pagination, autoHeight" hint="The products page's shape: families expand lazily to at most 10 variations in the grid's sort; the page of rows is as tall as the pager says and the PAGE scrolls; tick rows and the toolbar swaps to bulk actions; Export writes the page as CSV." />
        <CatalogueScenario id="family" familyId="p1" title="Family page — one family's variations" hint="The same grid scoped to one family: a flat, paged list of its variations with no tree." />

        <Scenario id="grouping" title="Row grouping with aggregates" hint="Grouped by brand with sum(Available), avg(Price) and sum(Sales) on the group row; the group row cannot be selected. On the products page this is server-side; here the client groups the same fixture.">
          <GridCard>
            <NexusGrid<CatalogueRow> domLayout="autoHeight" rowData={CATALOGUE_PARENTS} getRowId={rowId} columnDefs={GROUP_COLS} autoGroupColumnDef={GROUP_AUTO} rowSelection={groupingSelection} groupDefaultExpanded={1} suppressAggFuncInHeader />
          </GridCard>
        </Scenario>

        <Scenario id="editor" title="A grid inside a modal — the editor: column-group strip, a matrix, pending → Apply" hint={<>Rows × locations under a 30px location strip; a locked FBA group; edits are pending (amber + delta chip) until Apply, and a refused cell stays red with its reason. <Button size="sm" variant="secondary" onClick={() => setEditorOpen(true)}>Open the editor</Button></>}>
          <MatrixEditor open={editorOpen} onClose={() => setEditorOpen(false)} />
        </Scenario>

        <Scenario id="drawer" title="A grid inside a drawer" hint={<>A bounded grid in a DS Drawer, cozy rows. <Button size="sm" variant="secondary" onClick={() => setDrawerOpen(true)}>Open the drawer</Button></>}>
          <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Search terms">
            <GridPanel>
              <NexusGrid<ReportRow> density="cozy" height={380} rowData={drawerRows} getRowId={rowId} columnDefs={REPORT_COLS} />
            </GridPanel>
          </Drawer>
        </Scenario>

        <Scenario id="tabs" title="A grid inside a tab panel" hint="Each tab is a page host: autoHeight, the page scrolls.">
          <Tabs tabs={TAB_ITEMS} active={tab} onChange={setTab} ariaLabel="Campaign type" />
          <GridCard>
            <NexusGrid<ReportRow> domLayout="autoHeight" rowData={tabRows} getRowId={rowId} columnDefs={REPORT_COLS} pinnedBottomRowData={REPORT_TOTALS} />
          </GridCard>
        </Scenario>

        <Scenario id="reporting" title="Read-only reporting grid with a pinned totals row" hint="The campaign cell carries its marks as 20px chips — targeting A/M, programme SP/SB/SD, each with a hover explanation — never as columns of their own. Money in cents through eur(); a percent is a fraction; ACoS with no sales is unmeasured (a dash, no title), zero sales a measured zero (a dash with a title). The totals row is the header's height at every density. The checkbox column is first even though Campaign is pinned.">
          <GridCard toolbar={<GridToolbar count={<><b>{REPORT.length}</b> campaigns</>} right={<Button size="sm"><Download size={13} /> Export</Button>} />}>
            <NexusGrid<ReportRow> domLayout="autoHeight" rowData={REPORT} getRowId={rowId} columnDefs={REPORT_COLS} pinnedBottomRowData={REPORT_TOTALS} rowSelection={REPORT_SELECTION} initialState={REPORT_SORT} />
          </GridCard>
        </Scenario>

        <RoundTripScenario />

        <Scenario id="actions-right" title="A frozen-right actions column" hint="Scroll the grid sideways: Edit and ⋯ stay reachable at the right edge, SKU at the left.">
          <GridCard>
            <NexusGrid<CatalogueRow> density="cozy" domLayout="autoHeight" rowData={DETAIL_ROWS} getRowId={rowId} columnDefs={ACTIONS_COLS} />
          </GridCard>
        </Scenario>

        <Scenario id="detail" title="Expandable detail rows (master / detail)" hint="A family opens a detail grid of its variations under the row — AG's master/detail, on the DS theme at the same density.">
          <GridCard>
            <NexusGrid<CatalogueRow> density="cozy" domLayout="autoHeight" rowData={DETAIL_ROWS} getRowId={rowId} columnDefs={DETAIL_COLS} masterDetail isRowMaster={isMaster} detailCellRendererParams={DETAIL_PARAMS} detailRowAutoHeight />
          </GridCard>
        </Scenario>

        <Scenario id="empty" title="A 0-row grid" hint="The header stays; the empty state says what to do next.">
          <GridCard>
            <NexusGrid<ReportRow> domLayout="autoHeight" rowData={EMPTY_ROWS} getRowId={rowId} columnDefs={REPORT_COLS} noRowsOverlayComponent={GridNoRowsOverlay} noRowsOverlayComponentParams={NO_ROWS_PARAMS} />
          </GridCard>
        </Scenario>

        <Scenario id="one" title="A 1-row grid" hint="Header, one row, the pager's arithmetic still true.">
          <GridCard>
            <NexusGrid<ReportRow> domLayout="autoHeight" rowData={ONE_ROW} getRowId={rowId} columnDefs={REPORT_COLS} />
          </GridCard>
        </Scenario>

        <Scenario id="big" title="A 10,000-row grid" hint="Client-side, bounded and virtualised here (a page host would page it at 500 rows a page — decision 4). Sort a column: 10,000 rows, no lag.">
          <GridCard>
            <NexusGrid<ReportRow> density="compact" height={460} rowData={BIG} getRowId={rowId} columnDefs={REPORT_COLS} rowSelection={REPORT_SELECTION} />
          </GridCard>
        </Scenario>

        <Scenario id="long-text" title="Very long text" hint="A cell never wraps its row taller: ellipsis, the full text on hover.">
          <GridCard>
            <NexusGrid<ReportRow> domLayout="autoHeight" rowData={LONG_TEXT} getRowId={rowId} columnDefs={LONG_COLS} />
          </GridCard>
        </Scenario>

        <Scenario id="loading" title="Loading" hint="The skeleton is drawn at the current density — a loading Spacious grid is the height of a loaded one, so nothing jumps when the data lands.">
          <GridCard>
            <NexusGrid<ReportRow> rows="media" height={gridDensity[density].header + 6 * gridDensity[density].rowMedia + 2} rowData={EMPTY_ROWS} getRowId={rowId} columnDefs={REPORT_COLS} loading loadingOverlayComponent={GridLoadingOverlay} loadingOverlayComponentParams={LOADING_PARAMS} />
          </GridCard>
        </Scenario>

        <Scenario id="keyboard" title="Keyboard-only operation" hint="Tab into the grid, arrow between cells, Space toggles a row's checkbox, Enter opens an editor, Escape leaves it; the header menu opens with Enter on a header cell. AG's ARIA (aria-sort, aria-selected, row/col indexes) is kept intact.">
          <GridCard>
            <NexusGrid<ReportRow> density="cozy" domLayout="autoHeight" rowData={drawerRows} getRowId={rowId} columnDefs={REPORT_COLS} rowSelection={REPORT_SELECTION} suppressCellFocus={false} />
          </GridCard>
        </Scenario>

        <Scenario id="statements" title="Stated, not rendered" hint={<>
          <b>Saved views</b> are server rows (<code>SavedView</code>, surface-keyed) — the lab has no server; the products page is the reference. ·{' '}
          <b>962px and 1440px</b>: the probe records the viewport; the conformance runner measures at both. ·{' '}
          <b>Screen readers</b>: AG's ARIA is kept (<code>role=grid</code>, <code>aria-sort</code>, <code>aria-selected</code>, <code>aria-rowindex</code>); bulk-count announcements are the toolbar's <code>role=status</code>. ·{' '}
          <b>RTL and mobile widths</b> are out of scope for GDS v1 (Q8): the console is desktop, LTR; below 1024px the card scrolls sideways. ·{' '}
          <b>The ads console cannot be verified locally</b> (401 + no CORS): its grids are proven here, from fixtures, and on prod.
        </>} />
      </div>
    </GridDensityProvider>
  )
}
