import type { Decimal } from '../../tax/decimal'

/**
 * Formats and text rules of the FatturaPA schema (VFPR12 v1.2.3): numbers with a dot and fixed decimals, ISO dates,
 * and the two character sets the schema allows.
 */

/** Amount2DecimalType: [-]digits.dd */
export function formatAmount(value: Decimal): string {
  return value.toFixed(2)
}

/** Amount8DecimalType / QuantitaType: 2 to 8 decimals, as many as the value has. */
export function formatPrice(value: Decimal): string {
  return value.toFixed(Math.min(8, Math.max(2, value.decimalPlaces())))
}

/** RateType: a percentage, 22 -> "22.00". */
export function formatRate(value: Decimal): string {
  return value.toFixed(2)
}

/** "2026-10-31" -> "31/10/2026", for text read by people. */
export function formatDateIt(date: string): string {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** A real calendar date written YYYY-MM-DD, from 1970 (DataFatturaType's lower bound) to 2099. */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(19[7-9]\d|20\d\d)-(\d\d)-(\d\d)$/.exec(value)
  if (!match) return false
  const year = parseInt(match[1]!, 10)
  const month = parseInt(match[2]!, 10)
  const day = parseInt(match[3]!, 10)
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= lengths[month - 1]!
}

/** "YYYY-MM" of a date. */
export function monthOf(date: string): string {
  return date.slice(0, 7)
}

/** The 15th of the month after the date's month: the last day to issue a deferred invoice (art. 21 c.4). */
export function fifteenthOfNextMonth(date: string): string {
  const year = parseInt(date.slice(0, 4), 10)
  const month = parseInt(date.slice(5, 7), 10)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-15`
}

/** Printable ASCII only (the schema's \p{IsBasicLatin} types, without control characters). */
export function isBasicLatinText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/** Printable Latin-1 (the schema's *LatinType types, without control characters). */
export function isLatin1Text(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || (code > 0x7e && code < 0xa0) || code > 0xff) return false
  }
  return true
}

/** The first character a Latin-1 field cannot carry, for the error message. */
export function firstNonLatin1(value: string): string | null {
  for (const char of value) {
    if (!isLatin1Text(char)) return char
  }
  return null
}

/** Splits text into pieces of at most `size` characters (Causale is repeated per 200 characters). */
export function chunkText(value: string, size: number): string[] {
  const pieces: string[] = []
  for (let start = 0; start < value.length; start += size) pieces.push(value.slice(start, start + size))
  return pieces
}
