import { businessDate, type BusinessDate } from '../core/time'
import { eachDay, isoWeekday, localInstant, plusDays } from './dates'
import { DEFAULT_PATTERN, shiftsOf, weekdaysWithShifts, type Pattern } from './patterns'

/**
 * Working time (PLT-103, PLN-001, PLN-002; B-W2a-08), pure: THE rules every module counts a working day with, so the
 * planning board, capacity, invoice reminders and the MRP's order-by date agree.
 *
 *   the chain     a line's day is read line → site → company, a workshop's (work centre) workshop → site → company, a
 *                 site's site → company; a supplier's calendar stands alone. `layers` holds the ACTIVE calendars of
 *                 the chain, most specific first; an owner without a calendar of its own reads the next one, and with
 *                 none at all the planning default (Monday to Friday, one shift: DEFAULT_PATTERN).
 *   the day       the most specific calendar with an exception on the date decides it: a HOLIDAY or CLOSURE closes
 *                 it, a WORKING day opens it (an extra Saturday, a short day). Without an exception, the working week
 *                 of the most specific calendar decides (`workingWeekdays`). So a site may open a company holiday
 *                 (its own patron saint elsewhere) and a line may work through the plant's shutdown.
 *   the shifts    a WORKING day's own pattern, else the first pattern of the chain, else the default. The weekday's
 *                 shifts less their breaks are the working time; a WORKING day on a weekday its pattern has no shift
 *                 on (an extra Saturday on a Monday-to-Friday pattern) works a normal day: the pattern's first
 *                 weekday with shifts. A weekday of the working week without a shift in the pattern has no working
 *                 time (`issue` NO_SHIFTS: the screens say so).
 *   minutes       real minutes, from the wall-clock times in the owner's time zone: a night shift across the clock
 *                 change counts 7 hours in March and 9 in October. A night shift belongs to the day it starts.
 *   a supplier    open or closed only (its days carry no shifts of ours): no minutes.
 *
 * The calendar knows the dates whose exceptions were loaded (`window`); asking outside it throws, so a caller never
 * reads a missing exception as "no exception".
 */

export const CALENDAR_SCOPES = ['COMPANY', 'SITE', 'LINE', 'WORK_CENTRE', 'SUPPLIER'] as const
export type CalendarScope = (typeof CALENDAR_SCOPES)[number]

export const DAY_KINDS = ['HOLIDAY', 'CLOSURE', 'WORKING'] as const
export type DayKind = (typeof DAY_KINDS)[number]

/** Which calendars an owner's day is read from, most specific first. */
export const CHAIN: Readonly<Record<Exclude<CalendarScope, 'SUPPLIER'>, readonly CalendarScope[]>> = Object.freeze({
  LINE: ['LINE', 'SITE', 'COMPANY'],
  WORK_CENTRE: ['WORK_CENTRE', 'SITE', 'COMPANY'],
  SITE: ['SITE', 'COMPANY'],
  COMPANY: ['COMPANY'],
})

/** The planning default week when no calendar is set: Monday to Friday. */
export const DEFAULT_WORKING_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])

/** One dated exception of a calendar. */
export interface DayException {
  readonly date: BusinessDate
  readonly kind: DayKind
  readonly name: string
  readonly shiftPatternId: string | null
}

/** One calendar of the chain with its exceptions in the window. */
export interface CalendarLayer {
  readonly id: string
  readonly scope: CalendarScope
  readonly name: string
  readonly workingWeekdays: readonly number[]
  readonly shiftPatternId: string | null
  readonly days: ReadonlyMap<BusinessDate, DayException>
}

export interface DateWindow {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

export interface WorkingCalendar {
  /** The ACTIVE calendars of the chain, most specific first (none: the planning default). */
  readonly layers: readonly CalendarLayer[]
  /** Every pattern a layer or an exception names. */
  readonly patterns: ReadonlyMap<string, Pattern>
  readonly timeZone: string
  /** The dates whose exceptions were loaded, both included. */
  readonly window: DateWindow
  /** A supplier's calendar: open or closed, no shifts. */
  readonly supplier: boolean
}

export class OutsideWindowError extends RangeError {
  override name = 'OutsideWindowError'
  constructor(
    readonly date: BusinessDate,
    readonly window: DateWindow,
  ) {
    super(`the calendar was loaded for ${window.from} to ${window.to}, not ${date}`)
  }
}

/** A calendar from its layers. Refuses a supplier's calendar mixed with others, a missing pattern, a reversed window. */
export function workingCalendar(input: { layers: readonly CalendarLayer[]; patterns: ReadonlyMap<string, Pattern>; timeZone: string; window: DateWindow; supplier?: boolean }): WorkingCalendar {
  const supplier = input.supplier ?? false
  if (input.window.to < input.window.from) throw new RangeError(`the window ends (${input.window.to}) before it starts (${input.window.from})`)
  if (supplier && (input.layers.length > 1 || input.layers.some((layer) => layer.scope !== 'SUPPLIER'))) throw new RangeError("a supplier's calendar stands alone")
  if (!supplier && input.layers.some((layer) => layer.scope === 'SUPPLIER')) throw new RangeError("a supplier's calendar is never in a chain")
  for (const layer of input.layers) {
    const named = [layer.shiftPatternId, ...[...layer.days.values()].map((day) => day.shiftPatternId)].filter((id): id is string => id !== null)
    for (const id of named) if (!input.patterns.has(id)) throw new RangeError(`calendar ${layer.id} names shift pattern ${id}, which was not loaded`)
  }
  return Object.freeze({ layers: [...input.layers], patterns: input.patterns, timeZone: input.timeZone, window: { ...input.window }, supplier })
}

export type DayReason = 'WEEK' | 'DAY_OFF' | 'HOLIDAY' | 'CLOSURE' | 'WORKING'

export interface WorkingShift {
  readonly label: string | null
  readonly start: Date
  readonly end: Date
  /** The shift less its breaks, real minutes. */
  readonly minutes: number
  /** The working stretches between the breaks. */
  readonly working: readonly { readonly start: Date; readonly end: Date }[]
  readonly breaks: readonly { readonly label: string | null; readonly start: Date; readonly end: Date }[]
}

export interface WorkingDay {
  readonly date: BusinessDate
  readonly weekday: number
  /** Not closed: in the working week or a WORKING exception, and no holiday or closure decided it. */
  readonly open: boolean
  /** Open and with working time (a supplier: open). The day a "next working day" lands on. */
  readonly working: boolean
  readonly reason: DayReason
  /** The exception's name ("Ferragosto", "August shutdown"); null on a plain day. */
  readonly name: string | null
  /** The calendar whose exception or week decided; null: the planning default (no calendar). */
  readonly decidedBy: { readonly calendarId: string; readonly scope: CalendarScope } | null
  /** The pattern in force on an open day of ours; null when closed or a supplier's day. */
  readonly pattern: { readonly id: string; readonly code: string; readonly name: string; readonly source: 'DAY' | 'CALENDAR' | 'DEFAULT'; readonly calendarId: string | null } | null
  /** The pattern's weekday whose shifts the day works (another one for an extra day: a normal day's). */
  readonly shiftsOfWeekday: number | null
  /** Real working minutes; 0 when closed; null for a supplier. */
  readonly minutes: number | null
  readonly shifts: readonly WorkingShift[]
  /** NO_SHIFTS: open by the working week, but the pattern has no shift that weekday. */
  readonly issue: 'NO_SHIFTS' | null
}

function inWindow(calendar: WorkingCalendar, date: BusinessDate): void {
  if (date < calendar.window.from || date > calendar.window.to) throw new OutsideWindowError(date, calendar.window)
}

/** The exception that decides a date: the most specific calendar's. */
function exceptionOn(calendar: WorkingCalendar, date: BusinessDate): { layer: CalendarLayer; day: DayException } | null {
  for (const layer of calendar.layers) {
    const day = layer.days.get(date)
    if (day) return { layer, day }
  }
  return null
}

/** The dated HOLIDAY or CLOSURE that closes a date, if any (a supplier's closed day for a lead time). */
export function closureOn(calendar: WorkingCalendar, date: BusinessDate): DayException | null {
  inWindow(calendar, date)
  const found = exceptionOn(calendar, date)
  return found && found.day.kind !== 'WORKING' ? found.day : null
}

function patternFor(calendar: WorkingCalendar, exception: DayException | null): NonNullable<WorkingDay['pattern']> & { readonly value: Pattern } {
  if (exception?.shiftPatternId) {
    const value = calendar.patterns.get(exception.shiftPatternId)!
    return { id: value.id, code: value.code, name: value.name, source: 'DAY', calendarId: null, value }
  }
  const layer = calendar.layers.find((candidate) => candidate.shiftPatternId !== null)
  if (layer) {
    const value = calendar.patterns.get(layer.shiftPatternId!)!
    return { id: value.id, code: value.code, name: value.name, source: 'CALENDAR', calendarId: layer.id, value }
  }
  return { id: DEFAULT_PATTERN.id, code: DEFAULT_PATTERN.code, name: DEFAULT_PATTERN.name, source: 'DEFAULT', calendarId: null, value: DEFAULT_PATTERN }
}

/** The working day of a date (in the window). */
export function dayOf(calendar: WorkingCalendar, date: BusinessDate): WorkingDay {
  inWindow(calendar, date)
  const weekday = isoWeekday(date)
  const found = exceptionOn(calendar, date)
  const top = calendar.layers[0]
  let open: boolean
  let reason: DayReason
  let decidedBy: WorkingDay['decidedBy']
  if (found) {
    open = found.day.kind === 'WORKING'
    reason = found.day.kind
    decidedBy = { calendarId: found.layer.id, scope: found.layer.scope }
  } else {
    const week = top?.workingWeekdays ?? DEFAULT_WORKING_WEEKDAYS
    open = week.includes(weekday)
    reason = open ? 'WEEK' : 'DAY_OFF'
    decidedBy = top ? { calendarId: top.id, scope: top.scope } : null
  }
  const base = { date, weekday, open, reason, name: found?.day.name ?? null, decidedBy }
  if (calendar.supplier) return { ...base, working: open, pattern: null, shiftsOfWeekday: null, minutes: null, shifts: [], issue: null }
  if (!open) return { ...base, working: false, pattern: null, shiftsOfWeekday: null, minutes: 0, shifts: [], issue: null }

  const { value, ...pattern } = patternFor(calendar, found?.day ?? null)
  const withShifts = weekdaysWithShifts(value.segments)
  const shiftsOfWeekday = withShifts.includes(weekday) ? weekday : reason === 'WORKING' ? (withShifts[0] ?? null) : null
  if (shiftsOfWeekday === null) return { ...base, working: false, pattern, shiftsOfWeekday: null, minutes: 0, shifts: [], issue: 'NO_SHIFTS' }
  const at = (minute: number) => localInstant(date, minute, calendar.timeZone)
  const shifts: WorkingShift[] = shiftsOf(value.segments, shiftsOfWeekday).map((shift) => {
    const working = shift.working.map((span) => ({ start: at(span.start), end: at(span.end) }))
    return {
      label: shift.label,
      start: at(shift.startMinute),
      end: at(shift.endMinute),
      minutes: working.reduce((sum, span) => sum + (span.end.getTime() - span.start.getTime()) / 60_000, 0),
      working,
      breaks: shift.breaks.map((pause) => ({ label: pause.label, start: at(pause.startMinute), end: at(pause.endMinute) })),
    }
  })
  const minutes = shifts.reduce((sum, shift) => sum + shift.minutes, 0)
  return { ...base, working: minutes > 0, pattern, shiftsOfWeekday, minutes, shifts, issue: null }
}

/** Every day from `from` to `to` (both in the window). */
export function daysOf(calendar: WorkingCalendar, from: BusinessDate, to: BusinessDate): WorkingDay[] {
  return eachDay(from, to).map((date) => dayOf(calendar, date))
}

/** Working days and real working minutes from `from` to `to`, both included (a supplier: minutes null). */
export function workingTimeOf(calendar: WorkingCalendar, from: BusinessDate, to: BusinessDate): { days: WorkingDay[]; workingDays: number; minutes: number | null } {
  const days = daysOf(calendar, from, to)
  return {
    days,
    workingDays: days.filter((day) => day.working).length,
    minutes: calendar.supplier ? null : days.reduce((sum, day) => sum + (day.minutes ?? 0), 0),
  }
}

/** The answer of a search: the date found, or the last date of the window when the search ran out of it. */
export type DaySearch = { readonly date: BusinessDate; readonly beyond?: undefined } | { readonly date?: undefined; readonly beyond: BusinessDate }

/**
 * `days` working days after `date` (1: the next working day; the date itself never counts); negative: before it; 0:
 * the date when it is working, else the next working day.
 */
export function addWorkingDays(calendar: WorkingCalendar, date: BusinessDate, days: number): DaySearch {
  if (!Number.isSafeInteger(days)) throw new RangeError(`not a whole number of days: ${String(days)}`)
  inWindow(calendar, date)
  if (days === 0 && dayOf(calendar, date).working) return { date }
  const step = days < 0 ? -1 : 1
  let left = Math.max(Math.abs(days), 1)
  let cursor = date
  for (;;) {
    cursor = plusDays(cursor, step)
    if (cursor < calendar.window.from || cursor > calendar.window.to) return { beyond: step > 0 ? calendar.window.to : calendar.window.from }
    if (dayOf(calendar, cursor).working) {
      left -= 1
      if (left === 0) return { date: cursor }
    }
  }
}

/** The first working day after `date`. */
export const nextWorkingDay = (calendar: WorkingCalendar, date: BusinessDate): DaySearch => addWorkingDays(calendar, date, 1)

/**
 * Real working minutes between two instants (`from` included, `to` excluded): every working stretch of the days that
 * reach into them, the day before `from` too (its night shift). The window must hold that day and `to`'s day.
 */
export function workingMinutesBetween(calendar: WorkingCalendar, from: Date, to: Date): number {
  if (calendar.supplier) throw new RangeError("a supplier's calendar has no working minutes")
  const start = from.getTime()
  const end = to.getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new RangeError('invalid time')
  if (end <= start) return 0
  const first = plusDays(businessDate(from, calendar.timeZone), -1)
  const last = businessDate(new Date(end - 1), calendar.timeZone)
  let total = 0
  for (const day of daysOf(calendar, first, last)) {
    for (const shift of day.shifts) {
      for (const span of shift.working) {
        const a = Math.max(span.start.getTime(), start)
        const b = Math.min(span.end.getTime(), end)
        if (b > a) total += (b - a) / 60_000
      }
    }
  }
  return total
}
