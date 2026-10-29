import type { Issue } from '../core/errors'
import { fitsDecimal, isCurrencyCode, UNIT_PRICE } from '../core/money'
import { isBusinessDate } from '../core/time'
import { defineMachine } from '../state/machine'
import { decimalOf } from '../product/units/units'

/**
 * The labour rates' and costing settings' rules (features FIN-004, FIN-005; the design's "Costing parameters"), pure.
 * A rate is the cost of one standard minute at a kind of work centre, in a currency, with the planned efficiency it
 * assumes, in force from a day; a new figure from a later day is a new rate, a wrong one is corrected (audited) or
 * archived. The settings hold the overhead percentage. The same limits hold in the database (…_costing_guards).
 */

export const LABOUR_RATE_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type LabourRateStatus = (typeof LABOUR_RATE_STATUSES)[number]

/** Archived is final: a rate in use by quotes stays readable; a new one is made instead. */
export const labourRateMachine = defineMachine({ name: 'labourRate', states: LABOUR_RATE_STATUSES, transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: [] } })

/** Planned efficiency, percent: above 0, at most 200 (Decimal(7,4)). */
export const MAX_EFFICIENCY_PCT = '200'
/** Overhead, percent: 0 to 100 (Decimal(7,4)). */
export const MAX_OVERHEAD_PCT = '100'
const PERCENT = { precision: 7, scale: 4 } as const

/** A percentage as stored: a plain decimal with at most 3 digits and 4 decimals. */
export const isPercent = (value: unknown): value is string => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && fitsDecimal(value, PERCENT.precision, PERCENT.scale)

export interface RateFields {
  readonly costPerMinute: string
  readonly currency: string
  readonly plannedEfficiencyPct: string
  readonly validFrom: string
}

/** What is wrong with a rate's figures (paths are the body's field names). */
export function rateProblems(rate: Partial<RateFields>): Issue[] {
  const issues: Issue[] = []
  if (rate.costPerMinute !== undefined && !(/^\d+(?:\.\d+)?$/.test(rate.costPerMinute) && fitsDecimal(rate.costPerMinute, UNIT_PRICE.precision, UNIT_PRICE.scale))) {
    issues.push({ path: 'costPerMinute', message: 'Expected 0 or more, with at most 12 digits and 6 decimals.' })
  }
  if (rate.currency !== undefined && !isCurrencyCode(rate.currency)) issues.push({ path: 'currency', message: 'Expected an ISO 4217 currency code such as EUR.' })
  if (rate.plannedEfficiencyPct !== undefined) {
    if (!isPercent(rate.plannedEfficiencyPct) || !decimalOf(rate.plannedEfficiencyPct).gt(0) || decimalOf(rate.plannedEfficiencyPct).gt(MAX_EFFICIENCY_PCT)) {
      issues.push({ path: 'plannedEfficiencyPct', message: `Expected a percentage above 0 and at most ${MAX_EFFICIENCY_PCT}, with at most 4 decimals.` })
    }
  }
  if (rate.validFrom !== undefined && !isBusinessDate(rate.validFrom)) issues.push({ path: 'validFrom', message: 'Expected a calendar day written YYYY-MM-DD.' })
  return issues
}

/** What is wrong with an overhead percentage. */
export function overheadProblems(overheadPct: string): Issue[] {
  if (isPercent(overheadPct) && !decimalOf(overheadPct).gt(MAX_OVERHEAD_PCT)) return []
  return [{ path: 'overheadPct', message: `Expected a percentage from 0 to ${MAX_OVERHEAD_PCT}, with at most 4 decimals.` }]
}
