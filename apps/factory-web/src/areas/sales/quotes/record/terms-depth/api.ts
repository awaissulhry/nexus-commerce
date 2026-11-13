import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { QuoteDetail } from '../../api'
import { termsSchema, type QuoteTerms } from '../lines-depth/api'

/**
 * Terms & delivery in depth (B-W2b-316 on B-W2b-294's PUT /sales/quotes/:quoteId/terms: Incoterm and place, ship complete
 * or as ready, the acceptance mode; the quote's `version` and the answer's `quoteVersion`), and the deposit's pay-online
 * page (W1's POST /payments/deposit-requests/:id/link, now the Links › Pay online page of B-W2b-199: bank transfer and card).
 */

export interface TermsPatch {
  incoterm?: string | null
  incotermPlace?: string | null
  shipComplete?: boolean
  acceptanceMode?: 'SIGN' | 'SIGN_AND_PAY'
}

export function saveTerms(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, patch: TermsPatch): Promise<QuoteTerms> {
  return api.request('PUT', `/sales/quotes/${encodeURIComponent(quote.id)}/terms`, { body: { version: quote.version, ...patch }, schema: termsSchema, idempotencyKey: newIdempotencyKey() })
}

const linkAnswerSchema = z.object({
  link: z.object({ id: z.string(), expiresAt: z.string(), to: z.string() }),
  delivery: z.enum(['sent', 'failed', 'retry', 'settled', 'replayed']),
})
export type PayLinkAnswer = z.infer<typeof linkAnswerSchema>

/** Mails the deposit's pay-online page (bank transfer or card) to the quote's contact; an older live page of the address stops. */
export function sendPayLink(api: ApiClient, depositRequestId: string): Promise<PayLinkAnswer> {
  return api.post(`/payments/deposit-requests/${encodeURIComponent(depositRequestId)}/link`, { body: {}, schema: linkAnswerSchema, idempotencyKey: newIdempotencyKey() })
}
