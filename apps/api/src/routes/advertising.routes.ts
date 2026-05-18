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
import { testConnection, adsMode } from '../services/advertising/ads-api-client.js'
import {
  runAdsSyncOnce,
  summarizeAdsSync,
} from '../services/advertising/ads-sync.service.js'
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

// Best-effort actor resolution. AD.4 wires real auth; for now the
// caller may pass an `x-actor-id` header (operator UI sets it) or
// fall back to a sentinel. Every audit row must be tagged.
function actorFromHeaders(headers: Record<string, unknown>): AdsActor {
  const raw = headers['x-actor-id']
  if (typeof raw === 'string' && raw.length > 0) return `user:${raw}` as AdsActor
  return 'user:anonymous' as AdsActor
}

const advertisingRoutes: FastifyPluginAsync = async (fastify) => {
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

    const campaigns = await prisma.campaign.findMany({
      where,
      orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
      take: limit,
      select: {
        id: true,
        name: true,
        type: true,
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
      },
    })
    reply.header('Cache-Control', 'private, max-age=60')
    return { items: campaigns, count: campaigns.length }
  })

  // ── GET /advertising/campaigns/:id ──────────────────────────────────
  fastify.get('/advertising/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        adGroups: {
          include: {
            targets: { take: 100 },
            productAds: { take: 50 },
          },
        },
      },
    })
    if (!campaign) {
      reply.code(404)
      return { error: 'not_found' }
    }
    return { campaign }
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
  fastify.post('/advertising/reports/ingest-completed', async (_request, _reply) => {
    const jobs = await prisma.amazonAdsReportJob.findMany({
      where: { status: 'COMPLETED', rowsIngested: 0 },
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
    const query = request.query as { windowDays?: string; marketplace?: string }
    const windowDays = query.windowDays
      ? Math.max(1, Math.min(180, Number(query.windowDays)))
      : 7

    const since = new Date()
    since.setUTCDate(since.getUTCDate() - windowDays)
    since.setUTCHours(0, 0, 0, 0)

    const rows = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['entityId', 'adProduct', 'marketplace', 'currencyCode'],
      where: {
        date: { gte: since },
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

    reply.header('Cache-Control', 'private, max-age=30')
    return { windowDays, count: Object.keys(byCampaign).length, byCampaign }
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
      productId?: string; asin?: string; sku?: string; windowDays?: string
    }
    const windowDays = Math.max(7, Math.min(90, Number(query.windowDays ?? 30)))
    if (!query.productId && !query.asin && !query.sku) {
      return reply.code(400).send({ error: 'productId, asin, or sku required' })
    }

    const since = new Date()
    since.setUTCDate(since.getUTCDate() - windowDays)
    since.setUTCHours(0, 0, 0, 0)

    // ── 1. Find all AdProductAd rows for this product ───────────────────
    const productAds = await prisma.adProductAd.findMany({
      where: {
        OR: [
          ...(query.productId ? [{ productId: query.productId }] : []),
          ...(query.asin ? [{ asin: query.asin }] : []),
          ...(query.sku  ? [{ sku:  query.sku  }] : []),
        ],
      },
      select: { id: true, asin: true, sku: true, adGroupId: true },
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
        date: { gte: since },
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
        date: { gte: since },
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

    // ── 5. Summary ──────────────────────────────────────────────────────
    const totalSpend = campaignData.reduce((s, c) => s + c.spendCents, 0)
    const totalSales = campaignData.reduce((s, c) => s + c.adSalesCents, 0)
    const summary = {
      campaignCount: campaigns.length,
      productAdCount: productAds.length,
      totalSpendCents: totalSpend,
      totalAdSalesCents: totalSales,
      acos: totalSales > 0 ? Math.round((totalSpend / totalSales) * 1000) / 10 : null,
      windowDays,
    }

    reply.header('Cache-Control', 'private, max-age=60')
    return { windowDays, productAds: productAds.length, campaigns: campaignData, searchTerms, summary }
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
    }
    const windowDays   = Math.max(7, Math.min(90, Number(query.windowDays   ?? 14)))
    const minSpendEur  = Math.max(0, Number(query.minSpendEur  ?? 1))
    const acosTarget   = Math.max(1, Number(query.acosTarget   ?? 35))
    const lowAcosTarget = Math.max(1, Number(query.lowAcosTarget ?? 8))
    const minMicros    = BigInt(Math.round(minSpendEur * 1_000_000))

    const since = new Date()
    since.setUTCDate(since.getUTCDate() - windowDays)
    since.setUTCHours(0, 0, 0, 0)

    const { findNegativeKeywordCandidates } = await import(
      '../services/advertising/ads-reports.service.js'
    )

    // ── 1. Negative keyword candidates ──────────────────────────────────
    const negKwRaw = await findNegativeKeywordCandidates({
      lookbackDays: windowDays,
      minSpend: minSpendEur,
      limit: 200,
      ...(query.marketplace ? { marketplace: query.marketplace } : {}),
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
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
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
    const activeCampaigns = await prisma.campaign.findMany({
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
    }
    const windowDays = Math.max(7, Math.min(180, Number(query.windowDays ?? 30)))
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - windowDays)
    since.setUTCHours(0, 0, 0, 0)

    // ── Ad performance per day ──────────────────────────────────────────
    const perfByDay = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['date'],
      where: {
        date: { gte: since },
        entityType: 'CAMPAIGN',
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
    const salesByDay = await prisma.dailySalesAggregate.groupBy({
      by: ['day'],
      where: {
        day:     { gte: since },
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

    reply.header('Cache-Control', 'private, max-age=60')
    return { windowDays, count: rows.length, rows }
  })

  //   - per-adProduct live status from the adapter registry
  //   - report job counts by status
  //   - search-term cardinality + negative-keyword-candidate count
  // Designed for the Trading Desk landing page; one round-trip, no FK joins.
  fastify.get('/advertising/overview/v1', async (_request, reply) => {
    const { ADAPTERS } = await import('../services/advertising/adapters/index.js')
    const { findNegativeKeywordCandidates } = await import(
      '../services/advertising/ads-reports.service.js'
    )

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
      adapters: ADAPTERS.map((a) => ({
        adProduct: a.adProduct,
        live: a.live,
        blockerReason: a.liveBlockerReason ?? null,
      })),
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

  // POST /api/advertising/reports/cleanup-search-terms?daysToKeep=90
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

    // Build dynamic having clause based on hasOrders filter
    const having: Record<string, unknown> = {}
    if (minSpend > 0) having.costMicros = { _sum: { gte: minMicros } }
    if (minImpressions > 0) having.impressions = { _sum: { gte: minImpressions } }
    if (query.hasOrders === 'none') {
      having.orders7d = { _sum: { equals: 0 } }
    } else if (query.hasOrders === 'some') {
      having.orders7d = { _sum: { gt: 0 } }
    }

    const sortField = query.sortBy === 'clicks' ? 'clicks'
      : query.sortBy === 'orders' ? 'orders7d'
      : query.sortBy === 'impressions' ? 'impressions'
      : 'costMicros'

    const rows = await prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'matchType', 'campaignId', 'adGroupId', 'marketplace', 'adProduct', 'currencyCode'],
      where: {
        date: { gte: since },
        ...(query.profileId ? { profileId: query.profileId } : {}),
        ...(query.marketplace ? { marketplace: query.marketplace } : {}),
        ...(query.adProduct ? { adProduct: query.adProduct } : {}),
      },
      _sum: {
        impressions: true,
        clicks: true,
        costMicros: true,
        orders7d: true,
        sales7dCents: true,
      },
      having,
      orderBy: { _sum: { [sortField]: 'desc' } },
      take: limit,
    })

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
  fastify.post('/advertising/cron/ads-sync/trigger', async (_request, _reply) => {
    const s = await runAdsSyncOnce()
    return { ok: true, summary: summarizeAdsSync(s), detail: s }
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
  fastify.post('/advertising/cron/advertising-rule-evaluator/trigger', async (_request, _reply) => {
    const summary = await runAdvertisingRuleEvaluatorOnce()
    return { ok: true, summary }
  })

  fastify.get('/advertising/cron/advertising-rule-evaluator/status', async (_request, _reply) => {
    return getAdvertisingRuleEvaluatorStatus()
  })

  // ── AD.2: Mutation routes ───────────────────────────────────────────
  // Every write goes through ads-mutation.service which (1) updates the
  // local row immediately, (2) enqueues OutboundSyncQueue with a 5-min
  // holdUntil grace, (3) writes CampaignBidHistory, (4) adds a BullMQ
  // job. Operators can undo within the grace window via DELETE on the
  // returned outboundQueueId.

  fastify.patch('/advertising/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      dailyBudget?: number
      dailyBudgetCurrency?: string
      status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      biddingStrategy?: 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL'
      endDate?: string | null
      reason?: string
      applyImmediately?: boolean
    }
    const patch: Parameters<typeof updateCampaignWithSync>[0]['patch'] = {}
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
      defaultBidCents?: number
      status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      reason?: string
      applyImmediately?: boolean
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

  fastify.patch('/advertising/ad-targets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      bidCents?: number
      status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'
      reason?: string
      applyImmediately?: boolean
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
    return result
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
    const result = await bulkUpdateAdTargetBids({
      entries: body.entries,
      actor: actorFromHeaders(request.headers as Record<string, unknown>),
      reason: body.reason ?? null,
      applyImmediately: body.applyImmediately ?? false,
    })
    return { ok: true, ...result }
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
