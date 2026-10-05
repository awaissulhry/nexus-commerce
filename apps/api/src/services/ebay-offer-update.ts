/**
 * The body Nexus sends to eBay's Inventory API for one variation offer: `newOfferBody` for createOffer, and
 * `offerUpdateBody` for updateOffer on an offer eBay already holds.
 *
 * Why the update starts from eBay's offer: updateOffer REPLACES the whole offer ("this call does a complete
 * replacement of the existing offer object" — Sell Inventory API, updateOffer). A field the body leaves out is a field
 * removed. Until 2026-10-05 the photo publish of an eBay Inventory family sent only SKU, market, format, category,
 * subtitle, quantity, price, three policy ids and the location, so every photo publish deleted the offer's VAT (`tax`),
 * store categories, second category, product safety data (`regulatory`), original retail price and minimum advertised
 * price (`pricingSummary`), eBay Plus and shipping cost overrides (`listingPolicies`), lot size, charity and hidden
 * buyer details.
 *
 * Pure: no database, no eBay call.
 */
import { offerQuantityLimit } from './ebay-quantity-limit.js'

/** What Nexus itself sets on a variation offer. A blank category, subtitle, policy id or location is not sent. */
export interface VariationOfferOurs {
  sku: string
  marketplaceId: string
  format: 'FIXED_PRICE'
  categoryId?: string | null
  subtitle?: string | null
  availableQuantity: number
  price: { value: string; currency: string }
  policies: { fulfillmentPolicyId?: string | null; paymentPolicyId?: string | null; returnPolicyId?: string | null }
  merchantLocationKey?: string | null
  /** The main row's Max per buyer; null = none of ours (an existing offer then keeps eBay's, see `offerQuantityLimit`). */
  quantityLimitPerBuyer: number | null
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * createOffer for a variation SKU eBay holds no offer for. The shape the variation push has always sent:
 * `listingDescription` is left out (a group member shows the group's description), and Best Offer is left out (eBay
 * refuses it on a SKU in an inventory item group, error 25737). A new offer gets no Max per buyer unless ours is set.
 */
export function newOfferBody(ours: VariationOfferOurs): Record<string, unknown> {
  const { categoryId, merchantLocationKey } = ours
  const subtitle = ours.subtitle?.trim()
  const { fulfillmentPolicyId, paymentPolicyId, returnPolicyId } = ours.policies
  return {
    sku: ours.sku,
    marketplaceId: ours.marketplaceId,
    format: ours.format,
    ...(categoryId ? { categoryId } : {}),
    ...(subtitle ? { subtitle } : {}),
    availableQuantity: ours.availableQuantity,
    pricingSummary: { price: ours.price },
    listingPolicies: {
      ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
      ...(paymentPolicyId ? { paymentPolicyId } : {}),
      ...(returnPolicyId ? { returnPolicyId } : {}),
    },
    // merchantLocationKey (top level, not inside listingPolicies) lets eBay resolve the item's country.
    ...(merchantLocationKey ? { merchantLocationKey } : {}),
    ...offerQuantityLimit(ours.quantityLimitPerBuyer, null),
  }
}

/**
 * updateOffer for a variation offer eBay already holds: eBay's current offer (`live`, its getOffer answer or the
 * matching entry of getOffers), with ours on top.
 *
 * Dropped from eBay's answer:
 *   • what getOffer returns and updateOffer does not take (EbayOfferDetailsWithAll vs EbayOfferDetailsWithId):
 *     `offerId` (it is in the URL), `status`, `listing` (listingId, listingStatus, soldQuantity, listingOnHold);
 *   • two fields the variation push never sends on a group member: `listingDescription` (a member of an inventory item
 *     group shows the group's description, which this push sets on the group) and `listingPolicies.bestOfferTerms`
 *     (eBay refuses Best Offer on a SKU in an item group, error 25737).
 * `sku`, `marketplaceId` and `format` are fixed when the offer is created and updateOffer does not change them; Nexus
 * sends the same values it always sent (the offer it found is this market's one fixed-price offer).
 *
 * Ours replace eBay's: quantity, price (`pricingSummary.price` only — the original retail price, minimum advertised
 * price and its visibility stay eBay's), the three policy ids (eBay Plus, shipping cost overrides, compliance and
 * take-back policies stay eBay's), the location, and the category when ours is set. The subtitle is ours when it is
 * not blank, else eBay's. Max per buyer: ours when set, else eBay's (`offerQuantityLimit`).
 *
 * Always eBay's (Owner decision 1, 2026-10-05): `tax` — the VAT rate, the third-party tax table, the tax category.
 * Nexus sends nothing new there. Everything else eBay holds (store categories, second category, product safety and
 * producer responsibility data, lot size, charity, hidden buyer details, listing duration, …) is sent back unchanged.
 */
export function offerUpdateBody(live: unknown, ours: VariationOfferOurs): Record<string, unknown> {
  const {
    offerId: _offerId, status: _status, listing: _listing, listingDescription: _description,
    // Replaced below by `offerQuantityLimit`, which keeps eBay's limit only when it is one eBay can take back.
    quantityLimitPerBuyer: _limit,
    ...held
  } = isRecord(live) ? live : {}
  const { bestOfferTerms: _bestOffer, ...heldPolicies } = isRecord(held.listingPolicies) ? held.listingPolicies : {}
  const heldPricing = isRecord(held.pricingSummary) ? held.pricingSummary : {}
  const fresh = newOfferBody({ ...ours, quantityLimitPerBuyer: null })
  return {
    ...held,
    ...fresh,
    pricingSummary: { ...heldPricing, ...(fresh.pricingSummary as Record<string, unknown>) },
    listingPolicies: { ...heldPolicies, ...(fresh.listingPolicies as Record<string, unknown>) },
    ...offerQuantityLimit(ours.quantityLimitPerBuyer, live),
  }
}
