import type { ScheduleStatus } from '@nexus/factory-domain/planning/schedule/backward'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { board } from '../schedule/board'
import type { FloorStatusView } from './floor-contract'
import { versionBoard } from './version-board'

/**
 * The board as a sheet (B-W2b-329; PLN-154 "the board as XLSX"; the export source platform/exports/sources/schedule-board):
 * one row per bar, in start order, read through the board's own reads, so the file holds what the screen shows the person:
 * the working plan's bars reaching into the board's days (B-W2a-34's GET /planning/schedule, without the material netting),
 * or a published version's bars (GET …/versions/:id/board). Each with its lane, times, work order, operation, garments still
 * to do (a part: its garments), standard minutes, due date, the work order's schedule state (the working plan) and its state
 * on the floor now.
 */

export interface BoardSheetRow {
  readonly id: string
  readonly lane: { readonly kind: 'LINE' | 'WORK_CENTRE' | 'WORKSHOP'; readonly code: string; readonly name: string }
  readonly startAt: string
  readonly endAt: string
  readonly rush: boolean
  readonly workOrder: string
  readonly style: string
  readonly operation: { readonly seq: number; readonly name: string } | null
  readonly pieces: number
  readonly minutes: string
  readonly dueDate: BusinessDate | null
  readonly schedule: ScheduleStatus | null
  readonly floor: Pick<FloorStatusView, 'state' | 'done' | 'of'> | null
  readonly pinned: boolean
  readonly note: string | null
}

export type BoardSheetQuery = { readonly siteId: string; readonly from?: BusinessDate; readonly to?: BusinessDate } | { readonly versionId: string }

export async function boardSheetRows(caller: CommandCaller, query: BoardSheetQuery): Promise<BoardSheetRow[]> {
  if ('versionId' in query) {
    const answer = await versionBoard(caller, query.versionId)
    return answer.slots.map((slot) => ({
      id: slot.id,
      lane: { kind: slot.lane.kind, code: slot.laneCode, name: slot.laneName },
      startAt: slot.startAt,
      endAt: slot.endAt,
      rush: slot.workOrder.rush,
      workOrder: slot.workOrder.number,
      style: `${slot.workOrder.style.code} ${slot.workOrder.style.name}`,
      operation: slot.operation ? { seq: slot.operation.seq, name: slot.operation.name } : null,
      pieces: slot.pieces ?? slot.floor?.of ?? 0,
      minutes: slot.minutes,
      dueDate: slot.workOrder.dueDate,
      schedule: null,
      floor: slot.floor ? { state: slot.floor.state, done: slot.floor.done, of: slot.floor.of } : null,
      pinned: slot.pinned,
      note: slot.note,
    }))
  }
  const answer = await board(caller, { siteId: query.siteId, ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), readiness: 'false' })
  const lanes = new Map(answer.lanes.map((lane) => [`${lane.kind}:${lane.id}`, lane]))
  const orders = new Map(answer.workOrders.map((workOrder) => [workOrder.id, workOrder]))
  return [...answer.slots]
    .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id))
    .map((slot) => {
      const lane = lanes.get(`${slot.lane.kind}:${slot.lane.id}`)
      const workOrder = orders.get(slot.workOrderId)
      const operation = slot.operationId ? workOrder?.operations.find((candidate) => candidate.id === slot.operationId) : undefined
      return {
        id: slot.id,
        lane: { kind: slot.lane.kind, code: lane?.code ?? '', name: lane?.name ?? '' },
        startAt: slot.startAt,
        endAt: slot.endAt,
        rush: workOrder?.rush ?? false,
        workOrder: workOrder?.number ?? '',
        style: workOrder ? `${workOrder.style.code} ${workOrder.style.name}` : '',
        operation: operation ? { seq: operation.seq, name: operation.name } : null,
        pieces: operation ? operation.remainingPieces : (slot.pieces ?? workOrder?.garments ?? 0),
        minutes: slot.minutes,
        dueDate: workOrder?.dueDate ?? null,
        schedule: workOrder?.schedule.status ?? null,
        floor: slot.floor ? { state: slot.floor.state, done: slot.floor.done, of: slot.floor.of } : null,
        pinned: slot.pinned,
        note: slot.note,
      }
    })
}
