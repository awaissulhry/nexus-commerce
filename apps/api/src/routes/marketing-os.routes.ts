// UM-series (P3) — Unified Marketing OS cockpit API.
//
// Read-only in P3 (shadow): serves the cross-channel campaign roster +
// summary KPIs from the new MarketingCampaign tables (populated by the
// P2 backfill) plus the marketing-events SSE stream the cockpit
// subscribes to. Writes/mutations land in P5+. Kept in a dedicated file
// so the legacy marketing.routes.ts stub stays untouched.
//
// Endpoints (all under /api):
//   GET /marketing/os/summary           KPI strip (counts by channel/status)
//   GET /marketing/os/campaigns         roster (filter: channel/status/marketplace/q)
//   GET /marketing/os/campaigns/:id     single campaign + detail + links + targets
//   GET /marketing/os/events            SSE stream (?since=<ms> replay)

import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { sseResponseHeaders } from '../lib/sse.js'
import { publishMarketingEvent } from '../services/marketing-events.service.js'

const ROSTER_MAX = 500

const marketingOsRoutes: FastifyPluginAsync = async (app) => {
  // ── Summary KPIs ──────────────────────────────────────────────────────
  app.get('/marketing/os/summary', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')
    const [byChannel, byStatus, spendAgg, total] = await Promise.all([
      prisma.marketingCampaign.groupBy({ by: ['channel'], _count: { _all: true } }),
      prisma.marketingCampaign.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.marketingCampaign.aggregate({ _sum: { spendCents: true, salesCents: true } }),
      prisma.marketingCampaign.count(),
    ])
    return {
      total,
      byChannel: Object.fromEntries(byChannel.map((r) => [r.channel, r._count._all])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      spendCents: spendAgg._sum.spendCents ?? 0,
      salesCents: spendAgg._sum.salesCents ?? 0,
    }
  })

  // ── Roster ────────────────────────────────────────────────────────────
  app.get('/marketing/os/campaigns', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const q = request.query as Record<string, string | undefined>

    const where: Prisma.MarketingCampaignWhereInput = {}
    if (q.channel) where.channel = q.channel as Prisma.MarketingCampaignWhereInput['channel']
    if (q.status) where.status = q.status as Prisma.MarketingCampaignWhereInput['status']
    if (q.surface) where.surface = q.surface as Prisma.MarketingCampaignWhereInput['surface']
    if (q.marketplace) where.marketplaces = { has: q.marketplace }
    if (q.q) where.name = { contains: q.q, mode: 'insensitive' }

    const take = Math.min(q.limit ? parseInt(q.limit, 10) || ROSTER_MAX : ROSTER_MAX, ROSTER_MAX)

    const rows = await prisma.marketingCampaign.findMany({
      where,
      take,
      orderBy: [{ status: 'asc' }, { spendCents: 'desc' }],
      include: {
        links: { select: { marketplace: true, status: true, externalId: true } },
        amazonAds: { select: { adProduct: true, portfolioId: true } },
        _count: { select: { targets: true, links: true } },
      },
    })

    // Shape for the grid: flatten the bits the roster columns need; keep
    // payloads lightweight (detail/targets fetched on drill-in).
    const items = rows.map((c) => ({
      id: c.id,
      name: c.name,
      channel: c.channel,
      surface: c.surface,
      objective: c.objective,
      status: c.status,
      marketplaces: c.marketplaces,
      primaryMarketplace: c.primaryMarketplace,
      budgetScope: c.budgetScope,
      budgetCents: c.budgetCents,
      budgetKind: c.budgetKind,
      currency: c.currency,
      spendCents: c.spendCents,
      salesCents: c.salesCents,
      acos: c.acos ? Number(c.acos) : null,
      roas: c.roas ? Number(c.roas) : null,
      deliveryStatus: c.deliveryStatus,
      deliveryReasons: c.deliveryReasons,
      startDate: c.startDate,
      endDate: c.endDate,
      lastSyncedAt: c.lastSyncedAt,
      adProduct: c.amazonAds?.adProduct ?? null,
      linkCount: c._count.links,
      targetCount: c._count.targets,
      markets: c.links.map((l) => l.marketplace),
    }))

    return { items, count: items.length, capped: items.length >= take }
  })

  // ── Single campaign ───────────────────────────────────────────────────
  app.get('/marketing/os/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const c = await prisma.marketingCampaign.findUnique({
      where: { id },
      include: {
        links: true,
        targets: { orderBy: { spendCents: 'desc' } },
        amazonAds: true,
        ebayPromoted: true,
        discount: true,
        externalAds: true,
        contentPush: true,
        outreach: true,
      },
    })
    if (!c) {
      reply.status(404)
      return { error: 'Campaign not found' }
    }
    return c
  })

  // ── Unified analytics (P14) ───────────────────────────────────────────
  // Cross-channel rollups from CampaignMetric. Sums EUR-normalized
  // costEurCents so Amazon + eBay + Shopify + external compare in one
  // currency. CAMPAIGN-grain only (the canonical spend grain — avoids
  // double-counting target/ad-group rows). Cross-channel ROAS is labeled
  // "channel-reported" because attribution models differ per channel.
  app.get('/marketing/os/analytics', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=30')
    const q = request.query as Record<string, string | undefined>
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400_000)
    const to = q.to ? new Date(q.to) : new Date()
    const baseWhere = { entityType: 'CAMPAIGN', date: { gte: from, lte: to } }

    const [byChannel, byMarketplace, daily, totals] = await Promise.all([
      prisma.campaignMetric.groupBy({ by: ['channel'], where: baseWhere, _sum: { costEurCents: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true } }),
      prisma.campaignMetric.groupBy({ by: ['marketplace'], where: baseWhere, _sum: { costEurCents: true, sales7dCents: true }, orderBy: { _sum: { costEurCents: 'desc' } }, take: 20 }),
      prisma.campaignMetric.groupBy({ by: ['date'], where: baseWhere, _sum: { costEurCents: true, sales7dCents: true }, orderBy: { date: 'asc' } }),
      prisma.campaignMetric.aggregate({ where: baseWhere, _sum: { costEurCents: true, sales7dCents: true, impressions: true, clicks: true, orders7d: true } }),
    ])

    const fmt = (rows: Array<{ _sum: { costEurCents: bigint | null; sales7dCents: number | null; impressions?: number | null; clicks?: number | null; orders7d?: number | null } }>, key: string, rowsRaw: Array<Record<string, unknown>>) =>
      rowsRaw.map((r, i) => {
        const spend = Number(rows[i]!._sum.costEurCents ?? 0n)
        const sales = rows[i]!._sum.sales7dCents ?? 0
        return {
          key: r[key],
          spendEurCents: spend,
          salesCents: sales,
          impressions: rows[i]!._sum.impressions ?? undefined,
          clicks: rows[i]!._sum.clicks ?? undefined,
          orders7d: rows[i]!._sum.orders7d ?? undefined,
          roas: spend > 0 ? sales / spend : null,
          acos: sales > 0 ? spend / sales : null,
        }
      })

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      attributionNote: 'Cross-channel ROAS/ACOS are channel-reported (attribution models differ per channel); spend is EUR-normalized via frozen FX at ingest.',
      totals: {
        spendEurCents: Number(totals._sum.costEurCents ?? 0n),
        salesCents: totals._sum.sales7dCents ?? 0,
        impressions: totals._sum.impressions ?? 0,
        clicks: totals._sum.clicks ?? 0,
        orders7d: totals._sum.orders7d ?? 0,
      },
      byChannel: fmt(byChannel, 'channel', byChannel as never),
      byMarketplace: fmt(byMarketplace, 'marketplace', byMarketplace as never),
      daily: daily.map((d) => ({ date: d.date.toISOString().slice(0, 10), spendEurCents: Number(d._sum.costEurCents ?? 0n), salesCents: d._sum.sales7dCents ?? 0 })),
    }
  })

  // ── Budget command center (P7) ────────────────────────────────────────
  app.get('/marketing/os/budgets', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const budgets = await prisma.campaignBudget.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        allocations: { include: { campaign: { select: { id: true, name: true, channel: true, budgetCents: true, currency: true } } } },
        _count: { select: { rebalances: true } },
      },
    })
    return { items: budgets, count: budgets.length }
  })

  app.post('/marketing/os/budgets', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name || b?.totalDailyCents == null) {
      reply.status(400)
      return { error: 'name and totalDailyCents are required' }
    }
    return prisma.campaignBudget.create({
      data: {
        name: b.name as string,
        description: (b.description as string) ?? null,
        scope: (b.scope as string) ?? 'POOL',
        currency: (b.currency as string) ?? 'EUR',
        totalDailyCents: Number(b.totalDailyCents),
        strategy: (b.strategy as string) ?? 'STATIC',
        coolDownMinutes: (b.coolDownMinutes as number) ?? 60,
        maxShiftPerRebalancePct: (b.maxShiftPerRebalancePct as number) ?? 20,
        enabled: (b.enabled as boolean) ?? false,
        dryRun: (b.dryRun as boolean) ?? true,
        createdBy: (b.createdBy as string) ?? null,
      },
    })
  })

  app.patch('/marketing/os/budgets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const allowed = ['name', 'description', 'totalDailyCents', 'strategy', 'coolDownMinutes', 'maxShiftPerRebalancePct', 'enabled', 'dryRun']
    const data: Record<string, unknown> = {}
    for (const k of allowed) if (b[k] !== undefined) data[k] = b[k]
    try {
      return await prisma.campaignBudget.update({ where: { id }, data: data as never })
    } catch {
      reply.status(404)
      return { error: 'budget not found' }
    }
  })

  app.delete('/marketing/os/budgets/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.campaignBudget.delete({ where: { id } })
      return { ok: true }
    } catch {
      reply.status(404)
      return { error: 'budget not found' }
    }
  })

  // Add a campaign to a pool. campaignId is globally unique across pools.
  app.post('/marketing/os/budgets/:id/allocations', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    if (!b?.campaignId) {
      reply.status(400)
      return { error: 'campaignId required' }
    }
    const c = await prisma.marketingCampaign.findUnique({ where: { id: b.campaignId as string }, select: { channel: true, primaryMarketplace: true } })
    if (!c) {
      reply.status(404)
      return { error: 'campaign not found' }
    }
    try {
      return await prisma.campaignBudgetAllocation.create({
        data: {
          budgetId: id,
          campaignId: b.campaignId as string,
          channel: c.channel,
          marketplace: c.primaryMarketplace,
          targetSharePct: (b.targetSharePct as number) ?? 0,
          minDailyBudgetCents: (b.minDailyBudgetCents as number) ?? 100,
          maxDailyBudgetCents: (b.maxDailyBudgetCents as number) ?? null,
        },
      })
    } catch {
      reply.status(409)
      return { error: 'campaign already allocated to a pool' }
    }
  })

  app.delete('/marketing/os/allocations/:allocId', async (request, reply) => {
    const { allocId } = request.params as { allocId: string }
    try {
      await prisma.campaignBudgetAllocation.delete({ where: { id: allocId } })
      return { ok: true }
    } catch {
      reply.status(404)
      return { error: 'allocation not found' }
    }
  })

  // Rebalance preview (dry diff) + apply.
  app.get('/marketing/os/budgets/:id/rebalance/preview', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { computeRebalance } = await import('../services/marketing/marketing-budget.service.js')
    try {
      return await computeRebalance(id)
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'preview failed' }
    }
  })

  app.post('/marketing/os/budgets/:id/rebalance/apply', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, string | undefined>
    const { applyRebalance } = await import('../services/marketing/marketing-budget.service.js')
    try {
      return await applyRebalance({ budgetId: id, triggeredBy: 'user:cockpit', force: q.force === '1' })
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'apply failed' }
    }
  })

  // ── Automation rules (P6, domain=marketing) ──────────────────────────
  // CRUD + manual dry-run over the shared AutomationRule engine. Handlers
  // (mkt_pause_campaign / mkt_resume_campaign / mkt_set_budget /
  // mkt_adjust_budget) self-register via the side-effect import below.
  app.get('/marketing/os/rules', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const rules = await prisma.automationRule.findMany({
      where: { domain: 'marketing' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { executions: true } } },
    })
    return { items: rules, count: rules.length }
  })

  app.post('/marketing/os/rules', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name || !b?.trigger) {
      reply.status(400)
      return { error: 'name and trigger are required' }
    }
    const rule = await prisma.automationRule.create({
      data: {
        domain: 'marketing',
        name: b.name as string,
        description: (b.description as string) ?? null,
        trigger: b.trigger as string,
        conditions: (b.conditions as object) ?? [],
        actions: (b.actions as object) ?? [],
        enabled: (b.enabled as boolean) ?? false,
        dryRun: (b.dryRun as boolean) ?? true, // live-with-guardrails: graduate explicitly
        maxExecutionsPerDay: (b.maxExecutionsPerDay as number) ?? 100,
        maxValueCentsEur: (b.maxValueCentsEur as number) ?? null,
        maxDailyAdSpendCentsEur: (b.maxDailyAdSpendCentsEur as number) ?? null,
        scopeMarketplace: (b.scopeMarketplace as string) ?? null,
        createdBy: (b.createdBy as string) ?? null,
      },
    })
    return rule
  })

  app.patch('/marketing/os/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const allowed = ['name', 'description', 'trigger', 'conditions', 'actions', 'enabled', 'dryRun', 'maxExecutionsPerDay', 'maxValueCentsEur', 'maxDailyAdSpendCentsEur', 'scopeMarketplace']
    const data: Record<string, unknown> = {}
    for (const k of allowed) if (b[k] !== undefined) data[k] = b[k]
    try {
      return await prisma.automationRule.update({ where: { id }, data: data as never })
    } catch {
      reply.status(404)
      return { error: 'rule not found' }
    }
  })

  app.delete('/marketing/os/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.automationRule.delete({ where: { id } })
      return { ok: true }
    } catch {
      reply.status(404)
      return { error: 'rule not found' }
    }
  })

  // Manual run. Defaults to a forced dry-run preview (?mode=apply runs at
  // the rule's own dryRun setting). Optional ?campaignId seeds the context.
  app.post('/marketing/os/rules/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as Record<string, string | undefined>
    const forceDryRun = q.mode !== 'apply'
    await import('../services/marketing/marketing-action-handlers.js') // register handlers
    const { evaluateRule } = await import('../services/automation-rule.service.js')
    const rule = await prisma.automationRule.findUnique({ where: { id } })
    if (!rule || rule.domain !== 'marketing') {
      reply.status(404)
      return { error: 'marketing rule not found' }
    }
    let context: unknown = { marketplace: null, ts: Date.now() }
    if (q.campaignId) {
      const c = await prisma.marketingCampaign.findUnique({
        where: { id: q.campaignId },
        select: { id: true, name: true, channel: true, status: true, acos: true, roas: true, spendCents: true, salesCents: true, budgetCents: true, primaryMarketplace: true },
      })
      if (c) context = { marketplace: c.primaryMarketplace, campaignId: c.id, campaign: { ...c, acos: c.acos != null ? Number(c.acos) : null, roas: c.roas != null ? Number(c.roas) : null } }
    }
    const result = await evaluateRule({ ruleId: id, context, forceDryRun })
    return { forceDryRun, result }
  })

  // Roll back an executed campaign action (post-grace undo).
  app.post('/marketing/os/actions/:id/rollback', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { rollbackCampaignAction } = await import('../services/marketing/marketing-mutation.service.js')
    const r = await rollbackCampaignAction(id)
    if (!r.rolledBack) reply.status(409)
    return r
  })

  // Run the marketing rule evaluator once (manual tick for verification).
  app.post('/marketing/os/rules/evaluate-now', async (_request, reply) => {
    const { runMarketingRuleEvaluatorOnce } = await import('../jobs/marketing-rule-evaluator.job.js')
    try {
      return await runMarketingRuleEvaluatorOnce()
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'evaluate failed' }
    }
  })

  // ── Create campaign (P10, any channel incl. INTERNAL) ─────────────────
  // Operator-authored campaigns: paid (Amazon/eBay/etc.), promotions, or
  // INTERNAL content-push / outreach. Creates the core row + the matching
  // 1:1 detail. Scheduling onto the calendar / launching content happens
  // via the calendar + /launch endpoints.
  app.post('/marketing/os/campaigns', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.name || !b?.channel || !b?.surface) {
      reply.status(400)
      return { error: 'name, channel, surface are required' }
    }
    const marketplaces = (b.marketplaces as string[]) ?? []
    const data: Record<string, unknown> = {
      channel: b.channel,
      surface: b.surface,
      objective: (b.objective as string) ?? 'SALES',
      name: b.name,
      status: (b.status as string) ?? 'DRAFT',
      startDate: b.startDate ? new Date(b.startDate as string) : new Date(),
      endDate: b.endDate ? new Date(b.endDate as string) : null,
      marketplaces,
      primaryMarketplace: (b.primaryMarketplace as string) ?? marketplaces[0] ?? null,
      budgetCents: (b.budgetCents as number) ?? null,
      budgetKind: (b.budgetKind as string) ?? null,
      currency: (b.currency as string) ?? 'EUR',
      createdBy: (b.createdBy as string) ?? null,
    }
    // Nested 1:1 detail by surface family.
    if (b.surface === 'CONTENT_PUSH') {
      data.contentPush = { create: { contentType: (b.contentType as string) ?? 'LISTING_COPY', aPlusContentId: (b.aPlusContentId as string) ?? null, brandStoryId: (b.brandStoryId as string) ?? null, targetRefs: (b.targetRefs as string[]) ?? [] } }
    } else if (b.surface === 'EMAIL_OUTREACH' || b.surface === 'REVIEW_OUTREACH') {
      data.outreach = { create: { mode: b.surface === 'REVIEW_OUTREACH' ? 'REVIEW' : 'EMAIL', segmentId: (b.segmentId as string) ?? null, templateId: (b.templateId as string) ?? null } }
    } else if (b.surface === 'DISCOUNT' || b.surface === 'MARKDOWN' || b.surface === 'DEAL') {
      data.discount = { create: { discountType: (b.discountType as string) ?? 'PERCENTAGE', discountPercent: (b.discountPercent as number) ?? null, discountValueCents: (b.discountValueCents as number) ?? null, appliesTo: (b.appliesTo as string) ?? 'ALL' } }
    }
    const created = await prisma.marketingCampaign.create({ data: data as never })
    publishMarketingEvent({ type: 'campaign.mutated', campaignId: created.id, channel: created.channel, action: 'created', ts: Date.now() })
    return created
  })

  // Delete a campaign (cascades links/detail/targets/metrics via FK). For
  // operator-authored drafts + verification cleanup.
  app.delete('/marketing/os/campaigns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const c = await prisma.marketingCampaign.delete({ where: { id }, select: { id: true, channel: true } })
      publishMarketingEvent({ type: 'campaign.mutated', campaignId: id, channel: c.channel, action: 'deleted', ts: Date.now() })
      return { ok: true }
    } catch {
      reply.status(404)
      return { error: 'campaign not found' }
    }
  })

  // Launch an INTERNAL content-push / outreach campaign (sandbox-gated).
  app.post('/marketing/os/campaigns/:id/launch', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { enqueueCampaignMutation } = await import('../services/marketing/marketing-mutation.service.js')
    try {
      const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_LAUNCH', payload: {}, applyImmediately: true })
      return r
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'launch failed' }
    }
  })

  // ── Campaign mutations (P5, sandbox-gated) ────────────────────────────
  // Operator writes flow through the unified mutation path: optimistic
  // local update + CampaignAction audit + OutboundSyncQueue row with a
  // 5-min grace window. Amazon stays SANDBOX via the write gate until the
  // P8 cutover (no live external write fires).
  app.patch('/marketing/os/campaigns/:id/mutate', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    const { enqueueCampaignMutation } = await import('../services/marketing/marketing-mutation.service.js')
    try {
      if (b.status !== undefined) {
        const status = b.status as string
        if (!['ACTIVE', 'PAUSED'].includes(status)) {
          reply.status(400)
          return { error: 'status must be ACTIVE or PAUSED' }
        }
        const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_STATE_UPDATE', payload: { status }, userId: (b.userId as string) ?? null })
        return r
      }
      if (b.budgetCents !== undefined) {
        const budgetCents = Number(b.budgetCents)
        if (!Number.isFinite(budgetCents) || budgetCents < 0) {
          reply.status(400)
          return { error: 'budgetCents must be a non-negative number' }
        }
        const r = await enqueueCampaignMutation({ campaignId: id, syncType: 'MKT_BUDGET_UPDATE', payload: { budgetCents }, userId: (b.userId as string) ?? null })
        return r
      }
      reply.status(400)
      return { error: 'provide status or budgetCents' }
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'mutation failed' }
    }
  })

  app.post('/marketing/os/mutations/:queueId/cancel', async (request, reply) => {
    const { queueId } = request.params as { queueId: string }
    const { cancelCampaignMutation } = await import('../services/marketing/marketing-mutation.service.js')
    const r = await cancelCampaignMutation(queueId)
    if (!r.cancelled) reply.status(409)
    return r
  })

  // Manual drain (sandbox verification + cron-friendly). Processes ready
  // MKT_* rows: gate-check then sandbox-finalize or live-dispatch.
  app.post('/marketing/os/sync/drain', async (_request, reply) => {
    const { drainMarketingSyncOnce } = await import('../services/marketing/marketing-mutation.service.js')
    try {
      return await drainMarketingSyncOnce()
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'drain failed' }
    }
  })

  // ── Marketing calendar (P4) ───────────────────────────────────────────
  // The shared calendar view-model: operator-authored CalendarEntry rows +
  // scheduled campaigns + RetailEvent background bands (demand anchors with
  // expectedLift) for a date window. Read + entry CRUD; scheduling a real
  // campaign onto the calendar via mutation lands in P5.
  app.get('/marketing/os/calendar', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const q = request.query as Record<string, string | undefined>
    // Default window: the current ±45-day span if not supplied.
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 45 * 86400_000)
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 45 * 86400_000)

    const [entries, retailEvents, campaigns] = await Promise.all([
      prisma.calendarEntry.findMany({
        where: { startsAt: { lte: to }, OR: [{ endsAt: null }, { endsAt: { gte: from } }] },
        orderBy: { startsAt: 'asc' },
      }),
      prisma.retailEvent.findMany({
        where: { isActive: true, startDate: { lte: to }, endDate: { gte: from } },
        orderBy: { startDate: 'asc' },
      }),
      prisma.marketingCampaign.findMany({
        where: { startDate: { lte: to }, OR: [{ endDate: null }, { endDate: { gte: from } }] },
        select: {
          id: true, name: true, channel: true, surface: true, status: true,
          startDate: true, endDate: true, marketplaces: true, budgetScope: true,
        },
        orderBy: { startDate: 'asc' },
        take: 500,
      }),
    ])
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      entries,
      retailEvents: retailEvents.map((e) => ({
        id: e.id, name: e.name, startDate: e.startDate, endDate: e.endDate,
        channel: e.channel, marketplace: e.marketplace, expectedLift: Number(e.expectedLift),
        prepLeadTimeDays: e.prepLeadTimeDays, source: e.source,
      })),
      campaigns,
    }
  })

  app.post('/marketing/os/calendar', async (request, reply) => {
    const b = request.body as Record<string, unknown>
    if (!b?.title || !b?.startsAt) {
      reply.status(400)
      return { error: 'title and startsAt are required' }
    }
    const entry = await prisma.calendarEntry.create({
      data: {
        kind: (b.kind as string) ?? 'NOTE',
        title: b.title as string,
        channel: (b.channel as never) ?? null,
        marketplaces: (b.marketplaces as string[]) ?? [],
        startsAt: new Date(b.startsAt as string),
        endsAt: b.endsAt ? new Date(b.endsAt as string) : null,
        status: (b.status as string) ?? 'PLANNED',
        color: (b.color as string) ?? null,
        notes: (b.notes as string) ?? null,
        campaignId: (b.campaignId as string) ?? null,
        retailEventId: (b.retailEventId as string) ?? null,
        createdBy: (b.createdBy as string) ?? null,
      },
    })
    publishMarketingEvent({ type: 'campaign.mutated', campaignId: entry.campaignId ?? 'calendar', channel: entry.channel ?? 'INTERNAL', action: 'created', ts: Date.now() })
    return entry
  })

  app.patch('/marketing/os/calendar/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const b = request.body as Record<string, unknown>
    try {
      const entry = await prisma.calendarEntry.update({
        where: { id },
        data: {
          ...(b.title !== undefined ? { title: b.title as string } : {}),
          ...(b.startsAt !== undefined ? { startsAt: new Date(b.startsAt as string) } : {}),
          ...(b.endsAt !== undefined ? { endsAt: b.endsAt ? new Date(b.endsAt as string) : null } : {}),
          ...(b.status !== undefined ? { status: b.status as string } : {}),
          ...(b.color !== undefined ? { color: b.color as string } : {}),
          ...(b.notes !== undefined ? { notes: b.notes as string } : {}),
          ...(b.kind !== undefined ? { kind: b.kind as string } : {}),
        },
      })
      publishMarketingEvent({ type: 'campaign.mutated', campaignId: entry.campaignId ?? 'calendar', channel: entry.channel ?? 'INTERNAL', action: 'updated', ts: Date.now() })
      return entry
    } catch {
      reply.status(404)
      return { error: 'Calendar entry not found' }
    }
  })

  app.delete('/marketing/os/calendar/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.calendarEntry.delete({ where: { id } })
      return { ok: true }
    } catch {
      reply.status(404)
      return { error: 'Calendar entry not found' }
    }
  })

  // ── Amazon cutover readiness + guarded test (P8) ──────────────────────
  // Status: what's needed for unified Amazon writes to go live. The flip is
  // deliberate + reversible (NEXUS_MARKETING_AMAZON_LIVE). Nothing here
  // writes live unless ALL gates are green.
  app.get('/marketing/os/cutover/amazon/status', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const { adsMode } = await import('../services/advertising/ads-api-client.js')
    const conns = await prisma.amazonAdsConnection.findMany({
      where: { isActive: true },
      select: { marketplace: true, mode: true, writesEnabledAt: true },
    })
    const marketingLive = process.env.NEXUS_MARKETING_AMAZON_LIVE === '1'
    const mode = adsMode()
    const writeReadyConns = conns.filter((c) => c.mode === 'production' && c.writesEnabledAt != null)
    return {
      gates: {
        NEXUS_MARKETING_AMAZON_LIVE: marketingLive,
        adsMode: mode,
        productionConnectionsWithWritesEnabled: writeReadyConns.length,
      },
      ready: marketingLive && mode === 'live' && writeReadyConns.length > 0,
      connections: conns.map((c) => ({ marketplace: c.marketplace, mode: c.mode, writesEnabled: c.writesEnabledAt != null })),
      note: 'Unified Amazon writes fire only when all three gates are green. Until then the cockpit/automation run sandbox (no external write). Legacy Trading Desk stays authoritative.',
    }
  })

  // Guarded test: writes a campaign's CURRENT budget back to itself — a
  // no-op-VALUE live write that exercises the end-to-end live path without
  // changing actual spend. Safe to run repeatedly.
  app.post('/marketing/os/cutover/amazon/test', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    if (!q.campaignId) {
      reply.status(400)
      return { error: 'campaignId required' }
    }
    const c = await prisma.marketingCampaign.findUnique({ where: { id: q.campaignId }, select: { id: true, channel: true, budgetCents: true } })
    if (!c || c.channel !== 'AMAZON') {
      reply.status(404)
      return { error: 'Amazon campaign not found' }
    }
    const { enqueueCampaignMutation, processMarketingSyncRow } = await import('../services/marketing/marketing-mutation.service.js')
    // No-op value: write current budget back. applyImmediately skips grace.
    const r = await enqueueCampaignMutation({ campaignId: c.id, syncType: 'MKT_BUDGET_UPDATE', payload: { budgetCents: c.budgetCents ?? 100 }, applyImmediately: true, userId: 'cutover-test' })
    const processed = await processMarketingSyncRow(r.queueId)
    return { queueId: r.queueId, processed, note: 'No-op-value write (current budget → itself). status=live-success means the live path works.' }
  })

  // ── eBay shadow backfill trigger (P9) ─────────────────────────────────
  // Mirrors the Amazon backfill — populates the eBay lens from the legacy
  // EbayCampaign table (no creds needed). Defaults dry-run; ?mode=apply writes.
  app.post('/marketing/os/backfill/ebay', async (request, reply) => {
    const apply = (request.query as Record<string, string | undefined>)?.mode === 'apply'
    const { backfillEbayShadow } = await import('../services/marketing/ebay-backfill.service.js')
    try {
      return await backfillEbayShadow({ apply })
    } catch (err) {
      reply.status(500)
      return { error: (err as Error)?.message ?? 'ebay backfill failed' }
    }
  })

  // ── Diagnostics (P3.2) ────────────────────────────────────────────────
  // Surfaces the CampaignMetric grain breakdown so we can see how spend is
  // distributed (CAMPAIGN vs TARGET vs AD_GROUP vs …) and how many rows
  // linked back to a campaign. Used to validate the spend rollup.
  app.get('/marketing/os/diagnostics/metrics', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=15')
    const byType = await prisma.campaignMetric.groupBy({
      by: ['entityType'],
      where: { channel: 'AMAZON' },
      _count: { _all: true },
      _sum: { costMicros: true, costEurCents: true, sales7dCents: true },
    })
    const linked = await prisma.campaignMetric.count({ where: { channel: 'AMAZON', campaignId: { not: null } } })
    const unlinked = await prisma.campaignMetric.count({ where: { channel: 'AMAZON', campaignId: null } })
    const campaignsWithSpend = await prisma.marketingCampaign.count({ where: { channel: 'AMAZON', spendCents: { gt: 0 } } })
    return {
      byEntityType: byType.map((r) => ({
        entityType: r.entityType,
        rows: r._count._all,
        costMicros: r._sum.costMicros?.toString() ?? '0',
        costEurCents: r._sum.costEurCents?.toString() ?? '0',
        sales7dCents: r._sum.sales7dCents ?? 0,
      })),
      linkedToCampaign: linked,
      unlinkedMetrics: unlinked,
      campaignsWithSpend,
    }
  })

  // ── Amazon shadow backfill trigger (P3.1) ────────────────────────────
  // Runs in-process so it can use the server's prod DB credentials (the
  // standalone script can't reach prod from a dev box). Defaults to a
  // dry-run PLAN; requires ?mode=apply to write. Idempotent (delete-then-
  // insert scoped channel=AMAZON) and reversible — only touches the new
  // shadow tables, never anything the live Trading Desk reads.
  app.post('/marketing/os/backfill/amazon', async (request, reply) => {
    const mode = (request.query as Record<string, string | undefined>)?.mode
    const apply = mode === 'apply'
    const { backfillAmazonShadow } = await import('../services/marketing/amazon-backfill.service.js')
    try {
      const report = await backfillAmazonShadow({ apply })
      if (apply && report.parity && !report.parity.ok) reply.status(207) // multi-status: ran but parity off
      return report
    } catch (err) {
      logger.error('[UM] amazon backfill failed', { error: (err as Error)?.message })
      reply.status(500)
      return { error: (err as Error)?.message ?? 'backfill failed' }
    }
  })

  // ── Campaign action history (P3-detail) ──────────────────────────────
  app.get('/marketing/os/campaigns/:id/actions', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=10')
    const { id } = request.params as { id: string }
    const actions = await prisma.campaignAction.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    const metrics = await prisma.campaignMetric.findMany({
      where: { campaignId: id, entityType: 'CAMPAIGN' },
      orderBy: { date: 'desc' },
      take: 60,
      select: { date: true, impressions: true, clicks: true, costEurCents: true, sales7dCents: true, currencyCode: true },
    })
    return { actions, metrics }
  })

  // ── SSE stream ────────────────────────────────────────────────────────
  // Mirrors /api/orders/events: ping on connect, ?since=<ms> replay,
  // 25s heartbeat, cleanup on close.
  app.get('/marketing/os/events', async (request, reply) => {
    reply.raw.writeHead(200, sseResponseHeaders(request.headers.origin as string | undefined))
    reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)

    const { subscribeMarketingEvents, replayMarketingEventsSince } = await import(
      '../services/marketing-events.service.js'
    )
    const send = (event: { type: string }) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // dead connection — close handler cleans up
      }
    }

    const sinceRaw = (request.query as Record<string, string | undefined>)?.since
    const sinceMs = sinceRaw ? Number(sinceRaw) : NaN
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      const replayed = replayMarketingEventsSince(sinceMs)
      for (const event of replayed) send(event)
      if (replayed.length > 0) {
        reply.raw.write(
          `event: replay.done\ndata: ${JSON.stringify({ ts: Date.now(), count: replayed.length })}\n\n`,
        )
      }
    }

    const unsubscribe = subscribeMarketingEvents(send)
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
      } catch {
        // ignore
      }
    }, 25_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })

    await new Promise(() => {})
  })

  logger.debug('[UM] marketing-os routes registered (P3, read-only cockpit)')
}

export default marketingOsRoutes
