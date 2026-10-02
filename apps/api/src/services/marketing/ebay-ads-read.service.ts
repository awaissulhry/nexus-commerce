/**
 * MCP full control A13 (docs/mcp-full-control/sections/01-ads.md §4, §6 step 13) — the eBay Promoted Listings reads,
 * moved out of `routes/ebay-ads.routes.ts` WITHOUT a behaviour change, so the console's routes and Claude's ad read
 * tools share one code path:
 *
 *   ebayAdsSummary     GET /ebay-ads/summary    — KPIs for a window and the window before it
 *   ebayAdsTrend       GET /ebay-ads/trend      — the account's daily points
 *   ebayAdsCampaigns   GET /ebay-ads/campaigns  — the campaign grid
 *   ebayAdsActions     GET /ebay-ads/actions    — the audit trail (moved with the eBay gap of ad-changes)
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
import { resolveRange, priorRange, bucketFor, type ResolvedRange } from '../ads-core/date-range.js'
import { EBAY_MANAGED_STATUSES } from '../ads-core/campaign-status.js'

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
  const p = priorRange(r)
  const [cur, prev, campaigns, economics, fr, liveCount, promotedRows] = await Promise.all([
    prisma.ebayAdsDailyPerformance.aggregate({ where: factWhere(q, r, 'CAMPAIGN'), _sum: sumFields }),
    prisma.ebayAdsDailyPerformance.aggregate({ where: factWhere(q, p, 'CAMPAIGN'), _sum: sumFields }),
    prisma.ebayCampaign.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } }),
    freshness(),
    prisma.ebayListingIndex.count({ where: { endedAt: null } }),
    prisma.ebayAd.findMany({ where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: [...EBAY_MANAGED_STATUSES] } } }, select: { listingId: true }, distinct: ['listingId'] }),
  ])
  const current = derive(toSums(cur))
  const prior = derive(toSums(prev))
  const deltaPct = (c: number, pr: number) => (pr > 0 ? ((c - pr) / pr) * 100 : null)
  return {
    window: { preset: r.preset, since: r.sinceStr, until: r.untilStr, days: r.days, includesToday: r.includesToday },
    currency: 'EUR',
    current,
    prior,
    deltas: {
      adFeesPct: deltaPct(current.adFeesCents, prior.adFeesCents),
      salesPct: deltaPct(current.salesCents, prior.salesCents),
      clicksPct: deltaPct(current.clicks, prior.clicks),
      impressionsPct: deltaPct(current.impressions, prior.impressions),
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
  const rows = await prisma.ebayAdsDailyPerformance.groupBy({
    by: ['date'],
    where: factWhere(q, r, 'CAMPAIGN'),
    _sum: sumFields,
    orderBy: { date: 'asc' },
  })
  return {
    window: { since: r.sinceStr, until: r.untilStr, bucket: bucketFor(r.days) },
    currency: 'EUR',
    points: rows.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      ...derive(toSums(row)),
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
    currency: 'EUR',
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

/** Every eBay campaign's market, status, budget currency and account: what the overview counts per market. */
export async function ebayCampaignCensus(marketplace?: string) {
  return prisma.ebayCampaign.findMany({
    where: marketplace ? { marketplace } : {},
    select: { id: true, externalCampaignId: true, marketplace: true, status: true, budgetCurrency: true, channelConnectionId: true },
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
