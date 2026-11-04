import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { SAFETY_INCIDENTS_MANAGE, SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { closeRefusal, hasWhere, INCIDENT_LIMITS, refusalOf, type IncidentKind, type IncidentSeverity, type IncidentStatus } from '@nexus/factory-domain/safety/incidents/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertVersion } from '../../people/employees/access'
import { actorIdOf, assertMay, assertMayWrite, officeOf, refuse } from './access'

/**
 * An incident's own writes (B-W2b-125; design plant.incidents record "EditModeBar for safety roles", pop-up "Close incident"
 * held while actions are open or a filing is due; floor.incident "The safety officer opens it → 'Seen by safety'"), office,
 * safety.incidents.manage over the incident, each one command at the version the screen read:
 *
 *   PATCH /safety/incidents/:id          kind, when, what, where, immediate action, the machine request, severity (OPEN only)
 *   POST  /safety/incidents/:id/seen     "seen by safety" (once; a second call answers the first)
 *   POST  /safety/incidents/:id/close    held while an action is open or an INAIL filing waits
 *   POST  /safety/incidents/:id/reopen   CLOSED → OPEN, nothing else changes
 *   POST  /safety/incidents/:id/cancel   a duplicate or a mistake, with the reason (held as close is); final
 *
 * The incident's row is locked and its version checked inside the command, before any write: every refusal is in words (the
 * guard's own refusal would be a 500).
 */

const MANAGE_WORDS = 'Incidents are kept by the safety roles (safety.incidents.manage).'

const LOCK_SELECT = { id: true, number: true, companyId: true, siteId: true, kind: true, status: true, version: true, seenAt: true, seenById: true, occurredAt: true, reportedAt: true, areaId: true, stationId: true, machineId: true, place: true } as const

async function placeOf(caller: CommandCaller, incidentId: string) {
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const row = await caller.withClient((db) => db.incident.findUnique({ where: { id: incidentId }, select: { companyId: true, siteId: true, seenAt: true, seenById: true, number: true, version: true } }))
  if (!row) throw new NotFoundError('Incident not found.')
  return row
}

async function locked(tx: CommandTx, incidentId: string, version: number | null) {
  await tx.$queryRaw`SELECT id FROM "Incident" WHERE id = ${incidentId}::uuid FOR UPDATE`
  const row = await tx.incident.findUnique({ where: { id: incidentId }, select: LOCK_SELECT })
  if (!row) throw new NotFoundError('Incident not found.')
  if (version !== null) assertVersion('incident', row.version, version)
  return row
}

type Locked = Awaited<ReturnType<typeof locked>>

function changed(tools: CommandTools, row: Locked, change: 'EDITED' | 'CLOSED' | 'REOPENED' | 'CANCELLED' | 'PEOPLE_CHANGED', status: IncidentStatus): void {
  tools.emit({ type: 'incident.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { incidentId: row.id, number: row.number, change, status } })
}

async function onIncident<T>(caller: CommandCaller, incidentId: string, name: 'safety.editIncident' | 'safety.closeIncident' | 'safety.reopenIncident' | 'safety.cancelIncident', input: { readonly version: number }, idempotencyKey: string | undefined, work: (tools: CommandTools, row: Locked) => Promise<T>) {
  const context = officeOf(caller)
  const place = await placeOf(caller, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, place)
  assertMayWrite(context, SAFETY_INCIDENTS_MANAGE, place, MANAGE_WORDS)
  const { result, replayed } = await command(caller, { name, idempotencyKey, input: { incidentId, ...input } }, async (tools) => work(tools, await locked(tools.tx, incidentId, input.version)))
  return { ...result, replayed }
}

export interface EditBody {
  readonly version: number
  readonly kind?: IncidentKind | undefined
  readonly occurredAt?: string | undefined
  readonly what?: string | undefined
  readonly areaId?: string | null | undefined
  readonly stationId?: string | null | undefined
  readonly machineId?: string | null | undefined
  readonly place?: string | null | undefined
  readonly immediateAction?: string | null | undefined
  readonly maintenanceRequestId?: string | null | undefined
  readonly severity?: IncidentSeverity | null | undefined
}

/** PATCH /safety/incidents/:id. */
export function editIncident(caller: CommandCaller, incidentId: string, body: EditBody, idempotencyKey?: string) {
  return onIncident(caller, incidentId, 'safety.editIncident', body, idempotencyKey, async (tools, row) => {
    const { tx, now } = tools
    if (row.status !== 'OPEN') refuse(refusalOf('NOT_OPEN'))
    const where = {
      areaId: body.areaId !== undefined ? body.areaId : row.areaId,
      stationId: body.stationId !== undefined ? body.stationId : row.stationId,
      machineId: body.machineId !== undefined ? body.machineId : row.machineId,
      place: body.place !== undefined ? body.place?.trim() || null : row.place,
    }
    if (!hasWhere(where)) refuse(refusalOf('WHERE_MISSING', 'where'))
    const wrong =
      (body.areaId && !(await tx.orgArea.findFirst({ where: { id: body.areaId, siteId: row.siteId }, select: { id: true } }))) ||
      (body.stationId && !(await tx.station.findFirst({ where: { id: body.stationId, siteId: row.siteId }, select: { id: true } }))) ||
      (body.machineId && !(await tx.machine.findFirst({ where: { id: body.machineId, siteId: row.siteId }, select: { id: true } })))
    if (wrong) refuse(refusalOf('WHERE_OTHER_SITE', 'where'))
    if (body.maintenanceRequestId && !(await tx.maintenanceRequest.findFirst({ where: { id: body.maintenanceRequestId, siteId: row.siteId }, select: { id: true } }))) refuse(refusalOf('REQUEST_OTHER_SITE', 'maintenanceRequestId'))
    let occurredAt: Date | undefined
    if (body.occurredAt !== undefined) {
      occurredAt = new Date(body.occurredAt)
      if (!Number.isFinite(occurredAt.getTime())) throw new ValidationError('The time is not valid.', [{ path: 'body/occurredAt', message: 'Expected a time.' }])
      if (occurredAt.getTime() > row.reportedAt.getTime()) refuse(refusalOf('OCCURRED_IN_FUTURE', 'occurredAt'))
    }
    if (body.kind !== undefined && body.kind !== 'INJURY' && row.kind === 'INJURY') {
      const injured = await tx.incidentPerson.count({ where: { incidentId: row.id, involvement: 'INJURED' } })
      if (injured > 0) refuse(refusalOf('STAYS_INJURY', 'kind'))
    }
    const data = {
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      ...(body.what !== undefined ? { what: body.what.trim().slice(0, INCIDENT_LIMITS.what) } : {}),
      ...(body.areaId !== undefined ? { areaId: body.areaId } : {}),
      ...(body.stationId !== undefined ? { stationId: body.stationId } : {}),
      ...(body.machineId !== undefined ? { machineId: body.machineId } : {}),
      ...(body.place !== undefined ? { place: where.place?.slice(0, INCIDENT_LIMITS.place) ?? null } : {}),
      ...(body.immediateAction !== undefined ? { immediateAction: body.immediateAction?.trim().slice(0, INCIDENT_LIMITS.immediateAction) || null } : {}),
      ...(body.maintenanceRequestId !== undefined ? { maintenanceRequestId: body.maintenanceRequestId } : {}),
      ...(body.severity !== undefined ? { severity: body.severity } : {}),
    }
    if (Object.keys(data).length === 0) throw new ValidationError('Change at least one thing.', [{ path: 'body', message: 'Nothing to change.' }])
    await tx.incident.update({ where: { id: row.id }, data: { ...data, version: row.version + 1, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'safety.editIncident', recordType: 'Incident', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { ...data, ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}) } })
    changed(tools, row, 'EDITED', 'OPEN')
    return { incident: { id: row.id, version: row.version + 1 } }
  })
}

/** POST /safety/incidents/:id/seen: once; a second call answers the first (no write). */
export async function markSeen(caller: CommandCaller, incidentId: string, idempotencyKey?: string) {
  const context = officeOf(caller)
  const place = await placeOf(caller, incidentId)
  assertMay(context, SAFETY_INCIDENTS_VIEW, place)
  assertMayWrite(context, SAFETY_INCIDENTS_MANAGE, place, MANAGE_WORDS)
  if (place.seenAt) return { incident: { id: incidentId, version: place.version, seenAt: place.seenAt.toISOString(), first: false }, replayed: false }
  const { result, replayed } = await command(caller, { name: 'safety.seeIncident', idempotencyKey, input: { incidentId } }, async (tools) => {
    const row = await locked(tools.tx, incidentId, null)
    if (row.seenAt) {
      tools.audit({ action: 'safety.seeIncident', recordType: 'Incident', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { seenBefore: row.seenAt.toISOString() } })
      return { incident: { id: row.id, version: row.version, seenAt: row.seenAt.toISOString(), first: false } }
    }
    // A closed or cancelled incident changes nothing (the guard): one never seen stays so.
    if (row.status !== 'OPEN') refuse(refusalOf('NOT_OPEN'))
    await tools.tx.incident.update({ where: { id: row.id }, data: { seenAt: tools.now, seenById: actorIdOf(tools.context), version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.seeIncident', recordType: 'Incident', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { seenAt: tools.now.toISOString() } })
    tools.emit({ type: 'incident.seen', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { incidentId: row.id, number: row.number, seenAt: tools.now.toISOString() } })
    return { incident: { id: row.id, version: row.version + 1, seenAt: tools.now.toISOString(), first: true } }
  })
  return { ...result, replayed }
}

async function holds(tx: CommandTx, incidentId: string) {
  const [actionsOpen, filingsWaiting] = await Promise.all([
    tx.incidentAction.count({ where: { incidentId, status: 'OPEN' } }),
    tx.inailFiling.count({ where: { incidentId, status: { in: ['WAITING_CERTIFICATE', 'DUE'] } } }),
  ])
  return { actionsOpen, filingsWaiting }
}

/** POST /safety/incidents/:id/close. */
export function closeIncident(caller: CommandCaller, incidentId: string, body: { readonly version: number }, idempotencyKey?: string) {
  return onIncident(caller, incidentId, 'safety.closeIncident', body, idempotencyKey, async (tools, row) => {
    refuse(closeRefusal({ status: row.status as IncidentStatus, ...(await holds(tools.tx, row.id)) }))
    await tools.tx.incident.update({ where: { id: row.id }, data: { status: 'CLOSED', closedAt: tools.now, closedById: actorIdOf(tools.context), version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.closeIncident', recordType: 'Incident', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: 'CLOSED' } })
    changed(tools, row, 'CLOSED', 'CLOSED')
    return { incident: { id: row.id, version: row.version + 1, status: 'CLOSED' as const } }
  })
}

/** POST /safety/incidents/:id/reopen: CLOSED → OPEN; nothing else of it changes in the same update (the guard's rule). */
export function reopenIncident(caller: CommandCaller, incidentId: string, body: { readonly version: number }, idempotencyKey?: string) {
  return onIncident(caller, incidentId, 'safety.reopenIncident', body, idempotencyKey, async (tools, row) => {
    if (row.status !== 'CLOSED') refuse(refusalOf('NOT_CLOSED'))
    await tools.tx.incident.update({ where: { id: row.id }, data: { status: 'OPEN', closedAt: null, closedById: null, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.reopenIncident', recordType: 'Incident', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'CLOSED' }, after: { status: 'OPEN' } })
    changed(tools, row, 'REOPENED', 'OPEN')
    return { incident: { id: row.id, version: row.version + 1, status: 'OPEN' as const } }
  })
}

/** POST /safety/incidents/:id/cancel: a duplicate or a mistake; held like close (an open action or a waiting filing); final. */
export function cancelIncident(caller: CommandCaller, incidentId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  return onIncident(caller, incidentId, 'safety.cancelIncident', body, idempotencyKey, async (tools, row) => {
    refuse(closeRefusal({ status: row.status as IncidentStatus, ...(await holds(tools.tx, row.id)) }))
    const reason = body.reason.trim().slice(0, INCIDENT_LIMITS.reason)
    await tools.tx.incident.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelledById: actorIdOf(tools.context), cancelReason: reason, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'safety.cancelIncident', recordType: 'Incident', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, reason })
    changed(tools, row, 'CANCELLED', 'CANCELLED')
    return { incident: { id: row.id, version: row.version + 1, status: 'CANCELLED' as const } }
  })
}

