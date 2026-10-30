import type { MachineStatus as DbMachineStatus, MaintenanceJobType, MaintenancePriority, Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PLANT_JOBS_MANAGE, PLANT_JOBS_WORK, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import {
  handBackReason,
  isOpenJob,
  JOB_MOVE_RULES,
  jobMoveRefusal,
  OPEN_JOB_STATUSES,
  PRIORITIES,
  STARTED_JOB_STATUSES,
  statusAfterJobMove,
  weekStart,
  type JobMove,
  type JobSource,
  type JobStatus,
  type JobTile,
  type JobType,
  type MachineAfter,
  type MachineStatus,
  type Priority,
} from '@nexus/factory-domain/plant/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMay, assertMayWrite, assertVersion, bodyIssue, byOf, contextOf, may, officeOf, refused, scopeOf, type PlantContext } from '../access'
import { assignedEvent, checkAssignee, makeJobInCommand, type Assignee } from '../making'
import { JOB_COLUMNS, jobViews, lockJob, lockMachine, locksOf, machineCard, machineViews, moveMachine, ownershipOf, readJob, readMachine, REQUEST_COLUMNS, requestViews, type JobRow } from '../store'

/**
 * Maintenance jobs (B-W2a-35; QHS-184; design plant.jobs SCR-149, floor.machine "My jobs", "The job"):
 *
 *   GET   /plant/jobs[/counts]        the office's list (a site, statuses, a tile, a machine, mine), newest first; tiles
 *   GET   /plant/jobs/:jobId          the record (office: plant.view; floor: a technician's, plant.jobs.work at its site)
 *   POST  /plant/jobs                 a job by hand (plant.jobs.manage): its number from the company's MAINTENANCE_JOB series
 *   PATCH /plant/jobs/:jobId          problem, type, priority, due, the technician (any assignee field names the whole
 *                                     new assignee: an office user, a floor worker or nobody)
 *   POST  /plant/jobs/assign          one technician for several jobs (the design's bulk Assign), all or none
 *   POST  /plant/jobs/:jobId/{plan,close,cancel}            the office (plant.jobs.manage)
 *   POST  /plant/jobs/:jobId/{start,wait,hand-back,reopen}  the technician (plant.jobs.work; office or floor: on the floor
 *                                     only the jobs given to them or to nobody)
 *
 * Every write is one command(): the machine row locked first, then the job (one lock order), the version, the rules
 * (factory-domain plant/rules jobMoveRefusal), the change, the machine's status after (statusAfterJobMove), audit rows and
 * events. Handed back RUNNING only once the machine is signed safe (H1); the …_quality_plant_w2a_guards hold it too.
 */

const NEWEST: Prisma.MaintenanceJobOrderByWithRelationInput[] = [{ id: 'desc' }]

// ---- reads ---------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly status?: readonly JobStatus[] | undefined
  readonly open?: boolean | undefined
  readonly tile?: JobTile | undefined
  readonly machineId?: string | undefined
  readonly mine?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

async function tileWhere(client: Pick<CommandTools['tx'], 'maintenanceRequest'>, base: Prisma.MaintenanceJobWhereInput, tile: JobTile, now: Date): Promise<Prisma.MaintenanceJobWhereInput> {
  switch (tile) {
    case 'OPEN':
      return { status: { in: [...OPEN_JOB_STATUSES] } }
    case 'OVERDUE':
      return { status: { in: OPEN_JOB_STATUSES.filter((status) => status !== 'HANDED_BACK') }, dueAt: { lt: now } }
    case 'UNSAFE': {
      const locked = await client.maintenanceRequest.findMany({ where: { unsafe: true, signedSafeAt: null }, distinct: ['machineId'], select: { machineId: true } })
      return { AND: [base, { status: { in: [...OPEN_JOB_STATUSES] } }, { machineId: { in: locked.map((row) => row.machineId) } }] }
    }
    case 'WAITING_PARTS':
      return { status: 'WAITING_PARTS' }
    case 'CLOSED_THIS_WEEK':
      return { status: 'CLOSED', closedAt: { gte: weekStart(now) } }
  }
}

/** GET /plant/jobs. */
export async function listJobs(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const now = new Date()
  const base: Prisma.MaintenanceJobWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MaintenanceJobWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.machineId ? { machineId: query.machineId } : {}] }
  return caller.withClient(async (client) => {
    const filters: Prisma.MaintenanceJobWhereInput[] = [base]
    if (query.tile) filters.push(await tileWhere(client, base, query.tile, now))
    if (query.open) filters.push({ status: { in: [...OPEN_JOB_STATUSES] } })
    if (query.status && query.status.length > 0) filters.push({ status: { in: [...query.status] } })
    // The caller's own jobs only (never another person's: no filter or group by person, Owner answer W1).
    if (query.mine) filters.push({ assigneeId: context.actorId })
    if (query.cursor) filters.push({ id: { lt: query.cursor } })
    const rows = await client.maintenanceJob.findMany({ where: { AND: filters }, orderBy: NEWEST, take: query.limit + 1, select: JOB_COLUMNS })
    const page = rows.slice(0, query.limit)
    return { jobs: await jobViews(client, page, context, now), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /plant/jobs/counts. */
export async function jobCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = new Date()
  const base: Prisma.MaintenanceJobWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MaintenanceJobWhereInput, query.siteId ? { siteId: query.siteId } : {}] }
  return caller.withClient(async (client) => {
    const count = async (tile: JobTile) => client.maintenanceJob.count({ where: { AND: [base, await tileWhere(client, base, tile, now)] } })
    return { tiles: { OPEN: await count('OPEN'), OVERDUE: await count('OVERDUE'), UNSAFE: await count('UNSAFE'), WAITING_PARTS: await count('WAITING_PARTS'), CLOSED_THIS_WEEK: await count('CLOSED_THIS_WEEK') } }
  })
}

/** A job the caller may see: the office with plant.view, the floor a technician of the site. 404 otherwise. */
function assertSees(context: PlantContext, job: { readonly companyId: string; readonly siteId: string }): void {
  assertMay(context, context.audience === 'floor' ? PLANT_JOBS_WORK : PLANT_VIEW, job, 'Job')
}

/** GET /plant/jobs/:jobId. */
export async function jobRecord(caller: CommandCaller, jobId: string) {
  const context = contextOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const row = isUuid(jobId) ? await readJob(client, jobId) : null
    if (!row) throw new NotFoundError('Job not found.')
    assertSees(context, row)
    const [job] = await jobViews(client, [row], context, now, { record: true })
    const requests = await client.maintenanceRequest.findMany({ where: { jobId: row.id }, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], select: REQUEST_COLUMNS })
    return {
      job: job!,
      card: (await machineCard(client, context, row.machineId, now, { lastJobs: context.audience === 'floor' ? 3 : 5 }))!,
      requests: await requestViews(client, requests, context, now, { record: true }),
      canManage: context.audience === 'office' && isOpenJob(row.status) && may(context, PLANT_JOBS_MANAGE, row),
      canWork: isOpenJob(row.status) && may(context, PLANT_JOBS_WORK, row) && (context.audience === 'office' || ownershipOf(row, context) !== 'OTHER'),
    }
  })
}

/** The floor's My jobs: the site's open jobs given to the signed-in technician or to nobody, P1 first, then the oldest. */
export async function floorJobs(caller: CommandCaller) {
  const context = contextOf(caller)
  if (context.audience !== 'floor') throw new NotFoundError('Not found.')
  const now = new Date()
  return caller.withClient(async (client) => {
    const rows = await client.maintenanceJob.findMany({
      where: { AND: [scopeOf(context, PLANT_JOBS_WORK) as Prisma.MaintenanceJobWhereInput, { status: { in: [...OPEN_JOB_STATUSES] } }, { OR: [{ assigneeWorkerId: context.actorId }, { assigneeId: null, assigneeWorkerId: null }] }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      select: JOB_COLUMNS,
    })
    const rank = (priority: string) => PRIORITIES.indexOf(priority as Priority)
    rows.sort((a, b) => rank(a.priority) - rank(b.priority))
    return { jobs: await jobViews(client, rows, context, now) }
  })
}

// ---- writes ----------------------------------------------------------------------------------------------------------------

async function machineAnswer(tx: CommandTools['tx'], context: PlantContext, machineId: string) {
  const [view] = await machineViews(tx, [(await readMachine(tx, context, machineId))!], context)
  return view!
}

const jobAnswer = async (tx: CommandTools['tx'], context: PlantContext, id: string, now: Date) => (await jobViews(tx, [(await readJob(tx, id))!], context, now, { record: true }))[0]!

export interface CreateBody {
  readonly machineId: string
  readonly type: JobType
  readonly problem: string
  readonly symptomId?: string | null | undefined
  readonly priority?: Priority | undefined
  readonly source?: Extract<JobSource, 'MANUAL' | 'STATUTORY_CHECK'> | undefined
  readonly assigneeId?: string | null | undefined
  readonly assigneeWorkerId?: string | null | undefined
  readonly dueAt?: string | null | undefined
  readonly plan?: boolean | undefined
}

/** POST /plant/jobs. */
export async function createJob(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient((client) => readMachine(client, context, body.machineId))
  if (!known) throw bodyIssue('machineId', 'Not a machine of the group.')
  assertMay(context, PLANT_VIEW, known, 'Machine')
  assertMayWrite(context, PLANT_JOBS_MANAGE, known, 'Maintenance jobs of this site are made by a role that plans them (plant.jobs.manage).')
  const { result, replayed } = await command(caller, { name: 'plant.createJob', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.id))!
    if (machine.status === 'RETIRED') throw new ConflictError(`Machine ${machine.assetNumber} is retired: it takes no more jobs.`)
    if (body.symptomId) {
      const symptom = await tx.machineSymptom.findUnique({ where: { id: body.symptomId }, select: { classId: true, active: true } })
      if (!symptom || !symptom.active) throw bodyIssue('symptomId', 'Not an active symptom of the group.')
      if (symptom.classId !== null && symptom.classId !== machine.classId) throw bodyIssue('symptomId', 'This symptom is for another kind of machine.')
    }
    const assignee = await checkAssignee(tx, context.tenantId, machine, body, now)
    const made = await makeJobInCommand(tools, {
      machine,
      type: body.type,
      source: body.source ?? 'MANUAL',
      problem: body.problem,
      symptomId: body.symptomId ?? null,
      priority: body.priority ?? 'P2',
      assignee,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      plan: body.plan ?? false,
      requestIds: [],
      createdById: context.actorId,
    })
    return { job: await jobAnswer(tx, context, made.id, now) }
  })
  return { ...result, replayed }
}

export interface UpdateBody {
  readonly version: number
  readonly type?: JobType | undefined
  readonly problem?: string | undefined
  readonly priority?: Priority | undefined
  readonly dueAt?: string | null | undefined
  readonly assigneeId?: string | null | undefined
  readonly assigneeWorkerId?: string | null | undefined
}

const namesAssignee = (body: { readonly assigneeId?: unknown; readonly assigneeWorkerId?: unknown }) => body.assigneeId !== undefined || body.assigneeWorkerId !== undefined
const sameAssignee = (job: Pick<JobRow, 'assigneeId' | 'assigneeWorkerId'>, next: Assignee) => job.assigneeId === next.assigneeId && job.assigneeWorkerId === next.assigneeWorkerId

async function knownJob(caller: CommandCaller, context: PlantContext, jobId: string): Promise<JobRow> {
  const known = isUuid(jobId) ? await caller.withClient((client) => readJob(client, jobId)) : null
  if (!known) throw new NotFoundError('Job not found.')
  assertSees(context, known)
  return known
}

/** PATCH /plant/jobs/:jobId. */
export async function updateJob(caller: CommandCaller, jobId: string, body: UpdateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownJob(caller, context, jobId)
  assertMayWrite(context, PLANT_JOBS_MANAGE, known, 'Maintenance jobs of this site are changed by a role that plans them (plant.jobs.manage).')
  const { result, replayed } = await command(caller, { name: 'plant.updateJob', idempotencyKey, input: { jobId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const job = (await lockJob(tx, jobId))!
    assertVersion('job', job.version, body.version)
    if (!isOpenJob(job.status)) throw new ConflictError(`Job ${job.number} is ${job.status === 'CLOSED' ? 'closed' : 'cancelled'}: it never changes.`)
    const data: Prisma.MaintenanceJobUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    const fields: string[] = []
    if (body.type !== undefined && body.type !== job.type) (data.type = body.type as MaintenanceJobType), fields.push('type')
    if (body.problem !== undefined && body.problem.trim() !== job.problem) (data.problem = body.problem.trim()), fields.push('problem')
    if (body.priority !== undefined && body.priority !== job.priority) (data.priority = body.priority as MaintenancePriority), fields.push('priority')
    if (body.dueAt !== undefined && (body.dueAt ? new Date(body.dueAt).getTime() : null) !== (job.dueAt?.getTime() ?? null)) (data.dueAt = body.dueAt ? new Date(body.dueAt) : null), fields.push('dueAt')
    let assignee: Assignee | null = null
    if (namesAssignee(body)) {
      const next = await checkAssignee(tx, context.tenantId, machine, body, now)
      if (!sameAssignee(job, next)) {
        assignee = next
        data.assigneeId = next.assigneeId
        data.assigneeWorkerId = next.assigneeWorkerId
      }
    }
    const scope = { companyId: job.companyId, siteId: job.siteId }
    if (fields.length === 0 && assignee === null) {
      tools.audit({ action: 'plant.updateJob', recordType: 'MaintenanceJob', recordId: job.id, ...scope, after: { unchanged: true } })
      return { job: await jobAnswer(tx, context, job.id, now) }
    }
    await tx.maintenanceJob.update({ where: { id: job.id }, data, select: { id: true } })
    tools.audit({
      action: 'plant.updateJob',
      recordType: 'MaintenanceJob',
      recordId: job.id,
      ...scope,
      before: { type: job.type, problem: job.problem, priority: job.priority, dueAt: job.dueAt?.toISOString() ?? null, assigneeId: job.assigneeId, assigneeWorkerId: job.assigneeWorkerId },
      after: { type: data.type ?? job.type, problem: data.problem ?? job.problem, priority: data.priority ?? job.priority, dueAt: fields.includes('dueAt') ? (body.dueAt ?? null) : (job.dueAt?.toISOString() ?? null), assigneeId: assignee ? assignee.assigneeId : job.assigneeId, assigneeWorkerId: assignee ? assignee.assigneeWorkerId : job.assigneeWorkerId },
    })
    if (fields.length > 0) tools.emit({ type: 'maintenance_job.changed', subject: job.id, ...scope, payload: { jobId: job.id, number: job.number, machineId: job.machineId, fields } })
    if (assignee) assignedEvent(tools, { id: job.id, number: job.number, machineId: job.machineId, ...scope }, assignee, context.actorId)
    return { job: await jobAnswer(tx, context, job.id, now) }
  })
  return { ...result, replayed }
}

/** POST /plant/jobs/assign: one technician for several jobs, in ONE command; any refusal refuses all (`body/jobs/<i>`). */
export async function assignJobs(caller: CommandCaller, body: { readonly jobs: readonly { readonly id: string; readonly version: number }[]; readonly assigneeId?: string | null | undefined; readonly assigneeWorkerId?: string | null | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const ids = body.jobs.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) throw bodyIssue('jobs', 'A job is named twice.')
  const known = await caller.withClient((client) => client.maintenanceJob.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, siteId: true, machineId: true } }))
  body.jobs.forEach((entry, index) => {
    const job = known.find((row) => row.id === entry.id)
    if (!job || !may(context, PLANT_VIEW, job)) throw new ValidationError('A job named is not there.', [{ path: `body/jobs/${index}`, message: 'Job not found.' }])
    if (!may(context, PLANT_JOBS_MANAGE, job)) throw new ValidationError('A job named is of a site you do not plan.', [{ path: `body/jobs/${index}`, message: 'Assigned only by a role that plans its jobs (plant.jobs.manage).' }])
  })
  const { result, replayed } = await command(caller, { name: 'plant.assignJobs', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One lock order for many: the machines by id, then the jobs by id.
    const machines = new Map<string, Awaited<ReturnType<typeof lockMachine>>>()
    for (const machineId of [...new Set(known.map((row) => row.machineId))].sort()) machines.set(machineId, await lockMachine(tx, context, machineId))
    const locked = new Map<string, JobRow>()
    for (const id of [...ids].sort()) locked.set(id, (await lockJob(tx, id))!)
    const answers: string[] = []
    for (const [index, entry] of body.jobs.entries()) {
      const job = locked.get(entry.id)!
      const at = (message: string) => new ValidationError(message, [{ path: `body/jobs/${index}`, message }])
      if (job.version !== entry.version) throw new ConflictError(`Job ${job.number} changed since you read it (version ${job.version}, not ${entry.version}): read it again.`)
      if (!isOpenJob(job.status)) throw at(`Job ${job.number} is ${job.status === 'CLOSED' ? 'closed' : 'cancelled'}.`)
      const next = await checkAssignee(tx, context.tenantId, machines.get(job.machineId)!, body, now)
      answers.push(job.id)
      if (sameAssignee(job, next)) continue
      await tx.maintenanceJob.update({ where: { id: job.id }, data: { assigneeId: next.assigneeId, assigneeWorkerId: next.assigneeWorkerId, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      const scope = { companyId: job.companyId, siteId: job.siteId }
      tools.audit({ action: 'plant.assignJobs', recordType: 'MaintenanceJob', recordId: job.id, ...scope, before: { assigneeId: job.assigneeId, assigneeWorkerId: job.assigneeWorkerId }, after: { ...next } })
      assignedEvent(tools, { id: job.id, number: job.number, machineId: job.machineId, ...scope }, next, context.actorId)
    }
    const rows: JobRow[] = []
    for (const id of answers) rows.push((await readJob(tx, id))!)
    return { jobs: await jobViews(tx, rows, context, now) }
  })
  return { ...result, replayed }
}

export interface MoveBody {
  readonly version: number
  readonly workDone?: string | undefined
  readonly machineAfter?: MachineAfter | undefined
  readonly reason?: string | undefined
}

/** POST /plant/jobs/:jobId/<move>: the office's (plan, close, cancel) and the technician's (start, wait, hand-back, reopen). */
export async function moveJob(caller: CommandCaller, jobId: string, move: JobMove, body: MoveBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const rule = JOB_MOVE_RULES[move]
  if (rule.by === 'office' && context.audience !== 'office') throw new NotFoundError('Not found.')
  const known = await knownJob(caller, context, jobId)
  const permission = rule.by === 'office' ? PLANT_JOBS_MANAGE : PLANT_JOBS_WORK
  assertMayWrite(context, permission, known, rule.by === 'office' ? 'Maintenance jobs of this site are planned, closed and cancelled by a role that plans them (plant.jobs.manage).' : 'Maintenance jobs are worked by a technician (plant.jobs.work).')
  const { result, replayed } = await command(caller, { name: `plant.${move}Job`, idempotencyKey, input: { jobId, move, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const job = (await lockJob(tx, jobId))!
    assertVersion('job', job.version, body.version)
    const locked = (await locksOf(tx, [machine.id])).has(machine.id)
    const refusal = jobMoveRefusal(
      { job: { number: job.number, status: job.status as JobStatus }, machine: { assetNumber: machine.assetNumber, status: machine.status as MachineStatus, locked }, floor: context.audience === 'floor', ownership: ownershipOf(job, context), machineAfter: body.machineAfter },
      move,
    )
    if (refusal) refused(refusal)
    const person = context.audience === 'floor' ? { handedBackById: null, handedBackByWorkerId: context.actorId } : { handedBackById: context.actorId, handedBackByWorkerId: null }
    const data: Prisma.MaintenanceJobUncheckedUpdateInput = { status: rule.to, version: { increment: 1 }, updatedAt: now }
    if (move === 'start') data.startedAt = job.startedAt ?? now
    if (move === 'handBack') Object.assign(data, { handedBackAt: now, ...person, workDone: body.workDone!.trim(), machineAfter: body.machineAfter! as DbMachineStatus })
    if (move === 'reopen') Object.assign(data, { handedBackAt: null, handedBackById: null, handedBackByWorkerId: null, workDone: null, machineAfter: null })
    if (move === 'close') Object.assign(data, { closedAt: now, closedById: context.actorId })
    if (move === 'cancel') Object.assign(data, { cancelledAt: now, cancelReason: body.reason!.trim() })
    await tx.maintenanceJob.update({ where: { id: job.id }, data, select: { id: true } })

    // The machine's status after the move.
    const machineAfter = move === 'handBack' ? body.machineAfter! : move === 'close' ? ((job.machineAfter as MachineAfter | null) ?? null) : null
    const otherStarted = move === 'cancel' ? await tx.maintenanceJob.count({ where: { machineId: machine.id, id: { not: job.id }, status: { in: [...STARTED_JOB_STATUSES] } } }) : 0
    const to = statusAfterJobMove({ move, status: machine.status as MachineStatus, machineAfter, floor: context.audience === 'floor', otherStartedJob: otherStarted > 0 })
    if (to) {
      const reason = to === 'DO_NOT_USE' ? handBackReason(job.number, machineAfter ?? 'DO_NOT_USE', body.workDone?.trim() ?? job.workDone ?? '') : to === 'RETIRED' ? `Retired: handed back as retired (job ${job.number}).` : to === 'DOWN' ? `Down: job ${job.number} was cancelled before the machine was handed back.` : null
      await moveMachine(tools, machine, to, { reason, cause: 'JOB', recordType: 'MaintenanceJob', recordId: job.id, by: byOf(context) })
    }
    const scope = { companyId: job.companyId, siteId: job.siteId }
    tools.audit({
      action: `plant.${move}Job`,
      recordType: 'MaintenanceJob',
      recordId: job.id,
      ...scope,
      before: { status: job.status },
      after: { status: rule.to, ...(move === 'handBack' ? { workDone: body.workDone!.trim(), machineAfter: body.machineAfter, ...person } : {}), ...(move === 'cancel' ? { cancelReason: body.reason!.trim() } : {}) },
    })
    tools.emit({ type: 'maintenance_job.moved', subject: job.id, ...scope, payload: { jobId: job.id, number: job.number, machineId: job.machineId, move, from: job.status as JobStatus, to: rule.to, machineAfter: move === 'handBack' ? body.machineAfter! : null, by: byOf(context) } })
    return { job: await jobAnswer(tx, context, job.id, now), machine: await machineAnswer(tx, context, machine.id) }
  })
  return { ...result, replayed }
}

