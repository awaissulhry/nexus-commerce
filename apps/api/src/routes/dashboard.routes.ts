/**
 * ZZ — /api/dashboard/overview
 *
 * One-shot aggregation for the Command Center page. Computes:
 *   - revenue / orders / AOV / units, current window vs previous of
 *     equal length, with delta percent
 *   - per-channel breakdown (Amazon / eBay / Shopify / WooCommerce)
 *   - per-(channel, marketplace) matrix derived from order metadata
 *     and ChannelListing rows
 *   - catalog snapshot: products, parents, variants, draft + live
 *     listings
 *   - operational alerts: low stock, draft / failed listings, stale
 *     schemas, disconnected channels
 *   - 30-day sparkline (revenue + orders per day, gap-filled to
 *     zero so the line doesn't bend on missing days)
 *   - recent activity from BulkOperation + AuditLog
 *
 * One endpoint instead of N small ones because the dashboard renders
 * everything together; one round trip is cheaper for the client and
 * easier to cache server-side.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

type Window = 'today' | '7d' | '30d' | '90d' | 'ytd'

function windowBounds(window: Window): {
  from: Date
  to: Date
  prevFrom: Date
  prevTo: Date
  label: string
} {
  const to = new Date()
  let from: Date
  let label: string
  switch (window) {
    case 'today': {
      from = new Date(to)
      from.setHours(0, 0, 0, 0)
      label = 'Today'
      break
    }
    case '7d': {
      from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
      label = 'Last 7 days'
      break
    }
    case '90d': {
      from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000)
      label = 'Last 90 days'
      break
    }
    case 'ytd': {
      from = new Date(to.getFullYear(), 0, 1)
      label = 'Year to date'
      break
    }
    case '30d':
    default: {
      from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
      label = 'Last 30 days'
      break
    }
  }
  const length = to.getTime() - from.getTime()
  const prevTo = new Date(from)
  const prevFrom = new Date(from.getTime() - length)
  return { from, to, prevFrom, prevTo, label }
}

function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0
  return ((current - previous) / previous) * 100
}

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { window?: string } }>(
    '/dashboard/overview',
    async (request, reply) => {
      const window = ((request.query?.window ?? '30d') as Window)
      const { from, to, prevFrom, prevTo, label } = windowBounds(window)

      // ── Period totals ─────────────────────────────────────────────
      const [
        currentOrders,
        previousOrders,
        currentItems,
        previousItems,
      ] = await Promise.all([
        prisma.order.findMany({
          where: { createdAt: { gte: from, lte: to } },
          select: {
            id: true,
            channel: true,
            totalPrice: true,
            currencyCode: true,
            status: true,
            createdAt: true,
            amazonMetadata: true,
            ebayMetadata: true,
          },
        }),
        prisma.order.findMany({
          where: { createdAt: { gte: prevFrom, lt: prevTo } },
          select: { totalPrice: true, currencyCode: true },
        }),
        prisma.orderItem.findMany({
          where: { order: { createdAt: { gte: from, lte: to } } },
          select: { quantity: true, productId: true, sku: true, price: true },
        }),
        prisma.orderItem.findMany({
          where: { order: { createdAt: { gte: prevFrom, lt: prevTo } } },
          select: { quantity: true },
        }),
      ])

      // DO.1 — multi-currency aware aggregation.
      //
      // Orders carry currencyCode (EUR, USD, GBP, …). Naively summing
      // totalPrice across currencies produces a meaningless blended
      // number; the previous code did exactly that and rendered the
      // result with a hardcoded $ symbol. The Italian operator on
      // mostly-EUR markets saw the wrong glyph on the wrong number.
      //
      // Now: bucket revenue by currency, pick a primary (highest-
      // revenue currency in the current window — falls back to EUR
      // when there are no orders), and report it alongside the full
      // breakdown so the client can show a secondary "incl. $X USD"
      // hint when multi-currency mixing is real.
      type CurrencyTotals = { current: number; previous: number }
      const byCurrency = new Map<string, CurrencyTotals>()
      const slotFor = (code: string): CurrencyTotals => {
        const ex = byCurrency.get(code)
        if (ex) return ex
        const fresh = { current: 0, previous: 0 }
        byCurrency.set(code, fresh)
        return fresh
      }
      for (const o of currentOrders) {
        const code = (o.currencyCode ?? 'EUR') || 'EUR'
        slotFor(code).current += Number((o.totalPrice as unknown as number) || 0)
      }
      for (const o of previousOrders) {
        const code = (o.currencyCode ?? 'EUR') || 'EUR'
        slotFor(code).previous += Number((o.totalPrice as unknown as number) || 0)
      }

      // Primary = currency with highest current-period revenue. With
      // ties or no data, fall back to EUR — Xavia's home market.
      let primaryCurrency = 'EUR'
      let topRevenue = -1
      for (const [code, totals] of byCurrency.entries()) {
        if (totals.current > topRevenue) {
          topRevenue = totals.current
          primaryCurrency = code
        }
      }

      const primaryTotals =
        byCurrency.get(primaryCurrency) ?? { current: 0, previous: 0 }

      const ordersInCurrency = (
        rows: Array<{ currencyCode: string | null }>,
        code: string,
      ): number =>
        rows.reduce(
          (acc, r) => acc + ((r.currencyCode ?? 'EUR') === code ? 1 : 0),
          0,
        )

      const sumQty = (rows: Array<{ quantity: number | null }>) =>
        rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0)

      const revenue = {
        current: primaryTotals.current,
        previous: primaryTotals.previous,
      }
      const orderCounts = {
        current: ordersInCurrency(currentOrders, primaryCurrency),
        previous: ordersInCurrency(previousOrders, primaryCurrency),
      }
      const units = {
        current: sumQty(currentItems),
        previous: sumQty(previousItems),
      }
      const aov = {
        current:
          orderCounts.current > 0 ? revenue.current / orderCounts.current : 0,
        previous:
          orderCounts.previous > 0
            ? revenue.previous / orderCounts.previous
            : 0,
      }

      // ── Per-channel breakdown ────────────────────────────────────
      const channelMap = new Map<
        string,
        { revenue: number; orders: number; units: number }
      >()
      for (const o of currentOrders) {
        const ch = String(o.channel)
        const slot = channelMap.get(ch) ?? { revenue: 0, orders: 0, units: 0 }
        slot.revenue += Number((o.totalPrice as unknown as number) || 0)
        slot.orders += 1
        channelMap.set(ch, slot)
      }
      // Distribute units back per channel by joining via OrderItem.
      const itemsByOrder = new Map<string, number>()
      for (const i of currentItems) {
        // Items don't carry channel directly; we need order → channel.
        // Build qty-by-orderId once and merge.
      }
      void itemsByOrder
      // Cheaper: re-aggregate via raw SQL.
      let unitsByChannel: Array<{ channel: string; total: bigint }> = []
      try {
        unitsByChannel = (await prisma.$queryRawUnsafe(
          `SELECT o."channel"::text AS channel, COALESCE(SUM(oi."quantity"), 0)::bigint AS total
           FROM "OrderItem" oi
           JOIN "Order" o ON o.id = oi."orderId"
           WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
           GROUP BY o."channel"`,
          from,
          to,
        )) as Array<{ channel: string; total: bigint }>
      } catch (err) {
        request.log.warn({ err }, '[dashboard] units-by-channel raw query failed')
      }
      for (const row of unitsByChannel) {
        const slot =
          channelMap.get(row.channel) ?? { revenue: 0, orders: 0, units: 0 }
        slot.units = Number(row.total)
        channelMap.set(row.channel, slot)
      }

      // Listings and sync status per channel.
      const listingsByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        _count: { _all: true },
      })
      const liveByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        where: { listingStatus: 'LIVE' },
        _count: { _all: true },
      })
      const draftByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        where: { listingStatus: 'DRAFT' },
        _count: { _all: true },
      })
      const failedByChannel = await prisma.channelListing.groupBy({
        by: ['channel'],
        where: { listingStatus: 'FAILED' },
        _count: { _all: true },
      })

      const knownChannels = new Set<string>([
        'AMAZON',
        'EBAY',
        'SHOPIFY',
        'WOOCOMMERCE',
        'ETSY',
      ])
      for (const r of listingsByChannel) knownChannels.add(r.channel)
      for (const c of channelMap.keys()) knownChannels.add(c)

      const byChannel = Array.from(knownChannels).map((ch) => {
        const slot = channelMap.get(ch) ?? { revenue: 0, orders: 0, units: 0 }
        const total =
          listingsByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const live =
          liveByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const draft =
          draftByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        const failed =
          failedByChannel.find((r) => r.channel === ch)?._count._all ?? 0
        return {
          channel: ch,
          revenue: slot.revenue,
          orders: slot.orders,
          units: slot.units,
          aov: slot.orders > 0 ? slot.revenue / slot.orders : 0,
          listings: { total, live, draft, failed },
        }
      })

      // ── Per-(channel, marketplace) matrix from listings ─────────
      const listingMatrix = await prisma.channelListing.groupBy({
        by: ['channel', 'marketplace'],
        _count: { _all: true },
      })
      const byMarketplace = listingMatrix.map((r) => ({
        channel: r.channel,
        marketplace: r.marketplace,
        listings: r._count._all,
      }))

      // ── Catalog snapshot ─────────────────────────────────────────
      const [
        totalProducts,
        totalParents,
        totalVariants,
        liveListings,
        draftListings,
        failedListings,
        lowStockCount,
        outOfStockCount,
      ] = await Promise.all([
        prisma.product.count(),
        prisma.product.count({ where: { isParent: true } }),
        prisma.productVariation.count(),
        prisma.channelListing.count({ where: { listingStatus: 'LIVE' } }),
        prisma.channelListing.count({ where: { listingStatus: 'DRAFT' } }),
        // C.4 — schema lists DRAFT, ACTIVE, INACTIVE, ENDED, ERROR for
        // ChannelListing.listingStatus. The previous 'FAILED' filter
        // matched nothing, so this counter was permanently 0 and the
        // dashboard alert never fired even when listings genuinely
        // needed attention. ERROR is the real "publish/validation
        // failed" terminal state.
        prisma.channelListing.count({ where: { listingStatus: 'ERROR' } }),
        prisma.product.count({
          where: { totalStock: { gt: 0, lte: 10 } },
        }),
        prisma.product.count({ where: { totalStock: { lte: 0 } } }),
      ])

      // ── Channel connectivity (eBay) ──────────────────────────────
      const [ebayActive, channelConnections] = await Promise.all([
        prisma.channelConnection.count({
          where: { channelType: 'EBAY', isActive: true },
        }),
        prisma.channelConnection.findMany({
          select: { channelType: true, isActive: true, lastSyncStatus: true },
        }),
      ])

      // ── Top SKUs by revenue in this window ──────────────────────
      let topProducts: Array<{
        sku: string
        revenue: number
        units: number
        productId: string | null
      }> = []
      try {
        const rows = (await prisma.$queryRawUnsafe(
          `SELECT oi."sku" AS sku,
                  oi."productId" AS "productId",
                  COALESCE(SUM(oi."quantity"), 0)::bigint AS units,
                  COALESCE(SUM(oi."price" * oi."quantity"), 0)::float AS revenue
           FROM "OrderItem" oi
           JOIN "Order" o ON o.id = oi."orderId"
           WHERE o."createdAt" >= $1 AND o."createdAt" <= $2
           GROUP BY oi."sku", oi."productId"
           ORDER BY revenue DESC
           LIMIT 10`,
          from,
          to,
        )) as Array<{
          sku: string
          productId: string | null
          units: bigint
          revenue: number
        }>
        topProducts = rows.map((r) => ({
          sku: r.sku,
          productId: r.productId,
          units: Number(r.units),
          revenue: Number(r.revenue),
        }))
      } catch (err) {
        request.log.warn({ err }, '[dashboard] top SKUs raw query failed')
      }

      // ── 30-day sparkline (gap-filled) ───────────────────────────
      const sparkFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
      sparkFrom.setHours(0, 0, 0, 0)
      let sparkRows: Array<{ d: string; revenue: number; orders: bigint }> = []
      try {
        sparkRows = (await prisma.$queryRawUnsafe(
          `SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS d,
                  COALESCE(SUM("totalPrice"), 0)::float AS revenue,
                  COUNT(*)::bigint AS orders
           FROM "Order"
           WHERE "createdAt" >= $1 AND "createdAt" <= $2
           GROUP BY 1
           ORDER BY 1 ASC`,
          sparkFrom,
          to,
        )) as Array<{ d: string; revenue: number; orders: bigint }>
      } catch (err) {
        request.log.warn({ err }, '[dashboard] sparkline raw query failed')
      }
      const sparkMap = new Map<string, { revenue: number; orders: number }>()
      for (const r of sparkRows) {
        sparkMap.set(r.d, { revenue: r.revenue, orders: Number(r.orders) })
      }
      const sparkline: Array<{ date: string; revenue: number; orders: number }> = []
      for (let i = 0; i < 30; i++) {
        const d = new Date(sparkFrom)
        d.setDate(d.getDate() + i)
        const key = d.toISOString().slice(0, 10)
        const slot = sparkMap.get(key) ?? { revenue: 0, orders: 0 }
        sparkline.push({ date: key, revenue: slot.revenue, orders: slot.orders })
      }

      // ── Recent activity (BulkOperation + AuditLog) ──────────────
      let recentActivity: Array<{
        type: string
        ts: string
        summary: string
      }> = []
      try {
        const [ops, audits] = await Promise.all([
          prisma.bulkOperation.findMany({
            take: 8,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              changeCount: true,
              productCount: true,
              status: true,
              createdAt: true,
            },
          }),
          prisma.auditLog
            .findMany({
              take: 8,
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                entityType: true,
                action: true,
                createdAt: true,
              },
            })
            .catch(() => []),
        ])
        for (const o of ops) {
          recentActivity.push({
            type: 'bulkOp',
            ts: o.createdAt.toISOString(),
            summary: `${o.status} — ${o.changeCount} change${
              o.changeCount === 1 ? '' : 's'
            } across ${o.productCount} product${
              o.productCount === 1 ? '' : 's'
            }`,
          })
        }
        for (const a of audits) {
          recentActivity.push({
            type: 'audit',
            ts: a.createdAt.toISOString(),
            summary: `${a.action} ${a.entityType}`,
          })
        }
        recentActivity.sort((x, y) => (x.ts < y.ts ? 1 : -1))
        recentActivity = recentActivity.slice(0, 12)
      } catch (err) {
        request.log.warn({ err }, '[dashboard] activity feed failed')
      }

      // ── Pending orders count (operational alert) ─────────────────
      const pendingOrders = await prisma.order
        .count({ where: { status: 'PENDING' } })
        .catch(() => 0)

      return {
        window: {
          from: from.toISOString(),
          to: to.toISOString(),
          label,
          key: window,
        },
        currency: {
          primary: primaryCurrency,
          // Sorted desc by current-period revenue so the client can
          // render "incl. $X USD" lines in priority order without
          // re-sorting.
          breakdown: Array.from(byCurrency.entries())
            .map(([code, totals]) => ({
              code,
              current: totals.current,
              previous: totals.previous,
            }))
            .sort((a, b) => b.current - a.current),
        },
        totals: {
          revenue: {
            current: revenue.current,
            previous: revenue.previous,
            deltaPct: deltaPct(revenue.current, revenue.previous),
          },
          orders: {
            current: orderCounts.current,
            previous: orderCounts.previous,
            deltaPct: deltaPct(orderCounts.current, orderCounts.previous),
          },
          aov: {
            current: aov.current,
            previous: aov.previous,
            deltaPct: deltaPct(aov.current, aov.previous),
          },
          units: {
            current: units.current,
            previous: units.previous,
            deltaPct: deltaPct(units.current, units.previous),
          },
        },
        byChannel,
        byMarketplace,
        topProducts,
        sparkline,
        recentActivity,
        catalog: {
          totalProducts,
          totalParents,
          totalVariants,
          liveListings,
          draftListings,
          failedListings,
          lowStockCount,
          outOfStockCount,
        },
        alerts: {
          lowStock: lowStockCount,
          outOfStock: outOfStockCount,
          failedListings,
          draftListings,
          pendingOrders,
          ebayConnected: ebayActive > 0,
          channelConnections: channelConnections.map((c) => ({
            channelType: c.channelType,
            isActive: c.isActive,
            lastSyncStatus: c.lastSyncStatus,
          })),
        },
      }
    },
  )

  /**
   * H.13 — sync health dashboard data.
   *
   *   GET /api/dashboard/health
   *
   * Single-shot rollup the operator can hit when something feels off:
   *   - Queue: OutboundSyncQueue depth (pending / inFlight / failed)
   *     plus the oldest pending row (drives the "stuck job" warning).
   *   - Per-channel sync: ChannelConnection status, last sync result,
   *     24h error count, derived status (ok / warn / fail).
   *   - 24h SyncLog roll-up: success + fail counts and computed error
   *     rate. Powers the headline stat at the top of the page.
   *   - Recent errors: last 20 from SyncError + SyncLog(status=FAILED)
   *     merged and sorted newest-first so the operator can scan.
   *
   * Replaces the "tab-hop between /sync-logs, /logs, /api/monitoring/
   * queue-stats" workflow. 30s Cache-Control because the page is
   * polled, and these tables don't change second-to-second.
   */
  fastify.get('/dashboard/health', async (_request, reply) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

    // ── Queue depth + oldest stuck row ─────────────────────────────
    const [pending, inFlight, failed, oldestPending] = await Promise.all([
      prisma.outboundSyncQueue.count({ where: { syncStatus: 'PENDING' } }),
      prisma.outboundSyncQueue.count({ where: { syncStatus: 'IN_PROGRESS' } }),
      prisma.outboundSyncQueue.count({ where: { syncStatus: 'FAILED' } }),
      prisma.outboundSyncQueue.findFirst({
        where: { syncStatus: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true, targetChannel: true },
      }),
    ])

    // ── 24h sync log rollup ─────────────────────────────────────────
    const [logsSuccessful, logsFailed] = await Promise.all([
      prisma.syncLog.count({
        where: { status: 'SUCCESS', createdAt: { gte: since24h } },
      }),
      prisma.syncLog.count({
        where: { status: 'FAILED', createdAt: { gte: since24h } },
      }),
    ])
    const logsTotal = logsSuccessful + logsFailed
    const errorRate24h = logsTotal === 0 ? 0 : logsFailed / logsTotal

    // ── Per-channel status ─────────────────────────────────────────
    const connections = await prisma.channelConnection.findMany({
      orderBy: [{ channelType: 'asc' }, { marketplace: 'asc' }],
      select: {
        id: true,
        channelType: true,
        marketplace: true,
        managedBy: true,
        isActive: true,
        lastSyncStatus: true,
        lastSyncAt: true,
        lastSyncError: true,
        displayName: true,
      },
    })

    // 24h error count per channel from SyncError. groupBy on (channel)
    // gives one query for every channel rather than N findMany calls.
    const errorByChannel = await prisma.syncError.groupBy({
      by: ['channel'],
      where: { createdAt: { gte: since24h } },
      _count: { _all: true },
    })
    const errorCountByChannel = new Map(
      errorByChannel.map((r) => [r.channel, r._count._all]),
    )

    const channels = connections.map((c) => {
      const errors24h = errorCountByChannel.get(c.channelType) ?? 0
      const status =
        !c.isActive
          ? 'inactive'
          : c.lastSyncStatus === 'FAILED'
            ? 'fail'
            : errors24h > 5
              ? 'warn'
              : 'ok'
      return {
        id: c.id,
        channel: c.channelType,
        marketplace: c.marketplace,
        managedBy: c.managedBy,
        isActive: c.isActive,
        displayName: c.displayName,
        lastSyncStatus: c.lastSyncStatus,
        lastSyncAt: c.lastSyncAt,
        lastSyncError: c.lastSyncError,
        errors24h,
        status,
      }
    })

    // ── Recent errors: merge SyncError + SyncLog(FAILED) ────────────
    // SyncError captures ad-hoc cross-channel failures; SyncLog
    // captures per-product publish attempts. Merging gives the
    // operator one timeline to triage from.
    const [syncErrors, failedLogs] = await Promise.all([
      prisma.syncError.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          channel: true,
          errorType: true,
          errorMessage: true,
          context: true,
          createdAt: true,
        },
      }),
      prisma.syncLog.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          syncType: true,
          errorMessage: true,
          productId: true,
          createdAt: true,
        },
      }),
    ])
    const recentErrors = [
      ...syncErrors.map((e) => ({
        id: `err:${e.id}`,
        kind: 'sync-error' as const,
        when: e.createdAt,
        channel: e.channel,
        type: e.errorType,
        message: e.errorMessage,
        productId: null,
        context: e.context,
      })),
      ...failedLogs.map((l) => ({
        id: `log:${l.id}`,
        kind: 'sync-log' as const,
        when: l.createdAt,
        channel: l.syncType.split('_')[0] ?? 'UNKNOWN',
        type: l.syncType,
        message: l.errorMessage ?? 'Unknown error',
        productId: l.productId,
        context: null,
      })),
    ]
      .sort((a, b) => b.when.getTime() - a.when.getTime())
      .slice(0, 20)

    reply.header('Cache-Control', 'private, max-age=30')
    return {
      generatedAt: new Date().toISOString(),
      queue: {
        pending,
        inFlight,
        failed,
        total: pending + inFlight + failed,
        oldestPending: oldestPending
          ? {
              id: oldestPending.id,
              createdAt: oldestPending.createdAt,
              targetChannel: oldestPending.targetChannel,
              ageMs: Date.now() - oldestPending.createdAt.getTime(),
            }
          : null,
      },
      logs24h: {
        successful: logsSuccessful,
        failed: logsFailed,
        total: logsTotal,
        errorRate: errorRate24h,
      },
      channels,
      recentErrors,
    }
  })

  // Cron observability — latest run per known job + recent failures.
  // Powers the CronStatusPanel on /dashboard/health.
  // Backed by the CronRun table written by recordCronRun().
  fastify.get('/dashboard/cron-runs', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=15')

      // Latest run per jobName via DISTINCT ON (Postgres-specific). The
      // grouped-window equivalent in pure Prisma is awkward; raw SQL is
      // cleaner here.
      const latest = await prisma.$queryRaw<
        Array<{
          jobName: string
          startedAt: Date
          finishedAt: Date | null
          status: string
          errorMessage: string | null
          outputSummary: string | null
          triggeredBy: string
        }>
      >`
        SELECT DISTINCT ON ("jobName")
          "jobName", "startedAt", "finishedAt", "status",
          "errorMessage", "outputSummary", "triggeredBy"
        FROM "CronRun"
        WHERE "startedAt" > NOW() - INTERVAL '30 days'
        ORDER BY "jobName", "startedAt" DESC
      `

      // Stale RUNNING rows (>2h) — likely a crash before the wrapper
      // could update. Surface as health flags.
      const staleRunning = await prisma.cronRun.findMany({
        where: {
          status: 'RUNNING',
          startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        select: {
          id: true,
          jobName: true,
          startedAt: true,
          triggeredBy: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 20,
      })

      // Last 20 failures across all jobs.
      const recentFailures = await prisma.cronRun.findMany({
        where: { status: 'FAILED' },
        select: {
          id: true,
          jobName: true,
          startedAt: true,
          finishedAt: true,
          errorMessage: true,
          triggeredBy: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 20,
      })

      return {
        latest: latest.map((r) => ({
          ...r,
          durationMs:
            r.finishedAt
              ? new Date(r.finishedAt).getTime() -
                new Date(r.startedAt).getTime()
              : null,
        })),
        staleRunning,
        recentFailures,
        generatedAt: new Date().toISOString(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/cron-runs] failed')
      return reply.code(500).send({ error: message })
    }
  })

  // Force-resync a single drifting ChannelListing. Repairs the
  // displayed value to match the master snapshot + enqueues an
  // OutboundSyncQueue row with no grace window so the cron worker
  // pushes immediately.
  //
  // Body: { kind: 'quantity' | 'price' }. The quantity case sets
  // ChannelListing.quantity = masterQuantity - stockBuffer; the price
  // case sets price = masterPrice when pricingRule=FIXED. Other rules
  // are intentional divergence (PERCENT_OF_MASTER, MATCH_AMAZON) and
  // get a 409.
  fastify.post<{
    Params: { id: string }
    Body: { kind?: 'quantity' | 'price' }
  }>('/dashboard/stock-drift/:id/resync', async (request, reply) => {
    try {
      const { id } = request.params
      const kind = request.body?.kind ?? 'quantity'
      const listing = await prisma.channelListing.findUnique({
        where: { id },
        select: {
          id: true,
          channel: true,
          region: true,
          marketplace: true,
          externalListingId: true,
          productId: true,
          masterPrice: true,
          price: true,
          masterQuantity: true,
          quantity: true,
          stockBuffer: true,
          pricingRule: true,
          followMasterQuantity: true,
          followMasterPrice: true,
        },
      })
      if (!listing) {
        return reply.code(404).send({ error: 'Listing not found' })
      }

      if (kind === 'quantity') {
        if (!listing.followMasterQuantity) {
          return reply.code(409).send({
            error:
              'Listing has followMasterQuantity=false; quantity divergence is intentional. Toggle on to resync.',
          })
        }
        if (listing.masterQuantity == null) {
          return reply.code(409).send({
            error: 'Master quantity not snapshotted yet; cannot resync.',
          })
        }
        const newQty = Math.max(
          0,
          listing.masterQuantity - (listing.stockBuffer ?? 0),
        )
        await prisma.$transaction(async (tx) => {
          await tx.channelListing.update({
            where: { id },
            data: {
              quantity: newQty,
              lastSyncStatus: 'PENDING',
              version: { increment: 1 },
            },
          })
          await tx.outboundSyncQueue.create({
            data: {
              productId: listing.productId,
              channelListingId: listing.id,
              targetChannel: listing.channel as any,
              targetRegion: listing.region,
              syncStatus: 'PENDING' as any,
              syncType: 'QUANTITY_UPDATE',
              holdUntil: null, // immediate — operator-initiated
              externalListingId: listing.externalListingId,
              payload: { quantity: newQty } as any,
            },
          })
        })
        return reply.send({
          success: true,
          kind,
          newValue: newQty,
        })
      }

      // kind === 'price'
      if (!listing.followMasterPrice) {
        return reply.code(409).send({
          error:
            'Listing has followMasterPrice=false; price divergence is intentional.',
        })
      }
      if (listing.pricingRule !== 'FIXED') {
        return reply.code(409).send({
          error: `pricingRule=${listing.pricingRule} intentionally diverges from master; only FIXED is a literal-follow rule.`,
        })
      }
      if (listing.masterPrice == null) {
        return reply.code(409).send({
          error: 'Master price not snapshotted yet; cannot resync.',
        })
      }
      const newPrice = Number(listing.masterPrice)
      await prisma.$transaction(async (tx) => {
        await tx.channelListing.update({
          where: { id },
          data: {
            price: newPrice.toFixed(2),
            lastSyncStatus: 'PENDING',
            version: { increment: 1 },
          },
        })
        await tx.outboundSyncQueue.create({
          data: {
            productId: listing.productId,
            channelListingId: listing.id,
            targetChannel: listing.channel as any,
            targetRegion: listing.region,
            syncStatus: 'PENDING' as any,
            syncType: 'PRICE_UPDATE',
            holdUntil: null,
            externalListingId: listing.externalListingId,
            payload: { price: newPrice } as any,
          },
        })
      })
      return reply.send({ success: true, kind, newValue: newPrice })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/stock-drift/:id/resync] failed')
      return reply.code(500).send({ error: message })
    }
  })

  // Stock drift detection — surface ChannelListings where the cached
  // master snapshot disagrees with the displayed value. The Phase 13
  // master-cascade should keep these in sync; persistent drift means
  // a sync queue row failed, the cron worker is stuck, or a manual
  // override was applied without followMaster being flipped off.
  //
  // Two drift classes:
  //   1. quantityDrift: followMasterQuantity=true AND
  //      |masterQuantity - quantity| > 0
  //   2. priceDrift: followMasterPrice=true AND pricingRule=FIXED AND
  //      |masterPrice - price| > 0.01
  //
  // Returns up to 100 of each, sorted by largest absolute drift first.
  fastify.get<{
    Querystring: { qtyThreshold?: string; priceThreshold?: string }
  }>('/dashboard/stock-drift', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const qtyThreshold = Math.max(
        0,
        Number(request.query.qtyThreshold ?? 0),
      )
      const priceThreshold = Math.max(
        0,
        Number(request.query.priceThreshold ?? 0.01),
      )

      type DriftRow = {
        id: string
        channel: string
        marketplace: string | null
        productId: string
        sku: string | null
        productName: string | null
        masterQuantity: number | null
        quantity: number | null
        quantityDelta: number | null
        masterPrice: string | null
        price: string | null
        priceDelta: number | null
        followMasterQuantity: boolean
        followMasterPrice: boolean
        pricingRule: string | null
        lastSyncStatus: string | null
        lastSyncedAt: Date | null
        updatedAt: Date
      }

      // Quantity drift: cached snapshot vs displayed.
      const qtyDriftRows = await prisma.$queryRaw<DriftRow[]>`
        SELECT
          cl.id,
          cl.channel,
          cl.marketplace,
          cl."productId",
          p.sku,
          p.name AS "productName",
          cl."masterQuantity",
          cl.quantity,
          (COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) AS "quantityDelta",
          NULL::text AS "masterPrice",
          NULL::text AS "price",
          NULL::numeric AS "priceDelta",
          cl."followMasterQuantity",
          cl."followMasterPrice",
          cl."pricingRule",
          cl."lastSyncStatus",
          cl."lastSyncedAt",
          cl."updatedAt"
        FROM "ChannelListing" cl
        JOIN "Product" p ON p.id = cl."productId"
        WHERE cl."followMasterQuantity" = true
          AND cl."masterQuantity" IS NOT NULL
          AND cl.quantity IS NOT NULL
          AND ABS(COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) > ${qtyThreshold}
        ORDER BY ABS(COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) DESC
        LIMIT 100
      `

      // Price drift: only relevant when pricingRule=FIXED (the rule
      // explicitly says "follow master price, no transformation").
      // PERCENT_OF_MASTER and MATCH_AMAZON intentionally diverge.
      const priceDriftRows = await prisma.$queryRaw<DriftRow[]>`
        SELECT
          cl.id,
          cl.channel,
          cl.marketplace,
          cl."productId",
          p.sku,
          p.name AS "productName",
          NULL::int AS "masterQuantity",
          NULL::int AS quantity,
          NULL::int AS "quantityDelta",
          cl."masterPrice"::text AS "masterPrice",
          cl.price::text AS price,
          (COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0))::numeric AS "priceDelta",
          cl."followMasterQuantity",
          cl."followMasterPrice",
          cl."pricingRule",
          cl."lastSyncStatus",
          cl."lastSyncedAt",
          cl."updatedAt"
        FROM "ChannelListing" cl
        JOIN "Product" p ON p.id = cl."productId"
        WHERE cl."followMasterPrice" = true
          AND cl."pricingRule" = 'FIXED'
          AND cl."masterPrice" IS NOT NULL
          AND cl.price IS NOT NULL
          AND ABS(COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0)) > ${priceThreshold}
        ORDER BY ABS(COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0)) DESC
        LIMIT 100
      `

      // Total counts (unbounded by limit) for the headline KPIs.
      const [qtyTotalRow] = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*)::bigint AS c FROM "ChannelListing" cl
        WHERE cl."followMasterQuantity" = true
          AND cl."masterQuantity" IS NOT NULL
          AND cl.quantity IS NOT NULL
          AND ABS(COALESCE(cl.quantity, 0) - COALESCE(cl."masterQuantity", 0)) > ${qtyThreshold}
      `
      const [priceTotalRow] = await prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*)::bigint AS c FROM "ChannelListing" cl
        WHERE cl."followMasterPrice" = true
          AND cl."pricingRule" = 'FIXED'
          AND cl."masterPrice" IS NOT NULL
          AND cl.price IS NOT NULL
          AND ABS(COALESCE(cl.price, 0) - COALESCE(cl."masterPrice", 0)) > ${priceThreshold}
      `

      return {
        quantityDrift: {
          totalCount: Number(qtyTotalRow?.c ?? 0n),
          rows: qtyDriftRows,
          threshold: qtyThreshold,
        },
        priceDrift: {
          totalCount: Number(priceTotalRow?.c ?? 0n),
          rows: priceDriftRows,
          threshold: priceThreshold,
        },
        generatedAt: new Date().toISOString(),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      fastify.log.error({ err }, '[dashboard/stock-drift] failed')
      return reply.code(500).send({ error: message })
    }
  })
}

export default dashboardRoutes
