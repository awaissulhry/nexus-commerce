import type { BusinessDate } from '../../core/time'
import { WARNING_CODES, type PlanWarning, type WarningCode } from '../explode'

/**
 * The run log (B-W2b-306; PLN-095 "MRP run log with plain reasons"; design planning.mrp run-log "Per run: inputs snapshot
 * and warnings"), pure: what a run read, written with it (PlanningRun.inputs, frozen with the run), so the log of any run
 * says what it counted even after stock, orders and settings moved on.
 *
 *   counts      the demand (order lines read, planned, late, without a date, made-to-measure, not placed), the bills,
 *               work orders, stock and lots, open purchase lines (and those bought for one order line), reservations,
 *               firm planned orders, order-specific pegs, item parameters, approved sources, planned work orders kept,
 *               protected and plain
 *   settings    the run's day and zone, the size-run rule, the explosion (multi-level since B-W2b-293) and its passes
 *   plan        the plan's own value of every field a planner protected (`protectedPlan`): what Reset to plan puts back
 *
 * No money, no person: counts, codes and days.
 */

export const RUN_LOG_VERSION = 1

export interface RunLogCounts {
  readonly orderLines: number
  readonly orderLinesPlanned: number
  readonly orders: number
  readonly lateOrderLines: number
  readonly undatedOrderLines: number
  readonly madeToMeasure: number
  readonly notPlaced: number
  readonly revisions: number
  readonly materials: number
  readonly workOrders: number
  readonly workOrderCells: number
  readonly scheduledWorkOrders: number
  readonly stockLines: number
  readonly lots: number
  readonly purchaseLines: number
  readonly purchaseOrders: number
  readonly purchaseLinesForOneOrder: number
  readonly reservations: number
  readonly firmPlannedOrders: number
  readonly orderSpecificPegs: number
  readonly itemParameters: number
  readonly approvedSources: number
  readonly plannedWorkOrdersFirm: number
  readonly plannedWorkOrdersProtected: number
  readonly plannedWorkOrdersPlain: number
}

export interface ProtectedPlan {
  readonly plannedWorkOrderId: string
  /** The plan's value of each protected field (PlanFields' shape, JSON). */
  readonly fields: Readonly<Record<string, unknown>>
}

export interface RunInputs {
  readonly version: typeof RUN_LOG_VERSION
  readonly runDate: BusinessDate
  readonly timezone: string
  /** The run it superseded (whose firm orders and pegs it carried); null: the site's first. */
  readonly previousRunId: string | null
  readonly explosion: 'MULTI_LEVEL' | 'ONE_LEVEL'
  /** Netting passes of the multi-level explosion. */
  readonly passes: number
  readonly sizeRunRule: string
  readonly sizeGroups: number
  readonly counts: RunLogCounts
  readonly protectedPlan: readonly ProtectedPlan[]
}

const COUNT_KEYS: readonly (keyof RunLogCounts)[] = [
  'orderLines',
  'orderLinesPlanned',
  'orders',
  'lateOrderLines',
  'undatedOrderLines',
  'madeToMeasure',
  'notPlaced',
  'revisions',
  'materials',
  'workOrders',
  'workOrderCells',
  'scheduledWorkOrders',
  'stockLines',
  'lots',
  'purchaseLines',
  'purchaseOrders',
  'purchaseLinesForOneOrder',
  'reservations',
  'firmPlannedOrders',
  'orderSpecificPegs',
  'itemParameters',
  'approvedSources',
  'plannedWorkOrdersFirm',
  'plannedWorkOrdersProtected',
  'plannedWorkOrdersPlain',
]

/** The stored snapshot, read defensively (a run before W2b-5 stored `{}`: null). */
export function readRunInputs(value: unknown): RunInputs | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version !== RUN_LOG_VERSION || typeof row.runDate !== 'string') return null
  const counts = (row.counts && typeof row.counts === 'object' ? row.counts : {}) as Record<string, unknown>
  const whole = (entry: unknown) => (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 ? entry : 0)
  const plan = Array.isArray(row.protectedPlan) ? row.protectedPlan : []
  return {
    version: RUN_LOG_VERSION,
    runDate: row.runDate,
    timezone: typeof row.timezone === 'string' ? row.timezone : 'UTC',
    previousRunId: typeof row.previousRunId === 'string' ? row.previousRunId : null,
    explosion: row.explosion === 'ONE_LEVEL' ? 'ONE_LEVEL' : 'MULTI_LEVEL',
    passes: whole(row.passes) || 1,
    sizeRunRule: typeof row.sizeRunRule === 'string' ? row.sizeRunRule : 'ONE_GRID',
    sizeGroups: whole(row.sizeGroups),
    counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, whole(counts[key])])) as unknown as RunLogCounts,
    protectedPlan: plan.flatMap((entry) => {
      const item = entry as { plannedWorkOrderId?: unknown; fields?: unknown } | null
      return item && typeof item.plannedWorkOrderId === 'string' && item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields) ? [{ plannedWorkOrderId: item.plannedWorkOrderId, fields: item.fields as Record<string, unknown> }] : []
    }),
  }
}

/** The plan's values of one planned order's protected fields in a run's log (empty: none kept). */
export const protectedPlanOf = (inputs: RunInputs | null, plannedWorkOrderId: string): Readonly<Record<string, unknown>> => inputs?.protectedPlan.find((entry) => entry.plannedWorkOrderId === plannedWorkOrderId)?.fields ?? {}

/** The warnings counted per code, in the codes' order (the log's summary line). */
export function warningCounts(warnings: readonly Pick<PlanWarning, 'code'>[]): { readonly code: WarningCode; readonly count: number }[] {
  return WARNING_CODES.flatMap((code) => {
    const count = warnings.filter((warning) => warning.code === code).length
    return count > 0 ? [{ code, count }] : []
  })
}

/** What the run read, in one sentence (the log's head line). */
export function inputsSentence(inputs: RunInputs): string {
  const c = inputs.counts
  const parts = [
    `${c.orderLinesPlanned} of ${c.orderLines} order ${c.orderLines === 1 ? 'line' : 'lines'} planned (${c.orders} ${c.orders === 1 ? 'order' : 'orders'})`,
    `${c.materials} ${c.materials === 1 ? 'material' : 'materials'} from ${c.revisions} ${c.revisions === 1 ? 'bill' : 'bills'} (${inputs.explosion === 'MULTI_LEVEL' ? `every level, ${inputs.passes} ${inputs.passes === 1 ? 'pass' : 'passes'}` : 'one level'})`,
    `${c.stockLines} stock ${c.stockLines === 1 ? 'line' : 'lines'}`,
    `${c.purchaseLines} open purchase ${c.purchaseLines === 1 ? 'line' : 'lines'}`,
    `${c.workOrders} work ${c.workOrders === 1 ? 'order' : 'orders'}`,
    `${c.reservations} ${c.reservations === 1 ? 'reservation' : 'reservations'}`,
    `${c.firmPlannedOrders} firm planned ${c.firmPlannedOrders === 1 ? 'order' : 'orders'}`,
  ]
  const late = c.lateOrderLines > 0 ? ` ${c.lateOrderLines} order ${c.lateOrderLines === 1 ? 'line is' : 'lines are'} late: planned from ${inputs.runDate}.` : ''
  return `On ${inputs.runDate}: ${parts.join(', ')}.${late}`
}
