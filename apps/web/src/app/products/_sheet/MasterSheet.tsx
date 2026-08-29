'use client'

/**
 * MS.3 — the MASTER SHEET, on live data, for one market.
 *
 * `docs/2026-08-29-master-sheet-design.md`. Self-contained on purpose: where this lives is still the
 * Owner's open question (§8.3), so it takes a market and nothing else and can be mounted anywhere —
 * a tab on /products, a route, the grid lab — without changing a line inside it.
 *
 *   <MasterSheet market="IT" />
 *
 * What it puts on screen: a page of FAMILIES (a parent and its variations, never split), the master
 * attributes this market's channels actually read, each cell showing whether it is the row's own,
 * the parent's (tinted) or absent, and beside them what each channel would do with the row right
 * now. Every edit autosaves on its own and paints the server's answer on that cell.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'

import { Button, Input, InfoTip, Pill, SegmentedControl } from '@/design-system/primitives'
import {
  CellSaveTracker,
  EmptyValue,
  ExpandButton,
  ExpandSlot,
  GridPager,
  GridSearchSlot,
  GridSheet,
  GridSheetStatus,
  GridToolbar,
  IdentityChip,
  LongTextCell,
  NexusGrid,
  ReadinessCell,
  SHEET_GRID_OPTIONS,
  SkuTag,
  gridSelection,
  lengthValidation,
  longTextEditor,
  numericColumn,
  numericEditor,
  roundTripClassRules,
  saveCell,
  selectEditor,
  selectValidation,
  sheetClassRules,
  sheetPasteProcessor,
  type ColDef,
  type ColGroupDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type IRowNode,
  type ReadinessValue,
  type ValueGetterParams,
  type ValueSetterParams,
} from '@/design-system/grid'

import { coordKey, type SheetColumn, type SheetRow } from './types'
import { saveSheetCell, useMasterSheet } from './useMasterSheet'

const PAGE_SIZES = [10, 25, 50, 100]

export interface MasterSheetProps {
  /** The market this sheet edits, e.g. `IT`. */
  market?: string
  /** Height when embedded in a page that keeps scrolling (a lab, a wizard step). */
  height?: number
  onMarketChange?: (market: string) => void
}

/** AG re-renders a cell renderer on expand; the node's own event is the only reliable source. */
function useExpanded(node: IRowNode): boolean {
  const [expanded, setExpanded] = useState(!!node.expanded)
  useEffect(() => {
    const on = () => setExpanded(!!node.expanded)
    node.addEventListener('expandedChanged', on)
    return () => node.removeEventListener('expandedChanged', on)
  }, [node])
  return expanded
}

/**
 * The tree control and nothing else. The name is an EDITABLE column — a sheet whose whole point is
 * editing must not spend 300px repeating it read-only beside the cell that writes it.
 */
function ProductCell(p: ICellRendererParams<SheetRow>) {
  const expanded = useExpanded(p.node)
  const d = p.data
  if (!d) return null
  const parent = d.isParent
  return (
    <span className="nds-cell-identity" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
      {parent && d.childCount > 0 ? (
        <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand variations', 'Collapse variations']} />
      ) : (
        <ExpandSlot />
      )}
      <IdentityChip
        label={parent ? 'P' : 'C'}
        tone={parent ? 'accent' : 'neutral'}
        tip={parent ? `Parent · ${d.childCount} ${d.childCount === 1 ? 'variation' : 'variations'}` : 'Variation'}
      />
    </span>
  )
}

export function MasterSheet({ market: marketProp, height, onMarketChange }: MasterSheetProps) {
  const [market, setMarket] = useState(marketProp ?? 'IT')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState(0)
  const [refused, setRefused] = useState(0)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

  useEffect(() => { if (marketProp) setMarket(marketProp) }, [marketProp])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => { setPage(1) }, [market, debounced, limit])

  const { data, loading, error, reload, applyLocal } = useMasterSheet({ market, page, limit, search: debounced })
  const tracker = useMemo(() => new CellSaveTracker(), [])
  const apiRef = useRef<GridApi<SheetRow> | null>(null)
  const dataRef = useRef(data)
  dataRef.current = data

  const refreshCounts = useCallback(() => {
    const d = dataRef.current
    if (!d) return
    let p = 0
    let r = 0
    for (const row of d.rows) {
      for (const col of d.columns) {
        const e = tracker.get(row.id, col.key)
        if (e?.state === 'saving') p++
        if (e?.state === 'refused') r++
      }
    }
    setPending(p)
    setRefused(r)
  }, [tracker])

  const columnDefs = useMemo<(ColDef<SheetRow> | ColGroupDef<SheetRow>)[]>(() => {
    if (!data) return []
    const rt = roundTripClassRules<SheetRow>(tracker, (r) => r.id)
    const locale = data.locale

    /** A cell is not applicable when a parent has no per-variant value, or the type differs. */
    const applies = (row: SheetRow, col: SheetColumn) => {
      if (row.isParent && col.scope === 'per_variant') return false
      if (col.applicableProductTypes?.length) {
        const pt = (row.productType ?? '').toUpperCase()
        if (!pt || !col.applicableProductTypes.map((t) => t.toUpperCase()).includes(pt)) return false
      }
      return true
    }
    const requiredHere = (row: SheetRow, col: SheetColumn) => {
      if (col.requiredBy.length === 0) return false
      if (col.requiredForProductTypes?.length) {
        const pt = (row.productType ?? '').toUpperCase()
        return !!pt && col.requiredForProductTypes.map((t) => t.toUpperCase()).includes(pt)
      }
      return true
    }

    const build = (col: SheetColumn): ColDef<SheetRow> => {
      const base = col.kind === 'select'
        ? selectValidation<SheetRow>(col.options ?? [], col.mode ?? 'open', col.requiredBy.length > 0)
        : lengthValidation<SheetRow>(col.maxLength ?? 4000, col.requiredBy.length > 0, !!col.maxBytes)
      // Warn-never-block, and never flag a cell that does not apply to this row.
      const validation = { validate: (v: unknown, d: SheetRow, key: string) => (applies(d, col) ? base.validate(v, d, key) : { level: null as null }) }

      const rules = sheetClassRules<SheetRow>(validation, (d, key) => !!d.values[key]?.inherited)
      const editable = (p: { data?: SheetRow }) => !!p.data && col.editable && applies(p.data, col)

      const def: ColDef<SheetRow> = {
        colId: col.key,
        headerName: col.label + (col.requiredBy.length > 0 ? ' *' : ''),
        headerTooltip: [
          col.requiredBy.length > 0 ? `Required by ${col.requiredBy.join(', ')}` : null,
          col.maxLength ? `Max ${col.maxLength} characters${col.capFrom ? ` (${col.capFrom})` : ''}` : null,
          col.maxBytes ? `Max ${col.maxBytes} bytes` : null,
          col.helpText,
        ].filter(Boolean).join(' · ') || undefined,
        width: col.width ?? (col.kind === 'longtext' ? 240 : 140),
        editable,
        valueGetter: (p: ValueGetterParams<SheetRow>) => (p.data ? p.data.values[col.key]?.value ?? null : null),
        valueSetter: (p: ValueSetterParams<SheetRow>) => {
          if (!p.data || !applies(p.data, col)) return false
          // AG re-reads `newValue` from params.data right after this returns — mutate, don't schedule.
          p.data.values = { ...p.data.values, [col.key]: { value: p.newValue, source: 'master', inheritedFrom: null, inherited: false } }
          return true
        },
        cellClass: (p) => (p.data && !applies(p.data, col) ? 'nds-ag-cell nds-cell-is-locked' : 'nds-ag-cell nds-cell-is-editable'),
        cellClassRules: { ...rules, ...rt },
        tooltipValueGetter: (p) => {
          if (!p.data) return ''
          const entry = tracker.get(p.data.id, col.key)
          if (entry?.reason) return entry.reason
          const v = validation.validate(p.value, p.data, col.key)
          if (v.message) return v.message
          if (p.data.values[col.key]?.inherited) return 'Inherited from the parent — edit to give this variation its own value'
          if (!applies(p.data, col)) return p.data.isParent ? 'Belongs to each variation, not to the parent' : `Not part of ${p.data.productType ?? 'this product type'}`
          return ''
        },
      }

      if (col.kind === 'select') {
        const opts = (col.options ?? []).map((o) => ({ value: o, label: col.optionLabels?.[o] ?? o }))
        return {
          ...def,
          ...selectEditor(opts),
          editable,
          cellRenderer: (p: ICellRendererParams<SheetRow>) => {
            if (p.value != null && p.value !== '') return <span>{col.optionLabels?.[String(p.value)] ?? String(p.value)}</span>
            if (p.data && applies(p.data, col) && requiredHere(p.data, col)) return <span className="nds-cell-required">⚠ required</span>
            return <EmptyValue />
          },
        }
      }
      if (col.kind === 'longtext') {
        return {
          ...def,
          ...longTextEditor({ maxLength: Math.max(col.maxLength ?? 2000, 200) }),
          editable,
          cellRenderer: LongTextCell,
          cellRendererParams: { maxLength: col.maxLength, countBytes: !!col.maxBytes, required: col.requiredBy.length > 0 },
        }
      }
      if (col.kind === 'number') {
        return {
          ...def,
          ...numericColumn,
          ...numericEditor({ min: 0, precision: 2 }),
          editable,
          cellClass: (p) => [...numericColumn.cellClass, p.data && applies(p.data, col) ? 'nds-cell-is-editable' : 'nds-cell-is-locked'].join(' '),
        }
      }
      if (col.kind === 'boolean') {
        return {
          ...def,
          ...selectEditor([{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]),
          editable,
          valueGetter: (p) => { const v = p.data?.values[col.key]?.value; return v == null ? null : String(v) },
          cellRenderer: (p: ICellRendererParams<SheetRow>) => (p.value == null ? <EmptyValue /> : <span>{p.value === 'true' ? 'Yes' : 'No'}</span>),
        }
      }
      return {
        ...def,
        cellEditor: 'agTextCellEditor',
        editable,
        cellRenderer: (p: ICellRendererParams<SheetRow>) => {
          if (p.value != null && p.value !== '') return <span>{String(p.value)}</span>
          if (p.data && applies(p.data, col) && requiredHere(p.data, col)) return <span className="nds-cell-required">⚠ required</span>
          return <EmptyValue />
        },
      }
    }

    const visible = data.columns.filter((c) => c.defaultVisible)
    const groups = new Map<string, SheetColumn[]>()
    for (const c of visible) groups.set(c.group, [...(groups.get(c.group) ?? []), c])

    const identity: ColGroupDef<SheetRow> = {
      groupId: 'identity',
      headerName: 'Identity',
      marryChildren: true,
      children: [
        { colId: 'sku', headerName: 'SKU', width: 170, pinned: 'left', lockPinned: true, cellClass: 'nds-ag-cell nds-cell-is-locked', valueGetter: (p) => p.data?.sku ?? null, cellRenderer: (p: ICellRendererParams) => (p.value ? <SkuTag>{p.value}</SkuTag> : <EmptyValue />), headerTooltip: 'The master key — never edited on the sheet' },
        { colId: 'completeness', headerName: 'Master', width: 86, pinned: 'left', lockPinned: true, ...numericColumn, valueGetter: (p) => p.data?.completeness.overall.pct ?? null, headerTooltip: 'Filled ÷ applicable master attributes', cellRenderer: (p: ICellRendererParams<SheetRow>) => (p.value == null ? <EmptyValue /> : <span className={p.value === 100 ? 'nds-cell-strong' : p.value < 40 ? 'nds-cell-stock-low' : undefined}>{p.value}%</span>) },
      ],
    }

    // The pinned pair keeps the group name "Identity"; everything else the API filed under Identity
    // becomes "Master". A `marryChildren` group that straddles the pinned boundary is rendered TWICE
    // by AG — measured on real data as two adjacent IDENTITY headers.
    const attrGroups: ColGroupDef<SheetRow>[] = [...groups.entries()]
      .map(([g, cols]) => [g === 'Identity' ? 'Master' : g, cols] as const)
      .map(([g, cols]) => ({
        groupId: g,
        headerName: g === 'Content' ? `Content · ${locale.toUpperCase()}` : g,
        marryChildren: true,
        children: cols.filter((c) => c.key !== 'sku').map(build),
      }))
      .filter((g) => g.children.length > 0)

    const readiness: ColGroupDef<SheetRow> = {
      groupId: 'readiness',
      headerName: `Readiness · ${data.market}`,
      marryChildren: true,
      children: data.coordinates.map((c) => ({
        colId: `ready:${coordKey(c)}`,
        headerName: c.label,
        width: 160,
        sortable: false,
        cellClass: 'nds-ag-cell nds-cell-is-locked',
        valueGetter: (p: ValueGetterParams<SheetRow>): ReadinessValue | null => {
          const r = p.data?.readiness[coordKey(c)]
          if (!r) return null
          return { state: r.state, issues: r.issues.map((i) => i.message), ref: r.ref }
        },
        cellRenderer: ReadinessCell,
      })),
    }

    return [identity, ...attrGroups, readiness]
  }, [data, tracker])

  const onCellValueChanged = useCallback(
    (e: { data: SheetRow; colDef: { colId?: string }; api: GridApi<SheetRow>; newValue: unknown }) => {
      const d = dataRef.current
      const colId = e.colDef.colId
      if (!d || !colId) return
      const column = d.columns.find((c) => c.key === colId)
      if (!column) return

      void saveCell(e.api, tracker, e.data.id, colId, () => saveSheetCell({ row: e.data, column, value: e.newValue, locale: d.locale })).then((o) => {
        if (o.ok) {
          setLastSavedAt(new Date().toISOString())
          applyLocal(e.data.id, (row) => { row.values[colId] = { value: e.newValue, source: 'master', inheritedFrom: null, inherited: false } })
        }
        refreshCounts()
        // Readiness and completeness are derived from the row, and a PARENT's value is what every
        // variation inherits — so the row and its whole family repaint.
        const node = e.api.getRowNode(e.data.id)
        const family = node ? [node, ...(node.childrenAfterGroup ?? [])] : []
        if (family.length) e.api.refreshCells({ rowNodes: family, force: true })
      })
      refreshCounts()
    },
    [tracker, refreshCounts, applyLocal],
  )

  const rows = data?.rows ?? []
  const getRowId = useCallback((p: { data: SheetRow }) => p.data.id, [])
  const getDataPath = useCallback((d: SheetRow) => (d.parentId ? [d.parentId, d.id] : [d.id]), [])
  const autoGroupColumnDef = useMemo<ColDef<SheetRow>>(() => ({ headerName: '', colId: 'product', pinned: 'left', lockPinned: true, lockPosition: 'left', width: 76, cellRenderer: ProductCell, cellClass: 'nds-ag-cell', suppressHeaderMenuButton: true, headerTooltip: 'Family — a parent and its variations' }), [])
  const rowSelection = useMemo(() => gridSelection<SheetRow>(), [])
  const defaultColDef = useMemo<ColDef<SheetRow>>(() => ({ sortable: false, resizable: true, suppressHeaderMenuButton: true }), [])
  const onSelectionChanged = useCallback((e: { api: GridApi<SheetRow> }) => setSelected(e.api.getSelectedNodes().map((n) => n.data!.id)), [])
  const onGridReady = useCallback((e: GridReadyEvent<SheetRow>) => { apiRef.current = e.api }, [])
  const processDataFromClipboard = useMemo(
    () => sheetPasteProcessor<SheetRow>((data?.columns ?? []).filter((c) => c.defaultVisible).map((c) => ({ colId: c.key, headerName: c.label }))),
    [data],
  )
  const markets = data?.availableMarkets ?? []
  const marketOptions = useMemo(() => markets.map((m) => ({ value: m, label: m })), [markets])

  const switchMarket = useCallback((next: string) => {
    setMarket(next)
    onMarketChange?.(next)
  }, [onMarketChange])

  const staleTypes = data?.schemaAge.filter((a) => Date.now() - new Date(a.fetchedAt).getTime() > 7 * 864e5) ?? []

  return (
    <GridSheet
      height={height}
      toolbar={
        <GridToolbar
          count={
            selected.length > 0 ? (
              <>Selected <b>{selected.length}</b> {selected.length === 1 ? 'row' : 'rows'}</>
            ) : (
              <>
                <b>{data?.total ?? 0}</b> {data?.total === 1 ? 'product' : 'products'} · <b>{rows.length}</b> rows on this page · market <b>{market}</b>
              </>
            )
          }
          right={
            <>
              {marketOptions.length > 1 && (
                <SegmentedControl size="sm" options={marketOptions} value={market} onChange={switchMarket} ariaLabel="Market" />
              )}
              {(staleTypes.length > 0 || (data?.schemaMissing.length ?? 0) > 0) && (
                <InfoTip
                  tip={
                    data && data.schemaMissing.length > 0
                      ? `No cached Amazon schema for ${data.schemaMissing.join(', ')} — those columns carry no length caps or closed lists.`
                      : `Length caps and lists come from a schema last fetched ${staleTypes.map((t) => `${t.productType} ${t.fetchedAt.slice(0, 10)}`).join(', ')}.`
                  }
                >
                  <Pill tone="warning" size="sm"><AlertTriangle size={11} /> caps</Pill>
                </InfoTip>
              )}
              <Button size="sm" onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Reload'}</Button>
            </>
          }
        >
          <GridSearchSlot>
            <Input leadingIcon={<Search size={13} />} placeholder="Find a SKU or a name…" aria-label="Find" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%' }} />
          </GridSearchSlot>
        </GridToolbar>
      }
      footer={
        <>
          <GridPager
            page={page}
            pageCount={Math.max(1, Math.ceil((data?.total ?? 0) / limit))}
            pageSize={limit}
            onPage={setPage}
            onPageSize={setLimit}
            pageSizes={PAGE_SIZES}
            left={<span className="nds-cell-muted">{data ? `${data.total} ${data.total === 1 ? 'product' : 'products'} · families per page` : ''}</span>}
          />
          <GridSheetStatus rows={rows.length} selected={selected.length} pending={pending} refused={refused} lastSavedAt={lastSavedAt}>
            <span className="nds-cell-muted">Type to edit · F2 · Enter ↓ · Tab → · drag the corner to fill · ⌘Z</span>
          </GridSheetStatus>
        </>
      }
    >
      {error ? (
        <div style={{ padding: 24, color: 'var(--nds-danger-text)' }}>
          Could not load the sheet: {error}{' '}
          <Button size="sm" onClick={reload}>Try again</Button>
        </div>
      ) : (
        <NexusGrid<SheetRow>
          fill
          {...SHEET_GRID_OPTIONS}
          rowData={rows}
          getRowId={getRowId}
          treeData
          flatTree
          getDataPath={getDataPath}
          groupDefaultExpanded={-1}
          autoGroupColumnDef={autoGroupColumnDef}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          groupHeaderHeight={30}
          rowSelection={rowSelection}
          onSelectionChanged={onSelectionChanged}
          onGridReady={onGridReady}
          onCellValueChanged={onCellValueChanged}
          processDataFromClipboard={processDataFromClipboard}
          loading={loading}
          tooltipShowDelay={300}
        />
      )}
    </GridSheet>
  )
}

export default MasterSheet
