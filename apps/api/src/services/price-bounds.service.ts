/**
 * P4.4c — the operator's own price floor and ceiling, honoured at the send.
 *
 * 🔴 `Product.minPrice` ("Pricing floor") and `Product.maxPrice` ("Pricing
 * ceiling") have existed on the product for as long as the pricing-intelligence
 * block has. Nine screens read them, `bulk-upload` writes them, and an operator
 * can set them from the products grid.
 *
 * **No price write consulted either of them.** Measured across the seven paths
 * that push a price — `outbound-sync.service.ts`, `master-price.service.ts`,
 * `pim/channel-price-write.service.ts`, `shopify/listing-write.service.ts`,
 * `ebay-variation-push.service.ts`, `amazon/flat-file.service.ts`,
 * `routes/catalog.routes.ts` — **0 occurrences in all seven**, with
 * `repricing.service.ts` (16) as the positive control that the search works.
 *
 * The repricer's 16 are a DIFFERENT pair: `RepricingRule.minPrice/maxPrice`, a
 * per-rule range its strategies clamp inside. So the floor an operator sets on
 * the product bound one machine lane and nothing else: a typed price, a master
 * price cascade, a flat-file save, a wizard publish and a bulk action all went
 * straight through it.
 *
 * 🔴 It REFUSES rather than clamping, and that is the deliberate difference from
 * the oversell clamp next to it. A quantity clamp reduces a number the system
 * derived; a price outside the operator's own floor is a number a PERSON typed,
 * and quietly sending a different one is worse than not sending it. The
 * repricer may still clamp within its own rule — a machine choosing inside a
 * range it was given is not the same act.
 */

import prisma from '../db.js'

export interface PriceBounds {
  minPrice: number | null
  maxPrice: number | null
}

/**
 * The verdict, pure so it is tested by VALUE.
 *
 * `null` = nothing to say. A sentence = do not send, and this is why.
 */
export function priceBoundsRefusal(args: {
  price: number | undefined | null
  bounds: PriceBounds
  channel: string
  sku?: string | null
}): string | null {
  const price = args.price
  // No price on this row: nothing to check. A row with a nonsense price is a
  // different defect, refused by the channel's own validation.
  if (price === undefined || price === null || !Number.isFinite(price)) return null
  const who = args.sku ? ` for ${args.sku}` : ''
  const { minPrice, maxPrice } = args.bounds
  // A floor ABOVE the ceiling is a contradiction the operator has to resolve; we
  // do not pick one of the two. Checked before either bound, or a price between
  // them would slip through a range that cannot exist.
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    return `Nothing was sent to ${args.channel}${who}: the pricing floor (${minPrice}) is above the pricing ceiling (${maxPrice}). Fix the two on the product before pricing.`
  }
  if (minPrice !== null && price < minPrice) {
    return `Nothing was sent to ${args.channel}${who}: ${price} is below the pricing floor of ${minPrice} set on this product. Change the price, or change the floor.`
  }
  if (maxPrice !== null && price > maxPrice) {
    return `Nothing was sent to ${args.channel}${who}: ${price} is above the pricing ceiling of ${maxPrice} set on this product. Change the price, or change the ceiling.`
  }
  return null
}

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * The product's floor and ceiling. An unreadable product is `{ null, null }` —
 * "no bounds set" — which is the same answer as a product with none, and means
 * this guard never blocks a send because of its own failure.
 *
 * 🔴 That IS a fail-open, and it is the right one HERE, deliberately, unlike the
 * EU quantity guard (D9). A missing bound is the overwhelmingly common state
 * (most products have neither), so "could not read" and "none set" are not
 * meaningfully different populations, and refusing every price push on a
 * database hiccup would take pricing down for the 99% who set no floor. The
 * guard's job is to honour a bound that EXISTS, not to gate pricing.
 */
export async function loadPriceBounds(productId: string | null | undefined): Promise<PriceBounds> {
  if (!productId) return { minPrice: null, maxPrice: null }
  // try/catch, not `.catch()`: `prisma.product.findUnique` throws SYNCHRONOUSLY
  // when the client has no `product` model at all, and a `.catch()` on the
  // promise never sees that. The promise this guard makes — that it never blocks
  // a send by failing — has to hold for both shapes of failure.
  try {
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { minPrice: true, maxPrice: true } })
    return { minPrice: asNumber(product?.minPrice), maxPrice: asNumber(product?.maxPrice) }
  } catch {
    return { minPrice: null, maxPrice: null }
  }
}

/** The one call a send lane makes: `null` to proceed, a sentence to refuse. */
export async function priceRefusalFor(args: {
  price: number | undefined | null
  productId: string | null | undefined
  channel: string
  sku?: string | null
}): Promise<string | null> {
  // No read at all when the row carries no price — a content or quantity push
  // must not pay for this guard, and must not fail because of it.
  if (args.price === undefined || args.price === null) return null
  return priceBoundsRefusal({ ...args, bounds: await loadPriceBounds(args.productId) })
}

/**
 * The same floor and ceiling, checked BEFORE a master price is written (the agent price tools). The push
 * refuses a price outside them, but by then Nexus has stored it, so Nexus and the channel would disagree.
 * `null` = within the bounds, or none set; otherwise the reason as a clause ("35.00 is below its pricing floor
 * of 40.00") for the caller's own sentence.
 */
export function masterPriceBoundsReason(price: number, bounds: PriceBounds): string | null {
  const { minPrice, maxPrice } = bounds
  const fmt = (n: number) => n.toFixed(2)
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    return `its pricing floor (${fmt(minPrice)}) is above its pricing ceiling (${fmt(maxPrice)})`
  }
  if (minPrice !== null && price < minPrice) return `${fmt(price)} is below its pricing floor of ${fmt(minPrice)}`
  if (maxPrice !== null && price > maxPrice) return `${fmt(price)} is above its pricing ceiling of ${fmt(maxPrice)}`
  return null
}

/** Decimal-or-null columns as the numbers `PriceBounds` holds. */
export function priceBoundsOf(row: { minPrice?: unknown; maxPrice?: unknown }): PriceBounds {
  return { minPrice: asNumber(row.minPrice), maxPrice: asNumber(row.maxPrice) }
}
