import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import type { PlanOrderLine, PlanWarning } from '../explode'

/**
 * Nothing planned in the past (B-W2b-306; PLN-083 "no past-dated plans, with dated planned orders"), pure. A run never
 * dates a planned order before its day: late demand starts today, its planned work is due on the earliest day it can be
 * ready, and the run says so with a LATE warning per order line, once:
 *
 *   past due     the order line's date is before the run's day ("SO-0001 line 10 was due 2026-11-01, 11 days ago: it is
 *                planned from today")
 *   cannot make  its planned work cannot be ready by its date even starting today ("… is due 2026-11-14; its planned work
 *                is ready 2026-11-18 at the earliest, 4 days late")
 *
 * A planned purchase keeps the day its need falls on (the requirement's need date is the demand's, a fact); the line's view
 * dates it today at the earliest (`plannedDateOf`), and W2a's exception list says a short material ordered today is late.
 */

/** The planned order's date: its need, never before today. */
export const plannedDateOf = (needDate: BusinessDate, today: BusinessDate): BusinessDate => (needDate < today ? today : needDate)

/** One order line's lateness the run found (its date, and its planned work's earliest day when that is later). */
export interface LateLine {
  readonly line: Pick<PlanOrderLine, 'orderId' | 'orderNumber' | 'orderLineId' | 'lineSeq' | 'dueDate'>
  /** The earliest day its planned work can be ready (null: no planned work, or in time). */
  readonly readyDate: BusinessDate | null
}

/** The LATE warnings of a run, one per order line, in the lines' order. */
export function lateWarnings(lines: readonly LateLine[], runDate: BusinessDate): PlanWarning[] {
  const out: PlanWarning[] = []
  const seen = new Set<string>()
  for (const { line, readyDate } of lines) {
    if (seen.has(line.orderLineId) || line.dueDate === null) continue
    const label = `${line.orderNumber} line ${line.lineSeq}`
    if (line.dueDate < runDate) {
      seen.add(line.orderLineId)
      const ago = daysFrom(line.dueDate, runDate)
      out.push({ code: 'LATE', message: `${label} was due ${line.dueDate}, ${ago} ${ago === 1 ? 'day' : 'days'} ago: its work and material are planned from today (${runDate}).${readyDate ? ` Its planned work is ready ${readyDate} at the earliest.` : ''}`, orderId: line.orderId, orderLineId: line.orderLineId })
    } else if (readyDate !== null && readyDate > line.dueDate) {
      seen.add(line.orderLineId)
      const days = daysFrom(line.dueDate, readyDate)
      out.push({ code: 'LATE', message: `${label} is due ${line.dueDate}; its planned work is ready ${readyDate} at the earliest, ${days} ${days === 1 ? 'day' : 'days'} late, starting today (${runDate}).`, orderId: line.orderId, orderLineId: line.orderLineId })
    }
  }
  return out
}
