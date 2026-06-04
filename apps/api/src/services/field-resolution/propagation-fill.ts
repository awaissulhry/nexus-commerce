/**
 * FM.5 — shared propagation helpers.
 *
 * The currency-guard primitives used by BOTH the FL field-link propagation
 * previews (field-links.routes) and the FM.5 catalog propagation planner
 * (mapping-propagation.service). Copying a raw price across currencies
 * (€50 → £50) is wrong, so cross-currency price targets are flagged +
 * skipped rather than propagated.
 */

// Price fields whose values are currency-bound — never copy verbatim
// across markets in different currencies.
export const PRICE_FIELD_KEYS = new Set(['our_price', 'price', 'purchasable_offer.our_price'])

export function currencyForMarket(mp: string): string {
  const m = (mp ?? '').toUpperCase()
  if (m === 'UK' || m === 'GB') return 'GBP'
  if (m === 'US') return 'USD'
  if (m === 'JP') return 'JPY'
  return 'EUR'
}

/**
 * For a price field, mark any target whose currency differs from the
 * source as a skipped "currency mismatch" so the operator sets it manually
 * (or via FX) instead of copying the wrong number. No-op for non-price
 * fields and same-currency targets. Generic over the entry shape used by
 * the FL propagation previews ({ marketplace, action }).
 */
export function guardCurrency<T extends { marketplace: string; action: string }>(
  entries: T[],
  fieldKey: string,
  sourceMarketplace: string,
): Array<T & { currencyMismatch?: boolean }> {
  if (!PRICE_FIELD_KEYS.has(fieldKey)) return entries
  const srcCurrency = currencyForMarket(sourceMarketplace)
  return entries.map((e) =>
    currencyForMarket(e.marketplace) !== srcCurrency
      ? { ...e, action: 'skip', currencyMismatch: true }
      : e,
  )
}
