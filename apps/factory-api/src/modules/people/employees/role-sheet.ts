import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_EMPLOYEES_MANAGE, PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import {
  CHANGE_OF_TASK_LAW,
  fingerprintOf,
  KIT_LAW,
  personImpact,
  ROLE_SHEET_LAW,
  SURVEILLANCE_LAW,
  TRAINING_LAW,
  VISIT_NEED_READER,
  type PersonImpact,
  type RoleSheetStatus,
} from '@nexus/factory-domain/safety/rolesheets/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { holdingsOf, roleNeedsOf, roleSinceOf, ROLE_SET_ACTION, type RoleNeeds } from '../../safety/rolesheets/needs'
import { assertMay, assertMayWrite, assertVersion, dayOf, may, officeOf, refuse, todayOf } from './access'
import { lockEmployee, nameOf, readEmployee, type EmployeeRow } from './store'

/**
 * A person's role sheet (B-W2b-128; QHS-236, QHS-253; design people.employees "Role (mansione) → link to its role risk sheet",
 * "Changing Role opens 'What this changes' before Apply: courses now needed, PPE kit items to issue, a change-of-task visit"),
 * office only. The HR record names the sheet (Employee.roleSheetId); jobRole stays the record's text, for history. Routes
 * (registered by modules/safety/rolesheets/routes.ts, entries in its manifest):
 *
 *   GET  /people/employees/:id/role-sheet           the person's sheet, since when, what it asks of them (courses held or
 *                                                   not, kit units held), the sheets of their site to choose from (people.view)
 *   POST /people/employees/:id/role-sheet/preview   "What this changes" for one person: courses now needed (due from today),
 *                                                   courses no longer asked, kit items to issue, items no longer in the kit, a
 *                                                   change-of-task visit (people.employees.manage)
 *   PUT  /people/employees/:id/role-sheet           give the person the sheet (or none) in one command (version, and the
 *                                                   preview's fingerprint: a change made meanwhile is refused)
 *
 * WHICH PERSON needs which health visit is protected (GDPR art. 9): the visit and the surveillance needs behind it are shown
 * only to VISIT_NEED_READER holders (HR and the safety roles); others read `shown: false`. A move to another site clears the
 * sheet in the move's own update (people/employees/writes.ts calls roleSheetBeforeMove + roleSheetClearedByMove).
 */

type Client = FactoryClient | CommandTx

const MANAGE_WORDS = 'A person’s role is set by a role that keeps the HR register (people.employees.manage).'
const LAW = { roleSheet: ROLE_SHEET_LAW, kit: KIT_LAW, training: TRAINING_LAW, surveillance: SURVEILLANCE_LAW, changeOfTask: CHANGE_OF_TASK_LAW }

const placeOf = (row: EmployeeRow) => ({ companyId: row.companyId, siteId: row.siteId })
const mayKnowVisits = (context: OfficeContext, row: EmployeeRow): boolean => may(context, VISIT_NEED_READER, placeOf(row))

async function roleSheetIdOf(client: Client, employeeId: string): Promise<string | null> {
  return (await client.employee.findUnique({ where: { id: employeeId }, select: { roleSheetId: true } }))?.roleSheetId ?? null
}

/** The names of the courses and items a person's answer names. */
async function namesOf(client: Client, courseIds: readonly string[], ppeItemIds: readonly string[]) {
  const courses = courseIds.length > 0 ? await client.safetyCourse.findMany({ where: { id: { in: [...new Set(courseIds)] } }, select: { id: true, code: true, name: true, type: true } }) : []
  const items = ppeItemIds.length > 0 ? await client.ppeItem.findMany({ where: { id: { in: [...new Set(ppeItemIds)] } }, select: { id: true, code: true, name: true, category: true } }) : []
  return { course: new Map(courses.map((course) => [course.id, { code: course.code, name: course.name, type: course.type }])), item: new Map(items.map((item) => [item.id, { code: item.code, name: item.name, category: item.category }])) }
}

const sheetRef = (needs: RoleNeeds | null | undefined) => (needs ? { id: needs.roleSheetId, code: needs.code, name: needs.name, status: needs.status as RoleSheetStatus } : null)

async function readablePerson(client: Client, context: OfficeContext, employeeId: string): Promise<EmployeeRow> {
  const row = isUuid(employeeId) ? await readEmployee(client, employeeId) : null
  if (!row) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_VIEW, placeOf(row), 'Employee')
  return row
}

/** GET /people/employees/:employeeId/role-sheet. */
export async function personRoleSheet(caller: CommandCaller, employeeId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = await readablePerson(client, context, employeeId)
    const roleSheetId = await roleSheetIdOf(client, row.id)
    const needs = roleSheetId ? ((await roleNeedsOf(client, [roleSheetId])).get(roleSheetId) ?? null) : null
    const since = needs ? ((await roleSinceOf(client, [{ employeeId: row.id, startDate: dayOf(row.startDate) }])).get(row.id) ?? null) : null
    const holdings = needs ? await holdingsOf(client, [row.id], needs.content.requirements.map((entry) => entry.courseId), needs.content.kit.map((entry) => entry.ppeItemId), today) : null
    const names = needs ? await namesOf(client, needs.content.requirements.map((entry) => entry.courseId), needs.content.kit.map((entry) => entry.ppeItemId)) : null
    const choices = await client.roleSheet.findMany({ where: { siteId: row.siteId, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, name: true } })
    const shown = mayKnowVisits(context, row)
    return {
      employee: { id: row.id, name: nameOf(row), siteId: row.siteId, jobRole: row.jobRole, status: row.status as 'ACTIVE' | 'LEFT', version: row.version },
      roleSheet: sheetRef(needs),
      since,
      asks:
        needs && holdings && names
          ? {
              risks: [...needs.risks],
              courses: needs.content.requirements.map((entry) => ({ courseId: entry.courseId, course: names.course.get(entry.courseId) ?? null, withinDays: entry.withinDays, held: holdings.met.has(`${row.id}|${entry.courseId}`) })),
              kit: needs.content.kit.map((entry) => ({ ppeItemId: entry.ppeItemId, item: names.item.get(entry.ppeItemId) ?? null, quantity: entry.quantity, whenToWear: entry.whenToWear, held: holdings.held.get(`${row.id}|${entry.ppeItemId}`) ?? 0 })),
              visits: shown ? { shown: true, needed: needs.needed, frequencyMonths: needs.frequencyMonths, needs: [...needs.surveillanceNeeds] } : { shown: false, needed: null, frequencyMonths: null, needs: [] },
            }
          : null,
      choices,
      canChange: row.status !== 'LEFT' && may(context, PEOPLE_EMPLOYEES_MANAGE, placeOf(row)),
      law: LAW,
      today,
    }
  })
}

/** The sheet a person may be given: ACTIVE, of their site (409 in words, at the field). */
async function targetSheet(client: Client, row: EmployeeRow, roleSheetId: string | null): Promise<void> {
  if (roleSheetId === null) return
  const sheet = isUuid(roleSheetId) ? await client.roleSheet.findUnique({ where: { id: roleSheetId }, select: { siteId: true, status: true } }) : null
  if (!sheet || sheet.siteId !== row.siteId) refuse('ROLE_SHEET_OTHER_SITE', 'A person is given a role sheet of their own site.', 'roleSheetId')
  if (sheet!.status !== 'ACTIVE') refuse('ROLE_SHEET_ARCHIVED', 'This role sheet is archived: choose an active one.', 'roleSheetId')
}

/** What moving the person to the sheet means for them, as the caller may see it, with its fingerprint. */
async function impactFor(client: Client, context: OfficeContext, row: EmployeeRow, toId: string | null, today: BusinessDate) {
  const fromId = await roleSheetIdOf(client, row.id)
  const needs = await roleNeedsOf(client, [fromId, toId].filter((value): value is string => value !== null))
  const from = fromId ? (needs.get(fromId) ?? null) : null
  const to = toId ? (needs.get(toId) ?? null) : null
  const courseIds = [...(from?.content.requirements ?? []), ...(to?.content.requirements ?? [])].map((entry) => entry.courseId)
  const itemIds = [...(from?.content.kit ?? []), ...(to?.content.kit ?? [])].map((entry) => entry.ppeItemId)
  const impact: PersonImpact = personImpact(row.id, fromId, from, toId, to, await holdingsOf(client, [row.id], courseIds, itemIds, today), today)
  const names = await namesOf(client, courseIds, itemIds)
  const shownVisit = mayKnowVisits(context, row)
  const shown = {
    from: sheetRef(from),
    to: sheetRef(to),
    change: impact.change,
    courses: {
      needed: impact.courses.needed.map((entry) => ({ ...entry, course: names.course.get(entry.courseId) ?? null })),
      noLonger: impact.courses.noLonger.map((entry) => ({ ...entry, course: names.course.get(entry.courseId) ?? null })),
    },
    kit: {
      toIssue: impact.kit.toIssue.map((entry) => ({ ...entry, item: names.item.get(entry.ppeItemId) ?? null })),
      noLonger: impact.kit.noLonger.map((entry) => ({ ...entry, item: names.item.get(entry.ppeItemId) ?? null })),
    },
    visit: shownVisit ? { shown: true, consequence: impact.visit, frequencyMonths: impact.frequencyMonths } : { shown: false, consequence: null, frequencyMonths: null },
  }
  return { fromId, shown, fingerprint: fingerprintOf(shown) }
}

/** POST /people/employees/:employeeId/role-sheet/preview. */
export async function previewRoleChange(caller: CommandCaller, employeeId: string, body: { readonly roleSheetId: string | null }, now: Date = new Date()) {
  const context = officeOf(caller)
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    const row = await readablePerson(client, context, employeeId)
    assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, placeOf(row), MANAGE_WORDS)
    if (row.status === 'LEFT') refuse('LEFT', 'This person has left: the record no longer changes.')
    await targetSheet(client, row, body.roleSheetId)
    const { shown, fingerprint } = await impactFor(client, context, row, body.roleSheetId, today)
    return { employee: { id: row.id, name: nameOf(row), version: row.version }, ...shown, fingerprint, law: LAW, today }
  })
}

/** PUT /people/employees/:employeeId/role-sheet. */
export async function setRoleSheet(caller: CommandCaller, employeeId: string, body: { readonly version: number; readonly roleSheetId: string | null; readonly impactFingerprint?: string | undefined; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const seen = await caller.withClient((client) => readablePerson(client, context, employeeId))
  assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, placeOf(seen), MANAGE_WORDS)
  const { result } = await command(caller, { name: 'people.setRoleSheet', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    const row = (await lockEmployee(tx, employeeId))!
    if (row.status === 'LEFT') refuse('LEFT', 'This person has left: the record no longer changes.')
    assertVersion('employee', row.version, body.version)
    await targetSheet(tx, row, body.roleSheetId)
    const { fromId, shown, fingerprint } = await impactFor(tx, context, row, body.roleSheetId, today)
    if (fromId === body.roleSheetId) {
      tools.audit({ action: 'people.keepRoleSheet', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { unchanged: true, roleSheetId: fromId } })
      return { employee: { id: row.id, version: row.version, roleSheet: shown.to }, ...shown, fingerprint, changed: false }
    }
    if (body.impactFingerprint && body.impactFingerprint !== fingerprint) refuse('IMPACT_CHANGED', 'What this changes for the person is not what you read any more (a course or a PPE item was recorded, or the role sheet changed): read it again.')
    await tx.employee.update({ where: { id: row.id }, data: { roleSheetId: body.roleSheetId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: ROLE_SET_ACTION, recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { roleSheetId: fromId, roleSheet: shown.from?.code ?? null }, after: { roleSheetId: body.roleSheetId, roleSheet: shown.to?.code ?? null }, ...(body.reason?.trim() ? { reason: body.reason.trim() } : {}) })
    tools.emit({ type: 'employee.updated', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { employeeId: row.id, change: 'EDITED', fields: ['roleSheetId'], workerId: null, by: 'OFFICE' } })
    tools.emit({ type: 'employee.role_changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { employeeId: row.id, fromRoleSheetId: fromId, toRoleSheetId: body.roleSheetId, by: 'OFFICE' } })
    return { employee: { id: row.id, version: row.version + 1, roleSheet: shown.to }, ...shown, fingerprint, changed: true }
  })
  return result
}

// ---- a move to another site (people/employees/writes.ts) ------------------------------------------------------------------

/** The person's role sheet before a move to another site: a sheet is of one site, so the move clears it in its own update. */
export const roleSheetBeforeMove = (tx: CommandTx, employeeId: string): Promise<string | null> => roleSheetIdOf(tx, employeeId)

/** The cleared sheet's audit row (roleSinceOf reads it) and event, in the move's command: the office gives a sheet of the new site. */
export function roleSheetClearedByMove(tools: CommandTools, facts: { readonly employeeId: string; readonly companyId: string; readonly toSiteId: string; readonly roleSheetId: string }): void {
  tools.audit({ action: ROLE_SET_ACTION, recordType: 'Employee', recordId: facts.employeeId, companyId: facts.companyId, siteId: facts.toSiteId, before: { roleSheetId: facts.roleSheetId }, after: { roleSheetId: null }, reason: 'Moved to another site: a role sheet is of one site.' })
  tools.emit({ type: 'employee.role_changed', subject: facts.employeeId, companyId: facts.companyId, siteId: facts.toSiteId, payload: { employeeId: facts.employeeId, fromRoleSheetId: facts.roleSheetId, toRoleSheetId: null, by: 'SITE_MOVE' } })
}
