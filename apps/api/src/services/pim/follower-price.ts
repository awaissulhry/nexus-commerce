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
import { followerListingPrice, roundCents } from '@nexus/shared/listing-price'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import { marketCurrency, type MarketCurrencyRow } from './market-currency.js'
import { masterCurrency } from '../fx-rate.service.js'

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
  return heldSentence(listing, `The price ${price.toFixed(2)}`)
}

/**
 * The same sentence for any change kept in Nexus by `holdsCascadedPrice` — a follower price, a typed (pinned) price,
 * a sale: `what` names it ("The price 25.00", "The sale 19.90"). Round 5: a held change IS sent later — once, on resume
 * (`sendHeldPrices`), or by Publish — so the sentence says when.
 */
export function heldSentence(listing: HoldFacts, what: string): string {
  return listing.syncPaused
    ? `${what} is saved in Nexus. Nothing was sent: this listing's sync is paused. It is sent when the listing resumes.`
    : `${what} is saved in Nexus. Nothing was sent: this listing is a draft that has not been published; Publish sends it.`
}

/*
 * HELD PRICES (round 5, 2026-10-01) — a price change kept in Nexus by `holdsCascadedPrice` is not lost: it is written
 * as a PRICE_UPDATE row that is never dispatched (`SKIPPED`, so no dispatcher, drain or retry picks it up), and the
 * channel price door's `sendHeldPrices` sends it ONCE when the listing can be sent to again — on resume, and when a
 * draft goes live. Before, nothing replayed it: a price, pin or sale changed while a listing was paused stayed in
 * Nexus after the resume until some later change happened to push it.
 *
 *   - `PUSH_SYNC_PAUSED` — a live listing's sync is paused. The same code the dispatcher gives a row it refuses because
 *     the listing was paused after the row was queued (inside the 30 s hold), so that change waits the same way.
 *   - `PRICE_HELD_DRAFT` — a still-draft, for a change its publication does NOT carry. Round 6: every publisher sends
 *     the listing's own send price (`listingSendPrice`: a pin, or the rule's price), so a price is carried by Publish
 *     and is never marked; an Amazon draft's sale (and offer leaves) is: studio Publish now sends it with its dates,
 *     but a draft can also go live through the old flat file, the wizard, a pull or reconciliation, which do not —
 *     the held row is what reaches Amazon then (after Publish it is one harmless re-send).
 *     (Other channels' senders send no sale: a held one would only send the price again.)
 * A held row is kept by the queue's retention sweep (`NOT_HELD_PRICE_ROW`) and is not retried by hand: it waits for
 * the resume or the publish, or is replaced by a newer change.
 */
export const HELD_PAUSED_CODE = 'PUSH_SYNC_PAUSED'
export const HELD_DRAFT_CODE = 'PRICE_HELD_DRAFT'
export const HELD_PRICE_CODES = [HELD_PAUSED_CODE, HELD_DRAFT_CODE] as const
/** A `where` for a listing's held price changes. */
export const HELD_PRICE_ROWS = { syncType: 'PRICE_UPDATE', syncStatus: 'SKIPPED', errorCode: { in: [...HELD_PRICE_CODES] } } satisfies Prisma.OutboundSyncQueueWhereInput
/**
 * A `where` for every row that is NOT a held price change — for a sweep that deletes or cancels settled rows (the
 * retention job). Spelled positively: SQL's `NOT IN` is unknown on a null `errorCode`, which would keep every
 * code-less SKIPPED price row for ever.
 */
export const NOT_HELD_PRICE_ROW = {
  OR: [{ syncType: { not: 'PRICE_UPDATE' } }, { syncStatus: { not: 'SKIPPED' } }, { errorCode: null }, { errorCode: { notIn: [...HELD_PRICE_CODES] } }],
} satisfies Prisma.OutboundSyncQueueWhereInput
/** Is this queue row a held price change? */
export const isHeldPriceRow = (row: { syncType: string | null; syncStatus: string | null; errorCode: string | null }) =>
  row.syncType === 'PRICE_UPDATE' && row.syncStatus === 'SKIPPED' && (HELD_PRICE_CODES as readonly string[]).includes(row.errorCode ?? '')

/**
 * Which held marker a change kept in Nexus needs, or `null` (none: the listing is not held, or Publish carries it).
 * `followerPrice` is the price a following listing now carries when the change moved it; `masterPrice` the master.
 */
export function heldPriceCode(listing: HoldFacts & { channel: string }, change: { pin: boolean; sale: boolean; followerPrice: number | null }): typeof HELD_PRICE_CODES[number] | null {
  // A draft: Publish carries the price (`listingSendPrice`); only Amazon's sale is left for the go-live to send.
  if (isStillDraftListing(listing)) return change.sale && listing.channel === 'AMAZON' ? HELD_DRAFT_CODE : null
  if (listing.syncPaused) return change.pin || change.sale || change.followerPrice != null ? HELD_PAUSED_CODE : null
  return null
}

/**
 * The held marker row (created through `createOutboundRow(s)`, like every queue row): SKIPPED, never dispatched. Its
 * payload says what was held (the row the change would have queued) under its own `source: 'HELD_PRICE'` (the original
 * source in `heldFrom`), so nothing that counts the rows a change QUEUED (the agent's approval status) counts it.
 */
export function heldPriceRowData(
  listing: { id: string; productId: string | null; channel: string; region: string | null; externalListingId: string | null },
  code: typeof HELD_PRICE_CODES[number],
  payload: Record<string, unknown>,
): Prisma.OutboundSyncQueueUncheckedCreateInput {
  return {
    productId: listing.productId, channelListingId: listing.id, targetChannel: listing.channel as never, targetRegion: listing.region,
    syncStatus: 'SKIPPED' as never, syncType: 'PRICE_UPDATE', holdUntil: null, externalListingId: listing.externalListingId, maxRetries: 0,
    errorCode: code,
    errorMessage: code === HELD_PAUSED_CODE
      ? 'Kept in Nexus while this listing’s sync is paused. It is sent once, when the listing resumes.'
      : 'Kept in Nexus while this listing is a draft. It is sent once, when the listing is published.',
    payload: { ...payload, source: 'HELD_PRICE', heldFrom: payload.source ?? null, held: code } as Prisma.InputJsonValue,
  }
}

/** The facts `listingSendPrice` reads. */
export interface SendPriceListing {
  followMasterPrice: boolean | null
  priceOverride: unknown
  price: unknown
  pricingRule: string | null
  priceAdjustmentPercent: unknown
}

/** A configured currency code (three letters, upper case), or `null` — read as `marketCurrency` reads a market's. */
export const currencyCode = (value: unknown): string | null => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/** A product with no listing on the destination yet: it follows the master price under the default rule. */
export const NO_LISTING_PRICE_FACTS: SendPriceListing = { followMasterPrice: true, priceOverride: null, price: null, pricingRule: 'FIXED', priceAdjustmentPercent: null }

/** The price a listing is sent, or why it has none to send (a sentence in the door's words). */
export type SendPrice = { price: number; reason?: undefined } | { price: null; reason: string }

const amount = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value))
  return Number.isFinite(n) ? n : null
}

/**
 * ROUND 6 (2026-10-01) — THE price a listing is sent now. One rule for every sender: the price door's SEND mode (Push
 * price and the held-price hook), every publisher (Amazon, eBay, Shopify's content sync and colour products) and the
 * native Shopify offer sender for a row that carries no price:
 *
 *   - pinned (`followMasterPrice: false`): its own price (`priceOverride`, else `price`);
 *   - following, in a market that sells in the master currency, under a rule that takes its price from the master:
 *     the rule's price from the CURRENT master (`computeListingPrice`, the cascade's maths);
 *   - following under Match Amazon, or in a market that sells in another currency (or has none configured): the price
 *     the listing holds — its own number in its own currency. The master number is never sent there, converted or not.
 *   - nothing to send: `null`, and why.
 *
 * Before, every publisher sent a following listing the MASTER price: a listing at "master +10%" went live at the
 * master, and a GBP market was sent the EUR number as pounds.
 */
export function listingSendPrice(
  listing: SendPriceListing,
  context: { masterPrice: unknown; marketCurrency: string | null; masterCurrency?: string; where?: string },
): SendPrice {
  const where = context.where ?? 'this market'
  // A market's own name ("eBay UK") keeps its spelling at the start of a sentence; the stand-in is capitalised.
  const whereStart = context.where ?? 'This market'
  const own = amount(listing.priceOverride) ?? amount(listing.price)
  if (listing.followMasterPrice === false) {
    return own != null ? { price: roundCents(own) } : { price: null, reason: `This listing has no price of its own for ${where}. Set its price first.` }
  }
  const master = (context.masterCurrency ?? masterCurrency()).toUpperCase()
  const base = amount(context.masterPrice)
  if (context.marketCurrency === master && base != null) {
    const ruled = computeListingPrice(base, listing.pricingRule, true, listing.priceAdjustmentPercent as never)
    if (ruled != null) return { price: ruled }
  }
  const held = amount(listing.price)
  if (held != null) return { price: roundCents(held) }
  if (context.marketCurrency !== master) {
    return {
      price: null,
      reason: context.marketCurrency
        ? `${whereStart} sells in ${context.marketCurrency}, and this listing follows the master price in ${master}. Nexus does not convert it. Set this listing's own ${context.marketCurrency} price.`
        : `No currency is configured for ${where}, so the master price (${master}) is not sent there. Set the market's currency, or this listing's own price.`,
    }
  }
  return {
    price: null,
    reason: base == null
      ? 'This product has no master price. Set the master price, or this listing\'s own price.'
      : `Match Amazon has not set a price for ${where} yet. Set this listing's own price, or change its pricing rule.`,
  }
}

/** `listingSendPrice` with the listing market's currency read from its Marketplace row (none configured → `null`). */
export async function listingSendPriceNow(listing: SendPriceListing & { channel: string; marketplace: string }, masterPrice: unknown, where?: string): Promise<SendPrice> {
  let marketCur: string | null = null
  try { marketCur = await marketCurrency(listing.channel, listing.marketplace) } catch { marketCur = null }
  return listingSendPrice(listing, { masterPrice, marketCurrency: marketCur, where: where ?? `${listing.channel} ${listing.marketplace}` })
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
