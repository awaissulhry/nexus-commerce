import type { CheckOutcome as DbCheckOutcome, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANT_JOBS_MANAGE, PLANT_REPORT, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { OPEN_JOB_STATUSES, type JobType, type Priority } from '@nexus/factory-domain/plant/rules'
import { PLANT_CHECKS_MANAGE } from '@nexus/factory-domain/plant/statutory/permissions'
import {
  CHECK_LIMITS,
  correctedAlready,
  correctsOther,
  dateOf,
  dayOf,
  jobDefaultsOf,
  jobExists,
  jobProblemOf,
  keptUntilOf,
  lockedAlready,
  lockNeedsFailed,
  lockWordsOf,
  machineRetired,
  nextDueAfter,
  noJobForPassed,
  planEnded,
  planOther,
  resultProblems,
  takesJob,
  takesLock,
  type CheckIntervalUnit,
  type CheckOutcome,
} from '@nexus/factory-domain/plant/statutory/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertMay, assertMayWrite, bodyIssue, may, officeOf, problemsError } from '../access'
import { checkAssignee, makeJobInCommand } from '../making'
import { reportInCommand } from '../requests/requests'
import { jobViews, lockMachine, locksOf, machineViews, readJob, readMachine, readRequest, requestViews, type MachineRow } from '../store'
import { checkOutsideBody, lockPlan, planViews, readPlan, readResult, refuse, RESULT_COLUMNS, resultViews, todayOf, type PlanRow, type ResultRow } from './store'

/**
 * The check register (B-W2b-124; QHS-205; D.Lgs. 81/2008 art. 71; design plant.preventive "Record a check result":
 * "Failed → 'Make a job' and 'Lock as unsafe' in the same step", "Check register": "A failed result offers 'Make a job'
 * and 'Lock as unsafe'"):
 *
 *   POST /plant/checks/results               a result, in ONE command (the machine row locked first, then the plan): the
 *                                            result (append-only; kept until the day + the type's years, at least three),
 *                                            the plan's next due date moved (its date, else the day + the interval) and its
 *                                            reminder cleared, and — when asked — the job (MaintenanceJob STATUTORY_CHECK
 *                                            naming the result, through the jobs module's makeJobInCommand) and the lock
 *                                            (an unsafe office request through the requests module's reportInCommand: the
 *                                            machine DO_NOT_USE at once, routed, maintenance_request.locked; Owner answer
 *                                            H1: only a technician's sign-safe frees it). Job and lock together: the lock
 *                                            request is the job's (JOB_MADE). A correction names the result it corrects
 *                                            with why (each once); it moves the plan when it corrects the plan's last check.
 *   POST /plant/checks/results/:id/job       the job of a failed or remarked result afterwards (one open job per result)
 *   POST /plant/checks/results/:id/lock      the lock of a failed result afterwards (it joins the result's open job)
 *   GET  /plant/checks/results/:id           one result: plan, corrections, jobs, reports, what this person may do
 *
 * Permissions: plant.checks.manage records; the job asks plant.jobs.manage too, the lock plant.report (H1: anyone who
 * reports may lock), each over the machine's company and site, before anything is written.
 */

export interface JobAsk {
  readonly type?: JobType | undefined
  readonly priority?: Priority | undefined
  readonly problem?: string | undefined
  readonly assigneeId?: string | null | undefined
  readonly assigneeWorkerId?: string | null | undefined
  readonly dueAt?: string | null | undefined
  readonly plan?: boolean | undefined
}

export interface LockAsk {
  readonly note?: string | undefined
}

export interface RecordBody {
  /** The plan it is due under; else the machine and check type (the ACTIVE plan of the two is used when there is one). */
  readonly planId?: string | undefined
  readonly machineId?: string | undefined
  readonly checkTypeId?: string | undefined
  readonly performedOn: BusinessDate
  readonly outcome: CheckOutcome
  readonly remarks?: string | null | undefined
  readonly performedBy: string
  readonly outsideBodyPartyId?: string | null | undefined
  readonly nextDueOn?: BusinessDate | null | undefined
  readonly correctsId?: string | null | undefined
  readonly correctionReason?: string | null | undefined
  /** Make a job of it in the same step (a failed or remarked result). */
  readonly job?: JobAsk | undefined
  /** Lock the machine as unsafe in the same step (a failed result). */
  readonly lock?: LockAsk | undefined
}

/** What a caller must hold over the machine for each part of the step, asked before anything is written. */
function assertParts(context: OfficeContext, machine: { readonly companyId: string; readonly siteId: string }, parts: { readonly record: boolean; readonly job: boolean; readonly lock: boolean }): void {
  if (parts.record) assertMayWrite(context, PLANT_CHECKS_MANAGE, machine, 'Check results of this site are recorded by a role that keeps the statutory checks (plant.checks.manage).')
  if (parts.job) assertMayWrite(context, PLANT_JOBS_MANAGE, machine, 'A job of the check is made by a role that plans maintenance jobs (plant.jobs.manage).')
  if (parts.lock) assertMayWrite(context, PLANT_REPORT, machine, 'The machine is locked by a role that reports machine problems (plant.report).')
}

/** The newest result of a plan in force (not corrected), other than `except`. */
async function lastOfPlan(tx: Pick<CommandTx, 'machineCheckResult'>, planId: string, except?: string) {
  return tx.machineCheckResult.findFirst({
    where: { planId, correctedBy: { none: {} }, ...(except ? { id: { not: except } } : {}) },
    orderBy: [{ performedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, performedOn: true },
  })
}

interface Made {
  readonly jobId: string | null
  readonly lockRequestId: string | null
}

/**
 * The job and the lock of a result, inside the caller's command (the machine row locked by the caller): the lock first (the
 * report's command), then the job naming the result; the lock request joins the job (JOB_MADE). An open job of the result
 * that exists already takes the new lock instead of a new job.
 */
async function jobAndLockInCommand(
  tools: CommandTools,
  context: OfficeContext,
  machine: MachineRow,
  result: { readonly id: string; readonly outcome: CheckOutcome; readonly performedOn: BusinessDate; readonly remarks: string | null; readonly typeLabel: string },
  asks: { readonly job?: JobAsk | undefined; readonly lock?: LockAsk | undefined },
): Promise<Made> {
  const { tx, now } = tools
  let lockRequestId: string | null = null
  if (asks.lock) {
    if (!takesLock(result.outcome)) refuse(lockNeedsFailed())
    if ((await locksOf(tx, [machine.id])).has(machine.id)) refuse(lockedAlready(machine.assetNumber))
    const made = await reportInCommand(tools, context, machine, {
      description: lockWordsOf({ typeLabel: result.typeLabel, performedOn: result.performedOn, remarks: result.remarks, note: asks.lock.note?.trim() || null }),
      unsafe: true,
      down: false,
      deviceStationId: null,
    })
    lockRequestId = made.id
  }
  let jobId: string | null = null
  if (asks.job) {
    if (!takesJob(result.outcome)) refuse(noJobForPassed())
    const open = await tx.maintenanceJob.findFirst({ where: { checkResultId: result.id, status: { in: [...OPEN_JOB_STATUSES] } }, select: { number: true } })
    if (open) refuse(jobExists(open.number))
    const defaults = jobDefaultsOf(result.outcome)
    const assignee = await checkAssignee(tx, context.tenantId, machine, asks.job, now)
    const job = await makeJobInCommand(tools, {
      machine,
      type: asks.job.type ?? defaults.type,
      source: 'STATUTORY_CHECK',
      problem: asks.job.problem?.trim() || jobProblemOf({ outcome: result.outcome, typeLabel: result.typeLabel, performedOn: result.performedOn, remarks: result.remarks }),
      symptomId: null,
      priority: asks.job.priority ?? defaults.priority,
      assignee,
      dueAt: asks.job.dueAt ? new Date(asks.job.dueAt) : null,
      plan: asks.job.plan ?? false,
      requestIds: lockRequestId ? [lockRequestId] : [],
      createdById: context.actorId,
    })
    // The job names the result it was made of (set once; the database holds it to a failed or remarked result of the machine).
    await tx.maintenanceJob.update({ where: { id: job.id }, data: { checkResultId: result.id }, select: { id: true } })
    jobId = job.id
  } else if (lockRequestId) {
    // A lock afterwards joins the result's open job, when there is one.
    const open = await tx.maintenanceJob.findFirst({ where: { checkResultId: result.id, status: { in: [...OPEN_JOB_STATUSES] } }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    jobId = open?.id ?? null
  }
  if (lockRequestId && jobId) {
    await tx.maintenanceRequest.update({ where: { id: lockRequestId }, data: { status: 'JOB_MADE', jobId, acknowledgedAt: now, acknowledgedById: context.actorId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const request = (await readRequest(tx, lockRequestId))!
    const scope = { companyId: machine.companyId, siteId: machine.siteId }
    tools.audit({ action: 'plant.makeJobOfRequest', recordType: 'MaintenanceRequest', recordId: lockRequestId, ...scope, before: { status: 'NEW' }, after: { status: 'JOB_MADE', jobId, checkResultId: result.id } })
    tools.emit({ type: 'maintenance_request.triaged', subject: lockRequestId, ...scope, payload: { requestId: lockRequestId, machineId: machine.id, assetNumber: machine.assetNumber, action: 'JOB_MADE', status: 'JOB_MADE', jobId, mergedIntoId: request.mergedIntoId, closeReason: null } })
  }
  return { jobId, lockRequestId }
}

/** The answer of a step: the result, the plan after it, the job and the lock request made, the machine now. */
async function stepAnswer(tx: CommandTx, context: OfficeContext, resultId: string, made: Made, now: Date) {
  const row = (await readResult(tx, resultId))!
  const [result] = await resultViews(tx, [row])
  const plan = row.planId ? (await planViews(tx, [(await readPlan(tx, row.planId))!], now))[0]! : null
  const job = made.jobId ? (await jobViews(tx, [(await readJob(tx, made.jobId))!], context, now))[0]! : null
  const lock = made.lockRequestId ? (await requestViews(tx, [(await readRequest(tx, made.lockRequestId))!], context, now, { record: true }))[0]! : null
  const [machine] = await machineViews(tx, [(await readMachine(tx, context, row.machineId))!], context)
  return { result: result!, plan, job, lock, machine: machine! }
}

function recordedEvent(tools: Pick<CommandTools, 'emit'>, row: { readonly id: string; readonly companyId: string; readonly siteId: string; readonly machineId: string; readonly checkTypeId: string; readonly planId: string | null; readonly performedOn: BusinessDate; readonly outcome: CheckOutcome; readonly correctsId: string | null }, assetNumber: string, planNextDueOn: BusinessDate | null, made: Made): void {
  tools.emit({
    type: 'machine_check.recorded',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { resultId: row.id, machineId: row.machineId, assetNumber, checkTypeId: row.checkTypeId, planId: row.planId, performedOn: row.performedOn, outcome: row.outcome, correctsId: row.correctsId, planNextDueOn, jobId: made.jobId, lockRequestId: made.lockRequestId },
  })
}

/** POST /plant/checks/results. */
export async function recordResult(caller: CommandCaller, body: RecordBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const today = todayOf(new Date())
  const problems = resultProblems(body, today)
  if (problems.length > 0) throw problemsError(problems, 'The result is not valid.')
  if (!body.planId && !(body.machineId && body.checkTypeId)) throw bodyIssue('planId', 'Name the plan, or the machine and the check type.')
  if (body.job && !takesJob(body.outcome)) refuse(noJobForPassed())
  if (body.lock && !takesLock(body.outcome)) refuse(lockNeedsFailed())
  // Where it goes: the plan's machine, or the machine named.
  const known = await caller.withClient(async (client) => {
    const plan = body.planId && isUuid(body.planId) ? await readPlan(client, body.planId) : null
    if (body.planId && !plan) throw bodyIssue('planId', 'Not a check plan of the group.')
    if (plan && ((body.machineId && body.machineId !== plan.machineId) || (body.checkTypeId && body.checkTypeId !== plan.checkTypeId))) refuse(planOther())
    const machine = await readMachine(client, context, plan?.machineId ?? body.machineId!)
    if (!machine) throw bodyIssue('machineId', 'Not a machine of the group.')
    return { plan, machine }
  })
  assertMay(context, PLANT_VIEW, known.machine, 'Machine')
  assertParts(context, known.machine, { record: true, job: Boolean(body.job), lock: Boolean(body.lock) })
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.recordCheckResult', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machine.id))!
    if (machine.status === 'RETIRED') refuse(machineRetired(machine.assetNumber))
    const checkTypeId = known.plan?.checkTypeId ?? body.checkTypeId!
    const type = await tx.machineCheckType.findFirst({ where: { id: checkTypeId }, select: { id: true, code: true, labelEn: true, retentionYears: true } })
    if (!type) throw bodyIssue('checkTypeId', 'Not a check type of the group.')
    // The plan: the one named, else the ACTIVE plan of the machine and type (a result of it moves it).
    const planRef = known.plan ?? (await tx.machineCheckPlan.findFirst({ where: { machineId: machine.id, checkTypeId: type.id, status: 'ACTIVE' }, select: { id: true } }))
    const plan: PlanRow | null = planRef ? await lockPlan(tx, planRef.id) : null
    if (plan && plan.status !== 'ACTIVE') refuse(planEnded())
    // A correction: of a result of the same machine and type, corrected once.
    let corrected: Pick<ResultRow, 'id' | 'planId' | 'machineId' | 'checkTypeId'> | null = null
    if (body.correctsId) {
      corrected = isUuid(body.correctsId) ? await tx.machineCheckResult.findUnique({ where: { id: body.correctsId }, select: { id: true, planId: true, machineId: true, checkTypeId: true } }) : null
      if (!corrected) throw bodyIssue('correctsId', 'Not a check result of the group.')
      if (corrected.machineId !== machine.id || corrected.checkTypeId !== type.id) refuse(correctsOther())
      if ((await tx.machineCheckResult.count({ where: { correctsId: corrected.id } })) > 0) refuse(correctedAlready())
    }
    const outsideBodyPartyId = await checkOutsideBody(tx, body.outsideBodyPartyId, machine.companyId)
    // Does it move the plan? Only as the plan's newest check in force (an older check typed in later leaves it).
    const last = plan ? await lastOfPlan(tx, plan.id, corrected?.id) : null
    const moves = plan !== null && (last === null || dayOf(last.performedOn) <= body.performedOn)
    const keptUntil = keptUntilOf(body.performedOn, type.retentionYears)
    const remarks = body.remarks?.trim() || null
    await tx.machineCheckResult.create({
      data: {
        id,
        companyId: machine.companyId,
        siteId: machine.siteId,
        machineId: machine.id,
        checkTypeId: type.id,
        planId: plan?.id ?? null,
        performedOn: dateOf(body.performedOn),
        outcome: body.outcome as DbCheckOutcome,
        remarks,
        performedBy: body.performedBy.trim(),
        outsideBodyPartyId,
        nextDueOn: body.nextDueOn ? dateOf(body.nextDueOn) : null,
        keptUntil: dateOf(keptUntil),
        correctsId: corrected?.id ?? null,
        correctionReason: corrected ? body.correctionReason!.trim() : null,
        createdAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    const scope = { companyId: machine.companyId, siteId: machine.siteId }
    let planNextDueOn: BusinessDate | null = null
    if (plan && moves) {
      planNextDueOn = nextDueAfter({ interval: plan.interval, intervalUnit: plan.intervalUnit as CheckIntervalUnit, firstDueOn: dayOf(plan.firstDueOn) }, { performedOn: body.performedOn, nextDueOn: body.nextDueOn ?? null })
      const before = dayOf(plan.nextDueOn)
      await tx.machineCheckPlan.update({ where: { id: plan.id }, data: { nextDueOn: dateOf(planNextDueOn), lastRemindedAt: null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'plant.moveCheckPlan', recordType: 'MachineCheckPlan', recordId: plan.id, ...scope, before: { nextDueOn: before }, after: { nextDueOn: planNextDueOn, byResultId: id } })
      tools.emit({
        type: 'machine_check_plan.changed',
        subject: plan.id,
        ...scope,
        payload: { planId: plan.id, machineId: machine.id, assetNumber: machine.assetNumber, checkTypeId: type.id, change: 'MOVED', nextDueOn: planNextDueOn, interval: plan.interval, intervalUnit: plan.intervalUnit as CheckIntervalUnit, replacedPlanId: null, fields: ['nextDueOn'] },
      })
    }
    const made = await jobAndLockInCommand(tools, context, machine, { id, outcome: body.outcome, performedOn: body.performedOn, remarks, typeLabel: type.labelEn }, { job: body.job, lock: body.lock })
    tools.audit({
      action: 'plant.recordCheckResult',
      recordType: 'MachineCheckResult',
      recordId: id,
      ...scope,
      after: { machineId: machine.id, checkTypeId: type.id, planId: plan?.id ?? null, performedOn: body.performedOn, outcome: body.outcome, remarks, performedBy: body.performedBy.trim(), outsideBodyPartyId, nextDueOn: body.nextDueOn ?? null, keptUntil, correctsId: corrected?.id ?? null, planNextDueOn, jobId: made.jobId, lockRequestId: made.lockRequestId },
      ...(corrected ? { reason: body.correctionReason!.trim() } : {}),
    })
    recordedEvent(tools, { id, ...scope, machineId: machine.id, checkTypeId: type.id, planId: plan?.id ?? null, performedOn: body.performedOn, outcome: body.outcome, correctsId: corrected?.id ?? null }, machine.assetNumber, planNextDueOn, made)
    return stepAnswer(tx, context, id, made, now)
  })
  return { ...result, replayed }
}

/** A result the caller may see, else 404. */
async function knownResult(caller: CommandCaller, context: OfficeContext, resultId: string): Promise<ResultRow> {
  const row = isUuid(resultId) ? await caller.withClient((client) => readResult(client, resultId)) : null
  if (!row) throw new NotFoundError('Check result not found.')
  assertMay(context, PLANT_VIEW, row, 'Check result')
  return row
}

/** POST /plant/checks/results/:resultId/job and …/lock: the job or the lock of a result afterwards, in ONE command each. */
export async function actOnResult(caller: CommandCaller, resultId: string, act: 'job' | 'lock', body: JobAsk & LockAsk, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownResult(caller, context, resultId)
  const outcome = known.outcome as CheckOutcome
  if (act === 'job' && !takesJob(outcome)) refuse(noJobForPassed())
  if (act === 'lock' && !takesLock(outcome)) refuse(lockNeedsFailed())
  assertParts(context, known, { record: false, job: act === 'job', lock: act === 'lock' })
  const { result, replayed } = await command(caller, { name: act === 'job' ? 'plant.makeJobOfCheck' : 'plant.lockFromCheck', idempotencyKey, input: { resultId, act, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    if (machine.status === 'RETIRED') refuse(machineRetired(machine.assetNumber))
    const asks = act === 'job' ? { job: { type: body.type, priority: body.priority, problem: body.problem, assigneeId: body.assigneeId, assigneeWorkerId: body.assigneeWorkerId, dueAt: body.dueAt, plan: body.plan } } : { lock: { note: body.note } }
    const made = await jobAndLockInCommand(tools, context, machine, { id: known.id, outcome, performedOn: dayOf(known.performedOn), remarks: known.remarks, typeLabel: known.checkType.labelEn }, asks)
    tools.audit({ action: act === 'job' ? 'plant.makeJobOfCheck' : 'plant.lockFromCheck', recordType: 'MachineCheckResult', recordId: known.id, companyId: known.companyId, siteId: known.siteId, after: { jobId: made.jobId, lockRequestId: made.lockRequestId } })
    return stepAnswer(tx, context, known.id, made, now)
  })
  return { ...result, replayed }
}

/** GET /plant/checks/results/:resultId. */
export async function resultRecord(caller: CommandCaller, resultId: string) {
  const context = officeOf(caller)
  const known = await knownResult(caller, context, resultId)
  const now = new Date()
  return caller.withClient(async (client) => {
    const [result] = await resultViews(client, [known])
    const plan = known.planId ? (await planViews(client, [(await readPlan(client, known.planId))!], now))[0]! : null
    // The corrections around it: what it corrects, down the chain, and what corrects it, up the chain (newest first).
    const chain: Prisma.MachineCheckResultWhereInput = { machineId: known.machineId, checkTypeId: known.checkTypeId, OR: [{ correctsId: { not: null } }, { correctedBy: { some: {} } }] }
    const related = await client.machineCheckResult.findMany({ where: chain, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: CHECK_LIMITS.page, select: { id: true, correctsId: true } })
    const links = new Map(related.map((row) => [row.id, row.correctsId]))
    const ids = new Set<string>([known.id])
    for (let next = known.correctsId; next && !ids.has(next); next = links.get(next) ?? null) ids.add(next)
    for (let changed = true; changed; ) {
      changed = false
      for (const [id, corrects] of links) if (corrects && ids.has(corrects) && !ids.has(id)) (ids.add(id), (changed = true))
    }
    ids.delete(known.id)
    const corrections = ids.size > 0 ? await client.machineCheckResult.findMany({ where: { id: { in: [...ids] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: RESULT_COLUMNS }) : []
    const machine = (await readMachine(client, context, known.machineId))!
    const locked = (await locksOf(client, [known.machineId])).has(known.machineId)
    const openJob = known.jobs.some((job) => (OPEN_JOB_STATUSES as readonly string[]).includes(job.status))
    const outcome = known.outcome as CheckOutcome
    const usable = machine.status !== 'RETIRED'
    return {
      result: result!,
      plan,
      corrections: await resultViews(client, corrections),
      machine: { id: machine.id, assetNumber: machine.assetNumber, status: machine.status, locked },
      canCorrect: result!.inForce && usable && may(context, PLANT_CHECKS_MANAGE, known),
      canMakeJob: usable && takesJob(outcome) && !openJob && may(context, PLANT_JOBS_MANAGE, known),
      canLock: usable && takesLock(outcome) && !locked && may(context, PLANT_REPORT, known),
      canAddReport: may(context, PLANT_CHECKS_MANAGE, known),
    }
  })
}
