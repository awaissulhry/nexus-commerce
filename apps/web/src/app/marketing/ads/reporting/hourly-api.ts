/** GX.5 — client contract for the hourly pulse. Mirrors the service; computes nothing. */
import { getBackendUrl } from '@/lib/backend-url'

export interface HourPoint {
  hour: number
  impressions: number
  clicks: number
  cost: number
  sales: number
  orders: number
}

export interface HeatCell {
  weekday: number
  hour: number
  /** Null where the window holds no rows for that weekday-hour — never a measured zero. */
  cost: number | null
  clicks: number | null
  sales: number | null
  orders: number | null
  acos: number | null
  cvr: number | null
  /** Distinct days behind the cell, so one built from a single day is not read as a pattern. */
  days: number
}

export interface HourlyMarket {
  marketplace: string
  lastDay: string | null
  lagDays: number | null
  days: number
  campaigns: number
  /** Nothing enabled — the market is idle, which is not the same as broken. */
  idle: boolean
}

export interface HourlyCampaign {
  id: string | null
  label: string
  cost: number
  clicks: number
  sales: number
  orders: number
  acos: number | null
  href: string | null
}

export interface HourlyPulse {
  marketplace: string
  today: string
  throughHour: number | null
  comparisonDay: string
  todaySeries: HourPoint[]
  comparisonSeries: HourPoint[]
  totals: { today: HourPoint; comparison: HourPoint }
  heat: HeatCell[]
  heatWindowDays: number
  topCampaigns: HourlyCampaign[]
  markets: HourlyMarket[]
  caveats: string[]
  elapsedMs: number
}

export async function fetchHourlyPulse(
  q: { marketplace: string; heatWindowDays?: number },
  signal?: AbortSignal,
): Promise<HourlyPulse> {
  const qs = new URLSearchParams({ marketplace: q.marketplace })
  if (q.heatWindowDays) qs.set('heatWindowDays', String(q.heatWindowDays))
  const res = await fetch(`${getBackendUrl()}/api/advertising/reporting/hourly?${qs}`, {
    credentials: 'include',
    signal,
    // This is the one surface whose value IS being current — never serve it from cache.
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Could not load the hourly stream (${res.status})`)
  }
  return res.json() as Promise<HourlyPulse>
}
