import type { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { fitsDecimal, UNIT_PRICE } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { COST_SCALE, decimalOf, decimalText, roundTo } from '../../product/units/units'

/**
 * Standard costs (B-W2a-21; FIN-024; design finance.costing "Standard cost per item"), pure: what one base unit of an item
 * should cost in a period, for one company. factory-db's StandardCost keeps them (cost-ledger.prisma, the
 * …_money_w2a_guards trigger holds the same rules); apps/factory-api's modules/costing/standards writes them.
 *
 *   DRAFT    prepared (from the cost sheet, the item's standard purchase price, or typed) and free to change or discard
 *   FROZEN   fixed for its period: nothing changes but its end, set once when the next standard takes over
 *
 * The parts (material, labour, subcontract, overhead) are 0 or more, at most 6 decimals each; the unit cost is their exact
 * sum. Two FROZEN standards of one company and item never share a day: freezing one ends the open one before it on the
 * day before its first day, and is refused (in words) when another frozen one starts on or after that first day, or
 * when the one before it has its end set already and reaches into the new period.
 */

export const STANDARD_COST_STATUSES = ['DRAFT', 'FROZEN'] as const
export type StandardCostStatus = (typeof STANDARD_COST_STATUSES)[number]

/** Where a standard comes from: the cost sheet of a made item, the purchase price of a bought one, or typed by finance. */
export const STANDARD_COST_SOURCES = ['ROLLUP', 'PURCHASE', 'MANUAL'] as const
export type StandardCostSource = (typeof STANDARD_COST_SOURCES)[number]

/** What an event says happened to a standard. */
export const STANDARD_COST_CHANGES = ['prepared', 'updated', 'discarded', 'frozen', 'ended'] as const
export type StandardCostChange = (typeof STANDARD_COST_CHANGES)[number]

export const STANDARD_PARTS = ['materialCost', 'labourCost', 'subcontractCost', 'overheadCost'] as const
export type StandardPart = (typeof STANDARD_PARTS)[number]
export type StandardParts = Readonly<Record<StandardPart, string>>

const COST_ROUND = { scale: COST_SCALE, rounding: 'HALF_UP' } as const

/** A cost figure as stored: rounded half up to 6 places, as plain text ("4.2", "0"). */
export const costText = (value: Decimal | string): string => decimalText(roundTo(value, COST_ROUND))

/** Each part is a decimal of 0 or more with at most 6 places and 12 digits before the dot. Issues name `<path>/<part>`. */
export function partsProblems(parts: Partial<StandardParts>, path = 'body'): Issue[] {
  const issues: Issue[] = []
  for (const part of STANDARD_PARTS) {
    const value = parts[part]
    if (value === undefined) continue
    if (!fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale)) {
      issues.push({ path: `${path}/${part}`, message: 'Expected a decimal with at most 12 digits before and 6 after the dot.' })
    } else if (decimalOf(value).isNegative()) {
      issues.push({ path: `${path}/${part}`, message: 'A cost is 0 or more.' })
    }
  }
  return issues
}

/** The unit cost: the exact sum of the parts (each already at most 6 places, so the sum is too). */
export function unitCostOf(parts: StandardParts): string {
  return decimalText(STANDARD_PARTS.reduce((sum, part) => sum.plus(decimalOf(parts[part])), decimalOf('0')))
}

/** The period's days are valid and the end is not before the start. */
export function periodProblems(validFrom: string, validTo: string | null, path = 'body'): Issue[] {
  const issues: Issue[] = []
  if (!isBusinessDate(validFrom)) issues.push({ path: `${path}/validFrom`, message: 'Expected a calendar day written YYYY-MM-DD.' })
  if (validTo !== null && !isBusinessDate(validTo)) issues.push({ path: `${path}/validTo`, message: 'Expected a calendar day written YYYY-MM-DD.' })
  if (issues.length === 0 && validTo !== null && validTo < validFrom) issues.push({ path: `${path}/validTo`, message: `The last day is not before the first day (${validFrom}).` })
  return issues
}

const DAY_MS = 24 * 60 * 60 * 1000
const dayShift = (day: BusinessDate, by: number): BusinessDate => new Date(Date.parse(`${day}T00:00:00.000Z`) + by * DAY_MS).toISOString().slice(0, 10)
export const dayBefore = (day: BusinessDate): BusinessDate => dayShift(day, -1)
export const dayAfter = (day: BusinessDate): BusinessDate => dayShift(day, 1)

/** A standard's period and state, as the freeze and the "in force" reads need it. */
export interface StandardPeriod {
  readonly id: string
  readonly status: StandardCostStatus
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
  readonly currency: string
}

/** The FROZEN standard in force on `day` (in `currency`, when given): its period holds the day. */
export function standardOn<T extends StandardPeriod>(rows: readonly T[], day: BusinessDate, currency?: string): T | null {
  const inForce = rows.filter((row) => row.status === 'FROZEN' && (currency === undefined || row.currency === currency) && row.validFrom <= day && (row.validTo === null || row.validTo >= day))
  return [...inForce].sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : 0))[0] ?? null
}

const overlaps = (a: Pick<StandardPeriod, 'validFrom' | 'validTo'>, b: Pick<StandardPeriod, 'validFrom' | 'validTo'>): boolean =>
  a.validFrom <= (b.validTo ?? '9999-12-31') && (a.validTo ?? '9999-12-31') >= b.validFrom

/** What freezing a DRAFT needs: the frozen standard to end (on the day before its first day), or why it cannot be frozen. */
export interface FreezePlan {
  readonly end: { readonly id: string; readonly validTo: BusinessDate } | null
  readonly problem: string | null
}

export function freezePlan(target: Pick<StandardPeriod, 'id' | 'validFrom' | 'validTo'>, others: readonly StandardPeriod[]): FreezePlan {
  let end: FreezePlan['end'] = null
  // In date order: the one before the new first day is answered first, then the later ones.
  for (const other of [...others].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0))) {
    if (other.id === target.id || other.status !== 'FROZEN' || !overlaps(other, target)) continue
    if (other.validFrom >= target.validFrom) {
      return {
        end: null,
        problem: `The standard frozen from ${other.validFrom} covers part of this period: give this one a last day before ${other.validFrom}, or a first day after ${other.validTo ?? 'that one ends'}.`,
      }
    }
    if (other.validTo !== null) {
      return { end: null, problem: `The standard frozen from ${other.validFrom} to ${other.validTo} covers ${target.validFrom}; its end is set already: start this one after ${other.validTo}.` }
    }
    end = { id: other.id, validTo: dayBefore(target.validFrom) }
  }
  return { end, problem: null }
}
