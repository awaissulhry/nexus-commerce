import type { Locale } from '../../i18n/locales'
import { dayOf, shortDateOf } from '../parts/time'

/**
 * fx5w (walk W-11): a day as the app writes it — "29 Oct" (another year adds it: "31 Dec 2036") — in the company's time zone, for the
 * order's Files tab, its windows and its asks (never "29/10/2026"). `now` for a test.
 */
export function dayWords(at: string, locale: Locale, now: Date = new Date()): string {
  return shortDateOf(at, locale, dayOf(now))
}
