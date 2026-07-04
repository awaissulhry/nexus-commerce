/**
 * E3 (eBay Ads) — read/analytics API for the eBay console at
 * /marketing/ads/ebay. READ-ONLY (writes are E4). RBAC: the /api/ebay-ads
 * prefix is already mapped in permissions-manifest.ts (reads → ads.view,
 * writes → ads.campaigns.manage).
 *
 * Conventions: money as integer cents + currency code (client formats);
 * every payload carries `freshness` timestamps — panels must say "as of".
 * Date windows resolve through ads-core (Rome-anchored presets +
 * priorRange comparisons).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { resolveRange, priorRange, bucketFor, type ResolvedRange } from '../services/ads-core/date-range.js'
import * as writes from '../services/marketing/ebay-ads-write.service.js'
import { exportAdsCsv, parseAdsOpsCsv, diffOps, applyOps } from '../services/marketing/ebay-ads-csv.service.js'
import { getLiveEbayItemIds } from '../services/marketing/ebay-listing-index.service.js'
import { rebuildEbayListingEconomics } from '../services/ads-core/ebay-margin.js'
import { BUILDER_TEMPLATES, buildListingPlan, mineKeywordSeeds, suggestBudgetLocal, suggestName } from '../services/marketing/ebay-ads-builder.service.js'
import { getActiveEbayAdsAuth, suggestMaxCpcApi, suggestKeywordsApi, suggestBidsApi, suggestBudgetApi } from '../services/marketing/ebay-ads-api.service.js'

const SHORT_BY_MKT: Record<string, string> = { EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES', EBAY_GB: 'UK' }

interface WindowQuery { preset?: string; startDate?: string; endDate?: string; marketplace?: string }

function factWhere(q: WindowQuery, r: ResolvedRange, entityType?: string) {
  return {
    ...(entityType ? { entityType } : {}),
    ...(q.marketplace && q.marketplace !== 'all' ? { marketplace: q.marketplace } : {}),
    date: { gte: r.since, lte: r.until },
  }
}

const sumFields = { impressions: true, clicks: true, adFeesCents: true, salesCents: true, soldQty: true } as const

type Sums = { impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }
const zeroSums: Sums = { impressions: 0, clicks: 0, adFeesCents: 0, salesCents: 0, soldQty: 0 }

function toSums(agg: { _sum: Partial<Record<keyof Sums, number | null>> }): Sums {
  return {
    impressions: agg._sum.impressions ?? 0,
    clicks: agg._sum.clicks ?? 0,
    adFeesCents: agg._sum.adFeesCents ?? 0,
    salesCents: agg._sum.salesCents ?? 0,
    soldQty: agg._sum.soldQty ?? 0,
  }
}

function derive(s: Sums) {
  return {
    ...s,
    ctrPct: s.impressions > 0 ? (s.clicks / s.impressions) * 100 : null,
    // eBay ACOS = ad fees ÷ ATTRIBUTED (any-click) sales — labeled in UI.
    acosPct: s.salesCents > 0 ? (s.adFeesCents / s.salesCents) * 100 : null,
    avgCpcCents: s.clicks > 0 ? Math.round(s.adFeesCents / s.clicks) : null,
  }
}

async function freshness() {
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

const ebayAdsRoutes: FastifyPluginAsync = async (app) => {
  // ── Summary KPIs (+ vs-previous-period deltas) ─────────────────────────
  app.get<{ Querystring: WindowQuery }>('/ebay-ads/summary', async (req) => {
    const r = resolveRange(req.query)
    const p = priorRange(r)
    const [cur, prev, campaigns, economics, fr, liveCount, promotedRows] = await Promise.all([
      prisma.ebayAdsDailyPerformance.aggregate({ where: factWhere(req.query, r, 'CAMPAIGN'), _sum: sumFields }),
      prisma.ebayAdsDailyPerformance.aggregate({ where: factWhere(req.query, p, 'CAMPAIGN'), _sum: sumFields }),
      prisma.ebayCampaign.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } }),
      freshness(),
      prisma.ebayListingIndex.count({ where: { endedAt: null } }),
      prisma.ebayAd.findMany({ where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: ['RUNNING', 'PAUSED'] } } }, select: { listingId: true }, distinct: ['listingId'] }),
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
  })

  // ── Daily trend (account level = derived campaign grain summed) ────────
  app.get<{ Querystring: WindowQuery }>('/ebay-ads/trend', async (req) => {
    const r = resolveRange(req.query)
    const rows = await prisma.ebayAdsDailyPerformance.groupBy({
      by: ['date'],
      where: factWhere(req.query, r, 'CAMPAIGN'),
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
  })

  // ── Campaign grid ───────────────────────────────────────────────────────
  app.get<{ Querystring: WindowQuery }>('/ebay-ads/campaigns', async (req) => {
    const r = resolveRange(req.query)
    const yday = new Date(); yday.setUTCDate(yday.getUTCDate() - 1); yday.setUTCHours(0, 0, 0, 0)
    const [camps, facts, adCounts, hiddenCounts, policies, allRules, ydayFacts] = await Promise.all([
      prisma.ebayCampaign.findMany({
        where: req.query.marketplace && req.query.marketplace !== 'all' ? { marketplace: req.query.marketplace } : {},
        orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      }),
      prisma.ebayAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: factWhere(req.query, r, 'CAMPAIGN'),
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
  })

  // ER3.1 — manual entity sync (the header's Data Sync button)
  app.post('/ebay-ads/sync', async () => {
    const { syncEbayAdsEntities } = await import('../services/marketing/ebay-ads-entity-sync.service.js')
    const report = await syncEbayAdsEntities()
    return { ok: true, report }
  })

  // ── Campaign detail ─────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: WindowQuery }>('/ebay-ads/campaigns/:id', async (req, reply) => {
    const c = await prisma.ebayCampaign.findUnique({
      where: { id: req.params.id },
      include: {
        ads: { orderBy: { updatedAt: 'desc' } },
        adGroups: { orderBy: { name: 'asc' } },
        keywords: { orderBy: { text: 'asc' } },
        negativeKeywords: { orderBy: { text: 'asc' } },
        automationPolicy: true, // ER1
      },
    })
    if (!c) return reply.code(404).send({ error: 'campaign not found' })
    const r = resolveRange(req.query)
    const short = SHORT_BY_MKT[c.marketplace] ?? 'IT'
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
  })

  // ── ER1: ad-group drill-down ────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: WindowQuery }>('/ebay-ads/ad-groups/:id', async (req, reply) => {
    const g = await prisma.ebayAdGroup.findUnique({
      where: { id: req.params.id },
      include: { campaign: { select: { id: true, externalCampaignId: true, name: true, marketplace: true, fundingModel: true, campaignTargetingType: true, status: true, budgetCurrency: true } } },
    })
    if (!g) return reply.code(404).send({ error: 'ad group not found' })
    const r = resolveRange(req.query)
    const short = SHORT_BY_MKT[g.campaign.marketplace] ?? 'IT'
    const [ads, keywords, negatives] = await Promise.all([
      prisma.ebayAd.findMany({ where: { adGroupId: g.id }, orderBy: { updatedAt: 'desc' } }),
      prisma.ebayKeyword.findMany({ where: { adGroupId: g.id }, orderBy: { text: 'asc' } }),
      prisma.ebayNegativeKeyword.findMany({ where: { adGroupId: g.id }, orderBy: { text: 'asc' } }),
    ])
    const listingIds = ads.map((a) => a.listingId).filter((x): x is string => !!x)
    const [listingFacts, keywordFacts, index] = await Promise.all([
      prisma.ebayAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'LISTING', entityId: { in: listingIds.length ? listingIds : ['−'] }, date: { gte: r.since, lte: r.until } }, _sum: sumFields }),
      prisma.ebayAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'KEYWORD', entityId: { in: keywords.length ? keywords.map((k) => k.externalKeywordId) : ['−'] }, date: { gte: r.since, lte: r.until } }, _sum: sumFields }),
      prisma.ebayListingIndex.findMany({ where: { marketplace: short, itemId: { in: listingIds.length ? listingIds : ['−'] } }, select: { itemId: true, title: true, price: true, quantity: true } }),
    ])
    const lf = new Map(listingFacts.map((f) => [f.entityId, derive(toSums(f))]))
    const kf = new Map(keywordFacts.map((f) => [f.entityId, derive(toSums(f))]))
    const idx = new Map(index.map((i) => [i.itemId, i]))
    return {
      window: { preset: r.preset, since: r.sinceStr, until: r.untilStr },
      currency: g.campaign.budgetCurrency ?? 'EUR',
      adGroup: { id: g.id, externalAdGroupId: g.externalAdGroupId, name: g.name, status: g.status, defaultBidCents: g.defaultBidCents },
      campaign: { id: g.campaign.id, externalCampaignId: g.campaign.externalCampaignId, name: g.campaign.name, marketplace: g.campaign.marketplace, fundingModel: g.campaign.fundingModel ?? 'COST_PER_CLICK', targetingType: g.campaign.campaignTargetingType, status: g.campaign.status },
      ads: ads.map((a) => ({
        id: a.id, listingId: a.listingId, status: a.status, hiddenReason: a.hiddenReason, productId: a.productId,
        bidPercentage: a.bidPercentage != null ? Number(a.bidPercentage.toString()) : null,
        title: a.listingId ? idx.get(a.listingId)?.title ?? null : null,
        priceCents: a.listingId && idx.get(a.listingId)?.price != null ? Math.round(Number(idx.get(a.listingId)!.price!.toString()) * 100) : null,
        quantity: a.listingId ? idx.get(a.listingId)?.quantity ?? null : null,
        metrics: a.listingId ? lf.get(a.listingId) ?? derive(zeroSums) : derive(zeroSums),
      })),
      keywords: keywords.map((k) => ({
        id: k.id, adGroupId: k.adGroupId, adGroupName: g.name, externalKeywordId: k.externalKeywordId,
        text: k.text, matchType: k.matchType, bidCents: k.bidCents, status: k.status,
        metrics: kf.get(k.externalKeywordId) ?? derive(zeroSums),
      })),
      negativeKeywords: negatives.map((n) => ({ id: n.id, adGroupId: n.adGroupId, text: n.text, matchType: n.matchType, status: n.status })),
      freshness: await freshness(),
    }
  })

  // ── Product rollups (+ unmatched listings) ──────────────────────────────
  app.get<{ Querystring: WindowQuery }>('/ebay-ads/products', async (req) => {
    const r = resolveRange(req.query)
    const short = req.query.marketplace && req.query.marketplace !== 'all' ? SHORT_BY_MKT[req.query.marketplace] : undefined
    const [listings, listingFacts, economics, adRows] = await Promise.all([
      prisma.ebayListingIndex.findMany({
        where: { endedAt: null, ...(short ? { marketplace: short } : {}) },
        select: { itemId: true, marketplace: true, title: true, price: true, currency: true, quantity: true, productIds: true, matchStatus: true, categoryId: true, imageUrl: true },
      }),
      prisma.ebayAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'LISTING', date: { gte: r.since, lte: r.until } },
        _sum: sumFields,
      }),
      prisma.ebayListingEconomics.findMany({ select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }),
      // ER3.4 — promoted-state: which active campaigns carry each listing (+
      // eBay's OOS auto-hide flag at the ad level)
      prisma.ebayAd.findMany({
        where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { status: { in: ['RUNNING', 'PAUSED'] } } },
        select: { listingId: true, hiddenReason: true, campaign: { select: { id: true, name: true, fundingModel: true } } },
      }),
    ])
    const lf = new Map(listingFacts.map((f) => [f.entityId, derive(toSums(f))]))
    const eco = new Map(economics.map((e) => [e.itemId, e]))
    const promoBy = new Map<string, Array<{ id: string; name: string; fundingModel: string; adHidden: boolean }>>()
    for (const a of adRows) {
      const arr = promoBy.get(a.listingId!) ?? []
      arr.push({ id: a.campaign.id, name: a.campaign.name, fundingModel: a.campaign.fundingModel, adHidden: a.hiddenReason != null })
      promoBy.set(a.listingId!, arr)
    }

    const productIds = [...new Set(listings.flatMap((l) => l.productIds))]
    const [products, mainImages] = productIds.length
      ? await Promise.all([
          prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true, costPrice: true } }),
          prisma.productImage.findMany({ where: { productId: { in: productIds }, type: 'MAIN' }, orderBy: { sortOrder: 'asc' }, select: { productId: true, url: true } }),
        ])
      : [[], []]
    const pById = new Map(products.map((p) => [p.id, p]))
    const mainBy = new Map<string, string>()
    for (const m of mainImages) if (!mainBy.has(m.productId)) mainBy.set(m.productId, m.url) // EV2

    const listingRow = (l: (typeof listings)[number]) => ({
      itemId: l.itemId,
      marketplace: l.marketplace,
      title: l.title,
      priceCents: l.price != null ? Math.round(Number(l.price.toString()) * 100) : null,
      currency: l.currency ?? 'EUR',
      quantity: l.quantity,
      matchStatus: l.matchStatus,
      imageUrl: l.imageUrl ?? (l.productIds[0] ? mainBy.get(l.productIds[0]) ?? null : null), // EV2
      breakEvenAdRatePct: eco.get(l.itemId)?.breakEvenAdRatePct != null ? Number(eco.get(l.itemId)!.breakEvenAdRatePct!.toString()) : null,
      economicsStatus: eco.get(l.itemId)?.dataStatus ?? null,
      campaigns: promoBy.get(l.itemId) ?? [],
      metrics: lf.get(l.itemId) ?? derive(zeroSums),
    })

    // ONE row per listing, grouped under its primary product — a listing
    // matched to N variant products must not appear N times (duplicated rows
    // double-count the totals; caught on prod 2026-07-03).
    const byProduct = new Map<string, ReturnType<typeof listingRow>[]>()
    const unmatched: ReturnType<typeof listingRow>[] = []
    for (const l of listings) {
      const row = listingRow(l)
      if (l.productIds.length === 0) { unmatched.push(row); continue }
      const pid = l.productIds[0]!
      const arr = byProduct.get(pid) ?? []
      arr.push(row)
      byProduct.set(pid, arr)
    }
    const sumRows = (rows: ReturnType<typeof listingRow>[]): Sums =>
      rows.reduce<Sums>((acc, row) => ({
        impressions: acc.impressions + row.metrics.impressions,
        clicks: acc.clicks + row.metrics.clicks,
        adFeesCents: acc.adFeesCents + row.metrics.adFeesCents,
        salesCents: acc.salesCents + row.metrics.salesCents,
        soldQty: acc.soldQty + row.metrics.soldQty,
      }), { ...zeroSums })

    return {
      window: { preset: r.preset, since: r.sinceStr, until: r.untilStr },
      currency: 'EUR',
      products: [...byProduct.entries()].map(([pid, rows]) => ({
        productId: pid,
        sku: pById.get(pid)?.sku ?? null,
        name: pById.get(pid)?.name ?? null,
        hasCost: pById.get(pid)?.costPrice != null,
        costPriceCents: pById.get(pid)?.costPrice != null ? Math.round(Number(pById.get(pid)!.costPrice!.toString()) * 100) : null,
        listings: rows,
        metrics: derive(sumRows(rows)),
      })).sort((a, b) => b.metrics.adFeesCents - a.metrics.adFeesCents),
      unmatchedListings: unmatched.sort((a, b) => b.metrics.impressions - a.metrics.impressions),
      freshness: await freshness(),
    }
  })

  // ── Match queue + cost entry (activates the margin engine) ─────────────
  // Suggestions score catalog products by rarity-weighted token overlap with
  // the listing title — suggestions only; the OPERATOR confirms identity.
  app.get<{ Querystring: { itemId: string; marketplace: string; q?: string } }>('/ebay-ads/products/match-candidates', async (req, reply) => {
    const idx = await prisma.ebayListingIndex.findFirst({ where: { itemId: req.query.itemId, marketplace: req.query.marketplace }, select: { title: true } })
    if (!idx) return reply.code(404).send({ error: 'listing not indexed' })
    const q = (req.query.q ?? '').trim()
    const pool = await prisma.product.findMany({
      where: { deletedAt: null, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { sku: { contains: q, mode: 'insensitive' } }] } : {}) },
      select: { id: true, sku: true, name: true, costPrice: true },
      ...(q ? { take: 30, orderBy: { sku: 'asc' } } : {}),
    })
    if (q) return { candidates: pool.map((p) => ({ id: p.id, sku: p.sku, name: p.name, costPriceCents: p.costPrice != null ? Math.round(Number(p.costPrice.toString()) * 100) : null, suggested: false })) }
    const tokens = (s: string) => [...new Set(s.toLowerCase().normalize('NFD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 3))]
    const titleToks = new Set(tokens(idx.title ?? ''))
    const freq = new Map<string, number>()
    const prodToks = pool.map((p) => {
      const ts = tokens(`${p.name} ${p.sku}`)
      for (const t of ts) freq.set(t, (freq.get(t) ?? 0) + 1)
      return ts
    })
    const scored = pool.map((p, i) => {
      let score = 0
      for (const t of prodToks[i]!) if (titleToks.has(t)) score += 1 / Math.sqrt(freq.get(t) ?? 1)
      return { p, score }
    }).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.p.sku.length - b.p.sku.length)
      .slice(0, 8)
    return { candidates: scored.map(({ p, score }) => ({ id: p.id, sku: p.sku, name: p.name, costPriceCents: p.costPrice != null ? Math.round(Number(p.costPrice.toString()) * 100) : null, suggested: true, score: Math.round(score * 100) / 100 })) }
  })

  app.post<{ Body: { itemId: string; marketplace: string; productId: string | null } }>('/ebay-ads/products/match', async (req, reply) => {
    const { itemId, marketplace, productId } = req.body
    const idx = await prisma.ebayListingIndex.findUnique({ where: { marketplace_itemId: { marketplace, itemId } }, select: { productIds: true } })
    if (!idx) return reply.code(404).send({ error: 'listing not indexed' })
    if (productId) {
      const p = await prisma.product.findUnique({ where: { id: productId }, select: { deletedAt: true } })
      if (!p || p.deletedAt) return reply.code(400).send({ error: 'product not found (or deleted)' })
    }
    await prisma.ebayListingIndex.update({
      where: { marketplace_itemId: { marketplace, itemId } },
      data: productId ? { productIds: [productId], matchStatus: 'MANUAL' } : { productIds: [], matchStatus: 'UNMATCHED' },
    })
    await prisma.campaignAction.create({
      data: {
        userId: (req as { authUser?: { id?: string } }).authUser?.id ?? null, channel: 'EBAY', actionType: 'match_listing', entityType: 'LISTING', entityId: itemId,
        payloadBefore: { productIds: idx.productIds }, payloadAfter: { productIds: productId ? [productId] : [], _mode: 'local' } as object, channelResponseStatus: 'SUCCESS',
      },
    }).catch(() => {})
    await rebuildEbayListingEconomics()
    const eco = await prisma.ebayListingEconomics.findUnique({ where: { marketplace_itemId: { marketplace, itemId } } })
    return { ok: true, matchStatus: productId ? 'MANUAL' : 'UNMATCHED', economicsStatus: eco?.dataStatus ?? null, breakEvenAdRatePct: eco?.breakEvenAdRatePct != null ? Number(eco.breakEvenAdRatePct.toString()) : null }
  })

  // Sets Product.costPrice (the canonical cost field) on the listing's
  // matched product(s) — per-variant refinement stays in the product editor.
  app.post<{ Body: { itemId: string; marketplace: string; costEur: number } }>('/ebay-ads/products/cost', async (req, reply) => {
    const { itemId, marketplace, costEur } = req.body
    if (!Number.isFinite(costEur) || costEur <= 0 || costEur > 100000) return reply.code(400).send({ error: 'costEur must be a positive number' })
    const idx = await prisma.ebayListingIndex.findUnique({ where: { marketplace_itemId: { marketplace, itemId } }, select: { productIds: true } })
    if (!idx) return reply.code(404).send({ error: 'listing not indexed' })
    if (!idx.productIds.length) return reply.code(400).send({ error: 'match the listing to a product first' })
    const products = await prisma.product.findMany({ where: { id: { in: idx.productIds } }, select: { id: true, sku: true, costPrice: true } })
    await prisma.product.updateMany({ where: { id: { in: idx.productIds } }, data: { costPrice: costEur.toFixed(2) } })
    await prisma.campaignAction.create({
      data: {
        userId: (req as { authUser?: { id?: string } }).authUser?.id ?? null, channel: 'EBAY', actionType: 'set_product_cost', entityType: 'LISTING', entityId: itemId,
        payloadBefore: { costs: Object.fromEntries(products.map((p) => [p.sku, p.costPrice?.toString() ?? null])) },
        payloadAfter: { costEur, products: products.map((p) => p.sku), _mode: 'local' } as object, channelResponseStatus: 'SUCCESS',
      },
    }).catch(() => {})
    await rebuildEbayListingEconomics()
    const eco = await prisma.ebayListingEconomics.findUnique({ where: { marketplace_itemId: { marketplace, itemId } } })
    return { ok: true, updatedProducts: products.map((p) => p.sku), economicsStatus: eco?.dataStatus ?? null, breakEvenAdRatePct: eco?.breakEvenAdRatePct != null ? Number(eco.breakEvenAdRatePct.toString()) : null }
  })

  // ── Sync status (powers the "as of" panel) ──────────────────────────────
  app.get('/ebay-ads/status', async () => {
    const jobs = ['ebay-ads-entity-sync', 'ebay-listing-discovery', 'ebay-ads-report-schedule', 'ebay-ads-report-poll', 'ebay-ads-economics-rebuild']
    const runs = await Promise.all(jobs.map((jobName) =>
      prisma.cronRun.findFirst({ where: { jobName }, orderBy: { startedAt: 'desc' }, select: { jobName: true, status: true, startedAt: true, finishedAt: true, outputSummary: true } }),
    ))
    const [campaigns, ads, keywords, facts, tasks, indexCount] = await Promise.all([
      prisma.ebayCampaign.count(),
      prisma.ebayAd.count(),
      prisma.ebayKeyword.count(),
      prisma.ebayAdsDailyPerformance.count(),
      prisma.ebayAdsReportTask.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.ebayListingIndex.count({ where: { endedAt: null } }),
    ])
    return {
      crons: runs.filter(Boolean),
      counts: {
        campaigns, ads, keywords, facts, liveListings: indexCount,
        reportTasks: Object.fromEntries(tasks.map((t) => [t.status, t._count._all])),
      },
      freshness: await freshness(),
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // E4 — WRITES. POST → ads.campaigns.manage (manifest RW mapping). All ops
  // flow through the audited write service: gate → guardrails → mirror →
  // CampaignAction. Sandbox until NEXUS_MARKETING_WRITES_EBAY=1.
  // ═══════════════════════════════════════════════════════════════════════
  const actor = (req: { authUser?: { id?: string } }): writes.OpContext => ({ actorUserId: req.authUser?.id ?? null })

  app.get('/ebay-ads/write-mode', async () => ({ mode: writes.currentWriteMode(), gateEnv: 'NEXUS_MARKETING_WRITES_EBAY' }))

  // Product-first promote: resolve products → live item IDs → bulk-create ads
  app.post<{ Body: { productIds?: string[]; listingIds?: string[]; marketplace?: string; campaignId: string; defaultRatePct?: number; perListing?: Array<{ listingId: string; ratePct?: number }>; override?: { reason: string } } }>(
    '/ebay-ads/promote', async (req, reply) => {
      const b = req.body
      const short = ({ EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES' } as Record<string, string>)[b.marketplace ?? 'EBAY_IT']
      const resolved = new Map<string, string[]>() // listingId → productIds (provenance)
      for (const lid of b.listingIds ?? []) resolved.set(lid, [])
      for (const pid of b.productIds ?? []) {
        for (const hit of await getLiveEbayItemIds(pid, short)) {
          resolved.set(hit.itemId, [...(resolved.get(hit.itemId) ?? []), pid])
        }
      }
      if (resolved.size === 0) return reply.code(400).send({ error: 'nothing to promote — no live eBay listings resolved for the selection' })
      const rateBy = new Map((b.perListing ?? []).map((p) => [p.listingId, p.ratePct]))
      const items = [...resolved.keys()].map((listingId) => ({ listingId, ratePct: rateBy.get(listingId) ?? undefined }))
      const out = await writes.promoteListings(actor(req), { campaignId: b.campaignId, items, defaultRatePct: b.defaultRatePct, override: b.override })
      return { ...out, resolved: Object.fromEntries(resolved) }
    })

  // Rules preview (local approximation over the listing index, labeled as such)
  app.post<{ Body: { marketplace: string; selectionRules: Array<{ brands?: string[]; categoryIds?: string[]; minPrice?: number; maxPrice?: number }> } }>(
    '/ebay-ads/campaigns/preview-rules', async (req) => {
      const short = ({ EBAY_IT: 'IT', EBAY_DE: 'DE', EBAY_FR: 'FR', EBAY_ES: 'ES' } as Record<string, string>)[req.body.marketplace] ?? 'IT'
      const live = await prisma.ebayListingIndex.findMany({ where: { marketplace: short, endedAt: null } })
      const matches = live.filter((l) => req.body.selectionRules.some((r) => {
        if (r.categoryIds?.length && (!l.categoryId || !r.categoryIds.includes(l.categoryId))) return false
        const price = l.price != null ? Number(l.price.toString()) : null
        if (r.minPrice != null && (price == null || price < r.minPrice)) return false
        if (r.maxPrice != null && (price == null || price > r.maxPrice)) return false
        if (r.brands?.length) {
          const aspects = (l.aspects ?? {}) as Record<string, string[]>
          const brand = (aspects['Marca'] ?? aspects['Brand'] ?? [])[0]?.toLowerCase()
          if (!brand || !r.brands.some((x) => x.toLowerCase() === brand)) return false
        }
        return true
      }))
      return {
        note: 'local approximation over currently-indexed LIVE listings — eBay evaluates its own rules daily (incl. FUTURE listings when auto-select is on)',
        matched: matches.map((m) => ({ itemId: m.itemId, title: m.title, price: m.price, categoryId: m.categoryId })),
        totalLive: live.length,
      }
    })

  app.post<{ Body: writes.CreateCampaignInput }>('/ebay-ads/campaigns', async (req) =>
    writes.createCampaign(actor(req), req.body))

  app.post<{ Params: { id: string }; Body: { action: 'pause' | 'resume' | 'end' } }>('/ebay-ads/campaigns/:id/action', async (req) =>
    writes.campaignLifecycle(actor(req), req.params.id, req.body.action))

  app.post<{ Params: { id: string }; Body: { name: string } }>('/ebay-ads/campaigns/:id/clone', async (req) =>
    writes.cloneCampaign(actor(req), req.params.id, req.body.name))

  app.post<{ Params: { id: string }; Body: { adRateStrategy: 'FIXED' | 'DYNAMIC'; ratePct?: number; capPct?: number; adjustmentPct?: number } }>(
    '/ebay-ads/campaigns/:id/rate-strategy', async (req) => writes.updateRateStrategy(actor(req), req.params.id, req.body))

  app.post<{ Params: { id: string }; Body: { dailyBudgetCents: number } }>('/ebay-ads/campaigns/:id/budget', async (req) =>
    writes.updateBudget(actor(req), req.params.id, req.body.dailyBudgetCents))

  app.post<{ Params: { id: string }; Body: { items: Array<{ listingId: string; ratePct: number }>; override?: { reason: string } } }>(
    '/ebay-ads/campaigns/:id/ad-rates', async (req) => writes.setAdRates(actor(req), req.params.id, req.body.items, req.body.override))

  app.post<{ Params: { id: string }; Body: { listingIds: string[] } }>('/ebay-ads/campaigns/:id/ads/remove', async (req) =>
    writes.removeAds(actor(req), req.params.id, req.body.listingIds))

  app.post<{ Params: { id: string }; Body: { name: string; defaultBidCents?: number } }>('/ebay-ads/campaigns/:id/ad-groups', async (req) =>
    writes.createAdGroup(actor(req), req.params.id, req.body.name, req.body.defaultBidCents))

  app.post<{ Params: { id: string }; Body: { adGroupId: string; keywords: Array<{ text: string; matchType: string; bidCents?: number }> } }>(
    '/ebay-ads/campaigns/:id/keywords', async (req) => writes.addKeywords(actor(req), req.params.id, req.body.adGroupId, req.body.keywords))

  app.post<{ Params: { id: string }; Body: { updates: Array<{ keywordId: string; bidCents?: number; status?: 'ACTIVE' | 'PAUSED' }> } }>(
    '/ebay-ads/campaigns/:id/keywords/update', async (req) => writes.updateKeywords(actor(req), req.params.id, req.body.updates))

  app.post<{ Params: { id: string }; Body: { adGroupId: string; negatives: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }> } }>(
    '/ebay-ads/campaigns/:id/negatives', async (req) => writes.addNegatives(actor(req), req.params.id, req.body.adGroupId, req.body.negatives))

  // Suggestions (read-side; live eBay calls — sell.marketing verified)
  app.post<{ Body: Record<string, unknown> }>('/ebay-ads/suggest/max-cpc', async (req, reply) => {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) return reply.code(503).send({ error: 'no active eBay connection' })
    return suggestMaxCpcApi(auth.token, req.body)
  })
  app.post<{ Body: { campaignExternalId: string; adGroupExternalId: string; listingIds: string[] } }>('/ebay-ads/suggest/keywords', async (req, reply) => {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) return reply.code(503).send({ error: 'no active eBay connection' })
    return suggestKeywordsApi(auth.token, req.body.campaignExternalId, req.body.adGroupExternalId, req.body.listingIds)
  })
  app.post<{ Body: { campaignExternalId: string; adGroupExternalId: string; keywords: Array<{ keywordText: string; matchType: string }> } }>('/ebay-ads/suggest/bids', async (req, reply) => {
    const auth = await getActiveEbayAdsAuth()
    if (!auth) return reply.code(503).send({ error: 'no active eBay connection' })
    return suggestBidsApi(auth.token, req.body.campaignExternalId, req.body.adGroupExternalId, req.body.keywords)
  })

  // CSV round-trip
  app.get('/ebay-ads/export.csv', async (_req, reply) => {
    const csv = await exportAdsCsv()
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="ebay-ads-${new Date().toISOString().slice(0, 10)}.csv"`)
    return csv
  })
  app.post<{ Body: { csv: string; dryRun?: boolean } }>('/ebay-ads/import', async (req) => {
    const parsed = parseAdsOpsCsv(req.body.csv)
    const diff = await diffOps(parsed.ops)
    if (req.body.dryRun !== false) {
      return { dryRun: true, parseErrors: parsed.errors, diff, applied: null }
    }
    const valid = parsed.ops.filter((op) => !diff.find((d) => d.row === op.row)?.error)
    const applied = await applyOps(actor(req), valid)
    return { dryRun: false, parseErrors: parsed.errors, diff, applied }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // E5 — automation ('/automation' paths → ads.automation.manage) + digest
  // ═══════════════════════════════════════════════════════════════════════
  app.get('/ebay-ads/automation/state', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    const [state, ceilings] = await Promise.all([auto.getAutomationState(), auto.checkSpendCeilings()])
    return { state, ceilings }
  })
  app.post<{ Body: { globalMode?: 'OFF' | 'SUGGEST' | 'AUTO'; halted?: boolean; haltReason?: string } }>('/ebay-ads/automation/state', async (req) => {
    const b = req.body
    return prisma.marketingAutomationState.upsert({
      where: { channel: 'EBAY' },
      create: { channel: 'EBAY', globalMode: b.globalMode ?? 'OFF', halted: b.halted ?? false, haltReason: b.haltReason ?? null, haltedBy: b.halted ? (req as { authUser?: { id?: string } }).authUser?.id ?? 'operator' : null },
      update: { ...(b.globalMode ? { globalMode: b.globalMode } : {}), ...(b.halted !== undefined ? { halted: b.halted, haltReason: b.halted ? b.haltReason ?? 'operator halt' : null, haltedBy: b.halted ? (req as { authUser?: { id?: string } }).authUser?.id ?? 'operator' : null } : {}) },
    })
  })
  app.post<{ Body: { marketplace: string; monthlyCapCents: number; killSwitch?: boolean } }>('/ebay-ads/automation/ceilings', async (req) => {
    return prisma.marketingSpendCeiling.upsert({
      where: { channel_marketplace: { channel: 'EBAY', marketplace: req.body.marketplace } },
      create: { channel: 'EBAY', marketplace: req.body.marketplace, monthlyCapCents: req.body.monthlyCapCents, killSwitch: req.body.killSwitch ?? false },
      update: { monthlyCapCents: req.body.monthlyCapCents, ...(req.body.killSwitch !== undefined ? { killSwitch: req.body.killSwitch } : {}) },
    })
  })
  app.get('/ebay-ads/automation/rules', async () => ({
    rules: await prisma.ebayAdsRule.findMany({ orderBy: { name: 'asc' }, include: { executions: { orderBy: { createdAt: 'desc' }, take: 1 } } }),
  }))
  // ER3.2 — starter archetypes as editor templates (single source: the service).
  app.get('/ebay-ads/automation/rules/templates', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { templates: auto.STARTER_RULES }
  })
  app.get<{ Params: { id: string } }>('/ebay-ads/automation/rules/:id', async (req, reply) => {
    const rule = await prisma.ebayAdsRule.findUnique({ where: { id: req.params.id }, include: { executions: { orderBy: { createdAt: 'desc' }, take: 10 } } })
    if (!rule) return reply.code(404).send({ error: 'rule not found' })
    return rule
  })
  app.post<{ Body: { name: string; trigger: unknown; action: unknown; guardrails?: unknown; scope?: unknown; marketplace?: string | null; cooldownHours?: number } }>('/ebay-ads/automation/rules', async (req, reply) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    const errs = auto.validateRuleBody(req.body as Partial<import('../services/marketing/ebay-ads-automation.service.js').RuleBody>)
    if (errs.length) return reply.code(400).send({ error: errs.join(' · ') })
    const row = await prisma.ebayAdsRule.create({ data: {
      name: req.body.name.trim(), enabled: false, mode: 'PROPOSE',
      trigger: req.body.trigger as object, action: req.body.action as object,
      guardrails: (req.body.guardrails ?? undefined) as object | undefined, scope: (req.body.scope ?? undefined) as object | undefined,
      marketplace: req.body.marketplace ?? null, cooldownHours: req.body.cooldownHours ?? 24,
    } })
    await auto.snapshotRuleVersion(row.id, 1, auto.ruleConfigOf(row), (req as { authUser?: { id?: string } }).authUser?.id ?? null) // ER5
    return row
  })
  // ER3.2 — full edit: config fields validated against the merged rule; the
  // original enabled/mode toggles keep their exact semantics.
  app.post<{ Params: { id: string }; Body: { enabled?: boolean; mode?: 'PROPOSE' | 'AUTOPILOT'; name?: string; trigger?: unknown; action?: unknown; guardrails?: unknown; scope?: unknown; marketplace?: string | null; cooldownHours?: number } }>('/ebay-ads/automation/rules/:id', async (req, reply) => {
    const rule = await prisma.ebayAdsRule.findUnique({ where: { id: req.params.id } })
    if (!rule) return reply.code(404).send({ error: 'rule not found' })
    const b = req.body
    const touchesConfig = b.name !== undefined || b.trigger !== undefined || b.action !== undefined || b.guardrails !== undefined || b.scope !== undefined || b.marketplace !== undefined || b.cooldownHours !== undefined
    if (touchesConfig) {
      const auto = await import('../services/marketing/ebay-ads-automation.service.js')
      const merged = {
        name: b.name ?? rule.name,
        trigger: (b.trigger ?? rule.trigger) as import('../services/marketing/ebay-ads-automation.service.js').RuleTrigger,
        action: (b.action ?? rule.action) as import('../services/marketing/ebay-ads-automation.service.js').RuleAction,
        guardrails: (b.guardrails ?? rule.guardrails) as Record<string, unknown> | null,
        scope: (b.scope ?? rule.scope) as { campaignIds?: string[] } | null,
        marketplace: b.marketplace !== undefined ? b.marketplace : rule.marketplace,
        cooldownHours: b.cooldownHours ?? rule.cooldownHours,
      }
      const errs = auto.validateRuleBody(merged)
      if (errs.length) return reply.code(400).send({ error: errs.join(' · ') })
      // ER5 — version only REAL config changes (not no-op saves, not enabled/mode)
      const mergedCfg = { name: merged.name, marketplace: merged.marketplace ?? null, scope: merged.scope ?? null, trigger: merged.trigger, action: merged.action, guardrails: merged.guardrails ?? null, cooldownHours: merged.cooldownHours }
      if (auto.ruleConfigChanged(auto.ruleConfigOf(rule), mergedCfg)) {
        const next = rule.version + 1
        const updated = await prisma.ebayAdsRule.update({ where: { id: req.params.id }, data: {
          ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
          ...(b.mode ? { mode: b.mode } : {}),
          name: merged.name.trim(), trigger: merged.trigger as object, action: merged.action as object,
          guardrails: (merged.guardrails ?? undefined) as object | undefined, scope: (merged.scope ?? undefined) as object | undefined,
          marketplace: merged.marketplace, cooldownHours: merged.cooldownHours, version: next,
        } })
        await auto.snapshotRuleVersion(rule.id, next, mergedCfg, (req as { authUser?: { id?: string } }).authUser?.id ?? null)
        return updated
      }
    }
    return prisma.ebayAdsRule.update({ where: { id: req.params.id }, data: {
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(b.mode ? { mode: b.mode } : {}),
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.trigger !== undefined ? { trigger: b.trigger as object } : {}),
      ...(b.action !== undefined ? { action: b.action as object } : {}),
      ...(b.guardrails !== undefined ? { guardrails: b.guardrails as object } : {}),
      ...(b.scope !== undefined ? { scope: b.scope as object } : {}),
      ...(b.marketplace !== undefined ? { marketplace: b.marketplace } : {}),
      ...(b.cooldownHours !== undefined ? { cooldownHours: b.cooldownHours } : {}),
    } })
  })
  // ER5 — immutable config history (full snapshots; sentences render client-side)
  app.get<{ Params: { id: string } }>('/ebay-ads/automation/rules/:id/versions', async (req) => ({
    versions: await prisma.ebayAdsRuleVersion.findMany({ where: { ruleId: req.params.id }, orderBy: { version: 'desc' }, take: 50 }),
  }))
  app.post<{ Params: { id: string }; Body: { toVersion: number } }>('/ebay-ads/automation/rules/:id/revert', async (req, reply) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    try {
      return await auto.revertRuleToVersion((req as { authUser?: { id?: string } }).authUser?.id ?? null, req.params.id, req.body.toVersion)
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }) }
  })
  app.delete<{ Params: { id: string } }>('/ebay-ads/automation/rules/:id', async (req, reply) => {
    const rule = await prisma.ebayAdsRule.findUnique({ where: { id: req.params.id }, select: { id: true } })
    if (!rule) return reply.code(404).send({ error: 'rule not found' })
    await prisma.ebayAdsRule.delete({ where: { id: req.params.id } }) // executions cascade; proposals keep ruleId (history survives)
    return { ok: true }
  })
  // ER3.2 — dry-run an unsaved rule body: counts + first matches, zero writes.
  app.post<{ Body: unknown }>('/ebay-ads/automation/rules/preview', async (req, reply) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    try {
      return await auto.previewRule(req.body as import('../services/marketing/ebay-ads-automation.service.js').RuleBody)
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }) }
  })
  app.post<{ Body: { ruleId?: string } }>('/ebay-ads/automation/evaluate', async (req) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return auto.evaluateEbayAdsRules(req.body?.ruleId || undefined) // ER3.2 — per-rule Run now (service always supported it)
  })
  app.post('/ebay-ads/automation/presets/starter-pack', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return auto.installStarterRules()
  })
  app.get<{ Querystring: { status?: string } }>('/ebay-ads/automation/proposals', async (req) => ({
    proposals: await prisma.ebayAdsProposal.findMany({ where: { status: req.query.status ?? 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 200 }),
  }))
  app.post<{ Body: { ids: string[]; decision: 'approve' | 'reject'; snoozeDays?: number } }>('/ebay-ads/automation/proposals/decide', async (req) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { results: await auto.decideProposals((req as { authUser?: { id?: string } }).authUser?.id ?? null, req.body.ids, req.body.decision, req.body.snoozeDays) }
  })
  app.post<{ Params: { id: string } }>('/ebay-ads/automation/proposals/:id/rollback', async (req) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { detail: await auto.rollbackProposal((req as { authUser?: { id?: string } }).authUser?.id ?? null, req.params.id) }
  })
  app.get('/ebay-ads/automation/executions', async () => ({
    executions: await prisma.ebayAdsRuleExecution.findMany({ orderBy: { createdAt: 'desc' }, take: 50, include: { rule: { select: { name: true } } } }),
  }))
  app.get('/ebay-ads/automation/anomalies', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { anomalies: await auto.detectAnomalies() }
  })
  // ER3.3 — dashboard aggregate: Recommendations panel + budget pacing.
  app.get('/ebay-ads/dashboard', async () => {
    const dash = await import('../services/marketing/ebay-ads-dashboard.service.js')
    return dash.getEbayAdsDashboard()
  })
  app.get('/ebay-ads/digest/latest', async () => {
    const d = await prisma.ebayAdsDigest.findFirst({ orderBy: { weekStart: 'desc' } })
    return { digest: d }
  })
  app.get('/ebay-ads/digests', async () => ({ digests: await prisma.ebayAdsDigest.findMany({ orderBy: { weekStart: 'desc' }, take: 12, select: { id: true, weekStart: true, generatedAt: true, reviewedAt: true } }) }))
  // ER3.5 — one stored week by id (the picker's fetch; history renders what was true then)
  app.get<{ Params: { id: string } }>('/ebay-ads/digests/:id', async (req, reply) => {
    const digest = await prisma.ebayAdsDigest.findUnique({ where: { id: req.params.id } })
    if (!digest) return reply.code(404).send({ error: 'digest not found' })
    return { digest }
  })
  app.post('/ebay-ads/digest/generate', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return auto.generateWeeklyDigest()
  })
  app.post<{ Params: { id: string } }>('/ebay-ads/digest/:id/reviewed', async (req) => {
    return prisma.ebayAdsDigest.update({ where: { id: req.params.id }, data: { reviewedAt: new Date() } })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // E7 Stage 1 — goal-first builder: prefill (derive everything from a goal
  // card: scope, break-even-clamped rates, collision preflight, any-click
  // fee forecast) + launch (create → resolve collisions → promote → bind
  // scoped rule packs → timeline).
  // ═══════════════════════════════════════════════════════════════════════
  const GOAL_DEFS = BUILDER_TEMPLATES // ER2 — template registry lives in ebay-ads-builder.service

  // ═══ ER2 — builder v2: composable step endpoints (SPEC-campaign-builder §6.1) ═══

  // Template registry (chooser chips stay in sync with rule-pack defs)
  app.get('/ebay-ads/builder/templates', async () => ({ templates: Object.values(BUILDER_TEMPLATES) }))

  // Per-listing plan rows (economics + conflicts + trailing sales) — the
  // Listings/Rates steps' data. goalFactor comes from a template when one
  // was picked; the default matches the margin-protect posture.
  app.post<{ Body: { marketplace: string; listingIds?: string[]; productIds?: string[]; strategy: 'CPS' | 'CPC'; goalFactor?: number; fallbackRatePct?: number } }>('/ebay-ads/builder/listings', async (req, reply) => {
    if (req.body.marketplace === 'EBAY_ES' && req.body.strategy === 'CPC') return reply.code(400).send({ error: 'Priority is not available on eBay Spain' })
    const plan = await buildListingPlan(req.body)
    const name = await suggestName(null, req.body.strategy, req.body.marketplace, (req.body.listingIds?.length ?? 0) + (req.body.productIds?.length ?? 0) > 0)
    return { ...plan, suggestedName: name }
  })

  // Keyword seeds mined from OUR titles + aspects for the selected listings
  app.post<{ Body: { marketplace: string; listingIds?: string[] } }>('/ebay-ads/builder/seeds', async (req) => ({
    seeds: await mineKeywordSeeds(req.body.marketplace, req.body.listingIds ?? []),
  }))

  // Budget: our provenance formula + eBay's suggest_budget where it answers
  app.post<{ Body: { marketplace: string; listingIds?: string[] } }>('/ebay-ads/builder/budget-suggest', async (req) => {
    const local = await suggestBudgetLocal(req.body.marketplace, req.body.listingIds ?? [])
    let ebaySuggestedCents: number | null = null
    try {
      const auth = await getActiveEbayAdsAuth()
      if (auth) {
        const out = await suggestBudgetApi(auth.token, { marketplaceId: req.body.marketplace, fundingStrategy: 'COST_PER_CLICK' }) as { suggestedBudget?: { amount?: { value?: string } } }
        const v = out?.suggestedBudget?.amount?.value
        if (v != null) ebaySuggestedCents = Math.round(Number(v) * 100)
      }
    } catch { /* eBay suggest_budget is best-effort — the local formula always answers */ }
    return { ...local, ebaySuggestedCents }
  })

  app.post<{ Body: {
    goal: string; name: string; marketplace: string
    ratePct?: number; dailyBudgetCents?: number; maxCpcCents?: number; targetingType?: 'MANUAL' | 'SMART'
    endDate?: string | null
    startDate?: string | null // EV3 — scheduled start (YYYY-MM-DD); omit/blank = launch now
    attachAdGroupName?: string // EV3 — MANUAL Priority: which ad group receives the staged listings (default: first created)
    items: Array<{ listingId: string; ratePct?: number; resolution?: 'include' | 'skip' | 'move' }>
    keywords?: Array<{ text: string; matchType: string; bidCents?: number }>
    // ER2 additive fields (SPEC §6.1)
    criterion?: { autoSelectFutureInventory?: boolean; selectionRules: unknown[] }
    adRateStrategy?: 'FIXED' | 'DYNAMIC'
    dynamicCapPct?: number
    adGroups?: Array<{ name: string; defaultBidCents?: number; keywords: Array<{ text: string; matchType: string; bidCents?: number }>; negatives?: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }> }>
    rateDiscovery?: { floorPct: number; capPct: number; stepPct: number; dwellDays: number }
    rulePacks?: string[]
    override?: { reason: string }
  } }>('/ebay-ads/builder/launch', async (req, reply) => {
    const b = req.body
    const def = GOAL_DEFS[b.goal]
    if (!def) return reply.code(400).send({ error: 'unknown goal' })
    if (b.rateDiscovery) {
      const d = b.rateDiscovery
      if (!(d.floorPct >= 2 && d.capPct <= 100 && d.floorPct < d.capPct && d.stepPct > 0 && d.dwellDays >= 1)) {
        return reply.code(400).send({ error: 'rate discovery: need 2 ≤ floor < cap ≤ 100, step > 0, dwell ≥ 1 day' })
      }
      if (def.strategy !== 'CPS' || b.criterion) return reply.code(400).send({ error: 'rate discovery applies to key-based General campaigns' })
    }
    const ctx = actor(req)
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    const writesSvc = writes

    // 1. create the campaign (ER2: rules-based criterion + DYNAMIC supported)
    const created = await writesSvc.createCampaign(ctx, {
      name: b.name,
      marketplace: b.marketplace,
      fundingModel: def.strategy === 'CPS' ? 'COST_PER_SALE' : 'COST_PER_CLICK',
      ...(b.startDate ? { startDate: b.startDate } : {}), // EV3 — scheduled start
      ...(def.strategy === 'CPS'
        ? (b.adRateStrategy === 'DYNAMIC'
          ? { adRateStrategy: 'DYNAMIC' as const, dynamicCapPct: b.dynamicCapPct ?? 10, ratePct: b.ratePct ?? def.fallbackRatePct }
          : { adRateStrategy: 'FIXED' as const, ratePct: b.ratePct ?? def.fallbackRatePct })
        : { targetingType: b.targetingType ?? 'MANUAL', dailyBudgetCents: b.dailyBudgetCents ?? 500, ...(b.targetingType === 'SMART' ? { maxCpcCents: b.maxCpcCents ?? 40 } : {}) }),
      ...(b.criterion?.selectionRules?.length ? { selectionRules: b.criterion.selectionRules, autoSelectFutureInventory: b.criterion.autoSelectFutureInventory ?? false } : {}),
    })

    // ER2 finding-fix: v1 accepted endDate but never sent it — createCampaign
    // has no schedule field; set it post-create via identification.
    if (b.endDate) {
      await writesSvc.updateCampaignIdentification(ctx, created.campaignId, { endDate: b.endDate }).catch(() => {
        /* end-date set is best-effort at launch; editable on the Details tab */
      })
    }

    // 2. resolve collisions (move = remove from the old campaign first)
    const include = b.items.filter((i) => i.resolution !== 'skip')
    const moves = b.items.filter((i) => i.resolution === 'move')
    const moveResults: Array<{ listingId: string; ok: boolean; error?: string | null }> = []
    for (const m of moves) {
      const old = await prisma.ebayAd.findFirst({ where: { listingId: m.listingId, status: { notIn: ['STALE'] }, campaignId: { not: created.campaignId }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: ['RUNNING', 'PAUSED'] } } }, select: { campaignId: true } })
      if (!old) { moveResults.push({ listingId: m.listingId, ok: true }); continue }
      try {
        const r = await writesSvc.removeAds(ctx, old.campaignId, [m.listingId])
        moveResults.push({ listingId: m.listingId, ok: !!r.results[0]?.ok, error: r.results[0]?.error })
      } catch (e) { moveResults.push({ listingId: m.listingId, ok: false, error: (e as Error).message }) }
    }

    // 3. promote (CPS) — CPC campaigns attach listings via their own flows
    let promoteResults: unknown[] = []
    if (def.strategy === 'CPS' && include.length) {
      const out = await writesSvc.promoteListings(ctx, {
        campaignId: created.campaignId,
        items: include.map((i) => ({ listingId: i.listingId, ratePct: i.ratePct })),
        defaultRatePct: b.ratePct ?? def.fallbackRatePct,
        override: b.override,
      })
      promoteResults = out.results
    }

    // 3b. CPC structure — ER2: explicit ad groups (name + default bid +
    // keywords + negatives each); legacy single-list `keywords` still lands
    // in a Default group.
    let keywordResults: unknown[] = []
    const groupResults: Array<{ name: string; adGroupId?: string; keywords: number; negatives: number; error?: string }> = []
    if (def.strategy === 'CPC' && b.adGroups?.length) {
      for (const g of b.adGroups) {
        try {
          const grp = await writesSvc.createAdGroup(ctx, created.campaignId, g.name, g.defaultBidCents)
          let kwOk = 0, negOk = 0
          if (g.keywords.length) {
            const out = await writesSvc.addKeywords(ctx, created.campaignId, grp.adGroupId, g.keywords)
            kwOk = out.results.filter((r) => r.ok).length
            keywordResults = [...keywordResults, ...out.results]
          }
          if (g.negatives?.length) {
            const out = await writesSvc.addNegatives(ctx, created.campaignId, grp.adGroupId, g.negatives)
            negOk = out.results.filter((r) => r.ok).length
          }
          groupResults.push({ name: g.name, adGroupId: grp.adGroupId, keywords: kwOk, negatives: negOk })
        } catch (e) { groupResults.push({ name: g.name, keywords: 0, negatives: 0, error: (e as Error).message }) }
      }
    } else if (def.strategy === 'CPC' && b.keywords?.length) {
      const kws = b.keywords
      const grp = await writesSvc.createAdGroup(ctx, created.campaignId, 'Default', undefined)
      groupResults.push({ name: 'Default', adGroupId: grp.adGroupId, keywords: 0, negatives: 0 })
      const out = await writesSvc.addKeywords(ctx, created.campaignId, grp.adGroupId, kws)
      keywordResults = out.results
    }

    // 3b'. ER4 E4 — PRI listing-attach: included listings become ads. Smart
    // Priority attaches at campaign level; MANUAL attaches into the chosen
    // ad group (EV3: attachAdGroupName from the Review step; fallback = the
    // first created group). No group ⇒ honest error in the results instead
    // of silently dropping the listings.
    if (def.strategy === 'CPC' && include.length) {
      try {
        const campRow = await prisma.ebayCampaign.findUniqueOrThrow({ where: { id: created.campaignId }, select: { campaignTargetingType: true } })
        const firstGroupId = (b.attachAdGroupName ? groupResults.find((g) => g.adGroupId && g.name === b.attachAdGroupName)?.adGroupId : undefined)
          ?? groupResults.find((g) => g.adGroupId)?.adGroupId
        const out = await writesSvc.promoteListings(ctx, {
          campaignId: created.campaignId,
          items: include.map((i) => ({ listingId: i.listingId })),
          ...(campRow.campaignTargetingType === 'SMART' ? {} : { adGroupId: firstGroupId }),
        })
        promoteResults = out.results
      } catch (e) {
        promoteResults = include.map((i) => ({ key: i.listingId, ok: false, mode: 'skipped', error: (e as Error).message }))
      }
    }

    // 3c. ER2 — arm Rate Discovery (bounded ladder; evaluator walks it and
    // PROPOSEs each step; cap is additionally clamped per listing to
    // break-even at apply time).
    let rateDiscoveryArmed = false
    if (b.rateDiscovery && def.strategy === 'CPS') {
      await prisma.ebayRateDiscoveryPlan.create({
        data: {
          campaignId: created.campaignId,
          floorPct: b.rateDiscovery.floorPct.toFixed(1),
          capPct: b.rateDiscovery.capPct.toFixed(1),
          stepPct: b.rateDiscovery.stepPct.toFixed(1),
          dwellDays: Math.round(b.rateDiscovery.dwellDays),
        },
      })
      rateDiscoveryArmed = true
    }

    // 4. bind scoped rule packs (PROPOSE, disabled→enabled per pack)
    const bound: string[] = []
    for (const packName of b.rulePacks ?? []) {
      const starter = auto.STARTER_RULES.find((r) => r.name === packName)
      if (!starter) continue
      await prisma.ebayAdsRule.create({
        data: {
          name: `${packName} — ${b.name}`,
          enabled: true,
          mode: 'PROPOSE',
          marketplace: b.marketplace,
          scope: { campaignIds: [created.campaignId] } as object,
          trigger: starter.trigger as object,
          action: starter.action as object,
          guardrails: starter.guardrails as object,
          cooldownHours: starter.cooldownHours,
        },
      })
      bound.push(packName)
    }

    return {
      ok: true,
      mode: created.mode,
      campaignId: created.campaignId,
      externalCampaignId: created.externalCampaignId,
      moveResults,
      promoteResults,
      keywordResults,
      groupResults,
      rateDiscoveryArmed,
      rulePacksBound: bound,
      timeline: [
        'eBay reviews and starts serving ads (typically within hours)',
        def.strategy === 'CPS' ? 'Any-click attribution: fees appear on sales within 30 days of any ad click' : 'CPC clicks bill immediately; budget edits take effect next day',
        ...(b.criterion?.selectionRules?.length ? ['Rules-based selection: eBay re-evaluates matching listings daily' + (b.criterion.autoSelectFutureInventory ? ' — future listings enroll automatically' : '')] : []),
        ...(rateDiscoveryArmed ? [`Rate Discovery armed: ${b.rateDiscovery!.floorPct}% → ${b.rateDiscovery!.capPct}% in ${b.rateDiscovery!.stepPct}% steps, ${b.rateDiscovery!.dwellDays}-day windows — each step arrives as a proposal`] : []),
        `Rule packs (${bound.length}) evaluate daily at ~07:45 and PROPOSE changes for your approval`,
        'Check back in 7 days: impressions per listing, eBay ACOS vs break-even, stale ads',
      ],
    }
  })

  // Audit trail for the console's activity panels (immutable event log —
  // pass entityId=<externalCampaignId> for one campaign's history; `before`
  // = createdAt cursor for pagination — ER1)
  app.get<{ Querystring: { limit?: string; entityId?: string; before?: string; actionType?: string } }>('/ebay-ads/actions', async (req) => {
    const rows = await prisma.campaignAction.findMany({
      where: {
        channel: 'EBAY',
        ...(req.query.entityId ? { entityId: req.query.entityId } : {}),
        ...(req.query.actionType ? { actionType: req.query.actionType } : {}), // ER3.4
        ...(req.query.before && !Number.isNaN(Date.parse(req.query.before)) ? { createdAt: { lt: new Date(req.query.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 50), 200),
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
  })

  // ═══ ER1 — campaign detail v2 endpoints ═════════════════════════════════

  // Rename + end-date (eBay updateCampaignIdentification; guarded + audited)
  app.patch<{ Params: { id: string }; Body: { name?: string; endDate?: string | null } }>('/ebay-ads/campaigns/:id/identification', async (req) => {
    return writes.updateCampaignIdentification(actor(req), req.params.id, req.body)
  })

  // Per-campaign automation aggregate: policy + applicable rules + scoped
  // proposals / applied / drift — the Automation tab's single fetch.
  app.get<{ Params: { id: string } }>('/ebay-ads/campaigns/:id/automation', async (req, reply) => {
    const c = await prisma.ebayCampaign.findUnique({ where: { id: req.params.id }, include: { automationPolicy: true } })
    if (!c) return reply.code(404).send({ error: 'campaign not found' })
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    const [allRules, proposals, applied, drifts, state, discovery] = await Promise.all([
      prisma.ebayAdsRule.findMany({ orderBy: { name: 'asc' } }),
      prisma.ebayAdsProposal.findMany({ where: { status: 'PENDING', entityRef: { path: ['campaignId'], equals: c.id } }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.ebayAdsProposal.findMany({ where: { status: 'APPLIED', entityRef: { path: ['campaignId'], equals: c.id } }, orderBy: { decidedAt: 'desc' }, take: 20 }),
      auto.detectDrift(c.id),
      auto.getAutomationState(),
      prisma.ebayRateDiscoveryPlan.findUnique({ where: { campaignId: c.id } }), // ER2
    ])
    const rules = allRules
      .map((r0) => ({ id: r0.id, name: r0.name, enabled: r0.enabled, mode: r0.mode, marketplace: r0.marketplace, lastEvaluatedAt: r0.lastEvaluatedAt, scoped: (((r0.scope as { campaignIds?: string[] } | null)?.campaignIds) ?? []).includes(c.id), global: ((((r0.scope as { campaignIds?: string[] } | null)?.campaignIds) ?? []).length === 0) }))
      .filter((r0) => r0.scoped || (r0.global && (!r0.marketplace || r0.marketplace === c.marketplace)))
    return {
      policy: c.automationPolicy ? {
        posture: c.automationPolicy.posture, protected: c.automationPolicy.protected,
        rateCapPct: c.automationPolicy.rateCapPct != null ? Number(c.automationPolicy.rateCapPct.toString()) : null,
        rateFloorPct: c.automationPolicy.rateFloorPct != null ? Number(c.automationPolicy.rateFloorPct.toString()) : null,
        bidCapCents: c.automationPolicy.bidCapCents, bidFloorCents: c.automationPolicy.bidFloorCents,
      } : { posture: 'INHERIT', protected: false, rateCapPct: null, rateFloorPct: null, bidCapCents: null, bidFloorCents: null },
      globalMode: state.globalMode, halted: state.halted,
      rules, proposals, applied, drifts,
      // ER2 — Rate Discovery progress for the Automation tab
      rateDiscovery: discovery ? {
        status: discovery.status,
        floorPct: Number(discovery.floorPct.toString()), capPct: Number(discovery.capPct.toString()),
        stepPct: Number(discovery.stepPct.toString()), dwellDays: discovery.dwellDays,
        currentPct: discovery.currentPct != null ? Number(discovery.currentPct.toString()) : null,
        bestPct: discovery.bestPct != null ? Number(discovery.bestPct.toString()) : null,
        lastStepAt: discovery.lastStepAt,
        history: discovery.history,
      } : null,
    }
  })

  // Policy write — local governance (no eBay call), still audited.
  app.put<{ Params: { id: string }; Body: { posture?: string; protected?: boolean; rateCapPct?: number | null; rateFloorPct?: number | null; bidCapCents?: number | null; bidFloorCents?: number | null } }>('/ebay-ads/campaigns/:id/automation-policy', async (req, reply) => {
    const c = await prisma.ebayCampaign.findUnique({ where: { id: req.params.id }, include: { automationPolicy: true } })
    if (!c) return reply.code(404).send({ error: 'campaign not found' })
    const b = req.body
    if (b.posture != null && !['INHERIT', 'OFF', 'SUGGEST', 'AUTO'].includes(b.posture)) return reply.code(400).send({ error: 'posture must be INHERIT | OFF | SUGGEST | AUTO' })
    for (const k of ['rateCapPct', 'rateFloorPct'] as const) {
      const v = b[k]
      if (v != null && (!Number.isFinite(v) || v < 0 || v > 100)) return reply.code(400).send({ error: `${k} must be 0–100` })
    }
    if (b.rateCapPct != null && b.rateFloorPct != null && b.rateFloorPct > b.rateCapPct) return reply.code(400).send({ error: 'rate floor cannot exceed rate cap' })
    const data = {
      ...(b.posture != null ? { posture: b.posture } : {}),
      ...(b.protected != null ? { protected: b.protected } : {}),
      ...(b.rateCapPct !== undefined ? { rateCapPct: b.rateCapPct } : {}),
      ...(b.rateFloorPct !== undefined ? { rateFloorPct: b.rateFloorPct } : {}),
      ...(b.bidCapCents !== undefined ? { bidCapCents: b.bidCapCents } : {}),
      ...(b.bidFloorCents !== undefined ? { bidFloorCents: b.bidFloorCents } : {}),
      updatedBy: actor(req).actorUserId,
    }
    const before = c.automationPolicy
    const saved = await prisma.ebayCampaignAutomationPolicy.upsert({ where: { campaignId: c.id }, create: { campaignId: c.id, ...data }, update: data })
    await prisma.campaignAction.create({
      data: {
        userId: actor(req).actorUserId, channel: 'EBAY', actionType: 'set_automation_policy', entityType: 'CAMPAIGN', entityId: c.externalCampaignId,
        payloadBefore: (before ? { posture: before.posture, protected: before.protected } : {}) as object,
        payloadAfter: { posture: saved.posture, protected: saved.protected, rateCapPct: saved.rateCapPct?.toString() ?? null, rateFloorPct: saved.rateFloorPct?.toString() ?? null, _mode: 'local' } as object,
        channelResponseStatus: 'SUCCESS',
      },
    }).catch(() => {})
    return { ok: true, policy: { posture: saved.posture, protected: saved.protected, rateCapPct: saved.rateCapPct != null ? Number(saved.rateCapPct.toString()) : null, rateFloorPct: saved.rateFloorPct != null ? Number(saved.rateFloorPct.toString()) : null, bidCapCents: saved.bidCapCents, bidFloorCents: saved.bidFloorCents } }
  })

  // Suggested keyword bids (quota-governed passthrough)
  app.post<{ Params: { id: string }; Body: { adGroupId: string; keywords: Array<{ text: string; matchType: string }> } }>('/ebay-ads/campaigns/:id/keyword-bid-suggestions', async (req, reply) => {
    const c = await prisma.ebayCampaign.findUnique({ where: { id: req.params.id } })
    const g = await prisma.ebayAdGroup.findUnique({ where: { id: req.body.adGroupId } })
    if (!c || !g) return reply.code(404).send({ error: 'campaign or ad group not found' })
    const auth = await getActiveEbayAdsAuth()
    if (!auth) return reply.code(503).send({ error: 'no active eBay connection' })
    try {
      const out = await suggestBidsApi(auth.token, c.externalCampaignId, g.externalAdGroupId, req.body.keywords.map((k) => ({ keywordText: k.text, matchType: k.matchType })))
      return { ok: true, suggestions: out }
    } catch (e) { return reply.code(502).send({ error: (e as Error).message }) }
  })

  // Criterion preview — matches selection rules against the live index
  // (shared by DetailsTab display + the ER2 builder). Condition rules can't
  // be previewed (the index doesn't carry condition) and say so.
  app.post<{ Body: { marketplace: string; rules: Array<{ brands?: string[]; categoryIds?: string[]; minPrice?: number; maxPrice?: number; listingConditionIds?: string[] }> } }>('/ebay-ads/criterion-preview', async (req) => {
    const short = SHORT_BY_MKT[req.body.marketplace] ?? req.body.marketplace ?? 'IT'
    const live = await prisma.ebayListingIndex.findMany({ where: { marketplace: short, endedAt: null }, select: { itemId: true, title: true, price: true, categoryId: true, aspects: true } })
    const rules = req.body.rules ?? []
    const matches = rules.length === 0 ? live : live.filter((l) => rules.some((rule) => {
      if (rule.categoryIds?.length && (!l.categoryId || !rule.categoryIds.includes(l.categoryId))) return false
      const price = l.price != null ? Number(l.price.toString()) : null
      if (rule.minPrice != null && (price == null || price < rule.minPrice)) return false
      if (rule.maxPrice != null && (price == null || price > rule.maxPrice)) return false
      if (rule.brands?.length) {
        const aspects = (l.aspects ?? {}) as Record<string, string[] | string>
        const brandVals = ([] as string[]).concat(...(['Marca', 'Brand', 'marca', 'brand'].map((k) => { const v = aspects[k]; return Array.isArray(v) ? v : v ? [v] : [] })))
        if (!rule.brands.some((b) => brandVals.some((v) => v.toLowerCase() === b.toLowerCase()))) return false
      }
      return true
    }))
    const conditionRuleUsed = rules.some((rule) => (rule.listingConditionIds?.length ?? 0) > 0)
    return {
      count: matches.length,
      totalLive: live.length,
      sample: matches.slice(0, 5).map((m) => ({ itemId: m.itemId, title: m.title, priceCents: m.price != null ? Math.round(Number(m.price.toString()) * 100) : null })),
      note: conditionRuleUsed ? 'condition rules are applied by eBay but not previewable here (the index does not carry item condition)' : null,
    }
  })

  // Search terms — latest SEARCH_QUERY snapshot for a Priority campaign
  app.get<{ Params: { id: string } }>('/ebay-ads/campaigns/:id/search-terms', async (req, reply) => {
    const c = await prisma.ebayCampaign.findUnique({ where: { id: req.params.id }, select: { externalCampaignId: true, fundingModel: true, marketplace: true } })
    if (!c) return reply.code(404).send({ error: 'campaign not found' })
    if ((c.fundingModel ?? '') !== 'COST_PER_CLICK') return reply.code(400).send({ error: 'search-query reporting exists for Priority (CPC) campaigns only' })
    const latest = await prisma.ebayAdsDailyPerformance.findFirst({
      where: { entityType: 'SEARCH_QUERY', entityId: { startsWith: `${c.externalCampaignId}::` } },
      orderBy: { date: 'desc' }, select: { date: true },
    })
    if (!latest) return { terms: [], window: null, freshness: await freshness() }
    const rows = await prisma.ebayAdsDailyPerformance.findMany({
      where: { entityType: 'SEARCH_QUERY', entityId: { startsWith: `${c.externalCampaignId}::` }, date: latest.date },
      orderBy: { adFeesCents: 'desc' }, take: 500,
    })
    return {
      window: { until: latest.date.toISOString().slice(0, 10), trailingDays: 30 },
      terms: rows.map((row) => {
        const extra = (row.extra ?? {}) as Record<string, string>
        return {
          query: extra.search_query ?? row.entityId.split('::').slice(1).join('::'),
          adGroupId: extra.ad_group_id ?? null,
          impressions: row.impressions, clicks: row.clicks,
          adFeesCents: row.adFeesCents, salesCents: row.salesCents, soldQty: row.soldQty,
          acosPct: row.salesCents > 0 ? (row.adFeesCents / row.salesCents) * 100 : null,
        }
      }),
      freshness: await freshness(),
    }
  })

  // ── E7 #25 — reconciliation (Nexus intent vs eBay live state) ──────────
  app.get('/ebay-ads/reconciliation', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { drifts: await auto.detectDrift(), freshness: await freshness() }
  })
  app.post<{ Body: { campaignId: string; kind: string; listingId?: string | null; action: 'reapply' | 'accept' } }>('/ebay-ads/reconciliation/repair', async (req) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { ok: true, detail: await auto.repairDrift((req as { authUser?: { id?: string } }).authUser?.id ?? null, req.body) }
  })
}

export default ebayAdsRoutes
