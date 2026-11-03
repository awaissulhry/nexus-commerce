import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { holds } from '@nexus/factory-domain/core/permissions'
import { SAFETY_INCIDENTS_MANAGE, SAFETY_INCIDENTS_PEOPLE, SAFETY_INCIDENTS_REPORT, SAFETY_INCIDENTS_VIEW } from '@nexus/factory-domain/safety/incidents/permissions'
import { ANONYMOUS_KINDS, EMERGENCY_NUMBER, INAIL_REMINDER_HOURS, INAIL_RULE, INAIL_RULE_WORDS, INCIDENT_LAW, INCIDENT_LIMITS, PROTECTED_LAW, countdownOf, type IncidentKind, type IncidentStatus } from '@nexus/factory-domain/safety/incidents/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { asTenantSystem } from '../../production/serials/facts'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { assertMay, floorOf, may, officeOf, scopeOf, todayOf } from './access'
import { actionCounts, deadlinesOf, inailSummaryOf, INCIDENT_SELECT, isoOrNull, peopleCounts, photoCounts, reporterOf, userNames, whereOf, type IncidentRow } from './store'
import { actionsOf } from './actions'
import { photosOf } from './files'

/**
 * The incidents' reads (B-W2b-125; design plant.incidents: band countdown chip, deadline banner, tiles, the anonymised list,
 * the record's Report, Actions and Authority notice tabs; floor.incident: the emergency banner, Where?, "Seen by safety"):
 *
 *   GET /safety/incidents              the list (safety.incidents.view): no person, no injury, no filing's type
 *   GET /safety/incidents/counts       the tiles, the critical banner (an INAIL deadline under 24 hours or late) and the chip
 *   GET /safety/incidents/:id          the record (people as counts; the values through ./protected.ts)
 *   GET /safety/incidents/rules        the INAIL rule in plain words with its law, the reminders, the tablet's limits (the
 *                                      Authority notice's "What the law asks", Plant settings' incident rules: read only)
 *   GET /safety/floor/incidents/start  the tablet's screen: 112, the site's first aiders in force, "Here: this station", areas
 *   GET /safety/floor/incidents/:id    a report this tablet sent (or one without a name, by its id): "Seen by safety at …"
 */

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly rows?: 'INJURY' | 'NEAR_MISS' | 'HAZARD' | 'INAIL_DUE' | undefined
  readonly status?: IncidentStatus | 'ALL' | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const placeAsked = (query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }): Prisma.IncidentWhereInput => ({
  ...(query.companyId ? { companyId: query.companyId } : {}),
  ...(query.siteId ? { siteId: query.siteId } : {}),
})

function cursorWhere(cursor: string | undefined): Prisma.IncidentWhereInput {
  if (!cursor) return {}
  const [at, id] = cursor.split('|')
  const date = at ? new Date(at) : null
  if (!date || !Number.isFinite(date.getTime()) || !id || !isUuid(id)) throw new ValidationError('The cursor is not valid.', [{ path: 'query/cursor', message: 'Expected the cursor a page gave.' }])
  return { OR: [{ occurredAt: { lt: date } }, { occurredAt: date, id: { lt: id } }] }
}

/** The list row everyone with the view sees. */
function rowOf(row: IncidentRow, extra: { people: { count: number; injured: number }; actions: { open: number; overdue: number }; inail: ReturnType<typeof inailSummaryOf>; photos: number }) {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as IncidentKind,
    companyId: row.companyId,
    siteId: row.siteId,
    site: { code: row.site.code, name: row.site.name },
    occurredAt: row.occurredAt.toISOString(),
    reportedAt: row.reportedAt.toISOString(),
    reportedVia: row.reportedVia,
    anonymous: row.reporterAnonymous,
    ...whereOf(row),
    severity: row.severity,
    status: row.status as IncidentStatus,
    seen: row.seenAt !== null,
    actionsOpen: extra.actions.open,
    actionsOverdue: extra.actions.overdue,
    people: extra.people,
    inail: extra.inail,
    photos: extra.photos,
    version: row.version,
  }
}

/** GET /safety/incidents. */
export async function listIncidents(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const limit = Math.min(query.limit ?? 50, INCIDENT_LIMITS.page)
  const now = new Date()
  const where: Prisma.IncidentWhereInput = {
    AND: [
      scopeOf(context, SAFETY_INCIDENTS_VIEW) as Prisma.IncidentWhereInput,
      placeAsked(query),
      query.status === 'ALL' ? {} : query.status ? { status: query.status } : { status: { in: ['OPEN', 'CLOSED'] } },
      query.rows === 'INJURY' || query.rows === 'NEAR_MISS' || query.rows === 'HAZARD' ? { kind: query.rows } : {},
      query.rows === 'INAIL_DUE' ? { inailFilings: { some: { status: { in: ['WAITING_CERTIFICATE', 'DUE'] } } } } : {},
      query.from ? { occurredAt: { gte: businessDayRange(query.from).start } } : {},
      query.to ? { occurredAt: { lt: businessDayRange(query.to).end } } : {},
      query.q ? { number: { contains: query.q.trim(), mode: 'insensitive' } } : {},
      cursorWhere(query.cursor),
    ],
  }
  return caller.withClient(async (db) => {
    const rows = await db.incident.findMany({ where, select: INCIDENT_SELECT, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const ids = page.map((row) => row.id)
    const [people, deadlines, actions, photos] = await Promise.all([peopleCounts(db, ids), deadlinesOf(db, ids, now), actionCounts(db, ids, todayOf(now)), photoCounts(db, ids)])
    const last = page[page.length - 1]
    return {
      now: now.toISOString(),
      incidents: page.map((row) => rowOf(row, { people: people.get(row.id) ?? { count: 0, injured: 0 }, actions: actions.get(row.id) ?? { open: 0, overdue: 0 }, inail: inailSummaryOf(deadlines.get(row.id) ?? []), photos: photos.get(row.id) ?? 0 })),
      nextCursor: rows.length > limit && last ? `${last.occurredAt.toISOString()}|${last.id}` : null,
      canReport: holds(actorOf(context), SAFETY_INCIDENTS_REPORT),
    }
  })
}

/** GET /safety/incidents/counts: the tiles, the critical banner and the band's chip. */
export async function incidentCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const context = officeOf(caller)
  const now = new Date()
  const today = todayOf(now)
  const monthStart = businessDayRange(`${today.slice(0, 8)}01`).start
  const scope: Prisma.IncidentWhereInput = { AND: [scopeOf(context, SAFETY_INCIDENTS_VIEW) as Prisma.IncidentWhereInput, placeAsked(query)] }
  return caller.withClient(async (db) => {
    const [openIncidents, nearMissesThisMonth, hazardsOpen, inailOpen, actionsOverdue, due] = await Promise.all([
      db.incident.count({ where: { AND: [scope, { status: 'OPEN' }] } }),
      db.incident.count({ where: { AND: [scope, { kind: 'NEAR_MISS', status: { not: 'CANCELLED' }, occurredAt: { gte: monthStart } }] } }),
      db.incident.count({ where: { AND: [scope, { kind: 'HAZARD', status: 'OPEN' }] } }),
      db.inailFiling.count({ where: { status: { in: ['WAITING_CERTIFICATE', 'DUE'] }, incident: scope } }),
      db.incidentAction.count({ where: { status: 'OPEN', dueOn: { lt: new Date(`${today}T00:00:00.000Z`) }, incident: scope } }),
      // The DUE filings, nearest first: the banner (under 24 hours or late) and the chip (the nearest of all).
      db.inailFiling.findMany({ where: { status: 'DUE', incident: scope }, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: 50, select: { dueAt: true, incident: { select: { id: true, number: true } } } }),
    ])
    const deadlines = due.filter((row) => row.dueAt !== null).map((row) => ({ incidentId: row.incident.id, number: row.incident.number, countdown: countdownOf(row.dueAt!, now) }))
    const urgent = deadlines.filter((deadline) => deadline.countdown.late || deadline.countdown.under24h)
    return {
      now: now.toISOString(),
      tiles: { openIncidents, inailOpen, nearMissesThisMonth, hazardsOpen, actionsOverdue },
      /** The critical banner (design plant.incidents "Deadline": hidden when none): the most urgent one, and how many more. */
      deadline: urgent[0] ? { ...urgent[0], more: urgent.length - 1 } : null,
      /** The band's chip: the nearest INAIL deadline of all. */
      next: deadlines[0] ?? null,
      law: INCIDENT_LAW,
    }
  })
}

/** The record (office). */
async function recordOf(caller: CommandCaller, incidentId: string) {
  const context = officeOf(caller)
  if (!isUuid(incidentId)) throw new NotFoundError('Incident not found.')
  const now = new Date()
  return caller.withClient(async (db) => {
    const row = await db.incident.findUnique({ where: { id: incidentId }, select: INCIDENT_SELECT })
    if (!row) throw new NotFoundError('Incident not found.')
    assertMay(context, SAFETY_INCIDENTS_VIEW, row)
    const [people, deadlines, actions, photos, gate] = await Promise.all([peopleCounts(db, [row.id]), deadlinesOf(db, [row.id], now), actionsOf(db, row.id, todayOf(now)), photosOf(db, row.id), workerGateFor(db, row.siteId)])
    const users = await userNames(db, [row.reportedById, row.seenById, row.closedById, row.cancelledById, ...actions.map((action) => action.ownerId), ...actions.map((action) => action.doneById)])
    const workers = new Map<string, string>()
    if (gate.open && row.reportedByWorkerId) {
      const worker = await db.worker.findUnique({ where: { id: row.reportedByWorkerId }, select: { displayName: true } })
      if (worker) workers.set(row.reportedByWorkerId, worker.displayName)
    }
    const devices = new Map<string, string>()
    if (row.deviceId) {
      const device = await db.device.findUnique({ where: { id: row.deviceId }, select: { name: true } })
      if (device) devices.set(row.deviceId, device.name)
    }
    const request = row.maintenanceRequestId ? await db.maintenanceRequest.findUnique({ where: { id: row.maintenanceRequestId }, select: { id: true, status: true, unsafe: true } }) : null
    const count = people.get(row.id) ?? { count: 0, injured: 0 }
    const canManage = may(context, SAFETY_INCIDENTS_MANAGE, row)
    const canPeople = may(context, SAFETY_INCIDENTS_PEOPLE, row)
    return {
      now: now.toISOString(),
      incident: {
        id: row.id,
        number: row.number,
        kind: row.kind as IncidentKind,
        companyId: row.companyId,
        siteId: row.siteId,
        site: { code: row.site.code, name: row.site.name },
        occurredAt: row.occurredAt.toISOString(),
        reportedAt: row.reportedAt.toISOString(),
        what: row.what,
        ...whereOf(row),
        immediateAction: row.immediateAction,
        maintenanceRequest: request ? { id: request.id, status: request.status, unsafe: request.unsafe } : null,
        severity: row.severity,
        status: row.status as IncidentStatus,
        reportedVia: row.reportedVia,
        reporter: reporterOf(row, { users, workers, devices }, gate.open),
        seen: row.seenAt ? { at: row.seenAt.toISOString(), by: row.seenById ? (users.get(row.seenById) ?? null) : null } : null,
        closed: row.closedAt ? { at: row.closedAt.toISOString(), by: row.closedById ? (users.get(row.closedById) ?? null) : null } : null,
        cancelled: row.cancelledAt ? { at: row.cancelledAt.toISOString(), by: row.cancelledById ? (users.get(row.cancelledById) ?? null) : null, reason: row.cancelReason } : null,
        /** "One person involved": everyone with the view sees the count; the names and injuries through POST …/people/open. */
        people: { ...count, canOpen: canPeople && count.count > 0 },
        actions: actions.map(({ ownerId, doneById, ...action }) => ({ ...action, owner: ownerId ? { id: ownerId, name: users.get(ownerId) ?? '' } : null, doneBy: doneById ? (users.get(doneById) ?? null) : null })),
        inail: { deadlines: deadlines.get(row.id) ?? [], canOpen: canPeople && (deadlines.get(row.id) ?? []).length > 0, law: INCIDENT_LAW, rule: ruleOf() },
        photos,
        version: row.version,
        canManage,
        canPeople,
        canClose: canManage && row.status === 'OPEN',
        law: { incident: INCIDENT_LAW, people: PROTECTED_LAW },
      },
    }
  })
}

/** The INAIL rule as the plan gives it (not a setting: the law's numbers), with the module's own reminders. */
const ruleOf = () => ({ law: INCIDENT_LAW, ...INAIL_RULE, words: INAIL_RULE_WORDS })

/** GET /safety/incidents/rules: what the law asks and how Nexus keeps the deadline, read only (nothing here is a setting). */
export function incidentRules(caller: CommandCaller) {
  officeOf(caller)
  return {
    rule: ruleOf(),
    reminders: { hoursBefore: [...INAIL_REMINDER_HOURS] },
    floor: { anonymousKinds: [...ANONYMOUS_KINDS], photos: INCIDENT_LIMITS.floorPhotos, photoMinutes: INCIDENT_LIMITS.floorPhotoMinutes, emergencyNumber: EMERGENCY_NUMBER },
    law: { incident: INCIDENT_LAW, people: PROTECTED_LAW },
  }
}

/** GET /safety/incidents/:id. */
export const incidentRecord = (caller: CommandCaller, incidentId: string) => recordOf(caller, incidentId)

/** GET /safety/floor/incidents/start: what the tablet's screen needs before the first tap. */
export async function floorStart(request: FastifyRequest) {
  const context = floorOf(request)
  const today = businessDate(new Date())
  const local = await request.withClient(async (db) => {
    const device = await db.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true } })
    const station = device?.stationId ? await db.station.findUnique({ where: { id: device.stationId }, select: { id: true, code: true, name: true } }) : null
    const machines = station ? await db.machine.findMany({ where: { stationId: station.id, siteId: context.siteId }, select: { id: true, assetNumber: true }, orderBy: { assetNumber: 'asc' }, take: 20 }) : []
    const areas = await db.orgArea.findMany({ where: { siteId: context.siteId, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 100 })
    const site = await db.site.findUnique({ where: { id: context.siteId }, select: { companyId: true } })
    return { station, machines, areas, companyId: site?.companyId ?? null }
  })
  // The site's first aiders in force (the organisation register: names for the notice board; the floor reads no appointment).
  const day = new Date(`${today}T00:00:00.000Z`)
  const firstAiders = local.companyId
    ? await asTenantSystem(request).withClient((db) =>
        db.safetyAppointment.findMany({
          where: { companyId: local.companyId!, role: 'FIRST_AID', OR: [{ siteId: context.siteId }, { siteId: null }], fromDate: { lte: day }, AND: [{ OR: [{ untilDate: null }, { untilDate: { gte: day } }] }] },
          select: { outsideName: true, employee: { select: { displayName: true } }, shiftPattern: { select: { name: true } } },
          orderBy: [{ fromDate: 'asc' }, { id: 'asc' }],
          take: 20,
        }),
      )
    : []
  return {
    emergency: { number: EMERGENCY_NUMBER, firstAiders: firstAiders.map((row) => ({ name: row.employee?.displayName ?? row.outsideName ?? '', shift: row.shiftPattern?.name ?? null })) },
    here: local.station ? { station: local.station, machines: local.machines } : null,
    areas: local.areas,
    anonymousKinds: [...ANONYMOUS_KINDS],
  }
}

/** GET /safety/floor/incidents/:id: "Seen by safety at …" for a report this tablet sent in the last days (or one without a name, by its id). */
export async function floorIncident(request: FastifyRequest, incidentId: string) {
  const context = floorOf(request)
  if (!isUuid(incidentId)) throw new NotFoundError('Report not found.')
  const since = new Date(Date.now() - INCIDENT_LIMITS.floorReadDays * 86_400_000)
  const row = await asTenantSystem(request).withClient((db) =>
    db.incident.findFirst({
      where: { id: incidentId, siteId: context.siteId, reportedVia: 'FLOOR', reportedAt: { gte: since }, OR: [{ deviceId: context.deviceId }, { reporterAnonymous: true }] },
      select: { id: true, number: true, kind: true, seenAt: true, status: true },
    }),
  )
  if (!row) throw new NotFoundError('Report not found.')
  return { incident: { id: row.id, number: row.number, kind: row.kind as IncidentKind, seenAt: isoOrNull(row.seenAt), closed: row.status === 'CLOSED' } }
}
