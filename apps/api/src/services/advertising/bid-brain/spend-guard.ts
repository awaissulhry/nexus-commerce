/**
 * BID BRAIN BB-10 — the brain's own guard on raises (design §5): when a campaign's projected spend for this hour is above
 * 1.5 × its 7-day same-hour average, the brain raises nothing there this run — no keyword bid and no placement %. A
 * lowering, a stop and a give-back after a floor still go. Auto-undo judges what was written; this only stops the brain
 * adding to a spike while it is happening.
 *
 *   spent      the campaign's cost in this UTC hour so far (AmazonAdsHourlyPerformance, the Marketing Stream rows at
 *              campaign grain), projected to the full hour: spent × 60 ÷ the minutes gone (at least 15, so the first
 *              minutes of an hour do not project a few cents into a spike)
 *   average    the same UTC hour on the 7 days before today, over the days it spent in that hour; fewer than 3 such
 *              days, or an average under 20¢, is too little to judge: no cap (said nowhere — nothing is held)
 *   last hour  BB-10 review — the previous full hour above 1.5 × ITS same-hour average caps too: the :00 tick of a new
 *              hour sees almost nothing spent yet, and must not reopen raises in the middle of a spike
 */
import prisma from '../../../db.js'

export const SPEND_GUARD_FACTOR = 1.5
export const SPEND_GUARD_DAYS = 7
export const SPEND_GUARD_MIN_DAYS = 3
export const SPEND_GUARD_MIN_AVG_CENTS = 20
const MIN_MINUTES = 15
const DAY_MS = 86_400_000

const euros = (cents: number) => `€${(cents / 100).toFixed(2)}`

/** The average of the days that spent, or null when too few days or too small an average to judge. */
function averageOf(sameHourCents: readonly number[]): { avg: number; days: number } | null {
  const days = sameHourCents.filter((c) => c > 0)
  if (days.length < SPEND_GUARD_MIN_DAYS) return null
  const avg = days.reduce((n, c) => n + c, 0) / days.length
  return avg < SPEND_GUARD_MIN_AVG_CENTS ? null : { avg, days: days.length }
}

/** Why raises wait this hour, or null. `previous`: the last full hour and its own same-hour days. Pure. */
export function spendGuardWhy(a: { spentCents: number; minutesIntoHour: number; sameHourCents: readonly number[]; previous?: { spentCents: number; sameHourCents: readonly number[] } | null }): string | null {
  const now = averageOf(a.sameHourCents)
  if (now) {
    const projected = (a.spentCents * 60) / Math.max(MIN_MINUTES, Math.min(60, a.minutesIntoHour))
    if (projected > SPEND_GUARD_FACTOR * now.avg) return `this hour's spend heads for ${euros(Math.round(projected))}, more than ${SPEND_GUARD_FACTOR} × its ${now.days}-day same-hour average ${euros(Math.round(now.avg))}`
  }
  const last = a.previous ? averageOf(a.previous.sameHourCents) : null
  if (a.previous && last && a.previous.spentCents > SPEND_GUARD_FACTOR * last.avg) {
    return `the last hour spent ${euros(Math.round(a.previous.spentCents))}, more than ${SPEND_GUARD_FACTOR} × its ${last.days}-day same-hour average ${euros(Math.round(last.avg))}`
  }
  return null
}

/** Per campaign whose raises wait this hour: why. `now` gives the UTC hour and the minutes gone in it. */
export async function loadSpendGuard(campaignIds: readonly string[], now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!campaignIds.length) return out
  const hour = now.getUTCHours()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  // The last full hour: the hour before, yesterday's 23:00 at 00:xx.
  const prevHour = (hour + 23) % 24
  const prevDay = hour === 0 ? today - DAY_MS : today
  const rows = await prisma.amazonAdsHourlyPerformance.groupBy({
    by: ['localEntityId', 'date', 'hour'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: [...campaignIds] }, hour: { in: [hour, prevHour] }, date: { gte: new Date(today - (SPEND_GUARD_DAYS + 1) * DAY_MS), lte: new Date(today) } },
    _sum: { costMicros: true },
  })
  const byCampaign = new Map<string, { spent: number; days: number[]; prevSpent: number; prevDays: number[] }>()
  for (const r of rows) {
    if (!r.localEntityId) continue
    const cents = Number(r._sum.costMicros ?? 0n) / 10_000
    const e = byCampaign.get(r.localEntityId) ?? { spent: 0, days: [], prevSpent: 0, prevDays: [] }
    const t = r.date.getTime()
    if (r.hour === hour) {
      if (t >= today) e.spent += cents
      else if (t >= today - SPEND_GUARD_DAYS * DAY_MS) e.days.push(cents)
    }
    if (r.hour === prevHour) {
      if (t === prevDay) e.prevSpent += cents
      else if (t < prevDay && t >= prevDay - SPEND_GUARD_DAYS * DAY_MS) e.prevDays.push(cents)
    }
    byCampaign.set(r.localEntityId, e)
  }
  for (const [campaignId, e] of byCampaign) {
    const why = spendGuardWhy({ spentCents: e.spent, minutesIntoHour: now.getUTCMinutes(), sameHourCents: e.days, previous: { spentCents: e.prevSpent, sameHourCents: e.prevDays } })
    if (why) out.set(campaignId, why)
  }
  return out
}
