import type { Decimal } from 'decimal.js'
import { plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import type { MaterialPegging } from '../mrp/net'
import { orderQuantities } from '../settings/items'
import type { LotSizing } from './parameters'

/**
 * Lot sizing (B-W2b-318; PLN-006), pure: how a material's net need, by the day it is short, becomes the orders the plan
 * suggests. A run keeps ONE line per material and colour (W1) whose suggestion is the NEXT order to place; the lots after
 * it are the plan's later orders (the item's projected stock shows them: ../item-profile), which the next runs suggest as
 * the earlier ones are bought.
 *
 *   LOT_FOR_LOT   one order of the whole net need, on the first day short (W1, unchanged: `nextLotOf` says null)
 *   FIXED         orders of the fixed lot: walking the days, when what came before is used up, as many lots as the day
 *                 takes (what a lot brings beyond the need stays for the next days)
 *   MIN_MAX       orders by the row's order limits (W2a's minOrderQty, orderMultiple, maxOrderQty; planning/settings
 *                 `orderQuantities`): on the first day short, as much of what is still to come as the maximum allows, at
 *                 least the minimum, in steps; more orders on the same day while that day is still short
 *   PERIOD        one order per period: the need of the period's days from the first day short, then the next period
 *                 from the next day short after it
 *
 * The supplier's own rounding (whole units, its minimum and steps in its purchase unit: planning/buy, the approved
 * sources) still applies to the order after this. Quantities in the base unit, four decimals; a lot is never less than
 * the need of its first day. The method decides whether a row is read at all (ORDERS only): `lotRuleOf`.
 */

/** A row's lot sizing, as the run reads it (planning/settings ItemPlanning). */
export interface LotRule {
  readonly lotSizing: Exclude<LotSizing, 'LOT_FOR_LOT'>
  readonly fixedLotQty: string | null
  readonly lotPeriodDays: number | null
  readonly minOrderQty: string | null
  readonly orderMultiple: string | null
  readonly maxOrderQty: string | null
}

/** A row of ItemPlanning as lot sizing reads it (decimals as stored). */
export interface LotRow {
  readonly method: string
  readonly lotSizing: string
  readonly fixedLotQty: { toString(): string } | null
  readonly lotPeriodDays: number | null
  readonly minOrderQty: { toString(): string } | null
  readonly orderMultiple: { toString(): string } | null
  readonly maxOrderQty: { toString(): string } | null
}

const text = (value: { toString(): string } | null): string | null => (value === null ? null : decimalOf(value.toString()).toFixed(QUANTITY_SCALE))

/**
 * The rule a row sizes orders by; null: lot for lot (W1) — no row, LOT_FOR_LOT, a method other than ORDERS (reorder
 * rules order their own lot), FIXED without its lot, PERIOD without its days, MIN_MAX without any limit.
 */
export function lotRuleOf(row: LotRow | null): LotRule | null {
  if (!row || row.method !== 'ORDERS') return null
  const rule = { fixedLotQty: text(row.fixedLotQty), lotPeriodDays: row.lotPeriodDays, minOrderQty: text(row.minOrderQty), orderMultiple: text(row.orderMultiple), maxOrderQty: text(row.maxOrderQty) }
  if (row.lotSizing === 'FIXED') return rule.fixedLotQty !== null && decimalOf(rule.fixedLotQty).gt(0) ? { lotSizing: 'FIXED', ...rule } : null
  if (row.lotSizing === 'PERIOD') return rule.lotPeriodDays !== null && rule.lotPeriodDays >= 1 ? { lotSizing: 'PERIOD', ...rule } : null
  if (row.lotSizing === 'MIN_MAX') return rule.minOrderQty !== null || rule.orderMultiple !== null || rule.maxOrderQty !== null ? { lotSizing: 'MIN_MAX', ...rule } : null
  return null
}

/** What is short on one day (base unit). */
export interface LotNeed {
  readonly day: BusinessDate
  readonly quantity: string
}

/** One order the plan suggests for the material. */
export interface PlannedLot {
  /** 1: the next order to place (the run's suggestion before the supplier's rounding). */
  readonly seq: number
  /** The day it is needed (the first day it covers). */
  readonly date: BusinessDate
  readonly quantity: string
  /** The days whose need it covers (the last one: the day before the next lot, or the last day short). */
  readonly covers: { readonly from: BusinessDate; readonly to: BusinessDate }
}

const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

/**
 * The short quantity of a material by day, from its netting: NET (the run's suggestion: before a firm planned order, the
 * whole net need), or UNCOVERED (what is still to order after the firm planned order: the item profile's planned lots).
 */
export function needsOfPegging(pegging: Pick<MaterialPegging, 'coverage'>, of: 'NET' | 'UNCOVERED' = 'NET'): LotNeed[] {
  const byDay = new Map<BusinessDate, Decimal>()
  for (const entry of pegging.coverage) {
    const short = decimalOf(of === 'NET' ? entry.short : entry.uncovered)
    if (short.gt(0)) byDay.set(entry.day, (byDay.get(entry.day) ?? ZERO).plus(short))
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, quantity]) => ({ day, quantity: q(quantity) }))
}

/** The orders a material's need becomes under a rule (null: lot for lot, one order). */
export function plannedLots(rule: LotRule | null, needs: readonly LotNeed[]): PlannedLot[] {
  const days = needs.filter((need) => decimalOf(need.quantity).gt(0))
  if (days.length === 0) return []
  const last = days[days.length - 1]!.day
  const drafts: { date: BusinessDate; quantity: Decimal; to?: BusinessDate }[] = []
  if (rule === null) {
    drafts.push({ date: days[0]!.day, quantity: days.reduce((sum, need) => sum.plus(decimalOf(need.quantity)), ZERO), to: last })
  } else if (rule.lotSizing === 'PERIOD') {
    const period = Math.max(1, rule.lotPeriodDays ?? 1)
    let index = 0
    while (index < days.length) {
      const from = days[index]!.day
      const to = plusDays(from, period - 1)
      let quantity = ZERO
      while (index < days.length && days[index]!.day <= to) {
        quantity = quantity.plus(decimalOf(days[index]!.quantity))
        index += 1
      }
      drafts.push({ date: from, quantity, to: to < last ? to : last })
    }
  } else {
    // FIXED and MIN_MAX: walk the days with what the earlier lots left (`carry`); `after`: the need of the days after.
    const after = days.map((_, index) => days.slice(index + 1).reduce((sum, need) => sum.plus(decimalOf(need.quantity)), ZERO))
    let carry = ZERO
    days.forEach((need, index) => {
      carry = carry.minus(decimalOf(need.quantity))
      for (let guard = 0; carry.lt(0) && guard < 1000; guard += 1) {
        // MIN_MAX: as much of what is still to come as the limits allow (the first order of W2a's split).
        const lot = rule.lotSizing === 'FIXED' ? decimalOf(rule.fixedLotQty!) : decimalOf(orderQuantities(q(carry.negated().plus(after[index]!)), rule)[0]!)
        if (!lot.gt(0)) break
        drafts.push({ date: need.day, quantity: lot })
        carry = carry.plus(lot)
      }
    })
  }
  return drafts.map((draft, index) => {
    const next = drafts.slice(index + 1).find((other) => other.date > draft.date)
    const to = draft.to ?? (next ? plusDays(next.date, -1) : last)
    return { seq: index + 1, date: draft.date, quantity: q(draft.quantity), covers: { from: draft.date, to: to < draft.date ? draft.date : to } }
  })
}

/**
 * The run's suggestion before the supplier's rounding (planning/explode): the first lot's quantity under the rule; null
 * for lot for lot (the whole net need, W1) or when nothing is short.
 */
export function nextLotOf(rule: LotRule | null, pegging: Pick<MaterialPegging, 'coverage'>): string | null {
  if (rule === null) return null
  return plannedLots(rule, needsOfPegging(pegging))[0]?.quantity ?? null
}

/** The lots in one English sentence ("3 orders: 500 on 2026-11-20, …"). */
export function lotsWords(rule: LotRule | null, lots: readonly PlannedLot[], uom: string): string {
  if (lots.length === 0) return 'Nothing to order: the need is covered.'
  const how = rule === null ? 'lot for lot' : rule.lotSizing === 'FIXED' ? `in fixed lots of ${rule.fixedLotQty} ${uom}` : rule.lotSizing === 'PERIOD' ? `one order per ${rule.lotPeriodDays} day${rule.lotPeriodDays === 1 ? '' : 's'} of need` : 'within the order limits'
  const list = lots.slice(0, 5).map((lot) => `${lot.quantity} ${uom} on ${lot.date}`).join(', ')
  const more = lots.length > 5 ? ` and ${lots.length - 5} more` : ''
  return `${lots.length} order${lots.length === 1 ? '' : 's'} ${how}: ${list}${more}. The run suggests the first; the next runs suggest the others as the earlier ones are bought.`
}
