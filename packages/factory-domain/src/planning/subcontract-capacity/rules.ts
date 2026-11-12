import { plusDays } from '../../calendars/dates'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Work to subcontractors (B-W2b-321; PLN-124, PLN-162, PLN-164, PLN-165), pure. The API (apps/factory-api
 * modules/planning/subcontract-capacity, capacity/subcontractors.ts) reads the rows and calls these rules.
 *
 *   capacity   a workshop's weekly capacity per kind of work (SubcontractorCapacity: minutes or garments a week, from a
 *              day until a day; kind null = all its work). One row per workshop, kind and day (no two periods overlap),
 *              one unit per workshop and kind. A week's capacity is spread over its weekdays (Monday to Friday) the
 *              workshop is not closed: a week with two closed days has 3/5 of it. A workshop with no row: capacity unknown
 *              ("—", never 0).
 *   load       the work at a workshop (a job: a live subcontract order's operations, a part of a work order the allocation
 *              board put there with no order yet, a planned subcontract order of the plan), spread evenly over the
 *              workshop's open weekdays from the job's first day to the day it is due back. In MINUTES: the operations'
 *              standard minutes × the pieces still to come back; in PIECES: the garments (a garment counts once for all the
 *              operations of the job). A kind's row counts the operations of that kind; the row with no kind all of them.
 *   offered    a workshop gets work only when it is an active workshop with a stock location at the site, not on hold or
 *              blocked as a supplier, qualified for every operation sent (B-W2b-315's qualification: the kind of work or
 *              the operation) and, when it is said to be a subcontractor (its supplier kinds), with a DURC in force
 *              (D.Lgs. 276/2003 art. 29). Each hold and warning has a code and its words.
 *   outside    the work a whole-order drop sends: the operations already outside (outsourced) or whose routing step is
 *              outside work, with work left; when there are none, the making (sewing, assembly, finishing) with work left.
 */

export const CAPACITY_UNITS = ['MINUTES', 'PIECES'] as const
export type CapacityUnit = (typeof CAPACITY_UNITS)[number]
export const PER_WEEK_MAX = 1_000_000
export const NOTE_MAX = 2000
/** The days a kit travels to a workshop when the workshop has no lead time of its own (the design's "start − 2 transport days"). */
export const DEFAULT_TRANSPORT_DAYS = 2
/** The kit leaves at 08:00 site time on its day. */
export const KIT_HOUR = 8
/** What terzisti do when no step says it: the making. */
export const MAKING_KINDS: readonly string[] = Object.freeze(['SEWING', 'ASSEMBLY', 'FINISHING'])
/** The work order states an operation goes outside or back in (the database's rule). */
export const SWITCH_STATES: readonly string[] = Object.freeze(['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'])
/** At most this many parts in one "Create subcontract orders". */
export const MAX_PARTS = 50

const lowerFirst = (words: string): string => (words.length === 0 ? words : words.charAt(0).toLowerCase() + words.slice(1))
const kindWords = (kind: string | null): string => (kind === null ? 'all work' : kind.toLowerCase())
const unitWords = (unit: CapacityUnit): string => (unit === 'MINUTES' ? 'minutes' : 'garments')
export const capacityWords = (row: { readonly workCentreKind: string | null; readonly unit: CapacityUnit; readonly perWeek: number }): string =>
  `${row.perWeek.toLocaleString('en-GB')} ${unitWords(row.unit)} a week for ${kindWords(row.workCentreKind)}`

// ---- capacity rows ---------------------------------------------------------------------------------------------------------

export interface CapacityRow {
  readonly id: string
  readonly partyId: string
  readonly workCentreKind: string | null
  readonly unit: CapacityUnit
  readonly perWeek: number
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
}

/** What is wrong with a row's fields as given (paths under body/). */
export function capacityProblems(row: { readonly perWeek?: number | undefined; readonly validFrom?: BusinessDate | undefined; readonly validTo?: BusinessDate | null | undefined; readonly note?: string | null | undefined }): Issue[] {
  const issues: Issue[] = []
  if (row.perWeek !== undefined && (!Number.isSafeInteger(row.perWeek) || row.perWeek < 1 || row.perWeek > PER_WEEK_MAX)) issues.push({ path: 'body/perWeek', message: `A whole number from 1 to ${PER_WEEK_MAX.toLocaleString('en-GB')} a week.` })
  if (row.validFrom !== undefined && row.validTo !== undefined && row.validTo !== null && row.validTo < row.validFrom) issues.push({ path: 'body/validTo', message: 'The last day is on or after the first.' })
  if (row.note !== undefined && row.note !== null && row.note.length > NOTE_MAX) issues.push({ path: 'body/note', message: `At most ${NOTE_MAX} characters.` })
  return issues
}

const overlap = (a: Pick<CapacityRow, 'validFrom' | 'validTo'>, b: Pick<CapacityRow, 'validFrom' | 'validTo'>): boolean =>
  (a.validTo === null || a.validTo >= b.validFrom) && (b.validTo === null || b.validTo >= a.validFrom)

/** Why a row may not stand beside the workshop's others: a period of the same kind that overlaps, or another unit for the kind. */
export function conflictProblem(others: readonly CapacityRow[], row: Omit<CapacityRow, 'id'> & { readonly id: string | null }): Issue | null {
  const same = others.filter((other) => other.id !== row.id && other.partyId === row.partyId && other.workCentreKind === row.workCentreKind)
  const unit = same.find((other) => other.unit !== row.unit)
  if (unit) return { path: 'body/unit', message: `The capacity for ${kindWords(row.workCentreKind)} is counted in ${unitWords(unit.unit)}: keep ${unitWords(unit.unit)}, or remove those rows first.` }
  const clash = same.find((other) => overlap(other, row))
  if (clash) return { path: 'body/validFrom', message: `It overlaps the capacity for ${kindWords(row.workCentreKind)} from ${clash.validFrom}${clash.validTo ? ` to ${clash.validTo}` : ''}: end that one first, or start after it.` }
  return null
}

/** The row of a workshop and kind in force on a day (null kind = the row for all work). */
export const rowOn = (rows: readonly CapacityRow[], partyId: string, kind: string | null, day: BusinessDate): CapacityRow | null =>
  rows.find((row) => row.partyId === partyId && row.workCentreKind === kind && row.validFrom <= day && (row.validTo === null || row.validTo >= day)) ?? null

/** Monday to Friday. */
export const isWeekday = (day: BusinessDate): boolean => {
  const weekday = new Date(`${day}T12:00:00.000Z`).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

/** The days from `from` to `to`, both included. */
export function daysBetween(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = []
  for (let day = from; day <= to && out.length < 800; day = plusDays(day, 1)) out.push(day)
  return out
}

/** One capacity line of a workshop: its kind (null: all its work) and unit. */
export interface CapacityKey {
  readonly partyId: string
  readonly workCentreKind: string | null
  readonly unit: CapacityUnit
}

/** The capacity lines of the workshops: one per workshop and kind its rows name (one unit each). */
export function keysOf(rows: readonly CapacityRow[]): CapacityKey[] {
  const out = new Map<string, CapacityKey>()
  for (const row of [...rows].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))) {
    const key = `${row.partyId}|${row.workCentreKind ?? '*'}`
    if (!out.has(key)) out.set(key, { partyId: row.partyId, workCentreKind: row.workCentreKind, unit: row.unit })
  }
  const order = (key: CapacityKey): string => `${key.partyId}|${key.workCentreKind ?? ''}`
  return [...out.values()].sort((a, b) => (order(a) < order(b) ? -1 : 1))
}

/** A line's capacity over some days: perWeek ÷ 5 on each weekday the workshop is open and a row is in force. */
export function capacityOver(rows: readonly CapacityRow[], key: CapacityKey, days: readonly BusinessDate[], closed: ReadonlySet<BusinessDate>): { readonly amount: Decimal; readonly openDays: number; readonly closedDays: number; readonly known: boolean } {
  let amount = new Dec(0)
  let openDays = 0
  let closedDays = 0
  let known = false
  for (const day of days) {
    if (!isWeekday(day)) continue
    if (closed.has(day)) {
      closedDays += 1
      continue
    }
    const row = rowOn(rows, key.partyId, key.workCentreKind, day)
    if (!row || row.unit !== key.unit) continue
    known = true
    openDays += 1
    amount = amount.plus(new Dec(row.perWeek).div(5))
  }
  return { amount, openDays, closedDays, known }
}

// ---- load ------------------------------------------------------------------------------------------------------------------

export const JOB_KINDS = ['ORDER', 'ALLOCATION', 'PLANNED'] as const
export type JobKind = (typeof JOB_KINDS)[number]

/** Work at a workshop. */
export interface WorkshopJob {
  readonly kind: JobKind
  /** The subcontract order, the allocation slot or the planned work order. */
  readonly id: string
  readonly partyId: string
  readonly workOrderId: string | null
  readonly from: BusinessDate
  readonly to: BusinessDate
  /** Garments still to come back (PIECES). */
  readonly garments: number
  /** Its operations: kind of work and the standard minutes still to come back. */
  readonly operations: readonly { readonly workCentreKind: string; readonly minutes: string }[]
}

/** What a job puts on a capacity line: minutes of its operations of the kind (all for no kind), or its garments. */
export function jobAmount(job: WorkshopJob, key: Pick<CapacityKey, 'workCentreKind' | 'unit'>): Decimal {
  const operations = key.workCentreKind === null ? job.operations : job.operations.filter((operation) => operation.workCentreKind === key.workCentreKind)
  if (key.unit === 'PIECES') return operations.length > 0 ? new Dec(job.garments) : new Dec(0)
  return operations.reduce((sum, operation) => sum.plus(operation.minutes), new Dec(0))
}

/** A job's amount per day: even over the workshop's open weekdays from its first day to its last (all on its first day when it has none). */
export function spreadJob(amount: Decimal, job: Pick<WorkshopJob, 'from' | 'to'>, closed: ReadonlySet<BusinessDate>): Map<BusinessDate, Decimal> {
  const last = job.to < job.from ? job.from : job.to
  const open = daysBetween(job.from, last).filter((day) => isWeekday(day) && !closed.has(day))
  const days = open.length > 0 ? open : [job.from]
  const share = amount.div(days.length)
  return new Map(days.map((day) => [day, share]))
}

/** Booked against available, as the capacity screen writes it: one decimal; null when nothing is available. */
export function loadPctOf(booked: Decimal, available: Decimal): string | null {
  if (!available.gt(0)) return null
  return booked.div(available).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

/** Minutes or garments with one decimal (a share of a spread job). */
export const amountText = (value: Decimal): string => value.toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)

// ---- offered workshops (PLN-162) -------------------------------------------------------------------------------------------

export const HOLD_CODES = ['NOT_A_WORKSHOP', 'NOT_ACTIVE', 'SUPPLIER_STATUS', 'NO_LOCATION', 'NOT_QUALIFIED', 'NO_VALID_DURC'] as const
export type HoldCode = (typeof HOLD_CODES)[number]
export const WARNING_CODES = ['CONDITIONAL', 'DURC_EXPIRING', 'DURC_NOT_CHECKED', 'OVER_CAPACITY', 'NO_CAPACITY_SET'] as const
export type WarningCode = (typeof WARNING_CODES)[number]

export interface NeedAnswer {
  /** "sewing (Op 20 Armour pockets)". */
  readonly label: string
  readonly qualified: boolean
  readonly standing: string
  readonly words: string
}

export interface WorkshopFacts {
  readonly name: string
  readonly isWorkshop: boolean
  readonly active: boolean
  /** B-W2b-311's supplier status problem (on hold, blocked, inactive), or null. */
  readonly supplierProblem: string | null
  readonly siteName: string
  readonly hasLocation: boolean
  readonly needs: readonly NeedAnswer[]
  /** The DURC asked of a workshop whose supplier kinds say SUBCONTRACTOR (B-W2b-315's vault); checked false: kinds not set. */
  readonly durc: { readonly checked: boolean; readonly state: 'MET' | 'EXPIRING' | 'EXPIRED' | 'MISSING'; readonly expiresOn: BusinessDate | null }
  /** The capacity while the work would be there: over 100 %, unknown (no row). */
  readonly capacity: { readonly known: boolean; readonly over: boolean; readonly loadPct: string | null } | null
}

export interface Verdict {
  readonly offered: boolean
  readonly held: readonly { readonly code: HoldCode; readonly words: string }[]
  readonly warnings: readonly { readonly code: WarningCode; readonly words: string }[]
}

/** Whether a workshop is offered for the work, the holds and the warnings in words. */
export function verdictOf(facts: WorkshopFacts): Verdict {
  const held: { code: HoldCode; words: string }[] = []
  const warnings: { code: WarningCode; words: string }[] = []
  if (!facts.isWorkshop) held.push({ code: 'NOT_A_WORKSHOP', words: `${facts.name} has no subcontractor role.` })
  if (!facts.active) held.push({ code: 'NOT_ACTIVE', words: `${facts.name} is not active.` })
  if (facts.supplierProblem) held.push({ code: 'SUPPLIER_STATUS', words: facts.supplierProblem })
  if (!facts.hasLocation) held.push({ code: 'NO_LOCATION', words: `${facts.name} has no stock location at ${facts.siteName}: the kit has nowhere to go (a SUBCONTRACTOR location it owns).` })
  for (const need of facts.needs) {
    if (!need.qualified) held.push({ code: 'NOT_QUALIFIED', words: `Not approved for ${need.label}: ${lowerFirst(need.words)}` })
    else if (need.standing === 'CONDITIONAL') warnings.push({ code: 'CONDITIONAL', words: `Approved for ${need.label} with conditions: ${lowerFirst(need.words.replace(/^Qualified with conditions:\s*/, ''))}` })
  }
  if (!facts.durc.checked) warnings.push({ code: 'DURC_NOT_CHECKED', words: `${facts.name}'s supplier kinds are not set: its DURC is not checked.` })
  else if (facts.durc.state === 'MISSING') held.push({ code: 'NO_VALID_DURC', words: 'No valid DURC on file (D.Lgs. 276/2003 art. 29): ask the workshop for it.' })
  else if (facts.durc.state === 'EXPIRED') held.push({ code: 'NO_VALID_DURC', words: `No valid DURC: it expired on ${facts.durc.expiresOn ?? 'a day passed'}.` })
  else if (facts.durc.state === 'EXPIRING') warnings.push({ code: 'DURC_EXPIRING', words: `Its DURC expires on ${facts.durc.expiresOn}.` })
  if (facts.capacity && !facts.capacity.known) warnings.push({ code: 'NO_CAPACITY_SET', words: `${facts.name} has no weekly capacity set: its load is not known.` })
  else if (facts.capacity?.over) warnings.push({ code: 'OVER_CAPACITY', words: `${facts.name} would be at ${facts.capacity.loadPct}% of its capacity while the work is there.` })
  return { offered: held.length === 0, held, warnings }
}

// ---- the work sent out -------------------------------------------------------------------------------------------------------

export interface OperationFacts {
  readonly id: string
  readonly seq: number
  readonly name: string
  readonly workCentreKind: string
  readonly outsourced: boolean
  /** Its routing step is outside work. */
  readonly outsideStep: boolean
  /** Garments still to do there. */
  readonly remaining: number
}

/** The operations a whole-order drop on a workshop sends (see above). */
export function outsideWorkOf<Op extends OperationFacts>(operations: readonly Op[]): Op[] {
  const left = operations.filter((operation) => operation.remaining > 0)
  const outside = left.filter((operation) => operation.outsourced || operation.outsideStep)
  return outside.length > 0 ? outside : left.filter((operation) => MAKING_KINDS.includes(operation.workCentreKind))
}

export const needLabel = (operation: Pick<OperationFacts, 'seq' | 'name' | 'workCentreKind'>): string => `${operation.workCentreKind.toLowerCase()} (Op ${operation.seq} ${operation.name})`

/** Why an operation cannot go outside now (empty: it can). */
export function outsideProblems(workOrder: { readonly number: string; readonly status: string }, operation: Pick<OperationFacts, 'seq' | 'name' | 'outsourced' | 'remaining'>): string[] {
  if (!SWITCH_STATES.includes(workOrder.status)) return [`${workOrder.number} is ${workOrder.status.toLowerCase()}: its operations stay where they are.`]
  if (operation.outsourced) return [`Op ${operation.seq} ${operation.name} is outside already: bring it back in first to send it elsewhere.`]
  if (operation.remaining <= 0) return [`Op ${operation.seq} ${operation.name} has no work left.`]
  return []
}

/** Why an outside operation cannot come back in now (empty: it can). */
export function inHouseProblems(workOrder: { readonly number: string; readonly status: string }, operation: Pick<OperationFacts, 'seq' | 'name' | 'outsourced'>, order: { readonly number: string; readonly status: string; readonly somethingOut: boolean } | null): string[] {
  if (!SWITCH_STATES.includes(workOrder.status)) return [`${workOrder.number} is ${workOrder.status.toLowerCase()}: its operations stay where they are.`]
  if (!operation.outsourced) return [`Op ${operation.seq} ${operation.name} is done in-house already.`]
  if (order && (order.somethingOut || !['DRAFT', 'ISSUED', 'CANCELLED', 'CLOSED'].includes(order.status))) return [`The kit or pieces of ${order.number} are at the workshop: take them back on the order first.`]
  return []
}

// ---- kit timing (PLN-164) ----------------------------------------------------------------------------------------------------

/** The days the work takes at the workshop: from its capacity (the amount ÷ a weekday's capacity, rounded up), else the routing's days, else one. */
export function workDaysOf(input: { readonly amount: Decimal | null; readonly perWeek: number | null; readonly routingDays: number | null; readonly transportDays: number }): { readonly days: number; readonly source: 'CAPACITY' | 'ROUTING' | 'DEFAULT' } {
  if (input.amount !== null && input.perWeek !== null && input.perWeek > 0 && input.amount.gt(0)) return { days: Math.max(1, Number.parseInt(input.amount.div(new Dec(input.perWeek).div(5)).toDecimalPlaces(0, Dec.ROUND_UP).toFixed(0), 10)), source: 'CAPACITY' }
  if (input.routingDays !== null && input.routingDays > 0) return { days: Math.max(1, input.routingDays - 2 * input.transportDays), source: 'ROUTING' }
  return { days: 1, source: 'DEFAULT' }
}

/** The kit's words: when it leaves, and whether that day has passed. */
export function kitWords(input: { readonly workshop: string; readonly shipOn: BusinessDate; readonly start: BusinessDate; readonly transportDays: number; readonly today: BusinessDate }): { readonly late: boolean; readonly words: string } {
  const late = input.shipOn < input.today
  const lead = `${input.transportDays} transport day${input.transportDays === 1 ? '' : 's'}`
  return late
    ? { late, words: `The kit should have left on ${input.shipOn} to reach ${input.workshop} ${lead} before the work starts on ${input.start}: send it today, or start later.` }
    : { late, words: `Send the kit on ${input.shipOn}: ${lead} before the work starts at ${input.workshop} on ${input.start}.` }
}
