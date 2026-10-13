'use client'

/**
 * Google Ads step 1b, WB — one campaign's negative keywords (R7, PLAN-1B M8): its ad groups' negatives, the campaign's
 * own (brand lists included), and the keywords of the negative keyword lists attached to it. Words only, A→Z, no
 * totals (a negative keyword has no numbers). The lists themselves are named above the grid with how many keywords each
 * holds. A part Nexus has not read yet is named, so the list never passes for complete.
 *
 * Read only: no control here changes Google Ads.
 */
import { useEffect, useMemo } from 'react'
import { SummaryTable } from '@/design-system/components'
import { fetchAllGooglePages, fetchGoogleNegatives, GOOGLE_PAGE_LIMIT, type GoogleNegative, type GoogleNegativesPage } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleGrainState } from './GoogleGrainState'
import {
  activeNegatives, MATCH_TYPE_OPTIONS, NEGATIVE_LEVEL_OPTIONS, NEGATIVE_LIST_COLUMNS, negativeLevelText, negativeListRows, negativeMatchLabel,
  negativesMissingText, negativesRead, negativeText, NOUN,
} from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

const rowId = (r: GoogleNegative) => r.negativeId
const firstSort = (r: GoogleNegative) => negativeText(r).toLowerCase()
const searchValue = (r: GoogleNegative) => `${negativeText(r)} ${r.adGroupName ?? ''} ${r.listName ?? ''}`
const renderFirst = (r: GoogleNegative) => <span className="gads-camp" title={negativeText(r)}>{negativeText(r)}</span>

const COLUMNS: GridColumn<GoogleNegative>[] = [
  { key: 'match', label: 'Match type', metric: false, sortValue: (r) => negativeMatchLabel(r), render: (r) => negativeMatchLabel(r) },
  { key: 'level', label: 'Set on', metric: false, tip: 'An ad group, the campaign, or a negative keyword list attached to the campaign.', sortValue: (r) => negativeLevelText(r).toLowerCase(), render: (r) => <span className="gads-camp" title={negativeLevelText(r)}>{negativeLevelText(r)}</span> },
]

const FILTERS: GridFilter[] = [
  { key: 'level', label: 'Set on', kind: 'select', options: NEGATIVE_LEVEL_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleNegative).level },
  { key: 'match', label: 'Match type', kind: 'select', options: MATCH_TYPE_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleNegative).matchType ?? '' },
]

export function GoogleNegativesTab({ campaignId, account, nextReadAt, onCount }: {
  campaignId: string
  account: string | null
  nextReadAt: string | null
  onCount?: (n: number | null) => void
}) {
  const read = useGoogleRead(
    googleReadKey('negatives', account, campaignId),
    () => fetchAllGooglePages<GoogleNegativesPage>((cursor) => fetchGoogleNegatives({ account, campaignId, limit: GOOGLE_PAGE_LIMIT, cursor })),
    { keepPrevious: true },
  )
  const page = read.data
  const rows = useMemo(() => activeNegatives(page?.items ?? []), [page])
  const lists = useMemo(() => negativeListRows(page?.lists ?? []), [page])
  const state = page ? negativesRead(page.read) : null
  const missing = state ? negativesMissingText(state.missing) : null

  const total = page && !read.loading ? (state?.read.readAt ? rows.length : null) : undefined
  useEffect(() => { if (total !== undefined) onCount?.(total) }, [total, onCount])

  return (
    <GoogleGrainState
      noun={NOUN.negative} scope="campaign"
      load={{ loading: read.loading, has: !!page, error: read.error, reload: read.reload }}
      read={state?.read ?? null}
      count={rows.length + lists.length} windowed={false} truncated={page?.truncated} nextReadAt={nextReadAt}
      note={missing}
      above={lists.length > 0 && (
        <div className="gads-table gads-lists" tabIndex={0} role="region" aria-label="Negative keyword lists">
          <SummaryTable label="Negative keyword lists attached to this campaign" columns={NEGATIVE_LIST_COLUMNS} rows={lists} />
        </div>
      )}
    >
      {rows.length === 0 ? <p className="gads-meta">The lists above hold no negative keywords that Nexus has read.</p> : (
      <AdsDataGrid<GoogleNegative>
        rows={rows}
        loading={read.loading}
        rowId={rowId}
        noun="Negative keyword"
        firstColLabel="Negative keyword"
        renderFirst={renderFirst}
        firstSortValue={firstSort}
        columns={COLUMNS}
        filters={FILTERS}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search negative keywords…"
        searchValue={searchValue}
        storageKey="h10-google-negatives-cols"
        // No row checkboxes and no totals: nothing here acts on a selection, and a negative keyword has no numbers.
        selectable={false}
        emptyLabel="No negative keywords match these filters."
      />
      )}
    </GoogleGrainState>
  )
}
