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
