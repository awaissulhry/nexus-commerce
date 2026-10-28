import { INTL_LOCALE, type Locale } from './locales'

/**
 * Numbers, dates and times as the person reads them (PLT-134, PLT-135). The API stores and sends instants in UTC
 * (ISO 8601); a screen shows them in the SITE's time zone (the company's `timezone`, Europe/Rome by default), never
 * the browser's: two people looking at one work order see the same time. Italian: decimal comma, `28/10/2026`.
 * English: European order too (`28/10/2026`, 24-hour clock), with a decimal point.
 */

export const DEFAULT_TIME_ZONE = 'Europe/Rome'

export interface FormatPlace {
  locale: Locale
  /** IANA name; the site's. */
  timeZone?: string
}

const toDate = (value: Date | string | number): Date => (value instanceof Date ? value : new Date(value))

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], options).format(value)
}

/** `28/10/2026` */
export function formatDate(value: Date | string | number, { locale, timeZone = DEFAULT_TIME_ZONE }: FormatPlace): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(toDate(value))
}

/** `14:05` */
export function formatTime(value: Date | string | number, { locale, timeZone = DEFAULT_TIME_ZONE }: FormatPlace): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(toDate(value))
}

/** `28/10/2026, 14:05` */
export function formatDateTime(value: Date | string | number, place: FormatPlace): string {
  return `${formatDate(value, place)}, ${formatTime(value, place)}`
}
