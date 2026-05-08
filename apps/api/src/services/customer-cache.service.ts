/**
 * O.21a — Customer aggregate-cache + auto-link service.
 *
 * Two responsibilities:
 *
 *   1. ensureCustomerForOrder(orderId) — every new order ingested
 *      after the O.20 migration needs a Customer row + FK link, but
 *      the ingestion services (amazon-orders, ebay-orders, Shopify
 *      webhooks) don't know about Customer. This helper:
 *        - resolves the Order.customerEmail (denormalized cache)
 *        - finds-or-creates a Customer with email = lower(email)
 *        - links Order.customerId
 *      Idempotent: safe to call multiple times for the same order.
 *      No-op when customerEmail is empty (legacy/test rows).
 *
 *   2. refreshCustomerCache(customerId) — recompute the aggregate
 *      cache (totalOrders, totalSpentCents, firstOrderAt,
 *      lastOrderAt, channelOrderCounts) by re-aggregating Order
 *      rows. Excludes CANCELLED + REFUNDED orders from LTV totals
 *      (cancelled orders never resulted in revenue; refunded
 *      orders were reversed). Cheap: scoped by customerId index.
 *
 * Both calls are fire-and-forget at the ingestion sites — wrapped
 * in try/catch so a Customer-side failure never aborts the order
 * write itself. The audit-trail-style refresh stays eventually
 * consistent: a missed refresh is recoverable via /api/customers/
 * :id/refresh-cache or the next order touching the same customer.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const LTV_EXCLUDE_STATUSES = ['CANCELLED', 'REFUNDED'] as const

function customerIdFromEmail(email: string): string {
  // Match the deterministic format the O.20 migration backfill used:
  //   'cust_' + first 24 chars of md5(lower(email))
  // Re-hashing here keeps new orders consistent with backfilled rows.
  const crypto = require('crypto') as typeof import('crypto')
  const hash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex')
  return `cust_${hash.slice(0, 24)}`
}

/**
 * Find-or-create the Customer for an order's customerEmail, then
 * link the FK back onto the Order. Returns the resolved Customer
 * id (or null when the order has no email to anchor on).
 *
 * FU.3: also snapshots the Customer's Italian fiscal data (codice
 * fiscale, partita IVA, fiscalKind, PEC, codice destinatario) onto
 * the Order — but only when Order.codiceFiscale et al are still
 * NULL (operator hasn't manually adjusted yet). This way the
 * customer's profile fiscal data lazily flows to incoming orders,
 * and historical orders stay frozen at sale-time values.
 */
export async function ensureCustomerForOrder(orderId: string): Promise<string | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      customerEmail: true,
      customerName: true,
      customerId: true,
      codiceFiscale: true,
      partitaIva: true,
      fiscalKind: true,
      pecEmail: true,
      codiceDestinatario: true,
    },
  })
  if (!order) return null
  if (!order.customerEmail || order.customerEmail.trim() === '') return null

  const email = order.customerEmail.toLowerCase()
  const id = order.customerId ?? customerIdFromEmail(email)

  // Find-or-create via upsert. createOnly fields stay sticky on
  // re-link of an existing row (e.g. operator-edited name wins
  // over the channel-supplied value).
  const customer = await prisma.customer.upsert({
    where: { email },
    create: {
      id,
      email,
      name: order.customerName || null,
    },
    update: {},
    select: {
      id: true,
      codiceFiscale: true,
      partitaIva: true,
      fiscalKind: true,
      pecEmail: true,
      codiceDestinatario: true,
    },
  })

  // FU.3 — snapshot fiscal fields onto Order when not yet set.
  // We only snapshot a field if it's currently NULL on the Order
  // AND non-NULL on the Customer; that way historical orders
  // stay frozen and operators can override per-order if needed.
  const fiscalSnapshot: Record<string, string | null> = {}
  if (!order.codiceFiscale && customer.codiceFiscale) {
    fiscalSnapshot.codiceFiscale = customer.codiceFiscale
  }
  if (!order.partitaIva && customer.partitaIva) {
    fiscalSnapshot.partitaIva = customer.partitaIva
  }
  if (!order.fiscalKind && customer.fiscalKind) {
    fiscalSnapshot.fiscalKind = customer.fiscalKind
  }
  if (!order.pecEmail && customer.pecEmail) {
    fiscalSnapshot.pecEmail = customer.pecEmail
  }
  if (!order.codiceDestinatario && customer.codiceDestinatario) {
    fiscalSnapshot.codiceDestinatario = customer.codiceDestinatario
  }

  const orderUpdate: Record<string, any> = {}
  if (!order.customerId) orderUpdate.customerId = customer.id
  Object.assign(orderUpdate, fiscalSnapshot)

  if (Object.keys(orderUpdate).length > 0) {
    await prisma.order.update({
      where: { id: orderId },
      data: orderUpdate,
    })
  }

  return customer.id
}

/**
 * Recompute Customer.{totalOrders, totalSpentCents, firstOrderAt,
 * lastOrderAt, channelOrderCounts} from the live Order set.
 *
 * Order timestamps: prefer Order.purchaseDate (channel-supplied),
 * fall back to Order.createdAt (row-insert time). Mirrors the
 * pattern in the O.20 backfill so re-running this on a backfilled
 * customer reproduces the same numbers (modulo new orders).
 */
export async function refreshCustomerCache(customerId: string): Promise<void> {
  try {
    const orders = await prisma.order.findMany({
      where: { customerId },
      select: {
        channel: true,
        status: true,
        totalPrice: true,
        purchaseDate: true,
        createdAt: true,
      },
    })

    let totalOrders = 0
    let totalSpentCents = BigInt(0)
    let firstOrderAt: Date | null = null
    let lastOrderAt: Date | null = null
    const channelOrderCounts: Record<string, number> = {}

    for (const o of orders) {
      const at = o.purchaseDate ?? o.createdAt
      if (!firstOrderAt || at < firstOrderAt) firstOrderAt = at
      if (!lastOrderAt || at > lastOrderAt) lastOrderAt = at

      // totalOrders + LTV exclude cancelled/refunded — those never
      // produced revenue or stayed in the customer's history. They
      // still count toward firstOrderAt / lastOrderAt because the
      // operator wants to see "this customer last interacted X days
      // ago" even if the interaction was a cancel.
      if (LTV_EXCLUDE_STATUSES.includes(o.status as any)) continue
      totalOrders++
      totalSpentCents += BigInt(Math.round(Number(o.totalPrice) * 100))
      channelOrderCounts[o.channel] = (channelOrderCounts[o.channel] ?? 0) + 1
    }

    await prisma.customer.update({
      where: { id: customerId },
      data: {
        totalOrders,
        totalSpentCents,
        firstOrderAt,
        lastOrderAt,
        channelOrderCounts:
          Object.keys(channelOrderCounts).length > 0
            ? (channelOrderCounts as object)
            : null,
      },
    })
  } catch (err) {
    logger.warn('refreshCustomerCache failed', {
      customerId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Convenience wrapper: ensure the FK exists, refresh the cache,
 * AND compute the risk score (O.22) in one call. Used by ingestion
 * paths that just upserted an Order and want all customer-side
 * side effects in one call.
 *
 * Risk scoring runs after FK + cache refresh because applyOrderRisk
 * Score reads Customer aggregates (totalOrders, etc.) for its
 * "first order" / "anomalous LTV" signals.
 */
export async function linkAndRefreshCustomerForOrder(orderId: string): Promise<void> {
  const customerId = await ensureCustomerForOrder(orderId)
  if (customerId) await refreshCustomerCache(customerId)
  // O.22: per-order risk score + customer rollup. Imported lazily
  // because some consumers of this service may not have the risk
  // engine wired yet (e.g. tests that stub Customer only).
  try {
    const { applyOrderRiskScore } = await import('./order-risk.service.js')
    await applyOrderRiskScore(orderId)
  } catch (err) {
    logger.warn('linkAndRefreshCustomerForOrder: risk scoring failed', {
      orderId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
