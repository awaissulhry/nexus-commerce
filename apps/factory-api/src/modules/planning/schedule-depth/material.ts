import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { WorkOrderReadiness } from '@nexus/factory-domain/planning/readiness/readiness'
import { arrivalWords, materialStartOf, startInTime, type MaterialStart } from '@nexus/factory-domain/planning/schedule-depth/material'
import { laneKey, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { MINUTE_MS, startFrom, whenWords } from '@nexus/factory-domain/planning/schedule/time'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, officeContextOf } from '../access'
import { readinessFor } from '../readiness/service'
import { SITE_COLUMNS, type Reader } from '../store'
import { siteViewOf } from '../schedule/publish'
import { scheduleWorld, type BoardWorkOrder, type ScheduleWorld } from '../schedule/service'
import type { MaterialQuery } from './contract'

/**
 * Moves that know the material (B-W2b-312; PLN-134): THE place the board, a move's answer, the drop's check, forward
 * scheduling and the backlog reschedule get a work order's earliest start with material from. Readiness is one netting
 * of the site's live plan (planning/readiness, B-W2a-22: the same inputs as a run, computed now); the item's delay days at
 * the site come from ItemPlanning (B-W2b-286). The day becomes the lane's first working instant of that day (THE calendars
 * service's stretches in the board's world), never before now. Read only; no permission is checked here but in the route.
 */

/** Delay days per material at the site (`itemId|itemColourId` and `itemId` for a row without a colour). */
async function delayDaysOf(db: Reader, siteId: string, itemIds: readonly string[]): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map()
  const rows = await db.itemPlanning.findMany({ where: { siteId, itemId: { in: [...new Set(itemIds)] }, delayDays: { not: null } }, select: { itemId: true, itemColourId: true, delayDays: true }, orderBy: { id: 'asc' } })
  const out = new Map<string, number>()
  for (const row of rows) out.set(row.itemColourId ? `${row.itemId}|${row.itemColourId}` : row.itemId, row.delayDays ?? 0)
  return out
}

/** Each work order's earliest start with material (one readiness netting for all of them, unless given). */
export async function materialStartsOf(db: Reader, world: ScheduleWorld, workOrderIds: readonly string[], given?: readonly WorkOrderReadiness[]): Promise<Map<string, MaterialStart>> {
  if (workOrderIds.length === 0) return new Map()
  const readiness = given ?? (await readinessFor(db, world.site, workOrderIds))
  const delays = await delayDaysOf(db, world.site.id, readiness.flatMap((row) => row.materials.map((material) => material.itemId)))
  const byId = new Map(readiness.map((row) => [row.workOrderId, row]))
  return new Map(workOrderIds.map((id) => [id, materialStartOf(byId.get(id) ?? null, world.today, delays)]))
}

/** Now, up to the next whole minute (a bar starts on a minute). */
export const nextMinuteOf = (world: Pick<ScheduleWorld, 'now'>): number => Math.ceil(world.now.getTime() / MINUTE_MS) * MINUTE_MS

/** The first working instant of a day on a lane (its working stretches; a workshop: the day's start), never before now. */
export function earliestOnLane(world: ScheduleWorld, lane: LaneRef | null, day: string): number {
  const from = Math.max(nextMinuteOf(world), businessDayStart(day, world.site.timezone).getTime())
  if (lane === null || lane.kind === 'WORKSHOP') return from
  const spans = world.lanes.get(laneKey(lane))?.spans ?? world.siteSpans
  return startFrom(spans, from) ?? from
}

/** The lane of a work order's first operation with work left (where its work starts). */
export function firstLaneOf(world: ScheduleWorld, workOrder: BoardWorkOrder): LaneRef | null {
  const first = [...workOrder.operations].sort((a, b) => a.seq - b.seq).find((operation) => operation.remaining > 0)
  return first ? (world.operationLanes.get(first.id) ?? null) : null
}

const iso = (value: number | null): string | null => (value === null ? null : toUtcIso(new Date(value)))

/** The board's and the popover's `materialStart` of a work order. */
export function materialStartViewOf(world: ScheduleWorld, workOrder: BoardWorkOrder, start: MaterialStart) {
  const earliest = start.startDay ? earliestOnLane(world, firstLaneOf(world, workOrder), start.startDay) : null
  const say = (instant: number) => whenWords(instant, world.site.timezone)
  const words = start.state === 'ARRIVES' && start.setBy && earliest !== null ? `${arrivalWords(start.setBy)} Earliest start with material: ${say(earliest)}.` : start.words
  return {
    state: start.state,
    arrives: start.arrives,
    startDay: start.startDay,
    earliestStart: iso(earliest),
    setBy: start.setBy ? materialDayView(start.setBy) : null,
    notCovered: start.notCovered.map((material) => ({ itemId: material.itemId, itemColourId: material.itemColourId, label: material.label })),
    words,
  }
}

const materialDayView = (material: MaterialStart['materials'][number]) => ({
  itemId: material.itemId,
  itemColourId: material.itemColourId,
  label: material.label,
  arrives: material.arrives,
  overdue: material.overdue,
  purchaseOrderNumber: material.purchaseOrderNumber,
  source: material.source,
  usableFrom: material.usableFrom,
})

/** A start on a lane against the material (see materialCheckView). */
export function materialCheckOf(world: ScheduleWorld, start: MaterialStart, lane: LaneRef | null, startAt: number) {
  const say = (instant: number) => whenWords(instant, world.site.timezone)
  const earliest = start.startDay ? earliestOnLane(world, lane, start.startDay) : null
  const inTime = startInTime(start.state, startAt, earliest)
  let words: string
  if (start.state === 'IN_HAND' || start.state === 'NOT_PLANNED') words = start.words
  else if (start.state === 'NOT_COVERED') words = `${start.words} The start ${say(startAt)} has no material yet.`
  else if (inTime) words = `${arrivalWords(start.setBy!)} The start ${say(startAt)} is on or after the earliest start with material (${say(earliest!)}).`
  else words = `${arrivalWords(start.setBy!)} Earliest start with material: ${say(earliest!)}.`
  return { state: start.state, startAt: toUtcIso(new Date(startAt)), inTime, earliestStart: iso(earliest), snapTo: !inTime && earliest !== null ? iso(earliest) : null, words }
}

/**
 * GET /planning/schedule/work-orders/:workOrderId/material: when the work order may start with its materials and, for a
 * drop being tried (`startAt` on a lane), whether that start is in time and where to snap it. Writes nothing.
 */
export async function workOrderMaterial(caller: CommandCaller, workOrderId: string, query: MaterialQuery) {
  const context = officeContextOf(caller)
  if ((query.laneKind === undefined) !== (query.laneId === undefined)) throw new ValidationError('Name the lane by its kind and id together.', [{ path: query.laneKind === undefined ? 'querystring/laneKind' : 'querystring/laneId', message: 'Give both, or neither.' }])
  return caller.withClient(async (db) => {
    const row = isUuid(workOrderId) ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, site: { select: SITE_COLUMNS } } }) : null
    assertMayAt(context, PLANNING_VIEW, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order')
    const now = serverClock.now()
    const today = businessDate(now, row!.site.timezone)
    const world = await scheduleWorld(db, row!.site, { from: today, to: today }, now)
    const workOrder = world.workOrders.find((candidate) => candidate.id === row!.id)
    if (!workOrder) throw new NotFoundError('The work order is not open: it is not on the board.')
    const start = (await materialStartsOf(db, world, [workOrder.id])).get(workOrder.id)!
    const lane: LaneRef | null = query.laneKind && query.laneId ? { kind: query.laneKind, id: query.laneId } : firstLaneOf(world, workOrder)
    if (lane && !world.lanes.has(laneKey(lane))) throw new NotFoundError('Lane not found on this site.')
    return {
      site: siteViewOf(row!.site),
      asOf: toUtcIso(now),
      workOrder: { id: workOrder.id, number: workOrder.number },
      materialStart: materialStartViewOf(world, workOrder, start),
      materials: start.materials.map((material) => ({ ...materialDayView(material), word: material.word, notCovered: material.notCovered })),
      check: query.startAt ? materialCheckOf(world, start, lane, parseInstant(query.startAt)!.getTime()) : null,
    }
  })
}
