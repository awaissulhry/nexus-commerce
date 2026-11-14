import { daysFrom } from '../../calendars/dates'
import { businessDate, type BusinessDate } from '../../core/time'

/**
 * Work in progress with ageing (B-W2b-429; ANA-015 "units and value in each stage and how long they waited, by line"; design
 * production.reports "WIP ageing"), pure. Never per person: per site, line and stage (the operation of the routing).
 *
 *   in work      a work order from its release until it is completed, closed or cancelled (on hold stays in work)
 *   pieces       its garments (the size grid's quantities)
 *   age          whole days on the site's clock since its release; piece-days = pieces × age (the layer keeps both at each
 *                day's end, per site and line: wip.pieces and wip.piece_days; KPI production.wip_age_days is their ratio,
 *                the average age of a piece in work)
 *   waited       in the drill, how long the garments at a stage have waited: days since the work order last moved (its
 *                latest floor report), else since its start, else since its release
 *   value        in the drill, the work order's cost ledger balance (what sits on it at cost; only with the cost grain)
 */

export const WIP_AGE_BUCKETS = ['D0_2', 'D3_5', 'D6_10', 'D11_PLUS'] as const
export type WipAgeBucket = (typeof WIP_AGE_BUCKETS)[number]

export interface WipWorkOrderDates {
  readonly releasedAt: Date | null
  readonly completedAt: Date | null
  readonly closedAt: Date | null
  readonly cancelledAt: Date | null
}

/** When the work order left work (completed, closed or cancelled: the earliest), or null. */
export function endedAt(order: WipWorkOrderDates): Date | null {
  const stamps = [order.completedAt, order.closedAt, order.cancelledAt].filter((stamp): stamp is Date => stamp !== null)
  return stamps.length === 0 ? null : new Date(Math.min(...stamps.map((stamp) => stamp.getTime())))
}

/** Was it in work at this moment (released before it, not yet out of work)? */
export function inWorkAt(order: WipWorkOrderDates, at: Date): boolean {
  if (!order.releasedAt || order.releasedAt.getTime() >= at.getTime()) return false
  const ended = endedAt(order)
  return ended === null || ended.getTime() >= at.getTime()
}

/** Whole days from the day of an instant (on a clock) to a day; never below 0. */
export const ageDays = (since: Date, day: BusinessDate, timeZone: string): number => Math.max(0, daysFrom(businessDate(since, timeZone), day))

/** The age band of some days. */
export function ageBucketOf(days: number): WipAgeBucket {
  if (days <= 2) return 'D0_2'
  if (days <= 5) return 'D3_5'
  if (days <= 10) return 'D6_10'
  return 'D11_PLUS'
}

/** Since when the garments of a work order have waited: its latest report, else its start, else its release. */
export const waitingSince = (order: { readonly releasedAt: Date | null; readonly startedAt: Date | null; readonly lastReportAt: Date | null }): Date | null => order.lastReportAt ?? order.startedAt ?? order.releasedAt
