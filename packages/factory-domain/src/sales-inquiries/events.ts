import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECLINE_REASONS, INQUIRY_SOURCES, INQUIRY_STATUSES } from '../sales/inquiries/rules'
import { PRODUCTION_ANSWERS } from '../sales/inquiries/production-answer' // B-TH-094

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032, SAL-033, SAL-305; the code is factory-domain sales/inquiries). A
 * module folder of its own, as sales-samples (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/sales/inquiries emits them in the command that makes the change; making the quote also emits W1's `quote.created`,
 * and making an inquiry from a mail that joins its thread email in's `email.inbound_sorted`.
 *
 *   inquiry.received   an inquiry was typed (office, phone, fair, a portal request) or made from a mail
 *   inquiry.changed    what is asked changed, a prospect was matched to a customer, it was given to someone or taken off, it
 *                      waits for the customer, or the customer answered
 *   inquiry.closed     it became a quote (QUOTED, with the quote), was declined (with the reason) or was lost; B-TH-025: or became
 *                      an order made straight from it (ORDERED, with the order: salesOrderId)
 *
 * Live on the inquiries screens for sales.inquiries.view. Ids, numbers and states only: no person, no money, no words asked.
 * B-TH-015 (PR-19): each live message names its customer (`partyId`, null for a prospect): the live filter (events/live.ts,
 * B-W2b-GF1) lets an office person limited to some customers receive only their requests, and the screen places the row
 * under its customer.
 */
export const INQUIRY_CHANGES = ['UPDATED', 'MATCHED', 'ASSIGNED', 'UNASSIGNED', 'NEED_INFO', 'RESUMED'] as const

const live = { permission: 'sales.inquiries.view' } as const

export const events = [
  defineEvent({
    type: 'inquiry.received',
    context: 'sales-inquiries',
    description: 'An inquiry or request for quotation was typed by the office (a visit, a phone call, a fair, a portal request) or made from a received mail.',
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), source: z.enum(INQUIRY_SOURCES), status: z.enum(INQUIRY_STATUSES), partyId: z.uuid().nullable(), sourceEmailId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'source', 'status', 'partyId'] },
  }),
  defineEvent({
    type: 'inquiry.changed',
    context: 'sales-inquiries',
    description: 'An inquiry changed while open: what is asked, the customer it is from (a prospect matched), who answers it, or whether it waits for the customer.',
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), status: z.enum(INQUIRY_STATUSES), previousStatus: z.enum(INQUIRY_STATUSES), change: z.enum(INQUIRY_CHANGES), partyId: z.uuid().nullable(), assigneeId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'status', 'change', 'partyId'] },
  }),
  defineEvent({
    type: 'inquiry.closed',
    context: 'sales-inquiries',
    description: 'An inquiry ended: it became a quote, it was declined (with the reason), the customer went away (lost), or an order was made straight from it (B-TH-025).',
    // B-TH-025: ORDERED with the order made from it (salesOrderId; null for every other end).
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), status: z.enum(['QUOTED', 'DECLINED', 'LOST', 'ORDERED']), previousStatus: z.enum(INQUIRY_STATUSES), quoteId: z.uuid().nullable(), salesOrderId: z.uuid().nullable(), declineReason: z.enum(DECLINE_REASONS).nullable(), partyId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'status', 'quoteId', 'salesOrderId', 'partyId'] },
  }),
  // ---- B-TH-094 (threads plan TH-9, N17): production's answer on a request — office only. Its own event (not inquiry.changed,
  // which the customer's portal session also receives as a refresh): the answer never reaches a portal, not even as a signal.
  // `notBefore`: the Monday of the week (NOT_BEFORE); answer null: taken back.
  defineEvent({
    type: 'inquiry.production_answered',
    context: 'sales-inquiries',
    description: 'Production answered a request (OK, or not before a week), changed its answer or took it back (B-TH-094). Office only.',
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), answer: z.enum(PRODUCTION_ANSWERS).nullable(), notBefore: z.iso.date().nullable(), partyId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'answer', 'notBefore', 'partyId'] },
  }),
  // ---- end B-TH-094
] as const
