/** One fail-closed FBA predicate for offer controls and outbound quantity.
 * Explicit FBM never cancels positive Amazon-managed fulfilment evidence. */
export function isFbaCoordinate(
  listing: { fulfillmentMethod?: string | null; platformAttributes?: any; product?: { fulfillmentMethod?: string | null } | null } | null | undefined,
  product: { fulfillmentMethod?: string | null } | null | undefined = listing?.product,
  evidence?: { fbaStockQty?: number | null; hasActiveFbaOffer?: boolean | null },
): boolean {
  const channel = String(listing?.platformAttributes?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase()
  return String(listing?.fulfillmentMethod ?? '').toUpperCase() === 'FBA' ||
    channel.startsWith('AMAZON') || String(product?.fulfillmentMethod ?? '').toUpperCase() === 'FBA' ||
    (evidence?.fbaStockQty != null && evidence.fbaStockQty > 0) || evidence?.hasActiveFbaOffer === true
}
