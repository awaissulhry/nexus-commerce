/**
 * P4.4e — price read-back: the closed loop for the number that is money.
 *
 * 🔴 What was measured, and it is the cheapest finding in the package: **the
 * price was already in our hands and we dropped it on the floor.**
 *
 *   - `amazon-qty-readback` pulls `GET_MERCHANT_LISTINGS_ALL_DATA` daily per
 *     market. `fetchActiveCatalog` already parses `price` out of it
 *     (`amazon.service.ts:452`, `CatalogItem.price`). The job diffs `quantity`
 *     and **throws the price away**.
 *   - `shopify-qty-readback` (P4.3f) reads each variant through `VARIANT_QUERY`,
 *     which selects `id sku price product { id } inventoryItem { … }`. It reads
 *     the available quantity out of the response and **throws the price away**.
 *
 * So a price read-back on both channels costs **zero additional API calls**. It
 * is not a new integration; it is keeping a field we already asked for.
 *
 * Before this, price drift was invisible on every channel. Shopify has a strong
 * WRITE-TIME check (`listing-write.service.ts` reads the variant back and throws
 * if it differs), Amazon and eBay have none at all — and a write-time check, as
 * P4.2c and P4.3f both put it, **cannot detect drift between writes**. A repricer
 * on the shop's side, a promotion, a third-party app or a failed push all move
 * the price and nothing here noticed.
 *
 * 🔴 It REPORTS and does not heal, unlike the quantity read-back beside it.
 * A quantity heal is bounded by the pool. A price heal is a **money write made
 * by a machine on a schedule**, with nothing above it but P4.4c's floor and
 * ceiling — and most products have neither. The Owner has not ruled on automatic
 * price correction, so this raises the conflict and stops. The switch is named
 * below for the day that ruling exists.
 */

/** Money compares to the cent. A float subtraction does not. */
const cents = (value: number): number => Math.round(value * 100)

export interface PriceDrift {
  /** What the channel says it is selling at. */
  channelPrice: number
  /** What the listing's committed price says it should be. */
  intendedPrice: number
  /** Signed, in the market's currency: positive = the channel is HIGHER. */
  difference: number
}

/**
 * The verdict, pure so it is tested by VALUE.
 *
 * `null` means nothing to report: they agree, or there is nothing to compare.
 */
export function priceDrift(args: {
  channelPrice: number | null | undefined
  intendedPrice: number | null | undefined
}): PriceDrift | null {
  const channelPrice = args.channelPrice
  const intendedPrice = args.intendedPrice
  // 🔴 A missing price on either side is NOT a drift of that amount. "The channel
  // did not tell us" and "the channel says 0" are different facts, and a report
  // that conflates them turns every unpriced listing into a false conflict.
  if (channelPrice === null || channelPrice === undefined || !Number.isFinite(channelPrice)) return null
  if (intendedPrice === null || intendedPrice === undefined || !Number.isFinite(intendedPrice)) return null
  // A channel price of 0 on a listing we intend to sell IS worth reporting — it
  // is the price equivalent of the scoped Zero — so 0 is a value, not a gap.
  const difference = cents(channelPrice) - cents(intendedPrice)
  if (difference === 0) return null
  return { channelPrice, intendedPrice, difference: difference / 100 }
}

/** The operator's sentence for one drifted listing. */
export function priceDriftMessage(args: {
  channel: string
  sku: string
  drift: PriceDrift
  currency?: string | null
}): string {
  const money = (n: number) => `${args.currency ? `${args.currency} ` : ''}${n.toFixed(2)}`
  return `${args.channel} shows ${money(args.drift.channelPrice)} for ${args.sku} but the listing intends ${money(args.drift.intendedPrice)}.`
}

/**
 * Whether the read-back may push a correction. Off, and it stays off until the
 * Owner rules on automatic price correction: a scheduled money write is not a
 * default anybody should inherit by accident.
 */
export function priceHealEnabled(): boolean {
  return process.env.NEXUS_ENABLE_PRICE_READBACK_HEAL === 'true'
}
