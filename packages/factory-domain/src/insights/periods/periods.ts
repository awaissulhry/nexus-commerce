import { isoWeekday, plusDays } from '../../calendars/dates'
import { businessDayRange, isBusinessDate, type BusinessDate } from '../../core/time'

/**
 * Periods aligned to calendars (B-W2b-428; ANA-028; design home.kpis › a KPI › Definition "period rules (weeks, months,
 * fiscal periods per company; shifts in the site's zone)"), pure. Every number of the metric layer is cut at the right
 * local midnight: a fact's day is the business day on its site's clock (else its company's), never the server's UTC date,
 * and the periods a KPI is read over are whole days of that clock:
 *
 *   DAY              one business day
 *   WEEK             Monday to Sunday (ISO 8601); key `2026-W46` in the ISO week-year
 *   MONTH            a calendar month; key `2026-11`
 *   QUARTER          a calendar quarter; key `2026-Q4`
 *   YEAR             a calendar year; key `2026`
 *   FISCAL_QUARTER   three months from the company's fiscal year start (Company.fiscalYearStartMonth); key `FY2026-Q2`
 *   FISCAL_YEAR      twelve months from that start; key `FY2026`, named by the calendar year it starts in
 *
 * Hours (FactHourly) are whole hours of the site's clock: `hoursOfDay` lists a day's hours from its local midnight (23 on the
 * night the clocks go forward, 25 on the night they go back). Shifts come from the site's
 * working calendar (apps/factory-api platform/calendars: each shift's real start and end); `shiftOfHour` puts an hour in
 * the shift it belongs to, so a night shift across midnight counts on the day it started.
 */

export const PERIOD_KINDS = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'FISCAL_QUARTER', 'FISCAL_YEAR'] as const
export type PeriodKind = (typeof PERIOD_KINDS)[number]

export interface Period {
  readonly kind: PeriodKind
  /** `2026-11-14`, `2026-W46`, `2026-11`, `2026-Q4`, `2026`, `FY2026-Q2`, `FY2026`. */
  readonly key: string
  /** First day, inclusive. */
  readonly from: BusinessDate
  /** Last day, inclusive. */
  readonly to: BusinessDate
}

/** At most this many periods in one read (a sparkline of 12, a year of weeks). */
export const MAX_PERIODS = 60

const pad = (value: number, length = 2) => String(value).padStart(length, '0')
const yearMonth = (day: BusinessDate): [number, number] => [Number.parseInt(day.slice(0, 4), 10), Number.parseInt(day.slice(5, 7), 10)]
const firstOfMonth = (year: number, month: number): BusinessDate => {
  const shifted = new Date(Date.UTC(year, month - 1, 1))
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-01`
}
/** The first day of the month `months` after the month of (year, month). */
const monthsAfter = (year: number, month: number, months: number): BusinessDate => firstOfMonth(year, month + months)

function checkFiscalStart(month: number): number {
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) throw new RangeError(`not a fiscal year start month: ${String(month)}`)
  return month
}

/** The Monday of a day's ISO week. */
export const weekMonday = (day: BusinessDate): BusinessDate => plusDays(day, 1 - isoWeekday(day))

/** The ISO week-year and week number of a day (the week of the year's first Thursday is week 1). */
export function isoWeekOf(day: BusinessDate): { readonly year: number; readonly week: number } {
  const thursday = plusDays(weekMonday(day), 3)
  const year = Number.parseInt(thursday.slice(0, 4), 10)
  const firstThursday = plusDays(weekMonday(`${pad(year, 4)}-01-04`), 3)
  const week = Math.round((Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${firstThursday}T00:00:00Z`)) / (7 * 86_400_000)) + 1
  return { year, week }
}

/**
 * The period of a kind a day falls in. `fiscalYearStartMonth` is the company's (1 January … 12 December); the calendar
 * kinds ignore it.
 */
export function periodOf(kind: PeriodKind, day: BusinessDate, fiscalYearStartMonth = 1): Period {
  if (!isBusinessDate(day)) throw new RangeError(`not a calendar day: ${String(day)}`)
  const [year, month] = yearMonth(day)
  switch (kind) {
    case 'DAY':
      return { kind, key: day, from: day, to: day }
    case 'WEEK': {
      const from = weekMonday(day)
      const { year: weekYear, week } = isoWeekOf(day)
      return { kind, key: `${pad(weekYear, 4)}-W${pad(week)}`, from, to: plusDays(from, 6) }
    }
    case 'MONTH':
      return { kind, key: `${pad(year, 4)}-${pad(month)}`, from: firstOfMonth(year, month), to: plusDays(monthsAfter(year, month, 1), -1) }
    case 'QUARTER': {
      const first = month - ((month - 1) % 3)
      return { kind, key: `${pad(year, 4)}-Q${(first - 1) / 3 + 1}`, from: firstOfMonth(year, first), to: plusDays(monthsAfter(year, first, 3), -1) }
    }
    case 'YEAR':
      return { kind, key: pad(year, 4), from: `${pad(year, 4)}-01-01`, to: `${pad(year, 4)}-12-31` }
    case 'FISCAL_QUARTER':
    case 'FISCAL_YEAR': {
      const start = checkFiscalStart(fiscalYearStartMonth)
      const startYear = month >= start ? year : year - 1
      const intoYear = (month - start + 12) % 12
      if (kind === 'FISCAL_YEAR') return { kind, key: `FY${pad(startYear, 4)}`, from: firstOfMonth(startYear, start), to: plusDays(monthsAfter(startYear, start, 12), -1) }
      const quarter = Math.floor(intoYear / 3)
      return { kind, key: `FY${pad(startYear, 4)}-Q${quarter + 1}`, from: monthsAfter(startYear, start, quarter * 3), to: plusDays(monthsAfter(startYear, start, quarter * 3 + 3), -1) }
    }
  }
}

/** The `count` periods of a kind that end with the one `anchor` falls in, oldest first (a sparkline of 12). */
export function periodsBack(kind: PeriodKind, anchor: BusinessDate, count: number, fiscalYearStartMonth = 1): Period[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PERIODS) throw new RangeError(`between 1 and ${MAX_PERIODS} periods: ${String(count)}`)
  const out: Period[] = [periodOf(kind, anchor, fiscalYearStartMonth)]
  while (out.length < count) out.unshift(periodOf(kind, plusDays(out[0]!.from, -1), fiscalYearStartMonth))
  return out
}

// ---- hours and shifts on the site's clock --------------------------------------------------------------------------------------

/** Every whole hour of a business day on a zone's clock, as instants (23, 24 or 25 of them). */
export function hoursOfDay(day: BusinessDate, timeZone: string): Date[] {
  const { start, end } = businessDayRange(day, timeZone)
  const out: Date[] = []
  for (let time = start.getTime(); time < end.getTime(); time += 3_600_000) out.push(new Date(time))
  return out
}

/** One shift of a working day on the site's clock (the calendar's WorkingShift, with its day). */
export interface ShiftWindow {
  /** The business day the shift starts on (a night shift belongs to its first day). */
  readonly day: BusinessDate
  /** Its name in the shift pattern ("Morning", "A"), else its place in the day: "1", "2" … */
  readonly label: string
  readonly start: Date
  readonly end: Date
}

/** The shifts of working days as windows, labelled by their names or their order in the day. */
export function shiftWindows(days: readonly { readonly date: BusinessDate; readonly shifts: readonly { readonly label: string | null; readonly start: Date; readonly end: Date }[] }[]): ShiftWindow[] {
  return days.flatMap((day) => day.shifts.map((shift, index) => ({ day: day.date, label: shift.label?.trim() || String(index + 1), start: shift.start, end: shift.end })))
}

/** The shift an hour (by its start) belongs to, or null outside every shift. */
export function shiftOfHour(hourStart: Date, windows: readonly ShiftWindow[]): ShiftWindow | null {
  const time = hourStart.getTime()
  return windows.find((window) => time >= window.start.getTime() && time < window.end.getTime()) ?? null
}
