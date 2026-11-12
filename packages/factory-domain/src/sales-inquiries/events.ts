import { z } from 'zod'
import { defineEvent } from '../events/define'
import { DECLINE_REASONS, INQUIRY_SOURCES, INQUIRY_STATUSES } from '../sales/inquiries/rules'

/**
 * Inquiries and requests for quotation (B-W2b-295; SAL-032, SAL-033, SAL-305; the code is factory-domain sales/inquiries). A
 * module folder of its own, as sales-samples (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/sales/inquiries emits them in the command that makes the change; making the quote also emits W1's `quote.created`,
 * and making an inquiry from a mail that joins its thread email in's `email.inbound_sorted`.
 *
 *   inquiry.received   an inquiry was typed (office, phone, fair, a portal request) or made from a mail
 *   inquiry.changed    what is asked changed, a prospect was matched to a customer, it was given to someone or taken off, it
 *                      waits for the customer, or the customer answered
 *   inquiry.closed     it became a quote (QUOTED, with the quote), was declined (with the reason) or was lost
 *
 * Live on the inquiries screens for sales.inquiries.view. Ids, numbers and states only: no person, no money, no words asked.
 */
export const INQUIRY_CHANGES = ['UPDATED', 'MATCHED', 'ASSIGNED', 'UNASSIGNED', 'NEED_INFO', 'RESUMED'] as const

const live = { permission: 'sales.inquiries.view' } as const

export const events = [
  defineEvent({
    type: 'inquiry.received',
    context: 'sales-inquiries',
    description: 'An inquiry or request for quotation was typed by the office (a visit, a phone call, a fair, a portal request) or made from a received mail.',
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), source: z.enum(INQUIRY_SOURCES), status: z.enum(INQUIRY_STATUSES), partyId: z.uuid().nullable(), sourceEmailId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'source', 'status'] },
  }),
  defineEvent({
    type: 'inquiry.changed',
    context: 'sales-inquiries',
    description: 'An inquiry changed while open: what is asked, the customer it is from (a prospect matched), who answers it, or whether it waits for the customer.',
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), status: z.enum(INQUIRY_STATUSES), previousStatus: z.enum(INQUIRY_STATUSES), change: z.enum(INQUIRY_CHANGES), partyId: z.uuid().nullable(), assigneeId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'status', 'change'] },
  }),
  defineEvent({
    type: 'inquiry.closed',
    context: 'sales-inquiries',
    description: 'An inquiry ended: it became a quote, it was declined (with the reason) or the customer went away (lost).',
    payload: z.strictObject({ inquiryId: z.uuid(), number: z.string(), status: z.enum(['QUOTED', 'DECLINED', 'LOST']), previousStatus: z.enum(INQUIRY_STATUSES), quoteId: z.uuid().nullable(), declineReason: z.enum(DECLINE_REASONS).nullable(), partyId: z.uuid().nullable() }),
    live: { ...live, fields: ['inquiryId', 'number', 'status', 'quoteId'] },
  }),
] as const
