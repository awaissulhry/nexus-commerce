import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { applyStockMovement, listStockMovements } from '../services/stock-movement.service.js'
import { refreshSalesAggregates } from '../services/sales-aggregate.service.js'
import { resolveAtp, DEFAULT_LEAD_TIME_DAYS } from '../services/atp.service.js'
import {
  ingestSalesTrafficForDay,
  ingestAllAmazonMarketplaces,
} from '../services/sales-report-ingest.service.js'
import {
  generateForecastForSeries,
  generateForecastsForAll,
} from '../services/forecast.service.js'

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
      if (q.status && q.status !== 'ALL') where.status = q.status
      const [total, items] = await Promise.all([
        prisma.inboundShipment.count({ where }),
        prisma.inboundShipment.findMany({
          where,
          include: {
            items: true,
            warehouse: { select: { code: true, name: true } },
            purchaseOrder: { select: { poNumber: true, supplierId: true } },
            workOrder: { select: { id: true, productId: true, quantity: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
      ])
      return { items, total }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fulfillment/inbound] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.get('/fulfillment/inbound/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const shipment = await prisma.inboundShipment.findUnique({
      where: { id },
      include: { items: true, warehouse: true, purchaseOrder: true, workOrder: true },
    })
    if (!shipment) return reply.code(404).send({ error: 'Inbound shipment not found' })
    return shipment
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
        items?: Array<{ productId?: string; sku: string; quantityExpected: number }>
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
          items: {
            create: items.map((it) => ({
              productId: it.productId ?? null,
              sku: it.sku,
              quantityExpected: it.quantityExpected,
            })),
          },
        },
        include: { items: true },
      })
      return shipment
    } catch (error: any) {
      fastify.log.error({ err: error }, '[POST /fulfillment/inbound] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // Receive inbound items: posts an array of {itemId, quantityReceived,
  // qcStatus?} and applies StockMovements.
  fastify.post('/fulfillment/inbound/:id/receive', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        items?: Array<{ itemId: string; quantityReceived: number; qcStatus?: string; qcNotes?: string }>
      }
      const itemUpdates = Array.isArray(body.items) ? body.items : []

      const shipment = await prisma.inboundShipment.findUnique({
        where: { id },
        include: { items: true },
      })
      if (!shipment) return reply.code(404).send({ error: 'Inbound shipment not found' })

      for (const upd of itemUpdates) {
        const orig = shipment.items.find((it) => it.id === upd.itemId)
        if (!orig) continue
        await prisma.inboundShipmentItem.update({
          where: { id: upd.itemId },
          data: {
            quantityReceived: upd.quantityReceived,
            qcStatus: upd.qcStatus ?? null,
            qcNotes: upd.qcNotes ?? null,
          },
        })
        // QC PASS or unset = stock the units. FAIL/HOLD = don't add to inventory yet.
        if ((!upd.qcStatus || upd.qcStatus === 'PASS') && orig.productId && upd.quantityReceived > 0) {
          const reasonMap: any = {
            SUPPLIER: 'SUPPLIER_DELIVERY',
            MANUFACTURING: 'MANUFACTURING_OUTPUT',
            FBA: 'FBA_TRANSFER_OUT', // sending TO Amazon = stock leaves
            TRANSFER: 'INBOUND_RECEIVED',
          }
          const reason = reasonMap[shipment.type] ?? 'INBOUND_RECEIVED'
          // FBA shipments DECREMENT (we're sending units to Amazon).
          // Supplier/Manufacturing/Transfer INCREMENT.
          const sign = shipment.type === 'FBA' ? -1 : 1
          await applyStockMovement({
            productId: orig.productId,
            warehouseId: shipment.warehouseId ?? undefined,
            change: sign * upd.quantityReceived,
            reason,
            referenceType: 'InboundShipment',
            referenceId: shipment.id,
            actor: 'inbound-receive',
          })
        }
      }
      const updated = await prisma.inboundShipment.update({
        where: { id },
        data: { status: 'RECEIVING', arrivedAt: shipment.arrivedAt ?? new Date(), version: { increment: 1 } },
        include: { items: true },
      })
      return updated
    } catch (error: any) {
      fastify.log.error({ err: error }, '[inbound/:id/receive] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/inbound/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string }
    const updated = await prisma.inboundShipment.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), version: { increment: 1 } },
    })
    return updated
  })

  // ═══════════════════════════════════════════════════════════════════
  // FBA Send-to-Amazon (B.6 scaffold)
  // ═══════════════════════════════════════════════════════════════════

  fastify.post('/fulfillment/fba/plan-shipment', async (request, reply) => {
    try {
      const body = request.body as {
        items?: Array<{ sku: string; quantity: number; prepType?: string }>
        warehouseId?: string
      }
      const items = Array.isArray(body.items) ? body.items : []
      if (items.length === 0) return reply.code(400).send({ error: 'items[] required' })

      // SP-API call would go here:
      //   POST /fba/inbound/v0/plans (createInboundShipmentPlan)
      // Returns shipment plans grouped by destination FC. We scaffold a
      // single-FC plan with the default destinationFC so the UI works.
      const planId = `PLAN-${Date.now()}`
      return {
        planId,
        shipmentPlans: [
          {
            shipmentId: `FBA${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
            destinationFC: 'MXP5',
            items: items.map((it) => ({ ...it, fnsku: null, prepType: it.prepType ?? 'NONE' })),
          },
        ],
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/plan-shipment] failed')
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

  fastify.post('/fulfillment/fba/shipments/:id/labels', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const shipment = await prisma.fBAShipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'FBA shipment not found' })
      // SP-API: GET /fba/inbound/v0/labels — returns a feed for FNSKU + carton labels
      // We scaffold a static URL for now so the UI download button works.
      return {
        ok: true,
        labelsUrl: `/api/fulfillment/fba/shipments/${id}/labels.pdf`,
        labelType: 'FNSKU',
        message: 'SP-API integration not yet wired — placeholder PDF returned. See SP-API getLabels.',
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments/:id/labels] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  fastify.post('/fulfillment/fba/shipments/:id/transport', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { isPartnered?: boolean; cartonCount?: number; estimatedShipDate?: string }
      const shipment = await prisma.fBAShipment.findUnique({ where: { id } })
      if (!shipment) return reply.code(404).send({ error: 'FBA shipment not found' })
      // SP-API: PUT /fba/inbound/v0/shipments/{shipmentId}/transport
      // Records transport details. We scaffold the state transition.
      const updated = await prisma.fBAShipment.update({
        where: { id },
        data: { status: 'SHIPPED' },
      })
      return { ok: true, shipment: updated, partnered: !!body.isPartnered }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[fba/shipments/:id/transport] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
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
      if (q.status && q.status !== 'ALL') where.status = q.status
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
            })),
          },
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
      const atpByProduct = await resolveAtp({
        products: products.map((p) => ({ id: p.id, sku: p.sku })),
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

      const counts = {
        critical: suggestions.filter((s) => s.urgency === 'CRITICAL').length,
        high: suggestions.filter((s) => s.urgency === 'HIGH').length,
        medium: suggestions.filter((s) => s.urgency === 'MEDIUM').length,
        low: suggestions.filter((s) => s.urgency === 'LOW').length,
      }

      return {
        suggestions,
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
          select: { id: true, sku: true, name: true, totalStock: true },
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
          resolveAtp({ products: [{ id: product.id, sku: product.sku }] }).then(
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

        return {
          product: {
            id: product.id,
            sku: product.sku,
            name: product.name,
            currentStock: product.totalStock,
          },
          atp: atpEntry,
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
        }>
        notes?: string
      }
      const items = body.items ?? []
      if (items.length === 0) {
        return reply.code(400).send({ error: 'items[] is required' })
      }

      // Resolve missing supplierIds via ReplenishmentRule. Group by
      // supplier so each supplier gets one PO per call. Items without
      // a resolved supplier go into a single "no-supplier" PO that the
      // user must assign before submitting (matches the single-SKU
      // /draft-po behaviour today).
      const productIds = items.map((i) => i.productId)
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true },
      })
      const productById = new Map(products.map((p) => [p.id, p]))

      const rules = await prisma.replenishmentRule.findMany({
        where: { productId: { in: productIds } },
        select: { productId: true, preferredSupplierId: true },
      })
      const ruleByProduct = new Map(
        rules.map((r) => [r.productId, r.preferredSupplierId] as const),
      )

      const grouped = new Map<
        string,
        Array<{ productId: string; sku: string; quantity: number; notes?: string | null }>
      >()
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
        const supplierId =
          item.supplierId ?? ruleByProduct.get(item.productId) ?? null
        const key = supplierId ?? '__no_supplier__'
        const arr = grouped.get(key) ?? []
        arr.push({
          productId: item.productId,
          sku: product.sku,
          quantity: Math.floor(item.quantity),
          notes: item.notes ?? null,
        })
        grouped.set(key, arr)
      }

      const createdPos: Array<{
        id: string
        poNumber: string
        supplierId: string | null
        itemCount: number
      }> = []
      for (const [supplierKey, lineItems] of grouped) {
        const supplierId = supplierKey === '__no_supplier__' ? null : supplierKey
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
          itemCount: po._count.items,
        })
      }

      return {
        ok: true,
        createdPos,
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
      const body = request.body as { quantity?: number; supplierId?: string; expectedDeliveryDate?: string }
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
      return po
    } catch (error: any) {
      fastify.log.error({ err: error }, '[replenishment/draft-po] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
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
