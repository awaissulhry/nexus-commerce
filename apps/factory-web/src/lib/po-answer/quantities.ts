import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { Locale } from '../i18n/locales'

/**
 * Quantities and days as a supplier types and reads them (B-W1-31's PO link; shared through src/lib since B-W2b-179 with the
 * supplier portal's answer: a view never imports another view): "1.200,5" in Italian and "1,200.5" in English read into the API's plain decimal, the API's four places
 * written back without trailing zeros, the supplier's today in Rome.
 */

/**
 * A quantity as the API takes it ("1200.5"), from what a person typed in the page's language: "1.200,5" or "1200,5"
 * in Italian, "1,200.5" or "1200.5" in English; spaces ignored. Null when it is no number.
 */
export function plainQuantity(typed: string, locale: Locale): string | null {
  let text = typed.replace(/[\s  ']/g, '')
  if (text === '') return null
  if (locale === 'it') {
    if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.')
    else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, '')
  } else {
    text = text.replace(/,/g, '')
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return new Dec(text).toString()
}

/** A quantity of the API ("1200.0000") as the page shows it in the reader's language. */
export function quantityShown(value: string, locale: Locale): string {
  const decimal = new Dec(value)
  const places = Math.min(4, Math.max(0, decimal.decimalPlaces()))
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { minimumFractionDigits: 0, maximumFractionDigits: places }).format(decimal.toNumber())
}

/** The same quantity in the form a person types it in the page's language (a draft starts from it). */
export function quantityTyped(value: string, locale: Locale): string {
  const plain = new Dec(value).toDecimalPlaces(4).toString()
  return locale === 'it' ? plain.replace('.', ',') : plain
}

/** `today` + days, ISO. */
export function addDaysIso(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The day in a zone (the supplier's today as the API counts it). */
export function dayIn(now: Date, timeZone = 'Europe/Rome'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
