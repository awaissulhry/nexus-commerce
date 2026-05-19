/**
 * Derives the effective fulfillment method for a product, in this
 * priority order:
 *
 *   1. Active Offers — the authoritative model. If the product has
 *      both FBA + FBM offers live, the answer is "BOTH".
 *   2. StockLevel locations — when offers haven't been ingested yet,
 *      infer from where stock physically lives (AMAZON_FBA bucket vs.
 *      everything else). Mirrors the logic used by /api/stock.
 *   3. Product.fulfillmentMethod — legacy seed/default field. Used
 *      only when neither offers nor stock signal anything.
 *   4. null — we genuinely don't know yet.
 *
 * Pure function; no I/O. Callers do the queries and pass the buckets
 * in. Returning null is preferred over guessing — the UI surfaces
 * "Set FBA/FBM" prompts when null.
 */
export type FulfillmentMethod = 'FBA' | 'FBM' | 'BOTH' | null

export type FulfillmentDerivationInput = {
  /** distinct fulfillment methods seen on active Offers for this product */
  offerMethods?: Set<'FBA' | 'FBM'>
  /** stock bucketed: fba = AMAZON_FBA location qty, non = everything else */
  stock?: { fba: number; non: number }
  /** Product.fulfillmentMethod — used only as last-resort fallback */
  fallback?: 'FBA' | 'FBM' | null
}

export function deriveFulfillmentMethod(
  input: FulfillmentDerivationInput,
): FulfillmentMethod {
  const offers = input.offerMethods
  if (offers && offers.size > 0) {
    const fba = offers.has('FBA')
    const fbm = offers.has('FBM')
    if (fba && fbm) return 'BOTH'
    if (fba) return 'FBA'
    return 'FBM'
  }

  const stock = input.stock
  if (stock && (stock.fba > 0 || stock.non > 0)) {
    if (stock.fba > 0 && stock.non > 0) return 'BOTH'
    if (stock.fba > 0) return 'FBA'
    return 'FBM'
  }

  return input.fallback ?? null
}
