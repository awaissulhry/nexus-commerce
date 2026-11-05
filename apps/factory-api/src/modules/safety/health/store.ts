import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { PlanFacts, VisitStatus, VisitType } from '@nexus/factory-domain/safety/health/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { userNames } from '../incidents/store'
import { dateOf, dayOf } from './access'

/**
 * The health tables as this module reads and writes them (B-W2b-135): the person (Employee: the company and site every check
 * uses), the plans of the roles (ACTIVE HealthPlan per role sheet), the doctor's appointment, and THE insert of a visit
 * (`planVisitInCommand`: the office's "Plan visits", the leaver's step and the background passes all write a visit there, with
 * its audit row (no value) and its event (id and state only)). Reads take one table at a time (safe on a command's transaction).
 */

export type Client = FactoryClient | CommandTx

export const PERSON_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  firstName: true,
  lastName: true,
  employeeCode: true,
  status: true,
  roleSheetId: true,
  startDate: true,
  site: { select: { code: true, name: true } },
} as const satisfies Prisma.EmployeeSelect
export type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof PERSON_SELECT }>

export const nameOf = (row: { readonly firstName: string; readonly lastName: string }): string => `${row.firstName} ${row.lastName}`
export const personOut = (row: PersonRow) => ({ id: row.id, name: nameOf(row), employeeCode: row.employeeCode, siteId: row.siteId, site: row.site })
export const placeOf = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })

export const readPerson = (client: Client, id: string): Promise<PersonRow | null> => client.employee.findUnique({ where: { id }, select: PERSON_SELECT })

export const PLAN_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  roleSheetId: true,
  needed: true,
  frequencyMonths: true,
  endOfEmploymentVisit: true,
  setOn: true,
  doctorAppointmentId: true,
  status: true,
  version: true,
} as const satisfies Prisma.HealthPlanSelect
export type PlanRow = Prisma.HealthPlanGetPayload<{ select: typeof PLAN_SELECT }>

export const planFactsOf = (row: PlanRow): PlanFacts => ({ planId: row.id, roleSheetId: row.roleSheetId, needed: row.needed, frequencyMonths: row.frequencyMonths, endOfEmploymentVisit: row.endOfEmploymentVisit, doctorSet: row.doctorAppointmentId !== null })

/** The ACTIVE plan of each role sheet (one per role). */
export async function plansOfRoles(client: Client, roleSheetIds: readonly (string | null)[]): Promise<Map<string, PlanRow>> {
  const ids = [...new Set(roleSheetIds.filter((value): value is string => value !== null))]
  if (ids.length === 0) return new Map()
  const rows = await client.healthPlan.findMany({ where: { roleSheetId: { in: ids }, status: 'ACTIVE' }, select: PLAN_SELECT })
  return new Map(rows.map((row) => [row.roleSheetId, row]))
}

/** The doctors' names by appointment (an employee appointed, or the outside doctor's name). */
export async function doctorNames(client: Client, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await client.safetyAppointment.findMany({ where: { id: { in: wanted } }, select: { id: true, outsideName: true, employee: { select: { firstName: true, lastName: true } } } })
  return new Map(rows.map((row) => [row.id, row.employee ? nameOf(row.employee) : (row.outsideName ?? '')]))
}

/**
 * The occupational doctor's appointment of a company for a judgement or a plan: the one named (a DOCTOR of the company, else
 * null: refused by the caller), or, when none is named, the company's DOCTOR appointment in force on the day (none: null).
 */
export async function doctorFor(client: Client, companyId: string, named: string | null | undefined, on: BusinessDate): Promise<{ readonly id: string | null; readonly refused: boolean }> {
  if (named) {
    const row = await client.safetyAppointment.findFirst({ where: { id: named, companyId, role: 'DOCTOR' }, select: { id: true } })
    return row ? { id: row.id, refused: false } : { id: null, refused: true }
  }
  const day = dateOf(on)
  const row = await client.safetyAppointment.findFirst({
    where: { companyId, role: 'DOCTOR', fromDate: { lte: day }, OR: [{ untilDate: null }, { untilDate: { gte: day } }] },
    orderBy: [{ fromDate: 'desc' }, { id: 'asc' }],
    select: { id: true },
  })
  return { id: row?.id ?? null, refused: false }
}

export { userNames }

/** The judgement copies of rows (AVAILABLE files of record type FitnessJudgement), newest first. */
export async function copiesOf(client: Client, judgementIds: readonly string[]) {
  if (judgementIds.length === 0) return []
  return client.storedFile.findMany({ where: { recordType: 'FitnessJudgement', recordId: { in: [...judgementIds] }, status: 'AVAILABLE' }, orderBy: [{ availableAt: 'desc' }, { id: 'desc' }], select: { id: true, recordId: true, originalName: true, availableAt: true } })
}

export const OPEN_STATUSES = ['DUE', 'BOOKED'] as const

export interface VisitDraft {
  readonly companyId: string
  readonly siteId: string
  readonly employeeId: string
  readonly type: VisitType
  readonly dueOn: BusinessDate
  readonly planId: string | null
  readonly roleSheetId: string | null
  readonly absenceDays: number | null
}

/**
 * Writes one DUE visit (the guard checks its shape again), its audit row (the visit, never a value: no type, no person, no
 * absence) and its event. Answers the id, or null when the person already has an open visit of the type and `skipOpen` (the
 * background passes); the office's plan refuses that case before it gets here.
 */
export async function planVisitInCommand(tools: CommandTools, draft: VisitDraft, by: 'OFFICE' | 'SYSTEM', options: { readonly skipOpen?: boolean } = {}): Promise<{ readonly id: string; readonly version: number; readonly status: VisitStatus } | null> {
  const { tx, now } = tools
  if (options.skipOpen) {
    const open = await tx.healthVisit.findFirst({ where: { employeeId: draft.employeeId, type: draft.type, status: { in: [...OPEN_STATUSES] } }, select: { id: true } })
    if (open) return null
  }
  const id = newId()
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.healthVisit.create({
    data: { id, companyId: draft.companyId, employeeId: draft.employeeId, type: draft.type, dueOn: dateOf(draft.dueOn), planId: draft.planId, roleSheetId: draft.roleSheetId, absenceDays: draft.absenceDays, status: 'DUE', createdAt: now, updatedAt: now, createdById: actorId },
    select: { id: true },
  })
  tools.audit({ action: 'safety.planHealthVisit', recordType: 'HealthVisit', recordId: id, companyId: draft.companyId, siteId: draft.siteId, after: { change: 'PLANNED', status: 'DUE', by } })
  tools.emit({ type: 'health_visit.changed', subject: id, companyId: draft.companyId, siteId: draft.siteId, payload: { visitId: id, change: 'PLANNED', status: 'DUE', by } })
  return { id, version: 1, status: 'DUE' }
}

/** Audit + event of a visit's move (no value in either). */
export function visitChanged(tools: CommandTools, visit: { readonly id: string; readonly companyId: string; readonly siteId: string }, change: 'BOOKED' | 'UNBOOKED' | 'MOVED' | 'DONE' | 'CANCELLED', status: VisitStatus, by: 'OFFICE' | 'SYSTEM', action: string): void {
  tools.audit({ action, recordType: 'HealthVisit', recordId: visit.id, companyId: visit.companyId, siteId: visit.siteId, after: { change, status, by } })
  tools.emit({ type: 'health_visit.changed', subject: visit.id, companyId: visit.companyId, siteId: visit.siteId, payload: { visitId: visit.id, change, status, by } })
}

/** The day a stored DATE holds. */
export const day = (value: Date): BusinessDate => dayOf(value)
export const dayOrNullOf = (value: Date | null): BusinessDate | null => (value === null ? null : dayOf(value))
