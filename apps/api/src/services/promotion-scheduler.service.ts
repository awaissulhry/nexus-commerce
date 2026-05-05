/**
 * G.5.2 — Promotion scheduler.
 *
 * Walks RetailEventPriceAction rows whose event window overlaps with
 * "now ± 12h" and materializes ChannelListing.salePrice for matching
 * listings. Engine then reads salePrice as source = SCHEDULED_SALE.
 *
 * Two phases per tick:
 *   1. ENTER — events that started in the last 12h but salePrice not set
 *   2. EXIT  — events that ended >0 (any past) and salePrice still set;
 *              clear salePrice and refresh snapshots so the engine reverts
 *
 * Idempotent. Safe to re-run; ENTER skips listings already at the
 * promo price, EXIT skips listings that aren't currently on a sale.
 */

import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { refreshSnapshotsForSkus } from './pricing-snapshot.service.js'
import { resolvePrice } from './pricing-engine.service.js'

interface PromotionTickResult {
  enteredEvents: number
  exitedEvents: number
  listingsUpdated: number
  snapshotsRefreshed: number
  durationMs: number
}

export async function runPromotionScheduler(
  prisma: PrismaClient,
): Promise<PromotionTickResult> {
  const startedAt = Date.now()
  const now = new Date()
  const windowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000)
  const windowEnd = new Date(now.getTime() + 12 * 60 * 60 * 1000)

  // ── ENTER: events whose start window has begun ──────────────────
  const enteringActions = await prisma.retailEventPriceAction.findMany({
    where: {
      isActive: true,
      event: {
        isActive: true,
        startDate: { gte: windowStart, lte: windowEnd },
      },
    },
    include: { event: true },
  })

  let listingsUpdated = 0
  const skusTouched = new Set<string>()

  for (const action of enteringActions) {
    // Find every ChannelListing matching the action's scope. Listings
    // without an explicit price still qualify — the engine will resolve
    // their base via inheritance / rules, and we apply the promotion on
    // top of whatever that returns.
    const listings = await prisma.channelListing.findMany({
      where: {
        ...(action.channel ? { channel: action.channel } : {}),
        ...(action.marketplace ? { marketplace: action.marketplace } : {}),
        ...(action.productType
          ? { product: { productType: action.productType } }
          : {}),
      },
      select: {
        id: true,
        productId: true,
        channel: true,
        marketplace: true,
        price: true,
        priceOverride: true,
        salePrice: true,
        product: { select: { sku: true, variations: { select: { sku: true } } } },
      },
    })

    for (const l of listings) {
      // Promo price computed against the engine's resolved base. For
      // FIXED_PRICE we don't need a base; for PERCENT_OFF we resolve
      // the parent product's SKU on this marketplace and apply the
      // discount. Variants on the listing (when present) inherit the
      // parent listing's promotion — Amazon's catalog clusters them.
      const baseSku = l.product?.variations?.[0]?.sku ?? l.product?.sku
      let promoPrice: number
      if (action.action === 'FIXED_PRICE') {
        promoPrice = Number(action.value)
      } else if (action.action === 'PERCENT_OFF' && baseSku) {
        const resolution = await resolvePrice(prisma, {
          sku: baseSku,
          channel: l.channel,
          marketplace: l.marketplace,
        })
        if (resolution.price <= 0) continue
        promoPrice = resolution.price * (1 - Number(action.value) / 100)
      } else {
        continue
      }
      const promoStr = promoPrice.toFixed(2)
      // Skip if already at the promo price.
      if (
        l.salePrice != null &&
        Math.abs(Number(l.salePrice) - promoPrice) < 0.005
      ) {
        continue
      }

      await prisma.channelListing.update({
        where: { id: l.id },
        data: {
          salePrice: promoStr,
          lastOverrideAt: new Date(),
          lastOverrideBy: `promotion:${action.eventId}`,
        },
      })
      listingsUpdated++
      // Collect SKUs for a single batched snapshot refresh later.
      if (l.product?.sku) skusTouched.add(l.product.sku)
      for (const v of l.product?.variations ?? []) skusTouched.add(v.sku)
    }
  }

  // ── EXIT: events whose end window has passed ────────────────────
  const exitingActions = await prisma.retailEventPriceAction.findMany({
    where: {
      isActive: true,
      event: { endDate: { lt: now } },
    },
    include: { event: true },
  })

  for (const action of exitingActions) {
    const listings = await prisma.channelListing.findMany({
      where: {
        ...(action.channel ? { channel: action.channel } : {}),
        ...(action.marketplace ? { marketplace: action.marketplace } : {}),
        ...(action.productType
          ? { product: { productType: action.productType } }
          : {}),
        salePrice: { not: null },
        // Only clear if THIS action set the salePrice (matches the
        // lastOverrideBy stamp we wrote on enter).
        lastOverrideBy: `promotion:${action.eventId}`,
      },
      select: {
        id: true,
        product: { select: { sku: true, variations: { select: { sku: true } } } },
      },
    })

    for (const l of listings) {
      await prisma.channelListing.update({
        where: { id: l.id },
        data: {
          salePrice: null,
          lastOverrideAt: new Date(),
          lastOverrideBy: `promotion-clear:${action.eventId}`,
        },
      })
      listingsUpdated++
      if (l.product?.sku) skusTouched.add(l.product.sku)
      for (const v of l.product?.variations ?? []) skusTouched.add(v.sku)
    }
  }

  // ── Refresh snapshots for affected SKUs ─────────────────────────
  let snapshotsRefreshed = 0
  if (skusTouched.size > 0) {
    const result = await refreshSnapshotsForSkus(prisma, [...skusTouched])
    snapshotsRefreshed = result.rowsRefreshed
  }

  const durationMs = Date.now() - startedAt
  logger.info('G.5.2 promotion scheduler tick complete', {
    enteredEvents: enteringActions.length,
    exitedEvents: exitingActions.length,
    listingsUpdated,
    snapshotsRefreshed,
    durationMs,
  })

  return {
    enteredEvents: enteringActions.length,
    exitedEvents: exitingActions.length,
    listingsUpdated,
    snapshotsRefreshed,
    durationMs,
  }
}
