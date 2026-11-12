import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Promise dates' events (B-W2b-301; PLN-171; the code is factory-domain planning/promise). A module folder of its own, as
 * planning-planned-orders (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/planning/promise
 * emits it in the command that writes the rows:
 *
 *   order_promise.recorded   an order line's promise per size was recorded: the PromiseRecord rows written (a size's
 *                            first promise, a size promised apart with its reason). The order's record, Planning ›
 *                            Promise dates and the portal's promise read again.
 *
 * Live for orders.view (the order's own readers: sales and the planner). Ids, sizes, dates and counts only: no words a
 * person typed, no person.
 */
export const events = [
  defineEvent({
    type: 'order_promise.recorded',
    context: 'planning-promise',
    description: "An order line's promise per size was recorded (first promises and sizes promised apart).",
    payload: z.strictObject({
      orderId: z.uuid(),
      orderLineId: z.uuid(),
      /** The site whose plan the dates came from; null: none named. */
      siteId: z.uuid().nullable(),
      rows: z
        .array(
          z.strictObject({
            /** null: every size of the line. */
            size: z.string().nullable(),
            promisedDate: z.iso.date(),
            kind: z.enum(['FIRST', 'RE_PROMISE']),
          }),
        )
        .min(1)
        .max(201),
    }),
    live: { permission: 'orders.view', fields: ['orderId', 'orderLineId'] },
  }),
]
