'use client'

/**
 * CBN.3.5 — Ads tab on the shared <AdsDataGrid>. Aggregates product ads across the
 * campaign's ad groups (GET /ad-groups/:id → .ads[], which carry asin/sku/name/photoUrl +
 * windowed metrics in cents). The first column is the product (thumb + title + ASIN/SKU).
 */
import { useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsDataGrid, type GridColumn, type GridFilter, type GridEditMode } from '../../_grid/AdsDataGrid'
import { num, eur, int, STATUS_PILL, METRIC_TIPS } from '../../_grid/format'
import { pickMetricFilters } from '../../_grid/filters'
import { bulkPatch } from '../../_grid/bulkActions'
import { H10Select, StatusOptions, AD_STATUS_OPTS } from '../../FilterDropdown'
import type { CampaignDetailData } from '../CampaignDetail'

interface AdRow {
  id: string; asin?: string | null; sku?: string | null; name?: string | null; photoUrl?: string | null
  status: string; impressions?: number; clicks?: number; spendCents?: number; salesCents?: number; orders?: number
  adGroupName?: string
}
const spendOf = (r: AdRow) => num(r.spendCents) / 100
const salesOf = (r: AdRow) => num(r.salesCents) / 100

export function AdsTab({ campaign, dateRange }: { campaign: CampaignDetailData | null; dateRange: { start: Date; end: Date } }) {
  const adGroups = useMemo(() => (campaign?.adGroups as Array<{ id: string; name?: string }> | undefined) ?? [], [campaign])
  const [rows, setRows] = useState<AdRow[]>([])
  const [loading, setLoading] = useState(true)
  const [bump, setBump] = useState(0)

  useEffect(() => {
    if (!adGroups.length) { setLoading(false); setRows([]); return }
    let cancel = false
    const days = Math.max(1, Math.round((dateRange.end.getTime() - dateRange.start.getTime()) / 86400000) + 1)
    setLoading(true)
    Promise.all(adGroups.map((ag) => fetch(`${getBackendUrl()}/api/advertising/ad-groups/${ag.id}?windowDays=${days}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)))
      .then((results) => {
        if (cancel) return
        const out: AdRow[] = []
        for (const res of results) { const ads = res?.adGroup?.ads ?? []; const agName = res?.adGroup?.name; for (const a of ads) out.push({ ...a, adGroupName: agName }) }
        setRows(out)
      })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [adGroups, dateRange, bump])

  // ER4 F2 — totals compute from the grid's FILTERED rows (function-form total)
  const tot = (vr: typeof rows) => vr.reduce((a, r) => ({ spend: a.spend + spendOf(r), sales: a.sales + salesOf(r), impr: a.impr + num(r.impressions), clicks: a.clicks + num(r.clicks), orders: a.orders + num(r.orders) }), { spend: 0, sales: 0, impr: 0, clicks: 0, orders: 0 })

  const columns: GridColumn<AdRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { const sp = STATUS_PILL[r.status] ?? { label: r.status, cls: '' }; return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span> }, total: '' },
    { key: 'spend', label: 'Spend', tip: METRIC_TIPS.spend, render: (r) => eur(spendOf(r)), sortValue: spendOf, filterValue: spendOf, total: (vr) => { const T = tot(vr); return eur(T.spend) } },
    { key: 'sales', label: 'Sales', tip: METRIC_TIPS.sales, render: (r) => eur(salesOf(r)), sortValue: salesOf, filterValue: salesOf, total: (vr) => { const T = tot(vr); return eur(T.sales) } },
    { key: 'acos', label: 'ACoS', tip: METRIC_TIPS.acos, render: (r) => (salesOf(r) ? `${(spendOf(r) / salesOf(r) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (salesOf(r) ? spendOf(r) / salesOf(r) * 100 : 0), filterValue: (r) => (salesOf(r) ? spendOf(r) / salesOf(r) * 100 : 0), total: (vr) => { const T = tot(vr); return T.sales ? `${(T.spend / T.sales * 100).toFixed(2)}%` : '—' } },
    { key: 'roas', label: 'ROAS', tip: METRIC_TIPS.roas, render: (r) => (spendOf(r) ? (salesOf(r) / spendOf(r)).toFixed(2) : '—'), sortValue: (r) => (spendOf(r) ? salesOf(r) / spendOf(r) : 0), filterValue: (r) => (spendOf(r) ? salesOf(r) / spendOf(r) : 0), total: (vr) => { const T = tot(vr); return T.spend ? (T.sales / T.spend).toFixed(2) : '—' } },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (r) => int(r.impressions), sortValue: (r) => num(r.impressions), filterValue: (r) => num(r.impressions), total: (vr) => { const T = tot(vr); return int(T.impr) } },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (r) => int(r.clicks), sortValue: (r) => num(r.clicks), filterValue: (r) => num(r.clicks), total: (vr) => { const T = tot(vr); return int(T.clicks) } },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (r) => (num(r.impressions) ? `${(num(r.clicks) / num(r.impressions) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (num(r.impressions) ? num(r.clicks) / num(r.impressions) : 0), filterValue: (r) => (num(r.impressions) ? num(r.clicks) / num(r.impressions) * 100 : 0), total: (vr) => { const T = tot(vr); return T.impr ? `${(T.clicks / T.impr * 100).toFixed(2)}%` : '—' } },
    { key: 'cpc', label: 'CPC', tip: METRIC_TIPS.cpc, render: (r) => (num(r.clicks) ? eur(spendOf(r) / num(r.clicks)) : '—'), sortValue: (r) => (num(r.clicks) ? spendOf(r) / num(r.clicks) : 0), filterValue: (r) => (num(r.clicks) ? spendOf(r) / num(r.clicks) : 0), total: (vr) => { const T = tot(vr); return T.clicks ? eur(T.spend / T.clicks) : '—' } },
    { key: 'orders', label: 'Orders', tip: METRIC_TIPS.ppcOrders, render: (r) => int(r.orders), sortValue: (r) => num(r.orders), filterValue: (r) => num(r.orders), total: (vr) => { const T = tot(vr); return int(T.orders) } },
    { key: 'cvr', label: 'CVR', tip: METRIC_TIPS.cvr, render: (r) => (num(r.clicks) ? `${(num(r.orders) / num(r.clicks) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (num(r.clicks) ? num(r.orders) / num(r.clicks) * 100 : 0), filterValue: (r) => (num(r.clicks) ? num(r.orders) / num(r.clicks) * 100 : 0), total: (vr) => { const T = tot(vr); return T.clicks ? `${(T.orders / T.clicks * 100).toFixed(2)}%` : '—' } },
  ], [])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'status', label: 'Status', kind: 'multiselect', options: [{ value: 'ARCHIVED', label: 'Archived' }, { value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }], placeholder: 'Select Status', value: (r) => (r as AdRow).status },
    ...pickMetricFilters('acos', 'roas', 'spend', 'sales', 'clicks', 'orders', 'cpc', 'ctr', 'cvr', 'impressions'),
  ], [])

  // Hover-edit only (bulk:false): a product ad's only editable field is Status. Save →
  // PATCH /advertising/product-ads/:id {status} (synced to Amazon), then refetch.
  const editMode = useMemo<GridEditMode<AdRow>>(() => ({
    label: 'Edit Ads',
    bulk: false,
    fields: [
      { key: 'status', initial: (r) => r.status, render: (v, set) => <H10Select width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
    ],
    onApply: async (edits) => {
      await Promise.all(edits.filter((e) => e.values.status).map((e) =>
        fetch(`${getBackendUrl()}/api/advertising/product-ads/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: e.values.status, applyImmediately: false, reason: 'Ads inline edit' }) })))
      setBump((b) => b + 1)
    },
  }), [])

  // Bulk actions (shown when ads are selected): Enable/Archive/Pause (ads have no bid).
  const [bulkBusy, setBulkBusy] = useState(false)
  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { await bulkPatch('product-ads', ids, body); clear(); setBump((b) => b + 1) } finally { setBulkBusy(false) }
  }

  return (
    <AdsDataGrid<AdRow>
      rows={rows}
      loading={loading}
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
      storageKey="h10-cd-ads-cols"
      exportable
      editMode={editMode}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ENABLED', reason: 'Bulk enable' }, clear)}>Enable</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'ARCHIVED', reason: 'Bulk archive' }, clear)}>Archive</button>
          <button type="button" className="h10-am-btn bulk" disabled={bulkBusy} onClick={() => void patchEach(ids, { status: 'PAUSED', reason: 'Bulk pause' }, clear)}>Pause</button>
        </span>
      )}
      emptyLabel="No ads on this campaign."
    />
  )
}
