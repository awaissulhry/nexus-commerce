import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { RUN_LOG_VERSION, type ProtectedPlan, type RunInputs } from '@nexus/factory-domain/planning/run-log/inputs'
import type { CommandTools } from '../../../core/command'
import type { PlanInputs } from '../inputs'
import type { PassResult } from '../planned-orders/pass'
import type { SiteRow } from '../store'

/**
 * What a run read, as its log keeps it (B-W2b-306; PLN-095): written with the run in its RUNNING → DONE write
 * (PlanningRun.inputs; the database freezes it with the run). Counts, codes and days only.
 */
export async function runInputsOf(
  tools: Pick<CommandTools, 'tx'>,
  site: SiteRow,
  facts: {
    readonly runDate: BusinessDate
    readonly inputs: PlanInputs
    readonly orderLinesPlanned: number
    readonly passes: number
    readonly lateOrderLines: number
    readonly pass: Pick<PassResult, 'sizeRunRule' | 'firm' | 'guarded' | 'plain'>
    readonly protectedPlan: readonly ProtectedPlan[]
  },
): Promise<RunInputs> {
  const { inputs } = facts
  const input = inputs.input
  const settings = await tools.tx.planningSettings.findUnique({ where: { id: site.id }, select: { sizeGroups: true } })
  const lines = input.orderLines
  return {
    version: RUN_LOG_VERSION,
    runDate: facts.runDate,
    timezone: site.timezone,
    previousRunId: inputs.previousRunId ?? null,
    explosion: inputs.garments ? 'MULTI_LEVEL' : 'ONE_LEVEL',
    passes: facts.passes,
    sizeRunRule: facts.pass.sizeRunRule,
    sizeGroups: Array.isArray(settings?.sizeGroups) ? settings!.sizeGroups.length : 0,
    counts: {
      orderLines: lines.length + inputs.demand.unplaced.length,
      orderLinesPlanned: facts.orderLinesPlanned,
      orders: new Set(lines.map((line) => line.orderId)).size,
      lateOrderLines: facts.lateOrderLines,
      undatedOrderLines: lines.filter((line) => line.dueDate === null).length,
      madeToMeasure: lines.filter((line) => line.madeToMeasure === true).length,
      notPlaced: inputs.demand.unplaced.length,
      revisions: input.revisions.length,
      materials: inputs.items.length,
      workOrders: new Set(input.workOrderCells.map((cell) => cell.workOrderId)).size,
      workOrderCells: input.workOrderCells.length,
      scheduledWorkOrders: input.workOrderStarts?.size ?? 0,
      stockLines: input.stock.length,
      lots: input.lots.length,
      purchaseLines: inputs.purchases.length,
      purchaseOrders: new Set(inputs.purchases.map((line) => line.purchaseOrderId)).size,
      purchaseLinesForOneOrder: input.orderSpecific?.purchaseFor.size ?? 0,
      reservations: inputs.reservations.length,
      firmPlannedOrders: inputs.firmSupply.length,
      orderSpecificPegs: input.orderSpecific?.pegs.length ?? 0,
      itemParameters: inputs.itemPlanning.length,
      approvedSources: inputs.sources.length,
      plannedWorkOrdersFirm: facts.pass.firm,
      plannedWorkOrdersProtected: facts.pass.guarded,
      plannedWorkOrdersPlain: facts.pass.plain,
    },
    protectedPlan: facts.protectedPlan,
  }
}
