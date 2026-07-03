/**
 * AME.5/AME.6 — single source of truth for campaign → ad-group → ad metric
 * allocation, so the campaign detail, the ad-group detail, and the ads table
 * NEVER disagree.
 *
 * The CAMPAIGN daily rows are Amazon's authoritative (billed) campaign total.
 * The PRODUCT_AD rows give per-ad granularity but differ from the campaign
 * report by ~15% + a T+2 lag. So we anchor on the campaign total and ALLOCATE
 * it downward by PRODUCT_AD share (largest-remainder), guaranteeing
 * Σ(ad groups) === campaign and Σ(ads) === ad group for every metric.
 */
import prisma from '../../db.js'
import { allocate, microsToCents } from '../ads-core/metrics-math.js'

export interface AllocatedMetrics {
  impressions: number
  clicks: number
  spendCents: number
  salesCents: number
  orders: number
  acos: number | null
  roas: number | null
}

function toMetrics(impr: number, clicks: number, spend: number, sales: number, orders: number): AllocatedMetrics {
  return { impressions: impr, clicks, spendCents: spend, salesCents: sales, orders, acos: sales > 0 ? spend / sales : null, roas: spend > 0 ? sales / spend : null }
}

function windowStart(windowDays: number): Date {
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - Math.max(1, Math.min(180, windowDays)))
  since.setUTCHours(0, 0, 0, 0)
  return since
}

interface RawShare { impr: number; clicks: number; micros: number; salesCents: number; orders: number }
function emptyShare(): RawShare { return { impr: 0, clicks: 0, micros: 0, salesCents: 0, orders: 0 } }

/**
 * Campaign authoritative totals + per-ad-group allocated metrics. `adGroups`
 * carries each ad group's PRODUCT_AD ids (the only per-ad-group grain).
 */
export async function computeCampaignDetailMetrics(opts: {
  campaignId: string
  externalCampaignId: string | null
  adGroups: Array<{ id: string; productAdIds: string[] }>
  windowDays: number
  // DR.1 — explicit Rome-anchored range overrides windowDays when provided.
  since?: Date
  until?: Date
}): Promise<{ campaign: AllocatedMetrics; byAdGroup: Map<string, AllocatedMetrics> }> {
  const since = opts.since ?? windowStart(opts.windowDays)
  const dateFilter = opts.until ? { gte: since, lte: opts.until } : { gte: since }

  const cagg = await prisma.amazonAdsDailyPerformance.aggregate({
    where: {
      entityType: 'CAMPAIGN',
      date: dateFilter,
      OR: [
        { localEntityId: opts.campaignId },
        ...(opts.externalCampaignId ? [{ entityId: opts.externalCampaignId }] : []),
      ],
    },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true },
  })
  let campImpr = cagg._sum.impressions ?? 0
  let campClicks = cagg._sum.clicks ?? 0
  let campSpend = microsToCents(cagg._sum.costMicros)
  let campSales = (cagg._sum.sales7dCents ?? 0) + (cagg._sum.sales14dCents ?? 0)
  let campOrders = cagg._sum.orders7d ?? 0

  // DR.3 — intraday overlay. Daily performance is T+1, so when the range
  // includes today its daily row is absent; layer in today's Amazon Marketing
  // Stream HOURLY rows (CAMPAIGN grain) so "Today"/MTD/YTD reflect live spend.
  const todayUtc = new Date(); todayUtc.setUTCHours(0, 0, 0, 0)
  const includesToday = !opts.until || opts.until.getTime() >= todayUtc.getTime()
  if (includesToday) {
    const hourly = await prisma.amazonAdsHourlyPerformance.aggregate({
      where: {
        entityType: 'CAMPAIGN',
        date: todayUtc,
        OR: [
          { localEntityId: opts.campaignId },
          ...(opts.externalCampaignId ? [{ entityId: opts.externalCampaignId }] : []),
        ],
      },
      _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    }).catch(() => null)
    if (hourly?._sum) {
      campImpr += hourly._sum.impressions ?? 0
      campClicks += hourly._sum.clicks ?? 0
      campSpend += microsToCents(hourly._sum.costMicros)
      // AmazonAdsHourlyPerformance only carries sales7dCents (no 14d like the
      // daily model) — referencing sales14dCents here broke the build.
      campSales += hourly._sum.sales7dCents ?? 0
      campOrders += hourly._sum.orders7d ?? 0
    }
  }

  const adIdToGroup = new Map<string, string>()
  for (const g of opts.adGroups) for (const aid of g.productAdIds) adIdToGroup.set(aid, g.id)
  const allAdIds = [...adIdToGroup.keys()]
  const share = new Map<string, RawShare>()
  for (const g of opts.adGroups) share.set(g.id, emptyShare())
  if (allAdIds.length) {
    const rows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'PRODUCT_AD', localEntityId: { in: allAdIds }, date: dateFilter },
      _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true },
    })
    for (const r of rows) {
      const gid = r.localEntityId ? adIdToGroup.get(r.localEntityId) : undefined
      if (!gid) continue
      const cur = share.get(gid)!
      cur.impr += r._sum.impressions ?? 0
      cur.clicks += r._sum.clicks ?? 0
      cur.micros += Number(r._sum.costMicros ?? 0n)
      cur.salesCents += (r._sum.sales7dCents ?? 0) + (r._sum.sales14dCents ?? 0)
      cur.orders += r._sum.orders7d ?? 0
    }
  }

  const gids = opts.adGroups.map((g) => g.id)
  const sh = gids.map((id) => share.get(id)!)
  const spendAlloc = allocate(campSpend, sh.map((s) => s.micros))
  const salesAlloc = allocate(campSales, sh.map((s) => s.salesCents))
  const imprAlloc = allocate(campImpr, sh.map((s) => s.impr))
  const clickAlloc = allocate(campClicks, sh.map((s) => s.clicks))
  const orderAlloc = allocate(campOrders, sh.map((s) => s.orders))

  const byAdGroup = new Map<string, AllocatedMetrics>()
  gids.forEach((id, i) => byAdGroup.set(id, toMetrics(imprAlloc[i]!, clickAlloc[i]!, spendAlloc[i]!, salesAlloc[i]!, orderAlloc[i]!)))

  return { campaign: toMetrics(campImpr, campClicks, campSpend, campSales, campOrders), byAdGroup }
}

/** Allocate a parent total across rows by their `shares`, returning per-row metrics. */
export function allocateMetricsAcross<T>(
  parent: AllocatedMetrics,
  rows: T[],
  shareOf: (row: T) => RawShare,
): AllocatedMetrics[] {
  const sh = rows.map(shareOf)
  const spend = allocate(parent.spendCents, sh.map((s) => s.micros))
  const sales = allocate(parent.salesCents, sh.map((s) => s.salesCents))
  const impr = allocate(parent.impressions, sh.map((s) => s.impr))
  const clicks = allocate(parent.clicks, sh.map((s) => s.clicks))
  const orders = allocate(parent.orders, sh.map((s) => s.orders))
  return rows.map((_, i) => toMetrics(impr[i]!, clicks[i]!, spend[i]!, sales[i]!, orders[i]!))
}

export { emptyShare }
export type { RawShare }
