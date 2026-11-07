import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Portal order requests (B-W2b-190; SAL-074 "portal orders arrive as requests"). apps/factory-api's
 * modules/sales/portal-ordering emits them in the command that makes the move: the customer's send and withdraw (its
 * portal session, the send numbered in the tenant's office scope as that person), the office's decision. Their own
 * module folder (as partners/events.ts): the code is factory-domain sales/portal-ordering. A draft moves no event (it is
 * the customer's work in progress).
 *
 *   portal_order_request.sent       a customer sent a request: it waits for the office in Home › Approvals
 *   portal_order_request.accepted   the office made the order or a quote from it
 *   portal_order_request.refused    the office refused it in words
 *   portal_order_request.withdrawn  the customer withdrew it before the office decided
 *
 * Reach the office's Home › Approvals and sales screens (orders.view over the request's company and customer): ids,
 * numbers and counts only; never a price or a name.
 */

const live = { permission: 'orders.view', fields: ['requestId', 'number', 'partyId'] } as const
const ids = { requestId: z.uuid(), number: z.string(), partyId: z.uuid() }

export const events = [
  defineEvent({
    type: 'portal_order_request.sent',
    context: 'portal-ordering',
    description: 'A customer sent an order request from the portal (picked styles, a reorder or an uploaded sheet): it waits for the office to make the order or a quote from it, or to refuse it.',
    payload: z.strictObject({ ...ids, source: z.enum(['PICKER', 'REORDER', 'UPLOAD']), lines: z.number().int().min(1), pieces: z.number().int().min(1) }),
    live,
  }),
  defineEvent({
    type: 'portal_order_request.accepted',
    context: 'portal-ordering',
    description: 'The office accepted a portal order request: it made the sales order (prices again) or a quote from it.',
    payload: z.strictObject({ ...ids, salesOrderId: z.uuid().nullable(), quoteId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'portal_order_request.refused',
    context: 'portal-ordering',
    description: 'The office refused a portal order request, saying why (the customer reads it).',
    payload: z.strictObject(ids),
    live,
  }),
  defineEvent({
    type: 'portal_order_request.withdrawn',
    context: 'portal-ordering',
    description: 'The customer withdrew a portal order request before the office decided it.',
    payload: z.strictObject(ids),
    live,
  }),
]
