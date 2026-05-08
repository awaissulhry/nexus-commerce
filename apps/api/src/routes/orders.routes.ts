/**
 * Orders API — D.2 rebuild.
 *
 * Replaces the legacy `{ success, data }` response shape with a flat
 * paginated payload (matching /api/products and /api/listings). Adds
 * rich filters, per-row coverage rollups, and a customer-aware lens.
 *
 * The old @fastify/compress empty-body bug is sidestepped by returning
 * the payload directly (`return { ... }`) instead of `reply.send(...)`.
 * Keep this pattern for any new GET handler in this file.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { logger } from '../utils/logger.js'
import { ingestMockOrders, shipOrder } from '../services/order-ingestion.service.js'
import prisma from '../db.js'
import { csvDocument } from '../lib/csv.js'

const ALL_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL'] as const

function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function csvParam(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v || v === 'ALL') return undefined
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

export async function ordersRoutes(app: FastifyInstance) {
  // ── Mock ingest (kept for demo/testing) ──────────────────────────
  app.post('/api/orders/ingest', async (_request, reply) => {
    try {
      const stats = await ingestMockOrders()
      return { success: true, message: 'Mock orders ingested', data: stats }
    } catch (error: any) {
      logger.error('[ORDERS API] ingest failed', { message: error.message })
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // ── Stats (kept, lighter response shape) ─────────────────────────
  app.get('/api/orders/stats', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const [total, pending, shipped, cancelled, delivered] = await Promise.all([
        prisma.order.count(),
        prisma.order.count({ where: { status: 'PENDING' } }),
        prisma.order.count({ where: { status: 'SHIPPED' } }),
        prisma.order.count({ where: { status: 'CANCELLED' } }),
        prisma.order.count({ where: { status: 'DELIVERED' } }),
      ])
      const last = await prisma.order.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, purchaseDate: true },
      })
      return {
        total, pending, shipped, cancelled, delivered,
        lastOrderAt: last?.purchaseDate ?? last?.createdAt ?? null,
      }
    } catch (error: any) {
      logger.error('[ORDERS API] stats failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders — paginated, filterable, per-row enriched ─────
  app.get('/api/orders', async (request, reply) => {
    try {
      const q = request.query as any

      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(500, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const search = (q.search ?? '').trim()

      const channels = csvParam(q.channel)
      const marketplaces = csvParam(q.marketplace)
      const statuses = csvParam(q.status)
      const fulfillment = csvParam(q.fulfillment)
      const tagIds = csvParam(q.tags)
      const reviewStatus = csvParam(q.reviewStatus)
      const customerEmail = (q.customerEmail ?? '').trim() || null
      const dateFrom = q.dateFrom ? new Date(q.dateFrom) : null
      const dateTo = q.dateTo ? new Date(q.dateTo) : null
      const hasReturn = q.hasReturn === 'true' ? true : q.hasReturn === 'false' ? false : null
      const hasRefund = q.hasRefund === 'true' ? true : q.hasRefund === 'false' ? false : null
      const reviewEligible = q.reviewEligible === 'true'

      const sortBy = (q.sortBy ?? 'purchaseDate') as string
      const sortDir = (q.sortDir === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'

      const where: any = {}
      if (channels && channels.length) where.channel = { in: channels }
      if (marketplaces && marketplaces.length) where.marketplace = { in: marketplaces }
      if (statuses && statuses.length) where.status = { in: statuses }
      if (fulfillment && fulfillment.length) where.fulfillmentMethod = { in: fulfillment }
      if (customerEmail) where.customerEmail = { contains: customerEmail, mode: 'insensitive' }
      if (dateFrom || dateTo) {
        where.purchaseDate = {}
        if (dateFrom) where.purchaseDate.gte = dateFrom
        if (dateTo) where.purchaseDate.lte = dateTo
      }
      if (search) {
        where.OR = [
          { channelOrderId: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
          { items: { some: { sku: { contains: search, mode: 'insensitive' } } } },
        ]
      }
      if (tagIds && tagIds.length) {
        where.tags = { some: { tagId: { in: tagIds } } }
      }
      if (reviewStatus && reviewStatus.length) {
        where.reviewRequests = { some: { status: { in: reviewStatus } } }
      }
      if (reviewEligible) {
        where.deliveredAt = { not: null }
        where.AND = [
          { reviewRequests: { none: {} } },
          { returns: { none: { status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } } } },
        ]
      }

      // Order-by translation
      let orderBy: any
      switch (sortBy) {
        case 'createdAt': orderBy = { createdAt: sortDir }; break
        case 'updatedAt': orderBy = { updatedAt: sortDir }; break
        case 'totalPrice': orderBy = { totalPrice: sortDir }; break
        case 'customer': orderBy = { customerEmail: sortDir }; break
        case 'channel': orderBy = [{ channel: sortDir }, { marketplace: 'asc' }]; break
        case 'status': orderBy = { status: sortDir }; break
        case 'purchaseDate':
        default: orderBy = { purchaseDate: sortDir }
      }

      const [total, rawOrders] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            items: { select: { id: true, sku: true, quantity: true, price: true, productId: true } },
            tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
            reviewRequests: { select: { id: true, channel: true, status: true, sentAt: true, scheduledFor: true } },
            _count: { select: { items: true, shipments: true, returns: true, financialTransactions: true } },
          },
        }),
      ])

      // Optional flags computed in JS — has-return / has-refund / repeat-customer
      const orderIds = rawOrders.map((o) => o.id)
      const emails = Array.from(new Set(rawOrders.map((o) => o.customerEmail).filter(Boolean)))

      const [activeReturnsByOrder, refundsByOrder, customerOrderCounts] = await Promise.all([
        prisma.return.groupBy({
          by: ['orderId'],
          where: { orderId: { in: orderIds }, status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING'] } },
          _count: true,
        }),
        prisma.financialTransaction.groupBy({
          by: ['orderId'],
          where: { orderId: { in: orderIds }, transactionType: 'Refund' },
          _count: true,
        }),
        emails.length === 0 ? Promise.resolve([] as Array<{ customerEmail: string; _count: number }>) : prisma.order.groupBy({
          by: ['customerEmail'],
          where: { customerEmail: { in: emails } },
          _count: true,
        }),
      ])
      const activeReturns = new Set(activeReturnsByOrder.map((r) => r.orderId))
      const hasRefundSet = new Set(refundsByOrder.map((r) => r.orderId))
      const customerOrderCountMap = new Map(customerOrderCounts.map((c: any) => [c.customerEmail, c._count]))

      const orders = rawOrders
        .filter((o) => {
          if (hasReturn === true && !activeReturns.has(o.id)) return false
          if (hasReturn === false && activeReturns.has(o.id)) return false
          if (hasRefund === true && !hasRefundSet.has(o.id)) return false
          if (hasRefund === false && hasRefundSet.has(o.id)) return false
          return true
        })
        .map((o) => ({
          id: o.id,
          channel: o.channel,
          marketplace: o.marketplace,
          channelOrderId: o.channelOrderId,
          status: o.status,
          fulfillmentMethod: o.fulfillmentMethod,
          totalPrice: Number(o.totalPrice),
          currencyCode: o.currencyCode,
          customerName: o.customerName,
          customerEmail: o.customerEmail,
          shippingAddress: o.shippingAddress,
          purchaseDate: o.purchaseDate,
          paidAt: o.paidAt,
          shippedAt: o.shippedAt,
          deliveredAt: o.deliveredAt,
          cancelledAt: o.cancelledAt,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
          itemCount: o._count.items,
          shipmentCount: o._count.shipments,
          returnCount: o._count.returns,
          financialTxCount: o._count.financialTransactions,
          hasActiveReturn: activeReturns.has(o.id),
          hasRefund: hasRefundSet.has(o.id),
          customerOrderCount: customerOrderCountMap.get(o.customerEmail) ?? 1,
          tags: o.tags.map((t: any) => t.tag),
          reviewRequests: o.reviewRequests,
          items: o.items.map((it) => ({ ...it, price: Number(it.price) })),
        }))

      return {
        orders,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      logger.error('[ORDERS API] list failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/facets — distinct channels, marketplaces, tags
  app.get('/api/orders/facets', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=60')
      const [channels, marketplaces, fulfillment] = await Promise.all([
        prisma.order.groupBy({ by: ['channel'], _count: true }),
        prisma.order.groupBy({ by: ['marketplace'], where: { marketplace: { not: null } }, _count: true }),
        prisma.order.groupBy({ by: ['fulfillmentMethod'], where: { fulfillmentMethod: { not: null } }, _count: true }),
      ])
      return {
        channels: channels.map((c) => ({ value: c.channel, count: c._count })),
        marketplaces: marketplaces.filter((m) => m.marketplace).map((m) => ({ value: m.marketplace!, count: m._count })),
        fulfillment: fulfillment.filter((f) => f.fulfillmentMethod).map((f) => ({ value: f.fulfillmentMethod!, count: f._count })),
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/:id — full detail with relations ─────────────
  app.get('/api/orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          items: {
            include: {
              product: { select: { id: true, sku: true, name: true, basePrice: true, images: { select: { url: true }, take: 1 } } },
            },
          },
          financialTransactions: { orderBy: { transactionDate: 'desc' } },
          shipments: { include: { items: true, warehouse: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' } },
          returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
          reviewRequests: { include: { rule: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } },
          tags: { include: { tag: true } },
        },
      })
      if (!order) return reply.status(404).send({ error: 'Order not found' })

      // Customer history sidebar — last 10 orders from this email
      const history = await prisma.order.findMany({
        where: { customerEmail: order.customerEmail, id: { not: order.id } },
        select: { id: true, channelOrderId: true, channel: true, totalPrice: true, status: true, purchaseDate: true, createdAt: true },
        orderBy: { purchaseDate: 'desc' },
        take: 10,
      })

      return {
        ...order,
        totalPrice: Number(order.totalPrice),
        items: order.items.map((it) => ({
          ...it,
          price: Number(it.price),
          product: it.product
            ? { ...it.product, basePrice: Number(it.product.basePrice), thumbnailUrl: it.product.images?.[0]?.url ?? null }
            : null,
        })),
        financialTransactions: order.financialTransactions.map((tx) => ({
          ...tx,
          amount: Number(tx.amount),
          amazonFee: Number(tx.amazonFee),
          fbaFee: Number(tx.fbaFee),
          paymentServicesFee: Number(tx.paymentServicesFee),
          ebayFee: Number(tx.ebayFee),
          paypalFee: Number(tx.paypalFee),
          otherFees: Number(tx.otherFees),
          grossRevenue: Number(tx.grossRevenue),
          netRevenue: Number(tx.netRevenue),
        })),
        tags: order.tags.map((t: any) => t.tag),
        customerHistory: history.map((h) => ({ ...h, totalPrice: Number(h.totalPrice) })),
      }
    } catch (error: any) {
      logger.error('[ORDERS API] detail failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/:id/timeline — synthesized event log ─────────
  app.get('/api/orders/:id/timeline', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          shipments: { select: { id: true, status: true, carrierCode: true, trackingNumber: true, shippedAt: true, deliveredAt: true, createdAt: true } },
          returns: { select: { id: true, rmaNumber: true, status: true, receivedAt: true, refundedAt: true, restockedAt: true, createdAt: true } },
          reviewRequests: { select: { id: true, channel: true, status: true, scheduledFor: true, sentAt: true, errorMessage: true } },
        },
      })
      if (!order) return reply.status(404).send({ error: 'Order not found' })

      type Event = { at: Date; kind: string; label: string; meta?: any }
      const events: Event[] = []
      if (order.purchaseDate) events.push({ at: order.purchaseDate, kind: 'placed', label: 'Order placed' })
      if (order.paidAt) events.push({ at: order.paidAt, kind: 'paid', label: 'Payment received' })
      if (order.shippedAt) events.push({ at: order.shippedAt, kind: 'shipped', label: 'Shipped' })
      if (order.deliveredAt) events.push({ at: order.deliveredAt, kind: 'delivered', label: 'Delivered' })
      if (order.cancelledAt) events.push({ at: order.cancelledAt, kind: 'cancelled', label: 'Cancelled' })
      for (const s of order.shipments) {
        if (s.shippedAt) events.push({ at: s.shippedAt, kind: 'shipment-shipped', label: `Shipment ${s.trackingNumber ?? ''} shipped`, meta: { shipmentId: s.id, carrier: s.carrierCode } })
        if (s.deliveredAt) events.push({ at: s.deliveredAt, kind: 'shipment-delivered', label: `Shipment ${s.trackingNumber ?? ''} delivered`, meta: { shipmentId: s.id } })
      }
      for (const r of order.returns) {
        if (r.receivedAt) events.push({ at: r.receivedAt, kind: 'return-received', label: `Return ${r.rmaNumber ?? ''} received`, meta: { returnId: r.id } })
        if (r.refundedAt) events.push({ at: r.refundedAt, kind: 'return-refunded', label: `Return ${r.rmaNumber ?? ''} refunded`, meta: { returnId: r.id } })
        if (r.restockedAt) events.push({ at: r.restockedAt, kind: 'return-restocked', label: `Return ${r.rmaNumber ?? ''} restocked`, meta: { returnId: r.id } })
      }
      for (const rr of order.reviewRequests) {
        if (rr.sentAt) events.push({ at: rr.sentAt, kind: 'review-sent', label: `Review request sent on ${rr.channel}`, meta: { reviewRequestId: rr.id, status: rr.status } })
        if (rr.scheduledFor && !rr.sentAt) events.push({ at: rr.scheduledFor, kind: 'review-scheduled', label: `Review request scheduled (${rr.channel})`, meta: { reviewRequestId: rr.id } })
      }
      events.sort((a, b) => a.at.getTime() - b.at.getTime())
      return { events }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/:id/financials — gross/fees/net rollup ───────
  app.get('/api/orders/:id/financials', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const txs = await prisma.financialTransaction.findMany({
        where: { orderId: id },
        orderBy: { transactionDate: 'desc' },
      })
      let gross = 0, fees = 0, net = 0
      for (const tx of txs) {
        gross += Number(tx.grossRevenue)
        fees += Number(tx.amazonFee) + Number(tx.fbaFee) + Number(tx.paymentServicesFee) + Number(tx.ebayFee) + Number(tx.paypalFee) + Number(tx.otherFees)
        net += Number(tx.netRevenue)
      }
      return {
        rollup: { gross, fees, net },
        transactions: txs.map((tx) => ({
          ...tx,
          amount: Number(tx.amount),
          amazonFee: Number(tx.amazonFee),
          fbaFee: Number(tx.fbaFee),
          paymentServicesFee: Number(tx.paymentServicesFee),
          ebayFee: Number(tx.ebayFee),
          paypalFee: Number(tx.paypalFee),
          otherFees: Number(tx.otherFees),
          grossRevenue: Number(tx.grossRevenue),
          netRevenue: Number(tx.netRevenue),
        })),
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/customers/:email — customer profile ──────────
  app.get('/api/orders/customers/:email', async (request, reply) => {
    try {
      const { email } = request.params as { email: string }
      const decoded = decodeURIComponent(email)
      const orders = await prisma.order.findMany({
        where: { customerEmail: decoded },
        orderBy: { purchaseDate: 'desc' },
        take: 100,
        select: {
          id: true, channelOrderId: true, channel: true, marketplace: true,
          status: true, totalPrice: true, currencyCode: true,
          purchaseDate: true, createdAt: true,
        },
      })
      const totalSpent = orders.reduce((s, o) => s + Number(o.totalPrice), 0)
      return {
        email: decoded,
        orderCount: orders.length,
        totalSpent,
        firstOrderAt: orders[orders.length - 1]?.purchaseDate ?? null,
        lastOrderAt: orders[0]?.purchaseDate ?? null,
        orders: orders.map((o) => ({ ...o, totalPrice: Number(o.totalPrice) })),
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── PATCH /api/orders/:id/ship — legacy single-mark-shipped ─────
  app.patch('/api/orders/:id/ship', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const order = await shipOrder(id)
      return { success: true, data: order }
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message })
    }
  })

  // ── POST /api/orders/bulk-mark-shipped ───────────────────────────
  app.post('/api/orders/bulk-mark-shipped', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { orderIds?: string[] }
      const ids = Array.isArray(body.orderIds) ? body.orderIds : []
      if (ids.length === 0) return reply.status(400).send({ error: 'orderIds[] required' })
      const result = await prisma.order.updateMany({
        where: { id: { in: ids }, status: { in: ['PENDING'] } },
        data: { status: 'SHIPPED', shippedAt: new Date() },
      })
      return { ok: true, updated: result.count }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── O.48: Manual order cancellation ────────────────────────────────
  // POST /api/orders/:id/cancel — operator-initiated cancellation.
  // Sets Order.status=CANCELLED + cancelledAt + runs the existing
  // O.45/O.46 cascade (void parcels + restore stock). Channel-side
  // pushback (telling Amazon/eBay we cancelled) is a separate
  // commit; today this only updates Nexus state, and the response
  // surfaces { channelPushbackPending: true } so the UI can warn
  // operator to also cancel on the channel.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/api/orders/:id/cancel',
    async (request, reply) => {
      try {
        const { id } = request.params
        const reason = request.body?.reason?.trim() || 'Cancelled by operator'

        const existing = await prisma.order.findUnique({
          where: { id },
          select: { id: true, status: true, channel: true, channelOrderId: true },
        })
        if (!existing) return reply.status(404).send({ error: 'Order not found' })
        if (existing.status === 'CANCELLED') {
          return reply.status(400).send({
            error: 'Order is already cancelled.',
            code: 'ALREADY_CANCELLED',
          })
        }
        if (['SHIPPED', 'DELIVERED'].includes(existing.status as string)) {
          return reply.status(400).send({
            error: `Cannot cancel a ${existing.status} order. File a return instead.`,
            code: 'ORDER_TOO_FAR',
          })
        }

        const updated = await prisma.order.update({
          where: { id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        })

        // Cascade: void shipments + restore stock + audit + SSE.
        const { handleOrderCancelled } = await import(
          '../services/order-cancellation/index.js'
        )
        const cleanup = await handleOrderCancelled(id)

        // O.50: channel-side pushback — tell the marketplace we
        // cancelled. dryRun-default per channel; real path gated by
        // NEXUS_ENABLE_*_ORDER_CANCEL flags. Best-effort: a channel
        // failure doesn't roll back the local cancellation (operator
        // already chose to cancel; we just couldn't notify upstream
        // automatically).
        let channelAck: import('../services/order-cancellation/channel-cancel.js').ChannelCancelResult | null = null
        if (existing.channel !== 'MANUAL' && existing.channelOrderId) {
          const channelCancel = await import(
            '../services/order-cancellation/channel-cancel.js'
          )
          try {
            if (existing.channel === 'AMAZON') {
              // Resolve marketplaceId from Order.marketplace
              const fullOrder = await prisma.order.findUnique({
                where: { id },
                select: { marketplace: true },
              })
              const map: Record<string, string> = {
                IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH',
                ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P', US: 'ATVPDKIKX0DER',
              }
              const mpId = map[fullOrder?.marketplace ?? 'IT'] ?? map.IT
              channelAck = await channelCancel.cancelOnAmazon(
                existing.channelOrderId,
                reason,
                [mpId],
              )
            } else if (existing.channel === 'EBAY') {
              const conn = await (prisma as any).channelConnection.findFirst({
                where: { channel: 'EBAY', isActive: true },
                select: { id: true },
              })
              if (conn?.id) {
                channelAck = await channelCancel.cancelOnEbay(
                  existing.channelOrderId,
                  reason,
                  conn.id,
                )
              } else {
                channelAck = {
                  ok: false,
                  channel: 'EBAY',
                  channelOrderId: existing.channelOrderId,
                  ackRef: null,
                  dryRun: false,
                  error: 'No active eBay connection',
                }
              }
            } else if (existing.channel === 'SHOPIFY') {
              channelAck = await channelCancel.cancelOnShopify(
                existing.channelOrderId,
                reason,
              )
            }
          } catch (err: any) {
            logger.warn('orders/:id/cancel channel pushback failed', {
              orderId: id,
              channel: existing.channel,
              error: err?.message,
            })
          }
        }

        // Operator-initiated audit row distinct from the auto-cancel
        // path (auto-cancel-from-order). Lets the audit-log surface
        // distinguish operator vs channel-driven cancellations.
        const { auditLogService } = await import('../services/audit-log.service.js')
        void auditLogService.write({
          entityType: 'Order',
          entityId: id,
          action: 'manual-cancel',
          before: { status: existing.status },
          after: { status: 'CANCELLED' },
          metadata: { reason, channel: existing.channel, ...cleanup, channelAck },
        })

        return {
          order: updated,
          cleanup,
          // O.50: channelPushbackPending is now true only when the
          // channel call failed OR the channel is MANUAL OR the
          // channel push was dryRun (operator hasn't enabled real
          // mode yet). Honest: operator only sees the "cancel on
          // marketplace too" reminder when there's actually
          // marketplace work left.
          channelPushbackPending:
            channelAck === null
            || channelAck.dryRun
            || !channelAck.ok,
          channelAck,
          channel: existing.channel,
          channelOrderId: existing.channelOrderId,
        }
      } catch (error: any) {
        logger.error('orders/:id/cancel failed', { error: error?.message })
        return reply.status(500).send({ error: error?.message ?? 'cancel failed' })
      }
    },
  )

  // FU.1 — per-line VAT rate override (Italian compliance).
  // Lets the operator flip a line from the default 22% to 10% or
  // 4% when the catalog mix doesn't fit the standard rate
  // (cycling apparel can be 10%, essentials 4%). Restricted to
  // IT-marketplace orders — non-IT lines have no Italian VAT
  // treatment to override.
  //
  // FU.4 — 0 added to the allowed list. Used for VAT-exempt
  // lines (cross-border B2B to non-EU; intra-EU reverse
  // charge). When the exempt portion of the order exceeds
  // €77.47, F.3/F.4 add €2 bollo virtuale per Italian law.
  app.patch('/api/orders/:id/items/:itemId/vat', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string }
      const body = request.body as { rate?: number | null }
      const allowed = [0, 4, 10, 22, null]
      const rate = body.rate ?? null
      if (!allowed.includes(rate as any)) {
        return reply.code(400).send({
          error: 'rate must be 0, 4, 10, 22, or null',
        })
      }
      const item = await prisma.orderItem.findFirst({
        where: { id: itemId, orderId: id },
        select: { id: true, order: { select: { marketplace: true } } },
      })
      if (!item) return reply.code(404).send({ error: 'Order item not found' })
      if (item.order?.marketplace !== 'IT') {
        return reply.code(400).send({
          error: 'VAT override only applies to IT-marketplace orders',
        })
      }
      const updated = await prisma.orderItem.update({
        where: { id: itemId },
        data: { itVatRatePct: rate },
        select: { id: true, itVatRatePct: true },
      })
      return {
        id: updated.id,
        itVatRatePct: updated.itVatRatePct == null ? null : Number(updated.itVatRatePct),
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // F.3 — Italian invoice + packing slip as printable HTML.
  // Operator opens in a new tab + prints to PDF via the browser
  // dialog; saves us a 5+ MB PDF library dep. Italian fiscal
  // authorities accept "PDF generated via print dialog from a
  // structured template" — what matters for compliance is the
  // data, not the renderer.
  app.get('/api/orders/:id/invoice.html', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { invoiceHtml, safeRender } = await import('../services/fiscal-pdf.service.js')
    const html = await safeRender(() => invoiceHtml(id), 'invoice')
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return reply.send(html)
  })

  app.get('/api/orders/:id/packing-slip.html', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { packingSlipHtml, safeRender } = await import('../services/fiscal-pdf.service.js')
    const html = await safeRender(() => packingSlipHtml(id), 'packing-slip')
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return reply.send(html)
  })

  // F.4 — FatturaPA XML download (B2B only). Operator manually
  // uploads to whichever commercial SDI intermediary they use
  // (Aruba / Fatture in Cloud / TeamSystem). Real auto-dispatch is
  // env-flag-gated; see dispatchToSdi below.
  app.get('/api/orders/:id/fattura-pa.xml', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { generateFatturaPaXml } = await import('../services/fattura-pa.service.js')
      const result = await generateFatturaPaXml(id)
      reply.header('Content-Type', 'application/xml; charset=utf-8')
      reply.header(
        'Content-Disposition',
        `attachment; filename="${result.filename}"`,
      )
      return reply.send(result.xml)
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'failed' })
    }
  })

  app.post('/api/orders/:id/fattura-pa/dispatch', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const { dispatchToSdi } = await import('../services/fattura-pa.service.js')
      const result = await dispatchToSdi(id)
      return result
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'failed' })
    }
  })

  // O.23b — CSV export. Mirrors the GET /api/orders filter shape so
  // an "Export current view" frontend button can pass the same query
  // string and get back exactly the rows the operator sees. Capped
  // at 10,000 rows — beyond that operators should use a real BI
  // export pipeline (BigQuery / Looker), not a one-shot CSV.
  app.get('/api/orders/export.csv', async (request, reply) => {
    try {
      const q = request.query as any
      const search = (q.search ?? '').trim()
      const channels = csvParam(q.channel)
      const marketplaces = csvParam(q.marketplace)
      const statuses = csvParam(q.status)
      const fulfillment = csvParam(q.fulfillment)
      const reviewStatus = csvParam(q.reviewStatus)
      const customerEmail = (q.customerEmail ?? '').trim() || null
      const dateFrom = q.dateFrom ? new Date(q.dateFrom) : null
      const dateTo = q.dateTo ? new Date(q.dateTo) : null
      const reviewEligible = q.reviewEligible === 'true'

      const where: any = {}
      if (channels && channels.length) where.channel = { in: channels }
      if (marketplaces && marketplaces.length) where.marketplace = { in: marketplaces }
      if (statuses && statuses.length) where.status = { in: statuses }
      if (fulfillment && fulfillment.length) where.fulfillmentMethod = { in: fulfillment }
      if (customerEmail) where.customerEmail = { contains: customerEmail, mode: 'insensitive' }
      if (dateFrom || dateTo) {
        where.purchaseDate = {}
        if (dateFrom) where.purchaseDate.gte = dateFrom
        if (dateTo) where.purchaseDate.lte = dateTo
      }
      if (search) {
        where.OR = [
          { channelOrderId: { contains: search, mode: 'insensitive' } },
          { customerName: { contains: search, mode: 'insensitive' } },
          { customerEmail: { contains: search, mode: 'insensitive' } },
          { items: { some: { sku: { contains: search, mode: 'insensitive' } } } },
        ]
      }
      if (reviewStatus && reviewStatus.length) {
        where.reviewRequests = { some: { status: { in: reviewStatus } } }
      }
      if (reviewEligible) {
        where.deliveredAt = { not: null }
      }

      const orders = await prisma.order.findMany({
        where,
        orderBy: { purchaseDate: 'desc' },
        take: 10_000,
        select: {
          id: true,
          channel: true,
          marketplace: true,
          channelOrderId: true,
          status: true,
          fulfillmentMethod: true,
          totalPrice: true,
          currencyCode: true,
          customerName: true,
          customerEmail: true,
          purchaseDate: true,
          paidAt: true,
          shippedAt: true,
          deliveredAt: true,
          cancelledAt: true,
          shipByDate: true,
          isPrime: true,
          shippingAddress: true,
        },
      })

      const headers = [
        'channel',
        'marketplace',
        'channelOrderId',
        'status',
        'fulfillmentMethod',
        'totalPrice',
        'currencyCode',
        'customerName',
        'customerEmail',
        'shipCountry',
        'shipCity',
        'shipPostalCode',
        'purchaseDate',
        'paidAt',
        'shippedAt',
        'deliveredAt',
        'cancelledAt',
        'shipByDate',
        'isPrime',
      ]

      const rows = orders.map((o) => {
        const addr = (o.shippingAddress ?? {}) as any
        const country =
          addr.CountryCode ?? addr.countryCode ?? addr.country_code ?? addr.country ?? ''
        const city = addr.City ?? addr.city ?? ''
        const postal = addr.PostalCode ?? addr.postal_code ?? addr.postalCode ?? ''
        return [
          o.channel,
          o.marketplace ?? '',
          o.channelOrderId,
          o.status,
          o.fulfillmentMethod ?? '',
          Number(o.totalPrice).toFixed(2),
          o.currencyCode ?? 'EUR',
          o.customerName,
          o.customerEmail,
          country,
          city,
          postal,
          o.purchaseDate,
          o.paidAt,
          o.shippedAt,
          o.deliveredAt,
          o.cancelledAt,
          o.shipByDate,
          o.isPrime ?? '',
        ]
      })

      const body = csvDocument(headers, rows)
      const filename = `orders-${new Date().toISOString().slice(0, 10)}.csv`
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      // Reply.send used here because returning the string would let
      // Fastify's JSON serialiser interfere with the CSV body.
      return reply.send(body)
    } catch (err: any) {
      logger.error('orders export.csv failed', { error: err?.message })
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // O.6 — SSE channel for /orders. Mirrors the outbound bus pattern
  // at /api/fulfillment/outbound/events. Carries order.created /
  // updated / cancelled + return.created so OrdersWorkspace can
  // refresh its list/facets/stats without polling. Heartbeat every
  // 25s defeats most reverse-proxy idle timeouts; client EventSource
  // auto-reconnects on transient drops.
  app.get('/api/orders/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(
      `event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`,
    )

    const { subscribeOrderEvents } = await import(
      '../services/order-events.service.js'
    )
    const send = (event: any) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // Connection dead — cleanup runs in the close handler.
      }
    }

    const unsubscribe = subscribeOrderEvents(send)
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
}
