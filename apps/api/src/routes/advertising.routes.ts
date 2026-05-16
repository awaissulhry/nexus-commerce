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
