/**
 * CC-26 — "today" in an Amazon Ads account's own time zone. Pure.
 *
 * The Sponsored Brands and Display campaign creates send a start date. It was computed as the UTC date (`toISOString`)
 * for SB and as the server's local date for SD (the server runs in UTC), so between 00:00 and 02:00 Italian time
 * Amazon was handed yesterday's date — a start date in the past for that account. The date is now the calendar day in
 * the account's time zone (`ads-market-time.ts` finds it).
 */

export interface LocalDay { y: string; m: string; d: string }

/** The calendar day `at` falls on in `timeZone` (an IANA name); the UTC day when the zone is missing or unknown. */
export function localDay(at: Date, timeZone?: string | null): LocalDay {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
      const y = get('year'), m = get('month'), d = get('day')
      if (y && m && d) return { y, m, d }
    } catch { /* an unknown zone falls through to UTC */ }
  }
  return { y: String(at.getUTCFullYear()), m: String(at.getUTCMonth() + 1).padStart(2, '0'), d: String(at.getUTCDate()).padStart(2, '0') }
}

/** `YYYY-MM-DD` (Sponsored Brands v4). */
export const isoDayIn = (at: Date, timeZone?: string | null): string => { const { y, m, d } = localDay(at, timeZone); return `${y}-${m}-${d}` }
/** `YYYYMMDD` (Sponsored Display). */
export const compactDayIn = (at: Date, timeZone?: string | null): string => { const { y, m, d } = localDay(at, timeZone); return `${y}${m}${d}` }

/** True when the runtime knows this IANA zone. */
export function isKnownTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone }); return true } catch { return false }
}
