import { z } from 'zod'
import { defineEvent } from '../events/define'
import { REQUEST_KINDS } from '../sales/change-requests/rules'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077, SAL-078). apps/factory-api's modules/sales/change-requests
 * emits them in the commands that make the change: the customer's (asked, withdrawn) and the office's (answered). Their own
 * module folder: the code is factory-domain sales/change-requests (the event contract wants `src/<module>/events.ts`).
 *
 *   order_change_request.asked       a customer asked to change or cancel an order from the portal (Home › Approvals and
 *                                    the order's timeline show it to the office)
 *   order_change_request.withdrawn   the customer withdrew it while it waited
 *   order_change_request.answered    the office accepted it (a change through an amendment of the order, named; a whole
 *                                    cancel by cancelling the order) or refused it with words; the customer is told by
 *                                    e-mail (platform/portal/notifications/rules/change-requests.ts)
 *
 * Reach the office's order screens and Today (orders.view over the order's company and customer): ids, kinds and states
 * only; never a name, a quantity or an amount.
 */

const live = (fields: readonly string[]) => ({ permission: 'orders.view', fields }) as const

export const events = [
  defineEvent({
    type: 'order_change_request.asked',
    context: 'sales-change-requests',
    description: "A customer asked, from the portal, to change an order (sizes, date, delivery address) or to cancel it (the whole order or some lines).",
    payload: z.strictObject({ requestId: z.uuid(), orderId: z.uuid(), partyId: z.uuid(), kind: z.enum(REQUEST_KINDS), lines: z.number().int().min(0), wholeOrder: z.boolean() }),
    live: live(['requestId', 'orderId', 'kind']),
  }),
  defineEvent({
    type: 'order_change_request.withdrawn',
    context: 'sales-change-requests',
    description: 'The customer withdrew a change or cancel request while it waited for the answer.',
    payload: z.strictObject({ requestId: z.uuid(), orderId: z.uuid(), partyId: z.uuid(), kind: z.enum(REQUEST_KINDS) }),
    live: live(['requestId', 'orderId', 'kind']),
  }),
  defineEvent({
    type: 'order_change_request.answered',
    context: 'sales-change-requests',
    description: 'The office accepted a change or cancel request (the amendment it made, or the order cancelled) or refused it with words.',
    payload: z.strictObject({
      requestId: z.uuid(),
      orderId: z.uuid(),
      partyId: z.uuid(),
      kind: z.enum(REQUEST_KINDS),
      answer: z.enum(['ACCEPTED', 'REFUSED']),
      /** The amendment an accepted change (or partial cancel) made; null otherwise. */
      amendmentId: z.uuid().nullable(),
      /** An accepted whole-order cancel cancelled the order. */
      orderCancelled: z.boolean(),
    }),
    live: live(['requestId', 'orderId', 'kind', 'answer']),
  }),
] as const
