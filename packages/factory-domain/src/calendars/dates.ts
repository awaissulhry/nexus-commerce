import { isBusinessDate, type BusinessDate } from '../core/time'

/**
 * Calendar days and wall-clock times for the business calendars (B-W2a-08), pure. A day is `YYYY-MM-DD`; a shift's
 * start and end are minutes from that day's local midnight in the owner's time zone (Europe/Rome unless the site or
 * company says otherwise). `localInstant` turns a wall-clock minute into the real instant, so a night shift across a
 * clock change counts the minutes people really work (7 hours on the short night of March, 9 on the long one of
 * October). Nothing here reads the machine's zone.
 */

const DAY_MS = 86_400_000

function parts(date: BusinessDate): [number, number, number] {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  return [year, month, day]
}

const utcOf = (date: BusinessDate): number => {
  const [year, month, day] = parts(date)
  return Date.UTC(year, month - 1, day)
}

/** The calendar day `days` later (negative: earlier). */
export function plusDays(date: BusinessDate, days: number): BusinessDate {
  if (!Number.isSafeInteger(days)) throw new RangeError(`not a whole number of days: ${String(days)}`)
  return new Date(utcOf(date) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysFrom(from: BusinessDate, to: BusinessDate): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS)
}

/** The ISO weekday of a day: 1 Monday … 7 Sunday. */
export function isoWeekday(date: BusinessDate): number {
  const day = new Date(utcOf(date)).getUTCDay()
  return day === 0 ? 7 : day
}

/** Every day from `from` to `to`, both included (empty when `to` is earlier). */
export function eachDay(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = []
  const count = daysFrom(from, to)
  for (let index = 0; index <= count; index++) out.push(plusDays(from, index))
  return out
}

/** The year of a day. */
export const yearOf = (date: BusinessDate): number => parts(date)[0]

/** `HH:MM` of a minute of the day (1440 and later run into the next day: 1800 is 06:00). */
export function clockText(minute: number): string {
  const inDay = ((minute % 1440) + 1440) % 1440
  return `${String(Math.floor(inDay / 60)).padStart(2, '0')}:${String(inDay % 60).padStart(2, '0')}`
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    formatters.set(timeZone, found)
  }
  return found
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds (whole seconds). */
function offsetAt(instant: number, timeZone: string): number {
  const wall: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') wall[part.type] = Number.parseInt(part.value, 10)
  }
  const asUtc = Date.UTC(wall.year!, wall.month! - 1, wall.day!, wall.hour!, wall.minute!, wall.second!)
  return asUtc - (instant - (((instant % 1000) + 1000) % 1000))
}

/** A time zone the platform knows (an IANA name such as Europe/Rome). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    formatter(value)
    return true
  } catch {
    return false
  }
}

/**
 * The instant of a wall-clock minute of a day in a time zone (1440 and later: the next day). On the night the clocks
 * go back, a time that happens twice is its first occurrence; on the night they go forward, a time that does not
 * exist moves forward by the gap (02:30 is 03:30), as most calendars do.
 */
export function localInstant(date: BusinessDate, minute: number, timeZone: string): Date {
  if (!Number.isSafeInteger(minute) || minute < 0) throw new RangeError(`not a minute of the day: ${String(minute)}`)
  const wall = utcOf(date) + minute * 60_000
  const before = offsetAt(wall - DAY_MS, timeZone)
  const after = offsetAt(wall + DAY_MS, timeZone)
  const candidates = [...new Set([before, after])].map((offset) => wall - offset).filter((instant) => wall - offsetAt(instant, timeZone) === instant)
  if (candidates.length > 0) return new Date(Math.min(...candidates))
  // In the gap of a spring change: the wall time does not exist; the offset before the change moves it forward.
  return new Date(wall - before)
}
