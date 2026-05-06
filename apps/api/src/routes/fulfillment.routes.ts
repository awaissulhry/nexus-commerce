import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { applyStockMovement, listStockMovements } from '../services/stock-movement.service.js'
import { refreshSalesAggregates } from '../services/sales-aggregate.service.js'
import { resolveAtp, DEFAULT_LEAD_TIME_DAYS } from '../services/atp.service.js'
import { resolveStockForChannel, type ChannelLocationSource } from '../services/atp-channel.service.js'
import {
  bulkPersistRecommendationsIfChanged,
  attachPoToRecommendation,
  getRecommendationHistory,
  getRecommendationById,
  type RecommendationInput,
  type Urgency,
  type VelocitySource,
} from '../services/replenishment-recommendation.service.js'
import {
  ingestSalesTrafficForDay,
  ingestAllAmazonMarketplaces,
} from '../services/sales-report-ingest.service.js'
import {
  generateForecastForSeries,
  generateForecastsForAll,
} from '../services/forecast.service.js'
import {
  getAccuracyForSku,
  getAccuracyAggregate,
  backfillForecastAccuracy,
} from '../services/forecast-accuracy.service.js'
import {
  renderFactoryPoPdf,
  type FactoryPoInput,
  type FactoryPoProductGroup,
  type FactoryPoVariantLine,
} from '../services/factory-po-pdf.service.js'
import {
  receiveItems as inboundReceiveItems,
  releaseQcHold as inboundReleaseQcHold,
  recordDiscrepancy as inboundRecordDiscrepancy,
  updateDiscrepancyStatus as inboundUpdateDiscrepancyStatus,
  addAttachment as inboundAddAttachment,
  appendItemPhoto as inboundAppendItemPhoto,
  transitionShipmentStatus as inboundTransitionStatus,
  InvalidTransitionError,
  NotFoundError,
} from '../services/inbound.service.js'
import {
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
} from '../services/cloudinary.service.js'
import {
  createInboundShipmentPlan as fbaCreateInboundShipmentPlan,
  getInboundShipmentLabels as fbaGetLabels,
  putInboundShipmentTransport as fbaPutTransport,
  isFbaInboundConfigured,
  type FbaShipmentType,
} from '../services/fba-inbound.service.js'
import {
  runFbaStatusPoll,
  getFbaStatusPollStatus,
} from '../jobs/fba-status-poll.job.js'
import {
  publishInboundEvent,
  subscribeInboundEvents,
  getListenerCount,
} from '../services/inbound-events.service.js'
import {
  listCarriers as listInboundCarriers,
  validateTrackingFormat,
} from '../services/carriers.service.js'
import { renderInboundDiscrepancyPdf } from '../services/inbound-discrepancy-pdf.service.js'

// ─────────────────────────────────────────────────────────────────────
// FULFILLMENT B.3–B.9 — full domain API surface
//
// Stock         GET  /fulfillment/stock-overview
//               GET  /fulfillment/stock                       (paginated, filterable)
//               GET  /fulfillment/stock/:productId/movements  (audit log)
//               POST /fulfillment/stock/:productId/adjust     (manual +/-)
//
// Outbound      GET  /fulfillment/shipments
//               POST /fulfillment/shipments                   (create from order)
//               GET  /fulfillment/shipments/:id
//               POST /fulfillment/shipments/:id/print-label   (Sendcloud stub)
//               POST /fulfillment/shipments/:id/mark-shipped  (push tracking)
//               POST /fulfillment/shipments/bulk-create       (from order ids[])
//               POST /fulfillment/shipments/bulk-print        (multi-label PDF)
//
// Inbound       GET  /fulfillment/inbound
//               POST /fulfillment/inbound                     (create draft)
//               GET  /fulfillment/inbound/:id
//               POST /fulfillment/inbound/:id/receive         (mark items received → stock)
//               POST /fulfillment/inbound/:id/close
//
// FBA           POST /fulfillment/fba/plan-shipment           (Send-to-Amazon plan)
//               POST /fulfillment/fba/create-shipment         (commit plan to FBA)
//               GET  /fulfillment/fba/shipments
//               POST /fulfillment/fba/shipments/:id/labels    (FNSKU + carton labels)
//               POST /fulfillment/fba/shipments/:id/transport (ASN + booking)
//
// Suppliers     GET  /fulfillment/suppliers
//               POST /fulfillment/suppliers
//               GET  /fulfillment/suppliers/:id
//               PATCH /fulfillment/suppliers/:id
//
// POs           GET  /fulfillment/purchase-orders
//               POST /fulfillment/purchase-orders             (draft)
//               GET  /fulfillment/purchase-orders/:id
//               POST /fulfillment/purchase-orders/:id/submit  (status DRAFT→SUBMITTED)
//               POST /fulfillment/purchase-orders/:id/receive (creates InboundShipment)
//
// Manufacturing GET  /fulfillment/work-orders
//               POST /fulfillment/work-orders
//               POST /fulfillment/work-orders/:id/complete    (output → stock)
//
// Returns       GET  /fulfillment/returns
//               POST /fulfillment/returns
//               GET  /fulfillment/returns/:id
//               POST /fulfillment/returns/:id/receive
//               POST /fulfillment/returns/:id/inspect         (condition grade)
//               POST /fulfillment/returns/:id/restock         (back into stock)
//               POST /fulfillment/returns/:id/refund          (mark refunded)
//               POST /fulfillment/returns/:id/scrap
//
// Replenishment GET  /fulfillment/replenishment               (suggestions)
//               POST /fulfillment/replenishment/:productId/draft-po (one-click)
//
// Carriers      GET  /fulfillment/carriers
//               POST /fulfillment/carriers/:code/connect
//               POST /fulfillment/carriers/:code/disconnect
//
// Index         GET  /fulfillment/overview                    (dashboard tiles)
// ─────────────────────────────────────────────────────────────────────

function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * H.0a — recompute PurchaseOrderItem.quantityReceived as
 * SUM(InboundShipmentItem.quantityReceived WHERE purchaseOrderItemId = X).
 * Idempotent. Driven from current state so re-runs converge.
 */
async function syncPoiQuantityReceived(purchaseOrderItemId: string): Promise<void> {
  const sum = await prisma.inboundShipmentItem.aggregate({
    where: { purchaseOrderItemId },
    _sum: { quantityReceived: true },
  })
  await prisma.purchaseOrderItem.update({
    where: { id: purchaseOrderItemId },
    data: { quantityReceived: sum._sum.quantityReceived ?? 0 },
  })
}

/**
 * H.0a — auto-transition PurchaseOrder.status based on aggregate
 * received vs ordered across all line items.
 *
 * Rules:
 *   - CANCELLED is terminal — never auto-transition out of it.
 *   - 0 received total → leave status untouched (DRAFT/SUBMITTED/CONFIRMED stays).
 *   - 0 < received < ordered → PARTIAL.
 *   - received >= ordered → RECEIVED.
 *   - Never auto-downgrade — a re-receive with a lower number must
 *     not slip a RECEIVED PO back to PARTIAL. Operator-driven reversals
 *     should be explicit.
 */
const PO_STATUS_ORDER: Record<string, number> = {
  DRAFT: 0,
  SUBMITTED: 1,
  CONFIRMED: 2,
  PARTIAL: 3,
  RECEIVED: 4,
  CANCELLED: -1,
}

async function maybeTransitionPoStatus(poId: string): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { items: { select: { quantityOrdered: true, quantityReceived: true } } },
  })
  if (!po || po.status === 'CANCELLED') return

  let totalOrdered = 0
  let totalReceived = 0
  for (const it of po.items) {
    totalOrdered += it.quantityOrdered
    totalReceived += it.quantityReceived ?? 0
  }
  if (totalReceived === 0) return

  const next: 'PARTIAL' | 'RECEIVED' =
    totalReceived >= totalOrdered ? 'RECEIVED' : 'PARTIAL'

  if (PO_STATUS_ORDER[next] <= PO_STATUS_ORDER[po.status]) return

  await prisma.purchaseOrder.update({
    where: { id: poId },
    data: { status: next, version: { increment: 1 } },
  })
}

function generatePoNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `PO-${yymmdd}-${rand}`
}

function generateRmaNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `RMA-${yymmdd}-${rand}`
}

const fulfillmentRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // OVERVIEW — dashboard tiles for /fulfillment index page
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/fulfillment/overview', async (_request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')

      const [
        pendingShipments,
        readyToPick,
        inTransit,
        deliveredToday,
        openInbound,
        receivingNow,
        lowStockCount,
        outOfStockCount,
        pendingReturns,
        inspectingReturns,
        replenishmentCritical,
        openWorkOrders,
        totalSuppliers,
        defaultWarehouse,
      ] = await Promise.all([
        prisma.shipment.count({ where: { status: { in: ['DRAFT', 'READY_TO_PICK'] as any } } }),
        prisma.shipment.count({ where: { status: 'READY_TO_PICK' as any } }),
        prisma.shipment.count({ where: { status: 'IN_TRANSIT' as any } }),
        prisma.shipment.count({
          where: {
            status: 'DELIVERED' as any,
            deliveredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.inboundShipment.count({ where: { status: { in: ['DRAFT', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING'] as any } } }),
        prisma.inboundShipment.count({ where: { status: 'RECEIVING' as any } }),
        prisma.product.count({ where: { totalStock: { gt: 0, lte: 5 }, isParent: false } }),
        prisma.product.count({ where: { totalStock: 0, isParent: false } }),
        prisma.return.count({ where: { status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT'] as any } } }),
        prisma.return.count({ where: { status: 'INSPECTING' as any } }),
        prisma.product.count({ where: { totalStock: 0, isParent: false } }),
        prisma.workOrder.count({ where: { status: { in: ['PLANNED', 'IN_PROGRESS'] as any } } }),
        prisma.supplier.count({ where: { isActive: true } }),
        prisma.warehouse.findFirst({ where: { isDefault: true } }),
      ])

      return {
        outbound: { pendingShipments, readyToPick, inTransit, deliveredToday },
        inbound: { openInbound, receivingNow, openWorkOrders },
        stock: { lowStock: lowStockCount, outOfStock: outOfStockCount },
        returns: { pending: pendingReturns, inspecting: inspectingReturns },
        replenishment: { critical: replenishmentCritical },
        suppliers: { active: totalSuppliers },
        defaultWarehouse,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/overview] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // STOCK
  // ═══════════════════════════════════════════════════════════════════

  // Legacy endpoint kept for backwards compatibility with current
  // /fulfillment/stock client; new client uses /fulfillment/stock.
  fastify.get('/fulfillment/stock-overview', async (request, reply) => {
    try {
      reply.header('Cache-Control', 'private, max-age=30')
      const q = request.query as any
      const limit = Math.min(safeNum(q.limit, 500) ?? 500, 1000)
      const where: any = { parentId: null }
      if (q.fulfillment === 'FBA' || q.fulfillment === 'FBM') where.fulfillmentChannel = q.fulfillment
      if (q.lowStock === '1' || q.lowStock === 'true') where.totalStock = { lte: 5 }
      if (q.q?.trim()) {
        const s = q.q.trim()
        where.OR = [
          { sku: { contains: s, mode: 'insensitive' } },
          { name: { contains: s, mode: 'insensitive' } },
        ]
      }
      const rows = await prisma.product.findMany({
        where,
        select: {
          id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
          fulfillmentChannel: true, amazonAsin: true, isParent: true,
        },
        orderBy: { totalStock: 'asc' },
        take: limit,
      })
      return { items: rows, count: rows.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock-overview] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/stock', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const skip = (page - 1) * pageSize

      const where: any = { isParent: false }
      if (q.fulfillment === 'FBA' || q.fulfillment === 'FBM') where.fulfillmentChannel = q.fulfillment
      if (q.lowStock === 'true') where.totalStock = { gt: 0, lte: 5 }
      if (q.outOfStock === 'true') where.totalStock = 0
      if (q.search?.trim()) {
        const s = q.search.trim()
        where.OR = [
          { sku: { contains: s, mode: 'insensitive' } },
          { name: { contains: s, mode: 'insensitive' } },
          { amazonAsin: { contains: s, mode: 'insensitive' } },
        ]
      }

      const sortBy = (q.sortBy ?? 'totalStock') as string
      const sortDir = (q.sortDir === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc'
      const orderBy =
        sortBy === 'sku' ? { sku: sortDir } :
        sortBy === 'name' ? { name: sortDir } :
        sortBy === 'updatedAt' ? { updatedAt: sortDir } :
        { totalStock: sortDir }

      const [total, rows] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          select: {
            id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
            fulfillmentChannel: true, fulfillmentMethod: true, amazonAsin: true,
            basePrice: true, costPrice: true, updatedAt: true,
            images: { select: { url: true }, take: 1 },
            channelListings: {
              select: { channel: true, marketplace: true, listingStatus: true, quantity: true, stockBuffer: true },
            },
          },
          orderBy,
          skip,
          take: pageSize,
        }),
      ])

      return {
        items: rows.map((r) => ({
          ...r,
          basePrice: r.basePrice == null ? null : Number(r.basePrice),
          costPrice: r.costPrice == null ? null : Number(r.costPrice),
          thumbnailUrl: r.images?.[0]?.url ?? null,
          channelCount: r.channelListings?.length ?? 0,
          listings: r.channelListings,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/stock/:productId/movements', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const q = request.query as any
      const movements = await listStockMovements({
        productId,
        limit: safeNum(q.limit, 100) ?? 100,
      })
      return { movements, count: movements.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock/:id/movements] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/stock/:productId/adjust', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const body = (request.body ?? {}) as { change?: number; reason?: string; notes?: string; warehouseId?: string }
      const change = Number(body.change)
      if (!Number.isFinite(change) || change === 0) {
        return reply.code(400).send({ error: 'change must be a non-zero number' })
      }
      const movement = await applyStockMovement({
        productId,
        change,
        reason: 'MANUAL_ADJUSTMENT',
        warehouseId: body.warehouseId,
        notes: body.notes,
        actor: 'manual-adjust',
      })
      return { ok: true, movement }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/stock/:id/adjust] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // OUTBOUND SHIPMENTS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/shipments', async (request, reply) => {
    try {
      const q = request.query as any
      const page = Math.max(1, safeNum(q.page, 1) ?? 1)
      const pageSize = Math.min(200, safeNum(q.pageSize, 50) ?? 50)
      const where: any = {}
      if (q.status && q.status !== 'ALL') where.status = q.status
      if (q.carrierCode) where.carrierCode = q.carrierCode
      if (q.search?.trim()) {
        where.OR = [
          { trackingNumber: { contains: q.search.trim(), mode: 'insensitive' } },
          { sendcloudParcelId: { contains: q.search.trim(), mode: 'insensitive' } },
        ]
      }
      const [total, items] = await Promise.all([
        prisma.shipment.count({ where }),
        prisma.shipment.findMany({
          where,
          include: { items: true, warehouse: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/shipments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const shipment = await prisma.shipment.findUnique({
      where: { id },
      include: { items: true, warehouse: true },
    })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    return shipment
  })

  fastify.post('/fulfillment/shipments', async (request, reply) => {
    try {
      const body = request.body as { orderId: string; warehouseId?: string; carrierCode?: string }
      if (!body.orderId) return reply.code(400).send({ error: 'orderId is required' })

      const order = await prisma.order.findUnique({
        where: { id: body.orderId },
        include: { items: true },
      })
      if (!order) return reply.code(404).send({ error: 'Order not found' })

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const shipment = await prisma.shipment.create({
        data: {
          orderId: order.id,
          warehouseId,
          carrierCode: (body.carrierCode as any) ?? 'SENDCLOUD',
          status: 'DRAFT',
          items: {
            create: order.items.map((it) => ({
              orderItemId: it.id,
              productId: it.productId,
              sku: it.sku,
              quantity: it.quantity,
            })),
          },
        },
        include: { items: true },
      })
      return shipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/:id/print-label', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.shipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })

      // B.4: Sendcloud integration point. The carrier service connection
      // would call POST /api/v2/parcels here. We scaffold the state
      // transition and a fake label URL so the UI flow works end-to-end
      // without live credentials.
      const carrier = await prisma.carrier.findUnique({ where: { code: shipment.carrierCode } })
      if (!carrier?.isActive) {
        return reply.code(400).send({ error: `Carrier ${shipment.carrierCode} is not connected. Open /fulfillment/carriers.` })
      }

      const fakeParcelId = `SC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const fakeTracking = `JJD${Math.floor(Math.random() * 1e10)}`

      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'LABEL_PRINTED',
          sendcloudParcelId: fakeParcelId,
          trackingNumber: fakeTracking,
          trackingUrl: `https://tracking.sendcloud.sc/forward?carrier=${shipment.carrierCode}&code=${fakeTracking}`,
          labelUrl: `/api/fulfillment/shipments/${id}/label.pdf`,
          labelPrintedAt: new Date(),
          version: { increment: 1 },
        },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[print-label] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/:id/mark-shipped', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updated = await prisma.shipment.update({
        where: { id },
        data: { status: 'SHIPPED', shippedAt: new Date(), version: { increment: 1 } },
      })
      // TODO: push tracking back to channel via channel-specific service
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[mark-shipped] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/shipments/bulk-create', async (request, reply) => {
    try {
      const body = request.body as { orderIds?: string[]; warehouseId?: string; carrierCode?: string }
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds : []
      if (orderIds.length === 0) return reply.code(400).send({ error: 'orderIds[] required' })
      if (orderIds.length > 200) return reply.code(400).send({ error: 'Max 200 orders per bulk create' })

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      let created = 0
      const errors: Array<{ orderId: string; reason: string }> = []
      for (const oid of orderIds) {
        try {
          const existing = await prisma.shipment.findFirst({ where: { orderId: oid, status: { not: 'CANCELLED' } } })
          if (existing) { errors.push({ orderId: oid, reason: 'shipment already exists' }); continue }
          const order = await prisma.order.findUnique({ where: { id: oid }, include: { items: true } })
          if (!order) { errors.push({ orderId: oid, reason: 'order not found' }); continue }
          await prisma.shipment.create({
            data: {
              orderId: oid,
              warehouseId,
              carrierCode: (body.carrierCode as any) ?? 'SENDCLOUD',
              status: 'DRAFT',
              items: {
                create: order.items.map((it) => ({
                  orderItemId: it.id, productId: it.productId, sku: it.sku, quantity: it.quantity,
                })),
              },
            },
          })
          created++
        } catch (e: any) {
          errors.push({ orderId: oid, reason: e?.message ?? String(e) })
        }
      }
      return { created, errors }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[bulk-create shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // INBOUND SHIPMENTS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/inbound', async (request, reply) => {
    try {
      const q = request.query as any
      const where: any = {}
      if (q.type && q.type !== 'ALL') where.type = q.type
      // H.3: status accepts comma-separated multi-select.
      if (q.status && q.status !== 'ALL') {
        const statuses = String(q.status).split(',').map((s) => s.trim()).filter(Boolean)
        if (statuses.length === 1) where.status = statuses[0]
        else if (statuses.length > 1) where.status = { in: statuses }
      }
      // H.3: search across reference / trackingNumber / carrierCode +
      // any item.sku containing the term.
      if (q.search?.trim()) {
        const s = q.search.trim()
        where.OR = [
          { reference: { contains: s, mode: 'insensitive' } },
          { trackingNumber: { contains: s, mode: 'insensitive' } },
          { carrierCode: { contains: s, mode: 'insensitive' } },
          { fbaShipmentId: { contains: s, mode: 'insensitive' } },
          { asnNumber: { contains: s, mode: 'insensitive' } },
          { purchaseOrder: { poNumber: { contains: s, mode: 'insensitive' } } },
          { items: { some: { sku: { contains: s, mode: 'insensitive' } } } },
        ]
      }

      // H.5: delayed filter — shipments past expectedAt in non-terminal
      // status. Compounds with type/status/search filters.
      if (q.delayed === 'true') {
        where.expectedAt = { lt: new Date() }
        const nonTerminal = ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED']
        if (where.status) {
          // Caller already filtered by status — intersect rather than overwrite.
          // (Most common case: q.delayed=true alone, no status filter.)
        } else {
          where.status = { in: nonTerminal as any }
        }
      }

      // H.3: pagination + sort.
      const page = Math.max(1, Math.floor(safeNum(q.page, 1) ?? 1))
      const pageSize = Math.min(200, Math.max(1, Math.floor(safeNum(q.pageSize, 50) ?? 50)))
      const skip = (page - 1) * pageSize
      const sortBy = (q.sortBy ?? 'createdAt') as string
      const sortDir = (q.sortDir === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'
      const orderBy =
        sortBy === 'expectedAt' ? { expectedAt: sortDir } :
        sortBy === 'status'     ? { status: sortDir } :
        sortBy === 'type'       ? { type: sortDir } :
        sortBy === 'updatedAt'  ? { updatedAt: sortDir } :
        { createdAt: sortDir }

      const [total, items] = await Promise.all([
        prisma.inboundShipment.count({ where }),
        prisma.inboundShipment.findMany({
          where,
          include: {
            items: true,
            warehouse: { select: { code: true, name: true } },
            purchaseOrder: { select: { poNumber: true, supplierId: true } },
            workOrder: { select: { id: true, productId: true, quantity: true } },
            _count: { select: { attachments: true, discrepancies: true } },
          },
          orderBy,
          skip,
          take: pageSize,
        }),
      ])
      return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/inbound] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.3 — KPI strip for /fulfillment/inbound. Counts driven by the
  // post-H.2 status taxonomy + open discrepancies. Computed in one
  // groupBy round-trip + two scalar counts.
  fastify.get('/fulfillment/inbound/kpis', async (_request, reply) => {
    try {
      const now = Date.now()
      const weekFromNow = new Date(now + 7 * 86400_000)

      const [byStatus, byType, openDiscCount, arrivingThisWeek, delayedCount, qcQueueCount] = await Promise.all([
        prisma.inboundShipment.groupBy({
          by: ['status'],
          _count: { status: true },
        }),
        prisma.inboundShipment.groupBy({
          by: ['type'],
          _count: { type: true },
        }),
        prisma.inboundDiscrepancy.count({
          where: { status: { in: ['REPORTED', 'ACKNOWLEDGED'] } },
        }),
        prisma.inboundShipment.count({
          where: {
            expectedAt: { gte: new Date(), lte: weekFromNow },
            status: { in: ['SUBMITTED', 'IN_TRANSIT'] },
          },
        }),
        // H.5 — shipments past expected arrival in non-terminal status.
        prisma.inboundShipment.count({
          where: {
            expectedAt: { lt: new Date() },
            status: { in: ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED'] },
          },
        }),
        // H.12 — items currently in QC quarantine (FAIL or HOLD) on
        // any non-CLOSED shipment. CLOSED shipments are excluded
        // because their QC dispositions are historical.
        prisma.inboundShipmentItem.count({
          where: {
            qcStatus: { in: ['FAIL', 'HOLD'] },
            inboundShipment: { status: { not: 'CLOSED' } },
          },
        }),
      ])

      const statusCounts: Record<string, number> = {}
      for (const r of byStatus) statusCounts[r.status] = r._count.status
      const typeCounts: Record<string, number> = {}
      for (const r of byType) typeCounts[r.type] = r._count.type

      const openStatuses = ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED', 'RECEIVED']
      const openShipments = openStatuses.reduce((a, s) => a + (statusCounts[s] ?? 0), 0)

      return {
        openShipments,
        inTransit: statusCounts.IN_TRANSIT ?? 0,
        arrivingThisWeek,
        delayed: delayedCount,
        openDiscrepancies: openDiscCount,
        qcQueueCount,
        statusCounts,
        typeCounts,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/inbound/kpis] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.14 — SSE stream of inbound events. Long-lived GET; keeps a
  // single open connection per client. We send a comment line
  // every 25s so middleware (Railway proxy, Cloudflare etc.) can't
  // close idle connections. EventSource auto-reconnects on its own,
  // so a transient drop is invisible to the operator.
  fastify.get('/fulfillment/inbound/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Tell proxies not to buffer (Cloudflare honours this; Railway's
      // Envoy passes it through).
      'X-Accel-Buffering': 'no',
    })
    // Initial hello so the client knows the stream is live.
    reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)

    const send = (event: any) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      } catch {
        // If write throws, the connection is dead — cleanup runs in close handler.
      }
    }

    const unsubscribe = subscribeInboundEvents(send)
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

    // Keep handler alive by returning a never-resolving promise.
    // Fastify will tear down when the connection closes.
    await new Promise(() => {})
  })

  fastify.get('/fulfillment/inbound/events/stats', async () => {
    return { listenerCount: getListenerCount() }
  })

  // H.15 — server-side inbound carrier registry. Frontend pulls
  // this on load instead of duplicating the hardcoded map. PDFs +
  // emails (when added) can resolveTrackingUrl(...) directly.
  fastify.get('/fulfillment/carriers/inbound', async () => {
    return { items: listInboundCarriers() }
  })

  fastify.post('/fulfillment/carriers/inbound/validate-tracking', async (request) => {
    const body = request.body as { carrierCode?: string; trackingNumber?: string }
    return validateTrackingFormat(body.carrierCode, body.trackingNumber)
  })

  // H.12 — QC queue. Cross-shipment view of items currently in
  // FAIL/HOLD on non-CLOSED shipments. The existing release-hold
  // endpoint stays as the action surface; this just lists what's
  // in the queue with enough context for the operator to decide.
  fastify.get('/fulfillment/inbound/qc-queue', async (_request, reply) => {
    try {
      const items = await prisma.inboundShipmentItem.findMany({
        where: {
          qcStatus: { in: ['FAIL', 'HOLD'] },
          inboundShipment: { status: { not: 'CLOSED' } },
        },
        include: {
          inboundShipment: {
            select: {
              id: true,
              type: true,
              status: true,
              reference: true,
              expectedAt: true,
              warehouseId: true,
            },
          },
        },
        orderBy: [
          { inboundShipment: { expectedAt: 'asc' } },
          { id: 'asc' },
        ],
      })

      const productIds = Array.from(new Set(items.map((i) => i.productId).filter((x): x is string => !!x)))
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          })
        : []
      const nameById = new Map(products.map((p) => [p.id, p.name]))

      return {
        count: items.length,
        items: items.map((it) => ({
          itemId: it.id,
          sku: it.sku,
          productId: it.productId,
          productName: it.productId ? (nameById.get(it.productId) ?? null) : null,
          quantityExpected: it.quantityExpected,
          quantityReceived: it.quantityReceived,
          qcStatus: it.qcStatus,
          qcNotes: it.qcNotes,
          shipment: {
            id: it.inboundShipment.id,
            type: it.inboundShipment.type,
            status: it.inboundShipment.status,
            reference: it.inboundShipment.reference,
            expectedAt: it.inboundShipment.expectedAt,
          },
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[fulfillment/inbound/qc-queue] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get('/fulfillment/inbound/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const shipment = await prisma.inboundShipment.findUnique({
      where: { id },
      include: {
        items: { include: { discrepancies: true, receipts: { orderBy: { receivedAt: 'desc' } } } },
        warehouse: true,
        purchaseOrder: true,
        workOrder: true,
        // H.1 additions — full bundle for the detail surface.
        attachments: { orderBy: { uploadedAt: 'desc' } },
        discrepancies: { where: { inboundShipmentItemId: null }, orderBy: { reportedAt: 'desc' } },
      },
    })
    if (!shipment) return reply.code(404).send({ error: 'Inbound shipment not found' })

    // H.11 — landed cost summary. Goods = sum of (unitCostCents *
    // quantityExpected) — using expected, not received, so the
    // landed cost is the planned figure regardless of receive
    // progress. Operators with cost variance use the discrepancy
    // surface to track actuals.
    const goodsCents = shipment.items.reduce((sum, it) => {
      return sum + (it.unitCostCents ?? 0) * it.quantityExpected
    }, 0)
    const shippingCents = shipment.shippingCostCents ?? 0
    const customsCents = shipment.customsCostCents ?? 0
    const dutiesCents = shipment.dutiesCostCents ?? 0
    const insuranceCents = shipment.insuranceCostCents ?? 0
    const totalCents = goodsCents + shippingCents + customsCents + dutiesCents + insuranceCents

    return {
      ...shipment,
      landedCost: {
        currencyCode: shipment.currencyCode,
        exchangeRate: shipment.exchangeRate,
        goodsCents,
        shippingCents,
        customsCents,
        dutiesCents,
        insuranceCents,
        totalCents,
      },
    }
  })

  // H.11 — patch costs. Updates shipment-level cost fields and/or
  // per-line unitCostCents in a single call. Empty body is a no-op
  // (returns the unchanged shipment). Pass `null` to clear a field.
  fastify.patch('/fulfillment/inbound/:id/costs', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        currencyCode?: string
        exchangeRate?: number | null
        shippingCostCents?: number | null
        customsCostCents?: number | null
        dutiesCostCents?: number | null
        insuranceCostCents?: number | null
        items?: Array<{ id: string; unitCostCents: number | null }>
      }
      const existing = await prisma.inboundShipment.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Inbound shipment not found' })

      const data: any = {}
      if (body.currencyCode !== undefined) data.currencyCode = body.currencyCode
      if (body.exchangeRate !== undefined) data.exchangeRate = body.exchangeRate
      if (body.shippingCostCents !== undefined) data.shippingCostCents = body.shippingCostCents
      if (body.customsCostCents !== undefined) data.customsCostCents = body.customsCostCents
      if (body.dutiesCostCents !== undefined) data.dutiesCostCents = body.dutiesCostCents
      if (body.insuranceCostCents !== undefined) data.insuranceCostCents = body.insuranceCostCents

      if (Object.keys(data).length > 0) {
        await prisma.inboundShipment.update({ where: { id }, data })
      }

      if (body.items && body.items.length > 0) {
        // updateMany doesn't support per-row values; loop with bounded
        // concurrency. Item count per shipment is small (<100) so
        // sequential is fine.
        for (const it of body.items) {
          await prisma.inboundShipmentItem.update({
            where: { id: it.id },
            data: { unitCostCents: it.unitCostCents },
          })
        }
      }

      publishInboundEvent({ type: 'inbound.updated', shipmentId: id, reason: 'costs', ts: Date.now() })
      return { ok: true }
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/:id/costs] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // H.16 — compliance update. Per-line lot/expiry on
  // InboundShipmentItem; HS code + countryOfOrigin live on Product
  // and are updated via the existing /api/products PATCH.
  fastify.patch('/fulfillment/inbound/:id/compliance', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items?: Array<{
          id: string
          lotNumber?: string | null
          expiryDate?: string | null
        }>
      }
      const existing = await prisma.inboundShipment.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Inbound shipment not found' })

      if (body.items && body.items.length > 0) {
        for (const it of body.items) {
          const data: any = {}
          if (it.lotNumber !== undefined) data.lotNumber = it.lotNumber
          if (it.expiryDate !== undefined) {
            data.expiryDate = it.expiryDate ? new Date(it.expiryDate) : null
          }
          if (Object.keys(data).length > 0) {
            await prisma.inboundShipmentItem.update({ where: { id: it.id }, data })
          }
        }
      }

      publishInboundEvent({ type: 'inbound.updated', shipmentId: id, reason: 'compliance', ts: Date.now() })
      return { ok: true }
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/:id/compliance] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // H.17 — inbound discrepancy report PDF. Generates a one-page
  // report of every discrepancy on the shipment for the operator
  // to forward to the supplier. Email automation isn't wired yet
  // (no email infra — TECH_DEBT entry); operator downloads + sends
  // via their own mail client.
  fastify.get('/fulfillment/inbound/:id/discrepancies/report.pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.inboundShipment.findUnique({
        where: { id },
        include: {
          items: { select: { id: true, sku: true, productId: true } },
          discrepancies: { orderBy: { reportedAt: 'asc' } },
          purchaseOrder: { include: { supplier: { select: { name: true } } } },
        },
      })
      if (!shipment) return reply.code(404).send({ error: 'Inbound shipment not found' })

      // Pull line-level discrepancies separately so we can resolve
      // SKU + product name per row.
      const lineDiscs = await prisma.inboundDiscrepancy.findMany({
        where: { inboundShipmentItemId: { in: shipment.items.map((i) => i.id) } },
        orderBy: { reportedAt: 'asc' },
      })
      const allDiscs = [...shipment.discrepancies, ...lineDiscs].sort((a, b) => a.reportedAt.getTime() - b.reportedAt.getTime())

      const itemById = new Map(shipment.items.map((i) => [i.id, i]))
      const productIds = Array.from(new Set(shipment.items.map((i) => i.productId).filter((x): x is string => !!x)))
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true },
          })
        : []
      const productNameById = new Map(products.map((p) => [p.id, p.name]))

      const brandSettings = await prisma.brandSettings.findFirst().catch(() => null)
      const brand = {
        name: brandSettings?.brandName ?? 'Nexus Commerce',
        addressLines: [
          brandSettings?.addressLine1,
          [brandSettings?.postalCode, brandSettings?.city].filter(Boolean).join(' '),
          brandSettings?.country,
        ].filter((s): s is string => !!s && s.trim().length > 0),
        logoUrl: brandSettings?.logoUrl ?? null,
      }

      const pdf = await renderInboundDiscrepancyPdf({
        brand,
        shipment: {
          id: shipment.id,
          reference: shipment.reference,
          type: shipment.type,
          status: shipment.status,
          expectedAt: shipment.expectedAt,
          arrivedAt: shipment.arrivedAt,
          supplierName: shipment.purchaseOrder?.supplier?.name ?? null,
        },
        discrepancies: allDiscs.map((d) => {
          const item = d.inboundShipmentItemId ? itemById.get(d.inboundShipmentItemId) : null
          return {
            reasonCode: d.reasonCode,
            status: d.status,
            reportedAt: d.reportedAt,
            reportedBy: d.reportedBy,
            description: d.description,
            expectedValue: d.expectedValue,
            actualValue: d.actualValue,
            quantityImpact: d.quantityImpact,
            costImpactCents: d.costImpactCents,
            sku: item?.sku ?? null,
            productName: item?.productId ? (productNameById.get(item.productId) ?? null) : null,
          }
        }),
        currencyCode: shipment.currencyCode ?? 'EUR',
      })

      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="discrepancy-report-${shipment.reference ?? shipment.id}.pdf"`)
        .send(pdf)
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/:id/discrepancies/report.pdf] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // H.16 — recall lookup. Given a lot number, return every
  // InboundShipmentItem that received it, with shipment + product
  // context. Critical for safety-recall responses on motorcycle gear
  // (helmets, body armor) where the recall scope is "this lot".
  fastify.get('/fulfillment/inbound/lots/:lotNumber', async (request, reply) => {
    try {
      const { lotNumber } = request.params as { lotNumber: string }
      if (!lotNumber.trim()) return reply.code(400).send({ error: 'lotNumber required' })

      const items = await prisma.inboundShipmentItem.findMany({
        where: { lotNumber: lotNumber.trim() },
        include: {
          inboundShipment: {
            select: {
              id: true,
              type: true,
              status: true,
              reference: true,
              expectedAt: true,
              arrivedAt: true,
            },
          },
        },
        orderBy: { id: 'asc' },
      })

      const productIds = Array.from(new Set(items.map((i) => i.productId).filter((x): x is string => !!x)))
      const products = productIds.length > 0
        ? await prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, name: true, sku: true },
          })
        : []
      const byId = new Map(products.map((p) => [p.id, p]))

      return {
        lotNumber: lotNumber.trim(),
        count: items.length,
        items: items.map((it) => ({
          itemId: it.id,
          sku: it.sku,
          productName: it.productId ? (byId.get(it.productId)?.name ?? null) : null,
          quantityExpected: it.quantityExpected,
          quantityReceived: it.quantityReceived,
          expiryDate: it.expiryDate,
          shipment: it.inboundShipment,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[inbound/lots/:lotNumber] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/inbound', async (request, reply) => {
    try {
      const body = request.body as {
        type?: 'FBA' | 'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'
        warehouseId?: string
        purchaseOrderId?: string
        workOrderId?: string
        fbaShipmentId?: string
        reference?: string
        expectedAt?: string
        notes?: string
        // H.1 additions
        asnNumber?: string
        asnFileUrl?: string
        carrierCode?: string
        trackingNumber?: string
        trackingUrl?: string
        currencyCode?: string
        exchangeRate?: number
        shippingCostCents?: number
        customsCostCents?: number
        dutiesCostCents?: number
        insuranceCostCents?: number
        createdById?: string
        items?: Array<{
          productId?: string
          sku: string
          quantityExpected: number
          purchaseOrderItemId?: string
          // H.1
          unitCostCents?: number
        }>
      }
      if (!body.type) return reply.code(400).send({ error: 'type is required' })
      const items = Array.isArray(body.items) ? body.items : []

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const shipment = await prisma.inboundShipment.create({
        data: {
          type: body.type,
          status: 'DRAFT',
          warehouseId,
          purchaseOrderId: body.purchaseOrderId ?? null,
          workOrderId: body.workOrderId ?? null,
          fbaShipmentId: body.fbaShipmentId ?? null,
          reference: body.reference ?? null,
          expectedAt: body.expectedAt ? new Date(body.expectedAt) : null,
          notes: body.notes ?? null,
          // H.1 — pass-through. defaults handle currencyCode + photoUrls.
          asnNumber: body.asnNumber ?? null,
          asnFileUrl: body.asnFileUrl ?? null,
          carrierCode: body.carrierCode ?? null,
          trackingNumber: body.trackingNumber ?? null,
          trackingUrl: body.trackingUrl ?? null,
          ...(body.currencyCode ? { currencyCode: body.currencyCode } : {}),
          exchangeRate: body.exchangeRate != null ? body.exchangeRate : null,
          shippingCostCents: body.shippingCostCents ?? null,
          customsCostCents: body.customsCostCents ?? null,
          dutiesCostCents: body.dutiesCostCents ?? null,
          insuranceCostCents: body.insuranceCostCents ?? null,
          createdById: body.createdById ?? null,
          items: {
            create: items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              quantityExpected: it.quantityExpected,
              purchaseOrderItemId: it.purchaseOrderItemId ?? null,
              unitCostCents: it.unitCostCents ?? null,
            })),
          },
        },
        include: { items: true },
      })
      publishInboundEvent({ type: 'inbound.created', shipmentId: shipment.id, ts: Date.now() })
      return shipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/inbound] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Receive inbound items. H.0b — event-log idempotent flow,
  // refactored in H.2 to delegate to inbound.service. Body shape
  // unchanged for backwards compat; new optional photoUrls per item
  // appends to the cached InboundShipmentItem.photoUrls array.
  // H.10a — cross-shipment scan-receive. Returns every open
  // InboundShipmentItem matching a SKU so the bulk-receive UI can
  // route the scan to the right shipment without the operator
  // having to look it up. "Open" = parent shipment not in
  // RECEIVED/RECONCILED/CLOSED/CANCELLED, AND quantityReceived <
  // quantityExpected. Sorted by (expectedAt asc, createdAt asc) so
  // the oldest open shipment ranks first — that's almost always
  // what the operator wants when there's ambiguity.
  fastify.get('/fulfillment/inbound/receive-candidates', async (request, reply) => {
    const q = request.query as { sku?: string }
    const sku = (q.sku ?? '').trim()
    if (!sku) return reply.code(400).send({ error: 'sku query param required' })

    const TERMINAL = ['RECEIVED', 'RECONCILED', 'CLOSED', 'CANCELLED']

    const candidates = await prisma.inboundShipmentItem.findMany({
      where: {
        sku,
        inboundShipment: { status: { notIn: TERMINAL as any } },
      },
      include: {
        inboundShipment: {
          select: {
            id: true,
            reference: true,
            type: true,
            status: true,
            expectedAt: true,
            createdAt: true,
            warehouseId: true,
          },
        },
      },
      orderBy: [
        { inboundShipment: { expectedAt: 'asc' } },
        { inboundShipment: { createdAt: 'asc' } },
      ],
    })

    const open = candidates.filter((c) => c.quantityReceived < c.quantityExpected)

    // Resolve product names in one extra query so the UI can show
    // "SKU + product name" without a second roundtrip per row.
    const productIds = Array.from(new Set(open.map((c) => c.productId).filter((x): x is string => !!x)))
    const products = productIds.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true },
        })
      : []
    const nameById = new Map(products.map((p) => [p.id, p.name]))

    return {
      sku,
      count: open.length,
      candidates: open.map((c) => ({
        itemId: c.id,
        sku: c.sku,
        productName: c.productId ? (nameById.get(c.productId) ?? null) : null,
        productId: c.productId,
        quantityExpected: c.quantityExpected,
        quantityReceived: c.quantityReceived,
        remaining: c.quantityExpected - c.quantityReceived,
        shipment: {
          id: c.inboundShipment.id,
          reference: c.inboundShipment.reference,
          type: c.inboundShipment.type,
          status: c.inboundShipment.status,
          expectedAt: c.inboundShipment.expectedAt,
        },
      })),
    }
  })

  fastify.post('/fulfillment/inbound/:id/receive', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items?: Array<{
          itemId: string
          quantityReceived: number
          qcStatus?: string
          qcNotes?: string
          idempotencyKey?: string
          notes?: string
          photoUrls?: string[]
        }>
        actor?: string
        receivedById?: string
      }
      const items = Array.isArray(body.items) ? body.items : []
      const updated = await inboundReceiveItems({
        shipmentId: id,
        items,
        actor: body.actor ?? 'inbound-receive',
        receivedById: body.receivedById,
      })
      publishInboundEvent({ type: 'inbound.received', shipmentId: id, ts: Date.now() })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/receive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — explicit state machine transition. Auto-transitions still
  // happen on receive + discrepancy resolution; this endpoint is for
  // operator-driven moves (DRAFT→SUBMITTED, SUBMITTED→IN_TRANSIT, etc.).
  fastify.post('/fulfillment/inbound/:id/transition', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { status?: string; actor?: string }
      if (!body.status) return reply.code(400).send({ error: 'status required' })
      const updated = await inboundTransitionStatus({
        shipmentId: id,
        newStatus: body.status as any,
        actor: body.actor,
      })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/transition] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — release QC HOLD/FAIL units to stock. Default releases the
  // full held quantity; pass `quantity` for a partial release (rest
  // stays excluded from inventory).
  fastify.post('/fulfillment/inbound/:id/items/:itemId/release-hold', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string }
      const body = request.body as { quantity?: number; actor?: string }
      const mv = await inboundReleaseQcHold({
        shipmentId: id,
        itemId,
        quantity: body.quantity,
        actor: body.actor,
      })
      return { ok: true, movement: mv }
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/items/:id/release-hold] failed')
      return reply.code(400).send({ error: error?.message ?? String(error) })
    }
  })

  // H.7 — multipart upload: receives a binary file (camera capture or
  // gallery pick), uploads to Cloudinary in inbound/{shipmentId}/items/
  // {itemId}/, then appends the secure URL to InboundShipmentItem.
  // photoUrls. Server-mediated (vs client-direct) to keep the
  // Cloudinary credentials off the wire and to stamp the folder
  // structure server-side.
  fastify.post('/fulfillment/inbound/:id/items/:itemId/upload-photo', async (request, reply) => {
    try {
      const { id, itemId } = request.params as { id: string; itemId: string }
      if (!isCloudinaryConfigured()) {
        return reply.code(503).send({ error: 'Cloudinary not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)' })
      }
      const data = await (request as any).file?.()
      if (!data) {
        return reply.code(400).send({ error: 'multipart file required' })
      }
      const buffer = await data.toBuffer()
      if (buffer.length > 10 * 1024 * 1024) {
        return reply.code(413).send({ error: 'file too large (max 10MB)' })
      }
      // Confirm the item belongs to the shipment before uploading —
      // saves a wasted Cloudinary upload if the path is wrong.
      const item = await prisma.inboundShipmentItem.findUnique({
        where: { id: itemId },
        select: { id: true, inboundShipmentId: true },
      })
      if (!item) return reply.code(404).send({ error: 'item not found' })
      if (item.inboundShipmentId !== id) {
        return reply.code(400).send({ error: 'item does not belong to this shipment' })
      }
      const result = await uploadBufferToCloudinary(buffer, {
        folder: `inbound/${id}/items/${itemId}`,
      })
      const updated = await inboundAppendItemPhoto({ shipmentItemId: itemId, url: result.url })
      return { ok: true, url: result.url, photoUrls: updated.photoUrls }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[inbound/:id/items/:id/upload-photo] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — append a photo URL to an item's proof gallery. Cloudinary
  // direct-uploads from the frontend POST the resulting URL here.
  fastify.post('/fulfillment/inbound/:id/items/:itemId/photos', async (request, reply) => {
    try {
      const { itemId } = request.params as { id: string; itemId: string }
      const body = request.body as { url?: string }
      if (!body.url) return reply.code(400).send({ error: 'url required' })
      const item = await inboundAppendItemPhoto({ shipmentItemId: itemId, url: body.url })
      return item
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/items/:id/photos] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — register an attachment uploaded to Cloudinary. Body:
  //   { kind, url, filename?, contentType?, sizeBytes?, uploadedBy? }
  // kind is one of PHOTO|INVOICE|PACKING|CUSTOMS|ASN|OTHER.
  fastify.post('/fulfillment/inbound/:id/attachments', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      if (!body.kind || !body.url) return reply.code(400).send({ error: 'kind + url required' })
      const att = await inboundAddAttachment({
        shipmentId: id,
        kind: body.kind,
        url: body.url,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        uploadedBy: body.uploadedBy,
      })
      return att
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/attachments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — record a discrepancy (ship-level or line-level).
  fastify.post('/fulfillment/inbound/:id/discrepancies', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      if (!body.reasonCode) return reply.code(400).send({ error: 'reasonCode required' })
      const d = await inboundRecordDiscrepancy({
        shipmentId: id,
        itemId: body.itemId,
        reasonCode: body.reasonCode,
        expectedValue: body.expectedValue,
        actualValue: body.actualValue,
        quantityImpact: body.quantityImpact,
        costImpactCents: body.costImpactCents,
        description: body.description,
        photoUrls: body.photoUrls,
        reportedBy: body.reportedBy,
      })
      return d
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/discrepancies] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.2 — update discrepancy status. Triggers maybeAutoTransition so
  // RECEIVED → RECONCILED happens once everything's resolved.
  fastify.patch('/fulfillment/inbound/discrepancies/:did', async (request, reply) => {
    try {
      const { did } = request.params as { did: string }
      const body = request.body as { status?: string; resolutionNotes?: string; actor?: string }
      if (!body.status) return reply.code(400).send({ error: 'status required' })
      const valid = ['REPORTED', 'ACKNOWLEDGED', 'RESOLVED', 'DISPUTED', 'WAIVED']
      if (!valid.includes(body.status)) return reply.code(400).send({ error: `status must be one of ${valid.join(', ')}` })
      const updated = await inboundUpdateDiscrepancyStatus({
        discrepancyId: did,
        status: body.status as any,
        resolutionNotes: body.resolutionNotes,
        actor: body.actor,
      })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/discrepancies/:id PATCH] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // /close kept as a convenience alias for transition→CLOSED.
  fastify.post('/fulfillment/inbound/:id/close', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const updated = await inboundTransitionStatus({
        shipmentId: id,
        newStatus: 'CLOSED' as any,
      })
      return updated
    } catch (error: any) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message })
      if (error instanceof InvalidTransitionError) return reply.code(409).send({ error: error.message })
      fastify.log.error({ err: error }, '[inbound/:id/close] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // FBA Send-to-Amazon (B.6 scaffold)
  // ═══════════════════════════════════════════════════════════════════

  // H.8a — real SP-API createInboundShipmentPlan. v0 endpoint
  // (deprecated but functional; 2024-03-20 multi-step flow lands in
  // a future migration — see TECH_DEBT). Returns Amazon-issued
  // shipment plans grouped by destination FC. 503 with a clear
  // message when SP-API isn't configured rather than silently
  // falling back to a stub.
  fastify.post('/fulfillment/fba/plan-shipment', async (request, reply) => {
    try {
      const body = request.body as {
        items?: Array<{ sku: string; quantity: number; asin?: string; condition?: string; quantityInCase?: number }>
        labelPrepPreference?: 'SELLER_LABEL' | 'AMAZON_LABEL_ONLY' | 'AMAZON_LABEL_PREFERRED'
      }
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) return reply.code(400).send({ error: 'items[] required' })

      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured. Set AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AMAZON_MARKETPLACE_ID.',
        })
      }

      const result = await fbaCreateInboundShipmentPlan({
        items: items.map((it) => ({
          sellerSku: it.sku,
          quantity: it.quantity,
          asin: it.asin,
          condition: it.condition as any,
          quantityInCase: it.quantityInCase,
        })),
        labelPrepPreference: body.labelPrepPreference,
      })

      // Return a shape compatible with the existing UI wizard. The
      // legacy stub returned { planId, shipmentPlans[] } where
      // shipmentPlans[i] = { shipmentId, destinationFC, items[] }.
      // We map Amazon's PascalCase response onto the same lowercase
      // keys so the wizard doesn't need to change in this commit.
      return {
        planId: `PLAN-${result.shipmentPlans.map((p) => p.ShipmentId).join('-')}`,
        shipmentPlans: result.shipmentPlans.map((p) => ({
          shipmentId: p.ShipmentId,
          destinationFC: p.DestinationFulfillmentCenterId,
          labelPrepType: p.LabelPrepType,
          shipToAddress: p.ShipToAddress,
          items: p.Items.map((it) => ({
            sku: it.SellerSKU,
            quantity: it.Quantity,
            fnsku: it.FulfillmentNetworkSKU ?? null,
            prepDetails: it.PrepDetailsList ?? [],
          })),
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/plan-shipment] failed')
      // Surface the SP-API error message intact — operator-facing UI
      // benefits from seeing "InvalidSellerSKU" etc. rather than a
      // generic 500.
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/fba/create-shipment', async (request, reply) => {
    try {
      const body = request.body as {
        shipmentId: string // from plan
        destinationFC: string
        name?: string
        items: Array<{ productId?: string; sku: string; quantity: number; fnsku?: string }>
      }
      if (!body.shipmentId || !body.destinationFC) {
        return reply.code(400).send({ error: 'shipmentId + destinationFC required' })
      }

      const fbaShipment = await prisma.fBAShipment.create({
        data: {
          shipmentId: body.shipmentId,
          name: body.name ?? null,
          status: 'WORKING',
          destinationFC: body.destinationFC,
          items: {
            create: body.items
              .filter((it) => it.productId)
              .map((it) => ({
                productId: it.productId!,
                quantitySent: it.quantity,
                quantityReceived: 0,
              })),
          },
        },
        include: { items: true },
      })

      // Mirror as InboundShipment (type=FBA) so it shows in /fulfillment/inbound
      await prisma.inboundShipment.create({
        data: {
          type: 'FBA',
          status: 'DRAFT',
          fbaShipmentId: fbaShipment.shipmentId,
          reference: `Send-to-Amazon ${body.shipmentId}`,
          items: {
            create: body.items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              quantityExpected: it.quantity,
            })),
          },
        },
      })

      return fbaShipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/create-shipment] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/fba/shipments', async (_request, reply) => {
    try {
      const items = await prisma.fBAShipment.findMany({
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { items, total: items.length }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.8b — real SP-API getLabels. The :id param accepts EITHER the
  // local FBAShipment.id (cuid) OR the Amazon-issued shipmentId
  // (FBA-prefixed). Local lookup first to resolve to the Amazon ID;
  // if not found, treat :id as the Amazon ID directly so operators
  // can hit the route with whatever they have.
  //
  // Body (all optional):
  //   pageType   PackageLabel_A4_4 (default) | _Letter_4 | _Thermal | …
  //   labelType  BARCODE_2D (default — FNSKU unit labels)
  //              | UNIQUE (carton labels)
  //              | PALLET (pallet labels)
  //   numberOfPackages, packageLabelsToPrint, numberOfPallets
  //
  // Response: { downloadUrl } — Amazon-hosted temp URL (minutes TTL)
  // pointing at the labels PDF. Frontend renders as a download link.
  fastify.post('/fulfillment/fba/shipments/:id/labels', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as {
        pageType?: any; labelType?: any
        numberOfPackages?: number; packageLabelsToPrint?: string[]; numberOfPallets?: number
      }
      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured. Set AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AMAZON_MARKETPLACE_ID.',
        })
      }
      // Resolve to the Amazon-issued shipmentId. Local FBAShipment.id
      // (cuid) → Amazon shipmentId via the row; if no row, assume the
      // operator passed Amazon's ID directly.
      let amazonShipmentId = id
      const local = await prisma.fBAShipment.findUnique({
        where: { id },
        select: { shipmentId: true },
      }).catch(() => null)
      if (local?.shipmentId) amazonShipmentId = local.shipmentId

      const result = await fbaGetLabels({
        shipmentId: amazonShipmentId,
        pageType: body.pageType,
        labelType: body.labelType,
        numberOfPackages: body.numberOfPackages,
        packageLabelsToPrint: body.packageLabelsToPrint,
        numberOfPallets: body.numberOfPallets,
      })
      return {
        ok: true,
        downloadUrl: result.downloadUrl,
        // Pre-H.8b clients used `labelsUrl` — keep alias for backwards compat.
        labelsUrl: result.downloadUrl,
        shipmentId: amazonShipmentId,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments/:id/labels] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/fba/shipments/:id/transport', async (request, reply) => {
    try {
      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)',
        })
      }
      const { id } = request.params as { id: string }
      const body = request.body as {
        shipmentType?: FbaShipmentType
        carrierName?: string
        trackingIds?: string[]
        proNumber?: string
      }

      // :id may be FBAShipment.id (cuid) or the Amazon shipmentId
      // directly. Resolve to Amazon shipmentId for the SP-API call.
      const local = await prisma.fBAShipment.findUnique({ where: { id } }).catch(() => null)
      const amazonShipmentId = local?.shipmentId ?? id
      if (!amazonShipmentId) {
        return reply.code(400).send({ error: 'shipmentId required' })
      }

      const shipmentType: FbaShipmentType = body.shipmentType ?? 'SP'

      const result = await fbaPutTransport({
        shipmentId: amazonShipmentId,
        shipmentType,
        ...(shipmentType === 'SP'
          ? {
              smallParcel: {
                carrierName: body.carrierName ?? 'OTHER',
                trackingIds: body.trackingIds ?? [],
              },
            }
          : {
              ltl: {
                carrierName: body.carrierName ?? 'OTHER',
                proNumber: body.proNumber ?? '',
              },
            }),
      })

      // No local persistence yet — FBAShipment lacks transport fields.
      // H.8d (status polling) will reconcile state from Amazon as
      // source of truth, which avoids drift between two writers.

      return {
        ok: true,
        transportStatus: result.transportStatus,
        shipmentId: amazonShipmentId,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments/:id/transport] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // H.8d — FBA status polling. POST trigger for manual reconcile;
  // GET returns the cron's last-run snapshot. The cron itself runs
  // every 15 min from index.ts on startup.
  fastify.post('/fulfillment/fba/poll-status', async (_request, reply) => {
    try {
      if (!isFbaInboundConfigured()) {
        return reply.code(503).send({
          error: 'SP-API not configured (set AMAZON_LWA_* + AMAZON_MARKETPLACE_ID)',
        })
      }
      const result = await runFbaStatusPoll()
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/poll-status] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/fba/poll-status', async () => {
    return { ok: true, ...getFbaStatusPollStatus() }
  })

  // ═══════════════════════════════════════════════════════════════════
  // SUPPLIERS + PURCHASE ORDERS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/suppliers', async (request, reply) => {
    const q = request.query as any
    const where: any = {}
    if (q.search?.trim()) where.name = { contains: q.search.trim(), mode: 'insensitive' }
    if (q.activeOnly === 'true') where.isActive = true
    const items = await prisma.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true, purchaseOrders: true } } },
    })
    return { items, total: items.length }
  })

  fastify.get('/fulfillment/suppliers/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        products: { include: { } as any },
        purchaseOrders: { take: 20, orderBy: { createdAt: 'desc' } },
      },
    })
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return supplier
  })

  // H.13 — supplier scorecard. Aggregates from PurchaseOrder +
  // InboundShipment + InboundShipmentItem over a rolling window
  // (default 365 days). Metrics:
  //   - leadTimeDays — avg/median/max of (createdAt → first inbound
  //     shipment for that PO arriving) in days. Only POs with at
  //     least one arrived inbound count.
  //   - onTimePercent — arrivedAt <= expectedAt / total arrived.
  //   - defectRate — (FAIL + HOLD items) / total received items.
  //   - openPOs — non-terminal POs.
  //   - spend — sum of PurchaseOrder.totalCents (all-time, since
  //     totals don't change after submit).
  fastify.get('/fulfillment/suppliers/:id/scorecard', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const q = request.query as { windowDays?: string }
      const windowDays = Math.max(1, Math.min(3650, Number(q.windowDays) || 365))
      const since = new Date(Date.now() - windowDays * 86400_000)

      const supplier = await prisma.supplier.findUnique({ where: { id }, select: { id: true, name: true, leadTimeDays: true, defaultCurrency: true } })
      if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })

      // POs in window with their inbound shipments + items.
      const pos = await prisma.purchaseOrder.findMany({
        where: { supplierId: id, createdAt: { gte: since } },
        include: {
          inboundShipments: {
            include: {
              items: { select: { qcStatus: true, quantityReceived: true, quantityExpected: true } },
            },
          },
        },
      })

      // Lead time: createdAt → earliest arrived inbound shipment.
      const leadDaysList: number[] = []
      let onTimeArrived = 0
      let totalArrived = 0
      let failHoldUnits = 0
      let receivedUnits = 0

      for (const po of pos) {
        const arrived = po.inboundShipments.filter((s) => s.arrivedAt != null)
        if (arrived.length > 0) {
          const earliest = arrived.reduce((acc, s) => acc.arrivedAt! < s.arrivedAt! ? acc : s)
          const leadMs = earliest.arrivedAt!.getTime() - po.createdAt.getTime()
          if (leadMs > 0) leadDaysList.push(leadMs / 86400_000)
        }
        for (const ship of arrived) {
          totalArrived++
          if (ship.expectedAt && ship.arrivedAt && ship.arrivedAt.getTime() <= ship.expectedAt.getTime()) {
            onTimeArrived++
          }
          for (const it of ship.items) {
            receivedUnits += it.quantityReceived
            if (it.qcStatus === 'FAIL' || it.qcStatus === 'HOLD') {
              failHoldUnits += it.quantityReceived
            }
          }
        }
      }

      const sortedLead = [...leadDaysList].sort((a, b) => a - b)
      const median = sortedLead.length === 0 ? null
        : sortedLead.length % 2 === 0
          ? (sortedLead[sortedLead.length / 2 - 1] + sortedLead[sortedLead.length / 2]) / 2
          : sortedLead[(sortedLead.length - 1) / 2]
      const avg = sortedLead.length === 0 ? null : sortedLead.reduce((s, x) => s + x, 0) / sortedLead.length
      const max = sortedLead.length === 0 ? null : sortedLead[sortedLead.length - 1]

      const openPOs = await prisma.purchaseOrder.count({
        where: { supplierId: id, status: { notIn: ['CLOSED', 'CANCELLED'] as any } },
      })
      const spendCents = pos.reduce((sum, p) => sum + (p.totalCents ?? 0), 0)

      return {
        supplierId: id,
        supplierName: supplier.name,
        windowDays,
        since: since.toISOString(),
        leadTime: {
          stated: supplier.leadTimeDays,
          observedAvgDays: avg,
          observedMedianDays: median,
          observedMaxDays: max,
          sampleCount: leadDaysList.length,
        },
        onTime: {
          arrivedCount: totalArrived,
          onTimeCount: onTimeArrived,
          percent: totalArrived === 0 ? null : (onTimeArrived / totalArrived) * 100,
        },
        defectRate: {
          totalUnitsReceived: receivedUnits,
          failHoldUnits,
          percent: receivedUnits === 0 ? null : (failHoldUnits / receivedUnits) * 100,
        },
        openPOs,
        spend: {
          totalCents: spendCents,
          currencyCode: supplier.defaultCurrency ?? 'EUR',
          poCount: pos.length,
        },
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[suppliers/:id/scorecard] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/fulfillment/suppliers', async (request, reply) => {
    try {
      const body = request.body as any
      if (!body.name) return reply.code(400).send({ error: 'name required' })
      const created = await prisma.supplier.create({ data: body })
      return created
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.patch('/fulfillment/suppliers/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as any
      const updated = await prisma.supplier.update({ where: { id }, data: body })
      return updated
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/purchase-orders', async (request, reply) => {
    try {
      const q = request.query as any
      const where: any = {}
      // H.4: status accepts comma-separated multi-select. Used by the
      // create-inbound modal to limit the PO picker to in-flight POs
      // (SUBMITTED, CONFIRMED, PARTIAL).
      if (q.status && q.status !== 'ALL') {
        const statuses = String(q.status).split(',').map((s) => s.trim()).filter(Boolean)
        if (statuses.length === 1) where.status = statuses[0]
        else if (statuses.length > 1) where.status = { in: statuses }
      }
      if (q.supplierId) where.supplierId = q.supplierId
      const items = await prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { code: true } },
          items: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { items, total: items.length }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/purchase-orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { supplier: true, warehouse: true, items: true, inboundShipments: true },
    })
    if (!po) return reply.code(404).send({ error: 'PO not found' })
    return po
  })

  // F.6 — Factory-ready PDF for a PO. Renders letterhead with company
  // branding (BrandSettings), per-product groups with images and Size×
  // Color matrix when applicable, totals, and a signature block.
  // Streams the PDF as application/pdf so the browser can preview or
  // download. Filename: factory-po-<poNumber>.pdf.
  fastify.get('/fulfillment/purchase-orders/:id/factory.pdf', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: {
          supplier: true,
          items: true,
        },
      })
      if (!po) return reply.code(404).send({ error: 'PO not found' })

      // Constraint #3 — Robust dual-architecture resolution. The codebase
      // carries two parent/child shapes:
      //   * ProductVariation: master Product → many ProductVariation rows
      //     (typical Amazon parent ASIN with size/color variants)
      //   * Hub-and-spoke (Phase 31): master Product → child Product rows
      //     via parentId (legacy pattern still in use for some catalogs)
      // SKUs may exist in either space; in pathological cases, the same
      // SKU could exist in BOTH (data drift). We resolve in this order:
      //   1. ProductVariation (canonical for new data)
      //   2. Child Product → parent Product (hub-and-spoke fallback)
      //   3. Standalone Product (no parent)
      //   4. Orphan (productId null or both lookups miss)
      // When step 1 + step 2/3 both match, we log a warning so data drift
      // is observable rather than silent.
      //
      // Two batched queries up front: variants by SKU (step 1) and products
      // by id+parentId chain (steps 2-3). Parents that aren't directly on
      // po.items get pulled in a second query.
      const itemProductIds = po.items
        .map((it) => it.productId)
        .filter((id): id is string => !!id)
      const itemSkus = po.items.map((it) => it.sku)

      const productSelect = {
        id: true,
        sku: true,
        name: true,
        productType: true,
        brand: true,
        parentId: true,
        isParent: true,
        images: {
          where: { type: 'MAIN' as const },
          select: { url: true },
          take: 1,
        },
      } as const

      const [variants, directProducts] = await Promise.all([
        prisma.productVariation.findMany({
          where: { sku: { in: itemSkus } },
          select: {
            sku: true,
            productId: true,
            variationAttributes: true,
            product: { select: productSelect },
          },
        }),
        prisma.product.findMany({
          where: { id: { in: itemProductIds } },
          select: productSelect,
        }),
      ])

      const variantBySku = new Map(variants.map((v) => [v.sku, v]))
      const productById = new Map(directProducts.map((p) => [p.id, p]))

      // Pull parent products for any hub-and-spoke children whose parents
      // aren't already loaded. Without this, a SKU's parent would fall
      // through to the child as the group identity (image / name / brand
      // come from the child instead of the parent product family).
      const missingParentIds = directProducts
        .map((p) => p.parentId)
        .filter(
          (pid): pid is string => !!pid && !productById.has(pid),
        )
      if (missingParentIds.length > 0) {
        const parents = await prisma.product.findMany({
          where: { id: { in: [...new Set(missingParentIds)] } },
          select: productSelect,
        })
        for (const p of parents) productById.set(p.id, p)
      }

      // Detect SKUs that exist in BOTH spaces — data drift. Log + flag
      // for observability without blocking the render.
      const dualSpaceSkus: string[] = []
      for (const item of po.items) {
        if (variantBySku.has(item.sku) && productById.has(item.productId ?? '')) {
          dualSpaceSkus.push(item.sku)
        }
      }
      if (dualSpaceSkus.length > 0) {
        fastify.log.warn(
          { skus: dualSpaceSkus, poId: id, poNumber: po.poNumber },
          'factory-pdf: SKUs found in both ProductVariation and Product spaces; preferring variant lookup',
        )
      }

      // Centralized resolver — always returns a group identity. This is
      // the single source of truth for "which group does this PO line
      // belong to"; the upsertGroup loop just picks up whatever this
      // returns.
      type ResolvedGroupIdentity = {
        groupKey: string
        productId: string
        productName: string
        productType: string | null
        brand: string | null
        imageUrl: string | null
      }
      const resolveGroupIdentity = (
        item: (typeof po.items)[number],
      ): ResolvedGroupIdentity => {
        // 1. ProductVariation (canonical)
        const variant = variantBySku.get(item.sku)
        if (variant) {
          const parent = variant.product
          return {
            groupKey: parent.id,
            productId: parent.id,
            productName: parent.name,
            productType: parent.productType ?? null,
            brand: parent.brand ?? null,
            imageUrl: parent.images[0]?.url ?? null,
          }
        }
        // 2 + 3. Direct product lookup (hub-and-spoke + standalone)
        const product = item.productId ? productById.get(item.productId) : null
        if (product) {
          const parent = product.parentId
            ? productById.get(product.parentId) ?? product
            : product
          return {
            groupKey: parent.id,
            productId: parent.id,
            productName: parent.name,
            productType: parent.productType ?? null,
            brand: parent.brand ?? null,
            imageUrl: parent.images[0]?.url ?? null,
          }
        }
        // 4. Orphan
        return {
          groupKey: `__orphan_${item.sku}`,
          productId: `__orphan_${item.sku}`,
          productName: `Unknown product (SKU: ${item.sku})`,
          productType: null,
          brand: null,
          imageUrl: null,
        }
      }

      const groupMap = new Map<string, FactoryPoProductGroup>()
      for (const item of po.items) {
        const identity = resolveGroupIdentity(item)
        const variant = variantBySku.get(item.sku)
        const line: FactoryPoVariantLine = {
          sku: item.sku,
          quantity: item.quantityOrdered,
          variationAttributes: variant
            ? (variant.variationAttributes as Record<string, string> | null)
            : null,
        }
        const existing = groupMap.get(identity.groupKey)
        if (existing) {
          existing.lines.push(line)
        } else {
          groupMap.set(identity.groupKey, {
            productId: identity.productId,
            productName: identity.productName,
            productType: identity.productType,
            brand: identity.brand,
            imageUrl: identity.imageUrl,
            lines: [line],
          })
        }
      }

      const groups = Array.from(groupMap.values())
      const totalUnits = po.items.reduce(
        (acc, it) => acc + it.quantityOrdered,
        0,
      )

      // BrandSettings — single-row pattern; create empty default if none.
      let brand = await prisma.brandSettings.findFirst()
      if (!brand) brand = await prisma.brandSettings.create({ data: {} })

      const input: FactoryPoInput = {
        poNumber: po.poNumber,
        status: po.status,
        expectedDeliveryDate: po.expectedDeliveryDate,
        notes: po.notes,
        createdAt: po.createdAt,
        brand: {
          companyName: brand.companyName,
          addressLines: brand.addressLines,
          taxId: brand.taxId,
          contactEmail: brand.contactEmail,
          contactPhone: brand.contactPhone,
          websiteUrl: brand.websiteUrl,
          logoUrl: brand.logoUrl,
          signatureBlockText: brand.signatureBlockText,
          defaultPoNotes: brand.defaultPoNotes,
        },
        supplier: po.supplier
          ? {
              id: po.supplier.id,
              name: po.supplier.name,
              contactName: po.supplier.contactName,
              email: po.supplier.email,
              phone: po.supplier.phone,
            }
          : null,
        groups,
        totalUnits,
      }

      const buffer = await renderFactoryPoPdf(input)

      reply
        .header('Content-Type', 'application/pdf')
        .header(
          'Content-Disposition',
          `inline; filename="factory-po-${po.poNumber}.pdf"`,
        )
        .header('Cache-Control', 'no-store')
      return reply.send(buffer)
    } catch (error: any) {
      fastify.log.error({ err: error }, '[purchase-orders/factory.pdf] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/purchase-orders', async (request, reply) => {
    try {
      const body = request.body as {
        supplierId?: string
        warehouseId?: string
        expectedDeliveryDate?: string
        notes?: string
        items?: Array<{ productId?: string; sku: string; supplierSku?: string; quantityOrdered: number; unitCostCents?: number }>
      }
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) return reply.code(400).send({ error: 'items[] required' })
      const totalCents = items.reduce((s, it) => s + (it.unitCostCents ?? 0) * it.quantityOrdered, 0)
      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: generatePoNumber(),
          supplierId: body.supplierId ?? null,
          warehouseId,
          status: 'DRAFT',
          expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
          notes: body.notes ?? null,
          totalCents,
          items: {
            create: items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              supplierSku: it.supplierSku ?? null,
              quantityOrdered: it.quantityOrdered,
              unitCostCents: it.unitCostCents ?? 0,
            })),
          },
        },
        include: { items: true },
      })
      return po
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/purchase-orders] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/purchase-orders/:id/submit', async (request, reply) => {
    const { id } = request.params as { id: string }
    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data: { status: 'SUBMITTED', version: { increment: 1 } },
    })
    return updated
  })

  fastify.post('/fulfillment/purchase-orders/:id/receive', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const po = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      })
      if (!po) return reply.code(404).send({ error: 'PO not found' })

      // Create an InboundShipment (type=SUPPLIER) tied to this PO.
      // H.0a — thread purchaseOrderItemId per row so the receive flow
      // can propagate quantities back to the PO without a sku rematch.
      const inbound = await prisma.inboundShipment.create({
        data: {
          type: 'SUPPLIER',
          status: 'DRAFT',
          warehouseId: po.warehouseId,
          purchaseOrderId: po.id,
          reference: `Receipt for ${po.poNumber}`,
          items: {
            create: po.items.map((it) => ({
              productId: it.productId,
              sku: it.sku,
              quantityExpected: it.quantityOrdered - (it.quantityReceived ?? 0),
              purchaseOrderItemId: it.id,
              // H.1 — thread expected per-unit cost from the PO line so
              // landed-cost variance can be computed at receive time.
              unitCostCents: it.unitCostCents ?? null,
            })),
          },
          // H.1 — propagate the PO's currency to the inbound. PO defaults
          // to EUR; if the operator set USD/GBP/CNY there, the inbound
          // mirrors so cost columns are interpreted consistently.
          currencyCode: po.currencyCode ?? 'EUR',
        },
        include: { items: true },
      })
      return { inboundShipmentId: inbound.id, items: inbound.items }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[po/:id/receive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // WORK ORDERS (in-house manufacturing)
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/work-orders', async (request, reply) => {
    const q = request.query as any
    const where: any = {}
    if (q.status && q.status !== 'ALL') where.status = q.status
    const items = await prisma.workOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    })
    return { items, total: items.length }
  })

  fastify.post('/fulfillment/work-orders', async (request, reply) => {
    try {
      const body = request.body as { productId: string; quantity: number; notes?: string }
      if (!body.productId || !body.quantity) return reply.code(400).send({ error: 'productId + quantity required' })
      const created = await prisma.workOrder.create({
        data: {
          productId: body.productId,
          quantity: body.quantity,
          status: 'PLANNED',
          notes: body.notes ?? null,
        },
      })
      return created
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/work-orders/:id/complete', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { actualQuantity?: number; costCents?: number; notes?: string }
      const wo = await prisma.workOrder.findUnique({ where: { id } })
      if (!wo) return reply.code(404).send({ error: 'WorkOrder not found' })

      const qty = body.actualQuantity ?? wo.quantity
      const updated = await prisma.workOrder.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          quantity: qty,
          costCents: body.costCents ?? wo.costCents,
          notes: body.notes ?? wo.notes,
        },
      })

      // Stock the produced units via StockMovement
      if (qty > 0) {
        await applyStockMovement({
          productId: wo.productId,
          change: qty,
          reason: 'MANUFACTURING_OUTPUT',
          referenceType: 'WorkOrder',
          referenceId: wo.id,
          actor: 'work-order-complete',
        })
      }
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[work-orders/:id/complete] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // RETURNS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/returns', async (request, reply) => {
    try {
      const q = request.query as any
      const where: any = {}
      if (q.status && q.status !== 'ALL') where.status = q.status
      if (q.channel) where.channel = q.channel
      if (q.fbaOnly === 'true') where.isFbaReturn = true
      if (q.fbaOnly === 'false') where.isFbaReturn = false
      const items = await prisma.return.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      return { items, total: items.length }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/returns/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const ret = await prisma.return.findUnique({ where: { id }, include: { items: true } })
    if (!ret) return reply.code(404).send({ error: 'Return not found' })
    return ret
  })

  fastify.post('/fulfillment/returns', async (request, reply) => {
    try {
      const body = request.body as {
        orderId?: string
        channel: string
        marketplace?: string
        reason?: string
        isFbaReturn?: boolean
        items?: Array<{ orderItemId?: string; productId?: string; sku: string; quantity: number }>
      }
      if (!body.channel) return reply.code(400).send({ error: 'channel required' })
      const items = Array.isArray(body.items) ? body.items : []

      const ret = await prisma.return.create({
        data: {
          orderId: body.orderId ?? null,
          channel: body.channel,
          marketplace: body.marketplace ?? null,
          rmaNumber: generateRmaNumber(),
          status: 'REQUESTED',
          reason: body.reason ?? null,
          isFbaReturn: !!body.isFbaReturn,
          items: {
            create: items.map((it) => ({
              orderItemId: it.orderItemId ?? null,
              productId: it.productId ?? null,
              sku: it.sku,
              quantity: it.quantity,
            })),
          },
        },
        include: { items: true },
      })
      return ret
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/returns] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/receive', async (request, reply) => {
    const { id } = request.params as { id: string }
    const updated = await prisma.return.update({
      where: { id },
      data: { status: 'RECEIVED', receivedAt: new Date(), version: { increment: 1 } },
    })
    return updated
  })

  fastify.post('/fulfillment/returns/:id/inspect', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items: Array<{ itemId: string; conditionGrade: string; notes?: string }>
        overallCondition?: string
      }
      for (const it of body.items ?? []) {
        await prisma.returnItem.update({
          where: { id: it.itemId },
          data: { conditionGrade: it.conditionGrade as any, notes: it.notes ?? null },
        })
      }
      const updated = await prisma.return.update({
        where: { id },
        data: {
          status: 'INSPECTING',
          conditionGrade: (body.overallCondition as any) ?? null,
          inspectedAt: new Date(),
          version: { increment: 1 },
        },
        include: { items: true },
      })
      return updated
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/restock', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { warehouseId?: string }
      const ret = await prisma.return.findUnique({ where: { id }, include: { items: true } })
      if (!ret) return reply.code(404).send({ error: 'Return not found' })

      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

      for (const item of ret.items) {
        if (!item.productId) continue
        // Only restock items graded NEW/LIKE_NEW/GOOD; DAMAGED and UNUSABLE go to write-off.
        const grade = item.conditionGrade
        if (grade === 'DAMAGED' || grade === 'UNUSABLE') continue
        await applyStockMovement({
          productId: item.productId,
          warehouseId,
          change: item.quantity,
          reason: 'RETURN_RESTOCKED',
          referenceType: 'Return',
          referenceId: ret.id,
          actor: 'return-restock',
        })
      }
      const updated = await prisma.return.update({
        where: { id },
        data: { status: 'RESTOCKED', restockedAt: new Date(), version: { increment: 1 } },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[returns/:id/restock] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/refund', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { refundCents?: number; auto?: boolean }
      const updated = await prisma.return.update({
        where: { id },
        data: {
          status: 'REFUNDED',
          refundStatus: 'REFUNDED',
          refundedAt: new Date(),
          refundCents: body.refundCents ?? null,
          version: { increment: 1 },
        },
      })
      return updated
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/returns/:id/scrap', async (request, reply) => {
    const { id } = request.params as { id: string }
    const updated = await prisma.return.update({
      where: { id },
      data: { status: 'SCRAPPED', version: { increment: 1 } },
    })
    return updated
  })

  // ═══════════════════════════════════════════════════════════════════
  // REPLENISHMENT — velocity-driven suggestions
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/replenishment', async (request, reply) => {
    try {
      const q = request.query as any
      const window = Math.min(90, Math.max(7, safeNum(q.window, 30) ?? 30))
      const since = new Date(Date.now() - window * 24 * 60 * 60 * 1000)
      since.setUTCHours(0, 0, 0, 0)
      // F.1 — Optional marketplace filter. When set, velocity is per-marketplace
      // (Amazon DE alone, eBay IT alone, etc.); when absent, all marketplaces sum.
      const marketplaceFilter =
        typeof q.marketplace === 'string' && q.marketplace.length > 0
          ? q.marketplace.toUpperCase()
          : null
      // F.1 — Optional channel filter. Same pattern.
      const channelFilter =
        typeof q.channel === 'string' && q.channel.length > 0
          ? q.channel.toUpperCase()
          : null

      // Pull all non-parent products
      const products = await prisma.product.findMany({
        where: { isParent: false, status: { not: 'INACTIVE' } },
        select: {
          id: true, sku: true, name: true, totalStock: true, lowStockThreshold: true,
          fulfillmentChannel: true, basePrice: true, costPrice: true,
        },
        take: 1000,
      })

      // F.1 — Read pre-aggregated demand from DailySalesAggregate instead of
      // GroupBy-ing the live OrderItem table. The aggregate is keyed by SKU
      // (not productId), so the join key here is sku — matches the data layer
      // and lets per-marketplace rows aggregate naturally.
      const skus = products.map((p) => p.sku)
      const sold = await prisma.dailySalesAggregate.groupBy({
        by: ['sku'],
        where: {
          sku: { in: skus },
          day: { gte: since },
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
        },
        _sum: { unitsSold: true },
      })
      const soldBySku = new Map<string, number>()
      for (const r of sold) soldBySku.set(r.sku, r._sum.unitsSold ?? 0)

      // R.2 — per-(sku, channel, marketplace) velocity for the
      // channelCover[] breakdown. Same date window as the global
      // groupBy. Ignores channel/marketplace filters: even with a
      // filter active, the drawer should still show the full per-
      // channel breakdown so operators can see which specific
      // channel is driving the urgency.
      const soldByChannel = await prisma.dailySalesAggregate.groupBy({
        by: ['sku', 'channel', 'marketplace'],
        where: { sku: { in: skus }, day: { gte: since } },
        _sum: { unitsSold: true },
      })
      const channelVelocityBySku = new Map<
        string,
        Array<{ channel: string; marketplace: string; unitsSold: number }>
      >()
      for (const r of soldByChannel) {
        const arr = channelVelocityBySku.get(r.sku) ?? []
        arr.push({
          channel: r.channel,
          marketplace: r.marketplace,
          unitsSold: r._sum.unitsSold ?? 0,
        })
        channelVelocityBySku.set(r.sku, arr)
      }

      // Pull replenishment rules (overrides) + supplier lead times
      const rules = await prisma.replenishmentRule.findMany({
        where: { productId: { in: products.map((p) => p.id) } },
      })
      const rulesByProduct = new Map(rules.map((r) => [r.productId, r]))

      // F.2 — Resolve per-product lead time + open inbound stock in two
      // batched queries (see atp.service.ts). The urgency formula now
      // uses effectiveStock = on-hand + inboundWithinLeadTime, so a SKU
      // with a 200-unit PO arriving in 5 days no longer fires a
      // false-positive CRITICAL when current stock is low.
      // R.2 — pass totalStock so legacy products without StockLevel
      // rows get a synthesized fallback row (UI flags amber).
      const atpByProduct = await resolveAtp({
        products: products.map((p) => ({ id: p.id, sku: p.sku, totalStock: p.totalStock })),
      })

      // F.4 — Pre-fetch ReplenishmentForecast rows for the entire visible
      // horizon (max lead time among the products) in one query, then
      // sum per-(sku, horizonDay) inline. Forecasts are scoped to the
      // active channel/marketplace filters so multi-marketplace SKUs
      // sum only the relevant marketplace's forecast.
      //
      // Two summary metrics per SKU:
      //   forecastedDemandLeadTime — sum over (today, today+leadTime+safety)
      //   forecastedDemand30d      — sum over the next 30 days (UI surface)
      // Plus lower80 / upper80 confidence bands for the lead-time horizon.
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      const horizonEnd = new Date(today)
      horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 90) // 90-day cap
      const forecasts = await prisma.replenishmentForecast.findMany({
        where: {
          sku: { in: skus },
          horizonDay: { gte: today, lte: horizonEnd },
          ...(channelFilter ? { channel: channelFilter } : {}),
          ...(marketplaceFilter ? { marketplace: marketplaceFilter } : {}),
        },
        select: {
          sku: true,
          horizonDay: true,
          forecastUnits: true,
          lower80: true,
          upper80: true,
        },
      })
      // Index by SKU; each row is one (sku, horizonDay) point. We sum
      // per-SKU at the right slices in the suggestions loop below.
      const forecastsBySku = new Map<
        string,
        Array<{ horizonDay: Date; units: number; lower: number; upper: number }>
      >()
      for (const f of forecasts) {
        const arr = forecastsBySku.get(f.sku) ?? []
        arr.push({
          horizonDay: f.horizonDay,
          units: Number(f.forecastUnits),
          lower: Number(f.lower80),
          upper: Number(f.upper80),
        })
        forecastsBySku.set(f.sku, arr)
      }

      const suggestions = products.map((p) => {
        const rule = rulesByProduct.get(p.id)
        const atp = atpByProduct.get(p.id)
        const unitsSold = soldBySku.get(p.sku) ?? 0
        const trailingVelocity = unitsSold / window // units per day, trailing
        const safetyDays = rule?.safetyStockDays ?? 7
        const leadTimeDays = atp?.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS
        const inboundWithinLeadTime = atp?.inboundWithinLeadTime ?? 0
        const totalOpenInbound = atp?.totalOpenInbound ?? 0
        const effectiveStock = p.totalStock + inboundWithinLeadTime

        // F.4 — Sum forecast over the relevant horizon. Falls back to
        // trailing velocity × days when no forecast row exists yet
        // (cold start before the first forecast worker run).
        const seriesForecasts = forecastsBySku.get(p.sku) ?? []
        const horizonWindowDays = leadTimeDays + safetyDays
        let forecastedDemandLeadTime = 0
        let forecastedLower = 0
        let forecastedUpper = 0
        let forecastedDemand30d = 0
        const horizonCutoffMs =
          today.getTime() + horizonWindowDays * 86400000
        const thirtyDayCutoffMs = today.getTime() + 30 * 86400000
        for (const f of seriesForecasts) {
          const ms = f.horizonDay.getTime()
          if (ms < horizonCutoffMs) {
            forecastedDemandLeadTime += f.units
            forecastedLower += f.lower
            forecastedUpper += f.upper
          }
          if (ms < thirtyDayCutoffMs) {
            forecastedDemand30d += f.units
          }
        }
        const hasForecast = seriesForecasts.length > 0
        const forecastVelocity = hasForecast
          ? forecastedDemand30d / 30
          : trailingVelocity
        // Velocity used for urgency / reorder-point math: prefer
        // forecast-derived value, fall back to trailing.
        const velocity = forecastVelocity

        const reorderPoint = rule?.reorderPoint ?? Math.ceil(velocity * (leadTimeDays + safetyDays))
        const reorderQuantity = rule?.reorderQuantity ?? Math.max(1, Math.ceil(velocity * 30))
        const daysOfStockLeft =
          velocity > 0 ? Math.floor(effectiveStock / velocity) : Infinity

        let urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
        if (effectiveStock === 0 && velocity > 0) urgency = 'CRITICAL'
        else if (daysOfStockLeft <= leadTimeDays / 2) urgency = 'CRITICAL'
        else if (daysOfStockLeft <= leadTimeDays) urgency = 'HIGH'
        else if (effectiveStock <= reorderPoint) urgency = 'MEDIUM'
        else urgency = 'LOW'

        const needsReorder = effectiveStock <= reorderPoint && velocity > 0

        // R.2 — per-channel days-of-cover. For each (channel,
        // marketplace) tuple this product sold on, resolve which
        // location pool serves it and divide its available units by
        // the channel-specific velocity. Headline urgency is still
        // global (changes ship in R.4); this gives the drawer
        // visibility into which channels are at risk.
        const isFba = p.fulfillmentChannel === 'FBA'
        const channelCover = (channelVelocityBySku.get(p.sku) ?? [])
          .map((v) => {
            const stock = resolveStockForChannel({
              byLocation: atp?.byLocation ?? [],
              channel: v.channel,
              marketplace: v.marketplace,
              fulfillmentMethod:
                v.channel === 'AMAZON' ? (isFba ? 'FBA' : 'FBM') : null,
            })
            const channelVelocity = v.unitsSold / window
            const daysOfCover =
              channelVelocity > 0
                ? Math.floor(stock.available / channelVelocity)
                : null
            return {
              channel: v.channel,
              marketplace: v.marketplace,
              velocityPerDay: Number(channelVelocity.toFixed(2)),
              available: stock.available,
              locationCode: stock.locationCode,
              source: stock.source as ChannelLocationSource,
              daysOfCover,
            }
          })
          .sort((a, b) =>
            // Sort: lowest cover first (most urgent), then by channel name
            (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) -
              (b.daysOfCover ?? Number.MAX_SAFE_INTEGER) ||
            a.channel.localeCompare(b.channel),
          )

        return {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          currentStock: p.totalStock,
          // F.2 — ATP composition for the UI: on-hand + inbound within lead
          // time = effective stock the urgency math actually used.
          inboundWithinLeadTime,
          totalOpenInbound,
          effectiveStock,
          openShipments: atp?.openShipments ?? [],
          // R.2 — multi-location stock breakdown (replaces the implicit
          // "currentStock = Product.totalStock" assumption).
          byLocation: atp?.byLocation ?? [],
          totalAvailable: atp?.totalAvailable ?? 0,
          stockSource: atp?.stockSource ?? 'STOCK_LEVEL',
          channelCover,
          unitsSold30d: unitsSold,
          // F.4 — forecast-driven velocity + horizon demand. Trailing
          // velocity is kept as a reference so the UI can show
          // "trailing 30d: X/day" alongside "forecast next 30d: Y/day".
          velocity: Number(velocity.toFixed(2)),
          trailingVelocity: Number(trailingVelocity.toFixed(2)),
          forecastedDemand30d: hasForecast
            ? Number(forecastedDemand30d.toFixed(2))
            : null,
          forecastedDemandLeadTime: hasForecast
            ? Number(forecastedDemandLeadTime.toFixed(2))
            : null,
          forecastedDemandLower80: hasForecast
            ? Number(forecastedLower.toFixed(2))
            : null,
          forecastedDemandUpper80: hasForecast
            ? Number(forecastedUpper.toFixed(2))
            : null,
          forecastSource: hasForecast ? 'FORECAST' : 'TRAILING_VELOCITY',
          daysOfStockLeft: daysOfStockLeft === Infinity ? null : daysOfStockLeft,
          reorderPoint,
          reorderQuantity,
          urgency,
          needsReorder,
          // F.2 — surface lead-time provenance so the UI can show
          // "from supplier override" vs "from supplier default" vs "fallback".
          leadTimeDays,
          leadTimeSource: atp?.leadTimeSource ?? 'FALLBACK',
          isManufactured: !!rule?.isManufactured,
          preferredSupplierId: rule?.preferredSupplierId ?? null,
          fulfillmentChannel: p.fulfillmentChannel,
        }
      })

      // Sort: CRITICAL first, then HIGH, MEDIUM, LOW
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
      suggestions.sort((a, b) => order[a.urgency] - order[b.urgency] || (a.daysOfStockLeft ?? 999) - (b.daysOfStockLeft ?? 999))

      // R.3 — persist recommendations (diff-aware: only writes rows
      // for products whose urgency / qty / stock / needsReorder
      // actually changed vs the current ACTIVE row). Failure to
      // persist must not block the page render — service logs +
      // returns prev id when individual writes fail.
      const recommendationInputs: RecommendationInput[] = suggestions.map((s) => ({
        productId: s.productId,
        sku: s.sku,
        velocity: s.velocity,
        velocitySource: s.forecastSource as VelocitySource,
        leadTimeDays: s.leadTimeDays,
        leadTimeSource: s.leadTimeSource,
        safetyDays: rulesByProduct.get(s.productId)?.safetyStockDays ?? 7,
        totalAvailable: s.totalAvailable,
        inboundWithinLeadTime: s.inboundWithinLeadTime,
        effectiveStock: s.effectiveStock,
        reorderPoint: s.reorderPoint,
        reorderQuantity: s.reorderQuantity,
        daysOfStockLeft: s.daysOfStockLeft,
        urgency: s.urgency as Urgency,
        needsReorder: s.needsReorder,
        preferredSupplierId: s.preferredSupplierId,
        isManufactured: s.isManufactured,
      }))
      const recIdsByProduct = await bulkPersistRecommendationsIfChanged(
        recommendationInputs,
      ).catch((err) => {
        fastify.log.warn({ err }, '[replenishment] persist failed — continuing without ids')
        return new Map<string, string>()
      })

      // Attach recommendationId to each suggestion so the UI can
      // round-trip it back when creating a PO.
      const suggestionsWithRecId = suggestions.map((s) => ({
        ...s,
        recommendationId: recIdsByProduct.get(s.productId) ?? null,
      }))

      const counts = {
        critical: suggestionsWithRecId.filter((s) => s.urgency === 'CRITICAL').length,
        high: suggestionsWithRecId.filter((s) => s.urgency === 'HIGH').length,
        medium: suggestionsWithRecId.filter((s) => s.urgency === 'MEDIUM').length,
        low: suggestionsWithRecId.filter((s) => s.urgency === 'LOW').length,
      }

      return {
        suggestions: suggestionsWithRecId,
        counts,
        window,
        // F.1 — surface the active filters so the UI can render them
        // without re-parsing the query string.
        filter: {
          channel: channelFilter,
          marketplace: marketplaceFilter,
        },
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/replenishment] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.1 — Manual recompute. Re-aggregates OrderItem rows in the given
  // window into DailySalesAggregate. Useful after order corrections
  // (refunds, cancellations) when waiting for the nightly job is too slow.
  // Defaults: last 7 days. Window cap: 365 days per call.
  fastify.post('/fulfillment/replenishment/refresh-aggregates', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        from?: string
        to?: string
        days?: number
        overrideReportSources?: boolean
      }
      const days = body.days
        ? Math.min(365, Math.max(1, Math.floor(body.days)))
        : null
      const now = new Date()
      let to: Date
      let from: Date
      if (body.from && body.to) {
        from = new Date(body.from)
        to = new Date(body.to)
      } else if (days != null) {
        to = now
        from = new Date(now.getTime() - (days - 1) * 86400000)
      } else {
        to = now
        from = new Date(now.getTime() - 6 * 86400000) // last 7 days inclusive
      }
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return reply.code(400).send({ error: 'Invalid from/to dates' })
      }

      const result = await refreshSalesAggregates({
        from,
        to,
        overrideReportSources: !!body.overrideReportSources,
      })
      return {
        ok: true,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        ...result,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/refresh-aggregates] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.3 — Manual sales-report ingest trigger. Without a date range,
  // ingests yesterday for every active Amazon marketplace. With
  // marketplace + day, runs the single-marketplace path. Useful for
  // dev/test (no cron required) and for catch-up after API outages.
  //
  // Without SP-API credentials this endpoint will surface the auth
  // failure as a 500 with the SP-API error message in the body —
  // exactly what the cron would log. NOT a runtime crash.
  fastify.post('/fulfillment/sales-reports/ingest', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        marketplace?: string
        day?: string
        skipIfReportExists?: boolean
      }

      const day = body.day ? new Date(body.day) : (() => {
        const d = new Date()
        d.setUTCHours(0, 0, 0, 0)
        d.setUTCDate(d.getUTCDate() - 1) // default: yesterday
        return d
      })()
      if (Number.isNaN(day.getTime())) {
        return reply.code(400).send({ error: 'Invalid day (expected YYYY-MM-DD)' })
      }

      if (body.marketplace) {
        const result = await ingestSalesTrafficForDay({
          marketplaceCode: body.marketplace,
          day,
          skipIfReportExists: !!body.skipIfReportExists,
        })
        return { ok: true, single: result }
      }
      const results = await ingestAllAmazonMarketplaces(day)
      return { ok: true, results }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[sales-reports/ingest] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.5 — Upcoming retail events for the banner. Returns events whose
  // window overlaps with the next 90 days, sorted by startDate ASC. Each
  // event carries a `prepDeadline` derived from startDate − prepLeadTimeDays
  // so the UI can render "Black Friday in 47 days — last day to PO: Oct 13".
  fastify.get('/fulfillment/replenishment/upcoming-events', async (_request, reply) => {
    try {
      const today = new Date()
      today.setUTCHours(0, 0, 0, 0)
      const horizonEnd = new Date(today)
      horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 90)

      const events = await prisma.retailEvent.findMany({
        where: {
          isActive: true,
          startDate: { lte: horizonEnd },
          endDate: { gte: today },
        },
        orderBy: { startDate: 'asc' },
        take: 20,
      })

      const annotated = events.map((e) => {
        const prepDeadline = new Date(e.startDate)
        prepDeadline.setUTCDate(
          prepDeadline.getUTCDate() - e.prepLeadTimeDays,
        )
        const daysUntilStart = Math.ceil(
          (e.startDate.getTime() - today.getTime()) / 86400000,
        )
        const daysUntilDeadline = Math.ceil(
          (prepDeadline.getTime() - today.getTime()) / 86400000,
        )
        return {
          id: e.id,
          name: e.name,
          startDate: e.startDate.toISOString().slice(0, 10),
          endDate: e.endDate.toISOString().slice(0, 10),
          channel: e.channel,
          marketplace: e.marketplace,
          productType: e.productType,
          expectedLift: Number(e.expectedLift),
          prepLeadTimeDays: e.prepLeadTimeDays,
          prepDeadline: prepDeadline.toISOString().slice(0, 10),
          daysUntilStart,
          daysUntilDeadline,
          description: e.description,
        }
      })
      return { events: annotated }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/upcoming-events] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R.1 — Per-SKU forecast accuracy. Drawer card + per-product
  // dashboards. Returns rolling MAPE, MAE, band calibration, plus a
  // by-regime breakdown so we can compare HOLT_WINTERS vs
  // TRAILING_MEAN_FALLBACK head-to-head on the same SKU.
  fastify.get('/fulfillment/replenishment/forecast-accuracy', async (request, reply) => {
    try {
      const q = request.query as { sku?: string; channel?: string; marketplace?: string; windowDays?: string }
      if (!q.sku) return reply.code(400).send({ error: 'sku required' })
      const windowDays = Math.max(1, Math.min(365, Number(q.windowDays) || 30))
      const result = await getAccuracyForSku({
        sku: q.sku,
        channel: q.channel,
        marketplace: q.marketplace,
        windowDays,
      })
      return result
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/forecast-accuracy] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.1 — aggregate accuracy. Powers the workspace "Forecast health"
  // card. groupBy=regime is the head-to-head model comparison; channel
  // / marketplace are also available for future drilldowns.
  fastify.get('/fulfillment/replenishment/forecast-accuracy/aggregate', async (request, reply) => {
    try {
      const q = request.query as { windowDays?: string; groupBy?: string }
      const windowDays = Math.max(1, Math.min(365, Number(q.windowDays) || 30))
      const groupBy = (q.groupBy === 'regime' || q.groupBy === 'channel' || q.groupBy === 'marketplace')
        ? q.groupBy
        : 'none'
      const result = await getAccuracyAggregate({ windowDays, groupBy })
      return result
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/forecast-accuracy/aggregate] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.1 — manual backfill. One-shot at deploy time so dashboards have
  // numbers from day one (cron only populates yesterday onward).
  // POST body: { fromDay: 'YYYY-MM-DD', toDay: 'YYYY-MM-DD' }.
  fastify.post('/fulfillment/replenishment/forecast-accuracy/backfill', async (request, reply) => {
    try {
      const body = request.body as { fromDay?: string; toDay?: string }
      if (!body.fromDay || !body.toDay) return reply.code(400).send({ error: 'fromDay + toDay required (YYYY-MM-DD)' })
      const fromDay = new Date(body.fromDay + 'T00:00:00Z')
      const toDay = new Date(body.toDay + 'T00:00:00Z')
      if (Number.isNaN(fromDay.getTime()) || Number.isNaN(toDay.getTime())) {
        return reply.code(400).send({ error: 'fromDay/toDay must be ISO YYYY-MM-DD' })
      }
      const r = await backfillForecastAccuracy({ fromDay, toDay })
      return { ok: true, ...r }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/forecast-accuracy/backfill] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // F.5 — Per-SKU forecast detail. Returns 90 days of point forecasts,
  // confidence bands, signal breakdown, recent (60d) actuals, and any
  // open inbound shipments — enough to render the row-detail drawer's
  // chart + signal panel + shipment list without further API calls.
  fastify.get<{ Params: { productId: string } }>(
    '/fulfillment/replenishment/:productId/forecast-detail',
    async (request, reply) => {
      try {
        const { productId } = request.params
        const q = request.query as any
        const channel =
          typeof q.channel === 'string' && q.channel.length > 0
            ? q.channel.toUpperCase()
            : null
        const marketplace =
          typeof q.marketplace === 'string' && q.marketplace.length > 0
            ? q.marketplace.toUpperCase()
            : null

        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: { id: true, sku: true, name: true, totalStock: true, fulfillmentChannel: true },
        })
        if (!product) return reply.code(404).send({ error: 'Product not found' })

        const today = new Date()
        today.setUTCHours(0, 0, 0, 0)
        const horizonEnd = new Date(today)
        horizonEnd.setUTCDate(horizonEnd.getUTCDate() + 90)
        const historyStart = new Date(today)
        historyStart.setUTCDate(historyStart.getUTCDate() - 60)

        const [forecastRows, historyRows, atpEntry] = await Promise.all([
          prisma.replenishmentForecast.findMany({
            where: {
              sku: product.sku,
              horizonDay: { gte: today, lte: horizonEnd },
              ...(channel ? { channel } : {}),
              ...(marketplace ? { marketplace } : {}),
            },
            orderBy: { horizonDay: 'asc' },
            select: {
              horizonDay: true,
              forecastUnits: true,
              lower80: true,
              upper80: true,
              signals: true,
              model: true,
              generationTag: true,
            },
          }),
          prisma.dailySalesAggregate.findMany({
            where: {
              sku: product.sku,
              day: { gte: historyStart, lt: today },
              ...(channel ? { channel } : {}),
              ...(marketplace ? { marketplace } : {}),
            },
            orderBy: { day: 'asc' },
            select: { day: true, unitsSold: true },
          }),
          resolveAtp({ products: [{ id: product.id, sku: product.sku, totalStock: product.totalStock }] }).then(
            (m) => m.get(product.id) ?? null,
          ),
        ])

        // Aggregate per-day across channels/marketplaces if no filter
        // (frontend usually passes filter; this branch is the catch-all).
        const historyByDay = new Map<string, number>()
        for (const r of historyRows) {
          const key = r.day.toISOString().slice(0, 10)
          historyByDay.set(key, (historyByDay.get(key) ?? 0) + r.unitsSold)
        }
        const forecastByDay = new Map<string, {
          point: number
          lower: number
          upper: number
          signals: any
        }>()
        for (const r of forecastRows) {
          const key = r.horizonDay.toISOString().slice(0, 10)
          const existing = forecastByDay.get(key)
          if (existing) {
            existing.point += Number(r.forecastUnits)
            existing.lower += Number(r.lower80)
            existing.upper += Number(r.upper80)
          } else {
            forecastByDay.set(key, {
              point: Number(r.forecastUnits),
              lower: Number(r.lower80),
              upper: Number(r.upper80),
              signals: r.signals,
            })
          }
        }

        // Build a continuous 60d-history + 90d-forecast series for the chart.
        const series: Array<{
          day: string
          actual: number | null
          forecast: number | null
          lower80: number | null
          upper80: number | null
        }> = []
        const cursor = new Date(historyStart)
        while (cursor < today) {
          const key = cursor.toISOString().slice(0, 10)
          series.push({
            day: key,
            actual: historyByDay.get(key) ?? 0,
            forecast: null,
            lower80: null,
            upper80: null,
          })
          cursor.setUTCDate(cursor.getUTCDate() + 1)
        }
        const forecastCursor = new Date(today)
        for (let i = 0; i < 90; i++) {
          const key = forecastCursor.toISOString().slice(0, 10)
          const f = forecastByDay.get(key)
          series.push({
            day: key,
            actual: null,
            forecast: f?.point ?? null,
            lower80: f?.lower ?? null,
            upper80: f?.upper ?? null,
          })
          forecastCursor.setUTCDate(forecastCursor.getUTCDate() + 1)
        }

        // Signal breakdown — use the most recent forecast row's signals
        // (they're typically constant across the horizon for a given series
        // unless events mid-window). Caller can drill if they want per-day.
        const latestSignals =
          forecastRows.length > 0 ? forecastRows[0].signals : null

        // R.2 — per-(channel, marketplace) days-of-cover for the
        // drawer's channel breakdown panel. 30-day rolling velocity
        // per channel-marketplace, divided by the location-pool
        // available units that channel resolves to.
        const channelWindowDays = 30
        const channelSince = new Date(today)
        channelSince.setUTCDate(channelSince.getUTCDate() - channelWindowDays)
        const channelSold = await prisma.dailySalesAggregate.groupBy({
          by: ['channel', 'marketplace'],
          where: { sku: product.sku, day: { gte: channelSince, lt: today } },
          _sum: { unitsSold: true },
        })
        const isFba = product.fulfillmentChannel === 'FBA'
        const channelCover = channelSold
          .map((row) => {
            const stock = resolveStockForChannel({
              byLocation: atpEntry?.byLocation ?? [],
              channel: row.channel,
              marketplace: row.marketplace,
              fulfillmentMethod:
                row.channel === 'AMAZON' ? (isFba ? 'FBA' : 'FBM') : null,
            })
            const units = row._sum.unitsSold ?? 0
            const velocityPerDay = units / channelWindowDays
            const daysOfCover =
              velocityPerDay > 0
                ? Math.floor(stock.available / velocityPerDay)
                : null
            return {
              channel: row.channel,
              marketplace: row.marketplace,
              velocityPerDay: Number(velocityPerDay.toFixed(2)),
              available: stock.available,
              locationCode: stock.locationCode,
              source: stock.source,
              daysOfCover,
            }
          })
          .sort((a, b) =>
            (a.daysOfCover ?? Number.MAX_SAFE_INTEGER) -
              (b.daysOfCover ?? Number.MAX_SAFE_INTEGER) ||
            a.channel.localeCompare(b.channel),
          )

        return {
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            currentStock: product.totalStock,
          },
          atp: atpEntry,
          channelCover,
          model: forecastRows[0]?.model ?? null,
          generationTag: forecastRows[0]?.generationTag ?? null,
          signals: latestSignals,
          series,
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[replenishment/forecast-detail] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    },
  )

  // F.5 — Bulk draft PO. Accepts an array of {productId, quantity,
  // supplierId?, notes?} and groups them into one PO per supplier.
  // Lets the user multi-select 12 SKUs in the grid and one-click
  // "Create POs from selection" without 12 round-trips.
  fastify.post('/fulfillment/replenishment/bulk-draft-po', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        items?: Array<{
          productId: string
          quantity: number
          supplierId?: string | null
          notes?: string | null
          // R.3 — link the resulting PO/WO back to the source rec.
          recommendationId?: string | null
          // R.3 — operator's quantity override (if quantity != suggested).
          quantityOverride?: number | null
          overrideNotes?: string | null
        }>
        notes?: string
        userId?: string
      }
      const items = body.items ?? []
      if (items.length === 0) {
        return reply.code(400).send({ error: 'items[] is required' })
      }

      // Resolve supplierIds + manufactured flag per product via
      // ReplenishmentRule. Items split into two paths:
      //   * Manufactured (rule.isManufactured = true) → one WorkOrder per
      //     item (manufacturing is per-product, not batched by supplier).
      //   * Sourced from a supplier → grouped into one PO per supplier;
      //     items without a resolved supplier land in a single
      //     "no-supplier" PO the user must assign before submitting.
      const productIds = items.map((i) => i.productId)
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true },
      })
      const productById = new Map(products.map((p) => [p.id, p]))

      const rules = await prisma.replenishmentRule.findMany({
        where: { productId: { in: productIds } },
        select: {
          productId: true,
          preferredSupplierId: true,
          isManufactured: true,
        },
      })
      const ruleByProduct = new Map(
        rules.map(
          (r) =>
            [
              r.productId,
              {
                supplierId: r.preferredSupplierId,
                isManufactured: r.isManufactured,
              },
            ] as const,
        ),
      )

      // R.3 — line shape carries the optional source recommendationId
      // + override fields so we can attach PO/WO ids back after create.
      type Line = {
        productId: string
        sku: string
        quantity: number
        notes?: string | null
        recommendationId?: string | null
        quantityOverride?: number | null
        overrideNotes?: string | null
      }
      const grouped = new Map<string, Line[]>()
      const manufactured: Line[] = []
      const skipped: Array<{ productId: string; reason: string }> = []
      for (const item of items) {
        const product = productById.get(item.productId)
        if (!product) {
          skipped.push({ productId: item.productId, reason: 'product not found' })
          continue
        }
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
          skipped.push({ productId: item.productId, reason: 'quantity must be > 0' })
          continue
        }
        const rule = ruleByProduct.get(item.productId)
        const line: Line = {
          productId: item.productId,
          sku: product.sku,
          quantity: Math.floor(item.quantity),
          notes: item.notes ?? null,
          recommendationId: item.recommendationId ?? null,
          quantityOverride: item.quantityOverride ?? null,
          overrideNotes: item.overrideNotes ?? null,
        }
        // Manufactured items create a WorkOrder, not a PO line.
        if (rule?.isManufactured) {
          manufactured.push(line)
          continue
        }
        const supplierId = item.supplierId ?? rule?.supplierId ?? null
        const key = supplierId ?? '__no_supplier__'
        const arr = grouped.get(key) ?? []
        arr.push(line)
        grouped.set(key, arr)
      }

      // Pre-fetch supplier contact info so the response carries enough
      // data for the UI to build a "Email supplier" mailto: link without
      // a second round-trip.
      const involvedSupplierIds = [...grouped.keys()].filter(
        (k) => k !== '__no_supplier__',
      )
      const suppliers =
        involvedSupplierIds.length > 0
          ? await prisma.supplier.findMany({
              where: { id: { in: involvedSupplierIds } },
              select: { id: true, name: true, email: true, contactName: true },
            })
          : []
      const supplierById = new Map(suppliers.map((s) => [s.id, s]))

      const createdPos: Array<{
        id: string
        poNumber: string
        supplierId: string | null
        supplierName: string | null
        supplierEmail: string | null
        itemCount: number
        totalUnits: number
      }> = []
      for (const [supplierKey, lineItems] of grouped) {
        const supplierId = supplierKey === '__no_supplier__' ? null : supplierKey
        const supplier = supplierId ? supplierById.get(supplierId) : null
        const totalUnits = lineItems.reduce((acc, li) => acc + li.quantity, 0)
        const po = await prisma.purchaseOrder.create({
          data: {
            poNumber: generatePoNumber(),
            supplierId,
            status: 'DRAFT',
            totalCents: 0,
            notes: body.notes ?? null,
            items: {
              create: lineItems.map((li) => ({
                productId: li.productId,
                sku: li.sku,
                quantityOrdered: li.quantity,
              })),
            },
          },
          select: { id: true, poNumber: true, supplierId: true, _count: { select: { items: true } } },
        })
        createdPos.push({
          id: po.id,
          poNumber: po.poNumber,
          supplierId: po.supplierId,
          supplierName: supplier?.name ?? null,
          supplierEmail: supplier?.email ?? null,
          itemCount: po._count.items,
          totalUnits,
        })

        // R.3 — attach this PO back to every source recommendation
        // that contributed a line to it. Failures don't roll back the
        // PO (audit trail is best-effort, not transactional with
        // PO creation).
        for (const li of lineItems) {
          if (!li.recommendationId) continue
          await attachPoToRecommendation({
            recommendationId: li.recommendationId,
            poId: po.id,
            overrideQuantity: li.quantityOverride ?? null,
            overrideNotes: li.overrideNotes ?? null,
            userId: body.userId ?? null,
          }).catch((err) => {
            fastify.log.warn({ err, recId: li.recommendationId, poId: po.id }, '[replenishment] attach failed')
          })
        }
      }

      // Manufactured items → one WorkOrder per line. WorkOrders have no
      // SKU concept; the productId carries the manufacturing target.
      const createdWorkOrders: Array<{
        id: string
        productId: string
        quantity: number
      }> = []
      for (const line of manufactured) {
        const wo = await prisma.workOrder.create({
          data: {
            productId: line.productId,
            quantity: line.quantity,
            status: 'PLANNED',
            notes: body.notes ?? null,
          },
          select: { id: true, productId: true, quantity: true },
        })
        createdWorkOrders.push(wo)

        if (line.recommendationId) {
          await attachPoToRecommendation({
            recommendationId: line.recommendationId,
            workOrderId: wo.id,
            overrideQuantity: line.quantityOverride ?? null,
            overrideNotes: line.overrideNotes ?? null,
            userId: body.userId ?? null,
          }).catch((err) => {
            fastify.log.warn({ err, recId: line.recommendationId, woId: wo.id }, '[replenishment] attach failed')
          })
        }
      }

      return {
        ok: true,
        createdPos,
        createdWorkOrders,
        itemsAccepted: items.length - skipped.length,
        skipped,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/bulk-draft-po] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // F.4 — Manual forecast trigger. Without a body, regenerates forecasts
  // for every series in the catalog. With { sku, channel, marketplace }
  // body, regenerates a single series (useful for debugging a specific
  // SKU's forecast in dev / after a manual data correction).
  fastify.post('/fulfillment/forecast/run', async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        sku?: string
        channel?: string
        marketplace?: string
        includeColdStart?: boolean
      }
      if (body.sku && body.channel && body.marketplace) {
        // Resolve productType for category-aware weather elasticity.
        const product = await prisma.product.findFirst({
          where: { sku: body.sku },
          select: { productType: true },
        })
        const variant = !product
          ? await prisma.productVariation.findFirst({
              where: { sku: body.sku },
              select: { product: { select: { productType: true } } },
            })
          : null
        const productType = product?.productType ?? variant?.product.productType ?? null

        const result = await generateForecastForSeries({
          sku: body.sku,
          channel: body.channel.toUpperCase(),
          marketplace: body.marketplace.toUpperCase(),
          productType,
        })
        return { ok: true, single: result }
      }
      const result = await generateForecastsForAll({
        includeColdStart: !!body.includeColdStart,
      })
      return { ok: true, ...result }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[forecast/run] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/replenishment/:productId/draft-po', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const body = request.body as {
        quantity?: number
        supplierId?: string
        expectedDeliveryDate?: string
        // R.3 — link the resulting PO back to the source rec.
        recommendationId?: string
        quantityOverride?: number | null
        overrideNotes?: string | null
        userId?: string
      }
      const product = await prisma.product.findUnique({ where: { id: productId }, select: { sku: true } })
      if (!product) return reply.code(404).send({ error: 'Product not found' })
      const supplierId = body.supplierId ?? (await prisma.replenishmentRule.findUnique({ where: { productId } }))?.preferredSupplierId ?? null

      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: generatePoNumber(),
          supplierId,
          status: 'DRAFT',
          expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
          totalCents: 0,
          items: {
            create: [{
              productId,
              sku: product.sku,
              quantityOrdered: body.quantity ?? 1,
            }],
          },
        },
        include: { items: true },
      })

      // R.3 — attach back to the source rec when provided.
      if (body.recommendationId) {
        await attachPoToRecommendation({
          recommendationId: body.recommendationId,
          poId: po.id,
          overrideQuantity: body.quantityOverride ?? null,
          overrideNotes: body.overrideNotes ?? null,
          userId: body.userId ?? null,
        }).catch((err) => {
          fastify.log.warn({ err, recId: body.recommendationId, poId: po.id }, '[replenishment] attach failed')
        })
      }

      return po
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/draft-po] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // R.3 — recommendation history per product. Chronological list of
  // every recommendation we've ever shown for this product, with
  // status + supersession + ACTED transitions. Powers the drawer
  // History mini-section.
  fastify.get('/fulfillment/replenishment/:productId/history', async (request, reply) => {
    try {
      const { productId } = request.params as { productId: string }
      const q = request.query as { limit?: string }
      const limit = Math.max(1, Math.min(500, Number(q.limit) || 50))
      const rows = await getRecommendationHistory(productId, limit)
      return {
        productId,
        history: rows.map((r) => ({
          id: r.id,
          generatedAt: r.generatedAt,
          urgency: r.urgency,
          reorderQuantity: r.reorderQuantity,
          reorderPoint: r.reorderPoint,
          daysOfStockLeft: r.daysOfStockLeft,
          effectiveStock: r.effectiveStock,
          totalAvailable: r.totalAvailable,
          status: r.status,
          supersededAt: r.supersededAt,
          actedAt: r.actedAt,
          resultingPoId: r.resultingPoId,
          resultingWorkOrderId: r.resultingWorkOrderId,
          overrideQuantity: r.overrideQuantity,
          overrideNotes: r.overrideNotes,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/:productId/history] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // R.3 — single recommendation by id. Useful for forensics + future
  // approval workflow surfaces.
  fastify.get('/fulfillment/replenishment/recommendations/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const row = await getRecommendationById(id)
      if (!row) return reply.code(404).send({ error: 'Recommendation not found' })
      return row
    } catch (err: any) {
      fastify.log.error({ err }, '[replenishment/recommendations/:id] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // CARRIERS
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/carriers', async (_request, reply) => {
    try {
      const items = await prisma.carrier.findMany({ orderBy: { code: 'asc' } })
      // Don't expose encrypted creds
      return {
        items: items.map((c) => ({
          id: c.id, code: c.code, name: c.name,
          isActive: c.isActive, hasCredentials: !!c.credentialsEncrypted,
          defaultServiceMap: c.defaultServiceMap, updatedAt: c.updatedAt,
        })),
      }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/carriers/:code/connect', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const body = request.body as { publicKey?: string; privateKey?: string; integrationId?: number; defaultServiceMap?: any }
      // For B.9 we store creds as JSON for now. Phase: rotate to AES-256-GCM
      // matching MarketplaceCredential, sharing the same crypto helper.
      const credentialsEncrypted = JSON.stringify({
        publicKey: body.publicKey,
        privateKey: body.privateKey,
        integrationId: body.integrationId,
      })
      const existing = await prisma.carrier.findUnique({ where: { code: code as any } })
      const data = {
        code: code as any,
        name: code === 'SENDCLOUD' ? 'Sendcloud' : code === 'AMAZON_BUY_SHIPPING' ? 'Amazon Buy Shipping' : 'Manual',
        isActive: true,
        credentialsEncrypted,
        defaultServiceMap: body.defaultServiceMap ?? null,
      }
      const upserted = existing
        ? await prisma.carrier.update({ where: { code: code as any }, data })
        : await prisma.carrier.create({ data })
      return { ok: true, carrier: { id: upserted.id, code: upserted.code, name: upserted.name, isActive: upserted.isActive } }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[carriers/:code/connect] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/carriers/:code/disconnect', async (request, reply) => {
    try {
      const { code } = request.params as { code: string }
      const existing = await prisma.carrier.findUnique({ where: { code: code as any } })
      if (!existing) return reply.code(404).send({ error: 'Carrier not connected' })
      await prisma.carrier.update({
        where: { code: code as any },
        data: { isActive: false, credentialsEncrypted: null },
      })
      return { ok: true }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // WAREHOUSE
  // ═══════════════════════════════════════════════════════════════════

  fastify.get('/fulfillment/warehouses', async (_request, reply) => {
    const items = await prisma.warehouse.findMany({ orderBy: [{ isDefault: 'desc' }, { code: 'asc' }] })
    return { items }
  })
}

export default fulfillmentRoutes
