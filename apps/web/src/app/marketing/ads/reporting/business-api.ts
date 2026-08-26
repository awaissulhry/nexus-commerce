/** RPT.11 — client contract for TACoS, ad-vs-organic and wasted spend. */
import { getBackendUrl } from '@/lib/backend-url'

export interface MarketContext {
  marketplace: string
  adSpend: number
  adSales: number
  totalSales: number
  acos: number | null
  tacos: number | null
  adShare: number | null
}

/** One ISO week of the same four figures the totals are built from. */
export interface BusinessWeek {
  weekStart: string
  adSpend: number
  adSales: number
  totalSales: number
  tacos: number | null
  adShare: number | null
  /** Not covered by both feeds yet, or clipped by the window — never compared with a full week. */
  partial: boolean
}

/** Spend and campaign counts per ad product — and the measured reason AMC is empty. */
export interface AdProductMix {
  adProduct: string
  campaigns: number
  enabled: number
  spend: number
}

export interface BusinessContext {
  window: { from: string; to: string }
  currency: string
  /** Markets the caller asked for; empty means every market. */
  marketplaces: string[]
  totals: MarketContext
  byMarket: MarketContext[]
  series: BusinessWeek[]
  /** The last day BOTH feeds cover. Every week ending after it is partial. */
  completeThrough: string | null
  adMix: AdProductMix[]
  wasted: {
    amount: number
    terms: number
    pctOfSpend: number
    minClicks: number
    maturedTo: string
    top: Array<{ query: string; marketplace: string; clicks: number; spend: number }>
  }
  caveats: string[]
  elapsedMs: number
}

export interface BusinessContextQuery {
  from: string
  to: string
  /** Restrict every figure to these markets. Empty = all of them. */
  marketplaces?: string[]
}

/**
 * RPX — takes an explicit window and an optional market.
 *
 * It used to take a day count and always covered every market, which is fine for the panel under
 * the campaign report and wrong for a tab whose whole point is that a blended TACoS hides the
 * market that moved. The day-count form is kept as a helper below so the existing caller is
 * unchanged.
 */
export async function fetchBusinessContext(q: BusinessContextQuery, signal?: AbortSignal): Promise<BusinessContext> {
  const qs = new URLSearchParams({ from: q.from, to: q.to })
  if (q.marketplaces?.length) qs.set('marketplaces', q.marketplaces.join(','))
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/business-context?${qs}`, {
    credentials: 'include',
    signal,
    // The route caches for five minutes and Refresh re-requests the same URL; without this the
    // button can hand back a stale answer and look like it worked.
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Business context unavailable (${res.status})`)
  return (await res.json()) as BusinessContext
}

/** The last N days, every market — the shape the campaign report's panel asks for. */
export function fetchBusinessContextDays(days = 30, signal?: AbortSignal): Promise<BusinessContext> {
  const to = new Date()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - (days - 1))
  return fetchBusinessContext({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }, signal)
}

export const money = (v: number, c = 'EUR') =>
  v.toLocaleString('en-GB', { style: 'currency', currency: c, maximumFractionDigits: 0 })
export const money2 = (v: number, c = 'EUR') =>
  v.toLocaleString('en-GB', { style: 'currency', currency: c, minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (v: number | null) =>
  v == null ? '—' : `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`
