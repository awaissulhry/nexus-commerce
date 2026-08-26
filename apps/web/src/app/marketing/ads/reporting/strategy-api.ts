/**
 * RPX — client contract for the two strategy endpoints.
 *
 * Both mirror their service's return type exactly and neither computes anything: shares,
 * ratios, verdicts and the "cannot discriminate" flag are all decided server-side, beside the
 * SQL that produced the numbers. A percentage computed in the browser is a second definition,
 * and a second definition is how a headline and its own table end up disagreeing.
 */
import { getBackendUrl } from '@/lib/backend-url'

export type Verdict = 'ahead' | 'behind' | 'level' | 'no-median' | 'no-value'

export interface BrandBenchmark {
  id: string
  label: string
  format: string
  help?: string
  value: number | null
  median: number | null
  top: number | null
  ratio: number | null
  verdict: Verdict
  distance: number | null
  discriminates: boolean
}

export interface BrandBand {
  id: string
  label: string
  lower: number | null
  upper: number | null
  medianLower: number | null
  medianUpper: number | null
  topLower: number | null
  topUpper: number | null
  discriminates: boolean
}

export interface BrandStage {
  id: 'awareness' | 'consideration' | 'purchase'
  label: string
  index: number | null
  metrics: BrandBenchmark[]
}

export interface BrandNode {
  name: string
  treeName: string | null
  depth: number
  weeks: number
  isRoot: boolean
}

export interface BrandMarketFreshness {
  marketplace: string
  lastWeek: string | null
  lagDays: number | null
  nodes: number
}

export interface BrandSeriesPoint {
  week: string
  awarenessIndex: number | null
  considerationIndex: number | null
  salesIndex: number | null
  brandCustomers: number | null
  addToCarts: number | null
  viewedDetailPageOnly: number | null
  brandCustomersMedian: number | null
}

export interface BrandMarketRatio {
  marketplace: string
  node: string
  week: string | null
  indices: { awareness: number | null; consideration: number | null; sales: number | null }
  benchmarks: BrandBenchmark[]
}

export interface BrandStrategy {
  marketplace: string
  brandName: string | null
  node: BrandNode | null
  nodes: BrandNode[]
  week: string | null
  weeksHeld: number
  firstWeek: string | null
  lastWeek: string | null
  lagDays: number | null
  freshness: BrandMarketFreshness[]
  indices: { awareness: number | null; consideration: number | null; sales: number | null }
  stages: BrandStage[]
  benchmarks: BrandBenchmark[]
  bands: BrandBand[]
  series: BrandSeriesPoint[]
  byMarket: BrandMarketRatio[]
  levelBand: number
  caveats: string[]
  elapsedMs: number
}

export interface ShareStage {
  id: 'impressions' | 'clicks' | 'cartAdds' | 'purchases'
  label: string
  ours: number
  market: number
  share: number | null
}

export interface ShareWeek {
  week: string
  rows: number
  impressionShare: number | null
  clickShare: number | null
  cartAddShare: number | null
  purchaseShare: number | null
  thin: boolean
}

export interface ShareQuery {
  query: string
  marketImpressions: number
  ourImpressions: number
  impressionShare: number | null
  ourClicks: number
  marketPurchases: number
  ourPurchases: number
  purchaseShare: number | null
}

export interface MarketShare {
  marketplace: string
  week: string | null
  weeksHeld: number
  firstWeek: string | null
  lastWeek: string | null
  lagDays: number | null
  freshness: Array<{ marketplace: string; lastWeek: string | null; lagDays: number | null; weeks: number; queries: number }>
  funnel: ShareStage[]
  series: ShareWeek[]
  queries: ShareQuery[]
  coverage: { medianRows: number; thinBelow: number; thinWeeks: string[] }
  caveats: string[]
  elapsedMs: number
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${getBackendUrl()}${path}`, {
    credentials: 'include',
    signal,
    // 🔴 The header's Refresh re-requests the same URL, and the route sets a 5-minute
    // private cache. Without this the button can hand back a five-minute-old answer and
    // look like it worked. Same fix the report runner needed.
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${res.status})`)
  }
  return res.json() as Promise<T>
}

export function fetchBrandStrategy(
  opts: { marketplace: string; node?: string | null; weeks?: number },
  signal?: AbortSignal,
): Promise<BrandStrategy> {
  const qs = new URLSearchParams({ marketplace: opts.marketplace })
  if (opts.node) qs.set('node', opts.node)
  if (opts.weeks) qs.set('weeks', String(opts.weeks))
  return getJson<BrandStrategy>(`/api/advertising/reporting/brand?${qs}`, signal)
}

export function fetchMarketShare(
  opts: { marketplace: string; weeks?: number; queryLimit?: number },
  signal?: AbortSignal,
): Promise<MarketShare> {
  const qs = new URLSearchParams({ marketplace: opts.marketplace })
  if (opts.weeks) qs.set('weeks', String(opts.weeks))
  if (opts.queryLimit) qs.set('queryLimit', String(opts.queryLimit))
  return getJson<MarketShare>(`/api/advertising/reporting/market-share?${qs}`, signal)
}

// ── formatting ────────────────────────────────────────────────────────────────
// One place, so a figure looks the same on every tab.

/** A count. Null renders as an em-dash — an absence is never a zero. */
export const fmtCount = (v: number | null | undefined): string =>
  (v == null ? '—' : v.toLocaleString('en-GB', { maximumFractionDigits: v < 10 && !Number.isInteger(v) ? 2 : 0 }))

/** A 0..1 rate as a percentage. Two decimals, because these shares live under 2%. */
export const fmtShare = (v: number | null | undefined, dp = 2): string =>
  (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)

export const fmtRatio = (v: number | null | undefined): string =>
  (v == null ? '—' : v.toFixed(2))

export const fmtMoney = (v: number | null | undefined): string =>
  (v == null ? '—' : `€${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)

/**
 * A benchmark value in its own unit. `pct` values are 0..1 rates; `ratio` and `int` are not.
 * The engagement band is deliberately NOT routed through here — it is already in percent units
 * and multiplying it again is exactly the unit bug the registry documents.
 */
export function fmtBenchmark(v: number | null | undefined, format: string): string {
  if (v == null) return '—'
  if (format === 'pct') return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`
  if (format === 'ratio') return v.toFixed(2)
  return fmtCount(v)
}

/**
 * "5.3× ahead" / "5.0× behind" / "level".
 *
 * A ratio below 1 is inverted so both directions read as a multiple — "0.20× behind" makes a
 * reader do the division themselves, and half of them will get it wrong.
 */
export function fmtDistance(b: { ratio: number | null; verdict: Verdict }): string {
  if (b.verdict === 'no-value') return 'not reported'
  if (b.verdict === 'no-median') return 'no benchmark'
  if (b.verdict === 'level') return 'level'
  if (b.ratio == null || b.ratio <= 0) return b.verdict === 'behind' ? 'behind' : 'ahead'
  const mult = b.ratio >= 1 ? b.ratio : 1 / b.ratio
  return `${mult.toFixed(1)}× ${b.verdict}`
}
