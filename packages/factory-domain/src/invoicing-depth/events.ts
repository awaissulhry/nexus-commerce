import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of invoicing in depth (B-W2b-396; FIN-068, FIN-080 and the fee follow-ups; apps/factory-api
 * modules/invoicing/{runs,cancellation} and from-shipment/fees.ts). Context `invoicing-depth`, its own module folder (the
 * event guard wants `src/<module>/events.ts`; the invoicing events file is W1's). They reach the office screens that read
 * invoices (invoices.view). No amount, no person, no words: ids, codes and actions. A draft made, changed or deleted by
 * these routes also emits W1's invoice.draft_saved / invoice.draft_deleted, an issue invoice.issued.
 *
 *   invoice_run.changed                a company's monthly invoice run was made, its customers picked again, issued or deleted
 *   deposit_cancellation_rule.changed  a company's rule for the deposit of a cancelled order was made, changed or archived
 *   deposit_cancellation.decided       the deposits of a cancelled order were decided: the credit notes it drafted
 *   fee_credit.changed                 an order's fee was named against its customer's bulk order (with the credit note
 *                                      drafted), or credited (the credit note issued, or the fee never invoiced)
 */
export const RUN_ACTIONS = ['CREATED', 'PICKED', 'ISSUED', 'DELETED'] as const
export const RULE_ACTIONS = ['CREATED', 'EDITED', 'ARCHIVED'] as const
export const FEE_CREDIT_ACTIONS = ['NAMED', 'CREDITED'] as const

export const events = [
  defineEvent({
    type: 'invoice_run.changed',
    context: 'invoicing-depth',
    description: "A company's monthly invoice run was made with its customers' deferred invoices, its customers picked again, issued (its drafts that passed the checks issued and sent) or deleted while a preview.",
    payload: z.strictObject({ invoiceRunId: z.uuid(), companyId: z.uuid(), month: z.string(), action: z.enum(RUN_ACTIONS), invoices: z.number().int().min(0) }),
    live: { permission: 'invoices.view', fields: ['invoiceRunId', 'companyId', 'month', 'action', 'invoices'] },
  }),
  defineEvent({
    type: 'deposit_cancellation_rule.changed',
    context: 'invoicing-depth',
    description: "A company's rule for the deposit when an order is cancelled (what is kept or paid back, the document that follows) was made, changed or archived.",
    payload: z.strictObject({ ruleId: z.uuid(), companyId: z.uuid(), action: z.enum(RULE_ACTIONS) }),
    live: { permission: 'invoices.view', fields: ['ruleId', 'companyId', 'action'] },
  }),
  defineEvent({
    type: 'deposit_cancellation.decided',
    context: 'invoicing-depth',
    description: 'The paid deposits of a cancelled order were decided by the rules: the credit notes of their deposit invoices were drafted for what is paid back.',
    payload: z.strictObject({ orderId: z.uuid(), cancelledBy: z.enum(['CUSTOMER', 'COMPANY']), creditNoteIds: z.array(z.uuid()) }),
    live: { permission: 'invoices.view', fields: ['orderId', 'cancelledBy', 'creditNoteIds'] },
  }),
  defineEvent({
    type: 'fee_credit.changed',
    context: 'invoicing-depth',
    description: "An order's fee (development, sample, tooling) was named against the customer's bulk order with its credit note drafted, or credited: that credit note issued, or the fee credited before any invoice billed it.",
    payload: z.strictObject({ salesOrderLineId: z.uuid(), orderId: z.uuid(), bulkOrderId: z.uuid(), action: z.enum(FEE_CREDIT_ACTIONS), creditNoteId: z.uuid().nullable() }),
    live: { permission: 'invoices.view', fields: ['salesOrderLineId', 'orderId', 'bulkOrderId', 'action', 'creditNoteId'] },
  }),
] as const
