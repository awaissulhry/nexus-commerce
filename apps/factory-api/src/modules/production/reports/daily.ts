import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingTimeOf } from '@nexus/factory-domain/calendars/working-time'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dailyReport, laneKey, missingRoots, type DailyExtra, type DailyReport, type DailyScan, type LaneRef } from '@nexus/factory-domain/production/reports/daily'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { countKindOf, SCAN_KINDS } from '@nexus/factory-domain/production/scans/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { addWorkingDaysFor, ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { effectiveOf, readLanes } from '../../planning/settings/lanes'
import { readSettings } from '../../planning/settings/store'
import type { Reader } from '../../planning/store'
import type { DailyQuery } from './contract'

/**
 * The daily production report (B-W2a-38; MES-301; design production.reports "Daily production"): one site, one day, per
 * lane (a line, else the work centre of a station that stands alone), style and size, from the floor's scans and the
 * rework orders, counted by factory-domain production/reports/daily (the rules are there). The scans are read WITHOUT
 * their worker (the select never names workerId): no figure can be per person (Statuto dei Lavoratori art. 4).
 *
 * Reads, one query after another: the day's scans, the later rows that void or correct them, and the older reports
 * their corrections stand for; their bundles, work orders (all operations, the lane's last one decides "good"), cells;
 * the site's stations, lines and work centres; the rework opened by hand that day and the rework finished that day (its
 * scrap); each active line's people (planning capacity, else one per active station) and working minutes (its calendar).
 */

export interface ReportSite {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timezone: string
}

const SITE_SELECT = { id: true, companyId: true, code: true, name: true, timezone: true } as const satisfies Prisma.SiteSelect

/** Never the worker: per line only. */
const SCAN_SELECT = {
  id: true,
  kind: true,
  correctsId: true,
  bundleId: true,
  workOrderId: true,
  workOrderOperationId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  stationId: true,
  serverTime: true,
} as const satisfies Prisma.OperationScanSelect
type ScanRow = Prisma.OperationScanGetPayload<{ select: typeof SCAN_SELECT }>

const toScan = (row: ScanRow): DailyScan => ({
  id: row.id,
  kind: countKindOf(row.kind),
  correctsId: row.correctsId,
  bundleId: row.bundleId,
  workOrderId: row.workOrderId,
  operationId: row.workOrderOperationId,
  good: row.goodQuantity,
  scrap: row.scrapQuantity,
  rework: row.reworkQuantity,
  stationId: row.stationId,
  at: row.serverTime,
})

const ids = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The sites the actor holds a permission at, by code; of the screen's company when the request names one. */
export async function sitesFor(db: Reader, actor: Actor, permission: Permission, companyId?: string): Promise<ReportSite[]> {
  const scope = scopeWhere(actor, permission, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput
  return db.site.findMany({ where: companyId ? { AND: [scope, { companyId }] } : scope, select: SITE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
}

/** One site the actor holds the permission at, of the screen's company when the request names one (else not found). */
export async function siteFor(db: Reader, actor: Actor, permission: Permission, siteId: string, companyId?: string): Promise<ReportSite> {
  const site = isUuid(siteId) ? await db.site.findUnique({ where: { id: siteId }, select: SITE_SELECT }) : null
  if (!site || (companyId && site.companyId !== companyId) || !can(actor, permission, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Site not found.')
  return site
}

/** Every scan the day's report needs (see the module comment). */
async function scansOfDay(db: Reader, siteId: string, range: { readonly start: Date; readonly end: Date }): Promise<DailyScan[]> {
  const rows = new Map<string, ScanRow>()
  // The count ledger only (W2b: the timing kinds carry no counts; the voiding and root rows below are count rows too).
  for (const row of await db.operationScan.findMany({ where: { siteId, kind: { in: [...SCAN_KINDS] }, serverTime: { gte: range.start, lt: range.end } }, select: SCAN_SELECT, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })) rows.set(row.id, row)
  // The later rows that undo or correct them (and theirs): the day's figures are what stands now.
  let frontier = [...rows.keys()]
  for (let depth = 0; frontier.length > 0 && depth < 20; depth += 1) {
    const later = await db.operationScan.findMany({ where: { siteId, correctsId: { in: frontier }, serverTime: { gte: range.end } }, select: SCAN_SELECT })
    frontier = later.filter((row) => !rows.has(row.id)).map((row) => row.id)
    for (const row of later) rows.set(row.id, row)
  }
  // The older reports the day's corrections stand for (a correction counts on its report's day).
  for (let depth = 0; depth < 20; depth += 1) {
    const missing = missingRoots([...rows.values()].map(toScan))
    if (missing.length === 0) break
    for (const row of await db.operationScan.findMany({ where: { id: { in: missing } }, select: SCAN_SELECT })) rows.set(row.id, row)
  }
  return [...rows.values()].map(toScan)
}

export interface LaneName {
  readonly code: string
  readonly name: string
}

export interface DailyRead {
  readonly report: DailyReport
  readonly lanes: ReadonlyMap<string, LaneName>
  readonly styles: ReadonlyMap<string, { readonly id: string; readonly code: string; readonly name: string }>
  readonly people: ReadonlyMap<string, { readonly people: number; readonly workingMinutes: number }>
  /** The day's REPORT and CORRECTION rows by station (the floor overview's last report per line). */
  readonly scans: readonly DailyScan[]
  /** The station → lane map of the site. */
  readonly stationLanes: ReadonlyMap<string, LaneRef>
}

/** The report of one site and day, with the names the answers need. */
export async function readDaily(db: Reader, site: ReportSite, day: BusinessDate): Promise<DailyRead> {
  const range = businessDayRange(day, site.timezone)
  const scans = await scansOfDay(db, site.id, range)
  const reworks = await db.reworkOrder.findMany({
    where: {
      siteId: site.id,
      OR: [
        { sourceScanId: null, status: { not: 'CANCELLED' }, createdAt: { gte: range.start, lt: range.end } },
        { status: 'DONE', scrapQuantity: { gt: 0 }, doneAt: { gte: range.start, lt: range.end } },
      ],
    },
    select: { workOrderId: true, workOrderSizeId: true, sourceScanId: true, foundAtOperationId: true, reworkAtOperationId: true, quantity: true, status: true, scrapQuantity: true, createdAt: true, doneAt: true },
  })
  const bundles = await db.bundle.findMany({ where: { id: { in: ids(scans.map((scan) => scan.bundleId)) } }, select: { id: true, part: true, status: true, workOrderSizeId: true } })
  const workOrderIds = ids([...scans.map((scan) => scan.workOrderId), ...reworks.map((rework) => rework.workOrderId)])
  const workOrders = await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, styleId: true, lineId: true } })
  const styles = await db.style.findMany({ where: { id: { in: ids(workOrders.map((row) => row.styleId)) } }, select: { id: true, code: true, name: true } })
  const operations = await db.workOrderOperation.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, workOrderId: true, seq: true, scanRequired: true, workCentreId: true, standardMinutes: true } })
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: workOrderIds } }, select: { id: true, size: true } })
  const stations = await db.station.findMany({ where: { siteId: site.id }, select: { id: true, lineId: true, workCentreId: true } })
  const lines = await db.line.findMany({ where: { siteId: site.id }, select: { id: true, code: true, name: true, status: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const centres = await db.workCentre.findMany({ where: { siteId: site.id }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })

  const stationLanes = new Map<string, LaneRef>(stations.map((station) => [station.id, station.lineId ? { kind: 'LINE', id: station.lineId } : { kind: 'WORK_CENTRE', id: station.workCentreId }]))
  const laneCentres = new Map<string, Set<string>>()
  for (const station of stations) {
    const key = laneKey(stationLanes.get(station.id)!)
    laneCentres.set(key, (laneCentres.get(key) ?? new Set()).add(station.workCentreId))
  }
  for (const centre of centres) laneCentres.set(laneKey({ kind: 'WORK_CENTRE', id: centre.id }), new Set([centre.id]))
  const operationById = new Map(operations.map((operation) => [operation.id, operation]))
  const workOrderById = new Map(workOrders.map((row) => [row.id, row]))
  const laneOfRework = (rework: (typeof reworks)[number]): LaneRef => {
    const lineId = workOrderById.get(rework.workOrderId)?.lineId ?? null
    if (lineId) return { kind: 'LINE', id: lineId }
    const operation = operationById.get(rework.foundAtOperationId ?? rework.reworkAtOperationId) ?? operationById.get(rework.reworkAtOperationId)
    return { kind: 'WORK_CENTRE', id: operation?.workCentreId ?? rework.reworkAtOperationId }
  }
  const inDay = (instant: Date | null) => instant !== null && instant >= range.start && instant < range.end
  const extras: DailyExtra[] = reworks.flatMap((rework) => [
    ...(rework.sourceScanId === null && rework.status !== 'CANCELLED' && inDay(rework.createdAt) ? [{ lane: laneOfRework(rework), workOrderId: rework.workOrderId, workOrderSizeId: rework.workOrderSizeId, scrap: 0, rework: rework.quantity }] : []),
    ...(rework.status === 'DONE' && inDay(rework.doneAt) ? [{ lane: laneOfRework(rework), workOrderId: rework.workOrderId, workOrderSizeId: rework.workOrderSizeId, scrap: rework.scrapQuantity, rework: 0 }] : []),
  ])

  // Each active line's people (a headcount, never who) and working minutes that day.
  const active = lines.filter((line) => line.status === 'ACTIVE')
  const settings = await readSettings(db, site.id)
  const { lines: lanes } = await readLanes(db, site.id)
  const calendars = active.length ? await workingCalendarsFor(db, active.map((line) => ({ scope: 'LINE' as const, id: line.id })), { from: day, to: day }) : new Map()
  const people = new Map<string, { people: number; workingMinutes: number }>()
  for (const line of active) {
    const lane = lanes.find((entry) => entry.id === line.id)
    const calendar = calendars.get(ownerKey({ scope: 'LINE', id: line.id }))
    people.set(line.id, { people: lane ? effectiveOf(lane, settings).people : 0, workingMinutes: calendar ? (workingTimeOf(calendar.calendar, day, day).minutes ?? 0) : 0 })
  }

  const report = dailyReport(
    {
      day,
      timeZone: site.timezone,
      scans,
      bundles: new Map(bundles.map((bundle) => [bundle.id, { part: bundle.part, status: bundle.status, workOrderSizeId: bundle.workOrderSizeId }])),
      operations: new Map(operations.map((operation) => [operation.id, { workOrderId: operation.workOrderId, seq: operation.seq, scanRequired: operation.scanRequired, workCentreId: operation.workCentreId, standardMinutes: operation.standardMinutes.toString() }])),
      workOrders: new Map(workOrders.map((row) => [row.id, { styleId: row.styleId }])),
      sizes: new Map(cells.map((cell) => [cell.id, cell.size])),
      stationLanes,
      laneCentres,
      extras,
      available: people,
    },
    [...lines.map((line) => laneKey({ kind: 'LINE', id: line.id })), ...centres.map((centre) => laneKey({ kind: 'WORK_CENTRE', id: centre.id }))],
  )
  const names = new Map<string, LaneName>([
    ...lines.map((line) => [laneKey({ kind: 'LINE', id: line.id }), { code: line.code, name: line.name }] as const),
    ...centres.map((centre) => [laneKey({ kind: 'WORK_CENTRE', id: centre.id }), { code: centre.code, name: centre.name }] as const),
  ])
  return { report, lanes: names, styles: new Map(styles.map((row) => [row.id, row])), people, scans, stationLanes }
}

/** The report as the answers carry it: names on the lanes, rows by style code then size. */
export function dailyView(read: DailyRead) {
  return {
    lanes: read.report.lanes.map((lane) => {
      const name = read.lanes.get(laneKey(lane.lane)) ?? { code: '?', name: '?' }
      const setup = lane.lane.kind === 'LINE' ? read.people.get(lane.lane.id) : undefined
      return {
        kind: lane.lane.kind,
        id: lane.lane.id,
        code: name.code,
        name: name.name,
        good: lane.good,
        scrap: lane.scrap,
        rework: lane.rework,
        earnedMinutes: lane.earnedMinutes,
        availableMinutes: lane.availableMinutes,
        efficiencyPct: lane.efficiencyPct,
        people: setup ? setup.people : null,
        workingMinutes: setup ? setup.workingMinutes : null,
        rows: lane.rows
          .map((row) => ({ style: read.styles.get(row.styleId) ?? { id: row.styleId, code: '?', name: '?' }, size: row.size, good: row.good, scrap: row.scrap, rework: row.rework }))
          .sort((a, b) => (a.style.code !== b.style.code ? a.style.code.localeCompare(b.style.code) : a.size.localeCompare(b.size, 'en', { numeric: true }))),
      }
    }),
    totals: read.report.totals,
  }
}

/** The site's working day before `day` (its calendar), else the day before. */
export async function previousWorkingDayOf(db: Reader, siteId: string, day: BusinessDate): Promise<BusinessDate> {
  try {
    return (await addWorkingDaysFor(db, { scope: 'SITE', id: siteId }, day, -1)).date ?? plusDays(day, -1)
  } catch {
    return plusDays(day, -1)
  }
}

/** GET /production/reports/daily (production.reports.view): one site's day, today by default. */
export async function dailyAnswer(caller: CommandCaller, query: DailyQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const sites = await sitesFor(db, actor, PRODUCTION_REPORTS_VIEW, context.companyId)
    const site = query.siteId ? await siteFor(db, actor, PRODUCTION_REPORTS_VIEW, query.siteId, context.companyId) : sites[0]
    if (!site) throw new NotFoundError('No site where you may read the production reports.')
    const today = businessDate(now, site.timezone)
    const day = query.date ?? today
    const read = await readDaily(db, site, day)
    const calendars = await workingCalendarsFor(db, [{ scope: 'SITE', id: site.id }], { from: day, to: day })
    const calendar = calendars.get(ownerKey({ scope: 'SITE', id: site.id }))
    const next = plusDays(day, 1)
    return {
      site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone },
      sites: sites.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })),
      day,
      today,
      previousWorkingDay: await previousWorkingDayOf(db, site.id, day),
      nextDay: next <= today ? next : null,
      workingDay: calendar ? (workingTimeOf(calendar.calendar, day, day).workingDays ?? 0) > 0 : true,
      asOf: toUtcIso(now),
      ...dailyView(read),
    }
  })
}
