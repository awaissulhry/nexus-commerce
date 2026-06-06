/**
 * STO.5 — descriptive "conversion by send hour × weekday" report.
 *
 * For every SENT review request in the window, buckets it by the LOCAL weekday
 * and hour it was sent (in its marketplace timezone) and marks it converted if an
 * attributed review followed — reusing the same (channel, marketplace, productId)
 * + attribution-window heuristic as review-analytics.service.
 *
 * This is descriptive only (the operator nudges the send-time table from it); it
 * is NOT auto-applied. At low review volume it will be sparse — `hasReviews`
 * tells the UI to show the "turn on ingestion" empty-state.
 */

import prisma from '../../db.js'
import { timezoneForMarketplace } from './review-timing.service.js'

const DAY = 24 * 60 * 60 * 1000
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function localWeekdayHour(d: Date, tz: string): { weekday: number; hour: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', weekday: 'short' }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return { weekday: DOW[g('weekday')] ?? 0, hour: Number(g('hour')) % 24 }
}

export interface SendHourCell { dayOfWeek: number; hour: number; sent: number; converted: number }
export interface SendHourReport {
  windowDays: number
  totalSent: number
  totalConverted: number
  hasReviews: boolean
  cells: SendHourCell[]
}

export async function computeSendHourConversion(opts: { windowDays?: number; attributionWindowDays?: number } = {}): Promise<SendHourReport> {
  const windowDays = Math.max(7, Math.min(365, opts.windowDays ?? 90))
  const attributionWindowDays = opts.attributionWindowDays ?? 30
  const now = new Date()
  const since = new Date(now.getTime() - windowDays * DAY)

  const sentRequests = await prisma.reviewRequest.findMany({
    where: { sentAt: { gte: since, lte: now } },
    select: {
      id: true, channel: true, marketplace: true, sentAt: true,
      order: { select: { items: { select: { productId: true }, take: 1 } } },
    },
  })

  const reviewSince = new Date(since.getTime() - attributionWindowDays * DAY)
  const reviews = await prisma.review.findMany({
    where: { postedAt: { gte: reviewSince, lte: now }, channel: { in: ['AMAZON', 'EBAY', 'SHOPIFY'] } },
    select: { channel: true, marketplace: true, productId: true, postedAt: true },
  })

  // attribution: latest matching SENT request whose sentAt ≤ postedAt within the window
  const byKey = new Map<string, typeof sentRequests>()
  for (const r of sentRequests) {
    const productId = r.order?.items[0]?.productId ?? '_none'
    const key = `${r.channel}|${r.marketplace ?? ''}|${productId}`
    const arr = byKey.get(key) ?? []
    arr.push(r)
    byKey.set(key, arr)
  }
  for (const arr of byKey.values()) arr.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))

  const attributionMs = attributionWindowDays * DAY
  const converted = new Set<string>()
  for (const rv of reviews) {
    if (!rv.productId) continue
    const bucket = byKey.get(`${rv.channel}|${rv.marketplace ?? ''}|${rv.productId}`)
    if (!bucket) continue
    const postedMs = rv.postedAt.getTime()
    for (const req of bucket) {
      if (!req.sentAt || converted.has(req.id)) continue
      const sentMs = req.sentAt.getTime()
      if (sentMs <= postedMs && postedMs - sentMs <= attributionMs) { converted.add(req.id); break }
    }
  }

  const cells = new Map<string, SendHourCell>()
  let totalSent = 0
  for (const req of sentRequests) {
    if (!req.sentAt) continue
    const { weekday, hour } = localWeekdayHour(req.sentAt, timezoneForMarketplace(req.marketplace))
    const k = `${weekday}-${hour}`
    const cell = cells.get(k) ?? { dayOfWeek: weekday, hour, sent: 0, converted: 0 }
    cell.sent += 1
    if (converted.has(req.id)) cell.converted += 1
    cells.set(k, cell)
    totalSent += 1
  }

  return {
    windowDays,
    totalSent,
    totalConverted: converted.size,
    hasReviews: reviews.length > 0,
    cells: [...cells.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour),
  }
}
