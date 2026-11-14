import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * A payment's bank line (B-W2b-425 on B-W2b-393's API; design finance.payments rec:Payment tab Bank line: "bank, date,
 * amount, reference text, payer IBAN; confidence and reasons"). No money in this section. The lists mirror factory-domain
 * payments/matching (the tests hold them equal); the API's English words are never drawn.
 */

export const MATCH_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number]
export const MATCH_REASONS = ['AMOUNT_EQUAL', 'AMOUNT_WITHIN_TOLERANCE', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN', 'NAME_MATCHES', 'CHOSEN_BY_PERSON'] as const
export type MatchReason = (typeof MATCH_REASONS)[number]

const bankLineSchema = z.object({
  paymentId: z.string(),
  recordedByHand: z.boolean(),
  line: z
    .object({
      id: z.string(),
      statementId: z.string(),
      bank: z.string().nullable(),
      accountIban: z.string().nullable(),
      bookedOn: z.string(),
      valueOn: z.string().nullable(),
      referenceText: z.string().nullable(),
      counterpartyName: z.string().nullable(),
      counterpartyIban: z.string().nullable(),
      match: z.object({
        id: z.string(),
        confidence: z.enum(MATCH_CONFIDENCES),
        reasons: z.array(z.object({ code: z.enum(MATCH_REASONS) })),
        chosenByPerson: z.boolean(),
        acceptedAt: z.string().nullable(),
        acceptedById: z.string().nullable(),
        reversedAt: z.string().nullable(),
      }),
    })
    .nullable(),
})
export type PaymentBankLine = z.infer<typeof bankLineSchema>

/** GET /payments/:id/bank-line (payments.view; the line itself only with payments.bank.view). */
export function paymentBankLine(api: ApiClient, paymentId: string, signal?: AbortSignal): Promise<PaymentBankLine> {
  return api.get(`/payments/${encodeURIComponent(paymentId)}/bank-line`, { schema: bankLineSchema, signal })
}
