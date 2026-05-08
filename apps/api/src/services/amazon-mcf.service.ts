/**
 * S.24 — Amazon Multi-Channel Fulfillment service.
 *
 * MCF lets Amazon ship FBA inventory to non-Amazon orders (eBay,
 * Shopify, etc). Operator triggers via the dashboard or via auto-
 * routing rules. Inventory follows the same reserve-then-consume
 * pattern S.2 introduced for FBM/Shopify, applied to AMAZON-EU-FBA.
 *
 *   createMCFShipment(orderId, items)
 *     - reserves stock at AMAZON-EU-FBA per item (S.2 reserveOpenOrder)
 *     - calls SP-API createFulfillmentOrder
 *     - persists MCFShipment row with the returned amazonFulfillmentOrderId
 *     - sets Order.fulfillmentMethod = 'MCF'
 *
 *   syncMCFStatus(amazonFulfillmentOrderId)
 *     - calls SP-API getFulfillmentOrder
 *     - updates MCFShipment status / tracking / timestamps
 *     - on COMPLETE → consumeOpenOrder (decrements quantity)
 *     - on CANCELLED / UNFULFILLABLE → releaseOpenOrder (frees reserved)
 *
 *   cancelMCFShipment(amazonFulfillmentOrderId, reason?)
 *     - calls SP-API cancelFulfillmentOrder
 *     - releases reservations + sets MCFShipment.cancelledAt
 *
 * The Amazon adapter is parameter-injected: production passes the
 * real SP-API client; tests pass a mock with the same shape. When
 * the env vars aren't set the route returns a sandbox-safe error.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  reserveOpenOrder,
  consumeOpenOrder,
  releaseOpenOrder,
  resolveLocationByCode,
} from './stock-level.service.js'

// MCF SP-API operation surface — minimal interface so tests can
// pass a mock and the production adapter can wrap the real client.
export interface MCFAdapter {
  createFulfillmentOrder(args: {
    sellerFulfillmentOrderId: string
    marketplaceId: string
    displayableOrderId: string
    displayableOrderDate: Date
    displayableOrderComment?: string
    shippingSpeedCategory: 'Standard' | 'Expedited' | 'Priority' | 'ScheduledDelivery'
    destinationAddress: {
      name: string
      addressLine1: string
      addressLine2?: string
      city: string
      stateOrRegion?: string
      postalCode: string
      countryCode: string
      phone?: string
      email?: string
    }
    items: Array<{
      sellerSku: string
      sellerFulfillmentOrderItemId: string
      quantity: number
      perUnitDeclaredValue?: { currencyCode: string; value: number }
    }>
  }): Promise<{ amazonFulfillmentOrderId: string; raw: unknown }>

  getFulfillmentOrder(amazonFulfillmentOrderId: string): Promise<{
    status: string
    receivedDate?: string
    statusUpdatedDate?: string
    fulfillmentShipments?: Array<{
      shipmentStatus?: string
      trackingNumber?: string
      carrier?: string
      shippedDate?: string
      deliveredDate?: string
    }>
    raw: unknown
  }>

  cancelFulfillmentOrder(amazonFulfillmentOrderId: string): Promise<{ raw: unknown }>
}

export interface CreateMCFArgs {
  orderId: string
  shippingSpeed?: 'Standard' | 'Expedited' | 'Priority' | 'ScheduledDelivery'
  /** Override the AMAZON-EU-FBA marketplace if needed (cross-marketplace MCF). */
  marketplaceId?: string
  /** Operator note shown on packing slip. */
  comment?: string
  /** Optional override of items (otherwise the order's OrderItems are used). */
  items?: Array<{ sku: string; quantity: number }>
}

const FBA_LOCATION_CODE = 'AMAZON-EU-FBA'
const DEFAULT_MARKETPLACE = 'APJ6JRA9NG5V4' // IT

/**
 * Create an MCF shipment for an existing Order. Reserves AMAZON-EU-FBA
 * stock first; on adapter failure the reservations are released so we
 * don't strand inventory.
 */
export async function createMCFShipment(
  adapter: MCFAdapter,
  args: CreateMCFArgs,
): Promise<{ id: string; amazonFulfillmentOrderId: string; status: string }> {
  const { orderId } = args
  const fbaLocationId = await resolveLocationByCode(FBA_LOCATION_CODE)
  if (!fbaLocationId) {
    throw new Error(`createMCFShipment: ${FBA_LOCATION_CODE} StockLocation missing`)
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { select: { id: true, sku: true, quantity: true, productId: true } },
    },
  })
  if (!order) throw new Error(`createMCFShipment: order ${orderId} not found`)
  if (order.channel === 'AMAZON') {
    throw new Error('createMCFShipment: Amazon orders ship via FBA directly, not MCF')
  }

  // Idempotency: a single Order has at most one active MCFShipment.
  // Re-issuing for an order that already has a non-cancelled
  // shipment is a no-op (return the existing row).
  const existingActive = await prisma.mCFShipment.findFirst({
    where: {
      orderId,
      status: { notIn: ['CANCELLED', 'INVALID', 'UNFULFILLABLE'] },
    },
  })
  if (existingActive) {
    logger.info('amazon-mcf: returning existing active shipment', { orderId, id: existingActive.id })
    return {
      id: existingActive.id,
      amazonFulfillmentOrderId: existingActive.amazonFulfillmentOrderId,
      status: existingActive.status,
    }
  }

  // Resolve item productIds + reserve at AMAZON-EU-FBA.
  const itemsToShip = (args.items && args.items.length > 0
    ? args.items
    : order.items.map((it) => ({ sku: it.sku, quantity: it.quantity }))
  ).filter((it) => it.quantity > 0)
  if (itemsToShip.length === 0) {
    throw new Error('createMCFShipment: no items to ship')
  }

  const products = await prisma.product.findMany({
    where: { sku: { in: itemsToShip.map((it) => it.sku) } },
    select: { id: true, sku: true },
  })
  const productBySku = new Map(products.map((p) => [p.sku, p]))

  const reservations: string[] = []
  try {
    for (const it of itemsToShip) {
      const p = productBySku.get(it.sku)
      if (!p) throw new Error(`createMCFShipment: unknown SKU ${it.sku}`)
      const r = await reserveOpenOrder({
        orderId,
        productId: p.id,
        locationId: fbaLocationId,
        quantity: it.quantity,
        actor: 'amazon-mcf:create',
      })
      reservations.push(r.id)
    }
  } catch (err) {
    // Release whatever we managed to reserve before the failure.
    await releaseOpenOrder({ orderId, actor: 'amazon-mcf:create-rollback', reason: 'reservation failure' })
    throw err
  }

  // Generate idempotency key (operator-owned). Re-issued requests
  // with the same key get the same shipment back from Amazon.
  const sellerFulfillmentOrderId = `MCF-${orderId.slice(-12)}-${Date.now().toString(36)}`
  const marketplaceId = args.marketplaceId ?? DEFAULT_MARKETPLACE
  const shippingSpeed = args.shippingSpeed ?? 'Standard'

  // Address from Order.shippingAddress (JSON). Defensive fallback —
  // missing fields throw before we burn an SP-API call.
  const addr = (order.shippingAddress as Record<string, unknown> | null) ?? {}
  const destination = {
    name: String(addr.name ?? order.customerName),
    addressLine1: String(addr.addressLine1 ?? addr.street ?? ''),
    addressLine2: addr.addressLine2 ? String(addr.addressLine2) : undefined,
    city: String(addr.city ?? ''),
    stateOrRegion: addr.stateOrRegion ? String(addr.stateOrRegion) : (addr.state ? String(addr.state) : undefined),
    postalCode: String(addr.postalCode ?? addr.zip ?? ''),
    countryCode: String(addr.countryCode ?? addr.country ?? 'IT').slice(0, 2).toUpperCase(),
    phone: addr.phone ? String(addr.phone) : undefined,
    email: order.customerEmail || undefined,
  }
  if (!destination.addressLine1 || !destination.city || !destination.postalCode) {
    await releaseOpenOrder({ orderId, actor: 'amazon-mcf:create-rollback', reason: 'invalid address' })
    throw new Error('createMCFShipment: shipping address missing required fields (line1/city/postalCode)')
  }

  let amazonResponse: Awaited<ReturnType<MCFAdapter['createFulfillmentOrder']>>
  try {
    amazonResponse = await adapter.createFulfillmentOrder({
      sellerFulfillmentOrderId,
      marketplaceId,
      displayableOrderId: order.channelOrderId,
      displayableOrderDate: order.purchaseDate ?? order.createdAt,
      displayableOrderComment: args.comment,
      shippingSpeedCategory: shippingSpeed,
      destinationAddress: destination,
      items: itemsToShip.map((it, idx) => ({
        sellerSku: it.sku,
        sellerFulfillmentOrderItemId: `${orderId.slice(-8)}-${idx}`,
        quantity: it.quantity,
      })),
    })
  } catch (err) {
    await releaseOpenOrder({ orderId, actor: 'amazon-mcf:create-rollback', reason: 'SP-API failure' })
    throw err
  }

  const created = await prisma.mCFShipment.create({
    data: {
      orderId,
      amazonFulfillmentOrderId: amazonResponse.amazonFulfillmentOrderId,
      sellerFulfillmentOrderId,
      status: 'NEW',
      marketplaceId,
      displayableOrderId: order.channelOrderId,
      shippingSpeedCategory: shippingSpeed,
      rawResponse: amazonResponse.raw as object,
    },
    select: { id: true, amazonFulfillmentOrderId: true, status: true },
  })
  // Mark the source order as MCF-fulfilled.
  await prisma.order.update({
    where: { id: orderId },
    data: { fulfillmentMethod: 'MCF' },
  })

  logger.info('amazon-mcf: shipment created', {
    orderId, mcfId: created.id, fulfillmentOrderId: created.amazonFulfillmentOrderId,
  })
  return created
}

/**
 * Status lifecycle constants. Status names mirror Amazon's
 * FulfillmentOrder lifecycle.
 */
const TERMINAL_STATUSES = new Set(['COMPLETE', 'COMPLETE_PARTIALLED', 'CANCELLED', 'UNFULFILLABLE', 'INVALID'])
const COMPLETE_STATUSES = new Set(['COMPLETE', 'COMPLETE_PARTIALLED'])
const CANCELLED_STATUSES = new Set(['CANCELLED', 'UNFULFILLABLE', 'INVALID'])

/**
 * Pull the current status from Amazon and reconcile with our row.
 * Idempotent — terminal statuses are observed-once: consume / release
 * happens the first time we see COMPLETE / CANCELLED.
 */
export async function syncMCFStatus(
  adapter: MCFAdapter,
  amazonFulfillmentOrderId: string,
): Promise<{ id: string; status: string; changed: boolean }> {
  const shipment = await prisma.mCFShipment.findUnique({
    where: { amazonFulfillmentOrderId },
  })
  if (!shipment) {
    throw new Error(`syncMCFStatus: shipment ${amazonFulfillmentOrderId} not found`)
  }

  let result: Awaited<ReturnType<MCFAdapter['getFulfillmentOrder']>>
  try {
    result = await adapter.getFulfillmentOrder(amazonFulfillmentOrderId)
  } catch (err) {
    await prisma.mCFShipment.update({
      where: { id: shipment.id },
      data: { lastSyncedAt: new Date(), lastError: err instanceof Error ? err.message : String(err) },
    })
    throw err
  }

  const newStatus = result.status
  const firstShipment = result.fulfillmentShipments?.[0]
  const trackingNumber = firstShipment?.trackingNumber ?? null
  const carrier = firstShipment?.carrier ?? null
  const shippedAt = firstShipment?.shippedDate ? new Date(firstShipment.shippedDate) : null
  const deliveredAt = firstShipment?.deliveredDate ? new Date(firstShipment.deliveredDate) : null

  const previousTerminal = TERMINAL_STATUSES.has(shipment.status)
  const newTerminal = TERMINAL_STATUSES.has(newStatus)
  const justCompleted = !previousTerminal && COMPLETE_STATUSES.has(newStatus)
  const justCancelled = !previousTerminal && CANCELLED_STATUSES.has(newStatus)

  await prisma.mCFShipment.update({
    where: { id: shipment.id },
    data: {
      status: newStatus,
      lastSyncedAt: new Date(),
      trackingNumber: trackingNumber ?? shipment.trackingNumber,
      carrier: carrier ?? shipment.carrier,
      shippedAt: shippedAt ?? shipment.shippedAt,
      deliveredAt: deliveredAt ?? shipment.deliveredAt,
      cancelledAt: justCancelled ? new Date() : shipment.cancelledAt,
      rawResponse: result.raw as object,
      lastError: null,
    },
  })

  // Reconcile inventory on first observation of a terminal status.
  if (justCompleted) {
    try {
      const consumed = await consumeOpenOrder({ orderId: shipment.orderId, actor: 'amazon-mcf:complete' })
      logger.info('amazon-mcf: consumed reservations on COMPLETE', { orderId: shipment.orderId, consumed })
    } catch (err) {
      logger.warn('amazon-mcf: consumeOpenOrder failed (continuing)', {
        orderId: shipment.orderId, error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (justCancelled) {
    try {
      const released = await releaseOpenOrder({
        orderId: shipment.orderId, actor: 'amazon-mcf:cancelled', reason: `MCF status ${newStatus}`,
      })
      logger.info('amazon-mcf: released reservations on CANCELLED/UNFULFILLABLE/INVALID', {
        orderId: shipment.orderId, released, status: newStatus,
      })
    } catch (err) {
      logger.warn('amazon-mcf: releaseOpenOrder failed (continuing)', {
        orderId: shipment.orderId, error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { id: shipment.id, status: newStatus, changed: newStatus !== shipment.status || newTerminal }
}

/**
 * Operator-initiated cancel. Posts to SP-API; on success releases
 * the reservations and marks the row CANCELLED. Amazon may reject
 * cancellation if the shipment is already shipped — we surface the
 * error to the operator without changing local state.
 */
export async function cancelMCFShipment(
  adapter: MCFAdapter,
  amazonFulfillmentOrderId: string,
  reason?: string,
): Promise<{ id: string; status: string }> {
  const shipment = await prisma.mCFShipment.findUnique({
    where: { amazonFulfillmentOrderId },
  })
  if (!shipment) {
    throw new Error(`cancelMCFShipment: shipment ${amazonFulfillmentOrderId} not found`)
  }
  if (TERMINAL_STATUSES.has(shipment.status)) {
    return { id: shipment.id, status: shipment.status }
  }

  await adapter.cancelFulfillmentOrder(amazonFulfillmentOrderId)

  await prisma.mCFShipment.update({
    where: { id: shipment.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      lastSyncedAt: new Date(),
      lastError: null,
    },
  })
  await releaseOpenOrder({
    orderId: shipment.orderId,
    actor: 'amazon-mcf:operator-cancel',
    reason: reason ?? 'operator cancelled',
  })
  logger.info('amazon-mcf: shipment cancelled by operator', {
    orderId: shipment.orderId, mcfId: shipment.id, reason,
  })
  return { id: shipment.id, status: 'CANCELLED' }
}

/**
 * List MCF shipments for the dashboard. Filterable by status.
 */
export async function listMCFShipments(opts: {
  status?: string
  limit?: number
} = {}): Promise<Array<{
  id: string
  orderId: string
  channelOrderId: string
  channel: string
  amazonFulfillmentOrderId: string
  status: string
  trackingNumber: string | null
  carrier: string | null
  shippedAt: Date | null
  deliveredAt: Date | null
  requestedAt: Date
  lastSyncedAt: Date | null
  lastError: string | null
}>> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100))
  const where: any = {}
  if (opts.status && opts.status !== 'all') {
    if (opts.status === 'active') {
      where.status = { notIn: ['COMPLETE', 'COMPLETE_PARTIALLED', 'CANCELLED', 'UNFULFILLABLE', 'INVALID'] }
    } else {
      where.status = opts.status
    }
  }
  const rows = await prisma.mCFShipment.findMany({
    where,
    orderBy: { requestedAt: 'desc' },
    take: limit,
    include: {
      order: { select: { channel: true, channelOrderId: true } },
    },
  })
  return rows.map((r) => ({
    id: r.id,
    orderId: r.orderId,
    channelOrderId: r.order.channelOrderId,
    channel: String(r.order.channel),
    amazonFulfillmentOrderId: r.amazonFulfillmentOrderId,
    status: r.status,
    trackingNumber: r.trackingNumber,
    carrier: r.carrier,
    shippedAt: r.shippedAt,
    deliveredAt: r.deliveredAt,
    requestedAt: r.requestedAt,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
  }))
}

/**
 * Stub adapter that throws on every call — used when SP-API isn't
 * configured (no env vars). Routes use this to return a clear error
 * instead of crashing.
 */
export const unconfiguredAdapter: MCFAdapter = {
  async createFulfillmentOrder() {
    throw new Error('MCF: SP-API not configured (set AMAZON_SP_API_* env vars)')
  },
  async getFulfillmentOrder() {
    throw new Error('MCF: SP-API not configured')
  },
  async cancelFulfillmentOrder() {
    throw new Error('MCF: SP-API not configured')
  },
}
