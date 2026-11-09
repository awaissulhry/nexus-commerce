import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { cardOfferSchema, intentSchema, startedSchema, type PaymentIntent, type PaymentMethod, type StartedPayment } from '../../lib/payments/online'

/**
 * Pay online by link (apps/factory-api modules/payments/online/link.ts, B-W2b-185; FIN-123): a PAYMENT link (an invoice or
 * a deposit request the office sent to be paid) or W1's DEPOSIT_INFO link (the deposit's bank details, now with card).
 * What you pay, the bank transfer (always), card and SEPA (offered or why not), the latest payment started from this
 * link; start a payment (the client secret in the answer only), then how it stands. The party's own price only. The
 * token travels only in `x-factory-link` (the client the link landing made); starting a payment does not use the link.
 */

const price = z.number().int().optional()

export const payPageSchema = z.object({
  what: z.object({
    target: z.enum(['DEPOSIT_REQUEST', 'INVOICE']),
    id: z.string(),
    /** The invoice's number (null for a deposit request). */
    number: z.string().nullable(),
    orderNumber: z.string().nullable(),
    quoteDocument: z.string().nullable(),
    issueDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    currency: z.string(),
    total: price,
    /** Paid and credited so far. */
    settled: price,
    /** Still to pay. */
    open: price,
  }),
  /** To pay · Paid (nothing open and something paid) · Closed (cancelled, waived, rejected: nothing to pay). */
  status: z.enum(['TO_PAY', 'PAID', 'CLOSED']),
  bank: z
    .object({
      method: z.literal('BANK_TRANSFER'),
      amount: price,
      currency: z.string(),
      dueDate: z.string().nullable(),
      reference: z.string(),
      bank: z.object({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(),
    })
    .nullable(),
  card: cardOfferSchema,
  /** The latest payment started from this link. */
  intent: intentSchema.nullable(),
  from: z.object({ legalName: z.string(), tradeName: z.string().nullable() }),
  expiresAt: z.string(),
})
export type PayPage = z.infer<typeof payPageSchema>

export function readPayPage(api: ApiClient, signal?: AbortSignal): Promise<PayPage> {
  return api.get('/payments/link/pay', { schema: payPageSchema, signal })
}

/** W1's deposit facts (DEPOSIT_INFO only, `GET /payments/link/deposit`): acconto or caparra, and its share of the total. */
export const depositFactsSchema = z.object({ deposit: z.object({ kind: z.string(), depositPct: z.string().nullable() }) })
export type DepositFacts = z.infer<typeof depositFactsSchema>['deposit']

export function readDepositFacts(api: ApiClient, signal?: AbortSignal): Promise<DepositFacts> {
  return api.get('/payments/link/deposit', { schema: depositFactsSchema, signal }).then((read) => read.deposit)
}

/** Start paying by card or SEPA (the same payer's payment under way is taken up again: `resumed`). */
export function startLinkPayment(api: ApiClient, method: PaymentMethod, idempotencyKey: string = newIdempotencyKey()): Promise<StartedPayment> {
  return api.post('/payments/link/pay/intents', { body: { method }, schema: startedSchema, idempotencyKey })
}

/** How a payment of this link stands (the page polls it: the provider's webhook moves it). */
export function readLinkIntent(api: ApiClient, intentId: string, signal?: AbortSignal): Promise<PaymentIntent> {
  return api.get(`/payments/link/pay/intents/${encodeURIComponent(intentId)}`, { schema: z.object({ intent: intentSchema }), signal }).then((read) => read.intent)
}
