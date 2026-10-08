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
 */
import prisma from '../../../db.js'

export const SPEND_GUARD_FACTOR = 1.5
export const SPEND_GUARD_DAYS = 7
export const SPEND_GUARD_MIN_DAYS = 3
export const SPEND_GUARD_MIN_AVG_CENTS = 20
const MIN_MINUTES = 15
const DAY_MS = 86_400_000

const euros = (cents: number) => `€${(cents / 100).toFixed(2)}`

/** Why raises wait this hour, or null. Pure. */
export function spendGuardWhy(a: { spentCents: number; minutesIntoHour: number; sameHourCents: readonly number[] }): string | null {
  const days = a.sameHourCents.filter((c) => c > 0)
  if (days.length < SPEND_GUARD_MIN_DAYS) return null
  const avg = days.reduce((n, c) => n + c, 0) / days.length
  if (avg < SPEND_GUARD_MIN_AVG_CENTS) return null
  const projected = (a.spentCents * 60) / Math.max(MIN_MINUTES, Math.min(60, a.minutesIntoHour))
  if (projected <= SPEND_GUARD_FACTOR * avg) return null
  return `this hour's spend heads for ${euros(Math.round(projected))}, more than ${SPEND_GUARD_FACTOR} × its ${days.length}-day same-hour average ${euros(Math.round(avg))}`
}

/** Per campaign whose raises wait this hour: why. `now` gives the UTC hour and the minutes gone in it. */
export async function loadSpendGuard(campaignIds: readonly string[], now: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!campaignIds.length) return out
  const hour = now.getUTCHours()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const rows = await prisma.amazonAdsHourlyPerformance.groupBy({
    by: ['localEntityId', 'date'],
    where: { entityType: 'CAMPAIGN', localEntityId: { in: [...campaignIds] }, hour, date: { gte: new Date(today - SPEND_GUARD_DAYS * DAY_MS), lte: new Date(today) } },
    _sum: { costMicros: true },
  })
  const byCampaign = new Map<string, { spent: number; days: number[] }>()
  for (const r of rows) {
    if (!r.localEntityId) continue
    const cents = Number(r._sum.costMicros ?? 0n) / 10_000
    const e = byCampaign.get(r.localEntityId) ?? { spent: 0, days: [] }
    if (r.date.getTime() >= today) e.spent += cents
    else e.days.push(cents)
    byCampaign.set(r.localEntityId, e)
  }
  for (const [campaignId, e] of byCampaign) {
    const why = spendGuardWhy({ spentCents: e.spent, minutesIntoHour: now.getUTCMinutes(), sameHourCents: e.days })
    if (why) out.set(campaignId, why)
  }
  return out
}
