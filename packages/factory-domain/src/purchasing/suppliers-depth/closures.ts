import { plusDays } from '../../calendars/dates'
import { arrivalDate, closedDaysOf, closedSpansOf, weeklyDaysOffOf, type ClosedSpan } from '../../calendars/suppliers'
import type { WorkingCalendar } from '../../calendars/working-time'
import type { BusinessDate } from '../../core/time'

/**
 * A supplier's closures in its lead time (B-W2b-311; SCM-012; the calendars are B-W2a-08's: platform/calendars keeps a
 * supplier's dated HOLIDAY and CLOSURE days, calendars.suppliers.manage). A lead time is calendar days (weekends are in it
 * already); the supplier's dated closed days are not counted, so an order placed before the August closure arrives after
 * it. Pure: the API loads the calendar (platform/calendars supplierCalendarsFor) and asks here.
 */

/** How far ahead the supplier's record shows its closures. */
export const CLOSURES_AHEAD_DAYS = 365

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const dayWords = (date: BusinessDate): { readonly day: number; readonly month: string; readonly year: string } => ({ day: Number.parseInt(date.slice(8, 10), 10), month: MONTHS[Number.parseInt(date.slice(5, 7), 10) - 1]!, year: date.slice(0, 4) })

/** "3–28 Aug 2026", "30 Dec 2026 – 2 Jan 2027", "15 Aug 2026". */
export function spanDates(span: Pick<ClosedSpan, 'from' | 'to'>): string {
  const from = dayWords(span.from)
  const to = dayWords(span.to)
  if (span.from === span.to) return `${from.day} ${from.month} ${from.year}`
  if (from.year !== to.year) return `${from.day} ${from.month} ${from.year} – ${to.day} ${to.month} ${to.year}`
  if (from.month !== to.month) return `${from.day} ${from.month} – ${to.day} ${to.month} ${to.year}`
  return `${from.day}–${to.day} ${to.month} ${to.year}`
}

/** "closed 3–28 Aug 2026 (Summer closure)". */
export const spanWords = (span: ClosedSpan): string => `closed ${spanDates(span)}${span.name ? ` (${span.name})` : ''}`

export interface SupplierClosures {
  /** ISO weekdays it never works (Saturday and Sunday by default). */
  readonly weeklyDaysOff: readonly number[]
  /** Its dated closed days from `from` for CLOSURES_AHEAD_DAYS, as spans. */
  readonly ahead: readonly (ClosedSpan & { readonly words: string })[]
}

export function closuresAhead(calendar: WorkingCalendar | null, from: BusinessDate): SupplierClosures {
  return {
    weeklyDaysOff: weeklyDaysOffOf(calendar),
    ahead: closedSpansOf(closedDaysOf(calendar, from, plusDays(from, CLOSURES_AHEAD_DAYS))).map((span) => ({ ...span, words: spanWords(span) })),
  }
}

export interface OrderedOn {
  readonly orderDate: BusinessDate
  readonly leadTimeDays: number
  /** The earliest arrival, the closed days not counted. */
  readonly arrives: BusinessDate
  /** The closures the lead time walked past. */
  readonly skipped: readonly ClosedSpan[]
  /** More closed days than a walk counts: the date is not reliable. */
  readonly capped: boolean
  /** "Ordered on 2026-07-27, it arrives on 2026-09-07 at the earliest: 10 days' lead time, closed 3–28 Aug 2026 (Summer closure)." */
  readonly words: string
}

/** When an order placed on `orderDate` arrives at the earliest (null without a lead time). */
export function orderedOn(calendar: WorkingCalendar | null, orderDate: BusinessDate, leadTimeDays: number | null): OrderedOn | null {
  if (leadTimeDays === null) return null
  const walk = arrivalDate(calendar, orderDate, leadTimeDays)
  const skipped = closedSpansOf(walk.skipped)
  const lead = `${leadTimeDays} ${leadTimeDays === 1 ? "day's" : "days'"} lead time`
  const past = skipped.length === 0 ? '' : `, ${skipped.map(spanWords).join(', ')}`
  return {
    orderDate,
    leadTimeDays,
    arrives: walk.date,
    skipped,
    capped: walk.capped,
    words: `Ordered on ${orderDate}, it arrives on ${walk.date} at the earliest: ${lead}${past}.${walk.capped ? ' The supplier is closed for most of a year: the date is not reliable.' : ''}`,
  }
}
