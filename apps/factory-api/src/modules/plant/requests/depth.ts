import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PLANT_JOBS_WORK, PLANT_REPORT, PLANT_REQUESTS_TRIAGE, PLANT_SIGN_SAFE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { lockDescription, lockedAlready } from '@nexus/factory-domain/plant/requests/lock'
import { duplicateGroups, groupWords, mergeNothing } from '@nexus/factory-domain/plant/requests/merge'
import { floorAcknowledgeRefusal, onTheWayRefusal, progressOf, worksAgainRefusal } from '@nexus/factory-domain/plant/requests/progress'
import { isOpenRequest, joinJobRefusal, mergeTargetRefusal, OPEN_JOB_STATUSES, OPEN_REQUEST_STATUSES, triageRefusal, type CloseReason, type JobStatus, type RequestStatus } from '@nexus/factory-domain/plant/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { hasAcknowledgedNotice, scanSubjectFor } from '../../production/settings/subject'
import { assertVersion, byOf, contextOf, may, officeOf, refused, scopeOf, type PlantContext } from '../access'
import { jobViews, lockJob, lockMachine, lockRequest, locksOf, machineViews, readJob, readMachine, readRequest, REQUEST_COLUMNS, requestViews, type RequestRow } from '../store'
import { reportInCommand } from './requests'

/**
 * Machine requests in depth (B-W2b-96; QHS-180, QHS-181, QHS-183; design floor.machine "Progress", plant.requests
 * "Unsafe machines", "Possible duplicates", pop-ups "Merge requests", "Lock as unsafe"):
 *
 *   step       acknowledge (a technician on the floor: NEW → ACKNOWLEDGED), on the way (a technician, office or floor; from
 *              NEW it acknowledges in the same step), works again (the reporter: the office user, or the station — the
 *              worker where the site names workers and they acknowledged the notice). ONE command each, the machine row
 *              locked first, then the request; the progress rules of factory-domain plant/requests/progress.
 *   lock       "Lock as unsafe" from a request: a NEW unsafe request of the machine reported by the office user (the
 *              report's own command: the machine DO_NOT_USE at once, maintenance_request.locked with the site's hazard
 *              report setting), and the open request it came from joins it (MERGED).
 *   merge      several requests of one machine into one request (MERGED) or into the machine's open job (JOB_MADE), all
 *              or none; every reporter keeps their request and follows the target.
 *   reads      the possible duplicates with a suggested target, the open locks (the queue's banner).
 */

export type ProgressMove = 'ACKNOWLEDGE' | 'ON_THE_WAY' | 'WORKS_AGAIN'

const STEP_PERMISSION = { ACKNOWLEDGE: PLANT_JOBS_WORK, ON_THE_WAY: PLANT_JOBS_WORK, WORKS_AGAIN: PLANT_REPORT } as const
const STEP_COMMAND = { ACKNOWLEDGE: 'plant.acknowledgeOnFloor', ON_THE_WAY: 'plant.onTheWay', WORKS_AGAIN: 'plant.confirmWorks' } as const
const STEP_WORDS = {
  ACKNOWLEDGE: 'Machine requests are acknowledged on the floor by a technician (plant.jobs.work).',
  ON_THE_WAY: 'A technician says they are on the way (plant.jobs.work).',
  WORKS_AGAIN: 'The person who reported a machine problem confirms it works again (plant.report).',
} as const

/** A request the caller may see for this step (else 404) and make it (else 403 in words). */
async function knownFor(caller: CommandCaller, context: PlantContext, requestId: string, permission: typeof PLANT_JOBS_WORK | typeof PLANT_REPORT | typeof PLANT_REQUESTS_TRIAGE): Promise<RequestRow> {
  const known = isUuid(requestId) ? await caller.withClient((client) => readRequest(client, requestId)) : null
  if (!known || (!may(context, permission, known) && (context.audience === 'floor' || !may(context, PLANT_VIEW, known)))) throw new NotFoundError('Request not found.')
  if (!may(context, permission, known)) throw new ForbiddenError(permission === PLANT_REQUESTS_TRIAGE ? 'Machine requests are merged by a role that triages them (plant.requests.triage).' : permission === PLANT_JOBS_WORK ? STEP_WORDS.ON_THE_WAY : STEP_WORDS.WORKS_AGAIN)
  return known
}

const progressFacts = (row: RequestRow) => ({
  status: row.status,
  acknowledgedAt: row.acknowledgedAt,
  onTheWayAt: row.onTheWayAt,
  confirmedWorksAt: row.confirmedWorksAt,
  closedAt: row.closedAt,
  job: row.job,
  unsafe: row.unsafe,
  signedSafeAt: row.signedSafeAt,
  target: row.mergedInto,
})

/** Who a floor confirmation names: the worker where the site names workers and they acknowledged the notice, else the station. */
async function floorConfirmer(tx: CommandTools['tx'], siteId: string, workerId: string): Promise<string | null> {
  const subject = await scanSubjectFor(tx, siteId)
  return subject === 'WORKER' && (await hasAcknowledgedNotice(tx, siteId, workerId)) ? workerId : null
}

/** One progress step of a request, in ONE command (POST …/acknowledge on the floor, …/on-the-way, …/works). */
export async function stepRequest(caller: CommandCaller, requestId: string, move: ProgressMove, body: { readonly version?: number | undefined }, idempotencyKey?: string) {
  const context = contextOf(caller)
  if (move === 'ACKNOWLEDGE' && context.audience !== 'floor') throw new NotFoundError('Not found.')
  const known = await knownFor(caller, context, requestId, STEP_PERMISSION[move])
  const name = STEP_COMMAND[move]
  const { result, replayed } = await command(caller, { name, idempotencyKey, input: { requestId, move, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const request = (await lockRequest(tx, requestId))!
    if (body.version !== undefined) assertVersion('request', request.version, body.version)
    const floor = context.audience === 'floor'
    const data: Prisma.MaintenanceRequestUncheckedUpdateInput = { version: { increment: 1 }, updatedAt: now }
    const acknowledges = request.status === 'NEW' && move !== 'WORKS_AGAIN'
    if (move === 'ACKNOWLEDGE') {
      const refusal = floorAcknowledgeRefusal(request)
      if (refusal) refused(refusal)
    }
    if (move === 'ON_THE_WAY') {
      const refusal = onTheWayRefusal(request)
      if (refusal) refused(refusal)
      Object.assign(data, floor ? { onTheWayAt: now, onTheWayByWorkerId: context.actorId } : { onTheWayAt: now, onTheWayById: context.actorId })
    }
    if (acknowledges) Object.assign(data, { status: 'ACKNOWLEDGED', acknowledgedAt: now, ...(floor ? { acknowledgedByWorkerId: context.actorId } : { acknowledgedById: context.actorId }) })
    if (move === 'WORKS_AGAIN') {
      const refusal = worksAgainRefusal(progressOf(progressFacts(request)), machine.assetNumber)
      if (refusal) refused(refusal)
      const by = floor ? await floorConfirmer(tx, request.siteId, context.actorId) : null
      Object.assign(data, { confirmedWorksAt: now, ...(floor ? { confirmedWorksByWorkerId: by } : { confirmedWorksById: context.actorId }) })
    }
    await tx.maintenanceRequest.update({ where: { id: request.id }, data, select: { id: true } })
    const after = (await readRequest(tx, request.id))!
    const scope = { companyId: request.companyId, siteId: request.siteId }
    tools.audit({
      action: name,
      recordType: 'MaintenanceRequest',
      recordId: request.id,
      ...scope,
      before: { status: request.status, acknowledgedAt: request.acknowledgedAt?.toISOString() ?? null, onTheWayAt: request.onTheWayAt?.toISOString() ?? null, confirmedWorksAt: request.confirmedWorksAt?.toISOString() ?? null },
      after: { status: after.status, acknowledgedAt: after.acknowledgedAt?.toISOString() ?? null, acknowledgedByWorkerId: after.acknowledgedByWorkerId, onTheWayAt: after.onTheWayAt?.toISOString() ?? null, onTheWayById: after.onTheWayById, onTheWayByWorkerId: after.onTheWayByWorkerId, confirmedWorksAt: after.confirmedWorksAt?.toISOString() ?? null, confirmedWorksById: after.confirmedWorksById, confirmedWorksByWorkerId: after.confirmedWorksByWorkerId },
    })
    if (acknowledges) {
      tools.emit({ type: 'maintenance_request.triaged', subject: request.id, ...scope, payload: { requestId: request.id, machineId: request.machineId, assetNumber: machine.assetNumber, action: 'ACKNOWLEDGED', status: 'ACKNOWLEDGED', jobId: null, mergedIntoId: null, closeReason: null } })
    }
    if (move !== 'ACKNOWLEDGE') {
      tools.emit({ type: 'maintenance_request.progressed', subject: request.id, ...scope, payload: { requestId: request.id, machineId: request.machineId, assetNumber: machine.assetNumber, step: move === 'ON_THE_WAY' ? 'ON_THE_WAY' : 'WORKS_AGAIN', by: byOf(context) } })
    }
    const [view] = await requestViews(tx, [after], context, now, { record: true })
    const [machineView] = await machineViews(tx, [(await readMachine(tx, context, machine.id))!], context)
    return { request: view!, machine: machineView! }
  })
  return { ...result, replayed }
}

// ---- "Lock as unsafe" from a request (QHS-183) ---------------------------------------------------------------------------

/** POST /plant/requests/:requestId/lock (office; plant.report and the site's lock settings: H1, anyone who reports). */
export async function lockFromRequest(caller: CommandCaller, requestId: string, body: { readonly version: number; readonly note?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await knownFor(caller, context, requestId, PLANT_REPORT)
  const { result, replayed } = await command(caller, { name: 'plant.lockFromRequest', idempotencyKey, input: { requestId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const source = (await lockRequest(tx, requestId))!
    assertVersion('request', source.version, body.version)
    if ((await locksOf(tx, [machine.id])).has(machine.id)) refused(lockedAlready(machine.assetNumber))
    const words = source.symptom?.labelEn ?? source.description
    const made = await reportInCommand(tools, context, machine, {
      symptomId: source.symptom?.active ? source.symptomId ?? undefined : undefined,
      description: lockDescription(words, body.note?.trim() || null),
      unsafe: true,
      down: false,
      deviceStationId: null,
      fromRequestId: source.id,
    })
    // The request it came from joins the lock: one request carries the lock and its job; its reporter follows it.
    let joined = false
    if (isOpenRequest(source.status)) {
      await tx.maintenanceRequest.update({
        where: { id: source.id },
        data: { status: 'MERGED', mergedIntoId: made.id, closedAt: now, closedById: context.actorId, ...(source.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedById: context.actorId }), version: { increment: 1 }, updatedAt: now },
        select: { id: true },
      })
      joined = true
      const scope = { companyId: source.companyId, siteId: source.siteId }
      tools.audit({ action: 'plant.mergeRequest', recordType: 'MaintenanceRequest', recordId: source.id, ...scope, before: { status: source.status }, after: { status: 'MERGED', mergedIntoId: made.id, lockedBy: made.id } })
      tools.emit({ type: 'maintenance_request.triaged', subject: source.id, ...scope, payload: { requestId: source.id, machineId: machine.id, assetNumber: machine.assetNumber, action: 'MERGED', status: 'MERGED', jobId: null, mergedIntoId: made.id, closeReason: null } })
    }
    const views = await requestViews(tx, [(await readRequest(tx, made.id))!, (await readRequest(tx, source.id))!], context, now, { record: true })
    const [machineView] = await machineViews(tx, [(await readMachine(tx, context, machine.id))!], context)
    return { lock: views[0]!, from: views[1]!, joined, machine: machineView! }
  })
  return { ...result, replayed }
}

// ---- merge several into one (QHS-181) ------------------------------------------------------------------------------------

export interface MergeBody {
  readonly requests: readonly { readonly id: string; readonly version: number }[]
  readonly intoId?: string | undefined
  readonly intoJobId?: string | undefined
}

/** POST /plant/requests/merge: all or none, into one request (MERGED) or into the machine's open job (JOB_MADE). */
export async function mergeMany(caller: CommandCaller, body: MergeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const nothing = mergeNothing(body.requests.length)
  if (nothing) refused(nothing)
  if ((body.intoId === undefined) === (body.intoJobId === undefined)) throw new ValidationError('Merge into one request or into one job.', [{ path: 'body/intoId', message: 'Name the request or the job to merge into: exactly one.' }])
  const ids = body.requests.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A request is named twice.', [{ path: 'body/requests', message: 'A request is named twice.' }])
  const known: RequestRow[] = []
  for (const [index, entry] of body.requests.entries()) {
    const row = isUuid(entry.id) ? await caller.withClient((client) => readRequest(client, entry.id)) : null
    if (!row || !may(context, PLANT_VIEW, row)) throw new ValidationError('A request named is not there.', [{ path: `body/requests/${index}`, message: 'Request not found.' }])
    if (!may(context, PLANT_REQUESTS_TRIAGE, row)) throw new ValidationError('A request named is of a site you do not triage.', [{ path: `body/requests/${index}`, message: 'Merged only by a role that triages its requests (plant.requests.triage).' }])
    known.push(row)
  }
  const machineId = known[0]!.machineId
  known.forEach((row, index) => {
    if (row.machineId !== machineId) throw new ValidationError('The requests are about different machines.', [{ path: `body/requests/${index}`, message: 'Merge only requests of the same machine.' }])
  })
  const { result, replayed } = await command(caller, { name: 'plant.mergeRequests', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, machineId))!
    // One lock order: the machine, the target, then the requests by id.
    const target = body.intoId ? await lockRequest(tx, body.intoId) : null
    const job = body.intoJobId ? await lockJob(tx, body.intoJobId) : null
    if (body.intoId && !target) throw new ValidationError('Not a request of the group.', [{ path: 'body/intoId', message: 'Not a request of the group.' }])
    if (body.intoJobId && !job) throw new ValidationError('Not a maintenance job of the group.', [{ path: 'body/intoJobId', message: 'Not a maintenance job of the group.' }])
    if (job) {
      const refusal = joinJobRefusal({ machineId, job: { machineId: job.machineId, status: job.status as JobStatus, number: job.number } })
      if (refusal) refused(refusal)
    }
    const locked = new Map<string, RequestRow>()
    for (const id of [...ids].sort()) locked.set(id, (await lockRequest(tx, id))!)
    for (const entry of body.requests) {
      const request = locked.get(entry.id)!
      assertVersion('request', request.version, entry.version)
      const move = target ? 'merge' : 'job'
      const triage = triageRefusal({ request: { status: request.status as RequestStatus, unsafe: request.unsafe, signedSafe: request.signedSafeAt !== null }, assetNumber: machine.assetNumber }, move)
      if (triage) refused(triage)
      if (target) {
        const refusal = mergeTargetRefusal({ requestId: request.id, machineId, target: { id: target.id, machineId: target.machineId, status: target.status as RequestStatus } })
        if (refusal) refused(refusal)
      }
      const acknowledged = request.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedById: context.actorId }
      const data: Prisma.MaintenanceRequestUncheckedUpdateInput = target
        ? { status: 'MERGED', mergedIntoId: target.id, closedAt: now, closedById: context.actorId, ...acknowledged }
        : { status: 'JOB_MADE', jobId: job!.id, ...acknowledged }
      await tx.maintenanceRequest.update({ where: { id: request.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      const scope = { companyId: request.companyId, siteId: request.siteId }
      tools.audit({ action: target ? 'plant.mergeRequest' : 'plant.makeJobOfRequest', recordType: 'MaintenanceRequest', recordId: request.id, ...scope, before: { status: request.status }, after: { status: target ? 'MERGED' : 'JOB_MADE', mergedIntoId: target?.id ?? null, jobId: job?.id ?? null } })
      tools.emit({
        type: 'maintenance_request.triaged',
        subject: request.id,
        ...scope,
        payload: { requestId: request.id, machineId, assetNumber: machine.assetNumber, action: target ? 'MERGED' : 'JOB_MADE', status: target ? 'MERGED' : 'JOB_MADE', jobId: job?.id ?? null, mergedIntoId: target?.id ?? null, closeReason: null as CloseReason | null },
      })
    }
    const rows: RequestRow[] = []
    for (const id of ids) rows.push((await readRequest(tx, id))!)
    return {
      requests: await requestViews(tx, rows, context, now, { record: true }),
      target: target ? (await requestViews(tx, [(await readRequest(tx, target.id))!], context, now, { record: true }))[0]! : null,
      job: job ? (await jobViews(tx, [(await readJob(tx, job.id))!], context, now))[0]! : null,
    }
  })
  return { ...result, replayed }
}

// ---- reads ---------------------------------------------------------------------------------------------------------------

/** GET /plant/requests/duplicates: the machines with two or more open requests, each with its suggested target. */
export async function duplicatesRead(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const where: Prisma.MaintenanceRequestWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MaintenanceRequestWhereInput, query.siteId ? { siteId: query.siteId } : {}, { status: { in: [...OPEN_REQUEST_STATUSES] } }] }
    const open = await client.maintenanceRequest.findMany({ where, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], take: 500, select: REQUEST_COLUMNS })
    const machineIds = [...new Set(open.map((row) => row.machineId))]
    const jobs = machineIds.length === 0 ? [] : await client.maintenanceJob.findMany({ where: { machineId: { in: machineIds }, status: { in: [...OPEN_JOB_STATUSES] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, number: true, status: true, machineId: true } })
    const openJobOf = new Map<string, string>()
    for (const job of jobs) if (!openJobOf.has(job.machineId)) openJobOf.set(job.machineId, job.id)
    const groups = duplicateGroups(open.map((row) => ({ id: row.id, machineId: row.machineId, reportedAt: row.reportedAt, locking: row.unsafe && row.signedSafeAt === null })), openJobOf)
    const views = new Map((await requestViews(client, open.filter((row) => groups.some((group) => group.requestIds.includes(row.id))), context, now)).map((view) => [view.id, view]))
    return {
      groups: groups.map((group) => {
        const requests = group.requestIds.map((id) => views.get(id)!)
        const machine = requests[0]!.machine
        const job = group.suggested.kind === 'JOB' ? jobs.find((row) => row.id === (group.suggested as { jobId: string }).jobId)! : null
        return {
          machine,
          requests,
          withinMinutes: group.withinMinutes,
          words: groupWords(requests.length, `${machine.class.labelEn} ${machine.assetNumber}`, group.withinMinutes),
          suggested: job ? { kind: 'JOB' as const, job: { id: job.id, number: job.number, status: job.status }, requestId: null } : { kind: 'REQUEST' as const, job: null, requestId: (group.suggested as { requestId: string }).requestId },
        }
      }),
    }
  })
}

/** GET /plant/requests/locks: every machine locked as unsafe now (the queue's banner: always first on the page). */
export async function locksRead(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const where: Prisma.MaintenanceRequestWhereInput = { AND: [scopeOf(context, PLANT_VIEW) as Prisma.MaintenanceRequestWhereInput, query.siteId ? { siteId: query.siteId } : {}, { unsafe: true, signedSafeAt: null }] }
    const rows = await client.maintenanceRequest.findMany({ where, orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }], take: 200, select: REQUEST_COLUMNS })
    // One banner per machine: its first lock.
    const first = new Map<string, RequestRow>()
    for (const row of rows) if (!first.has(row.machineId)) first.set(row.machineId, row)
    const requests = await requestViews(client, [...first.values()], context, now)
    const machineRows = []
    for (const id of first.keys()) {
      const row = await readMachine(client, context, id)
      if (row) machineRows.push(row)
    }
    const machines = new Map((await machineViews(client, machineRows, context)).map((view) => [view.id, view]))
    return {
      locks: requests.map((request) => ({ machine: machines.get(request.machine.id)!, request, canSignSafe: may(context, PLANT_SIGN_SAFE, request) })),
    }
  })
}
