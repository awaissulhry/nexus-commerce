'use client'

/**
 * `#sheet` — the MASTER SHEET, prototyped on the GDS `GridSheet` from a XAVIA fixture.
 *
 * What it shows (docs/2026-08-29-master-sheet-design.md): one market (IT); parents and their
 * variations as a family tree; frozen identity; column-group strips for Content · IT, Attributes,
 * Identifiers, Pricing · IT, Readiness; a global attribute inherited by variations (tinted) and
 * pinned per variation when edited; cell-by-cell editing with per-cell round trips (saving → saved
 * | refused); validation that WARNS on an off-list value and ERRORS on a cap; a follows-master
 * control beside the market price; per channel × market readiness recomputed on every edit; a
 * Publish action on the selection with per-row results; header-matched paste; ⌘Z.
 *
 * Lab-only: this folder may import `ag-grid-*`.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { CellClassParams, CellValueChangedEvent, ColDef, ColGroupDef, GridApi, GridReadyEvent, ICellRendererParams, IRowNode, ValueGetterParams, ValueSetterParams } from 'ag-grid-community'
import { Download, Search, Upload } from 'lucide-react'

import { Button, Input, Pill } from '@/design-system/primitives'
import {
  CellSaveTracker,
  EmptyValue,
  ExpandButton,
  ExpandSlot,
  FollowsCell,
  GridSearchSlot,
  GridSelectionActions,
  GridSheet,
  GridSheetStatus,
  GridToolbar,
  IdentityChip,
  LongTextCell,
  NexusGrid,
  ReadinessCell,
  SHEET_GRID_OPTIONS,
  SelectionLabel,
  SkuTag,
  euroColumn,
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
  statusColumn,
  type ReadinessValue,
} from '@/design-system/grid'

import { registerLabModules } from './labModules'
import { SHEET_SCHEMA, attrValue, completenessOf, isInherited, makeSheet, readinessOf, type SheetAttr, type SheetRow } from './sheetFixture'

registerLabModules()

const STATUS_TONES = { ACTIVE: { tone: 'success' as const, label: 'Active' }, DRAFT: { tone: 'neutral' as const, label: 'Draft' }, INACTIVE: { tone: 'danger' as const, label: 'Inactive' } }
/** Every round trip the lab made — read by a browser session through `window.__gdsSheet.log`. */
const SAVE_LOG: { id: string; key: string; value: unknown; ok: boolean; reason?: string }[] = []
const CHANNELS = [{ id: 'amazon', label: 'Amazon · IT' }, { id: 'ebay', label: 'eBay · IT' }, { id: 'shopify', label: 'Shopify' }] as const

/** The fake server: 600ms, refuses an EAN that is not 13 digits and a title over Amazon's 200. */
const fakeSave = (key: string, value: unknown) =>
  new Promise<{ ok: boolean; reason?: string }>((res) =>
    setTimeout(() => {
      const s = value == null ? '' : String(value)
      if (key === 'ean' && s && !/^\d{13}$/.test(s)) return res({ ok: false, reason: 'Refused: an EAN is 13 digits' })
      if (key === 'title' && s.length > 200) return res({ ok: false, reason: 'Refused: Amazon caps the title at 200 characters' })
      res({ ok: true })
    }, 600),
  )

function useExpanded(node: IRowNode): boolean {
  const [expanded, setExpanded] = useState(!!node.expanded)
  useMemo(() => {
    const on = () => setExpanded(!!node.expanded)
    node.addEventListener('expandedChanged', on)
    return () => node.removeEventListener('expandedChanged', on)
  }, [node])
  return expanded
}

function ProductCell(p: ICellRendererParams<SheetRow>) {
  const expanded = useExpanded(p.node)
  const d = p.data
  if (!d) return null
  const parent = !d.parentSku
  // A sheet row is ONE line (compact, 28px): the chip and the name; the SKU is its own frozen column.
  return (
    <span className="nds-cell-identity" style={{ gap: 6, alignItems: 'center', minWidth: 0 }}>
      {parent && d.childCount > 0 ? <ExpandButton expanded={expanded} onToggle={() => p.node.setExpanded(!expanded)} labels={['Expand variations', 'Collapse variations']} /> : <ExpandSlot />}
      <IdentityChip label={parent ? 'P' : 'C'} tone={parent ? 'accent' : 'neutral'} tip={parent ? `Parent · ${d.childCount} variations · colour × size` : 'Variation'} />
      <span className={parent ? 'nds-cell-strong' : undefined} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{parent ? d.name : `${d.attrs.color} · ${d.attrs.size}`}</span>
    </span>
  )
}

export function GdsSheetScenario() {
  const [rows, setRows] = useState<SheetRow[]>(() => makeSheet())
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const tracker = useMemo(() => new CellSaveTracker(), [])
  const apiRef = useRef<GridApi<SheetRow> | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState(0)
  const [refused, setRefused] = useState(0)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [published, setPublished] = useState<Record<string, string>>({})

  const refreshCounts = useCallback(() => {
    let p = 0, r = 0
    for (const row of rowsRef.current) for (const a of SHEET_SCHEMA) { const e = tracker.get(row.id, a.key); if (e?.state === 'saving') p++; if (e?.state === 'refused') r++ }
    setPending(p); setRefused(r)
  }, [tracker])

  // A value setter must be SYNCHRONOUS and must change the object AG holds: AG computes
  // `cellValueChanged.newValue` by re-running the value getter on `params.data` right after the
  // setter returns. So the row is mutated in place (AG's own idiom) and React is ticked after.
  const patchRow = useCallback((id: string, mutate: (r: SheetRow) => void) => {
    const row = rowsRef.current.find((r) => r.id === id)
    if (!row) return
    mutate(row)
    const next = [...rowsRef.current]
    rowsRef.current = next
    setRows(next)
  }, [])
  const write = useCallback((row: SheetRow, key: string, value: unknown) => patchRow(row.id, (r) => { r.attrs[key] = value === '' ? null : (value as string) }), [patchRow])

  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent<SheetRow>) => {
      const key = e.colDef.colId ?? ''
      const api = e.api
      void saveCell(api, tracker, e.data.id, key, () => fakeSave(key, e.newValue)).then((o) => {
        SAVE_LOG.push({ id: e.data.id, key, value: e.newValue, ok: o.ok, reason: o.reason })
        if (o.ok) setLastSavedAt(new Date().toISOString())
        refreshCounts()
        // Readiness and completeness are derived from the row — and a PARENT's global value is
        // what every variation inherits — so the row and its whole family repaint.
        const node = api.getRowNode(e.data.id)
        const family = node ? [node, ...(node.childrenAfterGroup ?? [])] : []
        api.refreshCells({ rowNodes: family, force: true })
      })
      refreshCounts()
    },
    [tracker, refreshCounts],
  )

  const columnDefs = useMemo<(ColDef<SheetRow> | ColGroupDef<SheetRow>)[]>(() => {
    const rt = roundTripClassRules<SheetRow>(tracker, (r) => r.id)
    const attrCol = (a: SheetAttr): ColDef<SheetRow> => {
      const base_validation = a.kind === 'select' ? selectValidation<SheetRow>(a.options ?? [], a.mode ?? 'open', !!a.requiredBy?.length) : lengthValidation<SheetRow>(a.maxLength ?? 4000, !!a.requiredBy?.length)
      // A parent has no colour, size or EAN of its own: those cells are LOCKED on it, never flagged.
      const notApplicable = (d: SheetRow) => !d.parentSku && a.scope === 'per_variant'
      const validation: typeof base_validation = { validate: (v, d, key) => (notApplicable(d) ? { level: null } : base_validation.validate(v, d, key)) }
      const rules = sheetClassRules<SheetRow>(validation, (d, key) => isInherited(d, key))
      const classRules = { ...rules, ...rt, 'nds-cell-is-locked': (p: CellClassParams<SheetRow>) => !!p.data && notApplicable(p.data) }
      const base: ColDef<SheetRow> = {
        colId: a.key,
        headerName: a.label + (a.requiredBy?.length ? ' *' : ''),
        headerTooltip: a.requiredBy?.length ? `Required by ${a.requiredBy.join(', ')}` : undefined,
        width: a.width ?? 120,
        valueGetter: (p: ValueGetterParams<SheetRow>) => (p.data ? attrValue(p.data, a.key, rowsRef.current) : null),
        valueSetter: (p: ValueSetterParams<SheetRow>) => { if (!p.data) return false; if (!p.data.parentSku && a.scope === 'per_variant') return false; write(p.data, a.key, p.newValue); return true },
        editable: (p) => !!p.data && !(!p.data.parentSku && a.scope === 'per_variant'),
        cellClassRules: classRules,
        tooltipValueGetter: (p) => { if (!p.data) return ''; const v = validation.validate(p.value, p.data, a.key); if (v.message) return v.message; const e = tracker.get(p.data.id, a.key); if (e?.reason) return e.reason; return isInherited(p.data, a.key) ? 'Inherited from the parent — edit to pin this variation\'s own value' : '' },
        cellClass: (p) => (p.data && notApplicable(p.data) ? 'nds-ag-cell' : 'nds-ag-cell nds-cell-is-editable'),
      }
      if (a.kind === 'select') return { ...base, ...selectEditor((a.options ?? []).map((o) => ({ value: o, label: o }))), cellRenderer: (p: ICellRendererParams<SheetRow>) => (p.value == null || p.value === '' ? (a.requiredBy?.length && !(p.data && !p.data.parentSku && a.scope === 'per_variant') ? <span className="nds-cell-required">⚠ required</span> : <EmptyValue />) : <span>{String(p.value)}</span>) }
      if (a.kind === 'boolean') return { ...base, ...selectEditor([{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]), valueGetter: (p) => (p.data ? (attrValue(p.data, a.key, rowsRef.current) === null ? null : String(attrValue(p.data, a.key, rowsRef.current))) : null), valueSetter: (p) => { if (!p.data) return false; patchRow(p.data.id, (r) => { r.attrs[a.key] = p.newValue === 'true' }); return true }, cellRenderer: (p: ICellRendererParams<SheetRow>) => (p.value == null ? <EmptyValue /> : <span>{p.value === 'true' ? 'Yes' : 'No'}</span>) }
      if (a.kind === 'longtext') return { ...base, ...longTextEditor({ maxLength: Math.max(a.maxLength ?? 2000, 200) }), cellRenderer: LongTextCell, cellRendererParams: { maxLength: a.maxLength, required: !!a.requiredBy?.length } }
      return { ...base, editable: base.editable, cellEditor: 'agTextCellEditor', cellRenderer: (p: ICellRendererParams<SheetRow>) => (p.value == null || p.value === '' ? (a.requiredBy?.length && p.data?.parentSku ? <span className="nds-cell-required">⚠ required</span> : <EmptyValue />) : <span>{String(p.value)}</span>) }
    }
    const groups = new Map<string, SheetAttr[]>()
    for (const a of SHEET_SCHEMA) groups.set(a.group, [...(groups.get(a.group) ?? []), a])
    const attrGroups: ColGroupDef<SheetRow>[] = [...groups.entries()].map(([g, attrs]) => ({ groupId: g, headerName: g, marryChildren: true, children: attrs.map(attrCol) }))

    const identity: ColGroupDef<SheetRow> = {
      groupId: 'identity', headerName: 'Identity', marryChildren: true,
      children: [
        { colId: 'sku', headerName: 'SKU', width: 150, pinned: 'left', lockPinned: true, cellClass: 'nds-ag-cell nds-cell-is-locked', valueGetter: (p) => p.data?.sku ?? null, cellRenderer: (p: ICellRendererParams) => (p.value ? <SkuTag>{p.value}</SkuTag> : <EmptyValue />), headerTooltip: 'The master key — never edited on the sheet' },
        { colId: 'status', headerName: 'Status', width: 96, pinned: 'left', lockPinned: true, ...statusColumn<SheetRow>('status', { tones: STATUS_TONES }), ...selectEditor([{ value: 'ACTIVE', label: 'Active' }, { value: 'DRAFT', label: 'Draft' }, { value: 'INACTIVE', label: 'Inactive' }]), valueSetter: (p) => { if (!p.data) return false; patchRow(p.data.id, (r) => { r.status = p.newValue }); return true } },
        { colId: 'completeness', headerName: 'Master', width: 84, pinned: 'left', lockPinned: true, ...numericColumn, valueGetter: (p) => (p.data ? completenessOf(p.data, rowsRef.current) : null), cellRenderer: (p: ICellRendererParams<SheetRow>) => (p.value == null ? <EmptyValue /> : <span className={p.value === 100 ? 'nds-cell-strong' : p.value < 60 ? 'nds-cell-stock-low' : undefined}>{p.value}%</span>), headerTooltip: 'Master completeness — filled attributes of the applicable schema' },
      ],
    }
    const pricing: ColGroupDef<SheetRow> = {
      groupId: 'pricing', headerName: 'Pricing · IT', marryChildren: true,
      children: [
        { colId: 'basePrice', headerName: 'Base price', width: 100, ...euroColumn<SheetRow>('basePrice'), ...numericEditor({ min: 0, precision: 2, step: 0.5 }), cellClass: [...numericColumn.cellClass, 'nds-cell-is-editable'], cellClassRules: rt, valueSetter: (p) => { if (!p.data) return false; patchRow(p.data.id, (r) => { r.basePrice = Number(p.newValue) }); return true } },
        { colId: 'priceIT', headerName: 'Price · IT', width: 100, ...euroColumn<SheetRow>('priceIT'), valueGetter: (p) => (p.data ? (p.data.priceFollowsMaster ? p.data.basePrice : p.data.priceIT) : null), ...numericEditor({ min: 0, precision: 2, step: 0.5 }), cellClass: [...numericColumn.cellClass, 'nds-cell-is-editable'], cellClassRules: rt, headerTooltip: 'The effective market price. Editing it PINS the market (follows master → pinned).', valueSetter: (p) => { if (!p.data) return false; patchRow(p.data.id, (r) => { r.priceIT = Number(p.newValue); r.priceFollowsMaster = false }); return true } },
        { colId: 'priceFollows', headerName: 'Follows', width: 120, cellClass: 'nds-ag-cell', valueGetter: (p) => p.data?.priceFollowsMaster ?? null, cellRenderer: FollowsCell, ...selectEditor([{ value: 'true', label: 'Follows master' }, { value: 'false', label: 'Pinned' }]), valueSetter: (p) => { if (!p.data) return false; const f = p.newValue === 'true' || p.newValue === true; patchRow(p.data.id, (r) => { r.priceFollowsMaster = f; r.priceIT = f ? null : (r.priceIT ?? r.basePrice) }); return true } },
      ],
    }
    const readiness: ColGroupDef<SheetRow> = {
      groupId: 'readiness', headerName: 'Readiness · IT', marryChildren: true,
      children: CHANNELS.map((c) => ({ colId: `ready:${c.id}`, headerName: c.label, width: 150, cellClass: 'nds-ag-cell', sortable: false, valueGetter: (p: ValueGetterParams<SheetRow>): ReadinessValue | null => (p.data ? readinessOf(p.data, rowsRef.current, c.id) : null), cellRenderer: ReadinessCell, cellClassRules: { 'nds-cell-is-locked': () => true } })),
    }
    const links: ColGroupDef<SheetRow> = {
      groupId: 'links', headerName: 'Channel ids 🔒', marryChildren: true,
      children: [
        { colId: 'asin', headerName: 'ASIN', width: 120, cellClass: 'nds-ag-cell nds-cell-is-locked', valueGetter: (p) => p.data?.refs.amazonAsin ?? null, cellRenderer: (p: ICellRendererParams) => (p.value ? <span className="nds-cell-sku">{p.value}</span> : <EmptyValue />), headerTooltip: 'Synced from the channel — read-only' },
        { colId: 'ebayItem', headerName: 'eBay item', width: 130, cellClass: 'nds-ag-cell nds-cell-is-locked', valueGetter: (p) => p.data?.refs.ebayItemId ?? null, cellRenderer: (p: ICellRendererParams) => (p.value ? <span className="nds-cell-sku">{p.value}</span> : <EmptyValue />) },
        { colId: 'images', headerName: 'Images', width: 80, ...numericColumn, cellClass: [...numericColumn.cellClass, 'nds-cell-is-locked'], valueGetter: (p) => (p.data && !p.data.parentSku ? p.data.imageCount : null), headerTooltip: 'The master gallery — edited in the product, not here' },
      ],
    }
    return [identity, ...attrGroups, pricing, readiness, links]
  }, [tracker, write, patchRow])

  const autoGroupColumnDef = useMemo<ColDef<SheetRow>>(() => ({ headerName: 'Product', colId: 'product', pinned: 'left', lockPinned: true, lockPosition: 'left', width: 300, cellRenderer: ProductCell, cellClass: 'nds-ag-cell', sortable: true, suppressHeaderMenuButton: true }), [])
  const getDataPath = useCallback((d: SheetRow) => (d.parentSku ? [d.parentSku, d.sku] : [d.sku]), [])
  const getRowId = useCallback((p: { data: SheetRow }) => p.data.id, [])
  const rowSelection = useMemo(() => gridSelection<SheetRow>(), [])
  const onSelectionChanged = useCallback((e: { api: GridApi<SheetRow> }) => setSelected(e.api.getSelectedNodes().map((n) => n.data!.id)), [])
  const onGridReady = useCallback((e: GridReadyEvent<SheetRow>) => {
    apiRef.current = e.api
    // Lab probe: the conformance runner and a browser session read the tracker and the API here.
    ;(window as unknown as { __gdsSheet?: unknown }).__gdsSheet = { api: e.api, tracker, rows: () => rowsRef.current, log: SAVE_LOG }
  }, [tracker])
  const processDataFromClipboard = useMemo(() => sheetPasteProcessor<SheetRow>(SHEET_SCHEMA.map((a) => ({ colId: a.key, headerName: a.label }))), [])
  const defaultColDef = useMemo<ColDef<SheetRow>>(() => ({ sortable: false, resizable: true, suppressHeaderMenuButton: true }), [])
  const rowClassRules = useMemo(() => ({ 'nds-ag-clickable': () => false }), [])

  const publish = useCallback((channel: (typeof CHANNELS)[number]) => {
    const api = apiRef.current
    if (!api) return
    const ids = selected.length ? selected : rowsRef.current.map((r) => r.id)
    const results: Record<string, string> = {}
    for (const id of ids) {
      const row = rowsRef.current.find((r) => r.id === id)!
      const r = readinessOf(row, rowsRef.current, channel.id)
      if (r.state === 'errors' || r.state === 'missing') {
        results[id] = `${channel.label}: refused — ${r.issues[0]}`
        continue
      }
      results[id] = `${channel.label}: published`
      // The channel answers with ITS id; the readiness cell then reads `Live · <id>` from the row.
      if (channel.id === 'amazon' && !row.refs.amazonAsin) row.refs.amazonAsin = `B0${Math.floor(Math.random() * 9e7 + 1e7)}`
      if (channel.id === 'ebay' && !row.refs.ebayItemId) row.refs.ebayItemId = `1${Math.floor(Math.random() * 9e10)}`
      if (channel.id === 'shopify' && !row.refs.shopifyId) row.refs.shopifyId = `${Math.floor(Math.random() * 9e9)}`
    }
    setPublished((prev) => ({ ...prev, ...results }))
    api.refreshCells({ rowNodes: ids.map((id) => api.getRowNode(id)).filter((n): n is IRowNode<SheetRow> => !!n), columns: ['ready:amazon', 'ready:ebay', 'ready:shopify', 'asin', 'ebayItem'], force: true })
    api.deselectAll()
  }, [selected])

  const clear = useCallback(() => apiRef.current?.deselectAll(), [])

  return (
    <GridSheet
      height={640}
      toolbar={
        <GridToolbar
          count={selected.length ? <>Selected <b>{selected.length}</b> {selected.length === 1 ? 'row' : 'rows'}</> : <><b>{rows.filter((r) => !r.parentSku).length}</b> products · <b>{rows.length - rows.filter((r) => !r.parentSku).length}</b> variations · market <b>IT</b></>}
          right={
            <>
              {CHANNELS.map((c) => (
                <Button key={c.id} size="sm" variant={selected.length ? 'primary' : 'secondary'} onClick={() => publish(c)} title={`Publish ${selected.length ? 'the selection' : 'every ready row'} to ${c.label}`}>
                  <Upload size={13} /> <SelectionLabel>{c.label}</SelectionLabel>
                </Button>
              ))}
              <Button size="sm" onClick={() => apiRef.current?.exportDataAsCsv({ fileName: 'master-sheet-IT.csv' })}><Download size={13} /> Export</Button>
            </>
          }
        >
          {selected.length ? (
            <GridSelectionActions>
              <Button size="sm" disabled title="Bulk set for the selection — designed, not built in the lab">Set for selection…</Button>
              <Button size="sm" variant="link" onClick={clear}>Clear</Button>
            </GridSelectionActions>
          ) : (
            <GridSearchSlot>
              <Input leadingIcon={<Search size={13} />} placeholder="Find a SKU, a title, a value…" aria-label="Find" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%' }} />
            </GridSearchSlot>
          )}
        </GridToolbar>
      }
      footer={
        <GridSheetStatus rows={rows.length} selected={selected.length} pending={pending} refused={refused} lastSavedAt={lastSavedAt}>
          {Object.keys(published).length > 0 && <Pill tone="neutral" size="sm">{Object.values(published).filter((v) => v.endsWith('published')).length} published · {Object.values(published).filter((v) => v.includes('refused')).length} refused</Pill>}
          <span className="nds-cell-muted">Type to edit · F2 · Enter ↓ · Tab → · drag the corner to fill · paste a block from Excel (headers are matched by name) · ⌘Z</span>
        </GridSheetStatus>
      }
    >
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
        quickFilterText={search}
        rowClassRules={rowClassRules}
        tooltipShowDelay={300}
        singleClickEdit={false}
      />
    </GridSheet>
  )
}
