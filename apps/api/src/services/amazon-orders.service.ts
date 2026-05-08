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
 * Stock semantics (S.2):
 *   - FBA orders: never touched here. Amazon ships from FBA inventory,
 *     and the 15-min FBA cron syncs `fulfillableQuantity` into the
 *     AMAZON-EU-FBA StockLevel — that's the canonical FBA source.
 *     Decrementing here would double-count.
 *   - FBM orders: reserve-then-consume pattern. At ingestion we hold
 *     stock at IT-MAIN (StockLevel.reserved goes up, available goes
 *     down, quantity unchanged). When Amazon transitions the order
 *     to SHIPPED we consume the reservation (quantity decreases too).
 *     If the order is cancelled, the reservation is released (no
 *     quantity change). Idempotency: every helper checks for an
 *     existing reservation by (orderId, productId) before acting.
 */

import prisma from '../db.js'
import {
  AmazonService,
  AmazonOrderRaw,
  AmazonOrderItemRaw,
} from './marketplaces/amazon.service.js'
import { logger } from '../utils/logger.js'
import {
  reserveOpenOrder,
  consumeOpenOrder,
  resolveLocationByCode,
} from './stock-level.service.js'

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
  // S.2 — FBM stock lifecycle counters
  fbmReservationsCreated: number
  fbmReservationsConsumed: number
  fbmInsufficientStock: number
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
      fbmReservationsCreated: 0,
      fbmReservationsConsumed: 0,
      fbmInsufficientStock: 0,
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
      fbmReservationsCreated: summary.fbmReservationsCreated,
      fbmReservationsConsumed: summary.fbmReservationsConsumed,
      fbmInsufficientStock: summary.fbmInsufficientStock,
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

    // O.7: terminal-status downgrade guard. If the local row is
    // already in a terminal state (operator cancelled before the
    // channel-cancel pushback completed) and SP-API still reports a
    // non-terminal status, preserve the local status + lifecycle
    // timestamps. Metadata still refreshes.
    const { shouldPreserveTerminalStatus } = await import(
      './order-status-guards.js'
    )
    const preserveStatus = shouldPreserveTerminalStatus(
      existing?.status,
      status,
    )
    if (preserveStatus) {
      logger.info('amazon-orders: preserving local terminal status (channel still reports non-terminal)', {
        orderId: raw.AmazonOrderId,
        localStatus: existing?.status,
        channelStatus: status,
      })
    }

    const updateData = {
      status: preserveStatus ? (existing!.status as any) : status,
      totalPrice,
      currencyCode,
      customerName: pickCustomerName(raw),
      customerEmail: pickCustomerEmail(raw),
      shippingAddress,
      fulfillmentMethod,
      marketplace,
      purchaseDate,
      shippedAt:
        !preserveStatus && isShippedLike
          ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate)
          : undefined,
      cancelledAt:
        !preserveStatus && status === 'CANCELLED'
          ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate)
          : undefined,
      deliveredAt:
        !preserveStatus && status === 'DELIVERED'
          ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate)
          : undefined,
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

    // S.2: did we just transition to SHIPPED? Only the SHIPPED status
    // (not PARTIALLY_SHIPPED) consumes reservations — partials stay
    // reserved until the order completes, since we don't know which
    // line items shipped from the order-level status alone. Operators
    // can manually consume via the drawer if a partial drags.
    const newlyShipped =
      status === 'SHIPPED'
      && (existing == null || existing.status !== 'SHIPPED')

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

    // O.6: emit lifecycle event so OrdersWorkspace auto-refreshes
    // without polling. Created vs. updated mirrors the upsert path —
    // existing == null means we just created, otherwise the row was
    // touched (status / metadata refresh).
    void (async () => {
      try {
        const { publishOrderEvent } = await import('./order-events.service.js')
        publishOrderEvent(
          existing == null
            ? {
                type: 'order.created',
                orderId: order.id,
                channel: 'AMAZON',
                channelOrderId: raw.AmazonOrderId,
                ts: Date.now(),
              }
            : {
                type: 'order.updated',
                orderId: order.id,
                channel: 'AMAZON',
                status,
                ts: Date.now(),
              },
        )
      } catch {
        // bus failure must not break ingestion
      }
    })()

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

    // O.5: upsert by (orderId, externalLineItemId=Amazon OrderItemId)
    // instead of delete-then-create. OrderItem.id stays stable across
    // SP-API re-polls so ReturnItem.orderItemId joins keep working
    // when the same order is touched twice (e.g. shipping update +
    // refund-on-return both arrive within a 15-min cron window).
    // Same-SKU-on-multiple-lines is still allowed because the unique
    // key is the line id, not the SKU.
    const items = await amazonService.fetchOrderItems(raw.AmazonOrderId)
    const createdItems: Array<{ productId: string | null; quantity: number; sku: string }> = []
    for (const item of items) {
      try {
        const created = await this.upsertOrderItem(order.id, item)
        createdItems.push(created)
        summary.itemsUpserted++
      } catch (err) {
        summary.itemsFailed++
        logger.warn('amazon-orders: item upsert failed', {
          orderId: raw.AmazonOrderId,
          orderItemId: item.OrderItemId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // S.2: FBM stock lifecycle. FBA never touched here. Cancellations
    // are handled by the existing handleOrderCancelled cascade above
    // (which now also releases open reservations — see order-cancellation).
    if (fulfillmentMethod === 'FBM') {
      await this.applyFbmStockLifecycle({
        orderId: order.id,
        rawAmazonOrderId: raw.AmazonOrderId,
        items: createdItems,
        newlyShipped,
        summary,
      })
    }
  }

  /**
   * S.2 — FBM reserve-then-consume lifecycle. Always tries to reserve
   * (idempotent: skipped if a reservation already exists for this
   * orderId+productId). If the order has just transitioned to SHIPPED,
   * consume every open reservation for the order.
   *
   * Insufficient-stock errors are logged + counted but never throw —
   * Amazon already accepted the order; we can't refuse it. Operator
   * sees the oversell via the upcoming negative-available alert.
   */
  private async applyFbmStockLifecycle(args: {
    orderId: string
    rawAmazonOrderId: string
    items: Array<{ productId: string | null; quantity: number; sku: string }>
    newlyShipped: boolean
    summary: SyncSummary
  }): Promise<void> {
    const itMainId = await resolveLocationByCode('IT-MAIN')
    if (!itMainId) {
      logger.error('amazon-orders: IT-MAIN location missing — cannot reserve FBM stock', {
        orderId: args.orderId,
      })
      return
    }

    for (const it of args.items) {
      if (!it.productId || it.quantity <= 0) continue
      try {
        const before = await prisma.stockReservation.count({
          where: {
            orderId: args.orderId,
            releasedAt: null,
            consumedAt: null,
            stockLevel: { productId: it.productId },
          },
        })
        await reserveOpenOrder({
          orderId: args.orderId,
          productId: it.productId,
          locationId: itMainId,
          quantity: it.quantity,
          actor: 'amazon-orders-sync',
        })
        const after = await prisma.stockReservation.count({
          where: {
            orderId: args.orderId,
            releasedAt: null,
            consumedAt: null,
            stockLevel: { productId: it.productId },
          },
        })
        if (after > before) args.summary.fbmReservationsCreated++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('insufficient available')) {
          args.summary.fbmInsufficientStock++
          logger.warn('amazon-orders: FBM oversell — order accepted but insufficient stock to reserve', {
            orderId: args.orderId,
            productId: it.productId,
            sku: it.sku,
            quantity: it.quantity,
          })
        } else {
          logger.warn('amazon-orders: FBM reserve failed', {
            orderId: args.orderId,
            productId: it.productId,
            sku: it.sku,
            error: msg,
          })
        }
      }
    }

    if (args.newlyShipped) {
      try {
        const consumed = await consumeOpenOrder({
          orderId: args.orderId,
          actor: 'amazon-orders-sync',
        })
        args.summary.fbmReservationsConsumed += consumed
        if (consumed > 0) {
          logger.info('amazon-orders: FBM SHIPPED transition consumed reservations', {
            orderId: args.orderId,
            rawAmazonOrderId: args.rawAmazonOrderId,
            consumed,
          })
        }
      } catch (err) {
        logger.warn('amazon-orders: FBM consume on SHIPPED failed', {
          orderId: args.orderId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private async upsertOrderItem(
    orderId: string,
    item: AmazonOrderItemRaw,
  ): Promise<{ productId: string | null; quantity: number; sku: string }> {
    const totalPrice = item.ItemPrice?.Amount ? Number(item.ItemPrice.Amount) : 0
    const sku = item.SellerSKU ?? item.ASIN ?? ''
    const externalLineItemId = item.OrderItemId

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

    await prisma.orderItem.upsert({
      where: {
        orderId_externalLineItemId: { orderId, externalLineItemId },
      },
      create: {
        orderId,
        externalLineItemId,
        sku,
        quantity: item.QuantityOrdered,
        price: totalPrice,
        amazonMetadata: item as object,
        ...(productId ? { productId } : {}),
      },
      update: {
        sku,
        quantity: item.QuantityOrdered,
        price: totalPrice,
        amazonMetadata: item as object,
        ...(productId ? { productId } : {}),
      },
    })

    return { productId, quantity: item.QuantityOrdered, sku }
  }
}

export const amazonOrdersService = new AmazonOrdersService()
