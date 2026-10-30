import type { WorkingDay } from '../../calendars/working-time'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Working time as stretches on the clock (B-W2a-34; PLN-129), pure: the planning board's walks through a lane's
 * calendar. A lane's working stretches come from THE calendars service's working days (their shifts less breaks; a
 * night shift belongs to the day it starts), so this module never decides which day works: it only walks.
 *
 *   before   the instant N working minutes before an instant (backward scheduling: a latest start from a latest finish)
 *   after    the instant N working minutes after an instant (a finish from a start; forward from now)
 *   endBy    the last working instant at or before an instant (a due date's end of work)
 *   startFrom the first working instant at or after an instant
 *
 * Instants are epoch milliseconds; minutes are real minutes. A walk that runs out of the loaded stretches answers null
 * (the caller loads a wide enough window, and says "before the calendar's first day" when it still runs out).
 */

export const MINUTE_MS = 60_000

export interface Span {
  readonly start: number
  readonly end: number
}

/** The working stretches of the days, in time order, touching ones joined. */
export function spansOf(days: readonly WorkingDay[]): Span[] {
  const all = days.flatMap((day) => day.shifts.flatMap((shift) => shift.working.map((span) => ({ start: span.start.getTime(), end: span.end.getTime() }))))
  all.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Span[] = []
  for (const span of all) {
    if (span.end <= span.start) continue
    const last = out[out.length - 1]
    if (last && span.start <= last.end) out[out.length - 1] = { start: last.start, end: Math.max(last.end, span.end) }
    else out.push(span)
  }
  return out
}

/** The instant `minutes` working minutes before `end`; `end` itself for none; null when the stretches run out. */
export function before(spans: readonly Span[], end: number, minutes: number): number | null {
  let left = Math.max(0, minutes) * MINUTE_MS
  if (left === 0) return end
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!
    if (span.start >= end) continue
    const top = Math.min(span.end, end)
    const room = top - span.start
    if (room >= left) return top - left
    left -= room
  }
  return null
}

/** The instant `minutes` working minutes after `start`; `start` itself for none; null when the stretches run out. */
export function after(spans: readonly Span[], start: number, minutes: number): number | null {
  let left = Math.max(0, minutes) * MINUTE_MS
  if (left === 0) return start
  for (const span of spans) {
    if (span.end <= start) continue
    const bottom = Math.max(span.start, start)
    const room = span.end - bottom
    if (room >= left) return bottom + left
    left -= room
  }
  return null
}

/** The last working instant at or before `instant` (the end of the stretch before it, or the instant inside one). */
export function endBy(spans: readonly Span[], instant: number): number | null {
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!
    if (span.start >= instant) continue
    return Math.min(span.end, instant)
  }
  return null
}

/** The first working instant at or after `instant`. */
export function startFrom(spans: readonly Span[], instant: number): number | null {
  for (const span of spans) {
    if (span.end <= instant) continue
    return Math.max(span.start, instant)
  }
  return null
}

/** Working minutes between two instants (`from` included, `to` excluded). */
export function minutesBetween(spans: readonly Span[], from: number, to: number): number {
  let total = 0
  for (const span of spans) {
    const a = Math.max(span.start, from)
    const b = Math.min(span.end, to)
    if (b > a) total += b - a
  }
  return total / MINUTE_MS
}

/** How a lane works an operation: so many people (a line) or stations (a work centre) at an efficiency. */
export interface LaneRate {
  readonly people: number
  /** Percent, a decimal string (85.00). */
  readonly efficiencyPct: string
}

/**
 * The working minutes standard minutes take on a lane: standard minutes ÷ (people × efficiency), whole minutes rounded
 * up. A lane with no people or stations counts as one, an efficiency of 0 or less as 100 % (the settings refuse both;
 * the board still draws a bar).
 */
export function workingMinutesFor(standardMinutes: Decimal | string, rate: LaneRate): number {
  const people = Math.max(1, rate.people)
  const pct = new Dec(rate.efficiencyPct)
  const efficiency = pct.gt(0) ? pct.div(100) : new Dec(1)
  const value = new Dec(standardMinutes.toString()).div(efficiency.times(people))
  // Whole working minutes (a count, rounded up), never a float of a decimal.
  return Math.max(0, Number.parseInt(value.toDecimalPlaces(0, Dec.ROUND_UP).toFixed(0), 10))
}

const WHEN = new Map<string, Intl.DateTimeFormat>()

/** "17 Nov 08:00" in the site's zone (the API's English words; the screens say it from the instant). */
export function whenWords(instant: number, timeZone: string): string {
  let format = WHEN.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    WHEN.set(timeZone, format)
  }
  return format.format(new Date(instant)).replace(',', '')
}

/** "17 Nov 2026" for a business date. */
export function dayWords(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]
  return `${day} ${name} ${year}`
}
