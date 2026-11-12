import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { decimalOf } from '../../product/units/units'
import type { DemandPart, PartCoverage } from '../mrp/net'
import { usableFromArrival } from '../schedule-depth/material'

/**
 * Calculated delays (B-W2b-318; PLN-082), pure: when the supply cannot meet a demand's day, the earliest day it can, and
 * the delay said on the demand. For one material in one colour, from the plan's netting (planning/mrp/net coverage):
 *
 *   to order     what nothing covers yet (the plan's PLANNED share) arrives at the earliest on `arrival`: today plus the
 *                lead time, the supplier's closed days not counted (the API walks them: calendars/suppliers
 *                `arrivalDate`; a MAKE line: today plus the make lead time); no lead time on record: today, and said so
 *   firm, late   a firm planned order that covers it after its day (FIRM late) arrives on its date (today at the earliest)
 *   overdue      a purchase order line due before today and not received counts from today
 *   usable       the day after it arrives, or the item's delay days later (ItemPlanning.delayDays: THE rule of
 *                planning/schedule-depth `usableFromArrival`), then the site's first working day on or after it (the API's
 *                calendars service: `onWorkingDay`)
 *
 * A demand is delayed when that day is after the day it is needed; supply the netting counted in time (stock, a
 * reservation, a purchase line due on or before the day and not overdue, a firm order in time) never delays it.
 */

export const DELAY_SOURCES = ['PLANNED', 'FIRM', 'PURCHASE_ORDER'] as const
export type DelaySource = (typeof DELAY_SOURCES)[number]

export interface DelayFacts {
  readonly today: BusinessDate
  /** A new supply's earliest arrival (see above). */
  readonly arrival: BusinessDate
  readonly leadTimeDays: number | null
  readonly delayDays: number | null
  /** The site's first working day on or after a day (the day itself when there is no calendar). */
  readonly onWorkingDay: (day: BusinessDate) => BusinessDate
}

export interface DelayedPart {
  readonly part: DemandPart
  /** The day it is needed. */
  readonly day: BusinessDate
  /** The earliest day its material is usable. */
  readonly usable: BusinessDate
  readonly arrival: BusinessDate
  readonly daysLate: number
  readonly source: DelaySource
  /** The purchase order line that is overdue (PURCHASE_ORDER). */
  readonly purchaseOrderLineId: string | null
}

const later = (a: BusinessDate, b: BusinessDate): BusinessDate => (a > b ? a : b)

/** The earliest usable day of a supply that arrives on `arrival` (the delay days, then the site's working day). */
export const usableDay = (facts: Pick<DelayFacts, 'delayDays' | 'onWorkingDay'>, arrival: BusinessDate): BusinessDate => facts.onWorkingDay(usableFromArrival(arrival, facts.delayDays))

/** The delayed demand of one material (its coverage as netted), latest first. */
export function calculatedDelays(coverage: readonly PartCoverage[], facts: DelayFacts): DelayedPart[] {
  const out: DelayedPart[] = []
  for (const entry of coverage) {
    const candidates: { source: DelaySource; arrival: BusinessDate; purchaseOrderLineId: string | null }[] = []
    if (decimalOf(entry.uncovered).gt(0)) candidates.push({ source: 'PLANNED', arrival: facts.arrival, purchaseOrderLineId: null })
    for (const supply of entry.supplies) {
      if (!decimalOf(supply.quantity).gt(0)) continue
      if (supply.kind === 'FIRM' && supply.late && supply.date) candidates.push({ source: 'FIRM', arrival: later(supply.date, facts.today), purchaseOrderLineId: null })
      if (supply.kind === 'PURCHASE_ORDER' && supply.date && supply.date < facts.today) candidates.push({ source: 'PURCHASE_ORDER', arrival: facts.today, purchaseOrderLineId: supply.purchaseOrderLineId ?? null })
    }
    let worst: DelayedPart | null = null
    for (const candidate of candidates) {
      const usable = usableDay(facts, candidate.arrival)
      if (usable <= entry.day) continue
      const daysLate = daysFrom(entry.day, usable)
      if (worst === null || usable > worst.usable) worst = { part: entry.part, day: entry.day, usable, arrival: candidate.arrival, daysLate, source: candidate.source, purchaseOrderLineId: candidate.purchaseOrderLineId }
    }
    if (worst) out.push(worst)
  }
  return out.sort((a, b) => b.daysLate - a.daysLate || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || (a.part.key < b.part.key ? -1 : 1))
}

/** "SEED-SO-0001 line 10, size 52 needs SEED-LTH-100 BLK on 2026-11-20; it can be used on 2026-11-30 at the earliest: 10 days late." */
export function delayWords(delayed: DelayedPart, label: string, leadTimeDays: number | null): string {
  const who = `${delayed.part.orderNumber} line ${delayed.part.lineSeq}${delayed.part.size ? `, size ${delayed.part.size}` : ''}${delayed.part.workOrderNumber ? ` (${delayed.part.workOrderNumber})` : ''}`
  const why =
    delayed.source === 'PLANNED'
      ? leadTimeDays === null
        ? 'it is not ordered yet and has no lead time on record (counted as here today)'
        : `it is not ordered yet: ordered today, it arrives on ${delayed.arrival} (${leadTimeDays} day${leadTimeDays === 1 ? '' : 's'})`
      : delayed.source === 'FIRM'
        ? `its firm planned order is dated ${delayed.arrival}`
        : 'its purchase order line is overdue and not received (counted from today)'
  return `${who} needs ${label} on ${delayed.day}; ${why}, usable on ${delayed.usable} at the earliest: ${delayed.daysLate} day${delayed.daysLate === 1 ? '' : 's'} late.`
}
