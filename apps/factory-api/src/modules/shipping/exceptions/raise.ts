import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { exceptionsDue, exceptionTaskOf, type ExceptionDue, type ParcelNews, type TrackingExceptionKind } from '@nexus/factory-domain/shipping/exceptions/rules'
import { latestByParcel } from '@nexus/factory-domain/shipping/labels/tracking'
import { events as deliveryEvents } from '@nexus/factory-domain/shipping-delivery/events'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * Tracking problems inside a command (B-W2b-398; LOG-063; factory-domain shipping/exceptions): the shipment's row locked
 * first (FOR UPDATE, as the tracking recorder does), its facts read again under the lock, then per problem due: the Task a
 * person works it in (on the shipment: its company, site and customer; no one assigned, the site's dispatch desk is told
 * by the notification rule) and the TrackingException naming it, their audit rows, task.created and
 * shipment.tracking_problem_raised. A problem already open is never raised twice (factory-domain exceptionsDue; the
 * database's TrackingException_one_open holds it too).
 *
 * Resolving: once, with its time (then the row is frozen); by a person, or by itself when the goods arrive or come back
 * (`resolveOpenInCommand`); the problem's task is done with it (by that person, or by the system).
 */

const [taskCreated, , taskCompleted] = taskEvents
const raised = deliveryEvents.find((event) => event.type === 'shipment.tracking_problem_raised')!
const resolved = deliveryEvents.find((event) => event.type === 'shipment.tracking_problem_resolved')!

const SHIPMENT_SELECT = { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, shippedAt: true, expectedDeliveryAt: true } as const

export interface RaisedProblem {
  readonly exceptionId: string
  readonly kind: TrackingExceptionKind
  readonly taskId: string
}

async function lockShipment(tx: CommandTx, shipmentId: string) {
  await tx.$queryRaw`SELECT 1 FROM "Shipment" WHERE "id" = ${shipmentId}::uuid FOR UPDATE`
  return tx.shipment.findUnique({ where: { id: shipmentId }, select: SHIPMENT_SELECT })
}

/** What the check reads of a shipment (inside or outside a command). */
export async function exceptionFactsOf(tx: CommandTx, shipment: { readonly id: string; readonly status: string; readonly shippedAt: Date | null; readonly expectedDeliveryAt: Date | null }) {
  const parcels = await tx.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, carrierParcelId: true, trackingNumber: true, labelledAt: true }, orderBy: { seq: 'asc' } })
  const events = await tx.trackingEvent.findMany({ where: { shipmentId: shipment.id }, select: { parcelId: true, status: true, source: true, occurredAt: true, recordedAt: true, externalEventId: true, carrierStatusCode: true, description: true } })
  const latest = new Map<string, ParcelNews>([...latestByParcel(events)].map(([parcelId, event]) => [parcelId, { status: event.status, occurredAt: event.occurredAt, carrierStatusCode: event.carrierStatusCode, description: event.description }]))
  const open = (await tx.trackingException.findMany({ where: { shipmentId: shipment.id, resolvedAt: null }, select: { kind: true } })).map((row) => row.kind as TrackingExceptionKind)
  return { status: shipment.status, shippedAt: shipment.shippedAt, expectedDeliveryAt: shipment.expectedDeliveryAt, parcels, latest, open }
}

/** The problems due on a shipment now (no write): what the daily check asks a command for. */
export async function problemsDue(tx: CommandTx, shipmentId: string, now: Date): Promise<ExceptionDue[]> {
  const shipment = await tx.shipment.findUnique({ where: { id: shipmentId }, select: SHIPMENT_SELECT })
  if (!shipment) return []
  return exceptionsDue(await exceptionFactsOf(tx, shipment), now, businessDate(now))
}

/** Raises the shipment's problems due now (see above); answers what it raised (none: nothing written). */
export async function raiseDueInCommand(tools: CommandTools, shipmentId: string): Promise<RaisedProblem[]> {
  const { tx, now } = tools
  const shipment = await lockShipment(tx, shipmentId)
  if (!shipment) return []
  const due = exceptionsDue(await exceptionFactsOf(tx, shipment), now, businessDate(now))
  if (due.length === 0) return []
  const company = await tx.company.findUnique({ where: { id: shipment.companyId }, select: { locale: true } })
  const out: RaisedProblem[] = []
  for (const problem of due) {
    const taskId = newId()
    const exceptionId = newId()
    const words = exceptionTaskOf(shipment.number, problem.kind, company?.locale ?? null)
    await tx.task.create({
      data: {
        id: taskId,
        companyId: shipment.companyId,
        siteId: shipment.siteId,
        partyId: shipment.partyId,
        title: words.title,
        description: words.description,
        recordType: 'Shipment',
        recordId: shipment.id,
        recordLabel: shipment.number,
        checklist: [],
        createdAt: now,
        updatedAt: now,
        createdById: null,
      },
      select: { id: true },
    })
    tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: taskId, companyId: shipment.companyId, siteId: shipment.siteId, after: { title: words.title, status: 'OPEN', recordType: 'Shipment', recordId: shipment.id, by: 'shipping.trackingProblem' } })
    tools.emit(eventFor(taskCreated, { subject: taskId, companyId: shipment.companyId, siteId: shipment.siteId, payload: { taskId, recordType: 'Shipment', recordId: shipment.id, assigneeId: null } }))
    await tx.trackingException.create({
      data: { id: exceptionId, siteId: shipment.siteId, partyId: shipment.partyId, shipmentId: shipment.id, kind: problem.kind, raisedAt: problem.raisedAt, taskId, createdAt: now, updatedAt: now, createdById: null },
      select: { id: true },
    })
    tools.audit({ action: 'shipping.trackingProblem', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { exceptionId, kind: problem.kind, raisedAt: toUtcIso(problem.raisedAt), taskId } })
    tools.emit(eventFor(raised, { subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, exceptionId, kind: problem.kind, taskId } }))
    out.push({ exceptionId, kind: problem.kind, taskId })
  }
  return out
}

/** Resolves one open problem (the row FOR UPDATE first); answers false when it was resolved already. */
export async function resolveInCommand(tools: CommandTools, exceptionId: string, automatic: boolean, note: string | null = null): Promise<boolean> {
  const { tx, now } = tools
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "TrackingException" WHERE "id" = ${exceptionId}::uuid FOR UPDATE`
  if (rows.length === 0) return false
  const row = await tx.trackingException.findUniqueOrThrow({ where: { id: exceptionId }, select: { id: true, kind: true, raisedAt: true, resolvedAt: true, taskId: true, shipment: { select: { id: true, number: true, companyId: true, siteId: true } } } })
  if (row.resolvedAt !== null) return false
  const at = now.getTime() < row.raisedAt.getTime() ? row.raisedAt : now
  await tx.trackingException.update({ where: { id: exceptionId }, data: { resolvedAt: at, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
  const shipment = row.shipment
  tools.audit({ action: 'shipping.resolveTrackingProblem', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { exceptionId, kind: row.kind, resolvedAt: toUtcIso(at), automatic }, ...(note ? { reason: note } : {}) })
  tools.emit(eventFor(resolved, { subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, exceptionId, kind: row.kind, automatic } }))
  // The problem's task is done with it (by the person who resolved it, or by the system).
  if (row.taskId) {
    const task = await tx.task.findUnique({ where: { id: row.taskId }, select: { id: true, status: true } })
    if (task?.status === 'OPEN') {
      const closedById = tools.context.audience === 'office' ? tools.context.actorId : null
      await tx.task.update({ where: { id: task.id }, data: { status: 'DONE', closedAt: now, closedById, updatedAt: now, version: { increment: 1 } }, select: { id: true } })
      tools.audit({ action: 'tasks.complete', recordType: 'Task', recordId: task.id, companyId: shipment.companyId, siteId: shipment.siteId, before: { status: 'OPEN' }, after: { status: 'DONE', by: 'shipping.trackingProblemResolved' } })
      tools.emit(eventFor(taskCompleted, { subject: task.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { taskId: task.id, recordType: 'Shipment', recordId: shipment.id } }))
    }
  }
  return true
}

/** The goods arrived or came back: every open problem of the shipment resolved by itself (and its task done). */
export async function resolveOpenInCommand(tools: CommandTools, shipmentId: string): Promise<number> {
  const open = await tools.tx.trackingException.findMany({ where: { shipmentId, resolvedAt: null }, select: { id: true }, orderBy: { raisedAt: 'asc' } })
  let count = 0
  for (const row of open) if (await resolveInCommand(tools, row.id, true)) count++
  return count
}
