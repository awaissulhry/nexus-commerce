import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { OPEN_JOB_STATUSES } from '@nexus/factory-domain/plant/rules'
import { PEOPLE_VIEW } from '@nexus/factory-domain/people/employees/permissions'
import type { EmployeeKind } from '@nexus/factory-domain/people/employees/rules'
import { PEOPLE_LEAVERS_MANAGE } from '@nexus/factory-domain/people/leavers/permissions'
import { cancelRefusal, leaverStepsFor, startRefusal, stepRefusal, type LeaverCaseStatus, type LeaverRefusal, type LeaverStepKind, type LeaverStepStatus, type LeaverView, type StepAction } from '@nexus/factory-domain/people/leavers/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { actorIdOf, assertMay, assertMayWrite, assertVersion, bodyIssue, dateOf, dayOf, may, officeOf, refuse, scopeOf, todayOf } from '../employees/access'
import { caseViewOf, CASE_SELECT, type CaseRow } from '../employees/cases'
import { userNames } from '../employees/employees'
import { lockEmployee, nameOf, readEmployee } from '../employees/store'
import { settleCase } from './automatic'

/**
 * Leaver steps (B-W2b-26; MES-214; design people.employees "Leavers in progress", "Start leaver steps"), office only,
 * people.view to read, people.leavers.manage to write, checked with can() against the person's company and site.
 *
 *   GET  /people/leavers                                   open (default), done, cancelled or every leaving
 *   GET  /people/leavers/:caseId                           one leaving with its steps
 *   GET  /people/employees/:employeeId/leaving/preview     what leaving on a day would mean (the steps, open work, shifts)
 *   POST /people/employees/:employeeId/leaving             start the leaver steps (one open leaving per person)
 *   POST /people/leavers/:caseId/steps/:stepId/done        tick a step (where it was done, when a record shows it)
 *   POST /people/leavers/:caseId/steps/:stepId/skip        skip a step with the reason
 *   POST /people/leavers/:caseId/steps/:stepId/reopen      reopen a step while the leaving is open
 *   POST /people/leavers/:caseId/cancel                    "Cancel leaving" until the last day, with the reason
 *   POST /people/leavers/:caseId/check                     settle the automatic steps now (the cron does it hourly)
 *
 * Every write settles the case in the same command (./automatic.ts): the automatic steps that are due tick, and the case
 * closes (the person LEFT) once nothing is open and the last day has come.
 */

type Client = FactoryClient | CommandTx

const PERSON_SELECT = { id: true, companyId: true, siteId: true, firstName: true, lastName: true, displayName: true, employeeCode: true, kind: true, site: { select: { code: true, name: true } } } as const satisfies Prisma.EmployeeSelect
type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof PERSON_SELECT }>

const LEAVER_SELECT = { ...CASE_SELECT, employee: { select: PERSON_SELECT } } as const satisfies Prisma.LeaverCaseSelect
type LeaverRow = CaseRow & { readonly employee: PersonRow }

async function leaverViews(client: Client, rows: readonly LeaverRow[]) {
  const names = await userNames(client, rows.flatMap((row) => [row.startedById, ...row.steps.map((step) => step.doneById)]))
  return rows.map((row) => ({
    ...caseViewOf(row, names),
    employee: { id: row.employee.id, name: nameOf(row.employee), displayName: row.employee.displayName, employeeCode: row.employee.employeeCode, kind: row.employee.kind as EmployeeKind, site: { id: row.employee.siteId, code: row.employee.site.code, name: row.employee.site.name }, companyId: row.employee.companyId },
    openSteps: row.steps.filter((step) => step.status === 'OPEN').length,
  }))
}

const readLeaver = (client: Client, id: string): Promise<LeaverRow | null> => client.leaverCase.findUnique({ where: { id }, select: LEAVER_SELECT }) as Promise<LeaverRow | null>
const viewOf = async (client: Client, id: string) => (await leaverViews(client, [(await readLeaver(client, id))!]))[0]!

const STATUS_OF: Readonly<Record<LeaverView, LeaverCaseStatus | null>> = { open: 'OPEN', done: 'DONE', cancelled: 'CANCELLED', all: null }

/** GET /people/leavers: open ones by their last day (soonest first), closed ones newest first. */
export async function listLeavers(caller: CommandCaller, query: { readonly view: LeaverView; readonly siteId?: string | undefined; readonly companyId?: string | undefined; readonly limit: number }, now: Date = new Date()) {
  const context = officeOf(caller)
  const status = STATUS_OF[query.view]
  return caller.withClient(async (client) => {
    const rows = (await client.leaverCase.findMany({
      where: {
        AND: [
          { employee: { AND: [scopeOf(context, PEOPLE_VIEW) as Prisma.EmployeeWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.companyId ? { companyId: query.companyId } : {}] } },
          status ? { status } : {},
        ],
      },
      orderBy: status === 'OPEN' ? [{ lastWorkingDay: 'asc' }, { id: 'asc' }] : [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: LEAVER_SELECT,
    })) as LeaverRow[]
    return { leavers: await leaverViews(client, rows), today: todayOf(now) }
  })
}

/** The case, readable by the caller (404 otherwise). */
async function visibleLeaver(client: Client, context: OfficeContext, caseId: string): Promise<LeaverRow> {
  const row = isUuid(caseId) ? await readLeaver(client, caseId) : null
  if (!row) throw new NotFoundError('Leaver case not found.')
  assertMay(context, PEOPLE_VIEW, row.employee, 'Leaver case')
  return row
}

/** GET /people/leavers/:caseId. */
export async function leaverRecord(caller: CommandCaller, caseId: string, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const row = await visibleLeaver(client, context, caseId)
    return { leaver: (await leaverViews(client, [row]))[0]!, canManage: may(context, PEOPLE_LEAVERS_MANAGE, row.employee), today: todayOf(now) }
  })
}

/** What a leaving needs to know of the person: floor sign-ins and badges, the account, open work, shifts and loans after. */
async function factsOf(client: Client, employee: { readonly id: string; readonly userId: string | null }, lastWorkingDay: BusinessDate, now: Date) {
  const workers = await client.worker.findMany({ where: { employeeId: employee.id, status: 'ACTIVE' }, select: { id: true, _count: { select: { badges: { where: { status: 'ACTIVE' } } } } } })
  const workerIds = workers.map((worker) => worker.id)
  const openTasks = employee.userId ? await client.task.count({ where: { assigneeId: employee.userId, status: 'OPEN' } }) : 0
  const openMaintenanceJobs = await client.maintenanceJob.count({ where: { status: { in: [...OPEN_JOB_STATUSES] }, OR: [...(employee.userId ? [{ assigneeId: employee.userId }] : []), ...(workerIds.length > 0 ? [{ assigneeWorkerId: { in: workerIds } }] : [])] } })
  const shiftsAfter = await client.rosterEntry.count({ where: { employeeId: employee.id, date: { gt: dateOf(lastWorkingDay) }, kind: 'WORK' } })
  const loansAfter = await client.lineLoan.count({ where: { employeeId: employee.id, endsAt: { gt: now } } })
  return {
    floorSignIns: workers.length,
    activeBadges: workers.reduce((sum, worker) => sum + worker._count.badges, 0),
    officeAccount: employee.userId !== null,
    openTasks: workerIds.length === 0 && !employee.userId ? 0 : openTasks,
    openMaintenanceJobs: workerIds.length === 0 && !employee.userId ? 0 : openMaintenanceJobs,
    shiftsAfter,
    loansAfter,
  }
}

const refusalOf = (refusal: LeaverRefusal | null): never | void => {
  if (refusal) refuse(refusal.code, refusal.message, refusal.code === 'BEFORE_START' || refusal.code === 'TOO_FAR' ? 'lastWorkingDay' : undefined)
}

/** GET /people/employees/:employeeId/leaving/preview: the steps and the consequences, and why it cannot start (if so). */
export async function leavingPreview(caller: CommandCaller, employeeId: string, query: { readonly lastWorkingDay: BusinessDate; readonly exitVisit?: boolean | undefined; readonly ppeReturn?: boolean | undefined }, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const employee = isUuid(employeeId) ? await readEmployee(client, employeeId) : null
    if (!employee) throw new NotFoundError('Employee not found.')
    assertMay(context, PEOPLE_VIEW, employee, 'Employee')
    const consequences = await factsOf(client, employee, query.lastWorkingDay, now)
    const leaving = (await client.leaverCase.count({ where: { employeeId, status: 'OPEN' } })) > 0
    return {
      steps: leaverStepsFor(consequences, { exitVisit: query.exitVisit ?? false, ppeReturn: query.ppeReturn ?? false }, query.lastWorkingDay),
      consequences,
      refusal: startRefusal({ status: employee.status, leaving, startDate: dayOf(employee.startDate), lastWorkingDay: query.lastWorkingDay, today: todayOf(now) }),
    }
  })
}

const MANAGE_WORDS = 'Leaver steps of this site are kept by a role that keeps them (people.leavers.manage).'

/** POST /people/employees/:employeeId/leaving: the case OPEN with its steps; a last day already past settles at once. */
export async function startLeaving(caller: CommandCaller, employeeId: string, body: { readonly lastWorkingDay: BusinessDate; readonly exitVisit?: boolean | undefined; readonly ppeReturn?: boolean | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = isUuid(employeeId) ? await caller.withClient((client) => readEmployee(client, employeeId)) : null
  if (!known) throw new NotFoundError('Employee not found.')
  assertMay(context, PEOPLE_VIEW, known, 'Employee')
  assertMayWrite(context, PEOPLE_LEAVERS_MANAGE, known, MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'people.startLeaving', idempotencyKey, input: { employeeId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const employee = (await lockEmployee(tx, employeeId))!
    const leaving = (await tx.leaverCase.count({ where: { employeeId, status: 'OPEN' } })) > 0
    refusalOf(startRefusal({ status: employee.status, leaving, startDate: dayOf(employee.startDate), lastWorkingDay: body.lastWorkingDay, today: todayOf(now) }))
    const facts = await factsOf(tx, employee, body.lastWorkingDay, now)
    const steps = leaverStepsFor(facts, { exitVisit: body.exitVisit ?? false, ppeReturn: body.ppeReturn ?? false }, body.lastWorkingDay)
    const startedById = actorIdOf(tools.context)!
    await tx.leaverCase.create({ data: { id, employeeId, lastWorkingDay: dateOf(body.lastWorkingDay), status: 'OPEN', startedAt: now, startedById, createdAt: now, updatedAt: now, createdById: startedById }, select: { id: true } })
    await tx.leaverStep.createMany({ data: steps.map((step) => ({ id: newId(), caseId: id, kind: step.kind, seq: step.seq, automatic: step.automatic, dueOn: step.dueOn === null ? null : dateOf(step.dueOn), status: 'OPEN' as const, createdAt: now, updatedAt: now, createdById: startedById })) })
    tools.audit({ action: 'people.startLeaving', recordType: 'Employee', recordId: employee.id, companyId: employee.companyId, siteId: employee.siteId, after: { caseId: id, lastWorkingDay: body.lastWorkingDay, steps: steps.map((step) => step.kind), openTasks: facts.openTasks, openMaintenanceJobs: facts.openMaintenanceJobs } })
    tools.emit({ type: 'leaver.started', subject: id, companyId: employee.companyId, siteId: employee.siteId, payload: { caseId: id, employeeId: employee.id, steps: steps.map((step) => step.kind), by: 'OFFICE' } })
    await settleCase(tools, id)
    return { leaver: await viewOf(tx, id) }
  })
  return { ...result, replayed }
}

async function writableLeaver(caller: CommandCaller, caseId: string): Promise<LeaverRow> {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => visibleLeaver(client, context, caseId))
  assertMayWrite(context, PEOPLE_LEAVERS_MANAGE, row.employee, MANAGE_WORDS)
  return row
}

const ACTION_NAME: Readonly<Record<StepAction, 'people.leaverStepDone' | 'people.leaverStepSkipped' | 'people.leaverStepReopened'>> = { DONE: 'people.leaverStepDone', SKIP: 'people.leaverStepSkipped', REOPEN: 'people.leaverStepReopened' }

/** POST /people/leavers/:caseId/steps/:stepId/done | skip | reopen. */
export async function moveStep(caller: CommandCaller, caseId: string, stepId: string, action: StepAction, body: { readonly version: number; readonly reason?: string | undefined; readonly recordType?: string | undefined; readonly recordId?: string | undefined }, idempotencyKey?: string) {
  await writableLeaver(caller, caseId)
  if ((body.recordType === undefined) !== (body.recordId === undefined)) throw bodyIssue(body.recordType === undefined ? 'recordType' : 'recordId', 'Where the step was done names a record type and its id, or neither.')
  const { result } = await command(caller, { name: ACTION_NAME[action], idempotencyKey, input: { caseId, stepId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "LeaverCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`
    const leaver = (await readLeaver(tx, caseId))!
    const step = leaver.steps.find((entry) => entry.id === stepId)
    if (!step) throw new NotFoundError('Leaver step not found.')
    assertVersion('step', step.version, body.version)
    const refusal = stepRefusal(leaver.status as LeaverCaseStatus, step.status as LeaverStepStatus, action, body.reason)
    if (refusal) refuse(refusal.code, refusal.message, refusal.code === 'NO_REASON' ? 'reason' : undefined)
    const actorId = actorIdOf(tools.context)
    const data: Prisma.LeaverStepUncheckedUpdateInput =
      action === 'DONE'
        ? { status: 'DONE', doneAt: now, doneById: actorId, skipReason: null, recordType: body.recordType ?? null, recordId: body.recordId ?? null }
        : action === 'SKIP'
          ? { status: 'SKIPPED', doneAt: now, doneById: actorId, skipReason: body.reason!.trim(), recordType: null, recordId: null }
          : { status: 'OPEN', doneAt: null, doneById: null, skipReason: null, recordType: null, recordId: null }
    await tx.leaverStep.update({ where: { id: step.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const status: LeaverStepStatus = action === 'DONE' ? 'DONE' : action === 'SKIP' ? 'SKIPPED' : 'OPEN'
    tools.audit({ action: ACTION_NAME[action], recordType: 'Employee', recordId: leaver.employeeId, companyId: leaver.employee.companyId, siteId: leaver.employee.siteId, before: { caseId, step: step.kind, status: step.status }, after: { caseId, step: step.kind, status, recordType: body.recordType ?? null, recordId: body.recordId ?? null }, ...(body.reason ? { reason: body.reason } : {}) })
    tools.emit({ type: 'leaver.step_done', subject: caseId, companyId: leaver.employee.companyId, siteId: leaver.employee.siteId, payload: { caseId, employeeId: leaver.employeeId, stepId: step.id, kind: step.kind as LeaverStepKind, status, by: 'OFFICE' } })
    await settleCase(tools, caseId)
    return { leaver: await viewOf(tx, caseId) }
  })
  return result
}

/** POST /people/leavers/:caseId/cancel: until the last day, with the reason. */
export async function cancelLeaving(caller: CommandCaller, caseId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  await writableLeaver(caller, caseId)
  const { result } = await command(caller, { name: 'people.cancelLeaving', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "LeaverCase" WHERE "id" = ${caseId}::uuid FOR UPDATE`
    const leaver = (await readLeaver(tx, caseId))!
    assertVersion('leaver case', leaver.version, body.version)
    const refusal = cancelRefusal({ status: leaver.status as LeaverCaseStatus, lastWorkingDay: dayOf(leaver.lastWorkingDay), today: todayOf(now) })
    if (refusal) refuse(refusal.code, refusal.message)
    await tx.leaverCase.update({ where: { id: caseId }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: actorIdOf(tools.context), cancelReason: body.reason.trim(), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'people.cancelLeaving', recordType: 'Employee', recordId: leaver.employeeId, companyId: leaver.employee.companyId, siteId: leaver.employee.siteId, before: { caseId, status: 'OPEN' }, after: { caseId, status: 'CANCELLED' }, reason: body.reason })
    tools.emit({ type: 'leaver.ended', subject: caseId, companyId: leaver.employee.companyId, siteId: leaver.employee.siteId, payload: { caseId, employeeId: leaver.employeeId, outcome: 'CANCELLED', by: 'OFFICE' } })
    return { leaver: await viewOf(tx, caseId) }
  })
  return result
}

/** POST /people/leavers/:caseId/check: settle the automatic steps now (an audited no-op when nothing is due). */
export async function checkLeaving(caller: CommandCaller, caseId: string, idempotencyKey?: string) {
  await writableLeaver(caller, caseId)
  const { result } = await command(caller, { name: 'people.settleLeaver', idempotencyKey, input: { caseId } }, async (tools: CommandTools) => {
    const settled = await settleCase(tools, caseId)
    const leaver = (await readLeaver(tools.tx, caseId))!
    if (settled.ticked.length === 0 && !settled.closed && settled.floorSwitchedOff === 0) {
      tools.audit({ action: 'people.settleLeaver', recordType: 'Employee', recordId: leaver.employeeId, companyId: leaver.employee.companyId, siteId: leaver.employee.siteId, after: { caseId, unchanged: true } })
    }
    return { leaver: (await leaverViews(tools.tx, [leaver]))[0]!, ticked: [...settled.ticked], floorSwitchedOff: settled.floorSwitchedOff, closed: settled.closed }
  })
  return result
}
