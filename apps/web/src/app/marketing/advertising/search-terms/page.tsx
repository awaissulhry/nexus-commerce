/**
 * Phase 5c — Search-term explorer.
 *
 * Lists aggregated search queries that triggered ads in the last N days
 * (default 30). Server-renders with filter params from URL search params
 * so the page is shareable + bookmarkable. Negative-keyword candidates
 * (high spend, zero orders) are highlighted in amber and pulled to the
 * top by default.
 *
 * Data source: AmazonAdsSearchTerm table, populated by Phase 6 search-
 * term report ingestion (spSearchTerm / sbSearchTerm). SD has no
 * equivalent so it never appears here.
 */

import { Search, AlertTriangle, Filter } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface SearchTermRow {
  query: string
  matchType: string | null
  campaignId: string
  adGroupId: string
  marketplace: string
  adProduct: string
  currencyCode: string
  impressions: number
  clicks: number
  costMicros: string
  costUnits: number
  salesCents: number
  orders: number
  acos: number | null
  roas: number | null
  ctr: number | null
  cpc: number | null
  isCandidate: boolean
}

interface SearchTermResponse {
  lookbackDays: number
  count: number
  items: SearchTermRow[]
}

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

function formatPct(value: number | null, digits = 1): string {
  if (value == null) return '—'
  return `${(value).toFixed(digits)}%`
}

function formatRatio(value: number | null): string {
  if (value == null) return '—'
  return value.toFixed(2)
}

interface PageProps {
  searchParams: Promise<{
    lookbackDays?: string
    marketplace?: string
    adProduct?: string
    hasOrders?: string
    sortBy?: string
    minSpend?: string
  }>
}

export default async function SearchTermsPage({ searchParams }: PageProps) {
  const params = await searchParams
  const lookbackDays = params.lookbackDays ?? '30'
  const marketplace = params.marketplace ?? ''
  const adProduct = params.adProduct ?? ''
  const hasOrders = (params.hasOrders as 'any' | 'none' | 'some' | undefined) ?? 'any'
  const sortBy = (params.sortBy as 'spend' | 'clicks' | 'orders' | 'impressions' | undefined) ?? 'spend'
  const minSpend = params.minSpend ?? '0'

  const qs = new URLSearchParams({
    lookbackDays,
    sortBy,
    limit: '500',
    minSpend,
    ...(marketplace ? { marketplace } : {}),
    ...(adProduct ? { adProduct } : {}),
    ...(hasOrders !== 'any' ? { hasOrders } : {}),
  })

  const data = await fetchJson<SearchTermResponse>(
    `${getBackendUrl()}/api/advertising/reports/search-terms?${qs}`,
    { lookbackDays: Number(lookbackDays), count: 0, items: [] },
  )

  const candidates = data.items.filter((r) => r.isCandidate)
  const candidateCount = candidates.length
  const totalCostUnits = data.items.reduce((sum, r) => sum + r.costUnits, 0)
  const totalOrders = data.items.reduce((sum, r) => sum + r.orders, 0)
  const wastedCostUnits = candidates.reduce((sum, r) => sum + r.costUnits, 0)
  const wastedPct = totalCostUnits > 0 ? (wastedCostUnits * 100) / totalCostUnits : 0

  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-start gap-3">
        <Search className="h-6 w-6 text-blue-600 dark:text-blue-400 mt-0.5" aria-hidden="true" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Search Terms
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Queries that triggered your ads in the last {lookbackDays} days. High-spend
            zero-conversion queries are flagged as negative keyword candidates.
            <br />
            <span className="text-xs">
              Sourced from Sponsored Products and Sponsored Brands search-term reports
              (Phase 6 ingest). SD has no search-term concept.
            </span>
          </p>
        </div>
      </div>

      <AdvertisingNav />

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Tile label="Unique queries" value={data.count.toLocaleString()} />
        <Tile
          label="Total spend"
          value={formatMoney(totalCostUnits, candidates[0]?.currencyCode ?? 'EUR')}
        />
        <Tile label="Attributed orders" value={totalOrders.toLocaleString()} />
        <Tile
          label="Wasted spend"
          value={formatMoney(wastedCostUnits, candidates[0]?.currencyCode ?? 'EUR')}
          sublabel={`${candidateCount} candidates · ${wastedPct.toFixed(1)}% of total`}
          tone={candidateCount > 0 ? 'warn' : 'ok'}
        />
      </div>

      {/* Filters */}
      <form
        method="get"
        className="flex flex-wrap items-end gap-2 mb-4 p-3 bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 rounded-md"
      >
        <div className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
          <Filter className="h-3.5 w-3.5" />
          <span className="text-xs">Filters</span>
        </div>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Window</span>
          <select
            name="lookbackDays"
            defaultValue={lookbackDays}
            className="h-7 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 px-2"
          >
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Ad product</span>
          <select
            name="adProduct"
            defaultValue={adProduct}
            className="h-7 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 px-2"
          >
            <option value="">All</option>
            <option value="SPONSORED_PRODUCTS">SP</option>
            <option value="SPONSORED_BRANDS">SB</option>
          </select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Marketplace</span>
          <input
            name="marketplace"
            defaultValue={marketplace}
            placeholder="e.g. APJ6JRA9NG5V4"
            className="h-7 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 px-2 w-44"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Orders</span>
          <select
            name="hasOrders"
            defaultValue={hasOrders}
            className="h-7 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 px-2"
          >
            <option value="any">Any</option>
            <option value="none">Zero only (waste)</option>
            <option value="some">With orders</option>
          </select>
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Min spend</span>
          <input
            name="minSpend"
            type="number"
            step="0.5"
            min="0"
            defaultValue={minSpend}
            className="h-7 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 px-2 w-20"
          />
        </label>

        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Sort by</span>
          <select
            name="sortBy"
            defaultValue={sortBy}
            className="h-7 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 px-2"
          >
            <option value="spend">Spend</option>
            <option value="clicks">Clicks</option>
            <option value="orders">Orders</option>
            <option value="impressions">Impressions</option>
          </select>
        </label>

        <button
          type="submit"
          className="h-7 px-3 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded"
        >
          Apply
        </button>
      </form>

      {/* Table */}
      {data.items.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
          <Search className="h-10 w-10 text-slate-300 dark:text-slate-700 mx-auto mb-2" />
          <div className="text-sm text-slate-600 dark:text-slate-300 font-medium mb-1">
            No search terms found
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            Trigger a search-term report cycle via
            <code className="ml-1 text-slate-700 dark:text-slate-300">
              POST /api/advertising/reports/create-search-terms-cycle
            </code>
            , wait ~2 minutes, then poll + ingest.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-md">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950/40 text-xs uppercase tracking-wider text-slate-600 dark:text-slate-400">
              <tr>
                <th className="text-left px-2 py-2 font-medium">Query</th>
                <th className="text-left px-2 py-2 font-medium">Match</th>
                <th className="text-left px-2 py-2 font-medium">Product</th>
                <th className="text-right px-2 py-2 font-medium">Impressions</th>
                <th className="text-right px-2 py-2 font-medium">Clicks</th>
                <th className="text-right px-2 py-2 font-medium">CTR</th>
                <th className="text-right px-2 py-2 font-medium">Spend</th>
                <th className="text-right px-2 py-2 font-medium">CPC</th>
                <th className="text-right px-2 py-2 font-medium">Orders</th>
                <th className="text-right px-2 py-2 font-medium">ACOS</th>
                <th className="text-right px-2 py-2 font-medium">ROAS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.items.map((r, idx) => (
                <tr
                  key={`${r.query}::${r.campaignId}::${r.adGroupId}::${r.matchType ?? ''}::${idx}`}
                  className={`${r.isCandidate ? 'bg-amber-50/50 dark:bg-amber-950/20' : 'hover:bg-slate-50 dark:hover:bg-slate-950/40'}`}
                >
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {r.isCandidate && (
                        <AlertTriangle
                          className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0"
                          aria-label="Negative keyword candidate"
                        />
                      )}
                      <span className="font-medium text-slate-900 dark:text-slate-100 truncate max-w-md" title={r.query}>
                        {r.query}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-slate-600 dark:text-slate-400 text-xs">
                    {r.matchType ?? '—'}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                      {r.adProduct === 'SPONSORED_PRODUCTS' ? 'SP'
                        : r.adProduct === 'SPONSORED_BRANDS' ? 'SB'
                        : r.adProduct}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.impressions.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.clicks.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                    {r.ctr != null ? formatPct(r.ctr * 100, 2) : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                    {formatMoney(r.costUnits, r.currencyCode)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">
                    {r.cpc != null ? formatMoney(r.cpc, r.currencyCode) : '—'}
                  </td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${r.orders === 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-300'}`}>
                    {r.orders}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.acos != null
                      ? <span className={r.acos > 50 ? 'text-rose-600 dark:text-rose-400 font-medium' : r.acos > 25 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}>
                          {formatPct(r.acos)}
                        </span>
                      : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {formatRatio(r.roas)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        <span>
          Highlighted rows are <strong>negative keyword candidates</strong>: ≥ 2 currency units
          spent with zero attributed orders. Adding these as negative keywords typically
          recovers 5–15% of wasted ad spend.
        </span>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  sublabel,
  tone,
}: {
  label: string
  value: string
  sublabel?: string
  tone?: 'warn' | 'ok'
}) {
  const valueClass =
    tone === 'warn'
      ? 'text-amber-700 dark:text-amber-300'
      : tone === 'ok'
      ? 'text-emerald-700 dark:text-emerald-300'
      : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-md p-3 bg-white dark:bg-slate-900">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className={`text-xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      {sublabel && (
        <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate" title={sublabel}>
          {sublabel}
        </div>
      )}
    </div>
  )
}
