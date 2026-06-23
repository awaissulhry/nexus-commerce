/**
 * AD.1 — Trading Desk read-only API.
 *
 * Replaces the placeholder /marketing/advertising at marketing.routes.ts:10.
 * AD.2 adds the mutation routes (PATCH campaigns/ad-groups/targets) +
 * bid-history; AD.3 mounts /api/advertising/automation-rules as a
 * domain-filtered proxy over /api/automation-rules.
 *
 * Endpoints (all under /api/advertising):
 *   GET  /campaigns                   ?marketplace, ?status, ?search
 *   GET  /campaigns/:id               drawer: campaign + adGroups + productAds + 30d profit
 *   GET  /fba-storage-age             ?marketplace, ?daysToLtsLte, ?bucket
 *   GET  /fba-storage-age/:productId  drill-down: per-poll history
 *   GET  /profit/daily                ?marketplace, ?productId, ?dateFrom, ?dateTo
 *   GET  /summary                     three-card landing payload (campaign count, ad spend 30d, true-profit margin 30d)
 *   POST /ads-connection/test         credential check (admin-only path TBD in AD.4)
 *   POST /cron/ads-sync/trigger        manual cron trigger (mirrors /sync-logs/cron pattern)
 *   POST /cron/fba-storage-age-ingest/trigger
 *   POST /cron/true-profit-rollup/trigger
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { testConnection, adsMode, listPortfolios, createPortfolio, type AdsRegion } from '../services/advertising/ads-api-client.js'
import { allocate, microsToCents, toEurCents } from '../services/advertising/ads-metrics-math.js'
import { detectKeywordConflicts } from '../services/advertising/keyword-conflicts.service.js'
import { getFxRate } from '../services/fx-rate.service.js'
import {
  runFbaStorageAgeIngestOnce,
  summarizeFbaStorageAge,
} from '../services/advertising/fba-storage-age-ingest.service.js'
import {
  runTrueProfitRollupOnce,
  summarizeTrueProfitRollup,
} from '../services/advertising/true-profit-rollup.service.js'
import {
  runAdsMetricsIngestOnce,
  summarizeAdsMetricsIngest,
} from '../services/advertising/ads-metrics-ingest.service.js'
import {
  updateCampaignWithSync,
  updateAdGroupWithSync,
  updateAdTargetWithSync,
  updateProductAdWithSync,
  bulkUpdateAdTargetBids,
  cancelPendingMutation,
  type AdsActor,
} from '../services/advertising/ads-mutation.service.js'
import { drainAdsSyncOnce } from '../workers/ads-sync.worker.js'
// AD.3 — side-effect import registers the 8 advertising action handlers
// into ACTION_HANDLERS. No engine code is touched; the map is mutated
// at module load. Loading this routes plugin during app boot guarantees
// the handlers are available before any rule fires.
import '../services/advertising/automation-action-handlers.js'
import { seedAdvertisingTemplates } from '../services/advertising/automation-templates.js'
import {
  runAdvertisingRuleEvaluatorOnce,
  getAdvertisingRuleEvaluatorStatus,
} from '../jobs/advertising-rule-evaluator.job.js'
import { evaluateRule } from '../services/automation-rule.service.js'
import { rollbackByExecutionId } from '../services/advertising/rollback.service.js'
import {
  rebalanceAndAudit,
  computeRebalance,
} from '../services/advertising/budget-pool-rebalancer.service.js'
import { randomBytes, createHash } from 'node:crypto'

// AD.4 — in-memory token store for the two-step enable-writes flow.
// Token issued by /preview-writes is required to complete /enable-writes.
// Tokens live 60s; stored as sha256 hash so the cleartext token is the
// caller's burden to retain.
const ENABLE_WRITES_TOKENS = new Map<string, { profileId: string; expiresAt: number }>()
function gcEnableWriteTokens(): void {
  const now = Date.now()
  for (const [k, v] of ENABLE_WRITES_TOKENS.entries()) {
    if (v.expiresAt < now) ENABLE_WRITES_TOKENS.delete(k)
  }
}

// AME.2 — resolve EUR-per-unit rates for a set of currency codes once, so a
// rollup that crosses marketplaces converts native minor units to the EUR base
// before summing. EUR maps to 1 (no-op); all current ad data is EUR.
async function buildEurRateMap(codes: Array<string | null | undefined>): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const c of codes) {
    const ccy = c || 'EUR'
    if (out.has(ccy)) continue
    out.set(ccy, ccy === 'EUR' ? 1 : await getFxRate(prisma, ccy, 'EUR'))
  }
  return out
}

// Best-effort actor resolution. AD.4 wires real auth; for now the
// caller may pass an `x-actor-id` header (operator UI sets it) or
// fall back to a sentinel. Every audit row must be tagged.
function actorFromHeaders(headers: Record<string, unknown>): AdsActor {
  const raw = headers['x-actor-id']
  if (typeof raw === 'string' && raw.length > 0) return `user:${raw}` as AdsActor
  return 'user:anonymous' as AdsActor
}

const advertisingRoutes: FastifyPluginAsync = async (fastify) => {
  // Phase 4 — invalidate the ads read cache after any successful write so an
  // operator never sees a stale number right after an edit. Scoped to this
  // plugin's routes; GETs and failures are ignored.
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return
    if (reply.statusCode >= 400) return
    if (!request.url.includes('/advertising/')) return
    const { flushAdsCache } = await import('../services/advertising/ads-cache.js')
    void flushAdsCache()
  })

  // ── GET /advertising/campaigns ──────────────────────────────────────
  fastify.get('/advertising/campaigns', async (request, reply) => {
    const q = request.query as {
      marketplace?: string
      status?: string
      search?: string
      limit?: string
    }
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.status) where.status = q.status
    if (q.search) where.name = { contains: q.search, mode: 'insensitive' }
    const limit = Math.min(Number(q.limit) || 200, 500)

    // CBN.2g — date-windowed metrics. When the Ad Manager passes a range
    // (preset/startDate/endDate/windowDays) the spend/sales/etc. are derived LIVE
    // from AmazonAdsDailyPerformance for that window (the same authoritative source
    // the detail page + trends use). With no date params we keep the fast stored
    // columns, so other callers are unchanged.
    const qd = q as { preset?: string; startDate?: string; endDate?: string; windowDays?: string }
    const hasDateParams = !!(qd.preset || qd.startDate || qd.endDate || qd.windowDays)
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = hasDateParams ? resolveRange(qd) : null

    const { cached } = await import('../services/advertising/ads-cache.js')
    const rangeKey = range ? `${range.sinceStr}:${range.untilStr}` : 'stored'
    const cacheKey = `campaigns:${q.marketplace ?? ''}:${q.status ?? ''}:${q.search ?? ''}:${limit}:${rangeKey}`
    const result = await cached(cacheKey, 300, async () => {
      const campaigns = await prisma.campaign.findMany({
        where,
        orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
        take: limit,
        select: {
          id: true,
          name: true,
          type: true,
          adProduct: true,
          status: true,
          marketplace: true,
          externalCampaignId: true,
          dailyBudget: true,
          biddingStrategy: true,
          impressions: true,
          clicks: true,
          spend: true,
          sales: true,
          acos: true,
          roas: true,
          trueProfitCents: true,
          trueProfitMarginPct: true,
          lastSyncedAt: true,
          lastSyncStatus: true,
          // H.2: v1 export populates these — surface in the table for
          // operators to see *why* a campaign isn't serving.
          deliveryStatus: true,
          deliveryReasons: true,
          // Ads-console table columns (image #6 defaults).
          startDate: true,
          endDate: true,
          portfolioId: true,
          // P2 (Trading Desk Ad Manager): placement multipliers live here.
          dynamicBidding: true,
        },
      })
      // P2 — derive inline placement multipliers (ToS/PDP/RoS) from
      // Campaign.dynamicBidding.placementBidding so the Ad Manager grid can
      // show them as columns without an extra per-campaign fetch. The heavy
      // dynamicBidding JSON is stripped from the response.
      const base = campaigns.map((c) => {
        const { dynamicBidding, ...rest } = c
        const db = (dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }>; targetAcos?: number; bidAutomation?: boolean }
        const pb = db.placementBidding ?? []
        const find = (kw: string) => {
          const m = pb.find((p) => p.placement?.toLowerCase().includes(kw))
          return m ? m.percentage : null
        }
        // CBN.2h.6 — surface the Bulk-Actions-managed settings inline (stored in
        // dynamicBidding alongside placementBidding). targetAcos is a fraction
        // (0.3 = 30%) — the same shape the bid-optimizer reads.
        return { ...rest, placements: { tos: find('top'), pdp: find('product'), ros: find('rest') }, targetAcos: db.targetAcos ?? null, bidAutomation: db.bidAutomation ?? false }
      })

      if (!range) return { items: base, count: base.length, range: null }

      // CBN.2g — override the stored columns with window-aggregated metrics from the
      // daily-performance table, batched across the whole list (2 groupBys). The
      // localEntityId match + entityId fallback (rows that never linked locally)
      // mirrors the detail endpoint's OR-match without double-counting.
      const ids = campaigns.map((c) => c.id)
      const extIds = campaigns.map((c) => c.externalCampaignId).filter(Boolean) as string[]
      const n = (v: bigint | number | null | undefined) => Number(v ?? 0)
      const m2c = (v: bigint | number | null | undefined) => Math.round(Number(v ?? 0) / 10000)
      const dateFilter = { gte: range.since, lte: range.until }
      const _sum = { impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true } as const
      const [byLocal, byExt] = await Promise.all([
        prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: dateFilter }, _sum }),
        prisma.amazonAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'CAMPAIGN', entityId: { in: extIds }, localEntityId: null, date: dateFilter }, _sum }),
      ])
      const mapL = new Map(byLocal.map((r) => [r.localEntityId, r._sum]))
      const mapE = new Map(byExt.map((r) => [r.entityId, r._sum]))
      const items = base.map((it) => {
        const a = mapL.get(it.id)
        const b = it.externalCampaignId ? mapE.get(it.externalCampaignId) : undefined
        const spendCents = m2c(a?.costMicros) + m2c(b?.costMicros)
        const salesCents = n(a?.sales7dCents) + n(a?.sales14dCents) + n(b?.sales7dCents) + n(b?.sales14dCents)
        return {
          ...it,
          impressions: n(a?.impressions) + n(b?.impressions),
          clicks: n(a?.clicks) + n(b?.clicks),
          spend: spendCents / 100,
          sales: salesCents / 100,
          acos: salesCents > 0 ? spendCents / salesCents : null,
          roas: spendCents > 0 ? salesCents / spendCents : null,
          ppcOrders: n(a?.orders7d) + n(b?.orders7d),
        }
      })
      return { items, count: items.length, range: { startDate: range.sinceStr, endDate: range.untilStr, preset: range.preset } }
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return result
  })

  // ── GET /advertising/campaigns/:id ──────────────────────────────────
  // AME.1 — metrics are derived LIVE from AmazonAdsDailyPerformance (the same
  // source the trends chart + by-product grid read) rather than the stale
  // stored columns (Campaign.spend / AdGroup.spendCents were last-write 0 in
  // prod → the detail page showed €0 while the chart showed real spend). A
  // single campaign belongs to one marketplace/currency, so summing within it
  // is currency-safe by construction. Sales = SP(sales7dCents)+SB(sales14dCents),
  // disjoint per row. Campaign totals come from CAMPAIGN daily rows; ad-group
  // totals roll up PRODUCT_AD daily rows by ad group (no AD_GROUP daily grain).
  fastify.get('/advertising/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { windowDays?: string; preset?: string; startDate?: string; endDate?: string }
    // DR.1 — Rome-anchored range (preset/custom) with windowDays back-compat.
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(q)
    const since = range.since
    const windowDays = range.days

    const { cached } = await import('../services/advertising/ads-cache.js')
    const payload = await cached(`detail:${id}:${range.sinceStr}:${range.untilStr}`, 300, async () => {
      const campaign = await prisma.campaign.findUnique({
        where: { id },
        include: {
          adGroups: {
            include: {
              targets: { take: 100 },
              // PERF — the cockpit never renders per-ad-group product ads; we only
              // need their ids to allocate the campaign total across ad groups.
              // Selecting full rows (creativeJson, deliveryReasons…) for up to 500
              // ads × every ad group was the bulk of the detail-endpoint payload.
              productAds: { take: 500, select: { id: true } },
            },
          },
        },
      })
      if (!campaign) return null

      // ── Campaign totals — authoritative + chart-consistent. CAMPAIGN daily
      // rows are Amazon's billed campaign spend; match localEntityId OR entityId
      // exactly like /trends. A single campaign = one marketplace/currency, so
      // summing here is currency-safe by construction.
      const campaignWhere = {
        OR: [
          { localEntityId: id },
          ...(campaign.externalCampaignId ? [{ entityId: campaign.externalCampaignId }] : []),
        ],
      }
      // Allocated metrics via the shared service (Σ ad groups == campaign).
      const { computeCampaignDetailMetrics } = await import('../services/advertising/ads-detail-metrics.service.js')
      const [{ campaign: campMetrics, byAdGroup }, fresh] = await Promise.all([
        computeCampaignDetailMetrics({
          campaignId: id,
          externalCampaignId: campaign.externalCampaignId,
          adGroups: campaign.adGroups.map((g) => ({ id: g.id, productAdIds: g.productAds.map((pa) => pa.id) })),
          windowDays,
          since: range.since,
          until: range.until,
        }),
        prisma.amazonAdsDailyPerformance.aggregate({
          where: { entityType: 'CAMPAIGN', date: { gte: since, lte: range.until }, ...campaignWhere },
          _max: { date: true }, // AME.4 — data-freshness signal for the detail UI
        }),
      ])

      const adGroups = campaign.adGroups.map((g) => {
        const m = byAdGroup.get(g.id)!
        return { ...g, impressions: m.impressions, clicks: m.clicks, spendCents: m.spendCents, salesCents: m.salesCents, ordersCount: m.orders, acos: m.acos, roas: m.roas }
      })

      return {
        campaign: {
          ...campaign,
          impressions: campMetrics.impressions,
          clicks: campMetrics.clicks,
          spend: campMetrics.spendCents / 100,
          sales: campMetrics.salesCents / 100,
          acos: campMetrics.acos,
          roas: campMetrics.roas,
          adGroups,
          metricsWindowDays: windowDays,
          metricsSource: 'daily_performance',
          dataThrough: fresh._max.date ? fresh._max.date.toISOString().slice(0, 10) : null,
          range: { preset: range.preset, startDate: range.sinceStr, endDate: range.untilStr, includesToday: range.includesToday },
        },
      }
    })
    if (!payload) { reply.code(404); return { error: 'not_found' } }
    reply.header('Cache-Control', 'private, max-age=20')
    return payload
  })

  // ── GET /advertising/ad-groups/:id (AME.6) ──────────────────────────
  // Amazon-parity ad-group drill-down. Metrics derive live from the daily
  // table (same source as the campaign detail + chart). Returns the ad group
  // + its ads (product thumbnail + per-ad metrics), targets, a daily trend
  // and campaign context. Search-terms/negatives/history load lazily.
  // ── H2: flat ad-groups list for the Rule Builder "Add Ad Group" popover. Returns each
  //    ad group + its campaign context (name/status/type/marketplace) so the popover can
  //    render the Ad Groups tab (flat) and the Campaigns tab (grouped by campaign). ──
  fastify.get('/advertising/ad-groups', async (request) => {
    const q = request.query as { marketplace?: string; status?: string; campaignStatus?: string; limit?: string }
    const where: Record<string, unknown> = {}
    if (q.status) where.status = q.status
    const campWhere: Record<string, unknown> = {}
    if (q.marketplace && q.marketplace !== 'all') campWhere.marketplace = q.marketplace
    if (q.campaignStatus) campWhere.status = q.campaignStatus
    if (Object.keys(campWhere).length) where.campaign = campWhere
    const adGroups = await prisma.adGroup.findMany({
      where,
      select: {
        id: true, name: true, status: true, targetingType: true, campaignId: true,
        campaign: { select: { id: true, name: true, status: true, marketplace: true, type: true, portfolioId: true } },
      },
      orderBy: [{ campaign: { name: 'asc' } }, { name: 'asc' }],
      take: Math.min(Number(q.limit) || 2000, 5000),
    })
    return {
      items: adGroups.map((g) => ({
        id: g.id, name: g.name, status: g.status, targetingType: g.targetingType,
        campaignId: g.campaignId, campaignName: g.campaign?.name ?? null,
        campaignStatus: g.campaign?.status ?? null, marketplace: g.campaign?.marketplace ?? null,
        adProduct: g.campaign?.type ?? null, portfolioId: g.campaign?.portfolioId ?? null,
      })),
      count: adGroups.length,
    }
  })

  fastify.get('/advertising/ad-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { windowDays?: string; preset?: string; startDate?: string; endDate?: string }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(q)
    const since = range.since
    const windowDays = range.days

    const { cached: cachedAg } = await import('../services/advertising/ads-cache.js')
    const agPayload = await cachedAg(`adgroup:${id}:${range.sinceStr}:${range.untilStr}`, 300, async () => {
    const adGroup = await prisma.adGroup.findUnique({
      where: { id },
      include: {
        campaign: { select: { id: true, name: true, marketplace: true, type: true, status: true, externalCampaignId: true, dailyBudget: true } },
        targets: { take: 200 },
        productAds: { take: 200, select: { id: true, asin: true, sku: true, productId: true, status: true } },
      },
    })
    if (!adGroup) return null

    const adIds = adGroup.productAds.map((a) => a.id)
    const agDateFilter = { gte: since, lte: range.until }
    const [perAd, trendRaw, siblings] = await Promise.all([
      adIds.length ? prisma.amazonAdsDailyPerformance.groupBy({
        by: ['localEntityId'],
        where: { entityType: 'PRODUCT_AD', localEntityId: { in: adIds }, date: agDateFilter },
        _sum: { costMicros: true, sales7dCents: true, sales14dCents: true, impressions: true, clicks: true, orders7d: true },
      }) : Promise.resolve([]),
      adIds.length ? prisma.amazonAdsDailyPerformance.groupBy({
        by: ['date'],
        where: { entityType: 'PRODUCT_AD', localEntityId: { in: adIds }, date: agDateFilter },
        _sum: { costMicros: true, sales7dCents: true, sales14dCents: true, impressions: true, clicks: true, orders7d: true },
        orderBy: { date: 'asc' },
      }) : Promise.resolve([]),
      // All sibling ad groups (id + product-ad ids) so the campaign total can be
      // allocated to THIS ad group exactly as the campaign detail does it.
      prisma.adGroup.findMany({ where: { campaignId: adGroup.campaign.id }, select: { id: true, productAds: { select: { id: true } } } }),
    ])
    const metByAd = new Map(perAd.map((r) => [r.localEntityId!, r]))

    // Anchor on the campaign authoritative total → allocate to this ad group, so
    // the figures match the campaign detail's ad-group row 1:1.
    const { computeCampaignDetailMetrics, allocateMetricsAcross } = await import('../services/advertising/ads-detail-metrics.service.js')
    const { byAdGroup } = await computeCampaignDetailMetrics({
      campaignId: adGroup.campaign.id,
      externalCampaignId: adGroup.campaign.externalCampaignId,
      adGroups: siblings.map((s) => ({ id: s.id, productAdIds: s.productAds.map((p) => p.id) })),
      windowDays,
      since: range.since,
      until: range.until,
    })
    const agMetrics = byAdGroup.get(adGroup.id) ?? { impressions: 0, clicks: 0, spendCents: 0, salesCents: 0, orders: 0, acos: null, roas: null }

    const { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } = await import('../services/product-read-cache.service.js')
    const productIds = [...new Set(adGroup.productAds.map((a) => a.productId).filter((x): x is string => !!x))]
    const prods = productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true, images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY } } }) : []
    const prodById = new Map(prods.map((p) => [p.id, p]))

    // Allocate the ad-group total across its ads (Σ ads == ad group).
    const adShareOf = (a: { id: string }) => {
      const m = metByAd.get(a.id)
      return { impr: m?._sum.impressions ?? 0, clicks: m?._sum.clicks ?? 0, micros: Number(m?._sum.costMicros ?? 0n), salesCents: (m?._sum.sales7dCents ?? 0) + (m?._sum.sales14dCents ?? 0), orders: m?._sum.orders7d ?? 0 }
    }
    const adAlloc = allocateMetricsAcross(agMetrics, adGroup.productAds, adShareOf)
    const ads = adGroup.productAds.map((a, i) => {
      const p = a.productId ? prodById.get(a.productId) : undefined
      const am = adAlloc[i]!
      return {
        id: a.id, asin: a.asin, sku: a.sku ?? p?.sku ?? null, productId: a.productId, status: a.status,
        name: p?.name ?? a.asin ?? a.sku ?? '—',
        photoUrl: p ? pickFaceImage(p.images) : null,
        impressions: am.impressions, clicks: am.clicks, spendCents: am.spendCents, salesCents: am.salesCents, orders: am.orders,
        acos: am.acos, roas: am.roas,
      }
    }).sort((a, b) => b.spendCents - a.spendCents)

    // Allocate the ad-group total across dates (Σ trend == ad group → chart == KPI).
    const trendShareOf = (r: { _sum: { impressions: number | null; clicks: number | null; costMicros: bigint | null; sales7dCents: number | null; sales14dCents: number | null; orders7d: number | null } }) => ({ impr: r._sum.impressions ?? 0, clicks: r._sum.clicks ?? 0, micros: Number(r._sum.costMicros ?? 0n), salesCents: (r._sum.sales7dCents ?? 0) + (r._sum.sales14dCents ?? 0), orders: r._sum.orders7d ?? 0 })
    const trendAlloc = allocateMetricsAcross(agMetrics, trendRaw, trendShareOf)
    const trend = trendRaw.map((r, i) => ({ date: r.date.toISOString().slice(0, 10), spendCents: trendAlloc[i]!.spendCents, salesCents: trendAlloc[i]!.salesCents, impressions: trendAlloc[i]!.impressions, clicks: trendAlloc[i]!.clicks, orders: trendAlloc[i]!.orders }))

    return {
      adGroup: {
        id: adGroup.id, name: adGroup.name, status: adGroup.status, defaultBidCents: adGroup.defaultBidCents,
        externalAdGroupId: adGroup.externalAdGroupId,
        campaign: adGroup.campaign,
        metrics: agMetrics,
        ads,
        targets: adGroup.targets,
        trend,
        windowDays,
        range: { preset: range.preset, startDate: range.sinceStr, endDate: range.untilStr, includesToday: range.includesToday },
        dataThrough: trendRaw.length ? trendRaw[trendRaw.length - 1]!.date.toISOString().slice(0, 10) : null,
      },
    }
    })
    if (!agPayload) { reply.code(404); return { error: 'not_found' } }
    reply.header('Cache-Control', 'private, max-age=20')
    return agPayload
  })

  // ── GET /advertising/fba-storage-age ────────────────────────────────
  fastify.get('/advertising/fba-storage-age', async (request, reply) => {
    const q = request.query as {
      marketplace?: string
      daysToLtsLte?: string
      bucket?: 'aging' | 'critical' | 'all'
      limit?: string
    }
    const limit = Math.min(Number(q.limit) || 200, 500)
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.daysToLtsLte != null && q.daysToLtsLte !== '') {
      where.daysToLtsThreshold = { lte: Number(q.daysToLtsLte), not: null }
    } else if (q.bucket === 'critical') {
      where.daysToLtsThreshold = { lte: 14, not: null }
    } else if (q.bucket === 'aging') {
      where.daysToLtsThreshold = { lte: 30, not: null }
    }

    // Per-SKU latest snapshot only (group by sku × marketplace, take max polledAt).
    // Cheap approximation: pull recent rows, dedupe in memory.
    const rows = await prisma.fbaStorageAge.findMany({
      where,
      orderBy: { polledAt: 'desc' },
      take: limit * 3,
      select: {
        id: true,
        productId: true,
        sku: true,
        asin: true,
        marketplace: true,
        polledAt: true,
        quantityInAge0_90: true,
        quantityInAge91_180: true,
        quantityInAge181_270: true,
        quantityInAge271_365: true,
        quantityInAge365Plus: true,
        currentStorageFeeCents: true,
        projectedLtsFee30dCents: true,
        projectedLtsFee60dCents: true,
        projectedLtsFee90dCents: true,
        daysToLtsThreshold: true,
      },
    })
    const seen = new Set<string>()
    const items: typeof rows = []
    for (const r of rows) {
      const k = `${r.sku}::${r.marketplace}`
      if (seen.has(k)) continue
      seen.add(k)
      items.push(r)
      if (items.length >= limit) break
    }
    reply.header('Cache-Control', 'private, max-age=120')
    return { items, count: items.length }
  })

  // ── GET /advertising/campaigns/:id/placements (AX.3) ────────────────
  // Placement-level performance + current bid adjustment % (from
  // Campaign.dynamicBidding). Read-only; placement WRITES land in AX.8.
  fastify.get('/advertising/campaigns/:id/placements', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { windowDays?: string }
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { externalCampaignId: true, dynamicBidding: true },
    })
    if (!campaign?.externalCampaignId) {
      reply.header('Cache-Control', 'private, max-age=60')
      return { placements: [] }
    }
    const rows = await prisma.amazonAdsPlacementReport.groupBy({
      by: ['placement'],
      where: { campaignId: campaign.externalCampaignId },
      _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
    })
    const db = (campaign.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }>; cpcCeiling?: { enabled?: boolean; multiple?: number } }
    const adj: Record<string, number> = {}
    for (const p of db.placementBidding ?? []) adj[p.placement] = p.percentage
    // Report rows carry Amazon's display placement names, but placementBidding is
    // keyed by the bidding-API enum — without this map the bias adjustment never
    // joins and the ladder shows 0% even when a bias IS set (see ads-top-of-search.service.ts:11).
    const REPORT_TO_BID_KEY: Record<string, string> = { 'Top of Search on-Amazon': 'PLACEMENT_TOP', 'Detail Page on-Amazon': 'PLACEMENT_PRODUCT_PAGE', 'Other on-Amazon': 'PLACEMENT_REST_OF_SEARCH' }
    const adjFor = (reportPlacement: string): number => adj[REPORT_TO_BID_KEY[reportPlacement] ?? reportPlacement] ?? adj[reportPlacement] ?? 0
    // CD/CPC — surface the CPC-ceiling guardrail config (read-modify-written by
    // PATCH /campaigns/:id/cpc-ceiling; enforced on ad-target bid writes).
    const cpcCeiling = { enabled: db.cpcCeiling?.enabled ?? false, multiple: db.cpcCeiling?.multiple ?? 1.5 }

    // CD.7 — optional per-placement daily spend trend (windowDays). One extra
    // groupBy over the placement report; aligned to a fixed date axis so each
    // placement series is the same length.
    let trend: { axis: string[]; series: Record<string, number[]> } | null = null
    if (q.windowDays) {
      const windowDays = Math.max(7, Math.min(90, Number(q.windowDays)))
      const since = new Date()
      since.setUTCDate(since.getUTCDate() - (windowDays - 1))
      since.setUTCHours(0, 0, 0, 0)
      const tr = await prisma.amazonAdsPlacementReport.groupBy({
        by: ['placement', 'date'],
        where: { campaignId: campaign.externalCampaignId, date: { gte: since } },
        _sum: { costMicros: true },
      })
      const axis: string[] = []
      for (let i = 0; i < windowDays; i++) { const d = new Date(since); d.setUTCDate(since.getUTCDate() + i); axis.push(d.toISOString().slice(0, 10)) }
      const idx = new Map(axis.map((d, i) => [d, i]))
      const series: Record<string, number[]> = {}
      for (const r of tr) {
        const k = r.date.toISOString().slice(0, 10); const i = idx.get(k); if (i == null) continue
        if (!series[r.placement]) series[r.placement] = new Array(windowDays).fill(0)
        series[r.placement]![i] = microsToCents(r._sum.costMicros) // cents
      }
      trend = { axis, series }
    }

    reply.header('Cache-Control', 'private, max-age=60')
    return {
      placements: rows.map((r) => ({
        placement: r.placement,
        impressions: r._sum.impressions ?? 0,
        clicks: r._sum.clicks ?? 0,
        costMicros: (r._sum.costMicros ?? 0n).toString(),
        sales7dCents: r._sum.sales7dCents ?? 0,
        orders7d: r._sum.orders7d ?? 0,
        adjustmentPct: adjFor(r.placement),
      })),
      cpcCeiling,
      ...(trend ? { trend } : {}),
    }
  })

  // ── PATCH placement bid adjustments (AX2.2) ─────────────────────────
  fastify.patch('/advertising/campaigns/:id/placements', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as { adjustments?: Array<{ placement: string; percentage: number }>; biddingStrategy?: string }
    if (!Array.isArray(b?.adjustments)) { reply.status(400); return { error: 'adjustments[] required' } }
    const { updatePlacementBidding } = await import('../services/advertising/ads-create.service.js')
    try { return await updatePlacementBidding({ campaignId: id, adjustments: b.adjustments, biddingStrategy: b.biddingStrategy as never }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── CPC-ceiling guardrail config (Pacvue-parity) ────────────────────
  // Read-modify-writes Campaign.dynamicBidding.cpcCeiling. Enforced at the
  // ad-target bid-write routes below: a requested bid is clamped to
  // `multiple × the target's historical CPC`. Caps Amazon's dynamic bidding
  // from running effective CPCs far above the seller's norm.
  fastify.patch('/advertising/campaigns/:id/cpc-ceiling', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as { enabled?: boolean; multiple?: number }
    const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
    if (!c) { reply.status(404); return { error: 'campaign not found' } }
    const db = (c.dynamicBidding ?? {}) as Record<string, unknown>
    const multiple = b.multiple != null ? Math.max(1, Math.min(10, Number(b.multiple))) : 1.5
    db.cpcCeiling = { enabled: !!b.enabled, multiple }
    await prisma.campaign.update({ where: { id }, data: { dynamicBidding: db as never } })
    return { ok: true, cpcCeiling: db.cpcCeiling }
  })

  // ── Self-competition (RC2.R8) — other campaigns in the SAME market that
  // advertise the SAME ASIN as this campaign. They compete in the same auction
  // (only the highest-eligible bid serves), so this flags accidental
  // cannibalisation. Read-only.
  fastify.get('/advertising/campaigns/:id/self-competition', async (request, reply) => {
    const { id } = request.params as { id: string }
    const camp = await prisma.campaign.findUnique({ where: { id }, select: { marketplace: true } })
    if (!camp) { reply.status(404); return { error: 'campaign not found' } }
    const myAds = await prisma.adProductAd.findMany({ where: { adGroup: { campaignId: id }, asin: { not: null } }, select: { asin: true } })
    const asins = [...new Set(myAds.map((a) => a.asin).filter((x): x is string => !!x))]
    reply.header('Cache-Control', 'private, max-age=120')
    if (asins.length === 0) return { marketplace: camp.marketplace, asins: [], conflicts: [] }
    const others = await prisma.adProductAd.findMany({
      where: { asin: { in: asins }, adGroup: { campaign: { marketplace: camp.marketplace, id: { not: id }, status: 'ENABLED' } } },
      select: { asin: true, adGroup: { select: { campaign: { select: { id: true, name: true, status: true } } } } },
    })
    const byCamp = new Map<string, { campaignId: string; name: string; status: string; asins: Set<string> }>()
    for (const o of others) {
      const c = o.adGroup?.campaign
      if (!c || !o.asin) continue
      let g = byCamp.get(c.id)
      if (!g) { g = { campaignId: c.id, name: c.name, status: c.status, asins: new Set() }; byCamp.set(c.id, g) }
      g.asins.add(o.asin)
    }
    const conflicts = [...byCamp.values()]
      .map((g) => ({ campaignId: g.campaignId, name: g.name, status: g.status, asins: [...g.asins] }))
      .sort((a, b) => b.asins.length - a.asins.length)
    return { marketplace: camp.marketplace, asins, conflicts }
  })

  // ── GET /advertising/campaigns/:id/keyword-conflicts (RC3.2) ───────────
  // Cross-product keyword-rank collisions: DIFFERENT products of ours bidding on
  // the SAME keyword, fighting for the same Top-of-search slot. Returns, per
  // contested keyword, every contender (mine + rivals) with bid/efficiency/ToS
  // intent and a recommended champion. Read-only; resolutions are gated writes.
  fastify.get('/advertising/campaigns/:id/keyword-conflicts', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { marketplace } = request.query as { marketplace?: string }
    const result = await detectKeywordConflicts(prisma, id, marketplace)
    if (!result) { reply.status(404); return { error: 'campaign not found' } }
    reply.header('Cache-Control', 'private, max-age=120')
    return result
  })

  // ── Product-family dayparting (RC2.T·product) ──────────────────────────
  // Resolve a campaign to its PARENT product family, the family's campaigns in
  // this market, and the family's roll-up order demand (when the product sells).
  // Drives ONE dayparting schedule applied across all the family's campaigns —
  // conversion timing is a product property, not a per-campaign one. Read-only.
  fastify.get('/advertising/campaigns/:id/product-dayparting', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { marketplace?: string; windowDays?: string }
    const camp = await prisma.campaign.findUnique({ where: { id }, select: { marketplace: true } })
    if (!camp) { reply.status(404); return { error: 'campaign not found' } }
    const marketplace = q.marketplace || camp.marketplace || undefined
    // Single source of truth: resolve campaign → parent family + the family's
    // campaigns (ASIN-centric, since AdProductAd.productId is often null).
    const { resolveProductFamily, blendedFamilyDemand, recommendRankWindows } = await import('../services/advertising/ads-dayparting-refresh.service.js')
    const fam = await resolveProductFamily({ campaignId: id, marketplace })
    reply.header('Cache-Control', 'private, max-age=120')
    if (!fam.parentProductId || fam.campaigns.length === 0) {
      return { marketplace, parentProductId: fam.parentProductId, parentName: fam.parentName, productIds: fam.productIds, asins: fam.asins, campaigns: fam.campaigns, demand: null }
    }
    const windowDays = q.windowDays ? Math.max(7, Math.min(365, Number(q.windowDays))) : 180
    const d = await blendedFamilyDemand(fam.productIds, fam.marketplace, windowDays, undefined, fam.skus)
    // RD.10f — RAW (the product's ACTUAL orders/revenue per cell) is the default so the
    // numbers are true + self-consistent. `smoothed` (market-blended) is an optional
    // overlay for sparse families. Recommendation derives from RAW so it matches what's shown.
    const recommended = recommendRankWindows(d.raw.weekdayProfile, d.raw.hourProfile)
    // RD.10g diag (?diag=1) — see how each match key counts the family's orders.
    let _diag: Record<string, unknown> | undefined
    if ((request.query as { diag?: string }).diag === '1') {
      const { aggregateOrdersDayparting } = await import('../services/advertising/orders-dayparting.service.js')
      const [byPid, bySku] = await Promise.all([
        aggregateOrdersDayparting({ channel: 'AMAZON', marketplace: fam.marketplace, productIds: fam.productIds, windowDays }),
        fam.skus.length ? aggregateOrdersDayparting({ channel: 'AMAZON', marketplace: fam.marketplace, skus: fam.skus, windowDays }) : Promise.resolve({ totals: { orders: 0 } }),
      ])
      _diag = { productCount: fam.productIds.length, skuCount: fam.skus.length, asinCount: fam.asins.length, sampleSkus: fam.skus.slice(0, 6), byProductId: byPid.totals.orders, bySku: bySku.totals.orders, combined: d.raw.totals.orders }
      // Reconcile vs Amazon's official Sales & Traffic report (= Seller Central) over the last 30d.
      try {
        const since = new Date(Date.now() - 30 * 86_400_000)
        const dsaWhere = (src: string) => ({ sku: { in: fam.skus }, channel: 'AMAZON', ...(fam.marketplace ? { marketplace: fam.marketplace } : {}), day: { gte: since }, source: src })
        const [rep, ord, ourDemand30] = await Promise.all([
          prisma.dailySalesAggregate.aggregate({ where: dsaWhere('AMAZON_REPORT'), _sum: { unitsSold: true, grossRevenue: true, ordersCount: true } }),
          prisma.dailySalesAggregate.aggregate({ where: dsaWhere('ORDER_ITEM'), _sum: { unitsSold: true, grossRevenue: true, ordersCount: true } }),
          aggregateOrdersDayparting({ channel: 'AMAZON', marketplace: fam.marketplace, productIds: fam.productIds, skus: fam.skus, windowDays: 30 }),
        ])
        _diag.reconcile30d = {
          amazonOfficialReport: { units: rep._sum.unitsSold ?? 0, revenueEur: Math.round(Number(rep._sum.grossRevenue ?? 0)), orders: rep._sum.ordersCount ?? 0 },
          orderItemAgg: { units: ord._sum.unitsSold ?? 0, revenueEur: Math.round(Number(ord._sum.grossRevenue ?? 0)), orders: ord._sum.ordersCount ?? 0 },
          ourDemand: { orders: ourDemand30.totals.orders, units: ourDemand30.totals.units, revenueEur: Math.round(ourDemand30.totals.revenueCents / 100) },
        }
      } catch (e) { _diag.reconcileError = (e as Error).message }
    }
    return {
      marketplace: fam.marketplace ?? marketplace, parentProductId: fam.parentProductId, parentName: fam.parentName, productIds: fam.productIds, asins: fam.asins,
      campaigns: fam.campaigns,
      demand: { totals: d.raw.totals, hourProfile: d.raw.hourProfile, weekdayProfile: d.raw.weekdayProfile, grid: d.raw.grid, hasData: d.hasData, familyOrders: d.familyOrders, windowDays, timezone: d.timezone, metric: d.metric },
      smoothed: { totals: d.totals, hourProfile: d.hourProfile, weekdayProfile: d.weekdayProfile, grid: d.grid, blended: d.blended, timezone: d.timezone, metric: d.metric },
      recommended,
      ...(_diag ? { _diag } : {}),
    }
  })

  // ── Apex A.2a: per-campaign bid guardrails (max-change-% + writes/day) ──
  // Stored in dynamicBidding JSON alongside cpcCeiling. maxBidChangePct clamps
  // how far any single bid move (manual/bulk/automation) can swing from the
  // current bid; maxWritesPerDay caps live writes per UTC day (gate-enforced).
  // Pass 0/null to clear a cap.
  fastify.patch('/advertising/campaigns/:id/guardrails', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as { maxBidChangePct?: number | null; maxWritesPerDay?: number | null }
    const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
    if (!c) { reply.status(404); return { error: 'campaign not found' } }
    const db = (c.dynamicBidding ?? {}) as Record<string, unknown>
    if (b.maxBidChangePct !== undefined) {
      const pct = b.maxBidChangePct == null ? 0 : Math.max(0, Math.min(500, Number(b.maxBidChangePct)))
      if (pct > 0) db.maxBidChangePct = pct
      else delete db.maxBidChangePct
    }
    if (b.maxWritesPerDay !== undefined) {
      const n = b.maxWritesPerDay == null ? 0 : Math.max(0, Math.min(10000, Math.round(Number(b.maxWritesPerDay))))
      if (n > 0) db.maxWritesPerDay = n
      else delete db.maxWritesPerDay
    }
    await prisma.campaign.update({ where: { id }, data: { dynamicBidding: db as never } })
    return { ok: true, maxBidChangePct: db.maxBidChangePct ?? null, maxWritesPerDay: db.maxWritesPerDay ?? null }
  })

  // ── CBN.2h.6: Bid Automation + Target ACoS (Ad Manager Bulk Actions) ────
  // Local automation settings stored in dynamicBidding (NOT pushed to Amazon —
  // these drive our own bid-optimizer, which reads dynamicBidding.targetAcos).
  // targetAcos is a fraction (0.3 = 30%), matching the optimizer's read shape.
  // Same read-modify-write pattern as /cpc-ceiling and /guardrails.
  fastify.patch('/advertising/campaigns/:id/automation', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as { bidAutomation?: boolean; targetAcos?: number | null }
    const c = await prisma.campaign.findUnique({ where: { id }, select: { dynamicBidding: true } })
    if (!c) { reply.status(404); return { error: 'campaign not found' } }
    const db = (c.dynamicBidding ?? {}) as Record<string, unknown>
    if (b.bidAutomation !== undefined) db.bidAutomation = !!b.bidAutomation
    if (b.targetAcos !== undefined) {
      if (b.targetAcos == null) delete db.targetAcos
      else db.targetAcos = Math.max(0, Math.min(5, Number(b.targetAcos))) // fraction; clamp 0–500%
    }
    await prisma.campaign.update({ where: { id }, data: { dynamicBidding: db as never } })
    return { ok: true, bidAutomation: db.bidAutomation ?? false, targetAcos: db.targetAcos ?? null }
  })

  // ── Apex A.2a: per-campaign live-write allowlist toggle ─────────────────
  // DEFAULT-DENY containment for the cautious cutover. Even with the deploy
  // flag + connection writes enabled, the write-gate refuses live bid/state
  // mutations to this campaign until enabled here. Toggling OFF stops future
  // live writes immediately (in-flight grace-window rows still re-check on run).
  fastify.patch('/advertising/campaigns/:id/live-writes', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as { enabled?: boolean }
    const c = await prisma.campaign.findUnique({ where: { id }, select: { id: true, name: true } })
    if (!c) { reply.status(404); return { error: 'campaign not found' } }
    const enabled = !!b.enabled
    await prisma.campaign.update({ where: { id }, data: { liveBidWritesEnabled: enabled } })
    logger.warn('[ADS-LIVE-ALLOWLIST]', {
      campaignId: id,
      name: c.name,
      enabled,
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
    })
    return { ok: true, campaignId: id, liveBidWritesEnabled: enabled }
  })

  // MM.2 — bulk live-write allowlist for a whole marketplace (or an explicit set), so an
  // operator taking a market live doesn't flip dozens of campaigns one-by-one. Flips the
  // per-campaign allowlist only; the connection gate (mode=production + writesEnabledAt)
  // still independently governs whether anything actually reaches Amazon.
  fastify.post('/advertising/campaigns/live-writes/bulk', async (request, reply) => {
    const b = request.body as { marketplace?: string; enabled?: boolean; campaignIds?: string[] }
    const enabled = !!b.enabled
    if (!b.marketplace && !(b.campaignIds && b.campaignIds.length)) { reply.status(400); return { error: 'marketplace or campaignIds required' } }
    const where = b.campaignIds?.length ? { id: { in: b.campaignIds } } : { marketplace: b.marketplace }
    const r = await prisma.campaign.updateMany({ where, data: { liveBidWritesEnabled: enabled } })
    logger.warn('[ADS-LIVE-ALLOWLIST-BULK]', { marketplace: b.marketplace, campaignIds: b.campaignIds?.length, enabled, count: r.count, actor: actorFromHeaders(request.headers as Record<string, unknown>) })
    return { ok: true, count: r.count, enabled }
  })

  // CB.5 — guided Campaign Builder launch. dryRun=true returns the PLAN (what would be
  // created) without writing; dryRun=false creates SP campaigns + ad groups + product ads
  // + keywords through the gated create primitives (real only on a live+gate-open market,
  // local/sandbox otherwise; new campaigns are NOT auto-allowlisted, so their bids can't
  // change until the operator opts them in). Preview-then-create per operator choice.
  fastify.post('/advertising/campaign-builder/launch', async (request, reply) => {
    const b = request.body as {
      market?: string; productGroupName?: string; bidStrategy?: string; defaultBidEur?: number; dailyBudgetEur?: number
      asins?: string[]; includeProductTarget?: boolean; keywords?: Array<{ text: string; match?: string; bid?: number }>; dryRun?: boolean
    }
    const market = b.market || 'IT'
    const grp = (b.productGroupName || 'Guided campaign').trim()
    const asins = (b.asins ?? []).filter(Boolean)
    if (!asins.length) { reply.status(400); return { error: 'no products selected' } }
    const bid = b.defaultBidEur ?? 0.45
    const budget = b.dailyBudgetEur ?? 25
    const biddingStrategy: 'legacyForSales' | 'autoForSales' | 'manual' = b.bidStrategy === 'maxOrders' ? 'autoForSales' : 'legacyForSales'
    const roles: Array<{ role: string; targeting: 'AUTO' | 'MANUAL'; keywords: boolean }> = [
      { role: 'Auto', targeting: 'AUTO', keywords: false },
      { role: 'Research', targeting: 'MANUAL', keywords: true },
      { role: 'Performance', targeting: 'MANUAL', keywords: true },
      ...(b.includeProductTarget ? [{ role: 'Product Target', targeting: 'MANUAL' as const, keywords: false }] : []),
    ]
    const kws = b.keywords ?? []
    const plan = {
      market,
      campaigns: roles.map((r) => ({ name: `${grp} - SP - ${r.role}`, adGroup: `${grp} - SP - ${r.role} Ad Group`, targeting: r.targeting, productAds: asins.length, keywords: r.keywords ? kws.length : 0 })),
      totalCampaigns: roles.length, totalProductAds: asins.length * roles.length, totalKeywords: kws.filter(() => true).length * roles.filter((r) => r.keywords).length,
    }
    if (b.dryRun) return { ok: true, dryRun: true, plan }

    const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal } = await import('../services/advertising/ads-create.service.js')
    const created: Array<{ role: string; campaignId: string; externalCampaignId: string | null; mode: string }> = []
    let mode = 'local'
    for (const r of roles) {
      try {
        const camp = await createCampaignLocal({ name: `${grp} - SP - ${r.role}`, type: 'SP', marketplace: market, targetingType: r.targeting, dailyBudgetEur: budget, biddingStrategy })
        mode = camp.mode
        const ag = await createAdGroupLocal({ campaignId: camp.id, name: `${grp} - SP - ${r.role} Ad Group`, defaultBidEur: bid })
        for (const asin of asins) { try { await createProductAdLocal({ adGroupId: ag.id, asin }) } catch (e) { logger.warn('[CB-launch] product ad failed', { asin, error: (e as Error).message }) } }
        if (r.keywords) for (const k of kws) { try { await createKeywordLocal({ adGroupId: ag.id, keywordText: k.text, matchType: ((k.match || 'Broad').toUpperCase() as 'EXACT' | 'PHRASE' | 'BROAD'), bidEur: k.bid ?? bid }) } catch (e) { logger.warn('[CB-launch] keyword failed', { kw: k.text, error: (e as Error).message }) } }
        created.push({ role: r.role, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, mode: camp.mode })
      } catch (e) { logger.error('[CB-launch] campaign create failed', { role: r.role, market, error: (e as Error).message }) }
    }
    logger.warn('[CB-launch] guided builder created campaigns', { market, grp, created: created.length, mode, actor: actorFromHeaders(request.headers as Record<string, unknown>) })
    return { ok: true, created, mode, plan }
  })

  // ── SPW.7: SP Super Wizard launch ───────────────────────────────────────
  // Creates the wizard's generated campaigns + ad groups + product ads +
  // keyword/product targeting + negatives + placement bid multiplier, all via
  // the local-first create service — nothing hits Amazon unless a per-campaign
  // live-write gate is open (gated create, no live push). The UI redirects to
  // the Ad Manager grid on success. dryRun returns the plan without writing.
  fastify.post('/advertising/campaign-builder/sp-super-wizard/launch', async (request, reply) => {
    type PRef = { asin?: string; sku?: string; productId?: string }
    type SpwRule = { ruleName?: string; automate?: boolean; perf?: { conditions?: Array<{ metric?: string; op?: string; value?: string }>; lookback?: string; exclude?: string }; rows?: Record<string, { st?: boolean; tB?: boolean; tP?: boolean; tE?: boolean; tBox?: boolean; nP?: boolean; nE?: boolean; nBox?: boolean }> }
    const b = request.body as {
      market?: string; productGroupName?: string
      products?: PRef[]
      campaigns?: Array<{ id?: string; name: string; adGroupName?: string; kind: 'auto' | 'keyword' | 'pat'; adProduct?: 'SP' | 'SB' | 'SD'; matchType?: string; bidEur?: number; budgetEur?: number; keywords?: string[]; productTargets?: PRef[]; negKeywords?: Array<string | { text?: string; matchType?: 'EXACT' | 'PHRASE' }>; negProducts?: PRef[]; autoGroups?: Array<{ key: string; enabled?: boolean; bidEur?: number }>; creative?: Record<string, unknown> }>
      placementBids?: { tos?: string; pdp?: string; ros?: string }
      rules?: { harvest?: SpwRule; negative?: SpwRule }
      automationMode?: 'rule' | 'ai'
      bidConfig?: { strategy?: string; targetAcos?: string; minBid?: string; maxBid?: string }
      portfolioId?: string
      dryRun?: boolean
    }
    const market = b.market || 'IT'
    const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
    const campaigns = (b.campaigns ?? []).filter((c) => c && c.name)
    if (!campaigns.length) { reply.status(400); return { error: 'no campaigns to create' } }
    if (b.dryRun) return { ok: true, dryRun: true, plan: { market, totalCampaigns: campaigns.length, totalProductAds: products.length * campaigns.length } }

    const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal, createTargetLocal, createNegativeProductTargetLocal, createNegativeKeywordLocal, updatePlacementBidding } = await import('../services/advertising/ads-create.service.js')
    const userId = actorFromHeaders(request.headers as Record<string, unknown>)
    const matchTypesFor = (m?: string): Array<'BROAD' | 'PHRASE' | 'EXACT'> => {
      const u = (m || '').toLowerCase()
      if (u.includes('&')) return ['BROAD', 'PHRASE', 'EXACT']
      if (u.includes('phrase')) return ['PHRASE']
      if (u.includes('exact')) return ['EXACT']
      return ['BROAD']
    }
    const pb = b.placementBids ?? {}
    const adjustments = ([['PLACEMENT_TOP', pb.tos], ['PLACEMENT_PRODUCT_PAGE', pb.pdp], ['PLACEMENT_REST_OF_SEARCH', pb.ros]] as Array<[string, string | undefined]>)
      .flatMap(([placement, v]) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? [{ placement, percentage: n }] : [] })

    const created: Array<{ name: string; campaignId: string; externalCampaignId: string | null; mode: string }> = []
    const idMap: Record<string, { campaignId: string; adGroupId: string }> = {} // wizard campaign id → created ids (for the harvest rule)
    for (const c of campaigns) {
      try {
        const bidEur = Number(c.bidEur) || 0.75
        const budgetEur = Number(c.budgetEur) || 10
        const camp = await createCampaignLocal({ name: c.name, type: c.adProduct ?? 'SP', marketplace: market, targetingType: c.kind === 'auto' ? 'AUTO' : 'MANUAL', dailyBudgetEur: budgetEur, biddingStrategy: 'legacyForSales', portfolioId: b.portfolioId, userId })
        // SB creative (brand · ad type · landing page · ASINs · headline · logo/custom image) → Campaign.creativeAssetJson (gated; pushed to Amazon when the SB write gate opens).
        if (c.creative && c.adProduct === 'SB') { try { await prisma.campaign.update({ where: { id: camp.id }, data: { creativeAssetJson: c.creative as never } }) } catch (e) { logger.warn('[SPW-launch] SB creative store failed', { error: (e as Error).message }) } }
        const ag = await createAdGroupLocal({ campaignId: camp.id, name: c.adGroupName || `${c.name} Ad Group`, defaultBidEur: bidEur, userId })
        if (c.id) idMap[c.id] = { campaignId: camp.id, adGroupId: ag.id }
        for (const p of products) { try { await createProductAdLocal({ adGroupId: ag.id, asin: p.asin, sku: p.sku, productId: p.productId, userId }) } catch (e) { logger.warn('[SPW-launch] product ad failed', { error: (e as Error).message }) } }
        if (c.kind === 'keyword') {
          for (const kw of c.keywords ?? []) for (const mt of matchTypesFor(c.matchType)) { try { await createKeywordLocal({ adGroupId: ag.id, keywordText: kw, matchType: mt, bidEur, userId }) } catch (e) { logger.warn('[SPW-launch] keyword failed', { kw, error: (e as Error).message }) } }
        } else if (c.kind === 'pat') {
          for (const pt of c.productTargets ?? []) { const asin = pt.asin || pt.sku; if (!asin) continue; try { await createTargetLocal({ adGroupId: ag.id, kind: 'PRODUCT', value: asin, bidEur, userId }) } catch (e) { logger.warn('[SPW-launch] product target failed', { error: (e as Error).message }) } }
        } else if (c.kind === 'auto') {
          // AT.1 — the 4 Amazon auto-targeting groups, each with its own bid + state.
          for (const g of c.autoGroups ?? []) { if (!g?.key) continue; try { await createTargetLocal({ adGroupId: ag.id, kind: 'AUTO', value: g.key, bidEur: Number(g.bidEur) || bidEur, state: g.enabled === false ? 'paused' : 'enabled', userId }) } catch (e) { logger.warn('[SPW-launch] auto group failed', { key: g.key, error: (e as Error).message }) } }
        }
        for (const nk of c.negKeywords ?? []) { const text = (typeof nk === 'string' ? nk : nk?.text ?? '').trim(); if (!text) continue; const mt: 'EXACT' | 'PHRASE' = (typeof nk === 'object' && nk?.matchType === 'PHRASE') ? 'PHRASE' : 'EXACT'; try { await createNegativeKeywordLocal({ adGroupId: ag.id, keywordText: text, matchType: mt, userId }) } catch (e) { logger.warn('[SPW-launch] neg keyword failed', { error: (e as Error).message }) } }
        for (const np of c.negProducts ?? []) { const asin = np.asin || np.sku; if (!asin) continue; try { await createNegativeProductTargetLocal({ adGroupId: ag.id, asin, userId }) } catch (e) { logger.warn('[SPW-launch] neg product failed', { error: (e as Error).message }) } }
        if (adjustments.length) { try { await updatePlacementBidding({ campaignId: camp.id, adjustments, userId }) } catch (e) { logger.warn('[SPW-launch] placement failed', { error: (e as Error).message }) } }
        created.push({ name: c.name, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, mode: camp.mode })
      } catch (e) { logger.error('[SPW-launch] campaign create failed', { name: c.name, market, error: (e as Error).message }) }
    }
    // AT.4a — persist the Step-3 harvesting rule as an AutomationRule (domain advertising)
    // so it survives launch instead of being thrown away. The matrix (which ad groups to
    // harvest from + which match types to graduate/negate, incl. the Auto campaign's groups)
    // is encoded in the action's `sources`; the harvest engine honours scoping in AT.4b.
    // Gated: dryRun stays true (the rule proposes via the engine) until the live gate opens.
    // S3.4 — two separate rules: Keyword Harvesting + Negative Targeting.
    const rulesCreated: Array<{ id: string; name: string }> = []
    // H.2 — destination map for keyword graduation: matchType → the ad group of the keyword campaign
    // that hosts that match type in this product group (e.g. EXACT → the Exact campaign). A harvested
    // winner promotes there instead of back into its source ad group. Built from the campaigns just
    // created above; empty if the group has no keyword campaigns (then graduation falls back to source).
    const destinations: Record<string, string> = {}
    for (const c of campaigns) {
      if (!c.id) continue
      const ref = idMap[c.id]
      if (!ref) continue
      if (c.kind === 'keyword') { for (const mt of matchTypesFor(c.matchType)) destinations[mt] = ref.adGroupId }
      else if (c.kind === 'pat') destinations.PRODUCT = ref.adGroupId // H.5 — converting ASINs graduate into the PAT campaign
    }
    const buildRule = async (rcfg: SpwRule | undefined, kind: 'harvest' | 'negative') => {
      if (!rcfg) return
      const sources = Object.entries(rcfg.rows ?? {})
        .map(([wid, r]) => {
          const ref = idMap[wid]
          if (!ref || !r) return null
          const graduate: string[] = []
          if (r.tB) graduate.push('BROAD'); if (r.tP) graduate.push('PHRASE'); if (r.tE) graduate.push('EXACT')
          const negate: string[] = []
          if (r.nP) negate.push('PHRASE'); if (r.nE) negate.push('EXACT')
          const any = r.st || graduate.length || negate.length || r.tBox || r.nBox
          return any ? { adGroupId: ref.adGroupId, campaignId: ref.campaignId, harvestFrom: !!r.st, graduate, negate, graduateProduct: !!r.tBox, negateProduct: !!r.nBox } : null
        })
        .filter((s): s is NonNullable<typeof s> => s != null)
      if (!((rcfg.ruleName ?? '').trim() || sources.length)) return
      try {
        const perf = rcfg.perf ?? {}
        const conds = perf.conditions ?? []
        const ordersC = conds.find((c) => c?.metric === 'PPC Orders' || c?.metric === 'Orders')
        const spendC = conds.find((c) => c?.metric === 'Spend')
        const minOrders = ordersC && Number.isFinite(Number(ordersC.value)) ? Number(ordersC.value) : 2
        const minSpendCents = spendC && Number.isFinite(Number(spendC.value)) ? Math.round(Number(spendC.value) * 100) : 1000
        const defaultName = `${(b.productGroupName || 'Campaign').trim()} — ${kind === 'negative' ? 'Negative Targeting' : 'Harvest & Negate'}`
        // H.4 — propose-first. control:'manual' makes the engine force dry-run and record each run as
        // an AdsRuleSuggestion the operator approves on /marketing/ads/suggestions (approving re-runs
        // it live, write-gated). No notify action — the suggestion card IS the notification, and a bare
        // notify would otherwise create a noise card. Flip to hands-off later by dropping control:'manual'
        // + setting dryRun:false + opening the write-gate.
        const actions = [
          { type: 'harvest_and_negate', control: 'manual', windowDays: 60, minSpendCents, minOrders, graduationBidEur: 0.5, sources, destinations, perfCriteria: perf, mode: kind },
        ]
        const rule = await prisma.automationRule.create({
          data: {
            name: ((rcfg.ruleName ?? '').trim() || defaultName).slice(0, 120),
            description: 'Created by SP Super Wizard', domain: 'advertising', trigger: 'SCHEDULE',
            conditions: [] as never, actions: actions as never,
            enabled: !!rcfg.automate, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? null,
          },
        })
        rulesCreated.push({ id: rule.id, name: rule.name })
        logger.warn('[SPW-launch] created rule', { ruleId: rule.id, kind, sources: sources.length, enabled: !!rcfg.automate })
      } catch (e) { logger.error('[SPW-launch] rule create failed', { kind, error: (e as Error).message }) }
    }
    if (created.length && b.rules) { await buildRule(b.rules.harvest, 'harvest'); await buildRule(b.rules.negative, 'negative') }

    // S3.5 — persist the chosen bid strategy as a bid-management rule scoped to the
    // new campaigns (Target ACoS → the bid_to_target_acos action; others stored
    // forward-looking). Gated dryRun. Skipped under AI Control / strategy None.
    if (created.length && b.automationMode === 'rule' && b.bidConfig?.strategy && b.bidConfig.strategy !== 'none') {
      try {
        const bc = b.bidConfig
        const minBidEur = Number(bc.minBid) || undefined
        const maxBidEur = Number(bc.maxBid) || undefined
        const campaignIds = created.map((c) => c.campaignId)
        const action = bc.strategy === 'targetAcos'
          ? { type: 'bid_to_target_acos', targetAcos: Number(bc.targetAcos) || 30, minBidEur, maxBidEur, campaignIds }
          : { type: 'set_bid_strategy', strategy: bc.strategy, minBidEur, maxBidEur, campaignIds }
        const label = bc.strategy === 'targetAcos' ? 'Target ACoS' : bc.strategy === 'maxImpressions' ? 'Max Impressions' : bc.strategy === 'maxOrders' ? 'Max Orders' : 'Custom'
        const rule = await prisma.automationRule.create({
          data: {
            name: `${(b.productGroupName || 'Campaign').trim()} — ${label} bidding`.slice(0, 120),
            description: 'Bid strategy from SP Super Wizard', domain: 'advertising', trigger: 'SCHEDULE',
            conditions: [] as never, actions: [action] as never,
            enabled: true, dryRun: true, maxExecutionsPerDay: 4, createdBy: userId ?? null,
          },
        })
        rulesCreated.push({ id: rule.id, name: rule.name })
        logger.warn('[SPW-launch] created bid-strategy rule', { ruleId: rule.id, strategy: bc.strategy })
      } catch (e) { logger.error('[SPW-launch] bid rule create failed', { error: (e as Error).message }) }
    }

    logger.warn('[SPW-launch] SP Super Wizard created campaigns', { market, grp: (b.productGroupName || '').trim(), count: created.length, rules: rulesCreated.length, actor: userId })
    return { ok: true, created, totalCampaigns: created.length, rules: rulesCreated }
  })

  // SB.7 — Single Campaign builder launch. Creates ONE SP campaign with PER-KEYWORD match
  // types + bids (richer than the SP Super Wizard's uniform model), the placement multiplier,
  // an optional Target-ACoS / strategy bid rule, and an optional inline Negative-Targeting
  // rule. Same gated local-first create path (no Amazon push unless the write gate is open).
  fastify.post('/advertising/campaign-builder/single/launch', async (request, reply) => {
    type PRef = { asin?: string; sku?: string; productId?: string }
    const b = request.body as {
      market?: string; name?: string; adGroupName?: string; portfolioId?: string
      biddingStrategy?: 'down' | 'updown' | 'fixed'; sites?: 'amazon' | 'business'
      placementBids?: { tos?: string; pdp?: string; ros?: string }
      bidBoosts?: { video?: boolean; amazonBusiness?: boolean; amazonBusinessPct?: string; audience?: boolean }
      products?: PRef[]; sponsoredVideoAsins?: string[]; budgetEur?: number; defaultBidEur?: number
      bidConfig?: { strategy?: string; targetAcos?: string; minBid?: string; maxBid?: string }
      targetMode?: 'keyword' | 'product'
      keywords?: Array<{ text?: string; matchType?: 'BROAD' | 'PHRASE' | 'EXACT'; bidEur?: number }>
      negKeywords?: Array<{ text?: string; matchType?: 'EXACT' | 'PHRASE' }>
      productTargets?: PRef[]; negProducts?: PRef[]
      addNegativeRule?: boolean; attachRuleIds?: string[]; autoBidAdjust?: boolean; dryRun?: boolean
    }
    const market = b.market || 'IT'
    const name = (b.name || '').trim()
    if (!name) { reply.status(400); return { ok: false, error: 'campaign name required' } }
    const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
    const defaultBidEur = Number(b.defaultBidEur) || 0.75
    const budgetEur = Number(b.budgetEur) || 10
    if (b.dryRun) return { ok: true, dryRun: true, plan: { market, name, products: products.length, keywords: (b.keywords ?? []).length } }

    const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, createProductAdLocal, createTargetLocal, createNegativeProductTargetLocal, createNegativeKeywordLocal, updatePlacementBidding } = await import('../services/advertising/ads-create.service.js')
    const userId = actorFromHeaders(request.headers as Record<string, unknown>)
    const biddingStrategy: 'legacyForSales' | 'autoForSales' | 'manual' = b.biddingStrategy === 'updown' ? 'autoForSales' : b.biddingStrategy === 'fixed' ? 'manual' : 'legacyForSales'
    const rulesCreated: Array<{ id: string; name: string }> = []
    try {
      const camp = await createCampaignLocal({ name, type: 'SP', marketplace: market, targetingType: 'MANUAL', dailyBudgetEur: budgetEur, biddingStrategy, portfolioId: b.portfolioId, userId })
      const ag = await createAdGroupLocal({ campaignId: camp.id, name: (b.adGroupName || '').trim() || `${name} Ad Group`, defaultBidEur, userId })
      for (const p of products) { try { await createProductAdLocal({ adGroupId: ag.id, asin: p.asin, sku: p.sku, productId: p.productId, userId }) } catch (e) { logger.warn('[single-launch] product ad failed', { error: (e as Error).message }) } }
      if ((b.targetMode ?? 'keyword') === 'product') {
        for (const pt of b.productTargets ?? []) { const asin = pt.asin || pt.sku; if (!asin) continue; try { await createTargetLocal({ adGroupId: ag.id, kind: 'PRODUCT', value: asin, bidEur: defaultBidEur, userId }) } catch (e) { logger.warn('[single-launch] product target failed', { error: (e as Error).message }) } }
      } else {
        for (const kw of b.keywords ?? []) { const text = (kw?.text || '').trim(); if (!text) continue; const mt: 'BROAD' | 'PHRASE' | 'EXACT' = kw.matchType === 'PHRASE' ? 'PHRASE' : kw.matchType === 'EXACT' ? 'EXACT' : 'BROAD'; try { await createKeywordLocal({ adGroupId: ag.id, keywordText: text, matchType: mt, bidEur: Number(kw.bidEur) || defaultBidEur, userId }) } catch (e) { logger.warn('[single-launch] keyword failed', { error: (e as Error).message }) } }
      }
      for (const nk of b.negKeywords ?? []) { const text = (nk?.text || '').trim(); if (!text) continue; const mt: 'EXACT' | 'PHRASE' = nk.matchType === 'PHRASE' ? 'PHRASE' : 'EXACT'; try { await createNegativeKeywordLocal({ adGroupId: ag.id, keywordText: text, matchType: mt, userId }) } catch (e) { logger.warn('[single-launch] neg keyword failed', { error: (e as Error).message }) } }
      for (const np of b.negProducts ?? []) { const asin = np.asin || np.sku; if (!asin) continue; try { await createNegativeProductTargetLocal({ adGroupId: ag.id, asin, userId }) } catch (e) { logger.warn('[single-launch] neg product failed', { error: (e as Error).message }) } }
      const pb = b.placementBids ?? {}
      const adjustments = ([['PLACEMENT_TOP', pb.tos], ['PLACEMENT_PRODUCT_PAGE', pb.pdp], ['PLACEMENT_REST_OF_SEARCH', pb.ros]] as Array<[string, string | undefined]>)
        .flatMap(([placement, v]) => { const n = Number(v); return v && Number.isFinite(n) && n > 0 ? [{ placement, percentage: n }] : [] })
      if (adjustments.length) { try { await updatePlacementBidding({ campaignId: camp.id, adjustments, userId }) } catch (e) { logger.warn('[single-launch] placement failed', { error: (e as Error).message }) } }

      // #1/#3/#4 — persist Sponsored-Video opt-ins, Sites reach, and the video/AB/audience bid
      // boosts onto the campaign's dynamicBidding config (preserves the placementBidding just
      // written). Forward-looking: applied to Amazon when the v3 boost write-path opens (same gate).
      const svAsins = (b.sponsoredVideoAsins ?? []).filter(Boolean)
      const boosts = b.bidBoosts ?? {}
      const wantBoost = !!(boosts.video || boosts.amazonBusiness || boosts.audience)
      if (svAsins.length || b.sites === 'business' || wantBoost) {
        try {
          const cur = await prisma.campaign.findUnique({ where: { id: camp.id }, select: { dynamicBidding: true } })
          const dyn = (cur?.dynamicBidding && typeof cur.dynamicBidding === 'object' ? cur.dynamicBidding : {}) as Record<string, unknown>
          await prisma.campaign.update({ where: { id: camp.id }, data: { dynamicBidding: {
            ...dyn,
            ...(b.sites ? { sites: b.sites } : {}),
            ...(svAsins.length ? { sponsoredVideoAsins: svAsins } : {}),
            ...(wantBoost ? { bidBoosts: { video: !!boosts.video, amazonBusiness: !!boosts.amazonBusiness, amazonBusinessPct: Number(boosts.amazonBusinessPct) || undefined, audience: !!boosts.audience } } : {}),
          } as never } })
        } catch (e) { logger.warn('[single-launch] config merge failed', { error: (e as Error).message }) }
      }

      // #2 — attach this campaign to existing rules: append its id to each rule action's
      // campaignIds / sources so the Rules engine evaluates it too (read+extend, never rebuild).
      let attachedCount = 0
      for (const ruleId of (b.attachRuleIds ?? [])) {
        try {
          const rule = await prisma.automationRule.findUnique({ where: { id: ruleId }, select: { id: true, actions: true, domain: true } })
          if (!rule || rule.domain !== 'advertising') continue
          const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<Record<string, unknown>>
          let touched = false
          for (const a of actions) {
            if (Array.isArray(a.campaignIds) && !(a.campaignIds as string[]).includes(camp.id)) { (a.campaignIds as string[]).push(camp.id); touched = true }
            if (Array.isArray(a.sources) && !(a.sources as Array<{ campaignId?: string }>).some((s) => s?.campaignId === camp.id)) { (a.sources as unknown[]).push({ adGroupId: ag.id, campaignId: camp.id, harvestFrom: true, graduate: [], negate: [] }); touched = true }
          }
          if (touched) { await prisma.automationRule.update({ where: { id: ruleId }, data: { actions: actions as never } }); attachedCount++ }
        } catch (e) { logger.warn('[single-launch] attach rule failed', { ruleId, error: (e as Error).message }) }
      }

      if (b.bidConfig?.strategy && b.bidConfig.strategy !== 'none') {
        try {
          const bc = b.bidConfig
          const minBidEur = Number(bc.minBid) || undefined
          const maxBidEur = Number(bc.maxBid) || undefined
          const action = bc.strategy === 'targetAcos'
            ? { type: 'bid_to_target_acos', targetAcos: Number(bc.targetAcos) || 30, minBidEur, maxBidEur, campaignIds: [camp.id] }
            : { type: 'set_bid_strategy', strategy: bc.strategy, minBidEur, maxBidEur, campaignIds: [camp.id] }
          const label = bc.strategy === 'targetAcos' ? 'Target ACoS' : bc.strategy === 'maxImpressions' ? 'Max Impressions' : bc.strategy === 'maxOrders' ? 'Max Orders' : 'Custom'
          const rule = await prisma.automationRule.create({ data: { name: `${name} — ${label} bidding`.slice(0, 120), description: 'Bid strategy from Single Campaign builder', domain: 'advertising', trigger: 'SCHEDULE', conditions: [] as never, actions: [action] as never, enabled: !!b.autoBidAdjust, dryRun: true, maxExecutionsPerDay: 4, createdBy: userId ?? null } })
          rulesCreated.push({ id: rule.id, name: rule.name })
        } catch (e) { logger.error('[single-launch] bid rule failed', { error: (e as Error).message }) }
      }
      if (b.addNegativeRule) {
        try {
          const rule = await prisma.automationRule.create({ data: { name: `${name} — Negative Targeting`.slice(0, 120), description: 'Negative rule from Single Campaign builder', domain: 'advertising', trigger: 'SCHEDULE', conditions: [] as never, actions: [{ type: 'harvest_and_negate', control: 'manual', mode: 'negative', windowDays: 60, minSpendCents: 1000, minOrders: 0, sources: [{ adGroupId: ag.id, campaignId: camp.id, harvestFrom: true, graduate: [], negate: ['EXACT'] }], destinations: {} }] as never, enabled: true, dryRun: true, maxExecutionsPerDay: 3, createdBy: userId ?? null } })
          rulesCreated.push({ id: rule.id, name: rule.name })
        } catch (e) { logger.error('[single-launch] negative rule failed', { error: (e as Error).message }) }
      }
      logger.warn('[single-launch] created campaign', { market, name, campaignId: camp.id, rules: rulesCreated.length, attached: attachedCount, actor: userId })
      return { ok: true, campaignId: camp.id, externalCampaignId: camp.externalCampaignId, rules: rulesCreated, attached: attachedCount }
    } catch (e) {
      logger.error('[single-launch] failed', { name, market, error: (e as Error).message })
      reply.status(500); return { ok: false, error: (e as Error).message }
    }
  })

  // ── AT.3 — suggested bid per Auto-targeting group (READ; works pre-launch + while
  // writes are gated). Anchored to the account's OWN median CPC (data-grounded, via
  // ads-bid-suggest), scaled by the same intent multipliers as the smart defaults. ──
  fastify.get('/advertising/campaign-builder/auto-bid-suggestions', async (request) => {
    const market = (request.query as { market?: string })?.market || 'IT'
    const { suggestBids } = await import('../services/advertising/ads-bid-suggest.service.js')
    const base = await suggestBids({ keywords: [], marketplace: market })
    const baseCents = base.defaultBidCents
    const MULT: Record<string, number> = { CLOSE_MATCH: 1.0, SUBSTITUTES: 1.1, LOOSE_MATCH: 0.65, COMPLEMENTS: 0.6 }
    const groups = Object.fromEntries(Object.entries(MULT).map(([k, m]) => [k, Math.max(5, Math.round(baseCents * m))]))
    return { ok: true, baseCents, accountMedianCpcCents: base.accountMedianCpcCents, groups }
  })

  // ── Apex A.2a: preview pending live writes for a campaign ───────────────
  // Shows exactly what would hit Amazon before the grace window expires: each
  // queued mutation's resolved external id + field changes + a request sketch,
  // plus a live gate-decision dry-run so the operator can see allow/deny and
  // why. Read-only — does not send anything.
  fastify.get('/advertising/campaigns/:id/pending-writes', async (request, reply) => {
    const { id } = request.params as { id: string }
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: {
        id: true, name: true, marketplace: true, liveBidWritesEnabled: true,
        liveBidWritesToday: true, liveBidWritesDay: true, dynamicBidding: true,
      },
    })
    if (!campaign) { reply.status(404); return { error: 'campaign not found' } }

    // Collect this campaign's local entity ids (campaign + ad groups + targets + ads).
    const adGroups = await prisma.adGroup.findMany({
      where: { campaignId: id },
      select: { id: true, targets: { select: { id: true } }, productAds: { select: { id: true } } },
    })
    const entityIds = new Set<string>([id])
    for (const g of adGroups) {
      entityIds.add(g.id)
      for (const t of g.targets) entityIds.add(t.id)
      for (const a of g.productAds) entityIds.add(a.id)
    }

    // Pending Amazon-bound queue rows whose payload targets one of those entities.
    const rows = await prisma.outboundSyncQueue.findMany({
      where: { targetChannel: 'AMAZON', syncStatus: 'PENDING' },
      select: { id: true, syncType: true, payload: true, holdUntil: true, externalListingId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    })
    const endpointFor = (entityType: string): string =>
      entityType === 'CAMPAIGN' ? 'PUT /sp/campaigns'
        : entityType === 'AD_GROUP' ? 'PUT /sp/adGroups'
          : entityType === 'PRODUCT_AD' ? 'PUT /sp/productAds'
            : 'PUT /sp/keywords'
    const pending = rows
      .map((r) => {
        const p = (r.payload ?? {}) as { entityType?: string; entityId?: string; externalId?: string | null; fieldChanges?: Array<{ field: string; oldValue: string | null; newValue: string | null }> }
        if (!p.entityId || !entityIds.has(p.entityId)) return null
        return {
          queueId: r.id,
          syncType: r.syncType,
          entityType: p.entityType ?? null,
          entityId: p.entityId,
          externalId: p.externalId ?? r.externalListingId ?? null,
          fieldChanges: p.fieldChanges ?? [],
          holdUntil: r.holdUntil,
          graceExpired: r.holdUntil ? r.holdUntil <= new Date() : true,
          requestPreview: {
            endpoint: endpointFor(p.entityType ?? ''),
            externalId: p.externalId ?? r.externalListingId ?? null,
            changes: Object.fromEntries((p.fieldChanges ?? []).map((c) => [c.field, c.newValue])),
          },
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)

    // Live gate dry-run for this campaign (representative small bid write).
    const { checkAdsWriteGate } = await import('../services/advertising/ads-write-gate.js')
    const gate = await checkAdsWriteGate({ marketplace: campaign.marketplace, payloadValueCents: 50, campaignId: id })
    const gateInfo = gate.allowed === false
      ? { allowed: false as const, reason: gate.reason, deniedAt: gate.deniedAt }
      : { allowed: true as const, mode: gate.mode }
    const guards = (campaign.dynamicBidding ?? {}) as { maxBidChangePct?: number; maxWritesPerDay?: number; cpcCeiling?: { enabled?: boolean; multiple?: number } }

    // Recent terminal-state writes (SUCCESS/FAILED/SKIPPED/CANCELLED) for this
    // campaign's entities — so the operator (and the canary) can see what
    // actually hit Amazon, including the error message on a failure.
    const recentRows = await prisma.outboundSyncQueue.findMany({
      where: { targetChannel: 'AMAZON', syncStatus: { in: ['SUCCESS', 'FAILED', 'SKIPPED', 'CANCELLED'] } },
      select: { id: true, syncType: true, syncStatus: true, errorMessage: true, errorCode: true, payload: true, syncedAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    })
    const recent = recentRows
      .map((r) => {
        const p = (r.payload ?? {}) as { entityType?: string; entityId?: string; fieldChanges?: Array<{ field: string; newValue: string | null }> }
        if (!p.entityId || !entityIds.has(p.entityId)) return null
        return {
          queueId: r.id,
          syncType: r.syncType,
          status: r.syncStatus,
          errorCode: r.errorCode ?? null,
          errorMessage: r.errorMessage ?? null,
          changes: Object.fromEntries((p.fieldChanges ?? []).map((c) => [c.field, c.newValue])),
          at: r.syncedAt ?? r.updatedAt,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .slice(0, 15)

    return {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        marketplace: campaign.marketplace,
        liveBidWritesEnabled: campaign.liveBidWritesEnabled,
        writesToday: campaign.liveBidWritesDay === new Date().toISOString().slice(0, 10) ? campaign.liveBidWritesToday : 0,
      },
      adsMode: adsMode(),
      gate: gateInfo,
      guardrails: {
        cpcCeiling: guards.cpcCeiling ?? { enabled: false, multiple: 1.5 },
        maxBidChangePct: guards.maxBidChangePct ?? null,
        maxWritesPerDay: guards.maxWritesPerDay ?? null,
      },
      pending,
      pendingCount: pending.length,
      recent,
    }
  })

  // ── RC4.5: cancel a staged (PENDING) Amazon write within its grace window ──
  // Powers the staged-changes tray's per-change "Discard" + "Discard all".
  fastify.post('/advertising/queued-mutations/:queueId/cancel', async (request, reply) => {
    const { queueId } = request.params as { queueId: string }
    const { cancelPendingMutation } = await import('../services/advertising/ads-mutation.service.js')
    const r = await cancelPendingMutation(queueId)
    if (!r.ok) { reply.status(r.error === 'not_found' ? 404 : 409); return { ok: false, error: r.error } }
    return { ok: true }
  })

  // ── RC4.6: change-history timeline for a campaign (manual + automation) ──
  // The audit trail behind the History tab + undo/redo. CampaignBidHistory is the
  // scalar before→after record; a keyword/target bid change is "undoable" because
  // re-staging its oldValue through the gated bid path reverses it cleanly.
  fastify.get('/advertising/campaigns/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { limit } = request.query as { limit?: string }
    const take = Math.min(200, Math.max(1, Number(limit) || 60))
    const campaign = await prisma.campaign.findUnique({ where: { id }, select: { id: true } })
    if (!campaign) { reply.status(404); return { error: 'campaign not found' } }
    const adGroups = await prisma.adGroup.findMany({ where: { campaignId: id }, select: { id: true, targets: { select: { id: true } } } })
    const entityIds = new Set<string>([id])
    for (const g of adGroups) { entityIds.add(g.id); for (const t of g.targets) entityIds.add(t.id) }
    const rows = await prisma.campaignBidHistory.findMany({
      where: { OR: [{ campaignId: id }, { entityId: { in: [...entityIds] } }] },
      orderBy: { changedAt: 'desc' },
      take,
      select: { id: true, entityType: true, entityId: true, field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
    })
    const dayMs = 24 * 3600 * 1000
    const now = Date.now()
    const entries = rows.map((r) => ({
      id: r.id,
      at: r.changedAt,
      actor: r.changedBy.startsWith('automation:') ? 'automation' as const : 'you' as const,
      entityType: r.entityType,
      entityId: r.entityId,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      reason: r.reason,
      isUndo: (r.reason ?? '').startsWith('Undo:') || (r.reason ?? '').startsWith('Redo'),
      undoable: r.entityType === 'AD_TARGET' && r.field === 'bid' && r.oldValue != null && now - new Date(r.changedAt).getTime() < dayMs,
    }))
    reply.header('Cache-Control', 'private, max-age=10')
    return { campaignId: id, entries }
  })

  // ── RC4.12: per-day Top-of-search impression-share + ACOS trend (sparklines) ──
  fastify.get('/advertising/campaigns/:id/rank-trend', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { windowDays } = request.query as { windowDays?: string }
    const days = Math.max(7, Math.min(90, Number(windowDays) || 30))
    const campaign = await prisma.campaign.findUnique({ where: { id }, select: { externalCampaignId: true } })
    reply.header('Cache-Control', 'private, max-age=300')
    if (!campaign) return { axis: [], is: [], acos: [], windowDays: days }
    const since = new Date(); since.setUTCDate(since.getUTCDate() - (days - 1)); since.setUTCHours(0, 0, 0, 0)
    const axis: string[] = []
    for (let i = 0; i < days; i++) { const d = new Date(since); d.setUTCDate(since.getUTCDate() + i); axis.push(d.toISOString().slice(0, 10)) }
    const idx = new Map(axis.map((d, i) => [d, i]))
    const is: (number | null)[] = new Array(days).fill(null)
    const acos: (number | null)[] = new Array(days).fill(null)
    // IS: avg Top-of-search impression share per day — sparse (Amazon only reports
    // it when you actually compete at the top), so it's gappy by nature.
    if (campaign.externalCampaignId) {
      const isRows = await prisma.amazonAdsPlacementReport.groupBy({
        by: ['date'],
        where: { campaignId: campaign.externalCampaignId, placement: 'Top of Search on-Amazon', date: { gte: since } },
        _avg: { topOfSearchIS: true },
      })
      for (const r of isRows) { const i = idx.get(r.date.toISOString().slice(0, 10)); if (i != null && r._avg.topOfSearchIS != null) is[i] = Number(r._avg.topOfSearchIS) }
    }
    // ACOS: the campaign's daily spend ÷ sales across all placements — far denser.
    const acosRows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['date'],
      where: { entityType: 'CAMPAIGN', localEntityId: id, date: { gte: since } },
      _sum: { costMicros: true, sales7dCents: true },
    })
    for (const r of acosRows) {
      const i = idx.get(r.date.toISOString().slice(0, 10)); if (i == null) continue
      const cost = microsToCents(r._sum.costMicros ?? 0n)
      const sales = r._sum.sales7dCents ?? 0
      acos[i] = sales > 0 ? cost / sales : null
    }
    return { axis, is, acos, windowDays: days }
  })

  // ── GET /advertising/fba-storage-age/:productId ─────────────────────
  fastify.get('/advertising/fba-storage-age/:productId', async (request, _reply) => {
    const { productId } = request.params as { productId: string }
    const snapshots = await prisma.fbaStorageAge.findMany({
      where: { productId },
      orderBy: { polledAt: 'desc' },
      take: 90, // ~6 months of 6-hourly polls
    })
    return { items: snapshots, count: snapshots.length }
  })

  // ── GET /advertising/profit/daily ───────────────────────────────────
  fastify.get('/advertising/profit/daily', async (request, reply) => {
    const q = request.query as {
      marketplace?: string
      productId?: string
      dateFrom?: string
      dateTo?: string
      limit?: string
    }
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.productId) where.productId = q.productId
    if (q.dateFrom || q.dateTo) {
      const range: Record<string, Date> = {}
      if (q.dateFrom) range.gte = new Date(q.dateFrom)
      if (q.dateTo) range.lte = new Date(q.dateTo)
      where.date = range
    }
    const limit = Math.min(Number(q.limit) || 500, 5000)
    const rows = await prisma.productProfitDaily.findMany({
      where,
      orderBy: [{ date: 'desc' }, { trueProfitMarginPct: 'asc' }],
      take: limit,
      include: {
        product: { select: { id: true, sku: true, name: true } },
      },
    })
    reply.header('Cache-Control', 'private, max-age=120')
    return { items: rows, count: rows.length }
  })

  // ── GET /advertising/summary ────────────────────────────────────────
  fastify.get('/advertising/summary', async (_request, reply) => {
    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const [campaignCount, agg, agedCritical] = await Promise.all([
      prisma.campaign.count({ where: { status: { in: ['ENABLED', 'PAUSED'] } } }),
      prisma.productProfitDaily.aggregate({
        where: { date: { gte: thirtyDaysAgo } },
        _sum: {
          grossRevenueCents: true,
          advertisingSpendCents: true,
          trueProfitCents: true,
        },
      }),
      prisma.fbaStorageAge.count({
        where: { daysToLtsThreshold: { lte: 30, not: null } },
      }),
    ])

    const grossCents = agg._sum.grossRevenueCents ?? 0
    const trueProfitCents = agg._sum.trueProfitCents ?? 0
    const marginPct = grossCents > 0 ? (trueProfitCents / grossCents) * 100 : null

    reply.header('Cache-Control', 'private, max-age=120')
    return {
      campaignCount,
      adSpend30dCents: agg._sum.advertisingSpendCents ?? 0,
      grossRevenue30dCents: grossCents,
      trueProfit30dCents: trueProfitCents,
      trueProfitMargin30dPct: marginPct,
      agedSkusFlagged: agedCritical,
      mode: adsMode(),
    }
  })

  // ── POST /advertising/ads-connection/test ───────────────────────────
  // Admin-only path lands in AD.4. AD.1 ships a sandbox-safe smoke test.
  fastify.post('/advertising/ads-connection/test', async (request, _reply) => {
    const body = request.body as { profileId?: string; region?: 'EU' | 'NA' | 'FE' }
    const result = await testConnection({
      profileId: body?.profileId ?? 'SANDBOX-PROFILE-IT-001',
      region: body?.region ?? 'EU',
    })
    return result
  })

  // ── Phase 4: Reports API routes ──────────────────────────────────────
  // Async report flow: create-cycle → poll → ingest. Each can be called
  // manually for now; cron wiring lands in Phase 11 hardening.

  // POST /api/advertising/reports/create-cycle
  //   { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD", adProducts?: [...] }
  // Creates a report job per (active profile × adProduct). Idempotent.
  fastify.post('/advertising/reports/create-cycle', async (request, reply) => {
    const body = request.body as {
      startDate?: string
      endDate?: string
      adProducts?: Array<'SPONSORED_PRODUCTS' | 'SPONSORED_DISPLAY' | 'SPONSORED_BRANDS'>
    }
    if (!body.startDate || !body.endDate) {
      return reply.code(400).send({ error: 'startDate and endDate (YYYY-MM-DD) required' })
    }
    const { runReportCreationCycle } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await runReportCreationCycle({
      startDate: body.startDate,
      endDate: body.endDate,
      adProducts: body.adProducts,
    })
    return { ok: true, ...result }
  })

  // POST /api/advertising/reports/poll
  //   ?limit=N (default 20) — advance PENDING/IN_PROGRESS jobs.
  fastify.post('/advertising/reports/poll', async (request, _reply) => {
    const query = request.query as { limit?: string }
    const limit = query.limit ? Math.max(1, Math.min(50, Number(query.limit))) : 20
    const { pollPendingJobs } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await pollPendingJobs(limit)
    return { ok: true, ...result }
  })

  // POST /api/advertising/reports/:id/ingest
  // Downloads a COMPLETED job's S3 file and upserts rows into
  // AmazonAdsDailyPerformance.
  fastify.post('/advertising/reports/:id/ingest', async (request, _reply) => {
    const { id } = request.params as { id: string }
    const { ingestCompletedJob } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await ingestCompletedJob(id)
    return { ok: !result.error, ...result }
  })

  // POST /api/advertising/reports/ingest-completed
  // Bulk: find every COMPLETED job not yet ingested and ingest each.
  // Also skip jobs whose signed URL likely expired (completedAt >50min ago)
  // to match the cron pattern and prevent endless retries.
  fastify.post('/advertising/reports/ingest-completed', async (_request, _reply) => {
    const fiftyMinAgo = new Date(Date.now() - 50 * 60 * 1000)
    const jobs = await prisma.amazonAdsReportJob.findMany({
      where: {
        status: 'COMPLETED',
        rowsIngested: 0,
        completedAt: { gt: fiftyMinAgo },
      },
      select: { id: true },
      take: 20,
    })
    const { ingestCompletedJob } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const results = []
    for (const j of jobs) {
      results.push(await ingestCompletedJob(j.id))
    }
    return { ok: true, ingested: results.length, results }
  })

  // GET /api/advertising/reports — list jobs (paginated, newest first)
  fastify.get('/advertising/reports', async (request, _reply) => {
    const query = request.query as {
      status?: string
      profileId?: string
      adProduct?: string
      limit?: string
    }
    const limit = query.limit ? Math.max(1, Math.min(200, Number(query.limit))) : 50
    const items = await prisma.amazonAdsReportJob.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.profileId ? { profileId: query.profileId } : {}),
        ...(query.adProduct ? { adProduct: query.adProduct } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, profileId: true, adProduct: true, reportTypeId: true,
        externalReportId: true, status: true, startDate: true, endDate: true,
        location: true, fileSize: true, rowsIngested: true, errorMessage: true,
        attempts: true, lastPolledAt: true, createdAt: true, completedAt: true,
      },
    })
    return { items, count: items.length }
  })

  // GET /api/advertising/reports/:id — single job detail
  fastify.get('/advertising/reports/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const job = await prisma.amazonAdsReportJob.findUnique({ where: { id } })
    if (!job) return reply.code(404).send({ error: 'not_found' })
    return job
  })

  // ── Phase 5b: per-campaign v1 metrics (last N days) ──────────────────
  // Returns campaign-level aggregates from AmazonAdsDailyPerformance for
  // the requested window. Keyed by externalCampaignId so the campaigns
  // page server component can merge into its existing campaign list.
  fastify.get('/advertising/campaigns/v1-metrics', async (request, reply) => {
    const query = request.query as { windowDays?: string; marketplace?: string; preset?: string; startDate?: string; endDate?: string }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(query)
    const since = range.since
    const windowDays = range.days

    const { cached } = await import('../services/advertising/ads-cache.js')
    const payload = await cached(`v1metrics:${range.sinceStr}:${range.untilStr}:${query.marketplace ?? ''}`, 300, async () => {
    const rows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['entityId', 'adProduct', 'marketplace', 'currencyCode'],
      where: {
        date: { gte: since, lte: range.until },
        entityType: 'CAMPAIGN',
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
      },
      _sum: {
        impressions: true,
        clicks: true,
        costMicros: true,
        sales7dCents: true,
        sales14dCents: true,
        orders7d: true,
        units7d: true,
      },
    })

    // Shape: { [externalCampaignId]: { impressions, clicks, ... } }
    const byCampaign: Record<string, {
      impressions: number
      clicks: number
      costMicros: string
      costUnits: number
      salesCents: number
      orders: number
      units: number
      currencyCode: string
      adProduct: string
      marketplace: string
      acos: number | null
      roas: number | null
      ctr: number | null
      cpc: number | null
    }> = {}

    for (const r of rows) {
      const impressions = r._sum.impressions ?? 0
      const clicks = r._sum.clicks ?? 0
      const costMicros = r._sum.costMicros ?? 0n
      const costUnits = Number(costMicros) / 1_000_000
      const salesCents = (r._sum.sales7dCents ?? 0) + (r._sum.sales14dCents ?? 0)
      const orders = r._sum.orders7d ?? 0
      const units = r._sum.units7d ?? 0
      const acos = salesCents > 0 ? (costUnits * 100) / salesCents : null
      const roas = costUnits > 0 ? salesCents / 100 / costUnits : null
      const ctr = impressions > 0 ? clicks / impressions : null
      const cpc = clicks > 0 ? costUnits / clicks : null
      byCampaign[r.entityId] = {
        impressions, clicks,
        costMicros: costMicros.toString(),
        costUnits,
        salesCents, orders, units,
        currencyCode: r.currencyCode,
        adProduct: r.adProduct,
        marketplace: r.marketplace,
        acos, roas, ctr, cpc,
      }
    }

    return { windowDays, count: Object.keys(byCampaign).length, byCampaign }
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return payload
  })

  // GET /api/advertising/insights — rule-based insight engine (Phase 8)
  //
  // Four insight types derived from live aggregates:
  //   NEGATIVE_KW     — search terms with high spend + zero orders
  //   HIGH_ACOS       — campaigns with ACOS > acosTarget (default 35%)
  //   LOW_ACOS        — campaigns with ACOS < lowTarget (default 8%) + spend ≥ floor
  // GET /api/advertising/product-ads — Phase 10 cross-system ad intelligence
  //
  // Given a productId (and/or asin/sku), walks the join chain:
  //   AdProductAd → AdGroup → Campaign → externalCampaignId
  //   → AmazonAdsDailyPerformance (entityType=CAMPAIGN)
  //   → AmazonAdsSearchTerm
  //
  // Returns a summary tile + per-campaign table + top search terms for
  // embedding in the /products/[id]/edit "Ads" tab.
  fastify.get('/advertising/product-ads', async (request, reply) => {
    const query = request.query as {
      productId?: string; asin?: string; sku?: string; windowDays?: string; preset?: string; startDate?: string; endDate?: string
    }
    if (!query.productId && !query.asin && !query.sku) {
      return reply.code(400).send({ error: 'productId, asin, or sku required' })
    }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(query)
    const windowDays = range.days
    const since = range.since
    const dateFilterPA = { gte: since, lte: range.until }

    // ── 1. Find all AdProductAd rows for this product ───────────────────
    // Select creativeJson + adType so the UI can render multi-product
    // creatives (especially SB ads where one creative bundles 3-4 ASINs).
    const productAds = await prisma.adProductAd.findMany({
      where: {
        OR: [
          ...(query.productId ? [{ productId: query.productId }] : []),
          ...(query.asin ? [{ asin: query.asin }] : []),
          ...(query.sku  ? [{ sku:  query.sku  }] : []),
        ],
      },
      select: {
        id: true, asin: true, sku: true, adGroupId: true,
        externalAdId: true, status: true, adType: true,
        creativeJson: true, deliveryStatus: true, deliveryReasons: true,
      },
    })
    if (productAds.length === 0) {
      return { windowDays, productAds: 0, campaigns: [], searchTerms: [], summary: null }
    }

    // ── 2. Walk to campaigns ────────────────────────────────────────────
    const adGroupIds = [...new Set(productAds.map((a) => a.adGroupId))]
    const adGroups = await prisma.adGroup.findMany({
      where: { id: { in: adGroupIds } },
      select: { id: true, campaignId: true },
    })
    const campaignIds = [...new Set(adGroups.map((g) => g.campaignId))]
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: {
        id: true, name: true, adProduct: true, marketplace: true,
        status: true, externalCampaignId: true,
      },
    })

    // ── 3. AmazonAdsDailyPerformance for these campaigns ───────────────
    const extIds = campaigns
      .map((c) => c.externalCampaignId)
      .filter((x): x is string => x != null)

    const perfRows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['entityId', 'adProduct', 'marketplace', 'currencyCode'],
      where: {
        entityId: { in: extIds },
        entityType: 'CAMPAIGN',
        date: dateFilterPA,
      },
      _sum: {
        impressions:   true,
        clicks:        true,
        costMicros:    true,
        sales7dCents:  true,
        sales14dCents: true,
        orders7d:      true,
      },
    })

    // Index perf by externalCampaignId
    const perfByExtId = new Map(perfRows.map((r) => [r.entityId, r]))

    const campaignData = campaigns.map((c) => {
      const perf = c.externalCampaignId ? perfByExtId.get(c.externalCampaignId) : undefined
      const spendMicros  = Number(perf?._sum.costMicros ?? 0n)
      const adSalesCents = (perf?._sum.sales7dCents ?? 0) + (perf?._sum.sales14dCents ?? 0)
      const spendCents   = Math.round(spendMicros / 10_000)
      const acos = adSalesCents > 0 ? (spendCents / adSalesCents) * 100 : null
      return {
        id: c.id,
        externalCampaignId: c.externalCampaignId,
        name: c.name,
        adProduct: c.adProduct ?? 'UNKNOWN',
        marketplace: c.marketplace ?? '—',
        status: c.status,
        impressions:   perf?._sum.impressions ?? 0,
        clicks:        perf?._sum.clicks ?? 0,
        orders:        perf?._sum.orders7d ?? 0,
        spendCents,
        adSalesCents,
        currencyCode:  perf?.currencyCode ?? 'EUR',
        acos:          acos != null ? Math.round(acos * 10) / 10 : null,
        hasV1Data:     perf != null,
      }
    })

    // ── 4. Top search terms for these campaigns ─────────────────────────
    const searchTermRows = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'matchType', 'adProduct', 'marketplace'],
      where: {
        campaignId: { in: extIds },
        date: dateFilterPA,
      },
      _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
      orderBy: { _sum: { costMicros: 'desc' } },
      take: 10,
    })

    const searchTerms = searchTermRows.map((r) => {
      const spendMicros  = Number(r._sum.costMicros ?? 0n)
      const adSalesCents = r._sum.sales7dCents ?? 0
      const spendCents   = Math.round(spendMicros / 10_000)
      return {
        query:       r.query,
        matchType:   r.matchType,
        adProduct:   r.adProduct,
        marketplace: r.marketplace,
        impressions: r._sum.impressions ?? 0,
        clicks:      r._sum.clicks ?? 0,
        orders:      r._sum.orders7d ?? 0,
        spendCents,
        adSalesCents,
        acos: adSalesCents > 0 ? Math.round((spendCents / adSalesCents) * 1000) / 10 : null,
      }
    })

    // ── 5. Creatives — surface multi-product creativeJson, especially
    // valuable for SB ads where one ad bundles multiple ASINs. We
    // build a campaign-name + adGroup-name lookup so the UI can show
    // "this product appears in Brand Builder XYZ alongside ASINs A, B,
    // C" without extra round-trips.
    const adGroupNameMap = new Map<string, string>(
      adGroups.length === 0 ? [] :
      (await prisma.adGroup.findMany({
        where: { id: { in: adGroups.map((g) => g.id) } },
        select: { id: true, name: true },
      })).map((g) => [g.id, g.name]),
    )
    const adGroupToCampaign = new Map(adGroups.map((g) => [g.id, g.campaignId]))
    const campaignNameMap = new Map(campaigns.map((c) => [c.id, { name: c.name, adProduct: c.adProduct, marketplace: c.marketplace }]))

    // Collect ALL ASINs/SKUs referenced in creativeJson.products[] so
    // we can resolve them to local Product names + thumbnails in one
    // batch query. Skips the current product (it's the focus).
    const siblingAsins = new Set<string>()
    const siblingSkus = new Set<string>()
    for (const pa of productAds) {
      const products = (pa.creativeJson as { products?: Array<{ productIdType?: string; productId?: string }> } | null)
        ?.products ?? []
      for (const p of products) {
        if (!p.productId) continue
        if (p.productIdType === 'ASIN' && p.productId !== query.asin) siblingAsins.add(p.productId)
        if (p.productIdType === 'SKU'  && p.productId !== query.sku ) siblingSkus.add(p.productId)
      }
    }
    const siblingProducts = (siblingAsins.size > 0 || siblingSkus.size > 0)
      ? await prisma.product.findMany({
          where: {
            // F.1 — exclude soft-deleted (recycle-bin) rows so the
            // sibling-ad-keyword inference doesn't suggest trashed SKUs.
            deletedAt: null,
            OR: [
              ...(siblingAsins.size > 0 ? [{ amazonAsin: { in: [...siblingAsins] } }] : []),
              ...(siblingSkus.size  > 0 ? [{ sku:        { in: [...siblingSkus]  } }] : []),
            ],
          },
          select: { id: true, sku: true, name: true, amazonAsin: true },
        })
      : []
    const asinToSibling = new Map(siblingProducts.filter((p) => p.amazonAsin).map((p) => [p.amazonAsin!, p]))
    const skuToSibling  = new Map(siblingProducts.map((p) => [p.sku, p]))

    const creatives = productAds.map((pa) => {
      const campId = adGroupToCampaign.get(pa.adGroupId)
      const camp   = campId ? campaignNameMap.get(campId) : undefined
      const products = (pa.creativeJson as { products?: Array<{ productIdType?: string; productId?: string }> } | null)
        ?.products ?? []
      // Annotate each entry: is it the current product? what's the
      // sibling SKU/name?
      const annotated = products.map((p) => {
        const isCurrent =
          (p.productIdType === 'ASIN' && p.productId === query.asin) ||
          (p.productIdType === 'SKU'  && p.productId === query.sku)
        let siblingName: string | null = null
        let siblingSku:  string | null = null
        let siblingProductId: string | null = null
        if (!isCurrent) {
          const sib = p.productIdType === 'ASIN'
            ? (p.productId ? asinToSibling.get(p.productId) : undefined)
            : (p.productId ? skuToSibling.get(p.productId)  : undefined)
          if (sib) {
            siblingName = sib.name
            siblingSku  = sib.sku
            siblingProductId = sib.id
          }
        }
        return {
          productIdType:  p.productIdType ?? null,
          productId:      p.productId ?? null,
          isCurrent,
          siblingName, siblingSku, siblingProductId,
        }
      })
      return {
        id:             pa.id,
        externalAdId:   pa.externalAdId,
        adType:         pa.adType,
        status:         pa.status,
        deliveryStatus: pa.deliveryStatus,
        deliveryReasons: pa.deliveryReasons,
        campaignName:   camp?.name ?? null,
        campaignAdProduct: camp?.adProduct ?? null,
        marketplace:    camp?.marketplace ?? null,
        adGroupName:    adGroupNameMap.get(pa.adGroupId) ?? null,
        productCount:   products.length,
        products:       annotated,
      }
    })

    // ── 6. Summary ──────────────────────────────────────────────────────
    const totalSpend = campaignData.reduce((s, c) => s + c.spendCents, 0)
    const totalSales = campaignData.reduce((s, c) => s + c.adSalesCents, 0)
    const sbCreatives = creatives.filter((c) => c.campaignAdProduct === 'SPONSORED_BRANDS').length
    const multiProductCreatives = creatives.filter((c) => c.productCount > 1).length
    const summary = {
      campaignCount: campaigns.length,
      productAdCount: productAds.length,
      totalSpendCents: totalSpend,
      totalAdSalesCents: totalSales,
      acos: totalSales > 0 ? Math.round((totalSpend / totalSales) * 1000) / 10 : null,
      sbCreatives,
      multiProductCreatives,
      windowDays,
    }

    reply.header('Cache-Control', 'private, max-age=60')
    return { windowDays, productAds: productAds.length, campaigns: campaignData, searchTerms, creatives, summary }
  })

  // ── PC.1: product-centric ad roster ─────────────────────────────────
  // One row per ADVERTISED product, aggregated from ProductProfitDaily (the
  // true per-product windowed source: ad spend + revenue + true profit, no
  // multi-product double-count). Headline metric is TACOS (spend÷revenue);
  // ACOS lives in the per-campaign expand (product-ads). #campaigns/#markets
  // come from the AdProductAd→Campaign structure. Returns a reconciliation
  // remainder (account spend − Σ attributed) so nothing is silently dropped.
  // GET /advertising/by-product?windowDays=&marketplace=&search=&sort=&dir=&limit=
  fastify.get('/advertising/by-product', async (request, reply) => {
    const q = request.query as { windowDays?: string; marketplace?: string; search?: string; sort?: string; dir?: string; limit?: string; compare?: string; mode?: string; preset?: string; startDate?: string; endDate?: string }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(q)
    const windowDays = range.days
    const since = range.since
    const until = range.until
    const dateFilterBP = { gte: since, lte: until }
    const limit = Math.max(1, Math.min(1000, Number(q.limit ?? 300)))
    const mkt = q.marketplace || undefined
    // PC.8 — mode: advertised (default) | opportunity (selling but NOT
    // advertised) | unmatched (handled separately below).
    const mode = q.mode === 'opportunity' ? 'opportunity' : q.mode === 'unmatched' ? 'unmatched' : 'advertised'

    // PC.8 — Unmatched ASINs: PRODUCT_AD rows with no local AdProductAd link.
    if (mode === 'unmatched') {
      const um = await prisma.amazonAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'PRODUCT_AD', localEntityId: null, date: dateFilterBP, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
        orderBy: { _sum: { costMicros: 'desc' } },
        take: limit,
      })
      const rows = um.map((r) => {
        const adSpendCents = microsToCents(r._sum.costMicros)
        const salesC = r._sum.sales7dCents ?? 0
        return {
          id: r.entityId, sku: undefined, name: r.entityId.replace(/^ASIN:/, ''), asin: r.entityId.replace(/^ASIN:/, ''),
          photoUrl: null, photoCount: 0, adSpendCents, revenueCents: salesC, profitCents: 0,
          units: r._sum.orders7d ?? 0, tacos: salesC > 0 ? Math.round((adSpendCents / salesC) * 1000) / 10 : null, marginPct: null,
          campaignCount: 0, marketCount: 0, isParent: false, childCount: 0, unmatched: true,
        }
      })
      reply.header('Cache-Control', 'private, max-age=60')
      return { windowDays, mode, rows, totals: { adSpendCents: rows.reduce((s, r) => s + r.adSpendCents, 0), revenueCents: 0, profitCents: 0, products: rows.length }, marketplaces: [] }
    }

    // 1. Per-product ad metrics. PRIMARY source = PRODUCT_AD daily rows (PC.0):
    // true per-product spend/sales/impr/clicks → ACOS. Falls back to
    // ProductProfitDaily.advertisingSpendCents when PRODUCT_AD isn't ingested
    // yet (zero-regression). Opportunity mode always uses ProductProfitDaily.
    type AdAgg = { spendC: number; salesC: number; impr: number; clicks: number; orders: number }
    const adByProduct = new Map<string, AdAgg>()
    if (mode === 'advertised') {
      // AME.2 — group by currencyCode so cross-marketplace spend/sales convert
      // to the EUR base before summing (no-op while all ad data is EUR). AME.3
      // — round micros→cents once per (ad,currency) bucket, not per daily row.
      const perAd = await prisma.amazonAdsDailyPerformance.groupBy({
        by: ['localEntityId', 'currencyCode'],
        where: { entityType: 'PRODUCT_AD', localEntityId: { not: null }, date: dateFilterBP, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
      })
      if (perAd.length > 0) {
        const adIds = perAd.map((r) => r.localEntityId).filter((x): x is string => !!x)
        const adProds = await prisma.adProductAd.findMany({ where: { id: { in: adIds } }, select: { id: true, productId: true } })
        const prodByAd = new Map(adProds.map((a) => [a.id, a.productId]))
        const fxToEur = await buildEurRateMap(perAd.map((r) => r.currencyCode))
        for (const r of perAd) {
          const pid = r.localEntityId ? prodByAd.get(r.localEntityId) : null
          if (!pid) continue
          const rate = fxToEur.get(r.currencyCode) ?? 1
          const cur = adByProduct.get(pid) ?? { spendC: 0, salesC: 0, impr: 0, clicks: 0, orders: 0 }
          cur.spendC += toEurCents(microsToCents(r._sum.costMicros), rate)
          cur.salesC += toEurCents(r._sum.sales7dCents ?? 0, rate)
          cur.impr += r._sum.impressions ?? 0
          cur.clicks += r._sum.clicks ?? 0
          cur.orders += r._sum.orders7d ?? 0
          adByProduct.set(pid, cur)
        }
      }
    }
    // Product set. Advertised mode = UNION of PRODUCT_AD-advertised products
    // (real spend/ACOS) and ProductProfitDaily-advertised products (fallback
    // spend), so partial PRODUCT_AD ingestion never hides a product. Per-row we
    // prefer PRODUCT_AD when present. Opportunity mode = selling-but-unadvertised.
    let ids: string[]
    let ppdByProduct: Map<string, { _sum: { advertisingSpendCents: number | null; grossRevenueCents: number | null; trueProfitCents: number | null; unitsSold: number | null } }>
    if (mode === 'opportunity') {
      const grouped = await prisma.productProfitDaily.groupBy({
        by: ['productId'],
        where: { date: dateFilterBP, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true, unitsSold: true },
        having: { advertisingSpendCents: { _sum: { equals: 0 } }, grossRevenueCents: { _sum: { gt: 0 } } },
        orderBy: { _sum: { grossRevenueCents: 'desc' } },
        take: limit,
      })
      ids = grouped.map((g) => g.productId)
      ppdByProduct = new Map(grouped.map((g) => [g.productId, g]))
    } else if (adByProduct.size > 0) {
      // PRODUCT_AD data exists → use ONLY that set (true per-product spend/ACOS,
      // no double-count). Coverage grows daily as the advertised-product cron
      // accumulates; products without PRODUCT_AD rows yet appear as they ingest.
      ids = [...adByProduct.entries()].sort((a, b) => b[1].spendC - a[1].spendC).slice(0, limit).map(([pid]) => pid)
      const ppd = await prisma.productProfitDaily.groupBy({
        by: ['productId'],
        where: { productId: { in: ids }, date: dateFilterBP, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true, unitsSold: true },
        orderBy: { _sum: { grossRevenueCents: 'desc' } },
      })
      ppdByProduct = new Map(ppd.map((g) => [g.productId, g]))
    } else {
      // Fallback (no PRODUCT_AD yet): ProductProfitDaily.advertisingSpendCents.
      const grouped = await prisma.productProfitDaily.groupBy({
        by: ['productId'],
        where: { date: dateFilterBP, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true, unitsSold: true },
        having: { advertisingSpendCents: { _sum: { gt: 0 } } },
        orderBy: { _sum: { advertisingSpendCents: 'desc' } },
        take: limit,
      })
      ids = grouped.map((g) => g.productId)
      ppdByProduct = new Map(grouped.map((g) => [g.productId, g]))
    }
    if (ids.length === 0) {
      reply.header('Cache-Control', 'private, max-age=60')
      return { windowDays, mode, rows: [], totals: { adSpendCents: 0, revenueCents: 0, profitCents: 0, products: 0 }, unattributedSpendCents: 0, marketplaces: [] }
    }

    // 2. Variant identity (+ parentId) and parent identity, so we can ROLL UP
    // each variant's ad metrics under its PARENT product (PCF.1). Standalone
    // products (no parent) stay as their own row.
    const { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } = await import('../services/product-read-cache.service.js')
    const variants = await prisma.product.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, sku: true, name: true, parentId: true, images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY } },
    })
    const variantById = new Map(variants.map((p) => [p.id, p]))
    const parentIds = [...new Set(variants.map((v) => v.parentId).filter((x): x is string => !!x))]
    const parents = parentIds.length ? await prisma.product.findMany({
      where: { id: { in: parentIds } },
      select: { id: true, sku: true, name: true, images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY }, _count: { select: { children: true } } },
    }) : []
    const parentById = new Map(parents.map((p) => [p.id, p]))

    // 3. #campaigns + #markets + asin from the ad structure (keyed by variant).
    const ads = await prisma.adProductAd.findMany({
      where: { productId: { in: ids } },
      select: { productId: true, asin: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true } } } } },
    })
    const structByProduct = new Map<string, { campaigns: Set<string>; markets: Set<string>; asin: string | null }>()
    for (const a of ads) {
      if (!a.productId) continue
      let s = structByProduct.get(a.productId)
      if (!s) { s = { campaigns: new Set(), markets: new Set(), asin: a.asin }; structByProduct.set(a.productId, s) }
      const c = a.adGroup?.campaign
      if (c?.id && (!mkt || c.marketplace === mkt)) { s.campaigns.add(c.id); if (c.marketplace) s.markets.add(c.marketplace) }
      if (!s.asin && a.asin) s.asin = a.asin
    }

    // 4. Roll up variant metrics under the parent (groupId = parentId ?? self).
    interface Group { groupId: string; variants: Set<string>; spend: number; salesC: number; revenue: number; profit: number; units: number; impr: number; clicks: number; campaigns: Set<string>; markets: Set<string>; asin: string | null; hasPA: boolean }
    const groups = new Map<string, Group>()
    for (const pid of ids) {
      const v = variantById.get(pid)
      if (!v) continue
      const groupId = (v.parentId && parentById.has(v.parentId)) ? v.parentId : pid
      let g = groups.get(groupId)
      if (!g) { g = { groupId, variants: new Set(), spend: 0, salesC: 0, revenue: 0, profit: 0, units: 0, impr: 0, clicks: 0, campaigns: new Set(), markets: new Set(), asin: null, hasPA: false }; groups.set(groupId, g) }
      g.variants.add(pid)
      const ad = adByProduct.get(pid), ppd = ppdByProduct.get(pid)
      g.spend += ad ? ad.spendC : (ppd?._sum.advertisingSpendCents ?? 0)
      g.salesC += ad?.salesC ?? 0
      g.revenue += ppd?._sum.grossRevenueCents ?? 0
      g.profit += ppd?._sum.trueProfitCents ?? 0
      g.units += ppd?._sum.unitsSold ?? 0
      g.impr += ad?.impr ?? 0
      g.clicks += ad?.clicks ?? 0
      if (ad) g.hasPA = true
      const st = structByProduct.get(pid)
      if (st) { st.campaigns.forEach((c) => g.campaigns.add(c)); st.markets.forEach((m) => g.markets.add(m)); if (!g.asin) g.asin = st.asin }
    }

    const searchLc = q.search?.toLowerCase()
    let rows = [...groups.values()].flatMap((g) => {
      const parent = parentById.get(g.groupId)
      const identity = parent ?? variantById.get(g.groupId)
      if (!identity) return []
      if (searchLc && !identity.name.toLowerCase().includes(searchLc) && !identity.sku.toLowerCase().includes(searchLc)) return []
      const isParentRow = !!parent
      return [{
        id: g.groupId,
        sku: identity.sku,
        name: identity.name,
        asin: g.asin,
        photoUrl: pickFaceImage(identity.images),
        photoCount: identity.images.length,
        adSpendCents: g.spend, adSalesCents: g.salesC, revenueCents: g.revenue, profitCents: g.profit,
        units: g.units,
        acos: g.hasPA && g.salesC > 0 ? Math.round((g.spend / g.salesC) * 1000) / 10 : null,
        roas: g.hasPA && g.spend > 0 ? Math.round((g.salesC / g.spend) * 100) / 100 : null,
        impressions: g.impr, clicks: g.clicks,
        tacos: g.revenue > 0 ? Math.round((g.spend / g.revenue) * 1000) / 10 : null,
        marginPct: g.revenue > 0 ? Math.round((g.profit / g.revenue) * 1000) / 10 : null,
        campaignCount: g.campaigns.size,
        marketCount: g.markets.size,
        variantCount: g.variants.size,
        isParent: isParentRow,           // expandable → its advertised variants
        childCount: isParentRow ? g.variants.size : 0,
        opportunity: mode === 'opportunity',
      }]
    })
    // Re-sort by the requested key (rollup reorders vs the variant-level sort).
    rows.sort((a, b) => b.adSpendCents - a.adSpendCents)
    rows = rows.slice(0, limit)

    // 5. Reconciliation: account ad spend (campaign-level) vs Σ attributed.
    // AME.2 — per-currency so a future non-EUR marketplace converts to the EUR
    // base before summing (no-op while all ad data is EUR).
    const acctRows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['currencyCode'],
      where: { entityType: 'CAMPAIGN', date: dateFilterBP, ...(mkt ? { marketplace: mkt } : {}) },
      _sum: { costMicros: true },
    })
    const acctFx = await buildEurRateMap(acctRows.map((r) => r.currencyCode))
    const accountSpendCents = acctRows.reduce(
      (s, r) => s + toEurCents(microsToCents(r._sum.costMicros), acctFx.get(r.currencyCode) ?? 1),
      0,
    )
    const attributedSpendCents = rows.reduce((s, r) => s + r.adSpendCents, 0)

    // PC.5 — prior equal-length window totals for vs-period deltas.
    let previousTotals: { adSpendCents: number; revenueCents: number; profitCents: number } | null = null
    if (q.compare === 'true' || q.compare === '1') {
      const prevSince = new Date(since); prevSince.setUTCDate(prevSince.getUTCDate() - windowDays)
      const prev = await prisma.productProfitDaily.aggregate({
        where: { date: { gte: prevSince, lt: since }, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true },
      })
      previousTotals = {
        adSpendCents: prev._sum.advertisingSpendCents ?? 0,
        revenueCents: prev._sum.grossRevenueCents ?? 0,
        profitCents: prev._sum.trueProfitCents ?? 0,
      }
    }

    // Optional client-driven re-sort (default already spend desc).
    const dir = q.dir === 'asc' ? 1 : -1
    if (q.sort && q.sort !== 'spend') {
      const key = q.sort as 'revenue' | 'profit' | 'tacos' | 'margin' | 'campaigns'
      const val = (r: typeof rows[number]) => key === 'revenue' ? r.revenueCents : key === 'profit' ? r.profitCents : key === 'tacos' ? (r.tacos ?? -1) : key === 'margin' ? (r.marginPct ?? -999) : r.campaignCount
      rows.sort((a, b) => (val(a) - val(b)) * dir)
    }

    // Distinct markets with ad spend in window — drives the filter dropdown.
    const mktRows = await prisma.productProfitDaily.groupBy({
      by: ['marketplace'],
      where: { date: dateFilterBP, advertisingSpendCents: { gt: 0 } },
    })
    const marketplaces = mktRows.map((m) => m.marketplace).filter(Boolean).sort()

    reply.header('Cache-Control', 'private, max-age=60')
    return {
      windowDays,
      mode,
      rows,
      marketplaces,
      totals: { adSpendCents: attributedSpendCents, revenueCents: rows.reduce((s, r) => s + r.revenueCents, 0), profitCents: rows.reduce((s, r) => s + r.profitCents, 0), products: rows.length },
      previousTotals,
      accountSpendCents,
      unattributedSpendCents: Math.max(0, accountSpendCents - attributedSpendCents),
      // Honest reconciliation (PCF.2): product spend can slightly EXCEED the
      // campaign total because campaign reports lag T+2 for recent days + a
      // small systematic variance between Amazon's advertised-product and
      // campaign reports. Surface it as variance, not a hidden over-count.
      overAttributedCents: Math.max(0, attributedSpendCents - accountSpendCents),
    }
  })

  // PCF.1 — variant children of a parent product (the expansion rows). Per-
  // variant ad spend/revenue/ACOS for one parent's advertised variants.
  // GET /advertising/by-product/variants?parentId=&windowDays=&marketplace=
  fastify.get('/advertising/by-product/variants', async (request, reply) => {
    const q = request.query as { parentId?: string; windowDays?: string; marketplace?: string }
    if (!q.parentId) { reply.status(400); return { error: 'parentId required' } }
    const windowDays = Math.max(7, Math.min(90, Number(q.windowDays ?? 30)))
    const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)
    const mkt = q.marketplace || undefined

    const { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } = await import('../services/product-read-cache.service.js')
    const children = await prisma.product.findMany({
      where: { parentId: q.parentId, deletedAt: null },
      select: { id: true, sku: true, name: true, images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY } },
    })
    const childIds = children.map((c) => c.id)
    if (childIds.length === 0) { reply.header('Cache-Control', 'private, max-age=60'); return { rows: [] } }

    // PRODUCT_AD per variant.
    const ads = await prisma.adProductAd.findMany({ where: { productId: { in: childIds } }, select: { id: true, productId: true, asin: true, adGroup: { select: { campaign: { select: { id: true, marketplace: true } } } } } })
    const adIds = ads.map((a) => a.id)
    const perAd = adIds.length ? await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'currencyCode'],
      where: { entityType: 'PRODUCT_AD', localEntityId: { in: adIds }, date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
      _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
    }) : []
    const prodByAd = new Map(ads.map((a) => [a.id, a.productId]))
    const variantFx = await buildEurRateMap(perAd.map((r) => r.currencyCode))
    const adByVariant = new Map<string, { spendC: number; salesC: number; impr: number; clicks: number }>()
    for (const r of perAd) {
      const pid = r.localEntityId ? prodByAd.get(r.localEntityId) : null
      if (!pid) continue
      const rate = variantFx.get(r.currencyCode) ?? 1
      const cur = adByVariant.get(pid) ?? { spendC: 0, salesC: 0, impr: 0, clicks: 0 }
      cur.spendC += toEurCents(microsToCents(r._sum.costMicros), rate)
      cur.salesC += toEurCents(r._sum.sales7dCents ?? 0, rate)
      cur.impr += r._sum.impressions ?? 0
      cur.clicks += r._sum.clicks ?? 0
      adByVariant.set(pid, cur)
    }
    const ppd = await prisma.productProfitDaily.groupBy({
      by: ['productId'], where: { productId: { in: childIds }, date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
      _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true, unitsSold: true },
    })
    const ppdBy = new Map(ppd.map((g) => [g.productId, g]))
    const structBy = new Map<string, { campaigns: Set<string>; markets: Set<string>; asin: string | null }>()
    for (const a of ads) {
      if (!a.productId) continue
      let s = structBy.get(a.productId); if (!s) { s = { campaigns: new Set(), markets: new Set(), asin: a.asin }; structBy.set(a.productId, s) }
      const c = a.adGroup?.campaign; if (c?.id && (!mkt || c.marketplace === mkt)) { s.campaigns.add(c.id); if (c.marketplace) s.markets.add(c.marketplace) }
      if (!s.asin && a.asin) s.asin = a.asin
    }
    const rows = children.flatMap((c) => {
      const ad = adByVariant.get(c.id), p = ppdBy.get(c.id), st = structBy.get(c.id)
      const spend = ad ? ad.spendC : (p?._sum.advertisingSpendCents ?? 0)
      // Only variants with ad activity or sales are interesting in the expansion.
      if (spend === 0 && (p?._sum.grossRevenueCents ?? 0) === 0) return []
      const rev = p?._sum.grossRevenueCents ?? 0, sales = ad?.salesC ?? 0
      return [{
        id: c.id, sku: c.sku, name: c.name, asin: st?.asin ?? null,
        photoUrl: pickFaceImage(c.images), photoCount: c.images.length,
        adSpendCents: spend, adSalesCents: sales, revenueCents: rev, profitCents: p?._sum.trueProfitCents ?? 0, units: p?._sum.unitsSold ?? 0,
        acos: ad && sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null,
        tacos: rev > 0 ? Math.round((spend / rev) * 1000) / 10 : null,
        marginPct: rev > 0 ? Math.round(((p?._sum.trueProfitCents ?? 0) / rev) * 1000) / 10 : null,
        impressions: ad?.impr ?? 0, clicks: ad?.clicks ?? 0,
        campaignCount: st?.campaigns.size ?? 0, marketCount: st?.markets.size ?? 0,
        isParent: false, childCount: 0,
      }]
    })
    rows.sort((a, b) => b.adSpendCents - a.adSpendCents)
    reply.header('Cache-Control', 'private, max-age=60')
    return { rows }
  })

  // PCG.1 — a product's CAMPAIGNS (the expansion rows). Per-campaign the
  // PRODUCT's own spend/sales/ACOS (from PRODUCT_AD, NOT the whole-campaign
  // total which includes other products). If productId is a parent, includes
  // all its children. Optional status filter.
  // GET /advertising/by-product/campaigns?productId=&windowDays=&marketplace=&status=
  fastify.get('/advertising/by-product/campaigns', async (request, reply) => {
    const q = request.query as { productId?: string; windowDays?: string; marketplace?: string; status?: string; preset?: string; startDate?: string; endDate?: string }
    if (!q.productId) { reply.status(400); return { error: 'productId required' } }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(q)
    const since = range.since
    const dateFilterBPC = { gte: since, lte: range.until }
    const mkt = q.marketplace || undefined

    // Resolve the product + its children (parent rows roll up variants).
    const childRows = await prisma.product.findMany({ where: { parentId: q.productId }, select: { id: true } })
    const productIds = [...new Set([q.productId, ...childRows.map((c) => c.id)])]

    // Each AdProductAd = this product advertised in one campaign. Group its
    // PRODUCT_AD perf by campaign → the product's spend/sales in that campaign.
    const ads = await prisma.adProductAd.findMany({
      where: { productId: { in: productIds } },
      select: { id: true, adGroup: { select: { campaign: { select: { id: true, name: true, marketplace: true, status: true, dailyBudget: true, adProduct: true } } } } },
    })
    const adToCampaign = new Map<string, { id: string; name: string; marketplace: string | null; status: string; dailyBudget: unknown; adProduct: string | null }>()
    for (const a of ads) { const c = a.adGroup?.campaign; if (c?.id) adToCampaign.set(a.id, c) }
    const adIds = [...adToCampaign.keys()]
    const perAd = adIds.length ? await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'PRODUCT_AD', localEntityId: { in: adIds }, date: dateFilterBPC, ...(mkt ? { marketplace: mkt } : {}) },
      _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
    }) : []

    interface CampAgg { id: string; name: string; marketplace: string | null; status: string; adProduct: string | null; dailyBudgetCents: number; spendC: number; salesC: number; impr: number; clicks: number; orders: number }
    const byCampaign = new Map<string, CampAgg>()
    for (const r of perAd) {
      const c = r.localEntityId ? adToCampaign.get(r.localEntityId) : null
      if (!c) continue
      let g = byCampaign.get(c.id)
      if (!g) { g = { id: c.id, name: c.name, marketplace: c.marketplace, status: c.status, adProduct: c.adProduct, dailyBudgetCents: Math.round(parseFloat(String(c.dailyBudget ?? '0')) * 100), spendC: 0, salesC: 0, impr: 0, clicks: 0, orders: 0 }; byCampaign.set(c.id, g) }
      g.spendC += microsToCents(r._sum.costMicros)
      g.salesC += r._sum.sales7dCents ?? 0
      g.impr += r._sum.impressions ?? 0
      g.clicks += r._sum.clicks ?? 0
      g.orders += r._sum.orders7d ?? 0
    }
    let rows = [...byCampaign.values()]
    if (q.status) rows = rows.filter((c) => c.status === q.status)
    if (mkt) rows = rows.filter((c) => c.marketplace === mkt)
    const out = rows.map((c) => ({
      id: c.id, name: c.name, marketplace: c.marketplace, status: c.status, adProduct: c.adProduct,
      dailyBudgetCents: c.dailyBudgetCents,
      adSpendCents: c.spendC, adSalesCents: c.salesC,
      acos: c.salesC > 0 ? Math.round((c.spendC / c.salesC) * 1000) / 10 : null,
      impressions: c.impr, clicks: c.clicks, orders: c.orders,
    })).sort((a, b) => b.adSpendCents - a.adSpendCents)
    reply.header('Cache-Control', 'private, max-age=60')
    return { rows: out }
  })

  // PC.7 — bulk action on the campaigns behind selected products. Resolves
  // products → AdProductAd → distinct campaigns and applies status/budget via
  // the audited updateCampaignWithSync path (OutboundSyncQueue grace + gate).
  // POST /advertising/by-product/bulk { productIds[], action, value? }
  fastify.post('/advertising/by-product/bulk', async (request, reply) => {
    const b = request.body as { productIds?: string[]; action?: string; value?: number }
    if (!Array.isArray(b?.productIds) || b.productIds.length === 0) { reply.status(400); return { error: 'productIds[] required' } }
    const action = b.action
    if (!['pause', 'enable', 'budgetPct'].includes(String(action))) { reply.status(400); return { error: 'action must be pause|enable|budgetPct' } }
    // Rows are PARENT products (PCF.1) but ads live on the VARIANTS — expand
    // each selected parent to its children so bulk fans out to all variant
    // campaigns. (Standalone/variant ids pass through unchanged.)
    const childRows = await prisma.product.findMany({ where: { parentId: { in: b.productIds } }, select: { id: true } })
    const allProductIds = [...new Set([...b.productIds, ...childRows.map((c) => c.id)])]
    // Resolve distinct campaigns advertising any of these products.
    const ads = await prisma.adProductAd.findMany({
      where: { productId: { in: allProductIds } },
      select: { adGroup: { select: { campaign: { select: { id: true, dailyBudget: true } } } } },
    })
    const campaigns = new Map<string, { id: string; dailyBudget: unknown }>()
    for (const a of ads) { const c = a.adGroup?.campaign; if (c?.id) campaigns.set(c.id, c) }
    const actor = actorFromHeaders(request.headers as Record<string, unknown>)
    let ok = 0, failed = 0
    for (const c of campaigns.values()) {
      const patch: Parameters<typeof updateCampaignWithSync>[0]['patch'] = {}
      if (action === 'pause') patch.status = 'PAUSED'
      else if (action === 'enable') patch.status = 'ENABLED'
      else if (action === 'budgetPct') {
        const cur = parseFloat(String(c.dailyBudget ?? '0')) || 0
        patch.dailyBudget = Math.max(1, Math.round(cur * (1 + (b.value ?? 0) / 100) * 100) / 100)
      }
      const r = await updateCampaignWithSync({ campaignId: c.id, patch, actor, reason: `by-product bulk ${action}`, applyImmediately: false }).catch(() => ({ ok: false }))
      if ((r as { ok?: boolean }).ok === false) failed++; else ok++
    }
    return { ok: true, campaignsAffected: campaigns.size, succeeded: ok, failed }
  })

  //   STALE_CAMPAIGN  — ENABLED campaigns with 0 impressions in windowDays
  //
  // Each insight has a severity (critical | warning | info), a title,
  // a description and up to 5 representative items for quick scanning.
  fastify.get('/advertising/insights', async (request, reply) => {
    const query = request.query as {
      windowDays?: string
      minSpendEur?: string
      acosTarget?: string
      lowAcosTarget?: string
      marketplace?: string
      campaignId?: string
    }
    const windowDays   = Math.max(7, Math.min(90, Number(query.windowDays   ?? 14)))
    const minSpendEur  = Math.max(0, Number(query.minSpendEur  ?? 1))
    const acosTarget   = Math.max(1, Number(query.acosTarget   ?? 35))
    const lowAcosTarget = Math.max(1, Number(query.lowAcosTarget ?? 8))
    const minMicros    = BigInt(Math.round(minSpendEur * 1_000_000))

    const since = new Date()
    since.setUTCDate(since.getUTCDate() - windowDays)
    since.setUTCHours(0, 0, 0, 0)

    // CD.5 — optional per-campaign scope. Resolve the campaign once so every
    // insight below narrows to it (negative-kw candidates by externalCampaignId,
    // ACOS rows by entityId). When campaign-scoped we skip the STALE insight —
    // that is an account-wide "which enabled campaigns went dark" sweep.
    let scopeExtId: string | null = null
    let scopeMarketplace: string | undefined = query.marketplace
    if (query.campaignId) {
      const c = await prisma.campaign.findUnique({
        where: { id: query.campaignId },
        select: { externalCampaignId: true, marketplace: true },
      })
      if (!c) { reply.status(404); return { error: 'campaign not found' } }
      scopeExtId = c.externalCampaignId
      scopeMarketplace = c.marketplace ?? query.marketplace
    }

    const { findNegativeKeywordCandidates } = await import(
      '../services/advertising/ads-reports.service.js'
    )

    // ── 1. Negative keyword candidates ──────────────────────────────────
    const negKwRaw = await findNegativeKeywordCandidates({
      lookbackDays: windowDays,
      minSpend: minSpendEur,
      limit: 200,
      ...(scopeMarketplace ? { marketplace: scopeMarketplace } : {}),
      ...(scopeExtId ? { externalCampaignId: scopeExtId } : {}),
    })
    const negKwTotalMicros = negKwRaw.reduce((s, r) => s + BigInt(r.totalCostMicros.toString()), 0n)
    const negKwInsight = negKwRaw.length === 0 ? null : {
      type: 'NEGATIVE_KW' as const,
      severity: negKwRaw.length >= 10 ? 'critical' : 'warning',
      title: `${negKwRaw.length} search term${negKwRaw.length === 1 ? '' : 's'} spend without converting`,
      description: `${negKwRaw.length} queries used €${(Number(negKwTotalMicros) / 1_000_000).toFixed(2)} in the last ${windowDays} days with zero orders. Add them as negative keywords to stop the bleed.`,
      count: negKwRaw.length,
      totalSpendCents: Math.round(Number(negKwTotalMicros) / 10_000),
      items: negKwRaw.slice(0, 5).map((r) => ({
        query:      r.query,
        matchType:  r.matchType,
        adProduct:  r.adProduct,
        marketplace: r.marketplace,
        clicks:     r.totalClicks,
        costEur:    Number(BigInt(r.totalCostMicros.toString())) / 1_000_000,
      })),
    }

    // ── 2 + 3. Per-campaign ACOS (HIGH + LOW) ───────────────────────────
    const perfByCampaign = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['entityId', 'adProduct', 'marketplace'],
      where: {
        date: { gte: since },
        entityType: 'CAMPAIGN',
        ...(scopeMarketplace ? { marketplace: scopeMarketplace } : {}),
        ...(scopeExtId ? { entityId: scopeExtId } : {}),
      },
      _sum: {
        costMicros:    true,
        sales7dCents:  true,
        sales14dCents: true,
        impressions:   true,
      },
      having: { costMicros: { _sum: { gte: minMicros } } },
    })

    // Enrich with campaign names from the Campaign table
    const campaignIds = [...new Set(perfByCampaign.map((r) => r.entityId))]
    const campaignNames = await prisma.campaign.findMany({
      where: { externalCampaignId: { in: campaignIds } },
      select: { externalCampaignId: true, name: true },
    })
    const nameMap = new Map(campaignNames.map((c) => [c.externalCampaignId ?? '', c.name]))

    type CampRow = {
      entityId: string; adProduct: string; marketplace: string
      spendEur: number; adSalesCents: number; acos: number; impressions: number
      name: string
    }
    const campRows: CampRow[] = perfByCampaign.map((r) => {
      const spendMicros  = Number(r._sum.costMicros ?? 0n)
      const adSalesCents = (r._sum.sales7dCents ?? 0) + (r._sum.sales14dCents ?? 0)
      const spendCents   = spendMicros / 10_000
      const acos = adSalesCents > 0 ? (spendCents / adSalesCents) * 100 : 999
      return {
        entityId:    r.entityId,
        adProduct:   r.adProduct ?? 'UNKNOWN',
        marketplace: r.marketplace,
        spendEur:    spendMicros / 1_000_000,
        adSalesCents,
        acos,
        impressions: r._sum.impressions ?? 0,
        name:        nameMap.get(r.entityId) ?? r.entityId,
      }
    })

    const highAcos = campRows
      .filter((r) => r.acos > acosTarget && r.adSalesCents > 0)
      .sort((a, b) => b.acos - a.acos)
    const lowAcos = campRows
      .filter((r) => r.acos < lowAcosTarget && r.acos >= 0 && r.adSalesCents > 0 && r.spendEur >= 5)
      .sort((a, b) => a.acos - b.acos)

    const highAcosInsight = highAcos.length === 0 ? null : {
      type: 'HIGH_ACOS' as const,
      severity: highAcos.length >= 3 ? 'critical' : 'warning',
      title: `${highAcos.length} campaign${highAcos.length === 1 ? '' : 's'} above ${acosTarget}% ACOS`,
      description: `These campaigns are spending more on ads than they return in attributed sales. Consider lowering bids or adding negative keywords.`,
      count: highAcos.length,
      totalSpendCents: Math.round(highAcos.reduce((s, r) => s + r.spendEur * 100, 0)),
      items: highAcos.slice(0, 5).map((r) => ({
        name: r.name, adProduct: r.adProduct, marketplace: r.marketplace,
        acos: Math.round(r.acos * 10) / 10, spendEur: Math.round(r.spendEur * 100) / 100,
      })),
    }

    const lowAcosInsight = lowAcos.length === 0 ? null : {
      type: 'LOW_ACOS' as const,
      severity: 'info',
      title: `${lowAcos.length} campaign${lowAcos.length === 1 ? '' : 's'} below ${lowAcosTarget}% ACOS — room to scale`,
      description: `Very low ACOS with real spend means headroom exists. Raising bids or daily budgets could capture more sales profitably.`,
      count: lowAcos.length,
      totalSpendCents: Math.round(lowAcos.reduce((s, r) => s + r.spendEur * 100, 0)),
      items: lowAcos.slice(0, 5).map((r) => ({
        name: r.name, adProduct: r.adProduct, marketplace: r.marketplace,
        acos: Math.round(r.acos * 10) / 10, spendEur: Math.round(r.spendEur * 100) / 100,
      })),
    }

    // ── 4. Stale ENABLED campaigns (no impressions in window) ───────────
    // Account-wide sweep — skipped when scoped to a single campaign.
    const activeCampaigns = scopeExtId ? [] : await prisma.campaign.findMany({
      where: {
        status: 'ENABLED',
        externalCampaignId: { not: null },
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
      },
      select: { externalCampaignId: true, name: true, adProduct: true, marketplace: true },
    })
    const withImpressions = new Set(
      perfByCampaign.filter((r) => (r._sum.impressions ?? 0) > 0).map((r) => r.entityId),
    )
    const stale = activeCampaigns.filter(
      (c) => c.externalCampaignId && !withImpressions.has(c.externalCampaignId),
    )
    const staleInsight = stale.length === 0 ? null : {
      type: 'STALE_CAMPAIGN' as const,
      severity: stale.length >= 5 ? 'warning' : 'info',
      title: `${stale.length} enabled campaign${stale.length === 1 ? '' : 's'} with zero impressions`,
      description: `These campaigns are ENABLED but received no impressions in the last ${windowDays} days. Check for budget exhaustion, paused ad groups, or poor bid coverage.`,
      count: stale.length,
      totalSpendCents: 0,
      items: stale.slice(0, 5).map((c) => ({
        name: c.name, adProduct: c.adProduct ?? 'UNKNOWN', marketplace: c.marketplace ?? '—',
      })),
    }

    const insights = [negKwInsight, highAcosInsight, staleInsight, lowAcosInsight]
      .filter(Boolean)

    reply.header('Cache-Control', 'private, max-age=120')
    return {
      windowDays,
      generatedAt: new Date().toISOString(),
      params: { minSpendEur, acosTarget, lowAcosTarget },
      count: insights.length,
      insights,
    }
  })

  // ── Phase 5a: v1 overview endpoint ────────────────────────────────────
  // Returns a comprehensive snapshot of every v1 substrate (Phase 2/4/6):
  //   - per-currency spend + sales in the last 30 days
  // GET /api/advertising/trends — daily TACOS + ACOS time-series
  //
  // Merges two Prisma queries:
  //   1. AmazonAdsDailyPerformance grouped by date → ad spend + ad sales
  //   2. DailySalesAggregate grouped by day (channel=AMAZON) → total revenue
  //
  // TACOS = adSpend / totalRevenue * 100 (requires both sources)
  // ACOS  = adSpend / adSales     * 100 (ads-only, always available)
  fastify.get('/advertising/trends', async (request, reply) => {
    const query = request.query as {
      windowDays?: string
      marketplace?: string
      adProduct?: string
      currencyCode?: string
      campaignId?: string
      compare?: string
      preset?: string
      startDate?: string
      endDate?: string
    }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(query)
    const windowDays = range.days
    const since = range.since
    const until = range.until

    // CD.1 — optional per-campaign scope. Resolve the campaign so we can
    // filter the daily-perf rows to it (localEntityId is the indexed FK to
    // Campaign.id; entityId holds the external Amazon id — match either so
    // the chart works regardless of which the ingester populated). When
    // campaign-scoped we drop the account-revenue/TACOS join: TACOS is an
    // account-level metric and would mislead at the campaign grain.
    let campaignScope: { localEntityId: string; entityId: string | null } | null = null
    if (query.campaignId) {
      const c = await prisma.campaign.findUnique({
        where: { id: query.campaignId },
        select: { id: true, externalCampaignId: true },
      })
      if (!c) { reply.status(404); return { error: 'campaign not found' } }
      campaignScope = { localEntityId: c.id, entityId: c.externalCampaignId }
    }
    const campaignWhere = campaignScope
      ? { OR: [
          { localEntityId: campaignScope.localEntityId },
          ...(campaignScope.entityId ? [{ entityId: campaignScope.entityId }] : []),
        ] }
      : {}

    const { cached: cachedTrends } = await import('../services/advertising/ads-cache.js')
    const trendsKey = `trends:${query.campaignId ?? ''}:${range.sinceStr}:${range.untilStr}:${query.marketplace ?? ''}:${query.adProduct ?? ''}:${query.currencyCode ?? ''}:${query.compare ?? ''}`
    const result = await cachedTrends(trendsKey, 300, async () => {
    // ── Ad performance per day ──────────────────────────────────────────
    const perfByDay = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['date'],
      where: {
        date: { gte: since, lte: until },
        entityType: 'CAMPAIGN',
        ...campaignWhere,
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
        ...(query.adProduct   ? { adProduct:   query.adProduct   } : {}),
        ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
      },
      _sum: {
        impressions:   true,
        clicks:        true,
        costMicros:    true,
        sales7dCents:  true,
        sales14dCents: true,
        orders7d:      true,
      },
      orderBy: { date: 'asc' },
    })

    // ── Total Amazon revenue per day (SP-API Sales & Traffic) ──────────
    // Skipped in campaign scope (TACOS is account-level, not per-campaign).
    const salesByDay = campaignScope ? [] : await prisma.dailySalesAggregate.groupBy({
      by: ['day'],
      where: {
        day:     { gte: since, lte: until },
        channel: 'AMAZON',
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
      },
      _sum: { grossRevenue: true, unitsSold: true, ordersCount: true },
      orderBy: { day: 'asc' },
    })

    // Index total revenue by ISO date string for O(1) merge
    const revenueMap = new Map<string, { revenueCents: number; units: number; orders: number }>()
    for (const r of salesByDay) {
      const key = r.day.toISOString().slice(0, 10)
      revenueMap.set(key, {
        revenueCents: Math.round(Number(r._sum.grossRevenue ?? 0) * 100),
        units:  r._sum.unitsSold  ?? 0,
        orders: r._sum.ordersCount ?? 0,
      })
    }

    // ── Merge ───────────────────────────────────────────────────────────
    const rows = perfByDay.map((p) => {
      const dateKey = p.date.toISOString().slice(0, 10)
      const spendMicros = Number(p._sum.costMicros ?? 0n)
      const adSpendCents = spendMicros / 10_000          // micros → cents
      // SP/SD 7d + SB 14d — avoid double-counting by using only one window
      const adSalesCents = (p._sum.sales7dCents ?? 0) + (p._sum.sales14dCents ?? 0)
      const rev = revenueMap.get(dateKey)
      const totalRevenueCents = rev?.revenueCents ?? 0

      const acos  = adSalesCents > 0
        ? (adSpendCents / adSalesCents) * 100 : null
      const tacos = totalRevenueCents > 0
        ? (adSpendCents / totalRevenueCents) * 100 : null
      const ctr = (p._sum.impressions ?? 0) > 0
        ? ((p._sum.clicks ?? 0) / (p._sum.impressions ?? 1)) * 100 : null

      return {
        date:             dateKey,
        impressions:      p._sum.impressions  ?? 0,
        clicks:           p._sum.clicks       ?? 0,
        orders:           p._sum.orders7d     ?? 0,
        adSpendCents:     Math.round(adSpendCents),
        adSalesCents,
        totalRevenueCents,
        acos:             acos  != null ? Math.round(acos  * 100) / 100 : null,
        tacos:            tacos != null ? Math.round(tacos * 100) / 100 : null,
        ctr:              ctr   != null ? Math.round(ctr   * 100) / 100 : null,
      }
    })

    // CD.2 — period-over-period comparison. Sums the current window from the
    // rows already computed + one aggregate query over the immediately prior
    // equal-length window (same scope), so the detail page can render ▲/▼ vs
    // the previous period on each KPI tile.
    const summarize = (sp: number, sa: number, im: number, cl: number, or: number) => ({
      impressions: im, clicks: cl, orders: or, spendCents: sp, salesCents: sa,
      acos: sa > 0 ? Math.round((sp / sa) * 10000) / 100 : null,
      roas: sp > 0 ? Math.round((sa / sp) * 100) / 100 : null,
      ctr:  im > 0 ? Math.round((cl / im) * 10000) / 100 : null,
    })
    const curSummary = summarize(
      rows.reduce((s, r) => s + r.adSpendCents, 0),
      rows.reduce((s, r) => s + r.adSalesCents, 0),
      rows.reduce((s, r) => s + r.impressions, 0),
      rows.reduce((s, r) => s + r.clicks, 0),
      rows.reduce((s, r) => s + r.orders, 0),
    )
    let previous: ReturnType<typeof summarize> | null = null
    if (query.compare === 'true' || query.compare === '1') {
      const prevSince = new Date(since)
      prevSince.setUTCDate(prevSince.getUTCDate() - windowDays)
      const prev = await prisma.amazonAdsDailyPerformance.aggregate({
        where: {
          date: { gte: prevSince, lt: since },
          entityType: 'CAMPAIGN',
          ...campaignWhere,
          ...(query.marketplace ? { marketplace: query.marketplace } : {}),
          ...(query.adProduct   ? { adProduct:   query.adProduct   } : {}),
          ...(query.currencyCode ? { currencyCode: query.currencyCode } : {}),
        },
        _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true },
      })
      previous = summarize(
        Math.round(Number(prev._sum.costMicros ?? 0n) / 10_000),
        (prev._sum.sales7dCents ?? 0) + (prev._sum.sales14dCents ?? 0),
        prev._sum.impressions ?? 0,
        prev._sum.clicks ?? 0,
        prev._sum.orders7d ?? 0,
      )
    }

    return { windowDays, count: rows.length, rows, summary: curSummary, previous, range: { preset: range.preset, startDate: range.sinceStr, endDate: range.untilStr, includesToday: range.includesToday } }
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return result
  })

  // CD.6 — batched per-entity sparklines. Returns one trailing daily series
  // (spend or clicks) per ad group / target under a campaign in a single
  // round-trip, keyed by the LOCAL entity id (AdGroup.id / AdTarget.id) so the
  // cockpit tables can drop a sparkline column straight in. Placements get
  // their dedicated trend treatment in CD.7.
  // GET /advertising/trends/sparklines?campaignId=&entityType=AD_GROUP|AD_TARGET&metric=spend|clicks&windowDays=14
  fastify.get('/advertising/trends/sparklines', async (request, reply) => {
    const q = request.query as { campaignId?: string; entityType?: string; metric?: string; windowDays?: string }
    if (!q.campaignId) { reply.status(400); return { error: 'campaignId required' } }
    const entityType = q.entityType === 'AD_TARGET' ? 'AD_TARGET' : 'AD_GROUP'
    const metric = q.metric === 'clicks' ? 'clicks' : 'spend'
    const windowDays = Math.max(7, Math.min(90, Number(q.windowDays ?? 14)))
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - (windowDays - 1))
    since.setUTCHours(0, 0, 0, 0)

    const { cached: cachedSpark } = await import('../services/advertising/ads-cache.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return cachedSpark(`spark:${q.campaignId}:${entityType}:${metric}:${windowDays}`, 300, async () => {
    // Resolve the campaign's child local ids for the requested grain.
    const localIds = entityType === 'AD_GROUP'
      ? (await prisma.adGroup.findMany({ where: { campaignId: q.campaignId }, select: { id: true } })).map((r) => r.id)
      : (await prisma.adTarget.findMany({ where: { adGroup: { campaignId: q.campaignId } }, select: { id: true } })).map((r) => r.id)
    if (localIds.length === 0) { return { windowDays, metric, entityType, series: {} } }

    const perf = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'date'],
      where: { entityType, localEntityId: { in: localIds }, date: { gte: since } },
      _sum: { costMicros: true, clicks: true },
    })

    // Build a fixed date axis so every series is the same length + aligned.
    const axis: string[] = []
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(since); d.setUTCDate(since.getUTCDate() + i)
      axis.push(d.toISOString().slice(0, 10))
    }
    const idx = new Map(axis.map((d, i) => [d, i]))
    const series: Record<string, number[]> = {}
    for (const id of localIds) series[id] = new Array(windowDays).fill(0)
    for (const r of perf) {
      if (!r.localEntityId) continue
      const k = r.date.toISOString().slice(0, 10)
      const i = idx.get(k)
      if (i == null) continue
      const arr = series[r.localEntityId]
      if (!arr) continue
      arr[i] = metric === 'clicks'
        ? (r._sum.clicks ?? 0)
        : microsToCents(r._sum.costMicros) // cents
    }

    return { windowDays, metric, entityType, axis, series }
    })
  })

  // CD.12 — dayparting heatmap. Aggregates the hourly store (CD.11) into a
  // weekday × hour grid in Europe/Rome wall-clock time (the AT TIME ZONE
  // double-cast: stored UTC → Rome, never a single cast). Powers "which hours
  // convert" + convert-aware scheduling. Empty until AMS hourly data lands.
  // GET /advertising/campaigns/:id/dayparting?windowDays=30
  fastify.get('/advertising/campaigns/:id/dayparting', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { windowDays?: string }
    const windowDays = Math.max(7, Math.min(90, Number(q.windowDays ?? 30)))
    const campaign = await prisma.campaign.findUnique({ where: { id }, select: { id: true, externalCampaignId: true } })
    if (!campaign) { reply.status(404); return { error: 'campaign not found' } }
    const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)

    // dow: 0=Sunday..6=Saturday (Postgres EXTRACT(DOW)). hour: 0-23 Rome.
    const rows = await prisma.$queryRaw<Array<{ dow: number; hour: number; cost: bigint | null; orders: bigint | null; sales: bigint | null; impressions: bigint | null; clicks: bigint | null }>>`
      SELECT EXTRACT(DOW FROM ts_rome)::int AS dow,
             EXTRACT(HOUR FROM ts_rome)::int AS hour,
             SUM("costMicros") AS cost,
             SUM(COALESCE("orders7d", 0)) AS orders,
             SUM(COALESCE("sales7dCents", 0)) AS sales,
             SUM("impressions") AS impressions,
             SUM("clicks") AS clicks
      FROM (
        SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts_rome,
               "costMicros", "orders7d", "sales7dCents", "impressions", "clicks"
        FROM "AmazonAdsHourlyPerformance"
        WHERE ("localEntityId" = ${campaign.id} OR "entityId" = ${campaign.externalCampaignId ?? '__none__'})
          AND "date" >= ${since}
      ) t
      GROUP BY dow, hour
      ORDER BY dow, hour`

    const cells = rows.map((r) => {
      const costCents = Math.round(Number(r.cost ?? 0n) / 10_000)
      const salesCents = Number(r.sales ?? 0n)
      return {
        dow: r.dow, hour: r.hour, costCents, salesCents,
        orders: Number(r.orders ?? 0n),
        impressions: Number(r.impressions ?? 0n),
        clicks: Number(r.clicks ?? 0n),
        acos: salesCents > 0 ? Math.round((costCents / salesCents) * 1000) / 10 : null,
      }
    })
    reply.header('Cache-Control', 'private, max-age=300')
    return { windowDays, timezone: 'Europe/Rome', hasData: cells.length > 0, cells }
  })

  // ── D-INT2: multi-campaign dayparting heatmap. Aggregates AmazonAdsHourlyPerformance
  //    across a SET of campaigns into dow×hour cells (all metrics) for the Dayparting
  //    Schedule Criteria heatmap + chart. Same SQL as the single-campaign endpoint, with
  //    IN-lists (Prisma.join) and a whitelisted timezone. ──
  fastify.get('/advertising/dayparting/heatmap', async (request, reply) => {
    const q = request.query as { campaignIds?: string; windowDays?: string; tz?: string }
    const ids = (q.campaignIds ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!ids.length) return { windowDays: 0, timezone: 'Europe/Rome', hasData: false, cells: [] }
    const windowDays = Math.max(7, Math.min(90, Number(q.windowDays ?? 60)))
    // whitelist the timezone (it's interpolated into AT TIME ZONE) — never trust the raw param
    const TZ_OK = new Set(['Europe/Rome', 'Europe/London', 'Europe/Madrid', 'Europe/Paris', 'Europe/Berlin', 'America/Los_Angeles', 'America/New_York', 'UTC'])
    const tz = TZ_OK.has(q.tz ?? '') ? (q.tz as string) : 'Europe/Rome'

    const camps = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, externalCampaignId: true } })
    if (!camps.length) return { windowDays, timezone: tz, hasData: false, cells: [] }
    const localIds = camps.map((c) => c.id)
    const extIds = camps.map((c) => c.externalCampaignId).filter(Boolean) as string[]
    const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)

    const rows = await prisma.$queryRaw<Array<{ dow: number; hour: number; cost: bigint | null; orders: bigint | null; sales: bigint | null; impressions: bigint | null; clicks: bigint | null }>>`
      SELECT EXTRACT(DOW FROM ts_local)::int AS dow,
             EXTRACT(HOUR FROM ts_local)::int AS hour,
             SUM("costMicros") AS cost, SUM(COALESCE("orders7d", 0)) AS orders,
             SUM(COALESCE("sales7dCents", 0)) AS sales, SUM("impressions") AS impressions, SUM("clicks") AS clicks
      FROM (
        SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE ${tz}) AS ts_local,
               "costMicros", "orders7d", "sales7dCents", "impressions", "clicks"
        FROM "AmazonAdsHourlyPerformance"
        WHERE "entityType" = 'CAMPAIGN' AND "date" >= ${since}
          AND ("localEntityId" IN (${Prisma.join(localIds)})${extIds.length ? Prisma.sql` OR "entityId" IN (${Prisma.join(extIds)})` : Prisma.empty})
      ) t
      GROUP BY dow, hour ORDER BY dow, hour`

    const cells = rows.map((r) => {
      const costCents = Math.round(Number(r.cost ?? 0n) / 10_000)
      const salesCents = Number(r.sales ?? 0n)
      return {
        dow: r.dow, hour: r.hour, costCents, salesCents,
        orders: Number(r.orders ?? 0n), impressions: Number(r.impressions ?? 0n), clicks: Number(r.clicks ?? 0n),
        acos: salesCents > 0 ? Math.round((costCents / salesCents) * 1000) / 10 : null,
        roas: costCents > 0 ? Math.round((salesCents / costCents) * 100) / 100 : null,
      }
    })
    reply.header('Cache-Control', 'private, max-age=300')
    return { windowDays, timezone: tz, hasData: cells.some((c) => c.costCents > 0 || c.clicks > 0), cells }
  })

  //   - per-adProduct live status from the adapter registry
  //   - report job counts by status
  //   - search-term cardinality + negative-keyword-candidate count
  // Designed for the Trading Desk landing page; one round-trip, no FK joins.
  fastify.get('/advertising/overview/v1', async (_request, reply) => {
    const { findNegativeKeywordCandidates } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    // H.2e: The per-product adapter registry is retired. The v1 unified
    // export pipeline covers all 3 ad products from a single code path.
    // This snapshot keeps the same response shape for back-compat with
    // the Trading Desk landing page.
    const ADAPTERS_SNAPSHOT = [
      { adProduct: 'SPONSORED_PRODUCTS', live: true, blockerReason: null },
      { adProduct: 'SPONSORED_BRANDS',   live: true, blockerReason: null },
      { adProduct: 'SPONSORED_DISPLAY',  live: true, blockerReason: null },
    ]

    const since30d = new Date()
    since30d.setUTCDate(since30d.getUTCDate() - 30)
    since30d.setUTCHours(0, 0, 0, 0)

    // Per-currency aggregates from the universal time-series table.
    const perfRows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['currencyCode', 'adProduct'],
      where: { date: { gte: since30d }, entityType: 'CAMPAIGN' },
      _sum: {
        impressions: true,
        clicks: true,
        costMicros: true,
        sales7dCents: true,
        sales14dCents: true,
        orders7d: true,
      },
    })

    // Roll up to per-currency totals across all ad products
    type CurrencyAgg = {
      currencyCode: string
      impressions: number
      clicks: number
      costMicros: bigint
      salesCents: number
      orders: number
    }
    const byCurrency = new Map<string, CurrencyAgg>()
    for (const r of perfRows) {
      const existing = byCurrency.get(r.currencyCode) ?? {
        currencyCode: r.currencyCode,
        impressions: 0, clicks: 0, costMicros: 0n, salesCents: 0, orders: 0,
      }
      existing.impressions += r._sum.impressions ?? 0
      existing.clicks += r._sum.clicks ?? 0
      existing.costMicros += r._sum.costMicros ?? 0n
      // Use whichever attribution window has data (SP/SD = 7d, SB = 14d)
      existing.salesCents += (r._sum.sales7dCents ?? 0) + (r._sum.sales14dCents ?? 0)
      existing.orders += r._sum.orders7d ?? 0
      byCurrency.set(r.currencyCode, existing)
    }

    // Report job counts by status
    const jobsByStatus = await prisma.amazonAdsReportJob.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    const reportJobs: Record<string, number> = {
      PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0, FAILED: 0, EXPIRED: 0,
    }
    for (const j of jobsByStatus) {
      reportJobs[j.status] = j._count._all
    }

    // Search-term cardinality
    const searchTermCount = await prisma.amazonAdsSearchTerm.count()
    const candidates = await findNegativeKeywordCandidates({ lookbackDays: 30, minSpend: 2, limit: 1 })
    const negativeKwCandidates = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'campaignId', 'adGroupId'],
      where: { date: { gte: since30d } },
      _sum: { costMicros: true, orders7d: true },
      having: {
        costMicros: { _sum: { gte: 2_000_000n } },
        orders7d: { _sum: { equals: 0 } },
      },
    }).then((r) => r.length).catch(() => candidates.length)

    // Campaign counts per adProduct (from Campaign table — populated by SD sync today)
    const campaignsByProduct = await prisma.campaign.groupBy({
      by: ['adProduct'],
      where: { adProduct: { not: null } },
      _count: { _all: true },
    })
    const byAdProduct = Object.fromEntries(
      campaignsByProduct.map((c) => [c.adProduct ?? 'UNKNOWN', c._count._all]),
    )

    reply.header('Cache-Control', 'private, max-age=30')
    return {
      windowDays: 30,
      spend: Array.from(byCurrency.values()).map((c) => ({
        currencyCode: c.currencyCode,
        impressions: c.impressions,
        clicks: c.clicks,
        costMicros: c.costMicros.toString(),
        costUnits: Number(c.costMicros) / 1_000_000,
        salesCents: c.salesCents,
        orders: c.orders,
        acos: c.salesCents > 0
          ? Number(c.costMicros / 10_000n) / c.salesCents
          : null,
        roas: c.costMicros > 0n
          ? c.salesCents / (Number(c.costMicros) / 1_000_000) / 100
          : null,
      })),
      adapters: ADAPTERS_SNAPSHOT,
      campaigns: { byAdProduct },
      reports: reportJobs,
      searchTerms: {
        total: searchTermCount,
        negativeKeywordCandidates: negativeKwCandidates,
      },
    }
  })

  // ── Phase 6: search-term + placement cycles + cleanup + neg-kw query ──

  // POST /api/advertising/reports/create-search-terms-cycle
  fastify.post('/advertising/reports/create-search-terms-cycle', async (request, reply) => {
    const body = request.body as {
      startDate?: string
      endDate?: string
      adProducts?: Array<'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS'>
    }
    if (!body.startDate || !body.endDate) {
      return reply.code(400).send({ error: 'startDate and endDate (YYYY-MM-DD) required' })
    }
    const { runSearchTermReportCycle } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await runSearchTermReportCycle({
      startDate: body.startDate,
      endDate: body.endDate,
      adProducts: body.adProducts,
    })
    return { ok: true, ...result }
  })

  // POST /api/advertising/reports/create-placements-cycle (SP only)
  fastify.post('/advertising/reports/create-placements-cycle', async (request, reply) => {
    const body = request.body as { startDate?: string; endDate?: string }
    if (!body.startDate || !body.endDate) {
      return reply.code(400).send({ error: 'startDate and endDate (YYYY-MM-DD) required' })
    }
    const { runPlacementReportCycle } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await runPlacementReportCycle({
      startDate: body.startDate,
      endDate: body.endDate,
    })
    return { ok: true, ...result }
  })

  // POST /api/advertising/reports/create-advertised-product-cycle (SP only) — PC.0
  fastify.post('/advertising/reports/create-advertised-product-cycle', async (request, reply) => {
    const body = request.body as { startDate?: string; endDate?: string }
    if (!body.startDate || !body.endDate) {
      return reply.code(400).send({ error: 'startDate and endDate (YYYY-MM-DD) required' })
    }
    const { runAdvertisedProductReportCycle } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await runAdvertisedProductReportCycle({ startDate: body.startDate, endDate: body.endDate })
    return { ok: true, ...result }
  })

  // POST /api/advertising/debug/backfill-campaign-adproduct — Phase B follow-up
  //
  // One-time backfill: derives Campaign.adProduct from the legacy `type`
  // column for existing rows where adProduct is null. Idempotent. The
  // sync code itself was fixed to populate both columns going forward;
  // this route just patches the rows that already exist.
  fastify.post('/advertising/debug/backfill-campaign-adproduct', async (_request, _reply) => {
    const mapping: Array<{ type: 'SP' | 'SB' | 'SD'; adProduct: string }> = [
      { type: 'SP', adProduct: 'SPONSORED_PRODUCTS' },
      { type: 'SB', adProduct: 'SPONSORED_BRANDS'  },
      { type: 'SD', adProduct: 'SPONSORED_DISPLAY' },
    ]
    const results: Record<string, number> = {}
    for (const { type, adProduct } of mapping) {
      const r = await prisma.campaign.updateMany({
        where: { type, adProduct: null },
        data: { adProduct },
      })
      results[type] = r.count
    }
    const totalUpdated = Object.values(results).reduce((s, n) => s + n, 0)
    return { ok: true, totalUpdated, byType: results }
  })

  // GET /api/advertising/debug/advertised-product-report — PC.0 diagnostic.
  // Downloads + dumps the latest COMPLETED spAdvertisedProduct report so we can
  // see Amazon's actual field names + whether the report is empty (ingest wrote
  // 0 rows). No DB writes.
  fastify.get('/advertising/debug/advertised-product-report', async (request) => {
    const q = request.query as { jobId?: string }
    const job = q.jobId
      ? await prisma.amazonAdsReportJob.findUnique({ where: { id: q.jobId } })
      : await prisma.amazonAdsReportJob.findFirst({ where: { reportTypeId: 'spAdvertisedProduct', status: 'COMPLETED' }, orderBy: { createdAt: 'desc' } })
    if (!job) return { error: 'no spAdvertisedProduct job found' }
    const info = { jobId: job.id, status: job.status, rowsIngested: job.rowsIngested, errorMessage: job.errorMessage, hasLocation: !!job.location, configuration: job.configuration }
    if (!job.location) return { info, note: 'no download location' }
    try {
      const { gunzipSync } = await import('node:zlib')
      const dl = await fetch(job.location)
      const buf = Buffer.from(await dl.arrayBuffer())
      let parsed: unknown
      try { parsed = JSON.parse(gunzipSync(buf).toString('utf8')) } catch { parsed = JSON.parse(buf.toString('utf8')) }
      const arr = Array.isArray(parsed) ? parsed : []
      return { info, rowCount: arr.length, firstKeys: arr[0] ? Object.keys(arr[0] as object) : [], sample: arr.slice(0, 3) }
    } catch (e) { return { info, error: (e as Error).message } }
  })

  // GET /api/advertising/debug/product-ad-reconcile — PCF.2 over-count diagnosis.
  // Per-day PRODUCT_AD spend vs CAMPAIGN spend (+ row counts + a sample), to see
  // which days are inflated and the PRODUCT_AD row structure. No writes.
  fastify.get('/advertising/debug/product-ad-reconcile', async (request) => {
    const q = request.query as { windowDays?: string }
    const windowDays = Math.max(1, Math.min(90, Number(q.windowDays ?? 30)))
    const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)
    const [pa, camp] = await Promise.all([
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['date'], where: { entityType: 'PRODUCT_AD', date: { gte: since } }, _sum: { costMicros: true }, _count: { _all: true } }),
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['date'], where: { entityType: 'CAMPAIGN', date: { gte: since } }, _sum: { costMicros: true } }),
    ])
    const campByDate = new Map(camp.map((r) => [r.date.toISOString().slice(0, 10), microsToCents(r._sum.costMicros)]))
    const byDay = pa.map((r) => {
      const d = r.date.toISOString().slice(0, 10)
      const paCents = microsToCents(r._sum.costMicros)
      const campCents = campByDate.get(d) ?? 0
      return { date: d, productAdEur: paCents / 100, campaignEur: campCents / 100, rows: r._count._all, ratio: campCents > 0 ? Math.round((paCents / campCents) * 100) / 100 : null }
    }).sort((a, b) => a.date.localeCompare(b.date))
    // entityId shape sample: how many PRODUCT_AD rows are keyed by adId vs ASIN:.
    const sample = await prisma.amazonAdsDailyPerformance.findMany({ where: { entityType: 'PRODUCT_AD', date: { gte: since } }, select: { entityId: true, localEntityId: true, date: true, costMicros: true, marketplace: true, profileId: true }, take: 8, orderBy: { costMicros: 'desc' } })
    const asinKeyed = await prisma.amazonAdsDailyPerformance.count({ where: { entityType: 'PRODUCT_AD', date: { gte: since }, entityId: { startsWith: 'ASIN:' } } })
    const total = await prisma.amazonAdsDailyPerformance.count({ where: { entityType: 'PRODUCT_AD', date: { gte: since } } })
    return { windowDays, byDay, asinKeyedRows: asinKeyed, totalProductAdRows: total, sample: sample.map((s) => ({ ...s, costMicros: s.costMicros.toString() })) }
  })

  // ── AME.4: reconciliation + self-heal ───────────────────────────────
  // GET = report (account vs attributed spend, EUR-normalised + data
  // freshness per marketplace). POST = also self-heal the stale stored
  // Campaign.spend columns from the daily table. The displayed surfaces
  // already derive live (AME.1–3); this proves + maintains it.
  fastify.get('/advertising/reconcile', async (request) => {
    const q = request.query as { windowDays?: string }
    const { reconcileAdMetrics } = await import('../services/advertising/ads-reconcile.service.js')
    return reconcileAdMetrics({ windowDays: Number(q.windowDays) || 30, heal: false })
  })
  fastify.post('/advertising/reconcile', async (request) => {
    const b = (request.body ?? {}) as { windowDays?: number }
    const { reconcileAdMetrics } = await import('../services/advertising/ads-reconcile.service.js')
    return reconcileAdMetrics({ windowDays: Number(b.windowDays) || 30, heal: true })
  })

  // AF.3 — fleet-wide target-accuracy reconcile (duplicates, manual campaigns
  // missing positives, per-marketplace coverage). Proves the keyword data is
  // structurally correct, independent of the metrics reconcile above.
  fastify.get('/advertising/reconcile/targets', async () => {
    const { reconcileTargetAccuracy } = await import('../services/advertising/ads-reconcile.service.js')
    return reconcileTargetAccuracy()
  })

  // POST /api/advertising/debug/wipe-product-ad — PCF.2 clean slate.
  // Deletes all PRODUCT_AD daily rows so they can be cleanly re-ingested (one
  // report per day, deduped). Returns the deleted count. Does NOT touch
  // CAMPAIGN/search-term/placement rows.
  fastify.post('/advertising/debug/wipe-product-ad', async (_request) => {
    const r = await prisma.amazonAdsDailyPerformance.deleteMany({ where: { entityType: 'PRODUCT_AD' } })
    return { ok: true, deleted: r.count }
  })

  // POST /api/advertising/debug/probe-endpoints — Phase A diagnostic
  //
  // Fires 12+ probes against Amazon Ads endpoints (legacy v2, v3 list,
  // Exports v1) for the given profileId and returns a structured report:
  // which variant Amazon accepts, status codes, response snippets.
  //
  // Manual-trigger only. Each invocation costs ~12 Amazon requests.
  // No DB writes, no production-path side effects (token cache is
  // bypassed via local LWA fetch).
  //
  // Body: { profileId: string }
  // ── H.2: v1 unified Ads API export routes ───────────────────────────
  //
  // Manual triggers for the new v1 sync service. Once H.2d wires the
  // cron registrations these will mostly be used for ad-hoc backfills
  // and for the H.2c verification step against a single profile.

  // POST /api/advertising/v1/export-cycle
  // Body: { profileIds?: string[], resources?: V1Resource[], adProducts?: V1AdProduct[] }
  fastify.post('/advertising/v1/export-cycle', async (request, _reply) => {
    const body = request.body as {
      profileIds?: string[]
      resources?: Array<'campaigns' | 'adGroups' | 'targets' | 'ads'>
      adProducts?: Array<'SPONSORED_PRODUCTS' | 'SPONSORED_BRANDS' | 'SPONSORED_DISPLAY'>
    } | undefined
    const { runV1ExportCycle, summarizeCycle } = await import(
      '../services/advertising/ads-v1-sync.service.js'
    )
    const result = await runV1ExportCycle({
      profileIds: body?.profileIds,
      resources: body?.resources,
      adProducts: body?.adProducts,
    })
    return { ok: true, summary: summarizeCycle(result), ...result }
  })

  // POST /api/advertising/v1/exports/poll?limit=N
  fastify.post('/advertising/v1/exports/poll', async (request, _reply) => {
    const q = request.query as { limit?: string }
    const limit = q.limit ? Math.max(1, Math.min(100, Number(q.limit))) : 20
    const { pollPendingExports } = await import(
      '../services/advertising/ads-v1-sync.service.js'
    )
    const summary = await pollPendingExports(limit)
    return { ok: true, ...summary }
  })

  // POST /api/advertising/v1/exports/refresh-expired (AF.1)
  // Re-GETs Amazon for COMPLETED jobs whose presigned URL lapsed (rowsIngested=0)
  // so they get a fresh URL + can finally ingest (recovers lost positive keywords).
  fastify.post('/advertising/v1/exports/refresh-expired', async (request) => {
    const q = request.query as { limit?: string }
    const { refreshExpiredCompletedExports } = await import('../services/advertising/ads-v1-sync.service.js')
    return refreshExpiredCompletedExports(q.limit ? Number(q.limit) : 40)
  })

  // POST /api/advertising/v1/exports/ingest-completed
  // Ingests up to 10 COMPLETED jobs per call.
  fastify.post('/advertising/v1/exports/ingest-completed', async (_request, _reply) => {
    const { ingestCompletedExport } = await import(
      '../services/advertising/ads-v1-sync.service.js'
    )
    const jobs = await prisma.amazonAdsExportJob.findMany({
      // Match cron filter: never re-ingest already-ingested jobs, and
      // don't waste cycles on jobs whose presigned URL has expired.
      where: {
        status: 'COMPLETED',
        url: { not: null },
        rowsIngested: 0,
        fileSize: { gte: 100 }, // AF.1 — skip empty (~22-byte) exports that starve data-rich jobs
        OR: [
          { urlExpiresAt: null },
          { urlExpiresAt: { gt: new Date() } },
        ],
      },
      select: { id: true },
      // AF.1 — newest first so fresh presigned URLs ingest before they expire
      // (oldest-first let large/late exports' URLs lapse → rows silently lost).
      orderBy: { completedAt: 'desc' },
      take: 10,
    })
    const results = await Promise.all(jobs.map((j) => ingestCompletedExport(j.id)))
    return { ok: true, ingested: results.length, results }
  })

  // GET /api/advertising/v1/exports?status=...&resource=...&limit=N
  fastify.get('/advertising/v1/exports', async (request, _reply) => {
    const q = request.query as {
      status?: string
      resource?: string
      profileId?: string
      limit?: string
    }
    const limit = q.limit ? Math.max(1, Math.min(200, Number(q.limit))) : 50
    const items = await prisma.amazonAdsExportJob.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.resource ? { resource: q.resource } : {}),
        ...(q.profileId ? { profileId: q.profileId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return { items, count: items.length }
  })

  // POST /api/advertising/debug/mark-expired-reports-failed
  //
  // Reports whose signed URL has long since expired (completedAt > 60 min ago)
  // but never ingested (rowsIngested = 0) are effectively dead. The cron
  // filter now excludes them, but they sit as COMPLETED + stale errorMessage.
  // This route flips them to FAILED so the dashboard counts reflect reality.
  fastify.post('/advertising/debug/mark-expired-reports-failed', async (_request, _reply) => {
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000)
    const r = await prisma.amazonAdsReportJob.updateMany({
      where: {
        status: 'COMPLETED',
        rowsIngested: 0,
        completedAt: { lt: sixtyMinAgo },
      },
      data: { status: 'EXPIRED', errorMessage: 'signed url expired before ingest could run' },
    })
    return { ok: true, marked: r.count }
  })

  // POST /api/advertising/debug/clear-stale-export-errors — H.2 follow-up
  //
  // Clears errorMessage on AmazonAdsExportJob rows that successfully
  // ingested data (rowsIngested > 0) but were re-processed by the cron
  // before the rowsIngested filter was added. Pure cleanup — the jobs
  // are healthy, the errorMessage is a historical artifact.
  fastify.post('/advertising/debug/clear-stale-export-errors', async (_request, _reply) => {
    const r = await prisma.amazonAdsExportJob.updateMany({
      where: { errorMessage: { not: null }, rowsIngested: { gt: 0 } },
      data: { errorMessage: null },
    })
    return { ok: true, cleared: r.count }
  })

  // POST /api/advertising/debug/reset-stuck-completed-jobs — Phase G follow-up
  //
  // Resets jobs that are status=COMPLETED but location=null (a data state
  // that should be impossible after the location→url fix). Sets them back
  // to IN_PROGRESS so the polling cron re-queries Amazon and captures the
  // signed URL on the next poll cycle.
  fastify.post('/advertising/debug/reset-stuck-completed-jobs', async (_request, _reply) => {
    const r = await prisma.amazonAdsReportJob.updateMany({
      where: { status: 'COMPLETED', location: null },
      data: { status: 'IN_PROGRESS', completedAt: null },
    })
    return { ok: true, jobsReset: r.count }
  })

  // GET /api/advertising/debug/report-status/:jobId — Phase G diagnostic
  //
  // Fetches Amazon's raw status response for a single AmazonAdsReportJob
  // via /reporting/reports/:externalReportId. Used to inspect what
  // Amazon is actually returning so we can fix our status-mapping or
  // identify report-not-progressing root cause.
  // GET /api/advertising/debug/report-download/:jobId
  //
  // Downloads + decompresses + parses the first 2 records from a
  // COMPLETED report job's S3 file. Used to inspect actual field
  // names Amazon returns when our ingest produces 0 rows. URL must
  // still be valid (within 1h TTL from completedAt).
  fastify.get('/advertising/debug/report-download/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    const job = await prisma.amazonAdsReportJob.findUnique({
      where: { id: jobId },
      select: { id: true, reportTypeId: true, location: true, fileSize: true,
                rowsIngested: true, completedAt: true, configuration: true },
    })
    if (!job) return reply.code(404).send({ error: 'job_not_found' })
    if (!job.location) return reply.code(400).send({ error: 'no_url_on_job' })
    try {
      const { gunzipSync } = await import('zlib')
      const res = await fetch(job.location)
      if (!res.ok) return reply.code(502).send({ error: `s3_${res.status}` })
      const buf = Buffer.from(await res.arrayBuffer())
      const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
      const decoded = isGzip ? gunzipSync(buf) : buf
      const text = decoded.toString('utf-8')
      let parsed: unknown
      try { parsed = JSON.parse(text) }
      catch { parsed = text.slice(0, 2000) }
      const sample = Array.isArray(parsed) ? parsed.slice(0, 2) : parsed
      return {
        job, isGzip,
        decompressedBytes: decoded.length,
        recordCount: Array.isArray(parsed) ? parsed.length : null,
        sampleRecords: sample,
      }
    } catch (err) {
      return reply.code(500).send({ error: String(err) })
    }
  })

  fastify.get('/advertising/debug/report-status/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string }
    const job = await prisma.amazonAdsReportJob.findUnique({
      where: { id: jobId },
      select: {
        id: true, profileId: true, externalReportId: true, status: true,
        attempts: true, lastPolledAt: true,
      },
    })
    if (!job) return reply.code(404).send({ error: 'job_not_found' })
    if (!job.externalReportId) return reply.code(400).send({ error: 'no_external_report_id' })

    const conn = await prisma.amazonAdsConnection.findUnique({
      where: { profileId: job.profileId },
      select: { region: true },
    })
    const region = (conn?.region === 'NA' || conn?.region === 'FE') ? conn.region : 'EU'

    const { liveCall } = await import('../services/advertising/ads-api-client.js')
    try {
      const status = await liveCall<Record<string, unknown>>({
        profileId: job.profileId,
        region: region as 'EU' | 'NA' | 'FE',
        method: 'GET',
        path: `/reporting/reports/${job.externalReportId}`,
      })
      return { job, amazonRawResponse: status }
    } catch (err) {
      return {
        job,
        amazonError: err instanceof Error ? err.message : String(err),
      }
    }
  })

  // GET /api/advertising/debug/export-status — Phase H.1 v1 chained probe
  //
  // Once a probe created an export (e.g. exports_v1_campaigns_sp returned
  // 202 with an exportId in its responseSnippet), pass the exportId +
  // profileId here to:
  //   1. Poll Amazon's GET /exports/{exportId} once and surface the
  //      raw response (so we can see the v1 status payload shape —
  //      this is what H.2's service will key on)
  //   2. If COMPLETED, attempt to download the signed URL (first 1KB)
  //      so we can confirm the file format (JSON / NDJSON / GZIP)
  //
  // No DB writes. Manual-trigger only. Use with the exportIds harvested
  // from the H.1 probe results.
  fastify.get('/advertising/debug/export-status', async (request, reply) => {
    const q = request.query as {
      profileId?: string
      exportId?: string
      // Phase H.1 finding: Amazon's /exports/{id} endpoint requires the
      // SAME MIME type that was used to create the export (per resource
      // type). The "available" types Amazon will accept here are:
      //   application/vnd.campaignsexport.v1+json
      //   application/vnd.adgroupsexport.v1+json
      //   application/vnd.targetsexport.v1+json
      //   application/vnd.adsexport.v1+json
      // Default to campaigns since that's the most common.
      resourceType?: 'campaigns' | 'adGroups' | 'targets' | 'ads'
    }
    if (!q.profileId || !q.exportId) {
      return reply.code(400).send({ error: 'profileId and exportId both required' })
    }
    const MIME_BY_RESOURCE: Record<string, string> = {
      campaigns: 'application/vnd.campaignsexport.v1+json',
      adGroups:  'application/vnd.adgroupsexport.v1+json',
      targets:   'application/vnd.targetsexport.v1+json',
      ads:       'application/vnd.adsexport.v1+json',
    }
    const acceptMime = MIME_BY_RESOURCE[q.resourceType ?? 'campaigns']
      ?? MIME_BY_RESOURCE.campaigns
    const conn = await prisma.amazonAdsConnection.findUnique({
      where: { profileId: q.profileId },
      select: { region: true, credentialsEncrypted: true },
    })
    if (!conn?.credentialsEncrypted) return reply.code(404).send({ error: 'connection_not_found' })
    const region = (conn.region === 'NA' || conn.region === 'FE') ? conn.region : 'EU'

    const { liveCall } = await import('../services/advertising/ads-api-client.js')
    let statusResp: Record<string, unknown> | null = null
    let statusError: string | null = null
    try {
      statusResp = await liveCall<Record<string, unknown>>({
        profileId: q.profileId,
        region: region as 'EU' | 'NA' | 'FE',
        method: 'GET',
        path: `/exports/${q.exportId}`,
        acceptHeader: acceptMime,
      })
    } catch (err) {
      statusError = err instanceof Error ? err.message : String(err)
    }

    // If Amazon returned a signed URL, fetch + decompress + parse the
    // first 1-2 records so we can see the actual v1 record shape (for
    // H.2's ingest mapper). Phase H.1 confirmed the file is gzipped
    // JSON via magic bytes 1f 8b at offset 0.
    let downloadPreview: {
      contentType: string
      totalBytes: number
      decompressedBytes: number
      isGzip: boolean
      sampleRecords: unknown
      recordCount: number | null
      parseError?: string
    } | null = null
    let downloadError: string | null = null
    const url = statusResp?.url as string | undefined
    if (url) {
      try {
        const { gunzipSync } = await import('zlib')
        const res = await fetch(url)
        const contentType = res.headers.get('content-type') ?? ''
        const buf = await res.arrayBuffer()
        const bytes = Buffer.from(buf)
        const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
        let decoded: Buffer = bytes
        if (isGzip) {
          try { decoded = gunzipSync(bytes) }
          catch (err) {
            downloadPreview = {
              contentType, totalBytes: bytes.length, decompressedBytes: 0,
              isGzip: true, sampleRecords: null, recordCount: null,
              parseError: `gunzip failed: ${String(err)}`,
            }
            return reply.send({
              profileId: q.profileId, exportId: q.exportId,
              amazonStatus: statusResp, statusError, downloadPreview, downloadError,
            })
          }
        }
        let parsed: unknown = null
        let recordCount: number | null = null
        let parseError: string | undefined
        const decodedText = decoded.toString('utf-8')
        try {
          parsed = JSON.parse(decodedText)
          if (Array.isArray(parsed)) recordCount = parsed.length
        } catch (err) {
          // Try NDJSON
          const lines = decodedText.split('\n').filter((l) => l.trim())
          try {
            parsed = lines.slice(0, 2).map((l) => JSON.parse(l))
            recordCount = lines.length
          } catch {
            parseError = `JSON parse failed: ${String(err)}`
          }
        }
        // Trim to first 2 records to keep response small
        const sample = Array.isArray(parsed) ? parsed.slice(0, 2) : parsed
        downloadPreview = {
          contentType, totalBytes: bytes.length, decompressedBytes: decoded.length,
          isGzip, sampleRecords: sample, recordCount, parseError,
        }
      } catch (err) {
        downloadError = err instanceof Error ? err.message : String(err)
      }
    }

    return {
      profileId: q.profileId,
      exportId: q.exportId,
      amazonStatus: statusResp,
      statusError,
      downloadPreview,
      downloadError,
    }
  })

  // AF.1/AF.3 — DB-only target breakdown (instant, no export download). Tells
  // us account-wide + per-campaign how many positive vs negative keyword/product
  // targets exist, so we can see if positives are systematically missing.
  fastify.get('/advertising/debug/target-breakdown', async (request) => {
    const q = request.query as { campaignId?: string }
    const where = q.campaignId ? { adGroup: { campaignId: q.campaignId } } : {}
    const [total, negatives, byType] = await Promise.all([
      prisma.adTarget.count({ where }),
      prisma.adTarget.count({ where: { ...where, isNegative: true } }),
      prisma.adTarget.groupBy({ by: ['expressionType', 'isNegative'], where, _count: { _all: true } }),
    ])
    // Campaigns that have negatives but ZERO positives (the reported symptom).
    let campaignsNegOnly: number | undefined
    if (!q.campaignId) {
      const grps = await prisma.adGroup.findMany({ select: { campaignId: true, targets: { select: { isNegative: true } } } })
      const byCamp = new Map<string, { pos: number; neg: number }>()
      for (const g of grps) { const c = byCamp.get(g.campaignId) ?? { pos: 0, neg: 0 }; for (const t of g.targets) (t.isNegative ? c.neg++ : c.pos++); byCamp.set(g.campaignId, c) }
      campaignsNegOnly = [...byCamp.values()].filter((c) => c.neg > 0 && c.pos === 0).length
    }
    return {
      campaignId: q.campaignId ?? null,
      total, positives: total - negatives, negatives,
      campaignsWithNegativesButNoPositives: campaignsNegOnly,
      byTypeAndNegative: byType.map((b) => ({ expressionType: b.expressionType, isNegative: b.isNegative, count: b._count._all })),
    }
  })

  // AF.1d — de-duplicate campaigns split across marketplace representations
  // (Amazon-id copy with metrics + short-code copy with keywords). dryRun by
  // default; pass { apply: true } to execute the destructive merge.
  fastify.post('/advertising/debug/dedupe-campaigns', async (request) => {
    const body = (request.body ?? {}) as { apply?: boolean }
    const { dedupeCampaigns } = await import('../services/advertising/ads-dedupe-campaigns.service.js')
    return dedupeCampaigns({ dryRun: body.apply !== true })
  })

  fastify.post('/advertising/debug/probe-endpoints', async (request, reply) => {
    const body = request.body as { profileId?: string }
    if (!body?.profileId) return reply.code(400).send({ error: 'profileId required' })
    const { probeAdvertisingEndpoints } = await import(
      '../services/advertising/ads-debug-probe.service.js'
    )
    try {
      const report = await probeAdvertisingEndpoints({ profileId: body.profileId })
      return report
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: msg })
    }
  })

  // GET /api/advertising/debug/probe-endpoints/profiles — list profiles
  // available for probing. Convenience for the UI dropdown.
  fastify.get('/advertising/debug/probe-endpoints/profiles', async (_request, _reply) => {
    const items = await prisma.amazonAdsConnection.findMany({
      where: { credentialsEncrypted: { not: null } },
      select: {
        profileId: true,
        marketplace: true,
        region: true,
        accountLabel: true,
        mode: true,
        isActive: true,
      },
      orderBy: { marketplace: 'asc' },
    })
    return { count: items.length, items }
  })

  // POST /api/advertising/profit/ingest-fba-fees — AD.4 Step 6
  //
  // Manual trigger for the FBA fees ingest. Accepts an optional
  // marketplaceId and rollupWindowDays. The weekly cron runs Sunday 02:00.
  fastify.post('/advertising/profit/ingest-fba-fees', async (request, reply) => {
    const body = request.body as { marketplaceId?: string; rollupWindowDays?: number } | undefined
    const { runFbaFeesIngest, summarizeFbaFeesIngest } = await import(
      '../services/advertising/fba-fees-ingest.service.js'
    )
    const result = await runFbaFeesIngest({
      marketplaceId: body?.marketplaceId,
      rollupWindowDays: body?.rollupWindowDays ?? 30,
    })
    return { ok: true, summary: summarizeFbaFeesIngest(result), ...result }
  })

  // POST /api/advertising/profit/backfill-ad-spend — Phase 11 close-out
  //
  // Manually triggers fillAdSpend for a date range. Use after the first
  // successful report ingest cycle to back-fill advertisingSpendCents on
  // ProductProfitDaily rows that were created with 0 (before AD data landed).
  // Body: { startDate: "YYYY-MM-DD", endDate?: "YYYY-MM-DD" }
  fastify.post('/advertising/profit/backfill-ad-spend', async (request, reply) => {
    const body = request.body as { startDate?: string; endDate?: string }
    if (!body?.startDate) return reply.code(400).send({ error: 'startDate required (YYYY-MM-DD)' })
    const { fillAdSpend } = await import(
      '../services/advertising/true-profit-rollup.service.js'
    )
    const start = new Date(body.startDate)
    const end   = body.endDate ? new Date(body.endDate) : new Date(body.startDate)
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return reply.code(400).send({ error: 'invalid date format' })
    }
    const results: Array<{ date: string; productsUpdated: number; errors: number }> = []
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    const stop  = new Date(Date.UTC(end.getUTCFullYear(),   end.getUTCMonth(),   end.getUTCDate()))
    while (cursor <= stop) {
      const r = await fillAdSpend(new Date(cursor))
      results.push({ date: cursor.toISOString().slice(0, 10), productsUpdated: r.productsUpdated, errors: r.errors.length })
      cursor = new Date(cursor.getTime() + 86_400_000)
    }
    return { ok: true, datesProcessed: results.length, results }
  })

  // POST /api/advertising/reports/cleanup-search-terms?daysToKeep=90
  // POST /api/advertising/negative-keywords — Phase J.3
  //
  // Creates a negative keyword in Amazon at either ad-group or campaign
  // scope via the SP v3 endpoints (/sp/negativeKeywords or
  // /sp/campaignNegativeKeywords — both confirmed working through our
  // Atza| token in Phase J.1 probes).
  //
  // Body shape:
  //   {
  //     profileId, externalCampaignId, externalAdGroupId?,
  //     keywordText, matchType: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE',
  //     scope: 'AD_GROUP' | 'CAMPAIGN', marketplace
  //   }
  //
  // Goes through the Phase 9 write gate. Idempotent — re-clicking the
  // same negative is a local DB lookup, no Amazon call.
  fastify.post('/advertising/negative-keywords', async (request, reply) => {
    const body = request.body as {
      profileId?: string
      externalCampaignId?: string
      externalAdGroupId?: string
      keywordText?: string
      matchType?: 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE'
      scope?: 'AD_GROUP' | 'CAMPAIGN'
      marketplace?: string
    }
    if (!body.externalCampaignId || !body.keywordText
        || !body.matchType || !body.scope || !body.marketplace) {
      return reply.code(400).send({
        error: 'missing_required_fields',
        required: ['externalCampaignId', 'keywordText',
                   'matchType', 'scope', 'marketplace',
                   '(profileId optional — resolved from marketplace)'],
      })
    }
    if (body.scope === 'AD_GROUP' && !body.externalAdGroupId) {
      return reply.code(400).send({ error: 'externalAdGroupId_required_for_AD_GROUP' })
    }
    // Resolve profileId from marketplace if not explicitly given
    let profileId = body.profileId
    if (!profileId) {
      const conn = await prisma.amazonAdsConnection.findFirst({
        where: { marketplace: body.marketplace, isActive: true },
        select: { profileId: true },
      })
      if (!conn) {
        return reply.code(404).send({
          error: 'no_active_connection_for_marketplace',
          marketplace: body.marketplace,
        })
      }
      profileId = conn.profileId
    }
    const { createNegative } = await import(
      '../services/advertising/ads-negative-kw.service.js'
    )
    const result = await createNegative({
      profileId,
      externalCampaignId: body.externalCampaignId,
      externalAdGroupId: body.externalAdGroupId,
      keywordText: body.keywordText,
      matchType: body.matchType,
      scope: body.scope,
      marketplace: body.marketplace,
    })
    if (result.denied) {
      return reply.code(403).send({
        error: 'write_gate_denied',
        reason: result.denied.reason,
        deniedAt: result.denied.deniedAt,
      })
    }
    if (!result.ok) {
      return reply.code(502).send({
        error: 'amazon_rejected',
        details: result.rawResponse,
      })
    }
    return {
      ok: true,
      alreadyExisted: result.alreadyExisted,
      mode: result.mode,
      externalNegativeKeywordId: result.externalNegativeKeywordId,
    }
  })

  fastify.post('/advertising/reports/cleanup-search-terms', async (request, _reply) => {
    const query = request.query as { daysToKeep?: string }
    const daysToKeep = query.daysToKeep ? Math.max(7, Math.min(365, Number(query.daysToKeep))) : 90
    const { cleanupOldSearchTerms } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const result = await cleanupOldSearchTerms(daysToKeep)
    return { ok: true, ...result }
  })

  // GET /api/advertising/reports/search-terms — broad listing with filters
  //   ?lookbackDays=30&profileId=&marketplace=&adProduct=&minSpend=0
  //   &hasOrders=any|none|some&sortBy=spend|clicks|orders|acos&limit=200
  fastify.get('/advertising/reports/search-terms', async (request, _reply) => {
    const query = request.query as {
      lookbackDays?: string
      profileId?: string
      marketplace?: string
      adProduct?: string
      campaignId?: string
      adGroupId?: string
      minSpend?: string
      minImpressions?: string
      hasOrders?: 'any' | 'none' | 'some'
      sortBy?: 'spend' | 'clicks' | 'orders' | 'impressions'
      limit?: string
    }
    const lookbackDays = query.lookbackDays
      ? Math.max(1, Math.min(180, Number(query.lookbackDays))) : 30
    const limit = query.limit ? Math.max(1, Math.min(1000, Number(query.limit))) : 200
    const minSpend = query.minSpend ? Math.max(0, Number(query.minSpend)) : 0
    const minImpressions = query.minImpressions ? Math.max(0, Number(query.minImpressions)) : 0
    const minMicros = BigInt(Math.round(minSpend * 1_000_000))

    const since = new Date()
    since.setUTCDate(since.getUTCDate() - lookbackDays)
    since.setUTCHours(0, 0, 0, 0)

    // Having + sortBy filters are applied in JS after the in-memory
    // groupBy below. The Prisma SQL groupBy on this table panics
    // (engine bug); JS aggregation is the workaround.

    const sortField = query.sortBy === 'clicks' ? 'clicks'
      : query.sortBy === 'orders' ? 'orders7d'
      : query.sortBy === 'impressions' ? 'impressions'
      : 'costMicros'

    // Workaround Prisma 6.19.3 Rust engine panic: the groupBy with 7
    // by-columns + 5 _sum aggregates (including BigInt costMicros) +
    // having clause crashes with 'internal error: entered unreachable
    // code'. Drop the groupBy entirely and aggregate in JS — bounded
    // dataset (~50K rows max) so in-memory grouping is fine.
    const rawRows = await prisma.amazonAdsSearchTerm.findMany({
      where: {
        date: { gte: since },
        ...(query.profileId ? { profileId: query.profileId } : {}),
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
        ...(query.adProduct ? { adProduct: query.adProduct } : {}),
        // AF.1e — scope to the campaign / ad group being viewed. The search-term
        // table stores EXTERNAL Amazon ids; the detail cockpits pass
        // externalCampaignId / externalAdGroupId. Without these the detail pages
        // showed every campaign's search terms (account-wide), not their own.
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.adGroupId ? { adGroupId: query.adGroupId } : {}),
      },
      select: {
        query: true, matchType: true, campaignId: true, adGroupId: true,
        marketplace: true, adProduct: true, currencyCode: true,
        impressions: true, clicks: true, costMicros: true,
        orders7d: true, sales7dCents: true,
      },
      take: 10_000,
    })

    // Group in JS by (query|matchType|campaignId|adGroupId|marketplace|adProduct|currencyCode)
    type Bucket = {
      query: string; matchType: string | null
      campaignId: string; adGroupId: string
      marketplace: string; adProduct: string; currencyCode: string
      _sum: {
        impressions: number; clicks: number
        costMicros: bigint
        orders7d: number; sales7dCents: number
      }
    }
    const buckets = new Map<string, Bucket>()
    for (const r of rawRows) {
      const k = `${r.query} ${r.matchType ?? ''} ${r.campaignId} ${r.adGroupId} ${r.marketplace} ${r.adProduct} ${r.currencyCode}`
      let b = buckets.get(k)
      if (!b) {
        b = {
          query: r.query, matchType: r.matchType,
          campaignId: r.campaignId, adGroupId: r.adGroupId,
          marketplace: r.marketplace, adProduct: r.adProduct, currencyCode: r.currencyCode,
          _sum: { impressions: 0, clicks: 0, costMicros: 0n, orders7d: 0, sales7dCents: 0 },
        }
        buckets.set(k, b)
      }
      b._sum.impressions  += r.impressions
      b._sum.clicks       += r.clicks
      b._sum.costMicros   += r.costMicros
      b._sum.orders7d     += r.orders7d ?? 0
      b._sum.sales7dCents += r.sales7dCents ?? 0
    }
    // Apply having-style filters in JS
    let allRows = [...buckets.values()]
    if (minSpend > 0) {
      allRows = allRows.filter((b) => b._sum.costMicros >= minMicros)
    }
    if (minImpressions > 0) {
      allRows = allRows.filter((b) => b._sum.impressions >= minImpressions)
    }
    if (query.hasOrders === 'none') {
      allRows = allRows.filter((b) => b._sum.orders7d === 0)
    } else if (query.hasOrders === 'some') {
      allRows = allRows.filter((b) => b._sum.orders7d > 0)
    }

    // JS-side sort + take to dodge the engine bug.
    const sorted = [...allRows].sort((a, b) => {
      const fa = sortField === 'costMicros'
        ? Number(a._sum.costMicros ?? 0n)
        : Number((a._sum as unknown as Record<string, number | null>)[sortField] ?? 0)
      const fb = sortField === 'costMicros'
        ? Number(b._sum.costMicros ?? 0n)
        : Number((b._sum as unknown as Record<string, number | null>)[sortField] ?? 0)
      return fb - fa
    })
    const rows = sorted.slice(0, limit)

    const items = rows.map((r) => {
      const costMicros = r._sum.costMicros ?? 0n
      const costUnits = Number(costMicros) / 1_000_000
      const salesCents = r._sum.sales7dCents ?? 0
      const orders = r._sum.orders7d ?? 0
      const impressions = r._sum.impressions ?? 0
      const clicks = r._sum.clicks ?? 0
      const acos = salesCents > 0 ? (costUnits * 100) / salesCents : null
      const roas = costUnits > 0 ? salesCents / 100 / costUnits : null
      const ctr = impressions > 0 ? clicks / impressions : null
      const cpc = clicks > 0 ? costUnits / clicks : null
      // Negative-keyword candidate heuristic: ≥ 2 currency units spent, zero orders
      const isCandidate = costUnits >= 2 && orders === 0
      return {
        query: r.query,
        matchType: r.matchType,
        campaignId: r.campaignId,
        adGroupId: r.adGroupId,
        marketplace: r.marketplace,
        adProduct: r.adProduct,
        currencyCode: r.currencyCode,
        impressions, clicks,
        costMicros: costMicros.toString(),
        costUnits,
        salesCents,
        orders,
        acos, roas, ctr, cpc,
        isCandidate,
      }
    })

    return { lookbackDays, count: items.length, items }
  })

  // ── GET /advertising/targets — account-level keyword/target roster ───
  // Positive AdTargets across all campaigns with window-aggregated metrics
  // (AD_TARGET daily perf by localEntityId; falls back to the denormalized
  // AdTarget columns when no daily rows in range). Powers the Ads Console
  // Targeting screen. Filterable by kind / match type / campaign / text.
  fastify.get('/advertising/targets', async (request, reply) => {
    const q = request.query as { windowDays?: string; limit?: string; search?: string; kind?: string; matchType?: string; campaignId?: string; preset?: string; startDate?: string; endDate?: string; negative?: string }
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange(q)
    const limit = Math.max(1, Math.min(2000, Number(q.limit ?? 500)))
    const targets = await prisma.adTarget.findMany({
      where: {
        // CBN.3.5 — default lists positive targets; ?negative=1 lists Campaign Negative
        // Targets (both CAMPAIGN- and AD_GROUP-level; adGroupId is required on every row).
        isNegative: q.negative === '1' || q.negative === 'true',
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.matchType ? { expressionType: q.matchType } : {}),
        ...(q.search ? { expressionValue: { contains: q.search, mode: 'insensitive' } } : {}),
        ...(q.campaignId ? { adGroup: { campaignId: q.campaignId } } : {}),
      },
      select: {
        id: true, externalTargetId: true, kind: true, expressionType: true, expressionValue: true,
        bidCents: true, status: true, impressions: true, clicks: true, spendCents: true, salesCents: true, ordersCount: true,
        isNegative: true, negativeLevel: true, createdAt: true,
        adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, marketplace: true, externalCampaignId: true } } } },
      },
      take: limit,
    })
    const ids = targets.map((t) => t.id)
    const perf = ids.length ? await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', localEntityId: { in: ids }, date: { gte: range.since, lte: range.until } },
      _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
    }) : []
    const pmap = new Map(perf.map((p) => [p.localEntityId, p]))
    const rows = targets.map((t) => {
      const p = pmap.get(t.id)
      const spendC = p ? microsToCents(p._sum.costMicros) : t.spendCents
      const salesC = p ? (p._sum.sales7dCents ?? 0) : t.salesCents
      const impr = p ? (p._sum.impressions ?? 0) : t.impressions
      const clk = p ? (p._sum.clicks ?? 0) : t.clicks
      const ord = p ? (p._sum.orders7d ?? 0) : t.ordersCount
      return {
        id: t.id, text: t.expressionValue, kind: t.kind, matchType: t.expressionType, bidCents: t.bidCents, status: t.status,
        isNegative: t.isNegative, negativeLevel: t.negativeLevel, createdAt: t.createdAt,
        campaignId: t.adGroup.campaign.id, campaignName: t.adGroup.campaign.name, externalCampaignId: t.adGroup.campaign.externalCampaignId,
        marketplace: t.adGroup.campaign.marketplace, adGroupId: t.adGroup.id, externalAdGroupId: t.adGroup.externalAdGroupId, adGroupName: t.adGroup.name,
        impressions: impr, clicks: clk, spendCents: spendC, salesCents: salesC, orders: ord,
        acos: salesC > 0 ? spendC / salesC : null, roas: spendC > 0 ? salesC / spendC : null,
        windowed: !!p,
      }
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return { windowDays: range.days, count: rows.length, rows }
  })

  // ── POST /advertising/search-terms/promote — harvest a search term into a
  // positive keyword. The search-term report carries EXTERNAL ad-group ids;
  // resolve to the local AdGroup, then create the keyword (sandbox-safe).
  fastify.post('/advertising/search-terms/promote', async (request, reply) => {
    const b = request.body as { query?: string; externalAdGroupId?: string; matchType?: string; bidEur?: number }
    if (!b?.query || !b?.externalAdGroupId || !b?.matchType || b?.bidEur == null) { reply.status(400); return { error: 'query, externalAdGroupId, matchType, bidEur required' } }
    const ag = await prisma.adGroup.findFirst({ where: { externalAdGroupId: b.externalAdGroupId }, select: { id: true } })
    if (!ag) { reply.status(404); return { error: 'ad_group_not_found_for_externalAdGroupId' } }
    const { createKeywordLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createKeywordLocal({ adGroupId: ag.id, keywordText: b.query, matchType: b.matchType, bidEur: b.bidEur } as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── GET /advertising/bulk/export — current state as an Amazon bulksheet (.xlsx)
  // Read-only. Campaign + Ad group + Keyword/Product-targeting rows in the exact
  // Sponsored Products bulksheet column layout. Powers the Bulk operations screen.
  const BULK_COLS = ['Product', 'Entity', 'Operation', 'Campaign ID', 'Ad group ID', 'Portfolio ID', 'Ad ID', 'Keyword ID', 'Product Targeting ID', 'Campaign name', 'Ad group name', 'Start date', 'End date', 'Targeting type', 'State', 'Daily budget', 'SKU', 'Ad Group Default Bid', 'Bid', 'Keyword text', 'Native language keyword', 'Native language locale', 'Match type', 'Bidding strategy', 'Placement', 'Percentage', 'Product targeting expression', 'Audience ID', 'Shopper Cohort Percentage', 'Shopper Cohort Type', 'Sites']
  fastify.get('/advertising/bulk/export', async (request, reply) => {
    const q = request.query as { limit?: string }
    const limit = Math.max(1, Math.min(500, Number(q.limit ?? 200)))
    const campaigns = await prisma.campaign.findMany({
      take: limit, orderBy: { name: 'asc' },
      include: { adGroups: { include: { targets: { where: { isNegative: false }, take: 200 } } } },
    })
    const PROD: Record<string, string> = { SPONSORED_PRODUCTS: 'Sponsored Products', SPONSORED_BRANDS: 'Sponsored Brands', SPONSORED_DISPLAY: 'Sponsored Display' }
    const st = (s: string) => (s || '').toLowerCase()
    const isAuto = (n: string) => /\bauto|close match|loose match|substitute|complement/i.test(n || '')
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sponsored Products Campaigns')
    ws.addRow(BULK_COLS)
    const push = (o: Record<string, unknown>) => ws.addRow(BULK_COLS.map((c) => o[c] ?? ''))
    for (const c of campaigns) {
      const product = PROD[c.adProduct ?? ''] ?? 'Sponsored Products'
      push({ Product: product, Entity: 'Campaign', 'Campaign ID': c.externalCampaignId ?? '', 'Campaign name': c.name, 'Start date': c.startDate ? c.startDate.toISOString().slice(0, 10) : '', 'End date': c.endDate ? c.endDate.toISOString().slice(0, 10) : '', 'Targeting type': isAuto(c.name) ? 'auto' : 'manual', State: st(c.status), 'Daily budget': c.dailyBudget != null ? Number(c.dailyBudget) : '', 'Bidding strategy': c.biddingStrategy ?? '' })
      for (const g of c.adGroups) {
        push({ Product: product, Entity: 'Ad group', 'Campaign ID': c.externalCampaignId ?? '', 'Ad group ID': g.externalAdGroupId ?? '', 'Ad group name': g.name, State: st(g.status) })
        for (const t of g.targets) {
          const isKw = t.kind === 'KEYWORD'
          push({ Product: product, Entity: isKw ? 'Keyword' : 'Product targeting', 'Campaign ID': c.externalCampaignId ?? '', 'Ad group ID': g.externalAdGroupId ?? '', 'Keyword ID': isKw ? (t.externalTargetId ?? '') : '', 'Product Targeting ID': isKw ? '' : (t.externalTargetId ?? ''), State: st(t.status), Bid: (t.bidCents / 100).toFixed(2), 'Keyword text': isKw ? t.expressionValue : '', 'Match type': t.expressionType, 'Product targeting expression': isKw ? '' : t.expressionValue })
        }
      }
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', 'attachment; filename="nexus-bulksheet.xlsx"')
    return reply.send(buf)
  })

  // ── POST /advertising/bulk/apply — apply a validated bulksheet ───────
  // Dispatches each row's Operation to the existing audited write paths. Defaults
  // to applyImmediately:false → pending/sandbox (no live Amazon writes unless the
  // campaign is on the live-write allowlist). v1 supports Campaign + Ad group
  // Update/Archive, Keyword Create, Negative keyword Create; others are skipped.
  fastify.post('/advertising/bulk/apply', async (request, reply) => {
    const body = request.body as { rows?: Array<Record<string, string>>; applyImmediately?: boolean }
    const rows = Array.isArray(body?.rows) ? body.rows : []
    if (!rows.length) { reply.status(400); return { error: 'rows[] required' } }
    if (rows.length > 2000) { reply.status(400); return { error: 'max 2000 rows per apply' } }
    const applyImmediately = body.applyImmediately === true
    const actor = actorFromHeaders(request.headers as Record<string, unknown>)
    const g = (r: Record<string, string>, k: string) => (r[k] ?? '').toString().trim()
    const extC = [...new Set(rows.map((r) => g(r, 'Campaign ID')).filter(Boolean))]
    const extA = [...new Set(rows.map((r) => g(r, 'Ad group ID')).filter(Boolean))]
    const [camps, ags] = await Promise.all([
      prisma.campaign.findMany({ where: { externalCampaignId: { in: extC } }, select: { id: true, externalCampaignId: true, marketplace: true } }),
      prisma.adGroup.findMany({ where: { externalAdGroupId: { in: extA } }, select: { id: true, externalAdGroupId: true, campaign: { select: { marketplace: true } } } }),
    ])
    const campByExt = new Map(camps.map((c) => [c.externalCampaignId, c]))
    const agByExt = new Map(ags.map((a) => [a.externalAdGroupId, a]))
    const ST: Record<string, 'ENABLED' | 'PAUSED' | 'ARCHIVED'> = { enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED' }
    const profileCache = new Map<string, string | null>()
    const profileFor = async (mkt: string | null): Promise<string | null> => {
      if (!mkt) return null
      if (profileCache.has(mkt)) return profileCache.get(mkt) ?? null
      const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace: mkt, isActive: true }, select: { profileId: true } })
      const pid = conn?.profileId ?? null; profileCache.set(mkt, pid); return pid
    }
    const { createKeywordLocal } = await import('../services/advertising/ads-create.service.js')
    const { createNegative } = await import('../services/advertising/ads-negative-kw.service.js')

    const results: Array<{ row: number; entity: string; operation: string; status: 'applied' | 'skipped' | 'error'; message: string }> = []
    let applied = 0, skipped = 0, errors = 0
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const entity = g(r, 'Entity'); const op = g(r, 'Operation')
      const push = (status: 'applied' | 'skipped' | 'error', message: string) => { results.push({ row: i + 1, entity, operation: op || 'Read', status, message }); if (status === 'applied') applied++; else if (status === 'error') errors++; else skipped++ }
      if (!op) { push('skipped', 'No operation (read row)'); continue }
      try {
        if (entity === 'Campaign' && (op === 'Update' || op === 'Archive')) {
          const c = campByExt.get(g(r, 'Campaign ID')); if (!c) { push('error', 'Campaign ID not found'); continue }
          const patch: { status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; dailyBudget?: number } = {}
          if (op === 'Archive') patch.status = 'ARCHIVED'; else if (ST[g(r, 'State').toLowerCase()]) patch.status = ST[g(r, 'State').toLowerCase()]
          const db = g(r, 'Daily budget') || g(r, 'Budget'); if (db && Number.isFinite(Number(db))) patch.dailyBudget = Number(db)
          const res = await updateCampaignWithSync({ campaignId: c.id, patch, actor, reason: 'bulk upload', applyImmediately })
          if (res.ok) push('applied', applyImmediately ? 'Campaign updated (live)' : 'Campaign queued (pending)'); else push('error', res.error ?? 'update failed')
        } else if (entity === 'Ad group' && (op === 'Update' || op === 'Archive')) {
          const a = agByExt.get(g(r, 'Ad group ID')); if (!a) { push('error', 'Ad group ID not found'); continue }
          const status = op === 'Archive' ? 'ARCHIVED' : ST[g(r, 'State').toLowerCase()]
          if (!status) { push('skipped', 'No State to update'); continue }
          const res = await updateAdGroupWithSync({ adGroupId: a.id, patch: { status }, actor, reason: 'bulk upload', applyImmediately })
          if (res.ok) push('applied', applyImmediately ? 'Ad group updated (live)' : 'Ad group queued (pending)'); else push('error', res.error ?? 'update failed')
        } else if (entity === 'Keyword' && op === 'Create') {
          const a = agByExt.get(g(r, 'Ad group ID')); if (!a) { push('error', 'Ad group ID not found'); continue }
          const mt = g(r, 'Match type').toUpperCase(); const matchType = mt.includes('PHRASE') ? 'PHRASE' : mt.includes('BROAD') ? 'BROAD' : 'EXACT'
          const bid = Number(g(r, 'Bid')); const bidEur = Number.isFinite(bid) && bid > 0 ? bid : 0.5
          await createKeywordLocal({ adGroupId: a.id, keywordText: g(r, 'Keyword text'), matchType, bidEur } as never)
          push('applied', 'Keyword created (pending)')
        } else if (entity === 'Negative keyword' && op === 'Create') {
          const cid = g(r, 'Campaign ID'); const aid = g(r, 'Ad group ID')
          const mkt = campByExt.get(cid)?.marketplace ?? agByExt.get(aid)?.campaign?.marketplace ?? null
          const profileId = await profileFor(mkt)
          if (!profileId || !mkt) { push('error', 'No active connection for marketplace'); continue }
          const matchType = g(r, 'Match type').toLowerCase().includes('phrase') ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT'
          await createNegative({ profileId, externalCampaignId: cid, externalAdGroupId: aid || undefined, keywordText: g(r, 'Keyword text'), matchType, scope: aid ? 'AD_GROUP' : 'CAMPAIGN', marketplace: mkt } as never)
          push('applied', 'Negative keyword created (pending)')
        } else {
          push('skipped', `${entity || 'Row'} · ${op} not supported yet`)
        }
      } catch (e) { push('error', (e as Error)?.message ?? 'failed') }
    }
    return { total: rows.length, applied, skipped, errors, applyImmediately, results }
  })

  // GET /api/advertising/reports/negative-keyword-candidates
  //    ?lookbackDays=30&minSpend=5&limit=100&profileId=&marketplace=
  fastify.get('/advertising/reports/negative-keyword-candidates', async (request, _reply) => {
    const query = request.query as {
      lookbackDays?: string
      minSpend?: string
      limit?: string
      profileId?: string
      marketplace?: string
    }
    const { findNegativeKeywordCandidates } = await import(
      '../services/advertising/ads-reports.service.js'
    )
    const candidates = await findNegativeKeywordCandidates({
      lookbackDays: query.lookbackDays ? Math.max(1, Math.min(180, Number(query.lookbackDays))) : 30,
      minSpend: query.minSpend ? Math.max(0, Number(query.minSpend)) : 5,
      limit: query.limit ? Math.max(1, Math.min(500, Number(query.limit))) : 100,
      profileId: query.profileId,
      marketplace: query.marketplace,
    })
    // BigInt → string for JSON safety
    return {
      ok: true,
      count: candidates.length,
      candidates: candidates.map((c) => ({
        ...c,
        totalCostMicros: c.totalCostMicros.toString(),
      })),
    }
  })

  // ── Manual cron triggers (sandbox-safe) ─────────────────────────────
  // Mirror the /sync-logs/cron pattern so the cron status panel can
  // surface manual triggers in the audit feed.
  // H.2e: ads-sync (Phase B) retired; this trigger now runs the v1
  // unified export cycle. URL preserved for back-compat with existing
  // monitoring + the /sync-logs/cron audit panel.
  fastify.post('/advertising/cron/ads-sync/trigger', async (_request, _reply) => {
    const { runV1ExportCycle, summarizeCycle } = await import(
      '../services/advertising/ads-v1-sync.service.js'
    )
    const result = await runV1ExportCycle({})
    return { ok: true, summary: summarizeCycle(result), detail: result }
  })

  fastify.post(
    '/advertising/cron/fba-storage-age-ingest/trigger',
    async (_request, _reply) => {
      const s = await runFbaStorageAgeIngestOnce()
      return { ok: true, summary: summarizeFbaStorageAge(s), detail: s }
    },
  )

  fastify.post(
    '/advertising/cron/true-profit-rollup/trigger',
    async (request, _reply) => {
      const q = request.query as { fromDate?: string; toDate?: string }
      const opts: { fromDate?: Date; toDate?: Date } = {}
      if (q.fromDate) opts.fromDate = new Date(q.fromDate)
      if (q.toDate) opts.toDate = new Date(q.toDate)
      const s = await runTrueProfitRollupOnce(opts)
      return { ok: true, summary: summarizeTrueProfitRollup(s), detail: s }
    },
  )

  fastify.post('/advertising/cron/ads-metrics-ingest/trigger', async (_request, _reply) => {
    const s = await runAdsMetricsIngestOnce()
    return { ok: true, summary: summarizeAdsMetricsIngest(s), detail: s }
  })

  fastify.post('/advertising/cron/drain-ads-sync/trigger', async (request, _reply) => {
    const q = request.query as { limit?: string }
    const limit = Math.min(Number(q.limit) || 50, 500)
    const result = await drainAdsSyncOnce(limit)
    return { ok: true, processed: result.processed, results: result.results }
  })

  // H.10 — on-demand mirror refresh: pull CURRENT keywords, negatives (ad-group + campaign-level),
  // targets, and reconcile Amazon-side deletions right now (the same v3 resync the hourly cron runs),
  // so an operator never has to wait for the next tick to see Amazon's state reflected locally.
  fastify.post('/advertising/cron/keyword-resync/trigger', async (_request, _reply) => {
    const { resyncAllCampaignKeywords } = await import('../services/advertising/ads-keyword-list-sync.service.js')
    const r = await resyncAllCampaignKeywords({})
    return { ok: true, summary: `kwUpserted=${r.upserted} campNeg=${r.campaignNegatives} targets=${r.targetsUpdated} archived=${r.archived} adGroups=${r.adGroups} mode=${r.mode}`, detail: r }
  })

  // ── AD.3: Automation rules (domain-filtered proxy over the existing
  // /api/automation-rules engine) ─────────────────────────────────────

  fastify.get('/advertising/automation-rules', async (request, reply) => {
    const q = request.query as { enabled?: string; trigger?: string }
    const where: Record<string, unknown> = { domain: 'advertising' }
    if (q.enabled === 'true') where.enabled = true
    if (q.enabled === 'false') where.enabled = false
    if (q.trigger) where.trigger = q.trigger
    const items = await prisma.automationRule.findMany({
      where,
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { items, count: items.length }
  })

  fastify.get('/advertising/automation-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.automationRule.findUnique({ where: { id } })
    if (!rule || rule.domain !== 'advertising') {
      reply.code(404)
      return { error: 'not_found' }
    }
    return { rule }
  })

  fastify.post('/advertising/automation-rules', async (request, reply) => {
    const body = request.body as {
      name: string
      description?: string
      trigger: string
      conditions?: object[]
      actions?: object[]
      maxExecutionsPerDay?: number
      maxValueCentsEur?: number
      maxDailyAdSpendCentsEur?: number
      scopeMarketplace?: string
    }
    if (!body?.name || !body.trigger) {
      reply.code(400)
      return { error: 'name + trigger required' }
    }
    const ALLOWED_TRIGGERS = new Set([
      'FBA_AGE_THRESHOLD_REACHED',
      'AD_SPEND_PROFITABILITY_BREACH',
      'CAC_SPIKE',
      'AD_TARGET_UNDERPERFORMING',
      'CAMPAIGN_PERFORMANCE_BUDGET',
      'SCHEDULE',
      // evaluator also supports these keyword/search-term/conversion triggers
      'CVR_DROP',
      'KEYWORD_LOW_CTR',
      'KEYWORD_WASTED_SPEND',
      'KEYWORD_ZERO_IMPRESSIONS',
      'SEARCH_TERM_CONVERTING',
      // Engine expansion (E-series) — net-new triggers
      'KEYWORD_HIGH_ACOS',
      'KEYWORD_SCALE_OPPORTUNITY',
      'AD_GROUP_UNDERPERFORMING',
      'NEW_TO_BRAND_WINNER',
      'CAMPAIGN_NO_SALES',
      'SEARCH_TERM_WASTING',
      'CAMPAIGN_ROAS_DECLINING',
      'KEYWORD_RISING_STAR',
      // SK-series — keyword-bid-adjustment rules driven by Share-of-Voice / keyword-tracker rank data
      'SOV_BID',
      'KEYWORD_RANK_BID',
    ])
    if (!ALLOWED_TRIGGERS.has(body.trigger)) {
      reply.code(400)
      return { error: `unknown trigger: ${body.trigger}` }
    }
    const rule = await prisma.automationRule.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        domain: 'advertising',
        trigger: body.trigger,
        conditions: (body.conditions ?? []) as object,
        actions: (body.actions ?? []) as object,
        // Safe defaults: every new advertising rule starts disabled +
        // dry-run; operator must explicitly opt in to live writes.
        enabled: false,
        dryRun: true,
        maxExecutionsPerDay: body.maxExecutionsPerDay ?? 10,
        maxValueCentsEur: body.maxValueCentsEur ?? null,
        maxDailyAdSpendCentsEur: body.maxDailyAdSpendCentsEur ?? 10000,
        scopeMarketplace: body.scopeMarketplace ?? null,
        createdBy: 'user',
      },
    })
    return { rule }
  })

  fastify.patch('/advertising/automation-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.automationRule.findUnique({ where: { id } })
    if (!existing || existing.domain !== 'advertising') {
      reply.code(404)
      return { error: 'not_found' }
    }
    const body = request.body as {
      name?: string
      description?: string | null
      enabled?: boolean
      dryRun?: boolean
      conditions?: object[]
      actions?: object[]
      maxExecutionsPerDay?: number | null
      maxValueCentsEur?: number | null
      maxDailyAdSpendCentsEur?: number | null
      scopeMarketplace?: string | null
    }
    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = body.name
    if (body.description !== undefined) data.description = body.description
    if (body.enabled !== undefined) data.enabled = body.enabled
    if (body.dryRun !== undefined) data.dryRun = body.dryRun
    if (body.conditions !== undefined) data.conditions = body.conditions
    if (body.actions !== undefined) data.actions = body.actions
    if (body.maxExecutionsPerDay !== undefined) data.maxExecutionsPerDay = body.maxExecutionsPerDay
    if (body.maxValueCentsEur !== undefined) data.maxValueCentsEur = body.maxValueCentsEur
    if (body.maxDailyAdSpendCentsEur !== undefined) data.maxDailyAdSpendCentsEur = body.maxDailyAdSpendCentsEur
    if (body.scopeMarketplace !== undefined) data.scopeMarketplace = body.scopeMarketplace
    const rule = await prisma.automationRule.update({ where: { id }, data })
    return { rule }
  })

  fastify.delete('/advertising/automation-rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.automationRule.findUnique({ where: { id } })
    if (!existing || existing.domain !== 'advertising') {
      reply.code(404)
      return { error: 'not_found' }
    }
    // Cascading delete on AutomationRuleExecution covered by the FK.
    await prisma.automationRule.delete({ where: { id } })
    return { ok: true }
  })

  // ── B3 (Budget rule builder): reusable rule templates — save a rule's criteria +
  //    THEN action, reapply to a new rule. Additive AutomationRuleTemplate table. ──
  fastify.get('/advertising/rule-templates', async (request) => {
    const q = request.query as { type?: string }
    const items = await prisma.automationRuleTemplate.findMany({
      where: { domain: 'advertising', ...(q.type ? { type: q.type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return { items }
  })

  fastify.post('/advertising/rule-templates', async (request, reply) => {
    const b = request.body as { name?: string; type?: string; payload?: unknown }
    if (!b?.name || !b?.type) {
      reply.code(400)
      return { error: 'name + type required' }
    }
    const template = await prisma.automationRuleTemplate.create({
      data: { name: b.name, type: b.type, domain: 'advertising', payload: (b.payload ?? {}) as object, createdBy: 'user' },
    })
    return { template }
  })

  fastify.delete('/advertising/rule-templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.automationRuleTemplate.delete({ where: { id } })
      return { ok: true }
    } catch {
      reply.code(404)
      return { error: 'not_found' }
    }
  })

  // ── ES1: Manual-rule Suggestions — list / approve(apply-live) / dismiss ──
  // F1 — lightweight pending count for the nav badge (no row payload).
  fastify.get('/advertising/suggestions/count', async () => {
    const pending = await prisma.adsRuleSuggestion.count({ where: { status: 'pending' } })
    return { pending }
  })

  fastify.get('/advertising/suggestions', async (request) => {
    const q = request.query as { status?: string; limit?: string }
    const status = q.status ?? 'pending'
    const items = await prisma.adsRuleSuggestion.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(q.limit) || 100, 300),
    })
    return { items, count: items.length }
  })

  // Approve → re-run the proposed action LIVE against the frozen execution context (respects the
  // automation halt + the handlers' own spend caps). The operator already approved, so we apply
  // the action directly rather than re-evaluating conditions.
  fastify.post('/advertising/suggestions/:id/apply', async (request, reply) => {
    const { id } = request.params as { id: string }
    const sug = await prisma.adsRuleSuggestion.findUnique({ where: { id } })
    if (!sug) { reply.code(404); return { error: 'not_found' } }
    if (sug.status !== 'pending') { reply.code(409); return { error: `already ${sug.status}` } }
    const { isAutomationHalted } = await import('../services/advertising/ads-automation-state.service.js')
    if (await isAutomationHalted()) { reply.code(423); return { error: 'automation_halted' } }
    if (!sug.executionId) { reply.code(422); return { error: 'no_execution_context' } }
    const exec = await prisma.automationRuleExecution.findUnique({ where: { id: sug.executionId }, select: { triggerData: true } })
    if (!exec) { reply.code(422); return { error: 'execution_context_gone' } }
    await import('../services/advertising/automation-action-handlers.js') // ensure handlers registered
    const { ACTION_HANDLERS } = await import('../services/automation-rule.service.js')
    const action = sug.proposedAction as Record<string, unknown>
    const handler = ACTION_HANDLERS[String(action.type)]
    if (!handler) { reply.code(422); return { error: `no handler for ${action.type}` } }
    const result = await handler(action as never, exec.triggerData, { dryRun: false, ruleId: sug.ruleId })
    await prisma.adsRuleSuggestion.update({
      where: { id }, data: { status: 'applied', decidedAt: new Date(), decidedBy: 'operator', appliedResult: result as object },
    })
    return { ok: result.ok !== false, result }
  })

  fastify.post('/advertising/suggestions/:id/dismiss', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.adsRuleSuggestion.update({ where: { id }, data: { status: 'dismissed', decidedAt: new Date(), decidedBy: 'operator' } })
      return { ok: true }
    } catch { reply.code(404); return { error: 'not_found' } }
  })

  // Test a rule against a synthetic context — used by the rule-builder
  // UI to preview which actions would fire. Always forces dryRun=true,
  // never writes side-effects regardless of rule.dryRun.
  fastify.post('/advertising/automation-rules/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { context?: unknown }
    if (body?.context == null) {
      reply.code(400)
      return { error: 'context required' }
    }
    const rule = await prisma.automationRule.findUnique({ where: { id } })
    if (!rule || rule.domain !== 'advertising') {
      reply.code(404)
      return { error: 'not_found' }
    }
    if (!rule.enabled) {
      // Allow testing disabled rules — temporarily flip + flip back.
      await prisma.automationRule.update({ where: { id }, data: { enabled: true } })
      try {
        const result = await evaluateRule({ ruleId: id, context: body.context, forceDryRun: true })
        return { result }
      } finally {
        await prisma.automationRule.update({ where: { id }, data: { enabled: false } })
      }
    }
    const result = await evaluateRule({ ruleId: id, context: body.context, forceDryRun: true })
    return { result }
  })

  // GET /api/advertising/automation-rules/:id/gate-status — Phase 9
  //
  // Returns a structured 8-check checklist for graduating a rule from
  // dryRun=true to dryRun=false. Each check has { id, label, detail, passed }.
  // gateOpen=true only when ALL checks pass. Callers render this as a
  // progress checklist; the graduate endpoint re-validates server-side.
  //
  // OBSERVATION_WINDOW uses rule.createdAt as a conservative proxy for
  // "how long has this rule been deployed". We require 14 full days.
  fastify.get('/advertising/automation-rules/:id/gate-status', async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.automationRule.findUnique({
      where: { id },
      select: {
        id: true, domain: true, enabled: true, dryRun: true,
        createdAt: true, evaluationCount: true, matchCount: true,
        executionCount: true,
      },
    })
    if (!rule || rule.domain !== 'advertising') return reply.code(404).send({ error: 'not_found' })

    const conn = await prisma.amazonAdsConnection.findFirst({
      where: { isActive: true },
      select: { mode: true, writesEnabledAt: true },
    })

    const daysInDryRun = Math.floor(
      (Date.now() - rule.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    )
    const OBSERVATION_DAYS = 14
    const liveMode = (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

    const checks = [
      {
        id: 'RULE_ENABLED',
        label: 'Rule is enabled',
        detail: rule.enabled ? 'Enabled' : 'Rule must be enabled (toggle it on first)',
        passed: rule.enabled,
      },
      {
        id: 'RULE_DRY_RUN',
        label: 'Rule is in dry-run mode',
        detail: rule.dryRun ? 'Currently dry-run (safe to graduate)' : 'Already live — nothing to graduate',
        passed: rule.dryRun,
      },
      {
        id: 'OBSERVATION_WINDOW',
        label: `${OBSERVATION_DAYS}-day observation period`,
        detail: daysInDryRun >= OBSERVATION_DAYS
          ? `${daysInDryRun} days since rule created — window complete`
          : `${daysInDryRun}/${OBSERVATION_DAYS} days — ${OBSERVATION_DAYS - daysInDryRun} days remaining`,
        passed: daysInDryRun >= OBSERVATION_DAYS,
      },
      {
        id: 'HAS_EVALUATIONS',
        label: 'Rule has evaluation history',
        detail: rule.evaluationCount >= 10
          ? `${rule.evaluationCount} evaluations recorded`
          : `${rule.evaluationCount} evaluations — need at least 10 to prove the rule has run`,
        passed: rule.evaluationCount >= 10,
      },
      {
        id: 'HAS_MATCHES',
        label: 'Rule has matched at least once',
        detail: rule.matchCount > 0
          ? `${rule.matchCount} matches — rule has found real candidates`
          : 'Zero matches — rule may not be triggering correctly (check conditions)',
        passed: rule.matchCount > 0,
      },
      {
        id: 'CONNECTION_PRODUCTION',
        label: 'Ads connection in production mode',
        detail: conn?.mode === 'production'
          ? 'AmazonAdsConnection.mode = production'
          : `AmazonAdsConnection.mode = ${conn?.mode ?? 'none'} (must be production)`,
        passed: conn?.mode === 'production',
      },
      {
        id: 'WRITES_ENABLED',
        label: 'Live writes explicitly enabled',
        detail: conn?.writesEnabledAt != null
          ? `Writes enabled at ${conn.writesEnabledAt.toISOString()}`
          : 'Run /advertising/connection/preview-writes + /enable-writes first',
        passed: conn?.writesEnabledAt != null,
      },
      {
        id: 'LIVE_MODE_ENV',
        label: 'NEXUS_AMAZON_ADS_MODE=live deployed',
        detail: liveMode
          ? 'Environment variable confirmed'
          : 'Set NEXUS_AMAZON_ADS_MODE=live on Railway and redeploy',
        passed: liveMode,
      },
    ]

    const gateOpen = checks.every((c) => c.passed)
    return { gateOpen, daysInDryRun, observationDaysRequired: OBSERVATION_DAYS, checks }
  })

  // POST /api/advertising/automation-rules/:id/graduate — Phase 9
  //
  // Flips dryRun=false after re-running all 8 gate checks server-side.
  // Returns 409 with structured failures if any check hasn't passed.
  // The operator is responsible for monitoring the first live executions.
  fastify.post('/advertising/automation-rules/:id/graduate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const rule = await prisma.automationRule.findUnique({
      where: { id },
      select: {
        id: true, domain: true, name: true, enabled: true, dryRun: true,
        createdAt: true, evaluationCount: true, matchCount: true,
      },
    })
    if (!rule || rule.domain !== 'advertising') return reply.code(404).send({ error: 'not_found' })

    // Re-validate gate server-side — never trust the client's gate result
    const conn = await prisma.amazonAdsConnection.findFirst({
      where: { isActive: true },
      select: { profileId: true, mode: true, writesEnabledAt: true },
    })
    const daysInDryRun = Math.floor((Date.now() - rule.createdAt.getTime()) / (1000 * 60 * 60 * 24))
    const liveMode = (process.env.NEXUS_AMAZON_ADS_MODE ?? 'sandbox') === 'live'

    const failures: string[] = []
    if (!rule.enabled)            failures.push('RULE_ENABLED')
    if (!rule.dryRun)             failures.push('RULE_DRY_RUN')
    if (daysInDryRun < 14)        failures.push(`OBSERVATION_WINDOW (${daysInDryRun}/14 days)`)
    if (rule.evaluationCount < 10) failures.push(`HAS_EVALUATIONS (${rule.evaluationCount}/10)`)
    if (rule.matchCount < 1)      failures.push('HAS_MATCHES')
    if (conn?.mode !== 'production') failures.push('CONNECTION_PRODUCTION')
    if (!conn?.writesEnabledAt)   failures.push('WRITES_ENABLED')
    if (!liveMode)                failures.push('LIVE_MODE_ENV')

    if (failures.length > 0) {
      return reply.code(409).send({
        error: 'gate_not_open',
        failures,
        message: 'Not all gate checks passed — resolve the listed items first',
      })
    }

    const updated = await prisma.automationRule.update({
      where: { id },
      data: { dryRun: false },
      select: { id: true, name: true, dryRun: true, enabled: true },
    })
    logger.info('[ADS-GRADUATE] rule graduated to live', {
      ruleId: id, ruleName: rule.name, profileId: conn?.profileId,
    })
    return { ok: true, rule: updated, graduatedAt: new Date().toISOString() }
  })

  fastify.post('/advertising/automation-rules/seed-templates', async (_request, _reply) => {
    const result = await seedAdvertisingTemplates()
    return { ok: true, ...result }
  })

  // ── AD.3: Execution feed ────────────────────────────────────────────
  fastify.get('/advertising/automation-rule-executions', async (request, reply) => {
    const q = request.query as {
      ruleId?: string
      status?: string
      limit?: string
    }
    const where: Record<string, unknown> = { rule: { domain: 'advertising' } }
    if (q.ruleId) where.ruleId = q.ruleId
    if (q.status) where.status = q.status
    const limit = Math.min(Number(q.limit) || 100, 500)
    const items = await prisma.automationRuleExecution.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: {
        rule: { select: { id: true, name: true, trigger: true } },
      },
    })
    reply.header('Cache-Control', 'private, max-age=15')
    return { items, count: items.length }
  })

  // ── AD.3: Evaluator manual trigger + status ─────────────────────────
  // POST /api/advertising/debug/tos-is-ingest — Option C probe + ingest.
  // Issues an ISOLATED campaigns report with the extra topOfSearchImpressionShare
  // column and stores it on the TOP_OF_SEARCH placement rows. Calling this both
  // validates that Amazon accepts the metric (withIS > 0 + sample populated) and
  // performs the first ingest. Safe: failure is isolated to this fetch.
  // Phase 2 — GET /api/advertising/execution-events — SSE stream for the
  // Activity feed. Publishes automation.rule.fired whenever any advertising
  // rule fires (matched, dry-run, failed, cap-exceeded). Reconnect via
  // ?since=<ts> to replay the ring buffer since that timestamp.
  fastify.get('/advertising/execution-events', async (request, reply) => {
    const q = request.query as { since?: string }
    const sinceMs = q.since ? Number(q.since) : 0
    const { sseResponseHeaders } = await import('../lib/sse.js')
    reply.raw.writeHead(200, sseResponseHeaders(request.headers.origin as string | undefined))
    reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)
    const { subscribeAdsExecutions, replayAdsExecutionsSince } = await import('../services/ads-execution-events.service.js')
    if (sinceMs > 0) {
      for (const e of replayAdsExecutionsSince(sinceMs)) {
        try { reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`) } catch { break }
      }
    }
    const send = (e: { type: string } & Record<string, unknown>) => {
      try { reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`) } catch { /* dead */ }
    }
    const unsub = subscribeAdsExecutions(send as never)
    const hb = setInterval(() => { try { reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`) } catch { clearInterval(hb) } }, 25_000)
    reply.raw.on('close', () => { clearInterval(hb); unsub() })
  })

  fastify.post('/advertising/debug/tos-is-ingest', async (request) => {
    const b = (request.body ?? {}) as { windowDays?: number; marketplace?: string }
    const { ingestTopOfSearchIS } = await import('../services/advertising/ads-tos-is-ingest.service.js')
    return ingestTopOfSearchIS({ windowDays: b.windowDays, marketplace: b.marketplace })
  })

  fastify.post('/advertising/cron/advertising-rule-evaluator/trigger', async (_request, _reply) => {
    const summary = await runAdvertisingRuleEvaluatorOnce()
    return { ok: true, summary }
  })

  fastify.get('/advertising/cron/advertising-rule-evaluator/status', async (_request, _reply) => {
    return getAdvertisingRuleEvaluatorStatus()
  })

  // ── AX.4: CREATE routes (campaign/adGroup/keyword/productAd) ─────────
  // Local-first; v3 SP POST behind the write gate (sandbox-safe). Feed the
  // campaign builder (AX.5) + keyword-paste architect (AX.6).
  fastify.post('/advertising/campaigns/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name || !b?.type || !b?.marketplace || b?.dailyBudgetEur == null) { reply.status(400); return { error: 'name, type, marketplace, dailyBudgetEur required' } }
    const { createCampaignLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createCampaignLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/adgroups/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.campaignId || !b?.name || b?.defaultBidEur == null) { reply.status(400); return { error: 'campaignId, name, defaultBidEur required' } }
    const { createAdGroupLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createAdGroupLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/keywords/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.adGroupId || !b?.keywordText || !b?.matchType || b?.bidEur == null) { reply.status(400); return { error: 'adGroupId, keywordText, matchType, bidEur required' } }
    const { createKeywordLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createKeywordLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/product-ads/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.adGroupId || (!b?.sku && !b?.asin)) { reply.status(400); return { error: 'adGroupId + sku|asin required' } }
    const { createProductAdLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createProductAdLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  // ── AME.14: autonomy & guardrails control center ────────────────────
  // Single pane: global kill state, rule posture (enabled / dry-run / off),
  // total daily-spend-cap exposure, recent auto-actions + rollback window.
  // pause-all is the one-click UI kill (disables every advertising rule);
  // resume re-enables the ids it returned. NEXUS_ADS_AUTOMATION_KILL is the
  // hard env-level stop that even blocks the evaluator.
  fastify.get('/advertising/autonomy/status', async (_request, reply) => {
    const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, enabled: true, dryRun: true, trigger: true, maxDailyAdSpendCentsEur: true } })
    const enabled = rules.filter((r) => r.enabled)
    const live = enabled.filter((r) => !r.dryRun)
    const dailyCapExposureCents = enabled.reduce((s, r) => s + (r.maxDailyAdSpendCentsEur ?? 0), 0)
    const recent = await prisma.automationRuleExecution.findMany({ orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, ruleId: true, status: true, startedAt: true, errorMessage: true } }).catch(() => [])
    const now = Date.now()
    reply.header('Cache-Control', 'private, max-age=15')
    return {
      killSwitch: process.env.NEXUS_ADS_AUTOMATION_KILL === '1',
      rules: { total: rules.length, enabled: enabled.length, live: live.length, dryRun: enabled.length - live.length, disabled: rules.length - enabled.length },
      dailyCapExposureCents,
      recentExecutions: recent.map((e) => ({ ...e, rollbackAvailable: now - new Date(e.startedAt).getTime() < 24 * 3600 * 1000 })),
    }
  })
  fastify.post('/advertising/autonomy/pause-all', async (_request) => {
    const enabled = await prisma.automationRule.findMany({ where: { domain: 'advertising', enabled: true }, select: { id: true } })
    const ids = enabled.map((r) => r.id)
    if (ids.length) await prisma.automationRule.updateMany({ where: { id: { in: ids } }, data: { enabled: false } })
    return { ok: true, pausedRuleIds: ids }
  })
  fastify.post('/advertising/autonomy/resume', async (request, reply) => {
    const b = (request.body ?? {}) as { ruleIds?: string[] }
    if (!Array.isArray(b.ruleIds) || b.ruleIds.length === 0) { reply.status(400); return { error: 'ruleIds[] required' } }
    await prisma.automationRule.updateMany({ where: { id: { in: b.ruleIds }, domain: 'advertising' }, data: { enabled: true } })
    return { ok: true, resumed: b.ruleIds.length }
  })

  // ── AX2.1: Product / ASIN / category / auto targeting ───────────────
  fastify.post('/advertising/targets/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.adGroupId || !b?.kind || !b?.value || b?.bidEur == null) { reply.status(400); return { error: 'adGroupId, kind (PRODUCT|CATEGORY|AUTO|AUDIENCE), value, bidEur required' } }
    const { createTargetLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createTargetLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/negative-targets/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.adGroupId || !b?.asin) { reply.status(400); return { error: 'adGroupId, asin required' } }
    const { createNegativeProductTargetLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createNegativeProductTargetLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  // ── AX2.10: Data-grounded bid suggestions ───────────────────────────
  fastify.post('/advertising/bid-suggestions', async (request, reply) => {
    const b = request.body as { keywords?: string[]; matchType?: string; marketplace?: string; adTargetId?: string }
    if (!Array.isArray(b?.keywords) || b.keywords.length === 0) { reply.status(400); return { error: 'keywords[] required' } }
    const { suggestBids } = await import('../services/advertising/ads-bid-suggest.service.js')
    try {
      const result = await suggestBids({ keywords: b.keywords, matchType: b.matchType, marketplace: b.marketplace })
      // Apex C.1 — blend Amazon's own theme-based bid recommendation when the
      // caller passes an adTargetId we can resolve to a synced ad-group context.
      // Best-effort + read-only: any failure leaves the own-CPC suggestion intact.
      if (b.adTargetId) {
        try {
          const t = await prisma.adTarget.findUnique({
            where: { id: b.adTargetId },
            select: {
              expressionType: true,
              adGroup: { select: { externalAdGroupId: true, campaign: { select: { externalCampaignId: true, marketplace: true, biddingStrategy: true } } } },
            },
          })
          const ag = t?.adGroup
          const camp = ag?.campaign
          if (ag?.externalAdGroupId && camp?.externalCampaignId && camp.marketplace) {
            const conn = await prisma.amazonAdsConnection.findFirst({
              where: { marketplace: camp.marketplace, isActive: true },
              select: { profileId: true, region: true },
            })
            if (conn) {
              const { getThemeBidRecommendations } = await import('../services/advertising/ads-api-client.js')
              const recs = await getThemeBidRecommendations(
                { profileId: conn.profileId, region: (conn.region as 'EU' | 'NA' | 'FE') ?? 'EU' },
                {
                  externalCampaignId: camp.externalCampaignId,
                  externalAdGroupId: ag.externalAdGroupId,
                  targets: b.keywords!.map((k) => ({ expression: k, matchType: b.matchType ?? t!.expressionType ?? 'BROAD' })),
                  biddingStrategy: camp.biddingStrategy ?? undefined,
                },
              )
              const byExpr = new Map(recs.map((r) => [r.expression.toLowerCase(), r]))
              for (const s of result.suggestions) {
                const r = byExpr.get(s.keyword.toLowerCase())
                if (r) s.amazon = { suggestedBidCents: r.suggestedBidCents, theme: r.theme, rangeLowCents: r.rangeLowCents, rangeHighCents: r.rangeHighCents }
              }
            }
          }
        } catch (e) {
          logger.warn('[bid-suggestions] Amazon rec blend failed (own-CPC stands)', { error: (e as Error)?.message })
        }
      }
      return result
    } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX2.9: Sponsored Brands creative ────────────────────────────────
  fastify.post('/advertising/sb-creatives/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.adGroupId || !b?.brandName || !b?.headline || !Array.isArray(b?.asins)) { reply.status(400); return { error: 'adGroupId, brandName, headline, asins[] required' } }
    const { createSbAdLocal } = await import('../services/advertising/ads-create.service.js')
    try { return await createSbAdLocal(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX.6: Keyword-paste auto-architect ──────────────────────────────
  fastify.post('/advertising/architect/preview', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.baseName || !b?.marketplace || !b?.strategy || !Array.isArray(b?.keywords)) { reply.status(400); return { error: 'baseName, marketplace, strategy, keywords[] required' } }
    const { buildPlan } = await import('../services/advertising/ads-architect.service.js')
    return buildPlan({ dailyBudgetEur: 10, defaultBidEur: 0.5, ...(b as object) } as never)
  })
  fastify.post('/advertising/architect/apply', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.baseName || !b?.marketplace || !b?.strategy || !Array.isArray(b?.keywords)) { reply.status(400); return { error: 'baseName, marketplace, strategy, keywords[] required' } }
    const { applyPlan } = await import('../services/advertising/ads-architect.service.js')
    try { return await applyPlan({ dailyBudgetEur: 10, defaultBidEur: 0.5, ...(b as object) } as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX.12: Amazon Marketing Stream ingest (hourly) ──────────────────
  // The operator creates an AMS subscription (Ads API → their AWS Firehose
  // → this endpoint). Accepts a single message or { messages: [...] }.
  fastify.post('/advertising/marketing-stream/ingest', async (request, reply) => {
    // AME.9 — shared-secret gate. When NEXUS_AMS_INGEST_SECRET is set, the
    // forwarder (SQS→Lambda) must send a matching x-ams-secret header. Left
    // open only if the secret is unset (so existing flows don't break).
    const secret = process.env.NEXUS_AMS_INGEST_SECRET
    if (secret && request.headers['x-ams-secret'] !== secret) {
      const { noteAmsUnauthorized } = await import('../services/advertising/ads-marketing-stream.service.js')
      noteAmsUnauthorized()
      reply.status(401); return { error: 'unauthorized' }
    }
    const b = request.body as Record<string, unknown>
    const messages = Array.isArray((b as { messages?: unknown[] })?.messages) ? (b as { messages: unknown[] }).messages : [b]
    const { ingestMarketingStream } = await import('../services/advertising/ads-marketing-stream.service.js')
    try { return await ingestMarketingStream(messages as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AME.9: Amazon Marketing Stream subscription management ───────────
  // Live hourly feed requires the operator to provision an AWS destination
  // (SQS/Firehose ARN) + create a subscription per dataset. These endpoints
  // drive that once NEXUS_AMS_DESTINATION_ARN (or a passed ARN) is set.
  async function firstActiveAdsProfile(): Promise<{ profileId: string; region: AdsRegion } | null> {
    const c = await prisma.amazonAdsConnection.findFirst({ where: { isActive: true }, select: { profileId: true, region: true } })
    if (!c) return null
    return { profileId: c.profileId, region: (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as AdsRegion }
  }
  fastify.get('/advertising/marketing-stream/status', async () => {
    const { amsStatus } = await import('../services/advertising/ads-marketing-stream.service.js')
    return amsStatus()
  })
  // Diagnostic — last raw AMS messages + ingest result this instance saw, to
  // confirm the real field shape once data flows.
  fastify.get('/advertising/marketing-stream/debug-sample', async () => {
    const { amsDebugSnapshot } = await import('../services/advertising/ads-marketing-stream.service.js')
    return amsDebugSnapshot()
  })

  // ── TD.0: Trading Desk automation safety spine (autonomy + circuit-breaker) ──
  fastify.get('/advertising/automation/state', async () => {
    const { getAutomationState } = await import('../services/advertising/ads-automation-state.service.js')
    return getAutomationState()
  })
  fastify.post('/advertising/automation/autonomy', async (request, reply) => {
    const b = (request.body ?? {}) as { level?: string }
    if (!b.level || !['OFF', 'SUGGEST', 'AUTO'].includes(b.level)) { reply.status(400); return { error: 'level must be OFF|SUGGEST|AUTO' } }
    const { setAutonomy, getAutomationState } = await import('../services/advertising/ads-automation-state.service.js')
    await setAutonomy(b.level as 'OFF' | 'SUGGEST' | 'AUTO', actorFromHeaders(request.headers as Record<string, unknown>))
    return getAutomationState()
  })
  fastify.post('/advertising/automation/halt', async (request, reply) => {
    const b = (request.body ?? {}) as { reason?: string }
    const { haltAutomation, getAutomationState } = await import('../services/advertising/ads-automation-state.service.js')
    await haltAutomation(b.reason || 'Operator halt', actorFromHeaders(request.headers as Record<string, unknown>))
    reply.status(200); return getAutomationState()
  })
  fastify.post('/advertising/automation/resume', async (request) => {
    const { resumeAutomation, getAutomationState } = await import('../services/advertising/ads-automation-state.service.js')
    await resumeAutomation(actorFromHeaders(request.headers as Record<string, unknown>))
    return getAutomationState()
  })
  fastify.post('/advertising/automation/thresholds', async (request) => {
    const b = (request.body ?? {}) as { maxHourlySpendCentsEur?: number | null; maxActionsPerHour?: number | null }
    const { setGuardThresholds, getAutomationState } = await import('../services/advertising/ads-automation-state.service.js')
    await setGuardThresholds(b)
    return getAutomationState()
  })
  fastify.post('/advertising/automation/guard/run', async () => {
    const { runAnomalyGuardOnce } = await import('../services/advertising/ads-anomaly-guard.service.js')
    return runAnomalyGuardOnce()
  })
  // TD.1 — run the profit-native target-ACOS auto-bid pass on demand (respects
  // the autonomy dial; SUGGEST = proposals only).
  fastify.post('/advertising/automation/auto-bid/run', async () => {
    const { runAutoBidOnce } = await import('../services/advertising/ads-auto-bid.service.js')
    return runAutoBidOnce()
  })
  // TD.2 — run the keyword harvest+prune pass on demand (autonomy-gated).
  fastify.post('/advertising/automation/auto-harvest/run', async () => {
    const { runAutoHarvestOnce } = await import('../services/advertising/ads-auto-harvest.service.js')
    return runAutoHarvestOnce()
  })
  fastify.get('/advertising/marketing-stream/subscriptions', async (request, reply) => {
    const prof = await firstActiveAdsProfile()
    if (!prof) { reply.status(400); return { error: 'no active Amazon Ads connection' } }
    const { listAmsSubscriptions } = await import('../services/advertising/ads-marketing-stream.service.js')
    try { return await listAmsSubscriptions(prof.profileId, prof.region) } catch (e) { reply.status(502); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/marketing-stream/subscriptions', async (request, reply) => {
    const b = (request.body ?? {}) as { dataSetId?: string; destinationArn?: string; notes?: string; allDatasets?: boolean }
    const prof = await firstActiveAdsProfile()
    if (!prof) { reply.status(400); return { error: 'no active Amazon Ads connection' } }
    const { createAmsSubscription, AMS_DATASETS } = await import('../services/advertising/ads-marketing-stream.service.js')
    const datasets = b.allDatasets ? [...AMS_DATASETS] : b.dataSetId ? [b.dataSetId] : []
    if (datasets.length === 0) { reply.status(400); return { error: 'dataSetId or allDatasets:true required' } }
    // Per-dataset try/catch so an already-subscribed dataset (duplicate 400)
    // doesn't abort the rest — allDatasets must be idempotent + resilient.
    const results: Array<{ dataSetId: string; ok: boolean; result?: unknown; error?: string }> = []
    for (const ds of datasets) {
      try {
        const result = await createAmsSubscription({ profileId: prof.profileId, region: prof.region, dataSetId: ds, destinationArn: b.destinationArn, notes: b.notes })
        results.push({ dataSetId: ds, ok: true, result })
      } catch (e) {
        results.push({ dataSetId: ds, ok: false, error: (e as Error)?.message })
      }
    }
    return { created: results }
  })
  fastify.delete('/advertising/marketing-stream/subscriptions/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const prof = await firstActiveAdsProfile()
    if (!prof) { reply.status(400); return { error: 'no active Amazon Ads connection' } }
    const { deleteAmsSubscription } = await import('../services/advertising/ads-marketing-stream.service.js')
    try { return await deleteAmsSubscription(prof.profileId, prof.region, id) } catch (e) { reply.status(502); return { error: (e as Error)?.message } }
  })

  // ── AME.11: Top-of-search placement optimizer ───────────────────────
  fastify.get('/advertising/top-of-search', async (request, reply) => {
    const q = request.query as { windowDays?: string; marketplace?: string; targetAcos?: string; targetIS?: string }
    const { analyzeTopOfSearch } = await import('../services/advertising/ads-top-of-search.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return analyzeTopOfSearch({ windowDays: q.windowDays ? Number(q.windowDays) : undefined, marketplace: q.marketplace, targetAcos: q.targetAcos ? Number(q.targetAcos) : undefined, targetIS: q.targetIS ? Number(q.targetIS) : undefined })
  })
  fastify.post('/advertising/top-of-search/apply', async (request, reply) => {
    const b = (request.body ?? {}) as { campaignId?: string; percentage?: number }
    if (!b.campaignId || b.percentage == null) { reply.status(400); return { error: 'campaignId and percentage required' } }
    const { applyTopOfSearch } = await import('../services/advertising/ads-top-of-search.service.js')
    try { return { ok: true, result: await applyTopOfSearch(b.campaignId, b.percentage) } } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/top-of-search/apply-all', async (request, reply) => {
    const b = (request.body ?? {}) as { windowDays?: number; marketplace?: string; targetAcos?: number }
    const { applyTopOfSearchRecommendations } = await import('../services/advertising/ads-top-of-search.service.js')
    try { return await applyTopOfSearchRecommendations(b) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // AME.13: the /internal/bidding/* contract endpoints live further below
  // (a concurrent session landed a token-gated + action-logged version — kept
  // as the single source of truth to avoid a duplicate-route boot crash).

  // ── AF.1b: synchronous keyword resync via the v3 list API ───────────
  // Reliable current-state keyword sync (the async export is snapshot-dedup'd
  // and returns empty, so it can't re-fetch existing keywords). Resyncs a
  // campaign's positive + negative keywords with clean bids.
  fastify.post('/advertising/keywords/resync', async (request, reply) => {
    const b = (request.body ?? {}) as { campaignId?: string }
    if (!b.campaignId) { reply.status(400); return { error: 'campaignId required' } }
    const { syncCampaignKeywords } = await import('../services/advertising/ads-keyword-list-sync.service.js')
    try { return { ok: true, ...(await syncCampaignKeywords(b.campaignId)) } } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  // AF.7 — fleet-wide keyword resync (real Amazon bids via v3 list API).
  fastify.post('/advertising/keywords/resync-all', async (request, reply) => {
    const b = (request.body ?? {}) as { chunk?: number }
    const { resyncAllCampaignKeywords } = await import('../services/advertising/ads-keyword-list-sync.service.js')
    try { return { ok: true, ...(await resyncAllCampaignKeywords({ chunk: b.chunk })) } } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AME.15-17: campaign launcher + keyword-graduation funnel ────────
  fastify.get('/advertising/funnel/state', async (request, reply) => {
    const q = request.query as { productId?: string }
    if (!q.productId) { reply.status(400); return { error: 'productId required' } }
    const { getFunnelState } = await import('../services/advertising/ads-keyword-funnel.service.js')
    reply.header('Cache-Control', 'private, max-age=30')
    return getFunnelState(q.productId)
  })
  fastify.post('/advertising/funnel/cross-match', async (request, reply) => {
    const b = (request.body ?? {}) as { productId?: string; apply?: boolean; userId?: string }
    if (!b.productId) { reply.status(400); return { error: 'productId required' } }
    const { crossMatchNegations } = await import('../services/advertising/ads-keyword-funnel.service.js')
    try { return await crossMatchNegations(b.productId, b.apply === true, b.userId) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/funnel/launch', async (request, reply) => {
    const b = (request.body ?? {}) as { productId?: string; marketplace?: string; dailyBudgetEur?: number; defaultBidEur?: number; keywords?: string[]; userId?: string }
    if (!b.productId || !b.marketplace) { reply.status(400); return { error: 'productId + marketplace required' } }
    const { launchProductFunnel } = await import('../services/advertising/ads-keyword-funnel.service.js')
    try { return { ok: true, ...(await launchProductFunnel(b as never)) } } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX.11: Search-term n-gram analysis ──────────────────────────────
  fastify.get('/advertising/ngrams', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { analyzeNgrams } = await import('../services/advertising/ads-ngram.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return analyzeNgrams({ windowDays: q.windowDays ? Number(q.windowDays) : undefined })
  })

  // ── AX2.6: Share of Voice + impression-share intel ──────────────────
  fastify.get('/advertising/share-of-voice', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { analyzeShareOfVoice } = await import('../services/advertising/ads-impression-share.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return analyzeShareOfVoice({ windowDays: q.windowDays ? Number(q.windowDays) : undefined, marketplace: q.marketplace, limit: q.limit ? Number(q.limit) : undefined })
  })

  // ── SK3: Keyword Tracker rank backend ───────────────────────────────
  // GET — the latest rank snapshot per (keyword, marketplace), plus the delta vs the prior snapshot
  // (positive delta = improved = moved toward #1). Feeds the Keyword Tracker report + KEYWORD_RANK_BID.
  fastify.get('/advertising/keyword-ranks', async (request, reply) => {
    const q = request.query as { marketplace?: string; asin?: string; limit?: string }
    const limit = Math.max(1, Math.min(2000, Number(q.limit ?? 500)))
    const rows = await prisma.keywordRank.findMany({
      where: { ...(q.marketplace ? { marketplace: q.marketplace } : {}), ...(q.asin ? { asin: q.asin } : {}) },
      orderBy: [{ keyword: 'asc' }, { marketplace: 'asc' }, { capturedAt: 'desc' }],
      take: 8000, // gather enough history to derive latest + prior per keyword (deduped below)
    })
    // collapse to latest + prior per (keyword, marketplace)
    const byKey = new Map<string, { latest: typeof rows[number]; prior?: typeof rows[number] }>()
    for (const r of rows) {
      const k = `${r.keyword} ${r.marketplace}`
      const e = byKey.get(k)
      if (!e) byKey.set(k, { latest: r })
      else if (!e.prior) e.prior = r
    }
    const items = [...byKey.values()].slice(0, limit).map(({ latest, prior }) => ({
      id: latest.id, keyword: latest.keyword, marketplace: latest.marketplace, asin: latest.asin,
      organicRank: latest.organicRank, sponsoredRank: latest.sponsoredRank, searchVolume: latest.searchVolume,
      capturedAt: latest.capturedAt, source: latest.source,
      // delta: prior - latest (rank improving means the number went DOWN, so a +ve delta = better)
      rankDelta: prior?.organicRank != null && latest.organicRank != null ? prior.organicRank - latest.organicRank : 0,
    }))
    reply.header('Cache-Control', 'private, max-age=60')
    return { count: items.length, items }
  })
  // POST — ingest rank snapshots (pluggable source: manual import now, a collector later). Each row is
  // a point-in-time observation; we append (never overwrite) so the time-series + deltas stay intact.
  fastify.post('/advertising/keyword-ranks', async (request, reply) => {
    const b = request.body as { ranks?: Array<{ keyword?: string; marketplace?: string; asin?: string; organicRank?: number; sponsoredRank?: number; searchVolume?: number; capturedAt?: string; source?: string }> }
    const list = Array.isArray(b?.ranks) ? b.ranks : []
    const clean = list
      .filter((r) => r && typeof r.keyword === 'string' && r.keyword.trim() && typeof r.marketplace === 'string' && r.marketplace.trim())
      .map((r) => ({
        keyword: r.keyword!.trim(),
        marketplace: r.marketplace!.trim().toUpperCase(),
        asin: r.asin?.trim() || null,
        organicRank: r.organicRank != null && Number.isFinite(Number(r.organicRank)) ? Math.max(1, Math.round(Number(r.organicRank))) : null,
        sponsoredRank: r.sponsoredRank != null && Number.isFinite(Number(r.sponsoredRank)) ? Math.max(1, Math.round(Number(r.sponsoredRank))) : null,
        searchVolume: r.searchVolume != null && Number.isFinite(Number(r.searchVolume)) ? Math.max(0, Math.round(Number(r.searchVolume))) : null,
        capturedAt: r.capturedAt ? new Date(r.capturedAt) : new Date(),
        source: (r.source?.trim() || 'manual').slice(0, 64),
      }))
    if (!clean.length) { reply.status(400); return { error: 'ranks[] required (each needs keyword + marketplace)' } }
    const res = await prisma.keywordRank.createMany({ data: clean })
    return { ingested: res.count }
  })

  // ── AX3.14: Advertising Events log ──────────────────────────────────
  fastify.get('/advertising/events', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { listEvents } = await import('../services/advertising/ads-events.service.js')
    reply.header('Cache-Control', 'private, max-age=30')
    return listEvents({ limit: q.limit ? Number(q.limit) : undefined, source: q.source, entityType: q.entityType })
  })
  fastify.post('/advertising/events/custom', async (request, reply) => {
    const b = request.body as { note?: string; entityType?: string; entityId?: string }
    if (!b?.note) { reply.status(400); return { error: 'note required' } }
    const { addCustomEvent } = await import('../services/advertising/ads-events.service.js')
    try { return await addCustomEvent(b as { note: string; entityType?: string; entityId?: string }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX3.13: Automation Health ───────────────────────────────────────
  fastify.get('/advertising/automation-health', async (_request, reply) => {
    const { analyzeAutomationHealth } = await import('../services/advertising/ads-automation-health.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return analyzeAutomationHealth()
  })

  // ── Internal: bidding-engine microservice contract (token-gated) ────
  // services/bidding-engine reads contexts + reports applied bids here; the
  // DB stays owned by this app. Auth via x-internal-token header.
  const internalAuthed = (request: { headers: Record<string, unknown> }): boolean => {
    const token = process.env.NEXUS_INTERNAL_API_TOKEN
    return !!token && request.headers['x-internal-token'] === token
  }
  fastify.get('/internal/bidding/contexts', async (request, reply) => {
    if (!internalAuthed(request as never)) { reply.status(401); return { error: 'unauthorized' } }
    const q = request.query as Record<string, string | undefined>
    const limit = Math.min(q.limit ? Number(q.limit) : 500, 2000)
    // Apex A.2a — in live mode the bidding engine only ever sees targets whose
    // campaign is on the live-write allowlist (default-deny), so the engine path
    // is contained exactly like the audited worker path. Sandbox returns all.
    const enforceAllowlist = adsMode() === 'live'
    const campaignWhere = {
      ...(q.marketplace ? { marketplace: q.marketplace } : {}),
      ...(enforceAllowlist ? { liveBidWritesEnabled: true } : {}),
    }
    const targets = await prisma.adTarget.findMany({
      where: {
        kind: 'KEYWORD', status: 'ENABLED', isNegative: false,
        externalTargetId: { not: null }, clicks: { gt: 0 },
        ...(Object.keys(campaignWhere).length ? { adGroup: { campaign: campaignWhere } } : {}),
      },
      take: limit,
      select: {
        id: true, externalTargetId: true, bidCents: true, clicks: true, spendCents: true,
        salesCents: true, ordersCount: true,
        adGroup: { select: { campaign: { select: { marketplace: true, dynamicBidding: true } } } },
      },
    })
    // Resolve profileId (accountRef) per marketplace once.
    const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true, profileId: true } })
    const profileByMkt = new Map(conns.map((c) => [c.marketplace, c.profileId]))
    const contexts = targets.flatMap((t) => {
      const mkt = t.adGroup?.campaign?.marketplace ?? null
      const accountRef = mkt ? profileByMkt.get(mkt) : undefined
      if (!accountRef || !t.externalTargetId) return []
      const cr = t.clicks > 0 ? (t.ordersCount ?? 0) / t.clicks : 0
      const db = (t.adGroup?.campaign?.dynamicBidding ?? {}) as { targetAcos?: number; maxBidChangePct?: number }
      const acosTargetBps = Math.round((db.targetAcos ?? 0.3) * 10000)
      // Apex A.2a — bound the engine's per-cycle move by the campaign's
      // max-change-% guardrail (when set), so the engine respects the same cap
      // as the audited path. Default keeps the original [5, max(bid×3,300)] band.
      const pct = Number(db.maxBidChangePct)
      const bounded = Number.isFinite(pct) && pct > 0
      const bidMinMinor = bounded ? Math.max(5, Math.round(t.bidCents * (1 - pct / 100))) : 5
      const bidMaxMinor = bounded ? Math.round(t.bidCents * (1 + pct / 100)) : Math.max(t.bidCents * 3, 300)
      return [{
        bridgeId: t.id, externalId: t.externalTargetId, accountRef,
        currentBidMinor: t.bidCents,
        aovMinor: (t.ordersCount ?? 0) > 0 ? Math.round(t.salesCents / (t.ordersCount ?? 1)) : 5000,
        cr7d: cr, cr30d: cr, acosTargetBps, acos1hBps: null, daysOfSupply: null,
        bidMinMinor, bidMaxMinor,
      }]
    })
    reply.header('Cache-Control', 'no-store')
    return { contexts }
  })
  fastify.post('/internal/bidding/applied', async (request, reply) => {
    if (!internalAuthed(request as never)) { reply.status(401); return { error: 'unauthorized' } }
    const b = request.body as { bridgeId?: string; externalId?: string; bidMinor?: number; prevBidMinor?: number; status?: string }
    if (!b?.bridgeId || b?.bidMinor == null) { reply.status(400); return { error: 'bridgeId + bidMinor required' } }
    if (b.status === 'applied') {
      await prisma.adTarget.update({ where: { id: b.bridgeId }, data: { bidCents: b.bidMinor } }).catch(() => {})
    }
    await prisma.advertisingActionLog.create({
      data: {
        actionType: 'bid_set_by_engine', entityType: 'AD_TARGET', entityId: b.bridgeId,
        payloadBefore: { bidCents: b.prevBidMinor ?? null },
        payloadAfter: { bidCents: b.bidMinor, source: 'bidding-engine' } as object,
        amazonResponseStatus: b.status === 'applied' ? 'SUCCESS' : b.status === 'failed' ? 'FAILED' : 'PENDING',
      },
    }).catch(() => {})
    return { ok: true }
  })

  // ── AX3.12: Live Ad Momentum ────────────────────────────────────────
  fastify.get('/advertising/momentum', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { getMomentum } = await import('../services/advertising/ads-momentum.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return getMomentum({ date: q.date })
  })

  // ── AX3.10: Budget Manager ──────────────────────────────────────────
  fastify.get('/advertising/budget-manager', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { analyzeBudgetManager } = await import('../services/advertising/ads-budget-manager.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return analyzeBudgetManager({ month: q.month })
  })
  fastify.post('/advertising/budget-manager/plans', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.id && (!b?.marketplace || !b?.month)) { reply.status(400); return { error: 'marketplace + month required (or id to update)' } }
    const { upsertBudgetPlan } = await import('../services/advertising/ads-budget-manager.service.js')
    try { return await upsertBudgetPlan(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.delete('/advertising/budget-manager/plans/:id', async (request) => {
    const { id } = request.params as { id: string }
    const { deleteBudgetPlan } = await import('../services/advertising/ads-budget-manager.service.js')
    await deleteBudgetPlan(id); return { ok: true }
  })

  // ── AX3.2: Full-funnel Goal builder (branded + unbranded) ───────────
  fastify.post('/advertising/goals/suggest-targets', async (request, reply) => {
    const b = request.body as { brandTerms?: string[]; asins?: string[]; limit?: number }
    if (!Array.isArray(b?.brandTerms)) { reply.status(400); return { error: 'brandTerms[] required' } }
    const { suggestTargets } = await import('../services/advertising/ads-goal.service.js')
    try { return await suggestTargets({ brandTerms: b.brandTerms, asins: b.asins, limit: b.limit }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/goals/apply', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.goalName) { reply.status(400); return { error: 'goalName required' } }
    const { buildGoalPlan, applyGoalPlan } = await import('../services/advertising/ads-goal.service.js')
    try {
      const plan = buildGoalPlan(b as never)
      return await applyGoalPlan(plan)
    } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AG.1: AI Advertising product goals (AI Goal builder → dashboard "Goals") ──
  // DB-only / sandbox: persists the goal config; no live Amazon writes (P8 gate).
  fastify.post('/advertising/ai-goals', async (request, reply) => {
    const { createProductGoal, ValidationError } = await import('../services/advertising/ai-product-goal.service.js')
    try {
      const goal = await createProductGoal(request.body as never)
      return { ok: true, goal }
    } catch (e) {
      if (e instanceof ValidationError) { reply.status(400); return { ok: false, error: e.message } }
      reply.status(500); return { ok: false, error: (e as Error)?.message }
    }
  })
  fastify.get('/advertising/ai-goals', async (request) => {
    const q = request.query as { marketplace?: string }
    const { listProductGoals } = await import('../services/advertising/ai-product-goal.service.js')
    return { items: await listProductGoals({ marketplace: q?.marketplace }) }
  })
  fastify.post('/advertising/ai-goals/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { archiveProductGoal } = await import('../services/advertising/ai-product-goal.service.js')
    try { return { ok: true, goal: await archiveProductGoal(id) } } catch (e) { reply.status(500); return { ok: false, error: (e as Error)?.message } }
  })

  // ── AX3.3: Amazon DSP + Performance+/Brand+ ─────────────────────────
  fastify.get('/advertising/dsp/meta', async (_request, reply) => {
    const { DSP_CHANNELS, DSP_OBJECTIVES } = await import('../services/advertising/ads-dsp.service.js')
    reply.header('Cache-Control', 'private, max-age=600')
    return { channels: DSP_CHANNELS, objectives: DSP_OBJECTIVES }
  })
  fastify.get('/advertising/dsp', async () => {
    const { listDspCampaigns } = await import('../services/advertising/ads-dsp.service.js')
    return listDspCampaigns()
  })
  fastify.post('/advertising/dsp/create', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name || !b?.mode || !b?.objective || b?.dailyBudgetEur == null) { reply.status(400); return { error: 'name, mode (PERFORMANCE_PLUS|BRAND_PLUS), objective, dailyBudgetEur required' } }
    const { createDspCampaign } = await import('../services/advertising/ads-dsp.service.js')
    try { return await createDspCampaign(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX3.4: AMC-style no-SQL audiences ───────────────────────────────
  fastify.get('/advertising/audience-templates', async (_request, reply) => {
    const { AUDIENCE_TEMPLATES } = await import('../services/advertising/ads-audience.service.js')
    reply.header('Cache-Control', 'private, max-age=600')
    return { templates: AUDIENCE_TEMPLATES }
  })
  fastify.get('/advertising/audiences', async (_request) => {
    const { listAudiences } = await import('../services/advertising/ads-audience.service.js')
    return listAudiences()
  })
  fastify.post('/advertising/audiences', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name || !b?.audienceType) { reply.status(400); return { error: 'name, audienceType required' } }
    const { createAudience } = await import('../services/advertising/ads-audience.service.js')
    try { return await createAudience(b as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/audiences/:id/activate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { activateAudience } = await import('../services/advertising/ads-audience.service.js')
    try { return await activateAudience(id) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/audiences/:id/archive', async (request) => {
    const { id } = request.params as { id: string }
    const { archiveAudience } = await import('../services/advertising/ads-audience.service.js')
    return archiveAudience(id)
  })

  // ── AX3.5: iROAS / incrementality (modeled) ─────────────────────────
  fastify.get('/advertising/incrementality', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { analyzeIncrementality } = await import('../services/advertising/ads-incrementality.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return analyzeIncrementality({
      windowDays: q.windowDays ? Number(q.windowDays) : undefined,
      brandTerms: q.brandTerms ? q.brandTerms.split(',') : undefined,
      brandedFactor: q.brandedFactor ? Number(q.brandedFactor) : undefined,
      nonBrandedFactor: q.nonBrandedFactor ? Number(q.nonBrandedFactor) : undefined,
    })
  })

  // ── AX3.1: Retail-readiness guard ───────────────────────────────────
  fastify.get('/advertising/retail-readiness', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { analyzeRetailReadiness } = await import('../services/advertising/ads-retail-readiness.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return analyzeRetailReadiness({ marketplace: q.marketplace, campaignId: q.campaignId })
  })
  fastify.post('/advertising/retail-readiness/apply', async (request, reply) => {
    const b = request.body as { campaignIds?: string[]; marketplace?: string }
    const { applyRetailGuard } = await import('../services/advertising/ads-retail-readiness.service.js')
    try { return await applyRetailGuard({ campaignIds: b?.campaignIds, marketplace: b?.marketplace }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX2.12: Ads alerts (anomaly watch) ──────────────────────────────
  fastify.get('/advertising/alerts', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { buildAlerts } = await import('../services/advertising/ads-alerts.service.js')
    reply.header('Cache-Control', 'private, max-age=120')
    return buildAlerts({ windowDays: q.windowDays ? Number(q.windowDays) : undefined, acosThreshold: q.acosThreshold ? Number(q.acosThreshold) : undefined })
  })

  // ── AX2.7: Unified AI + rules recommendations feed ──────────────────
  fastify.get('/advertising/recommendations', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { buildRecommendations } = await import('../services/advertising/ads-recommendations.service.js')
    reply.header('Cache-Control', 'private, max-age=60')
    return buildRecommendations({ windowDays: q.windowDays ? Number(q.windowDays) : undefined, targetAcos: q.targetAcos ? Number(q.targetAcos) : undefined })
  })
  fastify.get('/advertising/recommendations/brief', async (request) => {
    const q = request.query as Record<string, string | undefined>
    const { buildRecommendations, generateAdsBrief } = await import('../services/advertising/ads-recommendations.service.js')
    const result = await buildRecommendations({ windowDays: q.windowDays ? Number(q.windowDays) : undefined })
    return generateAdsBrief(result, q.language === 'it' ? 'it' : 'en')
  })
  fastify.post('/advertising/recommendations/apply', async (request, reply) => {
    const b = request.body as { kind?: string; payload?: Record<string, unknown> }
    if (!b?.kind || !b?.payload) { reply.status(400); return { error: 'kind + payload required' } }
    const { applyRecommendation } = await import('../services/advertising/ads-recommendations.service.js')
    try { return await applyRecommendation({ kind: b.kind, payload: b.payload }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX.10: Budget pacing ────────────────────────────────────────────
  fastify.get('/advertising/pacing/preview', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { previewPacing } = await import('../services/advertising/ads-budget-pacing.service.js')
    reply.header('Cache-Control', 'private, max-age=30')
    return previewPacing({ targetRoas: q.targetRoas ? Number(q.targetRoas) : undefined })
  })
  fastify.post('/advertising/pacing/apply', async (request, reply) => {
    const { applyPacing } = await import('../services/advertising/ads-budget-pacing.service.js')
    try { return await applyPacing((request.body ?? { changes: [] }) as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX.9: Dayparting schedules ──────────────────────────────────────
  fastify.get('/advertising/schedules', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const items = await prisma.adSchedule.findMany({ orderBy: { createdAt: 'desc' } })
    return { items, count: items.length }
  })
  fastify.post('/advertising/schedules', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.campaignId || !b?.name) { reply.status(400); return { error: 'campaignId, name required' } }
    return prisma.adSchedule.create({ data: { campaignId: b.campaignId as string, name: b.name as string, windows: (b.windows as object) ?? [], timezone: (b.timezone as string) ?? 'Europe/Rome', enabled: (b.enabled as boolean) ?? true, defaultTargetKey: (b.defaultTargetKey as string | null) ?? null } })
  })
  fastify.patch('/advertising/schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'windows', 'timezone', 'enabled', 'defaultTargetKey', 'targetOverrides']) if (b[k] !== undefined) data[k] = b[k]
    const before = await prisma.adSchedule.findUnique({ where: { id }, select: { campaignId: true, lastApplied: true } })
    if (!before) { reply.status(404); return { error: 'not found' } }
    // RC2.T3 reactivation safety: disabling a schedule that currently has the
    // campaign PAUSED must resume it — the cron only resumes ENABLED schedules,
    // so a disable-while-paused would otherwise strand the campaign paused.
    if (data.enabled === false && before.lastApplied === 'PAUSED') {
      try {
        const { updateCampaignWithSync } = await import('../services/advertising/ads-mutation.service.js')
        await updateCampaignWithSync({ campaignId: before.campaignId, patch: { status: 'ENABLED' }, actor: 'automation:dayparting-disable', reason: 'dayparting schedule disabled — resume', applyImmediately: true } as never)
        data.lastApplied = 'ENABLED'
      } catch { /* best-effort resume */ }
    }
    try { return await prisma.adSchedule.update({ where: { id }, data }) } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.delete('/advertising/schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const before = await prisma.adSchedule.findUnique({ where: { id }, select: { campaignId: true, lastApplied: true } })
    if (before?.lastApplied === 'PAUSED') {
      try {
        const { updateCampaignWithSync } = await import('../services/advertising/ads-mutation.service.js')
        await updateCampaignWithSync({ campaignId: before.campaignId, patch: { status: 'ENABLED' }, actor: 'automation:dayparting-delete', reason: 'dayparting schedule deleted — resume', applyImmediately: true } as never)
      } catch { /* best-effort resume */ }
    }
    try { await prisma.adSchedule.delete({ where: { id } }); return { ok: true } } catch { reply.status(404); return { error: 'not found' } }
  })

  // ── BS — Budget Schedules (Helium 10 "Budget Schedules" tab) ──────────
  // A weekly hourly/daily schedule that adjusts campaign budget (CAMPAIGN_BUDGET) or a budget
  // multiplier (BUDGET_MULTIPLIER). Applied by the ad-budget-schedule cron (sandbox-safe).
  const BS_DOW_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
  const bsScheduleDays = (windows: unknown): string => {
    const ws = Array.isArray(windows) ? windows as Array<{ day?: number }> : []
    const days = [...new Set(ws.map((w) => Number(w.day)).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b)
    if (days.length === 0) return '—'
    if (days.length === 7) return 'All Days'
    return days.map((d) => BS_DOW_SHORT[d]).join(', ')
  }
  const bsFmtDate = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

  fastify.get('/advertising/budget-schedules', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const items = await prisma.budgetSchedule.findMany({ where: { kind: 'BUDGET' }, orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }] })
    const shaped = items.map((s) => ({
      id: s.id, name: s.name, type: s.type, enabled: s.enabled, autoRefill: s.autoRefill,
      days: bsScheduleDays(s.windows),
      startDate: bsFmtDate(s.startDate), endDate: s.neverExpire ? null : bsFmtDate(s.endDate),
      excludeStart: null as string | null, excludeEnd: null as string | null,
    }))
    return { items: shaped, count: shaped.length }
  })

  fastify.get('/advertising/budget-schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const schedule = await prisma.budgetSchedule.findUnique({ where: { id } })
    if (!schedule) { reply.status(404); return { error: 'not found' } }
    return { schedule }
  })

  fastify.post('/advertising/budget-schedules', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    if (!b.name) { reply.status(400); return { error: 'name required' } }
    const schedule = await prisma.budgetSchedule.create({ data: {
      name: String(b.name), kind: 'BUDGET', type: (b.type as string) ?? 'CAMPAIGN_BUDGET',
      campaigns: (b.campaigns as object) ?? [], windows: (b.windows as object) ?? [],
      timezone: (b.timezone as string) ?? 'Europe/Rome', chartPrefs: (b.chartPrefs as object) ?? {},
      startDate: b.startDate ? new Date(String(b.startDate)) : null,
      endDate: b.endDate ? new Date(String(b.endDate)) : null,
      neverExpire: b.neverExpire !== false, excludeDates: (b.excludeDates as object) ?? [],
      autoRefill: b.autoRefill === true,
    } })
    return { schedule }
  })

  fastify.patch('/advertising/budget-schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'type', 'campaigns', 'windows', 'timezone', 'chartPrefs', 'neverExpire', 'excludeDates', 'autoRefill', 'enabled']) if (b[k] !== undefined) data[k] = b[k]
    if (b.startDate !== undefined) data.startDate = b.startDate ? new Date(String(b.startDate)) : null
    if (b.endDate !== undefined) data.endDate = b.endDate ? new Date(String(b.endDate)) : null
    try { const schedule = await prisma.budgetSchedule.update({ where: { id }, data }); return { schedule } } catch { reply.status(404); return { error: 'not found' } }
  })

  fastify.delete('/advertising/budget-schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try { await prisma.budgetSchedule.delete({ where: { id } }); return { ok: true } } catch { reply.status(404); return { error: 'not found' } }
  })

  // BS chart — "Hourly Campaign Performance" aggregated by hour-of-day (Rome), from the AMS
  // hourly store. Empty (hasData:false) until Marketing Stream is provisioned for the market.
  fastify.get('/advertising/budget-schedules/hourly-performance', async (request, reply) => {
    const q = request.query as { start?: string; end?: string; marketplace?: string }
    const since = q.start ? new Date(q.start) : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 60); d.setUTCHours(0, 0, 0, 0); return d })()
    const until = q.end ? new Date(q.end) : new Date()
    const rows = await prisma.$queryRaw<Array<{ hour: number; cost: bigint | null; sales: bigint | null; orders: bigint | null; clicks: bigint | null; impressions: bigint | null }>>`
      SELECT EXTRACT(HOUR FROM ts_rome)::int AS hour,
             SUM("costMicros") AS cost, SUM(COALESCE("sales7dCents",0)) AS sales,
             SUM(COALESCE("orders7d",0)) AS orders, SUM("clicks") AS clicks, SUM("impressions") AS impressions
      FROM (
        SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts_rome,
               "costMicros", "sales7dCents", "orders7d", "clicks", "impressions"
        FROM "AmazonAdsHourlyPerformance"
        WHERE "date" >= ${since} AND "date" <= ${until}
      ) t
      GROUP BY hour ORDER BY hour`
    const series = Array.from({ length: 24 }, (_, h) => {
      const r = rows.find((x) => Number(x.hour) === h)
      const spend = r ? Number(r.cost ?? 0n) / 1e6 : 0
      const sales = r ? Number(r.sales ?? 0n) / 100 : 0
      return { hour: h, spend: Math.round(spend * 100) / 100, sales: Math.round(sales * 100) / 100, orders: r ? Number(r.orders ?? 0n) : 0, clicks: r ? Number(r.clicks ?? 0n) : 0, impressions: r ? Number(r.impressions ?? 0n) : 0, acos: sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null }
    })
    reply.header('Cache-Control', 'private, max-age=300')
    return { groupBy: 'hour', timezone: 'Europe/Rome', hasData: rows.length > 0, series }
  })

  // ── AC — AI Control / Autopilot: plans CRUD + decisions + real-time SSE feed ──────
  fastify.get('/advertising/autopilot-plans', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=10')
    const items = await prisma.autopilotPlan.findMany({ orderBy: { updatedAt: 'desc' } })
    return { items, count: items.length }
  })
  fastify.get('/advertising/autopilot-plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const plan = await prisma.autopilotPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    return { plan }
  })
  fastify.post('/advertising/autopilot-plans', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    if (!b.name || !b.marketplace) { reply.status(400); return { error: 'name, marketplace required' } }
    const plan = await prisma.autopilotPlan.create({ data: {
      name: String(b.name), marketplace: String(b.marketplace),
      productGroupName: (b.productGroupName as string) ?? null,
      campaignIds: (b.campaignIds as object) ?? [],
      goal: (b.goal as string) ?? 'BALANCED', autonomy: (b.autonomy as string) ?? 'SUGGEST',
      guardrails: (b.guardrails as object) ?? {}, modules: (b.modules as object) ?? {},
      graph: (b.graph as object) ?? {}, linkedRuleIds: (b.linkedRuleIds as object) ?? [],
    } })
    return { plan }
  })
  fastify.patch('/advertising/autopilot-plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'marketplace', 'productGroupName', 'campaignIds', 'goal', 'autonomy', 'guardrails', 'modules', 'graph', 'linkedRuleIds', 'stage', 'enabled']) if (b[k] !== undefined) data[k] = b[k]
    try { const plan = await prisma.autopilotPlan.update({ where: { id }, data }); return { plan } } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.delete('/advertising/autopilot-plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try { await prisma.autopilotPlan.delete({ where: { id } }); return { ok: true } } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.get('/advertising/autopilot-plans/:id/decisions', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { limit?: string; status?: string }
    const take = Math.min(500, Math.max(1, Number(q.limit ?? 200)))
    const items = await prisma.autopilotDecision.findMany({ where: { planId: id, ...(q.status ? { status: q.status } : {}) }, orderBy: { at: 'desc' }, take })
    return { items, count: items.length }
  })
  // Manual dry-run: run the Conductor once for THIS plan and return the proposed actions (no writes).
  fastify.post('/advertising/autopilot-plans/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string }
    const plan = await prisma.autopilotPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    const { gatherSignals } = await import('../jobs/ad-autopilot.job.js')
    const { runConductorCycle } = await import('../services/advertising/autopilot/conductor.js')
    const signals = await gatherSignals(Array.isArray(plan.campaignIds) ? (plan.campaignIds as string[]) : [])
    const result = runConductorCycle({ goal: plan.goal as never, guardrails: (plan.guardrails ?? {}) as never, modules: (plan.modules ?? {}) as never, signals })
    return { dryRun: true, signalsEvaluated: signals.length, ...result }
  })
  // Backtest / projection: what AUTO would do now + the last-N-day spend/ACoS trajectory (P-F.2).
  fastify.get('/advertising/autopilot-plans/:id/backtest', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { days?: string }
    const plan = await prisma.autopilotPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    const { backtestPlan } = await import('../services/advertising/autopilot/backtest.js')
    const days = Math.min(90, Math.max(7, Number(q.days ?? 30)))
    reply.header('Cache-Control', 'private, max-age=120')
    return backtestPlan({ campaignIds: Array.isArray(plan.campaignIds) ? (plan.campaignIds as string[]) : [], goal: plan.goal as never, guardrails: (plan.guardrails ?? {}) as never, modules: (plan.modules ?? {}) as never, days })
  })
  // Real-time decision feed (SSE): emits new AutopilotDecision rows for the plan as they appear.
  fastify.get('/advertising/autopilot-plans/:id/decisions/stream', async (request, reply) => {
    const { id } = request.params as { id: string }
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    reply.raw.write(': autopilot stream open\n\n')
    let cursor = new Date(0)
    let alive = true
    const tick = async () => {
      if (!alive) return
      try {
        const rows = await prisma.autopilotDecision.findMany({ where: { planId: id, at: { gt: cursor } }, orderBy: { at: 'asc' }, take: 100 })
        if (rows.length) { cursor = rows[rows.length - 1].at; for (const r of rows) reply.raw.write(`data: ${JSON.stringify(r)}\n\n`) }
        else reply.raw.write(': ping\n\n')
      } catch { /* keep the stream alive on transient errors */ }
    }
    await tick()
    const iv = setInterval(() => { void tick() }, 3000)
    request.raw.on('close', () => { alive = false; clearInterval(iv) })
  })

  // ── RS.1 — Rank Targets (reusable rank GOALS for the schedule + baseline) ──
  // "Rank" on Amazon = a Top-of-Search impression-share target held by bid-to-win.
  // A target = placement + targetISPct + ACOS/CPC guardrails; the RS defend loop
  // (RS.5) converges bids toward targetISPct, re-taking the slot if we lose it.
  const BUILTIN_RANK_TARGETS = [
    { key: 'own-top', name: 'Own Top of Search', placement: 'PLACEMENT_TOP', targetISPct: 70, acosCapPct: 45, biasPct: 100, pause: false, color: '#0a7d48', builtIn: true, sortOrder: 1 },
    { key: 'defend-top', name: 'Defend Top', placement: 'PLACEMENT_TOP', targetISPct: 35, acosCapPct: 35, biasPct: 50, pause: false, color: '#3aa873', builtIn: true, sortOrder: 2 },
    { key: 'rest-of-search', name: 'Rest of Search', placement: 'PLACEMENT_REST_OF_SEARCH', targetISPct: 10, acosCapPct: 30, biasPct: 0, pause: false, color: '#e6b067', builtIn: true, sortOrder: 3 },
    // NP — the engine never pauses; this target floors bids to ~2¢ (campaign stays
    // live, restorable). Key stays 'pause' for back-compat with saved windows/plans.
    { key: 'pause', name: 'Min bid', placement: 'PLACEMENT_TOP', pause: true, color: '#d97757', builtIn: true, sortOrder: 4 },
    // RS.1.1 — all-out: ignore ACOS, hold the slot at any cost (up to maxCpc). For
    // must-win windows; maxCpcCents stays null here (operator sets a runaway guard).
    { key: 'own-top-allout', name: 'Own Top — All-Out', placement: 'PLACEMENT_TOP', targetISPct: 90, acosCapPct: null, maxCpcCents: null, biasPct: 150, pause: false, allOut: true, color: '#b91c1c', builtIn: true, sortOrder: 5 },
  ]
  fastify.get('/advertising/rank-targets', async (request, reply) => {
    const q = request.query as { productId?: string; campaignId?: string }
    reply.header('Cache-Control', 'private, max-age=15')
    // Lazy-seed the built-ins (idempotent; never overwrites operator tuning incl. renames).
    for (const t of BUILTIN_RANK_TARGETS) {
      try { await prisma.rankTarget.upsert({ where: { key: t.key }, update: { builtIn: true }, create: t as never }) } catch { /* race-safe */ }
    }
    // RTC — global library (scope null) ∪ custom swatches scoped to this product/campaign.
    const scopeOr: Record<string, unknown>[] = [{ scopeProductId: null, scopeCampaignId: null }]
    if (q.productId) scopeOr.push({ scopeProductId: q.productId })
    if (q.campaignId) scopeOr.push({ scopeCampaignId: q.campaignId })
    const items = await prisma.rankTarget.findMany({ where: { OR: scopeOr }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
    return { items, count: items.length }
  })
  fastify.post('/advertising/rank-targets', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name) { reply.status(400); return { error: 'name required' } }
    const key = (b.key as string) || `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const data = {
      key, name: b.name as string,
      placement: (b.placement as string) ?? 'PLACEMENT_TOP',
      targetISPct: (b.targetISPct as number | null) ?? null,
      acosCapPct: (b.acosCapPct as number | null) ?? null,
      maxCpcCents: (b.maxCpcCents as number | null) ?? null,
      biasPct: (b.biasPct as number | null) ?? null,
      // MP — motion profile (how the loop moves the bias); all default to today's behaviour.
      jumpStartPct: (b.jumpStartPct as number | null) ?? null,
      stepUpPct: (b.stepUpPct as number | null) ?? null,
      stepDownPct: (b.stepDownPct as number | null) ?? null,
      maxBiasPct: (b.maxBiasPct as number | null) ?? null,
      keepClimbing: !!b.keepClimbing,
      pause: !!b.pause, allOut: !!b.allOut, color: (b.color as string | null) ?? null,
      builtIn: false, sortOrder: (b.sortOrder as number) ?? 50,
      scopeProductId: (b.scopeProductId as string | null) ?? null,
      scopeCampaignId: (b.scopeCampaignId as string | null) ?? null,
      // BL — blended lanes (Top/Rest/Product driven at once) + base-bid lever. Empty
      // lanes = legacy single-placement (the engine ignores []).
      lanes: Array.isArray(b.lanes) ? (b.lanes as never) : [],
      bidMode: (b.bidMode as string | null) ?? null,
      bidValueCents: (b.bidValueCents as number | null) ?? null,
      bidDeltaPct: (b.bidDeltaPct as number | null) ?? null,
    }
    try { return await prisma.rankTarget.create({ data: data as never }) } catch { reply.status(409); return { error: 'key_taken' } }
  })
  fastify.patch('/advertising/rank-targets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'placement', 'targetISPct', 'acosCapPct', 'maxCpcCents', 'biasPct', 'jumpStartPct', 'stepUpPct', 'stepDownPct', 'maxBiasPct', 'keepClimbing', 'pause', 'allOut', 'color', 'sortOrder', 'bidMode', 'bidValueCents', 'bidDeltaPct']) if (b[k] !== undefined) data[k] = b[k]
    if (b.lanes !== undefined) data.lanes = Array.isArray(b.lanes) ? b.lanes : [] // BL — [] = clear blend
    try { return await prisma.rankTarget.update({ where: { id }, data }) } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.delete('/advertising/rank-targets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const t = await prisma.rankTarget.findUnique({ where: { id }, select: { builtIn: true } })
    if (!t) { reply.status(404); return { error: 'not found' } }
    if (t.builtIn) { reply.status(409); return { error: 'builtin_protected' } }
    await prisma.rankTarget.delete({ where: { id } })
    return { ok: true }
  })
  // RTC — reset a built-in target to its canonical default values (clears operator tuning).
  fastify.post('/advertising/rank-targets/:id/reset', async (request, reply) => {
    const { id } = request.params as { id: string }
    const t = await prisma.rankTarget.findUnique({ where: { id }, select: { key: true } })
    const d = (t ? BUILTIN_RANK_TARGETS.find((x) => x.key === t.key) : null) as Record<string, unknown> | null
    if (!d) { reply.status(404); return { error: 'not_a_builtin' } }
    return await prisma.rankTarget.update({ where: { id }, data: { name: d.name, placement: d.placement, targetISPct: d.targetISPct ?? null, acosCapPct: d.acosCapPct ?? null, maxCpcCents: d.maxCpcCents ?? null, biasPct: d.biasPct ?? null, jumpStartPct: (d.jumpStartPct as number | null) ?? null, stepUpPct: (d.stepUpPct as number | null) ?? null, stepDownPct: (d.stepDownPct as number | null) ?? null, maxBiasPct: (d.maxBiasPct as number | null) ?? null, keepClimbing: !!d.keepClimbing, color: d.color ?? null, pause: !!d.pause, allOut: !!d.allOut, lanes: [], bidMode: null, bidValueCents: null, bidDeltaPct: null } as never })
  })

  // ── RTPL — named rank-SCHEDULE templates (account-global; Save/Load a painted schedule) ──
  fastify.get('/advertising/rank-templates', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=10')
    const items = await prisma.rankScheduleTemplate.findMany({ orderBy: { updatedAt: 'desc' } })
    return { items, count: items.length }
  })
  fastify.post('/advertising/rank-templates', async (request, reply) => {
    const b = request.body as { name?: string; windows?: unknown; defaultTargetKey?: string | null }
    if (!b?.name?.trim()) { reply.status(400); return { error: 'name required' } }
    return await prisma.rankScheduleTemplate.create({ data: { name: b.name.trim(), windows: (b.windows as object) ?? [], defaultTargetKey: (b.defaultTargetKey as string | null) ?? null } })
  })
  fastify.patch('/advertising/rank-templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'windows', 'defaultTargetKey']) if (b[k] !== undefined) data[k] = b[k]
    try { return await prisma.rankScheduleTemplate.update({ where: { id }, data }) } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.delete('/advertising/rank-templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try { await prisma.rankScheduleTemplate.delete({ where: { id } }); return { ok: true } } catch { reply.status(404); return { error: 'not found' } }
  })

  // ── RD.1 — Rank Director: product-FAMILY rank+dayparting plans ──────────
  // ONE plan per (parent product, marketplace). The defend loop (RD.4+) fans it
  // out to EVERY campaign advertising the family's ASINs, resolved LIVE — so it
  // is the single source of truth vs N drifting per-campaign AdSchedules. Windows
  // carry a rank targetKey (fused dayparting + rank goal); defaultTargetKey is the
  // baseline for unpainted hours ("for the rest, hold Y").
  // B — pull live campaign settings (placement bids / budget / strategy / state) from
  // Amazon v3 into the DB. ?profileId= scopes to one account; default = all. Returns
  // sampleShape (first raw v3 campaign) so the response shape can be verified/refined.
  fastify.post('/advertising/campaigns/sync-settings', async (request, reply) => {
    const q = request.query as { profileId?: string }
    const { syncCampaignSettingsFromAmazon } = await import('../services/advertising/ads-campaign-settings-sync.service.js')
    try { return await syncCampaignSettingsFromAmazon({ profileId: q.profileId }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // B (on-open) — refresh ONE campaign's settings live from Amazon. The cockpit fires
  // this when a campaign is opened so its placement bids / budget / strategy are bang
  // up to date, without waiting for the ~20-min cron.
  fastify.post('/advertising/campaigns/:id/refresh-settings', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { syncOneCampaignSettings } = await import('../services/advertising/ads-campaign-settings-sync.service.js')
    try { return await syncOneCampaignSettings(id) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  fastify.get('/advertising/rank-plans', async (request, reply) => {
    const q = request.query as { marketplace?: string; enabled?: string }
    const where: Record<string, unknown> = {}
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.enabled === '1' || q.enabled === 'true') where.enabled = true
    if (q.enabled === '0' || q.enabled === 'false') where.enabled = false
    const items = await prisma.productRankPlan.findMany({ where, orderBy: { updatedAt: 'desc' } })
    return { items, count: items.length }
  })
  fastify.get('/advertising/rank-plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const plan = await prisma.productRankPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    return plan
  })
  fastify.post('/advertising/rank-plans', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.productId || !b?.marketplace) { reply.status(400); return { error: 'productId, marketplace required' } }
    const data = {
      productId: b.productId as string,
      parentAsin: (b.parentAsin as string | null) ?? null,
      marketplace: b.marketplace as string,
      windows: (b.windows as object) ?? [],
      defaultTargetKey: (b.defaultTargetKey as string | null) ?? null,
      timezone: (b.timezone as string) ?? 'Europe/Rome',
      familyDailyBudgetCents: (b.familyDailyBudgetCents as number | null) ?? null,
      familyAcosCapPct: (b.familyAcosCapPct as number | null) ?? null,
      maxCampaigns: (b.maxCampaigns as number | null) ?? null,
      leadTimeMinutes: (b.leadTimeMinutes as number) ?? 0,
      excludeCampaignIds: (b.excludeCampaignIds as object) ?? [],
      enabled: (b.enabled as boolean) ?? false,
      manualOnly: (b.manualOnly as boolean) ?? false,
      createdBy: (b.createdBy as string | null) ?? null,
    }
    // @@unique([productId, marketplace]) → one plan per family per market.
    try { return await prisma.productRankPlan.create({ data: data as never }) } catch { reply.status(409); return { error: 'plan_exists_for_product_market' } }
  })
  fastify.patch('/advertising/rank-plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['parentAsin', 'windows', 'defaultTargetKey', 'timezone', 'familyDailyBudgetCents', 'familyAcosCapPct', 'maxCampaigns', 'leadTimeMinutes', 'excludeCampaignIds', 'targetOverrides', 'enabled', 'manualOnly']) if (b[k] !== undefined) data[k] = b[k]
    // Disabling stamps pausedAt. The resume-paused-family-campaigns safety (mirror
    // of the AdSchedule reactivation guard) lands in RD.7, once plans actuate.
    if (data.enabled === false) data.pausedAt = new Date()
    try { return await prisma.productRankPlan.update({ where: { id }, data }) } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.delete('/advertising/rank-plans/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try { await prisma.productRankPlan.delete({ where: { id } }); return { ok: true } } catch { reply.status(404); return { error: 'not found' } }
  })

  // ── RD.2 — what this plan fans out to + is the mapping trustworthy? ─────
  // resolveProductFamily is ASIN-centric (AdProductAd.productId is often null), so
  // we surface per-campaign attribution health (ASIN-matched vs productId-linked)
  // alongside the retail-readiness verdict (OOS / lost-buybox) so the operator can
  // trust the campaign list this plan will actuate before arming it.
  fastify.get('/advertising/rank-plans/:id/family', async (request, reply) => {
    const { id } = request.params as { id: string }
    const plan = await prisma.productRankPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
    const fam = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
    // RD.12 — manual scope + delivery recency, so the UI shows which campaigns this
    // plan excludes and can tell "running recently" from "permanently paused".
    const excludeSet = new Set<string>(Array.isArray(plan.excludeCampaignIds) ? (plan.excludeCampaignIds as string[]) : [])
    const since30 = new Date(Date.now() - 30 * 86400000)
    const perf = fam.campaigns.length ? await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: fam.campaigns.map((c) => c.id) }, date: { gte: since30 }, impressions: { gt: 0 } },
      _max: { date: true }, _sum: { costMicros: true },
    }) : []
    const perfByCamp = new Map(perf.filter((p) => p.localEntityId).map((p) => [p.localEntityId as string, { lastDeliveredAt: p._max.date as Date | null, recentSpendCents: Math.round(Number(p._sum.costMicros ?? 0n) / 10000) }]))
    // Attribution health: how reliably the family's ad rows link back to a Product.
    const famAds = fam.asins.length ? await prisma.adProductAd.findMany({
      where: { asin: { in: fam.asins }, adGroup: { campaign: { marketplace: plan.marketplace } } },
      select: { productId: true, adGroup: { select: { campaign: { select: { id: true } } } } },
    }) : []
    const byCamp = new Map<string, { ads: number; matched: number }>()
    for (const a of famAds) {
      const cid = a.adGroup?.campaign?.id; if (!cid) continue
      const e = byCamp.get(cid) ?? { ads: 0, matched: 0 }
      e.ads += 1; if (a.productId) e.matched += 1
      byCamp.set(cid, e)
    }
    // Retail-readiness verdicts (OOS / lost-buybox), filtered to family campaigns.
    const readiness: Record<string, { verdict: string; reason: string; outOfStock: number; lostBuyBox: number }> = {}
    try {
      const { analyzeRetailReadiness } = await import('../services/advertising/ads-retail-readiness.service.js')
      const rr = await analyzeRetailReadiness({ marketplace: plan.marketplace })
      for (const c of rr.campaigns) readiness[c.campaignId] = { verdict: c.verdict, reason: c.reason, outOfStock: c.outOfStock, lostBuyBox: c.lostBuyBox }
    } catch { /* readiness best-effort */ }
    const campaigns = fam.campaigns.map((c) => {
      const att = byCamp.get(c.id) ?? { ads: 0, matched: 0 }
      const pf = perfByCamp.get(c.id)
      return {
        id: c.id, name: c.name, status: c.status, marketplace: c.marketplace,
        adProductAds: att.ads, productIdMatched: att.matched, asinOnly: att.ads - att.matched,
        attributionPct: att.ads ? Math.round((att.matched / att.ads) * 100) : null,
        readiness: readiness[c.id] ?? null,
        excluded: excludeSet.has(c.id),
        lastDeliveredAt: pf?.lastDeliveredAt ?? null,
        recentSpendCents: pf?.recentSpendCents ?? 0,
      }
    })
    const totalAds = [...byCamp.values()].reduce((s, e) => s + e.ads, 0)
    const totalMatched = [...byCamp.values()].reduce((s, e) => s + e.matched, 0)
    reply.header('Cache-Control', 'private, max-age=60')
    return {
      plan: { id: plan.id, productId: plan.productId, parentAsin: plan.parentAsin, marketplace: plan.marketplace },
      family: { parentProductId: fam.parentProductId, parentName: fam.parentName, asins: fam.asins, productIds: fam.productIds, campaignCount: fam.campaigns.length },
      campaigns,
      attribution: { totalAdProductAds: totalAds, productIdMatched: totalMatched, overallPct: totalAds ? Math.round((totalMatched / totalAds) * 100) : null },
      readinessSummary: { pause: campaigns.filter((c) => c.readiness?.verdict === 'pause').length, watch: campaigns.filter((c) => c.readiness?.verdict === 'watch').length },
    }
  })

  // ── RD.3 — family demand by hour (product-anchored, per-market, date-range) ──
  // The authoring feed for Rank Director: pick a PRODUCT → see when the whole
  // VARIATION FAMILY actually sells (order demand, blended + sparse-shrunk toward
  // the market prior), in the market's shopper-local time — even if a campaign has
  // one ASIN. Returns a recommended rank-window plan (peak hours → push target,
  // the rest → baseline) the operator one-clicks then tunes. Read-only.
  fastify.get('/advertising/by-product/family-dayparting', async (request, reply) => {
    const q = request.query as { productId?: string; marketplace?: string; from?: string; to?: string; preset?: string; windowDays?: string }
    if (!q.productId) { reply.status(400); return { error: 'productId required' } }
    const marketplace = q.marketplace || 'IT'
    const { resolveProductFamily, blendedFamilyDemand, recommendRankWindows } = await import('../services/advertising/ads-dayparting-refresh.service.js')
    const fam = await resolveProductFamily({ parentProductId: q.productId, marketplace })
    if (!fam.parentProductId || fam.productIds.length === 0) { reply.status(404); return { error: 'product family not found' } }
    // Date range: explicit from/to (or a preset), else windowDays fallback. TZ note:
    // the demand SQL buckets in Europe/Rome — correct for IT v1; multi-market needs
    // the bucket TZ parameterised (tracked for expansion).
    const { resolveRange } = await import('../services/advertising/ads-date-range.js')
    const range = resolveRange({ preset: q.preset, startDate: q.from, endDate: q.to, windowDays: q.windowDays })
    const to = new Date(range.until.getTime() + 86_400_000) // include the until day (SQL uses < to)
    const d = await blendedFamilyDemand(fam.productIds, marketplace, range.days, { from: range.since, to }, fam.skus)
    // RD.10f — RAW actual demand is the default; smoothed (market-blended) is a toggle.
    const recommended = recommendRankWindows(d.raw.weekdayProfile, d.raw.hourProfile)
    reply.header('Cache-Control', 'private, max-age=120')
    return {
      marketplace, parentProductId: fam.parentProductId, parentName: fam.parentName,
      productIds: fam.productIds, asins: fam.asins, campaignCount: fam.campaigns.length,
      range: { from: range.sinceStr, to: range.untilStr, days: range.days, preset: range.preset },
      demand: { totals: d.raw.totals, hourProfile: d.raw.hourProfile, weekdayProfile: d.raw.weekdayProfile, grid: d.raw.grid, hasData: d.hasData, familyOrders: d.familyOrders, timezone: d.timezone, metric: d.metric },
      smoothed: { totals: d.totals, hourProfile: d.hourProfile, weekdayProfile: d.weekdayProfile, grid: d.grid, blended: d.blended, timezone: d.timezone, metric: d.metric },
      recommended,
    }
  })

  // ── RD.7 — per-plan actuation: live preview / apply-now / revert / bulk push ──
  // run-now evaluates ONE plan: dryRun previews per-campaign decisions; live applies
  // them through the write-gate (force bypasses manualOnly — the operator clicked
  // apply). revert resets the family's PLACEMENT_TOP to the baseline. apply-across is
  // an immediate bulk Top-of-Search set across every family campaign.
  fastify.post('/advertising/rank-plans/:id/run-now', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { dryRun?: boolean }
    const dryRun = body.dryRun === true || (request.query as { dryRun?: string })?.dryRun === '1'
    const plan = await prisma.productRankPlan.findUnique({ where: { id }, select: { id: true } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    const { runRankDefendOnce } = await import('../jobs/ad-rank-defend.job.js')
    try { return await runRankDefendOnce({ dryRun, onlyPlanId: id, force: !dryRun }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  fastify.post('/advertising/rank-plans/:id/revert', async (request, reply) => {
    const { id } = request.params as { id: string }
    const plan = await prisma.productRankPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
    const { applyTopOfSearch } = await import('../services/advertising/ads-top-of-search.service.js')
    const fam = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
    const baseline = plan.defaultTargetKey ? await prisma.rankTarget.findUnique({ where: { key: plan.defaultTargetKey } }) : null
    const pct = baseline?.biasPct ?? 0
    // Only revert the campaigns this plan actually controls (excluded ones were never touched).
    const exRevert = new Set<string>(Array.isArray(plan.excludeCampaignIds) ? (plan.excludeCampaignIds as string[]) : [])
    const scoped = fam.campaigns.filter((c) => !exRevert.has(c.id))
    let reverted = 0
    for (const c of scoped) { try { await applyTopOfSearch(c.id, pct); reverted++ } catch { /* best-effort */ } }
    return { ok: true, reverted, toPct: pct, campaigns: scoped.length }
  })
  fastify.post('/advertising/rank-plans/:id/apply-across', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = (request.body ?? {}) as { targetKey?: string; percentage?: number }
    const plan = await prisma.productRankPlan.findUnique({ where: { id } })
    if (!plan) { reply.status(404); return { error: 'not found' } }
    let pct = typeof b.percentage === 'number' ? b.percentage : undefined
    if (pct == null && b.targetKey) { const t = await prisma.rankTarget.findUnique({ where: { key: b.targetKey } }); pct = t?.biasPct ?? undefined }
    if (pct == null) { reply.status(400); return { error: 'targetKey or percentage required' } }
    const clamped = Math.max(0, Math.min(900, Math.round(pct)))
    const { resolveProductFamily } = await import('../services/advertising/ads-dayparting-refresh.service.js')
    const { applyTopOfSearch } = await import('../services/advertising/ads-top-of-search.service.js')
    const fam = await resolveProductFamily({ parentProductId: plan.productId, marketplace: plan.marketplace })
    const exApply = new Set<string>(Array.isArray(plan.excludeCampaignIds) ? (plan.excludeCampaignIds as string[]) : [])
    const scoped = fam.campaigns.filter((c) => !exApply.has(c.id))
    let applied = 0
    for (const c of scoped) { try { await applyTopOfSearch(c.id, clamped); applied++ } catch { /* best-effort */ } }
    return { ok: true, applied, pct: clamped, campaigns: scoped.length }
  })

  // ── RG.4 — copy one schedule (windows + baseline) onto many products' plans ──
  // Paint a rank schedule once, then bulk-apply it across other products in the same
  // market. Upserts each target product's ProductRankPlan: sets windows + baseline,
  // leaves guardrails + enabled untouched on existing plans (new plans land DISABLED
  // so each is armed deliberately). The cron resolves each family live, so the same
  // time-of-day rank shape fans across many products without per-window hand-editing.
  fastify.post('/advertising/rank-plans/copy-schedule', async (request, reply) => {
    const b = (request.body ?? {}) as { windows?: unknown; defaultTargetKey?: string | null; toProductIds?: string[]; marketplace?: string; fromPlanId?: string }
    let windows = Array.isArray(b.windows) ? (b.windows as unknown[]) : undefined
    let baseline = (b.defaultTargetKey ?? null) as string | null
    const marketplace = b.marketplace
    const toProductIds = Array.isArray(b.toProductIds) ? [...new Set(b.toProductIds.filter(Boolean))] : []
    // Source can be inline (windows/baseline from the painter) or pulled from a plan.
    if (!windows && b.fromPlanId) {
      const src = await prisma.productRankPlan.findUnique({ where: { id: b.fromPlanId } })
      if (src) { windows = (src.windows as unknown[]) ?? []; baseline = src.defaultTargetKey ?? baseline }
    }
    if (!marketplace || !toProductIds.length || !Array.isArray(windows)) { reply.status(400); return { error: 'marketplace, toProductIds[], windows required' } }
    const prods = await prisma.product.findMany({ where: { id: { in: toProductIds } }, select: { id: true, amazonAsin: true } })
    const asinOf = new Map(prods.map((p) => [p.id, p.amazonAsin]))
    const results: { productId: string; planId: string; created: boolean }[] = []
    for (const productId of toProductIds) {
      const existing = await prisma.productRankPlan.findUnique({ where: { productId_marketplace: { productId, marketplace } } }).catch(() => null)
      const plan = await prisma.productRankPlan.upsert({
        where: { productId_marketplace: { productId, marketplace } },
        create: { productId, marketplace, parentAsin: asinOf.get(productId) ?? null, windows: windows as never, defaultTargetKey: baseline, enabled: false },
        update: { windows: windows as never, defaultTargetKey: baseline },
      })
      results.push({ productId, planId: plan.id, created: !existing })
    }
    return { ok: true, applied: results.length, created: results.filter((r) => r.created).length, updated: results.filter((r) => !r.created).length, results }
  })

  // RS.4 — preview the pure rank controller's next move for a given target +
  // observed signals (no writes). Lets the cockpit show "what would the defend
  // loop do right now", and is how RS.4 is verified end-to-end.
  fastify.post('/advertising/rank-controller/simulate', async (request, reply) => {
    const b = request.body as { target?: unknown; observed?: unknown; maxPct?: number }
    if (!b?.target || !b?.observed) { reply.status(400); return { error: 'target + observed required' } }
    const { computeStep } = await import('../services/advertising/rank-controller.js')
    try { return { decision: computeStep(b.target as never, b.observed as never, { maxPct: b.maxPct }) } } catch (e) { reply.status(400); return { error: (e as Error)?.message } }
  })

  // RS.5 — run the rank-defend loop once across every enabled goal-mode schedule.
  // ?dryRun=1 (or body {dryRun:true}) previews decisions with NO writes; otherwise
  // it applies (honouring the live-write gate — sandbox writes stay local).
  fastify.post('/advertising/rank-defend/run-now', async (request, reply) => {
    const body = (request.body ?? {}) as { dryRun?: boolean }
    const dryRun = body.dryRun === true || (request.query as { dryRun?: string })?.dryRun === '1'
    const { runRankDefendOnce } = await import('../jobs/ad-rank-defend.job.js')
    try { return await runRankDefendOnce({ dryRun }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // WC — one-time re-sync: force-push the CURRENT local bids to Amazon for rank-governed
  // campaigns, healing stale Amazon state left by the old daily-write cap. forceResync makes
  // the push fire even when the patch equals the local value (Amazon was the stale side).
  // Defaults to every campaign under an enabled goal-mode schedule; pass {campaignIds:[...]} to scope.
  fastify.post('/advertising/rank-defend/resync-bids', async (request, reply) => {
    const { updateAdGroupWithSync, updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')
    const { isGoalMode } = await import('../jobs/ad-rank-defend.job.js')
    const body = (request.body ?? {}) as { campaignIds?: string[] }
    let campaignIds = body.campaignIds
    if (!campaignIds?.length) {
      const scheds = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true, windows: true, defaultTargetKey: true } })
      campaignIds = [...new Set(scheds.filter((s) => isGoalMode(s.windows, s.defaultTargetKey)).map((s) => s.campaignId))]
    }
    const actor = 'automation:resync-bids' as const
    let groups = 0, targets = 0, skipped = 0
    try {
      for (const cid of campaignIds) {
        const ags = await prisma.adGroup.findMany({ where: { campaignId: cid }, select: { id: true, defaultBidCents: true } })
        for (const g of ags) {
          if (g.defaultBidCents == null) { skipped++; continue }
          const r = await updateAdGroupWithSync({ adGroupId: g.id, patch: { defaultBidCents: g.defaultBidCents }, actor, reason: 'resync stale Amazon bid (WC)', applyImmediately: true, force: true, forceResync: true })
          if (r.ok && r.error !== 'no_changes') groups++; else skipped++
        }
        const tgs = await prisma.adTarget.findMany({ where: { adGroup: { campaignId: cid }, isNegative: false }, select: { id: true, bidCents: true } })
        for (const t of tgs) {
          if (t.bidCents == null) { skipped++; continue }
          const r = await updateAdTargetWithSync({ adTargetId: t.id, patch: { bidCents: t.bidCents }, actor, reason: 'resync stale Amazon bid (WC)', applyImmediately: true, force: true, forceResync: true })
          if (r.ok && r.error !== 'no_changes') targets++; else skipped++
        }
      }
    } catch (e) { reply.status(500); return { error: (e as Error)?.message, groups, targets, skipped } }
    return { campaigns: campaignIds.length, groups, targets, skipped }
  })

  // AR — manual trigger / preview for the auto-reconcile sweep (the same sweep the
  // rank cron rides every tick). Re-pushes the CURRENT local bid/placement for any
  // entity whose LAST live write to Amazon failed transiently. dryRun=1 lists what
  // WOULD be re-pushed without writing.
  fastify.post('/advertising/rank-defend/reconcile', async (request, reply) => {
    const { reconcileFailedAmazonWrites } = await import('../services/advertising/ads-write-reconcile.service.js')
    const q = request.query as Record<string, string | undefined>
    const body = (request.body ?? {}) as { dryRun?: boolean; limit?: number }
    const dryRun = q.dryRun === '1' || q.dryRun === 'true' || body.dryRun === true
    const limit = body.limit ?? (q.limit ? Number(q.limit) : undefined)
    try { return await reconcileFailedAmazonWrites({ dryRun, limit }) }
    catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  fastify.post('/advertising/dayparting/run-now', async (_request, reply) => {
    const { runDaypartingOnce } = await import('../jobs/ad-dayparting.job.js')
    try { return await runDaypartingOnce() } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })
  // ── AX2.11: Dayparting intelligence (day-of-week conversion) ────────
  fastify.get('/advertising/dayparting-intel', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { analyzeDayparting } = await import('../services/advertising/ads-dayparting-intel.service.js')
    reply.header('Cache-Control', 'private, max-age=300')
    return analyzeDayparting({ windowDays: q.windowDays ? Number(q.windowDays) : undefined, campaignId: q.campaignId })
  })

  // ── AX.8: Target-ACOS bid optimization ──────────────────────────────
  fastify.get('/advertising/bid-optimizer/preview', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { previewBidOptimization } = await import('../services/advertising/ads-bid-optimizer.service.js')
    reply.header('Cache-Control', 'private, max-age=30')
    return previewBidOptimization({
      targetAcos: q.targetAcos ? Number(q.targetAcos) : undefined,
      campaignId: q.campaignId,
      // Apex C.2/C.3 — opt into profit-derived target ACOS and/or Bayesian sparse-data handling.
      profitMode: q.profitMode === '1' || q.profitMode === 'true',
      bayesian: q.bayesian === '1' || q.bayesian === 'true',
      mode: q.mode === 'profit' || q.mode === 'balanced' || q.mode === 'growth' ? q.mode : undefined,
    })
  })
  fastify.post('/advertising/bid-optimizer/apply', async (request, reply) => {
    const { applyBidOptimization } = await import('../services/advertising/ads-bid-optimizer.service.js')
    try { return await applyBidOptimization((request.body ?? { changes: [] }) as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AX.7: Negative + keyword harvesting ─────────────────────────────
  fastify.get('/advertising/harvest/preview', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const { previewHarvest } = await import('../services/advertising/ads-harvest.service.js')
    reply.header('Cache-Control', 'private, max-age=30')
    return previewHarvest({ windowDays: q.windowDays ? Number(q.windowDays) : undefined, minSpendCents: q.minSpendCents ? Number(q.minSpendCents) : undefined, minOrders: q.minOrders ? Number(q.minOrders) : undefined })
  })
  fastify.post('/advertising/harvest/apply', async (request, reply) => {
    const { applyHarvest } = await import('../services/advertising/ads-harvest.service.js')
    try { return await applyHarvest((request.body ?? {}) as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
  })

  // ── AD.2: Mutation routes ───────────────────────────────────────────
  // Every write goes through ads-mutation.service which (1) updates the
  // local row immediately, (2) enqueues OutboundSyncQueue with a 5-min
  // holdUntil grace, (3) writes CampaignBidHistory, (4) adds a BullMQ
  // job. Operators can undo within the grace window via DELETE on the
  // returned outboundQueueId.

  // SP portfolios for the Campaign-Details picker. Live list from Amazon (GET /v2/portfolios),
  // merged across active connections (optionally ?marketplace=), deduped by id. Sandbox →
  // fixture. Failures per-connection are logged and skipped so one bad profile can't 500.
  fastify.get('/advertising/portfolios', async (request, reply) => {
    const q = request.query as { marketplace?: string }
    const mk = q.marketplace && q.marketplace !== 'all' ? q.marketplace : null
    try {
      const seen = new Set<string>()
      const out: Array<{ portfolioId: string; name: string; state?: string; marketplace: string }> = []
      if (adsMode() === 'sandbox') {
        const list = await listPortfolios({ profileId: 'SANDBOX-PROFILE-IT-001', region: 'EU' })
        for (const pf of list) { seen.add(pf.portfolioId); out.push({ ...pf, marketplace: mk ?? 'IT' }) }
      } else {
        const conns = await prisma.amazonAdsConnection.findMany({
          where: { isActive: true, ...(mk ? { marketplace: mk } : {}) },
          select: { profileId: true, region: true, marketplace: true },
        })
        for (const c of conns) {
          const region = (c.region === 'NA' || c.region === 'FE' ? c.region : 'EU') as AdsRegion
          try {
            const list = await listPortfolios({ profileId: c.profileId, region })
            for (const pf of list) { if (seen.has(pf.portfolioId)) continue; seen.add(pf.portfolioId); out.push({ ...pf, marketplace: c.marketplace }) }
          } catch (e) {
            logger.warn('[ADS-PORTFOLIOS] fetch failed', { profileId: c.profileId, error: (e as Error)?.message })
          }
        }
      }
      // PA — include locally-created portfolios (gated; not yet on Amazon's live list).
      try {
        const local = await prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true } })
        for (const lp of local) { if (!seen.has(lp.externalPortfolioId)) { seen.add(lp.externalPortfolioId); out.push({ portfolioId: lp.externalPortfolioId, name: lp.name, marketplace: mk ?? 'IT' }) } }
      } catch { /* local merge best-effort */ }
      return { portfolios: out }
    } catch (e) {
      reply.status(500)
      return { error: (e as Error)?.message ?? 'portfolios fetch failed', portfolios: [] }
    }
  })

  // PA.2 — create a portfolio (gated-local: stored as an AmazonAdsPortfolio row; pushed to
  // Amazon only when the write gate is open). Returns the new portfolio for the picker.
  fastify.post('/advertising/portfolios', async (request, reply) => {
    const body = request.body as { name?: string; marketplace?: string }
    const name = (body.name ?? '').trim()
    if (!name) { reply.status(400); return { error: 'name required' } }
    const marketplace = body.marketplace || 'IT'
    let externalId: string | null = null, mode = 'local', profileId = `local-${marketplace}`
    try {
      const conn = await prisma.amazonAdsConnection.findFirst({ where: { marketplace, isActive: true }, select: { profileId: true, region: true } })
      if (conn) {
        profileId = conn.profileId
        const region = (conn.region === 'NA' || conn.region === 'FE' ? conn.region : 'EU') as AdsRegion
        const { checkAdsWriteGate } = await import('../services/advertising/ads-write-gate.js')
        const gate = await checkAdsWriteGate({ marketplace, payloadValueCents: 0 })
        if (gate.allowed) { const r = await createPortfolio({ profileId, region }, { name, state: 'enabled' }); externalId = r.externalId; mode = r.mode }
      }
      if (!externalId) externalId = `local-pf-${profileId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`
      const pf = await prisma.amazonAdsPortfolio.upsert({
        where: { profileId_externalPortfolioId: { profileId, externalPortfolioId: externalId } },
        update: { name }, create: { profileId, externalPortfolioId: externalId, name, state: 'ENABLED' },
      })
      logger.warn('[ADS-PORTFOLIOS] created portfolio', { externalId, name, mode })
      return { ok: true, portfolio: { portfolioId: pf.externalPortfolioId, name: pf.name }, mode }
    } catch (e) { reply.status(500); return { error: (e as Error)?.message ?? 'create failed' } }
  })

  fastify.patch('/advertising/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      name?: string
      portfolioId?: string | null
      dailyBudget?: number
      dailyBudgetCurrency?: string
      status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
      endDate?: string | null
      reason?: string
      applyImmediately?: boolean
    }
    const patch: Parameters<typeof updateCampaignWithSync>[0]['patch'] = {}
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (body.portfolioId !== undefined) patch.portfolioId = body.portfolioId
    if (body.dailyBudget != null) patch.dailyBudget = body.dailyBudget
    if (body.dailyBudgetCurrency) patch.dailyBudgetCurrency = body.dailyBudgetCurrency
    if (body.status) patch.status = body.status
    if (body.biddingStrategy) patch.biddingStrategy = body.biddingStrategy
    if (body.endDate !== undefined) {
      patch.endDate = body.endDate ? new Date(body.endDate) : null
    }
    const result = await updateCampaignWithSync({
      campaignId: id,
      patch,
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
      reason: body.reason ?? null,
      applyImmediately: body.applyImmediately ?? false,
    })
    if (!result.ok && result.error === 'not_found') {
      reply.code(404)
      return result
    }
    return result
  })

  fastify.patch('/advertising/ad-groups/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      name?: string
      defaultBidCents?: number
      status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      reason?: string
      applyImmediately?: boolean
    }
    // CBN.3 G4 — Edit Groups inline rename. Name has no Amazon-sync path here, so it's a
    // local rename; status/defaultBid still flow through the audited updateAdGroupWithSync.
    if (typeof body.name === 'string' && body.name.trim()) {
      const existing = await prisma.adGroup.findUnique({ where: { id }, select: { id: true } })
      if (!existing) { reply.code(404); return { ok: false, error: 'not_found' } }
      await prisma.adGroup.update({ where: { id }, data: { name: body.name.trim() } })
    }
    // No bid/status change → nothing for the sync service to do (name-only edit returns ok).
    if (body.defaultBidCents == null && body.status == null) {
      return { ok: true, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: null }
    }
    const result = await updateAdGroupWithSync({
      adGroupId: id,
      patch: {
        defaultBidCents: body.defaultBidCents,
        status: body.status,
      },
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
      reason: body.reason ?? null,
      applyImmediately: body.applyImmediately ?? false,
    })
    if (!result.ok && result.error === 'not_found') {
      reply.code(404)
      return result
    }
    if (!result.ok && result.error === 'bid_below_floor_5_cents') {
      reply.code(400)
      return result
    }
    return result
  })

  // CPC-ceiling enforcement (route layer, before the audited mutation service).
  // For each requested bid, if the target's campaign has cpcCeiling enabled and
  // the target has historical clicks, clamp the bid to `multiple × its CPC`
  // (never below the 5-cent floor). Targets with no click history have no basis
  // → left unclamped. Returns the effective entries + a clamp log. One findMany.
  const clampBidsByCeiling = async (
    entries: Array<{ adTargetId: string; bidCents: number }>,
  ): Promise<{ entries: Array<{ adTargetId: string; bidCents: number }>; clamps: Array<{ adTargetId: string; from: number; to: number; ceilingCents: number }> }> => {
    const ids = entries.map((e) => e.adTargetId)
    const targets = await prisma.adTarget.findMany({
      where: { id: { in: ids } },
      select: { id: true, clicks: true, spendCents: true, adGroup: { select: { campaign: { select: { dynamicBidding: true } } } } },
    })
    const byId = new Map(targets.map((t) => [t.id, t]))
    const clamps: Array<{ adTargetId: string; from: number; to: number; ceilingCents: number }> = []
    const out = entries.map((e) => {
      const t = byId.get(e.adTargetId)
      const db = (t?.adGroup?.campaign?.dynamicBidding ?? {}) as { cpcCeiling?: { enabled?: boolean; multiple?: number } }
      const ceil = db.cpcCeiling
      if (!t || !ceil?.enabled || !t.clicks || t.clicks <= 0) return e
      const avgCpc = t.spendCents / t.clicks
      const ceilingCents = Math.max(5, Math.round((ceil.multiple ?? 1.5) * avgCpc))
      if (e.bidCents > ceilingCents) {
        clamps.push({ adTargetId: e.adTargetId, from: e.bidCents, to: ceilingCents, ceilingCents })
        return { ...e, bidCents: ceilingCents }
      }
      return e
    })
    return { entries: out, clamps }
  }

  fastify.patch('/advertising/ad-targets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      bidCents?: number
      status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      reason?: string
      applyImmediately?: boolean
    }
    // CPC ceiling: clamp the requested bid before the audited write.
    let cpcClamp: { from: number; to: number; ceilingCents: number } | null = null
    if (body.bidCents != null) {
      const { entries, clamps } = await clampBidsByCeiling([{ adTargetId: id, bidCents: body.bidCents }])
      body.bidCents = entries[0]!.bidCents
      if (clamps[0]) cpcClamp = { from: clamps[0].from, to: clamps[0].to, ceilingCents: clamps[0].ceilingCents }
    }
    const result = await updateAdTargetWithSync({
      adTargetId: id,
      patch: { bidCents: body.bidCents, status: body.status },
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
      reason: body.reason ?? null,
      applyImmediately: body.applyImmediately ?? false,
    })
    if (!result.ok && result.error === 'not_found') {
      reply.code(404)
      return result
    }
    if (!result.ok && result.error === 'bid_below_floor_5_cents') {
      reply.code(400)
      return result
    }
    return cpcClamp ? { ...result, cpcClamp } : result
  })

  fastify.post('/advertising/ad-targets/bulk-bid', async (request, reply) => {
    const body = request.body as {
      entries: Array<{ adTargetId: string; bidCents: number }>
      reason?: string
      applyImmediately?: boolean
    }
    if (!Array.isArray(body?.entries) || body.entries.length === 0) {
      reply.code(400)
      return { ok: false, error: 'entries_required' }
    }
    // Hard cap at 10k entries per request — beyond that, operator should
    // upload via the bulk-action workflow.
    if (body.entries.length > 10_000) {
      reply.code(400)
      return { ok: false, error: 'too_many_entries' }
    }
    // CPC ceiling: clamp each requested bid before the audited bulk write.
    const { entries: clampedEntries, clamps } = await clampBidsByCeiling(body.entries)
    const result = await bulkUpdateAdTargetBids({
      entries: clampedEntries,
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
      reason: body.reason ?? null,
      applyImmediately: body.applyImmediately ?? false,
    })
    return { ok: true, ...result, cpcClamps: clamps }
  })

  // AF.5 — product ad enable/pause toggle.
  fastify.patch('/advertising/product-ads/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as { status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; reason?: string; applyImmediately?: boolean }
    if (!body.status) { reply.code(400); return { ok: false, error: 'status_required' } }
    const result = await updateProductAdWithSync({
      productAdId: id,
      status: body.status,
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
      reason: body.reason ?? null,
      applyImmediately: body.applyImmediately ?? false,
    })
    if (!result.ok && result.error === 'not_found') { reply.code(404); return result }
    return result
  })

  fastify.delete('/advertising/mutations/:outboundQueueId', async (request, reply) => {
    const { outboundQueueId } = request.params as { outboundQueueId: string }
    const result = await cancelPendingMutation(outboundQueueId)
    if (!result.ok) {
      reply.code(result.error === 'not_found' ? 404 : 409)
    }
    return result
  })

  // ── AD.2: bid history feed ──────────────────────────────────────────
  fastify.get('/advertising/bid-history', async (request, reply) => {
    const q = request.query as {
      entityId?: string
      entityType?: 'CAMPAIGN' | 'AD_GROUP' | 'AD_TARGET'
      campaignId?: string
      limit?: string
    }
    const where: Record<string, unknown> = {}
    if (q.entityId) where.entityId = q.entityId
    if (q.entityType) where.entityType = q.entityType
    if (q.campaignId) where.campaignId = q.campaignId
    const limit = Math.min(Number(q.limit) || 100, 500)
    const items = await prisma.campaignBidHistory.findMany({
      where,
      orderBy: { changedAt: 'desc' },
      take: limit,
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { items, count: items.length }
  })

  // ── AD.2: True ROAS by campaign ────────────────────────────────────
  // Joins ProductProfitDaily → AdProductAd → AdGroup → Campaign so the
  // "True Profit per campaign" lens has numbers even when the per-campaign
  // attribution is approximate (sum of profit on all products advertised).
  fastify.get('/advertising/profit/by-campaign', async (request, reply) => {
    const q = request.query as { marketplace?: string; dateFrom?: string; dateTo?: string }
    const dateFilter: Record<string, Date> = {}
    if (q.dateFrom) dateFilter.gte = new Date(q.dateFrom)
    if (q.dateTo) dateFilter.lte = new Date(q.dateTo)

    // 1. Read campaigns with their advertised productIds.
    const campaigns = await prisma.campaign.findMany({
      where: q.marketplace ? { marketplace: q.marketplace } : {},
      select: {
        id: true,
        name: true,
        marketplace: true,
        spend: true,
        sales: true,
        acos: true,
        roas: true,
        adGroups: {
          select: {
            productAds: { select: { productId: true } },
          },
        },
      },
    })

    // 2. For each campaign, sum trueProfit over its products.
    const items: Array<{
      campaignId: string
      name: string
      marketplace: string | null
      adSpendEur: number
      adSalesEur: number
      acos: number | null
      roas: number | null
      trueProfitCents: number
      trueProfitMarginPct: number | null
      productCount: number
    }> = []
    for (const c of campaigns) {
      const productIds = Array.from(
        new Set(
          c.adGroups
            .flatMap((ag) => ag.productAds)
            .map((pa) => pa.productId)
            .filter((id): id is string => !!id),
        ),
      )
      if (productIds.length === 0) {
        items.push({
          campaignId: c.id,
          name: c.name,
          marketplace: c.marketplace,
          adSpendEur: Number(c.spend),
          adSalesEur: Number(c.sales),
          acos: c.acos != null ? Number(c.acos) : null,
          roas: c.roas != null ? Number(c.roas) : null,
          trueProfitCents: 0,
          trueProfitMarginPct: null,
          productCount: 0,
        })
        continue
      }
      const profitWhere: Record<string, unknown> = { productId: { in: productIds } }
      if (c.marketplace) profitWhere.marketplace = c.marketplace
      if (Object.keys(dateFilter).length > 0) profitWhere.date = dateFilter
      const profit = await prisma.productProfitDaily.aggregate({
        where: profitWhere,
        _sum: { trueProfitCents: true, grossRevenueCents: true },
      })
      const tp = profit._sum.trueProfitCents ?? 0
      const gr = profit._sum.grossRevenueCents ?? 0
      items.push({
        campaignId: c.id,
        name: c.name,
        marketplace: c.marketplace,
        adSpendEur: Number(c.spend),
        adSalesEur: Number(c.sales),
        acos: c.acos != null ? Number(c.acos) : null,
        roas: c.roas != null ? Number(c.roas) : null,
        trueProfitCents: tp,
        trueProfitMarginPct: gr > 0 ? tp / gr : null,
        productCount: productIds.length,
      })
    }
    reply.header('Cache-Control', 'private, max-age=120')
    return { items, count: items.length }
  })

  // ── AD.4: enable-writes (two-step) ──────────────────────────────────
  // Step 1: caller hits /preview-writes with the profileId they intend
  // to enable. We return a confirmation token + a payload describing
  // the irreversible-side-effects of flipping the connection live.
  // Step 2: caller hits /enable-writes with the token to commit the flip.

  fastify.post('/advertising/connection/preview-writes', async (request, reply) => {
    const body = request.body as { profileId?: string }
    if (!body?.profileId) {
      reply.code(400)
      return { error: 'profileId required' }
    }
    const conn = await prisma.amazonAdsConnection.findUnique({
      where: { profileId: body.profileId },
      select: {
        profileId: true,
        marketplace: true,
        mode: true,
        writesEnabledAt: true,
        accountLabel: true,
        isActive: true,
      },
    })
    if (!conn) {
      reply.code(404)
      return { error: 'connection_not_found' }
    }
    if (conn.writesEnabledAt != null) {
      reply.code(409)
      return { error: 'already_enabled', writesEnabledAt: conn.writesEnabledAt }
    }
    if (conn.mode !== 'production') {
      reply.code(409)
      return { error: 'connection_mode_not_production', mode: conn.mode }
    }
    gcEnableWriteTokens()
    const token = randomBytes(24).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    ENABLE_WRITES_TOKENS.set(tokenHash, {
      profileId: conn.profileId,
      expiresAt: Date.now() + 60 * 1000,
    })
    return {
      ok: true,
      confirmationToken: token,
      expiresInSeconds: 60,
      preview: {
        profileId: conn.profileId,
        marketplace: conn.marketplace,
        accountLabel: conn.accountLabel,
        mode: conn.mode,
        consequencesIfEnabled: [
          'Bid/budget/status PATCHes will hit Amazon Ads API (after the 5-min holdUntil grace).',
          'The liquidate_aged_stock composite action will create RetailEvents + pause/boost campaigns for real.',
          `Per-write blast radius capped at €${(Number(process.env.NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS ?? 50000) / 100).toFixed(0)} via NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS.`,
          'Operator-initiated rollback available within 24h of each action.',
        ],
      },
    }
  })

  fastify.post('/advertising/connection/enable-writes', async (request, reply) => {
    const body = request.body as { confirmationToken?: string }
    if (!body?.confirmationToken) {
      reply.code(400)
      return { error: 'confirmationToken required' }
    }
    gcEnableWriteTokens()
    const tokenHash = createHash('sha256').update(body.confirmationToken).digest('hex')
    const stored = ENABLE_WRITES_TOKENS.get(tokenHash)
    if (!stored) {
      reply.code(400)
      return { error: 'invalid_or_expired_token' }
    }
    ENABLE_WRITES_TOKENS.delete(tokenHash)
    const conn = await prisma.amazonAdsConnection.update({
      where: { profileId: stored.profileId },
      data: { writesEnabledAt: new Date() },
      select: { profileId: true, marketplace: true, writesEnabledAt: true, mode: true },
    })
    return { ok: true, connection: conn }
  })

  fastify.post('/advertising/connection/disable-writes', async (request, reply) => {
    const body = request.body as { profileId?: string }
    if (!body?.profileId) {
      reply.code(400)
      return { error: 'profileId required' }
    }
    const conn = await prisma.amazonAdsConnection.update({
      where: { profileId: body.profileId },
      data: { writesEnabledAt: null },
      select: { profileId: true, writesEnabledAt: true },
    })
    return { ok: true, connection: conn }
  })

  // ── Apex A.2b: set a connection's mode (sandbox ↔ production) ───────────
  // Connections are created mode=sandbox; this is the only way to promote one
  // to production, which is a *precondition* for enable-writes (it does NOT by
  // itself enable any live write — writesEnabledAt stays null and the per-
  // campaign allowlist still applies). Switching back to sandbox also clears
  // writesEnabledAt so the gate hard-closes immediately.
  fastify.post('/advertising/connection/set-mode', async (request, reply) => {
    const body = request.body as { profileId?: string; mode?: string }
    if (!body?.profileId || (body.mode !== 'sandbox' && body.mode !== 'production')) {
      reply.code(400)
      return { error: 'profileId + mode (sandbox|production) required' }
    }
    const existing = await prisma.amazonAdsConnection.findUnique({
      where: { profileId: body.profileId },
      select: { profileId: true, marketplace: true, accountLabel: true, mode: true },
    })
    if (!existing) { reply.code(404); return { error: 'connection_not_found' } }
    const conn = await prisma.amazonAdsConnection.update({
      where: { profileId: body.profileId },
      data: {
        mode: body.mode,
        // Demoting to sandbox revokes any standing write enablement.
        ...(body.mode === 'sandbox' ? { writesEnabledAt: null } : {}),
      },
      select: { profileId: true, marketplace: true, mode: true, writesEnabledAt: true },
    })
    logger.warn('[ADS-CONNECTION-SET-MODE]', {
      profileId: conn.profileId,
      marketplace: conn.marketplace,
      from: existing.mode,
      to: conn.mode,
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
    })
    return { ok: true, connection: conn }
  })

  fastify.get('/advertising/connections', async (_request, reply) => {
    const items = await prisma.amazonAdsConnection.findMany({
      orderBy: [{ marketplace: 'asc' }],
      select: {
        id: true,
        profileId: true,
        marketplace: true,
        region: true,
        accountLabel: true,
        mode: true,
        writesEnabledAt: true,
        lastWriteAt: true,
        isActive: true,
        lastVerifiedAt: true,
        lastErrorAt: true,
        lastError: true,
      },
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { items, count: items.length, adsMode: adsMode() }
  })

  // ── POST /advertising/connections — create or update credentials ─────
  fastify.post('/advertising/connections', async (request, reply) => {
    const {
      profileId, marketplace, region, accountLabel,
      clientId, clientSecret, refreshToken,
    } = request.body as {
      profileId: string; marketplace: string; region?: string; accountLabel?: string
      clientId: string; clientSecret: string; refreshToken: string
    }
    if (!profileId || !clientId || !clientSecret || !refreshToken || !marketplace) {
      return reply.code(400).send({ error: 'missing_required_fields' })
    }
    const { encryptSecret } = await import('../lib/crypto.js')
    const credentialsEncrypted = encryptSecret(
      JSON.stringify({ clientId, clientSecret, refreshToken }),
    )
    const conn = await prisma.amazonAdsConnection.upsert({
      where: { profileId },
      create: {
        profileId,
        marketplace,
        region: region ?? 'EU',
        accountLabel: accountLabel ?? null,
        credentialsEncrypted,
        mode: 'sandbox',
        isActive: true,
      },
      update: {
        marketplace,
        region: region ?? 'EU',
        accountLabel: accountLabel ?? null,
        credentialsEncrypted,
        updatedAt: new Date(),
      },
      select: { id: true, profileId: true, marketplace: true, mode: true, isActive: true },
    })
    return { ok: true, connection: conn }
  })

  // ── DELETE /advertising/connections/:profileId ───────────────────────
  fastify.delete('/advertising/connections/:profileId', async (request, reply) => {
    const { profileId } = request.params as { profileId: string }
    try {
      await prisma.amazonAdsConnection.delete({ where: { profileId } })
      return { ok: true }
    } catch {
      return reply.code(404).send({ error: 'not_found' })
    }
  })

  // ── AD.4: rollback ──────────────────────────────────────────────────

  fastify.post('/advertising/actions/:executionId/rollback', async (request, reply) => {
    const { executionId } = request.params as { executionId: string }
    const body = request.body as { reason?: string }
    const exec = await prisma.automationRuleExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        startedAt: true,
        rule: { select: { id: true, domain: true } },
      },
    })
    if (!exec || exec.rule?.domain !== 'advertising') {
      reply.code(404)
      return { error: 'execution_not_found_or_wrong_domain' }
    }
    if (exec.startedAt.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      reply.code(409)
      return { error: 'rollback_window_expired' }
    }
    const actor = actorFromHeaders(request.headers as Record<string, unknown>)
    const result = await rollbackByExecutionId({
      executionId,
      actor,
      reason: body?.reason ?? `manual rollback of execution ${executionId}`,
    })
    return result
  })

  // ── AD.5: BudgetPool routes ─────────────────────────────────────────

  fastify.get('/advertising/budget-pools', async (_request, reply) => {
    const items = await prisma.budgetPool.findMany({
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
      include: {
        allocations: {
          select: {
            id: true,
            marketplace: true,
            campaignId: true,
            targetSharePct: true,
            minDailyBudgetCents: true,
            maxDailyBudgetCents: true,
          },
        },
        _count: { select: { allocations: true, rebalances: true } },
      },
    })
    reply.header('Cache-Control', 'private, max-age=30')
    return { items, count: items.length }
  })

  fastify.get('/advertising/budget-pools/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const pool = await prisma.budgetPool.findUnique({
      where: { id },
      include: {
        allocations: {
          orderBy: [{ marketplace: 'asc' }],
        },
        rebalances: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    })
    if (!pool) {
      reply.code(404)
      return { error: 'not_found' }
    }
    // Hydrate per-allocation current campaign budget so the visualizer
    // can render "current vs target" without a second round-trip.
    const campaignIds = pool.allocations
      .map((a) => a.campaignId)
      .filter((id): id is string => !!id)
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: { id: true, name: true, dailyBudget: true, status: true, marketplace: true },
    })
    return { pool, campaigns }
  })

  fastify.post('/advertising/budget-pools', async (request, reply) => {
    const body = request.body as {
      name: string
      description?: string
      currency?: string
      totalDailyBudgetCents: number
      strategy?: 'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'
      coolDownMinutes?: number
      maxShiftPerRebalancePct?: number
    }
    if (!body?.name || !body.totalDailyBudgetCents) {
      reply.code(400)
      return { error: 'name + totalDailyBudgetCents required' }
    }
    const pool = await prisma.budgetPool.create({
      data: {
        name: body.name,
        description: body.description ?? null,
        currency: body.currency ?? 'EUR',
        totalDailyBudgetCents: body.totalDailyBudgetCents,
        strategy: body.strategy ?? 'STATIC',
        coolDownMinutes: body.coolDownMinutes ?? 60,
        maxShiftPerRebalancePct: body.maxShiftPerRebalancePct ?? 20,
        enabled: false,
        dryRun: true,
        createdBy: 'user',
      },
    })
    return { pool }
  })

  fastify.patch('/advertising/budget-pools/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      name?: string
      description?: string | null
      totalDailyBudgetCents?: number
      strategy?: 'STATIC' | 'PROFIT_WEIGHTED' | 'URGENCY_WEIGHTED'
      coolDownMinutes?: number
      maxShiftPerRebalancePct?: number
      enabled?: boolean
      dryRun?: boolean
    }
    const existing = await prisma.budgetPool.findUnique({ where: { id } })
    if (!existing) {
      reply.code(404)
      return { error: 'not_found' }
    }
    const pool = await prisma.budgetPool.update({
      where: { id },
      data: body as Record<string, unknown>,
    })
    return { pool }
  })

  fastify.delete('/advertising/budget-pools/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const existing = await prisma.budgetPool.findUnique({ where: { id } })
    if (!existing) {
      reply.code(404)
      return { error: 'not_found' }
    }
    await prisma.budgetPool.delete({ where: { id } })
    return { ok: true }
  })

  // Allocations CRUD (nested under pool)
  fastify.post('/advertising/budget-pools/:id/allocations', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      campaignId: string
      targetSharePct?: number
      minDailyBudgetCents?: number
      maxDailyBudgetCents?: number
    }
    const campaign = await prisma.campaign.findUnique({
      where: { id: body.campaignId },
      select: { id: true, marketplace: true },
    })
    if (!campaign?.marketplace) {
      reply.code(400)
      return { error: 'campaign_not_found_or_no_marketplace' }
    }
    try {
      const allocation = await prisma.budgetPoolAllocation.create({
        data: {
          budgetPoolId: id,
          marketplace: campaign.marketplace,
          campaignId: campaign.id,
          targetSharePct: body.targetSharePct ?? 0,
          minDailyBudgetCents: body.minDailyBudgetCents ?? 100,
          maxDailyBudgetCents: body.maxDailyBudgetCents ?? null,
        },
      })
      return { allocation }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Unique constraint')) {
        reply.code(409)
        return { error: 'campaign_already_in_a_pool' }
      }
      reply.code(500)
      return { error: msg }
    }
  })

  fastify.delete(
    '/advertising/budget-pools/:id/allocations/:allocationId',
    async (request, reply) => {
      const { id, allocationId } = request.params as { id: string; allocationId: string }
      const existing = await prisma.budgetPoolAllocation.findUnique({
        where: { id: allocationId },
      })
      if (!existing || existing.budgetPoolId !== id) {
        reply.code(404)
        return { error: 'not_found' }
      }
      await prisma.budgetPoolAllocation.delete({ where: { id: allocationId } })
      return { ok: true }
    },
  )

  // Manual rebalance — always shows a dry-run preview first via the
  // ?preview=1 flag; without preview, runs through rebalanceAndAudit
  // honoring pool.dryRun.
  fastify.post('/advertising/budget-pools/:id/rebalance', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { preview?: string }
    const actor = actorFromHeaders(request.headers as Record<string, unknown>)
    if (q.preview === '1') {
      const outcome = await computeRebalance({
        poolId: id,
        triggeredBy: `user:${actor.slice(5)}`,
        ignoreCoolDown: true,
      })
      return { mode: 'preview', outcome }
    }
    const outcome = await rebalanceAndAudit({
      poolId: id,
      triggeredBy: `user:${actor.slice(5)}`,
      ignoreCoolDown: true,
      actor,
    })
    if (outcome.skipped) {
      reply.code(409)
      return { error: 'skipped', reason: outcome.skipped }
    }
    return { mode: 'committed', outcome }
  })

  fastify.get('/advertising/budget-pools/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { limit?: string }
    const limit = Math.min(Number(q.limit) || 50, 200)
    const items = await prisma.budgetPoolRebalance.findMany({
      where: { budgetPoolId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    reply.header('Cache-Control', 'private, max-age=15')
    return { items, count: items.length }
  })

  fastify.get('/advertising/actions/:executionId/log', async (request, reply) => {
    const { executionId } = request.params as { executionId: string }
    const exec = await prisma.automationRuleExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        ruleId: true,
        startedAt: true,
        finishedAt: true,
        rule: { select: { domain: true } },
      },
    })
    if (!exec || exec.rule?.domain !== 'advertising') {
      reply.code(404)
      return { error: 'not_found' }
    }
    const windowStart = new Date(exec.startedAt.getTime() - 1000)
    const windowEnd = new Date((exec.finishedAt ?? new Date()).getTime() + 5 * 60 * 1000)
    const items = await prisma.advertisingActionLog.findMany({
      where: {
        OR: [
          { executionId: exec.id },
          {
            AND: [
              { userId: `automation:${exec.ruleId}` },
              { createdAt: { gte: windowStart, lte: windowEnd } },
            ],
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    })
    reply.header('Cache-Control', 'private, max-age=10')
    return { items, count: items.length, executionStartedAt: exec.startedAt }
  })
}

export default advertisingRoutes
