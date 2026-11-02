import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { openSteps, standingTicks, type ChecklistOutcome, type ChecklistStep } from '@nexus/factory-domain/production/checklists/rules'
import { isOwn, type Viewer } from '@nexus/factory-domain/production/scans/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { workerGateFor } from '../../people/privacy/worker-gate'
import { floorOf, scanWorkOrder } from '../scans/access'
import { deviceStationOf, readOperations, readStations, workerNames, type Reader } from '../scans/store'
import { scanSubjectFor } from '../settings/subject'
import { bundleState } from '../terminal/views'
import type { BundleRef } from '../terminal/timing'
import { readBundleTicks, readTicks, stepsOfOperation, type TickRow } from './store'

/**
 * The steps of a bundle at an operation (B-W2b-47; MES-102: "each with who and when"). The tablet: the steps, what stands
 * for each (when, whether it is the viewer's own), how many required ones are open. Another person's tick says "another
 * person" (no name) on an operator's tablet, the name on a team leader's where the site names workers (floor.lead), as a
 * refusal's words do. The office: one bundle's ticks, all of them, inside the work order record (Owner answer W1: names
 * only inside one record, never a list, filter or total; a site that records stations has no name to show).
 */

export function checklistView(steps: readonly ChecklistStep[], ticks: readonly TickRow[], viewer: Viewer, names: ReadonlyMap<string, string>) {
  const standing = standingTicks(ticks)
  return {
    steps: steps.map((step) => {
      const tick = standing.get(step.code)
      return { code: step.code, words: step.words, required: step.required, tick: tick ? { outcome: tick.outcome as ChecklistOutcome, at: toUtcIso(tick.serverTime), mine: isOwn(tick, viewer), by: tick.workerId ? (names.get(tick.workerId) ?? null) : null } : null }
    }),
    open: openSteps(steps, ticks).length,
  }
}
export type ChecklistView = ReturnType<typeof checklistView>

/** The names a viewer sees on these ticks: their own, or all of them for a team leader. */
export async function tickNames(db: Reader, ticks: readonly TickRow[], viewer: Viewer, lead: boolean): Promise<Map<string, string>> {
  return workerNames(db, ticks.map((tick) => tick.workerId).filter((workerId) => workerId !== null && (lead || workerId === viewer.workerId)))
}

export const floorViewerOf = async (db: Reader, context: { readonly actorId: string; readonly deviceId: string; readonly siteId: string }): Promise<Viewer> => {
  const scanSubject = await scanSubjectFor(db, context.siteId)
  return { scanSubject, workerId: scanSubject === 'WORKER' ? context.actorId : null, stationId: await deviceStationOf(db, context.deviceId) }
}

/** GET /production/checklists/state: the operation as the operation screen decides it (terminal's state), and its steps. */
export async function checklistState(caller: CommandCaller, query: BundleRef) {
  const context = floorOf(caller)
  const state = await bundleState(caller, query)
  return caller.withClient(async (db) => {
    const viewer = await floorViewerOf(db, context)
    const steps = await stepsOfOperation(db, state.operation.id)
    const ticks = await readTicks(db, state.bundle.id, state.operation.id)
    const names = await tickNames(db, ticks, viewer, holds(actorOf(context), 'floor.lead'))
    return { bundle: { id: state.bundle.id, code: state.bundle.code }, operation: state.operation, ...checklistView(steps, ticks, viewer, names) }
  })
}

/** GET /production/checklists/work-orders/:workOrderId?bundleId: one bundle's steps, operation by operation, with every tick. */
export async function workOrderChecklists(caller: CommandCaller, workOrderId: string, bundleId: string) {
  const workOrder = await scanWorkOrder(caller, workOrderId, 'workorders.view')
  return caller.withClient(async (db) => {
    const bundle = isUuid(bundleId) ? await db.bundle.findFirst({ where: { id: bundleId, workOrderId: workOrder.id }, select: { id: true, code: true } }) : null
    if (!bundle) throw new NotFoundError('Bundle not found.')
    const ticks = await readBundleTicks(db, bundle.id)
    const who = await workerGateFor(db, workOrder.siteId)
    const names = await workerNames(db, who.lookup(ticks.map((tick) => tick.workerId)))
    const stations = await readStations(db, ticks.map((tick) => tick.stationId))
    const operations = []
    for (const operation of await readOperations(db, workOrder.id)) {
      const steps = await stepsOfOperation(db, operation.id)
      const own = ticks.filter((tick) => tick.workOrderOperationId === operation.id)
      if (steps.length === 0 && own.length === 0) continue
      operations.push({
        operation: { id: operation.id, seq: operation.seq, code: operation.code, name: operation.name },
        steps: steps.map((step) => ({ code: step.code, words: step.words, required: step.required })),
        open: openSteps(steps, own).length,
        ticks: own.map((tick) => ({ id: tick.id, stepCode: tick.stepCode, outcome: tick.outcome as ChecklistOutcome, at: toUtcIso(tick.serverTime), deviceTime: tick.deviceTime ? toUtcIso(tick.deviceTime) : null, by: who.name(tick.workerId, names), byHidden: who.hidden(tick.workerId), station: tick.stationId ? (stations.get(tick.stationId)?.code ?? null) : null })),
      })
    }
    return { bundle, operations }
  })
}
