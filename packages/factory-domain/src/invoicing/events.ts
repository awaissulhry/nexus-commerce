import { z } from 'zod'
import { defineEvent } from '../events/define'
import { INVOICE_DOC_TYPES } from './invoices'

/**
 * The invoicing module's events (plan A1 §3.4, §3.5; B-W1-28; FIN-054, FIN-057, FIN-061, FIN-066). apps/factory-api's
 * modules/invoicing emits them in the command that makes the change. Payloads carry ids, the type and the number only:
 * never an amount (money stays behind the price grain; a screen refetches what it shows) nor a name.
 *
 *   invoice.draft_saved     a draft was created, or its lines or text changed (the invoices list and record)
 *   invoice.draft_deleted   a draft was deleted (it had no number: no gap)
 *   invoice.issued          a draft was issued: its number and date (the payments matcher's open items, A2 SCR-082);
 *                           the worker makes its XML and PDF when the issuing request could not (invoicing files handler)
 *   invoice.files_attached  the issued invoice names its XML (the legal invoice) and its PDF courtesy copy
 */
const docType = z.enum(INVOICE_DOC_TYPES)
const live = { permission: 'invoices.view', fields: ['invoiceId', 'docType'] } as const

export const events = [
  defineEvent({
    type: 'invoice.draft_saved',
    context: 'invoicing',
    description: 'A draft invoice was created, or its lines or text changed.',
    payload: z.strictObject({ invoiceId: z.uuid(), docType, created: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'invoice.draft_deleted',
    context: 'invoicing',
    description: 'A draft invoice was deleted (it had no number).',
    payload: z.strictObject({ invoiceId: z.uuid(), docType }),
    live,
  }),
  defineEvent({
    type: 'invoice.issued',
    context: 'invoicing',
    description: 'An invoice was issued: it has its number and date from the fiscal series and never changes again.',
    payload: z.strictObject({ invoiceId: z.uuid(), docType, number: z.string(), issueDate: z.string(), partyId: z.uuid(), depositRequestId: z.uuid().nullable() }),
    live: { permission: 'invoices.view', fields: ['invoiceId', 'docType', 'number'] },
  }),
  defineEvent({
    type: 'invoice.files_attached',
    context: 'invoicing',
    description: 'An issued invoice names its FatturaPA XML and its PDF courtesy copy.',
    payload: z.strictObject({ invoiceId: z.uuid(), xmlFileId: z.uuid(), pdfFileId: z.uuid() }),
    live: { permission: 'invoices.view', fields: ['invoiceId'] },
  }),
] as const
