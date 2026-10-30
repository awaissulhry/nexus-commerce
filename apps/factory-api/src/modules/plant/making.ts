import type { MaintenanceJobSource, MaintenanceJobType, MaintenancePriority, Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PLANT_JOBS_WORK } from '@nexus/factory-domain/plant/permissions'
import { PLANT_LIMITS, type JobSource, type JobType, type Priority } from '@nexus/factory-domain/plant/rules'
import type { CommandTools, CommandTx } from '../../core/command'
import { heldRoles } from '../../platform/auth/roles/access'
import { allocateNumber } from '../../platform/numbering/allocate'
import { bodyIssue } from './access'

/**
 * Making a maintenance job and giving it to a technician (B-W2a-35; QHS-184): shared by the jobs' routes and a request's
 * "Make a job". The technician is an ACTIVE office user who holds plant.jobs.work over the machine's company and site,
 * or an ACTIVE floor worker of the machine's site with a live floor role that holds it (the `technician` template); at
 * most one of the two. The number comes from the company's MAINTENANCE_JOB series inside the making command (the office
 * numbers; the floor never makes a job).
 */

export interface Assignee {
  readonly assigneeId: string | null
  readonly assigneeWorkerId: string | null
}

/** The technician named, checked; a 400 naming the field otherwise. `undefined` fields: not named. */
export async function checkAssignee(tx: CommandTx, tenantId: string, machine: { readonly companyId: string; readonly siteId: string }, input: { readonly assigneeId?: string | null | undefined; readonly assigneeWorkerId?: string | null | undefined }, now: Date): Promise<Assignee> {
  const assigneeId = input.assigneeId ?? null
  const assigneeWorkerId = input.assigneeWorkerId ?? null
  if (assigneeId && assigneeWorkerId) throw bodyIssue('assigneeWorkerId', 'A job has one technician: an office user or a floor worker, not both.')
  if (assigneeId) {
    const user = await tx.user.findFirst({ where: { id: assigneeId, status: 'ACTIVE' }, select: { id: true } })
    const grants = user ? sessionGrants({ requireMfa: false }, await heldRoles(tx, assigneeId, now), true) : []
    if (!user || !can({ audience: 'office', tenantId, grants }, PLANT_JOBS_WORK, machine)) {
      throw bodyIssue('assigneeId', "Not a technician of the machine's site: the person needs a role that works maintenance jobs there (plant.jobs.work).")
    }
  }
  if (assigneeWorkerId) {
    const worker = await tx.worker.findFirst({ where: { id: assigneeWorkerId, siteId: machine.siteId, status: 'ACTIVE' }, select: { id: true } })
    const roles = worker ? await tx.workerRole.findMany({ where: { workerId: assigneeWorkerId, endedAt: null }, select: { role: { select: { permissions: true } } } }) : []
    if (!worker || !roles.some((entry) => entry.role.permissions.includes(PLANT_JOBS_WORK))) {
      throw bodyIssue('assigneeWorkerId', "Not a technician of the machine's site: the worker needs the maintenance technician's floor role there.")
    }
  }
  return { assigneeId, assigneeWorkerId }
}

export interface JobDraft {
  readonly machine: { readonly id: string; readonly assetNumber: string; readonly companyId: string; readonly siteId: string }
  readonly type: JobType
  readonly source: JobSource
  readonly problem: string
  readonly symptomId: string | null
  readonly priority: Priority
  readonly assignee: Assignee
  readonly dueAt: Date | null
  readonly plan: boolean
  /** The requests it is made for (they are moved to JOB_MADE by the caller). */
  readonly requestIds: readonly string[]
  readonly createdById: string
}

/** Makes the job inside the caller's command: its number, the row, its audit row, maintenance_job.created (and .assigned). */
export async function makeJobInCommand(tools: CommandTools, draft: JobDraft): Promise<{ readonly id: string; readonly number: string }> {
  const { tx, now } = tools
  const id = newId()
  const issued = await allocateNumber(tools, { companyId: draft.machine.companyId, kind: 'MAINTENANCE_JOB' }, { type: 'MaintenanceJob', id })
  const data: Prisma.MaintenanceJobUncheckedCreateInput = {
    id,
    companyId: draft.machine.companyId,
    siteId: draft.machine.siteId,
    number: issued.formatted,
    machineId: draft.machine.id,
    type: draft.type as MaintenanceJobType,
    source: draft.source as MaintenanceJobSource,
    problem: draft.problem.trim().slice(0, PLANT_LIMITS.text),
    symptomId: draft.symptomId,
    priority: draft.priority as MaintenancePriority,
    assigneeId: draft.assignee.assigneeId,
    assigneeWorkerId: draft.assignee.assigneeWorkerId,
    dueAt: draft.dueAt,
    status: draft.plan ? 'PLANNED' : 'NEW',
    createdAt: now,
    updatedAt: now,
    createdById: draft.createdById,
  }
  await tx.maintenanceJob.create({ data, select: { id: true } })
  const scope = { companyId: draft.machine.companyId, siteId: draft.machine.siteId }
  tools.audit({
    action: 'plant.createJob',
    recordType: 'MaintenanceJob',
    recordId: id,
    ...scope,
    after: { number: issued.formatted, machineId: draft.machine.id, type: draft.type, source: draft.source, problem: data.problem, symptomId: draft.symptomId, priority: draft.priority, assigneeId: draft.assignee.assigneeId, assigneeWorkerId: draft.assignee.assigneeWorkerId, dueAt: draft.dueAt?.toISOString() ?? null, status: data.status, requestIds: [...draft.requestIds] },
  })
  tools.emit({
    type: 'maintenance_job.created',
    subject: id,
    ...scope,
    payload: { jobId: id, number: issued.formatted, machineId: draft.machine.id, assetNumber: draft.machine.assetNumber, type: draft.type, source: draft.source, priority: draft.priority, status: data.status as 'NEW' | 'PLANNED', requestIds: [...draft.requestIds] },
  })
  if (draft.assignee.assigneeId || draft.assignee.assigneeWorkerId) assignedEvent(tools, { id, number: issued.formatted, machineId: draft.machine.id, ...scope }, draft.assignee, draft.createdById)
  return { id, number: issued.formatted }
}

/** maintenance_job.assigned: the office assignee is told (platform/notifications/rules/plant.ts). */
export function assignedEvent(tools: Pick<CommandTools, 'emit'>, job: { readonly id: string; readonly number: string; readonly machineId: string; readonly companyId: string; readonly siteId: string }, assignee: Assignee, by: string | null): void {
  tools.emit({
    type: 'maintenance_job.assigned',
    subject: job.id,
    companyId: job.companyId,
    siteId: job.siteId,
    payload: {
      jobId: job.id,
      number: job.number,
      machineId: job.machineId,
      assignee: assignee.assigneeId ? 'USER' : assignee.assigneeWorkerId ? 'WORKER' : 'NOBODY',
      assigneeId: assignee.assigneeId,
      assignedById: by,
    },
  })
}
