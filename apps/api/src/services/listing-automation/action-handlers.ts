/**
 * OL.D.1 — Listings-domain action handlers for the AutomationRule engine.
 *
 * Mutates the exported ACTION_HANDLERS map at module load (same pattern
 * as advertising/automation-action-handlers.ts). Importing this file is
 * enough to register every listings action; no engine code is touched.
 * The side-effect import lives at the top of the listings rule routes +
 * the evaluator job, so registration fires before any rule evaluates.
 *
 * Actions:
 *   sync_price_to_marketplaces      — enqueue PRICE_UPDATE to a product's
 *                                     eligible listings (currency-guarded)
 *   sync_inventory_to_marketplaces  — enqueue QUANTITY_UPDATE
 *
 * Both go through OutboundSyncQueue with a 5-minute holdUntil grace
 * window (so the operator can cancel before it pushes) and honour the
 * engine's dryRun flag — a dry run reports exactly what it WOULD enqueue
 * without writing a single row. `notify` / `log_only` (engine built-ins)
 * cover the health-nudge rules.
 */

import { ACTION_HANDLERS, getFieldPath, type ActionResult } from '../automation-rule.service.js'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { currencyForMarket } from './triggers.js'

const GRACE_MS = 5 * 60 * 1000 // 5-minute undo window before the worker pushes

interface EligibleListing {
  id: string
  channel: string
  marketplace: string
  region: string | null
  externalListingId: string | null
  productId: string | null
}

// Resolve the product id from context (evaluator-built) or action config.
function productIdFrom(action: Record<string, unknown>, context: unknown): string | null {
  return (
    (getFieldPath(context, 'product.id') as string | undefined) ??
    (action.productId as string | undefined) ??
    null
  )
}

// Load active+published listings for a product, optionally narrowed by the
// rule's channel / marketplace filters.
async function eligibleListings(
  productId: string,
  action: Record<string, unknown>,
): Promise<EligibleListing[]> {
  const channels = Array.isArray(action.channels) ? (action.channels as string[]).map((c) => c.toUpperCase()) : null
  const marketplaces = Array.isArray(action.marketplaces) ? (action.marketplaces as string[]).map((m) => m.toUpperCase()) : null
  const rows = await prisma.channelListing.findMany({
    where: {
      productId,
      isPublished: true,
      offerActive: true,
      ...(channels ? { channel: { in: channels } } : {}),
      ...(marketplaces ? { marketplace: { in: marketplaces } } : {}),
    },
    select: { id: true, channel: true, marketplace: true, region: true, externalListingId: true, productId: true },
  })
  return rows
}

/**
 * sync_price_to_marketplaces — push a reference price to a product's
 * listings. referencePrice: 'master' (default, = Product.basePrice) |
 * 'min' | 'max' (from the diverged-price context). Currency-guarded:
 * by default only same-currency-as-reference (EUR) coordinates receive
 * the push; non-EUR markets are skipped (copying €→£ is wrong).
 */
ACTION_HANDLERS.sync_price_to_marketplaces = async (action, context, meta): Promise<ActionResult> => {
  const productId = productIdFrom(action as Record<string, unknown>, context)
  if (!productId) return { type: action.type, ok: false, error: 'No product.id in context' }

  const ref = (action.referencePrice as string | undefined) ?? 'master'
  let price: number | null = null
  if (ref === 'master') price = getFieldPath(context, 'product.basePrice') as number | null
  else if (ref === 'min') price = getFieldPath(context, 'price.min') as number | null
  else if (ref === 'max') price = getFieldPath(context, 'price.max') as number | null
  if (price == null || !(price > 0)) {
    return { type: action.type, ok: false, error: `No usable reference price (${ref})` }
  }

  const onlySameCurrency = action.onlySameCurrency !== false // default true
  const refCurrency = 'EUR' // master price is EUR
  const listings = await eligibleListings(productId, action as Record<string, unknown>)
  const targets = listings.filter((l) => !onlySameCurrency || currencyForMarket(l.marketplace) === refCurrency)
  const skippedCurrency = listings.length - targets.length

  if (targets.length === 0) {
    return { type: action.type, ok: true, output: { enqueued: 0, skippedCurrency, note: 'no eligible coordinates' } }
  }

  const coordinates = targets.map((l) => `${l.channel}:${l.marketplace}`)
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldEnqueue: targets.length, price, skippedCurrency, coordinates } }
  }

  await prisma.outboundSyncQueue.createMany({
    data: targets.map((l) => ({
      productId: l.productId ?? productId,
      channelListingId: l.id,
      targetChannel: l.channel as never,
      targetRegion: l.region ?? l.marketplace ?? undefined,
      syncType: 'PRICE_UPDATE' as const,
      syncStatus: 'PENDING' as const,
      payload: { price, source: `AUTOMATION:${meta.ruleId}` } as never,
      externalListingId: l.externalListingId ?? undefined,
      retryCount: 0,
      maxRetries: 3,
      holdUntil: new Date(Date.now() + GRACE_MS),
    })) as never,
    skipDuplicates: true,
  })
  logger.info('[listing-automation] sync_price enqueued', { ruleId: meta.ruleId, productId, count: targets.length, price })
  return { type: action.type, ok: true, output: { enqueued: targets.length, price, skippedCurrency, coordinates } }
}

/**
 * sync_inventory_to_marketplaces — push a quantity to a product's
 * listings. quantity comes from action.quantity or the inventory_low
 * context (inventory.available). Enqueues QUANTITY_UPDATE.
 */
ACTION_HANDLERS.sync_inventory_to_marketplaces = async (action, context, meta): Promise<ActionResult> => {
  const productId = productIdFrom(action as Record<string, unknown>, context)
  if (!productId) return { type: action.type, ok: false, error: 'No product.id in context' }

  const quantity =
    (action.quantity as number | undefined) ??
    (getFieldPath(context, 'inventory.available') as number | undefined) ??
    null
  if (quantity == null || quantity < 0) {
    return { type: action.type, ok: false, error: 'No usable quantity (set action.quantity or inventory.available)' }
  }

  const listings = await eligibleListings(productId, action as Record<string, unknown>)
  if (listings.length === 0) {
    return { type: action.type, ok: true, output: { enqueued: 0, note: 'no eligible coordinates' } }
  }
  const coordinates = listings.map((l) => `${l.channel}:${l.marketplace}`)
  if (meta.dryRun) {
    return { type: action.type, ok: true, output: { dryRun: true, wouldEnqueue: listings.length, quantity, coordinates } }
  }

  await prisma.outboundSyncQueue.createMany({
    data: listings.map((l) => ({
      productId: l.productId ?? productId,
      channelListingId: l.id,
      targetChannel: l.channel as never,
      targetRegion: l.region ?? l.marketplace ?? undefined,
      syncType: 'QUANTITY_UPDATE' as const,
      syncStatus: 'PENDING' as const,
      payload: { quantity, source: `AUTOMATION:${meta.ruleId}` } as never,
      externalListingId: l.externalListingId ?? undefined,
      retryCount: 0,
      maxRetries: 3,
      holdUntil: new Date(Date.now() + GRACE_MS),
    })) as never,
    skipDuplicates: true,
  })
  logger.info('[listing-automation] sync_inventory enqueued', { ruleId: meta.ruleId, productId, count: listings.length, quantity })
  return { type: action.type, ok: true, output: { enqueued: listings.length, quantity, coordinates } }
}

export const LISTING_HANDLERS_REGISTERED = true
