import type { Prisma } from '@nexus/factory-db'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { compareVersion, compareWords, type CompareSlot } from '@nexus/factory-domain/planning/schedule-log/compare'
import { laneKey, laneOfSlot } from '@nexus/factory-domain/planning/schedule/slots'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, officeContextOf } from '../access'
import { dayOf, SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import { siteViewOf, storedSlotView, versionHeaderOf } from '../schedule/publish'
import { scheduleWorld, type ScheduleWorld } from '../schedule/service'
import { floorVersionsOf, PLAN_COLUMNS, SLOT_COLUMNS, userNamesOf, type PlanRow } from '../schedule/store'
import { laneNamesOf } from './feed'
import { floorStatusesOf } from './floor'

/**
 * A published version, read-only (B-W2b-329; PLN-154 "a published version opens read-only"; design planning.board new tab
 * "Published version v12 (read-only)": "Compare what the floor has with the working plan side by side"): GET
 * /planning/schedule/versions/:versionId/board (planning.view over its site). The version's bars as the floor was given them
 * (a version never changes: the …_production_w2a_guards), each with its work order, operation and lane by name, its state
 * on the floor now (PLN-133) and the working plan beside it (factory-domain planning/schedule-log/compare: SAME, MOVED with
 * where it is now, REMOVED; the working plan's bars on its days that it does not have: added). `floor` says whether the
 * floor works to it now (CURRENT), waits for its start (UPCOMING) or a later version replaced it (REPLACED).
 */

export const VERSION_SLOT_COLUMNS = {
  ...SLOT_COLUMNS,
  workOrder: { select: { id: true, number: true, status: true, rush: true, dueDate: true, style: { select: { id: true, code: true, name: true } } } },
  operation: { select: { id: true, seq: true, code: true, name: true } },
} as const satisfies Prisma.ScheduleSlotSelect
export type VersionSlotRow = Prisma.ScheduleSlotGetPayload<{ select: typeof VERSION_SLOT_COLUMNS }>

const compareOf = (slot: { id: string; workOrderId: string; workOrderOperationId: string | null; lineId: string | null; workCentreId: string | null; partyId: string | null; startAt: Date; endAt: Date; pieces: number | null }): CompareSlot => ({
  id: slot.id,
  workOrderId: slot.workOrderId,
  operationId: slot.workOrderOperationId,
  lane: laneOfSlot(slot),
  startAt: slot.startAt.getTime(),
  endAt: slot.endAt.getTime(),
  pieces: slot.pieces,
})

/** A published version of a site the reader plans, with its site (404 otherwise). */
export async function publishedVersionFor(db: Reader, caller: CommandCaller, versionId: string): Promise<PlanRow & { site: SiteRow }> {
  const context = officeContextOf(caller)
  const version = isUuid(versionId) ? await db.planVersion.findUnique({ where: { id: versionId }, select: { ...PLAN_COLUMNS, site: { select: SITE_COLUMNS } } }) : null
  if (!version || version.kind !== 'PUBLISHED') throw new NotFoundError('Published version not found.')
  assertMayAt(context, PLANNING_VIEW, { companyId: version.companyId, siteId: version.siteId }, 'Published version')
  return version
}

/** The version's slots with their records, and the world's working slots on its days. */
export async function versionSlotsOf(db: Reader, world: ScheduleWorld, version: PlanRow) {
  const slots = await db.scheduleSlot.findMany({ where: { planVersionId: version.id }, select: VERSION_SLOT_COLUMNS, orderBy: [{ startAt: 'asc' }, { id: 'asc' }] })
  const tz = world.site.timezone
  const range = { start: businessDayStart(dayOf(version.coversFrom!), tz), end: businessDayStart(plusDays(dayOf(version.coversTo!), 1), tz) }
  const working = world.slots.filter((slot) => slot.startAt < range.end && slot.endAt > range.start)
  return { slots, working, compare: compareVersion(slots.map(compareOf), working.map(compareOf)) }
}

/** GET /planning/schedule/versions/:versionId/board. */
export async function versionBoard(caller: CommandCaller, versionId: string) {
  return caller.withClient(async (db) => {
    const version = await publishedVersionFor(db, caller, versionId)
    const site = version.site
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(db, site, { from: today, to: today }, now)
    const { slots, compare } = await versionSlotsOf(db, world, version)
    const names = await userNamesOf(db, slots.flatMap((slot) => [slot.updatedById, slot.pinnedById]))
    const floor = await floorStatusesOf(db, world, slots)
    const lanes = await laneNamesOf(db, slots.map(laneOfSlot))
    // CURRENT: the floor works to it now; UPCOMING: it waits for its start and no later version came; else REPLACED.
    const { current } = await floorVersionsOf(db, site.id, now)
    const later = await db.planVersion.count({ where: { siteId: site.id, kind: 'PUBLISHED', number: { gt: version.number! } } })
    const state = current?.id === version.id ? ('CURRENT' as const) : version.effectiveFrom! > now && later === 0 ? ('UPCOMING' as const) : ('REPLACED' as const)
    const laneList = [...new Map(slots.map((slot) => [laneKey(laneOfSlot(slot)), laneOfSlot(slot)])).values()]
      .map((lane) => ({ kind: lane.kind, id: lane.id, code: lanes.get(laneKey(lane))?.code ?? '', name: lanes.get(laneKey(lane))?.name ?? '' }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))
    return {
      site: siteViewOf(site),
      asOf: toUtcIso(now),
      version: await versionHeaderOf(db, version),
      readOnly: true as const,
      floor: state,
      lanes: laneList,
      slots: slots.map((slot) => {
        const lane = lanes.get(laneKey(laneOfSlot(slot)))
        const beside = compare.slots.get(slot.id)!
        return {
          ...storedSlotView(slot, names),
          workOrder: { id: slot.workOrder.id, number: slot.workOrder.number, status: slot.workOrder.status, rush: slot.workOrder.rush, dueDate: slot.workOrder.dueDate ? dayOf(slot.workOrder.dueDate) : null, style: slot.workOrder.style },
          operation: slot.operation,
          laneCode: lane?.code ?? '',
          laneName: lane?.name ?? '',
          floor: floor.get(slot.id) ?? null,
          working: { state: beside.state, slot: beside.working ? { id: beside.working.id, lane: beside.working.lane, startAt: toUtcIso(new Date(beside.working.startAt)), endAt: toUtcIso(new Date(beside.working.endAt)) } : null },
        }
      }),
      compare: {
        moved: compare.moved,
        added: compare.added.length,
        removed: compare.removed,
        words: compareWords(version.number!, { moved: compare.moved, added: compare.added.length, removed: compare.removed }),
        addedSlots: compare.added.map((slot) => ({ id: slot.id, workOrderId: slot.workOrderId, operationId: slot.operationId, lane: slot.lane, startAt: toUtcIso(new Date(slot.startAt)), endAt: toUtcIso(new Date(slot.endAt)) })),
      },
    }
  })
}
