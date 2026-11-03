import type { FactoryClient } from '@nexus/factory-db'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { coursesMet, kitHeld, type Holdings, type RoleAsks, type RoleSheetItemKind, type RoleSheetStatus } from '@nexus/factory-domain/safety/rolesheets/rules'
import type { CommandTx } from '../../../core/command'
import { dayOf, dayOrNull } from '../organisation/access'

/**
 * What a role asks of the people in it, and what they hold (B-W2b-128; QHS-236): THE read the later safety steps share, so
 * a role's needs are typed once (the role sheet) and read everywhere (plan: "Training, PPE and visit lists fill themselves
 * from these"):
 *
 *   roleNeedsOf(client, sheetIds)        per role: its risks and surveillance needs (words), its PPE kit (item, units, when to
 *                                        wear), its courses (within how many days of taking the role; null: before starting)
 *                                        and its health plan (needed: null while there is none, how often, the end-of-
 *                                        employment visit). B-W2b-133 (who needs which course: ∪ the machine classes of the
 *                                        person's authorisations), B-W2b-134 (gaps per person: the kit minus what they hold),
 *                                        B-W2b-135 (the due list: needed plans × the people of the role).
 *   peopleOfRoles(client, sheetIds)      the ACTIVE people in each role (Employee.roleSheetId), with their names (a register
 *                                        names people for the roles that keep it).
 *   holdingsOf(client, people, …)        the courses each person holds today (factory-domain coursesMet) and the units of each
 *                                        PPE item (kitHeld).
 *   roleSinceOf(client, people)          the day each person took their role: their newest role change (the audit row
 *                                        people.setRoleSheet, ROLE_SET_ACTION), else their start date. B-W2b-133's "due" =
 *                                        this day + withinDays. (Schema need: Employee.roleSheetSince would hold it.)
 *
 * Reads only, one read per table (no Promise.all: safe on a command's transaction). Whether a role needs visits is the
 * role's (no person in a HealthPlan); WHICH PERSON needs which visit is the health page's, behind its gate (rules.ts
 * VISIT_NEED_READER): a caller of peopleOfRoles × roleNeedsOf that shows both together keeps that gate.
 */

type Client = FactoryClient | CommandTx

/** The audit action of a person's role change (by the office, or cleared by a move): roleSinceOf reads it. */
export const ROLE_SET_ACTION = 'people.setRoleSheet'

export interface RoleNeeds extends RoleAsks {
  readonly roleSheetId: string
  readonly companyId: string
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly status: RoleSheetStatus
  /** The risks in words, and the surveillance needs in words (the reasons the health page shows). */
  readonly risks: readonly string[]
  readonly surveillanceNeeds: readonly string[]
  /** The health plan: the end-of-employment visit, and the day it was set (null: no plan in force). */
  readonly endOfEmploymentVisit: boolean
  readonly planSetOn: BusinessDate | null
}

/** What each role asks (sheets the caller's client sees; an archived sheet still answers what it asked). */
export async function roleNeedsOf(client: Client, roleSheetIds: readonly string[]): Promise<Map<string, RoleNeeds>> {
  const ids = [...new Set(roleSheetIds)]
  if (ids.length === 0) return new Map()
  const sheets = await client.roleSheet.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true, code: true, name: true, status: true } })
  const items = await client.roleSheetItem.findMany({ where: { roleSheetId: { in: ids } }, orderBy: [{ seq: 'asc' }], select: { roleSheetId: true, kind: true, title: true, note: true } })
  const kit = await client.ppeKitLine.findMany({ where: { roleSheetId: { in: ids } }, orderBy: [{ seq: 'asc' }], select: { roleSheetId: true, ppeItemId: true, quantity: true, whenToWear: true, note: true } })
  const requirements = await client.trainingRequirement.findMany({
    where: { source: 'ROLE_SHEET', roleSheetId: { in: ids } },
    orderBy: [{ course: { sortOrder: 'asc' } }, { course: { code: 'asc' } }, { id: 'asc' }],
    select: { roleSheetId: true, courseId: true, withinDays: true, note: true },
  })
  const plans = await client.healthPlan.findMany({ where: { roleSheetId: { in: ids }, status: 'ACTIVE' }, select: { roleSheetId: true, needed: true, frequencyMonths: true, endOfEmploymentVisit: true, setOn: true } })
  const answer = new Map<string, RoleNeeds>()
  for (const sheet of sheets) {
    const own = items.filter((item) => item.roleSheetId === sheet.id)
    const plan = plans.find((entry) => entry.roleSheetId === sheet.id) ?? null
    answer.set(sheet.id, {
      roleSheetId: sheet.id,
      companyId: sheet.companyId,
      siteId: sheet.siteId,
      code: sheet.code,
      name: sheet.name,
      status: sheet.status as RoleSheetStatus,
      content: {
        items: own.map((item) => ({ kind: item.kind as RoleSheetItemKind, title: item.title, note: item.note })),
        kit: kit.filter((entry) => entry.roleSheetId === sheet.id).map((entry) => ({ ppeItemId: entry.ppeItemId, quantity: entry.quantity, whenToWear: entry.whenToWear, note: entry.note })),
        requirements: requirements.filter((entry) => entry.roleSheetId === sheet.id).map((entry) => ({ courseId: entry.courseId, withinDays: entry.withinDays, note: entry.note })),
      },
      needed: plan ? plan.needed : null,
      frequencyMonths: plan?.frequencyMonths ?? null,
      risks: own.filter((item) => item.kind === 'RISK').map((item) => item.title),
      surveillanceNeeds: own.filter((item) => item.kind === 'SURVEILLANCE').map((item) => item.title),
      endOfEmploymentVisit: plan?.endOfEmploymentVisit ?? false,
      planSetOn: plan ? dayOf(plan.setOn) : null,
    })
  }
  return answer
}

export interface PersonInRole {
  readonly employeeId: string
  readonly roleSheetId: string
  readonly companyId: string
  readonly siteId: string
  readonly name: string
  readonly startDate: BusinessDate
}

/** The ACTIVE people in each role, by last name. */
export async function peopleOfRoles(client: Client, roleSheetIds: readonly string[]): Promise<PersonInRole[]> {
  const ids = [...new Set(roleSheetIds)]
  if (ids.length === 0) return []
  const rows = await client.employee.findMany({
    where: { roleSheetId: { in: ids }, status: 'ACTIVE' },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    select: { id: true, roleSheetId: true, companyId: true, siteId: true, firstName: true, lastName: true, startDate: true },
  })
  return rows.map((row) => ({ employeeId: row.id, roleSheetId: row.roleSheetId!, companyId: row.companyId, siteId: row.siteId, name: `${row.firstName} ${row.lastName}`, startDate: dayOf(row.startDate) }))
}

/** What the people hold today: the courses (a standing PASSED record still valid) and the units of each PPE item. */
export async function holdingsOf(client: Client, employeeIds: readonly string[], courseIds: readonly string[], ppeItemIds: readonly string[], today: BusinessDate): Promise<Holdings> {
  const people = [...new Set(employeeIds)]
  const courses = [...new Set(courseIds)]
  const items = [...new Set(ppeItemIds)]
  const standing =
    people.length > 0 && courses.length > 0
      ? await client.trainingRecord.findMany({
          // A record stands while no correction names it (a correction replaces it; a VOID one removes it).
          where: { result: 'PASSED', corrections: { none: {} }, employeeId: { in: people }, courseId: { in: courses } },
          orderBy: [{ completedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          select: { employeeId: true, courseId: true, validUntil: true },
        })
      : []
  const issues =
    people.length > 0 && items.length > 0
      ? await client.ppeIssue.findMany({ where: { employeeId: { in: people }, ppeItemId: { in: items } }, select: { id: true, kind: true, employeeId: true, ppeItemId: true, quantity: true, voidsId: true } })
      : []
  return {
    met: coursesMet(standing.map((record) => ({ employeeId: record.employeeId, courseId: record.courseId, validUntil: dayOrNull(record.validUntil) })), today),
    held: kitHeld(issues.map((issue) => ({ id: issue.id, kind: issue.kind as 'ISSUE' | 'VOID', employeeId: issue.employeeId, ppeItemId: issue.ppeItemId, quantity: issue.quantity, voidsId: issue.voidsId }))),
  }
}

/** The day each person took the role they are in now: their newest role change, else their start date. */
export async function roleSinceOf(client: Client, people: readonly { readonly employeeId: string; readonly startDate: BusinessDate }[]): Promise<Map<string, BusinessDate>> {
  if (people.length === 0) return new Map()
  const rows = await client.auditLog.findMany({
    where: { recordType: 'Employee', action: ROLE_SET_ACTION, recordId: { in: [...new Set(people.map((person) => person.employeeId))] } },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    select: { recordId: true, at: true },
  })
  const answer = new Map<string, BusinessDate>()
  for (const row of rows) if (!answer.has(row.recordId)) answer.set(row.recordId, businessDate(row.at))
  for (const person of people) if (!answer.has(person.employeeId)) answer.set(person.employeeId, person.startDate)
  return answer
}
