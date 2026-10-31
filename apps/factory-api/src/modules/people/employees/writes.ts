import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_EMPLOYEES_MANAGE, PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import {
  cleanCode,
  cleanName,
  cleanText,
  defaultDisplayName,
  employeeProblems,
  namesFromDisplayName,
  type EmployeeContract,
  type EmployeeDraft,
  type EmployeeKind,
} from '@nexus/factory-domain/people/employees/rules'
import { movePlan } from '@nexus/factory-domain/people/teams/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, bodyIssue, dateOf, dayOf, dayOrNull, may, officeOf, problemsError, refuse, todayOf } from './access'
import { auditedEmployee, currentMembership, employeeView, lockEmployee, readEmployee, type EmployeeRow } from './store'

/**
 * The employee writes (B-W2b-26; MES-208, MES-211; design people.employees "New employee", the record's Profile and Job
 * & team, "Floor workers with no employee record · Link them"), office only, people.employees.manage over the record's
 * company and site. One person, one record: made new, from a floor worker, or from an office user.
 *
 *   POST /people/employees                                  a new record at a site (the company is the site's)
 *   POST /people/employees/from-worker                      the record of a floor worker (its names, code, language and
 *                                                           site; its office account), linked to it
 *   POST /people/employees/from-user                        the record of an office user, linked to the account
 *   PATCH /people/employees/:employeeId                     identity, job and contract; a move to another site of the
 *                                                           company (the home line and the team membership end there)
 *   POST /people/employees/:employeeId/workers              link a floor sign-in (one per site; the same company)
 *   POST /people/employees/:employeeId/workers/:workerId/unlink   unlink one (with the reason)
 *   PUT /people/employees/:employeeId/user                  link or unlink the office account (one per person)
 *
 * Every rule the database keeps at the commit (one account per person, a linked worker's account and its record's agree,
 * the employee code unique, the agency an organisation) is answered first, in words, inside the command: a 409 whose
 * issues name the refusal (`refusal/<CODE>`) and the field (`body/<field>`), so the record shows it at the field.
 */

type Tx = CommandTx

/** The record's references, checked in the command (each a 409 at its field in words). */
interface Refs {
  readonly agencyPartyId?: string | null
  readonly homeLineId?: string | null
  readonly defaultShiftPatternId?: string | null
}

export async function checkRefs(tx: Tx, companyId: string, siteId: string, refs: Refs): Promise<void> {
  if (refs.agencyPartyId) {
    const party = await tx.party.findUnique({ where: { id: refs.agencyPartyId }, select: { kind: true, companyId: true, status: true } })
    if (!party || (party.companyId !== null && party.companyId !== companyId)) refuse('AGENCY_NOT_ORGANISATION', 'The agency is not a party of this company (Customers & suppliers).', 'agencyPartyId')
    if (party!.kind !== 'ORGANISATION') refuse('AGENCY_NOT_ORGANISATION', 'An agency is an organisation, not a person.', 'agencyPartyId')
  }
  if (refs.homeLineId) {
    const line = await tx.line.findUnique({ where: { id: refs.homeLineId }, select: { siteId: true, status: true } })
    if (!line || line.siteId !== siteId) refuse('LINE_NOT_OF_SITE', "The home line is a line of the person's site.", 'homeLineId')
    if (line!.status !== 'ACTIVE') refuse('LINE_NOT_OF_SITE', 'This line is archived: pick an active one.', 'homeLineId')
  }
  if (refs.defaultShiftPatternId) {
    const pattern = await tx.shiftPattern.findUnique({ where: { id: refs.defaultShiftPatternId }, select: { companyId: true, status: true } })
    if (!pattern || (pattern.companyId !== null && pattern.companyId !== companyId)) refuse('SHIFT_NOT_OF_COMPANY', "The default shift is a shift pattern of the person's company (Planning › Settings).", 'defaultShiftPatternId')
    if (pattern!.status !== 'ACTIVE') refuse('SHIFT_NOT_OF_COMPANY', 'This shift pattern is archived: pick an active one.', 'defaultShiftPatternId')
  }
}

/**
 * The employee code is free for this record: no other record has it, and no floor worker that is not this record's own
 * sign-in carries it ("Employee code already used by Worker 0142": create the record from that worker, or change it).
 */
export async function checkCode(tx: Tx, context: OfficeContext | null, code: string | null, employeeId: string | null, field = 'employeeCode'): Promise<void> {
  if (code === null) return
  const other = await tx.employee.findFirst({ where: { employeeCode: code, ...(employeeId ? { id: { not: employeeId } } : {}) }, select: { id: true } })
  if (other) refuse('CODE_TAKEN', `Employee code ${code} is already used by another employee record.`, field)
  const worker = await tx.worker.findFirst({ where: { employeeCode: code, OR: [{ employeeId: null }, ...(employeeId ? [{ employeeId: { not: employeeId } }] : [{ employeeId: { not: null } }])] }, select: { displayName: true, companyId: true, siteId: true, employeeId: true, site: { select: { code: true } } } })
  if (worker) {
    const shown = context === null || may(context, PEOPLE_VIEW, worker) ? `floor worker ${worker.displayName} (site ${worker.site.code})` : 'a floor worker'
    refuse('CODE_ON_WORKER', worker.employeeId === null ? `Employee code ${code} is already used by ${shown}, who has no employee record: make the record from that worker, or give another code.` : `Employee code ${code} is already used by ${shown} of another employee record.`, field)
  }
}

/** A site of the tenant that takes new people (active), with its company. */
async function activeSite(tx: Tx, siteId: string) {
  const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true, status: true, code: true } })
  if (!site) throw bodyIssue('siteId', 'Not a site of the group.')
  if (site.status !== 'ACTIVE') refuse('SITE_ARCHIVED', `Site ${site.code} is archived: it takes no new people.`, 'siteId')
  return site
}

/** An office account that may be linked: a current user, not the caller, without a record of its own. */
async function checkAccount(tx: Tx, context: OfficeContext, userId: string, employeeId: string | null): Promise<void> {
  if (userId === context.actorId) refuse('SELF_LINK', 'You cannot link your own office account: ask another administrator.', 'userId')
  const user = await tx.user.findUnique({ where: { id: userId }, select: { status: true } })
  if (!user || user.status === 'DEACTIVATED') refuse('ACCOUNT_INACTIVE', 'No current office account of the tenant has this id.', 'userId')
  const owner = await tx.employee.findFirst({ where: { userId, ...(employeeId ? { id: { not: employeeId } } : {}) }, select: { id: true } })
  if (owner) refuse('ACCOUNT_TAKEN', 'This office account belongs to another employee record: one record per person.', 'userId')
}

export interface NewEmployee {
  readonly companyId: string
  readonly siteId: string
  readonly draft: EmployeeDraft
  readonly homeLineId: string | null
  readonly defaultShiftPatternId: string | null
  readonly userId: string | null
}

/** Inserts a record checked by the caller (rules, references, code), audited; its id. */
export async function insertEmployee(tools: CommandTools, row: NewEmployee, action: string): Promise<EmployeeRow> {
  const { tx, now } = tools
  const id = newId()
  const { draft } = row
  await tx.employee.create({
    data: {
      id,
      companyId: row.companyId,
      siteId: row.siteId,
      employeeCode: draft.employeeCode,
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
      homeLineId: row.homeLineId,
      contract: draft.contract,
      weeklyMinutes: draft.weeklyMinutes,
      defaultShiftPatternId: row.defaultShiftPatternId,
      userId: row.userId,
      createdAt: now,
      updatedAt: now,
      createdById: actorIdOf(tools.context),
    },
    select: { id: true },
  })
  const saved = (await readEmployee(tx, id))!
  tools.audit({ action, recordType: 'Employee', recordId: id, companyId: row.companyId, siteId: row.siteId, after: auditedEmployee(saved) })
  return saved
}

/** The draft of a new record from what a route was given (names cleaned, the floor name defaulted). */
function draftOf(body: {
  readonly firstName: string
  readonly lastName: string
  readonly displayName?: string | undefined
  readonly employeeCode?: string | null | undefined
  readonly kind?: EmployeeKind | undefined
  readonly agencyPartyId?: string | null | undefined
  readonly locale?: string | undefined
  readonly startDate: BusinessDate
  readonly endDate?: BusinessDate | null | undefined
  readonly department?: string | null | undefined
  readonly jobRole?: string | null | undefined
  readonly contract?: EmployeeContract | null | undefined
  readonly weeklyMinutes?: number | null | undefined
}): EmployeeDraft {
  const firstName = cleanName(body.firstName)
  const lastName = cleanName(body.lastName)
  return {
    firstName,
    lastName,
    displayName: body.displayName ? cleanName(body.displayName) : defaultDisplayName(firstName, lastName),
    employeeCode: cleanCode(body.employeeCode),
    kind: body.kind ?? 'EMPLOYEE',
    agencyPartyId: body.agencyPartyId ?? null,
    locale: body.locale?.trim().toLowerCase() ?? 'it',
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    department: cleanText(body.department),
    jobRole: cleanText(body.jobRole),
    contract: body.contract ?? null,
    weeklyMinutes: body.weeklyMinutes ?? null,
  }
}

export interface CreateBody {
  readonly siteId: string
  readonly firstName: string
  readonly lastName: string
  readonly displayName?: string | undefined
  readonly employeeCode?: string | null | undefined
  readonly kind?: EmployeeKind | undefined
  readonly agencyPartyId?: string | null | undefined
  readonly locale?: string | undefined
  readonly startDate: BusinessDate
  readonly endDate?: BusinessDate | null | undefined
  readonly department?: string | null | undefined
  readonly jobRole?: string | null | undefined
  readonly homeLineId?: string | null | undefined
  readonly contract?: EmployeeContract | null | undefined
  readonly weeklyMinutes?: number | null | undefined
  readonly defaultShiftPatternId?: string | null | undefined
}

const MANAGE_WORDS = 'Employees of this site are kept by a role that keeps them (people.employees.manage).'

/** POST /people/employees. */
export async function createEmployee(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const draft = draftOf(body)
  const problems = employeeProblems(draft)
  if (problems.length > 0) throw problemsError(problems, 'The employee is not valid.')
  const placed = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true } }))
  if (!placed) throw bodyIssue('siteId', 'Not a site of the group.')
  assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, { companyId: placed.companyId, siteId: placed.id }, MANAGE_WORDS)
  const { result, replayed } = await command(caller, { name: 'people.createEmployee', idempotencyKey, input: body }, async (tools) => {
    const site = await activeSite(tools.tx, body.siteId)
    await checkRefs(tools.tx, site.companyId, site.id, { agencyPartyId: draft.agencyPartyId, homeLineId: body.homeLineId ?? null, defaultShiftPatternId: body.defaultShiftPatternId ?? null })
    await checkCode(tools.tx, context, draft.employeeCode, null)
    const saved = await insertEmployee(tools, { companyId: site.companyId, siteId: site.id, draft, homeLineId: body.homeLineId ?? null, defaultShiftPatternId: body.defaultShiftPatternId ?? null, userId: null }, 'people.createEmployee')
    tools.emit({ type: 'employee.created', subject: saved.id, companyId: saved.companyId, siteId: saved.siteId, payload: { employeeId: saved.id, kind: draft.kind, source: 'NEW', workerId: null, linkedUser: false } })
    return { employee: await employeeView(tools.tx, saved, todayOf(tools.now)) }
  })
  return { ...result, replayed }
}

export interface FromWorkerBody {
  readonly workerId: string
  readonly firstName?: string | undefined
  readonly lastName?: string | undefined
  readonly employeeCode?: string | null | undefined
  readonly kind?: EmployeeKind | undefined
  readonly agencyPartyId?: string | null | undefined
  readonly startDate?: BusinessDate | undefined
  readonly endDate?: BusinessDate | null | undefined
  readonly department?: string | null | undefined
  readonly jobRole?: string | null | undefined
  readonly homeLineId?: string | null | undefined
  readonly contract?: EmployeeContract | null | undefined
  readonly weeklyMinutes?: number | null | undefined
}

/** Links a worker to a record inside the command (its version moves: a stale Admin › Users edit is refused), audited. */
async function linkWorkerRow(tools: CommandTools, worker: { readonly id: string; readonly companyId: string; readonly siteId: string }, employeeId: string | null, before: string | null): Promise<void> {
  await tools.tx.worker.update({ where: { id: worker.id }, data: { employeeId, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: employeeId === null ? 'people.unlinkWorker' : 'people.linkWorker', recordType: 'Worker', recordId: worker.id, companyId: worker.companyId, siteId: worker.siteId, before: { employeeId: before }, after: { employeeId } })
}

/** POST /people/employees/from-worker: the floor worker's record, linked to them (one person, never two records). */
export async function employeeFromWorker(caller: CommandCaller, body: FromWorkerBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient((client) => client.worker.findUnique({ where: { id: body.workerId }, select: { id: true, companyId: true, siteId: true } }))
  if (!known) throw new NotFoundError('Worker not found.')
  assertMay(context, PEOPLE_VIEW, known, 'Worker')
  assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, known, MANAGE_WORDS)
  const { result, replayed } = await command(caller, { name: 'people.employeeFromWorker', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT "id" FROM "Worker" WHERE "id" = ${body.workerId}::uuid FOR UPDATE`
    const worker = (await tx.worker.findUnique({ where: { id: body.workerId }, select: { id: true, companyId: true, siteId: true, displayName: true, locale: true, employeeCode: true, userId: true, employeeId: true, status: true, createdAt: true } }))!
    if (worker.employeeId !== null) refuse('WORKER_LINKED', 'This floor worker has an employee record already: open it.', 'workerId')
    if (worker.status !== 'ACTIVE') refuse('WORKER_INACTIVE', 'This floor sign-in is switched off: reactivate it in Admin › Users first, or make a new record.', 'workerId')
    const site = await activeSite(tx, worker.siteId)
    const read = namesFromDisplayName(worker.displayName)
    const firstName = body.firstName ?? read?.firstName
    const lastName = body.lastName ?? read?.lastName
    if (!firstName || !lastName) throw bodyIssue(firstName ? 'lastName' : 'firstName', `The floor name "${worker.displayName}" is one word: give the first and last name.`)
    const code = body.employeeCode !== undefined ? body.employeeCode : worker.employeeCode
    const draft = draftOf({ ...body, firstName, lastName, displayName: worker.displayName.slice(0, 40), employeeCode: code, locale: worker.locale, startDate: body.startDate ?? businessDate(worker.createdAt) })
    const problems = employeeProblems(draft)
    if (problems.length > 0) throw problemsError(problems, 'The employee is not valid.')
    await checkRefs(tx, site.companyId, site.id, { agencyPartyId: draft.agencyPartyId, homeLineId: body.homeLineId ?? null })
    // The worker's own code is its own: only another record or another worker clashes.
    if (draft.employeeCode !== null) {
      const other = await tx.employee.findFirst({ where: { employeeCode: draft.employeeCode }, select: { id: true } })
      if (other) refuse('CODE_TAKEN', `Employee code ${draft.employeeCode} is already used by another employee record.`, 'employeeCode')
      const otherWorker = await tx.worker.findFirst({ where: { employeeCode: draft.employeeCode, id: { not: worker.id } }, select: { displayName: true, site: { select: { code: true } } } })
      if (otherWorker) refuse('CODE_ON_WORKER', `Employee code ${draft.employeeCode} is already used by floor worker ${otherWorker.displayName} (site ${otherWorker.site.code}).`, 'employeeCode')
    }
    if (worker.userId !== null) {
      const owner = await tx.employee.findFirst({ where: { userId: worker.userId }, select: { id: true } })
      if (owner) refuse('ACCOUNT_TAKEN', "This worker's office account belongs to another employee record: link the worker to that record instead.", 'workerId')
    }
    const saved = await insertEmployee(tools, { companyId: site.companyId, siteId: site.id, draft, homeLineId: body.homeLineId ?? null, defaultShiftPatternId: null, userId: worker.userId }, 'people.employeeFromWorker')
    await linkWorkerRow(tools, worker, saved.id, null)
    tools.emit({ type: 'employee.created', subject: saved.id, companyId: saved.companyId, siteId: saved.siteId, payload: { employeeId: saved.id, kind: draft.kind, source: 'WORKER', workerId: worker.id, linkedUser: worker.userId !== null } })
    return { employee: await employeeView(tx, saved, todayOf(tools.now)) }
  })
  return { ...result, replayed }
}

export interface FromUserBody extends Omit<CreateBody, 'firstName' | 'lastName' | 'homeLineId' | 'defaultShiftPatternId' | 'locale'> {
  readonly userId: string
  readonly firstName?: string | undefined
  readonly lastName?: string | undefined
}

/** POST /people/employees/from-user: the office user's record, linked to the account. */
export async function employeeFromUser(caller: CommandCaller, body: FromUserBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const placed = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true } }))
  if (!placed) throw bodyIssue('siteId', 'Not a site of the group.')
  assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, { companyId: placed.companyId, siteId: placed.id }, MANAGE_WORDS)
  const { result, replayed } = await command(caller, { name: 'people.employeeFromUser', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const site = await activeSite(tx, body.siteId)
    await checkAccount(tx, context, body.userId, null)
    const user = (await tx.user.findUnique({ where: { id: body.userId }, select: { displayName: true, locale: true } }))!
    const read = namesFromDisplayName(user.displayName)
    const firstName = body.firstName ?? read?.firstName
    const lastName = body.lastName ?? read?.lastName
    if (!firstName || !lastName) throw bodyIssue(firstName ? 'lastName' : 'firstName', `The user's name "${user.displayName}" is one word: give the first and last name.`)
    const draft = draftOf({ ...body, firstName, lastName, locale: /^[a-z]{2,3}$/.test(user.locale) ? user.locale : 'it' })
    const problems = employeeProblems(draft)
    if (problems.length > 0) throw problemsError(problems, 'The employee is not valid.')
    await checkRefs(tx, site.companyId, site.id, { agencyPartyId: draft.agencyPartyId })
    await checkCode(tx, context, draft.employeeCode, null)
    const saved = await insertEmployee(tools, { companyId: site.companyId, siteId: site.id, draft, homeLineId: null, defaultShiftPatternId: null, userId: body.userId }, 'people.employeeFromUser')
    tools.emit({ type: 'employee.created', subject: saved.id, companyId: saved.companyId, siteId: saved.siteId, payload: { employeeId: saved.id, kind: draft.kind, source: 'USER', workerId: null, linkedUser: true } })
    return { employee: await employeeView(tx, saved, todayOf(tools.now)) }
  })
  return { ...result, replayed }
}

export interface UpdateBody {
  readonly version: number
  readonly firstName?: string | undefined
  readonly lastName?: string | undefined
  readonly displayName?: string | undefined
  readonly employeeCode?: string | null | undefined
  readonly kind?: EmployeeKind | undefined
  readonly agencyPartyId?: string | null | undefined
  readonly locale?: string | undefined
  readonly startDate?: BusinessDate | undefined
  readonly endDate?: BusinessDate | null | undefined
  readonly department?: string | null | undefined
  readonly jobRole?: string | null | undefined
  readonly siteId?: string | undefined
  readonly homeLineId?: string | null | undefined
  readonly contract?: EmployeeContract | null | undefined
  readonly weeklyMinutes?: number | null | undefined
  readonly defaultShiftPatternId?: string | null | undefined
  readonly reason?: string | undefined
}

/** A record the caller may change: found, readable, writable, not LEFT. */
async function writableEmployee(caller: CommandCaller, context: OfficeContext, employeeId: string): Promise<EmployeeRow> {
  const row = isUuid(employeeId) ? await caller.withClient((client) => readEmployee(client, employeeId)) : null
  if (!row) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_VIEW, row, 'Employee')
  assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, row, MANAGE_WORDS)
  return row
}

/** The row in the command, locked, at the version read; a LEFT record no longer changes. */
async function lockedEmployee(tx: Tx, employeeId: string, version: number): Promise<EmployeeRow> {
  const row = (await lockEmployee(tx, employeeId))!
  if (row.status === 'LEFT') refuse('LEFT', 'This person has left: the record no longer changes.')
  assertVersion('employee', row.version, version)
  return row
}

const TEXT_FIELDS = ['department', 'jobRole'] as const

/** PATCH /people/employees/:employeeId. */
export async function updateEmployee(caller: CommandCaller, employeeId: string, body: UpdateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await writableEmployee(caller, context, employeeId)
  if (body.siteId !== undefined && body.siteId !== known.siteId) {
    const target = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId! }, select: { id: true, companyId: true } }))
    if (!target) throw bodyIssue('siteId', 'Not a site of the group.')
    if (target.companyId !== known.companyId) throw bodyIssue('siteId', 'Another company employs the person under a new record: a move stays within the company.')
    assertMayWrite(context, PEOPLE_EMPLOYEES_MANAGE, { companyId: target.companyId, siteId: target.id }, MANAGE_WORDS)
  }
  const { result } = await command(caller, { name: 'people.updateEmployee', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedEmployee(tx, employeeId, body.version)
    const today = todayOf(now)
    const moving = body.siteId !== undefined && body.siteId !== row.siteId
    const kind = body.kind ?? (row.kind as EmployeeKind)
    const draft: EmployeeDraft = {
      firstName: body.firstName !== undefined ? cleanName(body.firstName) : row.firstName,
      lastName: body.lastName !== undefined ? cleanName(body.lastName) : row.lastName,
      displayName: body.displayName !== undefined ? cleanName(body.displayName) : row.displayName,
      employeeCode: body.employeeCode !== undefined ? cleanCode(body.employeeCode) : row.employeeCode,
      kind,
      // Away from AGENCY the agency goes with it unless one is given.
      agencyPartyId: body.agencyPartyId !== undefined ? body.agencyPartyId : kind !== 'AGENCY' ? null : row.agencyPartyId,
      locale: body.locale !== undefined ? body.locale.trim().toLowerCase() : row.locale,
      startDate: body.startDate ?? dayOf(row.startDate),
      endDate: body.endDate !== undefined ? body.endDate : dayOrNull(row.endDate),
      department: body.department !== undefined ? cleanText(body.department) : row.department,
      jobRole: body.jobRole !== undefined ? cleanText(body.jobRole) : row.jobRole,
      contract: body.contract !== undefined ? body.contract : ((row.contract as EmployeeContract | null) ?? null),
      weeklyMinutes: body.weeklyMinutes !== undefined ? body.weeklyMinutes : row.weeklyMinutes,
    }
    const problems = employeeProblems(draft)
    if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
    const siteId = moving ? body.siteId! : row.siteId
    if (moving) await activeSite(tx, siteId)
    const homeLineId = body.homeLineId !== undefined ? body.homeLineId : moving ? null : row.homeLineId
    const defaultShiftPatternId = body.defaultShiftPatternId !== undefined ? body.defaultShiftPatternId : row.defaultShiftPatternId
    await checkRefs(tx, row.companyId, siteId, {
      agencyPartyId: draft.agencyPartyId !== row.agencyPartyId ? draft.agencyPartyId : null,
      homeLineId: homeLineId !== row.homeLineId || moving ? homeLineId : null,
      defaultShiftPatternId: defaultShiftPatternId !== row.defaultShiftPatternId ? defaultShiftPatternId : null,
    })
    if (draft.employeeCode !== row.employeeCode) await checkCode(tx, context, draft.employeeCode, row.id)
    const data: Prisma.EmployeeUncheckedUpdateInput = {}
    const fields: string[] = []
    const set = (field: string, next: unknown, current: unknown, stored: unknown = next) => {
      if (next === current) return
      ;(data as Record<string, unknown>)[field] = stored
      fields.push(field)
    }
    set('firstName', draft.firstName, row.firstName)
    set('lastName', draft.lastName, row.lastName)
    set('displayName', draft.displayName, row.displayName)
    set('employeeCode', draft.employeeCode, row.employeeCode)
    set('kind', draft.kind, row.kind)
    set('agencyPartyId', draft.agencyPartyId, row.agencyPartyId)
    set('locale', draft.locale, row.locale)
    set('startDate', draft.startDate, dayOf(row.startDate), dateOf(draft.startDate))
    set('endDate', draft.endDate, dayOrNull(row.endDate), draft.endDate === null ? null : dateOf(draft.endDate))
    for (const field of TEXT_FIELDS) set(field, draft[field], row[field])
    set('contract', draft.contract, row.contract)
    set('weeklyMinutes', draft.weeklyMinutes, row.weeklyMinutes)
    set('siteId', siteId, row.siteId)
    set('homeLineId', homeLineId, row.homeLineId)
    set('defaultShiftPatternId', defaultShiftPatternId, row.defaultShiftPatternId)
    if (fields.length === 0) {
      tools.audit({ action: 'people.updateEmployee', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { unchanged: true } })
      return { employee: await employeeView(tx, row, today) }
    }
    if (moving) {
      // A team and a loan belong to a site: the membership ends today; a planned or running loan stops the move.
      const loans = await tx.lineLoan.count({ where: { employeeId: row.id, endsAt: { gt: now } } })
      if (loans > 0) refuse('LOAN_OPEN', 'The person has a planned or running loan to another line: end or remove it before the move.', 'siteId')
      await endMembership(tools, row.id, today)
    }
    await tx.employee.update({ where: { id: row.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const saved = (await readEmployee(tx, row.id))!
    tools.audit({ action: 'people.updateEmployee', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: saved.siteId, before: auditedEmployee(row), after: auditedEmployee(saved), ...(body.reason ? { reason: body.reason } : {}) })
    tools.emit({ type: 'employee.updated', subject: row.id, companyId: row.companyId, siteId: saved.siteId, payload: { employeeId: row.id, change: moving ? 'MOVED_SITE' : 'EDITED', fields, workerId: null, by: 'OFFICE' } })
    return { employee: await employeeView(tx, saved, today) }
  })
  return result
}

/**
 * Ends the person's current team membership effective today (ended yesterday, or removed when it began today), taking
 * the lead flag with it. Emits team.changed for the team. Used by a move of site and by the leaver steps.
 */
export async function endMembership(tools: CommandTools, employeeId: string, today: BusinessDate, until?: BusinessDate): Promise<string | null> {
  const { tx } = tools
  const current = await currentMembership(tx, employeeId)
  if (!current) return null
  const team = (await tx.team.findUnique({ where: { id: current.teamId }, select: { id: true, code: true, companyId: true, siteId: true } }))!
  const plan = movePlan({ id: current.id, teamId: current.teamId, isLead: current.isLead, since: dayOf(current.since) }, null, until ? nextDay(until) : today)
  if (plan.kind === 'NONE') return null
  if (plan.remove) await tx.teamMember.delete({ where: { id: plan.remove }, select: { id: true } })
  if (plan.end) {
    if (current.isLead) await tx.teamMember.update({ where: { id: current.id }, data: { isLead: false, version: { increment: 1 } }, select: { id: true } })
    await tx.teamMember.update({ where: { id: plan.end.id }, data: { until: dateOf(plan.end.until), version: { increment: 1 } }, select: { id: true } })
  }
  tools.audit({ action: 'people.endMembership', recordType: 'Team', recordId: team.id, companyId: team.companyId, siteId: team.siteId, before: { employeeId, since: dayOf(current.since), isLead: current.isLead }, after: plan.remove ? { removed: true } : { until: plan.end!.until } })
  tools.emit({ type: 'team.changed', subject: team.id, companyId: team.companyId, siteId: team.siteId, payload: { teamId: team.id, code: team.code, change: 'MEMBERS_MOVED', employeeIds: [employeeId] } })
  return team.id
}

const nextDay = (date: BusinessDate): BusinessDate => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

/** POST /people/employees/:employeeId/workers: link a floor sign-in of the same company (one per site). */
export async function linkWorker(caller: CommandCaller, employeeId: string, body: { readonly version: number; readonly workerId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableEmployee(caller, context, employeeId)
  const known = await caller.withClient((client) => client.worker.findUnique({ where: { id: body.workerId }, select: { id: true, companyId: true, siteId: true } }))
  if (!known) throw new NotFoundError('Worker not found.')
  assertMay(context, PEOPLE_VIEW, known, 'Worker')
  const { result } = await command(caller, { name: 'people.linkWorker', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedEmployee(tx, employeeId, body.version)
    await tx.$queryRaw`SELECT "id" FROM "Worker" WHERE "id" = ${body.workerId}::uuid FOR UPDATE`
    const worker = (await tx.worker.findUnique({ where: { id: body.workerId }, select: { id: true, companyId: true, siteId: true, userId: true, employeeId: true, status: true, employeeCode: true } }))!
    if (worker.employeeId === row.id) refuse('WORKER_LINKED', 'This floor sign-in is linked to this record already.', 'workerId')
    if (worker.employeeId !== null) refuse('WORKER_LINKED', 'This floor sign-in belongs to another employee record: one record per person.', 'workerId')
    if (worker.companyId !== row.companyId) refuse('WORKER_OTHER_COMPANY', "The floor sign-in is of another company: a record links its own company's sign-ins.", 'workerId')
    if (worker.status !== 'ACTIVE') refuse('WORKER_INACTIVE', 'This floor sign-in is switched off: reactivate it in Admin › Users first.', 'workerId')
    const sameSite = await tx.worker.findFirst({ where: { employeeId: row.id, siteId: worker.siteId, status: 'ACTIVE' }, select: { id: true } })
    if (sameSite) refuse('WORKER_SITE_TAKEN', 'The person has a floor sign-in at this site already: one per site.', 'workerId')
    let userId = row.userId
    if (worker.userId !== null) {
      if (row.userId !== null && row.userId !== worker.userId) refuse('ACCOUNT_DISAGREES', "The floor sign-in names another office account than this record's: one person has one account.", 'workerId')
      if (row.userId === null) {
        const owner = await tx.employee.findFirst({ where: { userId: worker.userId, id: { not: row.id } }, select: { id: true } })
        if (owner) refuse('ACCOUNT_TAKEN', "The floor sign-in's office account belongs to another employee record.", 'workerId')
        userId = worker.userId
      }
    }
    if (worker.employeeCode !== null && row.employeeCode !== null && worker.employeeCode !== row.employeeCode) {
      refuse('CODE_ON_WORKER', `The floor sign-in carries employee code ${worker.employeeCode}, the record ${row.employeeCode}: make them agree in Admin › Users first.`, 'workerId')
    }
    if (userId !== row.userId) await tx.employee.update({ where: { id: row.id }, data: { userId }, select: { id: true } })
    await tx.employee.update({ where: { id: row.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await linkWorkerRow(tools, worker, row.id, null)
    tools.audit({ action: 'people.linkWorker', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { userId: row.userId }, after: { workerId: worker.id, userId } })
    tools.emit({ type: 'employee.updated', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { employeeId: row.id, change: 'WORKER_LINKED', fields: userId !== row.userId ? ['userId'] : [], workerId: worker.id, by: 'OFFICE' } })
    return { employee: await employeeView(tx, (await readEmployee(tx, row.id))!, todayOf(now)) }
  })
  return result
}

/** POST /people/employees/:employeeId/workers/:workerId/unlink. */
export async function unlinkWorker(caller: CommandCaller, employeeId: string, workerId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await writableEmployee(caller, context, employeeId)
  const { result } = await command(caller, { name: 'people.unlinkWorker', idempotencyKey, input: { employeeId, workerId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedEmployee(tx, employeeId, body.version)
    const worker = await tx.worker.findUnique({ where: { id: workerId }, select: { id: true, companyId: true, siteId: true, employeeId: true } })
    if (!worker || worker.employeeId !== row.id) throw new NotFoundError('This floor sign-in is not linked to this record.')
    await tx.employee.update({ where: { id: row.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    await linkWorkerRow(tools, worker, null, row.id)
    tools.audit({ action: 'people.unlinkWorker', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { workerId }, after: { workerId: null }, reason: body.reason })
    tools.emit({ type: 'employee.updated', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { employeeId: row.id, change: 'WORKER_UNLINKED', fields: [], workerId, by: 'OFFICE' } })
    return { employee: await employeeView(tx, (await readEmployee(tx, row.id))!, todayOf(now)) }
  })
  return result
}

/** PUT /people/employees/:employeeId/user: the office account (one per person), or none. */
export async function setAccount(caller: CommandCaller, employeeId: string, body: { readonly version: number; readonly userId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await writableEmployee(caller, context, employeeId)
  if (body.userId === null && known.userId === context.actorId) throw new ForbiddenError('This record is yours: ask another administrator to change its office account.')
  const { result } = await command(caller, { name: 'people.setAccount', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockedEmployee(tx, employeeId, body.version)
    if (body.userId !== null) {
      await checkAccount(tx, context, body.userId, row.id)
      const disagreeing = await tx.worker.findFirst({ where: { employeeId: row.id, userId: { not: null }, NOT: { userId: body.userId } }, select: { id: true } })
      if (disagreeing) refuse('ACCOUNT_DISAGREES', "A floor sign-in of this record names another office account: change it in Admin › Users first (one person, one account).", 'userId')
    }
    if (body.userId === row.userId) {
      tools.audit({ action: 'people.setAccount', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { unchanged: true } })
      return { employee: await employeeView(tx, row, todayOf(now)) }
    }
    await tx.employee.update({ where: { id: row.id }, data: { userId: body.userId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'people.setAccount', recordType: 'Employee', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { userId: row.userId }, after: { userId: body.userId } })
    tools.emit({ type: 'employee.updated', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { employeeId: row.id, change: body.userId === null ? 'ACCOUNT_UNLINKED' : 'ACCOUNT_LINKED', fields: ['userId'], workerId: null, by: 'OFFICE' } })
    return { employee: await employeeView(tx, (await readEmployee(tx, row.id))!, todayOf(now)) }
  })
  return result
}
