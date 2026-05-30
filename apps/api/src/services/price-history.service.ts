/**
 * PH.1 — Unified price-change timeline writer.
 *
 * `recordPriceChange` appends one row to PriceChangeEvent. Every code
 * path that mutates a live price calls it through here so the /pricing
 * drawer has a single, coordinate-keyed feed to answer "why did this
 * price change, and what was it before?".
 *
 * Emit sites (PH.1):
 *   - POST /pricing/bulk-override   → BULK_OVERRIDE (atomic, in the txn)
 *   - repricing-evaluator live apply → REPRICER (best-effort)
 *   - promotion-scheduler ENTER/EXIT → PROMO_START / PROMO_END (best-effort)
 *
 * Best-effort by default: a history-write failure must never roll back
 * or throw out of the price write that triggered it. The bulk-override
 * path is the one exception — it includes the create in its own
 * transaction array so the audit row and the override land together.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

export type PriceChangeSourceLiteral =
  | 'MANUAL_OVERRIDE'
  | 'BULK_OVERRIDE'
  | 'REPRICER'
  | 'PROMO_START'
  | 'PROMO_END'
  | 'CHANNEL_RULE'
  | 'MASTER_INHERIT'
  | 'FX'

export interface PriceChangeInput {
  productId: string
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod?: string | null
  /** Prior price; null when unknown. */
  oldPrice?: number | string | null
  /** New price; null on CLEAR (reverts to inherited). */
  newPrice?: number | string | null
  currency?: string
  source: PriceChangeSourceLiteral
  reason: string
  ruleId?: string | null
  actor?: string | null
}

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Build the `data` object for a PriceChangeEvent create. Exposed so the
 * bulk-override path can splice it into its own `$transaction([...])`
 * array (atomic with the override write) rather than firing a separate
 * best-effort insert.
 */
export function priceChangeData(
  input: PriceChangeInput,
): Prisma.PriceChangeEventCreateInput {
  return {
    product: { connect: { id: input.productId } },
    sku: input.sku,
    channel: input.channel,
    marketplace: input.marketplace,
    fulfillmentMethod: input.fulfillmentMethod ?? null,
    oldPrice: input.oldPrice == null ? null : String(input.oldPrice),
    newPrice: input.newPrice == null ? null : String(input.newPrice),
    currency: input.currency ?? 'EUR',
    source: input.source as Prisma.PriceChangeEventCreateInput['source'],
    reason: input.reason,
    ruleId: input.ruleId ?? null,
    actor: input.actor ?? null,
  }
}

/**
 * Append a price-change row. Best-effort: swallows and logs any error so
 * the caller's price write is never disrupted. For atomic capture, build
 * the row with `priceChangeData` and include it in your own transaction.
 */
export async function recordPriceChange(
  db: DbClient,
  input: PriceChangeInput,
): Promise<void> {
  try {
    await db.priceChangeEvent.create({ data: priceChangeData(input) })
  } catch (err) {
    logger.warn('PH.1 recordPriceChange failed (non-fatal)', {
      sku: input.sku,
      channel: input.channel,
      marketplace: input.marketplace,
      source: input.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
