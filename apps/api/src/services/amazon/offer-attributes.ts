/**
 * Amazon sheet gaps — THE send builder of Amazon's offer roots, `purchasable_offer` and `fulfillment_availability`,
 * for every sender: studio Publish, the price job, the stock job, the old page and the cockpit route. Pure.
 *
 * An Amazon PATCH `replace` of `/attributes/<root>` sets the WHOLE root, so a root is always built whole:
 *   - base = Amazon's current root when the caller read it, else the facts themselves (`offer-facts.ts`);
 *   - the selected leaves go on top (default: the leaves Nexus holds — live or draft; with no base, every known one);
 *   - other instances (other markets, the business/B2B audience) and sub-attributes Nexus does not model are kept.
 * Never a whole-root clear: a parent gets no offer root (a parent ASIN has no offer), an offer with no price is never
 * built, an FBA listing never gets a merchant entry, and a code Nexus did not set (Remote Fulfilment, VCS, unknown) is
 * never rebuilt — the root is left out and Amazon keeps it.
 */
import {
  AMAZON_FBA_CODE, AMAZON_FBM_CODE, describeAmazonFulfilmentCode, isFbaFulfilmentCode, normaliseAmazonFulfilmentCode,
} from '../../lib/amazon-fulfilment-programme.js'
import { amazonDiscountedPrice } from './discounted-price.js'
import { AMAZON_SUB_ATTRIBUTE, FULFILMENT_LEAVES, PURCHASABLE_OFFER_LEAVES, dayOf, isAmazonDate, type AmazonOfferLeaf } from './offer-fields.js'
import type { AmazonOfferFacts } from './offer-facts.js'

type Json = Record<string, unknown>
type OfferFacts = Pick<AmazonOfferFacts, 'values' | 'source'>
const record = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : null)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const scheduled = (n: number) => [{ schedule: [{ value_with_tax: n }] }]

/** Which leaves come from the facts: the caller's, else what Nexus holds (with a base) or knows (without one). */
function selection(facts: OfferFacts, family: readonly AmazonOfferLeaf[], leaves: readonly AmazonOfferLeaf[] | undefined, hasBase: boolean): AmazonOfferLeaf[] {
  if (leaves) return family.filter((l) => leaves.includes(l))
  return family.filter((l) => (hasBase ? facts.source[l] === 'live' || facts.source[l] === 'draft' : facts.source[l] !== 'none'))
}

/** One offer leaf's sub-attribute value as Amazon's schema shapes it; `null` = remove it. */
function offerSubValue(leaf: AmazonOfferLeaf, facts: OfferFacts, sendPrice?: number | null): unknown {
  const v = facts.values
  switch (leaf) {
    case 'our_price': {
      const price = sendPrice ?? v.our_price.price
      return price == null ? null : scheduled(price)
    }
    case 'sale': return v.sale ? amazonDiscountedPrice(v.sale.price, v.sale.start, v.sale.end) : null
    case 'minimum_seller_allowed_price': case 'maximum_seller_allowed_price': case 'map_price':
      return v[leaf] == null ? null : scheduled(v[leaf]!)
    case 'offer_start_at': return v.offer_start_at ? { value: v.offer_start_at } : null
    case 'offer_end_at': return v.offer_end_at ? { value: v.offer_end_at } : null
    case 'automated_pricing_rule_id': return v.automated_pricing_rule_id ? [{ merchandising_rule: { rule_id: v.automated_pricing_rule_id } }] : null
  }
  return null
}

export interface PurchasableOfferInput {
  marketplaceId: string
  currency: string
  facts: OfferFacts
  /** Amazon's current `purchasable_offer` root (every instance), when the caller read it. */
  base?: unknown
  /** The leaves written from the facts; others keep the base. Default: see `selection`. */
  leaves?: readonly AmazonOfferLeaf[]
  isParent?: boolean
  /** The price to send instead of the stored one (the job's payload price, Publish's send price). */
  sendPrice?: number | null
}

/** The whole `purchasable_offer` root to send, or null = send no offer root. */
export function amazonPurchasableOffer(input: PurchasableOfferInput): Json[] | null {
  if (input.isParent) return null
  const base = Array.isArray(input.base) ? (input.base as unknown[]).map(record).filter((x): x is Json => !!x).map(clone) : null
  const currency = input.currency.toUpperCase()
  const audienceOf = (x: Json) => String(x.audience ?? 'ALL').toUpperCase()
  const index = base ? base.findIndex((x) => audienceOf(x) === 'ALL' && (x.marketplace_id == null || x.marketplace_id === input.marketplaceId)
    && (x.currency == null || String(x.currency).toUpperCase() === currency)) : -1
  const instance: Json = index >= 0 ? base![index] : { currency, marketplace_id: input.marketplaceId }
  instance.marketplace_id = input.marketplaceId
  instance.currency ??= currency
  const chosen = selection(input.facts, PURCHASABLE_OFFER_LEAVES, input.leaves, !!base)
  if (input.sendPrice != null && !chosen.includes('our_price')) chosen.unshift('our_price')
  for (const leaf of chosen) {
    const value = offerSubValue(leaf, input.facts, input.sendPrice)
    if (value == null) delete instance[AMAZON_SUB_ATTRIBUTE[leaf]]
    else instance[AMAZON_SUB_ATTRIBUTE[leaf]] = value
  }
  // Without a price the replace would clear Amazon's price: build nothing rather than that.
  if (instance.our_price == null) return null
  if (!base) return [instance]
  if (index >= 0) return base
  return [...base, instance]
}

/**
 * The ONE merge instance of `purchasable_offer` (`NEXUS_AMAZON_OFFER_MERGE`): its selectors and the selected leaves only;
 * a leaf the facts remove is an explicit `null` (Amazon's documented delete). Everything else is left to Amazon.
 */
export function amazonOfferMergeLeaves(input: { marketplaceId: string; currency: string; audience?: string; facts: OfferFacts; leaves: readonly AmazonOfferLeaf[]; sendPrice?: number | null }): Json {
  const value: Json = { marketplace_id: input.marketplaceId, currency: input.currency, audience: input.audience ?? 'ALL' }
  for (const leaf of PURCHASABLE_OFFER_LEAVES.filter((l) => input.leaves.includes(l))) {
    value[AMAZON_SUB_ATTRIBUTE[leaf]] = offerSubValue(leaf, input.facts, input.sendPrice) ?? null
  }
  return value
}

export interface FulfillmentAvailabilityInput {
  facts: OfferFacts & Pick<AmazonOfferFacts, 'fulfilmentCodes' | 'fbaByCode'>
  /** The FBA verdict (`isFbaCoordinate` with the job's stock and offer evidence). An AMAZON code in the facts is FBA too. */
  fba: boolean
  /** The listing exists on Amazon: an FBA listing then gets no fulfilment root at all. */
  live: boolean
  /** The quantity to send (`send-quantity.ts`); absent = keep the base's (no base → no quantity key). */
  quantity?: number | null
  /** Amazon's current `fulfillment_availability` root, when the caller read it. */
  base?: unknown
  leaves?: readonly AmazonOfferLeaf[]
  isParent?: boolean
  /** The FBA code of a NEW FBA listing (`AMAZON_EU` unless the region says otherwise). */
  fbaCode?: string
  /** YYYY-MM-DD; a restock date before it is never sent. */
  today?: string
}

/** The whole `fulfillment_availability` root to send, or null = send no fulfilment root. */
export function amazonFulfillmentAvailability(input: FulfillmentAvailabilityInput): Json[] | null {
  if (input.isParent) return null
  const base = Array.isArray(input.base) ? (input.base as unknown[]).map(record).filter((x): x is Json => !!x).map(clone) : null
  const codes = [...new Set([...input.facts.fulfilmentCodes, ...(base ?? []).map((e) => normaliseAmazonFulfilmentCode(e.fulfillment_channel_code)).filter(Boolean)])]
  // A code Nexus did not set (Remote Fulfilment, VCS, any other AMAZON_*), or one it cannot read: never rebuilt.
  if (codes.some((c) => (c.startsWith('AMAZON') && c !== AMAZON_FBA_CODE) || describeAmazonFulfilmentCode(c).method === null)) return null
  // FBA: the caller's verdict, the guard's code test on the stored copies (D9 = A), or Amazon's own current root.
  if (input.fba || input.facts.fbaByCode || (base ?? []).some((e) => isFbaFulfilmentCode(normaliseAmazonFulfilmentCode(e.fulfillment_channel_code))))
    return input.live ? null : [{ fulfillment_channel_code: input.fbaCode ?? AMAZON_FBA_CODE }]

  const isMerchant = (e: Json) => { const c = normaliseAmazonFulfilmentCode(e.fulfillment_channel_code); return c === '' || c === AMAZON_FBM_CODE || c === 'MFN' }
  const at = base ? base.findIndex(isMerchant) : -1
  const entry: Json = at >= 0 ? base![at] : {}
  // Entries are channel-scoped, never market-scoped (the market is the request's): the schema has no marketplace_id.
  delete entry.marketplace_id
  entry.fulfillment_channel_code = AMAZON_FBM_CODE
  if (input.quantity != null) entry.quantity = input.quantity
  for (const leaf of selection(input.facts, FULFILMENT_LEAVES, input.leaves, !!base)) {
    const value = input.facts.values[leaf as 'lead_time_to_ship_max_days' | 'restock_date' | 'is_inventory_available']
    if (value == null) delete entry[leaf]
    else entry[leaf] = value
  }
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  if (entry.restock_date != null && (!isAmazonDate(entry.restock_date) || dayOf(entry.restock_date) < today)) delete entry.restock_date
  if (entry.lead_time_to_ship_max_days != null && !(Number.isInteger(entry.lead_time_to_ship_max_days) && (entry.lead_time_to_ship_max_days as number) >= 0 && (entry.lead_time_to_ship_max_days as number) <= 120)) delete entry.lead_time_to_ship_max_days
  const others = base ? base.filter((_, i) => i !== at && !isMerchant(base[i])) : []
  return [entry, ...others]
}

/** The code a refused price push carries: a person has to change the price or Amazon's bounds (not retryable). */
export const AMAZON_PRICE_OUTSIDE_SELLER_BOUNDS = 'AMAZON_PRICE_OUTSIDE_SELLER_BOUNDS'

/**
 * Amazon deactivates an offer priced outside the seller's own minimum and maximum, so a price outside them is refused
 * before anything is sent. The sale price is a price the buyer pays too. Null = inside (or no bounds).
 */
export function amazonSellerBoundsRefusal(input: { price: number | null; salePrice?: number | null; min: number | null; max: number | null; sku?: string }): string | null {
  const at = input.sku ? `${input.sku}: ` : ''
  const fmt = (n: number) => n.toFixed(2)
  const { min, max } = input
  if (min != null && max != null && min > max) return `${at}The minimum price on Amazon (${fmt(min)}) is above its maximum (${fmt(max)}). Fix the two before a price is sent.`
  const check = (n: number | null | undefined, what: string): string | null => {
    if (n == null) return null
    if (min != null && n < min) return `${at}${what}${fmt(n)} is below the minimum price on Amazon (${fmt(min)}), so Amazon would refuse it. Change the price or the minimum price.`
    if (max != null && n > max) return `${at}${what}${fmt(n)} is above the maximum price on Amazon (${fmt(max)}), so Amazon would refuse it. Change the price or the maximum price.`
    return null
  }
  return check(input.price, '') ?? check(input.salePrice, 'The sale price ')
}
