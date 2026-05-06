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
            status: true,
            createdAt: true,
            amazonMetadata: true,
            ebayMetadata: true,
          },
        }),
        prisma.order.findMany({
          where: { createdAt: { gte: prevFrom, lt: prevTo } },
          select: { totalPrice: true },
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

      const sumDecimal = (rows: Array<{ totalPrice: unknown }>) =>
        rows.reduce(
          (acc, r) =>
            acc + Number(((r.totalPrice ?? 0) as number) || 0),
          0,
        )
      const sumQty = (rows: Array<{ quantity: number | null }>) =>
        rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0)

      const revenue = {
        current: sumDecimal(currentOrders),
        previous: sumDecimal(previousOrders),
      }
      const orderCounts = {
        current: currentOrders.length,
        previous: previousOrders.length,
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
        prisma.channelListing.count({ where: { listingStatus: 'FAILED' } }),
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
}

export default dashboardRoutes
