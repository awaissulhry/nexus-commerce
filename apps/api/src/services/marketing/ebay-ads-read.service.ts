/**
 * MCP full control A13 (docs/mcp-full-control/sections/01-ads.md §4, §6 step 13) — the eBay Promoted Listings reads,
 * moved out of `routes/ebay-ads.routes.ts` WITHOUT a behaviour change, so the console's routes and Claude's ad read
 * tools share one code path:
 *
 *   ebayAdsSummary     GET /ebay-ads/summary    — KPIs for a window and the window before it
 *   ebayAdsTrend       GET /ebay-ads/trend      — the account's daily points
 *   ebayAdsCampaigns   GET /ebay-ads/campaigns  — the campaign grid
 *   ebayAdsActions     GET /ebay-ads/actions    — the audit trail (moved with the eBay gap of ad-changes)
 *   ebayCampaignDetail GET /ebay-ads/campaigns/:id — one campaign's page: its ads (per-listing rate, break-even),
 *                      ad groups, keywords (bid, status) and negatives, with listing and keyword metrics (moved for
 *                      Claude's ebay-ad-details read, T4)
 *
 * The routes answer exactly what these return (proven byte-equal against the code before the move). The helpers the
 * other eBay routes share (factWhere, sumFields, toSums, derive, freshness) moved with them and are imported back.
 *
 * Below them, three reads only the tools use: each campaign's OWN eBay account (EbayCampaign.channelConnectionId — the
 * account a later change must go to, P4.5a), each market's currency, and the newest day of performance data.
 *
 * Read-only: stored rows only. No eBay call, no token, no gateway.
 */
import prisma from '../../db.js'
import { resolveRange, priorRange, bucketFor, comparisonRanges, type ResolvedRange } from '../ads-core/date-range.js'
import { EBAY_MANAGED_STATUSES } from '../ads-core/campaign-status.js'
import { EBAY_MARKETPLACE_SHORT } from '../ads-core/ebay-marketplace.js'

export interface WindowQuery { preset?: string; startDate?: string; endDate?: string; marketplace?: string }

export function factWhere(q: WindowQuery, r: ResolvedRange, entityType?: string) {
  return {
    ...(entityType ? { entityType } : {}),
    ...(q.marketplace && q.marketplace !== 'all' ? { marketplace: q.marketplace } : {}),
    date: { gte: r.since, lte: r.until },
  }
}

export const sumFields = { impressions: true, clicks: true, adFeesCents: true, salesCents: true, soldQty: true } as const

export type Sums = { impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }
export const zeroSums: Sums = { impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0 }

export function toSums(agg: { _sum: Partial<Record<keyof Sums, number | null>> }): Sums {
  return {
    impressions: agg._sum.impressions ?? 0,
    clicks: agg._sum.clicks ?? 0,
    adFeesCents: agg._sum.adFeesCents ?? 0,
    salesCents: agg._sum.salesCents ?? 0,
    soldQty: agg._sum.soldQty ?? 0,
  }
}

export function derive(s: Sums) {
  return {
    ...s,
    ctrPct: s.impressions > 0 ? (s.clicks / s.impressions) * 100 : null,
    // eBay ACOS = ad fees ÷ ATTRIBUTED (any-click) sales — labeled in UI.
    acosPct: s.salesCents > 0 ? (s.adFeesCents / s.salesCents) * 100 : null,
    avgCpcCents: s.clicks > 0 ? Math.round(s.adFeesCents / s.clicks) : null,
  }
}

/**
 * AM-21 — never add two currencies. eBay reports each market in its own currency (EBAY_GB in GBP, the rest in EUR), and
 * the rows say which (`EbayAdsDailyPerformance.currency`). Counts (impressions, clicks, sold) add across markets; money
 * does not. When a window's rows hold more than one currency, the money fields of the one total are null and
 * `byCurrency` carries one total per currency instead. Nothing is converted: no rate is applied anywhere here.
 */
export function withoutMixedMoney<T extends ReturnType<typeof derive>>(d: T, mixed: boolean): T {
  return mixed ? { ...d, adFeesCents: null, salesCents: null, acosPct: null, avgCpcCents: null } : d
}

export function addSums(a: Sums, b: Sums): Sums {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    adFeesCents: a.adFeesCents + b.adFeesCents,
    salesCents: a.salesCents + b.salesCents,
    soldQty: a.soldQty + b.soldQty,
  }
}

/** The one currency of a set of rows; null when they hold more than one; `fallback` when there are none. */
export function oneCurrency(currencies: Iterable<string>, fallback: string | null = null): string | null {
  const set = [...new Set(currencies)]
  return set.length === 1 ? set[0] : set.length === 0 ? fallback : null
}

export async function freshness() {
  const [facts, entity, discovery] = await Promise.all([
    prisma.ebayAdsDailyPerformance.aggregate({ _max: { reportedAt: true } }),
    prisma.ebayCampaign.aggregate({ _max: { lastEntitySyncAt: true } }),
    prisma.ebayListingIndex.aggregate({ _max: { lastSeenAt: true } }),
  ])
  return {
    factsReportedAt: facts._max.reportedAt,
    entitySyncAt: entity._max.lastEntitySyncAt,
    listingSeenAt: discovery._max.lastSeenAt,
  }
}

/** GET /ebay-ads/summary — summary KPIs (+ vs-previous-period deltas). */
export async function ebayAdsSummary(q: WindowQuery) {
  const r = resolveRange(q)
  // AM-16 — the deltas compare COMPLETE days on both sides (ads-core/date-range.ts). A window that runs into today is
  // compared on its days through yesterday; `current` still shows the whole window.
  const cmp = comparisonRanges(r)
  const p = cmp?.prior ?? priorRange(r)
  // AM-21 — one sum per reporting currency (see withoutMixedMoney), for every window: shown, compared and prior.
  const byCcy = (range: ResolvedRange) => prisma.ebayAdsDailyPerformance.groupBy({ by: ['currency'], where: factWhere(q, range, 'CAMPAIGN'), _sum: sumFields })
  const [curByCcy, comparedByCcy, prevByCcy, campaigns, economics, fr, liveCount, promotedRows] = await Promise.all([
    byCcy(r),
    cmp?.todayLeftOut ? byCcy(cmp.current) : Promise.resolve(null),
    byCcy(p),
    // AM-15 — the campaign count follows the market picker like the money beside it.
    prisma.ebayCampaign.groupBy({ by: ['status'], where: q.marketplace && q.marketplace !== 'all' ? { marketplace: q.marketplace } : {}, _count: { _all: true } }),
    prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } }),
    freshness(),
    prisma.ebayListingIndex.count({ where: { endedAt: null } }),
    prisma.ebayAd.findMany({ where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: [...EBAY_MANAGED_STATUSES] } } }, select: { listingId: true }, distinct: ['listingId'] }),
  ])
  const sumOf = (groups: typeof curByCcy) => groups.reduce((acc, g) => addSums(acc, toSums(g)), zeroSums)
  const curOf = new Map(curByCcy.map((g) => [g.currency, toSums(g)]))
  const comparedRows: typeof curByCcy = comparedByCcy ?? curByCcy
  const comparedOf = new Map<string, Sums>(comparedRows.map((g) => [g.currency, toSums(g)]))
  const prevOf = new Map(prevByCcy.map((g) => [g.currency, toSums(g)]))
  const seen = [...new Set([...curOf.keys(), ...prevOf.keys()])].sort()
  const mixed = seen.length > 1
  // No row in either window: the market's own currency from older rows, else EUR (every amount is then 0).
  const fallback = seen.length === 0 && q.marketplace && q.marketplace !== 'all'
    ? (await ebayMarketCurrencies()).get(q.marketplace) ?? 'EUR'
    : 'EUR'
  const current = withoutMixedMoney(derive(sumOf(curByCcy)), mixed)
  const compared = withoutMixedMoney(derive(sumOf(comparedRows)), mixed)
  const prior = withoutMixedMoney(derive(sumOf(prevByCcy)), mixed)
  // A window of today alone has no complete day to compare: no delta, never a made-up one. Mixed money: no delta either.
  const deltaPct = (c: number | null, pr: number | null) => (cmp && c != null && pr != null && pr > 0 ? ((c - pr) / pr) * 100 : null)
  return {
    window: { preset: r.preset, since: r.sinceStr, until: r.untilStr, days: r.days, includesToday: r.includesToday },
    // AM-16 — what the deltas compare: `current` = the window's complete days, `prior` = the same number before them.
    comparison: cmp ? { current: { since: cmp.current.sinceStr, until: cmp.current.untilStr }, prior: { since: cmp.prior.sinceStr, until: cmp.prior.untilStr }, todayLeftOut: cmp.todayLeftOut } : null,
    /** The one currency of the window's money; null when the rows hold more than one (read `byCurrency`). */
    currency: oneCurrency(seen, fallback),
    current,
    prior,
    /** One total per currency, never added together (largest ad fees first). */
    byCurrency: seen
      .map((currency) => ({
        currency,
        current: derive(curOf.get(currency) ?? zeroSums),
        // AM-16 — the complete days the deltas compare, in this currency only.
        compared: derive(comparedOf.get(currency) ?? zeroSums),
        prior: derive(prevOf.get(currency) ?? zeroSums),
      }))
      .sort((a, b) => b.current.adFeesCents - a.current.adFeesCents || a.currency.localeCompare(b.currency)),
    deltas: {
      adFeesPct: deltaPct(compared.adFeesCents, prior.adFeesCents),
      salesPct: deltaPct(compared.salesCents, prior.salesCents),
      clicksPct: deltaPct(compared.clicks, prior.clicks),
      impressionsPct: deltaPct(compared.impressions, prior.impressions),
    },
    campaignCounts: Object.fromEntries(campaigns.map((c) => [c.status, c._count._all])),
    // Net margin after ads is only shown when economics has real inputs —
    // today most listings are MISSING_COGS ("manual only"); surface that.
    economicsStatus: Object.fromEntries(economics.map((e) => [e.dataStatus, e._count._all])),
    attributionModel: 'ebay-any-click',
    // E7 #21 — coverage KPI: % of live listings promoted in ≥1 active
    // General campaign (the standing guard proposes enrollment for the rest)
    coverage: { liveListings: liveCount, promoted: promotedRows.length, pct: liveCount > 0 ? Math.round((promotedRows.length / liveCount) * 1000) / 10 : null },
    freshness: fr,
  }
}

/** GET /ebay-ads/trend — daily trend (account level = derived campaign grain summed). */
export async function ebayAdsTrend(q: WindowQuery) {
  const r = resolveRange(q)
  // AM-21 — grouped by currency too: a day's money is only summed when the whole window is in one currency.
  const rows = await prisma.ebayAdsDailyPerformance.groupBy({
    by: ['date', 'currency'],
    where: factWhere(q, r, 'CAMPAIGN'),
    _sum: sumFields,
    orderBy: { date: 'asc' },
  })
  const currency = oneCurrency(rows.map((row) => row.currency), 'EUR')
  const byDay = new Map<string, Sums>()
  for (const row of rows) {
    const day = row.date.toISOString().slice(0, 10)
    byDay.set(day, addSums(byDay.get(day) ?? zeroSums, toSums(row)))
  }
  return {
    window: { since: r.sinceStr, until: r.untilStr, bucket: bucketFor(r.days) },
    /** null when the window holds more than one currency: the points then carry counts only (money is null). */
    currency,
    points: [...byDay].map(([date, sums]) => ({
      date,
      ...withoutMixedMoney(derive(sums), currency == null),
    })),
    freshness: await freshness(),
  }
}

/** GET /ebay-ads/campaigns — the campaign grid. */
export async function ebayAdsCampaigns(q: WindowQuery) {
  const r = resolveRange(q)
  const yday = new Date(); yday.setUTCDate(yday.getUTCDate() - 1); yday.setUTCHours(0, 0, 0, 0)
  const [camps, facts, adCounts, hiddenCounts, policies, allRules, ydayFacts] = await Promise.all([
    prisma.ebayCampaign.findMany({
      where: q.marketplace && q.marketplace !== 'all' ? { marketplace: q.marketplace } : {},
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    }),
    prisma.ebayAdsDailyPerformance.groupBy({
      by: ['entityId'],
      where: factWhere(q, r, 'CAMPAIGN'),
      _sum: sumFields,
    }),
    prisma.ebayAd.groupBy({ by: ['campaignId', 'status'], _count: { _all: true } }),
    // ER3.1 — ads eBay auto-hid (out of stock): a state, not an error
    prisma.ebayAd.groupBy({ by: ['campaignId'], where: { hiddenReason: { not: null } }, _count: { _all: true } }),
    prisma.ebayCampaignAutomationPolicy.findMany(),
    prisma.ebayAdsRule.findMany({ where: { enabled: true }, select: { marketplace: true, scope: true } }),
    // ER3.1 — "Limited by budget" heuristic input: yesterday's campaign fees
    prisma.ebayAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'CAMPAIGN', date: yday }, _sum: { adFeesCents: true } }),
  ])
  const factsByExt = new Map(facts.map((f) => [f.entityId, derive(toSums(f))]))
  const adsByCampaign = new Map<string, { total: number; stale: number }>()
  for (const a of adCounts) {
    const cur = adsByCampaign.get(a.campaignId) ?? { total: 0, stale: 0 }
    cur.total += a._count._all
    if (a.status === 'STALE') cur.stale += a._count._all
    adsByCampaign.set(a.campaignId, cur)
  }
  const hiddenByCampaign = new Map(hiddenCounts.map((h) => [h.campaignId, h._count._all]))
  const policyByCampaign = new Map(policies.map((p) => [p.campaignId, p]))
  const ydayFeesByExt = new Map(ydayFacts.map((f) => [f.entityId, f._sum.adFeesCents ?? 0]))
  const ruleCountFor = (id: string, marketplace: string): number =>
    allRules.filter((r0) => {
      const scoped = ((r0.scope as { campaignIds?: string[] } | null)?.campaignIds) ?? []
      return scoped.length ? scoped.includes(id) : (!r0.marketplace || r0.marketplace === marketplace)
    }).length
  return {
    window: { preset: r.preset, since: r.sinceStr, until: r.untilStr },
    // AM-21 — each row carries its own `budgetCurrency`; this is the one they share, or null when they differ.
    currency: oneCurrency(camps.map((c) => c.budgetCurrency ?? 'EUR'), 'EUR'),
    campaigns: camps.map((c) => ({
      id: c.id,
      externalCampaignId: c.externalCampaignId,
      name: c.name,
      marketplace: c.marketplace,
      fundingModel: c.fundingModel ?? 'COST_PER_SALE',
      targetingType: c.campaignTargetingType,
      channels: c.channels,
      status: c.status,
      adRateStrategy: c.adRateStrategy,
      bidPercentage: c.bidPercentage != null ? Number(c.bidPercentage.toString()) : null,
      dailyBudgetCents: c.dailyBudget != null ? Math.round(Number(c.dailyBudget.toString()) * 100) : null,
      budgetCurrency: c.budgetCurrency ?? 'EUR',
      isRulesBased: c.isRulesBased,
      nexusManaged: c.nexusManaged,
      startDate: c.startDate,
      endDate: c.endDate,
      lastEntitySyncAt: c.lastEntitySyncAt,
      budgetUpdatesToday: c.budgetUpdatesToday, // ER3.1 — grid Budget modal meter
      ads: { ...(adsByCampaign.get(c.id) ?? { total: 0, stale: 0 }), hidden: hiddenByCampaign.get(c.id) ?? 0 },
      metrics: factsByExt.get(c.externalCampaignId) ?? derive(zeroSums),
      // ER3.1 — automation column (rules that apply + policy) + honest
      // budget-cap heuristic (yesterday fees ≥ 90% of daily budget)
      automation: {
        rules: ruleCountFor(c.id, c.marketplace),
        protected: policyByCampaign.get(c.id)?.protected ?? false,
        posture: policyByCampaign.get(c.id)?.posture ?? 'INHERIT',
      },
      limitedByBudget: (c.fundingModel === 'COST_PER_CLICK' && c.status === 'RUNNING' && c.dailyBudget != null)
        ? (ydayFeesByExt.get(c.externalCampaignId) ?? 0) >= Math.round(Number(c.dailyBudget.toString()) * 100) * 0.9
        : false,
    })),
    freshness: await freshness(),
  }
}

/**
 * GET /ebay-ads/campaigns/:id — one campaign's detail page (the web's EbayCampaignDetail): the campaign with its
 * automation policy, its ads (each one's own rate, null = the campaign's; the listing's title, price, stock and
 * break-even rate in the campaign's market), ad groups, keywords and negatives, and the listing and keyword metrics of
 * the window. Null when the id names no campaign of this business (the route answers 404).
 */
export async function ebayCampaignDetail(id: string, q: WindowQuery) {
  const c = await prisma.ebayCampaign.findUnique({
    where: { id },
    include: {
      ads: { orderBy: { updatedAt: 'desc' } },
      adGroups: { orderBy: { name: 'asc' } },
      keywords: { orderBy: { text: 'asc' } },
      negativeKeywords: { orderBy: { text: 'asc' } },
      automationPolicy: true, // ER1
    },
  })
  if (!c) return null
  const r = resolveRange(q)
  const short = EBAY_MARKETPLACE_SHORT[c.marketplace] ?? 'IT'
  const listingIds = c.ads.map((a) => a.listingId).filter((x): x is string => !!x)

  const [listingFacts, keywordFacts, index, economics] = await Promise.all([
    prisma.ebayAdsDailyPerformance.groupBy({
      by: ['entityId'],
      where: { entityType: 'LISTING', entityId: { in: listingIds.length ? listingIds : ['−'] }, date: { gte: r.since, lte: r.until }, fundingModel: c.fundingModel ?? 'COST_PER_SALE' },
      _sum: sumFields,
    }),
    prisma.ebayAdsDailyPerformance.groupBy({
      by: ['entityId'],
      where: { entityType: 'KEYWORD', date: { gte: r.since, lte: r.until } },
      _sum: sumFields,
    }),
    prisma.ebayListingIndex.findMany({ where: { marketplace: short, itemId: { in: listingIds.length ? listingIds : ['−'] } }, select: { itemId: true, title: true, price: true, currency: true, quantity: true, endedAt: true } }),
    prisma.ebayListingEconomics.findMany({ where: { marketplace: short, itemId: { in: listingIds.length ? listingIds : ['−'] } }, select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }),
  ])
  const lf = new Map(listingFacts.map((f) => [f.entityId, derive(toSums(f))]))
  const kf = new Map(keywordFacts.map((f) => [f.entityId, derive(toSums(f))]))
  const idx = new Map(index.map((i) => [i.itemId, i]))
  const eco = new Map(economics.map((e) => [e.itemId, e]))
  const groupsById = new Map(c.adGroups.map((g) => [g.id, g]))

  return {
    window: { preset: r.preset, since: r.sinceStr, until: r.untilStr },
    currency: c.budgetCurrency ?? 'EUR',
    campaign: {
      id: c.id,
      externalCampaignId: c.externalCampaignId,
      name: c.name,
      marketplace: c.marketplace,
      fundingModel: c.fundingModel ?? 'COST_PER_SALE',
      targetingType: c.campaignTargetingType,
      channels: c.channels,
      status: c.status,
      adRateStrategy: c.adRateStrategy,
      dynamicAdRatePrefs: c.dynamicAdRatePrefs,
      campaignCriterion: c.campaignCriterion,
      isRulesBased: c.isRulesBased,
      nexusManaged: c.nexusManaged,
      bidPercentage: c.bidPercentage != null ? Number(c.bidPercentage.toString()) : null,
      dailyBudgetCents: c.dailyBudget != null ? Math.round(Number(c.dailyBudget.toString()) * 100) : null,
      budgetUpdatesToday: c.budgetUpdatesToday,
      startDate: c.startDate,
      endDate: c.endDate,
      lastEntitySyncAt: c.lastEntitySyncAt,
      // ER1 — per-campaign automation policy (null = INHERIT defaults)
      automationPolicy: c.automationPolicy ? {
        posture: c.automationPolicy.posture,
        protected: c.automationPolicy.protected,
        rateCapPct: c.automationPolicy.rateCapPct != null ? Number(c.automationPolicy.rateCapPct.toString()) : null,
        rateFloorPct: c.automationPolicy.rateFloorPct != null ? Number(c.automationPolicy.rateFloorPct.toString()) : null,
        bidCapCents: c.automationPolicy.bidCapCents,
        bidFloorCents: c.automationPolicy.bidFloorCents,
      } : null,
    },
    ads: c.ads.map((a) => ({
      id: a.id,
      listingId: a.listingId,
      inventoryReference: a.inventoryReference,
      adGroupId: a.adGroupId, // ER1
      hiddenReason: a.hiddenReason, // ER1 — OOS auto-hide surfaced as state
      productId: a.productId, // ER1 — deep link to Products
      status: a.status,
      bidPercentage: a.bidPercentage != null ? Number(a.bidPercentage.toString()) : null,
      createdVia: a.createdVia,
      title: a.listingId ? idx.get(a.listingId)?.title ?? null : null,
      priceCents: a.listingId && idx.get(a.listingId)?.price != null ? Math.round(Number(idx.get(a.listingId)!.price!.toString()) * 100) : null,
      quantity: a.listingId ? idx.get(a.listingId)?.quantity ?? null : null,
      listingEnded: a.listingId ? idx.get(a.listingId)?.endedAt != null : null,
      breakEvenAdRatePct: a.listingId && eco.get(a.listingId)?.breakEvenAdRatePct != null ? Number(eco.get(a.listingId)!.breakEvenAdRatePct!.toString()) : null,
      economicsStatus: a.listingId ? eco.get(a.listingId)?.dataStatus ?? null : null,
      metrics: a.listingId ? lf.get(a.listingId) ?? derive(zeroSums) : derive(zeroSums),
    })),
    adGroups: c.adGroups.map((g) => ({
      id: g.id,
      externalAdGroupId: g.externalAdGroupId,
      name: g.name,
      status: g.status,
      defaultBidCents: g.defaultBidCents,
    })),
    keywords: c.keywords.map((k) => ({
      id: k.id,
      adGroupId: k.adGroupId,
      adGroupName: groupsById.get(k.adGroupId)?.name ?? null,
      externalKeywordId: k.externalKeywordId,
      text: k.text,
      matchType: k.matchType,
      bidCents: k.bidCents,
      status: k.status,
      metrics: kf.get(k.externalKeywordId) ?? derive(zeroSums),
    })),
    negativeKeywords: c.negativeKeywords.map((n) => ({
      id: n.id,
      adGroupId: n.adGroupId, // ER1 — campaign-level (null) vs group-level split
      text: n.text,
      matchType: n.matchType,
      status: n.status,
    })),
    freshness: await freshness(),
  }
}
export type EbayCampaignDetail = NonNullable<Awaited<ReturnType<typeof ebayCampaignDetail>>>

/** GET /ebay-ads/actions — the eBay ad audit trail (CampaignAction), newest first, with each campaign named. */
export interface EbayActionsQuery { limit?: string; entityId?: string; before?: string; actionType?: string }
export async function ebayAdsActions(q: EbayActionsQuery) {
  const rows = await prisma.campaignAction.findMany({
    where: {
      channel: 'EBAY',
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.actionType ? { actionType: q.actionType } : {}), // ER3.4
      ...(q.before && !Number.isNaN(Date.parse(q.before)) ? { createdAt: { lt: new Date(q.before) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(q.limit ?? 50), 200),
  })
  // ER3.4 Change Log — additive per-row fields: campaign name/id resolution
  // (eBay audit rows are CAMPAIGN-grain, entityId = externalCampaignId) and
  // the H10 change-source classification, derived from RECORDED actors:
  // drift-Accept rows carry _mode='accept' (the change originated on eBay).
  const extIds = [...new Set(rows.filter((a) => a.entityType === 'CAMPAIGN').map((a) => a.entityId))]
  const camps = extIds.length
    ? await prisma.ebayCampaign.findMany({ where: { externalCampaignId: { in: extIds } }, select: { id: true, externalCampaignId: true, name: true } })
    : []
  const campBy = new Map(camps.map((c) => [c.externalCampaignId, c]))
  const actions = rows.map((a) => {
    const mode = String((a.payloadAfter as { _mode?: string } | null)?._mode ?? '')
    const c = a.entityType === 'CAMPAIGN' ? campBy.get(a.entityId) : undefined
    return {
      ...a,
      campaignId: c?.id ?? null,
      campaignName: c?.name ?? null,
      source: mode === 'accept' ? 'external_accepted' : a.userId === 'automation:ebay-ads' ? 'automation' : 'operator',
    }
  })
  return { actions }
}

// ── For the tools: accounts, currencies, freshness ──────────────────────────────────────────────────

export interface EbayCampaignAccount {
  /** The ChannelConnection the campaign belongs to: every write for it must go to this account (P4.5a). */
  connectionId: string
  /** The operator's own name for the account, else eBay's. */
  name: string | null
  active: boolean
}

/** Each campaign's own eBay account, by Nexus campaign id. Never "the primary": the campaign names its account. */
export async function ebayCampaignAccounts(campaignIds: string[]): Promise<Map<string, EbayCampaignAccount>> {
  const ids = [...new Set(campaignIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const rows = await prisma.ebayCampaign.findMany({
    where: { id: { in: ids } },
    select: { id: true, channelConnectionId: true, channelConnection: { select: { accountLabel: true, displayName: true, isActive: true } } },
  })
  return new Map(rows.map((c) => [c.id, {
    connectionId: c.channelConnectionId,
    name: c.channelConnection?.accountLabel ?? c.channelConnection?.displayName ?? null,
    active: c.channelConnection?.isActive ?? false,
  }]))
}

/** The rules' pending eBay proposals, newest first (what GET /ebay-ads/automation/proposals lists by default). */
export async function ebayPendingProposals(take = 200) {
  return prisma.ebayAdsProposal.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, take })
}

/**
 * Every eBay campaign's name, market, status, funding model, budget currency and account: what the overview counts per
 * market, and which campaigns ebay-ad-details opens.
 */
export async function ebayCampaignCensus(marketplace?: string) {
  return prisma.ebayCampaign.findMany({
    where: marketplace ? { marketplace } : {},
    select: { id: true, externalCampaignId: true, name: true, marketplace: true, status: true, fundingModel: true, budgetCurrency: true, channelConnectionId: true },
  })
}

/** The currency each market's performance rows are reported in (the newest row's), by marketplace. */
export async function ebayMarketCurrencies(): Promise<Map<string, string>> {
  const rows = await prisma.ebayAdsDailyPerformance.groupBy({
    by: ['marketplace', 'currency'],
    where: { entityType: 'CAMPAIGN' },
    _max: { date: true },
  })
  const newest = new Map<string, { currency: string; at: number }>()
  for (const r of rows) {
    const at = r._max.date?.getTime() ?? 0
    const seen = newest.get(r.marketplace)
    if (!seen || at > seen.at) newest.set(r.marketplace, { currency: r.currency, at })
  }
  return new Map([...newest].map(([market, { currency }]) => [market, currency]))
}

/** The newest day of campaign performance, overall or for one market (YYYY-MM-DD), or null when there is none. */
export async function ebayPerformanceAsOf(marketplace?: string): Promise<string | null> {
  const agg = await prisma.ebayAdsDailyPerformance.aggregate({
    where: { entityType: 'CAMPAIGN', ...(marketplace ? { marketplace } : {}) },
    _max: { date: true },
  })
  return agg._max.date ? agg._max.date.toISOString().slice(0, 10) : null
}
