'use client'

/**
 * Phase 10 — Cross-system advertising intelligence tab.
 *
 * Embedded inside the /products/[id]/edit workspace as the "Ads" tab.
 * Walks the join chain AdProductAd → AdGroup → Campaign →
 * AmazonAdsDailyPerformance + AmazonAdsSearchTerm to surface ad
 * performance for this specific product.
 *
 * Data is lazy-loaded on first render (the API call is skipped until
 * the operator opens the tab, keeping the edit page fast).
 */

import { useEffect, useState } from 'react'
import {
  Loader2, ExternalLink, TrendingDown, TrendingUp, Search,
  Activity, AlertCircle, BarChart2, Layers, Star,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface CampaignRow {
  id: string
  externalCampaignId: string | null
  name: string
  adProduct: string
  marketplace: string
  status: string
  impressions: number
  clicks: number
  orders: number
  spendCents: number
  adSalesCents: number
  currencyCode: string
  acos: number | null
  hasV1Data: boolean
}

interface SearchTermRow {
  query: string
  matchType: string | null
  adProduct: string
  marketplace: string
  impressions: number
  clicks: number
  orders: number
  spendCents: number
  adSalesCents: number
  acos: number | null
}

interface Summary {
  campaignCount: number
  productAdCount: number
  totalSpendCents: number
  totalAdSalesCents: number
  acos: number | null
  windowDays: number
  sbCreatives?: number
  multiProductCreatives?: number
}

interface CreativeProduct {
  productIdType: 'ASIN' | 'SKU' | string | null
  productId: string | null
  isCurrent: boolean
  siblingName: string | null
  siblingSku: string | null
  siblingProductId: string | null
}

interface CreativeRow {
  id: string
  externalAdId: string | null
  adType: string | null
  status: string
  deliveryStatus: string | null
  deliveryReasons: string[]
  campaignName: string | null
  campaignAdProduct: string | null
  marketplace: string | null
  adGroupName: string | null
  productCount: number
  products: CreativeProduct[]
}

interface ProductAdsData {
  windowDays: number
  productAds: number
  campaigns: CampaignRow[]
  searchTerms: SearchTermRow[]
  creatives?: CreativeRow[]
  summary: Summary | null
}

function fmtEur(cents: number, currency = 'EUR') {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency,
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(cents / 100)
}

function fmtPct(v: number | null) {
  return v != null ? `${v.toFixed(1)}%` : '—'
}

function acosColor(acos: number | null) {
  if (acos == null) return 'text-slate-400'
  if (acos > 35) return 'text-red-600 dark:text-red-400'
  if (acos > 20) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'ENABLED'
      ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-800'
      : status === 'PAUSED'
        ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-800'
        : 'bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 ring-slate-200 dark:ring-slate-700'
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${cls}`}>
      {status}
    </span>
  )
}

function KpiTile({
  label, value, sub, color = '',
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">{label}</p>
      <p className={`text-xl font-bold tabular-nums mt-0.5 ${color || 'text-slate-800 dark:text-slate-100'}`}>{value}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export function AdsTab({
  productId,
  asin,
  sku,
}: {
  productId: string
  asin?: string | null
  sku: string
}) {
  const [data, setData] = useState<ProductAdsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [windowDays, setWindowDays] = useState(30)

  async function load(days: number) {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ windowDays: String(days), productId })
      if (asin) qs.set('asin', asin)
      qs.set('sku', sku)
      const res = await fetch(`${getBackendUrl()}/api/advertising/product-ads?${qs}`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(windowDays) }, [windowDays]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading ad performance…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-red-600 dark:text-red-400">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    )
  }

  if (!data || data.productAds === 0) {
    return (
      <div className="py-12 text-center">
        <BarChart2 className="h-8 w-8 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
        <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">
          No ad placements found for this product
        </p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-xs mx-auto">
          Ad data populates once the SD sync runs and links campaigns to this
          SKU / ASIN via AdProductAd. Check back after the next cron tick.
        </p>
        <a
          href="/marketing/advertising/campaigns"
          target="_blank"
          className="inline-flex items-center gap-1 mt-3 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          Open Campaigns <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    )
  }

  const { summary, campaigns, searchTerms } = data
  const creatives = data.creatives ?? []

  return (
    <div className="space-y-5 py-2">
      {/* Window picker */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {data.productAds} ad placement{data.productAds !== 1 ? 's' : ''} across{' '}
          {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''}
        </p>
        <div className="flex items-center gap-1">
          {[7, 14, 30, 60].map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                windowDays === d
                  ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 border-slate-800 dark:border-slate-200'
                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary tiles */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <KpiTile
            label="Ad Spend"
            value={fmtEur(summary.totalSpendCents)}
            sub={`last ${windowDays} days`}
          />
          <KpiTile
            label="Ad Sales"
            value={fmtEur(summary.totalAdSalesCents)}
            sub="7-day attribution"
          />
          <KpiTile
            label="ACOS"
            value={fmtPct(summary.acos)}
            color={acosColor(summary.acos)}
          />
          <KpiTile
            label="Campaigns"
            value={String(summary.campaignCount)}
            sub={`${data.productAds} ad slots`}
          />
        </div>
      )}

      {/* Campaign table */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" aria-hidden />
          Campaigns
        </h3>
        <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                {['Campaign', 'Market', 'Status', 'Impressions', 'Clicks', 'Orders', 'Spend', 'Ad Sales', 'ACOS', ''].map((h) => (
                  <th key={h} className="px-2 py-1.5 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {campaigns.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-2 py-1.5 text-xs text-slate-700 dark:text-slate-300 max-w-[180px] truncate font-medium">
                    {c.name}
                  </td>
                  <td className="px-2 py-1.5 text-xs font-mono text-slate-500">{c.marketplace}</td>
                  <td className="px-2 py-1.5"><StatusBadge status={c.status} /></td>
                  <td className="px-2 py-1.5 text-xs tabular-nums text-slate-500">
                    {c.hasV1Data ? c.impressions.toLocaleString() : <span className="text-slate-300 dark:text-slate-600">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-xs tabular-nums text-slate-500">
                    {c.hasV1Data ? c.clicks.toLocaleString() : <span className="text-slate-300 dark:text-slate-600">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-xs tabular-nums text-slate-500">
                    {c.hasV1Data ? c.orders : <span className="text-slate-300 dark:text-slate-600">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-xs tabular-nums text-slate-700 dark:text-slate-300">
                    {c.hasV1Data ? fmtEur(c.spendCents, c.currencyCode) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-xs tabular-nums text-slate-700 dark:text-slate-300">
                    {c.hasV1Data && c.adSalesCents > 0 ? fmtEur(c.adSalesCents, c.currencyCode) : '—'}
                  </td>
                  <td className={`px-2 py-1.5 text-xs tabular-nums font-medium ${acosColor(c.acos)}`}>
                    {fmtPct(c.acos)}
                  </td>
                  <td className="px-2 py-1.5">
                    <a
                      href="/marketing/advertising/campaigns"
                      target="_blank"
                      className="text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
                      title="Open Campaigns"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!campaigns.some((c) => c.hasV1Data) && (
          <p className="text-xs text-slate-400 mt-1.5">
            No Reports API data yet for this window — run a campaign report cycle from{' '}
            <a href="/marketing/advertising/reports" target="_blank" className="underline hover:text-slate-600">
              Reports
            </a>
            .
          </p>
        )}
      </section>

      {/* Search terms */}
      {searchTerms.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5" aria-hidden />
            Top Search Terms ({windowDays}d)
          </h3>
          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
                  {['Query', 'Match', 'Clicks', 'Orders', 'Spend', 'ACOS'].map((h) => (
                    <th key={h} className="px-2 py-1.5 text-left text-[10px] font-medium text-slate-500 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {searchTerms.map((st, i) => (
                  <tr key={i} className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${st.orders === 0 && st.spendCents > 50 ? 'bg-amber-50/50 dark:bg-amber-900/10' : ''}`}>
                    <td className="px-2 py-1.5 text-xs font-mono text-slate-700 dark:text-slate-300 max-w-[200px] truncate">
                      {st.query}
                      {st.orders === 0 && st.spendCents > 50 && (
                        <TrendingDown className="inline h-3 w-3 text-amber-500 ml-1" aria-label="No orders" />
                      )}
                      {st.orders > 0 && (
                        <TrendingUp className="inline h-3 w-3 text-emerald-500 ml-1" aria-label="Converting" />
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-slate-400">{st.matchType ?? '—'}</td>
                    <td className="px-2 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">{st.clicks}</td>
                    <td className="px-2 py-1.5 text-xs tabular-nums text-slate-600 dark:text-slate-400">{st.orders}</td>
                    <td className="px-2 py-1.5 text-xs tabular-nums text-slate-700 dark:text-slate-300">{fmtEur(st.spendCents)}</td>
                    <td className={`px-2 py-1.5 text-xs tabular-nums font-medium ${acosColor(st.acos)}`}>
                      {fmtPct(st.acos)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            <a href="/marketing/advertising/search-terms" target="_blank" className="hover:underline text-blue-500">
              View all search terms →
            </a>
          </p>
        </section>
      )}

      {/* Creatives — multi-product creative envelope from v1 export */}
      {creatives.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5" aria-hidden />
            Ad Creatives ({creatives.length})
            {summary?.multiProductCreatives ? (
              <span className="ml-1 text-[10px] text-slate-400 normal-case tracking-normal">
                · {summary.multiProductCreatives} multi-product
              </span>
            ) : null}
          </h3>
          <div className="space-y-2">
            {creatives.map((cr) => (
              <div key={cr.id} className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                        {cr.campaignName ?? '(unknown campaign)'}
                      </span>
                      {cr.campaignAdProduct && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                          {cr.campaignAdProduct === 'SPONSORED_PRODUCTS' ? 'SP'
                            : cr.campaignAdProduct === 'SPONSORED_BRANDS' ? 'SB'
                            : 'SD'}
                        </span>
                      )}
                      {cr.adType && cr.adType !== 'PRODUCT_AD' && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
                          {cr.adType.replace('_', ' ')}
                        </span>
                      )}
                      <StatusBadge status={cr.status} />
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {cr.adGroupName ?? '(no ad-group name)'}{' '}
                      {cr.marketplace && <span className="text-slate-400">· {cr.marketplace}</span>}
                    </p>
                  </div>
                  {cr.productCount > 1 && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-800">
                      Multi · {cr.productCount}
                    </span>
                  )}
                </div>

                {/* Product entries */}
                <ul className="space-y-1">
                  {cr.products.map((p, i) => (
                    <li
                      key={i}
                      className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                        p.isCurrent
                          ? 'bg-blue-50 dark:bg-blue-950/40 ring-1 ring-inset ring-blue-200 dark:ring-blue-800'
                          : 'bg-slate-50 dark:bg-slate-800/40'
                      }`}
                    >
                      {p.isCurrent ? (
                        <Star className="h-3 w-3 text-blue-500 fill-blue-500 shrink-0" aria-label="This product" />
                      ) : (
                        <span className="h-3 w-3 shrink-0" />
                      )}
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 w-8 shrink-0">
                        {p.productIdType}
                      </span>
                      <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
                        {p.productId ?? '—'}
                      </span>
                      {p.siblingName && (
                        <a
                          href={p.siblingProductId ? `/products/${p.siblingProductId}/edit?tab=ads` : '#'}
                          className="text-slate-500 dark:text-slate-400 truncate hover:underline"
                          title={p.siblingName}
                        >
                          → {p.siblingName}
                        </a>
                      )}
                      {p.isCurrent && (
                        <span className="ml-auto text-[10px] text-blue-700 dark:text-blue-300 font-medium uppercase tracking-wider shrink-0">
                          This product
                        </span>
                      )}
                    </li>
                  ))}
                </ul>

                {/* Delivery status */}
                {cr.deliveryStatus && cr.deliveryStatus !== 'DELIVERING' && cr.deliveryReasons.length > 0 && (
                  <p className="text-[10px] text-amber-700 dark:text-amber-300 mt-2">
                    Not delivering: {cr.deliveryReasons.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-1.5">
            Creative data populated by the v1 export pipeline. SB ads typically
            bundle multiple ASINs in one creative; SP ads usually serve one ASIN.
          </p>
        </section>
      )}

      {/* Links */}
      <div className="flex items-center gap-4 pt-1 border-t border-slate-100 dark:border-slate-800">
        {[
          { href: '/marketing/advertising/analytics', label: 'Analytics' },
          { href: '/marketing/advertising/insights',  label: 'Insights' },
          { href: '/marketing/advertising/campaigns', label: 'All Campaigns' },
        ].map(({ href, label }) => (
          <a
            key={href}
            href={href}
            target="_blank"
            className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {label} <ExternalLink className="h-3 w-3" />
          </a>
        ))}
      </div>
    </div>
  )
}
