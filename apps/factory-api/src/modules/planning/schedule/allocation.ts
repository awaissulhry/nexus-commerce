import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { allocationProblems, mainPiecesOf, type Allocation } from '@nexus/factory-domain/planning/schedule/allocation'
import { PLANNING_SCHEDULE_MANAGE } from '@nexus/factory-domain/planning/schedule/permissions'
import { ScheduleRefusal } from '@nexus/factory-domain/planning/schedule/refusals'
import { laneColumns, laneKey, laneOfSlot, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { MINUTE_MS } from '@nexus/factory-domain/planning/schedule/time'
import { OPEN_STATUSES as SUBCONTRACT_OPEN } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { uniformBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, mayAt, officeContextOf, siteFor } from '../access'
import { capacityAnswer } from '../capacity/service'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import type { AllocateBody } from './contract'
import { siteViewOf } from './publish'
import { scheduleWorld, type BoardWorkOrder, type ScheduleWorld } from './service'
import { slotMinutes } from './slots'
import { laneFacts, lockedWorkingPlan } from './store'

/**
 * Allocation to lines and workshops (B-W2a-34; PLN-160; design planning.allocation "Lanes", "Allocation board"; factory-
 * domain planning/schedule/allocation for the rule): planning.view reads, planning.schedule.manage allocates. Columns:
 * "Not allocated", each ACTIVE line of the site (its load over the next four weeks, its garments), each workshop (a
 * SUBCONTRACTOR party with a location at the site: its garments and live subcontract orders; qualification is W2b),
 * plants (W3: another site). Cards: each open work order's line part (or not allocated) and each of its parts.
 *
 * PUT …/work-orders/:id sets the whole allocation of one work order in ONE command: the site's schedule lock and the
 * working plan's bump, then the work order at the version the board read (compare-and-set, its row locked): its line
 * (WorkOrder.lineId: an ACTIVE line of the site; when the line changes, the bars on the old line that the new line does
 * follow it, at their times) and its parts as whole-order slots of the working plan (one per lane; garments; minutes;
 * from the work order's latest safe start, or now, to its due date's end, or what the work takes). The capacity counts
 * the parts by their garments (planning/capacity/load). Moving work to a workshop plans it there; the subcontract order
 * itself is purchasing's (POST /purchasing/subcontracting/orders, B-W2a-25), the board's "planned subcontract order" W2b.
 */

const LOCKED = new Set(['COMPLETED', 'CLOSED', 'CANCELLED'])

function cardsOf(world: ScheduleWorld, workOrder: BoardWorkOrder) {
  const schedule = world.schedules.get(workOrder.id)!
  // Its parts: whole-order slots on a line or at a workshop.
  const parts = world.slots.filter((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === null && slot.workCentreId === null)
  const allocation: Allocation = { lineId: workOrder.lineId, parts: parts.map((slot) => ({ lane: laneOfSlot(slot) as { kind: 'LINE' | 'WORKSHOP'; id: string }, pieces: slot.pieces ?? workOrder.garments })) }
  const head = {
    workOrder: {
      id: workOrder.id,
      number: workOrder.number,
      status: workOrder.status,
      version: workOrder.version,
      dueDate: workOrder.dueDate,
      style: workOrder.style,
      // B-W2b-20: the style's family (design "Cards: order, style, pieces, minutes, due date, family") and the customer.
      family: workOrder.family,
      customer: workOrder.customers.length === 1 ? workOrder.customers[0]! : null,
      garments: workOrder.garments,
      holdReason: workOrder.holdReason,
    },
    schedule: { status: schedule.status, words: schedule.words, latestSafeStart: schedule.latestSafeStart === null ? null : toUtcIso(new Date(schedule.latestSafeStart)) },
  }
  const main = mainPiecesOf(allocation, workOrder.garments)
  const mainLane: LaneRef | null = workOrder.lineId ? { kind: 'LINE', id: workOrder.lineId } : null
  const cards = []
  if (main > 0) {
    cards.push({ id: `${workOrder.id}:LINE`, ...head, lane: mainLane ? { kind: 'LINE' as const, id: mainLane.id } : null, pieces: main, minutes: slotMinutes(world, workOrder, null, mainLane, main).toFixed(1), slot: null })
  }
  for (const slot of parts) {
    const lane = laneOfSlot(slot) as { kind: 'LINE' | 'WORKSHOP'; id: string }
    cards.push({ id: `${workOrder.id}:${slot.id}`, ...head, lane, pieces: slot.pieces ?? workOrder.garments, minutes: new Dec(slot.minutes.toString()).toFixed(1), slot: { id: slot.id, version: slot.version } })
  }
  return cards
}

/** GET /planning/allocation: the allocation board of a site. */
export async function allocationBoard(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(db, site, { from: today, to: plusDays(today, 27) }, now)
    const cards = world.workOrders.flatMap((workOrder) => cardsOf(world, workOrder))
    const answer = capacityAnswer(world.capacity, { from: today, to: plusDays(today, 27), buckets: uniformBuckets(today, plusDays(today, 27), 'WEEK') })
    const subcontracts = world.workshops.length
      ? await db.subcontractOrder.groupBy({ by: ['partyId'], where: { siteId: site.id, partyId: { in: world.workshops.map((workshop) => workshop.id) }, status: { in: [...SUBCONTRACT_OPEN] } }, _count: { _all: true } })
      : []
    const piecesOn = (lane: LaneRef) => cards.filter((card) => card.lane !== null && laneKey(card.lane) === laneKey(lane)).reduce((sum, card) => sum + card.pieces, 0)
    const lanes = [
      ...answer.lanes
        .filter((lane) => lane.kind === 'LINE')
        .map((lane) => ({ kind: 'LINE' as const, id: lane.id, code: lane.code, name: lane.name, load: lane.overall, piecesBooked: piecesOn({ kind: 'LINE', id: lane.id }), location: null, subcontractOrders: null })),
      ...world.workshops.map((workshop) => ({
        kind: 'WORKSHOP' as const,
        id: workshop.id,
        code: workshop.code,
        name: workshop.name,
        load: null,
        piecesBooked: piecesOn({ kind: 'WORKSHOP', id: workshop.id }),
        location: workshop.location,
        subcontractOrders: subcontracts.find((row) => row.partyId === workshop.id)?._count._all ?? 0,
      })),
    ]
    return {
      site: siteViewOf(site),
      asOf: toUtcIso(now),
      today,
      plan: { id: world.plan?.id ?? null, version: world.plan?.version ?? null },
      mayChange: mayAt(context, PLANNING_SCHEDULE_MANAGE, { companyId: site.companyId, siteId: site.id }),
      lanes,
      cards,
    }
  })
}

async function workOrderSite(caller: CommandCaller, workOrderId: string): Promise<{ id: string; companyId: string; siteId: string; site: SiteRow }> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db: Reader) => (isUuid(workOrderId) ? db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, site: { select: SITE_COLUMNS } } }) : Promise.resolve(null)))
  assertMayAt(context, PLANNING_SCHEDULE_MANAGE, row ? { companyId: row.companyId, siteId: row.siteId } : null, 'Work order')
  return row!
}

/** PUT /planning/allocation/work-orders/:workOrderId: the work order's line and its parts on other lanes. */
export async function allocate(caller: CommandCaller, workOrderId: string, body: AllocateBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await workOrderSite(caller, workOrderId)
  const { result, replayed } = await command(caller, { name: 'planning.schedule.allocate', idempotencyKey, input: { workOrderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const row = await tx.workOrder.findUniqueOrThrow({ where: { id: target.id }, select: { version: true, status: true, number: true, lineId: true } })
    if (row.version !== body.version) throw new StaleVersionError('WorkOrder', target.id, row.version, body.version)
    if (LOCKED.has(row.status)) throw new ScheduleRefusal('WORK_ORDER_LOCKED', `${row.number} is ${row.status.toLowerCase()}: its allocation is kept as it was.`)
    const { count } = await tx.workOrder.updateMany({ where: { id: target.id, version: row.version }, data: { version: row.version + 1 } })
    if (count !== 1) throw new StaleVersionError('WorkOrder', target.id, row.version + 1, body.version)
    const today = businessDate(now, target.site.timezone)
    const world = await scheduleWorld(tx, target.site, { from: today, to: plusDays(today, 1) }, now)
    const workOrder = world.workOrders.find((candidate) => candidate.id === target.id)
    if (!workOrder) throw new ScheduleRefusal('NOT_OPEN', `${row.number} is not open: it is not allocated.`)
    const problems = allocationProblems({ lineId: body.lineId, parts: body.parts }, workOrder.garments)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    if (body.lineId) await laneFacts(tx, target.site, { kind: 'LINE', id: body.lineId })
    for (const part of body.parts) await laneFacts(tx, target.site, part.lane)
    const schedule = world.schedules.get(workOrder.id)!
    const start = new Date(Math.max(now.getTime(), schedule.latestSafeStart ?? now.getTime()))
    const end = new Date(Math.max(start.getTime() + 60 * MINUTE_MS, schedule.latestFinish ?? start.getTime() + 24 * 60 * MINUTE_MS))
    const existing = world.slots.filter((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === null)
    const audits: { slotId: string; change: string; lane: LaneRef; pieces: number | null }[] = []
    // The parts: one whole-order slot per lane.
    for (const part of body.parts) {
      const there = existing.find((slot) => laneKey(laneOfSlot(slot)) === laneKey(part.lane))
      const minutes = slotMinutes(world, workOrder, null, part.lane, part.pieces).toFixed(3)
      if (there) {
        if (there.pieces === part.pieces && there.minutes.toFixed(3) === minutes) continue
        await tx.scheduleSlot.update({ where: { id: there.id }, data: { pieces: part.pieces, minutes, version: there.version + 1, updatedAt: now, updatedById: context.actorId }, select: { id: true } })
        audits.push({ slotId: there.id, change: 'CHANGED', lane: part.lane, pieces: part.pieces })
      } else {
        const id = newId()
        await tx.scheduleSlot.create({
          data: { id, siteId: target.siteId, planVersionId: plan.id, planKind: 'WORKING', workOrderId: workOrder.id, workOrderOperationId: null, ...laneColumns(part.lane), startAt: start, endAt: end, pieces: part.pieces, minutes, createdAt: now, updatedAt: now, createdById: context.actorId, updatedById: context.actorId },
          select: { id: true },
        })
        audits.push({ slotId: id, change: 'ADDED', lane: part.lane, pieces: part.pieces })
      }
    }
    for (const slot of existing) {
      if (body.parts.some((part) => laneKey(part.lane) === laneKey(laneOfSlot(slot)))) continue
      await tx.scheduleSlot.delete({ where: { id: slot.id }, select: { id: true } })
      audits.push({ slotId: slot.id, change: 'REMOVED', lane: laneOfSlot(slot), pieces: slot.pieces })
    }
    // The line: the work order's own; its bars on the old line follow it when the new line does their operation.
    let barsMoved = 0
    if (body.lineId !== row.lineId) {
      await tx.workOrder.update({ where: { id: target.id }, data: { lineId: body.lineId }, select: { id: true } })
      const next = body.lineId ? world.lanes.get(laneKey({ kind: 'LINE', id: body.lineId })) : null
      if (row.lineId && next) {
        for (const slot of world.slots.filter((candidate) => candidate.workOrderId === workOrder.id && candidate.workOrderOperationId !== null && candidate.lineId === row.lineId)) {
          const operation = workOrder.operations.find((candidate) => candidate.id === slot.workOrderOperationId)
          if (!operation || (next.does !== null && !next.does.includes(operation.workCentreId))) continue
          await tx.scheduleSlot.update({ where: { id: slot.id }, data: { lineId: next.ref.id, overloadReason: null, version: slot.version + 1, updatedAt: now, updatedById: context.actorId }, select: { id: true } })
          audits.push({ slotId: slot.id, change: 'FOLLOWED_LINE', lane: next.ref, pieces: null })
          barsMoved += 1
        }
      }
    }
    if (audits.length === 0 && body.lineId === row.lineId) throw new ScheduleRefusal('ALREADY_ALLOCATED', `${row.number} is already allocated so.`)
    tools.audit({
      action: 'planning.schedule.allocate',
      recordType: 'WorkOrder',
      recordId: target.id,
      companyId: target.companyId,
      siteId: target.siteId,
      before: { lineId: row.lineId, parts: existing.map((slot) => ({ slotId: slot.id, lane: laneOfSlot(slot), pieces: slot.pieces })) },
      after: { lineId: body.lineId, parts: body.parts, slots: audits, barsMoved },
    })
    tools.emit({
      type: 'planning.schedule_changed',
      subject: plan.id,
      companyId: target.companyId,
      siteId: target.siteId,
      payload: { siteId: target.siteId, planVersionId: plan.id, planVersion: plan.version, change: 'ALLOCATED', slots: audits.length, slotIds: audits.map((entry) => entry.slotId).slice(0, 200), workOrderIds: [target.id] },
    })
    return { planVersion: plan.version }
  })
  const answer = await caller.withClient(async (db) => {
    const now = serverClock.now()
    const today = businessDate(now, target.site.timezone)
    const world = await scheduleWorld(db, target.site, { from: today, to: today }, now)
    const workOrder = world.workOrders.find((candidate) => candidate.id === target.id)
    if (!workOrder) throw new NotFoundError('Work order not found on the board.')
    return { workOrder: { id: workOrder.id, version: workOrder.version, lineId: workOrder.lineId }, cards: cardsOf(world, workOrder) }
  })
  return { ...answer, planVersion: result.planVersion, replayed }
}
