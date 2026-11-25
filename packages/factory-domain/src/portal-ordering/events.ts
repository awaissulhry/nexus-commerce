import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Portal order requests (B-W2b-190; SAL-074 "portal orders arrive as requests"). apps/factory-api's
 * modules/sales/portal-ordering emits them in the command that makes the move: the customer's send and withdraw (its
 * portal session, the send numbered in the tenant's office scope as that person), the office's decision. Their own
 * module folder (as partners/events.ts): the code is factory-domain sales/portal-ordering. B-CP-071 (customer page plan D10):
 * each change of a draft (one per command: started, filled, its files, discarded) is `draft_changed`, so the office's Drafts
 * of a customer reads it again; nothing else moves on a draft.
 *
 *   portal_order_request.sent       a customer sent a request: it waits for the office in Home › Approvals
 *   portal_order_request.accepted   the office made the order or a quote from it
 *   portal_order_request.refused    the office refused it in words
 *   portal_order_request.withdrawn  the customer withdrew it before the office decided
 *   portal_order_request.draft_changed  B-CP-071: a customer changed one of its drafts (the office reads drafts, read-only)
 *   delivery_address.checked        the office approved or refused an address the customer added (B-W2b-F15)
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
    // od-fx1: Send needs nothing (the Owner's addendum R1 of 2026-11-25): a request may be sent with no line (lines 0; pieces stays
    // at least one, as the send counts it).
    payload: z.strictObject({ ...ids, source: z.enum(['PICKER', 'REORDER', 'UPLOAD']), lines: z.number().int().min(0), pieces: z.number().int().min(1) }),
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
  // ---- B-CP-071 (customer page plan D10; review C2): a draft changed. Its party only ROUTES the message (live.ts LIVE_PARTY_KEYS: a
  // person limited to another customer is never told); the screen is given the request's id alone, never the party.
  defineEvent({
    type: 'portal_order_request.draft_changed',
    context: 'portal-ordering',
    description: 'A draft order was started, changed or discarded — in the portal or by the office (od-s: both doors write it; nothing waits for it).',
    payload: z.strictObject({ requestId: z.uuid(), partyId: z.uuid() }),
    live: { permission: 'orders.view', fields: ['requestId'] },
  }),
  // ---- end B-CP-071
  // B-W2b-F15: the office decided a delivery address a customer added in the portal (sales/portal-ordering address-check.ts:
  // approved or refused by hand, or approved by accepting a request that names it). The customer's person who asked hears it
  // (platform/portal/notifications rules/addresses.ts). Ids and the decision only: never the address, the reason or a name.
  defineEvent({
    type: 'delivery_address.checked',
    context: 'portal-ordering',
    description: 'The office approved or refused a delivery address a customer added in the portal (the customer who asked is told).',
    payload: z.strictObject({ addressId: z.uuid(), partyId: z.uuid(), decision: z.enum(['APPROVED', 'REFUSED']) }),
    live: { permission: 'orders.view', fields: ['addressId', 'partyId', 'decision'] },
  }),
]
