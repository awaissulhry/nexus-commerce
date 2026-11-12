import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { PROMISE_REASON_CODES as CUSTOMER_REASON_CODES, PROMISE_REASON_WORDS as CUSTOMER_REASON_WORDS } from '../../sales/portal-orders/promise'
import { currentPromiseOf, PROMISE_REASON_CODES, type CurrentPromise, type PromiseRow, type StoredPromise } from '../promise/rules'

/**
 * Keeping promises (B-W2b-317; PLN-173): ONE promise history per order line, on B-W2b-286's append-only PromiseRecord rows.
 * The first promise of a line (and of a size) is kept forever; every later date is a RE_PROMISE row with its reason, so the
 * slips are counted honestly (design planning.promise "First promise (kept forever)", "Changes: count of slips").
 *
 * A size's promise over time is the walk of the line's rows in the order they were made: a row of the size sets it; a row
 * of every size sets it while the size has no row of its own (B-W2b-301's `currentPromiseOf`: a size's own newest row wins,
 * then the line's newest every-size row, then the date sales typed). Each change of that date is a change; a change to a
 * later day is a slip.
 *
 * W1's "Change promise date" (sales/orders `orders.changePromise`) overwrote the order's (or the lines') date; from this step
 * on it also writes the rows (`typedChangeRowsOf`): the line's first promise first (the date it had, kept), then the new
 * date for every size, and for each size promised apart the new date too, so the line's new date reaches every size.
 */

/** A stored row with what the history shows of it. */
export interface HistoryRow extends StoredPromise {
  readonly reasonCode: string | null
  readonly reason: string | null
  readonly customerToldAt: Date | null
}

/** One step of a size's promise over time. */
export interface TimelineStep {
  readonly rowId: string
  readonly date: BusinessDate
  readonly kind: 'FIRST' | 'RE_PROMISE'
  readonly at: Date
  /** The day it moved from (null: the first). */
  readonly from: BusinessDate | null
  /** Days later (+) or earlier (−) than the date before; null for the first. */
  readonly shiftDays: number | null
  readonly ownSize: boolean
}

const byTime = <T extends { readonly promisedAt: Date; readonly id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.promisedAt.getTime() - b.promisedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** The promise of one size over time (null: the line as one unit, a made-to-measure line). */
export function sizeTimeline(size: string | null, rows: readonly StoredPromise[]): TimelineStep[] {
  const steps: TimelineStep[] = []
  let own = false
  let date: BusinessDate | null = null
  for (const row of byTime(rows)) {
    const mine = size !== null && row.size === size
    if (!mine && row.size !== null) continue
    if (!mine && own) continue
    if (mine) own = true
    if (date === row.promisedDate && steps.length > 0) continue
    steps.push({ rowId: row.id, date: row.promisedDate, kind: row.kind, at: row.promisedAt, from: date, shiftDays: date === null ? null : daysFrom(date, row.promisedDate), ownSize: mine })
    date = row.promisedDate
  }
  return steps
}

export interface SizeHistory {
  readonly size: string | null
  /** The first promise kept forever: the first row reaching the size, else the date typed first (W1's originalPromiseDate). */
  readonly first: { readonly date: BusinessDate; readonly source: 'RECORD' | 'TYPED' } | null
  readonly current: CurrentPromise | null
  /** How many times its date changed after the first. */
  readonly changes: number
  /** How many of those moved it later. */
  readonly slips: number
  /** Days from the first promise to the current one (+ later); null without both. */
  readonly driftDays: number | null
  readonly lastChangeAt: Date | null
}

/** A size's history: first, current, changes and slips. `typed` is the date typed now, `original` the first one typed. */
export function sizeHistoryOf(size: string | null, rows: readonly StoredPromise[], typed: BusinessDate | null, original: BusinessDate | null): SizeHistory {
  const steps = sizeTimeline(size, rows)
  const current = currentPromiseOf(size, rows, typed)
  const firstDate = steps[0]?.date ?? original ?? typed
  const first = steps[0] ? { date: steps[0].date, source: 'RECORD' as const } : firstDate ? { date: firstDate, source: 'TYPED' as const } : null
  const moves = steps.slice(1)
  return {
    size,
    first,
    current,
    changes: moves.length,
    slips: moves.filter((step) => (step.shiftDays ?? 0) > 0).length,
    driftDays: first && current ? daysFrom(first.date, current.date) : null,
    lastChangeAt: moves.length > 0 ? moves[moves.length - 1]!.at : null,
  }
}

/** A slip (a move later) of the size made in [from, to). */
export const slippedBetween = (steps: readonly TimelineStep[], from: Date, to: Date): boolean =>
  steps.some((step) => step.from !== null && (step.shiftDays ?? 0) > 0 && step.at.getTime() >= from.getTime() && step.at.getTime() < to.getTime())

const latest = (dates: readonly (BusinessDate | null)[]): BusinessDate | null => dates.reduce<BusinessDate | null>((best, date) => (date === null ? best : best === null || date > best ? date : best), null)

/** A line's history: its first promise (the latest of its sizes' first: ship complete), its changes and slips (rows). */
export function lineHistoryOf(sizes: readonly (string | null)[], rows: readonly StoredPromise[], typed: BusinessDate | null, original: BusinessDate | null) {
  const perSize = sizes.map((size) => sizeHistoryOf(size, rows, typed, original))
  const slipRows = new Set<string>()
  const changeRows = new Set<string>()
  for (const size of sizes) {
    for (const step of sizeTimeline(size, rows).slice(1)) {
      changeRows.add(step.rowId)
      if ((step.shiftDays ?? 0) > 0) slipRows.add(step.rowId)
    }
  }
  const lastChange = perSize.reduce<Date | null>((best, entry) => (entry.lastChangeAt && (best === null || entry.lastChangeAt > best) ? entry.lastChangeAt : best), null)
  return {
    sizes: perSize,
    first: latest(perSize.map((entry) => entry.first?.date ?? null)),
    current: latest(perSize.map((entry) => entry.current?.date ?? null)),
    changes: changeRows.size,
    slips: slipRows.size,
    lastChangeAt: lastChange,
  }
}

// ---- W1's typed change writes the rows (PLN-173) -------------------------------------------------------------------------

/**
 * The reason code a W1 reason text names (`MATERIAL_LATE`, `MATERIAL_LATE: tannery batch 12 late`, or the curated words in
 * Italian or English, as the portal reads them), else null: the text itself is kept as the row's words.
 */
export function namedReasonCode(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const head = /^\s*\[?([A-Za-z_]+)\]?\s*(?::|$)/.exec(text)?.[1]?.toUpperCase()
  if (head && (PROMISE_REASON_CODES as readonly string[]).includes(head)) return head
  const fold = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '')
  const folded = fold(text)
  return CUSTOMER_REASON_CODES.find((code) => fold(CUSTOMER_REASON_WORDS[code].it) === folded || fold(CUSTOMER_REASON_WORDS[code].en) === folded) ?? null
}

/** At most 2000 characters of words on a row (the database's limit). */
export const rowReason = (text: string | null | undefined): string | null => (typeof text === 'string' && text.trim() !== '' ? text.trim().slice(0, 2000) : null)

/**
 * The rows a W1 change of a line's typed promise writes (PLN-173). `first` is the line's first known promise when it has no
 * row yet (the order's first typed date): it becomes the line's FIRST row (a backfill, made when the order was), and the
 * new date a RE_PROMISE of every size; a line never promised before gets the new date as its FIRST. A line with rows gets a
 * RE_PROMISE of every size when its every-size date differs (or when it has none and some size has no row of its own), and
 * one per size promised apart whose date differs. Nothing is written for a date before the order's (the database refuses
 * it; W1's change still stands) or when every size already has the date.
 */
export function typedChangeRowsOf(input: {
  /** The line's sizes (a made-to-measure line: none). */
  readonly sizes: readonly string[]
  readonly rows: readonly StoredPromise[]
  readonly first: BusinessDate | null
  readonly date: BusinessDate
  readonly reason: string | null
  readonly orderDate: BusinessDate
}): PromiseRow[] {
  const reason = rowReason(input.reason)
  const reasonCode = namedReasonCode(input.reason)
  const move = (size: string | null): PromiseRow => ({ size, promisedDate: input.date, kind: 'RE_PROMISE', reasonCode, reason: reason ?? (reasonCode ? null : 'Promise date changed'), backfill: false })
  if (input.date < input.orderDate) return []
  if (input.rows.length === 0) {
    if (input.first === null || input.first < input.orderDate) return [{ size: null, promisedDate: input.date, kind: 'FIRST', reasonCode: null, reason: null, backfill: false }]
    const firstRow: PromiseRow = { size: null, promisedDate: input.first, kind: 'FIRST', reasonCode: null, reason: null, backfill: true }
    return input.first === input.date ? [firstRow] : [firstRow, move(null)]
  }
  const out: PromiseRow[] = []
  const every = byTime(input.rows.filter((row) => row.size === null))
  const everyDate = every.length > 0 ? every[every.length - 1]!.promisedDate : null
  const ownSizes = new Set(input.rows.flatMap((row) => (row.size === null ? [] : [row.size])))
  const someWithout = input.sizes.length === 0 || input.sizes.some((size) => !ownSizes.has(size))
  if (everyDate !== null ? everyDate !== input.date : someWithout) out.push(move(null))
  for (const size of input.sizes) {
    if (!ownSizes.has(size)) continue
    const current = currentPromiseOf(size, input.rows, null)
    if (current?.date !== input.date) out.push(move(size))
  }
  return out
}
