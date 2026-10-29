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
 */
const target = z.enum(['DEPOSIT_REQUEST', 'INVOICE'])
const live = { permission: 'payments.view', fields: ['paymentId'] } as const

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
  defineEvent({
    type: 'deposit_request.link_sent',
    context: 'payments',
    description: 'The customer was mailed a DEPOSIT_INFO link to its deposit request: the amount, the due date and the bank details for the transfer.',
    payload: z.strictObject({ depositRequestId: z.uuid(), quoteId: z.uuid(), partyId: z.uuid(), linkId: z.uuid() }),
    live: { permission: 'payments.view', fields: ['depositRequestId', 'quoteId'] },
  }),
] as const
