'use client'

/**
 * Google Ads step 1b, WB — one campaign's ad groups (R5), in the campaign window. Words first (ad group, status with
 * what Google says about serving, type), then the nine metric columns every Google grid uses, then the bids Google holds
 * (no total: a bid does not add up). Enabled ad groups first, then by cost. A row (click, or Enter on the focused row)
 * opens the Keywords tab filtered to that ad group, when the campaign has keywords.
 *
 * Read only: no control here changes Google Ads.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { Pill } from '@/design-system/primitives'
import { fetchAllGooglePages, fetchGoogleAdGroups, GOOGLE_PAGE_LIMIT, type GoogleAdGroup, type GoogleAdGroupsPage } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleGrainState } from './GoogleGrainState'
import { formatMoney, formatRoas, metricColumns, sortable, STATUS_FILTER_OPTIONS } from './googleAds'
import { adGroupTypeLabel, entityStatusWord, NOUN, primaryWord } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

const rowId = (r: GoogleAdGroup) => r.adGroupId
const firstSort = (r: GoogleAdGroup) => r.name.toLowerCase()
const searchValue = (r: GoogleAdGroup) => r.name
const enabledFirst = (r: GoogleAdGroup) => r.status
const metricsOf = (r: GoogleAdGroup) => r.metrics
const renderFirst = (r: GoogleAdGroup) => <span className="gads-camp" title={r.name}>{r.name}</span>

const FILTERS: GridFilter[] = [
  { key: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleAdGroup).status ?? '' },
]

export function adGroupColumns(currency: string | null): GridColumn<GoogleAdGroup>[] {
  return [
    {
      key: 'status', label: 'Status', metric: false, sortValue: (r) => r.status,
      render: (r) => {
        const s = entityStatusWord(r.status)
        const p = primaryWord(r)
        return (
          <span className="gads-status">
            <Pill tone={s.tone} size="sm">{s.text}</Pill>
            {p && (p.tone === 'neutral' ? <span className="gads-dim">{p.text}</span> : <Pill tone={p.tone} size="sm">{p.text}</Pill>)}
          </span>
        )
      },
    },
    { key: 'type', label: 'Type', metric: false, sortValue: (r) => adGroupTypeLabel(r.type), render: (r) => adGroupTypeLabel(r.type) },
    ...metricColumns<GoogleAdGroup>(metricsOf, currency),
    {
      key: 'bid', label: 'Default bid', tip: 'The ad group’s default maximum cost per click, as Google holds it. Under automated bidding Google sets each bid itself.',
      sortValue: (r) => sortable(r.cpcBidCents), render: (r) => formatMoney(r.cpcBidCents, currency),
    },
    {
      key: 'target', label: 'Target', tip: 'The ad group’s own target cost per conversion or return on ad spend, when it has one.',
      sortValue: (r) => sortable(r.targetCpaCents ?? r.targetRoas),
      render: (r) => (r.targetCpaCents != null ? `${formatMoney(r.targetCpaCents, currency)} per conversion` : r.targetRoas != null ? `${formatRoas(r.targetRoas)} return on ad spend` : '—'),
    },
  ]
}

export function GoogleAdGroupsTab({ campaignId, account, window: range, currency, nextReadAt, onOpenAdGroup, onCount }: {
  campaignId: string
  account: string | null
  window: { from: string; to: string }
  currency: string | null
  nextReadAt: string | null
  /** Open the Keywords tab filtered to this ad group (Google's id of it); omitted when the campaign has no keywords. */
  onOpenAdGroup?: (externalAdGroupId: string) => void
  /** How many ad groups Google reported (the tab's count), once read. */
  onCount?: (n: number | null) => void
}) {
  const { from, to } = range
  const read = useGoogleRead(
    googleReadKey('ad-groups', account, campaignId, from, to),
    () => fetchAllGooglePages<GoogleAdGroupsPage>((cursor) => fetchGoogleAdGroups({ account, campaignId, from, to, limit: GOOGLE_PAGE_LIMIT, cursor })),
    { keepPrevious: true },
  )
  const page = read.data
  const ccy = page?.currency ?? currency
  const columns = useMemo(() => adGroupColumns(ccy), [ccy])
  const open = useCallback((r: GoogleAdGroup) => onOpenAdGroup?.(r.externalAdGroupId), [onOpenAdGroup])

  const listRead = page ? !!page.read.readAt : false
  const total = page && !read.loading ? (listRead ? page.total : null) : undefined
  useEffect(() => { if (total !== undefined) onCount?.(total) }, [total, onCount])

  return (
    <GoogleGrainState
      noun={NOUN.adGroup} scope="campaign"
      load={{ loading: read.loading, has: !!page, error: read.error, reload: read.reload }}
      read={page?.read ?? null} numbersRead={page?.numbersRead ?? null} coverage={page?.coverage ?? null}
      count={page?.items.length ?? 0} windowed truncated={page?.truncated} nextReadAt={nextReadAt}
    >
      <AdsDataGrid<GoogleAdGroup>
        rows={page?.items ?? []}
        loading={read.loading}
        rowId={rowId}
        noun="Ad group"
        firstColLabel="Ad group"
        renderFirst={renderFirst}
        firstSortValue={firstSort}
        columns={columns}
        filters={FILTERS}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search ad groups…"
        searchValue={searchValue}
        showTotal
        totalFirst="Total of the ad groups shown"
        defaultSort={{ key: 'cost', dir: 'desc' }}
        enabledFirst={enabledFirst}
        storageKey="h10-google-ad-groups-cols"
        onRowClick={onOpenAdGroup ? open : undefined}
        keyboardNav={!!onOpenAdGroup}
        // No row checkboxes: nothing here acts on a selection (Nexus only reads Google Ads).
        selectable={false}
        emptyLabel="No ad groups match these filters."
      />
    </GoogleGrainState>
  )
}
