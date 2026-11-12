import { businessDate } from '@nexus/factory-domain/core/time'
import { holdWords } from '@nexus/factory-domain/planning/milestones/rules'
import type { MaterialStart } from '@nexus/factory-domain/planning/schedule-depth/material'
import { leftInThePast } from '@nexus/factory-domain/planning/schedule-depth/forward'
import { laneOfSlot, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { whenWords } from '@nexus/factory-domain/planning/schedule/time'
import type { Reader } from '../store'
import { gateHoldsOf } from '../schedule/gates'
import type { ScheduleWorld } from '../schedule/service'
import { firstLaneOf, materialCheckOf } from './material'

/**
 * The problems list's three W2b kinds (B-W2b-312; design planning.board "Problems in this plan": "Operations in the past
 * (W2b)", "Material not in time (W2b)", "Gate not passed (W2b)"; "Show on board" outlines the bar named by `slotId`):
 *
 *   IN_THE_PAST          a bar that should have ended by now while its operation has work left (the backlog, PLN-141)
 *   MATERIAL_NOT_IN_TIME a work order on the board that starts before its earliest start with material (PLN-134)
 *   GATE_NOT_PASSED      a work order on the board whose order waits on a pre-production gate (B-W2b-263's hold)
 *
 * Read on the board's world (no query but the gates'); the material from the readiness the board already computed.
 */

export interface DepthProblem {
  readonly kind: 'IN_THE_PAST' | 'MATERIAL_NOT_IN_TIME' | 'GATE_NOT_PASSED'
  readonly words: string
  readonly lane: LaneRef | null
  readonly date: string | null
  readonly bucketKey: null
  readonly overMinutes: null
  readonly loadPct: null
  readonly workOrderId: string
  readonly daysLate: null
  readonly slotId: string | null
}

export async function depthProblemsOf(db: Reader, world: ScheduleWorld, starts: ReadonlyMap<string, MaterialStart> | null): Promise<DepthProblem[]> {
  const now = world.now.getTime()
  const tz = world.site.timezone
  const say = (instant: number) => whenWords(instant, tz)
  const out: DepthProblem[] = []
  const blank = { bucketKey: null, overMinutes: null, loadPct: null, daysLate: null } as const
  for (const workOrder of world.workOrders) {
    const bars = world.slots.filter((slot) => slot.workOrderId === workOrder.id)
    for (const slot of bars) {
      if (slot.workOrderOperationId === null) continue
      const operation = workOrder.operations.find((candidate) => candidate.id === slot.workOrderOperationId)
      if (!operation || !leftInThePast({ end: slot.endAt.getTime() }, operation.remaining, now)) continue
      const garments = operation.remaining === 1 ? '1 garment is' : `${operation.remaining} garments are`
      out.push({
        kind: 'IN_THE_PAST',
        words: `${workOrder.number} Op ${operation.seq} ${operation.name} was planned to end ${say(slot.endAt.getTime())} and ${garments} still to do there: ${slot.pinned ? 'it is pinned (unpin it to reschedule it)' : 'reschedule the backlog'}.`,
        lane: laneOfSlot(slot),
        date: businessDate(slot.endAt, tz),
        workOrderId: workOrder.id,
        slotId: slot.id,
        ...blank,
      })
    }
    const start = starts?.get(workOrder.id)
    const schedule = world.schedules.get(workOrder.id)
    if (start && schedule && schedule.plannedStart !== null && schedule.status !== 'DONE' && (start.state === 'ARRIVES' || start.state === 'NOT_COVERED')) {
      const first = [...bars].sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || (a.id < b.id ? -1 : 1))[0]
      const check = materialCheckOf(world, start, first ? laneOfSlot(first) : firstLaneOf(world, workOrder), schedule.plannedStart)
      if (!check.inTime) {
        out.push({ kind: 'MATERIAL_NOT_IN_TIME', words: `${workOrder.number} starts ${say(schedule.plannedStart)} on the board. ${check.words}`, lane: first ? laneOfSlot(first) : null, date: start.startDay, workOrderId: workOrder.id, slotId: first?.id ?? null, ...blank })
      }
    }
  }
  const onBoard = world.workOrders.filter((workOrder) => world.slots.some((slot) => slot.workOrderId === workOrder.id))
  const holds = await gateHoldsOf(db, onBoard.map((workOrder) => workOrder.id))
  for (const workOrder of onBoard) {
    const gates = holds.get(workOrder.id)
    if (!gates) continue
    const first = world.slots.filter((slot) => slot.workOrderId === workOrder.id).sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || (a.id < b.id ? -1 : 1))[0]!
    out.push({ kind: 'GATE_NOT_PASSED', words: holdWords(workOrder.number, gates), lane: laneOfSlot(first), date: businessDate(first.startAt, tz), workOrderId: workOrder.id, slotId: first.id, ...blank })
  }
  return out
}
