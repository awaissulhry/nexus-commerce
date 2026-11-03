import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { leadConfirmRefusal } from '@nexus/factory-domain/plant/jobs/close'
import { PLANT_REQUESTS_TRIAGE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { assertVersion, byOf, contextOf, may, refused, type PlantContext } from '../access'
import { jobViews, lockJob, lockMachine, machineViews, readJob, readMachine } from '../store'

/**
 * The line lead confirms the machine works after the hand-back (B-W2b-96; QHS-180, QHS-191; design plant.jobs "Line lead
 * confirms": "Confirmed by · time"): on the floor the line lead (floor.lead, with the device's site), in the office a person
 * who triages the machine requests (plant.requests.triage). Once, while the job is HANDED_BACK (before the office closes
 * it); taking the job back to work clears it with the hand-back. ONE command: the machine row, then the job.
 *
 *   POST /plant/jobs/:jobId/confirm          (office)
 *   POST /plant/floor/jobs/:jobId/confirm    (floor)
 */

const LEAD = 'floor.lead' as const

const permissionOf = (context: PlantContext) => (context.audience === 'floor' ? LEAD : PLANT_REQUESTS_TRIAGE)

/** POST …/jobs/:jobId/confirm. */
export async function confirmJob(caller: CommandCaller, jobId: string, body: { readonly version?: number | undefined }, idempotencyKey?: string) {
  const context = contextOf(caller)
  const permission = permissionOf(context)
  const known = isUuid(jobId) ? await caller.withClient((client) => readJob(client, jobId)) : null
  if (!known || (!may(context, permission, known) && (context.audience === 'floor' || !may(context, PLANT_VIEW, known)))) throw new NotFoundError('Job not found.')
  if (!may(context, permission, known)) throw new ForbiddenError(context.audience === 'floor' ? 'The line lead confirms the machine works (floor.lead).' : 'The machine is confirmed working by a role that triages the machine requests (plant.requests.triage).')
  const { result, replayed } = await command(caller, { name: 'plant.confirmJob', idempotencyKey, input: { jobId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, known.machineId))!
    const job = (await lockJob(tx, jobId))!
    if (body.version !== undefined) assertVersion('job', job.version, body.version)
    const refusal = leadConfirmRefusal({ number: job.number, status: job.status, leadConfirmedAt: job.leadConfirmedAt })
    if (refusal) refused(refusal)
    const by = context.audience === 'floor' ? { leadConfirmedById: null, leadConfirmedByWorkerId: context.actorId } : { leadConfirmedById: context.actorId, leadConfirmedByWorkerId: null }
    await tx.maintenanceJob.update({ where: { id: job.id }, data: { leadConfirmedAt: now, ...by, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const scope = { companyId: job.companyId, siteId: job.siteId }
    tools.audit({ action: 'plant.confirmJob', recordType: 'MaintenanceJob', recordId: job.id, ...scope, after: { leadConfirmedAt: now.toISOString(), ...by } })
    tools.emit({ type: 'maintenance_job.confirmed', subject: job.id, ...scope, payload: { jobId: job.id, number: job.number, machineId: job.machineId, by: byOf(context) } })
    const [view] = await jobViews(tx, [(await readJob(tx, job.id))!], context, now, { record: true })
    const [machineView] = await machineViews(tx, [(await readMachine(tx, context, machine.id))!], context)
    return { job: view!, machine: machineView! }
  })
  return { ...result, replayed }
}
