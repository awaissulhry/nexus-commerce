import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { workingMinutesBetween } from '@nexus/factory-domain/calendars/working-time'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayRange, toUtcIso } from '@nexus/factory-domain/core/time'
import { laneKey } from '@nexus/factory-domain/production/reports/daily'
import { bottleneckOf, lineStateOf, outputPct, plannedOnLine, plannedShare, type PlannedSlot, type WaitingAt } from '@nexus/factory-domain/production/reports/lines'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { floorVersionsOf, slotsOf } from '../../planning/schedule/store'
import type { Reader } from '../../planning/store'
import { wipFor } from '../scans/progress'
import { officeContextOf, readDaily, siteFor, sitesFor, type ReportSite } from './daily'

/**
 * The floor overview by line (B-W2a-38; MES-160; design production.floor "Lines"; Owner answer F2), for Floor now: each
 * ACTIVE line of the caller's sites (workorders.view) with its state word, the garments its stations passed through its
 * last operation today against what the site's CURRENT published plan puts through it today (P3: the floor works to
 * the published version, never the working plan), the open work orders allocated or planned on it, the operation where
 * most pieces wait, and per station only whether someone is signed in and whether a machine at it is down. Rules in
 * factory-domain production/reports/lines. No worker is read: a device's session is read for its times only.
 */

const OPEN = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const DOWN = ['DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'] as const

async function linesOfSite(db: Reader, site: ReportSite, now: Date) {
  const today = businessDate(now, site.timezone)
  const range = businessDayRange(today, site.timezone)
  const lines = await db.line.findMany({ where: { siteId: site.id, status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  if (lines.length === 0) return []
  const lineIds = lines.map((line) => line.id)
  const stations = await db.station.findMany({ where: { siteId: site.id, lineId: { in: lineIds }, status: 'ACTIVE' }, select: { id: true, code: true, name: true, lineId: true, workCentreId: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const stationIds = stations.map((station) => station.id)

  // Owner F2, per station: someone signed in (a live session on an active device there; its times only, never who) and
  // the machines that are down.
  const devices = stationIds.length
    ? await db.device.findMany({ where: { stationId: { in: stationIds }, status: 'ACTIVE', currentSessionId: { not: null } }, select: { stationId: true, currentSession: { select: { endedAt: true, idleExpiresAt: true, endsAt: true } } } })
    : []
  const signedIn = new Set(devices.filter((device) => device.currentSession && device.currentSession.endedAt === null && device.currentSession.idleExpiresAt > now && device.currentSession.endsAt > now).map((device) => device.stationId))
  const machines = stationIds.length ? await db.machine.findMany({ where: { stationId: { in: stationIds }, status: { in: [...DOWN] } }, select: { stationId: true, assetNumber: true, status: true }, orderBy: { assetNumber: 'asc' } }) : []

  // The plan: the slots of the version the floor works to now that reach into today, on these lines.
  const { current } = await floorVersionsOf(db, site.id, now)
  const slots = current ? (await slotsOf(db, current.id, range)).filter((slot) => slot.lineId !== null && lineIds.includes(slot.lineId)) : []

  const allocated = await db.workOrder.findMany({
    where: { siteId: site.id, status: { in: [...OPEN] }, OR: [{ lineId: { in: lineIds } }, { id: { in: [...new Set(slots.map((slot) => slot.workOrderId))] } }] },
    select: { id: true, number: true, status: true, lineId: true, style: { select: { id: true, code: true, name: true } }, sizes: { select: { quantity: true } } },
    orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
  })
  const workOrderById = new Map(allocated.map((row) => [row.id, row]))
  const operations = allocated.length
    ? await db.workOrderOperation.findMany({ where: { workOrderId: { in: allocated.map((row) => row.id) } }, select: { id: true, workOrderId: true, seq: true, workCentreId: true } })
    : []
  const slotOps = new Map(operations.map((operation) => [operation.id, operation]))

  // Working minutes of each line (its calendar), for a slot's share of today.
  const calendars = await workingCalendarsFor(db, lineIds.map((id) => ({ scope: 'LINE' as const, id })), { from: plusDays(today, -14), to: plusDays(today, 14) })
  const plannedOf = (lineId: string): number | null => {
    if (!current) return null
    const calendar = calendars.get(ownerKey({ scope: 'LINE', id: lineId }))?.calendar
    const minutesBetween = (from: Date, to: Date) => (calendar && to > from ? workingMinutesBetween(calendar, from, to) : 0)
    const clock = (from: Date, to: Date) => Math.max(0, (to.getTime() - from.getTime()) / 60_000)
    const shares: PlannedSlot[] = slots
      .filter((slot) => slot.lineId === lineId)
      .flatMap((slot) => {
        const workOrder = workOrderById.get(slot.workOrderId)
        if (!workOrder) return []
        const garments = slot.pieces ?? workOrder.sizes.reduce((sum, size) => sum + size.quantity, 0)
        const from = slot.startAt > range.start ? slot.startAt : range.start
        const to = slot.endAt < range.end ? slot.endAt : range.end
        return [
          {
            workOrderId: slot.workOrderId,
            operationSeq: slot.workOrderOperationId ? (slotOps.get(slot.workOrderOperationId)?.seq ?? 0) : null,
            plannedToday: plannedShare(garments, { today: minutesBetween(from, to), slot: minutesBetween(slot.startAt, slot.endAt) }, { today: clock(from, to), slot: clock(slot.startAt, slot.endAt) }),
          },
        ]
      })
    return plannedOnLine(shares)
  }

  // Output today: the daily report's good per line (through the line's last operation).
  const daily = await readDaily(db, site, today)
  const lastScan = new Map<string, Date>()
  for (const scan of daily.scans) {
    if (scan.kind === 'UNDO' || scan.stationId === null || scan.at < range.start || scan.at >= range.end) continue
    const lane = daily.stationLanes.get(scan.stationId)
    if (lane?.kind !== 'LINE') continue
    const seen = lastScan.get(lane.id)
    if (!seen || scan.at > seen) lastScan.set(lane.id, scan.at)
  }

  const out = []
  for (const line of lines) {
    const own = stations.filter((station) => station.lineId === line.id)
    const centres = new Set(own.map((station) => station.workCentreId))
    const onLine = allocated.filter((row) => row.lineId === line.id || slots.some((slot) => slot.lineId === line.id && slot.workOrderId === row.id))
    const waitingAt: WaitingAt[] = []
    for (const row of onLine) {
      const wip = await wipFor(db, { id: row.id, siteId: site.id })
      for (const op of wip.operations) {
        const centre = slotOps.get(op.operationId)?.workCentreId
        if (!op.scanRequired || !centre || (centres.size > 0 && !centres.has(centre))) continue
        waitingAt.push({ workOrderId: row.id, workOrderNumber: row.number, operationId: op.operationId, seq: op.seq, code: op.code, name: op.name, waiting: op.waiting })
      }
    }
    const plannedToday = plannedOf(line.id)
    const output = daily.report.lanes.find((lane) => laneKey(lane.lane) === laneKey({ kind: 'LINE', id: line.id }))?.good ?? 0
    const last = lastScan.get(line.id) ?? null
    out.push({
      id: line.id,
      code: line.code,
      name: line.name,
      site: { id: site.id, code: site.code },
      state: lineStateOf({ openWorkOrders: onLine.length, plannedToday, lastScanAt: last, now }),
      lastScanAt: last ? toUtcIso(last) : null,
      workOrders: onLine.map((row) => ({ id: row.id, number: row.number, status: row.status, style: row.style })),
      plannedToday,
      plan: current ? { number: current.number! } : null,
      output,
      outputPct: outputPct(output, plannedToday),
      bottleneck: bottleneckOf(waitingAt),
      stations: own.map((station) => ({
        id: station.id,
        code: station.code,
        name: station.name,
        signedIn: signedIn.has(station.id),
        machinesDown: machines.filter((machine) => machine.stationId === station.id).map((machine) => ({ assetNumber: machine.assetNumber, status: machine.status as (typeof DOWN)[number] })),
      })),
    })
  }
  return out
}

/** GET /production/reports/lines (workorders.view): every active line of the caller's sites, or of one site. */
export async function linesAnswer(caller: CommandCaller, query: { readonly siteId?: string | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const sites = query.siteId ? [await siteFor(db, actor, WORKORDERS_VIEW, query.siteId, context.companyId)] : await sitesFor(db, actor, WORKORDERS_VIEW, context.companyId)
    if (query.siteId && sites.length === 0) throw new NotFoundError('Site not found.')
    const lines = []
    for (const site of sites) lines.push(...(await linesOfSite(db, site, now)))
    return {
      asOf: toUtcIso(now),
      sites: sites.map((site) => ({ id: site.id, code: site.code, name: site.name, timeZone: site.timezone, today: businessDate(now, site.timezone) })),
      lines,
    }
  })
}
