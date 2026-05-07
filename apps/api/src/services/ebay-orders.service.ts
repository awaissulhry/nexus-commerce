/**
 * eBay Orders Service (audit fix #2 — TECH_DEBT #33)
 *
 * Fetches orders from eBay's Fulfillment API and writes them to the
 * Phase 26 unified `Order` model. Inventory deduction routes through
 * applyStockMovement so the cross-channel cascade (StockLevel ledger,
 * ChannelListing.masterQuantity, OutboundSyncQueue push) fires for
 * every eBay sale.
 *
 * Phase 26 mapping (replaces the legacy salesChannel/ebayOrderId/...
 * field names that broke this service against the post-Phase-26
 * schema):
 *   eBay orderId            → Order.channelOrderId (with channel='EBAY')
 *   pricingSummary.total    → Order.totalPrice (Decimal)
 *   pricingSummary.currency → Order.currencyCode
 *   buyer.username          → Order.customerName
 *   buyer.email             → Order.customerEmail (or fabricated stub
 *                             when eBay omits it; the schema requires
 *                             a value)
 *   creationDate            → Order.purchaseDate
 *   orderStatus / fulfillmentStatus / lastModifiedDate
 *                           → Order.ebayMetadata (JSON)
 *
 * Idempotency: upsert on the (channel, channelOrderId) compound
 * unique. OrderItem rows are uniquely identified by their eBay
 * lineItemId stored in `ebayMetadata.lineItemId`; we only insert (and
 * deduct inventory for) line items we haven't seen on a prior sync.
 * Re-running the cron is safe — quantities never double-deduct.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { EbayAuthService } from './ebay-auth.service.js'
import { applyStockMovement } from './stock-movement.service.js'

interface EbayOrder {
  orderId: string
  creationDate: string
  lastModifiedDate: string
  orderStatus: string
  fulfillmentStatus: string
  buyer: {
    username: string
    email?: string
  }
  shippingAddress: {
    addressLine1: string
    addressLine2?: string
    city: string
    stateOrProvince: string
    postalCode: string
    countryCode: string
  }
  pricingSummary: {
    total: string
    currency: string
  }
  lineItems: Array<{
    lineItemId: string
    sku: string
    title: string
    quantity: number
    lineItemCost: string
    taxes?: {
      taxAmount: string
    }
    discounts?: Array<{
      discountAmount: string
    }>
  }>
}

interface SyncResult {
  syncId: string
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  ordersFetched: number
  ordersCreated: number
  ordersUpdated: number
  itemsProcessed: number
  itemsLinked: number
  inventoryDeducted: number
  errors: Array<{ orderId?: string; error: string }>
  startedAt: Date
  completedAt: Date
}

export class EbayOrdersService {
  private stats = {
    ordersFetched: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    itemsProcessed: 0,
    itemsLinked: 0,
    inventoryDeducted: 0,
  }

  private resetStats() {
    this.stats = {
      ordersFetched: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      itemsProcessed: 0,
      itemsLinked: 0,
      inventoryDeducted: 0,
    }
  }

  /**
   * Fetch recent eBay orders from the Fulfillment API. Default 7-day
   * window matches the Amazon orders cron — keeps the total volume
   * pulled per tick reasonable while still catching anything the
   * previous tick missed.
   */
  async fetchEbayOrders(
    accessToken: string,
    days: number = 7,
  ): Promise<EbayOrder[]> {
    try {
      const since = new Date()
      since.setDate(since.getDate() - days)
      const fromDate = since.toISOString()

      const response = await fetch(
        `https://api.ebay.com/sell/fulfillment/v1/order?filter=creationdate:[${fromDate}]&limit=200`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        },
      )

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new Error(
          `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
        )
      }

      const data = (await response.json()) as { orders?: EbayOrder[] }
      return data.orders ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Error fetching eBay orders', { error: message })
      throw error
    }
  }

  /**
   * Resolve an eBay SKU back to a Nexus Product. Tries (in order):
   *   1. VariantChannelListing keyed on externalSku / externalListingId
   *      — the canonical cross-channel link.
   *   2. Product.sku exact match — for products with no variant set.
   *   3. ProductVariation.sku exact match — for legacy data.
   * Returns null when nothing matches; the caller still creates the
   * OrderItem (with productId=null) so the line stays auditable.
   */
  private async findProductBySku(sku: string, ebayItemId?: string) {
    try {
      const listing = await (prisma as any).variantChannelListing.findFirst({
        where: {
          OR: [
            { externalSku: sku },
            ebayItemId ? { externalListingId: ebayItemId } : undefined,
          ].filter(Boolean),
        },
        include: {
          variant: { include: { product: true } },
        },
      })
      if (listing?.variant?.product) return listing.variant.product

      const product = await prisma.product.findFirst({ where: { sku } })
      if (product) return product

      const variation = await (prisma as any).productVariation.findFirst({
        where: { sku },
        include: { product: true },
      })
      return variation?.product ?? null
    } catch (error) {
      logger.error('Error finding product by SKU', { sku, error })
      return null
    }
  }

  /**
   * Map eBay's order status to our unified OrderStatus enum (extended
   * in O.1: PROCESSING for paid-but-unshipped). eBay's status taxonomy
   * is coarser than ours; we lean conservative and default ambiguous
   * states to PENDING. fulfillmentStatus from the API takes precedence
   * when it's a more specific delivery state.
   */
  private mapOrderStatus(
    ebayStatus: string,
    fulfillmentStatus: string,
  ): 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'CANCELLED' | 'DELIVERED' {
    if (ebayStatus === 'CANCELLED' || ebayStatus === 'INACTIVE') {
      return 'CANCELLED'
    }
    if (fulfillmentStatus === 'FULFILLED') return 'DELIVERED'
    if (fulfillmentStatus === 'IN_PROGRESS') return 'SHIPPED'
    // O.1: COMPLETED + NOT_STARTED = paid, ready to fulfill — that's
    // PROCESSING in our taxonomy. Previously coerced to SHIPPED, which
    // broke ship-by urgency math.
    if (ebayStatus === 'COMPLETED' && fulfillmentStatus === 'NOT_STARTED') {
      return 'PROCESSING'
    }
    if (ebayStatus === 'COMPLETED') return 'SHIPPED'
    return 'PENDING'
  }

  /**
   * Process one eBay order: upsert the Order row, then for each line
   * item we haven't seen before, create the OrderItem and deduct
   * inventory through applyStockMovement (so ChannelListing.master
   * Quantity and the cross-channel sync queue both update).
   */
  private async processOrder(order: EbayOrder, _connectionId: string) {
    const totalPrice = Number(order.pricingSummary.total)
    if (!Number.isFinite(totalPrice)) {
      throw new Error(
        `eBay order ${order.orderId}: invalid pricingSummary.total ${order.pricingSummary.total}`,
      )
    }

    // eBay's Fulfillment API sometimes omits buyer.email (anonymized
    // for guest checkout). The Order schema requires customerEmail,
    // so synthesise a placeholder using the public username — kept
    // distinct from real addresses with the .invalid suffix.
    const customerEmail =
      (order.buyer.email ?? '').trim() ||
      `${(order.buyer.username || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '')}@buyer.ebay.invalid`

    const orderData = {
      channel: 'EBAY' as const,
      // eBay doesn't have per-marketplace splits like Amazon;
      // 'EBAY-GLOBAL' keeps the column non-null without faking a
      // marketplace code that doesn't exist.
      marketplace: 'EBAY-GLOBAL',
      channelOrderId: order.orderId,
      status: this.mapOrderStatus(order.orderStatus, order.fulfillmentStatus),
      totalPrice,
      currencyCode: order.pricingSummary.currency ?? 'EUR',
      customerName: order.buyer.username || 'eBay Buyer',
      customerEmail,
      shippingAddress: order.shippingAddress as unknown as object,
      purchaseDate: new Date(order.creationDate),
      // eBay is always merchant-fulfilled.
      fulfillmentMethod: 'MFN',
      // O.1: eBay default handling time = 1 day. Per-listing override
      // lives in the seller account and isn't exposed on the order
      // payload here — when that wires up, replace this with the
      // listing-level value. shipByDate is computed downstream from
      // (purchaseDate + fulfillmentLatency days).
      fulfillmentLatency: 1,
      shipByDate: new Date(new Date(order.creationDate).getTime() + 24 * 60 * 60 * 1000),
      ebayMetadata: {
        orderStatus: order.orderStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        lastModifiedDate: order.lastModifiedDate,
      },
    }

    // Look up existing on the (channel, channelOrderId) compound
    // unique so the upsert stays idempotent across sync runs.
    const existing = await prisma.order.findUnique({
      where: {
        channel_channelOrderId: {
          channel: 'EBAY' as any,
          channelOrderId: order.orderId,
        },
      },
      include: {
        items: {
          select: { id: true, sku: true, ebayMetadata: true, productId: true, quantity: true },
        },
      },
    })

    let dbOrder
    // O.45: did we just transition to CANCELLED?
    const newlyCancelled =
      orderData.status === 'CANCELLED'
      && existing != null
      && existing.status !== 'CANCELLED'

    if (existing) {
      dbOrder = await prisma.order.update({
        where: { id: existing.id },
        data: orderData,
      })
      this.stats.ordersUpdated++
    } else {
      dbOrder = await prisma.order.create({ data: orderData })
      this.stats.ordersCreated++
    }

    // O.45: cascade cancellation cleanup. Best-effort + non-blocking.
    if (newlyCancelled) {
      void (async () => {
        try {
          const { handleOrderCancelled } = await import(
            './order-cancellation/index.js'
          )
          const cleanup = await handleOrderCancelled(dbOrder.id)
          logger.info('ebay-orders: cancellation cascade', {
            orderId: dbOrder.id,
            ...cleanup,
          })
        } catch (err) {
          logger.warn('ebay-orders: cancellation cascade failed', {
            orderId: dbOrder.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }

    // Inventory deduction is one-shot per (orderId, lineItemId) — track
    // which line items we've already booked so re-running this sync
    // doesn't double-deduct.
    const seenLineItemIds = new Set<string>(
      (existing?.items ?? [])
        .map((it) => (it.ebayMetadata as any)?.lineItemId)
        .filter((id): id is string => typeof id === 'string'),
    )

    for (const lineItem of order.lineItems) {
      this.stats.itemsProcessed++
      const isNewLine = !seenLineItemIds.has(lineItem.lineItemId)
      if (!isNewLine) continue // already booked on a prior sync

      const itemPrice = Number(lineItem.lineItemCost)
      if (!Number.isFinite(itemPrice)) {
        logger.warn('eBay line item: non-numeric lineItemCost — skipping', {
          orderId: order.orderId,
          lineItemId: lineItem.lineItemId,
          raw: lineItem.lineItemCost,
        })
        continue
      }

      const product = await this.findProductBySku(lineItem.sku, lineItem.lineItemId)
      const taxAmount = lineItem.taxes ? Number(lineItem.taxes.taxAmount) : 0
      const discountAmount = lineItem.discounts
        ? lineItem.discounts.reduce(
            (sum, d) => sum + (Number(d.discountAmount) || 0),
            0,
          )
        : 0

      await prisma.orderItem.create({
        data: {
          orderId: dbOrder.id,
          productId: product?.id ?? null,
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          price: itemPrice,
          ebayMetadata: {
            lineItemId: lineItem.lineItemId,
            title: lineItem.title,
            taxAmount,
            discountAmount,
          },
        },
      })

      if (!product) {
        logger.warn('Could not link eBay line item to a Nexus product', {
          sku: lineItem.sku,
          ebayItemId: lineItem.lineItemId,
          orderId: order.orderId,
        })
        continue
      }
      this.stats.itemsLinked++

      // Inventory deduction routes through applyStockMovement so the
      // StockLevel ledger, ChannelListing.masterQuantity, and the
      // OutboundSyncQueue (cross-channel push) all update atomically.
      try {
        await applyStockMovement({
          productId: product.id,
          change: -lineItem.quantity,
          reason: 'ORDER_PLACED',
          referenceType: 'ORDER',
          referenceId: dbOrder.id,
          orderId: dbOrder.id,
          actor: 'ebay-orders-sync',
          notes: `eBay order ${order.orderId} line ${lineItem.lineItemId}`,
        })
        this.stats.inventoryDeducted++
      } catch (err) {
        // A stock-movement failure shouldn't roll back the order
        // ingestion (we don't want to lose the order record). Log
        // and continue; the audit reads stockMovement separately.
        logger.error('Stock-movement deduction failed for eBay line', {
          productId: product.id,
          quantity: lineItem.quantity,
          orderId: order.orderId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return dbOrder
  }

  /**
   * Main entry: fetch + sync. One per active eBay ChannelConnection,
   * triggered by the cron or by a settings page "Sync now" button.
   */
  async syncEbayOrders(connectionId: string): Promise<SyncResult> {
    const startedAt = new Date()
    const errors: Array<{ orderId?: string; error: string }> = []
    this.resetStats()

    try {
      const connection = await (prisma as any).channelConnection.findUnique({
        where: { id: connectionId },
      })
      if (!connection) {
        throw new Error(`ChannelConnection not found: ${connectionId}`)
      }
      if (!connection.isActive) {
        throw new Error('eBay connection is not active')
      }

      const authService = new EbayAuthService()
      const accessToken = await authService.getValidToken(connection)

      const orders = await this.fetchEbayOrders(accessToken)
      this.stats.ordersFetched = orders.length
      logger.info('Fetched eBay orders', { count: orders.length })

      for (const order of orders) {
        try {
          await this.processOrder(order, connectionId)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error)
          errors.push({ orderId: order.orderId, error: message })
          logger.error('Failed to process eBay order', {
            orderId: order.orderId,
            error: message,
          })
        }
      }

      const completedAt = new Date()

      return {
        syncId: `ebay-orders-${Date.now()}`,
        status:
          errors.length === 0
            ? 'SUCCESS'
            : errors.length < orders.length
              ? 'PARTIAL'
              : 'FAILED',
        ordersFetched: this.stats.ordersFetched,
        ordersCreated: this.stats.ordersCreated,
        ordersUpdated: this.stats.ordersUpdated,
        itemsProcessed: this.stats.itemsProcessed,
        itemsLinked: this.stats.itemsLinked,
        inventoryDeducted: this.stats.inventoryDeducted,
        errors,
        startedAt,
        completedAt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('eBay orders sync failed', { error: message })
      return {
        syncId: `ebay-orders-${Date.now()}`,
        status: 'FAILED',
        ordersFetched: this.stats.ordersFetched,
        ordersCreated: this.stats.ordersCreated,
        ordersUpdated: this.stats.ordersUpdated,
        itemsProcessed: this.stats.itemsProcessed,
        itemsLinked: this.stats.itemsLinked,
        inventoryDeducted: this.stats.inventoryDeducted,
        errors: [{ error: message }],
        startedAt,
        completedAt: new Date(),
      }
    }
  }

  /**
   * Placeholder — full sync-status tracking lives on a future SyncLog
   * surface. Today the syncEbayOrders() result IS the status.
   */
  async getSyncStatus(syncId: string): Promise<{
    syncId: string
    status: string
    message: string
  }> {
    return {
      syncId,
      status: 'COMPLETED',
      message: 'Sync status tracking not yet implemented',
    }
  }
}

export const ebayOrdersService = new EbayOrdersService()
