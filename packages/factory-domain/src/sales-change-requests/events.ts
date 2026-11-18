import { z } from 'zod'
import { defineEvent } from '../events/define'
// B-PR-24: every kind of request (the production asks beside change and cancel) and the customer's answer to our counter-offer.
import { COUNTER_ANSWERS } from '../sales/change-requests/counter'
import { ORDER_REQUEST_KINDS } from '../sales/change-requests/rules'
// B-PR-46a: a customer's bulk asks (one batch, one kind).
import { BATCH_ASK_KINDS } from '../production-brand/bulk'

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
 *
 * B-PR-24 (production plan §3, 08-backend §4.2 and §6): the kind is every kind of request — CHANGE and CANCEL, and the
 * production asks RUSH ("Urgent – asked"), HOLD, RESUME, SPLIT_SHIPMENT and SAMPLE_ROUND — on asked, withdrawn and answered.
 * Two more, about our counter-offer (a COUNTER_OFFER approval request the customer answers):
 *
 *   order_change_request.countered        the office answered an OPEN request with a counter-offer (it is now COUNTERED: the
 *                                         customer answers it in Waiting for you)
 *   order_change_request.counter_answered the customer said yes (ACCEPTED: the request is carried out with the counter) or no
 *                                         (REFUSED: the request is withdrawn) to our counter-offer
 * Never the counter's date, fee or words: ids, kinds and the answer only.
 *
 * B-PR-46a (production plan §3 "Bulk asks"; R-51): a customer's bulk ask from My production (Ask N; Mark urgent's rows over the
 * quota or from Cutting) is one request per order, all of ONE batch (one customer, one kind: the database checks it). Each
 * request's `asked` names its batch; the batch itself is told once, for the office's notice (B-PR-32: it notifies on this one
 * and skips the per-request notices that carry a batchId):
 *
 *   order_change_request.batch_asked      a customer asked one kind of many of its orders at once: the batch, the customer, the
 *                                         kind and how many requests it holds — OFFICE ONLY (no partner live entry, no portal
 *                                         notice: the customer reads its own answer)
 */

const live = (fields: readonly string[]) => ({ permission: 'orders.view', fields }) as const

export const events = [
  defineEvent({
    type: 'order_change_request.asked',
    context: 'sales-change-requests',
    description: "A customer asked, from the portal, to change an order (sizes, date, delivery address) or to cancel it (the whole order or some lines), or made a production ask (urgent, pause, resume, ship what is ready, another sample).",
    payload: z.strictObject({
      requestId: z.uuid(),
      orderId: z.uuid(),
      partyId: z.uuid(),
      kind: z.enum(ORDER_REQUEST_KINDS),
      lines: z.number().int().min(0),
      wholeOrder: z.boolean(),
      /** B-PR-46a: the batch of a bulk ask the request belongs to (left out: asked alone). */
      batchId: z.uuid().optional(),
    }),
    live: live(['requestId', 'orderId', 'kind']),
  }),
  defineEvent({
    type: 'order_change_request.withdrawn',
    context: 'sales-change-requests',
    description: 'The customer withdrew a change or cancel request while it waited for the answer.',
    payload: z.strictObject({ requestId: z.uuid(), orderId: z.uuid(), partyId: z.uuid(), kind: z.enum(ORDER_REQUEST_KINDS) }),
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
      kind: z.enum(ORDER_REQUEST_KINDS),
      answer: z.enum(['ACCEPTED', 'REFUSED']),
      /** The amendment an accepted change (or partial cancel) made; null otherwise. */
      amendmentId: z.uuid().nullable(),
      /** An accepted whole-order cancel cancelled the order. */
      orderCancelled: z.boolean(),
    }),
    live: live(['requestId', 'orderId', 'kind', 'answer']),
  }),
  // ---- B-PR-24: our counter-offer and the customer's answer to it ------------------------------------------------------------
  defineEvent({
    type: 'order_change_request.countered',
    context: 'sales-change-requests',
    description: "The office answered a customer's request with a counter-offer (another date, a price or words): the customer answers it.",
    payload: z.strictObject({ requestId: z.uuid(), orderId: z.uuid(), partyId: z.uuid(), kind: z.enum(ORDER_REQUEST_KINDS), approvalRequestId: z.uuid() }),
    live: live(['requestId', 'orderId', 'kind']),
  }),
  defineEvent({
    type: 'order_change_request.counter_answered',
    context: 'sales-change-requests',
    description: "The customer said yes (the request is carried out with the counter-offer) or no (the request is withdrawn) to our counter-offer.",
    payload: z.strictObject({ requestId: z.uuid(), orderId: z.uuid(), partyId: z.uuid(), kind: z.enum(ORDER_REQUEST_KINDS), answer: z.enum(COUNTER_ANSWERS) }),
    live: live(['requestId', 'orderId', 'kind', 'answer']),
  }),
  // ---- B-PR-46a: a customer's bulk ask, told once per batch (office only) -----------------------------------------------------
  defineEvent({
    type: 'order_change_request.batch_asked',
    context: 'sales-change-requests',
    description: 'A customer asked one kind (urgent, pause, resume, cancel) of many of its orders at once: one request per order, all of one batch.',
    payload: z.strictObject({
      batchId: z.uuid(),
      /** The one customer of the batch. */
      partyId: z.uuid(),
      kind: z.enum(BATCH_ASK_KINDS),
      /** The requests the batch holds (each order once). */
      count: z.number().int().min(1),
    }),
    // Office only: no partner live entry (the customer's own answer shows its results).
    live: live(['batchId', 'kind', 'count']),
  }),
] as const
