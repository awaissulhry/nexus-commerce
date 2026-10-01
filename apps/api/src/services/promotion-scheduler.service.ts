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
import { listingMarketCurrency } from './pim/follower-price.js'
import type { MarketCurrencyRow } from './pim/market-currency.js'
import { masterCurrency } from './fx-rate.service.js'
import { boundsApply, priceBoundsOf, storedPriceReason, zeroPriceReason } from './price-bounds.service.js'
import { refreshSnapshotsForSkus } from './pricing-snapshot.service.js'
import { isPriceRefusal, resolvePrice } from './pricing-engine.service.js'
import { recordPriceChange } from './price-history.service.js'

interface PromotionTickResult {
  enteredEvents: number
  exitedEvents: number
  /** Sales actually written through the price door (set or ended). */
  listingsUpdated: number
  /**
   * Listings in a promotion's scope that got no sale and were logged with their reason in THIS tick (see
   * `recordPromotionSkips`): a skip is logged and counted once per listing per event, not again on every later tick.
   */
  listingsSkipped: number
  snapshotsRefreshed: number
  durationMs: number
}

/**
 * Channels whose price sender sends no sale price: a promotion set on them would sit in Nexus and never reach the
 * channel, so it is not set (2026-10-01). eBay's and Etsy's listings have no sale at all (`channelShape(...).absent`,
 * the Studio matrix's own sentences); Shopify and WooCommerce send the regular price only
 * (`syncToShopify` → `work.price = payload.price`, `syncNativeShopifyOffer` writes `price`; the WooCommerce payload
 * carries `regular_price` only).
 */
const SALE_NOT_SENT: Readonly<Record<string, string>> = {
  SHOPIFY: "Shopify's price sender does not send a sale price, so a promotion is not set on Shopify listings.",
  WOOCOMMERCE: "WooCommerce's price sender does not send a sale price, so a promotion is not set on WooCommerce listings.",
}

/**
 * The one currency a FIXED_PRICE value is in: the named marketplace's (on the action's channel, or the one currency
 * every channel's row for that market agrees on), else the master currency. `null` = the market names no single
 * configured currency, so the value cannot be placed anywhere.
 */
function actionCurrency(action: { channel: string | null; marketplace: string | null }, rows: readonly MarketCurrencyRow[], master: string): string | null {
  if (!action.marketplace) return master
  const channels = action.channel ? [action.channel] : [...new Set(rows.map((r) => r.channel))]
  const found = new Set(channels.map((channel) => listingMarketCurrency({ channel, marketplace: action.marketplace! }, rows)).filter((c): c is string => !!c))
  return found.size === 1 ? [...found][0]! : null
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
  // A listing in scope that gets no sale: said by name — once per listing per event (`recordPromotionSkips`, after the
  // pass). The event stays in its start window for a whole day of ticks, and a listing in two of its actions is met twice.
  const skips: PromotionSkip[] = []
  const skipPromotion = (l: { id: string; channel: string; marketplace: string }, eventId: string, reason: string, extra: Record<string, unknown> = {}) => {
    skips.push({ listingId: l.id, channel: l.channel, marketplace: l.marketplace, eventId, phase: 'start', reason, extra })
  }
  // Every market's currency (the door reads them the same way), and the master currency the product's floor and
  // ceiling are in. Read once per tick, only when a promotion starts.
  const currencyRows: MarketCurrencyRow[] = enteringActions.length
    ? await prisma.marketplace.findMany({ select: { channel: true, code: true, currency: true } })
    : []
  const master = masterCurrency()

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
        product: { select: { sku: true, minPrice: true, maxPrice: true, variations: { select: { sku: true } } } },
      },
    })
    // A FIXED_PRICE value is a number in ONE currency (2026-10-01): it was applied to every listing in scope whatever
    // its market's currency, so "15" became €15, £15, 15 SEK and 15 PLN.
    const fixedCurrency = action.action === 'FIXED_PRICE' ? actionCurrency(action, currencyRows, master) : null

    for (const l of listings) {
      // A promotion puts a listing on sale ONCE. Taken again, a PERCENT_OFF would discount its own sale (the engine
      // answers the active sale as the price: 10.10 → 8.59 → 7.30 … on every tick, each one queued), and a sale an
      // operator changed since would be overwritten.
      if (await promotionEntered(prisma, action.eventId, l)) continue
      // A channel whose listings have no sale, or whose sender never sends one: skipped by name, before any pricing.
      const absent = channelShape(l.channel).absent.find((a) => a.cell === 'salePrice')
      const notSent = absent?.reason ?? SALE_NOT_SENT[l.channel.toUpperCase()]
      if (notSent) { skipPromotion(l, action.eventId, notSent); continue }
      const listingCurrency = listingMarketCurrency(l, currencyRows)
      if (action.action === 'FIXED_PRICE' && (!fixedCurrency || listingCurrency !== fixedCurrency)) {
        skipPromotion(l, action.eventId, !fixedCurrency
          ? `The promotion's market ${action.marketplace} has no single configured currency, so its fixed price ${Number(action.value).toFixed(2)} is not set anywhere.`
          : `The fixed price ${fixedCurrency} ${Number(action.value).toFixed(2)} is not set on a market that sells in ${listingCurrency ?? 'no configured currency'}.`,
        { listingCurrency, actionCurrency: fixedCurrency })
        continue
      }
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
          skipPromotion(l, action.eventId, `This market cannot be priced (configuration): ${(err as Error).message}`)
          continue
        }
        // Another sale already on the listing is not this promotion's base: the listing's own price is.
        const base = resolution.source === 'SCHEDULED_SALE' ? Number(l.priceOverride ?? l.price ?? 0) : resolution.price
        if (!(base > 0)) { skipPromotion(l, action.eventId, 'This listing has no price to take the percentage off.'); continue }
        promoPrice = base * (1 - Number(action.value) / 100)
      } else {
        continue
      }
      promoPrice = roundCents(promoPrice)
      const promoStr = promoPrice.toFixed(2)
      // Every sale value is held to the rules of a stored price (`storedPriceReason`): above 0, and inside the product's
      // own floor and ceiling where those apply — a market in the master currency only (refuse, don't convert).
      const refusal = boundsApply(listingCurrency, master)
        ? storedPriceReason(promoPrice, priceBoundsOf(l.product ?? {}))
        : zeroPriceReason(promoPrice)
      if (refusal) { skipPromotion(l, action.eventId, `Not changed: ${refusal}.`, { salePrice: promoPrice }); continue }
      // The sale through the door, with the event's window as its dates; the same sale again is the door's no-op.
      const written = await writeChannelPrices({
        targets: [{ listingId: l.id, sale: { value: promoPrice, start: isoDay(action.event.startDate), end: isoDay(action.event.endDate) }, unguardedReason: 'promotion' }],
        actor: `promotion:${action.eventId}`, source: 'PROMO_START', reason: `Promotion "${action.event.name}"`,
      })
      const outcome = written.results[0]
      if (!outcome || outcome.outcome !== 'applied') {
        if (outcome?.outcome === 'refused') skipPromotion(l, action.eventId, outcome.reason ?? 'The sale was not set.')
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

  const listingsSkipped = await recordPromotionSkips(prisma, skips)

  // ── EXIT: events whose end window has passed ────────────────────
  // The end date is INCLUSIVE (a one-day event has startDate == endDate; the sale's window ends on that day, as the
  // door sends it): the event is over once its end day is, not at that day's first second.
  const endSkips: PromotionSkip[] = []
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
      // A refused end stays this promotion's sale, so every later tick meets it again: said once per listing per event.
      if (ended.refused) endSkips.push({ listingId: l.id, channel: l.channel, marketplace: l.marketplace, eventId: action.eventId, phase: 'end', reason: ended.refused, extra: {} })
      if (!ended.applied) continue
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

  await recordPromotionSkips(prisma, endSkips)

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
    listingsSkipped,
    snapshotsRefreshed,
    durationMs,
  })

  return {
    enteredEvents: enteringActions.length,
    exitedEvents: exitingActions.length,
    listingsUpdated,
    listingsSkipped,
    snapshotsRefreshed,
    durationMs,
  }
}

const isoDay = (d: Date) => new Date(d).toISOString().slice(0, 10)

/** A listing a promotion did not put on sale (`start`), or whose promotion sale the door would not end (`end`). */
interface PromotionSkip {
  listingId: string
  channel: string
  marketplace: string
  eventId: string
  phase: 'start' | 'end'
  reason: string
  extra: Record<string, unknown>
}

/** The audit action a promotion's skip is recorded under: the record that it has been said, for this listing and event. */
export const PROMOTION_SKIP_ACTION = 'promotion-skipped'

/**
 * Say each skip ONCE per listing per event (per phase): a log line and an audit row on the listing. A skip already
 * recorded by an earlier tick — the event re-enters on every tick of its start window, and an ended event is met on
 * every tick after it — is not said again, nor a second meeting in the same pass (a listing in two actions of one event).
 * The listing is still judged on every tick (a skip can lift: a ceiling raised, a currency configured); only the saying
 * is once. Returns how many skips were said now. Best effort: a failed audit write never stops the tick (that skip is
 * then said again next tick).
 */
async function recordPromotionSkips(prisma: PrismaClient, skips: readonly PromotionSkip[]): Promise<number> {
  if (!skips.length) return 0
  const key = (s: { listingId: string; eventId: unknown; phase: unknown }) => `${String(s.eventId)}|${s.listingId}|${String(s.phase)}`
  const seen = new Set<string>()
  let recorded: Array<{ entityId: string; metadata: unknown }> = []
  try {
    recorded = await prisma.auditLog.findMany({
      where: { entityType: 'ChannelListing', action: PROMOTION_SKIP_ACTION, entityId: { in: [...new Set(skips.map((s) => s.listingId))] } },
      select: { entityId: true, metadata: true },
    })
  } catch (error) {
    // Unread, a skip may be said twice; never a tick that stops.
    logger.warn('promotion skips: the record of skips already said could not be read', { error: error instanceof Error ? error.message : String(error) })
  }
  for (const row of recorded) {
    const m = (row.metadata ?? {}) as { eventId?: unknown; phase?: unknown }
    seen.add(key({ listingId: row.entityId, eventId: m.eventId, phase: m.phase ?? 'start' }))
  }
  const fresh: PromotionSkip[] = []
  for (const s of skips) {
    if (seen.has(key(s))) continue
    seen.add(key(s))
    fresh.push(s)
  }
  for (const s of fresh) {
    if (s.phase === 'start') logger.info('promotion skipped on a listing', { listingId: s.listingId, channel: s.channel, marketplace: s.marketplace, eventId: s.eventId, reason: s.reason, ...s.extra })
    else logger.warn('promotion sale not ended on a listing', { listingId: s.listingId, channel: s.channel, marketplace: s.marketplace, eventId: s.eventId, reason: s.reason })
  }
  if (fresh.length) {
    try {
      await prisma.auditLog.createMany({
        data: fresh.map((s) => ({
          userId: null, entityType: 'ChannelListing', entityId: s.listingId, action: PROMOTION_SKIP_ACTION,
          metadata: { eventId: s.eventId, phase: s.phase, reason: s.reason, channel: s.channel, marketplace: s.marketplace, ...s.extra } as never,
        })),
      })
    } catch (error) {
      logger.warn('promotion skips: audit write failed; they are said again next tick', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  return fresh.filter((s) => s.phase === 'start').length
}

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

/**
 * End a promotion's sale on one listing through the door (the sale cleared, queued; on Amazon with `saleRemoved`).
 * `refused` is the door's sentence when it would not end it; the caller says it (the tick, once per listing per event).
 */
async function endPromotionSale(listingId: string, eventId: string, eventName: string): Promise<{ applied: boolean; refused?: string }> {
  const written = await writeChannelPrices({
    targets: [{ listingId, sale: { value: null, start: null, end: null }, unguardedReason: 'promotion' }],
    actor: `promotion-clear:${eventId}`, source: 'PROMO_END', reason: `Promotion "${eventName}" ended`,
  })
  const outcome = written.results[0]
  return { applied: outcome?.outcome === 'applied', ...(outcome?.outcome === 'refused' ? { refused: outcome.reason ?? 'The sale was not ended.' } : {}) }
}

/**
 * `DELETE /api/pricing/promotions/:id` — end every sale this promotion set, through the door. (It was a raw
 * `updateMany` of `salePrice` to null: nothing queued, so the channels kept the sale.)
 */
export async function endPromotionSales(prisma: PrismaClient, eventId: string, eventName: string): Promise<number> {
  const candidates = await prisma.channelListing.findMany({ where: { salePrice: { not: null } }, select: { id: true, lastOverrideBy: true } })
  let ended = 0
  for (const l of await promotionSales(prisma, eventId, candidates)) {
    const done = await endPromotionSale(l.id, eventId, eventName)
    // An operator's one delete: said here, once.
    if (done.refused) logger.warn('promotion sale not ended on a listing', { listingId: l.id, eventId, reason: done.refused })
    if (done.applied) ended++
  }
  return ended
}
