import { businessDate, isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * The deadline to send a rejected file again (FIN-087; Provv. AdE 89757/2018, circolare AdE 13/E/2018):
 * a file SDI rejected (NS) counts as never issued; it is sent again, corrected, under the SAME number and date within
 * five working days of the rejection. Counted here in Europe/Rome business days: the day of the notification is day 0,
 * Saturdays, Sundays and the Italian national holidays are not working days. Pure.
 *
 * Holidays (L. 260/1949 and later): 1 January, 6 January, Easter Monday, 25 April, 1 May, 2 June, 15 August,
 * 1 November, 8 December, 25 and 26 December, and from 2026 4 October again (L. 151/2025, San Francesco). Local patron
 * saints' days are not counted (they differ per comune). UNVERIFIED with the accountant: Saturday as a non-working day
 * (the Provvedimento says "giorni"; the AdE's guidance counts working days) — the screen shows the date we computed.
 */

export const RESEND_WORKING_DAYS = 5

const DAY_MS = 86_400_000

const toUtc = (date: BusinessDate): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
const fromUtc = (ms: number): BusinessDate => new Date(ms).toISOString().slice(0, 10)

/** Easter Sunday of a Gregorian year (the anonymous Gregorian algorithm, Meeus/Jones/Butcher). */
export function easterSunday(year: number): BusinessDate {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The Italian national holidays of a year, sorted. */
export function italianHolidays(year: number): BusinessDate[] {
  const fixed = ['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26', ...(year >= 2026 ? ['10-04'] : [])]
  const easterMonday = fromUtc(toUtc(easterSunday(year)) + DAY_MS)
  return [...fixed.map((day) => `${year}-${day}`), easterMonday].sort()
}

const holidays = new Map<number, Set<BusinessDate>>()
function holidaySet(year: number): Set<BusinessDate> {
  let found = holidays.get(year)
  if (!found) {
    found = new Set(italianHolidays(year))
    holidays.set(year, found)
  }
  return found
}

/** Monday to Friday and not an Italian national holiday. */
export function isItalianWorkingDay(date: BusinessDate): boolean {
  if (!isBusinessDate(date)) throw new RangeError(`not a date: ${date}`)
  const weekday = new Date(toUtc(date)).getUTCDay()
  return weekday !== 0 && weekday !== 6 && !holidaySet(Number(date.slice(0, 4))).has(date)
}

/** The day `count` working days after `date` (the date itself not counted). */
export function addWorkingDays(date: BusinessDate, count: number): BusinessDate {
  let ms = toUtc(date)
  let left = count
  while (left > 0) {
    ms += DAY_MS
    if (isItalianWorkingDay(fromUtc(ms))) left--
  }
  return fromUtc(ms)
}

/** Working days from `from` (excluded) to `to` (included); negative when `to` is earlier. */
export function workingDaysBetween(from: BusinessDate, to: BusinessDate): number {
  if (to < from) return -workingDaysBetween(to, from)
  const end = toUtc(to)
  let ms = toUtc(from)
  let count = 0
  while (ms < end) {
    ms += DAY_MS
    if (isItalianWorkingDay(fromUtc(ms))) count++
  }
  return count
}

/** The last day to send the corrected file again: five working days after the day SDI issued the NS. */
export function resendDeadline(rejectedAt: Date): BusinessDate {
  return addWorkingDays(businessDate(rejectedAt), RESEND_WORKING_DAYS)
}

export interface DeadlineState {
  readonly deadline: BusinessDate
  /** Working days left after today (0 on the last day); negative once it passed. */
  readonly workingDaysLeft: number
  readonly overdue: boolean
}

/** Where today stands against the deadline. */
export function deadlineState(rejectedAt: Date, today: BusinessDate): DeadlineState {
  const deadline = resendDeadline(rejectedAt)
  const left = workingDaysBetween(today, deadline)
  return { deadline, workingDaysLeft: left, overdue: today > deadline }
}
