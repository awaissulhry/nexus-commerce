/**
 * STO.5 — descriptive "conversion by send hour × weekday" report.
 *
 * For every SENT review request in the window where a review can follow, buckets it by the LOCAL weekday and hour it
 * was sent (in its marketplace timezone) and marks it converted when a review followed — the ONE review rate's own
 * link (review-rate.service.ts: the attribution job's Review.attributedRequestId, visible rows only).
 *
 * This is descriptive only (the operator nudges the send-time table from it); it
 * is NOT auto-applied. At low review volume it will be sparse — `hasReviews`
 * tells the UI to show the "turn on ingestion" empty-state.
 *
 * PR C (B11) — one market at a time (`marketplace`), for the Timing page's market picker: that market's sent requests,
 * and its reviews only.
 */

import { timezoneForMarketplace } from './review-timing.service.js'
import { rateMeasurable, rateOf, readRateFacts, readRateRequests } from './review-rate.service.js'

const DAY = 24 * 60 * 60 * 1000
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function localWeekdayHour(d: Date, tz: string): { weekday: number; hour: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', weekday: 'short' }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  return { weekday: DOW[g('weekday')] ?? 0, hour: Number(g('hour')) % 24 }
}

export interface SendHourCell {
  dayOfWeek: number
  hour: number
  /** Every request sent at that hour (live audit B05: the send hours as they really were). */
  sent: number
  /** Of those, the ones a review can follow (review-rate.service.ts `rateMeasurable`): the rate's base. */
  measured: number
  converted: number
}
export interface SendHourReport {
  windowDays: number
  /** PR C (B11) — the market read (null = every market). */
  marketplace: string | null
  totalSent: number
  /** Sent where a review can follow; 0 = the rate is not measurable (`words` says why). */
  totalMeasured: number
  totalConverted: number
  hasReviews: boolean
  /** Why the rate leaves requests out, or why there is none ("Not measurable: …"); null when every request counts. */
  words: string | null
  cells: SendHourCell[]
}

export async function computeSendHourConversion(opts: { windowDays?: number; attributionWindowDays?: number; marketplace?: string | null } = {}): Promise<SendHourReport> {
  const windowDays = Math.max(7, Math.min(365, opts.windowDays ?? 90))
  const marketplace = opts.marketplace ? opts.marketplace.toUpperCase() : null
  const now = new Date()
  const since = new Date(now.getTime() - windowDays * DAY)

  // The ONE review rate (review-rate.service.ts, audit C2/B20): sent requests, the reviews the attribution job linked
  // to them (visible rows only), counted only where a review can follow. Every sent request is placed on its hour
  // (live audit A02/B05: "Not measurable" where no review can follow — never 0 % — and the real send hours).
  const [rows, facts] = await Promise.all([readRateRequests({ from: since, to: now, market: marketplace }), readRateFacts()])
  const rate = rateOf(rows, facts)

  const cells = new Map<string, SendHourCell>()
  for (const req of rows) {
    if (!req.sentAt) continue
    const { weekday, hour } = localWeekdayHour(req.sentAt, timezoneForMarketplace(req.marketplace))
    const k = `${weekday}-${hour}`
    const cell = cells.get(k) ?? { dayOfWeek: weekday, hour, sent: 0, measured: 0, converted: 0 }
    cell.sent += 1
    if (rateMeasurable(req.channel, req.marketplace, facts)) {
      cell.measured += 1
      if (req.followed) cell.converted += 1
    }
    cells.set(k, cell)
  }

  return {
    windowDays,
    marketplace,
    totalSent: rate.sent,
    totalMeasured: rate.measured,
    totalConverted: rate.followed,
    hasReviews: rate.measured > 0 || [...facts.reviewedKeys].some((k) => !marketplace || k.endsWith(`|${marketplace}`)),
    words: rate.words,
    cells: [...cells.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour),
  }
}
