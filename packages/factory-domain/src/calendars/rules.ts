import type { Issue } from '../core/errors'
import type { BusinessDate } from '../core/time'
import { daysFrom } from './dates'
import type { CalendarScope, DayKind } from './working-time'

/**
 * The rules of keeping calendars (PLT-103, PLN-001, PLN-002; B-W2a-08), pure; the API says them in words before the
 * database's guards (…_platform_w2a_guards) would refuse the same with a check violation.
 *
 *   - one ACTIVE calendar per owner; the owner never changes (a new owner: archive and make a new calendar);
 *   - a calendar works at least one weekday (ISO 1-7); its pattern is ACTIVE and tenant-wide or of its company; a
 *     supplier's calendar has no pattern (it keeps its own days, not our shifts);
 *   - a day: HOLIDAY and CLOSURE carry no pattern; only a WORKING day of ours names one; a supplier's never does;
 *   - one exception per calendar and date; a range of days at most MAX_RANGE_DAYS long;
 *   - archived calendars and patterns are kept and read, never changed.
 */

/** The longest range one request sets, removes or asks about. */
export const MAX_RANGE_DAYS = 366

export const CALENDAR_LIMITS = Object.freeze({ name: 200, dayName: 120, note: 500, reason: 500 })

/** The weekdays as stored: unique, ascending, 1-7. */
export const normalizedWeekdays = (weekdays: readonly number[]): number[] => [...new Set(weekdays)].sort((a, b) => a - b)

export function weekdaysProblems(weekdays: readonly number[], path = 'workingWeekdays'): Issue[] {
  if (weekdays.length === 0) return [{ path, message: 'A calendar works at least one weekday.' }]
  if (weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) return [{ path, message: 'Weekdays are ISO numbers: 1 (Monday) to 7 (Sunday).' }]
  return []
}

/** A range of days: `to` not before `from`, at most MAX_RANGE_DAYS days. */
export function rangeProblems(from: BusinessDate, to: BusinessDate, path = 'to'): Issue[] {
  const span = daysFrom(from, to)
  if (span < 0) return [{ path, message: `The range ends (${to}) before it starts (${from}).` }]
  if (span + 1 > MAX_RANGE_DAYS) return [{ path, message: `A range is at most ${MAX_RANGE_DAYS} days; this one has ${span + 1}.` }]
  return []
}

/** What a day of this calendar may carry. */
export function dayProblems(scope: CalendarScope, day: { kind: DayKind; shiftPatternId: string | null }, path = 'shiftPatternId'): Issue[] {
  if (day.shiftPatternId === null) return []
  if (day.kind !== 'WORKING') return [{ path, message: 'A holiday or a closure has no shifts: only a working day names a shift pattern.' }]
  if (scope === 'SUPPLIER') return [{ path, message: "A supplier's day keeps no shifts of ours: leave the pattern out." }]
  return []
}

/** Who keeps a calendar: suppliers' calendars are the buyers' (calendars.suppliers.manage), the others calendars.manage. */
export const managesSuppliers = (scope: CalendarScope): boolean => scope === 'SUPPLIER'

/** The words of a scope, as the screens say it. */
export const SCOPE_WORDS: Readonly<Record<CalendarScope, string>> = Object.freeze({
  COMPANY: 'company',
  SITE: 'site',
  LINE: 'line',
  WORK_CENTRE: 'workshop',
  SUPPLIER: 'supplier',
})
