import { z } from 'zod'
import { defineEvent } from '../events/define'
import { RIBA_SETTLEMENTS } from '../receivables/riba/riba'
import { STOP_REASONS } from '../receivables/stops/stops'

/**
 * The events of collections (B-W2b-402; FIN-112, FIN-113, FIN-126, FIN-128; apps/factory-api modules/receivables/{riba,stops,
 * notices}, reminders/approval.ts). Context `receivables-collections`, its own module folder (the receivables events file is
 * W2a's). Payloads carry ids, codes and counts: never an amount, a name, an IBAN or a text. A trusted reminder that went by
 * itself emits W2a's payment_reminder.approved and payment_reminder.sent (the system approved it).
 *
 *   riba_batch.changed            a Ri.Ba. batch was made, its instalments picked again, its CBI file made (ISSUED) or the
 *                                 draft cancelled
 *   riba_item.settled             an instalment of an issued batch was paid (its payment recorded) or came back unpaid
 *   reminder_stop.changed         a stop on an invoice's reminders was recorded, changed or lifted
 *   reminder_trust.changed        a customer's trusted reminder level changed (the reminders that go without a person)
 *   collections_settings.changed  a company's (or the tenant's) Ri.Ba. switch or payment received notice switch changed
 *   payment.receipt_sent          the payment received notice of a bank transfer was e-mailed to the customer (its switch on)
 */
const live = { permission: 'receivables.view' } as const

export const events = [
  defineEvent({
    type: 'riba_batch.changed',
    context: 'receivables-collections',
    description: "A Ri.Ba. batch was made, its instalments picked again, its CBI file made for the bank's site, or the draft cancelled.",
    payload: z.strictObject({ batchId: z.uuid(), action: z.enum(['CREATED', 'PICKED', 'ISSUED', 'CANCELLED']), items: z.number().int().min(0), fileId: z.uuid().nullable() }),
    live: { ...live, fields: ['batchId', 'action', 'items'] },
  }),
  defineEvent({
    type: 'riba_item.settled',
    context: 'receivables-collections',
    description: 'An instalment of an issued Ri.Ba. batch was paid by the customer (its payment recorded) or came back unpaid with the bank’s fee.',
    payload: z.strictObject({ batchId: z.uuid(), itemId: z.uuid(), invoiceId: z.uuid(), partyId: z.uuid(), status: z.enum(RIBA_SETTLEMENTS), paymentId: z.uuid().nullable() }),
    live: { ...live, fields: ['batchId', 'itemId', 'invoiceId', 'status'] },
  }),
  defineEvent({
    type: 'reminder_stop.changed',
    context: 'receivables-collections',
    description: "A stop on an invoice's payment reminders was recorded, changed or lifted.",
    payload: z.strictObject({ stopId: z.uuid(), invoiceId: z.uuid(), partyId: z.uuid(), reason: z.enum(STOP_REASONS), action: z.enum(['ADDED', 'CHANGED', 'LIFTED']) }),
    live: { ...live, fields: ['stopId', 'invoiceId', 'partyId', 'action'] },
  }),
  defineEvent({
    type: 'reminder_trust.changed',
    context: 'receivables-collections',
    description: "A customer's trusted reminder level changed: the reminders up to it go without a person while reminders are switched on.",
    payload: z.strictObject({ partyId: z.uuid(), level: z.number().int().min(1).max(10).nullable() }),
    live: { ...live, fields: ['partyId', 'level'] },
  }),
  defineEvent({
    type: 'collections_settings.changed',
    context: 'receivables-collections',
    description: "A company's (or every company's) Ri.Ba. switch or payment received notice switch was turned on or off.",
    payload: z.strictObject({ settingsId: z.uuid(), companyId: z.uuid().nullable(), ribaOn: z.boolean(), paymentNoticeToCustomerOn: z.boolean() }),
    live: { ...live, fields: ['settingsId', 'companyId', 'ribaOn', 'paymentNoticeToCustomerOn'] },
  }),
  defineEvent({
    type: 'payment.receipt_sent',
    context: 'receivables-collections',
    description: "A bank transfer's payment received notice was e-mailed to the customer's invoice contacts (the company's switch on).",
    payload: z.strictObject({ paymentId: z.uuid(), partyId: z.uuid(), outboundId: z.uuid() }),
    live: { permission: 'payments.view', fields: ['paymentId', 'partyId'] },
  }),
] as const
