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
