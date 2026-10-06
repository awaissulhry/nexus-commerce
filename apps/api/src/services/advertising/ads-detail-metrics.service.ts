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
import { EXCLUDE_AMS_DAILY } from '../ads-core/ams-daily.js'
import { adSalesCents } from '../ads-core/ad-sales.js'
import { budgetDayStart } from '@nexus/shared/ads-budget-day'

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
      ...EXCLUDE_AMS_DAILY, // AX2.3 — the entityId arm also matches AMS daily rows

    },
    _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true },
  })
  let campImpr = cagg._sum.impressions ?? 0
  let campClicks = cagg._sum.clicks ?? 0
  let campSpend = microsToCents(cagg._sum.costMicros)
  let campSales = adSalesCents(cagg._sum)
  let campOrders = cagg._sum.orders7d ?? 0

  // DR.3 — intraday overlay. Daily performance is T+1, so when the range
  // includes today its daily row is absent; layer in today's Amazon Marketing
  // Stream HOURLY rows (CAMPAIGN grain) so "Today"/MTD/YTD reflect live spend.
  // AM-5 — the Ad Manager list reads the SAME overlay (`readIntradayOverlay`), so list and detail agree.
  const overlay = await readIntradayOverlay([{ id: opts.campaignId, externalCampaignId: opts.externalCampaignId }], opts.until)
  const today = overlay?.byCampaign.get(opts.campaignId)
  if (today) {
    campImpr += today.impressions
    campClicks += today.clicks
    campSpend += today.spendCents
    campSales += today.salesCents
    campOrders += today.orders
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
      cur.salesCents += adSalesCents(r._sum)
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

/** Today's hourly figures for one campaign (cents, counts). */
export interface IntradaySums { impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number }
export interface IntradayOverlay {
  /** The UTC day the hourly rows cover — the budget day (`@nexus/shared/ads-budget-day`), as the stream buckets it. */
  day: string
  /** The newest UTC hour with a row today; null when the stream has sent nothing yet today. */
  throughHour: number | null
  /** True when the hourly table could not be read: today's figures are missing, not zero. */
  unavailable: boolean
  byCampaign: Map<string, IntradaySums>
}

/**
 * DR.3 + AM-5 — THE intraday source: today's Amazon Marketing Stream HOURLY rows at campaign grain, summed per
 * campaign. The campaign detail page and the Ad Manager list both read it, so for any range that reaches today the
 * two can never disagree. Null when the range ends before today (the daily report covers it).
 *
 * A row counts for a campaign by its Nexus id, or — when the stream never linked it — by its Amazon id, the same
 * OR-match the detail page always used, without counting a row twice.
 */
export async function readIntradayOverlay(
  campaigns: Array<{ id: string; externalCampaignId: string | null }>,
  until?: Date | null,
  now: Date = new Date(),
): Promise<IntradayOverlay | null> {
  const todayUtc = budgetDayStart(now)
  if (until && until.getTime() < todayUtc.getTime()) return null
  const overlay: IntradayOverlay = { day: todayUtc.toISOString().slice(0, 10), throughHour: null, unavailable: false, byCampaign: new Map() }
  if (!campaigns.length) return overlay
  const ids = campaigns.map((c) => c.id)
  const localOf = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId as string, c.id]))
  // 🔴 GX.5 — NEVER `EXCLUDE_AMS_DAILY` here. That marker means "a row the stream wrote to the DAILY table"; on
  // this, the stream's OWN table, every row carries it (measured 2026-08-26: 33,099 of 33,099), so the filter
  // excluded everything and "Today" on the campaign page showed no spend at all. `EXCLUDE_AMS_DAILY`, not
  // `EXCLUDE_AMS`: a guard that is correct on one table can be exactly inverted on another.
  const _sum = { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true } as const
  try {
    const [byLocal, byExt, newest] = await Promise.all([
      prisma.amazonAdsHourlyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: todayUtc, localEntityId: { in: ids } }, _sum }),
      localOf.size
        ? prisma.amazonAdsHourlyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'CAMPAIGN', date: todayUtc, localEntityId: null, entityId: { in: [...localOf.keys()] } }, _sum })
        : Promise.resolve([]),
      prisma.amazonAdsHourlyPerformance.aggregate({ where: { entityType: 'CAMPAIGN', date: todayUtc }, _max: { hour: true } }),
    ])
    const add = (cid: string | null | undefined, s: (typeof byLocal)[number]['_sum']) => {
      if (!cid) return
      const cur = overlay.byCampaign.get(cid) ?? { impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0 }
      cur.impressions += s.impressions ?? 0
      cur.clicks += s.clicks ?? 0
      cur.spendCents += microsToCents(s.costMicros)
      // The hourly table carries sales7dCents only (no 14d like the daily model).
      cur.salesCents += s.sales7dCents ?? 0
      cur.orders += s.orders7d ?? 0
      overlay.byCampaign.set(cid, cur)
    }
    for (const r of byLocal) add(r.localEntityId, r._sum)
    for (const r of byExt) add(localOf.get(r.entityId), r._sum)
    overlay.throughHour = newest._max.hour ?? null
  } catch {
    overlay.unavailable = true
  }
  return overlay
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
