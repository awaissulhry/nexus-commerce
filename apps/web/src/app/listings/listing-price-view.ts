/**
 * What the listings screens say about a listing's price — pure, so it is tested by value (2026-10-01).
 *
 * The API's price door and master-price cascade price a following listing by its RULE (`@nexus/shared/listing-price`).
 * These screens read the same function, so a listing following at "master +10%" is shown ON its rule, never as 1.00
 * of drift, and the grid's price cell asks for what the API's PATCH takes: a typed price is a pin (`priceOverride`).
 */
import { expectedListingPrice, pricingRuleLabel } from '@nexus/shared/listing-price'

/** The PATCH body of the grid's inline cell. A price is a pin through the price door; it was `{ price }`, refused. */
export function inlineCellPatchBody(field: 'price' | 'quantity', value: number, version: number): Record<string, number> {
  return field === 'price' ? { priceOverride: value, expectedVersion: version } : { quantity: value, expectedVersion: version }
}

type Num = number | string | null | undefined

export interface PriceDriftView {
  /** The price the listing should carry: its rule's price when it follows, the master when it is pinned; null = none. */
  expected: number | null
  /** price − expected, in cents; null when either is unknown. */
  drift: number | null
  /** The label's tail: "+1.50 vs expected (the master price +10%) 11.00" / "+5.00 vs master". */
  label: string | null
}

/** The listing drawer's price comparison: rule-aware for a following listing, against the master for a pinned one. */
export function priceDriftView(listing: {
  price?: Num
  followMasterPrice?: boolean | null
  pricingRule?: string | null
  priceAdjustmentPercent?: Num
}, masterPrice: Num): PriceDriftView {
  const following = listing.followMasterPrice !== false
  const master = masterPrice == null || masterPrice === '' || !Number.isFinite(Number(masterPrice)) ? null : Number(masterPrice)
  const expected = following ? expectedListingPrice(listing, master) : master
  const price = listing.price == null || listing.price === '' ? null : Number(listing.price)
  const drift = expected != null && price != null && Number.isFinite(price) ? Math.round((price - expected) * 100) / 100 : null
  if (drift == null) return { expected, drift, label: null }
  const sign = drift > 0 ? '+' : ''
  const label = following
    ? `${sign}${drift.toFixed(2)} vs expected (${pricingRuleLabel(listing.pricingRule, listing.priceAdjustmentPercent)}) ${expected!.toFixed(2)}`
    : `${sign}${drift.toFixed(2)} vs master`
  return { expected, drift, label }
}
