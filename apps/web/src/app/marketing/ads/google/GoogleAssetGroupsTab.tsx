'use client'

/**
 * Google Ads step 1b, WB — one Performance Max campaign's asset groups (R10), in the campaign window. Words first (asset
 * group, status with what Google says about serving, ad strength, final URL), then the nine metric columns every Google
 * grid uses. Enabled asset groups first, then by cost.
 *
 * Read only: no control here changes Google Ads.
 */
import { useEffect, useMemo } from 'react'
import { Pill } from '@/design-system/primitives'
import { fetchAllGooglePages, fetchGoogleAssetGroups, GOOGLE_PAGE_LIMIT, type GoogleAssetGroup, type GoogleAssetGroupsPage } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleGrainState } from './GoogleGrainState'
import { metricColumns, STATUS_FILTER_OPTIONS } from './googleAds'
import { adStrengthWord, entityStatusWord, finalUrlText, NOUN, primaryWord } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

const rowId = (r: GoogleAssetGroup) => r.assetGroupId
const firstSort = (r: GoogleAssetGroup) => r.name.toLowerCase()
const searchValue = (r: GoogleAssetGroup) => r.name
const enabledFirst = (r: GoogleAssetGroup) => r.status
const metricsOf = (r: GoogleAssetGroup) => r.metrics
const renderFirst = (r: GoogleAssetGroup) => <span className="gads-camp" title={r.name}>{r.name}</span>

const FILTERS: GridFilter[] = [
  { key: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleAssetGroup).status ?? '' },
]

export function assetGroupColumns(currency: string | null): GridColumn<GoogleAssetGroup>[] {
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
    {
      key: 'strength', label: 'Ad strength', metric: false, tip: 'Google’s rating of the asset group’s headlines, images and videos.',
      sortValue: (r) => adStrengthWord(r.adStrength).text,
      render: (r) => {
        const w = adStrengthWord(r.adStrength)
        return w.text === '—' ? '—' : <Pill tone={w.tone} size="sm">{w.text}</Pill>
      },
    },
    {
      key: 'url', label: 'Final URL', metric: false, sortValue: (r) => r.finalUrls[0] ?? null,
      render: (r) => <span className="gads-camp" title={r.finalUrls.join('\n') || undefined}>{finalUrlText(r.finalUrls)}</span>,
    },
    ...metricColumns<GoogleAssetGroup>(metricsOf, currency),
  ]
}

export function GoogleAssetGroupsTab({ campaignId, account, window: range, currency, nextReadAt, onCount }: {
  campaignId: string
  account: string | null
  window: { from: string; to: string }
  currency: string | null
  nextReadAt: string | null
  onCount?: (n: number | null) => void
}) {
  const { from, to } = range
  const read = useGoogleRead(
    googleReadKey('asset-groups', account, campaignId, from, to),
    () => fetchAllGooglePages<GoogleAssetGroupsPage>((cursor) => fetchGoogleAssetGroups({ account, campaignId, from, to, limit: GOOGLE_PAGE_LIMIT, cursor })),
    { keepPrevious: true },
  )
  const page = read.data
  const ccy = page?.currency ?? currency
  const columns = useMemo(() => assetGroupColumns(ccy), [ccy])

  const total = page && !read.loading ? (page.read.readAt ? page.total : null) : undefined
  useEffect(() => { if (total !== undefined) onCount?.(total) }, [total, onCount])

  return (
    <GoogleGrainState
      noun={NOUN.assetGroup} scope="campaign"
      load={{ loading: read.loading, has: !!page, error: read.error, reload: read.reload }}
      read={page?.read ?? null} numbersRead={page?.numbersRead ?? null} coverage={page?.coverage ?? null}
      count={page?.items.length ?? 0} windowed truncated={page?.truncated} nextReadAt={nextReadAt}
    >
      <AdsDataGrid<GoogleAssetGroup>
        rows={page?.items ?? []}
        loading={read.loading}
        rowId={rowId}
        noun="Asset group"
        firstColLabel="Asset group"
        renderFirst={renderFirst}
        firstSortValue={firstSort}
        columns={columns}
        filters={FILTERS}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search asset groups…"
        searchValue={searchValue}
        showTotal
        totalFirst="Total of the asset groups shown"
        defaultSort={{ key: 'cost', dir: 'desc' }}
        enabledFirst={enabledFirst}
        storageKey="h10-google-asset-groups-cols"
        // No row checkboxes: nothing here acts on a selection (Nexus only reads Google Ads).
        selectable={false}
        emptyLabel="No asset groups match these filters."
      />
    </GoogleGrainState>
  )
}
