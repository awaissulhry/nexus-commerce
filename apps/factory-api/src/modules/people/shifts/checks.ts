import type { FactoryClient } from '@nexus/factory-db'
import { eachDay, plusDays } from '@nexus/factory-domain/calendars/dates'
import { BUSINESS_TIME_ZONE, type BusinessDate } from '@nexus/factory-domain/core/time'
import {
  LIMIT_KINDS,
  rosterWarnings,
  rulesInForce,
  warningKey,
  weeklyAverageWindowStart,
  yearlyCapWarnings,
  type LimitRules,
  type LimitWarning,
  type RuleRow,
} from '@nexus/factory-domain/people/shifts/limits'
import type { CommandTx } from '../../../core/command'
import { dateOf } from '../employees/access'
import { planningFor, workOf, type CellOverrides, type PlannedPerson, type Planning } from './planner'

/**
 * The working-time checks of People › Shifts (B-W2b-32; D.Lgs. 66/2003 arts. 4, 5, 7, 8): the rules in force per site
 * (People settings' WorkingTimeRule, else the law's value as a warning) and the warnings of a planned roster or of a
 * planned overtime, each with the rule in words. A write compares the warnings before and after it: a NEW warning whose
 * rule BLOCKs holds the write with the reason; a WARN shows.
 */

type Client = FactoryClient | CommandTx

export interface WarningOut extends LimitWarning {
  /** The write (or the overtime) being checked brings it: not there before. */
  readonly isNew: boolean
}

/** A company's site. */
export type Place = { readonly companyId: string; readonly siteId: string }

/** The rules in force for each place (one read of the tenant's ACTIVE rules). */
export async function rulesFor(client: Client): Promise<(place: Place) => LimitRules> {
  const rows = (await client.workingTimeRule.findMany({
    where: { status: 'ACTIVE', kind: { in: [...LIMIT_KINDS] } },
    select: { id: true, companyId: true, siteId: true, kind: true, limitMinutes: true, breakMinutes: true, referenceMonths: true, action: true, source: true, legalReference: true, status: true },
  })) as RuleRow[]
  const cache = new Map<string, LimitRules>()
  return (place) => {
    const key = `${place.companyId}|${place.siteId}`
    let rules = cache.get(key)
    if (!rules) {
      rules = rulesInForce(rows, place)
      cache.set(key, rules)
    }
    return rules
  }
}

/** The first day the checks of `from` … `to` need planned work from (rest the day before; the weekly average's weeks). */
export function checksWindowStart(people: readonly PlannedPerson[], rules: (place: Place) => LimitRules, from: BusinessDate): BusinessDate {
  let start = plusDays(from, -1)
  for (const person of people) {
    const first = weeklyAverageWindowStart(from, rules(person).WEEKLY_AVERAGE)
    if (first < start) start = first
  }
  return start
}

export interface RosterCheck {
  /** The planning over the checks' whole window (the days asked are inside it). */
  readonly planning: Planning
  /** Each person's warnings on the days asked. */
  readonly warnings: ReadonlyMap<string, readonly WarningOut[]>
  readonly rules: (place: Place) => LimitRules
}

/**
 * The roster warnings of each person on the days `from` … `to` (rest, break, weekly average), with `overrides` as if
 * written; with `compare` the same without them marks which are new.
 */
export async function rosterCheck(client: Client, people: readonly PlannedPerson[], report: { readonly from: BusinessDate; readonly to: BusinessDate }, options: { readonly overrides?: CellOverrides; readonly compare?: boolean } = {}): Promise<RosterCheck> {
  const rules = await rulesFor(client)
  const window = { from: checksWindowStart(people, rules, report.from), to: plusDays(report.to, 1) }
  const planning = await planningFor(client, people, window, options.overrides ? { overrides: options.overrides } : {})
  const before = options.overrides && options.compare ? await planningFor(client, people, window) : null
  const days = new Set(eachDay(report.from, report.to))
  const warnings = new Map<string, WarningOut[]>()
  for (const person of people) {
    const input = { rules: rules(person), report: days, timeZone: planning.timeZones.get(person.siteId) ?? BUSINESS_TIME_ZONE, employedFrom: person.startDate }
    const now = rosterWarnings({ ...input, work: workOf(planning, person) })
    const was = before ? new Set(rosterWarnings({ ...input, work: workOf(before, person) }).map(warningKey)) : null
    warnings.set(person.id, now.map((warning) => ({ ...warning, isNew: was ? !was.has(warningKey(warning)) : false })))
  }
  return { planning, warnings, rules }
}

/** The planned overtime minutes each person agreed to in a year (requests asked, approved or done; `without` left out). */
export async function plannedOvertimeOfYear(client: Client, employeeIds: readonly string[], year: string, without?: string): Promise<Map<string, number>> {
  if (employeeIds.length === 0) return new Map()
  const rows = await client.overtimeAgreement.findMany({
    where: { employeeId: { in: [...employeeIds] }, answer: 'AGREED', request: { status: { in: ['ASKED', 'AGREED', 'APPROVED', 'DONE'] }, date: { gte: dateOf(`${year}-01-01`), lte: dateOf(`${year}-12-31`) }, ...(without ? { id: { not: without } } : {}) } },
    select: { employeeId: true, request: { select: { minutes: true } } },
  })
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.employeeId, (out.get(row.employeeId) ?? 0) + row.request.minutes)
  return out
}

export interface OvertimePlan {
  readonly date: BusinessDate
  readonly startMinute: number | null
  readonly minutes: number
  /** The request being checked (its own asks are replaced by the plan). */
  readonly requestId?: string
}

/**
 * The checks of each person for a planned overtime (design "Request overtime": each with the annual cap and the rest
 * check): the rest before and after it, the break, the week's average and the year's cap, as if the person agreed.
 */
export async function overtimeChecks(client: Client, people: readonly PlannedPerson[], plan: OvertimePlan): Promise<Map<string, WarningOut[]>> {
  const rules = await rulesFor(client)
  const window = { from: checksWindowStart(people, rules, plan.date), to: plusDays(plan.date, 1) }
  const planning = await planningFor(client, people, window, plan.requestId ? { withoutRequest: plan.requestId } : {})
  const year = plan.date.slice(0, 4)
  const planned = await plannedOvertimeOfYear(client, people.map((person) => person.id), year, plan.requestId)
  const days = new Set([plan.date, plusDays(plan.date, 1)])
  const out = new Map<string, WarningOut[]>()
  for (const person of people) {
    const input = { rules: rules(person), report: days, timeZone: planning.timeZones.get(person.siteId) ?? BUSINESS_TIME_ZONE, employedFrom: person.startDate }
    const was = new Set(rosterWarnings({ ...input, work: workOf(planning, person) }).map(warningKey))
    const now = rosterWarnings({ ...input, work: workOf(planning, person, [plan]) })
    const cap = yearlyCapWarnings({ date: plan.date, plannedMinutes: (planned.get(person.id) ?? 0) + plan.minutes }, rules(person).OVERTIME_YEARLY_CAP)
    out.set(person.id, [...now.map((warning) => ({ ...warning, isNew: !was.has(warningKey(warning)) })), ...cap.map((warning) => ({ ...warning, isNew: true }))])
  }
  return out
}

/** The new warnings whose rule BLOCKs. */
export const blocking = (warnings: Iterable<readonly WarningOut[]>): WarningOut[] => [...warnings].flat().filter((warning) => warning.isNew && warning.level === 'BLOCK')
