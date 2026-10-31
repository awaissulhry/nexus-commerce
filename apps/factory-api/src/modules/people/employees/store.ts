import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { lifecycleOf, type EmployeeContract, type EmployeeKind, type EmployeeStatus, type Lifecycle } from '@nexus/factory-domain/people/employees/rules'
import type { CommandTx } from '../../../core/command'
import { countingAcks, workerNoticeRule } from '../../../platform/privacy/read'
import { dayOf, dayOrNull } from './access'

/**
 * The employee rows and their views (B-W2b-26), shared by the employees, teams and leavers routes and the employees
 * importer. Reads only; each takes the client it is given (a scoped client, or a command's transaction).
 */

type Client = FactoryClient | CommandTx

export const EMPLOYEE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  displayName: true,
  kind: true,
  agencyPartyId: true,
  locale: true,
  startDate: true,
  endDate: true,
  department: true,
  jobRole: true,
  homeLineId: true,
  contract: true,
  weeklyMinutes: true,
  defaultShiftPatternId: true,
  userId: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.EmployeeSelect

export type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof EMPLOYEE_SELECT }>

export const readEmployee = (client: Client, id: string): Promise<EmployeeRow | null> => client.employee.findUnique({ where: { id }, select: EMPLOYEE_SELECT })

/** The row locked for the rest of the command (FOR UPDATE), read again. */
export async function lockEmployee(tx: CommandTx, id: string): Promise<EmployeeRow | null> {
  await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${id}::uuid FOR UPDATE`
  return readEmployee(tx, id)
}

/** A person's full name, as the HR register and one record show it. */
export const nameOf = (row: { readonly firstName: string; readonly lastName: string }): string => `${row.firstName} ${row.lastName}`

/** What an audit row keeps of a record (plain JSON: dates as YYYY-MM-DD). */
export function auditedEmployee(row: EmployeeRow) {
  return {
    companyId: row.companyId,
    siteId: row.siteId,
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    kind: row.kind,
    agencyPartyId: row.agencyPartyId,
    locale: row.locale,
    startDate: dayOf(row.startDate),
    endDate: dayOrNull(row.endDate),
    department: row.department,
    jobRole: row.jobRole,
    homeLineId: row.homeLineId,
    contract: row.contract,
    weeklyMinutes: row.weeklyMinutes,
    defaultShiftPatternId: row.defaultShiftPatternId,
    userId: row.userId,
    status: row.status,
  }
}

export interface Ref {
  readonly id: string
  readonly code: string
  readonly name: string
}

export interface EmployeeView {
  readonly id: string
  readonly companyId: string
  readonly companyCode: string
  readonly site: Ref
  readonly employeeCode: string | null
  readonly firstName: string
  readonly lastName: string
  readonly name: string
  readonly displayName: string
  readonly kind: EmployeeKind
  readonly agency: Ref | null
  readonly locale: string
  readonly startDate: string
  readonly endDate: string | null
  readonly department: string | null
  readonly jobRole: string | null
  readonly homeLine: Ref | null
  readonly team: (Ref & { readonly since: string }) | null
  readonly isLead: boolean
  readonly lead: { readonly employeeId: string; readonly name: string } | null
  readonly contract: EmployeeContract | null
  readonly weeklyMinutes: number | null
  readonly defaultShift: Ref | null
  /** The floor sign-in: ACTIVE workers linked, whether one has an active badge, the worker notice (null: no sign-in). */
  readonly floor: { readonly signIns: number; readonly badge: 'ACTIVE' | 'NONE'; readonly notice: 'ACKNOWLEDGED' | 'MISSING' | 'NONE_IN_FORCE' | null }
  readonly officeAccount: boolean
  readonly status: EmployeeStatus
  readonly lifecycle: Lifecycle
  readonly leaving: { readonly caseId: string; readonly lastWorkingDay: string; readonly openSteps: number } | null
  readonly version: number
  readonly updatedAt: string
}

const refOf = (row: { readonly id: string; readonly code: string; readonly name: string } | undefined | null): Ref | null => (row ? { id: row.id, code: row.code, name: row.name } : null)

/** The worker-notice state of each worker (by site: the version in force at the site's company). */
async function noticesOf(client: Client, workers: readonly { readonly id: string; readonly siteId: string }[]): Promise<Map<string, 'ACKNOWLEDGED' | 'MISSING' | 'NONE_IN_FORCE'>> {
  const answer = new Map<string, 'ACKNOWLEDGED' | 'MISSING' | 'NONE_IN_FORCE'>()
  const bySite = new Map<string, string[]>()
  for (const worker of workers) bySite.set(worker.siteId, [...(bySite.get(worker.siteId) ?? []), worker.id])
  for (const [siteId, ids] of bySite) {
    const where = countingAcks(await workerNoticeRule(client, siteId))
    if (where === null) {
      for (const id of ids) answer.set(id, 'NONE_IN_FORCE')
      continue
    }
    const acked = new Set((await client.workerNoticeAck.findMany({ where: { ...where, siteId, workerId: { in: ids } }, select: { workerId: true } })).map((row) => row.workerId))
    for (const id of ids) answer.set(id, acked.has(id) ? 'ACKNOWLEDGED' : 'MISSING')
  }
  return answer
}

/** The views of many rows, with one read per related table (no Promise.all: safe on a transaction client). */
export async function employeeViews(client: Client, rows: readonly EmployeeRow[], today: BusinessDate): Promise<EmployeeView[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const uniq = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const companies = new Map((await client.company.findMany({ where: { id: { in: uniq(rows.map((row) => row.companyId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const sites = new Map((await client.site.findMany({ where: { id: { in: uniq(rows.map((row) => row.siteId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const agencyIds = uniq(rows.map((row) => row.agencyPartyId))
  const agencies = new Map(agencyIds.length === 0 ? [] : (await client.party.findMany({ where: { id: { in: agencyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
  const lineIds = uniq(rows.map((row) => row.homeLineId))
  const lines = new Map(lineIds.length === 0 ? [] : (await client.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const patternIds = uniq(rows.map((row) => row.defaultShiftPatternId))
  const patterns = new Map(patternIds.length === 0 ? [] : (await client.shiftPattern.findMany({ where: { id: { in: patternIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const memberships = await client.teamMember.findMany({ where: { employeeId: { in: ids }, until: null }, select: { employeeId: true, teamId: true, isLead: true, since: true, team: { select: { id: true, code: true, name: true } } } })
  const teamIds = uniq(memberships.map((row) => row.teamId))
  const leads = teamIds.length === 0 ? [] : await client.teamMember.findMany({ where: { teamId: { in: teamIds }, isLead: true, until: null }, select: { teamId: true, employee: { select: { id: true, firstName: true, lastName: true } } } })
  const leadOf = new Map(leads.map((row) => [row.teamId, { employeeId: row.employee.id, name: nameOf(row.employee) }]))
  const membershipOf = new Map(memberships.map((row) => [row.employeeId, row]))
  const workers = await client.worker.findMany({ where: { employeeId: { in: ids }, status: 'ACTIVE' }, select: { id: true, siteId: true, employeeId: true, badges: { where: { status: 'ACTIVE' }, select: { id: true }, take: 1 } } })
  const notices = await noticesOf(client, workers)
  const cases = await client.leaverCase.findMany({ where: { employeeId: { in: ids }, status: 'OPEN' }, select: { id: true, employeeId: true, lastWorkingDay: true, steps: { where: { status: 'OPEN' }, select: { id: true } } } })
  const caseOf = new Map(cases.map((row) => [row.employeeId, row]))
  return rows.map((row) => {
    const site = sites.get(row.siteId)
    const membership = membershipOf.get(row.id)
    const own = workers.filter((worker) => worker.employeeId === row.id)
    const states = own.map((worker) => notices.get(worker.id))
    const open = caseOf.get(row.id)
    return {
      id: row.id,
      companyId: row.companyId,
      companyCode: companies.get(row.companyId) ?? '',
      site: { id: row.siteId, code: site?.code ?? '', name: site?.name ?? '' },
      employeeCode: row.employeeCode,
      firstName: row.firstName,
      lastName: row.lastName,
      name: nameOf(row),
      displayName: row.displayName,
      kind: row.kind as EmployeeKind,
      agency: row.agencyPartyId ? (agencies.get(row.agencyPartyId) ?? null) : null,
      locale: row.locale,
      startDate: dayOf(row.startDate),
      endDate: dayOrNull(row.endDate),
      department: row.department,
      jobRole: row.jobRole,
      homeLine: row.homeLineId ? refOf(lines.get(row.homeLineId)) : null,
      team: membership ? { ...refOf(membership.team)!, since: dayOf(membership.since) } : null,
      isLead: membership?.isLead ?? false,
      lead: membership ? (leadOf.get(membership.teamId) ?? null) : null,
      contract: (row.contract as EmployeeContract | null) ?? null,
      weeklyMinutes: row.weeklyMinutes,
      defaultShift: row.defaultShiftPatternId ? refOf(patterns.get(row.defaultShiftPatternId)) : null,
      floor: {
        signIns: own.length,
        badge: own.some((worker) => worker.badges.length > 0) ? 'ACTIVE' : 'NONE',
        notice: own.length === 0 ? null : states.includes('MISSING') ? 'MISSING' : states.every((state) => state === 'NONE_IN_FORCE') ? 'NONE_IN_FORCE' : 'ACKNOWLEDGED',
      },
      officeAccount: row.userId !== null,
      status: row.status as EmployeeStatus,
      lifecycle: lifecycleOf({ status: row.status as EmployeeStatus, startDate: dayOf(row.startDate), leaving: open !== undefined }, today),
      leaving: open ? { caseId: open.id, lastWorkingDay: dayOf(open.lastWorkingDay), openSteps: open.steps.length } : null,
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

/** One view. */
export async function employeeView(client: Client, row: EmployeeRow, today: BusinessDate): Promise<EmployeeView> {
  return (await employeeViews(client, [row], today))[0]!
}

/** The person's current team membership (the row without an end), or null. */
export const currentMembership = (client: Client, employeeId: string) =>
  client.teamMember.findFirst({ where: { employeeId, until: null }, select: { id: true, teamId: true, siteId: true, isLead: true, since: true, version: true } })
