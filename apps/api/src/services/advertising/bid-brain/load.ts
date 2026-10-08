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
 *   BB-8        the overrides' sources (loadOverrideSources): each ad group's stock (ads-stock-risk.service.ts), what a
 *               playbook holds on each campaign, the break-even ACoS of the products advertised, a LAUNCH row's day,
 *               and for a keyword the brain last lowered by an override, the bid of its last decision before it
 *   BB-9        the rules' active inputs per campaign (loadDirectives: BidDirective rows not past `until`), each named by
 *               its rule
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
import { stockFactOf, type DirectiveRow, type AdGroupRow, type CampaignRow, type MarketRows, type PlaybookFact, type RunRows, type StockFact, type StrategyRead, type TargetRow } from './facts.js'
import { LOWERING_LAYERS, type DecisionLayer } from './decide.js'
import { readStockAdGroups } from '../ads-stock-risk.service.js'
import { breakevenByProduct } from '../ads-target-acos.service.js'
import { DEFAULT_STOP_BID_CENTS } from '../ads-strategy/fields.js'
import { PHASE_FLOOR_KIND } from '../ads-playbook/phase.js'
import { STOP_FLOOR_KIND } from '../ads-playbook/held.js'

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
  const productIdsOf = new Map<string, Set<string>>()
  const prices = new Map<string, number>()
  for (const pa of productAds) {
    const family = pa.product?.parentId ?? pa.productId!
    families.set(pa.adGroupId, (families.get(pa.adGroupId) ?? new Set()).add(family))
    productIdsOf.set(pa.adGroupId, (productIdsOf.get(pa.adGroupId) ?? new Set()).add(pa.productId!))
    const price = Math.round(Number(pa.product?.basePrice ?? 0) * 100)
    if (price > 0 && !prices.has(family)) prices.set(family, price)
  }
  const adGroups = new Map<string, AdGroupRow>(groups.map((g) => [g.id, {
    id: g.id, campaignId: g.campaignId, status: String(g.status), bidsSuppressedAt: g.bidsSuppressedAt,
    bidsSuppressedFloorCents: g.bidsSuppressedFloorCents, bidsSuppressedBy: g.bidsSuppressedBy, families: [...(families.get(g.id) ?? [])].sort(),
    productIds: [...(productIdsOf.get(g.id) ?? [])].sort(),
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
export async function loadStrategy(market: string, adGroupIds: readonly string[], now: Date = new Date()): Promise<Map<string, StrategyRead>> {
  const out = new Map<string, StrategyRead>()
  const launchRows = new Map<string, string>()
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
      // BB-8 — the stop bid (a stock or playbook floor lands there); a LAUNCH row's day is set below.
      stopBidCents: e.values.stop?.bidCents ?? null,
      ...(goal === 'LAUNCH' ? { launchDay: null } : {}),
    })
    const row = goal === 'LAUNCH' ? e.resolved.fields.get('goal')?.source?.strategyId : null
    if (row) launchRows.set(id, row)
  }
  // BB-8 — a LAUNCH product's day of its ramp: since the row that sets the goal last changed it to LAUNCH.
  if (launchRows.size) {
    const since = await launchSince([...new Set(launchRows.values())])
    for (const [id, row] of launchRows) {
      const at = since.get(row)
      if (at) out.get(id)!.launchDay = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000))
    }
  }
  return out
}

/** BB-8 — per strategy row, when its goal last became LAUNCH (the newest version whose changes set it). */
export async function launchSince(strategyIds: readonly string[]): Promise<Map<string, Date>> {
  if (!strategyIds.length) return new Map()
  const versions = await prisma.adsStrategyVersion.findMany({
    where: { strategyId: { in: [...strategyIds] } },
    orderBy: { createdAt: 'desc' },
    select: { strategyId: true, changes: true, values: true, op: true, createdAt: true },
  })
  const out = new Map<string, Date>()
  for (const v of versions) {
    if (out.has(v.strategyId)) continue
    const changes = Array.isArray(v.changes) ? (v.changes as Array<{ field?: unknown; to?: unknown }>) : []
    const goalTo = changes.find((c) => c?.field === 'goal')?.to
    if (goalTo === 'LAUNCH' || (goalTo == null && (v.values as { goal?: unknown } | null)?.goal === 'LAUNCH' && v.op === 'create')) out.set(v.strategyId, v.createdAt)
  }
  return out
}

/** BB-8 — the overrides' sources for the allowlisted campaigns of one market (see the header). */
export async function loadOverrideSources(
  m: MarketRows,
  q: { campaignIds: readonly string[]; groupIds: readonly string[]; strategy: ReadonlyMap<string, StrategyRead>; previous: ReadonlyMap<string, PreviousDecision>; marketplaces: readonly string[] },
): Promise<Pick<RunRows, 'stock' | 'playbook' | 'lowered' | 'breakEven'>> {
  const stopOf = (adGroupId: string) => q.strategy.get(adGroupId)?.stopBidCents ?? DEFAULT_STOP_BID_CENTS
  const [stock, playbook, lowered, breakEven] = await Promise.all([
    loadStockFacts(q.campaignIds, stopOf),
    loadPlaybookFacts(m, q.campaignIds, q.groupIds, stopOf),
    loadLowered(q.previous),
    loadBreakEven(m, q.groupIds, q.marketplaces),
  ])
  return { stock, playbook, lowered, breakEven }
}

async function loadStockFacts(campaignIds: readonly string[], stopOf: (adGroupId: string) => number): Promise<Map<string, StockFact>> {
  const out = new Map<string, StockFact>()
  if (!campaignIds.length) return out
  const { adGroups } = await readStockAdGroups({ campaignIds })
  for (const g of adGroups) {
    const f = stockFactOf(g, stopOf(g.id))
    if (f) out.set(g.id, f)
  }
  return out
}

/**
 * What a playbook holds on each campaign: a slot it BUILT while the playbook does not run (stopped → a STOP, never
 * started → its PHASE floor); a slot its phase floors (PHASE_FLOOR_KIND); a floor its STOP took over (STOP_FLOOR_KIND).
 * The floor: the campaign's own stamp, else the lowest stop bid of its ad groups.
 */
async function loadPlaybookFacts(m: MarketRows, campaignIds: readonly string[], groupIds: readonly string[], stopOf: (adGroupId: string) => number): Promise<Map<string, PlaybookFact>> {
  const out = new Map<string, PlaybookFact>()
  if (!campaignIds.length) return out
  const links = await prisma.adsPlaybookLink.findMany({
    where: { refId: { in: [...campaignIds] }, OR: [{ kind: 'slot', origin: 'built' }, { kind: PHASE_FLOOR_KIND }, { kind: STOP_FLOOR_KIND }] },
    select: { kind: true, refId: true, playbookId: true },
  })
  if (!links.length) return out
  const books = new Map((await prisma.adsPlaybook.findMany({ where: { id: { in: [...new Set(links.map((l) => l.playbookId))] } }, select: { id: true, label: true, state: true } })).map((b) => [b.id, b]))
  const groupsOf = new Map<string, string[]>()
  for (const id of groupIds) {
    const g = m.adGroups.get(id)
    if (g) groupsOf.set(g.campaignId, [...(groupsOf.get(g.campaignId) ?? []), id])
  }
  const floorOf = (campaignId: string) => {
    const stops = (groupsOf.get(campaignId) ?? []).map(stopOf)
    return m.campaigns.get(campaignId)?.bidsSuppressedFloorCents ?? (stops.length ? Math.min(...stops) : DEFAULT_STOP_BID_CENTS)
  }
  const rank = { stopped: 3, notStarted: 2, phaseFloor: 1 } as const
  for (const l of links) {
    const book = books.get(l.playbookId)
    if (!book) continue
    const kind: PlaybookFact['kind'] | null = l.kind === STOP_FLOOR_KIND
      ? 'stopped'
      : l.kind === PHASE_FLOOR_KIND
        ? 'phaseFloor'
        : book.state === 'RUNNING' ? null : book.state === 'STOPPED' ? 'stopped' : 'notStarted'
    if (!kind) continue
    const had = out.get(l.refId)
    if (had && rank[had.kind] >= rank[kind]) continue
    out.set(l.refId, { kind, floorCents: floorOf(l.refId), label: book.label })
  }
  return out
}

/** For each keyword the brain last lowered by an override: that override and the bid of its last decision before it. */
async function loadLowered(previous: ReadonlyMap<string, PreviousDecision>): Promise<Map<string, { layer: DecisionLayer; heldCents: number; beforeCents: number | null }>> {
  const out = new Map<string, { layer: DecisionLayer; heldCents: number; beforeCents: number | null }>()
  // A give-back that found no bid to go back to (a restore hold) still waits for one: it stays a candidate.
  const ids = [...previous].filter(([, p]) => (LOWERING_LAYERS as readonly string[]).includes(p.layer) || (p.layer === 'restore' && p.action === 'hold')).map(([id]) => id)
  if (!ids.length) return out
  // The bid before: a decision no override lowered (a give-back that wrote counts; one that held at the floor does not).
  const kept = ['goal', 'band', 'limit', 'no_goal', 'pin', 'freeze']
  const rows = await prisma.$queryRaw<Array<{ targetId: string; decidedCents: number }>>(Prisma.sql`
    SELECT DISTINCT ON (d."targetId") d."targetId", d."decidedCents" FROM "BidBrainDecision" d
     WHERE d."targetId" = ANY(${ids}::text[]) AND (d.layer = ANY(${kept}::text[]) OR (d.layer = 'restore' AND d.action = 'write'))
     ORDER BY d."targetId", d."createdAt" DESC`)
  const before = new Map(rows.map((r) => [r.targetId, r.decidedCents]))
  for (const id of ids) {
    const p = previous.get(id)!
    out.set(id, { layer: p.layer as DecisionLayer, heldCents: p.decidedCents, beforeCents: before.get(id) ?? null })
  }
  return out
}

/** Each ad group's break-even ACoS: its products' (with usable profit data), weighted by their revenue. */
async function loadBreakEven(m: MarketRows, groupIds: readonly string[], marketplaces: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const products = [...new Set(groupIds.flatMap((id) => m.adGroups.get(id)?.productIds ?? []))]
  if (!products.length) return out
  const be = await breakevenByProduct(products, marketplaces)
  if (!be.size) return out
  for (const id of groupIds) {
    let w = 0
    let sum = 0
    for (const p of m.adGroups.get(id)?.productIds ?? []) {
      const r = be.get(p)
      if (!r) continue
      const weight = Math.max(1, r.grossRevenueCents)
      sum += r.breakevenAcos * weight
      w += weight
    }
    if (w > 0) out.set(id, Math.round((sum / w) * 10_000) / 10_000)
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
    loadStrategy(m.market, groupIds, now),
    readOwnerTargets([]),
    personBidTargetIds(),
    prisma.bidHold.findMany({
      where: { campaignId: { in: campaignIds }, endedAt: null, OR: [{ until: null }, { until: { gt: now } }] },
      select: { campaignId: true, targetId: true, kind: true, by: true, until: true },
    }),
    // BB-8 — a HELD enrollment past its `heldUntil` no longer holds (read as LIVE).
    prisma.bidBrainEnrollment.findMany({ where: { campaignId: { in: campaignIds } }, select: { campaignId: true, mode: true, heldBy: true, heldUntil: true } })
      .then((rows) => rows.map((e) => (e.mode === 'HELD' && e.heldUntil && e.heldUntil <= now ? { ...e, mode: 'LIVE' } : e))),
    lastBidWrites(targetIds, now),
    previousDecisions(targetIds, now),
  ])
  const accountDefaultPct = typeof owner.accountDefaultPct === 'number' ? owner.accountDefaultPct : null
  // BB-5 — a TACoS target needs each family's total Amazon sales (read only when one is in force here).
  const tacosGroups = groupIds.filter((id) => strategy.get(id)?.target?.kind === 'TACOS')
  const tacosFamilies = [...new Set(tacosGroups.flatMap((id) => m.adGroups.get(id)?.families ?? []))]
  const familySales = tacosFamilies.length ? await loadFamilySales(m.market, tacosFamilies, new Date(`${m.dataDay}T00:00:00Z`)) : new Map<string, number>()
  const lastSteps = new Map([...previous].flatMap(([id, p]) => (p.lastStep ? [[id, p.lastStep] as const] : [])))
  // Profit rows carry the market's code ('IT'), as the roll-up writes them.
  const sources = await loadOverrideSources(m, { campaignIds, groupIds, strategy, previous, marketplaces: [m.market] })
  const directives = await loadDirectives(campaignIds, now)
  return {
    run: {
      ...sources,
      directives,
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

/** BB-9 — the rules' active inputs per campaign, each named by who asked (a rule by its name). */
export async function loadDirectives(campaignIds: readonly string[], now: Date = new Date()): Promise<Map<string, DirectiveRow[]>> {
  const out = new Map<string, DirectiveRow[]>()
  if (!campaignIds.length) return out
  const rows = await prisma.bidDirective.findMany({
    where: { campaignId: { in: [...campaignIds] }, OR: [{ until: null }, { until: { gt: now } }] },
    select: { campaignId: true, targetId: true, lane: true, kind: true, valueCents: true, valuePct: true, source: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!rows.length) return out
  const ruleIds = [...new Set(rows.flatMap((r) => (r.source.startsWith('rule:') ? [r.source.slice(5)] : [])))]
  const names = new Map(ruleIds.length ? (await prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true } })).map((r) => [r.id, r.name]) : [])
  for (const r of rows) {
    const rule = r.source.startsWith('rule:') ? r.source.slice(5) : null
    const label = rule ? `rule "${names.get(rule) ?? rule}"` : r.source
    out.set(r.campaignId, [...(out.get(r.campaignId) ?? []), { targetId: r.targetId, lane: r.lane, kind: r.kind, valueCents: r.valueCents, valuePct: r.valuePct, label }])
  }
  return out
}

