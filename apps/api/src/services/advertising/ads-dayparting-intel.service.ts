/**
 * AX2.11 — Dayparting intelligence ("bid when it converts").
 *
 * Aggregates daily campaign performance by day-of-week to reveal which days
 * actually convert, then recommends delivery windows the operator can push
 * straight into an AdSchedule (AX.9). Hour-of-day granularity becomes
 * available once Amazon Marketing Stream (AX.12) is delivering hourly rows;
 * until then the weekday signal comes from the daily reports we already have.
 */

import prisma from '../../db.js'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface DayRow {
  weekday: number // 0=Sun..6=Sat
  label: string
  impressions: number; clicks: number; costCents: number; orders: number; salesCents: number
  cvr: number | null // orders / clicks
  acos: number | null // cost / sales
  cvrIndex: number | null // this day's CVR ÷ overall CVR (1 = average)
  recommend: 'bid-up' | 'keep' | 'bid-down'
}
export interface HourRow {
  hour: number // 0-23 UTC
  impressions: number; clicks: number; costCents: number; orders: number; salesCents: number
  cvr: number | null
  acos: number | null
  cvrIndex: number | null // this hour's CVR ÷ overall CVR (1 = average)
  recommend: 'bid-up' | 'keep' | 'bid-down'
}
export interface DaypartingIntel {
  windowDays: number
  campaignId: string | null
  days: DayRow[]
  hours: HourRow[] // AME.10 — hour-of-day profile (empty until AMS delivers)
  hourlyAvailable: boolean
  peakHours: number[] // hours with cvrIndex ≥ 1.2
  weakHours: number[] // hours with cvrIndex < 0.6
  overallCvr: number | null
  recommendedWindows: Array<{ days: number[]; startHour: number; endHour: number }>
  note: string
}

export async function analyzeDayparting(opts: { windowDays?: number; campaignId?: string } = {}): Promise<DaypartingIntel> {
  const windowDays = opts.windowDays ?? 60
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const where: { entityType: string; date: { gte: Date }; localEntityId?: string } = { entityType: 'CAMPAIGN', date: { gte: since } }
  if (opts.campaignId) where.localEntityId = opts.campaignId

  const rows = await prisma.amazonAdsDailyPerformance.findMany({
    where, select: { date: true, impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })

  const buckets = DAY_LABELS.map((label, weekday) => ({ weekday, label, impressions: 0, clicks: 0, cost: 0, orders: 0, sales: 0 }))
  let totClicks = 0, totOrders = 0
  for (const r of rows) {
    const wd = r.date.getUTCDay()
    const b = buckets[wd]
    b.impressions += r.impressions; b.clicks += r.clicks
    b.cost += Number(r.costMicros) / 10_000
    b.orders += r.orders7d ?? 0; b.sales += r.sales7dCents ?? 0
    totClicks += r.clicks; totOrders += r.orders7d ?? 0
  }
  const overallCvr = totClicks > 0 ? totOrders / totClicks : null

  const days: DayRow[] = buckets.map((b) => {
    const cvr = b.clicks > 0 ? b.orders / b.clicks : null
    const acos = b.sales > 0 ? b.cost / b.sales : null
    const cvrIndex = cvr != null && overallCvr && overallCvr > 0 ? cvr / overallCvr : null
    const recommend: DayRow['recommend'] = cvrIndex == null ? 'keep' : cvrIndex >= 1.2 ? 'bid-up' : cvrIndex < 0.6 ? 'bid-down' : 'keep'
    return { weekday: b.weekday, label: b.label, impressions: b.impressions, clicks: b.clicks, costCents: Math.round(b.cost), orders: b.orders, salesCents: b.sales, cvr, acos, cvrIndex, recommend }
  })

  // ── AME.10: hour-of-day profile from Amazon Marketing Stream hourly rows.
  // Empty until AMS is delivering; the weekday signal above is the fallback.
  const hourWhere: { entityType: string; date: { gte: Date }; localEntityId?: string } = { entityType: 'CAMPAIGN', date: { gte: since } }
  if (opts.campaignId) hourWhere.localEntityId = opts.campaignId
  const hourRows = await prisma.amazonAdsHourlyPerformance.groupBy({
    by: ['hour'],
    where: hourWhere,
    _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const hourlyAvailable = hourRows.length > 0
  let hClicks = 0, hOrders = 0
  for (const r of hourRows) { hClicks += r._sum.clicks ?? 0; hOrders += r._sum.orders7d ?? 0 }
  const hOverallCvr = hClicks > 0 ? hOrders / hClicks : null
  const byHour = new Map(hourRows.map((r) => [r.hour, r]))
  const hours: HourRow[] = Array.from({ length: 24 }, (_, h) => {
    const r = byHour.get(h)
    const clicks = r?._sum.clicks ?? 0, orders = r?._sum.orders7d ?? 0
    const cost = Number(r?._sum.costMicros ?? 0n) / 10_000, sales = r?._sum.sales7dCents ?? 0
    const cvr = clicks > 0 ? orders / clicks : null
    const acos = sales > 0 ? cost / sales : null
    const cvrIndex = cvr != null && hOverallCvr && hOverallCvr > 0 ? cvr / hOverallCvr : null
    const recommend: DayRow['recommend'] = cvrIndex == null ? 'keep' : cvrIndex >= 1.2 ? 'bid-up' : cvrIndex < 0.6 ? 'bid-down' : 'keep'
    return { hour: h, impressions: r?._sum.impressions ?? 0, clicks, costCents: Math.round(cost), orders, salesCents: sales, cvr, acos, cvrIndex, recommend }
  })
  const peakHours = hours.filter((h) => h.recommend === 'bid-up').map((h) => h.hour)
  const weakHours = hours.filter((h) => h.recommend === 'bid-down').map((h) => h.hour)

  // Recommend delivery on every day that isn't a clear under-converter.
  const deliverDays = days.filter((d) => d.recommend !== 'bid-down').map((d) => d.weekday)
  const recommendedWindows = deliverDays.length && deliverDays.length < 7
    ? [{ days: deliverDays, startHour: 0, endHour: 24 }]
    : []
  const fmtHr = (h: number) => `${String(h).padStart(2, '0')}:00`
  const note = hourlyAvailable
    ? (peakHours.length
        ? `Hourly data live — bid up ${peakHours.map(fmtHr).join(', ')}${weakHours.length ? `; ease off ${weakHours.map(fmtHr).join(', ')}` : ''} (UTC).`
        : 'Hourly data live — conversion is even across the day so far.')
    : deliverDays.length === 7 || deliverDays.length === 0
      ? 'Conversion is even across the week — no day-level pausing recommended yet. (Activate Amazon Marketing Stream for hour-of-day signal.)'
      : `Recommend pausing on ${days.filter((d) => d.recommend === 'bid-down').map((d) => d.label).join(', ')} (well below-average conversion). Activate AMS for hour-of-day precision.`

  return { windowDays, campaignId: opts.campaignId ?? null, days, hours, hourlyAvailable, peakHours, weakHours, overallCvr, recommendedWindows, note }
}
