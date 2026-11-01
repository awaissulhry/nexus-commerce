import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCTION_CALLS_ANSWER, PRODUCTION_CALLS_VIEW } from '@nexus/factory-domain/production/calls/permissions'
import { CALL_LIMITS, callsByHour, median, OPEN_CALL_STATUSES, secondsOpen, stationCallState, type CallKind, type CallStatus, type CallTile, type CallView } from '@nexus/factory-domain/production/calls/rules'
import type { CommandCaller } from '../../../core/command'
import { assertMay, contextOf, may, officeOf, siteScopeOf, type CallContext } from './access'
import { answeredOf, CALL_COLUMNS, callRecord, callViews, devicePlaceOf, readCall, scopeOfCall, siteOf, type Reader } from './store'

/**
 * The reads of help calls (B-W2b-35; MES-144, MES-145, MES-147; design production.calls SCR-142 "Call tiles", "Calls",
 * "Calls by hour", the call's DetailModal; floor.supervisor "Calls", "Stations"; floor.display "Stations"):
 *
 *   GET /production/calls                 the inbox (production.calls.view): the open calls oldest first, or the closed /
 *                                         every call newest first; by site, line, station, type, kind, status, tile, days
 *   GET /production/calls/counts          the tiles: open, waiting over 5 minutes, answered today, and today's median
 *                                         response time (per site and line, never per person)
 *   GET /production/calls/by-hour         a site's day: calls per hour by kind and line, each kind's median response time
 *   GET /production/calls/:callId         one call: its timeline and who took each step, the caller where the site names
 *                                         workers, what it led to, the waiting booked
 *   GET /production/calls/board           a line's stations with their call state and the line's open calls to answer (the
 *                                         line view, the line TV; office and floor): no names, no output per station (F2)
 *
 * Calls carry their site, not their company: the lists keep to the sites the caller's grants reach.
 */

const OPEN = [...OPEN_CALL_STATUSES] as CallStatus[]

/** The ids of the sites the permission reaches (a floor device: its own). */
async function sitesInScope(db: Reader, context: CallContext, permission: typeof PRODUCTION_CALLS_VIEW): Promise<string[]> {
  return (await db.site.findMany({ where: siteScopeOf(context, permission) as Prisma.SiteWhereInput, select: { id: true } })).map((site) => site.id)
}

/** The time zone of the days asked: the site's, else the business zone. */
async function zoneOf(db: Reader, siteId: string | undefined): Promise<string> {
  return siteId ? ((await siteOf(db, siteId))?.timezone ?? BUSINESS_TIME_ZONE) : BUSINESS_TIME_ZONE
}

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly stationId?: string | undefined
  readonly typeId?: string | undefined
  readonly kind?: readonly CallKind[] | undefined
  readonly status?: readonly CallStatus[] | undefined
  readonly view: CallView
  readonly tile?: CallTile | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** A tile's rows (the same filters the counts use). */
function tileWhere(tile: CallTile, now: Date, today: { start: Date; end: Date }): Prisma.HelpCallWhereInput {
  switch (tile) {
    case 'OPEN':
      return { status: { in: OPEN } }
    case 'WAITING':
      return { status: { in: ['SENT', 'SEEN'] }, sentAt: { lte: new Date(now.getTime() - CALL_LIMITS.waitingMinutes * 60_000) } }
    case 'ANSWERED_TODAY':
      return { seenAt: { not: null }, sentAt: { gte: today.start, lt: today.end } }
  }
}

/** GET /production/calls. */
export async function listCalls(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const sites = await sitesInScope(db, context, PRODUCTION_CALLS_VIEW)
    const zone = await zoneOf(db, query.siteId)
    const filters: Prisma.HelpCallWhereInput[] = [{ siteId: { in: query.siteId ? sites.filter((id) => id === query.siteId) : sites } }]
    if (query.lineId) filters.push({ lineId: query.lineId })
    if (query.stationId) filters.push({ stationId: query.stationId })
    if (query.typeId) filters.push({ typeId: query.typeId })
    if (query.kind && query.kind.length > 0) filters.push({ type: { kind: { in: [...query.kind] } } })
    if (query.status && query.status.length > 0) filters.push({ status: { in: [...query.status] } })
    if (query.view === 'open') filters.push({ status: { in: OPEN } })
    if (query.view === 'closed') filters.push({ status: { in: ['SOLVED', 'CANCELLED'] } })
    if (query.tile) filters.push(tileWhere(query.tile, now, businessDayRange(businessDate(now, zone), zone)))
    if (query.from) filters.push({ sentAt: { gte: businessDayRange(query.from, zone).start } })
    if (query.to) filters.push({ sentAt: { lt: businessDayRange(query.to, zone).end } })
    const order: Prisma.SortOrder = query.view === 'open' ? 'asc' : 'desc'
    const rows = await db.helpCall.findMany({
      where: { AND: filters },
      orderBy: [{ sentAt: order }, { id: order }],
      ...(query.cursor && isUuid(query.cursor) ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit + 1,
      select: CALL_COLUMNS,
    })
    const page = rows.slice(0, query.limit)
    return { calls: await callViews(db, page, context, now), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /production/calls/counts. */
export async function callCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly lineId?: string | undefined }) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const sites = await sitesInScope(db, context, PRODUCTION_CALLS_VIEW)
    const zone = await zoneOf(db, query.siteId)
    const today = businessDayRange(businessDate(now, zone), zone)
    const base: Prisma.HelpCallWhereInput = { siteId: { in: query.siteId ? sites.filter((id) => id === query.siteId) : sites }, ...(query.lineId ? { lineId: query.lineId } : {}) }
    const count = (tile: CallTile) => db.helpCall.count({ where: { AND: [base, tileWhere(tile, now, today)] } })
    const answered = await db.helpCall.findMany({ where: { AND: [base, tileWhere('ANSWERED_TODAY', now, today)] }, select: { sentAt: true, seenAt: true } })
    return {
      tiles: { OPEN: await count('OPEN'), WAITING: await count('WAITING'), ANSWERED_TODAY: answered.length },
      medianResponseSeconds: median(answeredOf(answered)),
      waitingMinutes: CALL_LIMITS.waitingMinutes,
    }
  })
}

/** GET /production/calls/by-hour. */
export async function callsByHourOf(caller: CommandCaller, query: { readonly siteId: string; readonly date?: BusinessDate | undefined; readonly lineId?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const site = isUuid(query.siteId) ? await siteOf(db, query.siteId) : null
    if (!site) throw new NotFoundError('Site not found.')
    assertMay(context, PRODUCTION_CALLS_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
    const date = query.date ?? businessDate(new Date(), site.timezone)
    const day = businessDayRange(date, site.timezone)
    const rows = await db.helpCall.findMany({ where: { siteId: site.id, sentAt: { gte: day.start, lt: day.end }, ...(query.lineId ? { lineId: query.lineId } : {}) }, select: { sentAt: true, seenAt: true, lineId: true, type: { select: { kind: true } } } })
    const result = callsByHour(rows.map((row) => ({ sentAt: row.sentAt, seenAt: row.seenAt, lineId: row.lineId, kind: row.type.kind as CallKind })), site.timezone)
    const lineIds = [...new Set(rows.map((row) => row.lineId).filter((id): id is string => id !== null))]
    const lines = lineIds.length === 0 ? [] : await db.line.findMany({ where: { id: { in: lineIds } }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } })
    return { date, timeZone: site.timezone, hours: result.hours.map((hour) => ({ ...hour, byKind: { ...hour.byKind }, byLine: [...hour.byLine] })), byKind: [...result.byKind], lines }
  })
}

/** GET /production/calls/:callId. */
export async function callRecordOf(caller: CommandCaller, callId: string) {
  const context = officeOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const row = isUuid(callId) ? await readCall(db, callId) : null
    if (!row) throw new NotFoundError('Call not found.')
    assertMay(context, PRODUCTION_CALLS_VIEW, scopeOfCall(row), 'Call')
    const canAnswer = may(context, PRODUCTION_CALLS_ANSWER, scopeOfCall(row))
    return { call: await callRecord(db, row, context, now), canAnswer, canNameOutcome: canAnswer && row.outcomeRecordType === null }
  })
}

/** GET /production/calls/board: a line's stations and open calls (the floor: its device's line unless one is named). */
export async function lineBoard(caller: CommandCaller, query: { readonly lineId?: string | undefined }) {
  const context = contextOf(caller)
  const now = new Date()
  return caller.withClient(async (db) => {
    const lineId = query.lineId ?? (context.audience === 'floor' ? (await devicePlaceOf(db, context.deviceId)).lineId : null)
    if (!lineId) throw new ValidationError(context.audience === 'floor' ? 'This tablet shows no line: name the line.' : 'Name the line.', [{ path: 'querystring/lineId', message: 'Name the line.' }])
    const line = await db.line.findUnique({ where: { id: lineId }, select: { id: true, companyId: true, siteId: true, code: true, name: true } })
    if (!line) throw new NotFoundError('Line not found.')
    const scope = { companyId: line.companyId, siteId: line.siteId }
    assertMay(context, PRODUCTION_CALLS_VIEW, scope, 'Line')
    const stations = await db.station.findMany({ where: { lineId: line.id, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true, code: true, name: true } })
    const open = await db.helpCall.findMany({ where: { lineId: line.id, status: { in: OPEN } }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }], select: CALL_COLUMNS })
    return {
      line: { id: line.id, code: line.code, name: line.name },
      asOf: toUtcIso(now),
      stations: stations.map((station) => {
        const calls = open.filter((call) => call.stationId === station.id)
        return {
          id: station.id,
          code: station.code,
          name: station.name,
          state: stationCallState(calls),
          material: calls.some((call) => call.type.kind === 'MATERIAL'),
          calls: calls.map((call) => ({ id: call.id, kind: call.type.kind as CallKind, code: call.type.code, status: call.status as CallStatus, sentAt: toUtcIso(call.sentAt), openSeconds: secondsOpen(call.sentAt, now) })),
        }
      }),
      calls: await callViews(db, open, context, now),
      canAnswer: may(context, PRODUCTION_CALLS_ANSWER, scope),
    }
  })
}
