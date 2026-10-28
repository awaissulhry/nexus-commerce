import { fromMinorUnits, isCurrencyCode, minorPlaces, type CurrencyCode, type DecimalString, type MinorUnits } from '../core/money'
import { isBusinessDate, type BusinessDate } from '../core/time'
import { parseDecimal } from '../tax/decimal'
import type { DocumentLanguage } from './model'

/**
 * How numbers, money, dates and times read on a printed document, per language (pure; decimal strings, never floats):
 *
 *            number      money        date          date and time
 *   it       1.234,5     € 1.234,50   28/10/2026    28/10/2026 14:30
 *   en       1,234.5     €1,234.50    28 Oct 2026   28 Oct 2026, 14:30
 *
 * Intl is used only for the wall clock of an instant in a time zone; numbers are grouped here, from decimal strings.
 */

const SEPARATORS: Readonly<Record<DocumentLanguage, { readonly group: string; readonly decimal: string }>> = {
  it: { group: '.', decimal: ',' },
  en: { group: ',', decimal: '.' },
}
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const SYMBOLS: Readonly<Record<string, string>> = { EUR: '€', USD: '$', GBP: '£' }

/** Groups the integer digits of a plain decimal string ("-1234.50") with the language's separators. */
function grouped(fixed: string, language: DocumentLanguage): string {
  const { group, decimal } = SEPARATORS[language]
  const negative = fixed.startsWith('-')
  const [integer = '0', fraction] = (negative ? fixed.slice(1) : fixed).split('.')
  const digits = integer.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  return `${negative ? '-' : ''}${digits}${fraction === undefined ? '' : `${decimal}${fraction}`}`
}

/**
 * A decimal with at least `minPlaces` and at most `maxPlaces` decimals (trailing zeros beyond the minimum dropped),
 * rounded half up. Throws a TypeError for a value that is not a plain decimal.
 */
export function formatDecimal(value: DecimalString, language: DocumentLanguage, minPlaces = 0, maxPlaces = 4): string {
  const decimal = parseDecimal(value)
  if (decimal === null) throw new TypeError(`not a plain decimal: ${String(value)}`)
  let fixed = decimal.toFixed(maxPlaces)
  if (maxPlaces > minPlaces && fixed.includes('.')) {
    const [integer, fraction = ''] = fixed.split('.')
    let kept = fraction
    while (kept.length > minPlaces && kept.endsWith('0')) kept = kept.slice(0, -1)
    fixed = kept === '' ? integer! : `${integer}.${kept}`
  }
  if (/^-0(?:\.0*)?$/.test(fixed)) fixed = fixed.slice(1)
  return grouped(fixed, language)
}

/** A quantity: up to 4 decimals, none when whole ("12", "12,5", "0,0929"). */
export const formatQuantity = (value: DecimalString, language: DocumentLanguage): string => formatDecimal(value, language, 0, 4)

/** A unit price: 2 to 6 decimals ("12,50", "0,8125"). */
export const formatUnitPrice = (value: DecimalString, language: DocumentLanguage): string => formatDecimal(value, language, 2, 6)

/** A percentage ("22%", "12,5%"). */
export const formatPercent = (value: DecimalString, language: DocumentLanguage): string => `${formatDecimal(value, language, 0, 2)}%`

/** The currency's sign: € $ £, or its code. */
export function currencySign(currency: CurrencyCode): string {
  if (!isCurrencyCode(currency)) throw new RangeError(`not a currency code: ${String(currency)}`)
  return SYMBOLS[currency] ?? currency
}

/** Money with its sign, at the currency's minor places: "€ 1.234,50" (it), "€1,234.50" (en), "CHF 10.00". */
export function formatMoney(amountMinor: MinorUnits, currency: CurrencyCode, language: DocumentLanguage): string {
  const places = minorPlaces(currency)
  const fixed = fromMinorUnits(amountMinor, currency).toFixed(places)
  return withSign(grouped(fixed, language), currency, language)
}

/** A decimal amount in major units (a share capital) with its sign, at the currency's minor places. */
export function formatMajorAmount(value: DecimalString, currency: CurrencyCode, language: DocumentLanguage): string {
  return withSign(formatDecimal(value, language, minorPlaces(currency), minorPlaces(currency)), currency, language)
}

function withSign(number: string, currency: CurrencyCode, language: DocumentLanguage): string {
  const sign = currencySign(currency)
  const negative = number.startsWith('-')
  const digits = negative ? number.slice(1) : number
  const symbolOnly = sign.length === 1
  const joined = language === 'en' && symbolOnly ? `${sign}${digits}` : `${sign} ${digits}`
  return negative ? `-${joined}` : joined
}

/** A business date: "28/10/2026" (it), "28 Oct 2026" (en). */
export function formatDate(date: BusinessDate, language: DocumentLanguage): string {
  if (!isBusinessDate(date)) throw new RangeError(`not a business date: ${String(date)}`)
  const [year, month, day] = date.split('-') as [string, string, string]
  if (language === 'it') return `${day}/${month}/${year}`
  return `${Number.parseInt(day, 10)} ${MONTHS_EN[Number.parseInt(month, 10) - 1]} ${year}`
}

const clocks = new Map<string, Intl.DateTimeFormat>()

/** The wall-clock date (`YYYY-MM-DD`) and time (`HH:mm`) of an instant in a time zone. */
export function wallClockOf(instant: Date, timeZone: string): { date: BusinessDate; time: string } {
  if (!Number.isFinite(instant.getTime())) throw new RangeError('invalid instant')
  let clock = clocks.get(timeZone)
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    clocks.set(timeZone, clock)
  }
  const parts = Object.fromEntries(clock.formatToParts(instant).map((part) => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** An instant as the date and time on the wall in the zone: "28/10/2026 14:30" (it), "28 Oct 2026, 14:30" (en). */
export function formatDateTime(instant: Date, timeZone: string, language: DocumentLanguage): string {
  const { date, time } = wallClockOf(instant, timeZone)
  return language === 'it' ? `${formatDate(date, language)} ${time}` : `${formatDate(date, language)}, ${time}`
}
