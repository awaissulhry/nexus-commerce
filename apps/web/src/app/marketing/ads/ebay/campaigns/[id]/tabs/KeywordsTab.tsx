'use client'

/**
 * ER1 — Keywords tab (campaign-level rollup, PRI-manual): v1 bid GridEditMode
 * + enable/pause bulk preserved; the Ad Group column becomes a LINK to the
 * routed drill-down (fixes critique D-4) and a Suggested-bid column loads on
 * demand through eBay's suggestBids (quota-governed).
 */
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AdsDataGrid, type GridColumn, type GridEditMode } from '../../../../campaigns/_grid/AdsDataGrid'
import { money } from '../../../../campaigns/_grid/format'
import { postEbayAds, type CampaignDetailPayload, type KeywordRow, type WriteItemOutcome } from '../../../_lib'
import { ebayStatusPill } from '../../../_lib/status'
import { StatusPill } from '../../../../_shared/StatusPill'
import { metricColumns } from './metric-columns'

interface SuggestOut { suggestions: { suggestedBids?: Array<{ keywordText?: string; suggestedBid?: { value?: string } }> } }

export function KeywordsTab({ data, campaignId, reload, say }: { data: CampaignDetailPayload; campaignId: string; reload: () => void; say: (m: string) => void }) {
  const currency = data.currency
  const rows = data.keywords
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [suggested, setSuggested] = useState<Map<string, number> | null>(null)
  const [loadingSuggest, setLoadingSuggest] = useState(false)

  const fetchSuggestions = async () => {
    setLoadingSuggest(true)
    try {
      const byGroup = new Map<string, KeywordRow[]>()
      for (const k of rows) { const arr = byGroup.get(k.adGroupId) ?? []; arr.push(k); byGroup.set(k.adGroupId, arr) }
      const map = new Map<string, number>()
      for (const [adGroupId, kws] of byGroup) {
        const out = await postEbayAds<SuggestOut>(`/campaigns/${campaignId}/keyword-bid-suggestions`, { adGroupId, keywords: kws.map((k) => ({ text: k.text, matchType: k.matchType })) })
        for (const s of out.suggestions?.suggestedBids ?? []) {
          const v = s.suggestedBid?.value
          if (s.keywordText && v != null) map.set(s.keywordText.toLowerCase(), Math.round(Number(v) * 100))
        }
      }
      setSuggested(map)
      say(`suggested bids loaded for ${map.size} keyword(s)`)
    } catch (e) { say(`suggested bids unavailable: ${(e as Error).message}`) } finally { setLoadingSuggest(false) }
  }

  const editMode: GridEditMode<KeywordRow> = {
    label: 'Edit Bids',
    fields: [{
      key: 'bid',
      initial: (r) => (r.bidCents != null ? (r.bidCents / 100).toFixed(2) : ''),
      render: (value, set) => <input className="h10-edit-in" type="number" min={0.02} max={100} step={0.01} value={value} onChange={(e) => set(e.target.value)} aria-label="Keyword bid" />,
    }],
    onApply: async (edits) => {
      const updates = edits.map((e) => ({ keywordId: e.id, bidCents: Math.round(Number(e.values.bid) * 100) })).filter((u) => Number.isFinite(u.bidCents) && u.bidCents >= 2)
      if (!updates.length) return
      const out = await postEbayAds<{ results: WriteItemOutcome[] }>(`/campaigns/${campaignId}/keywords/update`, { updates })
      say(`${out.results.filter((r) => r.ok).length}/${updates.length} bid(s) updated`)
      reload()
    },
  }

  const setStatus = async (ids: string[], status: 'ACTIVE' | 'PAUSED') => {
    await postEbayAds(`/campaigns/${campaignId}/keywords/update`, { updates: ids.map((keywordId) => ({ keywordId, status })) })
    say(`${ids.length} keyword(s) → ${status}`)
    reload()
  }

  const columns: GridColumn<KeywordRow>[] = useMemo(() => [
    { key: 'state', label: 'State', metric: false, sortValue: (r) => r.status, render: (r) => { const p = ebayStatusPill(r.status); return <StatusPill label={p.label} cls={p.cls} /> } },
    { key: 'match', label: 'Match', metric: false, sortValue: (r) => r.matchType, render: (r) => <span className="h10-pill arch">{r.matchType}</span> },
    {
      key: 'group', label: 'Ad Group', metric: false, sortValue: (r) => r.adGroupName ?? '',
      render: (r) => <Link className="h10-am-link" href={`/marketing/ads/ebay/campaigns/${campaignId}/ad-groups/${r.adGroupId}`} onClick={(e) => e.stopPropagation()}>{r.adGroupName ?? 'group'}</Link>,
    },
    { key: 'bid', label: 'Bid', render: (r) => money(r.bidCents, currency), sortValue: (r) => r.bidCents ?? -1 },
    {
      key: 'suggested', label: 'Suggested Bid', tip: "eBay's suggested bid for the keyword + match type (suggest_bids).",
      render: (r) => { const s = suggested?.get(r.text.toLowerCase()); return s != null ? money(s, currency) : suggested ? '—' : <span style={{ color: '#8a93a1' }}>load →</span> },
      sortValue: (r) => suggested?.get(r.text.toLowerCase()) ?? -1,
    },
    ...metricColumns<KeywordRow>(rows, currency),
  ], [rows, currency, suggested, campaignId])

  return (
    <AdsDataGrid<KeywordRow>
      rows={rows}
      rowId={(r) => r.id}
      noun="Keyword"
      firstColLabel="Keyword"
      renderFirst={(r) => <div className="nmw"><span className="t">{r.text}</span></div>}
      firstSortValue={(r) => r.text.toLowerCase()}
      columns={columns}
      editMode={editMode}
      selected={selected}
      onSelectedChange={setSelected}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <button type="button" className="h10-am-btn bulk" onClick={() => { void setStatus(ids, 'ACTIVE'); clear() }}>Enable</button>
          <button type="button" className="h10-am-btn bulk" onClick={() => { void setStatus(ids, 'PAUSED'); clear() }}>Pause</button>
        </span>
      )}
      toolbarRight={<button type="button" className="h10-am-btn" disabled={loadingSuggest || rows.length === 0} onClick={() => void fetchSuggestions()}>{loadingSuggest ? 'Loading…' : 'Get suggested bids'}</button>}
      storageKey="er1-ebay-detail-keywords"
      emptyLabel="No keywords — add them from an ad-group page (or Action ▾ → Add ad group first)."
      searchable
      searchValue={(r) => r.text}
      defaultSort={{ key: 'spend', dir: 'desc' }}
      showTotal
    />
  )
}
