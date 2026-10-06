/**
 * AM-21 — never add two currencies.
 *
 * eBay reports each market in its own currency (EBAY_GB in GBP, the other markets in EUR). Rows already render in their
 * own currency; totals used to add every row's minor units together and print the sum in euros, so a UK campaign's
 * pence were counted as cents. These helpers keep one total per currency and print them side by side
 * ("€12.00 · £3.50"). Nothing is converted: there is no exchange rate here.
 */
import { money } from '../../campaigns/_grid/format'

export interface CurrencyTotal {
  currency: string
  feesCents: number
  salesCents: number
}

/** One fees/sales total per currency, the largest fees first. A row with no currency counts as EUR, as rows render. */
export function currencyTotals<T>(
  rows: readonly T[],
  currencyOf: (row: T) => string | null | undefined,
  feesOf: (row: T) => number,
  salesOf: (row: T) => number,
): CurrencyTotal[] {
  const by = new Map<string, CurrencyTotal>()
  for (const row of rows) {
    const currency = currencyOf(row) || 'EUR'
    const t = by.get(currency) ?? { currency, feesCents: 0, salesCents: 0 }
    t.feesCents += feesOf(row)
    t.salesCents += salesOf(row)
    by.set(currency, t)
  }
  return [...by.values()].sort((a, b) => b.feesCents - a.feesCents || a.currency.localeCompare(b.currency))
}

/** "€12.00 · £3.50": one amount per currency, never one sum. No rows: zero in EUR. */
export function moneyPerCurrency(totals: readonly CurrencyTotal[], pick: (t: CurrencyTotal) => number): string {
  if (totals.length === 0) return money(0, 'EUR')
  return totals.map((t) => money(pick(t), t.currency)).join(' · ')
}

/**
 * A ratio (ACOS, ROAS) per currency. One currency: just the value. Several: "EUR 9.00% · GBP 12.50%", because a ratio
 * over added GBP and EUR amounts would be neither market's number.
 */
export function ratioPerCurrency(
  totals: readonly CurrencyTotal[],
  ratio: (t: CurrencyTotal) => number | null,
  format: (value: number) => string,
): string {
  const show = (t: CurrencyTotal) => { const v = ratio(t); return v == null || !Number.isFinite(v) ? '—' : format(v) }
  if (totals.length === 0) return '—'
  if (totals.length === 1) return show(totals[0])
  return totals.map((t) => `${t.currency} ${show(t)}`).join(' · ')
}
