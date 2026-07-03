'use client'

/**
 * ER1 — search terms filtered to this ad group (the campaign-level snapshot
 * carries ad_group_id lineage; SPEC §6 — client-side filter of the same
 * report data).
 */
import { useEffect, useMemo, useState } from 'react'
import { AdsDataGrid, type GridColumn } from '../../../../../../campaigns/_grid/AdsDataGrid'
import { int, pct, money } from '../../../../../../campaigns/_grid/format'
import { getEbayAds, type AdGroupDetailPayload, type SearchTermRow, type SearchTermsPayload } from '../../../../../_lib'

export function AgSearchTermsTab({ data, campaignId }: { data: AdGroupDetailPayload; campaignId: string }) {
  const currency = data.currency
  const [payload, setPayload] = useState<SearchTermsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getEbayAds<SearchTermsPayload>(`/campaigns/${campaignId}/search-terms`)
      .then((p) => { if (alive) setPayload(p) })
      .catch((e) => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [campaignId])

  const rows = useMemo(() => (payload?.terms ?? []).filter((t) => t.adGroupId === data.adGroup.externalAdGroupId || t.adGroupId === data.adGroup.id || t.adGroupId == null), [payload, data.adGroup])
  const columns: GridColumn<SearchTermRow>[] = useMemo(() => [
    { key: 'impressions', label: 'Impressions', render: (r) => int(r.impressions), sortValue: (r) => r.impressions },
    { key: 'clicks', label: 'Clicks', render: (r) => int(r.clicks), sortValue: (r) => r.clicks },
    { key: 'spend', label: 'Ad Fees', render: (r) => money(r.adFeesCents, currency), sortValue: (r) => r.adFeesCents },
    { key: 'sales', label: 'Ad Sales', render: (r) => money(r.salesCents, currency), sortValue: (r) => r.salesCents },
    { key: 'acos', label: 'ACOS', render: (r) => (r.acosPct != null ? pct(r.acosPct / 100) : '—'), sortValue: (r) => r.acosPct ?? -1 },
  ], [currency])

  if (error) return <div className="h10-cd-error">Couldn&apos;t load search terms — {error}.</div>
  if (!payload) return <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-block" /></div>

  return (
    <AdsDataGrid<SearchTermRow>
      rows={rows}
      rowId={(r) => `${r.query}|${r.adGroupId ?? ''}`}
      noun="Search Term"
      firstColLabel="Search Term"
      renderFirst={(r) => <div className="nmw"><span className="t">{r.query}</span></div>}
      firstSortValue={(r) => r.query}
      columns={columns}
      storageKey="er1-ebay-ag-searchterms"
      emptyLabel="No search-query data for this ad group yet — the report snapshot lands daily."
      searchable
      searchValue={(r) => r.query}
      defaultSort={{ key: 'spend', dir: 'desc' }}
      selectable={false}
    />
  )
}
