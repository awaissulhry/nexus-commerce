'use client'

/**
 * Google Ads step 1b, WB — one campaign's keywords (R6), in the campaign window. Words first (keyword, match type, ad
 * group, status with what stops it showing: Disapproved, Under review, Rarely shown), then the nine metric columns every
 * Google grid uses, then quality score and the bids Google holds (no total: they do not add up). Enabled keywords first,
 * then by cost. Opened from an ad group, the Ad group filter starts on it; clearing the filter shows every keyword.
 *
 * Read only: no control here changes Google Ads.
 */
import { useEffect, useMemo } from 'react'
import { Pill } from '@/design-system/primitives'
import { fetchAllGooglePages, fetchGoogleKeywords, GOOGLE_PAGE_LIMIT, type GoogleKeyword, type GoogleKeywordsPage } from '@/lib/google-ads/contract'
import { AdsDataGrid, type FilterState, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleGrainState } from './GoogleGrainState'
import { formatInt, formatMoney, metricColumns, sortable, STATUS_FILTER_OPTIONS } from './googleAds'
import { entityStatusWord, keywordWord, MATCH_TYPE_OPTIONS, matchTypeLabel, NOUN } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

const rowId = (r: GoogleKeyword) => r.keywordId
const firstSort = (r: GoogleKeyword) => r.text.toLowerCase()
const searchValue = (r: GoogleKeyword) => `${r.text} ${r.adGroupName ?? ''}`
const enabledFirst = (r: GoogleKeyword) => r.status
const metricsOf = (r: GoogleKeyword) => r.metrics
const renderFirst = (r: GoogleKeyword) => <span className="gads-camp" title={r.text}>{r.text}</span>

export function keywordColumns(currency: string | null): GridColumn<GoogleKeyword>[] {
  return [
    { key: 'match', label: 'Match type', metric: false, sortValue: (r) => matchTypeLabel(r.matchType), render: (r) => matchTypeLabel(r.matchType) },
    { key: 'adGroup', label: 'Ad group', metric: false, sortValue: (r) => r.adGroupName?.toLowerCase() ?? null, render: (r) => <span className="gads-camp" title={r.adGroupName ?? undefined}>{r.adGroupName ?? '—'}</span> },
    {
      key: 'status', label: 'Status', metric: false, sortValue: (r) => r.status,
      render: (r) => {
        const s = entityStatusWord(r.status)
        const k = keywordWord(r)
        return (
          <span className="gads-status">
            <Pill tone={s.tone} size="sm">{s.text}</Pill>
            {k && (k.tone === 'neutral' ? <span className="gads-dim">{k.text}</span> : <Pill tone={k.tone} size="sm">{k.text}</Pill>)}
          </span>
        )
      },
    },
    ...metricColumns<GoogleKeyword>(metricsOf, currency),
    { key: 'quality', label: 'Quality score', tip: 'Google’s score from 1 to 10. Google gives none for a keyword with too few searches.', sortValue: (r) => sortable(r.qualityScore), render: (r) => formatInt(r.qualityScore) },
    { key: 'bid', label: 'Max bid', tip: 'The keyword’s own maximum cost per click, as Google holds it.', sortValue: (r) => sortable(r.cpcBidCents), render: (r) => formatMoney(r.cpcBidCents, currency) },
    { key: 'effectiveBid', label: 'Bid Google uses', tip: 'The maximum cost per click Google applies: the keyword’s own, else its ad group’s.', sortValue: (r) => sortable(r.effectiveCpcBidCents), render: (r) => formatMoney(r.effectiveCpcBidCents, currency) },
  ]
}

/** The Ad group filter's options: every ad group the keywords sit in, by name. */
export function keywordAdGroupOptions(items: readonly GoogleKeyword[]): Array<{ value: string; label: string }> {
  const byId = new Map<string, string>()
  for (const k of items) if (!byId.has(k.externalAdGroupId)) byId.set(k.externalAdGroupId, k.adGroupName?.trim() || '—')
  return [...byId].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }))
}

export function GoogleKeywordsTab({ campaignId, account, window: range, currency, nextReadAt, adGroup, onCount }: {
  campaignId: string
  account: string | null
  window: { from: string; to: string }
  currency: string | null
  nextReadAt: string | null
  /** Google's id of the ad group to start filtered on (from the Ad groups tab), or null for every keyword. */
  adGroup?: string | null
  onCount?: (n: number | null) => void
}) {
  const { from, to } = range
  const read = useGoogleRead(
    googleReadKey('keywords', account, campaignId, from, to),
    () => fetchAllGooglePages<GoogleKeywordsPage>((cursor) => fetchGoogleKeywords({ account, campaignId, from, to, sort: 'spend', limit: GOOGLE_PAGE_LIMIT, cursor })),
    { keepPrevious: true },
  )
  const page = read.data
  const ccy = page?.currency ?? currency
  const columns = useMemo(() => keywordColumns(ccy), [ccy])
  const items = page?.items
  const filters: GridFilter[] = useMemo(() => [
    { key: 'match', label: 'Match type', kind: 'select', options: MATCH_TYPE_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleKeyword).matchType ?? '' },
    { key: 'adGroup', label: 'Ad group', kind: 'select', options: keywordAdGroupOptions(items ?? []), placeholder: 'All', searchable: true, value: (r) => (r as GoogleKeyword).externalAdGroupId },
    { key: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleKeyword).status ?? '' },
  ], [items])
  const initialFilters: FilterState | undefined = useMemo(() => (adGroup ? { adGroup } : undefined), [adGroup])

  const total = page && !read.loading ? (page.read.readAt ? page.total : null) : undefined
  useEffect(() => { if (total !== undefined) onCount?.(total) }, [total, onCount])

  return (
    <GoogleGrainState
      noun={NOUN.keyword} scope="campaign"
      load={{ loading: read.loading, has: !!page, error: read.error, reload: read.reload }}
      read={page?.read ?? null} numbersRead={page?.numbersRead ?? null} coverage={page?.coverage ?? null}
      count={page?.items.length ?? 0} windowed truncated={page?.truncated} nextReadAt={nextReadAt}
    >
      <AdsDataGrid<GoogleKeyword>
        rows={items ?? []}
        loading={read.loading}
        rowId={rowId}
        noun="Keyword"
        firstColLabel="Keyword"
        renderFirst={renderFirst}
        firstSortValue={firstSort}
        columns={columns}
        filters={filters}
        initialFilters={initialFilters}
        filtersDefaultOpen={!!adGroup}
        searchable
        searchPlaceholder="Search keywords…"
        searchValue={searchValue}
        showTotal
        totalFirst="Total of the keywords shown"
        defaultSort={{ key: 'cost', dir: 'desc' }}
        enabledFirst={enabledFirst}
        storageKey="h10-google-keywords-cols"
        // No row checkboxes: nothing here acts on a selection (Nexus only reads Google Ads).
        selectable={false}
        emptyLabel="No keywords match these filters."
      />
    </GoogleGrainState>
  )
}
