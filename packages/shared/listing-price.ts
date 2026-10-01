/**
 * The ONE reading of a listing's pricing rule — what price a listing that follows the master carries, and whether a
 * rule or an adjustment percent may be stored at all.
 *
 * The API's master-price cascade and its channel price door compute the price a following listing is sent with
 * here, and the web's screens (the listing drawer's drift label, the product datasheet's effective price) compute the
 * price they show here, so a screen cannot call a correct price "drift" and the send cannot price a listing by rules
 * the screen does not show. Pure: no I/O, no clock.
 *
 *   FIXED              → the master price.
 *   PERCENT_OF_MASTER  → the master price × (1 + percent / 100); no percent counts as 0.
 *   MATCH_AMAZON       → no price from the master (Amazon's pricing drives it): `null`.
 *
 * Rounded to cents, as `ChannelListing.price` (Decimal(10, 2)) stores it.
 */

export const PRICING_RULES = ['FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER'] as const
export type PricingRuleName = (typeof PRICING_RULES)[number]

/** `ChannelListing.priceAdjustmentPercent` is Decimal(5, 2): at most 999.99 either way. */
export const ADJUSTMENT_PERCENT_MAX = 999.99

/**
 * THE cents rounding for every price Nexus computes (the cascade, the price door, the agent tools, the screens).
 * `toPrecision(12)` first, so the float error of `n * 100` cannot decide the cent: 1.005 is 1.01, not the float 1.00
 * (`1.005 * 100` is `100.49999999999999`). Half-up, as a price is rounded; 12 significant digits keep every price
 * below ten billion exact.
 */
export function roundCents(value: number): number {
  return Math.round(Number((value * 100).toPrecision(12))) / 100
}

/** A pricing rule name in any case, trimmed, as the column stores it; `null` when it names none of the three. */
export function normalisePricingRule(value: unknown): PricingRuleName | null {
  if (typeof value !== 'string') return null
  const upper = value.trim().toUpperCase()
  return (PRICING_RULES as readonly string[]).includes(upper) ? (upper as PricingRuleName) : null
}

/** The sentence a refused pricing rule earns: the operator's words for the three rules, no column names. */
export const PRICING_RULE_REFUSAL = 'Choose a pricing rule: Fixed, Match Amazon or Percent of master.'

/**
 * Why an adjustment percent cannot be stored, or `null` when it can. A number with at most 2 decimals, above -100
 * (-100% or less prices the listing at zero or below) and at most 999.99 (the column's range).
 */
export function adjustmentPercentProblem(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return 'The adjustment must be a number.'
  if (Math.abs(roundCents(n) - n) > 1e-9) return 'The adjustment can have at most 2 decimals.'
  if (n <= -100) return 'The adjustment must be above -100%. At -100% or less the price would be 0 or below.'
  if (n > ADJUSTMENT_PERCENT_MAX) return `The adjustment can be at most ${ADJUSTMENT_PERCENT_MAX}%.`
  return null
}

type NumberLike = number | string | { toString(): string } | null | undefined

const toNumber = (value: NumberLike): number | null => {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(String(value))
  return Number.isFinite(n) ? n : null
}

/**
 * The price a listing that follows the master carries under its rule, or `null` when the rule takes no price from
 * the master (MATCH_AMAZON) or there is no master price. An unknown rule reads as FIXED, as the column's default.
 */
export function followerListingPrice(masterPrice: NumberLike, rule: string | null | undefined, adjustmentPercent: NumberLike): number | null {
  const master = toNumber(masterPrice)
  if (master === null) return null
  const name = normalisePricingRule(rule) ?? 'FIXED'
  if (name === 'MATCH_AMAZON') return null
  if (name === 'PERCENT_OF_MASTER') return roundCents(master * (1 + (toNumber(adjustmentPercent) ?? 0) / 100))
  return roundCents(master)
}

/**
 * The price a listing is expected to carry from the master: its rule's price when it follows the master, `null` when
 * it does not (a pinned listing's own price is the expectation) or its rule sets none (MATCH_AMAZON).
 */
export function expectedListingPrice(
  listing: { followMasterPrice?: boolean | null; pricingRule?: string | null; priceAdjustmentPercent?: NumberLike },
  masterPrice: NumberLike,
): number | null {
  if (listing.followMasterPrice === false) return null
  return followerListingPrice(masterPrice, listing.pricingRule, listing.priceAdjustmentPercent)
}

/** A short description of a rule for a sentence: "the master price", "the master price +10%", "Amazon's pricing". */
export function pricingRuleLabel(rule: string | null | undefined, adjustmentPercent: NumberLike): string {
  const name = normalisePricingRule(rule) ?? 'FIXED'
  if (name === 'MATCH_AMAZON') return 'Amazon’s pricing'
  if (name === 'PERCENT_OF_MASTER') {
    const pct = toNumber(adjustmentPercent) ?? 0
    return pct === 0 ? 'the master price' : `the master price ${pct > 0 ? '+' : ''}${pct}%`
  }
  return 'the master price'
}
