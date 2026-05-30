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
import { logger } from '../utils/logger.js'
import { testConnection, adsMode } from '../services/advertising/ads-api-client.js'
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
        series[r.placement]![i] = Math.round(Number(r._sum.costMicros ?? 0n) / 10_000) // cents
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
        adjustmentPct: adj[r.placement] ?? 0,
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
    const q = request.query as { windowDays?: string; marketplace?: string; search?: string; sort?: string; dir?: string; limit?: string; compare?: string; mode?: string }
    const windowDays = Math.max(7, Math.min(90, Number(q.windowDays ?? 30)))
    const limit = Math.max(1, Math.min(1000, Number(q.limit ?? 300)))
    const since = new Date(); since.setUTCDate(since.getUTCDate() - windowDays); since.setUTCHours(0, 0, 0, 0)
    const mkt = q.marketplace || undefined
    // PC.8 — mode: advertised (default) | opportunity (selling but NOT
    // advertised) | unmatched (handled separately below).
    const mode = q.mode === 'opportunity' ? 'opportunity' : q.mode === 'unmatched' ? 'unmatched' : 'advertised'

    // PC.8 — Unmatched ASINs: PRODUCT_AD rows with no local AdProductAd link.
    if (mode === 'unmatched') {
      const um = await prisma.amazonAdsDailyPerformance.groupBy({
        by: ['entityId'],
        where: { entityType: 'PRODUCT_AD', localEntityId: null, date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
        orderBy: { _sum: { costMicros: 'desc' } },
        take: limit,
      })
      const rows = um.map((r) => {
        const adSpendCents = Math.round(Number(r._sum.costMicros ?? 0n) / 10_000)
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
      const perAd = await prisma.amazonAdsDailyPerformance.groupBy({
        by: ['localEntityId'],
        where: { entityType: 'PRODUCT_AD', localEntityId: { not: null }, date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { costMicros: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true },
      })
      if (perAd.length > 0) {
        const adIds = perAd.map((r) => r.localEntityId).filter((x): x is string => !!x)
        const adProds = await prisma.adProductAd.findMany({ where: { id: { in: adIds } }, select: { id: true, productId: true } })
        const prodByAd = new Map(adProds.map((a) => [a.id, a.productId]))
        for (const r of perAd) {
          const pid = r.localEntityId ? prodByAd.get(r.localEntityId) : null
          if (!pid) continue
          const cur = adByProduct.get(pid) ?? { spendC: 0, salesC: 0, impr: 0, clicks: 0, orders: 0 }
          cur.spendC += Math.round(Number(r._sum.costMicros ?? 0n) / 10_000)
          cur.salesC += r._sum.sales7dCents ?? 0
          cur.impr += r._sum.impressions ?? 0
          cur.clicks += r._sum.clicks ?? 0
          cur.orders += r._sum.orders7d ?? 0
          adByProduct.set(pid, cur)
        }
      }
    }
    const usePA = adByProduct.size > 0

    // The product set: PRODUCT_AD-advertised products (sorted by spend) when
    // available, else derived from the ProductProfitDaily roll-up below.
    let ids: string[]
    let ppdByProduct: Map<string, { _sum: { advertisingSpendCents: number | null; grossRevenueCents: number | null; trueProfitCents: number | null; unitsSold: number | null } }>
    if (usePA) {
      ids = [...adByProduct.entries()].sort((a, b) => b[1].spendC - a[1].spendC).slice(0, limit).map(([pid]) => pid)
      const ppd = await prisma.productProfitDaily.groupBy({
        by: ['productId'],
        where: { productId: { in: ids }, date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true, unitsSold: true },
        orderBy: { _sum: { grossRevenueCents: 'desc' } },
      })
      ppdByProduct = new Map(ppd.map((g) => [g.productId, g]))
    } else {
      const grouped = await prisma.productProfitDaily.groupBy({
        by: ['productId'],
        where: { date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
        _sum: { advertisingSpendCents: true, grossRevenueCents: true, trueProfitCents: true, unitsSold: true },
        having: mode === 'opportunity'
          ? { advertisingSpendCents: { _sum: { equals: 0 } }, grossRevenueCents: { _sum: { gt: 0 } } }
          : { advertisingSpendCents: { _sum: { gt: 0 } } },
        orderBy: mode === 'opportunity' ? { _sum: { grossRevenueCents: 'desc' } } : { _sum: { advertisingSpendCents: 'desc' } },
        take: limit,
      })
      ids = grouped.map((g) => g.productId)
      ppdByProduct = new Map(grouped.map((g) => [g.productId, g]))
    }
    if (ids.length === 0) {
      reply.header('Cache-Control', 'private, max-age=60')
      return { windowDays, mode, rows: [], totals: { adSpendCents: 0, revenueCents: 0, profitCents: 0, products: 0 }, unattributedSpendCents: 0, marketplaces: [] }
    }

    // 2. Product identity + photo (reuse the /products face-image picker).
    const { pickFaceImage, FACE_IMAGE_SELECT, FACE_IMAGE_ORDER_BY } = await import('../services/product-read-cache.service.js')
    const products = await prisma.product.findMany({
      where: {
        id: { in: ids }, deletedAt: null,
        ...(q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { contains: q.search, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, sku: true, name: true, images: { select: FACE_IMAGE_SELECT, orderBy: FACE_IMAGE_ORDER_BY } },
    })
    const prodById = new Map(products.map((p) => [p.id, p]))

    // 3. #campaigns + #markets + asin from the ad structure (one query).
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

    // 4. Build rows (skip products filtered out by search).
    const rows = ids.flatMap((pid) => {
      const p = prodById.get(pid)
      if (!p) return []
      const ad = adByProduct.get(pid)
      const ppd = ppdByProduct.get(pid)
      const adSpendCents = usePA ? (ad?.spendC ?? 0) : (ppd?._sum.advertisingSpendCents ?? 0)
      const adSalesCents = usePA ? (ad?.salesC ?? 0) : 0
      const revenueCents = ppd?._sum.grossRevenueCents ?? 0
      const profitCents = ppd?._sum.trueProfitCents ?? 0
      const st = structByProduct.get(pid)
      const campaignCount = st?.campaigns.size ?? 0
      return [{
        id: pid,
        sku: p.sku,
        name: p.name,
        asin: st?.asin ?? null,
        photoUrl: pickFaceImage(p.images),
        photoCount: p.images.length,
        adSpendCents, revenueCents, profitCents,
        units: ppd?._sum.unitsSold ?? 0,
        acos: usePA && adSalesCents > 0 ? Math.round((adSpendCents / adSalesCents) * 1000) / 10 : null,
        roas: usePA && adSpendCents > 0 ? Math.round((adSalesCents / adSpendCents) * 100) / 100 : null,
        impressions: ad?.impr ?? 0,
        clicks: ad?.clicks ?? 0,
        tacos: revenueCents > 0 ? Math.round((adSpendCents / revenueCents) * 1000) / 10 : null,
        marginPct: revenueCents > 0 ? Math.round((profitCents / revenueCents) * 1000) / 10 : null,
        campaignCount,
        marketCount: st?.markets.size ?? 0,
        isParent: campaignCount > 0,
        childCount: campaignCount,
        opportunity: mode === 'opportunity',
      }]
    })

    // 5. Reconciliation: account ad spend (campaign-level) vs Σ attributed.
    const acct = await prisma.amazonAdsDailyPerformance.aggregate({
      where: { entityType: 'CAMPAIGN', date: { gte: since }, ...(mkt ? { marketplace: mkt } : {}) },
      _sum: { costMicros: true },
    })
    const accountSpendCents = Math.round(Number(acct._sum.costMicros ?? 0n) / 10_000)
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
      where: { date: { gte: since }, advertisingSpendCents: { gt: 0 } },
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
    }
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
    // Resolve distinct campaigns advertising any of these products.
    const ads = await prisma.adProductAd.findMany({
      where: { productId: { in: b.productIds } },
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
    }
    const windowDays = Math.max(7, Math.min(180, Number(query.windowDays ?? 30)))
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - windowDays)
    since.setUTCHours(0, 0, 0, 0)

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

    // ── Ad performance per day ──────────────────────────────────────────
    const perfByDay = await prisma.amazonAdsDailyPerformance.groupBy({
      by: ['date'],
      where: {
        date: { gte: since },
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

    reply.header('Cache-Control', 'private, max-age=60')
    return { windowDays, count: rows.length, rows, summary: curSummary, previous }
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

    // Resolve the campaign's child local ids for the requested grain.
    const localIds = entityType === 'AD_GROUP'
      ? (await prisma.adGroup.findMany({ where: { campaignId: q.campaignId }, select: { id: true } })).map((r) => r.id)
      : (await prisma.adTarget.findMany({ where: { adGroup: { campaignId: q.campaignId } }, select: { id: true } })).map((r) => r.id)
    if (localIds.length === 0) { reply.header('Cache-Control', 'private, max-age=120'); return { windowDays, metric, entityType, series: {} } }

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
        : Math.round(Number(r._sum.costMicros ?? 0n) / 10_000) // cents
    }

    reply.header('Cache-Control', 'private, max-age=120')
    return { windowDays, metric, entityType, axis, series }
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
        OR: [
          { urlExpiresAt: null },
          { urlExpiresAt: { gt: new Date() } },
        ],
      },
      select: { id: true },
      orderBy: { completedAt: 'asc' },
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
    const b = request.body as { keywords?: string[]; matchType?: string; marketplace?: string }
    if (!Array.isArray(b?.keywords) || b.keywords.length === 0) { reply.status(400); return { error: 'keywords[] required' } }
    const { suggestBids } = await import('../services/advertising/ads-bid-suggest.service.js')
    try { return await suggestBids({ keywords: b.keywords, matchType: b.matchType, marketplace: b.marketplace }) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
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
    const b = request.body as Record<string, unknown>
    const messages = Array.isArray((b as { messages?: unknown[] })?.messages) ? (b as { messages: unknown[] }).messages : [b]
    const { ingestMarketingStream } = await import('../services/advertising/ads-marketing-stream.service.js')
    try { return await ingestMarketingStream(messages as never) } catch (e) { reply.status(500); return { error: (e as Error)?.message } }
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
    const targets = await prisma.adTarget.findMany({
      where: {
        kind: 'KEYWORD', status: 'ENABLED', isNegative: false,
        externalTargetId: { not: null }, clicks: { gt: 0 },
        ...(q.marketplace ? { adGroup: { campaign: { marketplace: q.marketplace } } } : {}),
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
      const acosTargetBps = Math.round(((t.adGroup?.campaign?.dynamicBidding as { targetAcos?: number })?.targetAcos ?? 0.3) * 10000)
      return [{
        bridgeId: t.id, externalId: t.externalTargetId, accountRef,
        currentBidMinor: t.bidCents,
        aovMinor: (t.ordersCount ?? 0) > 0 ? Math.round(t.salesCents / (t.ordersCount ?? 1)) : 5000,
        cr7d: cr, cr30d: cr, acosTargetBps, acos1hBps: null, daysOfSupply: null,
        bidMinMinor: 5, bidMaxMinor: Math.max(t.bidCents * 3, 300),
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
    return prisma.adSchedule.create({ data: { campaignId: b.campaignId as string, name: b.name as string, windows: (b.windows as object) ?? [], timezone: (b.timezone as string) ?? 'Europe/Rome', enabled: (b.enabled as boolean) ?? true } })
  })
  fastify.patch('/advertising/schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'windows', 'timezone', 'enabled']) if (b[k] !== undefined) data[k] = b[k]
    try { return await prisma.adSchedule.update({ where: { id }, data }) } catch { reply.status(404); return { error: 'not found' } }
  })
  fastify.delete('/advertising/schedules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try { await prisma.adSchedule.delete({ where: { id } }); return { ok: true } } catch { reply.status(404); return { error: 'not found' } }
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
    return previewBidOptimization({ targetAcos: q.targetAcos ? Number(q.targetAcos) : undefined, campaignId: q.campaignId })
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
