import type { Prisma } from '@nexus/factory-db'
import type { Finding, RulePlace } from '@nexus/factory-domain/alerts/rules'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { CHECKED_LIMITS, raisedChecks, type CheckedLimit, type LimitCheck, type LimitState } from '@nexus/factory-domain/people/limits/checks'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { dateOf, officeOf } from '../employees/access'
import { personFor, requireAttendance, siteFor } from '../attendance/access'
import { fullName } from '../attendance/store'
import { legalGateFor } from '../privacy/gate'
import { refusePersonKeys } from '../privacy/groups'
import { peopleFacts, type PlannedPerson } from '../shifts/planner'
import type { WarningsQuery } from './contract'
import { limitFacts, type LimitFacts } from './worked'

/**
 * Warnings before a working-time limit is broken (B-W2b-42; MES-232; D.Lgs. 66/2003 arts. 4, 5, 7), behind the site's
 * ATTENDANCE gate: the time people worked, with the published roster ahead, against the limits in force.
 *
 *   GET /people/limits/warnings                  the people with a limit close or passed at a site: each row a tone per
 *                                                limit, no name, no figure, no person's key (Owner answer W1): it opens the
 *                                                person's latest day, and a person key is refused
 *   GET /people/employees/:employeeId/limits     one person's limits in words (one record: people.attendance.view)
 *   alert WORKING_TIME_LIMIT                     the exception rule's finding (the scheduler's alert engine): one alert per
 *                                                site and limit, naming nobody, cleared when nobody is close any more
 */

const READ = [PEOPLE_ATTENDANCE_VIEW] as const

const yearOf = (date: BusinessDate): string => date.slice(0, 4)

/** One person's checks today: the cap on the overtime worked, approved or waiting. */
function checksToday(facts: LimitFacts, person: PlannedPerson, today: BusinessDate): LimitCheck[] {
  const { approvedMinutes, pendingMinutes } = facts.overtimeOf(person.id, yearOf(today))
  return facts.checksOf(person, today, approvedMinutes + pendingMinutes)
}

/** GET /people/limits/warnings. */
export async function listWarnings(caller: CommandCaller, query: WarningsQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [] })
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const where: Prisma.EmployeeWhereInput = {
      siteId: site.id,
      status: 'ACTIVE',
      ...(query.lineId ? { homeLineId: query.lineId } : {}),
      ...(query.teamId ? { teamMemberships: { some: { teamId: query.teamId, since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] } } } : {}),
    }
    const people = await peopleFacts(db, where)
    const facts = await limitFacts(db, people, { from: today, to: today }, now)
    const teams = people.length === 0 ? [] : await db.teamMember.findMany({ where: { employeeId: { in: people.map((person) => person.id) }, since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] }, select: { employeeId: true, teamId: true }, orderBy: [{ since: 'desc' }] })
    const teamOf = new Map<string, string>()
    for (const row of teams) if (!teamOf.has(row.employeeId)) teamOf.set(row.employeeId, row.teamId)
    const rows: { dayId: string | null; teamId: string | null; lineId: string | null; checks: { rule: CheckedLimit; state: LimitState; level: 'WARN' | 'BLOCK' }[] }[] = []
    for (const person of people) {
      const raised = raisedChecks(checksToday(facts, person, today))
      if (query.rule && !raised.some((check) => check.rule === query.rule)) continue
      if (raised.length > 0) rows.push({ dayId: facts.latestDayOf(person.id), teamId: teamOf.get(person.id) ?? null, lineId: person.homeLineId, checks: raised.map((check) => ({ rule: check.rule, state: check.state, level: check.level })) })
    }
    return { siteId: site.id, today, rows, words: ["A limit shows its tone only: one person's figures open one at a time (Statuto dei Lavoratori art. 4)."] }
  })
}

/** GET /people/employees/:employeeId/limits. */
export async function personLimits(caller: CommandCaller, employeeId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const person = await personFor(db, context, employeeId, PEOPLE_ATTENDANCE_VIEW)
    await requireAttendance(db, person.siteId)
    const [planned] = await peopleFacts(db, { id: person.id })
    const now = serverClock.now()
    const today = businessDate(now)
    const facts = await limitFacts(db, [planned!], { from: today, to: today }, now)
    const overtime = facts.overtimeOf(person.id, yearOf(today))
    return {
      person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, siteId: person.siteId },
      today,
      overtime: { year: yearOf(today), ...overtime, limitMinutes: facts.rules(planned!).OVERTIME_YEARLY_CAP.limitMinutes },
      checks: checksToday(facts, planned!, today).map((check) => ({ ...check, values: { ...check.values } })),
    }
  })
}

/**
 * WORKING_TIME_LIMIT's findings (factory-domain alerts/kinds; platform/alerts evaluators): at each site of the rule's place
 * whose ATTENDANCE gate is open, one finding per limit somebody is close to or over. It carries the site and the limit
 * only: nobody is named or counted, so it may reach a role without one person's figures.
 */
export async function workingTimeFindings(tx: CommandTx, rule: RulePlace, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const sites = await tx.site.findMany({
    where: { status: 'ACTIVE', ...(rule.companyId ? { companyId: rule.companyId } : {}), ...(rule.siteId ? { id: rule.siteId } : {}), ...(only ? { id: { in: [...only] } } : {}) },
    orderBy: [{ id: 'asc' }],
    select: { id: true, code: true, companyId: true, timezone: true },
  })
  const findings: Finding[] = []
  for (const site of sites) {
    if (!(await legalGateFor(tx, site.id, 'ATTENDANCE', now)).open) continue
    const people = await peopleFacts(tx, { siteId: site.id, status: 'ACTIVE' })
    if (people.length === 0) continue
    const today = businessDate(now, site.timezone)
    const facts = await limitFacts(tx, people, { from: today, to: today }, now)
    const raised = people.flatMap((person) => raisedChecks(checksToday(facts, person, today)))
    for (const limit of CHECKED_LIMITS) {
      const ofLimit = raised.filter((check) => check.rule === limit)
      if (ofLimit.length === 0) continue
      findings.push({ recordType: 'Site', recordId: site.id, subKey: limit, label: site.code, scope: { companyId: site.companyId, siteId: site.id, partyId: null }, facts: { limit } })
    }
  }
  return findings
}
