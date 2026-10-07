/**
 * BID BRAIN BB-3 — the loaders: what the brain needs to decide one market's bids, read once per run. Nothing here
 * writes. Called inside a business (the cron runs once per business; RLS keeps each to its own rows).
 *
 *   campaigns   every Sponsored Products campaign of the market (the pools need all of them); the brain decides only
 *               for those on the live-write allowlist
 *   evidence    one aggregate over AmazonAdsDailyPerformance at AD_TARGET grain: settled days only (ads-settled-window),
 *               up to 90 of them, each weighted with a 30-day half-life — in SQL, so one row per keyword crosses the wire
 *   freshness   the newest AD_TARGET report of the market's keywords' last 14 days: older than 48 hours is a brake
 *   run         the strategy per ad group, the campaign targets and account default, the holds (pins, a person's bid
 *               of the last 60 days, BidHold rows), enrollments, each keyword's last writer and the brain's last step
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'
import { personBidTargetIds } from '../bid-grid.service.js'
import { readEnginePosture } from '../ads-engine-guard.js'
import { settledBounds } from '../ads-settled-window.js'
import { readOwnerTargets } from '../ads-target-acos-resolver.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { openStrategy } from '../ads-strategy/effective.js'
import { MAX_WINDOW_DAYS, type Evidence } from './estimator.js'
import type { AdGroupRow, CampaignRow, MarketRows, RunRows, StrategyRead, TargetRow } from './facts.js'

/** The markets the shadow decides for (Owner, 2026-10-07: shadow on IT and DE first). */
export const SHADOW_MARKETS = ['IT', 'DE'] as const
/** Report data older than this stops the brain (design §2 brakes). */
export const STALE_DATA_HOURS = 48

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** One market's campaigns, ad groups, keywords, evidence and listing prices. */
export async function loadMarket(market: string, opts: { now?: Date } = {}): Promise<MarketRows & { newestReportAt: Date | null }> {
  const now = opts.now ?? new Date()
  const window = settledBounds(MAX_WINDOW_DAYS, 'SPONSORED_PRODUCTS', { now })
  const dataDay = isoDay(window.until)
  const all = await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', marketplace: { not: null } },
    select: {
      id: true, marketplace: true, status: true, liveBidWritesEnabled: true, pinBids: true, pinnedBy: true, bidsSuppressedAt: true,
      bidsSuppressedFloorCents: true, bidsSuppressedBy: true, minBidCents: true, maxBidCents: true, dynamicBidding: true,
    },
  })
  const campaigns = new Map<string, CampaignRow>()
  for (const c of all) {
    if (strategyMarket(c.marketplace) !== market) continue
    campaigns.set(c.id, {
      id: c.id, status: String(c.status), pinBids: c.pinBids, pinnedBy: c.pinnedBy, bidsSuppressedAt: c.bidsSuppressedAt,
      bidsSuppressedFloorCents: c.bidsSuppressedFloorCents, bidsSuppressedBy: c.bidsSuppressedBy, minBidCents: c.minBidCents,
      maxBidCents: c.maxBidCents, ownTargetAcos: (c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos, allowlisted: c.liveBidWritesEnabled,
    })
  }
  const empty = { market, dataDay, campaigns, adGroups: new Map(), targets: [], evidence: new Map(), adSales30: new Map(), prices: new Map(), newestReportAt: null }
  if (![...campaigns.values()].some((c) => c.allowlisted)) return empty

  const groups = await prisma.adGroup.findMany({
    where: { campaignId: { in: [...campaigns.keys()] } },
    select: { id: true, campaignId: true, status: true, bidsSuppressedAt: true, bidsSuppressedFloorCents: true, bidsSuppressedBy: true },
  })
  const groupIds = groups.map((g) => g.id)
  const [targets, productAds] = await Promise.all([
    prisma.adTarget.findMany({
      where: { adGroupId: { in: groupIds }, isNegative: false, status: 'ENABLED', orphanedAt: null, retiredAt: null },
      select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true },
    }),
    prisma.adProductAd.findMany({
      where: { adGroupId: { in: groupIds }, productId: { not: null } },
      select: { adGroupId: true, productId: true, product: { select: { parentId: true, basePrice: true } } },
    }),
  ])
  const families = new Map<string, Set<string>>()
  const prices = new Map<string, number>()
  for (const pa of productAds) {
    const family = pa.product?.parentId ?? pa.productId!
    families.set(pa.adGroupId, (families.get(pa.adGroupId) ?? new Set()).add(family))
    const price = Math.round(Number(pa.product?.basePrice ?? 0) * 100)
    if (price > 0 && !prices.has(family)) prices.set(family, price)
  }
  const adGroups = new Map<string, AdGroupRow>(groups.map((g) => [g.id, {
    id: g.id, campaignId: g.campaignId, status: String(g.status), bidsSuppressedAt: g.bidsSuppressedAt,
    bidsSuppressedFloorCents: g.bidsSuppressedFloorCents, bidsSuppressedBy: g.bidsSuppressedBy, families: [...(families.get(g.id) ?? [])].sort(),
  }]))
  const targetIds = targets.map((t) => t.id)
  const [{ evidence, adSales30 }, newestReportAt] = await Promise.all([loadEvidence(targetIds, window), newestReport(targetIds, now)])
  return { market, dataDay, campaigns, adGroups, targets, evidence, adSales30, prices, newestReportAt }
}

/** The decayed sums per keyword over the settled window (one row per keyword with data). */
export async function loadEvidence(targetIds: readonly string[], window: { since: Date; until: Date }): Promise<{ evidence: Map<string, Evidence>; adSales30: Map<string, number> }> {
  if (!targetIds.length) return { evidence: new Map(), adSales30: new Map() }
  const rows = await prisma.$queryRaw<Array<{ id: string; clicks: number; orders: number; sales: number; cost: number; sales30: number }>>(Prisma.sql`
    SELECT d."localEntityId" AS id,
           SUM(d.clicks * d.w)::float8 AS clicks,
           SUM(COALESCE(d."orders7d", 0) * d.w)::float8 AS orders,
           SUM(COALESCE(d."sales7dCents", 0) * d.w)::float8 AS sales,
           SUM(d."costMicros"::float8 / 10000 * d.w)::float8 AS cost,
           SUM(CASE WHEN d.age < 30 THEN COALESCE(d."sales7dCents", 0) ELSE 0 END)::float8 AS sales30
      FROM (SELECT p."localEntityId", p.clicks, p."orders7d", p."sales7dCents", p."costMicros",
                   (${isoDay(window.until)}::date - p.date) AS age,
                   power(0.5, (${isoDay(window.until)}::date - p.date)::float8 / 30) AS w
              FROM "AmazonAdsDailyPerformance" p
             WHERE p."entityType" = 'AD_TARGET' AND p."adProduct" = 'SPONSORED_PRODUCTS'
               AND p."localEntityId" = ANY(${[...targetIds]}::text[])
               AND p.date BETWEEN ${isoDay(window.since)}::date AND ${isoDay(window.until)}::date) d
     GROUP BY d."localEntityId"`)
  return {
    evidence: new Map(rows.map((r) => [r.id, { clicks: Number(r.clicks), orders: Number(r.orders), salesCents: Number(r.sales), costCents: Number(r.cost) }])),
    adSales30: new Map(rows.map((r) => [r.id, Number(r.sales30)])),
  }
}

/**
 * BB-5 — TACoS: each family's Amazon sales in the market over the 30 settled days (DailySalesAggregate, every SKU of the
 * family: the parent and its variations), in cents. Read only when a strategy target of the market is a TACoS one.
 */
export async function loadFamilySales(market: string, families: readonly string[], until: Date): Promise<Map<string, number>> {
  if (!families.length) return new Map()
  const products = await prisma.product.findMany({ where: { OR: [{ id: { in: [...families] } }, { parentId: { in: [...families] } }] }, select: { id: true, sku: true, parentId: true } })
  const familyOfSku = new Map(products.map((p) => [p.sku, p.parentId && families.includes(p.parentId) ? p.parentId : p.id]))
  if (!familyOfSku.size) return new Map()
  const rows = await prisma.dailySalesAggregate.groupBy({
    by: ['sku'],
    where: { sku: { in: [...familyOfSku.keys()] }, channel: 'AMAZON', marketplace: market, day: { gt: new Date(until.getTime() - 30 * 86_400_000), lte: until } },
    _sum: { grossRevenue: true },
  })
  const out = new Map<string, number>()
  for (const r of rows) {
    const family = familyOfSku.get(r.sku)
    if (family) out.set(family, (out.get(family) ?? 0) + Math.round(Number(r._sum.grossRevenue ?? 0) * 100))
  }
  return out
}

/** The newest AD_TARGET report of these keywords' last 14 days (Amazon re-reports a day while its sales settle; null: none). */
async function newestReport(targetIds: readonly string[], now: Date): Promise<Date | null> {
  if (!targetIds.length) return null
  const since = new Date(now.getTime() - 14 * 86_400_000)
  const [row] = await prisma.$queryRaw<Array<{ at: Date | null }>>(Prisma.sql`
    SELECT MAX(p."reportedAt") AS at FROM "AmazonAdsDailyPerformance" p
     WHERE p."entityType" = 'AD_TARGET' AND p."localEntityId" = ANY(${[...targetIds]}::text[]) AND p.date >= ${isoDay(since)}::date`)
  return row?.at ?? null
}

/** The brakes on a whole market: the engine posture and the age of its data. */
export async function marketBrakes(newestReportAt: Date | null, now: Date): Promise<string[]> {
  const brakes: string[] = []
  const posture = await readEnginePosture()
  if (posture.posture === 'stopped') brakes.push(posture.why)
  if (!newestReportAt) brakes.push('no keyword report for the last 14 days')
  else if (now.getTime() - newestReportAt.getTime() > STALE_DATA_HOURS * 3_600_000) brakes.push(`data more than ${STALE_DATA_HOURS} hours old (newest report ${newestReportAt.toISOString()})`)
  return brakes
}

/** The strategy per ad group, as the brain reads it. */
export async function loadStrategy(market: string, adGroupIds: readonly string[]): Promise<Map<string, StrategyRead>> {
  const out = new Map<string, StrategyRead>()
  if (!adGroupIds.length) return out
  const view = await openStrategy(market)
  if (view.empty) return out
  for (const [id, e] of await view.forAdGroups(adGroupIds)) {
    const t = e.resolved.fields.get('target')?.value as { targetKind?: unknown; targetPct?: unknown; targetLoPct?: unknown; targetHiPct?: unknown } | undefined
    const target = t && (t.targetKind === 'ACOS' || t.targetKind === 'TACOS') && typeof t.targetPct === 'number' ? { kind: t.targetKind, pct: t.targetPct } as const : null
    // BB-5 — the band, in the target's own kind (either side may be empty).
    const side = (v: unknown) => (typeof v === 'number' ? v : null)
    const band = target && (side(t?.targetLoPct) != null || side(t?.targetHiPct) != null) ? { loPct: side(t?.targetLoPct), hiPct: side(t?.targetHiPct) } : null
    const goal = e.resolved.fields.get('goal')?.value
    out.set(id, {
      target,
      acosPct: e.values.targetAcosPct,
      band,
      goal: typeof goal === 'string' ? goal : null,
      minBidCents: e.values.minBidCents,
      maxBidCents: e.values.maxBidCents,
      maxChangePct: e.values.maxChangePct,
    })
  }
  return out
}

export interface LastWrite { actor: string | null; at: Date }
export interface PreviousDecision {
  action: string
  layer: string
  currentCents: number
  decidedCents: number
  createdAt: Date
  lastStep: { dataDay: string; fromCents: number; toCents: number } | null
}

/** Each keyword's newest bid write in the last 30 days (who and when). */
export async function lastBidWrites(targetIds: readonly string[], now: Date): Promise<Map<string, LastWrite>> {
  if (!targetIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ entityId: string; userId: string | null; createdAt: Date }>>(Prisma.sql`
    SELECT DISTINCT ON (l."entityId") l."entityId", l."userId", l."createdAt" FROM "AdvertisingActionLog" l
     WHERE l."entityType" = 'AD_TARGET' AND l."actionType" = 'AD_BID_UPDATE' AND l."entityId" = ANY(${[...targetIds]}::text[])
       AND l."createdAt" >= ${new Date(now.getTime() - 30 * 86_400_000)}
     ORDER BY l."entityId", l."createdAt" DESC`)
  return new Map(rows.map((r) => [r.entityId, { actor: r.userId, at: r.createdAt }]))
}

/** Each keyword's newest decision of the brain in the last 30 days. */
export async function previousDecisions(targetIds: readonly string[], now: Date): Promise<Map<string, PreviousDecision>> {
  if (!targetIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ targetId: string; action: string; layer: string; currentCents: number; decidedCents: number; createdAt: Date; lastStep: unknown }>>(Prisma.sql`
    SELECT DISTINCT ON (d."targetId") d."targetId", d.action, d.layer, d."currentCents", d."decidedCents", d."createdAt", d.evidence -> 'lastStep' AS "lastStep"
      FROM "BidBrainDecision" d
     WHERE d."targetId" = ANY(${[...targetIds]}::text[]) AND d."createdAt" >= ${new Date(now.getTime() - 30 * 86_400_000)}
     ORDER BY d."targetId", d."createdAt" DESC`)
  return new Map(rows.map((r) => {
    const s = r.lastStep as { dataDay?: unknown; fromCents?: unknown; toCents?: unknown } | null
    const lastStep = s && typeof s.dataDay === 'string' && typeof s.fromCents === 'number' && typeof s.toCents === 'number' ? { dataDay: s.dataDay, fromCents: s.fromCents, toCents: s.toCents } : null
    return [r.targetId, { action: r.action, layer: r.layer, currentCents: r.currentCents, decidedCents: r.decidedCents, createdAt: r.createdAt, lastStep }]
  }))
}

/** The run's other facts for the allowlisted campaigns of one market. */
export async function loadRun(m: MarketRows & { newestReportAt: Date | null }, now: Date): Promise<{ run: RunRows; lastWrites: Map<string, LastWrite>; previous: Map<string, PreviousDecision> }> {
  const campaignIds = [...m.campaigns.values()].filter((c) => c.allowlisted).map((c) => c.id)
  const campaignSet = new Set(campaignIds)
  const groupIds = [...m.adGroups.values()].filter((g) => campaignSet.has(g.campaignId)).map((g) => g.id)
  const groupSet = new Set(groupIds)
  const targetIds = m.targets.filter((t) => groupSet.has(t.adGroupId)).map((t) => t.id)
  const [brakes, strategy, owner, personHeld, holds, enrollments, lastWrites, previous] = await Promise.all([
    marketBrakes(m.newestReportAt, now),
    loadStrategy(m.market, groupIds),
    readOwnerTargets([]),
    personBidTargetIds(),
    prisma.bidHold.findMany({
      where: { campaignId: { in: campaignIds }, endedAt: null, OR: [{ until: null }, { until: { gt: now } }] },
      select: { campaignId: true, targetId: true, kind: true, by: true, until: true },
    }),
    prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: campaignIds } }, select: { campaignId: true, mode: true, heldBy: true, heldUntil: true } }),
    lastBidWrites(targetIds, now),
    previousDecisions(targetIds, now),
  ])
  const accountDefaultPct = typeof owner.accountDefaultPct === 'number' ? owner.accountDefaultPct : null
  // BB-5 — a TACoS target needs each family's total Amazon sales (read only when one is in force here).
  const tacosGroups = groupIds.filter((id) => strategy.get(id)?.target?.kind === 'TACOS')
  const tacosFamilies = [...new Set(tacosGroups.flatMap((id) => m.adGroups.get(id)?.families ?? []))]
  const familySales = tacosFamilies.length ? await loadFamilySales(m.market, tacosFamilies, new Date(`${m.dataDay}T00:00:00Z`)) : new Map<string, number>()
  const lastSteps = new Map([...previous].flatMap(([id, p]) => (p.lastStep ? [[id, p.lastStep] as const] : [])))
  return {
    run: {
      marketBrakes: brakes,
      strategy,
      accountDefaultPct,
      personHeld,
      holds,
      enrollments: new Map(enrollments.map((e) => [e.campaignId, { mode: e.mode, heldBy: e.heldBy, heldUntil: e.heldUntil }])),
      lastSteps,
      familySales,
    },
    lastWrites,
    previous,
  }
}
