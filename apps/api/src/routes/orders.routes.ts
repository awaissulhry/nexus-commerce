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
import { sseResponseHeaders } from '../lib/sse.js'
import { logger } from '../utils/logger.js'
import { ingestMockOrders, shipOrder } from '../services/order-ingestion.service.js'
import prisma from '../db.js'
import { resolveConnection } from '../services/connection-resolver.service.js'
import { csvDocument } from '../lib/csv.js'
import { csvParam, listOrders, orderDetail, orderFinancials, orderTimeline, safeNum } from '../services/orders/order-read.service.js'
import { addOrderNote, deleteOrderNote, markOrderDelivered, updateOrderNote } from '../services/orders/order-update.service.js'
import { enqueueTrackingUpload } from '../services/fulfillment/tracking-upload.service.js'
import { cancelOrder } from '../services/order-cancellation/cancel-order.service.js'

const ALL_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL'] as const


// Single-tenant: derive a stable userId from the request. When auth lands
// this becomes req.user.id. Mirrors products-catalog.routes' userIdFor.
function userIdFor(_req: any): string {
  return 'default-user'
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
  // LS.3 — live-sync health probe for the freshness badge on /orders.
  // Reports the most recent push-notification (SQS) timestamp + cron
  // last-update + whether the SQS poll is gated ON. The UI uses this
  // to render a green/amber/rose pill telling operators whether
  // Amazon push is flowing.
  app.get('/api/orders/sync-health', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=10')
      const [lastPush, lastCron] = await Promise.all([
        // Most recent SQS message persisted as a WebhookEvent. Only
        // ORDER_CHANGE notifications land here today.
        prisma.webhookEvent.findFirst({
          where: { channel: 'AMAZON' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, eventType: true, isProcessed: true },
        }),
        // Best-effort cron heartbeat: latest Order.updatedAt for
        // Amazon. The 15-min cron touches at least one row per run
        // (the rolling cursor), so this is a reasonable proxy for
        // "the polling pipeline is alive".
        prisma.order.findFirst({
          where: { channel: 'AMAZON' },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true },
        }),
      ])
      return {
        push: {
          enabled: process.env.NEXUS_ENABLE_AMAZON_SQS_POLL === '1',
          queueConfigured: !!process.env.AMAZON_SQS_QUEUE_URL,
          lastEventAt: lastPush?.createdAt?.toISOString() ?? null,
          lastEventType: lastPush?.eventType ?? null,
        },
        cron: {
          enabled: process.env.NEXUS_ENABLE_AMAZON_ORDERS_CRON === '1',
          lastUpdateAt: lastCron?.updatedAt?.toISOString() ?? null,
        },
        checkedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      logger.error('[ORDERS API] sync-health failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  app.get('/api/orders/stats', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      // OX.16 — stats counts now respect the same scope-level filters
      // the list endpoint reads (date range, fulfillment, channel,
      // marketplace). Without this the status tab numbers misled
      // operators: "30 days" date range would still show "2152 shipped"
      // (lifetime) above a list of 47 shipped (last 30 days).
      //
      // We intentionally do NOT honour `status` or `noInvoice` params
      // here — those ARE the tabs, so the counts must stay unfiltered
      // along that axis to remain meaningful.
      const q = request.query as any
      const channels = csvParam(q.channel)
      const marketplaces = csvParam(q.marketplace)
      const fulfillment = csvParam(q.fulfillment)
      const dateFrom = q.dateFrom ? new Date(q.dateFrom) : null
      const dateTo = q.dateTo ? new Date(q.dateTo) : null
      const dateRangePreset = (q.dateRange ?? '').toString().trim() as
        | ''
        | '24h'
        | '7d'
        | '30d'
        | '90d'
      let presetFrom: Date | null = null
      switch (dateRangePreset) {
        case '24h': presetFrom = new Date(Date.now() - 24 * 60 * 60 * 1000); break
        case '7d': presetFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); break
        case '30d': presetFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); break
        case '90d': presetFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); break
      }
      const effectiveFrom = dateFrom ?? presetFrom
      const baseWhere: any = { deletedAt: null }
      if (channels && channels.length) baseWhere.channel = { in: channels }
      if (marketplaces && marketplaces.length) baseWhere.marketplace = { in: marketplaces }
      if (fulfillment && fulfillment.length) baseWhere.fulfillmentMethod = { in: fulfillment }
      if (effectiveFrom || dateTo) {
        baseWhere.purchaseDate = {}
        if (effectiveFrom) baseWhere.purchaseDate.gte = effectiveFrom
        if (dateTo) baseWhere.purchaseDate.lte = dateTo
      }

      // OX.2 — counts mirror the Amazon-style status tabs:
      //   Pending    → PENDING / AWAITING_PAYMENT
      //   Unshipped  → PROCESSING / ON_HOLD (paid + ready or held)
      //   Shipped    → SHIPPED / PARTIALLY_SHIPPED / DELIVERED
      //   Cancelled  → CANCELLED / REFUNDED / RETURNED
      //   NoInvoice  → marketplace=IT + status NOT IN (PENDING, CANCELLED, …)
      //                AND fiscalInvoice IS NULL (Italian compliance gap)
      // OX.17 — "All" total excludes cancelled/refunded/returned so the
      // headline number reflects orders that need attention, not the
      // lifetime count. The dedicated Cancelled tab still surfaces them.
      const TERMINAL_NEGATIVE = ['CANCELLED', 'REFUNDED', 'RETURNED']
      const [total, pending, unshipped, shipped, cancelled, delivered, noInvoice] = await Promise.all([
        prisma.order.count({ where: { ...baseWhere, status: { notIn: TERMINAL_NEGATIVE as any } } }),
        prisma.order.count({ where: { ...baseWhere, status: { in: ['PENDING', 'AWAITING_PAYMENT'] } } }),
        prisma.order.count({ where: { ...baseWhere, status: { in: ['PROCESSING', 'ON_HOLD'] } } }),
        prisma.order.count({ where: { ...baseWhere, status: { in: ['SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'] } } }),
        prisma.order.count({ where: { ...baseWhere, status: { in: TERMINAL_NEGATIVE as any } } }),
        prisma.order.count({ where: { ...baseWhere, status: 'DELIVERED' } }),
        prisma.order.count({
          where: {
            ...baseWhere,
            marketplace: 'IT',
            status: { in: ['PROCESSING', 'SHIPPED', 'PARTIALLY_SHIPPED', 'DELIVERED'] },
            fiscalInvoice: null,
          },
        }),
      ])
      // Find the most recently PLACED order (purchaseDate), not the
      // most recently INSERTED row. With backfilled data the last-
      // inserted row could carry any historical purchaseDate.
      const last = await prisma.order.findFirst({
        orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
        select: { createdAt: true, purchaseDate: true },
      })
      return {
        total, pending, unshipped, shipped, cancelled, delivered, noInvoice,
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
      // 07 O4 — the list lives in services/orders/order-read.service.ts (one read for the page and Claude).
      return await listOrders(request.query as any)
    } catch (error: any) {
      logger.error('[ORDERS API] list failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/facets — distinct channels, marketplaces, tags
  // OX.16 follow-up: respects the same scope filters as /api/orders/stats
  // (date range + channel + marketplace + fulfilment, EXCEPT each facet
  // is computed without filtering on its own axis — so the FBM/FBA
  // facet ignores ?fulfillment= and the marketplace facet ignores
  // ?marketplace= — otherwise picking FBM would make FBA show 0).
  app.get('/api/orders/facets', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const q = request.query as any
      const channels = csvParam(q.channel)
      const marketplaces = csvParam(q.marketplace)
      const fulfillment = csvParam(q.fulfillment)
      const dateFrom = q.dateFrom ? new Date(q.dateFrom) : null
      const dateTo = q.dateTo ? new Date(q.dateTo) : null
      const dateRangePreset = (q.dateRange ?? '').toString().trim() as
        | '' | '24h' | '7d' | '30d' | '90d'
      let presetFrom: Date | null = null
      switch (dateRangePreset) {
        case '24h': presetFrom = new Date(Date.now() - 24 * 60 * 60 * 1000); break
        case '7d': presetFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); break
        case '30d': presetFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); break
        case '90d': presetFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); break
      }
      const effectiveFrom = dateFrom ?? presetFrom
      // OX.17 — facets exclude cancelled rows so segment counts match
      // the "All" headline. The Cancelled status tab still works.
      const baseWhere: any = { deletedAt: null, status: { notIn: ['CANCELLED', 'REFUNDED', 'RETURNED'] } }
      if (effectiveFrom || dateTo) {
        baseWhere.purchaseDate = {}
        if (effectiveFrom) baseWhere.purchaseDate.gte = effectiveFrom
        if (dateTo) baseWhere.purchaseDate.lte = dateTo
      }
      // Per-axis WHERE: each facet is computed without its own axis
      // applied — so picking FBM doesn't zero out FBA's count and
      // operators can switch between them without losing visibility.
      const channelWhere: any = { ...baseWhere }
      if (marketplaces && marketplaces.length) channelWhere.marketplace = { in: marketplaces }
      if (fulfillment && fulfillment.length) channelWhere.fulfillmentMethod = { in: fulfillment }
      const marketplaceWhere: any = { ...baseWhere, marketplace: { not: null } }
      if (channels && channels.length) marketplaceWhere.channel = { in: channels }
      if (fulfillment && fulfillment.length) marketplaceWhere.fulfillmentMethod = { in: fulfillment }
      const fulfillmentWhere: any = { ...baseWhere, fulfillmentMethod: { not: null } }
      if (channels && channels.length) fulfillmentWhere.channel = { in: channels }
      if (marketplaces && marketplaces.length) fulfillmentWhere.marketplace = { in: marketplaces }

      const [channelGroups, marketplaceGroups, fulfillmentGroups] = await Promise.all([
        prisma.order.groupBy({ by: ['channel'], where: channelWhere, _count: true }),
        prisma.order.groupBy({ by: ['marketplace'], where: marketplaceWhere, _count: true }),
        prisma.order.groupBy({ by: ['fulfillmentMethod'], where: fulfillmentWhere, _count: true }),
      ])
      return {
        channels: channelGroups.map((c) => ({ value: c.channel, count: c._count })),
        marketplaces: marketplaceGroups.filter((m) => m.marketplace).map((m) => ({ value: m.marketplace!, count: m._count })),
        fulfillment: fulfillmentGroups.filter((f) => f.fulfillmentMethod).map((f) => ({ value: f.fulfillmentMethod!, count: f._count })),
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/:id — full detail with relations ─────────────
  app.get('/api/orders/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const detail = await orderDetail(id)
      if (!detail) return reply.status(404).send({ error: 'Order not found' })
      return detail
    } catch (error: any) {
      logger.error('[ORDERS API] detail failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/:id/timeline — synthesized event log ─────────
  app.get('/api/orders/:id/timeline', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const timeline = await orderTimeline(id)
      if (!timeline) return reply.status(404).send({ error: 'Order not found' })
      return timeline
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── GET /api/orders/:id/financials — gross/fees/net rollup ───────
  app.get('/api/orders/:id/financials', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      return await orderFinancials(id)
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

  // ── POST /api/orders/reclassify-already-solicited ────────────────
  // RV.2.5 hotfix — sweep ReviewRequest rows where the failure was Amazon's
  // duplicate-protection (HTTP 400/403 + "already") and re-classify them as
  // SKIPPED. The current data has ~51 such rows from the first cron run
  // before the classification fix landed. Run once.
  app.post('/api/orders/reclassify-already-solicited', async (request, reply) => {
    try {
      const result = await prisma.reviewRequest.updateMany({
        where: {
          status: 'FAILED',
          AND: [
            { errorMessage: { contains: 'already', mode: 'insensitive' } },
            { errorMessage: { contains: 'HTTP 40', mode: 'insensitive' } },
          ],
        },
        data: {
          status: 'SKIPPED',
          suppressedReason: 'Amazon already solicited a review for this order',
          providerResponseCode: 'ALREADY_SOLICITED',
          errorMessage: null,
        },
      })
      return { ok: true, updated: result.count }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── POST /api/orders/backfill-delivered-heuristic ────────────────
  // RV.2.3 (server-side variant) — find Amazon FBA SHIPPED orders with
  // shippedAt + 3 business days in the past, fill deliveredAt + source
  // = HEURISTIC_FBA_3D. Idempotent (deliveredAt IS NULL filter). Caller
  // can hit this once after RV.2 deploy; the same heuristic continues
  // to run inline on future sync upserts.
  app.post('/api/orders/backfill-delivered-heuristic', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { dryRun?: boolean; limit?: number }
      const dryRun = body.dryRun === true
      const limit = Math.min(Math.max(body.limit ?? 5000, 1), 10000)

      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      const candidates = await prisma.order.findMany({
        where: {
          channel: 'AMAZON',
          fulfillmentMethod: 'FBA',
          deliveredAt: null,
          status: { in: ['SHIPPED', 'PARTIALLY_SHIPPED'] },
          shippedAt: { not: null, lte: fiveDaysAgo },
        },
        select: { id: true, channelOrderId: true, shippedAt: true, marketplace: true },
        orderBy: { shippedAt: 'asc' },
        take: limit,
      })

      const now = Date.now()
      const addBusinessDays = (date: Date, days: number): Date => {
        const out = new Date(date.getTime())
        let added = 0
        while (added < days) {
          out.setDate(out.getDate() + 1)
          const dow = out.getDay()
          if (dow !== 0 && dow !== 6) added++
        }
        return out
      }

      let updated = 0
      let stillTooSoon = 0
      const sample: any[] = []
      for (const o of candidates) {
        if (!o.shippedAt) continue
        const projected = addBusinessDays(o.shippedAt, 3)
        if (projected.getTime() > now) { stillTooSoon++; continue }
        if (!dryRun) {
          await prisma.order.update({
            where: { id: o.id },
            data: { deliveredAt: projected, deliveredAtSource: 'HEURISTIC_FBA_3D' },
          })
        }
        updated++
        if (sample.length < 5) {
          sample.push({
            id: o.id,
            channelOrderId: o.channelOrderId,
            marketplace: o.marketplace,
            shippedAt: o.shippedAt.toISOString(),
            projectedDeliveredAt: projected.toISOString(),
          })
        }
      }
      return {
        ok: true,
        dryRun,
        candidates: candidates.length,
        updated,
        stillTooSoon,
        sample,
      }
    } catch (error: any) {
      return reply.status(500).send({ error: error.message })
    }
  })

  // ── POST /api/orders/:id/mark-delivered ──────────────────────────
  // RV.2.4 — operator manual delivery override. Writes deliveredAt with
  // source=MANUAL so the higher-authority guard in amazon-orders.service
  // never overwrites it. Lets ops unblock the review pipeline for an
  // order Amazon hasn't yet marked Delivered themselves.
  //
  // Body: { deliveredAt?: ISO date string } — defaults to now() if omitted.
  app.post('/api/orders/:id/mark-delivered', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as { deliveredAt?: string }
      let deliveredAt: Date
      if (body.deliveredAt) {
        const d = new Date(body.deliveredAt)
        if (Number.isNaN(d.getTime())) return reply.status(400).send({ error: 'invalid deliveredAt' })
        if (d.getTime() > Date.now() + 60_000) return reply.status(400).send({ error: 'deliveredAt cannot be in the future' })
        deliveredAt = d
      } else {
        deliveredAt = new Date()
      }
      // 07 O7 — the write lives in services/orders/order-update.service.ts (the page and Claude write one way).
      const order = await markOrderDelivered(id, deliveredAt)
      if (!order) return reply.status(404).send({ error: 'Order not found' })
      return { ok: true, order }
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
      const shippedAt = new Date()
      const pending = await prisma.order.findMany({ where: { id: { in: ids }, status: { in: ['PENDING'] } }, select: { id: true } })
      const result = await prisma.order.updateMany({
        where: { id: { in: ids }, status: { in: ['PENDING'] } },
        data: { status: 'SHIPPED', shippedAt },
      })
      // 07 O9 — the tracking of these orders' MANUAL-carrier shipments reaches the channel (a Sendcloud parcel's comes
      // with the carrier's first scan). An order with no shipment has no tracking to send.
      const manual = await prisma.shipment.findMany({
        where: { orderId: { in: pending.map((o) => o.id) }, carrierCode: 'MANUAL', status: { not: 'CANCELLED' }, trackingNumber: { not: null } },
        select: { id: true, trackingNumber: true, trackingUrl: true },
      })
      for (const shipment of manual) {
        await enqueueTrackingUpload(shipment.id, { shippedAt, trackingNumber: shipment.trackingNumber, trackingUrl: shipment.trackingUrl, carrierCode: 'MANUAL' }, { explicit: true })
      }
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
        // 07 O10 — the cancel lives in services/order-cancellation/cancel-order.service.ts (the page and Claude cancel one way).
        const answer = await cancelOrder(request.params.id, request.body?.reason, request.log)
        return reply.status(answer.status).send(answer.body)
      } catch (error: any) {
        logger.error('orders/:id/cancel failed', { error: error?.message })
        return reply.status(500).send({ error: error?.message ?? 'cancel failed' })
      }
    },
  )

  // AU.5 — Order-level notes CRUD (mirrors CustomerNote pattern).
  app.get('/api/orders/:id/notes', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const notes = await prisma.orderNote.findMany({
        where: { orderId: id },
        orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      })
      return { notes }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' })
    }
  })

  app.post('/api/orders/:id/notes', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { body?: string; pinned?: boolean; authorEmail?: string }
      const added = await addOrderNote(id, body)
      if (added.status === 'invalid') return reply.code(400).send({ error: 'body required' })
      if (added.status === 'not_found') return reply.code(404).send({ error: 'Order not found' })
      return added.note
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' })
    }
  })

  app.patch('/api/orders/:id/notes/:noteId', async (request, reply) => {
    try {
      const { id, noteId } = request.params as { id: string; noteId: string }
      const body = request.body as { body?: string; pinned?: boolean }
      const updated = await updateOrderNote(id, noteId, body)
      if (!updated) return reply.code(404).send({ error: 'Note not found' })
      return updated
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' })
    }
  })

  app.delete('/api/orders/:id/notes/:noteId', async (request, reply) => {
    try {
      const { id, noteId } = request.params as { id: string; noteId: string }
      if (!(await deleteOrderNote(id, noteId))) return reply.code(404).send({ error: 'Note not found' })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' })
    }
  })

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

  // OX.14 — single-order JSON export. Operator-triggered download of
  // the full order payload (items + shipments + returns + financials
  // + fiscal invoice + routing decisions + tags + review requests).
  // Useful for support escalations, accounting reconciliation, or
  // archiving outside Nexus. Mirrors the detail endpoint payload but
  // serves with Content-Disposition: attachment.
  app.get('/api/orders/:id/export.json', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          items: { include: { product: { select: { id: true, sku: true, name: true, amazonAsin: true } } } },
          financialTransactions: { orderBy: { transactionDate: 'desc' } },
          shipments: { include: { items: true, warehouse: { select: { code: true, name: true } } } },
          returns: { include: { items: true } },
          reviewRequests: true,
          tags: { include: { tag: true } },
          routingDecisions: { orderBy: { createdAt: 'desc' } },
          fiscalInvoice: true,
          notes: true,
        },
      })
      if (!order) return reply.status(404).send({ error: 'Order not found' })
      reply.header('Content-Type', 'application/json; charset=utf-8')
      reply.header(
        'Content-Disposition',
        `attachment; filename="order-${order.channelOrderId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json"`,
      )
      return reply.send(JSON.stringify(order, null, 2))
    } catch (error: any) {
      logger.error('[ORDERS API] export.json failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // OX.5 — bulk packing slips. Operator selects N orders, hits "Print
  // packing slips", we return one concatenated HTML doc where each
  // slip starts on a new physical page (CSS page-break-after). They
  // print to PDF via the browser dialog (same pattern as the single-
  // order endpoint — keeps us out of the puppeteer/pdf-lib hole).
  // GET /api/orders/bulk-packing-slips.html?ids=id1,id2,id3
  app.get('/api/orders/bulk-packing-slips.html', async (request, reply) => {
    try {
      const q = request.query as any
      const idsRaw = typeof q.ids === 'string' ? q.ids : ''
      const ids = idsRaw.split(',').map((s: string) => s.trim()).filter(Boolean).slice(0, 200)
      if (ids.length === 0) {
        reply.header('Content-Type', 'text/html; charset=utf-8')
        return reply.send('<html><body><h1>No orders selected</h1></body></html>')
      }
      const { packingSlipHtml, safeRender } = await import('../services/fiscal-pdf.service.js')
      const slips: string[] = []
      for (const id of ids) {
        const html = await safeRender(() => packingSlipHtml(id), 'packing-slip')
        slips.push(html)
      }
      // Strip <html>/<body> wrappers from inner docs and stitch with
      // a page-break wrapper so one print job → one slip per page.
      const inner = slips
        .map((h) => {
          const body = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? h
          return `<div class="packing-slip-page">${body}</div>`
        })
        .join('\n')
      const combined = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Packing Slips — ${ids.length} order${ids.length === 1 ? '' : 's'}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 0; }
    .packing-slip-page { page-break-after: always; padding: 16mm; }
    .packing-slip-page:last-child { page-break-after: auto; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print" style="padding:12px 16px;background:#0f172a;color:white;display:flex;align-items:center;gap:12px;">
    <strong>${ids.length} packing slip${ids.length === 1 ? '' : 's'} ready</strong>
    <span style="opacity:0.7;">Use your browser's Print dialog (Cmd/Ctrl+P) to save as PDF.</span>
    <button onclick="window.print()" style="margin-left:auto;padding:6px 12px;background:white;color:#0f172a;border:none;border-radius:4px;cursor:pointer;font-weight:600;">Print now</button>
  </div>
  ${inner}
</body>
</html>`
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.send(combined)
    } catch (error: any) {
      logger.error('[ORDERS API] bulk-packing-slips failed', { message: error.message })
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.status(500).send(`<html><body><h1>Bulk packing slip render failed</h1><pre>${error.message}</pre></body></html>`)
    }
  })

  // OX.12 — cross-channel buyer profile. Aggregates all orders we have
  // for a given email across Amazon + eBay + Shopify so the drawer can
  // show lifetime value, return rate, last contact, channel mix, and
  // a recent-order list without doing N+1 reads on the client.
  //
  // Caveats:
  //   - Amazon anonymises buyer emails (@marketplace.amazon.*) so the
  //     cross-channel match only fires when the operator has a real
  //     email (eBay/Shopify) or a stable Amazon alias for the same
  //     buyer. We don't try to fuzz across aliases.
  //   - currentOrderId is excluded from the "other orders" list when
  //     supplied so the drawer doesn't duplicate the page the operator
  //     is already viewing.
  app.get('/api/orders/buyer-profile', async (request, reply) => {
    try {
      const q = request.query as { email?: string; excludeOrderId?: string }
      const email = (q.email ?? '').trim()
      if (!email) return reply.status(400).send({ error: 'email required' })
      reply.header('Cache-Control', 'private, max-age=30')

      const baseWhere = { customerEmail: email, deletedAt: null } as any

      const [allOrders, returnsCount, refundedOrders, firstOrder, lastOrder] = await Promise.all([
        prisma.order.findMany({
          where: baseWhere,
          select: {
            id: true,
            channel: true,
            marketplace: true,
            channelOrderId: true,
            totalPrice: true,
            currencyCode: true,
            status: true,
            purchaseDate: true,
            createdAt: true,
            customerName: true,
          },
          orderBy: { purchaseDate: 'desc' },
          take: 50,
        }),
        prisma.return.count({ where: { order: baseWhere } }),
        prisma.order.count({
          where: {
            ...baseWhere,
            status: { in: ['REFUNDED', 'RETURNED'] },
          },
        }),
        prisma.order.findFirst({
          where: baseWhere,
          orderBy: { purchaseDate: 'asc' },
          select: { purchaseDate: true, createdAt: true },
        }),
        prisma.order.findFirst({
          where: baseWhere,
          orderBy: { purchaseDate: 'desc' },
          select: { purchaseDate: true, createdAt: true },
        }),
      ])

      const orderCount = allOrders.length
      const ltv = allOrders.reduce((s, o) => s + Number(o.totalPrice ?? 0), 0)
      const aov = orderCount > 0 ? ltv / orderCount : 0
      const refundRate = orderCount > 0 ? refundedOrders / orderCount : 0
      const channelBreakdown = allOrders.reduce(
        (acc: Record<string, number>, o) => {
          acc[o.channel] = (acc[o.channel] ?? 0) + 1
          return acc
        },
        {},
      )

      const filteredOrders = q.excludeOrderId
        ? allOrders.filter((o) => o.id !== q.excludeOrderId)
        : allOrders

      return {
        email,
        customerName: allOrders[0]?.customerName ?? null,
        orderCount,
        ltv,
        aov,
        refundedOrders,
        refundRate,
        returnsCount,
        firstOrderAt: firstOrder?.purchaseDate ?? firstOrder?.createdAt ?? null,
        lastOrderAt: lastOrder?.purchaseDate ?? lastOrder?.createdAt ?? null,
        channels: channelBreakdown,
        orders: filteredOrders.map((o) => ({
          ...o,
          totalPrice: Number(o.totalPrice),
        })),
      }
    } catch (error: any) {
      logger.error('[ORDERS API] buyer-profile failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
  })

  // OX.5 — bulk-issue invoices. Loop selected IDs; for each, call
  // assignInvoiceNumber() which is idempotent (no-op if a FiscalInvoice
  // already exists). Returns per-order outcome so the UI can report
  // newly-assigned vs already-issued vs failed.
  app.post('/api/orders/bulk-issue-invoices', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { orderIds?: string[] }
      const ids = (body.orderIds ?? []).slice(0, 200)
      if (ids.length === 0) return reply.status(400).send({ error: 'orderIds required' })
      // An invoice number is taken only for a business whose invoice can be printed: its name, full address and P.IVA
      // (Settings › Company). Without them no number is taken (2026-10-02; a business without them gets no invoices).
      const { MissingBusinessIdentityError, requireInvoiceIdentity } = await import('../services/business-identity.service.js')
      try {
        await requireInvoiceIdentity('the invoice')
      } catch (identityError) {
        if (identityError instanceof MissingBusinessIdentityError) return reply.status(400).send({ error: identityError.message })
        throw identityError
      }
      const { assignInvoiceNumber } = await import('../services/fiscal-invoice.service.js')
      const results = {
        scanned: ids.length,
        newlyIssued: 0,
        alreadyIssued: 0,
        failed: 0,
        errors: [] as Array<{ orderId: string; error: string }>,
      }
      for (const id of ids) {
        try {
          const out = await assignInvoiceNumber(id)
          if (out.newlyAssigned) results.newlyIssued += 1
          else results.alreadyIssued += 1
        } catch (e: any) {
          results.failed += 1
          results.errors.push({ orderId: id, error: e?.message ?? String(e) })
        }
      }
      return { success: true, ...results }
    } catch (error: any) {
      logger.error('[ORDERS API] bulk-issue-invoices failed', { message: error.message })
      return reply.status(500).send({ error: error.message })
    }
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

  // FU.5 — B2C corrispettivi telematici (daily summary). Distinct
  // from FatturaPA: B2C sales aggregate by day and submit to RT,
  // not per-transaction to SDI.
  app.get('/api/corrispettivi/daily/:date.xml', async (request, reply) => {
    try {
      const { date } = request.params as { date: string }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      const { generateCorrispettiviDaily } = await import(
        '../services/corrispettivi.service.js'
      )
      const result = await generateCorrispettiviDaily(date)
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

  app.get('/api/corrispettivi/daily/:date/preview', async (request, reply) => {
    try {
      const { date } = request.params as { date: string }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      const { generateCorrispettiviDaily } = await import(
        '../services/corrispettivi.service.js'
      )
      const result = await generateCorrispettiviDaily(date)
      const { xml, ...summary } = result
      return summary
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'failed' })
    }
  })

  app.post('/api/corrispettivi/daily/:date/dispatch', async (request, reply) => {
    try {
      const { date } = request.params as { date: string }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.code(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      const { dispatchCorrispettiviDaily } = await import(
        '../services/corrispettivi.service.js'
      )
      const result = await dispatchCorrispettiviDaily(date)
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
      // OX.16 — "ALL" is the sentinel the StatusTabs uses to mark
      // "user explicitly chose All" (distinct from no status param,
      // which triggers the default-to-Unshipped redirect). Filter it
      // out here so it doesn't reach the WHERE clause.
      const statuses = csvParam(q.status)?.filter((s: string) => s !== 'ALL')
      const fulfillment = csvParam(q.fulfillment)
      const reviewStatus = csvParam(q.reviewStatus)
      const customerEmail = (q.customerEmail ?? '').trim() || null
      const dateFrom = q.dateFrom ? new Date(q.dateFrom) : null
      const dateTo = q.dateTo ? new Date(q.dateTo) : null
      const reviewEligible = q.reviewEligible === 'true'
      const showDeleted = q.deleted === 'true'

      const where: any = {}
      // RB.1 — CSV export respects the recycle-bin scope so operators
      // exporting from the bin get the deleted rows (and vice versa).
      where.deletedAt = showDeleted ? { not: null } : null
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
  //
  // RT.8 — accepts ?since=<ms> on reconnect. Events newer than the
  // given timestamp are flushed before live streaming resumes so a
  // browser tab that briefly lost connectivity gets caught up
  // without falling back to a full list re-fetch. Buffer is in-
  // memory (last 100 events, 5-min TTL); longer gaps fall through
  // to the existing re-fetch path automatically.
  app.get('/api/orders/events', async (request, reply) => {
    reply.raw.writeHead(200, sseResponseHeaders(request.headers.origin as string | undefined))
    reply.raw.write(
      `event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`,
    )

    const { subscribeOrderEvents, replayOrderEventsSince } = await import(
      '../services/order-events.service.js'
    )
    const send = (event: any) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // Connection dead — cleanup runs in the close handler.
      }
    }

    // RT.8 — replay missed events for a reconnecting client. We do
    // this BEFORE subscribing so any events that arrive during
    // replay flush still get streamed (subscribeOrderEvents handles
    // them; the replay-vs-live ordering is fine because each event
    // is idempotent on the client — subscribers re-fetch on receipt).
    const sinceRaw = (request.query as any)?.since
    const sinceMs = sinceRaw ? Number(sinceRaw) : NaN
    if (Number.isFinite(sinceMs) && sinceMs > 0) {
      const replayed = replayOrderEventsSince(sinceMs)
      for (const event of replayed) send(event)
      if (replayed.length > 0) {
        // Signal end-of-replay so the client can flush any buffered
        // state before resuming. Type kept distinct from real events
        // so existing listeners ignore it.
        reply.raw.write(
          `event: replay.done\ndata: ${JSON.stringify({
            ts: Date.now(),
            count: replayed.length,
          })}\n\n`,
        )
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

  // ═══════════════════════════════════════════════════════════════════
  // RB.1 — SOFT-DELETE + RESTORE + HARD-DELETE (Order)
  //
  // Mirrors the /products bulk pattern (products-catalog.routes.ts
  // ~1460–1710). Soft-delete sets Order.deletedAt = now(); restore
  // clears it back to null; hard-delete only acts on rows already
  // in the bin and lets the schema's onDelete:Cascade fan-out clean
  // up OrderItem / OrderNote / OrderTag / OrderRiskScore / FiscalInvoice
  // / RoutingDecision / FinancialTransaction / MCFShipment / ReviewRequest.
  // Shipment.orderId + Return.orderId are SetNull (they outlive the order).
  //
  // Cap: 200 ids per call.
  // ═══════════════════════════════════════════════════════════════════
  const flipOrderDeletedAt = async (
    ids: string[],
    target: Date | null,
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: 'ids[] required' })
    }
    if (ids.length > 200) {
      return reply.code(400).send({
        error: `max 200 orders per call (got ${ids.length})`,
      })
    }
    const actor = userIdFor(request)
    const action = target ? 'soft-delete' : 'restore'

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, channelOrderId: true, channel: true, deletedAt: true },
      })
      const eligible = rows.filter((r) =>
        target ? r.deletedAt === null : r.deletedAt !== null,
      )
      if (eligible.length === 0) {
        return { changed: 0, skipped: rows.length }
      }
      const updated = await tx.order.updateMany({
        where: { id: { in: eligible.map((r) => r.id) } },
        data: { deletedAt: target },
      })
      await tx.auditLog.createMany({
        data: eligible.map((r) => ({
          userId: actor,
          entityType: 'Order',
          entityId: r.id,
          action,
          before: { deletedAt: r.deletedAt?.toISOString() ?? null },
          after: { deletedAt: target?.toISOString() ?? null },
          metadata: {
            channel: r.channel,
            channelOrderId: r.channelOrderId,
            source: 'orders-bulk',
          },
        })),
      })
      return { changed: updated.count, skipped: rows.length - updated.count }
    })

    return result
  }

  app.post('/api/orders/bulk-soft-delete', async (request, reply) => {
    try {
      const body = request.body as { ids?: string[] }
      const ids = Array.isArray(body?.ids) ? body.ids : []
      const r = await flipOrderDeletedAt(ids, new Date(), request, reply)
      if (r === undefined) return
      return { ok: true, ...r }
    } catch (err: any) {
      logger.error('[ORDERS API] bulk-soft-delete failed', { message: err?.message })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  app.post('/api/orders/bulk-restore', async (request, reply) => {
    try {
      const body = request.body as { ids?: string[] }
      const ids = Array.isArray(body?.ids) ? body.ids : []
      const r = await flipOrderDeletedAt(ids, null, request, reply)
      if (r === undefined) return
      return { ok: true, ...r }
    } catch (err: any) {
      logger.error('[ORDERS API] bulk-restore failed', { message: err?.message })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  app.post('/api/orders/bulk-hard-delete', async (request, reply) => {
    try {
      const body = request.body as { ids?: string[] }
      const ids = Array.isArray(body?.ids) ? body.ids : []
      if (ids.length === 0) {
        return reply.code(400).send({ error: 'ids[] required' })
      }
      if (ids.length > 200) {
        return reply.code(400).send({
          error: `max 200 orders per call (got ${ids.length})`,
        })
      }
      const actor = userIdFor(request)

      const result = await prisma.$transaction(async (tx) => {
        // Safety: only purge rows already in the bin.
        const eligible = await tx.order.findMany({
          where: { id: { in: ids }, deletedAt: { not: null } },
          select: {
            id: true,
            channel: true,
            channelOrderId: true,
            customerEmail: true,
            deletedAt: true,
          },
        })

        if (eligible.length === 0) {
          return {
            purged: 0,
            skipped: ids.length,
            warnings: [] as Array<{ id: string; channel: string; channelOrderId: string }>,
            dependents: { orders: 0 },
          }
        }

        // Channel-sync warning: surface live channel order ids so the
        // caller can render "this was already pushed to the channel —
        // delete is local-only" in the response. We still proceed —
        // the operator confirmed in the UI.
        const warnings = eligible
          .filter((r) => !!r.channelOrderId)
          .map((r) => ({
            id: r.id,
            channel: r.channel as string,
            channelOrderId: r.channelOrderId,
          }))

        const eligibleIds = eligible.map((r) => r.id)

        // AuditLog BEFORE the cascade (AuditLog has no FK to Order).
        await tx.auditLog.createMany({
          data: eligible.map((r) => ({
            userId: actor,
            entityType: 'Order',
            entityId: r.id,
            action: 'hard-delete',
            before: {
              channel: r.channel,
              channelOrderId: r.channelOrderId,
              customerEmail: r.customerEmail,
              deletedAt: r.deletedAt?.toISOString() ?? null,
            },
            after: null,
            metadata: {
              source: 'orders-bulk-hard-delete',
              ...(r.channelOrderId
                ? { channelSyncWarning: true }
                : {}),
            },
          })),
        })

        // The schema's onDelete:Cascade fans out to OrderItem, OrderNote,
        // OrderTag, OrderRiskScore, FiscalInvoice, RoutingDecision,
        // FinancialTransaction, MCFShipment, ReviewRequest. Shipment +
        // Return are SetNull (they outlive the order). Nothing manual
        // needed here.
        const purged = await tx.order.deleteMany({
          where: { id: { in: eligibleIds } },
        })

        return {
          purged: purged.count,
          skipped: ids.length - eligible.length,
          warnings,
          dependents: { orders: purged.count },
        }
      })

      return { ok: true, ...result }
    } catch (err: any) {
      logger.error('[ORDERS API] bulk-hard-delete failed', { message: err?.message })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })
}
