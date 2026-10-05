import { workspaceKey } from '@nexus/database/workspace-context'
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
import { recordOrderItem } from './sales-aggregate.service.js'
import {
  reserveOpenOrder,
  unitsPerProduct,
  consumeOpenOrder,
  resolveLocationByCode,
} from './stock-level.service.js'
import { InsufficientStockError, recascadeProduct } from './stock-movement.service.js'
import { amazonAccount } from '../lib/amazon-sp-client.js'
import { matchInboundSku } from './listings/channel-sku-inbound.js'

const amazonService = new AmazonService()

// An FBM order already in one of these before a read had its stock given back, or its stock belongs to
// the returns flow: a re-read must not hold stock again. SHIPPED/DELIVERED are deliberately absent — a
// re-read is how a line that could not be held at ingest (oversold) is taken once stock is there, and
// the hold/consume guards in stock-level.service keep every re-read to what the line still owes.
const FBM_NO_HOLD_ON_REREAD = new Set(['CANCELLED', 'REFUNDED', 'RETURNED'])
// A shipped FBM order never goes back to a pre-shipment status on a stale read (status only).
const FBM_PRE_SHIPMENT_STATUSES = new Set(['PENDING', 'PROCESSING', 'PARTIALLY_SHIPPED'])

/**
 * CX A0 — the Amazon account an order was imported through. A new order is created with the
 * pinned account (upsert `create`); an existing order gains it only while unattributed, by a
 * compare-and-set on NULL, so a concurrent import or the attribution backfill that linked it
 * first is never overwritten. A DIFFERENT account is a conflict to report: an Amazon order id
 * belongs to one seller, and re-pointing it would move its money to another account's books.
 */
export async function linkAmazonOrderAccount(
  order: { id: string; channelConnectionId: string | null },
  accountId: string,
): Promise<{ outcome: 'linked' | 'attributed' | 'conflict'; linkedConnectionId: string | null }> {
  if (order.channelConnectionId === accountId) return { outcome: 'linked', linkedConnectionId: accountId }
  if (order.channelConnectionId == null) {
    const { count } = await prisma.order.updateMany({ where: { id: order.id, channelConnectionId: null }, data: { channelConnectionId: accountId } })
    if (count === 1) return { outcome: 'attributed', linkedConnectionId: accountId }
    const current = await prisma.order.findUnique({ where: { id: order.id }, select: { channelConnectionId: true } })
    if (current?.channelConnectionId === accountId) return { outcome: 'linked', linkedConnectionId: accountId }
    return { outcome: 'conflict', linkedConnectionId: current?.channelConnectionId ?? null }
  }
  return { outcome: 'conflict', linkedConnectionId: order.channelConnectionId }
}

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

/**
 * RV.2.2 — add N business days to a date, skipping weekends.
 * Approximation: ignores public holidays. Italy averages ~12 bank
 * holidays/year, so the worst-case error vs. real carrier delivery is
 * ~2 days — well inside the Amazon Solicitations 4-30d send window.
 */
function addBusinessDays(date: Date, days: number): Date {
  const out = new Date(date.getTime())
  let added = 0
  while (added < days) {
    out.setDate(out.getDate() + 1)
    const dow = out.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return out
}

/**
 * Higher-authority sources never get overwritten by lower-authority ones.
 * Returns true when we are allowed to set deliveredAt to a heuristic value
 * over the existing one.
 */
const DELIVERED_AUTHORITATIVE_SOURCES = new Set([
  'AMAZON_API',
  'AMAZON_REPORT',
  'CARRIER_WEBHOOK',
  'MCF_API',
  'MANUAL',
])
function canOverwriteWithHeuristic(existingSource: string | null | undefined): boolean {
  if (!existingSource) return true
  return !DELIVERED_AUTHORITATIVE_SOURCES.has(existingSource)
}

/** AFN = Amazon Fulfilled (FBA), MFN = Merchant Fulfilled (FBM). */
function mapFulfillmentMethod(channel?: string): string | null {
  if (channel === 'AFN' || channel === 'AmazonFulfilled') return 'FBA'
  if (channel === 'MFN' || channel === 'MerchantFulfilled') return 'FBM'
  return channel ?? null
}

/**
 * P5.4 — buyer personal data: we do not ask Amazon for it, and we do not receive it.
 *
 * Amazon redacts buyer PII from `getOrders` / `getOrder` unless the call carries a
 * **Restricted Data Token**. Nexus has never minted one:
 * `createRestrictedDataToken` appears **once** in the whole codebase, inside the
 * gateway's list of read-shaped POST operations (`services/gateway/amazon-sdk.ts:24`),
 * and there is no call site.
 *
 * Measured on the development database 2026-09-21, across **4,464** Amazon orders:
 *
 * | column | rows with a value |
 * |---|---|
 * | `customerEmail` | **0** |
 * | `customerId` | **0** |
 * | `customerName` | 4,464 — **all of them the literal fallback below** |
 * | `shippingAddress` with a street (`AddressLine1`) | **0** |
 *
 * The stored addresses carry only City / CountryCode / PostalCode / StateOrRegion
 * (occasionally County, CompanyName) — exactly the non-personal subset Amazon returns
 * without an RDT, and what the shipping-cost and tax logic needs.
 *
 * So the plan's row — *"use a Restricted Data Token where we read buyer personal data
 * — or stop reading it if we do not need it"* — is answered by the second branch: **we
 * do not read it.** These two readers are kept, rather than deleted, because they are
 * the only place that says so; deleting them would leave the question open for the
 * next person to "fix" by adding an RDT.
 *
 * 🔴 **The risk here runs the other way.** If an RDT is ever added, `customerEmail`
 * silently starts filling with real buyer addresses, into a column with no retention
 * rule and no operator awareness. `amazon-buyer-pii.p54.vitest.test.ts` holds the
 * no-RDT decision so that changing it is a visible diff that has to carry a reason.
 */
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
    // EU region
    APJ6JRA9NG5V4: 'IT',
    A1PA6795UKMFR9: 'DE',
    A13V1IB3VIYZZH: 'FR',
    A1RKKUPIHCS9HS: 'ES',
    A1F83G8C2ARO7P: 'UK',
    A1805IZSGTT6HS: 'NL',
    A2NODRKZP88ZB9: 'SE',
    A1C3SOZRARQ6R3: 'PL',
    AMEN7PMS3EDWL: 'BE',
    A28R8C7NBKEWEA: 'IE',
    A33AVAJ2PDY3EV: 'TR',
    A17E79C6D8DWNP: 'SA',
    A2VIGQ35RCS4UG: 'AE',
    // NA region (kept for completeness; only enable in env)
    ATVPDKIKX0DER: 'US',
    A2EUQ1WTGCTBG2: 'CA',
    A1AM78C64UM0Y8: 'MX',
  }
  return map[marketplaceId] ?? null
}

/**
 * MS.1 — default marketplace IDs the EU cron sweeps when
 * NEXUS_AMAZON_MARKETPLACE_IDS isn't set. SP-API ListOrders accepts
 * multiple in one call (returns the union, each order carrying its
 * own MarketplaceId), so one request covers all of them and stays
 * inside the 0.0167 req/s throttle.
 *
 * The 11 EU markets Amazon supports under the EU SP-API region:
 *   IT, DE, FR, ES, UK, NL, SE, PL, BE, IE, TR (+ SA, AE for ME).
 */
export const DEFAULT_EU_MARKETPLACE_IDS = [
  'APJ6JRA9NG5V4', // IT
  'A1PA6795UKMFR9', // DE
  'A13V1IB3VIYZZH', // FR
  'A1RKKUPIHCS9HS', // ES
  'A1F83G8C2ARO7P', // UK
  'A1805IZSGTT6HS', // NL
  'A2NODRKZP88ZB9', // SE
  'A1C3SOZRARQ6R3', // PL
  'AMEN7PMS3EDWL', // BE
  'A28R8C7NBKEWEA', // IE
  'A33AVAJ2PDY3EV', // TR
] as const

export function getConfiguredMarketplaceIds(): string[] {
  const env = process.env.NEXUS_AMAZON_MARKETPLACE_IDS
  if (!env || !env.trim()) return [...DEFAULT_EU_MARKETPLACE_IDS]
  return env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * MS.5 — DB-backed marketplace config. Reads operator-controlled
 * isActive flags from the Marketplace table. Falls back to env var,
 * then the hardcoded default. Used by the cron + market-health
 * endpoint so flipping a toggle in the admin UI takes effect on the
 * next sync tick without redeploying.
 *
 * Filter: channel='AMAZON' AND isActive AND marketplaceId NOT NULL
 * AND region='EU' (NA/FE markets need different SP-API credentials).
 */
export async function getActiveMarketplaceIdsFromDb(): Promise<string[]> {
  try {
    const rows = await prisma.marketplace.findMany({
      where: {
        channel: 'AMAZON',
        isActive: true,
        region: 'EU',
        marketplaceId: { not: null },
      },
      select: { marketplaceId: true },
    })
    const ids = rows.map((r) => r.marketplaceId).filter((id): id is string => !!id)
    if (ids.length > 0) return ids
  } catch (e: any) {
    logger.warn('marketplace-config: DB read failed — falling back to env/default', {
      error: e?.message ?? String(e),
    })
  }
  return getConfiguredMarketplaceIds()
}

interface SyncSummary {
  startedAt: Date
  completedAt: Date
  durationMs: number
  cursor: { mode: 'since' | 'daysBack' | 'range'; value: string }
  ordersFetched: number
  ordersUpserted: number
  ordersFailed: number
  itemsUpserted: number
  itemsFailed: number
  // S.2 — FBM stock lifecycle counters
  fbmReservationsCreated: number
  fbmReservationsConsumed: number
  fbmInsufficientStock: number
  /** CX A0 — orders already linked to a different Amazon account; the link was kept. */
  accountConflicts?: number
  errors: Array<{ orderId: string; error: string }>
}

export class AmazonOrdersService {
  async isConfigured(): Promise<boolean> {
    return (await amazonService.isConfigured())
  }

  /**
   * Initial backfill — pulls every order with `CreatedAfter >= now - daysBack`.
   * Default 30 days. Bounded by `limit` (default 1000) so an unbounded
   * backfill can't pin the API process.
   *
   * M2: pass `marketplaceId` to scope to one Amazon marketplace; defaults
   * to env AMAZON_MARKETPLACE_ID. Multi-market backfill is handled at the
   * route layer (POST /api/amazon/orders/sync `marketplaceIds[]`) so each
   * market gets its own SyncSummary.
   */
  async syncAllOrders(options: { daysBack?: number; limit?: number; marketplaceId?: string; marketplaceIds?: string[] } = {}): Promise<SyncSummary> {
    const daysBack = options.daysBack ?? 30
    return this.runSync(
      { daysBack, limit: options.limit, marketplaceId: options.marketplaceId, marketplaceIds: options.marketplaceIds },
      { mode: 'daysBack', value: String(daysBack) },
    )
  }

  /**
   * Incremental poll — pulls every order with `LastUpdatedAfter >= since`.
   * Picks up status transitions on already-known orders (Pending → Shipped,
   * etc.) as well as newly-placed orders.
   */
  async syncNewOrders(since: Date, options: { limit?: number; marketplaceId?: string; marketplaceIds?: string[] } = {}): Promise<SyncSummary> {
    return this.runSync(
      { since, limit: options.limit, marketplaceId: options.marketplaceId, marketplaceIds: options.marketplaceIds },
      { mode: 'since', value: since.toISOString() },
    )
  }

  /**
   * Historical backfill — pulls every order with
   * `CreatedAfter >= from AND CreatedBefore <= to`.
   * Used by `scripts/first-backfill.ts` to walk 24 months of history in
   * 30-day chunks. Idempotent: re-running the same window upserts on the
   * (channel, channelOrderId) unique constraint.
   */
  async syncOrdersInRange(opts: { from: Date; to: Date; limit?: number; marketplaceId?: string; marketplaceIds?: string[] }): Promise<SyncSummary> {
    return this.runSync(
      { from: opts.from, to: opts.to, limit: opts.limit, marketplaceId: opts.marketplaceId, marketplaceIds: opts.marketplaceIds },
      { mode: 'range', value: `${opts.from.toISOString()}..${opts.to.toISOString()}` },
    )
  }

  /**
   * OX.0 — backfill OrderTotal for orders that were ingested at €0.00
   * but should have a real price (status NOT IN PENDING, CANCELLED).
   *
   * Calls SP-API `getOrder` per stale row (rate-limit-bounded by the
   * client throttle). Idempotent: re-running only updates rows that
   * still meet the stale criteria.
   *
   * Targets Amazon only — eBay + Shopify ingest their own totals and
   * don't suffer the same Pending-state withholding.
   */
  async backfillZeroTotals(
    options: {
      limit?: number
      olderThanDays?: number
      includePending?: boolean
      // GS-RT.4 — when set, only consider rows whose channelOrderId is
      // in this list. Used by the SQS ORDER_CHANGE handler to target
      // the specific order that just transitioned status, instead of
      // walking the global €0 backlog. The limit + status guards still
      // apply, so this is a strict subset of the default scope.
      channelOrderIds?: string[]
    } = {},
  ): Promise<{
    scanned: number
    repaired: number
    // GS-RT.7 — distinct counter for rows recovered via the
    // OrderItem.price fallback rather than the primary getOrder
    // OrderTotal path. Optional so old callers reading the response
    // shape stay backwards-compatible.
    repairedFromItems?: number
    skipped: number
    failed: number
    errors: Array<{ orderId: string; error: string }>
  }> {
    const limit = options.limit ?? 100
    // AR.1 — includePending=true repairs the PENDING+€0 rows that
    // landed before SA.2's eager getOrder went live. SA.2 fixes new
    // PENDING ingests at upsert time; this backfill closes the gap
    // for orders already in the DB. The Global Snapshot "sales today"
    // total then matches Amazon Seller Central without waiting for
    // each PENDING order to transition state.
    const excludedStatuses = options.includePending
      ? ['CANCELLED']
      : ['PENDING', 'CANCELLED']
    const stale = await prisma.order.findMany({
      where: {
        channel: 'AMAZON',
        totalPrice: 0,
        status: { notIn: excludedStatuses as any },
        deletedAt: null,
        ...(options.channelOrderIds && options.channelOrderIds.length > 0
          ? { channelOrderId: { in: options.channelOrderIds } }
          : {}),
      },
      select: { id: true, channelOrderId: true },
      orderBy: { purchaseDate: 'asc' },
      take: limit,
    })
    const result = {
      scanned: stale.length,
      repaired: 0,
      // GS-RT.7 — distinct counter for rows recovered from the
      // OrderItem.price fallback (vs the primary getOrder OrderTotal
      // path). Helps operators understand whether the SP-API fix
      // landed (getOrder count climbs) or whether we're surviving on
      // the legacy ingest data (items count climbs).
      repairedFromItems: 0,
      skipped: 0,
      failed: 0,
      errors: [] as Array<{ orderId: string; error: string }>,
      skips: [] as Array<{ orderId: string; reason: string; status?: string }>,
    }

    // GS-RT.7 — fallback when getOrder returns no OrderTotal. Looks
    // up the existing OrderItem rows for the order and sums
    // price × quantity. SP-API getOrderItems populates ItemPrice for
    // most orders even when getOrder withholds OrderTotal (esp. older
    // FBA Shipped orders), and we already captured those values at
    // ingest into OrderItem.price. Returns { cents, source } or null.
    const tryItemPriceFallback = async (
      orderId: string,
    ): Promise<{ amount: number; currency: string } | null> => {
      const items = await prisma.orderItem.findMany({
        where: { orderId },
        select: { price: true, quantity: true },
      })
      if (items.length === 0) return null
      let total = 0
      for (const it of items) {
        const unit = Number(it.price ?? 0)
        if (!Number.isFinite(unit) || unit <= 0) continue
        total += unit * (it.quantity ?? 0)
      }
      if (total <= 0) return null
      // Currency: keep whatever the existing Order row had (will be
      // EUR by default for IT/DE/FR/ES marketplaces). The caller
      // doesn't touch currencyCode when we go through this path —
      // OrderItem doesn't carry currency.
      return { amount: total, currency: '' }
    }

    // DA-RT.6 — track repaired order IDs so we can refresh the
    // DailySalesAggregate window once at the end. Without this trigger,
    // the aggregate stays stale for hours (until the next nightly
    // sales-aggregate cron) — insights/replenishment/forecast pages
    // would keep showing the under-reported pre-repair numbers.
    const repairedOrderIds: string[] = []

    for (const row of stale) {
      try {
        const raw = await amazonService.fetchOrderById(row.channelOrderId)
        if (!raw) {
          // GS-RT.7 — even when getOrder returns null (NotFound /
          // unavailable), the existing OrderItem rows may still give
          // us a real total. Try the fallback before skipping.
          const fb = await tryItemPriceFallback(row.id)
          if (fb) {
            await prisma.order.update({
              where: { id: row.id },
              data: { totalPrice: fb.amount },
            })
            result.repairedFromItems += 1
            repairedOrderIds.push(row.id)
            continue
          }
          result.skipped += 1
          result.skips.push({ orderId: row.channelOrderId, reason: 'getOrder returned null (NotFound or unavailable)' })
          continue
        }
        if (!raw.OrderTotal?.Amount) {
          // GS-RT.7 — primary getOrder path returned no OrderTotal
          // (the long-tail FBA Shipped case the 2026-05-23 audit
          // surfaced). Try the OrderItem.price fallback.
          const fb = await tryItemPriceFallback(row.id)
          if (fb) {
            await prisma.order.update({
              where: { id: row.id },
              data: { totalPrice: fb.amount },
            })
            result.repairedFromItems += 1
            repairedOrderIds.push(row.id)
            continue
          }
          result.skipped += 1
          result.skips.push({ orderId: row.channelOrderId, reason: 'OrderTotal.Amount missing AND OrderItem.price fallback empty', status: raw.OrderStatus })
          continue
        }
        const amount = Number(raw.OrderTotal.Amount)
        if (!Number.isFinite(amount) || amount === 0) {
          // GS-RT.7 — getOrder returned a non-positive total. Try
          // OrderItem.price before giving up.
          const fb = await tryItemPriceFallback(row.id)
          if (fb) {
            await prisma.order.update({
              where: { id: row.id },
              data: { totalPrice: fb.amount },
            })
            result.repairedFromItems += 1
            repairedOrderIds.push(row.id)
            continue
          }
          result.skipped += 1
          result.skips.push({ orderId: row.channelOrderId, reason: `OrderTotal.Amount=${raw.OrderTotal.Amount} AND OrderItem.price fallback empty`, status: raw.OrderStatus })
          continue
        }
        await prisma.order.update({
          where: { id: row.id },
          data: {
            totalPrice: amount,
            currencyCode: raw.OrderTotal.CurrencyCode ?? 'EUR',
          },
        })
        result.repaired += 1
        repairedOrderIds.push(row.id)
      } catch (e: any) {
        result.failed += 1
        result.errors.push({ orderId: row.channelOrderId, error: e?.message ?? String(e) })
      }
    }

    // DA-RT.6 — refresh DailySalesAggregate over the span of repaired
    // orders' days so insights/replenishment/forecast pages reflect
    // the new numbers within seconds instead of waiting for the
    // nightly sales-aggregate cron. Single refreshSalesAggregates call
    // for [minDay..maxDay] across all repaired orders — Postgres's
    // INSERT...SELECT walks the window once regardless of how many
    // rows landed in it.
    if (repairedOrderIds.length > 0) {
      try {
        const repairedOrders = await prisma.order.findMany({
          where: { id: { in: repairedOrderIds } },
          select: { purchaseDate: true, createdAt: true },
        })
        const days = repairedOrders
          .map((o) => o.purchaseDate ?? o.createdAt)
          .filter((d): d is Date => d != null)
        if (days.length > 0) {
          const minMs = Math.min(...days.map((d) => d.getTime()))
          const maxMs = Math.max(...days.map((d) => d.getTime()))
          const { refreshSalesAggregates } = await import('./sales-aggregate.service.js')
          // refreshSalesAggregates internally aligns to Europe/Rome
          // day boundaries via DA-RT.2's startOfRomeDay, so passing
          // raw instants is safe.
          await refreshSalesAggregates({
            from: new Date(minMs),
            to: new Date(maxMs),
          })
          logger.info('amazon-orders: DA-RT.6 sales-aggregate refresh after backfill', {
            repaired: result.repaired,
            repairedFromItems: result.repairedFromItems,
            windowFromDay: new Date(minMs).toISOString().slice(0, 10),
            windowToDay: new Date(maxMs).toISOString().slice(0, 10),
          })
        }
      } catch (aggregateErr) {
        // Non-fatal — the backfill itself succeeded; aggregate refresh
        // failure just delays the propagation by one nightly tick.
        logger.warn('amazon-orders: DA-RT.6 sales-aggregate refresh failed', {
          error: aggregateErr instanceof Error ? aggregateErr.message : String(aggregateErr),
          repairedOrderCount: repairedOrderIds.length,
        })
      }
    }

    logger.info('amazon-orders: backfillZeroTotals complete', result)
    return result
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
    fetchOpts: { since?: Date; daysBack?: number; from?: Date; to?: Date; limit?: number; marketplaceId?: string; marketplaceIds?: string[] },
    cursor: { mode: 'since' | 'daysBack' | 'range'; value: string },
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
      // CX A0 — resolve the account once and read through it, so the account stamped on
      // each order is the one its data came from.
      const account = await amazonAccount()
      const orders = await amazonService.fetchOrders({ ...fetchOpts, accountId: account.id })
      summary.ordersFetched = orders.length

      for (const raw of orders) {
        try {
          await this.upsertOrder(raw, summary, account.id)
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

  private async upsertOrder(raw: AmazonOrderRaw, summary: SyncSummary, accountId: string): Promise<void> {
    const purchaseDate = new Date(raw.PurchaseDate)
    let totalPrice = raw.OrderTotal?.Amount ? Number(raw.OrderTotal.Amount) : 0
    let currencyCode = raw.OrderTotal?.CurrencyCode ?? 'EUR'
    const status = mapStatus(raw.OrderStatus)

    // SA.2 — eager getOrder for PENDING orders. SP-API ListOrders
    // withholds OrderTotal for PENDING; getOrder returns it for ALL
    // statuses. Without this, every new PENDING order lands in our DB
    // at €0 and the Global Snapshot sales total silently under-reports
    // by the value of those orders (typically minutes to hours until
    // they transition out of PENDING). Rate-limit-safe: getOrder is
    // 0.5 req/sec burst 30 — incremental sync is well inside this.
    if (status === 'PENDING' && totalPrice === 0) {
      try {
        const full = await amazonService.fetchOrderById(raw.AmazonOrderId, accountId)
        if (full?.OrderTotal?.Amount) {
          const fetchedAmount = Number(full.OrderTotal.Amount)
          if (Number.isFinite(fetchedAmount) && fetchedAmount > 0) {
            totalPrice = fetchedAmount
            currencyCode = full.OrderTotal.CurrencyCode ?? currencyCode
            // Keep the raw payload as the canonical one but augment
            // with the resolved total so the row reflects reality.
            ;(raw as any).OrderTotal = full.OrderTotal
          }
        }
      } catch (e: any) {
        logger.warn('amazon-orders: SA.2 eager getOrder failed (PENDING row stays at €0)', {
          orderId: raw.AmazonOrderId,
          error: e?.message ?? String(e),
        })
      }
    }

    const fulfillmentMethod = mapFulfillmentMethod(raw.FulfillmentChannel)
    const marketplace = mapMarketplaceCode(raw.MarketplaceId)
    const shippingAddress = (raw.ShippingAddress ?? {}) as object
    const { shouldPreserveTerminalStatus } = await import(
      './order-status-guards.js'
    )
    // Serialize the state decision with its write, including an order not yet inserted.
    // Locks end before vendor item reads and stock work: neither belongs under this row lock.
    const { order, created, newlyCancelled, newlyShipped, previousStatus } = await prisma.$transaction(async tx => {
      const [scope] = await tx.$queryRaw<Array<{ workspaceId: string | null }>>`SELECT NULLIF(current_setting('nexus.workspace_id', true), '') AS "workspaceId"`
      const workspaceId = scope?.workspaceId
      if (!workspaceId) throw new Error('Amazon orders require a business profile.')
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-amazon-order-state', workspaceId, raw.AmazonOrderId])}, 0))`
      await tx.$queryRaw`SELECT id FROM "Order" WHERE "workspaceId"=${workspaceId} AND channel='AMAZON' AND "channelOrderId"=${raw.AmazonOrderId} FOR NO KEY UPDATE`
      // O.45: track the previous status so we can detect the
      // transition to CANCELLED (vs re-ingesting an already-cancelled
      // order, which shouldn't re-trigger the cleanup cascade).
      const existing = await tx.order.findUnique({
        where: {
          channel_channelOrderId: workspaceKey({
            channel: 'AMAZON',
            channelOrderId: raw.AmazonOrderId,
          }),
        },
        select: { id: true, status: true, deliveredAt: true, deliveredAtSource: true, shippedAt: true },
      })

      // O.1: Lifecycle-timestamp gate accepts SHIPPED *or* PARTIALLY_SHIPPED
      // for shippedAt — Amazon's PartiallyShipped is still "ship clock
      // started" from the customer's perspective.
      const isShippedLike = status === 'SHIPPED' || status === 'PARTIALLY_SHIPPED'

      // O.7: terminal-status downgrade guard. If the local row is
      // already in a terminal state (operator cancelled before the
      // channel-cancel pushback completed) and SP-API still reports a
      // non-terminal status, preserve the local status + lifecycle
      // timestamps. Metadata still refreshes.
      const preserveStatus = shouldPreserveTerminalStatus(
        existing?.status,
        status,
      ) || (fulfillmentMethod === 'FBM' && existing?.status === 'SHIPPED' && FBM_PRE_SHIPMENT_STATUSES.has(status))
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
        // RV.2.2 — deliveredAt resolution:
        //   1. SP-API explicitly says Delivered → authoritative AMAZON_API source.
        //   2. Existing higher-authority value present → leave it alone.
        //   3. FBA + shippedAt + 3 business days in the past → heuristic guess.
        //   4. Otherwise leave undefined (no write).
        // The review pipeline keys entirely off deliveredAt; (3) is what
        // unblocks it for FBA orders since SP-API rarely returns Delivered.
        ...(() => {
          if (!preserveStatus && status === 'DELIVERED') {
            return {
              deliveredAt: new Date(raw.LastUpdateDate ?? raw.PurchaseDate),
              deliveredAtSource: 'AMAZON_API' as const,
            }
          }
          if (!canOverwriteWithHeuristic(existing?.deliveredAtSource)) {
            return {}
          }
          const shippedAt = !preserveStatus && isShippedLike
            ? new Date(raw.LastUpdateDate ?? raw.PurchaseDate)
            : existing?.shippedAt ?? null
          if (fulfillmentMethod === 'FBA' && shippedAt) {
            const projected = addBusinessDays(shippedAt, 3)
            if (projected.getTime() <= Date.now()) {
              return {
                deliveredAt: projected,
                deliveredAtSource: 'HEURISTIC_FBA_3D' as const,
              }
            }
          }
          return {}
        })(),
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
        !preserveStatus && status === 'SHIPPED'
        && (existing == null || existing.status !== 'SHIPPED')

      const order = await tx.order.upsert({
        where: {
          channel_channelOrderId: workspaceKey({
            channel: 'AMAZON',
            channelOrderId: raw.AmazonOrderId,
          }),
        },
        // The update arm never names an account; linkAmazonOrderAccount fills a NULL below.
        update: updateData,
        create: {
          ...updateData,
          channel: 'AMAZON',
          channelOrderId: raw.AmazonOrderId,
          channelConnectionId: accountId,
        },
      })
      return { order, created: existing == null, newlyCancelled, newlyShipped, previousStatus: existing?.status ?? null }
    }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 30_000 })
    // CX A0 — after the state transaction: the link is its own compare-and-set on the global client,
    // which inside the transaction would wait on the row lock that transaction holds.
    const link = await linkAmazonOrderAccount(order, accountId)
    if (link.outcome === 'conflict') {
      summary.accountConflicts = (summary.accountConflicts ?? 0) + 1
      logger.warn('amazon-orders: order is linked to a different Amazon account — link kept', {
        orderId: raw.AmazonOrderId,
        linkedConnectionId: link.linkedConnectionId,
        importingConnectionId: accountId,
      })
    }

    // O.6: emit lifecycle event so OrdersWorkspace auto-refreshes
    // without polling. Created vs. updated mirrors the upsert path —
    // `created` comes from the locked state read; otherwise the row was
    // touched (status / metadata refresh).
    void (async () => {
      try {
        const { publishOrderEvent } = await import('./order-events.service.js')
        // AR.4 — enrich payload so subscribers can optimistically
        // update tile totals without a server round-trip.
        const totalPriceCents = Math.round(totalPrice * 100)
        publishOrderEvent(
          created
            ? {
                type: 'order.created',
                orderId: order.id,
                channel: 'AMAZON',
                channelOrderId: raw.AmazonOrderId,
                marketplace,
                fulfillmentMethod,
                totalPriceCents,
                currencyCode,
                ts: Date.now(),
              }
            : {
                type: 'order.updated',
                orderId: order.id,
                channel: 'AMAZON',
                // The stored status: a preserved one is what subscribers must see, not the stale read.
                status: order.status,
                marketplace,
                ts: Date.now(),
              },
        )
      } catch {
        // bus failure must not break ingestion
      }
    })()

    // O.21a: ensure Customer FK + refresh aggregate cache. Fire-and-
    // forget — a customer-side failure must never abort the order
    // ingest. Idempotent on re-runs (upsert + recompute).
    void (async () => {
      try {
        const { linkAndRefreshCustomerForOrder } = await import(
          './customer-cache.service.js'
        )
        await linkAndRefreshCustomerForOrder(order.id)
      } catch (err) {
        logger.warn('amazon-orders: customer cache refresh failed', {
          orderId: order.id,
          error: err instanceof Error ? err.message : String(err),
        })
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
    const items = await amazonService.fetchOrderItems(raw.AmazonOrderId, accountId)
    const createdItems: Array<{ productId: string | null; quantity: number; sku: string }> = []
    for (const item of items) {
      try {
        const created = await this.upsertOrderItem(order.id, item, { accountId, marketplace })
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
    // Never for a cancelled order, nor a re-read of one already cancelled, refunded or returned. A
    // re-read of a shipped order still runs: reserveOpenOrder holds only what the line still owes
    // (nothing once taken — before, every re-read held the units again and the reconcile took them).
    if (fulfillmentMethod === 'FBM' && order.status !== 'CANCELLED' && !FBM_NO_HOLD_ON_REREAD.has(previousStatus ?? '')) {
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
   * S.2 — FBM reserve-then-consume lifecycle. Tries to reserve on every
   * read that reaches it (idempotent: an open reservation for this
   * orderId+productId is reused, units already consumed are never held
   * again). If the order has just transitioned to SHIPPED,
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

    // R10 — one hold per product, for the units of all its lines.
    for (const { lines, ...it } of unitsPerProduct(args.items)) {
      const sku = lines.map((line) => line.sku).join(',')
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
        if (err instanceof InsufficientStockError) {
          args.summary.fbmInsufficientStock++
          logger.warn('amazon-orders: FBM oversell — order accepted but insufficient stock to reserve', {
            orderId: args.orderId,
            productId: it.productId,
            sku,
            quantity: it.quantity,
          })
        } else {
          logger.warn('amazon-orders: FBM reserve failed', {
            orderId: args.orderId,
            productId: it.productId,
            sku,
            error: msg,
          })
        }
      }
    }

    // IS.2 → RT.2 — after reserving, run the CANONICAL cascade so eBay/Shopify
    // can't oversell the reserved units. Replaces a hand-rolled row loop that
    // missed shared-eBay fan-out, FBA/Follow filtering, coalescing, and the
    // ChannelListing.quantity write (dispatch re-reads it), and carried a 30s
    // hold. reason ORDER_PLACED ⇒ 0-hold, priority-1 instant dispatch (~2s).
    // Fire-and-forget; a cascade failure must not roll back the order ingestion.
    void (async () => {
      try {
        for (const it of args.items) {
          if (!it.productId) continue
          const res = await recascadeProduct(it.productId, {
            reason: 'ORDER_PLACED',
            referenceType: 'ORDER',
            referenceId: args.orderId,
            actor: 'amazon-orders:IS.2',
          })
          if (res.ok === false) {
            logger.warn('amazon-orders: IS.2 recascade refused (NO_LEDGER) — backfill needed', {
              orderId: args.orderId,
              productId: it.productId,
              totalStock: res.totalStock,
            })
          }
        }
      } catch (err) {
        logger.warn('amazon-orders: IS.2 cascade failed', {
          orderId: args.orderId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()

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
    source: { accountId?: string | null; marketplace?: string | null } = {},
  ): Promise<{ productId: string | null; quantity: number; sku: string }> {
    // DA-RT.15 — SP-API's ItemPrice.Amount is the LINE TOTAL across
    // QuantityOrdered units, NOT per-unit. Downstream (sales-aggregate,
    // compute.ts Tier 2) does `SUM(OrderItem.price * quantity)` and
    // assumes per-unit pricing. Storing the line total directly causes
    // double-counting for orders with quantity > 1.
    //
    // Divide by quantity to get the per-unit price before storing.
    // For quantity = 1 (the common case) the value is unchanged.
    const lineTotal = item.ItemPrice?.Amount ? Number(item.ItemPrice.Amount) : 0
    const qty = item.QuantityOrdered || 1
    const unitPrice = qty > 0 ? lineTotal / qty : 0
    const sku = item.SellerSKU ?? item.ASIN ?? ''
    const externalLineItemId = item.OrderItemId

    // S6 — the seller SKU through the one inbound match (this Amazon account and market: a listing's own SKU,
    // also one renamed in Nexus that Amazon still holds; then the master SKU), then the ASIN as before.
    const asin = item.ASIN
    const match = await matchInboundSku(prisma, {
      channel: 'AMAZON',
      channelConnectionId: source.accountId,
      marketplace: source.marketplace,
      sku: item.SellerSKU,
      fallbacks: asin ? [{
        name: 'asin',
        label: `ASIN ${asin}`,
        find: async () => {
          const prod = await prisma.product.findFirst({ where: { amazonAsin: asin }, select: { id: true } })
          return prod ? [prod.id] : []
        },
      }] : [],
    })
    const productId = match.productId

    const upserted = await prisma.orderItem.upsert({
      where: {
        orderId_externalLineItemId: workspaceKey({ orderId, externalLineItemId }),
      },
      create: {
        orderId,
        externalLineItemId,
        sku,
        quantity: item.QuantityOrdered,
        price: unitPrice,
        amazonMetadata: item as object,
        ...(productId ? { productId } : {}),
      },
      update: {
        sku,
        quantity: item.QuantityOrdered,
        price: unitPrice,
        amazonMetadata: item as object,
      },
    })

    // A line keeps the product it was first linked to: the ordered quantity per product is what the
    // stock guards count, so re-pointing a line after a SKU change would owe (and take) it twice. An
    // unlinked line is filled only while still null; the stored winner is what stock uses.
    let linkedProductId = upserted.productId
    if (linkedProductId === null && productId) {
      await prisma.orderItem.updateMany({ where: { id: upserted.id, productId: null }, data: { productId } })
      linkedProductId = (await prisma.orderItem.findUnique({ where: { id: upserted.id }, select: { productId: true } }))?.productId ?? null
    }
    // S6 — a SKU that names more than one product stays unlinked (never a guess): the line keeps why.
    if (linkedProductId === null && match.problem) {
      await prisma.orderItem.updateMany({ where: { id: upserted.id, productId: null }, data: { amazonMetadata: { ...item, nexusUnlinkedReason: match.problem.sentence } as object } })
      logger.warn('amazon-orders: line not linked to a product', { orderItemId: upserted.id, sku, reason: match.problem.sentence })
    }

    // F.1 — keep DailySalesAggregate current for the forecasting layer.
    // Best-effort: a refresh failure must never block order ingestion.
    try {
      await recordOrderItem(upserted.id)
    } catch (err) {
      logger.warn('sales-aggregate refresh failed for OrderItem', {
        orderItemId: upserted.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    return { productId: linkedProductId, quantity: item.QuantityOrdered, sku }
  }
}

export const amazonOrdersService = new AmazonOrdersService()
