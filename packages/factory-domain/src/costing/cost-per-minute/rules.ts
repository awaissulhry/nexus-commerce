import { plusDays } from '../../calendars/dates'
import type { Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY, UNIT_PRICE } from '../../core/money'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import type { WorkCentreKind } from '../../product/routing/operations'
import { Dec } from '../../tax/decimal'

/**
 * The cost-per-minute calculator's rules (B-W2b-419; FIN-005; design finance.settings › Costing "Cost-per-minute calculator";
 * CostPerMinuteCalc of B-W2b-378), pure. For a company's department (a kind of work centre), or one work centre of it, and
 * whole months: the period's direct labour cost over the minutes the department was available, plus indirect labour and
 * overhead per minute, is the cost per minute, rounded once, half up, to 6 places (the database computes it again and
 * refuses another figure). Applied once by a person, it becomes the company's labour rate of that kind from a day.
 *
 * Never a figure about a single person (Statuto dei Lavoratori art. 4; the Owner's rule): the labour cost is the
 * department's payroll total, the minutes come from its calendars and its planned seats (Planning settings), and neither
 * a headcount nor anything per person is kept with the calculation. A department or work centre planned with one seat is
 * refused: its cost per minute would be one person's pay.
 *
 * UNVERIFIED (GATE-ACCOUNTANT): the overhead absorbed in the rate (overhead per minute) waits for the accountant's word, as
 * every overhead rule does (../overhead-rules/rules.ts); a calculation changes no cost until a person applies it.
 */

/** `cpm:<companyId>:<kind>:<workCentreId | all>` (the database's key; one applied calculation per key and first day). */
export const cpmKey = (companyId: string, kind: WorkCentreKind, workCentreId: string | null): string => `cpm:${companyId}:${kind}:${workCentreId ?? 'all'}`

/** A calculation covers at most a year. */
export const MAX_CALC_MONTHS = 12
/** How many bytes the minutes' basis may hold as text (the database's limit). */
export const MAX_BASIS_BYTES = 65_536

const dayOfMonth = (day: BusinessDate): number => Number(day.slice(8, 10))
/** The last day of the month of a day. */
export const monthEnd = (day: BusinessDate): BusinessDate => {
  const [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))]
  const next = month === 12 ? `${year + 1}-01-01` : `${day.slice(0, 5)}${String(month + 1).padStart(2, '0')}-01`
  return plusDays(next, -1)
}
/** Whole months from the first day of one to the last day of another (both included). */
export const monthsOf = (periodStart: BusinessDate, periodEnd: BusinessDate): number =>
  (Number(periodEnd.slice(0, 4)) - Number(periodStart.slice(0, 4))) * 12 + Number(periodEnd.slice(5, 7)) - Number(periodStart.slice(5, 7)) + 1

/**
 * What is wrong with a period of whole months: the first day of a month, the last day of a month not before it (`end`
 * null: open-ended, where `open` allows it), at most `maxMonths`. Paths are `<prefix>periodStart` and `<prefix>periodEnd`.
 */
export function monthsProblems(periodStart: string, periodEnd: string | null, options: { readonly open?: boolean; readonly maxMonths?: number; readonly prefix?: string } = {}): Issue[] {
  const prefix = options.prefix ?? 'body/'
  const issues: Issue[] = []
  if (!isBusinessDate(periodStart) || dayOfMonth(periodStart) !== 1) issues.push({ path: `${prefix}periodStart`, message: 'Expected the first day of a month, written YYYY-MM-01.' })
  if (periodEnd === null) {
    if (!options.open) issues.push({ path: `${prefix}periodEnd`, message: 'Send the last day of a month.' })
    return issues
  }
  if (!isBusinessDate(periodEnd) || monthEnd(periodEnd) !== periodEnd) {
    issues.push({ path: `${prefix}periodEnd`, message: 'Expected the last day of a month, written YYYY-MM-DD.' })
    return issues
  }
  if (issues.length > 0) return issues
  if (periodEnd < periodStart) return [{ path: `${prefix}periodEnd`, message: `The last day is not before the first day (${periodStart}).` }]
  if (options.maxMonths !== undefined && monthsOf(periodStart, periodEnd) > options.maxMonths) {
    return [{ path: `${prefix}periodEnd`, message: `At most ${options.maxMonths} months.` }]
  }
  return []
}

/** The figures of a calculation, as decimal strings. */
export interface CalcFigures {
  readonly directLabourCost: string
  readonly availableMinutes: string
  readonly indirectPerMinute: string
  readonly overheadPerMinute: string
}

const PLAIN = /^\d+(?:\.\d+)?$/
const costOk = (value: string): boolean => PLAIN.test(value) && fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale)

/** What is wrong with the figures sent (paths `body/<field>`): costs 0 or more (6 places), minutes above 0 (4 places). */
export function figuresProblems(figures: Partial<CalcFigures>): Issue[] {
  const issues: Issue[] = []
  for (const field of ['directLabourCost', 'indirectPerMinute', 'overheadPerMinute'] as const) {
    const value = figures[field]
    if (value !== undefined && !costOk(value)) issues.push({ path: `body/${field}`, message: 'Expected 0 or more, with at most 12 digits and 6 decimals.' })
  }
  const minutes = figures.availableMinutes
  if (minutes !== undefined && !(PLAIN.test(minutes) && fitsDecimal(minutes, QUANTITY.precision, QUANTITY.scale) && new Dec(minutes).gt(0))) {
    issues.push({ path: 'body/availableMinutes', message: 'Expected more than 0 minutes, with at most 14 digits and 4 decimals.' })
  }
  return issues
}

/**
 * The cost per minute: direct ÷ minutes + indirect + overhead, rounded once, half up, to 6 places (as the database's
 * round(…, 6) of the same numerics); written with its 6 places. Throws on figures that are not plain decimals.
 */
export function costPerMinuteOf(figures: CalcFigures): string {
  return new Dec(figures.directLabourCost).div(figures.availableMinutes).plus(figures.indirectPerMinute).plus(figures.overheadPerMinute).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)
}

/** True when a cost per minute fits the column (Decimal(18,6): at most 12 digits before the dot). */
export const fitsCostPerMinute = (value: string): boolean => fitsDecimal(value, UNIT_PRICE.precision, UNIT_PRICE.scale)

/** A work centre's share of the department's available minutes: its working minutes in the period × its planned seats. */
export interface CentreMinutes {
  readonly workingMinutes: number
  readonly seats: number
}

/** The available minutes of the work centres counted: Σ working minutes × seats, as a decimal string. */
export function availableMinutesOf(centres: readonly CentreMinutes[]): string {
  return centres.reduce((sum, centre) => sum.plus(new Dec(centre.workingMinutes).times(centre.seats)), new Dec(0)).toFixed()
}

/** A work centre's planned seats (Planning settings): its capacity's units, else its active stations (planning's own rule). */
export const seatsOf = (units: number | null, activeStations: number): number => units ?? activeStations

/**
 * Words that would make the minutes' basis hold a figure about a person: a headcount, a person, a pay. Checked as keys at
 * every depth (case and separators ignored).
 */
export const PERSONAL_BASIS_WORDS = ['headcount', 'people', 'person', 'persons', 'operator', 'operators', 'employee', 'employees', 'worker', 'workers', 'seats', 'wage', 'wages', 'salary', 'pay'] as const
const PERSONAL = new Set<string>(PERSONAL_BASIS_WORDS)
const keyWords = (key: string): string[] =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0)

function personalKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) value.forEach((item, index) => personalKeys(item, `${path}/${index}`, found))
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (keyWords(key).some((word) => PERSONAL.has(word))) found.push(`${path}/${key}`)
      personalKeys(item, `${path}/${key}`, found)
    }
  }
}

/** What is wrong with how the minutes were counted: an object of at most 64 KiB, with no headcount, person or pay in it. */
export function minutesBasisProblems(basis: unknown, path = 'body/minutesBasis'): Issue[] {
  if (basis === null || basis === undefined) return []
  if (typeof basis !== 'object' || Array.isArray(basis)) return [{ path, message: 'Expected an object.' }]
  if (new TextEncoder().encode(JSON.stringify(basis)).length > MAX_BASIS_BYTES) return [{ path, message: 'At most 64 KiB.' }]
  const found: string[] = []
  personalKeys(basis, path, found)
  return found.map((at) => ({ path: at, message: "How the minutes were counted holds no headcount, no person and no pay: the department's totals only." }))
}

/** Why a calculation write is refused, as the issue path `refusal/<code>`. */
export const CPM_REFUSALS = ['APPLIED', 'ANOTHER_APPLIED', 'PAST_DAY', 'CURRENCY', 'ONE_SEAT', 'NOT_OF_KIND', 'TOO_BIG', 'DATABASE'] as const
export type CpmRefusal = (typeof CPM_REFUSALS)[number]

/** The words of each refusal (a screen shows them from the code). */
export const CPM_REFUSAL_WORDS: Readonly<Record<Exclude<CpmRefusal, 'DATABASE'>, string>> = Object.freeze({
  APPLIED: 'This calculation was applied as a labour rate: it changes no more and is kept. Make a new calculation instead.',
  ANOTHER_APPLIED: 'Another calculation of this department and period was applied already: one labour rate per department and period.',
  PAST_DAY: 'A labour rate from a past day would price work already costed at another rate: choose today or a later day.',
  CURRENCY: "A calculation is in its company's currency: a labour rate in another one is listed as missing on every cost sheet.",
  ONE_SEAT: "One planned seat: its cost per minute would be one person's pay (no figure about a single person). Calculate the whole department, or plan its seats on Planning settings.",
  NOT_OF_KIND: 'The work centre is not an active one of this company and department.',
  TOO_BIG: 'The cost per minute is too big to keep (at most 12 digits before the dot): check the labour cost and the minutes.',
})

/** The calculation in words, without a figure (a caller without the cost grain reads them too); `validFrom`: its rate's first day. */
export function calcWords(applied: boolean, validFrom: BusinessDate | null): string {
  if (!applied) return 'Not applied: no cost uses it until a person applies it as the labour rate of the department.'
  return validFrom ? `Applied: the labour rate from ${validFrom} came from this calculation. It changes no more.` : 'Applied as the labour rate of the department. It changes no more.'
}

/** The note of a labour rate applied from a calculation, unless the person writes one. */
export const appliedRateNote = (periodStart: BusinessDate, periodEnd: BusinessDate): string => `From the cost-per-minute calculation of ${periodStart} to ${periodEnd}.`

/** The warning when the rate carries overhead per minute while per-minute overhead rules add it on the cost sheet too. */
export const OVERHEAD_TWICE =
  'Per-minute overhead rules are in force for this department: the cost sheet adds them on top of the labour rate. Keep the overhead per minute here at 0, or archive those rules, so the overhead is not counted twice.'

/** Words when what the calculation covers has no planned seat: its minutes cannot come from the calendars. */
export const NO_SEATS = 'No planned seat (no capacity on Planning settings and no active station): type the available minutes by hand.'

/** The words of the minutes' source, for the screen (UNVERIFIED overhead aside). */
export const MINUTES_FROM_WORDS =
  "Working minutes of each work centre's calendar (or its site's, or the company's) in the period × its planned seats (Planning settings: capacity, else active stations). Department totals only."
