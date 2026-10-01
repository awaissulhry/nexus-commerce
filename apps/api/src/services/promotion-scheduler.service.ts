/**
 * G.5.2 — Promotion scheduler.
 *
 * Walks RetailEventPriceAction rows whose event window overlaps with
 * "now ± 12h" and materializes ChannelListing.salePrice for matching
 * listings. Engine then reads salePrice as source = SCHEDULED_SALE.
 *
 * 2026-10-01 — the sale goes through the ONE channel price door's sale handling (`writeChannelPrices`, named reason
 * `promotion`): the event's window as the sale's dates (both, as Amazon schedules a sale), the audit row, and ONE
 * PRICE_UPDATE row that carries it (and, on Amazon, `saleRemoved` when it ends). eBay's and Etsy's listings have no
 * sale (the Studio matrix's own sentences) and are skipped by name. Before, the scheduler wrote `salePrice` alone: no
 * dates, no audit, nothing queued, so no promotion ever reached a channel. A promotion's sale is recognised by the
 * door's audit row (`changedBy promotion:<event>`, the latest sale change), so ending it never clears a sale an
 * operator set afterwards.
 *
 * Two phases per tick:
 *   1. ENTER — events that started in the last 12h: each listing in scope is put on sale ONCE per event
 *   2. EXIT  — events whose (inclusive) end day is over, and this promotion's sale still on the listing;
 *              clear salePrice and refresh snapshots so the engine reverts
 *
 * Idempotent. Safe to re-run; ENTER skips listings this promotion already
 * put on sale, EXIT skips listings that aren't on this promotion's sale.
 */

import type { PrismaClient } from '@prisma/client'
import { roundCents } from '@nexus/shared/listing-price'
import { logger } from '../utils/logger.js'
import { writeChannelPrices } from './pim/channel-price-write.service.js'
import { channelShape } from './pim/matrix-cells.js'
import { refreshSnapshotsForSkus } from './pricing-snapshot.service.js'
import { isPriceRefusal, resolvePrice } from './pricing-engine.service.js'
import { recordPriceChange } from './price-history.service.js'

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
        lastOverrideBy: true,
        product: { select: { sku: true, variations: { select: { sku: true } } } },
      },
    })

    for (const l of listings) {
      // A promotion puts a listing on sale ONCE. Taken again, a PERCENT_OFF would discount its own sale (the engine
      // answers the active sale as the price: 10.10 → 8.59 → 7.30 … on every tick, each one queued), and a sale an
      // operator changed since would be overwritten.
      if (await promotionEntered(prisma, action.eventId, l)) continue
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
        let resolution: Awaited<ReturnType<typeof resolvePrice>>
        try {
          resolution = await resolvePrice(prisma, {
            sku: baseSku,
            channel: l.channel,
            marketplace: l.marketplace,
          })
        } catch (err) {
          if (!isPriceRefusal(err)) throw err
          // CX (review 2026-09-26) — no FX rate or no market currency: this listing gets no promotion price.
          logger.warn('promotion skipped: this market cannot be priced (configuration)', { listingId: l.id, marketplace: l.marketplace, error: (err as Error).message })
          continue
        }
        // Another sale already on the listing is not this promotion's base: the listing's own price is.
        const base = resolution.source === 'SCHEDULED_SALE' ? Number(l.priceOverride ?? l.price ?? 0) : resolution.price
        if (!(base > 0)) continue
        promoPrice = base * (1 - Number(action.value) / 100)
      } else {
        continue
      }
      promoPrice = roundCents(promoPrice)
      const promoStr = promoPrice.toFixed(2)
      // eBay's and Etsy's listings have no sale (the Studio matrix's own sentences): skipped by name.
      const absent = channelShape(l.channel).absent.find((a) => a.cell === 'salePrice')
      if (absent) {
        logger.info('promotion skipped: this channel has no listing sale', { listingId: l.id, channel: l.channel, eventId: action.eventId, reason: absent.reason })
        continue
      }
      // The sale through the door, with the event's window as its dates; the same sale again is the door's no-op.
      const written = await writeChannelPrices({
        targets: [{ listingId: l.id, sale: { value: promoPrice, start: isoDay(action.event.startDate), end: isoDay(action.event.endDate) }, unguardedReason: 'promotion' }],
        actor: `promotion:${action.eventId}`, source: 'PROMO_START', reason: `Promotion "${action.event.name}"`,
      })
      const outcome = written.results[0]
      if (!outcome || outcome.outcome !== 'applied') {
        if (outcome?.outcome === 'refused') logger.warn('promotion not applied to a listing', { listingId: l.id, eventId: action.eventId, reason: outcome.reason })
        continue
      }
      // PH.1 — record the promo start on the unified timeline. oldPrice is
      // the standing price the sale displaces; newPrice is the promo price.
      if (l.product?.sku) {
        await recordPriceChange(prisma, {
          productId: l.productId,
          sku: l.product.sku,
          channel: l.channel,
          marketplace: l.marketplace,
          oldPrice:
            l.priceOverride != null
              ? Number(l.priceOverride)
              : l.price != null
                ? Number(l.price)
                : null,
          newPrice: promoStr,
          reason: `promo "${action.event.name}" started`,
          source: 'PROMO_START',
          actor: `promo-scheduler:${action.eventId}`,
        })
      }
      listingsUpdated++
      // Collect SKUs for a single batched snapshot refresh later.
      if (l.product?.sku) skusTouched.add(l.product.sku)
      for (const v of l.product?.variations ?? []) skusTouched.add(v.sku)
    }
  }

  // ── EXIT: events whose end window has passed ────────────────────
  // The end date is INCLUSIVE (a one-day event has startDate == endDate; the sale's window ends on that day, as the
  // door sends it): the event is over once its end day is, not at that day's first second.
  const exitingActions = await prisma.retailEventPriceAction.findMany({
    where: {
      isActive: true,
      event: { endDate: { lte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    },
    include: { event: true },
  })

  for (const action of exitingActions) {
    const candidates = await prisma.channelListing.findMany({
      where: {
        ...(action.channel ? { channel: action.channel } : {}),
        ...(action.marketplace ? { marketplace: action.marketplace } : {}),
        ...(action.productType
          ? { product: { productType: action.productType } }
          : {}),
        salePrice: { not: null },
      },
      select: {
        id: true,
        productId: true,
        channel: true,
        marketplace: true,
        salePrice: true,
        price: true,
        priceOverride: true,
        lastOverrideBy: true,
        product: { select: { sku: true, variations: { select: { sku: true } } } },
      },
    })

    // Only a sale THIS promotion set and nobody changed since is ended here.
    const listings = await promotionSales(prisma, action.eventId, candidates)
    for (const l of listings) {
      const ended = await endPromotionSale(l.id, action.eventId, action.event.name)
      if (!ended) continue
      // PH.1 — record the promo end. oldPrice is the sale price being
      // cleared; newPrice is the standing price the listing reverts to.
      if (l.product?.sku) {
        await recordPriceChange(prisma, {
          productId: l.productId,
          sku: l.product.sku,
          channel: l.channel,
          marketplace: l.marketplace,
          oldPrice: l.salePrice != null ? Number(l.salePrice) : null,
          newPrice:
            l.priceOverride != null
              ? Number(l.priceOverride)
              : l.price != null
                ? Number(l.price)
                : null,
          reason: `promo "${action.event.name}" ended`,
          source: 'PROMO_END',
          actor: `promo-scheduler:${action.eventId}`,
        })
      }
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

const isoDay = (d: Date) => new Date(d).toISOString().slice(0, 10)

/**
 * The listings among `candidates` whose sale this promotion set and nobody changed since: the latest sale change on
 * each is the door's audit row by `promotion:<event>` — or, for a sale set before the door, the old
 * `lastOverrideBy` marker with no later sale change.
 */
async function promotionSales<T extends { id: string }>(prisma: PrismaClient, eventId: string, candidates: T[]): Promise<T[]> {
  const mine: T[] = []
  for (const l of candidates) {
    const latest = await prisma.channelListingOverride.findFirst({ where: { channelListingId: l.id, fieldName: 'salePrice' }, orderBy: { createdAt: 'desc' }, select: { changedBy: true } })
    if (latest ? latest.changedBy === `promotion:${eventId}` : (l as { lastOverrideBy?: string | null }).lastOverrideBy === `promotion:${eventId}`) mine.push(l)
  }
  return mine
}

/** Has this promotion put this listing on sale before (the door's audit row, or the old `lastOverrideBy` marker)? */
async function promotionEntered(prisma: PrismaClient, eventId: string, l: { id: string; salePrice: unknown; lastOverrideBy: string | null }): Promise<boolean> {
  if (l.salePrice != null && l.lastOverrideBy === `promotion:${eventId}`) return true
  const row = await prisma.channelListingOverride.findFirst({ where: { channelListingId: l.id, fieldName: 'salePrice', changedBy: `promotion:${eventId}` }, select: { id: true } })
  return row !== null
}

/** End a promotion's sale on one listing through the door (the sale cleared, queued; on Amazon with `saleRemoved`). */
async function endPromotionSale(listingId: string, eventId: string, eventName: string): Promise<boolean> {
  const written = await writeChannelPrices({
    targets: [{ listingId, sale: { value: null, start: null, end: null }, unguardedReason: 'promotion' }],
    actor: `promotion-clear:${eventId}`, source: 'PROMO_END', reason: `Promotion "${eventName}" ended`,
  })
  const outcome = written.results[0]
  if (outcome?.outcome === 'refused') logger.warn('promotion sale not ended on a listing', { listingId, eventId, reason: outcome.reason })
  return outcome?.outcome === 'applied'
}

/**
 * `DELETE /api/pricing/promotions/:id` — end every sale this promotion set, through the door. (It was a raw
 * `updateMany` of `salePrice` to null: nothing queued, so the channels kept the sale.)
 */
export async function endPromotionSales(prisma: PrismaClient, eventId: string, eventName: string): Promise<number> {
  const candidates = await prisma.channelListing.findMany({ where: { salePrice: { not: null } }, select: { id: true, lastOverrideBy: true } })
  let ended = 0
  for (const l of await promotionSales(prisma, eventId, candidates)) if (await endPromotionSale(l.id, eventId, eventName)) ended++
  return ended
}
