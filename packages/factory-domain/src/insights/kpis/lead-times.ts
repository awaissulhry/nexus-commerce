import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { Dec } from '../../tax/decimal'
import { completeOn, dueOf } from './otif'

/**
 * Lead times (B-W2b-429; ANA-014 "quote-to-order, order-to-ship and order-to-start times, median and spread, by product
 * family"), pure. Whole calendar days between two business days, one order at a time:
 *
 *   QUOTE_TO_ORDER   from the day the order's quote was first sent (any version of it) to the order date; an order made
 *                    without a quote has none
 *   ORDER_TO_SHIP    from the order date to the day its last garment left: every garment line shipped complete (ordered
 *                    less closed short); an order not complete yet has none
 *   ORDER_TO_START   from the order date to the day the first work order making one of its lines started
 *
 * An order counts on the day its time ends (the order date, the day it shipped complete, the day work started). The layer
 * keeps per day the sum of the days and the number of orders, so a KPI's value is the average (Σ days ÷ orders, the KPI
 * files sales.quote_to_order_days, delivery.order_to_ship_days, production.order_to_start_days); the median and the spread
 * (the middle half: the 25th to the 75th percentile) by product family are the drill's, from the same orders
 * (GET /insights/kpis/drills/lead-times). The family of an order is the product type of most of its garments.
 */

export const LEAD_KINDS = ['QUOTE_TO_ORDER', 'ORDER_TO_SHIP', 'ORDER_TO_START'] as const
export type LeadKind = (typeof LEAD_KINDS)[number]

/** Whole days from one business day to a later one; a negative span (typed dates out of order) counts as 0. */
export const leadDays = (from: BusinessDate, to: BusinessDate): number => Math.max(0, daysFrom(from, to))

/** The day an order's garments all left (null: something is still due, or nothing ever was). */
export function orderShippedOn(lines: readonly { readonly kind: string; readonly quantity: number; readonly closedShortQuantity: number | null; readonly shipped: readonly { readonly day: BusinessDate; readonly quantity: number }[] }[]): BusinessDate | null {
  let last: BusinessDate | null = null
  let any = false
  for (const line of lines) {
    if (line.kind === 'FEE') continue
    const due = dueOf(line)
    if (due <= 0) continue
    any = true
    const day = completeOn(line.shipped, due)
    if (day === null) return null
    if (last === null || day > last) last = day
  }
  return any ? last : null
}

/** The product family of most of the garments (ties: the first family in `order`); null without garments. */
export function familyOf(lines: readonly { readonly family: string; readonly pieces: number }[], order: readonly string[] = []): string | null {
  const sums = new Map<string, number>()
  for (const line of lines) if (line.pieces > 0) sums.set(line.family, (sums.get(line.family) ?? 0) + line.pieces)
  const rank = (family: string) => (order.indexOf(family) === -1 ? order.length : order.indexOf(family))
  return [...sums.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null
}

/** The q-quantile of sorted values (linear between the two nearest ranks). */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.ceil(position)
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below)
}

export interface LeadSummary {
  readonly orders: number
  /** Days, one decimal; null without orders. */
  readonly medianDays: string | null
  readonly p25Days: string | null
  readonly p75Days: string | null
  /** The middle half: p75 − p25. */
  readonly spreadDays: string | null
  readonly averageDays: string | null
  readonly minDays: number | null
  readonly maxDays: number | null
}

const oneDecimal = (value: number | null): string | null => (value === null ? null : new Dec(value).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1))

/** The median, spread, average and range of some orders' days. */
export function leadSummary(days: readonly number[]): LeadSummary {
  const sorted = [...days].sort((a, b) => a - b)
  const p25 = quantile(sorted, 0.25)
  const p75 = quantile(sorted, 0.75)
  return {
    orders: sorted.length,
    medianDays: oneDecimal(quantile(sorted, 0.5)),
    p25Days: oneDecimal(p25),
    p75Days: oneDecimal(p75),
    spreadDays: oneDecimal(p25 === null || p75 === null ? null : p75 - p25),
    averageDays: sorted.length === 0 ? null : new Dec(sorted.reduce((total, value) => total + value, 0)).div(sorted.length).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1),
    minDays: sorted[0] ?? null,
    maxDays: sorted.at(-1) ?? null,
  }
}
