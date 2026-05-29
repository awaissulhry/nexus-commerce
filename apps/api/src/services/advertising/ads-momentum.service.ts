/**
 * AX3.12 — Live Ad Momentum.
 *
 * A "what's driving today" dashboard: the top campaigns / keywords / ASINs by
 * sales for the most recent reported day, delivery counts (enabled/paused),
 * and a sales-by-placement split. Built from AmazonAdsDailyPerformance +
 * AmazonAdsPlacementReport. True hour-of-day momentum + the live funnel light
 * up once Amazon Marketing Stream (AX.12) is delivering hourly rows; until
 * then this is day-grain.
 */

import prisma from '../../db.js'

export interface MomentumEntity { id: string; label: string; status?: string | null; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number; acos: number | null }
export interface MomentumResult {
  date: string | null
  counts: { enabled: number; paused: number }
  campaigns: MomentumEntity[]
  keywords: MomentumEntity[]
  asins: MomentumEntity[]
  placements: Array<{ placement: string; spendCents: number; salesCents: number; sharePct: number }>
}

async function latestDate(): Promise<Date | null> {
  const row = await prisma.amazonAdsDailyPerformance.findFirst({ orderBy: { date: 'desc' }, select: { date: true } })
  return row?.date ?? null
}

async function topByType(entityType: string, day: Date, take = 10) {
  return prisma.amazonAdsDailyPerformance.groupBy({
    by: ['localEntityId'], where: { entityType, date: day, localEntityId: { not: null } },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    orderBy: { _sum: { sales7dCents: 'desc' } }, take,
  })
}
function toEntity(id: string, label: string, status: string | null, s: { impressions: number | null; clicks: number | null; costMicros: bigint | null; sales7dCents: number | null; orders7d: number | null }): MomentumEntity {
  const spendCents = Math.round(Number(s.costMicros ?? 0) / 10_000)
  const salesCents = s.sales7dCents ?? 0
  return { id, label, status, impressions: s.impressions ?? 0, clicks: s.clicks ?? 0, spendCents, salesCents, orders: s.orders7d ?? 0, acos: salesCents > 0 ? spendCents / salesCents : null }
}

export async function getMomentum(opts: { date?: string } = {}): Promise<MomentumResult> {
  const day = opts.date ? new Date(`${opts.date}T00:00:00.000Z`) : await latestDate()
  if (!day || Number.isNaN(day.getTime())) return { date: null, counts: { enabled: 0, paused: 0 }, campaigns: [], keywords: [], asins: [], placements: [] }

  const [camp, kw, ad, enabled, paused, placeRows] = await Promise.all([
    topByType('CAMPAIGN', day), topByType('AD_TARGET', day), topByType('PRODUCT_AD', day),
    prisma.campaign.count({ where: { status: 'ENABLED' } }),
    prisma.campaign.count({ where: { status: 'PAUSED' } }),
    prisma.amazonAdsPlacementReport.groupBy({ by: ['placement'], where: { date: day }, _sum: { costMicros: true, sales7dCents: true } }),
  ])

  const campIds = camp.map((r) => r.localEntityId!).filter(Boolean)
  const kwIds = kw.map((r) => r.localEntityId!).filter(Boolean)
  const adIds = ad.map((r) => r.localEntityId!).filter(Boolean)
  const [campaigns, targets, productAds] = await Promise.all([
    prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true, status: true } }),
    prisma.adTarget.findMany({ where: { id: { in: kwIds } }, select: { id: true, expressionValue: true, status: true } }),
    prisma.adProductAd.findMany({ where: { id: { in: adIds } }, select: { id: true, asin: true, sku: true, status: true } }),
  ])
  const cMap = new Map(campaigns.map((c) => [c.id, c]))
  const tMap = new Map(targets.map((t) => [t.id, t]))
  const aMap = new Map(productAds.map((a) => [a.id, a]))

  const totalPlaceSales = placeRows.reduce((s, p) => s + (p._sum.sales7dCents ?? 0), 0)
  return {
    date: day.toISOString().slice(0, 10),
    counts: { enabled, paused },
    campaigns: camp.map((r) => { const c = cMap.get(r.localEntityId!); return toEntity(r.localEntityId!, c?.name ?? r.localEntityId!, c?.status ?? null, r._sum) }),
    keywords: kw.map((r) => { const t = tMap.get(r.localEntityId!); return toEntity(r.localEntityId!, t?.expressionValue ?? r.localEntityId!, t?.status ?? null, r._sum) }),
    asins: ad.map((r) => { const a = aMap.get(r.localEntityId!); return toEntity(r.localEntityId!, a?.asin ?? a?.sku ?? r.localEntityId!, a?.status ?? null, r._sum) }),
    placements: placeRows.map((p) => ({ placement: p.placement, spendCents: Math.round(Number(p._sum.costMicros ?? 0) / 10_000), salesCents: p._sum.sales7dCents ?? 0, sharePct: totalPlaceSales > 0 ? (p._sum.sales7dCents ?? 0) / totalPlaceSales : 0 })).sort((a, b) => b.salesCents - a.salesCents),
  }
}
