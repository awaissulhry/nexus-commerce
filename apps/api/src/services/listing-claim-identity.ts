/**
 * BP.S3 — the seller identity a claim is keyed on.
 *
 * Deliberately the SAME rule as `sellerSkuForDelist` in outbound-enqueue.ts: the
 * coordinate a publish reserves must be the coordinate a delist releases, and a
 * second, slightly different derivation one file away is how those two drift apart
 * until a release frees a coordinate nobody was holding.
 *
 * It is extracted rather than imported from there only to keep the claim service
 * free of the outbound module's queue imports; the rule itself is one function.
 */
export function sellerSkuForClaim(listing: {
  product?: { sku: string | null } | null
  offers?: Array<{ sku: string; fulfillmentMethod: string; isActive: boolean }>
}): string | null {
  const skus = [...new Set((listing.offers ?? [])
    .filter(offer => offer.isActive)
    .map(offer => offer.sku)
    .filter(sku => typeof sku === 'string' && sku.trim()))]
  // Two live seller identities cannot name one coordinate — the same refusal
  // `sellerSkuForDelist` makes, for the same reason.
  if (skus.length > 1) return null
  return skus[0] ?? (listing.product?.sku?.trim() ? listing.product.sku : null)
}
