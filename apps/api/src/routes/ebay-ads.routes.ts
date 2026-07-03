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
    const [cur, prev, campaigns, economics, fr] = await Promise.all([
      prisma.ebayAdsDailyPerformance.aggregate({ where: factWhere(req.query, r, 'CAMPAIGN'), _sum: sumFields }),
      prisma.ebayAdsDailyPerformance.aggregate({ where: factWhere(req.query, p, 'CAMPAIGN'), _sum: sumFields }),
      prisma.ebayCampaign.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } }),
      freshness(),
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
    const [camps, facts, adCounts] = await Promise.all([
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
    ])
    const factsByExt = new Map(facts.map((f) => [f.entityId, derive(toSums(f))]))
    const adsByCampaign = new Map<string, { total: number; stale: number }>()
    for (const a of adCounts) {
      const cur = adsByCampaign.get(a.campaignId) ?? { total: 0, stale: 0 }
      cur.total += a._count._all
      if (a.status === 'STALE') cur.stale += a._count._all
      adsByCampaign.set(a.campaignId, cur)
    }
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
        ads: adsByCampaign.get(c.id) ?? { total: 0, stale: 0 },
        metrics: factsByExt.get(c.externalCampaignId) ?? derive(zeroSums),
      })),
      freshness: await freshness(),
    }
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
      },
      ads: c.ads.map((a) => ({
        id: a.id,
        listingId: a.listingId,
        inventoryReference: a.inventoryReference,
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
        text: n.text,
        matchType: n.matchType,
        status: n.status,
      })),
      freshness: await freshness(),
    }
  })

  // ── Product rollups (+ unmatched listings) ──────────────────────────────
  app.get<{ Querystring: WindowQuery }>('/ebay-ads/products', async (req) => {
    const r = resolveRange(req.query)
    const short = req.query.marketplace && req.query.marketplace !== 'all' ? SHORT_BY_MKT[req.query.marketplace] : undefined
    const [listings, listingFacts, economics] = await Promise.all([
      prisma.ebayListingIndex.findMany({
        where: { endedAt: null, ...(short ? { marketplace: short } : {}) },
        select: { itemId: true, marketplace: true, title: true, price: true, currency: true, quantity: true, productIds: true, matchStatus: true, categoryId: true },
      }),
      prisma.ebayAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'LISTING', date: { gte: r.since, lte: r.until } },
        _sum: sumFields,
      }),
      prisma.ebayListingEconomics.findMany({ select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }),
    ])
    const lf = new Map(listingFacts.map((f) => [f.entityId, derive(toSums(f))]))
    const eco = new Map(economics.map((e) => [e.itemId, e]))

    const productIds = [...new Set(listings.flatMap((l) => l.productIds))]
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true, name: true, costPrice: true } })
      : []
    const pById = new Map(products.map((p) => [p.id, p]))

    const listingRow = (l: (typeof listings)[number]) => ({
      itemId: l.itemId,
      marketplace: l.marketplace,
      title: l.title,
      priceCents: l.price != null ? Math.round(Number(l.price.toString()) * 100) : null,
      currency: l.currency ?? 'EUR',
      quantity: l.quantity,
      matchStatus: l.matchStatus,
      breakEvenAdRatePct: eco.get(l.itemId)?.breakEvenAdRatePct != null ? Number(eco.get(l.itemId)!.breakEvenAdRatePct!.toString()) : null,
      economicsStatus: eco.get(l.itemId)?.dataStatus ?? null,
      metrics: lf.get(l.itemId) ?? derive(zeroSums),
    })

    const byProduct = new Map<string, ReturnType<typeof listingRow>[]>()
    const unmatched: ReturnType<typeof listingRow>[] = []
    for (const l of listings) {
      const row = listingRow(l)
      if (l.productIds.length === 0) { unmatched.push(row); continue }
      for (const pid of l.productIds) {
        const arr = byProduct.get(pid) ?? []
        arr.push(row)
        byProduct.set(pid, arr)
      }
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
        listings: rows,
        metrics: derive(sumRows(rows)),
      })).sort((a, b) => b.metrics.adFeesCents - a.metrics.adFeesCents),
      unmatchedListings: unmatched.sort((a, b) => b.metrics.impressions - a.metrics.impressions),
      freshness: await freshness(),
    }
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
}

export default ebayAdsRoutes
