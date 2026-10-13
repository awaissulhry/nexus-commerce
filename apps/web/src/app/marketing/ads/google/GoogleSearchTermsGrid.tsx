'use client'

/**
 * Google Ads step 1b, WB — the searches people made before they clicked an ad (R8), on the page's Search terms tab
 * (`campaignId` null: every campaign, with the Campaign and Type columns) and in the campaign window (one campaign).
 *
 * Only searches with at least one click (PLAN-1B M7), and the page says so. A search is "Brand" when it matches one
 * of the business's brand words (its protected terms); with no brand words every term is "—", never "Not brand". One
 * name on the tab: "brand words (your protected terms)" in the brand sentence (`brandRuleText`), "brand words" after. On the
 * page, the brand split (R9) sits above the grid: brand, not brand, and what Google did not list by search — a tile
 * filters the grid.
 *
 * Read only: no control here changes Google Ads.
 */
import { useCallback, useMemo, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { MetricStrip, type Metric } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import {
  fetchAllGooglePages, fetchGoogleBrandSplit, fetchGoogleSearchTerms, GOOGLE_PAGE_LIMIT, type GoogleBrandSplit, type GoogleMetrics,
  type GoogleSearchTerm, type GoogleSearchTermsPage,
} from '@/lib/google-ads/contract'
import { AdsDataGrid, type FilterState, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleGrainState } from './GoogleGrainState'
import { campaignTypeLabel, coverageNote, formatConversions, formatInt, formatMoney, metricColumns, TYPE_FILTER_OPTIONS } from './googleAds'
import { BRAND_FILTER_OPTIONS, brandKey, brandLabel, brandRuleText, NOUN, SEARCH_TERM_SCOPE_TEXT } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

export interface GoogleGrainGridProps {
  /** One campaign (the campaign window), or null for every campaign (a page tab: the Campaign column shows). */
  campaignId: string | null
  account: string | null
  window: { from: string; to: string }
  currency: string | null
  nextReadAt: string | null
}

const rowId = (r: GoogleSearchTerm) => r.termId
const firstSort = (r: GoogleSearchTerm) => r.term.toLowerCase()
const searchValue = (r: GoogleSearchTerm) => r.term
const metricsOf = (r: GoogleSearchTerm) => r.metrics
const renderFirst = (r: GoogleSearchTerm) => <span className="gads-camp" title={r.term}>{r.term}</span>

export function searchTermColumns(currency: string | null, withCampaign: boolean): GridColumn<GoogleSearchTerm>[] {
  return [
    { key: 'brand', label: 'Brand', metric: false, tip: 'Brand when the search matches one of the brand words; “—” when Nexus does not know them.', sortValue: (r) => brandKey(r.brand) || null, render: (r) => brandLabel(r.brand) },
    ...(withCampaign ? [
      { key: 'campaign', label: 'Campaign', metric: false, sortValue: (r: GoogleSearchTerm) => r.campaignName?.toLowerCase() ?? null, render: (r: GoogleSearchTerm) => <span className="gads-camp" title={r.campaignName ?? undefined}>{r.campaignName ?? '—'}</span> },
      { key: 'type', label: 'Type', metric: false, sortValue: (r: GoogleSearchTerm) => campaignTypeLabel(r.campaignType), render: (r: GoogleSearchTerm) => campaignTypeLabel(r.campaignType) },
    ] satisfies GridColumn<GoogleSearchTerm>[] : []),
    ...metricColumns<GoogleSearchTerm>(metricsOf, currency),
  ]
}

const BRAND_FILTER: GridFilter = { key: 'brand', label: 'Brand', kind: 'select', options: BRAND_FILTER_OPTIONS, placeholder: 'All', value: (r) => brandKey((r as GoogleSearchTerm).brand) }
const TYPE_FILTER: GridFilter = { key: 'type', label: 'Campaign type', kind: 'select', options: TYPE_FILTER_OPTIONS, placeholder: 'All', value: (r) => campaignTypeLabel((r as GoogleSearchTerm).campaignType) }

/** Why a brand-split tile has no numbers: no brand words, or no day of the window read (never "no brand words" then). */
const NO_BRAND_WORDS = 'No brand words yet'
const NOT_READ_FOR_THESE_DAYS = 'Not read for these days'

/** One brand-split tile: its cost, and its clicks and conversions (they show even when the money is hidden). */
function splitTile(label: string, m: GoogleMetrics | null | undefined, currency: string | null, why: string, extra: Partial<Metric> = {}): Metric {
  return {
    label,
    value: formatMoney(m?.spendCents, currency),
    hint: m ? `${formatInt(m.clicks)} clicks · ${formatConversions(m.conversions)} conversions` : why,
    ...extra,
  }
}

export function GoogleSearchTermsGrid({ campaignId, account, window: range, currency, nextReadAt }: GoogleGrainGridProps) {
  const { from, to } = range
  const page = campaignId == null
  const terms = useGoogleRead(
    googleReadKey('search-terms', account, campaignId, from, to),
    () => fetchAllGooglePages<GoogleSearchTermsPage>((cursor) => fetchGoogleSearchTerms({ account, campaignId, from, to, sort: 'spend', limit: GOOGLE_PAGE_LIMIT, cursor })),
    { keepPrevious: true },
  )
  // The brand split is the account's (R9 takes no campaign): on the page only.
  const split = useGoogleRead<GoogleBrandSplit>(
    page ? googleReadKey('brand-split', account, from, to) : null,
    () => fetchGoogleBrandSplit({ account, from, to }),
    { keepPrevious: true },
  )

  const data = terms.data
  const ccy = data?.currency ?? currency
  const columns = useMemo(() => searchTermColumns(ccy, page), [ccy, page])
  const filters = useMemo(() => (page ? [BRAND_FILTER, TYPE_FILTER] : [BRAND_FILTER]), [page])
  const [filterState, setFilterState] = useState<FilterState>({})
  const brandOn = typeof filterState.brand === 'string' ? filterState.brand : ''
  const pickBrand = useCallback((value: 'brand' | 'non_brand') => setFilterState((s) => ({ ...s, brand: s.brand === value ? '' : value })), [])

  const brandTerms = data?.brandTerms ?? split.data?.brandTerms ?? null
  const all = split.data?.read.readAt ? split.data.rows.find((r) => r.campaignType === 'ALL') ?? null : null
  const known = !!brandTerms?.terms.length
  // The split's own gaps only when they differ from the list's (the banner above already names the list's).
  const splitGaps = split.data ? coverageNote(split.data) : null
  const splitGapsOwn = splitGaps && splitGaps !== (data ? coverageNote(data) : null) ? splitGaps : null
  const brandWhy = known ? NOT_READ_FOR_THESE_DAYS : NO_BRAND_WORDS
  const tiles: Metric[] | null = page && all ? [
    splitTile('Brand', known ? all.brand : null, split.data?.currency ?? ccy, brandWhy, known ? { onClick: () => pickBrand('brand'), active: brandOn === 'brand' } : {}),
    splitTile('Not brand', known ? all.nonBrand : null, split.data?.currency ?? ccy, brandWhy, known ? { onClick: () => pickBrand('non_brand'), active: brandOn === 'non_brand' } : {}),
    splitTile('Not in the search-term list', all.notInSearchTerms, split.data?.currency ?? ccy, NOT_READ_FOR_THESE_DAYS),
  ] : null

  return (
    <GoogleGrainState
      noun={NOUN.searchTerm} scope={page ? 'account' : 'campaign'}
      load={{ loading: terms.loading, has: !!data, error: terms.error, reload: terms.reload }}
      read={data?.read ?? null} coverage={data?.coverage ?? null}
      count={data?.items.length ?? 0} windowed truncated={data?.truncated} nextReadAt={nextReadAt}
      above={(
        <>
          {tiles && <MetricStrip metrics={tiles} />}
          {tiles && splitGapsOwn && <p className="gads-note">Brand split: {splitGapsOwn}</p>}
          {page && split.error && <p className="gads-note">The brand split could not be loaded: {split.error}</p>}
          <p className="gads-brand">
            <span>{brandRuleText(brandTerms?.terms ?? [])}</span>
            {brandTerms?.editHref && (
              <Button asChild variant="link" inline><Link href={brandTerms.editHref}>{known ? 'Change the brand words' : 'Add your brand words'}</Link></Button>
            )}
          </p>
          <p className="gads-meta">{SEARCH_TERM_SCOPE_TEXT}</p>
        </>
      )}
    >
      <AdsDataGrid<GoogleSearchTerm>
        rows={data?.items ?? []}
        loading={terms.loading}
        rowId={rowId}
        noun="Search term"
        firstColLabel="Search term"
        renderFirst={renderFirst}
        firstSortValue={firstSort}
        columns={columns}
        filters={filters}
        filterState={filterState}
        onFilterStateChange={setFilterState}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search the search terms…"
        searchValue={searchValue}
        showTotal
        totalFirst="Total of the search terms shown"
        defaultSort={{ key: 'cost', dir: 'desc' }}
        storageKey={page ? 'h10-google-search-terms-cols' : 'h10-google-campaign-search-terms-cols'}
        // No row checkboxes: nothing here acts on a selection (Nexus only reads Google Ads).
        selectable={false}
        emptyLabel="No search terms match these filters."
      />
    </GoogleGrainState>
  )
}
