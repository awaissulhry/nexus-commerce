import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { WARNING_CODES } from '@nexus/factory-domain/planning/explode'
import { REQUIREMENT_ACTIONS } from '@nexus/factory-domain/planning/explode'
import { DECISIONS as REQUIREMENT_DECISIONS } from '@nexus/factory-domain/planning/decisions'
import { PLANNED_ORDER_KINDS, PLANNED_ORDER_STATUSES, PROTECTABLE_FIELDS } from '@nexus/factory-domain/planning/planned-orders/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { runView } from '../contract'

/**
 * The run log (B-W2b-306; PLN-095; design planning.mrp run-log modal "Per run: inputs snapshot and warnings"): what a run
 * read, its warnings, and why each proposal exists, in words. Counts, codes, quantities and days; no money, no person.
 */

const count = () => z.number().int()

const inputsView = output({
  version: z.literal(1),
  runDate: businessDate(),
  timezone: z.string(),
  previousRunId: id().nullable(),
  explosion: z.enum(['MULTI_LEVEL', 'ONE_LEVEL']),
  passes: count(),
  sizeRunRule: z.string(),
  sizeGroups: count(),
  counts: output({
    orderLines: count(),
    orderLinesPlanned: count(),
    orders: count(),
    lateOrderLines: count(),
    undatedOrderLines: count(),
    madeToMeasure: count(),
    notPlaced: count(),
    revisions: count(),
    materials: count(),
    workOrders: count(),
    workOrderCells: count(),
    scheduledWorkOrders: count(),
    stockLines: count(),
    lots: count(),
    purchaseLines: count(),
    purchaseOrders: count(),
    purchaseLinesForOneOrder: count(),
    reservations: count(),
    firmPlannedOrders: count(),
    orderSpecificPegs: count(),
    itemParameters: count(),
    approvedSources: count(),
    plannedWorkOrdersFirm: count(),
    plannedWorkOrdersProtected: count(),
    plannedWorkOrdersPlain: count(),
  }),
  /** The plan's value of each field a planner protected, per planned order (what Reset to plan puts back). */
  protectedPlan: z.array(output({ plannedWorkOrderId: id(), fields: z.record(z.string(), z.unknown()) })),
})

const warning = output({ code: z.enum(WARNING_CODES), message: z.string(), orderId: id().optional(), orderLineId: id().optional(), itemId: id().optional(), size: z.string().optional() })

export const runLogView = output({
  run: runView,
  /** What it read; null: a run from before the log (W2b-5). */
  inputs: inputsView.nullable(),
  /** The inputs in one sentence. */
  sentence: z.string().nullable(),
  warnings: z.array(warning),
  warningCounts: z.array(output({ code: z.enum(WARNING_CODES), count: count() })),
  proposals: output({
    requirements: z.array(
      output({
        id: id(),
        seq: count(),
        action: z.enum(REQUIREMENT_ACTIONS),
        item: output({ id: id(), code: z.string() }),
        colour: output({ id: id(), code: z.string() }).nullable(),
        netQuantity: z.string(),
        uom: z.enum(UOMS),
        needDate: businessDate(),
        decision: z.enum(REQUIREMENT_DECISIONS),
        firm: z.boolean(),
        orderSpecific: output({ orderLineId: id(), orderNumber: z.string(), lineSeq: count() }).nullable(),
        /** Why it exists, in one sentence. */
        reason: z.string(),
      }),
    ),
    plannedOrders: z.array(
      output({
        id: id(),
        kind: z.enum(PLANNED_ORDER_KINDS),
        status: z.enum(PLANNED_ORDER_STATUSES),
        label: z.string(),
        quantity: count(),
        startDate: businessDate(),
        dueDate: businessDate(),
        needDate: businessDate(),
        firm: z.boolean(),
        protectedFields: z.array(z.enum(PROTECTABLE_FIELDS)),
        reason: z.string(),
      }),
    ),
  }),
  actionMessages: output({ open: count(), done: count(), ignored: count() }),
})
export type RunLogView = z.infer<typeof runLogView>

export const runLogContract = defineContract({
  params: input({ runId: id() }),
  response: { 200: runLogView },
})
