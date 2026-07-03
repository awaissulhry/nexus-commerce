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
import { getActiveEbayAdsAuth, suggestMaxCpcApi, suggestKeywordsApi, suggestBidsApi } from '../services/marketing/ebay-ads-api.service.js'

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
  app.post<{ Body: { name: string; trigger: unknown; action: unknown; marketplace?: string; cooldownHours?: number } }>('/ebay-ads/automation/rules', async (req) => {
    return prisma.ebayAdsRule.create({ data: { name: req.body.name, enabled: false, mode: 'PROPOSE', trigger: req.body.trigger as object, action: req.body.action as object, marketplace: req.body.marketplace ?? null, cooldownHours: req.body.cooldownHours ?? 24 } })
  })
  app.post<{ Params: { id: string }; Body: { enabled?: boolean; mode?: 'PROPOSE' | 'AUTOPILOT' } }>('/ebay-ads/automation/rules/:id', async (req) => {
    return prisma.ebayAdsRule.update({ where: { id: req.params.id }, data: { ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}), ...(req.body.mode ? { mode: req.body.mode } : {}) } })
  })
  app.post<{ Params: { id?: string } }>('/ebay-ads/automation/evaluate', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return auto.evaluateEbayAdsRules()
  })
  app.post('/ebay-ads/automation/presets/starter-pack', async () => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return auto.installStarterRules()
  })
  app.get<{ Querystring: { status?: string } }>('/ebay-ads/automation/proposals', async (req) => ({
    proposals: await prisma.ebayAdsProposal.findMany({ where: { status: req.query.status ?? 'PENDING' }, orderBy: { createdAt: 'desc' }, take: 200 }),
  }))
  app.post<{ Body: { ids: string[]; decision: 'approve' | 'reject' } }>('/ebay-ads/automation/proposals/decide', async (req) => {
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    return { results: await auto.decideProposals((req as { authUser?: { id?: string } }).authUser?.id ?? null, req.body.ids, req.body.decision) }
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
  app.get('/ebay-ads/digest/latest', async () => {
    const d = await prisma.ebayAdsDigest.findFirst({ orderBy: { weekStart: 'desc' } })
    return { digest: d }
  })
  app.get('/ebay-ads/digests', async () => ({ digests: await prisma.ebayAdsDigest.findMany({ orderBy: { weekStart: 'desc' }, take: 12, select: { id: true, weekStart: true, generatedAt: true, reviewedAt: true } }) }))
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
  const GOAL_DEFS: Record<string, { label: string; strategy: 'CPS' | 'CPC'; goalFactor: number; fallbackRatePct: number; endDays: number | null; rulePacks: string[] }> = {
    catch_all: { label: 'Protect margin — promote everything', strategy: 'CPS', goalFactor: 0.7, fallbackRatePct: 5, endDays: null, rulePacks: ['Fee % creep-down (CPS)', 'Click bleeder — remove ad (CPS)', 'Rate above break-even — repair (CPS)', 'Restock re-promote (CPS)'] },
    hero: { label: 'Push hero products', strategy: 'CPC', goalFactor: 1.0, fallbackRatePct: 0, endDays: null, rulePacks: ['Keyword bleeder — pause (CPC)', 'Keyword bid-down on thin CTR (CPC)'] },
    clearance: { label: 'Clear stock', strategy: 'CPS', goalFactor: 1.0, fallbackRatePct: 12, endDays: 30, rulePacks: ['Click bleeder — remove ad (CPS)'] },
    defend: { label: 'Defend visibility', strategy: 'CPC', goalFactor: 1.0, fallbackRatePct: 0, endDays: null, rulePacks: ['Keyword bleeder — pause (CPC)'] },
  }

  app.post<{ Body: { goal: string; marketplace?: string; productIds?: string[]; listingIds?: string[] } }>('/ebay-ads/builder/prefill', async (req, reply) => {
    const def = GOAL_DEFS[req.body.goal]
    if (!def) return reply.code(400).send({ error: `unknown goal (${Object.keys(GOAL_DEFS).join('|')})` })
    const marketplace = req.body.marketplace ?? 'EBAY_IT'
    const short = SHORT_BY_MKT[marketplace] ?? 'IT'
    if (marketplace === 'EBAY_ES' && def.strategy === 'CPC') return reply.code(400).send({ error: 'Priority is not available on eBay Spain' })

    // Scope: explicit listings/products, else every live listing (catch-all)
    const ids = new Set<string>(req.body.listingIds ?? [])
    for (const pid of req.body.productIds ?? []) {
      for (const hit of await getLiveEbayItemIds(pid, short)) ids.add(hit.itemId)
    }
    const live = await prisma.ebayListingIndex.findMany({
      where: { marketplace: short, endedAt: null, ...(ids.size ? { itemId: { in: [...ids] } } : {}) },
      select: { itemId: true, title: true, price: true, quantity: true },
    })
    const itemIds = live.map((l) => l.itemId)

    const [eco, conflicts, facts30] = await Promise.all([
      prisma.ebayListingEconomics.findMany({ where: { marketplace: short, itemId: { in: itemIds } }, select: { itemId: true, breakEvenAdRatePct: true, dataStatus: true } }),
      prisma.ebayAd.findMany({
        where: { listingId: { in: itemIds }, status: { notIn: ['STALE'] }, campaign: { fundingModel: 'COST_PER_SALE', status: { in: ['RUNNING', 'PAUSED'] } } },
        select: { listingId: true, bidPercentage: true, campaign: { select: { id: true, name: true } } },
      }),
      prisma.ebayAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'LISTING', entityId: { in: itemIds }, date: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        _sum: { salesCents: true, adFeesCents: true },
      }),
    ])
    const ecoBy = new Map(eco.map((e) => [e.itemId, e]))
    const conflictBy = new Map(conflicts.map((c) => [c.listingId!, c]))
    const salesBy = new Map(facts30.map((f) => [f.entityId, f._sum.salesCents ?? 0]))

    const seq = (await prisma.ebayCampaign.count({ where: { marketplace } })) + 1
    const name = `${req.body.goal}-${def.strategy.toLowerCase()}-${ids.size ? 'selected' : 'all'}-${short}-${String(seq).padStart(3, '0')}`

    // E7 Stage 2 (#7): keyword seeds for CPC goals from OUR data — title
    // n-grams + brand/type aspects, tagged by source, default bids clamped
    // low (learning phase). eBay suggestKeywords needs an ad group, which
    // doesn't exist pre-launch — our own seeds fill that gap.
    let keywordSeeds: Array<{ text: string; source: string; matchType: string; bidCents: number }> = []
    let budget: { suggestedCents: number; formula: string } | null = null
    if (def.strategy === 'CPC') {
      const idx = await prisma.ebayListingIndex.findMany({ where: { marketplace: short, itemId: { in: itemIds } }, select: { title: true, aspects: true } })
      const STOP = new Set(['con', 'per', 'the', 'and', 'del', 'della', 'di', 'da', 'in', 'su', 'e', 'a', 'il', 'la', 'le', 'un', 'una', 'protezione', 'livello'])
      const counts = new Map<string, number>()
      for (const l of idx) {
        const words = (l.title ?? '').toLowerCase().replace(/[^a-zà-ù0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
        for (let i = 0; i < words.length - 1; i++) {
          const bi = `${words[i]} ${words[i + 1]}`
          counts.set(bi, (counts.get(bi) ?? 0) + 1)
        }
        const a = (l.aspects ?? {}) as Record<string, string[]>
        const brand = (a['Marca'] ?? a['Brand'] ?? [])[0]
        const tipo = (a['Tipo'] ?? a['Type'] ?? [])[0]
        if (brand && tipo) counts.set(`${brand} ${tipo}`.toLowerCase(), (counts.get(`${brand} ${tipo}`.toLowerCase()) ?? 0) + 3)
      }
      keywordSeeds = [...counts.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, 20)
        .map(([text, n]) => ({ text, source: n >= 3 ? 'ASPECT/FREQUENT' : 'TITLE', matchType: 'PHRASE', bidCents: 30 }))
      const trailingSales = [...salesBy.values()].reduce((a, b) => a + b, 0)
      const suggested = Math.max(500, Math.round((trailingSales * 0.05) / 30))
      budget = { suggestedCents: suggested, formula: `max(€5, trailing-30d sales ${(trailingSales / 100).toFixed(0)}€ × 5% ÷ 30 days) — efficiency rules unlock at ≥30 attributed conversions` }
    }

    const listings = live.map((l) => {
      const e = ecoBy.get(l.itemId)
      const be = e?.breakEvenAdRatePct != null ? Number(e.breakEvenAdRatePct.toString()) : null
      const computedRatePct = def.strategy === 'CPS'
        ? be != null ? Math.min(100, Math.max(2, Math.round(be * def.goalFactor * 10) / 10)) : def.fallbackRatePct
        : null
      const trailingSales = salesBy.get(l.itemId) ?? 0
      const conflict = conflictBy.get(l.itemId)
      return {
        itemId: l.itemId,
        title: l.title,
        priceCents: l.price != null ? Math.round(Number(l.price.toString()) * 100) : null,
        quantity: l.quantity,
        breakEvenPct: be,
        economicsStatus: e?.dataStatus ?? null,
        computedRatePct,
        rateSource: be != null ? `break-even ${be}% × ${def.goalFactor}` : `goal default (no cost data)`,
        trailingSales30dCents: trailingSales,
        forecastMonthlyFeeCents: def.strategy === 'CPS' && computedRatePct != null ? Math.round(trailingSales * (computedRatePct / 100)) : null,
        conflict: conflict ? { campaignId: conflict.campaign.id, campaignName: conflict.campaign.name, currentRatePct: conflict.bidPercentage != null ? Number(conflict.bidPercentage.toString()) : null } : null,
      }
    })

    return {
      goal: req.body.goal,
      derived: {
        label: def.label,
        strategy: def.strategy,
        name,
        marketplace,
        goalFactor: def.goalFactor,
        endDate: def.endDays ? new Date(Date.now() + def.endDays * 86_400_000).toISOString().slice(0, 10) : null,
        rulePacks: def.rulePacks,
        rateMode: 'FIXED',
        defaultBudgetCents: def.strategy === 'CPC' ? 500 : null,
      },
      listings,
      keywordSeeds,
      budget,
      totals: {
        listings: listings.length,
        conflicts: listings.filter((l) => l.conflict).length,
        missingCost: listings.filter((l) => l.breakEvenPct == null).length,
        forecastMonthlyFeeCents: listings.reduce((a, l) => a + (l.forecastMonthlyFeeCents ?? 0), 0),
        trailingSales30dCents: listings.reduce((a, l) => a + l.trailingSales30dCents, 0),
      },
      // E7 #17 sprawl cap — builder shows an advisory past 25 active campaigns
      activeCampaigns: await prisma.ebayCampaign.count({ where: { marketplace, status: 'RUNNING', NOT: { externalCampaignId: { startsWith: 'sandbox-' } } } }),
    }
  })

  app.post<{ Body: {
    goal: string; name: string; marketplace: string
    ratePct?: number; dailyBudgetCents?: number; maxCpcCents?: number; targetingType?: 'MANUAL' | 'SMART'
    endDate?: string | null
    items: Array<{ listingId: string; ratePct?: number; resolution?: 'include' | 'skip' | 'move' }>
    keywords?: Array<{ text: string; matchType: string; bidCents?: number }>
    rulePacks?: string[]
    override?: { reason: string }
  } }>('/ebay-ads/builder/launch', async (req, reply) => {
    const b = req.body
    const def = GOAL_DEFS[b.goal]
    if (!def) return reply.code(400).send({ error: 'unknown goal' })
    const ctx = actor(req)
    const auto = await import('../services/marketing/ebay-ads-automation.service.js')
    const writesSvc = writes

    // 1. create the campaign
    const created = await writesSvc.createCampaign(ctx, {
      name: b.name,
      marketplace: b.marketplace,
      fundingModel: def.strategy === 'CPS' ? 'COST_PER_SALE' : 'COST_PER_CLICK',
      ...(def.strategy === 'CPS'
        ? { adRateStrategy: 'FIXED' as const, ratePct: b.ratePct ?? def.fallbackRatePct }
        : { targetingType: b.targetingType ?? 'MANUAL', dailyBudgetCents: b.dailyBudgetCents ?? 500, ...(b.targetingType === 'SMART' ? { maxCpcCents: b.maxCpcCents ?? 40 } : {}) }),
    })

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

    // 3b. CPC goals: default ad group + seeded keywords launch WITH the
    // campaign (blueprint #7) — no more "add keywords later" gap.
    let keywordResults: unknown[] = []
    if (def.strategy === 'CPC' && b.keywords?.length) {
      const kws = b.keywords
      const grp = await writesSvc.createAdGroup(ctx, created.campaignId, 'Default', undefined)
      const out = await writesSvc.addKeywords(ctx, created.campaignId, grp.adGroupId, kws)
      keywordResults = out.results
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
      rulePacksBound: bound,
      timeline: [
        'eBay reviews and starts serving ads (typically within hours)',
        def.strategy === 'CPS' ? 'Any-click attribution: fees appear on sales within 30 days of any ad click' : 'CPC clicks bill immediately; budget edits take effect next day',
        `Rule packs (${bound.length}) evaluate daily at ~07:45 and PROPOSE changes for your approval`,
        'Check back in 7 days: impressions per listing, eBay ACOS vs break-even, stale ads',
      ],
    }
  })

  // Audit trail for the console's activity panels (immutable event log —
  // pass entityId=<externalCampaignId> for one campaign's history)
  app.get<{ Querystring: { limit?: string; entityId?: string } }>('/ebay-ads/actions', async (req) => {
    const actions = await prisma.campaignAction.findMany({
      where: { channel: 'EBAY', ...(req.query.entityId ? { entityId: req.query.entityId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 50), 200),
    })
    return { actions }
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
