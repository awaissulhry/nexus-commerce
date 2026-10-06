/**
 * AM-6 — which daily rows belong to a campaign in a date window, in ONE place.
 *
 * The Ad Manager list (`ads-campaign-list.service.ts`, CBN.2g) and the Portfolios overview both sum
 * `AmazonAdsDailyPerformance` per campaign for the window the operator picked. Before this, only the
 * list did: Portfolios read the stored `Campaign.spend/sales` — an unlabelled ~30-day window,
 * refreshed nightly, never reset for an idle campaign — so a portfolio's spend and the spend of its
 * own campaigns in the Ad Manager were two different numbers. Both read these two buckets now:
 *
 *  · `byLocal` — report rows linked to the campaign (`localEntityId`);
 *  · `byExt`   — report rows never linked locally, matched by the Amazon campaign id, WITHOUT the
 *               Marketing Stream's daily rows (AX2.3: those duplicate the report rows and were
 *               summed on top of them).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { AMS_DAILY_MARKER } from '../ads-core/ams-daily.js'
import { adSalesCents } from '../ads-core/ad-sales.js'

/** An inclusive window on the daily tables' `date` column (UTC-midnight days, from `resolveRange`). */
export interface DayWindow { gte: Date; lte: Date }

export function campaignDailyWhere(
  ids: string[],
  extIds: string[],
  date: DayWindow,
): { byLocal: Prisma.AmazonAdsDailyPerformanceWhereInput; byExt: Prisma.AmazonAdsDailyPerformanceWhereInput } {
  return {
    byLocal: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date },
    byExt: { entityType: 'CAMPAIGN', entityId: { in: extIds }, localEntityId: null, reportRunId: { not: AMS_DAILY_MARKER }, date },
  }
}

/** micros → cents, rounded per bucket exactly as the Ad Manager list rounds them. */
const m2c = (v: bigint | number | null | undefined) => Math.round(Number(v ?? 0) / 10000)

/**
 * Spend and ad sales in CENTS per campaign id, for the window — the same arithmetic as the Ad
 * Manager list (`spendCents = m2c(local) + m2c(ext)`, `salesCents = adSalesCents(local) + adSalesCents(ext)`),
 * so a sum of these equals the sum of the list's rows for the same campaigns and window.
 * A campaign with no row in the window is 0 / 0 (it did not spend), never its stored figure.
 */
export async function campaignWindowMoney(
  campaigns: Array<{ id: string; externalCampaignId: string | null }>,
  date: DayWindow,
): Promise<Map<string, { spendCents: number; salesCents: number }>> {
  const out = new Map<string, { spendCents: number; salesCents: number }>()
  if (campaigns.length === 0) return out
  const ids = campaigns.map((c) => c.id)
  const extIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)
  const where = campaignDailyWhere(ids, extIds, date)
  const _sum = { costMicros: true, sales7dCents: true, sales14dCents: true } as const
  const [byLocal, byExt] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: where.byLocal, _sum }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['entityId'], where: where.byExt, _sum }),
  ])
  const mapL = new Map(byLocal.map((r) => [r.localEntityId, r._sum]))
  const mapE = new Map(byExt.map((r) => [r.entityId, r._sum]))
  for (const c of campaigns) {
    const a = mapL.get(c.id)
    const b = c.externalCampaignId ? mapE.get(c.externalCampaignId) : undefined
    out.set(c.id, { spendCents: m2c(a?.costMicros) + m2c(b?.costMicros), salesCents: adSalesCents(a) + adSalesCents(b) })
  }
  return out
}
