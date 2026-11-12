import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Ask to buy (B-W2b-332; SCM-035, SCM-037; the rules are purchasing/ask-to-buy; apps/factory-api
 * modules/purchasing/ask-to-buy emits them in the command that makes the change). Live for purchasing.requests.ask over the request's company and site, so the buyer's queue (Purchasing ›
 * Requests to buy, "N updates · Show") and the asker's own list refresh. Ids, kinds and states only: no quantity, no money,
 * no words. The person who asked is named for a later notification rule ("your request was approved / drafted"); it never
 * travels on a live screen.
 *
 *   purchase_requests.asked            someone asked to buy (OPEN for the buyer, or PENDING_APPROVAL when a rule asks a yes)
 *   purchase_requests.status_changed   a request moved: the yes (OPEN), refused (REJECTED), taken back (CANCELLED) or drafted
 *                                      into a purchase order (CONVERTED, with the order)
 */
const STATUSES = ['OPEN', 'PENDING_APPROVAL', 'CONVERTED', 'REJECTED', 'CANCELLED'] as const
const live = { permission: 'purchasing.requests.ask' } as const

export const events = [
  defineEvent({
    type: 'purchase_requests.asked',
    context: 'purchase-requests',
    description: 'Someone in the office asked to buy a material (by hand, or from a work order’s shortage): it waits for the buyer, or for a yes first.',
    payload: z.strictObject({
      purchaseRequestId: z.uuid(),
      siteId: z.uuid(),
      source: z.enum(['OFFICE', 'SHORTAGE']),
      status: z.enum(['OPEN', 'PENDING_APPROVAL']),
      workOrderId: z.uuid().nullable(),
      approvalTaskId: z.uuid().nullable(),
      requestedById: z.uuid(),
    }),
    live: { ...live, fields: ['purchaseRequestId', 'source', 'status'] },
  }),
  defineEvent({
    type: 'purchase_requests.status_changed',
    context: 'purchase-requests',
    description: 'A request to buy moved: approved (back to the buyer), refused with the reason, taken back, or drafted into a purchase order.',
    payload: z.strictObject({
      purchaseRequestId: z.uuid(),
      siteId: z.uuid(),
      from: z.enum(STATUSES),
      to: z.enum(STATUSES),
      purchaseOrderId: z.uuid().nullable(),
      requestedById: z.uuid(),
    }),
    live: { ...live, fields: ['purchaseRequestId', 'from', 'to'] },
  }),
] as const
