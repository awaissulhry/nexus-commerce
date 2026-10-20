/**
 * Meta ads M1 — the windows of the read, in the AD ACCOUNT's time zone (Meta's insight days — `date_start` of a
 * one-day row — are days in the account's `timezone_name`). The day arithmetic is the same pure code as Google's.
 *
 *   daily     the last 28 account days, ending yesterday (never today: today is still moving). Meta attributes a
 *             purchase to the day of the ad's impression up to its attribution window later (default 7-day click,
 *             1-day view), so recent days change for a week or more: 28 days re-read covers them
 *   backfill  180 days ending yesterday, once, on the first read, in pieces of 30 days (one insights read each)
 */
import { addDays, accountToday, accountYesterday, chunkWindow, dateToDay, dayCount, dayToDate, daysOf, type DayWindow } from '../google-ads/dates.js'

export { addDays, accountToday, accountYesterday, chunkWindow, dateToDay, dayCount, dayToDate, daysOf, type DayWindow }

export const META_DAILY_WINDOW_DAYS = 28
export const META_BACKFILL_DAYS = 180
export const META_INSIGHTS_CHUNK_DAYS = 30

/** The daily re-read: 28 account days ending yesterday. */
export function metaDailyWindow(timeZone: string, now: Date = new Date()): DayWindow {
  const to = accountYesterday(timeZone, now)
  return { from: addDays(to, -(META_DAILY_WINDOW_DAYS - 1)), to }
}

/** The first read: 180 account days ending yesterday. */
export function metaBackfillWindow(timeZone: string, now: Date = new Date()): DayWindow {
  const to = accountYesterday(timeZone, now)
  return { from: addDays(to, -(META_BACKFILL_DAYS - 1)), to }
}

/**
 * The window to read now: the daily window, reaching back to the day after the last day read when runs were missed
 * (never past the backfill's 180 days).
 */
export function metaReadWindow(timeZone: string, now: Date, readThrough: string | null): DayWindow {
  const daily = metaDailyWindow(timeZone, now)
  if (!readThrough) return daily
  const next = addDays(readThrough, 1)
  if (next >= daily.from) return daily
  const oldest = metaBackfillWindow(timeZone, now).from
  return { from: next > oldest ? next : oldest, to: daily.to }
}
