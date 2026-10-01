/**
 * A FOLLOWING listing's price — the one set of rules the master-price cascade (`master-price.service.ts`) and the
 * channel price door's follower mode (`channel-price-write.service.ts`) both apply, so the two cannot drift:
 *
 *   - what the price becomes (`computeListingPrice`, the maths in `@nexus/shared/listing-price`);
 *   - refuse, don't convert: a listing whose market sells in another currency than the master is NOT sent a price
 *     taken from the master (`listingMarketCurrency`, `masterCurrencyRefusal`, `logMasterCurrencyRefusals`);
 *   - a paused listing or a still-draft keeps the price in Nexus and is not queued (`holdsCascadedPrice`);
 *   - the PRICE_UPDATE row's payload (`followerPricePayload`) and its 30 s grace window (`FOLLOWER_PRICE_HOLD_MS`).
 *
 * A light module on purpose: the cascade's module loads the queue (a Redis connection); the door must not pay that.
 */
import type { Prisma } from '@prisma/client'
import { followerListingPrice } from '@nexus/shared/listing-price'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { marketCurrency, type MarketCurrencyRow } from './market-currency.js'

/** The operator's grace window before a follower price leaves: 30 s to undo (IS.2b). */
export const FOLLOWER_PRICE_HOLD_MS = 30 * 1000

export type CascadeRule = 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'

/**
 * Compute what a ChannelListing's `price` should become given a master price. `null` when the price should NOT be
 * touched: the listing does not follow the master, or its rule takes no price from it (MATCH_AMAZON). Pure.
 */
export function computeListingPrice(
  newMasterPrice: number,
  rule: CascadeRule | string | null | undefined,
  followMasterPrice: boolean,
  adjustmentPercent: Prisma.Decimal | number | string | null | undefined,
): number | null {
  if (!followMasterPrice) return null
  return followerListingPrice(newMasterPrice, rule, adjustmentPercent as never)
}

/** The facts `holdsCascadedPrice` reads. */
export interface HoldFacts {
  syncPaused: boolean
  listingStatus: string | null
  isPublished: boolean
  externalListingId: string | null
}

/**
 * Whether a follower price stays in Nexus instead of being queued for the channel: a paused listing (an operator's
 * pause, or a draft kept inert by its pause) and a still-draft (`isStillDraftListing`), paused or not. A draft started
 * before drafts were born paused is not paused, and sending it a price would write to the channel before Publish.
 * A DRAFT row with a channel id has reached the channel, so it is not a still-draft and is queued.
 */
export function holdsCascadedPrice(listing: HoldFacts): boolean {
  return listing.syncPaused || isStillDraftListing(listing)
}

/** The sentence for a follower price kept in Nexus by `holdsCascadedPrice`. */
export function heldPriceSentence(listing: HoldFacts, price: number): string {
  return listing.syncPaused
    ? `The price ${price.toFixed(2)} is saved in Nexus. Nothing was sent: this listing's sync is paused.`
    : `The price ${price.toFixed(2)} is saved in Nexus. Nothing was sent: this listing is a draft that has not been published; Publish sends it.`
}

/** The listing market's configured currency, or `null` when the market has none (then it is never the master currency). */
export function listingMarketCurrency(listing: { channel: string; marketplace: string }, rows: readonly MarketCurrencyRow[]): string | null {
  try { return marketCurrency(listing.channel, listing.marketplace, rows) } catch { return null }
}

export interface MasterCurrencyRefusal {
  listingId: string
  channel: string
  marketplace: string
  /** The market's currency; `null` = none configured. */
  currency: string | null
  masterCurrency: string
}

/** Refuse, don't convert — the sentence recorded when a price taken from the master is not sent to a market. */
export function masterCurrencyRefusal(refusal: MasterCurrencyRefusal, masterPrice: number): string {
  const where = `${refusal.channel} ${refusal.marketplace}`
  return refusal.currency
    ? `The master price ${refusal.masterCurrency} ${masterPrice.toFixed(2)} was not sent to ${where}: that market sells in ${refusal.currency}. Set this listing's own ${refusal.currency} price. Nothing was queued.`
    : `The master price ${refusal.masterCurrency} ${masterPrice.toFixed(2)} was not sent to ${where}: no currency is configured for that market. Nothing was queued.`
}

/**
 * Record each refusal as a MASTER_PRICE_CURRENCY_REFUSED sync-health conflict. Best effort: never undoes the edit.
 * Call it once the edit is committed.
 */
export async function logMasterCurrencyRefusals(productId: string | null, masterPrice: number, refusals: readonly MasterCurrencyRefusal[]): Promise<void> {
  if (!refusals.length) return
  const { syncHealthService } = await import('../sync-health.service.js')
  for (const refusal of refusals) {
    await syncHealthService.logConflict({
      channel: refusal.channel,
      conflictType: 'MASTER_PRICE_CURRENCY_REFUSED',
      message: masterCurrencyRefusal(refusal, masterPrice),
      productId: productId ?? undefined,
      localData: { masterPrice, masterCurrency: refusal.masterCurrency },
      remoteData: { listingId: refusal.listingId, marketplace: refusal.marketplace, marketCurrency: refusal.currency },
    }).catch(() => { /* observability best-effort — the refusal already holds */ })
  }
}

/** A follower price outside the product's own floor or ceiling, or not above 0: never stored, never sent. */
export interface FollowerBoundsRefusal {
  listingId: string
  channel: string
  marketplace: string
  /** The follower price the rule gave. */
  price: number
  /** The clause: "11.00 is above its pricing ceiling of 10.50". */
  reason: string
}

/** Record each refusal as a MASTER_PRICE_BOUNDS_REFUSED sync-health conflict, once the change is committed. Best effort. */
export async function logFollowerBoundsRefusals(productId: string | null, masterPrice: number, refusals: readonly FollowerBoundsRefusal[]): Promise<void> {
  if (!refusals.length) return
  const { syncHealthService } = await import('../sync-health.service.js')
  for (const refusal of refusals) {
    await syncHealthService.logConflict({
      channel: refusal.channel,
      conflictType: 'MASTER_PRICE_BOUNDS_REFUSED',
      message: `The master price ${masterPrice.toFixed(2)} was not sent to ${refusal.channel} ${refusal.marketplace}: the listing would follow it at ${refusal.price.toFixed(2)}, but ${refusal.reason}. Change the rule, or the floor or ceiling on the product. The listing keeps its price; nothing was queued.`,
      productId: productId ?? undefined,
      localData: { masterPrice, followerPrice: refusal.price },
      remoteData: { listingId: refusal.listingId, marketplace: refusal.marketplace },
    }).catch(() => { /* observability best-effort — the refusal already holds */ })
  }
}

/** The PRICE_UPDATE payload for a follower price — the cascade's row and the door's follower row carry the same fields. */
export function followerPricePayload(input: {
  source: string
  productId: string | null
  productSku: string | null
  channel: string
  marketplace: string
  price: number
  oldPrice: number | null
  masterPrice: number
  oldMasterPrice: number | null
  pricingRule: string
  priceAdjustmentPercent: Prisma.Decimal | number | null
  reason: string | null
  idempotencyKey: string | null
}): Record<string, unknown> {
  return {
    source: input.source,
    productId: input.productId,
    productSku: input.productSku,
    channel: input.channel,
    marketplace: input.marketplace,
    price: input.price,
    oldPrice: input.oldPrice,
    masterPrice: input.masterPrice,
    oldMasterPrice: input.oldMasterPrice,
    pricingRule: input.pricingRule,
    priceAdjustmentPercent: input.priceAdjustmentPercent != null ? Number(input.priceAdjustmentPercent) : null,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  }
}
