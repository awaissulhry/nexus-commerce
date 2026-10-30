import type { Prisma, RequestCloseReason } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PLANT_REPORT, PLANT_REQUESTS_TRIAGE, PLANT_SIGN_SAFE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import {
  defaultJobType,
  defaultPriority,
  floorReporter,
  isOpenRequest,
  isUnsafeReport,
  joinJobRefusal,
  mergeTargetRefusal,
  minutesSince,
  normalAssetNumber,
  OPEN_JOB_STATUSES,
  OPEN_REQUEST_STATUSES,
  problemOf,
  reportedAtOf,
  reportRefusal,
  signSafeRefusal,
  STARTED_JOB_STATUSES,
  statusAfterReport,
  statusAfterSignSafe,
  triageRefusal,
  unsafeReason,
  WAITING_MINUTES,
  type CloseReason,
  type JobStatus,
  type JobType,
  type MachineStatus,
  type Priority,
  type RequestMove,
  type RequestStatus,
  type RequestTile,
  type SafeAfter,
} from '@nexus/factory-domain/plant/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { hasAcknowledgedNotice, scanSubjectFor } from '../../production/settings/subject'
import { assertMay, assertMayWrite, assertVersion, bodyIssue, byOf, contextOf, may, officeOf, refused, scopeOf, type PlantContext } from '../access'
import { stationWordsAt } from '../checks'
import { checkAssignee, makeJobInCommand } from '../making'
import {
  jobViews,
  lockJob,
  lockMachine,
  lockRequest,
  locksOf,
  machineCard,
  machineViews,
  moveMachine,
  readJob,
  readMachine,
  readRequest,
  REQUEST_COLUMNS,
  requestViews,
  type MachineRow,
  type RequestRow,
} from '../store'

/**
 * Machine requests (B-W2a-35; QHS-178; Owner answer H1; design plant.requests SCR-148, floor.machine SCR-179):
 *
 *   POST /plant/requests                     a report, from the station (floor, plant.report at its own site) or the office:
 *                                            the machine (its id or its scanned tag), the symptom (for its class or every
 *                                            class), words, down or not, unsafe or not. In ONE command, the machine row
 *                                            locked first: the request (the floor names the worker where the site records
 *                                            workers and they acknowledged the notice, else the station), and the machine
 *                                            DOWN (it stopped) or DO_NOT_USE at once (unsafe: H1). A queued report keeps the
 *                                            tablet's time when plausible; its Idempotency-Key makes a resend answer once.
 *   GET  /plant/requests[/counts]            the office's queue: unsafe first, then the oldest; the tiles
 *   GET  /plant/requests/:requestId          the record: the request, the machine card, the possible duplicates, photos
 *   POST /plant/requests/:id/acknowledge     triage (plant.requests.triage): seen by maintenance
 *   POST /plant/requests/:id/job             a new job (its number from the company's series), or the open job named
 *   POST /plant/requests/:id/merge           into another open request of the machine (a duplicate)
 *   POST /plant/requests/:id/close           without a job, with the reason; a DOWN machine runs again when nothing else
 *                                            open holds it (or `keepDown`)
 *   POST /plant/requests/:id/sign-safe       a technician (plant.signSafe; the office's fresh code, the floor's PIN) signs an
 *                                            unsafe request safe with what was checked; when no lock is left the machine
 *                                            runs again (or is under maintenance while its job is started)
 *
 * An unsafe request not signed safe is neither merged nor closed; its machine stays DO_NOT_USE (the database holds it at
 * commit too). Nobody is named in a list but office users; a worker's name only inside one record, in the office.
 */

const localTime = (at: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(at)

async function machineAnswer(tx: CommandTx, context: PlantContext, machineId: string) {
  const [view] = await machineViews(tx, [(await readMachine(tx, context, machineId))!], context)
  return view!
}

// ---- report ---------------------------------------------------------------------------------------------------------------

export interface ReportBody {
  readonly machineId?: string | undefined
  readonly assetNumber?: string | undefined
  readonly symptomId?: string | undefined
  readonly description?: string | undefined
  readonly unsafe?: boolean | undefined
  readonly down: boolean
  readonly occurredAt?: string | undefined
}

/** POST /plant/requests. */
export async function report(caller: CommandCaller, body: ReportBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (!body.machineId && !body.assetNumber) throw bodyIssue('machineId', 'Name the machine: scan its tag or pick it.')
  const found = await caller.withClient(async (client) => {
    if (body.machineId) return readMachine(client, context, body.machineId)
    const row = await client.machine.findFirst({ where: { assetNumber: normalAssetNumber(body.assetNumber!) }, select: { id: true } })
    return row ? readMachine(client, context, row.id) : null
  })
  if (!found || !may(context, PLANT_REPORT, found)) throw new NotFoundError(context.audience === 'floor' ? 'No machine with this tag at this site.' : 'Machine not found.')
  if (body.machineId && body.assetNumber && normalAssetNumber(body.assetNumber) !== found.assetNumber) throw bodyIssue('assetNumber', 'The tag scanned is of another machine than the one named.')
  const deviceStationId = context.audience === 'floor' ? ((await caller.withClient((client) => client.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true } })))?.stationId ?? null) : null
  const description = body.description?.trim() || null

  const { result, replayed } = await command(caller, { name: 'plant.report', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, found.id))!
    const symptom = body.symptomId ? await tx.machineSymptom.findUnique({ where: { id: body.symptomId }, select: { id: true, code: true, classId: true, active: true, unsafe: true, needsDetail: true, labelEn: true } }) : null
    if (body.symptomId && !symptom) throw bodyIssue('symptomId', 'Not a symptom of the group.')
    const refusal = reportRefusal({ machine: { assetNumber: machine.assetNumber, status: machine.status as MachineStatus, classId: machine.classId }, symptom, description })
    if (refusal) refused(refusal)
    const unsafe = isUnsafeReport({ symptomUnsafe: symptom?.unsafe ?? false, markedUnsafe: body.unsafe ?? false })

    // Who reported it: an office user; on the floor the worker (where the site records workers) or the station.
    let reporter: { reportedById: string | null; reportedByWorkerId: string | null; stationId: string | null }
    if (context.audience === 'office') reporter = { reportedById: context.actorId, reportedByWorkerId: null, stationId: null }
    else {
      const scanSubject = await scanSubjectFor(tx, machine.siteId)
      const acknowledged = scanSubject === 'WORKER' ? await hasAcknowledgedNotice(tx, machine.siteId, context.actorId) : false
      const subject = floorReporter({ scanSubject, workerId: context.actorId, workerAcknowledged: acknowledged, deviceStationId, machineStationId: machine.stationId })
      if (!subject.ok) refused(subject.refusal)
      reporter = { reportedById: null, reportedByWorkerId: subject.ok ? subject.reportedByWorkerId : null, stationId: subject.ok ? subject.stationId : null }
    }

    const id = newId()
    const reportedAt = reportedAtOf(body.occurredAt ? new Date(body.occurredAt) : null, now)
    const data: Prisma.MaintenanceRequestUncheckedCreateInput = {
      id,
      companyId: machine.companyId,
      siteId: machine.siteId,
      machineId: machine.id,
      symptomId: symptom?.id ?? null,
      description,
      unsafe,
      reportedAt,
      ...reporter,
      deviceId: context.audience === 'floor' ? context.deviceId : null,
      createdAt: now,
      updatedAt: now,
      createdById: context.audience === 'office' ? context.actorId : null,
    }
    await tx.maintenanceRequest.create({ data, select: { id: true } })
    const scope = { companyId: machine.companyId, siteId: machine.siteId }
    tools.audit({
      action: 'plant.report',
      recordType: 'MaintenanceRequest',
      recordId: id,
      ...scope,
      after: { machineId: machine.id, symptomId: data.symptomId, description, unsafe, down: body.down, reportedAt: reportedAt.toISOString(), reportedById: reporter.reportedById, reportedByWorkerId: reporter.reportedByWorkerId, stationId: reporter.stationId, deviceId: data.deviceId },
    })
    const to = statusAfterReport({ status: machine.status as MachineStatus, unsafe, down: body.down })
    if (to) {
      const words = symptom?.labelEn ?? description
      await moveMachine(tools, machine, to, {
        reason: to === 'DO_NOT_USE' ? unsafeReason(words, localTime(reportedAt)) : `Down: ${words ?? 'a problem was reported'} (reported ${localTime(reportedAt)}).`.slice(0, 500),
        cause: 'REPORT',
        recordType: 'MaintenanceRequest',
        recordId: id,
        by: byOf(context),
      })
    }
    const openOnMachine = await tx.maintenanceRequest.count({ where: { machineId: machine.id, status: { in: [...OPEN_REQUEST_STATUSES] }, id: { not: id } } })
    tools.emit({
      type: 'maintenance_request.reported',
      subject: id,
      ...scope,
      payload: { requestId: id, machineId: machine.id, assetNumber: machine.assetNumber, symptomId: symptom?.id ?? null, symptomCode: symptom?.code ?? null, unsafe, down: body.down, stationId: reporter.stationId, openOnMachine, by: byOf(context) },
    })
    const [request] = await requestViews(tx, [(await readRequest(tx, id))!], context, now)
    return { request: request!, machine: await machineAnswer(tx, context, machine.id), words: await stationWordsAt(tx, reporter.stationId ?? machine.stationId, machine.id) }
  })
  return { ...result, replayed }
}

// ---- triage ---------------------------------------------------------------------------------------------------------------

interface TriageInput {
  readonly version: number
}

/** The request for a triage or a sign-safe, read before the command: seen (plant.view, or a floor technician's), else 404. */
async function knownRequest(caller: CommandCaller, context: PlantContext, requestId: string, write: typeof PLANT_REQUESTS_TRIAGE | typeof PLANT_SIGN_SAFE): Promise<RequestRow> {
  const known = isUuid(requestId) ? await caller.withClient((client) => readRequest(client, requestId)) : null
  if (!known) throw new NotFoundError('Request not found.')
  assertMay(context, context.audience === 'floor' ? write : PLANT_VIEW, known, 'Request')
  assertMayWrite(context, write, known, write === PLANT_SIGN_SAFE ? 'Only a technician signs a machine safe again (Owner answer H1).' : 'Machine requests are triaged by a role that does it (plant.requests.triage).')
  return known
}

const triageAction = { acknowledge: 'ACKNOWLEDGED', job: 'JOB_MADE', merge: 'MERGED', close: 'CLOSED' } as const

/** One triage move in ONE command: the machine row locked first, then the request, the version, the rules, the change. */
async function triage<Extra>(
  caller: CommandCaller,
  requestId: string,
  move: RequestMove,
  body: TriageInput,
  idempotencyKey: string | undefined,
  work: (tools: CommandTools, request: RequestRow, machine: MachineRow) => Promise<{ readonly data: Prisma.MaintenanceRequestUncheckedUpdateInput; readonly jobId?: string | null; readonly extra?: Extra }>,
) {
  const context = officeOf(caller)
  const known = await knownRequest(caller, context, requestId, PLANT_REQUESTS_TRIAGE)
  const name: `plant.${string}` = move === 'job' ? 'plant.makeJobOfRequest' : `plant.${move}Request`
  const { result, replayed } = await command(caller, { name, idempotencyKey, input: { requestId, move, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const request = (await lockRequest(tx, requestId))!
    assertVersion('request', request.version, body.version)
    const refusal = triageRefusal({ request: { status: request.status as RequestStatus, unsafe: request.unsafe, signedSafe: request.signedSafeAt !== null }, assetNumber: machine.assetNumber }, move)
    if (refusal) refused(refusal)
    const done = await work(tools, request, machine)
    await tx.maintenanceRequest.update({ where: { id: request.id }, data: { ...done.data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readRequest(tx, request.id))!
    const scope = { companyId: request.companyId, siteId: request.siteId }
    tools.audit({
      action: name,
      recordType: 'MaintenanceRequest',
      recordId: request.id,
      ...scope,
      before: { status: request.status },
      after: { status: after.status, jobId: after.jobId, mergedIntoId: after.mergedIntoId, closeReason: after.closeReason, closeNote: after.closeNote },
    })
    tools.emit({
      type: 'maintenance_request.triaged',
      subject: request.id,
      ...scope,
      payload: { requestId: request.id, machineId: request.machineId, assetNumber: machine.assetNumber, action: triageAction[move], status: after.status as RequestStatus, jobId: after.jobId, mergedIntoId: after.mergedIntoId, closeReason: (after.closeReason as CloseReason | null) ?? null },
    })
    const [view] = await requestViews(tx, [after], context, now, { record: true })
    const job = after.jobId ? (await jobViews(tx, [(await readJob(tx, after.jobId))!], context, now))[0]! : null
    return { request: view!, machine: await machineAnswer(tx, context, machine.id), job }
  })
  return { ...result, replayed }
}

/** NEW → seen: when and by whom (set once). */
const acknowledged = (request: RequestRow, context: PlantContext, now: Date): Prisma.MaintenanceRequestUncheckedUpdateInput =>
  request.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedById: context.audience === 'office' ? context.actorId : null }

/** POST /plant/requests/:requestId/acknowledge. */
export async function acknowledgeRequest(caller: CommandCaller, requestId: string, body: TriageInput, idempotencyKey?: string) {
  const context = officeOf(caller)
  return triage(caller, requestId, 'acknowledge', body, idempotencyKey, async (tools, request) => ({ data: { status: 'ACKNOWLEDGED', ...acknowledged(request, context, tools.now) } }))
}

export interface MakeJobBody extends TriageInput {
  readonly jobId?: string | undefined
  readonly type?: JobType | undefined
  readonly problem?: string | undefined
  readonly priority?: Priority | undefined
  readonly assigneeId?: string | null | undefined
  readonly assigneeWorkerId?: string | null | undefined
  readonly dueAt?: string | null | undefined
  readonly plan?: boolean | undefined
}

/** POST /plant/requests/:requestId/job: a new job (prefilled from the request), or the open job of the machine named. */
export async function makeJobOfRequest(caller: CommandCaller, requestId: string, body: MakeJobBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const outcome = await triage(caller, requestId, 'job', body, idempotencyKey, async (tools, request, machine) => {
    const { tx, now } = tools
    let jobId: string
    if (body.jobId) {
      const job = await lockJob(tx, body.jobId)
      if (!job) throw bodyIssue('jobId', 'Not a maintenance job of the group.')
      const refusal = joinJobRefusal({ machineId: request.machineId, job: { machineId: job.machineId, status: job.status as JobStatus, number: job.number } })
      if (refusal) refused(refusal)
      jobId = job.id
    } else {
      const assignee = await checkAssignee(tx, context.tenantId, machine, body, now)
      const made = await makeJobInCommand(tools, {
        machine,
        type: body.type ?? defaultJobType(request.unsafe),
        source: 'REQUEST',
        problem: body.problem ?? problemOf(request.symptom?.labelEn ?? null, request.description),
        symptomId: request.symptomId,
        priority: body.priority ?? defaultPriority({ unsafe: request.unsafe && request.signedSafeAt === null, down: machine.status === 'DOWN' }),
        assignee,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        plan: body.plan ?? false,
        requestIds: [request.id],
        createdById: context.actorId,
      })
      jobId = made.id
    }
    return { data: { status: 'JOB_MADE', jobId, ...acknowledged(request, context, now) } }
  })
  return outcome
}

/** POST /plant/requests/:requestId/merge. */
export async function mergeRequest(caller: CommandCaller, requestId: string, body: TriageInput & { readonly intoId: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  return triage(caller, requestId, 'merge', body, idempotencyKey, async (tools, request) => {
    const target = await lockRequest(tools.tx, body.intoId)
    if (!target) throw bodyIssue('intoId', 'Not a request of the group.')
    const refusal = mergeTargetRefusal({ requestId: request.id, machineId: request.machineId, target: { id: target.id, machineId: target.machineId, status: target.status as RequestStatus } })
    if (refusal) refused(refusal)
    return { data: { status: 'MERGED', mergedIntoId: target.id, closedAt: tools.now, closedById: context.actorId, ...acknowledged(request, context, tools.now) } }
  })
}

/** POST /plant/requests/:requestId/close. */
export async function closeRequest(caller: CommandCaller, requestId: string, body: TriageInput & { readonly reason: CloseReason; readonly note?: string | undefined; readonly keepDown?: boolean | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (body.reason === 'OTHER' && !body.note?.trim()) throw bodyIssue('note', 'Say why the request closes without a job.')
  return triage(caller, requestId, 'close', body, idempotencyKey, async (tools, request, machine) => {
    const { tx, now } = tools
    // A DOWN machine runs again when nothing else open holds it: no other open request, no open job.
    if (machine.status === 'DOWN' && !body.keepDown) {
      const others = await tx.maintenanceRequest.count({ where: { machineId: machine.id, status: { in: [...OPEN_REQUEST_STATUSES] }, id: { not: request.id } } })
      const jobs = await tx.maintenanceJob.count({ where: { machineId: machine.id, status: { in: [...OPEN_JOB_STATUSES] } } })
      if (others === 0 && jobs === 0) await moveMachine(tools, machine, 'RUNNING', { reason: null, cause: 'TRIAGE', recordType: 'MaintenanceRequest', recordId: request.id, by: 'OFFICE' })
    }
    return { data: { status: 'CLOSED', closeReason: body.reason as RequestCloseReason, closeNote: body.note?.trim() || null, closedAt: now, closedById: context.actorId } }
  })
}

// ---- sign safe (H1) ---------------------------------------------------------------------------------------------------------

/**
 * POST /plant/requests/:requestId/sign-safe: the request's sign-safe (when, the technician, what was checked: all at once,
 * once), then — when no unsafe request of the machine is left — the machine out of DO_NOT_USE. `stepUp` is the signing
 * act's check (the office's fresh code, the floor's PIN), asked after every other check.
 */
export async function signSafe(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly note: string; readonly machineAfter?: SafeAfter | undefined }, stepUp: () => void | Promise<void>, idempotencyKey?: string) {
  const context = contextOf(caller)
  const known = await knownRequest(caller, context, requestId, PLANT_SIGN_SAFE)
  const early = signSafeRefusal({ unsafe: known.unsafe, signedSafe: known.signedSafeAt !== null })
  if (early) refused(early)
  await stepUp()
  const { result, replayed } = await command(caller, { name: 'plant.signSafe', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const request = (await lockRequest(tx, requestId))!
    assertVersion('request', request.version, body.version)
    const refusal = signSafeRefusal({ unsafe: request.unsafe, signedSafe: request.signedSafeAt !== null })
    if (refusal) refused(refusal)
    const signer = context.audience === 'floor' ? { signedSafeById: null, signedSafeByWorkerId: context.actorId } : { signedSafeById: context.actorId, signedSafeByWorkerId: null }
    await tx.maintenanceRequest.update({ where: { id: request.id }, data: { signedSafeAt: now, ...signer, signedSafeNote: body.note.trim(), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const stillLocked = (await locksOf(tx, [machine.id])).has(machine.id)
    let machineStatus = machine.status as MachineStatus
    if (!stillLocked && machine.status === 'DO_NOT_USE') {
      const started = await tx.maintenanceJob.count({ where: { machineId: machine.id, status: { in: [...STARTED_JOB_STATUSES] } } })
      machineStatus = await moveMachine(tools, machine, statusAfterSignSafe({ asked: body.machineAfter, startedJob: started > 0 }), { reason: null, cause: 'SIGN_SAFE', recordType: 'MaintenanceRequest', recordId: request.id, by: byOf(context) })
    }
    const scope = { companyId: request.companyId, siteId: request.siteId }
    tools.audit({ action: 'plant.signSafe', recordType: 'MaintenanceRequest', recordId: request.id, ...scope, after: { signedSafeAt: now.toISOString(), ...signer, signedSafeNote: body.note.trim(), machineStatus, stillLocked } })
    tools.emit({ type: 'maintenance_request.signed_safe', subject: request.id, ...scope, payload: { requestId: request.id, machineId: machine.id, assetNumber: machine.assetNumber, machineStatus, stillLocked, by: byOf(context) } })
    const [view] = await requestViews(tx, [(await readRequest(tx, request.id))!], context, now, { record: true })
    return { request: view!, machine: await machineAnswer(tx, context, machine.id) }
  })
  return { ...result, replayed }
}

// ---- reads ---------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly status?: readonly RequestStatus[] | undefined
  readonly open?: boolean | undefined
  readonly unsafe?: boolean | undefined
  readonly tile?: RequestTile | undefined
  readonly machineId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** The most rows the queue order reads (unsafe first, then the oldest): the open requests of a plant are few. */
const QUEUE_MAX = 500

/** Machines with two or more open requests (possible duplicates), in the caller's scope. */
async function duplicateMachines(client: Pick<CommandTx, 'maintenanceRequest'>, where: Prisma.MaintenanceRequestWhereInput): Promise<string[]> {
  const rows = await client.maintenanceRequest.groupBy({ by: ['machineId'], where: { AND: [where, { status: { in: [...OPEN_REQUEST_STATUSES] } }] }, _count: { _all: true } })
  return rows.filter((row) => row._count._all >= 2).map((row) => row.machineId)
}

/** GET /plant/requests. */
export async function listRequests(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const now = new Date()
  const base: Prisma.MaintenanceRequestWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MaintenanceRequestWhereInput, query.siteId ? { siteId: query.siteId } : {}, query.machineId ? { machineId: query.machineId } : {}] }
  return caller.withClient(async (client) => {
    const tileWhere = async (tile: RequestTile): Promise<Prisma.MaintenanceRequestWhereInput> => {
      switch (tile) {
        case 'NEW':
          return { status: 'NEW' }
        case 'UNSAFE':
          return { unsafe: true, signedSafeAt: null }
        case 'DOWN':
          return { status: { in: [...OPEN_REQUEST_STATUSES] }, machine: { status: 'DOWN' } }
        case 'WAITING':
          return { status: { in: [...OPEN_REQUEST_STATUSES] }, reportedAt: { lt: new Date(now.getTime() - WAITING_MINUTES * 60_000) } }
        case 'DUPLICATES':
          return { status: { in: [...OPEN_REQUEST_STATUSES] }, machineId: { in: await duplicateMachines(client, base) } }
      }
    }
    const filters: Prisma.MaintenanceRequestWhereInput[] = [base]
    if (query.tile) filters.push(await tileWhere(query.tile))
    if (query.open) filters.push({ status: { in: [...OPEN_REQUEST_STATUSES] } })
    if (query.status && query.status.length > 0) filters.push({ status: { in: [...query.status] } })
    if (query.unsafe !== undefined) filters.push({ unsafe: query.unsafe })
    const where: Prisma.MaintenanceRequestWhereInput = { AND: filters }
    if (query.open || query.tile) {
      // The triage queue: the requests that lock a machine first, then the oldest.
      const rows = await client.maintenanceRequest.findMany({ where, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], take: QUEUE_MAX + 1, select: REQUEST_COLUMNS })
      const sorted = rows.slice(0, QUEUE_MAX).sort((a, b) => Number(b.unsafe && b.signedSafeAt === null) - Number(a.unsafe && a.signedSafeAt === null))
      const page = sorted.slice(0, query.limit)
      return { requests: await requestViews(client, page, context, now), nextCursor: null, truncated: rows.length > query.limit }
    }
    const rows = await client.maintenanceRequest.findMany({ where: { AND: [where, query.cursor ? { id: { lt: query.cursor } } : {}] }, orderBy: { id: 'desc' }, take: query.limit + 1, select: REQUEST_COLUMNS })
    const page = rows.slice(0, query.limit)
    return { requests: await requestViews(client, page, context, now), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null, truncated: false }
  })
}

/** GET /plant/requests/counts: the queue's tiles now. */
export async function requestCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = new Date()
  const base: Prisma.MaintenanceRequestWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MaintenanceRequestWhereInput, query.siteId ? { siteId: query.siteId } : {}] }
  const machines: Prisma.MachineWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MachineWhereInput, query.siteId ? { siteId: query.siteId } : {}] }
  return caller.withClient(async (client) => {
    const fresh = await client.maintenanceRequest.aggregate({ where: { AND: [base, { status: 'NEW' }] }, _count: { _all: true }, _min: { reportedAt: true } })
    const locked = await client.maintenanceRequest.findMany({ where: { AND: [base, { unsafe: true, signedSafeAt: null }] }, distinct: ['machineId'], select: { machineId: true } })
    const down = await client.machine.count({ where: { AND: [machines, { status: 'DOWN' }] } })
    const waiting = await client.maintenanceRequest.count({ where: { AND: [base, { status: { in: [...OPEN_REQUEST_STATUSES] }, reportedAt: { lt: new Date(now.getTime() - WAITING_MINUTES * 60_000) } }] } })
    const duplicates = await duplicateMachines(client, base)
    return {
      tiles: {
        NEW: { count: fresh._count._all, oldestMinutes: fresh._min.reportedAt ? minutesSince(fresh._min.reportedAt, now) : null },
        UNSAFE: locked.length,
        DOWN: down,
        WAITING: waiting,
        DUPLICATES: duplicates.length,
      },
    }
  })
}

/** GET /plant/requests/:requestId. */
export async function requestRecord(caller: CommandCaller, requestId: string) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const row = isUuid(requestId) ? await readRequest(client, requestId) : null
    if (!row) throw new NotFoundError('Request not found.')
    assertMay(context, PLANT_VIEW, row, 'Request')
    const [request] = await requestViews(client, [row], context, now, { record: true })
    const others = await client.maintenanceRequest.findMany({ where: { machineId: row.machineId, status: { in: [...OPEN_REQUEST_STATUSES] }, id: { not: row.id } }, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], select: REQUEST_COLUMNS })
    const photos = await client.storedFile.findMany({ where: { recordType: 'MaintenanceRequest', recordId: row.id, status: 'AVAILABLE' }, orderBy: { createdAt: 'asc' }, select: { id: true, originalName: true, contentType: true } })
    return {
      request: request!,
      card: (await machineCard(client, context, row.machineId, now, { lastJobs: 5 }))!,
      duplicates: await requestViews(client, others, context, now),
      photos,
      canTriage: isOpenRequest(row.status) && may(context, PLANT_REQUESTS_TRIAGE, row),
      canSignSafe: row.unsafe && row.signedSafeAt === null && may(context, PLANT_SIGN_SAFE, row),
    }
  })
}

/** The open requests of a machine (the floor's machine card and the office's). */
export async function openRequestsOf(client: Parameters<typeof requestViews>[0], context: PlantContext, machineId: string, now: Date) {
  const rows = await client.maintenanceRequest.findMany({ where: { machineId, status: { in: [...OPEN_REQUEST_STATUSES] } }, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], select: REQUEST_COLUMNS })
  return requestViews(client, rows, context, now)
}

