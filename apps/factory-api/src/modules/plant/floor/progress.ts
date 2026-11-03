import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PLANT_JOBS_WORK, PLANT_REPORT } from '@nexus/factory-domain/plant/permissions'
import { OPEN_REQUEST_STATUSES } from '@nexus/factory-domain/plant/rules'
import { floorAcknowledgeRefusal, onTheWayRefusal } from '@nexus/factory-domain/plant/requests/progress'
import type { CommandCaller } from '../../../core/command'
import { asTenantSystem } from '../../production/bundles/codes'
import { assertMay, floorOf, may, scopeOf } from '../access'
import { mediaOf } from '../requests/files'
import { readRequest, REQUEST_COLUMNS, requestViews, type RequestRow } from '../store'

/**
 * What the floor sees of machine requests after the report (B-W2b-96; QHS-179, QHS-180; design floor.machine "Progress",
 * "My jobs"), floor only, nothing that names a person:
 *
 *   GET /plant/floor/requests              the station's requests still under way (plant.report): reported from this
 *                                          tablet's station (or, a tablet without one, from this tablet) in the last
 *                                          7 days, not closed and not yet confirmed working, newest first, each with its
 *                                          progress (acknowledged, on the way, fixed) and whether the station confirms now
 *   GET /plant/floor/requests/:requestId   one request of the site: its progress, its photos and voice notes, what this
 *                                          person may do now
 *   GET /plant/floor/queue                 the technician's queue (plant.jobs.work): the site's open requests, the ones
 *                                          routed or escalated to this technician first (their employee, or a team they
 *                                          are in now), then the ones that lock a machine, then the oldest
 */

const LOOK_BACK_DAYS = 7
const MAX_ROWS = 100

/** The device's station (null: a tablet without one). */
async function deviceStation(caller: CommandCaller, deviceId: string): Promise<string | null> {
  return (await caller.withClient((client) => client.device.findUnique({ where: { id: deviceId }, select: { stationId: true } })))?.stationId ?? null
}

/** GET /plant/floor/requests. */
export async function stationRequests(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = new Date()
  const stationId = await deviceStation(caller, context.deviceId)
  return caller.withClient(async (client) => {
    const rows = await client.maintenanceRequest.findMany({
      where: {
        AND: [
          scopeOf(context, PLANT_REPORT) as Prisma.MaintenanceRequestWhereInput,
          stationId ? { stationId } : { deviceId: context.deviceId },
          { reportedAt: { gte: new Date(now.getTime() - LOOK_BACK_DAYS * 86_400_000) } },
          { status: { not: 'CLOSED' } },
          { confirmedWorksAt: null },
        ],
      },
      orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }],
      take: MAX_ROWS,
      select: REQUEST_COLUMNS,
    })
    return { stationId, requests: await requestViews(client, rows, context, now) }
  })
}

/** The technician's employee record and the teams they are in today (read as the tenant's system: the floor reads no People). */
async function technicianOf(caller: CommandCaller, workerId: string): Promise<{ readonly employeeId: string | null; readonly teamIds: readonly string[] }> {
  const context = floorOf(caller)
  return asTenantSystem(caller, context).withClient(async (client) => {
    const worker = await client.worker.findUnique({ where: { id: workerId }, select: { employeeId: true } })
    if (!worker?.employeeId) return { employeeId: null, teamIds: [] }
    const today = new Date(`${businessDate(new Date())}T00:00:00.000Z`)
    const members = await client.teamMember.findMany({ where: { employeeId: worker.employeeId, since: { lte: today }, OR: [{ until: null }, { until: { gte: today } }] }, select: { teamId: true } })
    return { employeeId: worker.employeeId, teamIds: members.map((member) => member.teamId) }
  })
}

/** Routed or escalated to this technician (their employee record, or a team they are in). */
function toMe(row: RequestRow, me: { readonly employeeId: string | null; readonly teamIds: readonly string[] }, escalatedTo: ReadonlyMap<string, readonly string[]>): boolean {
  if (row.routedTeamId !== null && me.teamIds.includes(row.routedTeamId)) return true
  if (me.employeeId === null) return false
  return row.routedEmployeeId === me.employeeId || (escalatedTo.get(row.id) ?? []).includes(me.employeeId)
}

/** GET /plant/floor/queue. */
export async function technicianQueue(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = new Date()
  const me = await technicianOf(caller, context.actorId)
  return caller.withClient(async (client) => {
    const rows = await client.maintenanceRequest.findMany({
      where: { AND: [scopeOf(context, PLANT_JOBS_WORK) as Prisma.MaintenanceRequestWhereInput, { status: { in: [...OPEN_REQUEST_STATUSES] } }] },
      orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
      take: MAX_ROWS,
      select: REQUEST_COLUMNS,
    })
    // Whom each escalated request went to: its rule's people up to its level.
    const ruleIds = [...new Set(rows.filter((row) => row.escalationLevel > 0 && row.routingRuleId).map((row) => row.routingRuleId!))]
    const rules = ruleIds.length === 0 ? [] : await client.requestRoutingRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, escalateToId: true, escalateAgainToId: true } })
    const escalatedTo = new Map<string, string[]>()
    for (const row of rows) {
      const rule = rules.find((entry) => entry.id === row.routingRuleId)
      if (!rule || row.escalationLevel === 0) continue
      escalatedTo.set(row.id, [rule.escalateToId, row.escalationLevel >= 2 ? rule.escalateAgainToId : null].filter((id): id is string => id !== null))
    }
    const mine = new Set(rows.filter((row) => toMe(row, me, escalatedTo)).map((row) => row.id))
    const rank = (row: RequestRow) => (mine.has(row.id) ? 0 : 2) + (row.unsafe && row.signedSafeAt === null ? 0 : 1)
    const sorted = [...rows].sort((a, b) => rank(a) - rank(b))
    const views = await requestViews(client, sorted, context, now)
    return {
      requests: views.map((view) => ({
        request: view,
        toMe: mine.has(view.id),
        canAcknowledge: floorAcknowledgeRefusal({ status: view.status, acknowledgedAt: view.acknowledgedAt ? new Date(view.acknowledgedAt) : null }) === null,
        canGo: onTheWayRefusal({ status: view.status, onTheWayAt: view.progress.onTheWayAt ? new Date(view.progress.onTheWayAt) : null }) === null,
      })),
    }
  })
}

/** GET /plant/floor/requests/:requestId. */
export async function floorRequest(caller: CommandCaller, requestId: string) {
  const context = floorOf(caller)
  const now = new Date()
  return caller.withClient(async (client) => {
    const row = isUuid(requestId) ? await readRequest(client, requestId) : null
    if (!row) throw new NotFoundError('Request not found.')
    assertMay(context, PLANT_REPORT, row, 'Request')
    const [request] = await requestViews(client, [row], context, now)
    const technician = may(context, PLANT_JOBS_WORK, row)
    return {
      request: request!,
      files: await mediaOf(client, 'MaintenanceRequest', row.id),
      canAcknowledge: technician && floorAcknowledgeRefusal(row) === null,
      canGo: technician && onTheWayRefusal(row) === null,
      canConfirm: request!.progress.canConfirm,
    }
  })
}
