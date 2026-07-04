'use client'

/**
 * E6.1 — Products, rebuilt on the console idiom: ONE AdsDataGrid of live
 * LISTINGS grouped by resolved product (group bands = product name + count;
 * "Unmatched listings" band last, nothing hidden). Rows carry price/qty/
 * break-even/promoted-state pills + full window metrics with totals.
 * Per-row hover action = Promote; selection → bulk Promote.
 */
import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Megaphone, ExternalLink } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { DateRangePicker } from '../../_shell/DateRangePicker'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { eur, int, pct, latestReportLabel } from '../../campaigns/_grid/format'
import '../ebay.css'
import {
  useEbayAdsFetch, EBAY_MARKETS, useWriteMode, SandboxBanner,
  type ProductsPayload, type ProductListingRow,
} from '../_lib'
import { PromoteModal } from '../_modals/PromoteModal'
import { MatchModal } from './modals/MatchModal'
import { CostModal } from './modals/CostModal'

interface Row extends ProductListingRow {
  groupKey: string
  groupLabel: string
  productSku: string | null
  hasCost: boolean
  costPriceCents: number | null
}

const defaultRange = () => { const e = new Date(); e.setHours(0, 0, 0, 0); const s0 = new Date(e); s0.setDate(s0.getDate() - 29); return { start: s0, end: e } }

export function EbayProductsRollup() {
  const router = useRouter()
  // ER3.4 — dashboard deep link (?state=UNMATCHED) seeds the match-state filter
  const stateParam = useSearchParams().get('state')
  const [market, setMarket] = useState('all')
  const [dateRange, setDateRange] = useState(defaultRange)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [promote, setPromote] = useState<{ listingIds: string[] } | null>(null)
  const [matchRow, setMatchRow] = useState<Row | null>(null)
  const [costRow, setCostRow] = useState<Row | null>(null)
  const writeMode = useWriteMode()
  const { data, error, loading, reload } = useEbayAdsFetch<ProductsPayload>('/products', market, dateRange)

  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const out: Row[] = []
    for (const p of data.products) {
      for (const l of p.listings) {
        out.push({ ...l, groupKey: p.productId, groupLabel: p.name ?? p.sku ?? p.productId, productSku: p.sku, hasCost: p.hasCost, costPriceCents: p.costPriceCents })
      }
    }
    for (const l of data.unmatchedListings) {
      out.push({ ...l, groupKey: '~unmatched', groupLabel: 'Unmatched listings', productSku: null, hasCost: false, costPriceCents: null })
    }
    return out
  }, [data])

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'state', label: 'State', metric: false, sortValue: (r) => r.matchStatus,
      tip: 'Match a listing to a catalog product to unlock costs, break-evens and margin guardrails — ad spend is counted either way.',
      render: (r) => r.matchStatus === 'MATCHED' || r.matchStatus === 'CONFIRMED' || r.matchStatus === 'MANUAL'
        ? <span className="h10-pill ok" title={r.matchStatus === 'MANUAL' ? 'Operator-confirmed match (sticky across syncs)' : 'Matched via eBay SKU / listing map'}>Matched</span>
        : <button type="button" className="h10-am-btn sm" title="Link this listing to a catalog product — unlocks cost entry, break-evens and margin guardrails" onClick={(e) => { e.stopPropagation(); setMatchRow(r) }}>Match…</button>,
    },
    {
      key: 'promoted', label: 'Promoted', metric: false, sortValue: (r) => (r.campaigns?.length ?? 0),
      tip: 'Active campaigns carrying this listing — click a chip to open the campaign.',
      render: (r) => (r.campaigns && r.campaigns.length > 0)
        ? <span className="eb-promo-chips">{r.campaigns.map((c) => (
            <Link key={c.id} className="eb-promo-chip" href={`/marketing/ads/ebay/campaigns/${c.id}`} title={`${c.name}${c.adHidden ? ' — ad hidden by eBay (out of stock)' : ''}`} onClick={(e) => e.stopPropagation()}>
              <b>{c.fundingModel === 'COST_PER_SALE' ? 'GEN' : 'PRI'}</b> {c.name}{c.adHidden ? ' ⌀' : ''}
            </Link>
          ))}</span>
        : <span style={{ color: '#8a93a1' }}>—</span>,
    },
    { key: 'price', label: 'Price', render: (r) => (r.priceCents != null ? eur(r.priceCents / 100) : '—'), sortValue: (r) => r.priceCents ?? -1, filterValue: (r) => (r.priceCents ?? 0) / 100 },
    {
      key: 'qty', label: 'Qty', sortValue: (r) => r.quantity ?? -1,
      render: (r) => (
        <span className="eb-qty-cell">
          {r.quantity != null ? int(r.quantity) : '—'}
          {r.quantity === 0 && <span className="h10-pill warn" title="Out of stock — eBay auto-hides its ads until restock">OOS</span>}
          {r.quantity !== 0 && r.campaigns?.some((c) => c.adHidden) && <span className="h10-pill warn" title="An ad for this listing is hidden by eBay (auto-hide); it resurfaces on restock">hidden</span>}
        </span>
      ),
    },
    {
      key: 'breakeven', label: 'Break-even', tip: 'Max profitable General ad rate = contribution margin ÷ total sale amount. Click "add cost" to enter the unit cost right here — break-even computes immediately.',
      render: (r) => {
        if (r.breakEvenAdRatePct != null) {
          return <button type="button" className="h10-am-link" title={`Unit cost €${r.costPriceCents != null ? (r.costPriceCents / 100).toFixed(2) : '?'} — click to edit`} onClick={(e) => { e.stopPropagation(); setCostRow(r) }}>{pct(r.breakEvenAdRatePct / 100)}</button>
        }
        if (r.economicsStatus === 'MISSING_PRICE') return <span className="h10-pill arch">no price</span>
        if (r.groupKey === '~unmatched') return <button type="button" className="h10-am-btn sm" title="Match the listing to a product first" onClick={(e) => { e.stopPropagation(); setMatchRow(r) }}>match first</button>
        return <button type="button" className="h10-am-btn sm" title="Enter the unit cost — break-even + margin guardrails activate immediately" onClick={(e) => { e.stopPropagation(); setCostRow(r) }}>add cost</button>
      },
      sortValue: (r) => r.breakEvenAdRatePct ?? -1,
    },
    { key: 'impressions', label: 'Impressions', render: (r) => int(r.metrics.impressions), sortValue: (r) => r.metrics.impressions, filterValue: (r) => r.metrics.impressions, total: (vr) => int(vr.reduce((a, r) => a + r.metrics.impressions, 0)) },
    { key: 'clicks', label: 'Clicks', render: (r) => int(r.metrics.clicks), sortValue: (r) => r.metrics.clicks, filterValue: (r) => r.metrics.clicks, total: (vr) => int(vr.reduce((a, r) => a + r.metrics.clicks, 0)) },
    { key: 'ctr', label: 'CTR', render: (r) => (r.metrics.ctrPct != null ? pct(r.metrics.ctrPct / 100) : '—'), sortValue: (r) => r.metrics.ctrPct ?? -1 },
    { key: 'spend', label: 'Ad Fees', render: (r) => eur(r.metrics.adFeesCents / 100), sortValue: (r) => r.metrics.adFeesCents, filterValue: (r) => r.metrics.adFeesCents / 100, total: (vr) => eur(vr.reduce((a, r) => a + r.metrics.adFeesCents, 0) / 100) },
    { key: 'sales', label: 'Ad Sales', tip: 'Any-click attributed sales.', render: (r) => eur(r.metrics.salesCents / 100), sortValue: (r) => r.metrics.salesCents, filterValue: (r) => r.metrics.salesCents / 100, total: (vr) => eur(vr.reduce((a, r) => a + r.metrics.salesCents, 0) / 100) },
    {
      key: 'acos', label: 'eBay ACOS', render: (r) => (r.metrics.acosPct != null ? pct(r.metrics.acosPct / 100) : '—'), sortValue: (r) => r.metrics.acosPct ?? -1,
      total: (vr) => { const f = vr.reduce((a, r) => a + r.metrics.adFeesCents, 0); const s = vr.reduce((a, r) => a + r.metrics.salesCents, 0); return s > 0 ? pct(f / s) : '—' },
    },
    {
      key: 'roas', label: 'ROAS', tip: 'Attributed sales ÷ ad fees (any-click).',
      render: (r) => (r.metrics.adFeesCents > 0 ? (r.metrics.salesCents / r.metrics.adFeesCents).toFixed(2) : '—'),
      sortValue: (r) => (r.metrics.adFeesCents > 0 ? r.metrics.salesCents / r.metrics.adFeesCents : -1),
      total: (vr) => { const f = vr.reduce((a, r) => a + r.metrics.adFeesCents, 0); const sl = vr.reduce((a, r) => a + r.metrics.salesCents, 0); return f > 0 ? (sl / f).toFixed(2) : '—' },
    },
    { key: 'sold', label: 'Sold', render: (r) => int(r.metrics.soldQty), sortValue: (r) => r.metrics.soldQty, total: (vr) => int(vr.reduce((a, r) => a + r.metrics.soldQty, 0)) },
  ], [])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'state', label: 'Match state', kind: 'select', options: [{ value: 'MATCHED', label: 'Matched' }, { value: 'UNMATCHED', label: 'Unmatched' }], placeholder: 'All', value: (r) => ((r as Row).matchStatus === 'MATCHED' || (r as Row).matchStatus === 'CONFIRMED' || (r as Row).matchStatus === 'MANUAL' ? 'MATCHED' : 'UNMATCHED') },
    { key: 'spend', label: 'Ad Fees', kind: 'range', unit: '€' },
    { key: 'price', label: 'Price', kind: 'range', unit: '€' },
    { key: 'impressions', label: 'Impressions', kind: 'range' },
    { key: 'clicks', label: 'Clicks', kind: 'range' },
  ], [])

  return (
    <div className="h10-am">
      <AdsPageHeader
        channel="ebay"
        title="eBay Products"
        subtitle="Product-first: every live eBay listing, grouped by the product behind it — promote a product and all its item IDs come along."
        markets={EBAY_MARKETS.map((x) => x.id)}
        market={market}
        onMarketChange={setMarket}
        showLearn={false} showDataSync={false} showDateRange={false}
      />
      <SandboxBanner mode={writeMode} />
      {error && <div className="h10-am-latest" role="alert"><b>Load failed:</b> {error} · <button className="h10-am-link" onClick={reload}>Retry</button></div>}

      <AdsDataGrid<Row>
        rows={rows}
        loading={loading}
        rowId={(r) => r.itemId}
        noun="Listing"
        firstColLabel="Listing"
        renderFirst={(r) => (
          <div className="nmw eb-nmw-thumb">
            <span className="eb-thumb">{r.imageUrl ? <img src={r.imageUrl} alt="" loading="lazy" /> : <span className="ph" />}</span>
            <span className="body">
            <span className="t" title={r.title ?? r.itemId}>{r.title ?? r.itemId}</span>
            <span className="mk">{r.itemId.slice(-6)}</span>
            {r.productSku && <span className="mk" title={r.productSku}>{r.productSku.length > 14 ? `${r.productSku.slice(0, 13)}…` : r.productSku}</span>}
            <a className="h10-open" href={`https://www.ebay.it/itm/${r.itemId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
            <button type="button" className="h10-open" style={{ background: '#0a7d4d' }} onClick={(e) => { e.stopPropagation(); setPromote({ listingIds: [r.itemId] }) }}><Megaphone size={11} /> Promote</button>
            </span>
          </div>
        )}
        firstSortValue={(r) => (r.title ?? r.itemId).toLowerCase()}
        columns={columns}
        filters={filters}
        filtersDefaultOpen={false}
        searchable
        searchPlaceholder="Search listings / SKUs…"
        searchValue={(r) => `${r.title ?? ''} ${r.itemId} ${r.productSku ?? ''} ${r.groupLabel}`}
        groupBy={(r) => ({ key: r.groupKey, label: r.groupLabel })}
        initialFilters={stateParam ? { state: stateParam } : undefined}
        showTotal
        defaultSort={{ key: 'spend', dir: 'desc' }}
        storageKey="h10-ebay-products-cols"
        selected={selected}
        onSelectedChange={setSelected}
        selectionActions={(ids, clear) => (
          <span className="h10-bulkrow">
            <button type="button" className="h10-am-btn bulk" onClick={() => { setPromote({ listingIds: ids }); clear() }}><Megaphone size={13} /> Promote</button>
          </span>
        )}
        reportLabel={latestReportLabel([data?.freshness.factsReportedAt ?? null])}
        toolbarLeft={<DateRangePicker value={dateRange} onChange={(start, end) => setDateRange({ start, end })} />}
        toolbarRight={
          <button type="button" className="h10-am-btn primary" onClick={() => router.push('/marketing/ads/ebay/campaigns/new')}>New campaign</button>
        }
        emptyLabel="No live eBay listings indexed yet — discovery runs every 4 hours."
      />

      <PromoteModal
        open={promote != null}
        onClose={() => setPromote(null)}
        listingIds={promote?.listingIds ?? []}
        onDone={reload}
      />
      {matchRow && (
        <MatchModal
          open onClose={() => setMatchRow(null)}
          itemId={matchRow.itemId} marketplace={matchRow.marketplace} listingTitle={matchRow.title}
          onDone={reload}
        />
      )}
      {costRow && (
        <CostModal
          open onClose={() => setCostRow(null)}
          itemId={costRow.itemId} marketplace={costRow.marketplace} listingTitle={costRow.title}
          productSku={costRow.productSku} currentCostCents={costRow.costPriceCents}
          onDone={reload}
        />
      )}
    </div>
  )
}
