import { z } from 'zod'
import { defineEvent } from '../events/define'
import { INTENT_METHODS, INTENT_TARGETS } from '../payments/online/rules'

/**
 * Paying online (B-W2b-185; FIN-118, FIN-123). apps/factory-api's modules/payments/online emits them; their own module folder
 * because check-event-contract wants `src/<module>/events.ts` (the rules are payments/online).
 *
 *   payment_intent.started    a customer started a card or SEPA payment (by link or in the portal): WAITING once the
 *                             provider made it, FAILED when the provider refused at once
 *   payment_intent.finished   the provider's webhook ended it: SUCCEEDED (with the Payment it recorded), FAILED or
 *                             CANCELLED (a later payment replaced it, or the customer's bank declined it)
 *   payment_link.sent         the office sent a customer the page to pay an invoice (a PAYMENT link)
 *
 * Office screens: payments.view over the event's company (the invoice's or deposit request's payments card). Ids, kinds
 * and states only: never an amount, a provider reference or an address.
 */

const live = { permission: 'payments.view', fields: ['intentId', 'target', 'targetId'] } as const
const target = z.enum(INTENT_TARGETS)

export const events = [
  defineEvent({
    type: 'payment_intent.started',
    context: 'payment-intents',
    description: 'A customer started paying a deposit request or an invoice online, by card or SEPA Direct Debit.',
    payload: z.strictObject({ intentId: z.uuid(), partyId: z.uuid(), target, targetId: z.uuid(), method: z.enum(INTENT_METHODS), status: z.enum(['CREATED', 'WAITING', 'FAILED']), byLink: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'payment_intent.finished',
    context: 'payment-intents',
    description: "The payment provider ended an online payment: succeeded (its payment recorded and allocated), failed or cancelled.",
    payload: z.strictObject({ intentId: z.uuid(), partyId: z.uuid(), target, targetId: z.uuid(), method: z.enum(INTENT_METHODS), status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']), paymentId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'payment_link.sent',
    context: 'payment-intents',
    description: 'The office sent a customer the page to pay an invoice online (a PAYMENT link).',
    payload: z.strictObject({ linkId: z.uuid(), partyId: z.uuid(), target, targetId: z.uuid() }),
    live: { permission: 'payments.view', fields: ['linkId', 'target', 'targetId'] },
  }),
] as const
