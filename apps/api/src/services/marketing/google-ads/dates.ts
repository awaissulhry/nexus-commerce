/**
 * Google Ads step 1a — the windows of the read, in the ACCOUNT's time zone (Google's `segments.date` is a day in
 * `customer.time_zone`, and every custom date range is evaluated there). Pure: no clock is read unless `now` is
 * left out.
 *
 *   daily        the last 14 account days, ending yesterday (never today: today is still moving)
 *   weekly       35 days instead of 14 when the account's today is a Sunday (late conversions settle)
 *   backfill     400 days ending yesterday, once, on the first read
 *   changes      Google's change history keeps 30 days: a read starts 10 minutes before where the last one stopped,
 *                and never before the first instant of the account day 29 days ago
 *
 * A day travels as "YYYY-MM-DD"; a @db.Date column takes it as UTC midnight (`dayToDate`).
 */

export interface DayWindow {
  /** First day, included. */
  from: string
  /** Last day, included. */
  to: string
}

export const DAILY_WINDOW_DAYS = 14
export const SUNDAY_WINDOW_DAYS = 35
export const BACKFILL_DAYS = 400
export const CHANGE_HISTORY_DAYS = 30
export const CHANGE_HISTORY_OVERLAP_MS = 10 * 60_000

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/
const MS_PER_DAY = 86_400_000

function parts(at: Date, timeZone: string) {
  // hourCycle h23: midnight is "00", never "24". An unknown zone throws a RangeError (never a silent UTC).
  const out = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) => out.find((p) => p.type === type)?.value ?? '00'
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

function parseDay(day: string): number {
  const match = DAY.exec(day)
  if (!match) throw new Error(`google-ads dates: "${day}" is not a day (YYYY-MM-DD)`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

const formatDay = (utcMidnight: number): string => new Date(utcMidnight).toISOString().slice(0, 10)

/** The account's calendar day that the instant `at` falls on. */
export function dayIn(at: Date, timeZone: string): string {
  const { y, m, d } = parts(at, timeZone)
  return `${y}-${m}-${d}`
}

export const accountToday = (timeZone: string, now: Date = new Date()): string => dayIn(now, timeZone)
export const accountYesterday = (timeZone: string, now: Date = new Date()): string => addDays(accountToday(timeZone, now), -1)

export const addDays = (day: string, days: number): string => formatDay(parseDay(day) + days * MS_PER_DAY)

/** Days in the window, both ends counted (0 when it ends before it starts). */
export const dayCount = (window: DayWindow): number => Math.max(0, Math.round((parseDay(window.to) - parseDay(window.from)) / MS_PER_DAY) + 1)

/** 0 = Sunday … 6 = Saturday, for a calendar day (no time zone: the day already is one). */
export const weekdayOf = (day: string): number => new Date(parseDay(day)).getUTCDay()

/** Every day of the window, oldest first. */
export function daysOf(window: DayWindow): string[] {
  const out: string[] = []
  for (let day = window.from; day <= window.to; day = addDays(day, 1)) out.push(day)
  return out
}

/** The window cut into pieces of at most `size` days, oldest first (the later grains read big windows in chunks). */
export function chunkWindow(window: DayWindow, size: number): DayWindow[] {
  if (!(size >= 1)) throw new Error('google-ads dates: a chunk holds at least one day')
  const out: DayWindow[] = []
  for (let from = window.from; from <= window.to; from = addDays(from, size)) {
    const to = addDays(from, size - 1)
    out.push({ from, to: to < window.to ? to : window.to })
  }
  return out
}

/** The daily re-read: 14 account days ending yesterday; 35 when the account's today is a Sunday. */
export function dailyWindow(timeZone: string, now: Date = new Date()): DayWindow & { kind: 'DAILY' | 'WEEKLY' } {
  const today = accountToday(timeZone, now)
  const weekly = weekdayOf(today) === 0
  const to = addDays(today, -1)
  return { from: addDays(to, -((weekly ? SUNDAY_WINDOW_DAYS : DAILY_WINDOW_DAYS) - 1)), to, kind: weekly ? 'WEEKLY' : 'DAILY' }
}

/** The first read: `days` account days ending yesterday (400 by default). */
export function backfillWindow(timeZone: string, now: Date = new Date(), days: number = BACKFILL_DAYS): DayWindow {
  const to = accountYesterday(timeZone, now)
  return { from: addDays(to, -(days - 1)), to }
}

/** A day as the value of a @db.Date column (UTC midnight). */
export const dayToDate = (day: string): Date => new Date(parseDay(day))
/** A @db.Date value back to its day. */
export const dateToDay = (date: Date): string => date.toISOString().slice(0, 10)

/** "YYYY-MM-DD HH:MM:SS" of the instant in the account's time zone (seconds truncated). */
export function localDateTime(at: Date, timeZone: string): string {
  const { y, m, d, h, mi, s } = parts(at, timeZone)
  return `${y}-${m}-${d} ${h}:${mi}:${s}`
}

/** How far the zone is ahead of UTC at the instant, in ms. */
function offsetMs(at: number, timeZone: string): number {
  const whole = Math.floor(at / 1000) * 1000
  const { y, m, d, h, mi, s } = parts(new Date(whole), timeZone)
  return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)) - whole
}

/**
 * The instant of a wall-clock time in the account's time zone: "YYYY-MM-DD", "YYYY-MM-DD HH:MM:SS" or
 * "YYYY-MM-DD HH:MM:SS.ffffff" (Google's change_date_time). A wall-clock time a DST jump skips is read as the hour
 * after; one that happens twice (clocks going back) is read as its first occurrence.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const match = LOCAL.exec(local.trim())
  if (!match) throw new Error(`google-ads dates: "${local}" is not a date and time (YYYY-MM-DD HH:MM:SS)`)
  const [, y, m, d, h = '0', mi = '0', s = '0', fraction = ''] = match
  const ms = fraction ? Math.floor(Number(`0.${fraction}`) * 1000) : 0
  const asUtc = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s), ms)
  const first = offsetMs(asUtc, timeZone)
  let at = asUtc - first
  const second = offsetMs(at, timeZone)
  if (second !== first) at = asUtc - second
  return new Date(at)
}

export interface ChangeHistoryWindow {
  start: Date
  end: Date
  /** The same two instants as GAQL literals in the account's time zone. */
  startLiteral: string
  endLiteral: string
  /** True when the last read stopped before what Google still keeps: the changes in between can no longer be read. */
  gap: boolean
}

/**
 * The change history to read now: from 10 minutes before `resumeFrom` (Google can show a change up to ~3 minutes
 * late; rows are stored once by their resource name), or from the oldest instant Google still answers for — the
 * first second of the account day 29 days ago, so the range is always inside Google's 30 days — up to `now`.
 */
export function changeHistoryWindow(timeZone: string, now: Date = new Date(), resumeFrom: Date | null = null): ChangeHistoryWindow {
  const earliest = zonedToUtc(`${addDays(accountToday(timeZone, now), -(CHANGE_HISTORY_DAYS - 1))} 00:00:00`, timeZone)
  const wanted = resumeFrom ? new Date(resumeFrom.getTime() - CHANGE_HISTORY_OVERLAP_MS) : null
  const start = wanted && wanted > earliest ? wanted : earliest
  const end = start > now ? start : now
  return {
    start, end,
    startLiteral: localDateTime(start, timeZone),
    endLiteral: localDateTime(end, timeZone),
    gap: !!wanted && wanted < earliest,
  }
}
