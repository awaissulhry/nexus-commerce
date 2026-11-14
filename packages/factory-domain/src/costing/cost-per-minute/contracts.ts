import { z } from 'zod'
import { businessDate, currency, id, input, instant, output, quantity, unitPrice } from '../../core/contracts'
import { money } from '../../money/marked'
import { WORK_CENTRE_KINDS } from '../../product/routing/operations'
import { labourRateView } from '../contracts'
import { OVERHEAD_BASES } from '../overhead-rules/rules'

/**
 * The contracts of the cost-per-minute calculator (B-W2b-419; FIN-005; design finance.settings › Costing): what
 * apps/factory-api's modules/costing/cost-per-minute answers and the web's typed client reads. Every cost figure is
 * `money.cost` (dropped for a caller without the cost grain, refused in a body without it). Minutes are not money. Never a
 * headcount or a figure per person.
 */

const kind = () => z.enum(WORK_CENTRE_KINDS)
const note = () => z.string().trim().min(1).max(1000)

export const calcWorkCentreView = output({ id: id(), siteId: id(), code: z.string(), name: z.string() })

export const calcView = output({
  id: id(),
  companyId: id(),
  /** The department. */
  workCentreKind: kind(),
  /** One work centre of the department; null: the whole department. */
  workCentre: calcWorkCentreView.nullable(),
  key: z.string(),
  periodStart: businessDate(),
  periodEnd: businessDate(),
  currency: z.string(),
  /** The period's payroll total of the department (never one person's). */
  directLabourCost: money.cost(z.string()),
  availableMinutes: z.string(),
  indirectPerMinute: money.cost(z.string()),
  overheadPerMinute: money.cost(z.string()),
  costPerMinute: money.cost(z.string()),
  /** How the minutes were counted (no headcount, no person). */
  minutesBasis: z.record(z.string(), z.unknown()).nullable(),
  note: z.string().nullable(),
  /** The labour rate it became, from which day (null: not applied). */
  labourRateId: id().nullable(),
  appliedAt: instant().nullable(),
  appliedById: id().nullable(),
  /** In words, without a figure. */
  words: z.string(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type CalcView = z.infer<typeof calcView>

/** One calculation with the labour rate it became and what to look at before applying it. */
export const calcRecordView = calcView.extend({
  labourRate: labourRateView.nullable(),
  /** Warnings in words (overhead counted twice). */
  warnings: z.array(z.string()),
  /** The overhead absorbed in the rate waits for the accountant (GATE-ACCOUNTANT). */
  unverified: z.string(),
})
export type CalcRecordView = z.infer<typeof calcRecordView>

export const calcListQuery = input({
  companyId: id().optional(),
  workCentreKind: kind().optional(),
  workCentreId: id().optional(),
  /** true: applied ones only; false: not applied ones only. */
  applied: z.enum(['true', 'false']).optional(),
  /** Calculations whose period shares a day with this one. */
  from: businessDate().optional(),
  to: businessDate().optional(),
  cursor: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type CalcListQuery = z.infer<typeof calcListQuery>

export const createCalcBody = input({
  companyId: id(),
  workCentreKind: kind(),
  /** One work centre of the department (its site follows); left out: the whole department. */
  workCentreId: id().optional(),
  periodStart: businessDate(),
  periodEnd: businessDate(),
  /** Default and only value: the company's currency. */
  currency: currency().optional(),
  /** The department's payroll total for the period (never one person's). */
  directLabourCost: money.cost(unitPrice()),
  availableMinutes: quantity(),
  /** Default 0. */
  indirectPerMinute: money.cost(unitPrice()).optional(),
  /** Default 0 (UNVERIFIED: the accountant's word). */
  overheadPerMinute: money.cost(unitPrice()).optional(),
  /** How the minutes were counted: the prefill's `minutesBasis`, or your own words; no headcount, no person, no pay. */
  minutesBasis: z.record(z.string(), z.unknown()).optional(),
  note: note().optional(),
})
export type CreateCalcBody = z.infer<typeof createCalcBody>

/** A correction while not applied: only the fields sent change (the company, department and work centre never do). */
export const updateCalcBody = input({
  version: z.number().int().min(1),
  periodStart: businessDate().optional(),
  periodEnd: businessDate().optional(),
  directLabourCost: money.cost(unitPrice()).optional(),
  availableMinutes: quantity().optional(),
  indirectPerMinute: money.cost(unitPrice()).optional(),
  overheadPerMinute: money.cost(unitPrice()).optional(),
  minutesBasis: z.record(z.string(), z.unknown()).nullable().optional(),
  note: note().nullable().optional(),
})
export type UpdateCalcBody = z.infer<typeof updateCalcBody>

export const removeCalcQuery = input({ version: z.coerce.number().int().min(1) })

/**
 * Applied as the company's labour rate of the department from a day (today or later): the rate's planned efficiency is the
 * one in force for the department (else 100) unless sent.
 */
export const applyCalcBody = input({
  version: z.number().int().min(1),
  validFrom: businessDate(),
  plannedEfficiencyPct: z
    .string()
    .regex(/^\d{1,3}(?:\.\d{1,4})?$/, 'Expected a percentage with at most 3 digits and 4 decimals.')
    .optional(),
  /** The rate's note; default: where it came from. */
  note: z.string().trim().min(1).max(500).optional(),
})
export type ApplyCalcBody = z.infer<typeof applyCalcBody>

export const applyCalcAnswer = output({ calc: calcRecordView, rate: labourRateView })

/** The minutes of a department (or one work centre) for a period, from the calendars and the planned seats. */
export const prefillQuery = input({
  companyId: id(),
  workCentreKind: kind(),
  workCentreId: id().optional(),
  periodStart: businessDate(),
  periodEnd: businessDate(),
})
export type PrefillQuery = z.infer<typeof prefillQuery>

export const prefillCentreView = output({
  id: id(),
  siteId: id(),
  code: z.string(),
  name: z.string(),
  workingDays: z.number().int(),
  /** Its working minutes × its planned seats (the seats are not shown: no headcount next to a payroll total). */
  availableMinutes: z.string(),
  seatsFrom: z.enum(['CAPACITY', 'STATIONS']),
  /** The calendars that decided its days (its own, its site's, its company's); empty: the planning default week. */
  calendarIds: z.array(id()),
})

export const prefillView = output({
  companyId: id(),
  workCentreKind: kind(),
  periodStart: businessDate(),
  periodEnd: businessDate(),
  /** The company's currency (the calculation's). */
  currency: z.string(),
  availableMinutes: z.string(),
  workCentres: z.array(prefillCentreView),
  /** Send it back as the calculation's minutesBasis. */
  minutesBasis: z.record(z.string(), z.unknown()),
  /** The per-minute overhead rules in force for the department on the first day (UNVERIFIED). */
  overheadRules: z.array(output({ id: id(), companyId: id().nullable(), basis: z.enum(OVERHEAD_BASES), workCentreKind: kind().nullable(), value: money.cost(z.string()), currency: z.string().nullable() })),
  /** What those rules add a minute on the cost sheet. */
  overheadPerMinuteFromRules: money.cost(z.string()),
  /** In words: where the minutes come from, and what to look at (no seat, one seat, overhead twice). */
  words: z.array(z.string()),
})
export type PrefillView = z.infer<typeof prefillView>
