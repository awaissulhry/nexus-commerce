import { isCurrencyCode, minorPlaces } from '../../core/money'

/**
 * The currencies a company's documents may be in (B-W2b-389; PLT-132; factory-db currency.prisma Currency), pure.
 *
 *   base         the company's own currency (Company.currency, EUR for every Italian company): its books, its totals.
 *                It is always one of its document currencies and is never switched off.
 *   document     the other currencies its quotes, orders, purchase orders and invoices may be in: a Currency row per
 *                company and code, switched on or off (never deleted; switching an old row back on keeps its history).
 *   offered      the currencies with a daily ECB reference rate (the ECB's list, 2026: the euro area's partners; the
 *                Bulgarian lev left the list when Bulgaria joined the euro on 1 January 2026), so every one of them has a
 *                rate without typing; a manual rate per day can still be kept for each.
 *   minor units  ISO 4217's digits after the point (core/money minorPlaces: JPY, ISK, KRW 0; the rest 2), fixed with the row.
 *
 * Every money value stays minor units plus its currency (core/money); a total never adds two currencies (./totals).
 */

/** The ECB's reference-rate currencies (its daily file), in the ECB's order. */
export const ECB_CURRENCIES = [
  'USD',
  'JPY',
  'CZK',
  'DKK',
  'GBP',
  'HUF',
  'PLN',
  'RON',
  'SEK',
  'CHF',
  'ISK',
  'NOK',
  'TRY',
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'HKD',
  'IDR',
  'ILS',
  'INR',
  'KRW',
  'MXN',
  'MYR',
  'NZD',
  'PHP',
  'SGD',
  'THB',
  'ZAR',
] as const

/** The currencies a company may add: the euro and the ECB's list. */
export const OFFERED_CURRENCIES: readonly string[] = Object.freeze(['EUR', ...ECB_CURRENCIES])

/** The euro: the ECB's base, the currency of Italian books and of an invoice's euro total. */
export const EURO = 'EUR'

export const isOfferedCurrency = (code: string): boolean => OFFERED_CURRENCIES.includes(code)

/** Why a currency cannot be added to a company, or null. */
export function addCurrencyProblem(code: string, existing: readonly { readonly code: string; readonly active: boolean }[]): string | null {
  if (!isCurrencyCode(code)) return 'A currency is its ISO 4217 code: three capital letters (USD).'
  if (!isOfferedCurrency(code)) return `${code} has no ECB reference rate: the currencies offered are the euro and the ECB's (${ECB_CURRENCIES.join(', ')}).`
  if (existing.some((row) => row.code === code && row.active)) return `${code} is one of the company's currencies already.`
  return null
}

/** Why a document currency cannot be switched off, or null: the company's base currency always stays. */
export function switchOffProblem(code: string, baseCurrency: string): string | null {
  return code === baseCurrency ? `${code} is the company's own currency: it is never switched off.` : null
}

/** The minor units a new Currency row keeps (ISO 4217). */
export const minorUnitsOf = (code: string): number => minorPlaces(code)

/** Whether a document in `currency` is in a currency the company has switched on (its base currency always is). */
export function isDocumentCurrency(currency: string, baseCurrency: string, active: readonly string[]): boolean {
  return currency === baseCurrency || active.includes(currency)
}
