import { Dec, parseDecimal, type Decimal } from '../tax/decimal'

/**
 * Money and quantity types (plan A1 §2.1). Never a float:
 *   - an amount is an integer count of minor units (cents) of the document's currency, a PostgreSQL `Int`;
 *   - a unit price or a unit cost is a decimal with up to 6 places, `Decimal(18,6)`;
 *   - a quantity is a decimal with up to 4 places, `Decimal(18,4)`, always with its unit.
 * In contracts and JSON, decimals travel as plain decimal strings ("12.500000"), never as JSON numbers.
 * The decimal arithmetic itself is `../tax/decimal` (`Dec`, half-up rounding).
 */

/** ISO 4217 alphabetic code, e.g. EUR. */
export type CurrencyCode = string

/** Minor units, e.g. 1250 = €12.50. A safe integer inside PostgreSQL's Int range. */
export type MinorUnits = number

export interface Money {
  readonly amountMinor: MinorUnits
  readonly currency: CurrencyCode
}

/** A plain decimal string: digits, an optional dot and decimals, an optional leading minus. */
export type DecimalString = string

const CURRENCY = /^[A-Z]{3}$/
export const INT_MIN = -2_147_483_648
export const INT_MAX = 2_147_483_647

/** Places of the minor unit; 2 unless listed (ISO 4217). */
const MINOR_PLACES: Readonly<Record<string, number>> = {
  BHD: 3,
  CLP: 0,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  OMR: 3,
  TND: 3,
  VND: 0,
}

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && CURRENCY.test(value)
}

export function minorPlaces(currency: CurrencyCode): number {
  if (!isCurrencyCode(currency)) throw new RangeError(`not a currency code: ${String(currency)}`)
  return MINOR_PLACES[currency] ?? 2
}

export function isMinorUnits(value: unknown): value is MinorUnits {
  return typeof value === 'number' && Number.isInteger(value) && value >= INT_MIN && value <= INT_MAX
}

/**
 * A decimal amount in major units (12.505 EUR) to minor units, rounded half up at the minor unit (the one rounding
 * point, A1 §2.1). Refuses an amount outside PostgreSQL's Int range.
 */
export function toMinorUnits(amount: Decimal | DecimalString, currency: CurrencyCode): MinorUnits {
  const value = parseDecimal(amount)
  if (value === null) throw new TypeError(`not a plain decimal: ${String(amount)}`)
  const minor = value.times(new Dec(10).pow(minorPlaces(currency))).toDecimalPlaces(0, Dec.ROUND_HALF_UP)
  if (minor.lessThan(INT_MIN) || minor.greaterThan(INT_MAX)) throw new RangeError('amount outside the Int range')
  return Number.parseInt(minor.toFixed(0), 10)
}

/** Minor units back to a decimal in major units (1250 EUR → 12.50). */
export function fromMinorUnits(amountMinor: MinorUnits, currency: CurrencyCode): Decimal {
  if (!isMinorUnits(amountMinor)) throw new RangeError(`not an amount in minor units: ${String(amountMinor)}`)
  return new Dec(amountMinor).dividedBy(new Dec(10).pow(minorPlaces(currency)))
}

/** A decimal string fits `Decimal(precision, scale)`: at most `scale` places and `precision - scale` integer digits. */
export function fitsDecimal(value: unknown, precision: number, scale: number): value is DecimalString {
  if (typeof value !== 'string') return false
  const match = /^-?(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) return false
  const integer = match[1]!.replace(/^0+(?=\d)/, '')
  return integer.length <= precision - scale && (match[2]?.length ?? 0) <= scale
}

/** Unit price or unit cost: Decimal(18,6). */
export const UNIT_PRICE = { precision: 18, scale: 6 } as const
/** Quantity: Decimal(18,4). */
export const QUANTITY = { precision: 18, scale: 4 } as const
