/**
 * Amazon orders sync — SP-API getOrders + getOrderItems → Phase-26 unified Order.
 *
 * Two entry points:
 *   - `syncAllOrders({ daysBack })` — initial backfill (default 30 days).
 *   - `syncNewOrders(since)`        — incremental polling (cron path).
 *
 * Both use idempotent upsert on `Order.@@unique([channel, channelOrderId])`,
 * so re-running the same window is safe. Item upsert keys on
 * `OrderItem.@@unique([order, externalLineItemId])` (Amazon's OrderItemId).
 *
 * Does NOT decrement stock — order ingestion and inventory updates are
 * decoupled (inventory comes from `webhooks.routes.ts:order-created` or the
 * SP-API inventory summary endpoint, separately).
 */

import prisma from '../db.js'
import {
  AmazonService,
  AmazonOrderRaw,
  AmazonOrderItemRaw,
} from './marketplaces/amazon.service.js'
import { logger } from '../utils/logger.js'

const amazonService = new AmazonService()

/** Map Amazon's status strings to our `OrderStatus` enum (extended in O.1). */
type MappedOrderStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PARTIALLY_SHIPPED'
  | 'SHIPPED'
  | 'CANCELLED'
  | 'DELIVERED'

function mapStatus(amazonStatus: string): MappedOrderStatus {
  switch (amazonStatus) {
    case 'Shipped':
      return 'SHIPPED'
    case 'PartiallyShipped':
      return 'PARTIALLY_SHIPPED'
    case 'Canceled':
    case 'Cancelled':
      return 'CANCELLED'
    case 'Delivered':
      return 'DELIVERED'
    // O.1: "Unshipped" means paid + ready to fulfill — distinct from
    // PENDING (which we keep for not-yet-ready states like
    // PendingAvailability / InvoiceUnconfirmed).
    case 'Unshipped':
      return 'PROCESSING'
    case 'Pending':
    case 'PendingAvailability':
    case 'InvoiceUnconfirmed':
    default:
      return 'PENDING'
  }
}

/** Parse an Amazon timestamp string into a Date, returning null for missing/invalid. */
function parseAmazonDate(value: string | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** AFN = Amazon Fulfilled (FBA), MFN = Merchant Fulfilled (FBM). */
function mapFulfillmentMethod(channel?: string): string | null {
  if (channel === 'AFN' || channel === 'AmazonFulfilled') return 'FBA'
  if (channel === 'MFN' || channel === 'MerchantFulfilled') return 'FBM'
  return channel ?? null
}

/** Compose a usable customer name from buyer / shipping fields. */
function pickCustomerName(order: AmazonOrderRaw): string {
  return (
    order.BuyerInfo?.BuyerName ??
    order.ShippingAddress?.Name ??
    'Amazon customer'
  )
}

function pickCustomerEmail(order: AmazonOrderRaw): string {
  return order.BuyerInfo?.BuyerEmail ?? ''
}

/** Map MarketplaceId → 2-letter country code we store in Order.marketplace. */
function mapMarketplaceCode(marketplaceId?: string): string | null {
  if (!marketplaceId) return null
  const map: Record<string, string> = {
    APJ6JRA9NG5V4: 'IT',
    A1PA6795UKMFR9: 'DE',
    A13V1IB3VIYZZH: 'FR',
    A1RKKUPIHCS9HS: 'ES',
    A1F83G8C2ARO7P: 'UK',
    A1805IZSGTT6HS: 'NL',
    A2NODRKZP88ZB9: 'SE',
    A1C3SOZRARQ6R3: 'PL',
    ATVPDKIKX0DER: 'US',
    A2EUQ1WTGCTBG2: 'CA',
    A1AM78C64UM0Y8: 'MX',
  }
  return map[marketplaceId] ?? null
}

interface SyncSummary {
  startedAt: Date
  completedAt: Date
  durationMs: number
  cursor: { mode: 'since' | 'daysBack'; value: string }
  ordersFetched: number
  ordersUpserted: number
  ordersFailed: number
  itemsUpserted: number
  itemsFailed: number
  errors: Array<{ orderId: string; error: string }>
}

export class AmazonOrdersService {
  isConfigured(): boolean {
    return amazonService.isConfigured()
  }

  /**
   * Initial backfill — pulls every order with `CreatedAfter >= now - daysBack`.
   * Default 30 days. Bounded by `limit` (default 1000) so an unbounded
   * backfill can't pin the API process.
   */
  async syncAllOrders(options: { daysBack?: number; limit?: number } = {}): Promise<SyncSummary> {
    const daysBack = options.daysBack ?? 30
    return this.runSync(
      { daysBack, limit: options.limit },
      { mode: 'daysBack', value: String(daysBack) },
    )
  }

  /**
   * Incremental poll — pulls every order with `LastUpdatedAfter >= since`.
   * Picks up status transitions on already-known orders (Pending → Shipped,
   * etc.) as well as newly-placed orders.
   */
  async syncNewOrders(since: Date, options: { limit?: number } = {}): Promise<SyncSummary> {
    return this.runSync(
      { since, limit: options.limit },
      { mode: 'since', value: since.toISOString() },
    )
  }

  /** Find the most recent purchase date we already have for AMAZON.
   *  Used by the polling cron to derive `since` if no explicit cursor.
   *  Returns null if no Amazon orders exist (caller should fall back to backfill). */
  async getLatestPurchaseDate(): Promise<Date | null> {
    const latest = await prisma.order.findFirst({
      where: { channel: 'AMAZON' },
      orderBy: { purchaseDate: 'desc' },
      select: { purchaseDate: true },
    })
    return latest?.purchaseDate ?? null
  }

  // ── internals ────────────────────────────────────────────────────────

  private async runSync(
    fetchOpts: { since?: Date; daysBack?: number; limit?: number },
    cursor: { mode: 'since' | 'daysBack'; value: string },
  ): Promise<SyncSummary> {
    const startedAt = new Date()
    const summary: SyncSummary = {
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      cursor,
      ordersFetched: 0,
      ordersUpserted: 0,
      ordersFailed: 0,
      itemsUpserted: 0,
      itemsFailed: 0,
      errors: [],
    }

    try {
      const orders = await amazonService.fetchOrders(fetchOpts)
      summary.ordersFetched = orders.length

      for (const raw of orders) {
        try {
          await this.upsertOrder(raw, summary)
          summary.ordersUpserted++
        } catch (err) {
          summary.ordersFailed++
          summary.errors.push({
            orderId: raw.AmazonOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
          logger.warn('amazon-orders: upsert failed', {
            orderId: raw.AmazonOrderId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      summary.errors.push({
        orderId: 'FETCH',
        error: err instanceof Error ? err.message : String(err),
      })
      logger.error('amazon-orders: fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    summary.completedAt = new Date()
    summary.durationMs = summary.completedAt.getTime() - summary.startedAt.getTime()
    logger.info('amazon-orders: sync complete', {
      cursor,
      durationMs: summary.durationMs,
      ordersFetched: summary.ordersFetched,
      ordersUpserted: summary.ordersUpserted,
      ordersFailed: summary.ordersFailed,
      itemsUpserted: summary.itemsUpserted,
      itemsFailed: summary.itemsFailed,
    })
    return summary
  }

  private async upsertOrder(raw: AmazonOrderRaw, summary: SyncSummary): Promise<void> {
    const purchaseDate = new Date(raw.PurchaseDate)
    const totalPrice = raw.OrderTotal?.Amount ? Number(raw.OrderTotal.Amount) : 0
    const currencyCode = raw.OrderTotal?.CurrencyCode ?? 'EUR'
    const status = mapStatus(raw.OrderStatus)

    // O.45: track the previous status so we can detect the
    // transition to CANCELLED (vs re-ingesting an already-cancelled
    // order, which shouldn't re-trigger the cleanup cascade).
    const existing = await prisma.order.findUnique({
      where: {
        channel_channelOrderId: {
          channel: 'AMAZON',
          channelOrderId: raw.AmazonOrderId,
        },
      },
      select: { id: true, status: true },
    })
    const fulfillmentMethod = mapFulfillmentMethod(raw.FulfillmentChannel)
    const marketplace = mapMarketplaceCode(raw.MarketplaceId)
    const shippingAddress = (raw.ShippingAddress ?? {}) as object

    // O.1: Lifecycle-timestamp gate accepts SHIPPED *or* PARTIALLY_SHIPPED
    // for shippedAt — Amazon's PartiallyShipped is still "ship clock
    // started" from the customer's perspective.
    const isShippedLike = status === 'SHIPPED' || status === 'PARTIALLY_SHIPPED'

    const updateData = {
      status,
      totalPrice,
      currencyCode,
      customerName: pickCustomerName(raw),
      customerEmail: pickCustomerEmail(raw),
      shippingAddress,
      fulfillmentMethod,
      marketplace,
      purchaseDate,
      shippedAt: isShippedLike ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate) : undefined,
      cancelledAt: status === 'CANCELLED' ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate) : undefined,
      deliveredAt: status === 'DELIVERED' ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate) : undefined,
      // O.1: ship-by deadline + Prime SFP gating. SP-API delivers all of
      // these as ISO-8601 strings — parse defensively so a malformed
      // value doesn't fail the whole upsert.
      shipByDate: parseAmazonDate(raw.LatestShipDate),
      earliestShipDate: parseAmazonDate(raw.EarliestShipDate),
      latestDeliveryDate: parseAmazonDate(raw.LatestDeliveryDate),
      isPrime: raw.IsPrime ?? null,
      amazonMetadata: raw as object,
    }

    // O.45: did we just transition to CANCELLED?
    const newlyCancelled =
      status === 'CANCELLED'
      && existing != null
      && existing.status !== 'CANCELLED'

    const order = await prisma.order.upsert({
      where: {
        channel_channelOrderId: {
          channel: 'AMAZON',
          channelOrderId: raw.AmazonOrderId,
        },
      },
      update: updateData,
      create: {
        ...updateData,
        channel: 'AMAZON',
        channelOrderId: raw.AmazonOrderId,
      },
    })

    // O.45: cascade cancellation cleanup. Best-effort + non-blocking
    // — a void failure shouldn't fail the order ingest.
    if (newlyCancelled) {
      void (async () => {
        try {
          const { handleOrderCancelled } = await import(
            './order-cancellation/index.js'
          )
          const cleanup = await handleOrderCancelled(order.id)
          logger.info('amazon-orders: cancellation cascade', {
            orderId: order.id,
            ...cleanup,
          })
        } catch (err) {
          logger.warn('amazon-orders: cancellation cascade failed', {
            orderId: order.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    }

    // Items — the schema doesn't carry a per-line external id, and
    // there's no composite-unique on (orderId, sku) to upsert against
    // (a given order CAN have two lines for the same SKU at different
    // prices). Cleanest idempotent pattern is delete-then-create per
    // order. Cheap: orders carry 1-5 lines typically, and we're inside
    // the per-order loop where the cost is dominated by the SP-API
    // round-trip anyway. Amazon's OrderItemId is preserved in
    // amazonMetadata for downstream traceability.
    const items = await amazonService.fetchOrderItems(raw.AmazonOrderId)
    try {
      await prisma.orderItem.deleteMany({ where: { orderId: order.id } })
    } catch (err) {
      logger.warn('amazon-orders: stale-item purge failed (continuing)', {
        orderId: raw.AmazonOrderId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    for (const item of items) {
      try {
        await this.createOrderItem(order.id, item)
        summary.itemsUpserted++
      } catch (err) {
        summary.itemsFailed++
        logger.warn('amazon-orders: item create failed', {
          orderId: raw.AmazonOrderId,
          orderItemId: item.OrderItemId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async createOrderItem(orderId: string, item: AmazonOrderItemRaw): Promise<void> {
    const totalPrice = item.ItemPrice?.Amount ? Number(item.ItemPrice.Amount) : 0
    const sku = item.SellerSKU ?? item.ASIN

    // Try to link to a local Product by SKU first, then by ASIN.
    let productId: string | null = null
    if (item.SellerSKU) {
      const prod = await prisma.product.findUnique({
        where: { sku: item.SellerSKU },
        select: { id: true },
      })
      productId = prod?.id ?? null
    }
    if (!productId && item.ASIN) {
      const prod = await prisma.product.findFirst({
        where: { amazonAsin: item.ASIN },
        select: { id: true },
      })
      productId = prod?.id ?? null
    }

    await prisma.orderItem.create({
      data: {
        orderId,
        sku,
        quantity: item.QuantityOrdered,
        price: totalPrice,
        amazonMetadata: item as object,
        ...(productId ? { productId } : {}),
      },
    })
  }
}

export const amazonOrdersService = new AmazonOrdersService()
