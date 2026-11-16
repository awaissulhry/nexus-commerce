import { businessDate, BUSINESS_TIME_ZONE } from '@nexus/factory-domain/core/time'
import { INTL_LOCALE, type Locale } from '../../i18n/locales'

/**
 * Time in the record thread (B-TH-204, T4-F03): a message's day and time are the COMPANY's (Europe/Rome unless it says
 * otherwise), so "Yesterday" means the same day for everyone who reads the thread; the words are the reader's language.
 */

export const THREAD_TIME_ZONE = BUSINESS_TIME_ZONE

/** The company day of an instant, `YYYY-MM-DD`. */
export const dayOf = (at: string | Date, timeZone: string = THREAD_TIME_ZONE): string => businessDate(typeof at === 'string' ? new Date(at) : at, timeZone)

/** The day before a company day. */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  const previous = new Date(Date.UTC(year, month - 1, date - 1, 12))
  return previous.toISOString().slice(0, 10)
}

/** How a day line reads: Today, Yesterday, or the weekday and date ("Friday 13 Nov"; a past year adds it). */
export type DayWord = { kind: 'today' } | { kind: 'yesterday' } | { kind: 'date'; text: string }

export function dayWord(day: string, today: string, locale: Locale): DayWord {
  if (day === today) return { kind: 'today' }
  if (day === dayBefore(today)) return { kind: 'yesterday' }
  const [year, month, date] = day.split('-').map(Number)
  const noon = new Date(Date.UTC(year, month - 1, date, 12))
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  const text = new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(noon)
  return { kind: 'date', text: text.replace(/,/g, '') }
}

/** A message's time of day, `09:12`, in the company's time zone. */
export function timeOf(at: string, locale: Locale, timeZone: string = THREAD_TIME_ZONE): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at))
}

/** A short date, `12 Nov` (a past year adds it), in the company's time zone. */
export function shortDateOf(at: string, locale: Locale, today: string, timeZone: string = THREAD_TIME_ZONE): string {
  const sameYear = dayOf(at, timeZone).slice(0, 4) === today.slice(0, 4)
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(new Date(at))
}
