import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANT_JOBS_MANAGE } from '@nexus/factory-domain/plant/permissions'
import type { JobType, Priority } from '@nexus/factory-domain/plant/rules'
import { SAFETY_INCIDENTS_MANAGE } from '@nexus/factory-domain/safety/incidents/permissions'
import { INCIDENT_LIMITS, refusalOf, type ActionLink, type ActionStatus } from '@nexus/factory-domain/safety/incidents/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { can } from '@nexus/factory-domain/core/permissions'
import { checkAssignee, makeJobInCommand } from '../../plant/making'
import { actorIdOf, assertMay, assertMayWrite, dateOf, dayOf, officeOf, refuse } from './access'
import { assertVersion } from '../../people/employees/access'

/**
 * An incident's actions (B-W2b-125; design plant.incidents tab Actions: "Action · owner · due · status · evidence · made into:
 * maintenance job / DVR measure / training need (links)"; "'Make a job', 'Add to improvement plan', 'Plan training' create
 * the linked item in one step"), office, safety.incidents.manage over the incident, each one command:
 *
 *   POST /safety/incidents/:id/actions                      a plain action, or one made into its record in the same step
 *   POST /safety/incidents/:id/actions/:actionId/make       a plain action made into its record (set once)
 *   PATCH /safety/incidents/:id/actions/:actionId           title, owner, due day, evidence note (while OPEN)
 *   POST /safety/incidents/:id/actions/:actionId/done       done (+ evidence note); …/cancel with the reason
 *
 * Made into: a MAINTENANCE_JOB through the plant's own `makeJobInCommand` (number MAINTENANCE_JOB, source INCIDENT, NEW for
 * the maintenance lead to triage; a technician named asks plant.jobs.manage over the machine on top); a RISK_MEASURE of the
 * site's risk assessment (PLANNED, source INCIDENT naming this incident: the guard checks it); a TRAINING_SESSION (OPEN at the
 * site, the course and the trainer checked: the training records are written when it closes, B-W2b-139). The incident's row is
 * locked for the command (actions are written only while it is OPEN: the guard holds it too); its version does not move.
 */

const MANAGE_WORDS = 'An incident’s actions are kept by the safety roles (safety.incidents.manage).'

export interface MakeJob {
  readonly into: 'MAINTENANCE_JOB'
  readonly machineId?: string | undefined
  readonly type?: JobType | undefined
  readonly priority?: Priority | undefined
  readonly problem?: string | undefined
  readonly assigneeId?: string | undefined
  readonly assigneeWorkerId?: string | undefined
}
export interface MakeMeasure {
  readonly into: 'RISK_MEASURE'
  readonly assessmentId?: string | undefined
  readonly risk?: string | undefined
}
export interface MakeTraining {
  readonly into: 'TRAINING_SESSION'
  readonly courseId: string
  readonly heldOn: BusinessDate
  readonly hours: string
  readonly language: string
  readonly trainerEmployeeId?: string | undefined
  readonly trainerName?: string | undefined
  readonly location?: string | undefined
}
export type MakeBody = MakeJob | MakeMeasure | MakeTraining

export interface AddActionBody {
  readonly title: string
  readonly ownerId?: string | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly make?: MakeBody | undefined
}

const ACTION_SELECT = {
  id: true,
  seq: true,
  title: true,
  ownerId: true,
  dueOn: true,
  status: true,
  doneAt: true,
  doneById: true,
  evidenceNote: true,
  cancelledAt: true,
  cancelReason: true,
  madeInto: true,
  maintenanceJobId: true,
  riskMeasureId: true,
  trainingSessionId: true,
  version: true,
  maintenanceJob: { select: { id: true, number: true, status: true } },
  riskMeasure: { select: { id: true, title: true, status: true } },
  trainingSession: { select: { id: true, heldOn: true, status: true, course: { select: { code: true, name: true } } } },
} as const

/** The actions of an incident, in their order (the record's Actions tab). */
export async function actionsOf(db: Pick<CommandTx, 'incidentAction'>, incidentId: string, today: BusinessDate) {
  const rows = await db.incidentAction.findMany({ where: { incidentId }, select: ACTION_SELECT, orderBy: { seq: 'asc' } })
  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    title: row.title,
    ownerId: row.ownerId,
    dueOn: row.dueOn ? dayOf(row.dueOn) : null,
    status: row.status as ActionStatus,
    overdue: row.status === 'OPEN' && row.dueOn !== null && dayOf(row.dueOn) < today,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    doneById: row.doneById,
    evidenceNote: row.evidenceNote,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    cancelReason: row.cancelReason,
    madeInto: (row.madeInto ?? null) as ActionLink | null,
    record: row.maintenanceJob
      ? { type: 'MaintenanceJob' as const, id: row.maintenanceJob.id, label: row.maintenanceJob.number, status: row.maintenanceJob.status as string }
      : row.riskMeasure
        ? { type: 'RiskMeasure' as const, id: row.riskMeasure.id, label: row.riskMeasure.title, status: row.riskMeasure.status as string }
        : row.trainingSession
          ? { type: 'TrainingSession' as const, id: row.trainingSession.id, label: `${row.trainingSession.course.code} · ${dayOf(row.trainingSession.heldOn)}`, status: row.trainingSession.status as string }
          : null,
    version: row.version,
  }))
}

interface LockedIncident {
  readonly id: string
  readonly number: string
  readonly companyId: string
  readonly siteId: string
  readonly status: string
  readonly machineId: string | null
}

/** The incident locked for the command (its actions change under it), OPEN, or a refusal. */
async function lockIncident(tx: CommandTx, incidentId: string): Promise<LockedIncident> {
  await tx.$queryRaw`SELECT id FROM "Incident" WHERE id = ${incidentId}::uuid FOR UPDATE`
  const row = await tx.incident.findUnique({ where: { id: incidentId }, select: { id: true, number: true, companyId: true, siteId: true, status: true, machineId: true } })
  if (!row) throw new NotFoundError('Incident not found.')
  if (row.status !== 'OPEN') refuse(refusalOf('NOT_OPEN'))
  return row
}

async function placeOf(caller: CommandCaller, incidentId: string) {
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const row = await caller.withClient((db) => db.incident.findUnique({ where: { id: incidentId }, select: { companyId: true, siteId: true } }))
  if (!row) throw new NotFoundError('Incident not found.')
  return row
}

async function checkOwner(tx: CommandTx, ownerId: string | undefined): Promise<void> {
  if (ownerId === undefined) return
  const user = isUuid(ownerId) ? await tx.user.findFirst({ where: { id: ownerId, status: 'ACTIVE' }, select: { id: true } }) : null
  if (!user) throw new ValidationError('The owner is an active office user.', [{ path: 'body/ownerId', message: 'An active office user.' }])
}

/** Makes the linked record in the caller's command; answers its kind and id. */
async function makeRecord(tools: CommandTools, incident: LockedIncident, action: { readonly id: string; readonly title: string; readonly ownerId: string | null; readonly dueOn: Date | null }, make: MakeBody): Promise<{ madeInto: ActionLink; recordId: string; fk: Record<string, string> }> {
  const { tx, now } = tools
  const context = officeOf({ factoryContext: tools.context })
  const actorId = actorIdOf(tools.context)!
  if (make.into === 'MAINTENANCE_JOB') {
    const machineId = make.machineId ?? incident.machineId
    if (!machineId) refuse(refusalOf('NO_MACHINE', 'make/machineId'))
    const machine = isUuid(machineId!) ? await tx.machine.findFirst({ where: { id: machineId!, siteId: incident.siteId }, select: { id: true, assetNumber: true, companyId: true, siteId: true } }) : null
    if (!machine) refuse(refusalOf('WHERE_OTHER_SITE', 'make/machineId'))
    const named = make.assigneeId !== undefined || make.assigneeWorkerId !== undefined
    if (named && !can(actorOf(context), PLANT_JOBS_MANAGE, machine!)) throw new ForbiddenError('A technician is named on a job by a role that keeps the maintenance jobs (plant.jobs.manage); make the job without one and the maintenance lead assigns it.')
    const assignee = await checkAssignee(tx, context.tenantId, machine!, { assigneeId: make.assigneeId, assigneeWorkerId: make.assigneeWorkerId }, now)
    const job = await makeJobInCommand(tools, {
      machine: machine!,
      type: make.type ?? 'SAFETY',
      source: 'INCIDENT',
      problem: (make.problem ?? `${incident.number}: ${action.title}`).trim(),
      symptomId: null,
      priority: make.priority ?? 'P2',
      assignee,
      dueAt: action.dueOn,
      plan: false,
      requestIds: [],
      createdById: actorId,
    })
    return { madeInto: 'MAINTENANCE_JOB', recordId: job.id, fk: { maintenanceJobId: job.id } }
  }
  if (make.into === 'RISK_MEASURE') {
    const assessments = await tx.riskAssessment.findMany({ where: { siteId: incident.siteId, status: 'ACTIVE', ...(make.assessmentId ? { id: make.assessmentId } : {}) }, select: { id: true }, take: 2 })
    if (assessments.length !== 1) refuse(refusalOf('NO_ASSESSMENT', 'make/assessmentId'))
    const id = newId()
    await tx.riskMeasure.create({
      data: {
        id,
        companyId: incident.companyId,
        siteId: incident.siteId,
        assessmentId: assessments[0]!.id,
        title: action.title,
        risk: make.risk?.trim() || null,
        ownerId: action.ownerId,
        dueOn: action.dueOn,
        status: 'PLANNED',
        source: 'INCIDENT',
        sourceRecordType: 'Incident',
        sourceRecordId: incident.id,
        createdAt: now,
        updatedAt: now,
        createdById: actorId,
      },
      select: { id: true },
    })
    tools.audit({ action: 'safety.addRiskMeasure', recordType: 'RiskMeasure', recordId: id, companyId: incident.companyId, siteId: incident.siteId, after: { assessmentId: assessments[0]!.id, title: action.title, source: 'INCIDENT', sourceRecordType: 'Incident', sourceRecordId: incident.id, ownerId: action.ownerId, dueOn: action.dueOn ? dayOf(action.dueOn) : null } })
    return { madeInto: 'RISK_MEASURE', recordId: id, fk: { riskMeasureId: id } }
  }
  const course = isUuid(make.courseId) ? await tx.safetyCourse.findUnique({ where: { id: make.courseId }, select: { companyId: true, status: true } }) : null
  if (!course || course.status !== 'ACTIVE' || (course.companyId !== null && course.companyId !== incident.companyId)) refuse(refusalOf('COURSE_NOT_ACTIVE', 'make/courseId'))
  let trainerName = make.trainerName?.trim() ?? ''
  if (make.trainerEmployeeId) {
    const trainer = isUuid(make.trainerEmployeeId) ? await tx.employee.findFirst({ where: { id: make.trainerEmployeeId, companyId: incident.companyId, status: 'ACTIVE' }, select: { displayName: true } }) : null
    if (!trainer) refuse(refusalOf('TRAINER_NOT_ACTIVE', 'make/trainerEmployeeId'))
    trainerName = trainerName || trainer!.displayName
  }
  if (trainerName === '') refuse(refusalOf('TRAINER_NOT_ACTIVE', 'make/trainerName'))
  const id = newId()
  await tx.trainingSession.create({
    data: {
      id,
      companyId: incident.companyId,
      siteId: incident.siteId,
      courseId: make.courseId,
      heldOn: dateOf(make.heldOn),
      hours: make.hours,
      language: make.language,
      trainerEmployeeId: make.trainerEmployeeId ?? null,
      trainerName,
      location: make.location?.trim() || null,
      status: 'OPEN',
      openedById: actorId,
      note: `${incident.number}: ${action.title}`.slice(0, 1000),
      createdAt: now,
      updatedAt: now,
      createdById: actorId,
    },
    select: { id: true },
  })
  tools.audit({ action: 'safety.planTraining', recordType: 'TrainingSession', recordId: id, companyId: incident.companyId, siteId: incident.siteId, after: { courseId: make.courseId, heldOn: make.heldOn, hours: make.hours, language: make.language, trainerEmployeeId: make.trainerEmployeeId ?? null, fromIncident: incident.id } })
  return { madeInto: 'TRAINING_SESSION', recordId: id, fk: { trainingSessionId: id } }
}

function actionEvent(tools: CommandTools, incident: LockedIncident, actionId: string, change: 'ADDED' | 'EDITED' | 'MADE' | 'DONE' | 'CANCELLED', made: { madeInto: ActionLink; recordId: string } | null): void {
  tools.emit({ type: 'incident_action.changed', subject: incident.id, companyId: incident.companyId, siteId: incident.siteId, payload: { incidentId: incident.id, actionId, change, madeInto: made?.madeInto ?? null, recordId: made?.recordId ?? null } })
}

/** POST /safety/incidents/:id/actions. */
export async function addAction(caller: CommandCaller, incidentId: string, body: AddActionBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = await placeOf(caller, incidentId)
  assertMay(context, 'safety.incidents.view', place)
  assertMayWrite(context, SAFETY_INCIDENTS_MANAGE, place, MANAGE_WORDS)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'safety.addIncidentAction', idempotencyKey, input: { incidentId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const incident = await lockIncident(tx, incidentId)
    await checkOwner(tx, body.ownerId)
    const last = await tx.incidentAction.findFirst({ where: { incidentId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const title = body.title.trim().slice(0, INCIDENT_LIMITS.title)
    const dueOn = body.dueOn ? dateOf(body.dueOn) : null
    const made = body.make ? await makeRecord(tools, incident, { id, title, ownerId: body.ownerId ?? null, dueOn }, body.make) : null
    await tx.incidentAction.create({
      data: {
        id,
        siteId: incident.siteId,
        incidentId,
        seq: (last?.seq ?? 0) + 1,
        title,
        ownerId: body.ownerId ?? null,
        dueOn,
        status: 'OPEN',
        madeInto: made?.madeInto ?? null,
        ...(made?.fk ?? {}),
        createdAt: now,
        updatedAt: now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    tools.audit({ action: 'safety.addIncidentAction', recordType: 'IncidentAction', recordId: id, companyId: incident.companyId, siteId: incident.siteId, after: { incidentId, title, ownerId: body.ownerId ?? null, dueOn: body.dueOn ?? null, madeInto: made?.madeInto ?? null, recordId: made?.recordId ?? null } })
    actionEvent(tools, incident, id, 'ADDED', made)
    return { action: { id, version: 1, madeInto: made?.madeInto ?? null, recordId: made?.recordId ?? null } }
  })
  return { ...result, replayed }
}

async function actionRow(tx: CommandTx, incidentId: string, actionId: string) {
  const row = isUuid(actionId) ? await tx.incidentAction.findFirst({ where: { id: actionId, incidentId }, select: { id: true, title: true, ownerId: true, dueOn: true, status: true, madeInto: true, version: true } }) : null
  if (!row) throw new NotFoundError('Action not found.')
  return row
}

/** One command on an existing action (version checked; the incident locked and OPEN; the action OPEN). */
async function onAction<T>(caller: CommandCaller, incidentId: string, actionId: string, name: 'safety.makeIncidentAction' | 'safety.editIncidentAction' | 'safety.doneIncidentAction' | 'safety.cancelIncidentAction', input: { readonly version: number }, idempotencyKey: string | undefined, work: (tools: CommandTools, incident: LockedIncident, action: Awaited<ReturnType<typeof actionRow>>) => Promise<T>) {
  const context = officeOf(caller)
  const place = await placeOf(caller, incidentId)
  assertMay(context, 'safety.incidents.view', place)
  assertMayWrite(context, SAFETY_INCIDENTS_MANAGE, place, MANAGE_WORDS)
  if (!isUuid(actionId)) throw new NotFoundError('Action not found.')
  // The incident first (its actions change only while it is OPEN), then the action at the version the caller read: the
  // refusals in words before any row is touched (the guard's check_violation would be a 500).
  const { result, replayed } = await command(caller, { name, idempotencyKey, input: { incidentId, actionId, ...input } }, async (tools) => {
    const incident = await lockIncident(tools.tx, incidentId)
    await tools.tx.$queryRaw`SELECT id FROM "IncidentAction" WHERE id = ${actionId}::uuid FOR UPDATE`
    const action = await actionRow(tools.tx, incidentId, actionId)
    assertVersion('action', action.version, input.version)
    if (action.status !== 'OPEN') refuse(refusalOf('ACTION_NOT_OPEN'))
    return work(tools, incident, action)
  })
  return { ...result, replayed }
}

/** POST /safety/incidents/:id/actions/:actionId/make. */
export function makeAction(caller: CommandCaller, incidentId: string, actionId: string, body: { readonly version: number; readonly make: MakeBody }, idempotencyKey?: string) {
  return onAction(caller, incidentId, actionId, 'safety.makeIncidentAction', body, idempotencyKey, async (tools, incident, action) => {
    if (action.madeInto !== null) refuse(refusalOf('MADE_ALREADY'))
    const made = await makeRecord(tools, incident, action, body.make)
    await tools.tx.incidentAction.update({ where: { id: action.id }, data: { madeInto: made.madeInto, ...made.fk, updatedAt: tools.now, version: action.version + 1 }, select: { id: true } })
    tools.audit({ action: 'safety.makeIncidentAction', recordType: 'IncidentAction', recordId: action.id, companyId: incident.companyId, siteId: incident.siteId, after: { madeInto: made.madeInto, recordId: made.recordId } })
    actionEvent(tools, incident, action.id, 'MADE', made)
    return { action: { id: action.id, version: action.version + 1, madeInto: made.madeInto, recordId: made.recordId } }
  })
}

export interface EditActionBody {
  readonly version: number
  readonly title?: string | undefined
  readonly ownerId?: string | null | undefined
  readonly dueOn?: BusinessDate | null | undefined
  readonly evidenceNote?: string | null | undefined
}

/** PATCH /safety/incidents/:id/actions/:actionId. */
export function editAction(caller: CommandCaller, incidentId: string, actionId: string, body: EditActionBody, idempotencyKey?: string) {
  return onAction(caller, incidentId, actionId, 'safety.editIncidentAction', body, idempotencyKey, async (tools, incident, action) => {
    if (body.ownerId) await checkOwner(tools.tx, body.ownerId)
    const data = {
      ...(body.title !== undefined ? { title: body.title.trim().slice(0, INCIDENT_LIMITS.title) } : {}),
      ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
      ...(body.dueOn !== undefined ? { dueOn: body.dueOn === null ? null : dateOf(body.dueOn) } : {}),
      ...(body.evidenceNote !== undefined ? { evidenceNote: body.evidenceNote?.trim().slice(0, INCIDENT_LIMITS.evidence) || null } : {}),
    }
    await tools.tx.incidentAction.update({ where: { id: action.id }, data: { ...data, updatedAt: tools.now, version: action.version + 1 }, select: { id: true } })
    tools.audit({ action: 'safety.editIncidentAction', recordType: 'IncidentAction', recordId: action.id, companyId: incident.companyId, siteId: incident.siteId, after: { ...data, dueOn: body.dueOn ?? null } })
    actionEvent(tools, incident, action.id, 'EDITED', null)
    return { action: { id: action.id, version: action.version + 1 } }
  })
}

/** POST /safety/incidents/:id/actions/:actionId/done. */
export function doneAction(caller: CommandCaller, incidentId: string, actionId: string, body: { readonly version: number; readonly evidenceNote?: string | undefined }, idempotencyKey?: string) {
  return onAction(caller, incidentId, actionId, 'safety.doneIncidentAction', body, idempotencyKey, async (tools, incident, action) => {
    const evidenceNote = body.evidenceNote?.trim().slice(0, INCIDENT_LIMITS.evidence) || undefined
    await tools.tx.incidentAction.update({ where: { id: action.id }, data: { status: 'DONE', doneAt: tools.now, doneById: actorIdOf(tools.context), ...(evidenceNote ? { evidenceNote } : {}), updatedAt: tools.now, version: action.version + 1 }, select: { id: true } })
    tools.audit({ action: 'safety.doneIncidentAction', recordType: 'IncidentAction', recordId: action.id, companyId: incident.companyId, siteId: incident.siteId, before: { status: 'OPEN' }, after: { status: 'DONE', evidence: evidenceNote !== undefined } })
    actionEvent(tools, incident, action.id, 'DONE', null)
    return { action: { id: action.id, version: action.version + 1, status: 'DONE' as const } }
  })
}

/** POST /safety/incidents/:id/actions/:actionId/cancel. */
export function cancelAction(caller: CommandCaller, incidentId: string, actionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  return onAction(caller, incidentId, actionId, 'safety.cancelIncidentAction', body, idempotencyKey, async (tools, incident, action) => {
    const reason = body.reason.trim().slice(0, INCIDENT_LIMITS.reason)
    await tools.tx.incidentAction.update({ where: { id: action.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: reason, updatedAt: tools.now, version: action.version + 1 }, select: { id: true } })
    tools.audit({ action: 'safety.cancelIncidentAction', recordType: 'IncidentAction', recordId: action.id, companyId: incident.companyId, siteId: incident.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
    actionEvent(tools, incident, action.id, 'CANCELLED', null)
    return { action: { id: action.id, version: action.version + 1, status: 'CANCELLED' as const } }
  })
}
