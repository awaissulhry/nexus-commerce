import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Returns and complaints from outside (B-W2b-192; SAL-334, SAL-424; follow-ups CO5:01, CO5:02). apps/factory-api's
 * modules/sales/portal-returns and modules/quality/complaints/portal emit them in the command that makes the move. Their
 * own module folder (as portal-ordering/events.ts; check-event-contract wants src/<module>/events.ts): the code is
 * factory-domain sales/portal-returns. A complaint from outside is W2a's `complaint.received` (channel PORTAL or LINK);
 * the office's authorisation of a request is W2a's `return.authorised` and `return.status_changed`.
 *
 *   return_request.sent         a customer asked for a return from the portal or a claim link: an RMA REQUESTED, waiting
 *                               for the office to authorise or reject it
 *   claim_link.sent             the office made a claim link for a shipment or an order (or the customer asked for one
 *                               from its tracking link): ids and whether it was mailed, never the token or the address
 *   complaint_answer.published  the answer letter of a complaint was published to the customer's portal and claim link
 *                               (answeredVia PORTAL)
 *   complaint_document.shared   a CAPA's 8D report was shared with the complaint's customer as a copy on the complaint
 *
 * Reach the office's returns and complaints screens (sales.returns.view, quality.complaints.view over the record's
 * company and customer): ids, numbers and counts only; never a price, a name or an address.
 */

export const events = [
  defineEvent({
    type: 'return_request.sent',
    context: 'portal-returns',
    description: 'A customer asked for a return from the portal or a claim link: the RMA is REQUESTED with its lines and reasons, and waits for the office to authorise or reject it.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), partyId: z.uuid(), salesOrderId: z.uuid().nullable(), via: z.enum(['PORTAL', 'LINK']), lineIds: z.array(z.uuid()), pieces: z.number().int().min(1) }),
    live: { permission: 'sales.returns.view', fields: ['returnId', 'number', 'partyId', 'via'] },
  }),
  defineEvent({
    type: 'claim_link.sent',
    context: 'portal-returns',
    description: 'A claim link ("Report a problem") was made for a shipment or a sales order: by the office (mailed or handed over), or by the customer from its tracking link.',
    payload: z.strictObject({ linkId: z.uuid(), recordType: z.enum(['Shipment', 'SalesOrder']), recordId: z.uuid(), partyId: z.uuid(), via: z.enum(['OFFICE', 'TRACKING']), mailed: z.boolean(), expiresAt: z.iso.datetime() }),
    live: { permission: 'sales.returns.view', fields: ['linkId', 'recordType', 'recordId', 'partyId', 'via'] },
  }),
  defineEvent({
    type: 'complaint_answer.published',
    context: 'portal-returns',
    description: "A complaint's answer letter was published to the customer's portal and claim link (answeredVia PORTAL): the letter version kept and shared with the customer.",
    payload: z.strictObject({ complaintId: z.uuid(), number: z.string(), partyId: z.uuid(), documentId: z.uuid(), version: z.number().int().min(1) }),
    live: { permission: 'quality.complaints.view', fields: ['complaintId', 'number', 'partyId'] },
  }),
  defineEvent({
    type: 'complaint_document.shared',
    context: 'portal-returns',
    description: "A CAPA's 8D report was shared with the complaint's customer: a copy on the complaint the portal and the claim link show (the CAPA's own file stays the office's).",
    payload: z.strictObject({ complaintId: z.uuid(), number: z.string(), partyId: z.uuid(), capaId: z.uuid(), fileId: z.uuid(), sourceFileId: z.uuid() }),
    live: { permission: 'quality.complaints.view', fields: ['complaintId', 'number', 'partyId', 'capaId'] },
  }),
] as const
