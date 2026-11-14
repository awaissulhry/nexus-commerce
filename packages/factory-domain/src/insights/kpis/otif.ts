import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { lineHistoryOf } from '../../planning/promise-keep/history'
import type { StoredPromise } from '../../planning/promise/rules'

/**
 * On-time and in-full (B-W2b-429; ANA-013 "order lines shipped complete by the first promised date and by the current date,
 * by customer, site and month"; design home.kpis "on-time delivery and OTIF"), pure. One sales order line at a time:
 *
 *   counted      a garment line (a size grid or a made-to-measure unit; never a fee line) of an order that is not cancelled,
 *                with pieces due (ordered less closed short > 0) and a promise
 *   first        the line's first promise, kept forever (B-W2b-317's promise history: the latest of its sizes' first
 *                promises, since the line ships complete only when every size has; else the first date typed on the order,
 *                else the date typed now)
 *   current      the line's promise now (the latest of its sizes' promises now, else the date typed)
 *   due          the line is due on the promise's day: that day the period counts it
 *   complete on  the day (company clock) the pieces that left (SHIPPED or DELIVERED shipments) first reached what is due
 *   on time      complete on or before the promise's day; a line not complete yet is late once its day has begun
 *
 * The KPI files delivery.otif (first) and delivery.otif_current (current) read the facts this makes (the DELIVERY source);
 * the drill (GET /insights/kpis/drills/otif) lists the same lines, by customer, site and month. Never per person.
 */

export const OTIF_PROMISES = ['FIRST', 'CURRENT'] as const
export type OtifPromise = (typeof OTIF_PROMISES)[number]

export const OTIF_OUTCOMES = ['ON_TIME', 'LATE'] as const
export type OtifOutcome = (typeof OTIF_OUTCOMES)[number]

export interface OtifLine {
  readonly kind: string
  readonly quantity: number
  readonly closedShortQuantity: number | null
  readonly firstPromise: BusinessDate | null
  readonly currentPromise: BusinessDate | null
  /** The pieces that left, with the day each shipment left on the company's clock. */
  readonly shipped: readonly { readonly day: BusinessDate; readonly quantity: number }[]
}

export interface OtifResult {
  readonly promise: BusinessDate
  readonly due: number
  readonly shippedByPromise: number
  readonly completeOn: BusinessDate | null
  readonly outcome: OtifOutcome
  /** Days after the promise it was complete (or, not complete yet, until today); 0 on time. */
  readonly lateDays: number
}

/** The line's first and current promise from its history (rows of the line), the date typed now and the first one typed. */
export function linePromises(sizes: readonly (string | null)[], rows: readonly StoredPromise[], typed: BusinessDate | null, original: BusinessDate | null): { first: BusinessDate | null; current: BusinessDate | null } {
  const history = lineHistoryOf(sizes.length > 0 ? sizes : [null], rows, typed, original)
  return { first: history.first, current: history.current }
}

/** What is due of a line: ordered less closed short, never below 0. */
export const dueOf = (line: Pick<OtifLine, 'quantity' | 'closedShortQuantity'>): number => Math.max(0, line.quantity - (line.closedShortQuantity ?? 0))

/** The day the pieces that left first reached `due` (null: not yet). */
export function completeOn(shipped: OtifLine['shipped'], due: number): BusinessDate | null {
  if (due <= 0) return null
  let total = 0
  for (const entry of [...shipped].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    total += entry.quantity
    if (total >= due) return entry.day
  }
  return null
}

/** A line's outcome on one promise, as of `today` (null: not counted — a fee line, nothing due, no promise). */
export function otifOf(line: OtifLine, promise: OtifPromise, today: BusinessDate): OtifResult | null {
  if (line.kind === 'FEE') return null
  const due = dueOf(line)
  const day = promise === 'FIRST' ? line.firstPromise : line.currentPromise
  if (due <= 0 || day === null) return null
  const complete = completeOn(line.shipped, due)
  const shippedByPromise = line.shipped.filter((entry) => entry.day <= day).reduce((total, entry) => total + entry.quantity, 0)
  const onTime = complete !== null && complete <= day
  const lateDays = onTime ? 0 : Math.max(0, daysFrom(day, complete ?? today))
  return { promise: day, due, shippedByPromise: Math.min(shippedByPromise, due), completeOn: complete, outcome: onTime ? 'ON_TIME' : 'LATE', lateDays }
}

export interface OtifCounts {
  due: number
  onTime: number
  dueCurrent: number
  onTimeCurrent: number
}

/** The measures per day: the lines due on it on their first and on their current promise, and those on time. */
export function otifByDay(lines: readonly OtifLine[], today: BusinessDate): Map<BusinessDate, OtifCounts> {
  const out = new Map<BusinessDate, OtifCounts>()
  const of = (day: BusinessDate) => out.get(day) ?? out.set(day, { due: 0, onTime: 0, dueCurrent: 0, onTimeCurrent: 0 }).get(day)!
  for (const line of lines) {
    const first = otifOf(line, 'FIRST', today)
    if (first) {
      const counts = of(first.promise)
      counts.due += 1
      if (first.outcome === 'ON_TIME') counts.onTime += 1
    }
    const current = otifOf(line, 'CURRENT', today)
    if (current) {
      const counts = of(current.promise)
      counts.dueCurrent += 1
      if (current.outcome === 'ON_TIME') counts.onTimeCurrent += 1
    }
  }
  return out
}
