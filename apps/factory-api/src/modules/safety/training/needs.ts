import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { RequirementDraft } from '@nexus/factory-domain/safety/rolesheets/rules'
import { needsOf, type PersonNeed } from '@nexus/factory-domain/safety/training/rules'
import type { CommandTx } from '../../../core/command'
import { dateOf, dayOf } from '../organisation/access'
import { holdingsOf, roleNeedsOf, roleSinceOf } from '../rolesheets/needs'

/**
 * Who needs which course (B-W2b-133; QHS-242): THE read the training steps share (B-W2b-139's due lists and the skills
 * matrix's safety columns, B-W2b-146's screens), built on the role sheets' own read (../rolesheets/needs.ts: roleNeedsOf,
 * roleSinceOf, holdingsOf), never typed per person:
 *
 *   trainingPeopleOf(client, where)          the ACTIVE people a filter names, with their role sheet and start date.
 *   authorisationsOf(client, people, today)  their machine authorisations that count: not revoked, not ended by today (one
 *                                            starting later counts from its first day: the course is due before it).
 *   classRequirementsOf(client, classIds)    the courses each type of machine asks (TrainingRequirement MACHINE_CLASS).
 *   trainingNeedsOf(client, people, today)   per person × course: its sources (the role sheet: due the day they took the
 *                                            role + its days; each machine type: the day the authorisation starts + its
 *                                            days; none: before starting), the earliest due day, met (the standing record
 *                                            holds today) and the state MET | DUE | OVERDUE (factory-domain `needsOf`).
 *
 * Reads only, one read per table (no Promise.all: safe on a command's transaction).
 */

type Client = FactoryClient | CommandTx

export interface TrainingPerson {
  readonly employeeId: string
  readonly name: string
  readonly companyId: string
  readonly siteId: string
  readonly roleSheetId: string | null
  readonly startDate: BusinessDate
}

/** The ACTIVE people of a filter, by last name. */
export async function trainingPeopleOf(client: Client, where: Prisma.EmployeeWhereInput, take = 5000): Promise<TrainingPerson[]> {
  const rows = await client.employee.findMany({
    where: { AND: [where, { status: 'ACTIVE' }] },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    take,
    select: { id: true, firstName: true, lastName: true, companyId: true, siteId: true, roleSheetId: true, startDate: true },
  })
  return rows.map((row) => ({ employeeId: row.id, name: `${row.firstName} ${row.lastName}`, companyId: row.companyId, siteId: row.siteId, roleSheetId: row.roleSheetId, startDate: dayOf(row.startDate) }))
}

/** An authorisation that counts for training: not revoked, its last day not past (Prisma filter on MachineAuthorisation). */
export const countingAuthorisation = (today: BusinessDate): Prisma.MachineAuthorisationWhereInput => ({ revokedAt: null, OR: [{ validUntil: null }, { validUntil: { gte: dateOf(today) } }] })

export interface CountingAuthorisation {
  readonly employeeId: string
  readonly machineClassId: string
  readonly authorisedOn: BusinessDate
}

/** The people's authorisations that count today (optionally of some machine types only). */
export async function authorisationsOf(client: Client, employeeIds: readonly string[], today: BusinessDate, machineClassIds?: readonly string[]): Promise<CountingAuthorisation[]> {
  const people = [...new Set(employeeIds)]
  if (people.length === 0) return []
  const rows = await client.machineAuthorisation.findMany({
    where: { AND: [countingAuthorisation(today), { employeeId: { in: people } }, ...(machineClassIds ? [{ machineClassId: { in: [...new Set(machineClassIds)] } }] : [])] },
    orderBy: [{ authorisedOn: 'asc' }, { id: 'asc' }],
    select: { employeeId: true, machineClassId: true, authorisedOn: true },
  })
  return rows.map((row) => ({ employeeId: row.employeeId, machineClassId: row.machineClassId, authorisedOn: dayOf(row.authorisedOn) }))
}

/** The courses each machine type asks, in the catalogue's order. */
export async function classRequirementsOf(client: Client, machineClassIds: readonly string[]): Promise<Map<string, RequirementDraft[]>> {
  const ids = [...new Set(machineClassIds)]
  const answer = new Map<string, RequirementDraft[]>()
  if (ids.length === 0) return answer
  const rows = await client.trainingRequirement.findMany({
    where: { source: 'MACHINE_CLASS', machineClassId: { in: ids } },
    orderBy: [{ course: { sortOrder: 'asc' } }, { course: { code: 'asc' } }, { id: 'asc' }],
    select: { machineClassId: true, courseId: true, withinDays: true, note: true },
  })
  for (const row of rows) {
    const list = answer.get(row.machineClassId!) ?? []
    list.push({ courseId: row.courseId, withinDays: row.withinDays, note: row.note })
    answer.set(row.machineClassId!, list)
  }
  return answer
}

export interface TrainingNeeds {
  readonly needs: PersonNeed[]
  /** The authorisations that counted (each person's machine types). */
  readonly authorisations: readonly CountingAuthorisation[]
  /** The day each person took their role (people with a role sheet). */
  readonly roleSince: ReadonlyMap<string, BusinessDate>
}

/** Who among these people needs which course, from their role sheet and the machine types they are authorised on. */
export async function trainingNeedsOf(client: Client, people: readonly TrainingPerson[], today: BusinessDate): Promise<TrainingNeeds> {
  if (people.length === 0) return { needs: [], authorisations: [], roleSince: new Map() }
  const inRoles = people.filter((person) => person.roleSheetId !== null)
  const roles = await roleNeedsOf(client, inRoles.map((person) => person.roleSheetId!))
  const roleSince = await roleSinceOf(client, inRoles)
  const authorisations = await authorisationsOf(
    client,
    people.map((person) => person.employeeId),
    today,
  )
  const classes = await classRequirementsOf(
    client,
    authorisations.map((authorisation) => authorisation.machineClassId),
  )
  const roleRequirements = new Map([...roles.values()].map((role) => [role.roleSheetId, [...role.content.requirements]] as const))
  const courseIds = [...[...roleRequirements.values()].flat(), ...[...classes.values()].flat()].map((requirement) => requirement.courseId)
  const { met } = await holdingsOf(
    client,
    people.map((person) => person.employeeId),
    courseIds,
    [],
    today,
  )
  const needs = needsOf({
    people: people.map((person) => ({ employeeId: person.employeeId, roleSheetId: person.roleSheetId, roleSince: person.roleSheetId ? (roleSince.get(person.employeeId) ?? person.startDate) : null })),
    roleRequirements,
    authorisations,
    classRequirements: classes,
    met,
    today,
  })
  return { needs, authorisations, roleSince }
}
