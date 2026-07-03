'use client'

/**
 * E3 — product-first rollup: each Nexus product with EVERY live eBay item ID
 * behind it (the resolver's union), aggregated window performance, and cost
 * readiness. Unmatched listings (legacy, no SKUs) surface in their own panel
 * so nothing is silently invisible — matching actions land in E4.
 */
import { useMemo, useState } from 'react'
import { ExternalLink, Megaphone } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { Button } from '@/design-system/primitives/Button'
import { PromoteModal } from '../_write-modals'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Select } from '@/design-system/primitives/Select'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../ebay.css'
import {
  useEbayAdsFetch, EBAY_MARKETS, PRESETS, eurC, pctP, intlN,
  FreshnessLine, BreakEvenCell, type ProductsPayload, type ProductListingRow,
} from '../_shared'

type ProductRow = ProductsPayload['products'][number]

export function EbayProductsRollup() {
  const [market, setMarket] = useState('all')
  const [preset, setPreset] = useState('last30')
  const { data, error, loading, reload } = useEbayAdsFetch<ProductsPayload>('/products', market, preset)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedUnmatched, setSelectedUnmatched] = useState<Set<string>>(new Set())
  const [promoteOpen, setPromoteOpen] = useState(false)

  const productColumns: Column<ProductRow>[] = useMemo(() => [
    {
      key: 'product', label: 'Product', sticky: true, width: 300, sortable: true, sortValue: (p) => p.sku ?? '',
      render: (p) => (
        <div className="eb-cell-name">
          <span className="nm">{p.name ?? p.sku ?? p.productId}</span>
          <span className="sub">{p.sku ?? '—'}{!p.hasCost && <span className="eb-chip eb-chip--warn" title="No cost on file — break-even unavailable; manual-only for automations">add cost</span>}</span>
        </div>
      ),
    },
    {
      key: 'listings', label: 'Live listings', width: 210,
      render: (p) => (
        <span className="eb-itemids">
          {p.listings.map((l) => (
            <a key={l.itemId} href={`https://www.ebay.it/itm/${l.itemId}`} target="_blank" rel="noopener noreferrer" className="eb-chip eb-chip--item" title={`${l.title ?? l.itemId} · ${l.marketplace} · ${l.priceCents != null ? eurC(l.priceCents) : ''}`}>
              {l.itemId.slice(-6)} <ExternalLink size={10} aria-hidden />
            </a>
          ))}
        </span>
      ),
    },
    { key: 'breakEven', label: 'Break-even', align: 'right', width: 100, render: (p) => { const l = p.listings.find((x) => x.breakEvenAdRatePct != null) ?? p.listings[0]; return l ? <BreakEvenCell pct={l.breakEvenAdRatePct} status={l.economicsStatus} /> : <span>—</span> } },
    { key: 'impr', label: 'Impr.', align: 'right', width: 90, sortable: true, sortValue: (p) => p.metrics.impressions, render: (p) => intlN(p.metrics.impressions) },
    { key: 'clicks', label: 'Clicks', align: 'right', width: 80, sortable: true, sortValue: (p) => p.metrics.clicks, render: (p) => intlN(p.metrics.clicks) },
    { key: 'ctr', label: 'CTR', align: 'right', width: 80, render: (p) => pctP(p.metrics.ctrPct, 2) },
    { key: 'fees', label: 'Ad fees', align: 'right', width: 100, sortable: true, sortValue: (p) => p.metrics.adFeesCents, render: (p) => eurC(p.metrics.adFeesCents) },
    { key: 'sales', label: 'Ad sales', align: 'right', width: 105, sortable: true, sortValue: (p) => p.metrics.salesCents, render: (p) => eurC(p.metrics.salesCents) },
    { key: 'acos', label: 'eBay ACOS', align: 'right', width: 100, sortable: true, sortValue: (p) => p.metrics.acosPct ?? -1, render: (p) => pctP(p.metrics.acosPct) },
    { key: 'sold', label: 'Sold', align: 'right', width: 70, sortable: true, sortValue: (p) => p.metrics.soldQty, render: (p) => intlN(p.metrics.soldQty) },
  ], [])

  const unmatchedColumns: Column<ProductListingRow>[] = useMemo(() => [
    {
      key: 'listing', label: 'Listing', sticky: true, width: 340, sortable: true, sortValue: (l) => l.title ?? l.itemId,
      render: (l) => (
        <div className="eb-cell-name">
          <span className="nm">{l.title ?? l.itemId}</span>
          <span className="sub">
            <a href={`https://www.ebay.it/itm/${l.itemId}`} target="_blank" rel="noopener noreferrer" className="eb-extlink">{l.itemId} <ExternalLink size={11} aria-hidden /></a>
            {' '}· {l.marketplace}{l.priceCents != null && <> · {eurC(l.priceCents)}</>}{l.quantity != null && <> · qty {l.quantity}</>}
          </span>
        </div>
      ),
    },
    { key: 'impr', label: 'Impr.', align: 'right', width: 90, sortable: true, sortValue: (l) => l.metrics.impressions, render: (l) => intlN(l.metrics.impressions) },
    { key: 'clicks', label: 'Clicks', align: 'right', width: 80, sortable: true, sortValue: (l) => l.metrics.clicks, render: (l) => intlN(l.metrics.clicks) },
    { key: 'fees', label: 'Ad fees', align: 'right', width: 100, sortable: true, sortValue: (l) => l.metrics.adFeesCents, render: (l) => eurC(l.metrics.adFeesCents) },
    { key: 'sales', label: 'Ad sales', align: 'right', width: 105, render: (l) => eurC(l.metrics.salesCents) },
    { key: 'match', label: 'Match', width: 110, render: () => <span className="eb-chip eb-chip--warn" title="No SKU on the eBay listing — product matching lands with the E4 match queue">unmatched</span> },
  ], [])

  return (
    <div className="eb-page">
      <AdsPageHeader
        title="eBay Products"
        subtitle="Product-first view: every live eBay item ID behind each product, with aggregated ad performance."
        markets={EBAY_MARKETS.map((m) => m.id)}
        market={market}
        onMarketChange={setMarket}
      />

      <div className="eb-controls">
        <Select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <Button onClick={() => setPromoteOpen(true)} disabled={selected.size === 0 && selectedUnmatched.size === 0}>
          <Megaphone size={14} aria-hidden /> Promote {selected.size + selectedUnmatched.size > 0 ? `(${selected.size + selectedUnmatched.size})` : ''}
        </Button>
        <FreshnessLine f={data?.freshness} />
      </div>

      <PromoteModal
        open={promoteOpen}
        onClose={() => setPromoteOpen(false)}
        productIds={[...selected]}
        listingIds={[...selectedUnmatched]}
        onDone={reload}
      />

      {error && <Banner tone="danger" title="Couldn't load product rollups">{error} — <button className="eb-linkbtn" onClick={reload}>retry</button></Banner>}
      {loading && <Skeleton height={420} />}

      {data && !loading && (
        <>
          <section className="eb-panel">
            <header className="eb-panel-head"><h3>Products with live eBay listings ({data.products.length})</h3><span className="eb-panel-note">Aggregates every mapped item ID per product · {data.window.since} → {data.window.until}</span></header>
            {data.products.length === 0 ? (
              <EmptyState title="No matched products yet" description="Listings match to products via their eBay SKUs and the shared-SKU map. Legacy listings without SKUs appear below until matched." />
            ) : (
              <DataGrid<ProductRow> columns={productColumns} rows={data.products} rowKey={(p) => p.productId} initialSort={{ key: 'fees', dir: 'desc' }} maxHeight={430} selectable selected={selected} onSelectedChange={setSelected} />
            )}
          </section>

          <section className="eb-panel">
            <header className="eb-panel-head"><h3>Unmatched live listings ({data.unmatchedListings.length})</h3><span className="eb-panel-note">Live on eBay but not yet linked to a product (legacy, no SKUs). They still show real ad performance — nothing is hidden.</span></header>
            {data.unmatchedListings.length === 0 ? (
              <EmptyState title="Everything is matched" description="All live eBay listings resolve to products." />
            ) : (
              <DataGrid<ProductListingRow> columns={unmatchedColumns} rows={data.unmatchedListings} rowKey={(l) => l.itemId} initialSort={{ key: 'impr', dir: 'desc' }} maxHeight={360} selectable selected={selectedUnmatched} onSelectedChange={setSelectedUnmatched} />
            )}
          </section>
        </>
      )}
    </div>
  )
}
