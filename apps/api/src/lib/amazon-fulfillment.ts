import { hasFbaFulfilmentCode } from './amazon-fulfilment-programme.js'

/** One fail-closed FBA predicate for offer controls and outbound quantity.
 * Explicit FBM never cancels positive Amazon-managed fulfilment evidence. Any fulfilment code that starts with
 * `AMAZON` (FBA, Remote Fulfilment, VCS), in EITHER place a listing stores one and in ANY entry, is that evidence. */
export function isFbaCoordinate(
  listing: { fulfillmentMethod?: string | null; platformAttributes?: any; product?: { fulfillmentMethod?: string | null } | null } | null | undefined,
  product: { fulfillmentMethod?: string | null } | null | undefined = listing?.product,
  evidence?: { fbaStockQty?: number | null; hasActiveFbaOffer?: boolean | null },
): boolean {
  return String(listing?.fulfillmentMethod ?? '').toUpperCase() === 'FBA' ||
    hasFbaFulfilmentCode(listing?.platformAttributes) || String(product?.fulfillmentMethod ?? '').toUpperCase() === 'FBA' ||
    (evidence?.fbaStockQty != null && evidence.fbaStockQty > 0) || evidence?.hasActiveFbaOffer === true
}
