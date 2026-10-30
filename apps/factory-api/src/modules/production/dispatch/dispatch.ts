import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { dispatchOrder, dispatchState } from '@nexus/factory-domain/planning/schedule/dispatch'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { floorVersionsOf, slotsOf, type PlanRow } from '../../planning/schedule/store'
import { dayOf, type Reader } from '../../planning/store'
import { wipFor } from '../scans/progress'
import type { OfficeDispatchQuery } from './contract'

/**
 * The dispatch list per line or station (B-W2a-34; MES-021; design floor.mywork "Next" and "Then"; Owner answer P3): what
 * the site's CURRENT published version (the highest number whose start has come) puts on a line, a work centre or a
 * station, with where each piece of work stands from the floor's own scans, rush first, then due date, then the planned
 * start and sequence (factory-domain planning/schedule/dispatch). The working plan is never read: on the floor the
 * policies hide it anyway (the floor role reads PUBLISHED versions and slots only), in the office this module reads
 * only published ones.
 *
 *   a line        its bars, and the operations it does of the work orders (or parts of them) placed on it whole
 *   a work centre the bars placed on the work centre itself
 *   a station     its line's bars of the station's work centre, and the bars of its work centre
 *
 * Office: GET /production/dispatch?lineId|workCentreId|stationId (workorders.view over the lane's site). Floor: GET
 * /production/dispatch/station (floor.work): the device's own station (a device not placed at a station gets the reason
 * in words). No person, no money.
 */

interface SiteFacts {
  readonly id: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timezone: string
}

interface Target {
  readonly kind: 'LINE' | 'WORK_CENTRE' | 'STATION'
  readonly id: string
  readonly code: string
  readonly name: string
  readonly lineId: string | null
  readonly workCentreId: string | null
  readonly site: SiteFacts
}

const SITE = { id: true, companyId: true, code: true, name: true, timezone: true } as const

async function lineName(db: Reader, id: string | null) {
  return id ? db.line.findUnique({ where: { id }, select: { id: true, code: true, name: true } }) : null
}
async function centreName(db: Reader, id: string | null) {
  return id ? db.workCentre.findUnique({ where: { id }, select: { id: true, code: true, name: true } }) : null
}

/** The list of one target. */
async function listFor(db: Reader, target: Target, now: Date) {
  const site = target.site
  const { current, upcoming } = await floorVersionsOf(db, site.id, now)
  const base = {
    site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone },
    target: { kind: target.kind, id: target.id, code: target.code, name: target.name, line: await lineName(db, target.lineId), workCentre: await centreName(db, target.workCentreId) },
    asOf: toUtcIso(now),
    version: current ? versionOf(current) : null,
    upcoming: upcoming ? { id: upcoming.id, number: upcoming.number!, effectiveFrom: toUtcIso(upcoming.effectiveFrom!) } : null,
  }
  if (!current) {
    return { ...base, next: null, entries: [], words: upcoming ? `The first schedule, v${upcoming.number}, starts at ${toUtcIso(upcoming.effectiveFrom!)}.` : 'Nothing is published for this site yet: work from the bundles until the office publishes the plan.' }
  }
  const slots = await slotsOf(db, current.id)
  const workOrderIds = [...new Set(slots.map((slot) => slot.workOrderId))]
  const workOrders = workOrderIds.length
    ? await db.workOrder.findMany({
        where: { id: { in: workOrderIds } },
        select: {
          id: true,
          siteId: true,
          number: true,
          status: true,
          priority: true,
          dueDate: true,
          holdReason: true,
          style: { select: { code: true, name: true } },
          sizes: { select: { quantity: true } },
          operations: { select: { id: true, seq: true, code: true, name: true, workCentreId: true, standardMinutes: true }, orderBy: { seq: 'asc' } },
        },
      })
    : []
  const byId = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]))
  // What each line does: the work centres of its active stations (none: every operation).
  const stations = await db.station.findMany({ where: { siteId: site.id, status: 'ACTIVE' }, select: { lineId: true, workCentreId: true } })
  const lineDoes = (lineId: string) => {
    const own = stations.filter((station) => station.lineId === lineId).map((station) => station.workCentreId)
    return own.length > 0 ? new Set(own) : null
  }
  const lineMatches = (lineId: string | null, workCentreId: string) => {
    if (lineId === null) return false
    if (target.kind === 'LINE') return lineId === target.id
    if (target.kind === 'STATION') return target.lineId === lineId && target.workCentreId === workCentreId
    return false
  }
  const centreMatches = (workCentreId: string | null) => workCentreId !== null && (target.kind === 'WORK_CENTRE' ? workCentreId === target.id : target.kind === 'STATION' && workCentreId === target.workCentreId)
  const picked: { slot: (typeof slots)[number]; operationId: string; garments: number }[] = []
  for (const slot of slots) {
    const workOrder = byId.get(slot.workOrderId)
    if (!workOrder) continue
    const garments = workOrder.sizes.reduce((sum, size) => sum + size.quantity, 0)
    if (slot.workOrderOperationId) {
      const operation = workOrder.operations.find((candidate) => candidate.id === slot.workOrderOperationId)
      if (!operation) continue
      if (lineMatches(slot.lineId, operation.workCentreId) || centreMatches(slot.workCentreId)) picked.push({ slot, operationId: operation.id, garments })
      continue
    }
    // A work order (or part of it) placed whole on a line: the operations the line does that have no bar of their own.
    if (slot.lineId === null) continue
    const does = lineDoes(slot.lineId)
    for (const operation of workOrder.operations) {
      if (does !== null && !does.has(operation.workCentreId)) continue
      if (slots.some((other) => other.workOrderId === workOrder.id && other.workOrderOperationId === operation.id)) continue
      if (lineMatches(slot.lineId, operation.workCentreId)) picked.push({ slot, operationId: operation.id, garments: slot.pieces ?? garments })
    }
  }
  const wips = new Map<string, Awaited<ReturnType<typeof wipFor>>>()
  for (const workOrderId of new Set(picked.map((entry) => entry.slot.workOrderId))) wips.set(workOrderId, await wipFor(db, { id: workOrderId, siteId: site.id }))
  const entries = picked.map(({ slot, operationId, garments }) => {
    const workOrder = byId.get(slot.workOrderId)!
    const operation = workOrder.operations.find((candidate) => candidate.id === operationId)!
    const previous = [...workOrder.operations].reverse().find((candidate) => candidate.seq < operation.seq) ?? null
    const flow = wips.get(workOrder.id)!.operations.find((row) => row.operationId === operation.id)
    const done = Math.min(garments, (flow?.good ?? 0) + (flow?.scrap ?? 0))
    const state = dispatchState({
      workOrderNumber: workOrder.number,
      workOrderStatus: workOrder.status,
      holdReason: workOrder.holdReason,
      operation: { seq: operation.seq, name: operation.name },
      previous: previous ? { seq: previous.seq, name: previous.name } : null,
      garments,
      arrived: flow?.arrived ?? 0,
      waiting: flow?.waiting ?? 0,
      done,
    })
    const dueDate: BusinessDate | null = workOrder.dueDate ? dayOf(workOrder.dueDate) : null
    return {
      key: { priority: workOrder.priority, dueDate, startAt: slot.startAt.getTime(), seq: operation.seq, workOrderNumber: workOrder.number },
      view: {
        slotId: slot.id,
        workOrder: { id: workOrder.id, number: workOrder.number, status: workOrder.status, priority: workOrder.priority, rush: workOrder.priority > 0, dueDate, style: workOrder.style, holdReason: workOrder.holdReason },
        operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
        startAt: toUtcIso(slot.startAt),
        endAt: toUtcIso(slot.endAt),
        garments,
        minutes: new Dec(operation.standardMinutes.toString()).times(Math.max(0, garments - done)).toFixed(1),
        state: state.state,
        words: state.words,
        arrived: flow?.arrived ?? 0,
        waiting: flow?.waiting ?? 0,
        done,
      },
    }
  })
  entries.sort((a, b) => dispatchOrder(a.key, b.key))
  const list = entries.map((entry) => entry.view)
  const next = list.find((entry) => entry.state === 'READY') ?? null
  return { ...base, next, entries: list, words: list.length ? null : `Nothing queued for ${target.name} in v${current.number}. Scan a bundle to work on it.` }
}

const versionOf = (version: PlanRow) => ({
  id: version.id,
  number: version.number!,
  coversFrom: dayOf(version.coversFrom!),
  coversTo: dayOf(version.coversTo!),
  effectiveFrom: toUtcIso(version.effectiveFrom!),
  publishedAt: toUtcIso(version.publishedAt!),
})

/** GET /production/dispatch (office, workorders.view): one line's, work centre's or station's list. */
export async function officeDispatch(caller: CommandCaller, query: OfficeDispatchQuery) {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  const asked = [query.lineId ? 'lineId' : null, query.workCentreId ? 'workCentreId' : null, query.stationId ? 'stationId' : null].filter(Boolean)
  if (asked.length !== 1) throw new ValidationError('Name one line, work centre or station.', [{ path: 'querystring', message: 'Give exactly one of lineId, workCentreId and stationId.' }])
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    let target: Target | null = null
    if (query.lineId) {
      const row = await db.line.findUnique({ where: { id: query.lineId }, select: { id: true, code: true, name: true, site: { select: SITE } } })
      if (row) target = { kind: 'LINE', id: row.id, code: row.code, name: row.name, lineId: row.id, workCentreId: null, site: row.site }
    } else if (query.workCentreId) {
      const row = await db.workCentre.findUnique({ where: { id: query.workCentreId }, select: { id: true, code: true, name: true, site: { select: SITE } } })
      if (row) target = { kind: 'WORK_CENTRE', id: row.id, code: row.code, name: row.name, lineId: null, workCentreId: row.id, site: row.site }
    } else {
      const row = await db.station.findUnique({ where: { id: query.stationId! }, select: { id: true, code: true, name: true, lineId: true, workCentreId: true, site: { select: SITE } } })
      if (row) target = { kind: 'STATION', id: row.id, code: row.code, name: row.name, lineId: row.lineId, workCentreId: row.workCentreId, site: row.site }
    }
    if (!target || !can(actorOf(context), WORKORDERS_VIEW, { companyId: target.site.companyId, siteId: target.site.id })) throw new NotFoundError(`${asked[0] === 'lineId' ? 'Line' : asked[0] === 'workCentreId' ? 'Work centre' : 'Station'} not found.`)
    return listFor(db, target, now)
  })
}

function floorOf(caller: CommandCaller): FloorContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/** GET /production/dispatch/station (floor, floor.work): the device's own station's list, in the floor's scope. */
export async function stationDispatch(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const device = isUuid(context.deviceId) ? await db.device.findUnique({ where: { id: context.deviceId }, select: { stationId: true, site: { select: SITE } } }) : null
    if (!device) throw new NotFoundError('Device not found.')
    const station = device.stationId ? await db.station.findUnique({ where: { id: device.stationId }, select: { id: true, code: true, name: true, lineId: true, workCentreId: true, status: true } }) : null
    if (!station) {
      const { current, upcoming } = await floorVersionsOf(db, device.site.id, now)
      return {
        site: { id: device.site.id, code: device.site.code, name: device.site.name, timeZone: device.site.timezone },
        target: null,
        asOf: toUtcIso(now),
        version: current ? versionOf(current) : null,
        upcoming: upcoming ? { id: upcoming.id, number: upcoming.number!, effectiveFrom: toUtcIso(upcoming.effectiveFrom!) } : null,
        next: null,
        entries: [],
        words: 'This tablet is not placed at a station: ask the office to place it at one. Scan a bundle to work on it.',
      }
    }
    return listFor(db, { kind: 'STATION', id: station.id, code: station.code, name: station.name, lineId: station.lineId, workCentreId: station.workCentreId, site: device.site }, now)
  })
}
