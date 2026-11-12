import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Keeping promises' events (B-W2b-317; PLN-175, PLN-177, PLN-200; the code is factory-domain planning/{promise-keep,backlog}).
 * A module folder of its own, as planning-promise (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/planning/{promise-keep,backlog,exceptions/supply-late} emit them in the commands that write:
 *
 *   order_promise.proposed      planning proposed new dates for an order line's sizes: they wait for sales (a task on the
 *                               order). Promise dates and the order's record read again ("Re-promise waiting for sales").
 *   order_promise.decided       sales accepted (the rows are written: order_promise.recorded too) or declined the proposal,
 *                               or the planner withdrew it; `told` says the customer was sent the message.
 *   backlog.ranked     open orders were ranked by hand, sent back to the rule, or ranked by the rule.
 *   supply_late.checked  a supplier's date of a purchase order was checked against what it feeds, now (not at the
 *                               next run): the "Supply too late" exceptions it raised, kept and cleared.
 *
 * Live for orders.view (the order's readers) and planning.view (the planner's lists). Ids, sizes, dates and counts only: no
 * words a person typed, no person.
 */
const size = z.string().min(1).max(20).nullable()

export const events = [
  defineEvent({
    type: 'order_promise.proposed',
    context: 'planning-promise-keep',
    description: "Planning proposed new promise dates for an order line's sizes; they wait for sales to accept them.",
    payload: z.strictObject({
      orderId: z.uuid(),
      orderLineId: z.uuid(),
      /** The proposal (its task on the order). */
      proposalId: z.uuid(),
      siteId: z.uuid(),
      sizes: z.array(z.strictObject({ size, from: z.iso.date().nullable(), to: z.iso.date() })).min(1).max(201),
    }),
    live: { permission: 'orders.view', fields: ['orderId', 'orderLineId', 'proposalId'] },
  }),
  defineEvent({
    type: 'order_promise.decided',
    context: 'planning-promise-keep',
    description: 'A re-promise was accepted by sales (the new dates promised), declined by sales, or withdrawn by the planner.',
    payload: z.strictObject({
      orderId: z.uuid(),
      orderLineId: z.uuid(),
      proposalId: z.uuid(),
      decision: z.enum(['ACCEPTED', 'DECLINED', 'WITHDRAWN']),
      /** The customer was sent the message (on the order's thread). */
      told: z.boolean(),
    }),
    live: { permission: 'orders.view', fields: ['orderId', 'orderLineId', 'proposalId', 'decision'] },
  }),
  defineEvent({
    type: 'backlog.ranked',
    context: 'planning-promise-keep',
    description: 'Open sales orders were ranked by hand, sent back to the rule, or ranked by the rule (the ranked backlog allocation reads).',
    payload: z.strictObject({
      companyId: z.uuid(),
      mode: z.enum(['BY_HAND', 'BY_RULE']),
      orderIds: z.array(z.uuid()).min(1).max(500),
    }),
    live: { permission: 'planning.view', fields: ['companyId', 'mode'] },
  }),
  defineEvent({
    type: 'supply_late.checked',
    context: 'planning-promise-keep',
    description: "A purchase order's supplier dates were checked against what they feed: the 'Supply too late' exceptions raised, kept and cleared now.",
    payload: z.strictObject({
      siteId: z.uuid(),
      purchaseOrderId: z.uuid(),
      raised: z.number().int().min(0),
      stillOpen: z.number().int().min(0),
      cleared: z.number().int().min(0),
    }),
    live: { permission: 'planning.view', fields: ['siteId', 'purchaseOrderId'] },
  }),
]
