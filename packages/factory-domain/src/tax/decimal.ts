import { Decimal } from 'decimal.js'

/**
 * Decimal arithmetic for tax and invoice amounts. Never a JavaScript number: amounts arrive as a `Decimal` or as a
 * plain decimal string ("1234.50") and stay decimals until they are printed.
 *
 * `Dec` is a private clone of decimal.js, so the rounding set here never leaks into, or depends on, the global
 * `Decimal` configuration of another module.
 */
export const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 })

export type { Decimal }

/** What a caller may pass for an amount, a price, a quantity or a percentage: a decimal, or a plain decimal string. */
export type DecimalInput = Decimal | string

export const ZERO: Decimal = new Dec(0)
export const ONE_CENT: Decimal = new Dec('0.01')
export const HUNDRED: Decimal = new Dec(100)

const PLAIN_DECIMAL = /^-?\d{1,15}(\.\d{1,12})?$/

/**
 * Reads a decimal input. Strings must be plain decimals (digits, one optional dot, an optional leading minus): no
 * exponent, no thousands separator, no comma, no "Infinity". Returns null when the value is not a usable decimal.
 */
export function parseDecimal(value: unknown): Decimal | null {
  if (Decimal.isDecimal(value)) {
    const d = new Dec(value as Decimal)
    return d.isFinite() ? d : null
  }
  if (typeof value === 'string' && PLAIN_DECIMAL.test(value)) return new Dec(value)
  return null
}

/** Like parseDecimal, but throws on a bad value: for inputs that were validated before. */
export function toDecimal(value: DecimalInput): Decimal {
  const d = parseDecimal(value)
  if (d === null) throw new TypeError(`not a plain decimal: ${String(value)}`)
  return d
}

/**
 * Rounds to cents, half up: "per difetto se la terza cifra decimale è inferiore a 5, per eccesso se uguale o
 * superiore a 5" (FatturaPA technical rules, 2.2.2.6 Imposta). A negative amount rounds symmetrically (away from
 * zero on a half), so the deduction of an amount is the exact opposite of the amount.
 */
export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
}

/** Sum of decimals (0 for an empty list). */
export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(value), ZERO)
}
