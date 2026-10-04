/**
 * Ads fix 7d (review I.1) — the rules grid under the header's market picker.
 *
 * Every rule-type tab has a market picker that wrote `?market=`, and the rules grid never read it: "Germany" listed
 * the same rules as "All markets". Now the grid reads it, by the evaluator's own test (`automation-rule-scope.ts`:
 * a rule fires on a context when its `scopeMarketplace` is null or equals the context's marketplace):
 *  · no market picked — every rule is listed;
 *  · one market picked — the rules scoped to that market, and the rules with no market (they can act in every market),
 *    are listed. A rule with no market carries the "All markets" chip there.
 *
 * 🔴 A rule is never hidden without a word. The only rule left out is one scoped to a DIFFERENT market, and `hidden`
 * counts them; the grid states that count above the rows with a "Show all markets" button whenever it is above 0. The
 * tab badge keeps counting every rule.
 */

export interface MarketScoped {
  /** The rule's `scopeMarketplace`; null when the rule sets no market. */
  market: string | null
}

/** The rows to list for the picked market, and how many rules of another market were left out. */
export function rulesForMarket<T extends MarketScoped>(rows: T[], market: string | null | undefined): { shown: T[]; hidden: number } {
  if (!market || market === 'all') return { shown: rows, hidden: 0 }
  const shown = rows.filter((r) => !r.market || r.market === market)
  return { shown, hidden: rows.length - shown.length }
}

/** The chip on a rule with no market while one market is picked. */
export const ANY_MARKET_CHIP = 'All markets'
export const ANY_MARKET_WHY = 'This rule sets no market. It can act in every market its campaigns reach, so it is listed under each market.'

/** The line above the grid when rules of another market are left out. */
export function hiddenRulesLine(hidden: number, market: string, nounLower: string): string {
  const one = hidden === 1
  return `${hidden} ${nounLower}${one ? '' : 's'} ${one ? 'is' : 'are'} set to another market, so ${one ? 'it is' : 'they are'} not listed under ${market}.`
}
