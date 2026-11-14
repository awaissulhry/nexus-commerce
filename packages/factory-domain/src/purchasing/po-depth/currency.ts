import { fitsDecimal, fromMinorUnits, isCurrencyCode, toMinorUnits, type CurrencyCode, type MinorUnits } from '../../core/money'
import { Dec, parseDecimal } from '../../tax/decimal'
import type { DepthCheck } from './codes'

/**
 * A purchase order in the supplier's currency (B-W2b-296; SCM-065; factory-db supply.prisma PurchaseOrder.rateAtOrder,
 * companyNetAmount), pure.
 *
 *   rate      an order in a currency other than its company's carries the rate at order: how many units of the order's
 *             currency one unit of the company's buys, as the ECB quotes it (1 EUR = 1.0850 USD), above 0 with at most
 *             eight decimals. Typed by the buyer while the order is a DRAFT; with none typed the send takes the day's rate of
 *             the rates table (B-W2b-389, CY1:01: the typed rate stays the override).
 *             An order in the company's own currency has none.
 *   value     the order's net amount in the company's currency at that rate (net ÷ rate, rounded half up to the company
 *             currency's minor unit: one rounding), kept current while the order is a draft and frozen with the send.
 *             It is a cost (the cost grain), as the net amount is.
 *   send      an order in another currency without its rate is not sent: its value in the company's books must be known
 *             at order (GATE-ACCOUNTANT: the rate at order is the default; the rate at the invoice is the accountant's
 *             answer, and the invoice's own matter).
 */

/** Decimal(18, 8): the column's shape. */
export const RATE = { precision: 18, scale: 8 } as const

/** Why a typed rate cannot be stored, or null. */
export function rateProblem(rate: string): string | null {
  const parsed = parseDecimal(rate)
  if (parsed === null || !fitsDecimal(rate.trim(), RATE.precision, RATE.scale)) return 'A rate is a plain decimal with at most eight decimals (1.0850).'
  if (!parsed.greaterThan(0)) return 'A rate is above 0.'
  return null
}

/** The order's net amount (minor units of its currency) in the company's currency at the rate at order (minor units). */
export function companyValueOf(netAmount: MinorUnits, orderCurrency: CurrencyCode, rate: string, companyCurrency: CurrencyCode): MinorUnits {
  return toMinorUnits(fromMinorUnits(netAmount, orderCurrency).dividedBy(new Dec(rate)), companyCurrency)
}

/** Whether the order takes a rate: its currency is not its company's. */
export const takesRate = (orderCurrency: string, companyCurrency: string): boolean => isCurrencyCode(orderCurrency) && orderCurrency !== companyCurrency

/** The rate in words: "1 EUR = 1.085 USD". */
export const rateWords = (rate: string, orderCurrency: string, companyCurrency: string): string => `1 ${companyCurrency} = ${new Dec(rate).toString()} ${orderCurrency}`

/** The send's check of the order's currency (no rate: the send stops). */
export function currencyChecks(order: { readonly currency: string; readonly rateAtOrder: string | null }, companyCurrency: string): DepthCheck[] {
  if (!takesRate(order.currency, companyCurrency) || order.rateAtOrder !== null) return []
  return [{ code: 'NO_RATE_AT_ORDER', severity: 'BLOCKS', path: 'rateAtOrder', message: `The order is in ${order.currency} and the company keeps its books in ${companyCurrency}, and no rate of the day is kept: type the rate at order (1 ${companyCurrency} = … ${order.currency}), or keep the day's rate in Finance › Settings › Currencies & rates (B-W2b-389: the day's rate is taken by default).` }]
}
