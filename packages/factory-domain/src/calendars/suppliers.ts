import type { BusinessDate } from '../core/time'
import { daysFrom, eachDay, plusDays } from './dates'
import { DEFAULT_WORKING_WEEKDAYS, closureOn, type DayKind, type WorkingCalendar } from './working-time'

/**
 * A supplier's closed days and the lead time across them (PLN-001; the W1 gap of the MRP's order-by date, B-W1-29
 * buy.ts; B-W2a-08), pure. A supplier's calendar stands alone: its working week and its dated closures (August,
 * Christmas). A lead time is in calendar days (Item.leadTimeDays, Party.leadTimeDays: the weekends are already in it),
 * so only the dated HOLIDAY and CLOSURE days stretch it: the supplier does not work on them.
 *
 *   order by    the need date less the lead time, counting back only the days the supplier is not closed: needed on
 *               1 September with 14 days and a closure from 3 to 28 August, order by about 23 July.
 *   arrival     the order date plus the lead time, counting forward the same way (the purchase order's "arrives on …
 *               at the earliest").
 *
 * A walk never skips more than MAX_SKIPPED_CLOSED_DAYS closed days (a calendar closed for good would never end it): it
 * stops there and says so (`capped`).
 */

export const MAX_SKIPPED_CLOSED_DAYS = 366

export interface ClosedDay {
  readonly date: BusinessDate
  readonly kind: Exclude<DayKind, 'WORKING'>
  readonly name: string
}

export interface ClosedSpan {
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly kind: Exclude<DayKind, 'WORKING'>
  readonly name: string
  readonly days: number
}

/** A supplier's dated closed days from `from` to `to` (none without a calendar). */
export function closedDaysOf(calendar: WorkingCalendar | null, from: BusinessDate, to: BusinessDate): ClosedDay[] {
  if (!calendar) return []
  const out: ClosedDay[] = []
  for (const date of eachDay(from, to)) {
    const closed = closureOn(calendar, date)
    if (closed && closed.kind !== 'WORKING') out.push({ date, kind: closed.kind, name: closed.name })
  }
  return out
}

/** The ISO weekdays a supplier never works in a normal week (Saturday and Sunday by default). */
export function weeklyDaysOffOf(calendar: WorkingCalendar | null): number[] {
  const week = calendar?.layers[0]?.workingWeekdays ?? DEFAULT_WORKING_WEEKDAYS
  return [1, 2, 3, 4, 5, 6, 7].filter((weekday) => !week.includes(weekday))
}

/** Consecutive closed days with the same kind and name, as spans ("closed 3–28 Aug: Supplier closed in August"). */
export function closedSpansOf(days: readonly ClosedDay[]): ClosedSpan[] {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const spans: ClosedSpan[] = []
  for (const day of sorted) {
    const last = spans.at(-1)
    if (last && last.kind === day.kind && last.name === day.name && daysFrom(last.to, day.date) === 1) {
      spans[spans.length - 1] = { ...last, to: day.date, days: last.days + 1 }
    } else {
      spans.push({ from: day.date, to: day.date, kind: day.kind, name: day.name, days: 1 })
    }
  }
  return spans
}

export interface LeadTimeWalk {
  /** The order-by date (back from the need date) or the arrival date (forward from the order date). */
  readonly date: BusinessDate
  readonly leadTimeDays: number
  /** The supplier's closed days the walk did not count. */
  readonly skipped: readonly ClosedDay[]
  /** The walk stopped after MAX_SKIPPED_CLOSED_DAYS closed days: the date is not reliable. */
  readonly capped: boolean
}

/** The window a walk of this lead time needs loaded around its start date (both included). */
export function leadTimeWindow(start: BusinessDate, leadTimeDays: number, direction: 'back' | 'forward'): { from: BusinessDate; to: BusinessDate } {
  const reach = leadTimeDays + MAX_SKIPPED_CLOSED_DAYS + 1
  return direction === 'back' ? { from: plusDays(start, -reach), to: start } : { from: start, to: plusDays(start, reach) }
}

function walk(calendar: WorkingCalendar | null, start: BusinessDate, leadTimeDays: number, step: 1 | -1): LeadTimeWalk {
  if (!Number.isSafeInteger(leadTimeDays) || leadTimeDays < 0) throw new RangeError(`not a lead time in days: ${String(leadTimeDays)}`)
  const skipped: ClosedDay[] = []
  let cursor = start
  let left = leadTimeDays
  while (left > 0) {
    cursor = plusDays(cursor, step)
    const closed = calendar ? closureOn(calendar, cursor) : null
    if (closed && closed.kind !== 'WORKING') {
      skipped.push({ date: cursor, kind: closed.kind, name: closed.name })
      if (skipped.length >= MAX_SKIPPED_CLOSED_DAYS) return { date: cursor, leadTimeDays, skipped, capped: true }
      continue
    }
    left -= 1
  }
  return { date: cursor, leadTimeDays, skipped: step < 0 ? skipped.reverse() : skipped, capped: false }
}

/** The day to order by: the need date less the lead time, the supplier's closed days not counted. */
export function orderByDate(calendar: WorkingCalendar | null, needDate: BusinessDate, leadTimeDays: number): LeadTimeWalk {
  return walk(calendar, needDate, leadTimeDays, -1)
}

/** The earliest arrival: the order date plus the lead time, the supplier's closed days not counted. */
export function arrivalDate(calendar: WorkingCalendar | null, orderDate: BusinessDate, leadTimeDays: number): LeadTimeWalk {
  return walk(calendar, orderDate, leadTimeDays, 1)
}
