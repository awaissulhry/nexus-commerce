import type { BusinessDate } from '../core/time'

/**
 * The periods of the accounting exports and the period locks (B-W2a-39; design finance.accounting "1 · Period", "5 ·
 * Export and lock"): whole months of Europe/Rome days, written `YYYY-MM`. The database holds the same rule (the
 * …_money_w2a_guards' factory_money_whole_months): a period runs from the first day of a month to the last day of a
 * month. The API exports and locks one month at a time.
 *
 * The year end: the last day of the month before the company's fiscal year starts (Company.fiscalYearStartMonth, 1 by
 * default: 31 December, the day the year-end physical inventory is dated, c.c. art. 2217). The year-end stock pack goes
 * with the export of the month that ends on that day.
 *
 * The typed phrase of the final close (Owner answer P1: a typed phrase only for the monthly run and the final month
 * close): `close October 2026` in English or `chiudi ottobre 2026` in Italian, case and spaces as typed.
 */

export type Month = string
export const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/

export interface Period {
  readonly month: Month
  /** The first day. */
  readonly start: BusinessDate
  /** The last day. */
  readonly end: BusinessDate
}

export const isMonth = (value: unknown): value is Month => typeof value === 'string' && MONTH.test(value) && Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 2999

const pad = (value: number, size = 2): string => String(value).padStart(size, '0')

/** The number of days of a month of a year (Gregorian). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The period of a month: its first and last day. */
export function periodOfMonth(month: Month): Period {
  if (!isMonth(month)) throw new Error(`periodOfMonth(): ${JSON.stringify(month)} is not a month written YYYY-MM.`)
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  return { month, start: `${month}-01`, end: `${month}-${pad(daysInMonth(year, number))}` }
}

/** The month of a day (`2026-10-28` → `2026-10`). */
export const monthOfDay = (day: BusinessDate): Month => day.slice(0, 7)

/** The period whose first and last day these are, or null when they are not one whole month. */
export function periodOfDays(start: BusinessDate, end: BusinessDate): Period | null {
  const month = monthOfDay(start)
  if (!isMonth(month)) return null
  const period = periodOfMonth(month)
  return period.start === start && period.end === end ? period : null
}

/** The twelve months of a year. */
export const monthsOfYear = (year: number): Month[] => Array.from({ length: 12 }, (_, index) => `${year}-${pad(index + 1)}`)

/** A period is over once its last day is behind today (Europe/Rome). */
export const periodEnded = (period: Pick<Period, 'end'>, today: BusinessDate): boolean => today > period.end

/** The month of the year end: the month before the fiscal year starts (1 → 12, December). */
export function yearEndMonthNumber(fiscalYearStartMonth = 1): number {
  const start = Number.isInteger(fiscalYearStartMonth) && fiscalYearStartMonth >= 1 && fiscalYearStartMonth <= 12 ? fiscalYearStartMonth : 1
  return start === 1 ? 12 : start - 1
}

/** The period ends on the company's year end (31 December by default). */
export const isYearEndPeriod = (period: Period, fiscalYearStartMonth = 1): boolean => Number(period.month.slice(5, 7)) === yearEndMonthNumber(fiscalYearStartMonth)

const MONTH_NAMES = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
} as const

export type PeriodLanguage = keyof typeof MONTH_NAMES

/** `October 2026` / `ottobre 2026`. */
export function monthLabel(month: Month, language: PeriodLanguage = 'en'): string {
  return `${MONTH_NAMES[language][Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

/** The phrase that closes a month for good (a HARD lock), in each language. */
export function lockPhrases(month: Month): { readonly en: string; readonly it: string } {
  return { en: `close ${monthLabel(month, 'en')}`, it: `chiudi ${monthLabel(month, 'it')}` }
}

const folded = (text: string): string => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()

/** The typed phrase closes this month (either language; case and spaces as typed). */
export function phraseMatches(month: Month, typed: string | null | undefined): boolean {
  if (typeof typed !== 'string') return false
  const phrases = lockPhrases(month)
  return folded(typed) === folded(phrases.en) || folded(typed) === folded(phrases.it)
}
