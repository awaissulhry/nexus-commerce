import { marketCurrencyAcrossChannels, type MarketCurrencyRow } from '../pim/market-currency.js'
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

/**
 * P4.4a — REMOVED. This listed UK/US/JP and returned EUR for everything else,
 * so Poland (PLN), Sweden (SEK) and Turkey (TRY) all read as EUR and a price
 * copied into them looked same-currency. An identical function of the same name
 * lived in `listing-automation/triggers.ts`, neither importing the other.
 * Use `marketCurrencyAcrossChannels` with rows from `allMarketCurrencyRows()`.
 */

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
  /** P4.4a — the configured market currencies, loaded once by the caller
   *  (`allMarketCurrencyRows()`). Passed in so this stays a pure function. */
  currencyRows: readonly MarketCurrencyRow[],
): Array<T & { currencyMismatch?: boolean }> {
  if (!PRICE_FIELD_KEYS.has(fieldKey)) return entries
  // A market whose currency is not configured cannot be shown as a safe copy
  // target. Marking it a mismatch is the fail-closed answer: the operator sets
  // the price by hand instead of copying a number in the wrong currency.
  const currencyOf = (market: string): string | null => {
    try { return marketCurrencyAcrossChannels(market, currencyRows) } catch { return null }
  }
  const srcCurrency = currencyOf(sourceMarketplace)
  return entries.map((e) => {
    const target = currencyOf(e.marketplace)
    return srcCurrency === null || target === null || target !== srcCurrency
      ? { ...e, action: 'skip', currencyMismatch: true }
      : e
  })
}
