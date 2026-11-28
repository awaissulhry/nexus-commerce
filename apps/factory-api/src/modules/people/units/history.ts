import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { historyRows, PERSON_HISTORY_ACTIONS, PERSON_TEAM_ACTIONS, UNIT_HISTORY_ACTIONS, type HistoryAudit, type HistorySubject } from '@nexus/factory-domain/people/units/history'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { assertMay, officeOf } from '../employees/access'
import { userNames } from '../employees/employees'
import { nameOf } from '../employees/store'

/**
 * The History tab of a unit and of a person (owb-ss5 step 5.2; design § 5zb "every change is one line in the History of the unit and
 * of the person, with who and when"): the AuditLog rows of that record, newest first, only the actions of the domain's ALLOW-lists
 * (factory-domain people/units/history), each row's words and icon built there; `who` is the office person's name.
 *
 *   GET /people/units/:unitId/history             people.view over the unit: its Team rows
 *   GET /people/employees/:employeeId/history     people.view over the person: their Employee rows, and the Team rows that name
 *                                                 them (moved in or out of a team, made or no longer its leader, left it)
 *
 * The words name no customer and carry no figure about one person's work.
 */

type Client = FactoryClient | CommandTx

const HISTORY_LIMIT = 200

const AUDIT_SELECT = { id: true, at: true, audience: true, actorId: true, action: true, recordType: true, recordId: true, before: true, after: true } as const satisfies Prisma.AuditLogSelect

async function readRows(client: Client, where: Prisma.AuditLogWhereInput): Promise<HistoryAudit[]> {
  const rows = await client.auditLog.findMany({ where, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: HISTORY_LIMIT, select: AUDIT_SELECT })
  return rows.map((row) => ({ id: row.id, at: toUtcIso(row.at), audience: row.audience as string, actorId: row.actorId, action: row.action, recordType: row.recordType, recordId: row.recordId, before: row.before, after: row.after }))
}

/** The names a page of rows needs: its office people, the people and the units its rows name. */
async function namesOf(client: Client, rows: readonly HistoryAudit[]) {
  const actors = await userNames(client, rows.filter((row) => row.audience === 'OFFICE').map((row) => row.actorId))
  const employeeIds = new Set<string>()
  const unitIds = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === 'string' && isUuid(value)) employeeIds.add(value)
  }
  for (const row of rows) {
    if (row.recordType === 'Team') unitIds.add(row.recordId)
    const before = (row.before ?? {}) as Record<string, unknown>
    const after = (row.after ?? {}) as Record<string, unknown>
    add(before.leadEmployeeId)
    add(after.leadEmployeeId)
    add(before.employeeId)
    add(after.standInEmployeeId)
    if (Array.isArray(after.moved)) for (const entry of after.moved) add((entry as Record<string, unknown> | null)?.employeeId)
  }
  const employees = employeeIds.size === 0 ? [] : await client.employee.findMany({ where: { id: { in: [...employeeIds] } }, select: { id: true, firstName: true, lastName: true } })
  const units = unitIds.size === 0 ? [] : await client.team.findMany({ where: { id: { in: [...unitIds] } }, select: { id: true, name: true } })
  return { actors, employees: new Map(employees.map((row) => [row.id, nameOf(row)])), units: new Map(units.map((row) => [row.id, row.name])) }
}

/** GET /people/units/:unitId/history. */
export async function unitHistory(caller: CommandCaller, unitId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const unit = isUuid(unitId) ? await client.team.findUnique({ where: { id: unitId }, select: { id: true, companyId: true, siteId: true, code: true } }) : null
    if (!unit) throw new NotFoundError('Unit not found.')
    assertMay(context, PEOPLE_VIEW, unit, 'Unit')
    const rows = await readRows(client, { recordType: 'Team', recordId: unit.id, action: { in: [...UNIT_HISTORY_ACTIONS] } })
    const subject: HistorySubject = { kind: 'UNIT', unitId: unit.id, unitCode: unit.code }
    return { rows: historyRows(rows, subject, await namesOf(client, rows)) }
  })
}

/** GET /people/employees/:employeeId/history. */
export async function employeeHistory(caller: CommandCaller, employeeId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const employee = isUuid(employeeId) ? await client.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true } }) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_VIEW, employee, 'Employee')
    const rows = await readRows(client, {
      OR: [
        { recordType: 'Employee', recordId: employee.id, action: { in: [...PERSON_HISTORY_ACTIONS] } },
        // The Team rows that name the person (each action keeps the person's id where these paths say).
        { recordType: 'Team', action: 'people.moveTeamMembers', companyId: employee.companyId, after: { path: ['moved'], array_contains: [{ employeeId: employee.id }] } },
        { recordType: 'Team', action: 'people.setTeamLead', companyId: employee.companyId, OR: [{ after: { path: ['leadEmployeeId'], equals: employee.id } }, { before: { path: ['leadEmployeeId'], equals: employee.id } }] },
        { recordType: 'Team', action: 'people.endMembership', companyId: employee.companyId, before: { path: ['employeeId'], equals: employee.id } },
      ],
    })
    const subject: HistorySubject = { kind: 'PERSON', employeeId: employee.id }
    const shown = rows.filter((row) => row.recordType === 'Employee' || PERSON_TEAM_ACTIONS.includes(row.action))
    return { rows: historyRows(shown, subject, await namesOf(client, shown)) }
  })
}
