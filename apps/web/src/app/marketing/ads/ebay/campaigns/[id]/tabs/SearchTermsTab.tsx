'use client'

/**
 * ER1 — Search Terms (Priority-only; SEARCH_QUERY_PERFORMANCE_REPORT is
 * CPC-only, verified teardown §6 #10): trailing-30d buyer search queries with
 * per-term spend/sales and add-as-keyword / add-as-negative actions feeding
 * the existing guarded writes — the harvest loop's missing surface.
 */
import { useEffect, useMemo, useState } from 'react'
import { AdsDataGrid, type GridColumn } from '../../../../campaigns/_grid/AdsDataGrid'
import { int, pct, money } from '../../../../campaigns/_grid/format'
import { getEbayAds, type CampaignDetailPayload, type SearchTermRow, type SearchTermsPayload } from '../../../_lib'
import { AddKeywordsModal } from '../modals/AddKeywordsModal'
import { AddNegativeKeywordsModal } from '../modals/AddNegativeKeywordsModal'

export function SearchTermsTab({ data, campaignId, reload, say }: { data: CampaignDetailPayload; campaignId: string; reload: () => void; say: (m: string) => void }) {
  const currency = data.currency
  const [payload, setPayload] = useState<SearchTermsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [prefill, setPrefill] = useState<{ kind: 'keyword' | 'negative'; text: string; adGroupId: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    getEbayAds<SearchTermsPayload>(`/campaigns/${campaignId}/search-terms`)
      .then((p) => { if (alive) setPayload(p) })
      .catch((e) => { if (alive) setError((e as Error).message) })
    return () => { alive = false }
  }, [campaignId])

  const rows = payload?.terms ?? []
  const totFees = rows.reduce((a, r) => a + r.adFeesCents, 0)
  const totSales = rows.reduce((a, r) => a + r.salesCents, 0)
  const columns: GridColumn<SearchTermRow>[] = useMemo(() => [
    { key: 'impressions', label: 'Impressions', render: (r) => int(r.impressions), sortValue: (r) => r.impressions, total: int(rows.reduce((a, r) => a + r.impressions, 0)) },
    { key: 'clicks', label: 'Clicks', render: (r) => int(r.clicks), sortValue: (r) => r.clicks, total: int(rows.reduce((a, r) => a + r.clicks, 0)) },
    { key: 'spend', label: 'Ad Fees', render: (r) => money(r.adFeesCents, currency), sortValue: (r) => r.adFeesCents, total: money(totFees, currency) },
    { key: 'sales', label: 'Ad Sales', render: (r) => money(r.salesCents, currency), sortValue: (r) => r.salesCents, total: money(totSales, currency) },
    { key: 'acos', label: 'ACOS', render: (r) => (r.acosPct != null ? pct(r.acosPct / 100) : '—'), sortValue: (r) => r.acosPct ?? -1, total: totSales > 0 ? pct(totFees / totSales) : '—' },
    { key: 'sold', label: 'Sold', render: (r) => int(r.soldQty), sortValue: (r) => r.soldQty, total: int(rows.reduce((a, r) => a + r.soldQty, 0)) },
  ], [rows, currency, totFees, totSales])

  if (error) return <div className="h10-cd-error">Couldn&apos;t load search terms — {error}.</div>
  if (!payload) return <div className="h10-cd-skel" aria-busy="true"><div className="sk-line w40" /><div className="sk-block" /></div>

  return (
    <>
      {payload.window && <p className="eb-be-hint" style={{ marginBottom: 10 }}>Trailing {payload.window.trailingDays} days to <b>{payload.window.until}</b> · figures inside eBay&apos;s 72h reconciliation window are provisional · report refreshes daily.</p>}
      <AdsDataGrid<SearchTermRow>
        rows={rows}
        rowId={(r) => `${r.query}|${r.adGroupId ?? ''}`}
        noun="Search Term"
        firstColLabel="Search Term"
        renderFirst={(r) => (
          <div className="nmw">
            <span className="t">{r.query}</span>
            <button type="button" className="h10-open" onClick={(e) => { e.stopPropagation(); setPrefill({ kind: 'keyword', text: r.query, adGroupId: r.adGroupId }) }}>+ Keyword</button>
            <button type="button" className="h10-open negative" onClick={(e) => { e.stopPropagation(); setPrefill({ kind: 'negative', text: r.query, adGroupId: r.adGroupId }) }}>+ Negative</button>
          </div>
        )}
        firstSortValue={(r) => r.query}
        columns={columns}
        storageKey="er1-ebay-detail-searchterms"
        emptyLabel="No search-query data yet — the first report snapshot lands after the next daily report cycle."
        searchable
        searchValue={(r) => r.query}
        defaultSort={{ key: 'spend', dir: 'desc' }}
        showTotal
        selectable={false}
      />
      <AddKeywordsModal open={prefill?.kind === 'keyword'} onClose={() => setPrefill(null)} campaignId={campaignId} adGroups={data.adGroups} prefillText={prefill?.text} prefillAdGroupId={prefill?.adGroupId ?? undefined} onDone={() => { say('keyword added from search term'); reload() }} />
      <AddNegativeKeywordsModal open={prefill?.kind === 'negative'} onClose={() => setPrefill(null)} campaignId={campaignId} adGroups={data.adGroups} prefillText={prefill?.text} prefillAdGroupId={prefill?.adGroupId ?? undefined} onDone={() => { say('negative added from search term'); reload() }} />
    </>
  )
}
