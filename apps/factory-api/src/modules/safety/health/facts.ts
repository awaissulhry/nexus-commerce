import type { Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { visitProposals, type FitnessOutcome, type JudgementFacts, type PlanFacts, type Proposal, type VisitFacts, type VisitStatus, type VisitType } from '@nexus/factory-domain/safety/health/rules'
import { roleSinceOf } from '../rolesheets/needs'
import { dayOf } from './access'
import { PERSON_SELECT, planFactsOf, plansOfRoles, type Client, type PersonRow, type PlanRow } from './store'

/**
 * What the due list is computed from (B-W2b-135; design plant.health "The due list builds itself from roles, starts, role changes
 * and long absences"): the people in roles whose plan needs visits (B-W2b-128's Employee.roleSheetId and its plan; the day each
 * took the role: rolesheets/needs.ts roleSinceOf), their visits and their judgements, read with the caller's client inside the
 * filter the caller gives (the office: the people its permission reaches; the background: the tenant). Internal reads only:
 * whoever shows any of it to a person records the view first (./protected.ts).
 */

export interface HealthFacts {
  readonly people: readonly PersonRow[]
  readonly plans: ReadonlyMap<string, PlanRow>
  readonly visits: readonly VisitFacts[]
  readonly judgements: readonly JudgementFacts[]
  readonly roleSince: ReadonlyMap<string, BusinessDate>
}

/** The ACTIVE people in a role (inside `where`) with their plans, visits, judgements and the day they took the role. */
export async function healthFactsOf(client: Client, where: Prisma.EmployeeWhereInput): Promise<HealthFacts> {
  const inRoles = await client.employee.findMany({ where: { AND: [where, { status: 'ACTIVE', roleSheetId: { not: null } }] }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }], select: PERSON_SELECT })
  const plans = await plansOfRoles(client, inRoles.map((row) => row.roleSheetId))
  const people = inRoles.filter((row) => plans.get(row.roleSheetId!)?.needed === true)
  const ids = people.map((row) => row.id)
  const visits =
    ids.length === 0
      ? []
      : await client.healthVisit.findMany({ where: { employeeId: { in: ids } }, select: { employeeId: true, type: true, status: true, dueOn: true, bookedOn: true, doneOn: true } })
  const judgements =
    ids.length === 0
      ? []
      : await client.fitnessJudgement.findMany({ where: { employeeId: { in: ids } }, select: { id: true, employeeId: true, outcome: true, judgedOn: true, expiresOn: true, unfitUntil: true, voidedAt: true, createdAt: true } })
  const roleSince = await roleSinceOf(client, people.map((row) => ({ employeeId: row.id, startDate: dayOf(row.startDate) })))
  return {
    people,
    plans,
    visits: visits.map((row) => ({ employeeId: row.employeeId, type: row.type as VisitType, status: row.status as VisitStatus, dueOn: dayOf(row.dueOn), bookedOn: row.bookedOn ? dayOf(row.bookedOn) : null, doneOn: row.doneOn ? dayOf(row.doneOn) : null })),
    judgements: judgements.map(judgementFactsOf),
    roleSince,
  }
}

export const judgementFactsOf = (row: { id: string; employeeId: string; outcome: string; judgedOn: Date; expiresOn: Date | null; unfitUntil: Date | null; voidedAt: Date | null; createdAt: Date }): JudgementFacts => ({
  id: row.id,
  employeeId: row.employeeId,
  outcome: row.outcome as FitnessOutcome,
  judgedOn: dayOf(row.judgedOn),
  expiresOn: row.expiresOn ? dayOf(row.expiresOn) : null,
  unfitUntil: row.unfitUntil ? dayOf(row.unfitUntil) : null,
  voided: row.voidedAt !== null,
  createdAt: row.createdAt.toISOString(),
})

/** The visits nobody planned yet (domain visitProposals) over the facts. */
export function proposalsOf(facts: HealthFacts, today: BusinessDate, horizonDays: number): Proposal[] {
  const plans = new Map<string, PlanFacts>([...facts.plans.entries()].map(([roleSheetId, row]) => [roleSheetId, planFactsOf(row)]))
  return visitProposals({
    today,
    horizonDays,
    people: facts.people.map((row) => ({ employeeId: row.id, roleSheetId: row.roleSheetId!, startDate: dayOf(row.startDate), roleSince: facts.roleSince.get(row.id) ?? dayOf(row.startDate) })),
    plans,
    visits: facts.visits,
    judgements: facts.judgements,
  })
}
