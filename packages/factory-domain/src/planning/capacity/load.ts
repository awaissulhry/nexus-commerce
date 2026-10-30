import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'
import { minutesText } from './available'

/**
 * Load in standard minutes (PLN-116; B-W2a-16), pure: what the open work orders still ask of each line and work centre,
 * and when.
 *
 *   how much    per operation of a RELEASED or IN_PROGRESS work order: its standard minutes per garment (the FROZEN
 *               routing, copied onto WorkOrderOperation at release) × the garments still to do there: the work
 *               order's garments less the good and scrapped whole garments its standing scans report at the
 *               operation (production/scans wip). A held, draft, completed or cancelled work order books nothing.
 *   where       a work centre's load: every operation mapped to it. A line's load: the operations the planning board
 *               puts on it (slots of the site's WORKING plan on that line, their share of the operation's slots); an
 *               operation with no slot on any line goes to the line the work order is allocated to (WorkOrder.lineId),
 *               when that line does the operation's work centre (a line does the work centres of its active
 *               stations; a line without stations does every operation).
 *   when        the operation's slots in the WORKING plan (its own, else the work order's whole-order slots): each
 *               slot takes its share (by the minutes it booked; equal shares when none booked any) spread over its
 *               span by the lane's working minutes (by the clock when the span has none); an operation on no slot is
 *               placed on the work order's due date (not on the board yet: `placedBy` DUE_DATE), or nowhere when the
 *               work order has no due date (NO_DATE).
 *   who         nobody: per line, work centre and work order only (Statuto dei Lavoratori art. 4; Owner answer F2).
 */

export const LOADING_STATUSES = ['RELEASED', 'IN_PROGRESS'] as const
export const LANE_KINDS = ['LINE', 'WORK_CENTRE'] as const
export type LaneKind = (typeof LANE_KINDS)[number]

export interface LoadOperation {
  readonly id: string
  readonly seq: number
  readonly code: string
  readonly name: string
  /** Per garment, a decimal string (the frozen routing's). */
  readonly standardMinutes: string
  readonly workCentreId: string
  /** Whole garments done there (good + scrapped by the standing scans). */
  readonly done: number
}

export interface LoadWorkOrder {
  readonly id: string
  readonly dueDate: BusinessDate | null
  readonly lineId: string | null
  /** Garments of the work order (its cells). */
  readonly pieces: number
  readonly operations: readonly LoadOperation[]
}

export interface LoadSlot {
  readonly id: string
  readonly workOrderId: string
  /** null: the whole work order. */
  readonly operationId: string | null
  readonly lineId: string | null
  readonly workCentreId: string | null
  readonly startAt: Date
  readonly endAt: Date
  /** The standard minutes it booked when placed (a decimal string). */
  readonly minutes: string
}

/** What a line does: the work centres of its active stations; null: every operation (no stations). */
export interface LineScope {
  readonly lineId: string
  readonly workCentreIds: readonly string[] | null
}

export type Placement =
  | { readonly placedBy: 'SLOT'; readonly slotId: string; readonly start: Date; readonly end: Date }
  | { readonly placedBy: 'DUE_DATE'; readonly date: BusinessDate }
  | { readonly placedBy: 'NO_DATE' }

/** One part of an operation's load on one lane. */
export interface LoadPart {
  readonly laneKind: LaneKind
  readonly laneId: string
  readonly workOrderId: string
  readonly operationId: string
  /** Garments still to do at the operation (the whole operation's, also for a share). */
  readonly pieces: number
  readonly minutes: Decimal
  readonly placement: Placement
}

/** Standard minutes × garments, decimal. */
export const loadMinutes = (standardMinutes: string, pieces: number): Decimal => new Dec(standardMinutes).times(Math.max(0, pieces))

function shares(slots: readonly LoadSlot[]): Map<string, Decimal> {
  const booked = slots.map((slot) => new Dec(slot.minutes))
  const total = booked.reduce((sum, value) => sum.plus(value), new Dec(0))
  return new Map(slots.map((slot, index) => [slot.id, total.gt(0) ? booked[index]!.div(total) : new Dec(1).div(slots.length)]))
}

/** Every part of the open work orders' load, by the rules above. */
export function loadParts(workOrders: readonly LoadWorkOrder[], slots: readonly LoadSlot[], lines: readonly LineScope[]): LoadPart[] {
  const scopeOf = new Map(lines.map((line) => [line.lineId, line.workCentreIds]))
  const parts: LoadPart[] = []
  for (const workOrder of workOrders) {
    const own = slots.filter((slot) => slot.workOrderId === workOrder.id)
    const whole = own.filter((slot) => slot.operationId === null)
    for (const operation of workOrder.operations) {
      const pieces = Math.max(0, workOrder.pieces - operation.done)
      const minutes = loadMinutes(operation.standardMinutes, pieces)
      if (pieces === 0 || minutes.lte(0)) continue
      const opSlots = own.filter((slot) => slot.operationId === operation.id)
      const placedOn = opSlots.length > 0 ? opSlots : whole
      const share = shares(placedOn)
      const base = { workOrderId: workOrder.id, operationId: operation.id, pieces }
      const unplaced: Placement = workOrder.dueDate ? { placedBy: 'DUE_DATE', date: workOrder.dueDate } : { placedBy: 'NO_DATE' }
      const bySlot = (slot: LoadSlot): Placement => ({ placedBy: 'SLOT', slotId: slot.id, start: slot.startAt, end: slot.endAt })
      // The work centre: the whole operation, at its slots' times (whatever lane they are on), else its due date.
      if (placedOn.length > 0) {
        for (const slot of placedOn) parts.push({ ...base, laneKind: 'WORK_CENTRE', laneId: operation.workCentreId, minutes: minutes.times(share.get(slot.id)!), placement: bySlot(slot) })
      } else {
        parts.push({ ...base, laneKind: 'WORK_CENTRE', laneId: operation.workCentreId, minutes, placement: unplaced })
      }
      // The lines: the board's line slots, else the line the work order is allocated to (when it does the operation).
      const lineSlots = placedOn.filter((slot) => slot.lineId !== null)
      if (lineSlots.length > 0) {
        for (const slot of lineSlots) parts.push({ ...base, laneKind: 'LINE', laneId: slot.lineId!, minutes: minutes.times(share.get(slot.id)!), placement: bySlot(slot) })
        continue
      }
      const lineId = workOrder.lineId
      if (lineId === null || !scopeOf.has(lineId)) continue
      const does = scopeOf.get(lineId)
      if (does !== null && does !== undefined && !does.includes(operation.workCentreId)) continue
      if (placedOn.length > 0) {
        for (const slot of placedOn) parts.push({ ...base, laneKind: 'LINE', laneId: lineId, minutes: minutes.times(share.get(slot.id)!), placement: bySlot(slot) })
      } else {
        parts.push({ ...base, laneKind: 'LINE', laneId: lineId, minutes, placement: unplaced })
      }
    }
  }
  return parts
}

/** A bucket as instants: from its first day's local midnight to the day after its last. */
export interface TimedBucket {
  readonly key: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly start: Date
  readonly end: Date
}

/**
 * The minutes of a part per bucket. `working(from, to)`: the lane's working minutes between two instants, or null when
 * the lane's calendar was not loaded that far (the clock then decides the shares). Parts outside every bucket are left
 * out; a DUE_DATE part goes to the bucket of its date, a NO_DATE part nowhere.
 */
export function spreadPart(part: LoadPart, buckets: readonly TimedBucket[], working: (from: Date, to: Date) => number | null): Map<string, Decimal> {
  const out = new Map<string, Decimal>()
  const placement = part.placement
  if (placement.placedBy === 'NO_DATE') return out
  if (placement.placedBy === 'DUE_DATE') {
    const bucket = buckets.find((candidate) => placement.date >= candidate.from && placement.date <= candidate.to)
    if (bucket) out.set(bucket.key, part.minutes)
    return out
  }
  const start = placement.start.getTime()
  const end = placement.end.getTime()
  if (end <= start) {
    const bucket = buckets.find((candidate) => start >= candidate.start.getTime() && start < candidate.end.getTime())
    if (bucket) out.set(bucket.key, part.minutes)
    return out
  }
  const total = working(placement.start, placement.end)
  const byClock = total === null || total <= 0
  for (const bucket of buckets) {
    const from = Math.max(start, bucket.start.getTime())
    const to = Math.min(end, bucket.end.getTime())
    if (to <= from) continue
    const portion = byClock ? new Dec(to - from).div(end - start) : new Dec(working(new Date(from), new Date(to)) ?? 0).div(total)
    if (portion.gt(0)) out.set(bucket.key, (out.get(bucket.key) ?? new Dec(0)).plus(part.minutes.times(portion)))
  }
  return out
}

/** Booked against available: the percent (one decimal) and the minutes over; null percent when nothing is available. */
export function loadOf(booked: Decimal, available: Decimal): { loadPct: string | null; overMinutes: string } {
  const over = booked.minus(available)
  return {
    loadPct: available.gt(0) ? booked.div(available).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1) : null,
    overMinutes: minutesText(over.gt(0) ? over : new Dec(0)),
  }
}
