/**
 * eBay Orders Service (audit fix #2 — TECH_DEBT #33)
 *
 * Fetches orders from eBay's Fulfillment API. Writing them is the ONE transactional writer in
 * ebay-order-writer.ts (shared with stored notification replay): the order, its unseen lines and
 * their stock effect commit together, and the post-commit hooks run after it.
 *
 * Phase 26 mapping:
 *   eBay orderId            → Order.channelOrderId (with channel='EBAY')
 *   pricingSummary.total    → Order.totalPrice (Decimal)
 *   pricingSummary.currency → Order.currencyCode
 *   buyer.username          → Order.customerName, and exactly in Order.ebayMetadata.buyer.username
 *   buyer.email             → Order.customerEmail (or a .invalid placeholder when eBay omits it)
 *   creationDate            → Order.purchaseDate
 *   orderStatus / fulfillmentStatus / lastModifiedDate → Order.ebayMetadata (JSON)
 *
 * Idempotency: the (channel, channelOrderId) and (order, externalLineItemId) unique keys, read
 * under the writer's locks. Re-running the cron is safe — quantities never double-deduct.
 */

import { ebaySend, ebayTransport } from './gateway/ebay.js'
import { GatewayRefusal } from './gateway/gateway.js'
import { retryAfterMs } from './cx/ebay-grant-introspection.js'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { EbayAuthService } from './ebay-auth.service.js'
import { recordApiCall } from './outbound-api-call-log.service.js'
import { ebayAmountCurrency, ebayOrderConnectionLink, ingestEbayOrder, parseEbayAmount, type EbayAmountLike } from './ebay-order-writer.js'

// Pure helpers moved with the writer; re-exported for existing importers.
export { ebayAmountCurrency, ebayOrderConnectionLink, parseEbayAmount }
export type { EbayAmountLike }

interface EbayOrder {
  orderId: string
  creationDate: string
  // AS.3c — these four were imagined; live Fulfillment API payloads carry
  // orderFulfillmentStatus / orderPaymentStatus / cancelStatus and ship-to
  // under fulfillmentStartInstructions (normalized in ebay-order-writer.ts).
  lastModifiedDate?: string
  orderStatus?: string
  fulfillmentStatus?: string
  buyer: {
    username: string
    email?: string
  }
  shippingAddress?: {
    addressLine1: string
    addressLine2?: string
    city: string
    stateOrProvince: string
    postalCode: string
    countryCode: string
  }
  pricingSummary: {
    // AS.3b — the REAL Fulfillment API returns Amount objects
    // ({ value, currency }), not bare strings. The old string-typed shape
    // made Number(total) = NaN → every real order threw
    // "invalid pricingSummary.total [object Object]" and no eBay sale ever
    // reached the pool. parseEbayAmount accepts every historical shape.
    total: EbayAmountLike
    currency?: string
  }
  lineItems: Array<{
    lineItemId: string
    /** Absent on non-SKU/pre-relabel listings — resolved via legacyItemId
     *  membership lookup in ebay-order-writer.ts (AS.3d). */
    sku?: string
    legacyItemId?: string
    title: string
    quantity: number
    lineItemCost: EbayAmountLike
    /** Real API: array of { amount: {value,currency} }; legacy fixtures used
     *  { taxAmount: string }. Both accepted. */
    taxes?: Array<{ amount?: EbayAmountLike; taxAmount?: EbayAmountLike }> | { taxAmount?: EbayAmountLike }
    discounts?: Array<{
      discountAmount: EbayAmountLike
    }>
  }>
}

/** Why one order could not be read; the stored receipt maps it to defer / retry. */
export class EbayOrderFetchError extends Error {
  constructor(readonly reason: 'rate_limited' | 'auth_required' | 'not_found' | 'remote_error' | 'transport' | 'invalid_response', readonly retryAfterMs?: number) {
    super('The eBay order could not be read.')
    this.name = 'EbayOrderFetchError'
  }
}

/**
 * One order, one account — the stored notice's read. GET /sell/fulfillment/v1/order/{orderId} on
 * the same gateway sender as polling (kind 'read', the account's own token from the token service).
 * Never lists orders and never touches another account. One attempt: the receipt owns the retry
 * budget, so the gateway neither sleeps on a 429 nor repeats a 5xx. Call it outside every lock.
 */
export async function fetchEbayOrderById(connectionId: string, orderId: string, options: { environment?: 'production' | 'sandbox' } = {}): Promise<unknown> {
  const host = options.environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'
  const url = `${host}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`
  return recordApiCall<unknown>({ channel: 'EBAY', operation: 'getOrder', endpoint: '/sell/fulfillment/v1/order/{orderId}', method: 'GET', triggeredBy: 'webhook' }, async () => {
    let response: Response
    try {
      response = await ebayTransport(connectionId, { maxTransientRetries: 0, max429Retries: 0, timeoutMs: 30_000 })(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } })
    } catch (error) {
      if (error instanceof GatewayRefusal) {
        throw new EbayOrderFetchError(error.code === 'RATE_LIMITED_LOCAL' ? 'rate_limited' : error.outcome === 'held' ? 'auth_required' : 'remote_error')
      }
      throw new EbayOrderFetchError('transport')
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      throw new EbayOrderFetchError(
        response.status === 429 ? 'rate_limited' : response.status === 401 ? 'auth_required' : response.status === 404 ? 'not_found' : 'remote_error',
        response.status === 429 || response.status === 503 ? retryAfterMs(response.headers) : undefined)
    }
    try { return await response.json() } catch { throw new EbayOrderFetchError('invalid_response') }
  })
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
    /** P1.2 — the account the token belongs to (every call goes through the channel gateway). */
    connectionId: string | null = null,
  ): Promise<EbayOrder[]> {
    try {
      const since = new Date()
      since.setDate(since.getDate() - days)
      const fromDate = since.toISOString()

      const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=creationdate:[${fromDate}]&limit=200`
      // L.3.3 — wrap in recordApiCall so every cron tick writes an
      // OutboundApiCallLog row (latency, status, error bucket). The
      // SP-API library handles this automatically via instrumentSellingPartner;
      // eBay uses raw fetch so each callsite needs explicit wrapping.
      const data = await recordApiCall<{ orders?: EbayOrder[] }>(
        {
          channel: 'EBAY',
          operation: 'getOrders',
          endpoint: '/sell/fulfillment/v1/order',
          method: 'GET',
          triggeredBy: 'cron',
        },
        async () => {
          const response = await ebaySend(connectionId, url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          })
          if (!response.ok) {
            const errorBody = await response.text().catch(() => '')
            const err = new Error(
              `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string }
            err.statusCode = response.status
            err.body = errorBody
            throw err
          }
          return (await response.json()) as { orders?: EbayOrder[] }
        },
      )
      return data.orders ?? []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Error fetching eBay orders', { error: message })
      throw error
    }
  }

  /**
   * Historical backfill — fetch eBay orders inside an explicit
   * `[from, to]` window with pagination via `offset` + `limit`. Used by
   * the first-backfill runner to walk 24 months of history in 7-day
   * chunks (matches eBay's natural rolling window). Idempotent at the
   * processOrder layer (upsert on channelOrderId).
   */
  async fetchEbayOrdersInRange(
    accessToken: string,
    from: Date,
    to: Date,
    /** P1.2 — the account the token belongs to (every call goes through the channel gateway). */
    connectionId: string | null = null,
  ): Promise<EbayOrder[]> {
    const pageSize = 200 // eBay's max per call
    const collected: EbayOrder[] = []
    let offset = 0
    while (true) {
      const filter = `creationdate:[${from.toISOString()}..${to.toISOString()}]`
      const url =
        `https://api.ebay.com/sell/fulfillment/v1/order?` +
        `filter=${encodeURIComponent(filter)}&limit=${pageSize}&offset=${offset}`
      const data = await recordApiCall<{ orders?: EbayOrder[]; total?: number }>(
        {
          channel: 'EBAY',
          operation: 'getOrders',
          endpoint: '/sell/fulfillment/v1/order',
          method: 'GET',
          triggeredBy: 'manual',
        },
        async () => {
          const response = await ebaySend(connectionId, url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
          })
          if (!response.ok) {
            const errorBody = await response.text().catch(() => '')
            const err = new Error(
              `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string }
            err.statusCode = response.status
            err.body = errorBody
            throw err
          }
          return (await response.json()) as { orders?: EbayOrder[]; total?: number }
        },
      )
      const page = data.orders ?? []
      collected.push(...page)
      if (page.length < pageSize) return collected
      offset += pageSize
      // Polite spacing — keeps us well under the 5000/day daily call cap.
      await new Promise(r => setTimeout(r, 250))
    }
  }

  /**
   * Process one eBay order through the transactional writer. A thin wrapper so the cron, the
   * backfill and existing callers keep their shape; stats come from what the writer committed.
   */
  private async processOrder(order: EbayOrder, connectionId: string) {
    const result = await ingestEbayOrder(order, connectionId, { actor: 'ebay-orders-sync' })
    if (result.created) this.stats.ordersCreated++
    else this.stats.ordersUpdated++
    this.stats.itemsProcessed += result.stats.itemsProcessed
    this.stats.itemsLinked += result.stats.itemsLinked
    this.stats.inventoryDeducted += result.stats.inventoryDeducted
    return result.order
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
      // AS.3 — getValidToken takes the CONNECTION ID, not the row. Passing the
      // object (hidden by the `as any` prisma cast) made the inner findUnique
      // throw before any HTTP call — every poll tick failed for 7+ days with
      // fetched=0 and zero OutboundApiCallLog rows.
      const accessToken = await authService.getValidToken(connection.id)

      const orders = await this.fetchEbayOrders(accessToken, 7, connection.id)
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
   * Historical backfill wrapper — same shape as `syncEbayOrders` but
   * pulls every order inside an explicit `[from, to]` window via
   * `fetchEbayOrdersInRange`. Driven by `scripts/first-backfill.ts`.
   */
  async syncEbayOrdersInRange(
    connectionId: string,
    from: Date,
    to: Date,
  ): Promise<SyncResult> {
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
      // AS.3 — connection ID, not the row (same defect as syncEbayOrders).
      const accessToken = await authService.getValidToken(connection.id)

      const orders = await this.fetchEbayOrdersInRange(accessToken, from, to, connection.id)
      this.stats.ordersFetched = orders.length
      logger.info('Fetched eBay orders (range)', {
        count: orders.length,
        from: from.toISOString(),
        to: to.toISOString(),
      })

      for (const order of orders) {
        try {
          await this.processOrder(order, connectionId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push({ orderId: order.orderId, error: message })
          logger.error('Failed to process eBay order (range)', {
            orderId: order.orderId,
            error: message,
          })
        }
      }

      return {
        syncId: `ebay-orders-range-${Date.now()}`,
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
        completedAt: new Date(),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('eBay orders range sync failed', { error: message })
      return {
        syncId: `ebay-orders-range-${Date.now()}`,
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
