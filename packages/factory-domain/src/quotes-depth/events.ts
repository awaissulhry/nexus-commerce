import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TEMPLATE_CHANGES } from '../sales/quote-templates/rules'

/**
 * Quotes in depth (B-W2b-294; SAL-144, SAL-145, SAL-252). apps/factory-api's modules/sales/quote-templates and quote-terms emit
 * them in the command that makes the change. Their own module folder (the event guard wants src/<module>/events.ts): the code
 * is factory-domain sales/quote-templates and sales/quote-terms. A quote's Incoterm, ship complete and acceptance mode move
 * W1's `quote.updated` (the fields), a line's delivery schedule W1's `quote.lines_changed` (changed, the line).
 *
 *   quote_template.changed  a quote template was made (also from a quote), its header or lines changed, archived or restored
 *   quote.expired           a sent version passed its last day unanswered: EXPIRED (the validity job); a new version revives it
 *   quote.reminder_sent     the customer was reminded, before the last day, that the offer ends (the validity job)
 *
 * Reach the office's quote screens (quotes.view): ids, the number, what changed; never a price.
 */

const live = { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'number'] } as const

export const events = [
  defineEvent({
    type: 'quote_template.changed',
    context: 'quotes-depth',
    description: "A quote template (a saved start of quotes) was made, from nothing or from a quote, its header or lines changed, or it was archived or restored.",
    payload: z.strictObject({ templateId: z.uuid(), companyId: z.uuid().nullable(), change: z.enum(TEMPLATE_CHANGES), fields: z.array(z.string()) }),
    live: { permission: 'quotes.view', fields: ['templateId', 'companyId', 'change'] },
  }),
  defineEvent({
    type: 'quote.expired',
    context: 'quotes-depth',
    description: 'A sent quote version passed its last day without an answer and is EXPIRED; a new version of the quote revives it.',
    payload: z.strictObject({ quoteId: z.uuid(), versionId: z.uuid(), number: z.string(), revision: z.number().int(), validUntil: z.iso.date() }),
    live,
  }),
  defineEvent({
    type: 'quote.reminder_sent',
    context: 'quotes-depth',
    description: 'The customer was reminded, a few days before its last day, that a sent quote ends (a mail on the quote thread).',
    payload: z.strictObject({ quoteId: z.uuid(), versionId: z.uuid(), number: z.string(), revision: z.number().int(), validUntil: z.iso.date(), outboundId: z.uuid() }),
    live,
  }),
] as const
