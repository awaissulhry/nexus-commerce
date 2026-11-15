import { plusDays, daysFrom, localInstant } from '@nexus/factory-domain/calendars/dates'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'

/**
 * The seeds' calendar (B-W2b-F53): the ONE place that says where a seeded date lands on the day the seed runs, so no test
 * or golden step turns red, or stops checking, because the real calendar moved past a date the seeds once wrote down.
 *
 * The seeds were written as one made-up story around their week of 9-15 November 2026. Since 15 November 2026 (SEED_DAY):
 *   - HISTORY, a seeded date on or before SEED_DAY, never moves. It is already past and only grows older; it keeps its
 *     year, so every year-bound record of the story stays true: invoice numbers and their year (FT-2026-…, the money
 *     guard's year = year of the issue date), the DDT and hold series of 2026, the September 2026 period lock, the stamp
 *     duty quarters of 2026, the accounting exports and every id keyed by a date.
 *   - The seeds' FUTURE, a seeded date after SEED_DAY (a due day, a promise, a planned slot, an appointment, an expiry,
 *     an event the story puts in the days to come), moves on by whole weeks, as few as needed so that it is still to
 *     come: its distance from today is never shorter than it was on SEED_DAY (at most six days longer), and its weekday
 *     is the same. So a seeded future date never passes: a promise never turns late, a seeded scan of next Monday never
 *     becomes "today's", a certificate never expires under a test.
 *   - CALENDAR FACTS are not seed dates and are written as plain dates, never through this file: national holidays and
 *     plant closures (seed/calendar.ts), the first day of a year or a month a rate, price list, mapping or standard cost
 *     starts on (1 January 2027 …), period and quarter boundaries. A future date moved by whole weeks can land on one of
 *     them (8 December, 25-26 December, 1 and 6 January, a plant's Christmas closure); a test that reads capacity or a
 *     working day there reads the calendar (the planning answers), never assumes the day works.
 *     So are the long legal limits of a history record (a certificate's five years to 2030-31, ten-year retentions to
 *     2036): moved past their history start they would break their legal maximum; they pass only years from now.
 *   - A record that must hold in TODAY's year (a customer's declaration of intent for the year an invoice is issued in)
 *     takes the year from seedYear(): in a run after 2026 the seed adds that year's record beside 2026's.
 *   - A live record whose end is in the seeds' future and whose length is capped moves its start with it (seedAlong: a
 *     share ends at most 180 days after it was made).
 *   - A month-bound story keeps its dates: the pay seed's November 2026 period and its entries (a pay period is one whole
 *     month, its entries inside it) stay as written, as history does.
 *
 * A test that names a seeded date names it through the same functions (seedDay, seedAt), so seed and test agree on every
 * day. The shift is read once per test file (the first call, usually when the seed modules load), so a seed and the test
 * that reads it never straddle a midnight.
 *
 * A test file that FIXES ITS CLOCK on a day of the seeds' story (vi.useFakeTimers or a module's clock on 13, 17 or 30 November
 * 2026 …, the B-W2b-F43 way), or reads the story only on days it names itself (never today), runs the seeds as written
 * instead: it says so first, before the seed modules load, with
 *     await vi.hoisted(async () => (await import('@nexus/factory-db/testing')).seedsAsWritten())
 * (no shift whatever the real day; its clock and the seeds stay in the story's week together).
 *
 * A new seed writes its history on or before SEED_DAY, its days to come after it through seedDay/seedAt, or a date
 * counted from the run's day (seedToday).
 */

/** The last day of the seeds' written history (a Sunday): later seed dates are the seeds' future and follow the calendar. */
export const SEED_DAY: BusinessDate = '2026-11-15'

const ZONE = 'Europe/Rome'
const DATE = /^\d{4}-\d{2}-\d{2}$/
let fixedShift: number | undefined

/** Days the seeds' future moves on in this test file or process: 0 up to SEED_DAY, then whole weeks (7 from 16 November 2026, 63 on 14 January 2027). */
export function seedShiftDays(): number {
  if (fixedShift === undefined) fixedShift = 7 * Math.ceil(Math.max(0, daysFrom(SEED_DAY, seedToday())) / 7)
  return fixedShift
}

/**
 * The seeds as written, no shift, for a test file that fixes its clock on a day of the seeds' story. Call it before the
 * seed modules load (vi.hoisted); refused once a shift other than 0 was handed out.
 */
export function seedsAsWritten(): void {
  if (fixedShift !== undefined && fixedShift !== 0) throw new Error(`seedsAsWritten: the seeds already moved ${fixedShift} days in this test file; call it first (vi.hoisted)`)
  fixedShift = 0
}

/** Today in Europe/Rome by the clock (the test's clock when it fixes one). */
export function seedToday(): BusinessDate {
  return businessDate(new Date(), ZONE)
}

/** The year of seedToday(): the year a seeded record that must hold today is for. */
export function seedYear(): number {
  return Number(seedToday().slice(0, 4))
}

/** A seeded calendar day, YYYY-MM-DD: history as written, the seeds' future moved on by seedShiftDays(). */
export function seedDay(day: BusinessDate): BusinessDate {
  if (!DATE.test(day)) throw new RangeError(`seedDay: not a calendar day: ${day}`)
  return day <= SEED_DAY ? day : plusDays(day, seedShiftDays())
}

/**
 * A seeded instant (an ISO string with a zone, or a Date): history as written; the seeds' future moved on by
 * seedShiftDays(). A UTC midnight is a calendar day (a date column) and stays a UTC midnight; any other instant keeps its
 * wall-clock time in Europe/Rome (a 06:00 shift start stays 06:00 across a change to summer time).
 */
export function seedAt(instant: string | Date): Date {
  const at = typeof instant === 'string' ? new Date(instant) : instant
  if (!Number.isFinite(at.getTime())) throw new RangeError(`seedAt: not an instant: ${String(instant)}`)
  const iso = at.toISOString()
  if (iso.endsWith('T00:00:00.000Z')) return new Date(`${seedDay(iso.slice(0, 10))}T00:00:00.000Z`)
  if (businessDate(at, ZONE) <= SEED_DAY) return new Date(at.getTime())
  return moved(at)
}

/**
 * A seeded instant of HISTORY moved on with the seeds' future anyway: only for the start of a live record whose end is in the
 * seeds' future and may lie at most so long after its start (a share ends at most 180 days after it was made). It stays in
 * the past: the shift is never more than six days longer than the time since SEED_DAY.
 */
export function seedAlong(instant: string | Date): Date {
  const at = typeof instant === 'string' ? new Date(instant) : instant
  if (!Number.isFinite(at.getTime())) throw new RangeError(`seedAlong: not an instant: ${String(instant)}`)
  return moved(at)
}

function moved(at: Date): Date {
  const day = businessDate(at, ZONE)
  const sinceMidnight = at.getTime() - localInstant(day, 0, ZONE).getTime()
  const minute = Math.floor(sinceMidnight / 60_000)
  return new Date(localInstant(plusDays(day, seedShiftDays()), minute, ZONE).getTime() + (sinceMidnight - minute * 60_000))
}

/** seedAt as an ISO string (YYYY-MM-DDTHH:MM:SS.sssZ), for a test that writes a seeded instant into SQL or JSON. */
export function seedIso(instant: string): string {
  return seedAt(instant).toISOString()
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'] as const

/**
 * A seeded day (moved as seedDay moves it) written as the app's words write a day: 'en' "21 Nov 2026", 'en-day' "21 Nov",
 * 'it' "21 novembre 2026", 'dmy' "21/11/2026". For a test that reads a seeded future day inside a message.
 */
export function seedDayText(day: BusinessDate, style: 'en' | 'en-day' | 'it' | 'dmy'): string {
  const shifted = seedDay(day)
  const [year, month, date] = [Number(shifted.slice(0, 4)), Number(shifted.slice(5, 7)), Number(shifted.slice(8, 10))]
  if (style === 'dmy') return `${shifted.slice(8, 10)}/${shifted.slice(5, 7)}/${year}`
  if (style === 'en-day') return `${date} ${MONTHS_EN[month - 1]}`
  return `${date} ${(style === 'en' ? MONTHS_EN : MONTHS_IT)[month - 1]} ${year}`
}
