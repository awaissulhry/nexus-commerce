'use client'

/**
 * ER1 — Ad Groups tab (PRI-manual): grid of groups with default bid,
 * keyword/ad counts and window metrics rolled up from keyword-grain facts;
 * row click routes to the drill-down (C4 — routed pages, never inline
 * expansion).
 */
import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { AdsDataGrid, type GridColumn } from '../../../../campaigns/_grid/AdsDataGrid'
import { int, money } from '../../../../campaigns/_grid/format'
import type { AdGroupRow, CampaignDetailPayload, Derived } from '../../../_lib'
import { ebayStatusPill } from '../../../_lib/status'
import { StatusPill } from '../../../../_shared/StatusPill'
import { metricColumns } from './metric-columns'

interface GroupRow extends AdGroupRow { keywords: number; ads: number; metrics: Derived }

const zero: Derived = { impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0, ctrPct: null, acosPct: null, avgCpcCents: null }

export function AdGroupsTab({ data, campaignId, onCreate }: { data: CampaignDetailPayload; campaignId: string; onCreate: () => void }) {
  const router = useRouter()
  const currency = data.currency
  const rows: GroupRow[] = useMemo(() => data.adGroups.map((g) => {
    const kws = data.keywords.filter((k) => k.adGroupId === g.id)
    const ads = data.ads.filter((a) => a.adGroupId === g.id)
    const m = kws.reduce<Derived>((acc, k) => ({
      impressions: acc.impressions + k.metrics.impressions, clicks: acc.clicks + k.metrics.clicks,
      adFeesCents: acc.adFeesCents + k.metrics.adFeesCents, salesCents: acc.salesCents + k.metrics.salesCents,
      soldQty: acc.soldQty + k.metrics.soldQty, ctrPct: null, acosPct: null, avgCpcCents: null,
    }), { ...zero })
    m.ctrPct = m.impressions > 0 ? (m.clicks / m.impressions) * 100 : null
    m.acosPct = m.salesCents > 0 ? (m.adFeesCents / m.salesCents) * 100 : null
    m.avgCpcCents = m.clicks > 0 ? Math.round(m.adFeesCents / m.clicks) : null
    return { ...g, keywords: kws.length, ads: ads.length, metrics: m }
  }), [data])

  const columns: GridColumn<GroupRow>[] = useMemo(() => [
    { key: 'state', label: 'State', metric: false, sortValue: (r) => r.status, render: (r) => { const p = ebayStatusPill(r.status); return <StatusPill label={p.label} cls={p.cls} /> } },
    { key: 'bid', label: 'Default Bid', render: (r) => money(r.defaultBidCents, currency), sortValue: (r) => r.defaultBidCents ?? -1 },
    { key: 'kw', label: 'Keywords', render: (r) => int(r.keywords), sortValue: (r) => r.keywords },
    { key: 'ads', label: 'Ads', render: (r) => int(r.ads), sortValue: (r) => r.ads },
    ...metricColumns<GroupRow>(rows, currency),
  ], [rows, currency])

  return (
    <AdsDataGrid<GroupRow>
      rows={rows}
      rowId={(r) => r.id}
      noun="Ad Group"
      firstColLabel="Ad Group"
      renderFirst={(r) => (
        <div className="nmw">
          <span className="t">{r.name}</span>
          <span className="h10-open">Open</span>
        </div>
      )}
      firstSortValue={(r) => r.name.toLowerCase()}
      columns={columns}
      onRowClick={(r) => router.push(`/marketing/ads/ebay/campaigns/${campaignId}/ad-groups/${r.id}`)}
      toolbarRight={<button type="button" className="h10-am-btn primary" onClick={onCreate}>+ Ad group</button>}
      storageKey="er1-ebay-detail-adgroups"
      emptyLabel="No ad groups — create one to add keywords."
      showTotal
      selectable={false}
    />
  )
}
