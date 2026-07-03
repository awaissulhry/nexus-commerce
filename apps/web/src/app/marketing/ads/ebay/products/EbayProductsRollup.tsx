'use client'

/**
 * E6.1 — Products, rebuilt on the console idiom: ONE AdsDataGrid of live
 * LISTINGS grouped by resolved product (group bands = product name + count;
 * "Unmatched listings" band last, nothing hidden). Rows carry price/qty/
 * break-even/promoted-state pills + full window metrics with totals.
 * Per-row hover action = Promote; selection → bulk Promote.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Megaphone, ExternalLink } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { eur, int, pct, latestReportLabel } from '../../campaigns/_grid/format'
import '../ebay.css'
import {
  useEbayAdsFetch, EBAY_MARKETS, PRESETS, useWriteMode, SandboxBanner,
  type ProductsPayload, type ProductListingRow,
} from '../_shared'
import { PromoteModal } from '../_write-modals'

interface Row extends ProductListingRow {
  groupKey: string
  groupLabel: string
  productSku: string | null
  hasCost: boolean
}

export function EbayProductsRollup() {
  const router = useRouter()
  const [market, setMarket] = useState('all')
  const [preset, setPreset] = useState('last30')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [promote, setPromote] = useState<{ listingIds: string[] } | null>(null)
  const writeMode = useWriteMode()
  const { data, error, loading, reload } = useEbayAdsFetch<ProductsPayload>('/products', market, preset)

  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const out: Row[] = []
    for (const p of data.products) {
      for (const l of p.listings) {
        out.push({ ...l, groupKey: p.productId, groupLabel: p.name ?? p.sku ?? p.productId, productSku: p.sku, hasCost: p.hasCost })
      }
    }
    for (const l of data.unmatchedListings) {
      out.push({ ...l, groupKey: '~unmatched', groupLabel: 'Unmatched listings (no SKU on eBay — real spend still counted)', productSku: null, hasCost: false })
    }
    return out
  }, [data])

  const columns: GridColumn<Row>[] = useMemo(() => [
    {
      key: 'state', label: 'State', metric: false, sortValue: (r) => r.matchStatus,
      render: (r) => r.matchStatus === 'MATCHED' || r.matchStatus === 'CONFIRMED'
        ? <span className="h10-pill ok">Matched</span>
        : <span className="h10-pill warn" title="No SKU on the eBay listing — match actions land with the match queue">Unmatched</span>,
    },
    { key: 'price', label: 'Price', render: (r) => (r.priceCents != null ? eur(r.priceCents / 100) : '—'), sortValue: (r) => r.priceCents ?? -1, filterValue: (r) => (r.priceCents ?? 0) / 100 },
    { key: 'qty', label: 'Qty', render: (r) => (r.quantity != null ? int(r.quantity) : '—'), sortValue: (r) => r.quantity ?? -1 },
    {
      key: 'breakeven', label: 'Break-even', tip: 'Max profitable General ad rate = contribution margin ÷ total sale amount. "Add cost" = no product cost on file yet (manual-only for automations).',
      render: (r) => r.breakEvenAdRatePct != null
        ? <span>{pct(r.breakEvenAdRatePct / 100)}</span>
        : r.economicsStatus === 'MISSING_PRICE' ? <span className="h10-pill arch">no price</span> : <span className="h10-pill warn">add cost</span>,
      sortValue: (r) => r.breakEvenAdRatePct ?? -1,
    },
    { key: 'impressions', label: 'Impressions', render: (r) => int(r.metrics.impressions), sortValue: (r) => r.metrics.impressions, filterValue: (r) => r.metrics.impressions, total: int(rows.reduce((a, r) => a + r.metrics.impressions, 0)) },
    { key: 'clicks', label: 'Clicks', render: (r) => int(r.metrics.clicks), sortValue: (r) => r.metrics.clicks, filterValue: (r) => r.metrics.clicks, total: int(rows.reduce((a, r) => a + r.metrics.clicks, 0)) },
    { key: 'ctr', label: 'CTR', render: (r) => (r.metrics.ctrPct != null ? pct(r.metrics.ctrPct / 100) : '—'), sortValue: (r) => r.metrics.ctrPct ?? -1 },
    { key: 'spend', label: 'Ad Fees', render: (r) => eur(r.metrics.adFeesCents / 100), sortValue: (r) => r.metrics.adFeesCents, filterValue: (r) => r.metrics.adFeesCents / 100, total: eur(rows.reduce((a, r) => a + r.metrics.adFeesCents, 0) / 100) },
    { key: 'sales', label: 'Ad Sales', tip: 'Any-click attributed sales.', render: (r) => eur(r.metrics.salesCents / 100), sortValue: (r) => r.metrics.salesCents, filterValue: (r) => r.metrics.salesCents / 100, total: eur(rows.reduce((a, r) => a + r.metrics.salesCents, 0) / 100) },
    {
      key: 'acos', label: 'eBay ACOS', render: (r) => (r.metrics.acosPct != null ? pct(r.metrics.acosPct / 100) : '—'), sortValue: (r) => r.metrics.acosPct ?? -1,
      total: (() => { const f = rows.reduce((a, r) => a + r.metrics.adFeesCents, 0); const s = rows.reduce((a, r) => a + r.metrics.salesCents, 0); return s > 0 ? pct(f / s) : '—' })(),
    },
    { key: 'sold', label: 'Sold', render: (r) => int(r.metrics.soldQty), sortValue: (r) => r.metrics.soldQty, total: int(rows.reduce((a, r) => a + r.metrics.soldQty, 0)) },
  ], [rows])

  const filters: GridFilter[] = useMemo(() => [
    { key: 'state', label: 'Match state', kind: 'select', options: [{ value: 'MATCHED', label: 'Matched' }, { value: 'UNMATCHED', label: 'Unmatched' }], placeholder: 'All', value: (r) => ((r as Row).matchStatus === 'MATCHED' || (r as Row).matchStatus === 'CONFIRMED' ? 'MATCHED' : 'UNMATCHED') },
    { key: 'spend', label: 'Ad Fees', kind: 'range', unit: '€' },
    { key: 'price', label: 'Price', kind: 'range', unit: '€' },
    { key: 'impressions', label: 'Impressions', kind: 'range' },
    { key: 'clicks', label: 'Clicks', kind: 'range' },
  ], [])

  return (
    <div className="h10-am">
      <AdsPageHeader
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
          <div className="nmw">
            <span className="t" title={r.title ?? r.itemId}>{r.title ?? r.itemId}</span>
            <span className="mk">{r.itemId.slice(-6)}</span>
            {r.productSku && <span className="mk" title={r.productSku}>{r.productSku.length > 14 ? `${r.productSku.slice(0, 13)}…` : r.productSku}</span>}
            <a className="h10-open" href={`https://www.ebay.it/itm/${r.itemId}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Open</a>
            <button type="button" className="h10-open" style={{ background: '#0a7d4d' }} onClick={(e) => { e.stopPropagation(); setPromote({ listingIds: [r.itemId] }) }}><Megaphone size={11} /> Promote</button>
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
        toolbarLeft={
          <select className="h10-am-btn" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range" style={{ paddingRight: 8 }}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        }
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
    </div>
  )
}
