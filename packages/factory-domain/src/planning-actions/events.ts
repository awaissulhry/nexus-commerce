import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECISIONS } from '../planning/actions/messages'

/**
 * MRP you can trust (B-W2b-306; PLN-072, PLN-073, PLN-076, PLN-078; the code is factory-domain planning/actions). A module
 * folder of its own, as planning-planned-orders (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/planning emits them in the command that makes the change:
 *
 *   mrp_action_messages.raised    a run raised its action messages on existing orders (how many, and how many a planner
 *                                 had ignored before and were not raised again). The action list reads again.
 *   mrp_action_messages.decided   a person marked messages done or ignored.
 *   planned_work_orders.edited    a planner edited planned work orders (the fields changed are protected from the next run)
 *                                 or reset them to the plan; one or several (a bulk edit is one event).
 *   material_requirement.pegged   a planner kept a requirement of the latest plan for one order line only, or let it go.
 *
 * Live for planning.view. Ids, counts and codes only: no words a person typed, no person.
 */
export const events = [
  defineEvent({
    type: 'mrp_action_messages.raised',
    context: 'planning-actions',
    description: "A planning run raised its action messages on the site's existing orders (expedite, defer, cancel, increase, decrease).",
    payload: z.strictObject({
      runId: z.uuid(),
      siteId: z.uuid(),
      raised: z.number().int().nonnegative(),
      /** Asked before and ignored by a planner: not raised again. */
      notRaisedAgain: z.number().int().nonnegative(),
    }),
    live: { permission: 'planning.view', fields: ['runId', 'siteId', 'raised'] },
  }),
  defineEvent({
    type: 'mrp_action_messages.decided',
    context: 'planning-actions',
    description: 'Action messages of a planning run were marked done or ignored.',
    payload: z.strictObject({
      runId: z.uuid(),
      siteId: z.uuid(),
      status: z.enum(DECISIONS),
      messageIds: z.array(z.uuid()),
    }),
    live: { permission: 'planning.view', fields: ['runId', 'siteId', 'status', 'messageIds'] },
  }),
  defineEvent({
    type: 'planned_work_orders.edited',
    context: 'planning-actions',
    description: 'Planned work orders were edited by a planner (the fields changed are kept by the next runs) or reset to the plan.',
    payload: z.strictObject({
      siteId: z.uuid(),
      change: z.enum(['EDITED', 'RESET']),
      plannedWorkOrderIds: z.array(z.uuid()),
    }),
    live: { permission: 'planning.view', fields: ['siteId', 'change', 'plannedWorkOrderIds'] },
  }),
  defineEvent({
    type: 'material_requirement.pegged',
    context: 'planning-actions',
    description: 'A requirement of the latest plan was kept for one order line only (order-specific supply), or for every order again.',
    payload: z.strictObject({
      runId: z.uuid(),
      siteId: z.uuid(),
      requirementId: z.uuid(),
      /** null: for every order again. */
      orderLineId: z.uuid().nullable(),
    }),
    live: { permission: 'planning.view', fields: ['runId', 'siteId', 'requirementId', 'orderLineId'] },
  }),
]
