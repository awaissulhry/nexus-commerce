import { toUtcIso } from '@nexus/factory-domain/core/time'
import { floorStatusOf, floorStatusWords, type FloorOperationFacts, type FloorScanRow } from '@nexus/factory-domain/planning/schedule-log/floor-status'
import { laneKey, laneOfSlot } from '@nexus/factory-domain/planning/schedule/slots'
import type { Reader } from '../store'
import type { BoardOperation, ScheduleWorld } from '../schedule/service'
import type { FloorStatusView } from './floor-contract'

/**
 * The floor's state of the board's bars (B-W2b-329; PLN-133; factory-domain planning/schedule-log/floor-status): one read of
 * the scans of the operations the bars book (every kind: the count rows end a stretch too), on the caller's client. A bar of
 * a work order that is not open any more gets none (its work order says why). A whole-order part books the operations its
 * lane does (a line: those of its work centres; a workshop: every one). The scans' workers and stations are read only to
 * tell stretches apart, never answered.
 */

export interface FloorSlot {
  readonly id: string
  readonly workOrderId: string
  readonly workOrderOperationId: string | null
  readonly lineId: string | null
  readonly workCentreId: string | null
  readonly partyId: string | null
  readonly pieces: number | null
}

const SCAN_COLUMNS = {
  id: true,
  workOrderOperationId: true,
  bundleId: true,
  kind: true,
  correctsId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  pauseReasonCode: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  deviceTime: true,
  serverTime: true,
} as const

/** The operations a slot books on the world (a bar: its own; a part: those its lane does). */
function operationsOf(world: ScheduleWorld, slot: FloorSlot): readonly BoardOperation[] {
  const workOrder = world.workOrders.find((candidate) => candidate.id === slot.workOrderId)
  if (!workOrder) return []
  if (slot.workOrderOperationId) return workOrder.operations.filter((operation) => operation.id === slot.workOrderOperationId)
  const lane = laneOfSlot(slot)
  const does = lane.kind === 'LINE' ? (world.lanes.get(laneKey(lane))?.does ?? null) : null
  return workOrder.operations.filter((operation) => does === null || does.includes(operation.workCentreId))
}

/** Per slot id its floor state (absent: its work order is not open, or it books no operation). */
export async function floorStatusesOf(db: Reader, world: ScheduleWorld, slots: readonly FloorSlot[]): Promise<Map<string, FloorStatusView>> {
  const out = new Map<string, FloorStatusView>()
  const booked = slots.map((slot) => ({ slot, operations: operationsOf(world, slot) })).filter((entry) => entry.operations.length > 0)
  const wanted = [...new Set(booked.flatMap((entry) => entry.operations.filter((operation) => operation.remaining > 0).map((operation) => operation.id)))]
  const rows = wanted.length === 0 ? [] : await db.operationScan.findMany({ where: { workOrderOperationId: { in: wanted } }, select: SCAN_COLUMNS, orderBy: [{ serverTime: 'asc' }, { id: 'asc' }] })
  const rowsOf = new Map<string, FloorScanRow[]>()
  for (const row of rows) rowsOf.set(row.workOrderOperationId, [...(rowsOf.get(row.workOrderOperationId) ?? []), row])
  const garmentsOf = new Map(world.workOrders.map((workOrder) => [workOrder.id, workOrder.garments]))
  for (const { slot, operations } of booked) {
    const garments = garmentsOf.get(slot.workOrderId) ?? 0
    const facts: FloorOperationFacts[] = operations.map((operation) => ({ garments, remaining: operation.remaining, rows: rowsOf.get(operation.id) ?? [] }))
    // A part of the order on a lane: its own garments (a share of the work order's), else the whole order's.
    const status = floorStatusOf(facts, slot.workOrderOperationId === null && slot.pieces !== null ? slot.pieces : garments)
    out.set(slot.id, {
      state: status.state,
      done: status.done,
      of: status.of,
      pct: status.pct,
      runningBundles: status.runningBundles,
      pausedBundles: status.pausedBundles,
      since: status.since ? toUtcIso(status.since) : null,
      pauseReasonCode: status.pauseReasonCode,
      lastScanAt: status.lastScanAt ? toUtcIso(status.lastScanAt) : null,
      words: floorStatusWords(status, world.site.timezone),
    })
  }
  return out
}
