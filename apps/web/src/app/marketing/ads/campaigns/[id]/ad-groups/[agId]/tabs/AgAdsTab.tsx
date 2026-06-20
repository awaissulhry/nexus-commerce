'use client'

/**
 * Ads tab (Ad Group page) — the ad group's product ads on the shared <AdsDataGrid>, same
 * product cell + columns as the campaign Ads tab. Rows come straight from adGroup.ads[]
 * (asin/sku/name/photoUrl + windowed metrics in cents) — no extra fetch. Edit Ads (Status →
 * PATCH /advertising/product-ads/:id) + bulk Enable/Archive/Pause.
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AddProductsModal } from './AddProductsModal'
import { AdsDataGrid, type GridColumn, type GridFilter, type GridEditMode } from '../../../../_grid/AdsDataGrid'
import { num, eur, int, STATUS_PILL, METRIC_TIPS } from '../../../../_grid/format'
import { pickMetricFilters } from '../../../../_grid/filters'
import { bulkPatch } from '../../../../_grid/bulkActions'
import { H10Select, StatusOptions, AD_STATUS_OPTS } from '../../../../FilterDropdown'
import type { AdGroupDetailData } from '../AdGroupDetail'

interface AdRow {
  id: string; asin?: string | null; sku?: string | null; name?: string | null; photoUrl?: string | null
  status: string; impressions?: number; clicks?: number; spendCents?: number; salesCents?: number; orders?: number
}
const spendOf = (r: AdRow) => num(r.spendCents) / 100
const salesOf = (r: AdRow) => num(r.salesCents) / 100

export function AgAdsTab({ adGroup, onRefresh }: { adGroup: AdGroupDetailData | null; onRefresh?: () => void }) {
  const rows = useMemo<AdRow[]>(() => (adGroup?.ads as AdRow[] | undefined) ?? [], [adGroup])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [showAdd, setShowAdd] = useState(false)

  const T = useMemo(() => rows.reduce((a, r) => ({ spend: a.spend + spendOf(r), sales: a.sales + salesOf(r), impr: a.impr + num(r.impressions), clicks: a.clicks + num(r.clicks), orders: a.orders + num(r.orders) }), { spend: 0, sales: 0, impr: 0, clicks: 0, orders: 0 }), [rows])

  const columns: GridColumn<AdRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { const sp = STATUS_PILL[r.status] ?? { label: r.status, cls: '' }; return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span> }, total: '' },
    { key: 'spend', label: 'Spend', tip: METRIC_TIPS.spend, render: (r) => eur(spendOf(r)), sortValue: spendOf, filterValue: spendOf, total: eur(T.spend) },
    { key: 'sales', label: 'Sales', tip: METRIC_TIPS.sales, render: (r) => eur(salesOf(r)), sortValue: salesOf, filterValue: salesOf, total: eur(T.sales) },
    { key: 'acos', label: 'ACoS', tip: METRIC_TIPS.acos, render: (r) => (salesOf(r) ? `${(spendOf(r) / salesOf(r) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (salesOf(r) ? spendOf(r) / salesOf(r) * 100 : 0), filterValue: (r) => (salesOf(r) ? spendOf(r) / salesOf(r) * 100 : 0), total: T.sales ? `${(T.spend / T.sales * 100).toFixed(2)}%` : '—' },
    { key: 'roas', label: 'ROAS', tip: METRIC_TIPS.roas, render: (r) => (spendOf(r) ? (salesOf(r) / spendOf(r)).toFixed(2) : '—'), sortValue: (r) => (spendOf(r) ? salesOf(r) / spendOf(r) : 0), filterValue: (r) => (spendOf(r) ? salesOf(r) / spendOf(r) : 0), total: T.spend ? (T.sales / T.spend).toFixed(2) : '—' },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (r) => int(r.impressions), sortValue: (r) => num(r.impressions), filterValue: (r) => num(r.impressions), total: int(T.impr) },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (r) => int(r.clicks), sortValue: (r) => num(r.clicks), filterValue: (r) => num(r.clicks), total: int(T.clicks) },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (r) => (num(r.impressions) ? `${(num(r.clicks) / num(r.impressions) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (num(r.impressions) ? num(r.clicks) / num(r.impressions) : 0), filterValue: (r) => (num(r.impressions) ? num(r.clicks) / num(r.impressions) * 100 : 0), total: T.impr ? `${(T.clicks / T.impr * 100).toFixed(2)}%` : '—' },
    { key: 'cpc', label: 'CPC', tip: METRIC_TIPS.cpc, render: (r) => (num(r.clicks) ? eur(spendOf(r) / num(r.clicks)) : '—'), sortValue: (r) => (num(r.clicks) ? spendOf(r) / num(r.clicks) : 0), filterValue: (r) => (num(r.clicks) ? spendOf(r) / num(r.clicks) : 0), total: T.clicks ? eur(T.spend / T.clicks) : '—' },
    { key: 'orders', label: 'Orders', tip: METRIC_TIPS.ppcOrders, render: (r) => int(r.orders), sortValue: (r) => num(r.orders), filterValue: (r) => num(r.orders), total: int(T.orders) },
    { key: 'cvr', label: 'CVR', tip: METRIC_TIPS.cvr, render: (r) => (num(r.clicks) ? `${(num(r.orders) / num(r.clicks) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (num(r.clicks) ? num(r.orders) / num(r.clicks) * 100 : 0), filterValue: (r) => (num(r.clicks) ? num(r.orders) / num(r.clicks) * 100 : 0), total: T.clicks ? `${(T.orders / T.clicks * 100).toFixed(2)}%` : '—' },
  ], [T])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'status', label: 'Status', kind: 'multiselect', options: [{ value: 'ARCHIVED', label: 'Archived' }, { value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }], placeholder: 'Select Status', value: (r) => (r as AdRow).status },
    ...pickMetricFilters('acos', 'roas', 'spend', 'sales', 'clicks', 'orders', 'cpc', 'ctr', 'cvr', 'impressions'),
  ], [])

  const editMode = useMemo<GridEditMode<AdRow>>(() => ({
    label: 'Edit Ads',
    bulk: false,
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <H10Select width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
    ],
    onApply: async (edits) => {
      await Promise.all(edits.filter((e) => e.values.status).map((e) =>
        fetch(`${getBackendUrl()}/api/advertising/product-ads/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: e.values.status, applyImmediately: false, reason: 'Ads inline edit' }) })))
      onRefresh?.()
    },
  }), [onRefresh])

  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { await bulkPatch('product-ads', ids, body); clear(); onRefresh?.() } finally { setBulkBusy(false) }
  }

  return (
    <>
    <AdsDataGrid<AdRow>
      rows={rows}
      rowId={(r) => r.id}
      noun="Ad"
      firstColLabel="Product"
      renderFirst={(r) => (
        <div className="h10-pcell">
          {r.photoUrl ? <img src={r.photoUrl} alt="" /> : <span className="ph" />}
          <span className="x"><span className="t" title={r.name ?? ''}>{r.name || r.asin || r.sku || 'Advertised product'}</span><span className="m">{[r.asin, r.sku].filter(Boolean).join(' · ') || '—'}</span></span>
        </div>
      )}
      firstSortValue={(r) => (r.name || r.asin || '').toLowerCase()}
      columns={columns}
      filters={filters}
      showTotal
      storageKey="h10-ag-ads-cols"
      exportable
      editMode={editMode}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ENABLED', reason: 'Bulk enable' }, clear)}>Enable</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ARCHIVED', reason: 'Bulk archive' }, clear)}>Archive</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'PAUSED', reason: 'Bulk pause' }, clear)}>Pause</button>
        </span>
      )}
      toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setShowAdd(true)}><Plus size={13} /> Add Product</button>}
      emptyLabel="No ads on this ad group."
    />
    {showAdd && adGroup && <AddProductsModal adGroupId={adGroup.id} onClose={() => setShowAdd(false)} onAdded={() => onRefresh?.()} />}
    </>
  )
}
