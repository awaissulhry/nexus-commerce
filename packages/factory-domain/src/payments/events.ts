import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The payments module's events (plan A1 §3.4, §3.5; B-W1-28; FIN-121, FIN-066; Q12). apps/factory-api's
 * modules/payments emits them in the command that makes the change. Payloads carry ids and kinds only: never an amount
 * or a bank reference (a screen refetches what it shows, with its grain).
 *
 *   payment.recorded              a bank transfer received was recorded
 *   payment.allocated             part of a payment was allocated to a deposit request or an issued invoice (A2 SCR-080's
 *                                 Payment column, SCR-082)
 *   payment.allocation_reversed   an allocation was taken back by a reversal row
 *   payment.voided                a payment typed by mistake was voided
 *   payment.deposit_paid          the payments allocated to a deposit request cover it: the request is PAID (sales'
 *                                 order screens; the deposit gate before production, W2)
 *
 * B-W2a-61 (FIN-127 refunds, FIN-122 the credit balance; modules/payments/refunds.ts, credit-balance.ts):
 *   refund.recorded               a refund to a customer was recorded, DUE (to make) or PAID (made): its source is a
 *                                 credit note or a payment's unplaced part (the tile "Refunds to make", the record)
 *   refund.changed                a DUE refund's amount, due date or note changed
 *   refund.paid                   a DUE refund was paid: the bank's date and reference are recorded
 *   refund.cancelled              a DUE refund is not paid after all (the customer keeps the credit)
 *   refund.voided                 a refund recorded as paid by mistake was voided
 *   payment.overpayment_released  an invoice paid beyond what it is worth after a credit note gave the excess back to
 *                                 its payments' unplaced part: the customer's credit balance
 */
const target = z.enum(['DEPOSIT_REQUEST', 'INVOICE'])
const live = { permission: 'payments.view', fields: ['paymentId'] } as const
const refundLive = { permission: 'payments.view', fields: ['refundId'] } as const

export const events = [
  defineEvent({
    type: 'payment.recorded',
    context: 'payments',
    description: 'A payment received (a bank transfer) was recorded.',
    payload: z.strictObject({ paymentId: z.uuid(), partyId: z.uuid(), method: z.literal('BANK_TRANSFER') }),
    live,
  }),
  defineEvent({
    type: 'payment.allocated',
    context: 'payments',
    description: 'Part of a payment was allocated to a deposit request or an issued invoice.',
    payload: z.strictObject({ paymentId: z.uuid(), allocationId: z.uuid(), target, targetId: z.uuid() }),
    live: { permission: 'payments.view', fields: ['paymentId', 'target', 'targetId'] },
  }),
  defineEvent({
    type: 'payment.allocation_reversed',
    context: 'payments',
    description: 'An allocation of a payment was taken back (a reversal row).',
    payload: z.strictObject({ paymentId: z.uuid(), allocationId: z.uuid(), reversalOfId: z.uuid(), target, targetId: z.uuid() }),
    live: { permission: 'payments.view', fields: ['paymentId', 'target', 'targetId'] },
  }),
  defineEvent({
    type: 'payment.voided',
    context: 'payments',
    description: 'A payment typed by mistake was voided (its allocations were all reversed).',
    payload: z.strictObject({ paymentId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'payment.deposit_paid',
    context: 'payments',
    description: 'The payments allocated to a deposit request cover it: the request is PAID.',
    payload: z.strictObject({ depositRequestId: z.uuid(), partyId: z.uuid(), orderId: z.uuid().nullable() }),
    live: { permission: 'payments.view', fields: ['depositRequestId'] },
  }),
  // B-W2a-61: refunds and the credit balance.
  defineEvent({
    type: 'refund.recorded',
    context: 'payments',
    description: 'A refund to a customer was recorded: due (to make) or paid (made), of a credit note or of a payment not placed.',
    payload: z.strictObject({ refundId: z.uuid(), partyId: z.uuid(), source: z.enum(['CREDIT_NOTE', 'PAYMENT']), sourceId: z.uuid(), status: z.enum(['DUE', 'PAID']) }),
    live: refundLive,
  }),
  defineEvent({
    type: 'refund.changed',
    context: 'payments',
    description: "A due refund's amount, due date or note changed.",
    payload: z.strictObject({ refundId: z.uuid(), fields: z.array(z.enum(['amount', 'dueDate', 'internalNote'])).min(1) }),
    live: refundLive,
  }),
  defineEvent({
    type: 'refund.paid',
    context: 'payments',
    description: "A due refund was paid: the transfer's value date and the bank's reference are recorded.",
    payload: z.strictObject({ refundId: z.uuid(), partyId: z.uuid() }),
    live: refundLive,
  }),
  defineEvent({
    type: 'refund.cancelled',
    context: 'payments',
    description: 'A due refund is not paid after all (the customer keeps the credit).',
    payload: z.strictObject({ refundId: z.uuid(), partyId: z.uuid() }),
    live: refundLive,
  }),
  defineEvent({
    type: 'refund.voided',
    context: 'payments',
    description: 'A refund recorded as paid by mistake was voided.',
    payload: z.strictObject({ refundId: z.uuid(), partyId: z.uuid() }),
    live: refundLive,
  }),
  defineEvent({
    type: 'payment.overpayment_released',
    context: 'payments',
    description: "An invoice paid beyond what it is worth after a credit note gave the excess back to its payments' unplaced part (the customer's credit balance).",
    payload: z.strictObject({ invoiceId: z.uuid(), partyId: z.uuid(), paymentIds: z.array(z.uuid()).min(1) }),
    live: { permission: 'payments.view', fields: ['invoiceId'] },
  }),
  defineEvent({
    type: 'deposit_request.link_sent',
    context: 'payments',
    description: 'The customer was mailed a DEPOSIT_INFO link to its deposit request: the amount, the due date and the bank details for the transfer (B-W2b-16: also for a request made on an order without a quote, orderId set, quoteId null).',
    payload: z.strictObject({ depositRequestId: z.uuid(), quoteId: z.uuid().nullable(), orderId: z.uuid().nullable(), partyId: z.uuid(), linkId: z.uuid() }),
    live: { permission: 'payments.view', fields: ['depositRequestId', 'quoteId'] },
  }),
] as const
