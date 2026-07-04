'use client'

/**
 * CBN.3.5 — Search Terms tab on the shared <AdsDataGrid>. Data: GET /reports/search-terms
 * filtered by the campaign's EXTERNAL id (per the AF.1e scoping fix). Spend is costUnits
 * (euros), sales is salesCents, acos/ctr are fractions.
 */
import { useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../_grid/AdsDataGrid'
import { num, eur, int, METRIC_TIPS } from '../../_grid/format'
import { pickMetricFilters } from '../../_grid/filters'
import { SearchTermActionModal } from './SearchTermActionModal'
import type { CampaignDetailData } from '../CampaignDetail'

interface STRow {
  query: string; matchType?: string | null
  impressions?: number; clicks?: number; costUnits?: number; salesCents?: number; orders?: number
  acos?: number | null; roas?: number | null; ctr?: number | null; cpc?: number | null
}

const titleCase = (s?: string | null) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const spendOf = (r: STRow) => num(r.costUnits)
const salesOf = (r: STRow) => num(r.salesCents) / 100

export function SearchTermsTab({ campaign, dateRange }: { campaign: CampaignDetailData | null; dateRange: { start: Date; end: Date } }) {
  const ext = campaign?.externalCampaignId ?? null
  const [rows, setRows] = useState<STRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [action, setAction] = useState<'keyword' | 'negative' | null>(null)
  const rid = (r: STRow) => `${r.query}|${r.matchType ?? ''}`
  const selectedTerms = useMemo(() => Array.from(new Set(rows.filter((r) => selected.has(rid(r))).map((r) => r.query))), [rows, selected])
  const agList = useMemo(() => (campaign?.adGroups as Array<{ id: string; name?: string }> | undefined) ?? [], [campaign])

  useEffect(() => {
    if (!ext) { setLoading(false); setRows([]); return }
    let cancel = false
    const days = Math.max(1, Math.round((dateRange.end.getTime() - dateRange.start.getTime()) / 86400000) + 1)
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/reports/search-terms?campaignId=${ext}&lookbackDays=${days}&limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!cancel) setRows((d.items ?? []) as STRow[]) })
      .catch(() => { if (!cancel) setRows([]) })
      .finally(() => { if (!cancel) setLoading(false) })
    return () => { cancel = true }
  }, [ext, dateRange])

  // ER4 F2 — totals compute from the grid's FILTERED rows (function-form total)
  const tot = (vr: typeof rows) => vr.reduce((a, r) => ({ spend: a.spend + spendOf(r), sales: a.sales + salesOf(r), impr: a.impr + num(r.impressions), clicks: a.clicks + num(r.clicks), orders: a.orders + num(r.orders) }), { spend: 0, sales: 0, impr: 0, clicks: 0, orders: 0 })

  const columns: GridColumn<STRow>[] = useMemo(() => [
    { key: 'matchType', label: 'Match Type', metric: false, sortable: true, render: (r) => titleCase(r.matchType), sortValue: (r) => titleCase(r.matchType), total: '' },
    { key: 'impressions', label: 'Impressions', tip: METRIC_TIPS.impressions, render: (r) => int(r.impressions), sortValue: (r) => num(r.impressions), filterValue: (r) => num(r.impressions), total: (vr) => { const T = tot(vr); return int(T.impr) } },
    { key: 'clicks', label: 'Clicks', tip: METRIC_TIPS.clicks, render: (r) => int(r.clicks), sortValue: (r) => num(r.clicks), filterValue: (r) => num(r.clicks), total: (vr) => { const T = tot(vr); return int(T.clicks) } },
    { key: 'ctr', label: 'CTR', tip: METRIC_TIPS.ctr, render: (r) => (num(r.impressions) ? `${(num(r.clicks) / num(r.impressions) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (num(r.impressions) ? num(r.clicks) / num(r.impressions) : 0), filterValue: (r) => (num(r.impressions) ? num(r.clicks) / num(r.impressions) * 100 : 0), total: (vr) => { const T = tot(vr); return T.impr ? `${(T.clicks / T.impr * 100).toFixed(2)}%` : '—' } },
    { key: 'spend', label: 'Spend', tip: METRIC_TIPS.spend, render: (r) => eur(spendOf(r)), sortValue: spendOf, filterValue: spendOf, total: (vr) => { const T = tot(vr); return eur(T.spend) } },
    { key: 'cpc', label: 'CPC', tip: METRIC_TIPS.cpc, render: (r) => (num(r.clicks) ? eur(spendOf(r) / num(r.clicks)) : '—'), sortValue: (r) => (num(r.clicks) ? spendOf(r) / num(r.clicks) : 0), filterValue: (r) => (num(r.clicks) ? spendOf(r) / num(r.clicks) : 0), total: (vr) => { const T = tot(vr); return T.clicks ? eur(T.spend / T.clicks) : '—' } },
    { key: 'orders', label: 'Orders', tip: METRIC_TIPS.ppcOrders, render: (r) => int(r.orders), sortValue: (r) => num(r.orders), filterValue: (r) => num(r.orders), total: (vr) => { const T = tot(vr); return int(T.orders) } },
    { key: 'sales', label: 'Sales', tip: METRIC_TIPS.sales, render: (r) => eur(salesOf(r)), sortValue: salesOf, filterValue: salesOf, total: (vr) => { const T = tot(vr); return eur(T.sales) } },
    { key: 'acos', label: 'ACoS', tip: METRIC_TIPS.acos, render: (r) => (salesOf(r) ? `${(spendOf(r) / salesOf(r) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (salesOf(r) ? spendOf(r) / salesOf(r) * 100 : 0), filterValue: (r) => (salesOf(r) ? spendOf(r) / salesOf(r) * 100 : 0), total: (vr) => { const T = tot(vr); return T.sales ? `${(T.spend / T.sales * 100).toFixed(2)}%` : '—' } },
    { key: 'roas', label: 'ROAS', tip: METRIC_TIPS.roas, render: (r) => (spendOf(r) ? (salesOf(r) / spendOf(r)).toFixed(2) : '—'), sortValue: (r) => (spendOf(r) ? salesOf(r) / spendOf(r) : 0), filterValue: (r) => (spendOf(r) ? salesOf(r) / spendOf(r) : 0), total: (vr) => { const T = tot(vr); return T.spend ? (T.sales / T.spend).toFixed(2) : '—' } },
    { key: 'cvr', label: 'CVR', tip: METRIC_TIPS.cvr, render: (r) => (num(r.clicks) ? `${(num(r.orders) / num(r.clicks) * 100).toFixed(2)}%` : '—'), sortValue: (r) => (num(r.clicks) ? num(r.orders) / num(r.clicks) * 100 : 0), filterValue: (r) => (num(r.clicks) ? num(r.orders) / num(r.clicks) * 100 : 0), total: (vr) => { const T = tot(vr); return T.clicks ? `${(T.orders / T.clicks * 100).toFixed(2)}%` : '—' } },
  ], [])

  const stNames = useMemo(() => Array.from(new Set(rows.map((r) => r.query))), [rows])
  const filters: GridFilter[] = useMemo(() => [
    { key: 'searchTerm', label: 'Search Term', kind: 'select', wide: true, searchable: true, placeholder: 'Select a Search Term', options: stNames.map((n) => ({ value: n, label: n })), value: (r) => (r as STRow).query },
    ...pickMetricFilters('acos', 'roas', 'spend', 'sales', 'clicks', 'orders', 'cpc', 'ctr', 'cvr', 'impressions'),
  ], [stNames])

  return (
    <>
      <AdsDataGrid<STRow>
        rows={rows}
        loading={loading}
        rowId={rid}
        noun="Search Term"
        firstColLabel="Search Term"
        renderFirst={(r) => <div className="nmw"><span className="t" title={r.query}>{r.query}</span></div>}
        firstSortValue={(r) => r.query.toLowerCase()}
        columns={columns}
        filters={filters}
        showTotal
        storageKey="h10-cd-searchterms-cols"
        exportable
        selected={selected}
        onSelectedChange={setSelected}
        selectionActions={() => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" onClick={() => setAction('keyword')}>Add as Keyword</button>
            <button type="button" className="h10-am-btn bulk" onClick={() => setAction('negative')}>Add as Negative</button>
          </span>
        )}
        emptyLabel="No search-term data for this campaign in the selected date range."
      />
      {action && <SearchTermActionModal mode={action} terms={selectedTerms} adGroups={agList} externalCampaignId={ext} marketplace={campaign?.marketplace ?? null} onClose={() => setAction(null)} onDone={() => setSelected(new Set())} />}
    </>
  )
}
