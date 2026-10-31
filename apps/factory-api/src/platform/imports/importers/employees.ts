import type { Issue } from '@nexus/factory-domain/core/errors'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { ExistingRecord, RowIssue, RowValues } from '@nexus/factory-domain/imports/importer'
import { employeesImporter, hoursOfMinutes, minutesOfHours, NEW_EMPLOYEE_COLUMNS } from '@nexus/factory-domain/people/employees/importer'
import { PEOPLE_EMPLOYEES_MANAGE, PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import { cleanName, defaultDisplayName, employeeProblems, type EmployeeContract, type EmployeeDraft, type EmployeeKind } from '@nexus/factory-domain/people/employees/rules'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { PeopleRefusedError, dateOf, dayOf, dayOrNull } from '../../../modules/people/employees/access'
import { auditedEmployee, EMPLOYEE_SELECT, readEmployee, type EmployeeRow } from '../../../modules/people/employees/store'
import { checkCode, checkRefs, insertEmployee } from '../../../modules/people/employees/writes'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../registry'

/**
 * The employees' import adapter (B-W2b-26; MES-209; platform/imports; factory-domain people/employees/importer): a row is
 * one person of the job's company, found by the payroll's employee code.
 *
 *   authorize  employees belong to a company: a job for every company (companyId null) is refused; import per company.
 *              The engine checks people.employees.manage against the job's company and people.view to see the plans.
 *   load       the records the codes name, as the import sees them (the site's, agency's and home line's codes).
 *   check      every row against what it names, read again: the code not used by another company's record or by a floor
 *              worker that is not the record's own; the site (of the job's company, active, one the person may keep
 *              people at; a known record's site never moves by import: move a person from the record); the agency (an
 *              organisation of the company or the group); the home line (of the row's site); every employee rule on
 *              the record as it would be stored (an agency worker's agency and end, the dates' order, the weekly hours);
 *              a person who has LEFT does not change by import.
 *   write      one row in the batch's command: a new code makes the record (people.importEmployee, employee.created
 *              source IMPORT); a known one locks the row, changes the given cells, version + 1 (employee.updated).
 *
 * No money, no figure about a person's work; names stay in the job's plan rows, which only people.view may read.
 */

const ACTION = 'people.importEmployee'

/** Stops the batch: the row no longer fits what it names, or a row was made or changed since the dry run. */
class ImportRowRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for employee ${code} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const codeOf = (key: Readonly<Record<string, unknown>>): string => String(key.employeeCode)

interface Facts {
  readonly employees: ReadonlyMap<string, EmployeeRow>
  readonly sites: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly companyId: string; readonly status: string }>
  readonly siteById: ReadonlyMap<string, { readonly id: string; readonly code: string }>
}

async function factsFor(client: CommandTx, codes: readonly string[], scope: ImportScope): Promise<Facts> {
  const employees = codes.length === 0 ? [] : await client.employee.findMany({ where: { employeeCode: { in: [...codes] } }, select: EMPLOYEE_SELECT })
  const companySites = scope.companyId === null ? [] : await client.site.findMany({ where: { companyId: scope.companyId }, select: { id: true, code: true, companyId: true, status: true } })
  return {
    employees: new Map(employees.map((row) => [row.employeeCode!, row])),
    sites: new Map(companySites.map((site) => [site.code, site])),
    siteById: new Map(companySites.map((site) => [site.id, site])),
  }
}

/** A stored record as the import's columns see it (codes where ids stand, hours where minutes stand). */
async function importedOf(client: CommandTx, row: EmployeeRow, facts: Facts): Promise<Record<string, CellValue | null>> {
  const agency = row.agencyPartyId ? await client.party.findUnique({ where: { id: row.agencyPartyId }, select: { code: true } }) : null
  const line = row.homeLineId ? await client.line.findUnique({ where: { id: row.homeLineId }, select: { code: true } }) : null
  return {
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    kind: row.kind,
    agency: agency?.code ?? null,
    site: facts.siteById.get(row.siteId)?.code ?? null,
    homeLine: line?.code ?? null,
    department: row.department,
    jobRole: row.jobRole,
    contract: row.contract,
    weeklyHours: hoursOfMinutes(row.weeklyMinutes),
    startDate: dayOf(row.startDate),
    endDate: dayOrNull(row.endDate),
    language: row.locale,
  }
}

/** A row resolved against the database: the record (or null), the site, the ids the codes name, the draft as stored. */
interface Resolved {
  readonly current: EmployeeRow | null
  readonly site: { readonly id: string; readonly code: string; readonly companyId: string }
  readonly draft: EmployeeDraft
  readonly homeLineId: string | null
}

type Resolution = { readonly ok: true; readonly row: Resolved } | { readonly ok: false; readonly issues: RowIssue[] }

const COLUMN_OF: Readonly<Record<string, string>> = { agencyPartyId: 'agency', homeLineId: 'homeLine', weeklyMinutes: 'weeklyHours', locale: 'language' }
const issueOf = (issue: Issue): RowIssue => {
  const field = issue.path.split('/').at(-1) ?? ''
  const column = COLUMN_OF[field] ?? (Object.hasOwn(employeesImporter.columns, field) ? field : undefined)
  return column ? { column, message: issue.message } : { message: issue.message }
}

async function resolve(client: CommandTx, key: Readonly<Record<string, CellValue>>, values: RowValues, scope: ImportScope, facts: Facts, actor: Actor | null): Promise<Resolution> {
  const code = codeOf(key)
  const current = facts.employees.get(code) ?? null
  if (current && current.companyId !== scope.companyId) return { ok: false, issues: [{ column: 'employeeCode', message: `Employee code ${code} belongs to another company's record: import it with that company.` }] }
  if (current && current.status === 'LEFT') return { ok: false, issues: [{ column: 'employeeCode', message: `Employee ${code} has left: the record no longer changes by import.` }] }
  if (!current) {
    const missing = NEW_EMPLOYEE_COLUMNS.filter((column) => values[column] === undefined)
    if (missing.length > 0) return { ok: false, issues: missing.map((column) => ({ column, message: 'A new employee needs it.' })) }
  }
  const siteCode = typeof values.site === 'string' ? values.site : current ? facts.siteById.get(current.siteId)?.code : undefined
  const site = siteCode ? facts.sites.get(siteCode) : undefined
  if (!site) return { ok: false, issues: [{ column: 'site', message: siteCode ? `No site ${siteCode} in this company.` : 'A new employee needs the site.' }] }
  if (current && site.id !== current.siteId) return { ok: false, issues: [{ column: 'site', message: `Employee ${code} works at another site: move a person from their record, not by import.` }] }
  if (!current && site.status !== 'ACTIVE') return { ok: false, issues: [{ column: 'site', message: `Site ${site.code} is archived: it takes no new people.` }] }
  if (actor !== null && !can(actor, PEOPLE_EMPLOYEES_MANAGE, { companyId: site.companyId, siteId: site.id })) return { ok: false, issues: [{ column: 'site', message: `Keeping the people of site ${site.code} needs people.employees.manage at that site.` }] }

  const issues: RowIssue[] = []
  let agencyPartyId = current?.agencyPartyId ?? null
  if (typeof values.agency === 'string') {
    const party = await client.party.findFirst({ where: { code: values.agency, OR: [{ companyId: null }, { companyId: site.companyId }] }, select: { id: true, kind: true } })
    if (!party) issues.push({ column: 'agency', message: `No party ${values.agency} of this company.` })
    else if (party.kind !== 'ORGANISATION') issues.push({ column: 'agency', message: `${values.agency} is a person: an agency is an organisation.` })
    else agencyPartyId = party.id
  }
  let homeLineId = current?.homeLineId ?? null
  if (typeof values.homeLine === 'string') {
    const line = await client.line.findFirst({ where: { siteId: site.id, code: values.homeLine }, select: { id: true, status: true } })
    if (!line) issues.push({ column: 'homeLine', message: `No line ${values.homeLine} at site ${site.code}.` })
    else if (line.status !== 'ACTIVE') issues.push({ column: 'homeLine', message: `Line ${values.homeLine} is archived.` })
    else homeLineId = line.id
  }
  let weeklyMinutes = current?.weeklyMinutes ?? null
  if (typeof values.weeklyHours === 'string') {
    weeklyMinutes = minutesOfHours(values.weeklyHours)
    if (weeklyMinutes === null) issues.push({ column: 'weeklyHours', message: 'Hours that make whole minutes (37.5, 40, 38.25).' })
  }
  if (issues.length > 0) return { ok: false, issues }
  const kind = (values.kind as EmployeeKind | undefined) ?? (current?.kind as EmployeeKind | undefined) ?? 'EMPLOYEE'
  const firstName = typeof values.firstName === 'string' ? cleanName(values.firstName) : current!.firstName
  const lastName = typeof values.lastName === 'string' ? cleanName(values.lastName) : current!.lastName
  const draft: EmployeeDraft = {
    firstName,
    lastName,
    displayName: typeof values.displayName === 'string' ? cleanName(values.displayName) : (current?.displayName ?? defaultDisplayName(firstName, lastName)),
    employeeCode: code,
    kind,
    agencyPartyId: kind === 'AGENCY' ? agencyPartyId : typeof values.agency === 'string' ? agencyPartyId : null,
    locale: typeof values.language === 'string' ? values.language.toLowerCase() : (current?.locale ?? 'it'),
    startDate: typeof values.startDate === 'string' ? values.startDate : dayOf(current!.startDate),
    endDate: typeof values.endDate === 'string' ? values.endDate : dayOrNull(current?.endDate ?? null),
    department: typeof values.department === 'string' ? values.department.trim() : (current?.department ?? null),
    jobRole: typeof values.jobRole === 'string' ? values.jobRole.trim() : (current?.jobRole ?? null),
    contract: (values.contract as EmployeeContract | undefined) ?? ((current?.contract as EmployeeContract | null | undefined) ?? null),
    weeklyMinutes,
  }
  const problems = employeeProblems(draft)
  if (problems.length > 0) return { ok: false, issues: problems.map(issueOf) }
  // The code is free of other people's floor sign-ins (the record's own carry it rightly).
  try {
    await checkCode(client, null, code, current?.id ?? null)
  } catch (error) {
    if (error instanceof PeopleRefusedError) return { ok: false, issues: [{ column: 'employeeCode', message: error.message }] }
    throw error
  }
  return { ok: true, row: { current, site, draft, homeLineId } }
}

const tenantCheck = (tools: CommandTools): void => {
  if (!(tools.context as { readonly tenantId?: string }).tenantId) throw new ApiError('internal_error', 'An employees import runs in a tenant.')
}

export const employeesImportAdapter = Object.freeze({
  importer: employeesImporter,
  permission: PEOPLE_EMPLOYEES_MANAGE,
  viewPermission: PEOPLE_VIEW,

  authorize(_actor, job) {
    if (job.companyId === null) return [{ path: 'companyId', message: 'Employees belong to a company: import them for one company.' }]
    return []
  },

  async load(client, keys, scope) {
    const codes = keys.map(codeOf)
    const facts = await factsFor(client, codes, scope)
    const records: ExistingRecord[] = []
    for (const code of codes) {
      const row = facts.employees.get(code)
      if (row && row.companyId === scope.companyId) records.push({ id: row.id, values: await importedOf(client, row, facts) })
    }
    return records
  },

  async check(client, rows: readonly CheckRow[], scope, actor) {
    const facts = await factsFor(client, rows.map((row) => codeOf(row.key)), scope)
    const answers: RowIssue[][] = []
    for (const row of rows) {
      const resolved = await resolve(client, row.key, row.values, scope, facts, actor)
      answers.push(resolved.ok ? [] : resolved.issues)
    }
    return answers
  },

  async write(tools: CommandTools, row, scope) {
    tenantCheck(tools)
    const { tx, now } = tools
    const code = codeOf(row.key)
    if (row.action === 'UPDATE') await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${row.recordId}::uuid FOR UPDATE`
    const facts = await factsFor(tx, [code], scope)
    // The person was checked by the batch's check(); here the row is resolved again under the lock.
    const resolved = await resolve(tx, row.key, row.values, scope, facts, null)
    if (!resolved.ok) throw new ImportRowRefused(code, resolved.issues.map((issue) => issue.message).join(' '))
    const { current, site, draft, homeLineId } = resolved.row
    if ((row.action === 'UPDATE') !== (current !== null) || (current !== null && current.id !== row.recordId)) throw new ImportRowRefused(code, row.action === 'CREATE' ? 'a record with this code was made since' : 'the record is gone')
    try {
      await checkRefs(tx, site.companyId, site.id, { agencyPartyId: draft.agencyPartyId, homeLineId })
    } catch (error) {
      if (error instanceof PeopleRefusedError) throw new ImportRowRefused(code, error.message)
      throw error
    }
    if (current === null) {
      const saved = await insertEmployee(tools, { companyId: site.companyId, siteId: site.id, draft, homeLineId, defaultShiftPatternId: null, userId: null }, ACTION)
      tools.emit({ type: 'employee.created', subject: saved.id, companyId: saved.companyId, siteId: saved.siteId, payload: { employeeId: saved.id, kind: draft.kind, source: 'IMPORT', workerId: null, linkedUser: false } })
      return { recordId: saved.id }
    }
    const data = {
      firstName: draft.firstName,
      lastName: draft.lastName,
      displayName: draft.displayName,
      kind: draft.kind,
      agencyPartyId: draft.agencyPartyId,
      locale: draft.locale,
      startDate: dateOf(draft.startDate),
      endDate: draft.endDate === null ? null : dateOf(draft.endDate),
      department: draft.department,
      jobRole: draft.jobRole,
      homeLineId,
      contract: draft.contract,
      weeklyMinutes: draft.weeklyMinutes,
    }
    // The routes' version moves: an open edit of the record sees the import as a newer version.
    await tx.employee.update({ where: { id: current.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const saved = (await readEmployee(tx, current.id))!
    const before = auditedEmployee(current)
    const after = auditedEmployee(saved)
    const fields = Object.keys(after).filter((field) => JSON.stringify((before as Record<string, unknown>)[field]) !== JSON.stringify((after as Record<string, unknown>)[field]))
    tools.audit({ action: ACTION, recordType: 'Employee', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before, after })
    tools.emit({ type: 'employee.updated', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { employeeId: current.id, change: 'EDITED', fields, workerId: null, by: 'IMPORT' } })
    return { recordId: current.id }
  },
} satisfies ImportAdapter)
