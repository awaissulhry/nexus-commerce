import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { uniformBuckets, weekStart, type Bucket } from '../settings/buckets'

/**
 * Available to promise (B-W2b-301; PLN-168; design planning.promise › atp "sizes × weeks; stock + planned receipts −
 * committed"), pure: one SKU (a colourway in one size) at one site, by week.
 *
 *   on hand      finished garments of the SKU at the site's finished-goods places now
 *   receipts     garments still to come out of open work orders and the plan's planned work orders, on their day
 *   committed    what open customer order lines still wait for, on their day (past due and undated: this week)
 *
 * cumulative(week) = on hand + receipts − committed up to that week; what can still be promised for delivery in a week is
 * the least cumulative of that week and every later one (a later commitment is never promised away: the look-ahead), never
 * below 0. A week whose cumulative is below 0 is short by that much. Whole garments; no money.
 */

export const ATP_DEFAULT_WEEKS = 12
export const ATP_MAX_WEEKS = 52

/** A receipt or a commitment of garments on a day (null: no day known; it counts this week). */
export interface AtpFlow {
  readonly date: BusinessDate | null
  readonly pieces: number
}

export interface AtpInput {
  readonly onHand: number
  readonly receipts: readonly AtpFlow[]
  readonly commitments: readonly AtpFlow[]
}

export interface AtpCell {
  readonly key: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  /** Garments arriving in the week (the first week: with the past due ones). */
  readonly receipts: number
  /** Garments customers wait for in the week (the first week: with the past due and undated ones). */
  readonly committed: number
  /** On hand + receipts − committed up to the end of the week. */
  readonly cumulative: number
  /** What can still be promised for delivery in this week or later (the look-ahead), 0 or more. */
  readonly available: number
  /** The cumulative is below 0 by this much (0: not short). */
  readonly short: number
  /** The last day a receipt arrives in the week; null: none. */
  readonly lastReceipt: BusinessDate | null
}

export interface AtpRow {
  readonly onHand: number
  readonly cells: readonly AtpCell[]
  /** What can be promised now (the first week's available). */
  readonly availableNow: number
  /** Receipts and commitments after the last week (not in the grid). */
  readonly later: { readonly receipts: number; readonly committed: number }
}

/** The weeks of the grid: this week's Monday to the Sunday of week `weeks` (the first starting today when asked). */
export function atpWeeks(today: BusinessDate, weeks: number): Bucket[] {
  const from = weekStart(today)
  return uniformBuckets(from, plusDays(from, weeks * 7 - 1), 'WEEK')
}

const whole = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

/** One SKU's row over the weeks. */
export function atpRow(input: AtpInput, weeks: readonly Bucket[]): AtpRow {
  const receipts = weeks.map(() => 0)
  const committed = weeks.map(() => 0)
  const lastReceipt: (BusinessDate | null)[] = weeks.map(() => null)
  const later = { receipts: 0, committed: 0 }
  const indexOf = (date: BusinessDate | null): number => {
    if (weeks.length === 0) return -1
    if (date === null || date <= weeks[0]!.to) return 0
    const index = weeks.findIndex((week) => date >= week.from && date <= week.to)
    return index
  }
  for (const flow of input.receipts) {
    const pieces = whole(flow.pieces)
    if (pieces === 0) continue
    const index = indexOf(flow.date)
    if (index < 0) {
      later.receipts += pieces
      continue
    }
    receipts[index]! += pieces
    if (flow.date !== null && (lastReceipt[index] === null || flow.date > lastReceipt[index]!)) lastReceipt[index] = flow.date
  }
  for (const flow of input.commitments) {
    const pieces = whole(flow.pieces)
    if (pieces === 0) continue
    const index = indexOf(flow.date)
    if (index < 0) later.committed += pieces
    else committed[index]! += pieces
  }
  const cumulative: number[] = []
  let running = whole(input.onHand)
  for (let index = 0; index < weeks.length; index++) {
    running += receipts[index]! - committed[index]!
    cumulative.push(running)
  }
  const available: number[] = weeks.map(() => 0)
  let least = Number.POSITIVE_INFINITY
  for (let index = weeks.length - 1; index >= 0; index--) {
    least = Math.min(least, cumulative[index]!)
    available[index] = Math.max(0, least)
  }
  const cells: AtpCell[] = weeks.map((week, index) => ({
    key: week.key,
    from: week.from,
    to: week.to,
    receipts: receipts[index]!,
    committed: committed[index]!,
    cumulative: cumulative[index]!,
    available: available[index]!,
    short: Math.max(0, -cumulative[index]!),
    lastReceipt: lastReceipt[index]!,
  }))
  return { onHand: whole(input.onHand), cells, availableNow: available[0] ?? 0, later }
}

/**
 * The earliest day `quantity` garments can be promised from the row: this week from today, a later week on the day its
 * last receipt arrives (its Monday without one); null when the grid never has that many.
 */
export function stockDateFor(row: AtpRow, quantity: number, today: BusinessDate): BusinessDate | null {
  if (quantity <= 0) return today
  const index = row.cells.findIndex((cell) => cell.available >= quantity)
  if (index < 0) return null
  if (index === 0) return today
  const cell = row.cells[index]!
  const day = cell.lastReceipt ?? cell.from
  return day < today ? today : day
}

/** The rows of many SKUs added up (a colourway's or a style's total). */
export function atpTotal(rows: readonly AtpRow[], weeks: readonly Bucket[]): AtpRow {
  const cells: AtpCell[] = weeks.map((week, index) => {
    const of = (pick: (cell: AtpCell) => number) => rows.reduce((sum, row) => sum + pick(row.cells[index]!), 0)
    const days = rows.flatMap((row) => (row.cells[index]!.lastReceipt ? [row.cells[index]!.lastReceipt!] : []))
    return {
      key: week.key,
      from: week.from,
      to: week.to,
      receipts: of((cell) => cell.receipts),
      committed: of((cell) => cell.committed),
      cumulative: of((cell) => cell.cumulative),
      available: of((cell) => cell.available),
      short: of((cell) => cell.short),
      lastReceipt: days.length === 0 ? null : days.reduce((a, b) => (a > b ? a : b)),
    }
  })
  return {
    onHand: rows.reduce((sum, row) => sum + row.onHand, 0),
    cells,
    availableNow: cells[0]?.available ?? 0,
    later: { receipts: rows.reduce((sum, row) => sum + row.later.receipts, 0), committed: rows.reduce((sum, row) => sum + row.later.committed, 0) },
  }
}
