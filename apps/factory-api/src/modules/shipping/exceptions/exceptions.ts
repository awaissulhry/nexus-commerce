import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { exceptionRefusalPath, NO_SCAN_DAYS, type TrackingExceptionKind } from '@nexus/factory-domain/shipping/exceptions/rules'
import { SHIPPING_MANAGE, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../access'
import { officeShipment } from '../shipments/shipments'
import { resolveInCommand } from './raise'

/**
 * Tracking problems for the office (B-W2b-398; LOG-063; design warehouse.shipments Tracking & delivery, the dispatch desk's
 * "Exceptions" view of B-W2b-386/410):
 *
 *   GET  /shipping/shipments/:shipmentId/tracking-problems                       shipping.view: a shipment's problems, newest first
 *   GET  /shipping/tracking-problems?siteId&open                                 shipping.view: the problems of the shipments the
 *                                                                                reader sees (open ones by default), oldest first
 *   POST /shipping/shipments/:shipmentId/tracking-problems/:exceptionId/resolve  shipping.manage: resolved once, with a note
 */

const ROW_SELECT = { id: true, kind: true, raisedAt: true, resolvedAt: true, taskId: true, createdById: true } as const

const iso = (date: Date | null): string | null => (date === null ? null : toUtcIso(date))

async function taskStates(caller: CommandCaller, taskIds: readonly string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map()
  const rows = await caller.withClient((client) => client.task.findMany({ where: { id: { in: [...taskIds] } }, select: { id: true, status: true } }))
  return new Map(rows.map((row) => [row.id, row.status as string]))
}

/** A shipment's problems (its Tracking & delivery tab). */
export async function getShipmentProblems(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_VIEW)
  const rows = await caller.withClient((client) => client.trackingException.findMany({ where: { shipmentId: shipment.id }, select: ROW_SELECT, orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }], take: 200 }))
  const tasks = await taskStates(caller, rows.flatMap((row) => (row.taskId ? [row.taskId] : [])))
  return {
    shipment: { id: shipment.id, number: shipment.number, status: shipment.status },
    noScanDays: NO_SCAN_DAYS,
    problems: rows.map((row) => ({
      id: row.id,
      kind: row.kind as TrackingExceptionKind,
      raisedAt: toUtcIso(row.raisedAt),
      resolvedAt: iso(row.resolvedAt),
      taskId: row.taskId,
      taskStatus: row.taskId ? (tasks.get(row.taskId) ?? null) : null,
      raisedBySystem: row.createdById === null,
    })),
  }
}

export interface ProblemsQuery {
  readonly siteId?: string | undefined
  readonly open?: 'true' | 'false' | undefined
}

/** The problems of the shipments the reader sees: open ones (default) or every one, at most 200. */
export async function listProblems(caller: CommandCaller, query: ProblemsQuery) {
  const context = officeContextOf(caller)
  const open = query.open !== 'false'
  const shipmentWhere: Prisma.ShipmentWhereInput = {
    AND: [scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput, ...(query.siteId && isUuid(query.siteId) ? [{ siteId: query.siteId }] : [])],
  }
  const rows = await caller.withClient((client) =>
    client.trackingException.findMany({
      where: { ...(open ? { resolvedAt: null } : {}), shipment: shipmentWhere },
      select: { ...ROW_SELECT, shipment: { select: { id: true, number: true, status: true, siteId: true, carrierName: true, expectedDeliveryAt: true } } },
      orderBy: [{ raisedAt: 'asc' }, { id: 'asc' }],
      take: 201,
    }),
  )
  return {
    problems: rows.slice(0, 200).map((row) => ({
      id: row.id,
      kind: row.kind as TrackingExceptionKind,
      raisedAt: toUtcIso(row.raisedAt),
      resolvedAt: iso(row.resolvedAt),
      taskId: row.taskId,
      shipment: { id: row.shipment.id, number: row.shipment.number, status: row.shipment.status, siteId: row.shipment.siteId, carrierName: row.shipment.carrierName, expectedDeliveryAt: iso(row.shipment.expectedDeliveryAt) },
    })),
    truncated: rows.length > 200,
  }
}

/** shipping.manage: one open problem resolved, once (a note kept on the audit row). Answers the shipment's problems. */
export async function resolveProblem(caller: CommandCaller, shipmentId: string, exceptionId: string, body: { readonly note?: string | undefined }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const known = isUuid(exceptionId) ? await caller.withClient((client) => client.trackingException.findFirst({ where: { id: exceptionId, shipmentId: shipment.id }, select: { id: true } })) : null
  if (!known) throw new NotFoundError('Tracking problem not found.')
  const note = body.note?.trim() ? body.note.trim().slice(0, 500) : null
  await command(caller, { name: 'shipping.resolveTrackingProblem', idempotencyKey, input: { shipmentId, exceptionId, note } }, async (tools) => {
    const done = await resolveInCommand(tools, exceptionId, false, note)
    if (!done) {
      const message = 'This tracking problem was resolved already: it never changes. If the parcel has a new problem, the next carrier news or the daily check raises it again.'
      throw new DomainError('conflict', message, [{ path: exceptionRefusalPath('RESOLVED'), message }])
    }
    return { exceptionId }
  })
  return getShipmentProblems(caller, shipment.id)
}
