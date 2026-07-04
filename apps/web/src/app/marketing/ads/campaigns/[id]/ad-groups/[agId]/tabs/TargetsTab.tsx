'use client'

/**
 * Targets tab (Ad Group page) — the ad group's keyword/product targets rendered through the
 * shared <AdsDataGrid> (same component as the campaign grids, so they stay in lockstep). Data
 * is adGroup.targets[] (raw AdTarget rows, isNegative = false; metrics in cents). Columns +
 * filters match the H10 Targets grid; the long-tail (Kindle / NTB-* / SameSKU-* / etc.) is
 * hidden-by-default + available via Customize — parity placeholders where Amazon exposes no
 * per-target source, exactly as the campaign grids treat them. Edit Targets inline-edits
 * Status + Bid (PATCH /advertising/ad-targets/:id; status + bid sync to Amazon, deploy-gated).
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { AddKeywordsTargetsModal } from './AddKeywordsTargetsModal'
import { AdsDataGrid, type GridColumn, type GridFilter, type GridEditMode } from '../../../../_grid/AdsDataGrid'
import { num, eur, int, STATUS_PILL, latestReportLabel, METRIC_TIPS } from '../../../../_grid/format'
import { pickMetricFilters } from '../../../../_grid/filters'
import { bulkPatch, AdjustBidModal } from '../../../../_grid/bulkActions'
import { H10Select, StatusOptions, AD_STATUS_OPTS } from '../../../../FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'
import type { AdGroupDetailData } from '../AdGroupDetail'

interface TargetRow {
  id: string
  expressionValue: string
  expressionType?: string | null
  kind?: string | null
  status: string
  bidCents?: number | null
  isNegative?: boolean
  impressions?: number
  clicks?: number
  spendCents?: number
  salesCents?: number
  ordersCount?: number
  lastSyncedAt?: string | null
}

const spendOf = (r: TargetRow) => num(r.spendCents) / 100
const salesOf = (r: TargetRow) => num(r.salesCents) / 100
const acosOf = (r: TargetRow) => { const s = salesOf(r); return s ? (spendOf(r) / s) * 100 : 0 }
const roasOf = (r: TargetRow) => { const sp = spendOf(r); return sp ? salesOf(r) / sp : 0 }
const ctrOf = (r: TargetRow) => { const i = num(r.impressions); return i ? (num(r.clicks) / i) * 100 : 0 }
const cpcOf = (r: TargetRow) => { const c = num(r.clicks); return c ? spendOf(r) / c : 0 }
const cvrOf = (r: TargetRow) => { const c = num(r.clicks); return c ? (num(r.ordersCount) / c) * 100 : 0 }
const DASH = () => '—'
const TYPE_LABEL: Record<string, string> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad', ASIN: 'Product', CATEGORY: 'Category', CATEGORY_REFINEMENT: 'Category' }

export function TargetsTab({ adGroup, onRefresh }: { adGroup: AdGroupDetailData | null; onRefresh?: () => void }) {
  const rows = useMemo<TargetRow[]>(() => ((adGroup?.targets as TargetRow[] | undefined) ?? []).filter((t) => !t.isNegative), [adGroup])

  // ER4 F2 — totals compute from the grid's FILTERED rows (function-form total)
  const tot = (vr: typeof rows) => vr.reduce(
    (a, r) => ({ spend: a.spend + spendOf(r), sales: a.sales + salesOf(r), impr: a.impr + num(r.impressions), clicks: a.clicks + num(r.clicks), orders: a.orders + num(r.ordersCount) }),
    { spend: 0, sales: 0, impr: 0, clicks: 0, orders: 0 },
  )

  const columns: GridColumn<TargetRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { const sp = STATUS_PILL[r.status] ?? { label: r.status, cls: '' }; return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span> }, total: '' },
    { key: 'bid', label: 'Bid', render: (r) => eur(num(r.bidCents) / 100), sortValue: (r) => num(r.bidCents), filterValue: (r) => num(r.bidCents) / 100, total: '' },
    { key: 'spend', label: 'Spend', tip: METRIC_TIPS.spend, render: (r) => eur(spendOf(r)), sortValue: spendOf, filterValue: spendOf, total: (vr) => { const T = tot(vr); return eur(T.spend) } },
    { key: 'sales', label: 'Sales', tip: METRIC_TIPS.sales, render: (r) => eur(salesOf(r)), sortValue: salesOf, filterValue: salesOf, total: (vr) => { const T = tot(vr); return eur(T.sales) } },
    { key: 'acos', label: 'ACoS', tip: METRIC_TIPS.acos, render: (r) => <span className="h10-acos">{salesOf(r) ? `${acosOf(r).toFixed(2)}%` : '-%'}<i className="dot" /></span>, sortValue: acosOf, filterValue: acosOf, total: (vr) => { const T = tot(vr); return <span className="h10-acos">{T.sales ? `${((T.spend / T.sales) * 100).toFixed(2)}%` : '-%'}<i className="dot" /></span> } },
    { key: 'roas', label: 'ROAS', tip: METRIC_TIPS.roas, render: (r) => (roasOf(r) ? roasOf(r).toFixed(2) : '0'), sortValue: roasOf, filterValue: roasOf, total: (vr) => { const T = tot(vr); return (T.spend && T.sales) ? (T.sales / T.spend).toFixed(2) : '0' } },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (r) => int(r.impressions), sortValue: (r) => num(r.impressions), filterValue: (r) => num(r.impressions), total: (vr) => { const T = tot(vr); return int(T.impr) } },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (r) => int(r.clicks), sortValue: (r) => num(r.clicks), filterValue: (r) => num(r.clicks), total: (vr) => { const T = tot(vr); return int(T.clicks) } },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (r) => `${ctrOf(r).toFixed(2)}%`, sortValue: ctrOf, filterValue: ctrOf, total: (vr) => { const T = tot(vr); return `${(T.impr ? (T.clicks / T.impr) * 100 : 0).toFixed(2)}%` } },
    { key: 'cpc', label: 'CPC', tip: METRIC_TIPS.cpc, render: (r) => eur(cpcOf(r)), sortValue: cpcOf, filterValue: cpcOf, total: (vr) => { const T = tot(vr); return eur(T.clicks ? T.spend / T.clicks : 0) } },
    { key: 'ppcOrders', label: 'PPC Orders', tip: METRIC_TIPS.ppcOrders, render: (r) => int(r.ordersCount), sortValue: (r) => num(r.ordersCount), filterValue: (r) => num(r.ordersCount), total: (vr) => { const T = tot(vr); return int(T.orders) } },
    { key: 'cvr', label: 'CVR', tip: METRIC_TIPS.cvr, render: (r) => `${cvrOf(r).toFixed(2)}%`, sortValue: cvrOf, filterValue: cvrOf, total: (vr) => { const T = tot(vr); return `${(T.clicks ? (T.orders / T.clicks) * 100 : 0).toFixed(2)}%` } },
    { key: 'kindleReads', label: 'Kindle Reads', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'kindleRoyalties', label: 'Kindle Royalties', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'saleUnits', label: 'Sale Units', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'cpa', label: 'CPA', tip: 'Cost per acquisition = spend ÷ orders', defaultHidden: true, render: (r) => (num(r.ordersCount) ? eur(spendOf(r) / num(r.ordersCount)) : '—'), sortValue: (r) => (num(r.ordersCount) ? spendOf(r) / num(r.ordersCount) : 0), total: (vr) => { const T = tot(vr); return T.orders ? eur(T.spend / T.orders) : '—' } },
    { key: 'viewImpr', label: 'View Impr.', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'aov', label: 'AOV', tip: 'Average order value = sales ÷ orders', defaultHidden: true, render: (r) => (num(r.ordersCount) ? eur(salesOf(r) / num(r.ordersCount)) : '—'), sortValue: (r) => (num(r.ordersCount) ? salesOf(r) / num(r.ordersCount) : 0), total: (vr) => { const T = tot(vr); return T.orders ? eur(T.sales / T.orders) : '—' } },
    { key: 'asp', label: 'ASP', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'otherSales', label: 'Other Sales', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'otherSalesPct', label: 'Other Sales %', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbOrders', label: 'NTB-Orders', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbOrdersPct', label: 'NTB-Orders%', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbOrderRate', label: 'NTB-OrderRate', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbSales', label: 'NTB-Sales', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbSalesPct', label: 'NTB-Sales%', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbUnits', label: 'NTB-Units', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbUnitsPct', label: 'NTB-Units%', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'sameSkuSales', label: 'SameSKU Sales', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'sameSkuSaleUnits', label: 'SameSKU Sale Units', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'sameSkuOrders', label: 'SameSKU Orders', defaultHidden: true, sortable: false, render: DASH, total: '—' },
  ], [])

  const tgtNames = useMemo(() => Array.from(new Set(rows.map((r) => r.expressionValue))), [rows])
  const types = useMemo(() => Array.from(new Set(rows.map((r) => r.expressionType).filter(Boolean) as string[])), [rows])
  const filters: GridFilter[] = useMemo(() => [
    { key: 'target', label: 'Target', kind: 'select', wide: true, searchable: true, placeholder: 'Select a Target', options: tgtNames.map((n) => ({ value: n, label: n })), value: (r) => (r as TargetRow).expressionValue },
    { key: 'status', label: 'Status', kind: 'multiselect', options: [{ value: 'ARCHIVED', label: 'Archived' }, { value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }], placeholder: 'Select Status', value: (r) => (r as TargetRow).status },
    { key: 'targetingType', label: 'Targeting Type', kind: 'multiselect', options: (types.length ? types : ['EXACT', 'PHRASE', 'BROAD', 'ASIN']).map((t) => ({ value: t, label: TYPE_LABEL[t] ?? t })), placeholder: 'Select Type', value: (r) => (r as TargetRow).expressionType ?? '' },
    ...pickMetricFilters('acos', 'roas', 'spend', 'sales', 'clicks', 'ppcOrders', 'cpc', 'ctr', 'cvr', 'impressions', 'bid'),
  ], [tgtNames, types])

  const editMode = useMemo<GridEditMode<TargetRow>>(() => ({
    label: 'Edit Targets',
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <H10Select width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
      { key: 'bid', initial: (r) => (num(r.bidCents) / 100).toFixed(2), render: (v, set) => <div className="h10-edit-money"><span className="cur">€</span><input inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} aria-label="Bid" /></div> },
    ],
    onApply: async (edits) => {
      await Promise.all(edits.map((e) => {
        const body: Record<string, unknown> = { applyImmediately: false, reason: 'Edit Targets inline' }
        if (e.values.status != null) body.status = e.values.status
        if (e.values.bid != null) body.bidCents = Math.round(parseFloat(e.values.bid) * 100)
        return fetch(`${getBackendUrl()}/api/advertising/ad-targets/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      }))
      onRefresh?.()
    },
  }), [onRefresh])

  // Bulk actions (shown when targets are selected): Adjust Bid + Enable/Archive/Pause.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [adjustBid, setAdjustBid] = useState<{ ids: string[]; clear: () => void } | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { await bulkPatch('ad-targets', ids, body); clear(); onRefresh?.() } finally { setBulkBusy(false) }
  }

  return (
    <>
    <AdsDataGrid<TargetRow>
      rows={rows}
      rowId={(r) => r.id}
      noun="Target"
      firstColLabel="Target"
      renderFirst={(r) => <div className="nmw"><span className="t" title={r.expressionValue}>{r.expressionValue}</span>{r.expressionType ? <span className="mk">{TYPE_LABEL[r.expressionType] ?? r.expressionType}</span> : null}</div>}
      firstSortValue={(r) => r.expressionValue.toLowerCase()}
      columns={columns}
      filters={filters}
      showTotal
      defaultSort={{ key: 'spend', dir: 'desc' }}
      storageKey="h10-ag-targets-cols"
      exportable
      reportLabel={latestReportLabel(rows.map((r) => r.lastSyncedAt))}
      editMode={editMode}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => setAdjustBid({ ids, clear })}>Adjust Bid</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ENABLED', reason: 'Bulk enable' }, clear)}>Enable</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ARCHIVED', reason: 'Bulk archive' }, clear)}>Archive</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'PAUSED', reason: 'Bulk pause' }, clear)}>Pause</button>
        </span>
      )}
      toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setShowAdd(true)}><Plus size={13} /> Keyword / Target</button>}
    />
    {adjustBid && <AdjustBidModal count={adjustBid.ids.length} noun="target" bidLabel="Bid" onClose={() => setAdjustBid(null)} onApply={(bidEur) => patchEach(adjustBid.ids, { bidCents: Math.round(bidEur * 100), reason: 'Bulk adjust bid' }, adjustBid.clear).then(() => setAdjustBid(null))} />}
    {showAdd && adGroup && <AddKeywordsTargetsModal adGroupId={adGroup.id} adGroupName={adGroup.name} campaignName={adGroup.campaign?.name ?? ''} defaultBidEur={adGroup.defaultBidCents != null ? adGroup.defaultBidCents / 100 : 0.75} onClose={() => setShowAdd(false)} onAdded={() => onRefresh?.()} />}
    </>
  )
}
