'use client'

/**
 * Google Ads step 1b, WB — the products Google Ads advertises (R11: Shopping and Performance Max), on the page's
 * Products tab (`campaignId` null: every campaign, with the Campaign and Type columns) and in the campaign window (one
 * campaign). Words first (product with its item id, the Nexus product with exactly that SKU, whether Google shows it
 * and Google's own sentences why not), then the nine metric columns every Google grid uses. By cost.
 *
 * Read only: no control here changes Google Ads.
 */
import { useMemo } from 'react'
import Link from '@/lib/workspaces/Link'
import { Pill } from '@/design-system/primitives'
import { fetchAllGooglePages, fetchGoogleProducts, GOOGLE_PAGE_LIMIT, type GoogleProduct, type GoogleProductsPage } from '@/lib/google-ads/contract'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../campaigns/_grid/AdsDataGrid'
import { GoogleGrainState } from './GoogleGrainState'
import type { GoogleGrainGridProps } from './GoogleSearchTermsGrid'
import { campaignTypeLabel, metricColumns, TYPE_FILTER_OPTIONS } from './googleAds'
import { NOUN, notReadYet, PRODUCT_STATUS_OPTIONS, productIssuesText, productStatusWord } from './googleGrains'
import { googleReadKey, useGoogleRead } from './useGoogleRead'

const rowId = (r: GoogleProduct) => r.productKey
const firstSort = (r: GoogleProduct) => (r.title ?? r.itemId).toLowerCase()
const searchValue = (r: GoogleProduct) => `${r.title ?? ''} ${r.itemId} ${r.nexusProduct?.sku ?? ''}`
const metricsOf = (r: GoogleProduct) => r.metrics
const renderFirst = (r: GoogleProduct) => (
  <span className="gads-two" title={r.title ?? r.itemId}>
    <span>{r.title?.trim() || r.itemId}</span>
    <span className="gads-sub">Item ID {r.itemId}</span>
  </span>
)

export function productColumns(currency: string | null, withCampaign: boolean): GridColumn<GoogleProduct>[] {
  return [
    {
      key: 'nexus', label: 'In Nexus', metric: false, tip: 'The Nexus product whose SKU is exactly this item id.',
      sortValue: (r) => r.nexusProduct?.sku.toLowerCase() ?? null,
      render: (r) => (r.nexusProduct
        ? <Link href={`/products/${encodeURIComponent(r.nexusProduct.productId)}/edit`} title={r.nexusProduct.name}>{r.nexusProduct.sku}</Link>
        : <span className="gads-dim">Not matched</span>),
    },
    {
      key: 'status', label: 'Status', metric: false, tip: 'Whether Google shows the product, from Merchant Center.',
      sortValue: (r) => productStatusWord(r.status).text,
      render: (r) => {
        const w = productStatusWord(r.status)
        const why = productIssuesText(r)
        return (
          <span className="gads-status" title={why ?? undefined}>
            {r.status ? <Pill tone={w.tone} size="sm">{w.text}</Pill> : <span className="gads-dim">{w.text}</span>}
            {why && <span className="gads-dim">{why.split('\n')[0]}</span>}
          </span>
        )
      },
    },
    ...(withCampaign ? [
      { key: 'campaign', label: 'Campaign', metric: false, sortValue: (r: GoogleProduct) => r.campaignName?.toLowerCase() ?? null, render: (r: GoogleProduct) => <span className="gads-camp" title={r.campaignName ?? undefined}>{r.campaignName ?? '—'}</span> },
      { key: 'type', label: 'Type', metric: false, sortValue: (r: GoogleProduct) => campaignTypeLabel(r.campaignType), render: (r: GoogleProduct) => (r.campaignType ? campaignTypeLabel(r.campaignType) : '—') },
    ] satisfies GridColumn<GoogleProduct>[] : []),
    ...metricColumns<GoogleProduct>(metricsOf, currency),
  ]
}

const STATUS_FILTER: GridFilter = { key: 'status', label: 'Status', kind: 'select', options: PRODUCT_STATUS_OPTIONS, placeholder: 'All', value: (r) => (r as GoogleProduct).status ?? '' }
const TYPE_FILTER: GridFilter = { key: 'type', label: 'Campaign type', kind: 'select', options: TYPE_FILTER_OPTIONS, placeholder: 'All', value: (r) => campaignTypeLabel((r as GoogleProduct).campaignType) }

export function GoogleProductsGrid({ campaignId, account, window: range, currency, nextReadAt }: GoogleGrainGridProps) {
  const { from, to } = range
  const page = campaignId == null
  const read = useGoogleRead(
    googleReadKey('products', account, campaignId, from, to),
    () => fetchAllGooglePages<GoogleProductsPage>((cursor) => fetchGoogleProducts({ account, campaignId, from, to, sort: 'spend', limit: GOOGLE_PAGE_LIMIT, cursor })),
    { keepPrevious: true },
  )
  const data = read.data
  const ccy = data?.currency ?? currency
  const columns = useMemo(() => productColumns(ccy, page), [ccy, page])
  const filters = useMemo(() => (page ? [STATUS_FILTER, TYPE_FILTER] : [STATUS_FILTER]), [page])
  // The list is the products Google reported numbers or a status for: read when either was read.
  const listRead = data ? (notReadYet(data.numbersRead) ? data.statusRead : data.numbersRead) : null
  const statusNotRead = data != null && !notReadYet(listRead) && notReadYet(data.statusRead)

  return (
    <GoogleGrainState
      noun={NOUN.product} scope={page ? 'account' : 'campaign'}
      load={{ loading: read.loading, has: !!data, error: read.error, reload: read.reload }}
      read={listRead} numbersRead={data?.numbersRead ?? null} coverage={data?.coverage ?? null}
      count={data?.items.length ?? 0} windowed truncated={data?.truncated} nextReadAt={nextReadAt}
      note={statusNotRead ? 'Nexus has not read from Merchant Center whether Google shows these products yet.' : null}
    >
      <AdsDataGrid<GoogleProduct>
        rows={data?.items ?? []}
        loading={read.loading}
        rowId={rowId}
        noun="Product"
        firstColLabel="Product"
        renderFirst={renderFirst}
        firstSortValue={firstSort}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search products, item ids or SKUs…"
        searchValue={searchValue}
        showTotal
        totalFirst="Total of the products shown"
        defaultSort={{ key: 'cost', dir: 'desc' }}
        storageKey={page ? 'h10-google-products-cols' : 'h10-google-campaign-products-cols'}
        rowHeight={56}
        // No row checkboxes: nothing here acts on a selection (Nexus only reads Google Ads).
        selectable={false}
        emptyLabel="No products match these filters."
      />
    </GoogleGrainState>
  )
}
