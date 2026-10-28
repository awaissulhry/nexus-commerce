/**
 * Time (plan A1 §2.1, feature PLT-084 "trusted time"): instants are stored in UTC (`timestamptz`) with millisecond
 * precision, taken from the server clock, never from a device. A business date (an invoice date, a DDT date, "today's
 * orders") is a calendar day in the company's time zone, Europe/Rome unless a company says otherwise, written
 * `YYYY-MM-DD`. Turning one into the other always names the zone; nothing here reads the machine's local zone.
 */

export const BUSINESS_TIME_ZONE = 'Europe/Rome'

/** The source of "now". The API passes the server clock; tests pass a fixed one. */
export interface Clock {
  now(): Date
}

/** A calendar day, `YYYY-MM-DD`. */
export type BusinessDate = string

const DATE = /^\d{4}-\d{2}-\d{2}$/
// ISO 8601 with a zone: Z or ±hh:mm. A time without a zone is refused: it would be read in the machine's zone.
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, found)
  }
  return found
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallClock(instant: number, timeZone: string): WallClock {
  const values: Partial<Record<keyof WallClock, number>> = {}
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type in { year: 1, month: 1, day: 1, hour: 1, minute: 1, second: 1 }) {
      values[part.type as keyof WallClock] = Number.parseInt(part.value, 10)
    }
  }
  return values as WallClock
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function zoneOffset(instant: number, timeZone: string): number {
  const wall = wallClock(instant, timeZone)
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return wallAsUtc - (instant - (((instant % 1000) + 1000) % 1000))
}

function dateParts(date: string): [number, number, number] {
  const [year = '', month = '', day = ''] = date.split('-')
  return [Number.parseInt(year, 10), Number.parseInt(month, 10), Number.parseInt(day, 10)]
}

function assertInstant(instant: Date): number {
  const time = instant.getTime()
  if (!Number.isFinite(time)) throw new RangeError('invalid date')
  return time
}

/** The calendar day an instant falls on in a time zone. */
export function businessDate(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): BusinessDate {
  const wall = wallClock(assertInstant(instant), timeZone)
  const pad = (value: number, length: number) => String(value).padStart(length, '0')
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}`
}

/** A real calendar day written `YYYY-MM-DD` (no 2026-02-30). */
export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== 'string') return false
  if (!DATE.test(value)) return false
  const [year, month, day] = dateParts(value)
  const check = new Date(Date.UTC(year, month - 1, day))
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
}

/** The first instant of a calendar day in a time zone (local midnight, as UTC). */
export function businessDayStart(date: BusinessDate, timeZone: string = BUSINESS_TIME_ZONE): Date {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  const [year, month, day] = dateParts(date)
  const midnightAsUtc = Date.UTC(year, month - 1, day)
  // Two passes: the offset at the guess can differ from the offset at the answer when a clock change is near.
  let start = midnightAsUtc - zoneOffset(midnightAsUtc, timeZone)
  const offsetAtStart = zoneOffset(start, timeZone)
  if (midnightAsUtc - offsetAtStart !== start) start = midnightAsUtc - offsetAtStart
  return new Date(start)
}

/** A calendar day as an instant range: `start` included, `end` (the next day's start) excluded. */
export function businessDayRange(date: BusinessDate, timeZone: string = BUSINESS_TIME_ZONE): { start: Date; end: Date } {
  const start = businessDayStart(date, timeZone)
  const [year, month, day] = dateParts(date)
  const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
  return { start, end: businessDayStart(next, timeZone) }
}

/** An instant as stored and sent: ISO 8601 in UTC with milliseconds (`2026-10-28T09:15:00.000Z`). */
export function toUtcIso(instant: Date): string {
  assertInstant(instant)
  return instant.toISOString()
}

/** Reads an ISO 8601 instant that names its zone (Z or ±hh:mm). Returns null for anything else. */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const match = INSTANT.exec(value)
  if (!match || !isBusinessDate(match[1])) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

/** The server clock. */
export const systemClock: Clock = { now: () => new Date() }

/** A clock that always says the same instant (tests). */
export function fixedClock(instant: Date | string): Clock {
  const time = typeof instant === 'string' ? parseInstant(instant) : instant
  if (time === null || !Number.isFinite(time.getTime())) throw new RangeError(`not an instant: ${String(instant)}`)
  return { now: () => new Date(time.getTime()) }
}
