/**
 * MCP full control 08 S4 — the inbound shipment reads, out of the routes, so the purchasing pages and Claude's supply tools read the same
 * thing. Each function is the body of its route, moved as it was (supply-read.vitest.test.ts holds the routes'
 * answers): the route keeps its status codes and error handling, and returns what the function returns.
 *
 *   listInboundShipments  GET /api/fulfillment/inbound      shipments with items, filtered and paged
 *   readInboundShipment   GET /api/fulfillment/inbound/:id  one shipment with its landed cost (null: not found)
 *
 * 08 S10 — and the writes Claude's update-inbound-shipment and receive-stock share with the pages (setInboundCosts,
 * createPoReceipt), moved as they were (supply-receive.vitest.test.ts holds the routes' answers).
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { publishInboundEvent } from '../inbound-events.service.js'
import { PO_SECRET_OMIT } from './po-secrets.js'

/** A query number: the fallback when absent or not a number (as the fulfillment routes read them). */
function safeNum(v: unknown, fallback?: number): number | undefined {
  if (v == null) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Query of GET /api/fulfillment/inbound: deleted, type, status, search, delayed, page, pageSize, sortBy, sortDir. */
export async function listInboundShipments(q: Record<string, any>) {
  const where: any = {}
  // RB.1 — recycle-bin scope. Default = live-only.
  const showDeleted = q.deleted === 'true'
  where.deletedAt = showDeleted ? { not: null } : null
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
}

/** One inbound shipment with items, receipts, discrepancies and its landed cost, or null. */
export async function readInboundShipment(id: string) {
  const shipment = await prisma.inboundShipment.findUnique({
    where: { id },
    include: {
      items: { include: { discrepancies: true, receipts: { orderBy: { receivedAt: 'desc' } } } },
      warehouse: true,
      purchaseOrder: { omit: PO_SECRET_OMIT },
      workOrder: true,
      // H.1 additions — full bundle for the detail surface.
      attachments: { orderBy: { uploadedAt: 'desc' } },
      discrepancies: { where: { inboundShipmentItemId: null }, orderBy: { reportedAt: 'desc' } },
    },
  })
  if (!shipment) return null

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
}

// ── 08 S10 — the writes, moved out of routes/fulfillment.routes.ts as they were ─────────────────────────────

/** The body of PATCH /api/fulfillment/inbound/:id/costs (and Claude's update-inbound-shipment costs). */
export interface InboundCostsInput {
  currencyCode?: string
  exchangeRate?: number | null
  shippingCostCents?: number | null
  customsCostCents?: number | null
  dutiesCostCents?: number | null
  insuranceCostCents?: number | null
  items?: Array<{ id: string; unitCostCents: number | null }>
}

/** Set a shipment's header costs and line unit costs; publishes inbound.updated. False: no such shipment. */
export async function setInboundCosts(id: string, body: InboundCostsInput): Promise<boolean> {
  const existing = await prisma.inboundShipment.findUnique({ where: { id } })
  if (!existing) return false

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
  return true
}

/** A PO with its lines, as the receive routes read it. */
type PoForReceipt = Prisma.PurchaseOrderGetPayload<{ include: { items: true } }>

/**
 * A supplier shipment for a PO, one line per PO line expecting what is still open. `DRAFT` is the receipt the PO page
 * opens (POST /purchase-orders/:id/receive: open = ordered − received); `ARRIVED` is the one-shot receive
 * (POST /purchase-orders/:id/quick-receive: open never below 0). Publishes nothing: each caller announces its own.
 */
export async function createPoReceipt(
  po: PoForReceipt,
  opts: { status: 'DRAFT' } | { status: 'ARRIVED'; reference?: string; carrierCode?: string; trackingNumber?: string; arrivedAt: Date; notes?: string },
) {
  if (opts.status === 'DRAFT') {
    // Create an InboundShipment (type=SUPPLIER) tied to this PO.
    // H.0a — thread purchaseOrderItemId per row so the receive flow
    // can propagate quantities back to the PO without a sku rematch.
    return prisma.inboundShipment.create({
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
  }
  // Build the InboundShipment with quantityExpected = open qty
  // (ordered − received) per line.
  const openByPoi = new Map(
    po.items.map((it) => [it.id, Math.max(0, it.quantityOrdered - (it.quantityReceived ?? 0))]),
  )
  return prisma.inboundShipment.create({
    data: {
      type: 'SUPPLIER',
      status: 'ARRIVED', // receiveItems() handles RECEIVING/RECEIVED transitions
      warehouseId: po.warehouseId,
      purchaseOrderId: po.id,
      reference: opts.reference?.trim() || `Receipt for ${po.poNumber}`,
      carrierCode: opts.carrierCode?.trim() || null,
      trackingNumber: opts.trackingNumber?.trim() || null,
      arrivedAt: opts.arrivedAt,
      notes: opts.notes?.trim() || null,
      currencyCode: po.currencyCode ?? 'EUR',
      items: {
        create: po.items.map((it) => ({
          productId: it.productId,
          sku: it.sku,
          quantityExpected: openByPoi.get(it.id) ?? 0,
          purchaseOrderItemId: it.id,
          unitCostCents: it.unitCostCents ?? null,
        })),
      },
    },
    include: { items: true },
  })
}
