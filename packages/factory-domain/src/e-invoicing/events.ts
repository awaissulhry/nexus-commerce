import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SELF_INVOICE_KINDS } from '../invoicing/self-invoices/self-invoices'
import { SIMULATED_OUTCOMES } from '../invoicing/test-mode/test-mode'

/**
 * The events of e-invoicing in depth (B-W2b-401; FIN-095, FIN-096, FIN-097; apps/factory-api
 * modules/invoicing/{test-mode,self-invoices,archive-copy,debit-notes}). Context `e-invoicing`, its own module folder (the event
 * guard wants `src/<module>/events.ts`; the invoicing events file is W1's). They reach the office screens that read invoices
 * (invoices.view). No amount, no person, no words: ids, codes and actions. A self-invoice's or a debit note's draft, issue and
 * send also emit W1's invoice.draft_saved / invoice.issued / invoice.sdi_status_changed; a simulated SDI answer is recorded as
 * SDI's (invoice.sdi_notification_received).
 *
 *   e_invoicing.settings_changed  a company left test mode (went live), went back to it, changed the answer test mode
 *                                 simulates, or switched its self-invoice rules (self-invoices, debit notes, the VAT time
 *                                 limit) on or off
 *   self_invoice.changed          a foreign supplier's invoice got its self-invoice (with its draft; or a pending one its draft),
 *                                 which was issued or cancelled
 *   sdi_archive_copy.changed      our own copy of a send to SDI was made, or took more of SDI's notifications
 */
export const SETTINGS_ACTIONS = ['WENT_LIVE', 'BACK_TO_TEST', 'SIMULATE', 'SWITCH'] as const
export const SELF_INVOICE_ACTIONS = ['CREATED', 'DRAFTED', 'ISSUED', 'CANCELLED'] as const
export const COPY_ACTIONS = ['MADE', 'RECEIPTS_ADDED'] as const

export const events = [
  defineEvent({
    type: 'e_invoicing.settings_changed',
    context: 'e-invoicing',
    description: "A company's e-invoicing settings changed: it left test mode (from then on invoices go to SDI for real), went back to it, changed the answer test mode simulates, or switched its self-invoice rules on or off.",
    payload: z.strictObject({ companyId: z.uuid(), action: z.enum(SETTINGS_ACTIONS), testMode: z.boolean(), simulateOutcome: z.enum(SIMULATED_OUTCOMES), selfInvoicesOn: z.boolean() }),
    live: { permission: 'invoices.view', fields: ['companyId', 'action', 'testMode', 'simulateOutcome', 'selfInvoicesOn'] },
  }),
  defineEvent({
    type: 'self_invoice.changed',
    context: 'e-invoicing',
    description: "A foreign supplier's invoice got its self-invoice (TD17, TD18 or TD19, with its draft invoice), a pending self-invoice got its draft, or a self-invoice was issued or cancelled.",
    payload: z.strictObject({ selfInvoiceId: z.uuid(), companyId: z.uuid(), supplierInvoiceId: z.uuid(), kind: z.enum(SELF_INVOICE_KINDS), action: z.enum(SELF_INVOICE_ACTIONS), invoiceId: z.uuid().nullable() }),
    live: { permission: 'invoices.view', fields: ['selfInvoiceId', 'companyId', 'supplierInvoiceId', 'kind', 'action', 'invoiceId'] },
  }),
  defineEvent({
    type: 'sdi_archive_copy.changed',
    context: 'e-invoicing',
    description: "Our own copy of a send to SDI (the XML sent and SDI's notifications, as our own fiscal-archive files) was made, or took more notifications.",
    payload: z.strictObject({ copyId: z.uuid(), invoiceId: z.uuid(), submissionId: z.uuid(), action: z.enum(COPY_ACTIONS), receipts: z.number().int().min(0) }),
    live: { permission: 'invoices.view', fields: ['copyId', 'invoiceId', 'submissionId', 'action', 'receipts'] },
  }),
] as const
