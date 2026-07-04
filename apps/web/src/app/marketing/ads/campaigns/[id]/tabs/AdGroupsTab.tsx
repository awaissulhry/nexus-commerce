'use client'

/**
 * CBN.3.4 — Ad Groups tab, rendered through the shared <AdsDataGrid> (CBN.3.2). Columns +
 * filters match the H10 Ad Groups grid; data is the campaign's embedded adGroups[] (metrics
 * arrive in cents). Includes the Create Ad Group modal, the leading "Ad Group" filter, and
 * the long-tail Kindle/NTB/SameSKU columns (hidden by default, available via Customize —
 * parity placeholders where Amazon has no data source, exactly as the Ad Manager treats them).
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Layers, ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridFilter, type GridEditMode } from '../../_grid/AdsDataGrid'
import { num, eur, int, STATUS_PILL, latestReportLabel, METRIC_TIPS } from '../../_grid/format'
import { pickMetricFilters } from '../../_grid/filters'
import { bulkPatch, AdjustBidModal } from '../../_grid/bulkActions'
import { H10Select, StatusOptions, AD_STATUS_OPTS } from '../../FilterDropdown'
import { getBackendUrl } from '@/lib/backend-url'
import { CreateAdGroupModal } from './CreateAdGroupModal'
import type { CampaignDetailData } from '../CampaignDetail'

interface AdGroupRow {
  id: string
  name: string
  status: string
  defaultBidCents?: number | null
  targetingType?: string | null
  impressions?: number
  clicks?: number
  spendCents?: number
  salesCents?: number
  ordersCount?: number
  lastSyncedAt?: string | null
  targets?: unknown[]
  productAds?: unknown[]
}

const spendOf = (r: AdGroupRow) => num(r.spendCents) / 100
const salesOf = (r: AdGroupRow) => num(r.salesCents) / 100
const acosOf = (r: AdGroupRow) => { const s = salesOf(r); return s ? (spendOf(r) / s) * 100 : 0 }
const roasOf = (r: AdGroupRow) => { const sp = spendOf(r); return sp ? salesOf(r) / sp : 0 }
const ctrOf = (r: AdGroupRow) => { const i = num(r.impressions); return i ? (num(r.clicks) / i) * 100 : 0 }
const cpcOf = (r: AdGroupRow) => { const c = num(r.clicks); return c ? spendOf(r) / c : 0 }
const cvrOf = (r: AdGroupRow) => { const c = num(r.clicks); return c ? (num(r.ordersCount) / c) * 100 : 0 }
const DASH = () => '—'

export function AdGroupsTab({ campaign, campaignId, onRefresh }: { campaign: CampaignDetailData | null; campaignId: string; onRefresh?: () => void }) {
  const rows = useMemo<AdGroupRow[]>(() => (campaign?.adGroups as AdGroupRow[] | undefined) ?? [], [campaign])
  const [showCreate, setShowCreate] = useState(false)

  // ER4 F2 — totals compute from the grid's FILTERED rows (function-form total)
  const tot = (vr: typeof rows) => vr.reduce(
    (a, r) => ({ spend: a.spend + spendOf(r), sales: a.sales + salesOf(r), impr: a.impr + num(r.impressions), clicks: a.clicks + num(r.clicks), orders: a.orders + num(r.ordersCount), targets: a.targets + (r.targets?.length ?? 0) }),
    { spend: 0, sales: 0, impr: 0, clicks: 0, orders: 0, targets: 0 },
  )

  // Column catalog in H10's exact order (33 cols incl. the sticky Ad Group). Core metrics
  // visible; the long-tail (Kindle / View Impr / ASP / Other Sales / NTB-* / SameSKU-*) is
  // hidden-by-default + available via Customize — parity placeholders where Amazon exposes
  // no ad-group-level data source, exactly as the Ad Manager treats them. Header (i) tips
  // pull from the shared METRIC_TIPS so they match the filter tooltips verbatim.
  const columns: GridColumn<AdGroupRow>[] = useMemo(() => [
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => { const sp = STATUS_PILL[r.status] ?? { label: r.status, cls: '' }; return <span className={`h10-pill ${sp.cls}`}>{sp.label}</span> }, total: '' },
    { key: 'defaultBid', label: 'Default Bid', render: (r) => eur(num(r.defaultBidCents) / 100), sortValue: (r) => num(r.defaultBidCents), total: '' },
    { key: 'target', label: 'Target', tip: 'Number of keyword/product targets in this ad group', render: (r) => <span className="h10-tgt">{int(r.targets?.length ?? 0)}<ExternalLink size={13} className="og" /></span>, sortValue: (r) => r.targets?.length ?? 0, total: (vr) => { const T = tot(vr); return int(T.targets) } },
    { key: 'spend', label: 'Spend', tip: METRIC_TIPS.spend, render: (r) => eur(spendOf(r)), sortValue: spendOf, filterValue: spendOf, total: (vr) => { const T = tot(vr); return eur(T.spend) } },
    { key: 'sales', label: 'Sales', tip: METRIC_TIPS.sales, render: (r) => eur(salesOf(r)), sortValue: salesOf, filterValue: salesOf, total: (vr) => { const T = tot(vr); return eur(T.sales) } },
    { key: 'acos', label: 'ACoS', tip: METRIC_TIPS.acos, render: (r) => <span className="h10-acos">{salesOf(r) ? `${acosOf(r).toFixed(2)}%` : '-%'}<i className="dot" /></span>, sortValue: acosOf, filterValue: acosOf, total: (vr) => { const T = tot(vr); return <span className="h10-acos">{T.sales ? `${((T.spend / T.sales) * 100).toFixed(2)}%` : '-%'}<i className="dot" /></span> } },
    { key: 'roas', label: 'ROAS', tip: METRIC_TIPS.roas, render: (r) => (roasOf(r) ? roasOf(r).toFixed(2) : '0'), sortValue: roasOf, filterValue: roasOf, total: (vr) => { const T = tot(vr); return (T.spend && T.sales) ? (T.sales / T.spend).toFixed(2) : '0' } },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (r) => int(r.impressions), sortValue: (r) => num(r.impressions), filterValue: (r) => num(r.impressions), total: (vr) => { const T = tot(vr); return int(T.impr) } },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (r) => int(r.clicks), sortValue: (r) => num(r.clicks), filterValue: (r) => num(r.clicks), total: (vr) => { const T = tot(vr); return int(T.clicks) } },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (r) => `${ctrOf(r).toFixed(2)}%`, sortValue: ctrOf, filterValue: ctrOf, total: (vr) => { const T = tot(vr); return `${(T.impr ? (T.clicks / T.impr) * 100 : 0).toFixed(2)}%` } },
    { key: 'cpc', label: 'CPC', tip: METRIC_TIPS.cpc, render: (r) => eur(cpcOf(r)), sortValue: cpcOf, filterValue: cpcOf, total: (vr) => { const T = tot(vr); return eur(T.clicks ? T.spend / T.clicks : 0) } },
    { key: 'ppcOrders', label: 'PPC Orders', tip: METRIC_TIPS.ppcOrders, render: (r) => int(r.ordersCount), sortValue: (r) => num(r.ordersCount), filterValue: (r) => num(r.ordersCount), total: (vr) => { const T = tot(vr); return int(T.orders) } },
    { key: 'kindleReads', label: 'Kindle Reads', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'kindleRoyalties', label: 'Kindle Royalties', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'cvr', label: 'CVR', tip: METRIC_TIPS.cvr, render: (r) => `${cvrOf(r).toFixed(2)}%`, sortValue: cvrOf, filterValue: cvrOf, total: (vr) => { const T = tot(vr); return `${(T.clicks ? (T.orders / T.clicks) * 100 : 0).toFixed(2)}%` } },
    { key: 'saleUnits', label: 'Sale Units', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'cpa', label: 'CPA', tip: 'Cost per acquisition = spend ÷ orders', defaultHidden: true, render: (r) => (num(r.ordersCount) ? eur(spendOf(r) / num(r.ordersCount)) : '—'), sortValue: (r) => (num(r.ordersCount) ? spendOf(r) / num(r.ordersCount) : 0), total: (vr) => { const T = tot(vr); return T.orders ? eur(T.spend / T.orders) : '—' } },
    { key: 'viewImpr', label: 'View Impr.', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'aov', label: 'AOV', tip: 'Average order value = sales ÷ orders', defaultHidden: true, render: (r) => (num(r.ordersCount) ? eur(salesOf(r) / num(r.ordersCount)) : '—'), sortValue: (r) => (num(r.ordersCount) ? salesOf(r) / num(r.ordersCount) : 0), total: (vr) => { const T = tot(vr); return T.orders ? eur(T.sales / T.orders) : '—' } },
    { key: 'asp', label: 'ASP', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'otherSales', label: 'Other Sales', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'otherSalesPct', label: 'Other Sales %', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbOrders', label: 'NTB-Orders', tip: 'New-to-brand orders', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbOrdersPct', label: 'NTB-Orders%', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbOrderRate', label: 'NTB-OrderRate', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbSales', label: 'NTB-Sales', tip: 'New-to-brand sales', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbUnits', label: 'NTB-Units', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbSalesPct', label: 'NTB-Sales%', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'ntbUnitsPct', label: 'NTB-Units%', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'sameSkuSales', label: 'SameSKU Sales', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'sameSkuSaleUnits', label: 'SameSKU Sale Units', defaultHidden: true, sortable: false, render: DASH, total: '—' },
    { key: 'sameSkuOrders', label: 'SameSKU Orders', defaultHidden: true, sortable: false, render: DASH, total: '—' },
  ], [])

  const agNames = useMemo(() => Array.from(new Set(rows.map((r) => r.name))), [rows])
  const filters: GridFilter[] = useMemo(() => [
    { key: 'adGroup', label: 'Ad Group', kind: 'select', wide: true, searchable: true, placeholder: 'Select an Ad Group', options: agNames.map((n) => ({ value: n, label: n })), value: (r) => (r as AdGroupRow).name },
    { key: 'status', label: 'Status', kind: 'multiselect', options: [{ value: 'ARCHIVED', label: 'Archived' }, { value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }], placeholder: 'Select Status', value: (r) => (r as AdGroupRow).status },
    ...pickMetricFilters('acos', 'roas', 'spend', 'sales', 'clicks', 'ppcOrders', 'cpc', 'ctr', 'cvr', 'impressions'),
  ], [agNames])

  // Edit Groups inline-edit (H10): Ad Group name / Status / Default Bid editable per row.
  // Apply persists each diff via PATCH /advertising/ad-groups/:id (status + defaultBid sync
  // to Amazon; name is a local rename). Deploy-gated — web dev hits the prod API.
  const editMode = useMemo<GridEditMode<AdGroupRow>>(() => ({
    label: 'Edit Groups',
    fields: [
      { key: '__first', initial: (r) => r.name, render: (v, set) => <input className="h10-edit-in" value={v} onChange={(e) => set(e.target.value)} aria-label="Ad group name" /> },
      { key: 'status', initial: (r) => r.status, render: (v, set) => <H10Select width="100%" value={v} onChange={set} options={AD_STATUS_OPTS} ariaLabel="Status" />, renderPopover: (v, set) => <StatusOptions value={v} onChange={set} /> },
      { key: 'defaultBid', initial: (r) => (num(r.defaultBidCents) / 100).toFixed(2), render: (v, set) => <div className="h10-edit-money"><span className="cur">€</span><input inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} aria-label="Default bid" /></div> },
    ],
    onApply: async (edits) => {
      await Promise.all(edits.map((e) => {
        const body: Record<string, unknown> = { applyImmediately: false, reason: 'Edit Groups inline' }
        if (e.values.__first != null) body.name = e.values.__first
        if (e.values.status != null) body.status = e.values.status
        if (e.values.defaultBid != null) body.defaultBidCents = Math.round(parseFloat(e.values.defaultBid) * 100)
        return fetch(`${getBackendUrl()}/api/advertising/ad-groups/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      }))
      onRefresh?.()
    },
  }), [onRefresh])

  // Bulk actions (H10): shown when ad groups are selected. Enable/Archive/Pause patch each
  // selected group's status; Adjust Bid opens a modal to set a new default bid for all.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [adjustBid, setAdjustBid] = useState<{ ids: string[]; clear: () => void } | null>(null)
  const patchEach = async (ids: string[], body: Record<string, unknown>, clear: () => void) => {
    if (bulkBusy) return
    setBulkBusy(true)
    try { await bulkPatch('ad-groups', ids, body); clear(); onRefresh?.() } finally { setBulkBusy(false) }
  }

  return (
    <>
      <AdsDataGrid<AdGroupRow>
        rows={rows}
        rowId={(r) => r.id}
        noun="Ad Group"
        firstColLabel="Ad Group"
        renderFirst={(r) => <div className="nmw"><Layers size={15} className="agi" /><Link href={`/marketing/ads/campaigns/${campaignId}/ad-groups/${r.id}`} className="t agln" title={r.name}>{r.name}</Link></div>}
        firstSortValue={(r) => r.name.toLowerCase()}
        columns={columns}
        filters={filters}
        showTotal
        defaultSort={{ key: 'spend', dir: 'desc' }}
        storageKey="h10-cd-adgroups-cols"
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
        toolbarRight={<button type="button" className="h10-am-btn primary" onClick={() => setShowCreate(true)}><Plus size={13} /> Add Group</button>}
      />
      {showCreate && <CreateAdGroupModal campaignId={campaignId} onClose={() => setShowCreate(false)} onCreated={() => onRefresh?.()} />}
      {adjustBid && <AdjustBidModal count={adjustBid.ids.length} noun="ad group" bidLabel="Default Bid" onClose={() => setAdjustBid(null)} onApply={(bidEur) => patchEach(adjustBid.ids, { defaultBidCents: Math.round(bidEur * 100), reason: 'Bulk adjust bid' }, adjustBid.clear).then(() => setAdjustBid(null))} />}
    </>
  )
}
