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

export interface BusinessContext {
  window: { from: string; to: string }
  currency: string
  totals: MarketContext
  byMarket: MarketContext[]
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

export async function fetchBusinessContext(days = 30, signal?: AbortSignal): Promise<BusinessContext> {
  const to = new Date()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - (days - 1))
  const qs = new URLSearchParams({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) })
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/business-context?${qs}`, {
    credentials: 'include', signal,
  })
  if (!res.ok) throw new Error(`Business context unavailable (${res.status})`)
  return (await res.json()) as BusinessContext
}

export const money = (v: number, c = 'EUR') =>
  v.toLocaleString('en-GB', { style: 'currency', currency: c, maximumFractionDigits: 0 })
export const money2 = (v: number, c = 'EUR') =>
  v.toLocaleString('en-GB', { style: 'currency', currency: c, minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (v: number | null) =>
  v == null ? '—' : `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`
