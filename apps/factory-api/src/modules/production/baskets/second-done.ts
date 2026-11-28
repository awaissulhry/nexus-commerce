import { newId } from '@nexus/factory-domain/core/ids'
import { basketPlace, lastMove, type BasketPlace } from '@nexus/factory-domain/production/baskets/place'
import { basketRoute, scannedSteps, type RouteMarks } from '@nexus/factory-domain/production/baskets/route'
import { standingKey, type ScanFact } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTools } from '../../../core/command'
import type { FloorContext } from '../../../core/context'
import type { OperationRow, Reader, ScanHeader } from '../scans/store'
import { floorRecordSubjectFor } from '../settings/subject'
import { employeesOf } from '../terminal/store'
import { readEdits, readMoves, type MoveRow } from './store'

/**
 * The basket inside the REPORT command (owb- order workflow, S5 fl2; build/briefs/owb-fl2.md steps 1-2): the scans' command
 * (A/production/scans/scans.ts reportInCommand) reads the basket's OWN route and place here, after its locks, and asks
 * `secondDone` before it would refuse ALREADY_REPORTED.
 *
 *   basketInCommand   the route (factory-domain basketRoute over the work order's operations and the basket's route edits:
 *                     with none, the operations array itself) and the place (basketPlace over its standing reports and hand
 *                     moves: with none, exactly today's). Every rule of the report then reads the route.
 *   secondDone        "Done" at a step where a report already stands, when the basket's place is THAT step by a hand move
 *                     newer than the report (a move back to be done again, then Done): no second scan (the one-standing-report
 *                     trigger stays), no pay, no cost — a FORWARD BasketMove to the next step of its route (none: Ready to
 *                     ship, the last step being reported). The report answers 200 with `moved: true` and the step.
 *
 * The move names the worker only where the site's floor rules name workers (floorRecordSubjectFor), its device, and the
 * report's clientScanId as its client event id (a resend is answered by the command's receipt).
 */

export interface BasketInCommand {
  readonly route: (OperationRow & RouteMarks)[]
  readonly place: BasketPlace
  readonly moves: readonly MoveRow[]
}

/** The basket's route and place inside the command (see the file's head). */
export async function basketInCommand(tx: Reader, bundleId: string, operations: readonly OperationRow[], standing: ReadonlyMap<string, Pick<ScanFact, 'serverTime'>>): Promise<BasketInCommand> {
  const moves = (await readMoves(tx, [bundleId])).get(bundleId) ?? []
  const edits = (await readEdits(tx, [bundleId])).get(bundleId) ?? []
  const route = basketRoute(operations, edits)
  return { route, place: basketPlace(route, standing, bundleId, moves), moves }
}

/** Whether a Done at `operationId` is the second Done of a basket moved back to it (see the file's head). */
export function isSecondDone(basket: BasketInCommand, standing: ReadonlyMap<string, Pick<ScanFact, 'serverTime'>>, bundleId: string, operationId: string | null): boolean {
  if (operationId === null || basket.place.how !== 'MOVE' || basket.place.operationId !== operationId) return false
  const report = standing.get(standingKey(bundleId, operationId))
  const move = lastMove(basket.moves)
  return report !== undefined && move !== null && report.serverTime.getTime() <= move.serverTime.getTime()
}

/** What a second Done answers: the basket moved on, to the next step of its route (null: Ready to ship). */
export interface MovedOn {
  readonly moved: true
  readonly bundleId: string
  readonly from: string
  readonly to: string | null
  readonly groupId: string
}

/** Writes the FORWARD move of a second Done (see the file's head). */
export async function secondDone(tools: CommandTools, input: { readonly context: FloorContext; readonly workOrder: ScanHeader; readonly bundleId: string; readonly bundleCode: string; readonly basket: BasketInCommand; readonly from: string; readonly stationId: string | null; readonly clientScanId: string; readonly deviceTime: Date | null }): Promise<MovedOn> {
  const scanned = scannedSteps(input.basket.route)
  const at = scanned.findIndex((step) => step.id === input.from)
  const to = at < 0 ? null : (scanned[at + 1]?.id ?? null)
  const subject = await floorRecordSubjectFor(tools.tx, { siteId: input.workOrder.siteId, workerId: input.context.actorId, stationId: input.stationId })
  const employees = subject.workerId ? await employeesOf(tools.tx, [subject.workerId]) : new Map<string, string | null>()
  const id = newId()
  const groupId = newId()
  await tools.tx.basketMove.create({
    data: {
      id,
      siteId: input.workOrder.siteId,
      workOrderId: input.workOrder.id,
      bundleId: input.bundleId,
      fromOperationId: input.from,
      toOperationId: to,
      kind: 'FORWARD',
      groupId,
      workerId: subject.workerId,
      employeeId: subject.workerId ? (employees.get(subject.workerId) ?? null) : null,
      deviceId: input.context.deviceId,
      clientEventId: input.clientScanId,
      deviceTime: input.deviceTime,
      serverTime: tools.now,
    },
    select: { id: true },
  })
  tools.audit({ action: 'production.baskets.move', recordType: 'BasketMove', recordId: id, companyId: input.workOrder.companyId, siteId: input.workOrder.siteId, after: { bundleId: input.bundleId, code: input.bundleCode, kind: 'FORWARD', from: input.from, to, groupId, secondDone: true, workerId: subject.workerId } })
  return { moved: true, bundleId: input.bundleId, from: input.from, to, groupId }
}
