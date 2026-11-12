import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PLANNED_ORDER_KINDS } from '../planning/planned-orders/rules'

/**
 * Planned work orders' events (B-W2b-293; PLN-067, PLN-069; the code is factory-domain planning/planned-orders). A module
 * folder of its own, as planning-milestones (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/planning emits them in the command that makes the change:
 *
 *   planned_work_orders.planned   a run proposed the site's planned work and subcontract orders: how many it added,
 *                                 moved on, removed and kept (firm or protected). "To make" reads again.
 *   planned_work_order.converted  a planned order was made real: its DRAFT work order (and for a subcontract one, its
 *                                 subcontract order). "To make", the work orders and the subcontracting lists read again.
 *   planned_work_order.firmed     a planner made a planned order firm (the runs keep it) or planned again.
 *
 * Live for planning.view. Ids, kinds and counts only: no words a person typed, no person.
 */
export const events = [
  defineEvent({
    type: 'planned_work_orders.planned',
    context: 'planning-planned-orders',
    description: "A planning run proposed the site's planned work orders and planned subcontract orders (added, moved on, removed, kept).",
    payload: z.strictObject({
      runId: z.uuid(),
      siteId: z.uuid(),
      added: z.number().int().nonnegative(),
      moved: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      /** Firm or protected rows: moved on unchanged. */
      kept: z.number().int().nonnegative(),
      /** Of the planned orders now open, those for a workshop. */
      subcontract: z.number().int().nonnegative(),
    }),
    live: { permission: 'planning.view', fields: ['runId', 'siteId', 'added', 'moved', 'removed', 'kept'] },
  }),
  defineEvent({
    type: 'planned_work_order.converted',
    context: 'planning-planned-orders',
    description: 'A planned work order (or planned subcontract order) was made real: its work order, and its subcontract order.',
    payload: z.strictObject({
      plannedWorkOrderId: z.uuid(),
      siteId: z.uuid(),
      kind: z.enum(PLANNED_ORDER_KINDS),
      workOrderId: z.uuid(),
      workOrderNumber: z.string(),
      subcontractOrderId: z.uuid().nullable(),
      subcontractOrderNumber: z.string().nullable(),
      pieces: z.number().int().positive(),
    }),
    live: { permission: 'planning.view', fields: ['plannedWorkOrderId', 'siteId', 'kind', 'workOrderId', 'subcontractOrderId'] },
  }),
  defineEvent({
    type: 'planned_work_order.firmed',
    context: 'planning-planned-orders',
    description: 'A planned work order was made firm (the runs keep it as it is) or planned again.',
    payload: z.strictObject({
      plannedWorkOrderId: z.uuid(),
      siteId: z.uuid(),
      firm: z.boolean(),
    }),
    live: { permission: 'planning.view', fields: ['plannedWorkOrderId', 'siteId', 'firm'] },
  }),
]
