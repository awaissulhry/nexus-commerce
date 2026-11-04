import { newId } from '@nexus/factory-domain/core/ids'
import { INCIDENT_LIMITS, lockHazardWords } from '@nexus/factory-domain/safety/incidents/rules'
import { command, type CommandCaller } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { insertReportInCommand } from './report'

/**
 * A machine locked as unsafe opens a hazard report (B-W2b-125 on B-W2b-96's seam; design plant.incidents "immediate actions
 * (e.g. machine locked → link)"; plant.settings "hazard report on lock"): the worker's handler `safety.hazardOnLock` listens to
 * maintenance_request.locked and, when the event's `hazardReport` is true (the site's PlantSettings.hazardReportOnLock), opens
 * ONE hazard incident in a system command keyed `incident-on-lock:<request>`: OFFICE, reported by the system actor (no person
 * reported it here; the request names who locked it), the machine as where, the request linked, "machine locked" as the
 * immediate action, in the company's language. A lock already reported (an incident naming the request) opens nothing again.
 */

export interface LockedPayload {
  readonly requestId: string
  readonly machineId: string
  readonly assetNumber: string
  readonly hazardReport: boolean
}

/** Opens the hazard report of a lock; answers its id, or null (no report asked, or one exists). */
export async function hazardOnLock(caller: CommandCaller, payload: LockedPayload, cause: { readonly causationId?: string } = {}): Promise<string | null> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'system' || !payload.hazardReport) return null
  const found = await caller.withClient(async (db) => {
    const request = await db.maintenanceRequest.findUnique({ where: { id: payload.requestId }, select: { id: true, companyId: true, siteId: true, machineId: true, description: true, unsafe: true, symptom: { select: { labelIt: true, labelEn: true } } } })
    if (!request || !request.unsafe) return null
    const existing = await db.incident.findFirst({ where: { maintenanceRequestId: request.id }, select: { id: true } })
    if (existing) return null
    const company = await db.company.findUnique({ where: { id: request.companyId }, select: { locale: true } })
    return { request, locale: company?.locale ?? 'it' }
  })
  if (!found) return null
  const { request, locale } = found
  const italian = !locale.toLowerCase().startsWith('en')
  const problem = request.description ?? (request.symptom ? (italian ? request.symptom.labelIt : request.symptom.labelEn) : null)
  const words = lockHazardWords(locale, payload.assetNumber, problem)
  const id = newId()
  const { result } = await command(caller, { name: 'safety.hazardOnLock', idempotencyKey: `incident-on-lock:${request.id}`, input: payload, ...(cause.causationId ? { causationId: cause.causationId } : {}) }, async (tools) => {
    const again = await tools.tx.incident.findFirst({ where: { maintenanceRequestId: request.id }, select: { id: true } })
    if (again) {
      tools.audit({ action: 'safety.hazardOnLock', recordType: 'Incident', recordId: again.id, companyId: request.companyId, siteId: request.siteId, after: { reportedAlready: true, requestId: request.id } })
      return { incidentId: again.id }
    }
    const made = await insertReportInCommand(
      tools,
      {
        id,
        companyId: request.companyId,
        siteId: request.siteId,
        kind: 'HAZARD',
        occurredAt: tools.now,
        what: words.what.slice(0, INCIDENT_LIMITS.what),
        where: { machineId: request.machineId },
        immediateAction: words.immediateAction,
        maintenanceRequestId: request.id,
        via: 'OFFICE',
        anonymous: false,
        reportedByWorkerId: null,
        // No person reported it here: the system actor (the record says "opened from a machine lock"; the request names who locked).
        reportedById: SYSTEM_ACTOR_ID,
        deviceId: null,
        createdById: null,
        people: [],
      },
      request.id,
    )
    return { incidentId: made.id }
  })
  return result.incidentId
}

export function incidentHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'safety.hazardOnLock',
      events: ['maintenance_request.locked'],
      async handle(event, { caller }) {
        await hazardOnLock(caller, event.payload as LockedPayload, { causationId: event.eventId })
      },
    }),
  ]
}
