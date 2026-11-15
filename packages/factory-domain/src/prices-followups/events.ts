import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Prices and returns follow-ups (B-W2b-380, XF6:01). apps/factory-api's modules/sales/pricelists/pdf-store.ts emits them in
 * the command that makes the change. Their own module folder (the event guard wants src/<module>/events.ts): the code is
 * factory-domain prices-followups/price-list-pdf.
 *
 *   price_list.pdf_kept   a price list version was kept as a PDF (GeneratedDocument PRICE_LIST, a file of the version)
 *   price_list.pdf_sent   a kept price list PDF was mailed to a customer (its thread; FAKE locally)
 *
 * Reach the office's price list screens (pricelists.view): ids and numbers; never a price, never an address.
 */

export const events = [
  defineEvent({
    type: 'price_list.pdf_kept',
    context: 'prices-followups',
    description: 'A price list version was kept as a PDF, so a mail attaches that same file.',
    payload: z.strictObject({ listId: z.uuid(), versionId: z.uuid(), revision: z.number().int(), pdfVersion: z.number().int().min(1), generatedDocumentId: z.uuid(), fileId: z.uuid() }),
    live: { permission: 'pricelists.view', fields: ['listId', 'versionId', 'revision', 'pdfVersion'] },
  }),
  defineEvent({
    type: 'price_list.pdf_sent',
    context: 'prices-followups',
    description: 'A kept price list PDF was mailed to a customer (a copy of the kept file on the customer goes attached).',
    payload: z.strictObject({ listId: z.uuid(), versionId: z.uuid(), revision: z.number().int(), pdfVersion: z.number().int().min(1), partyId: z.uuid(), outboundId: z.uuid() }),
    live: { permission: 'pricelists.view', fields: ['listId', 'versionId', 'revision', 'pdfVersion'] },
  }),
] as const
