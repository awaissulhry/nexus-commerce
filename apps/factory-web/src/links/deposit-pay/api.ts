import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'

/**
 * The customer's deposit page by link (apps/factory-api modules/payments/deposit-link.ts; DEPOSIT_INFO; Q12 (a): an
 * acconto paid by bank transfer): the deposit request as its party sees it, the quote and order it belongs to, and how
 * to pay it (amount, due date, the reference to write on the transfer, the company's bank account). The party's own
 * price only. The token travels only in `x-factory-link` (the client the link landing made).
 */

export const linkDepositSchema = z.object({
  deposit: z.object({ kind: z.string(), depositPct: z.string().nullable(), currency: z.string(), amount: z.number().optional(), dueDate: z.string(), status: z.string(), paid: z.boolean() }),
  /** B-W2b-16: null for a deposit asked on an order typed without a quote (the order names it). */
  quote: z.object({ document: z.string() }).nullable(),
  order: z.object({ number: z.string() }).nullable(),
  from: z.object({ legalName: z.string(), tradeName: z.string().nullable() }),
  instructions: z.object({
    method: z.literal('BANK_TRANSFER'),
    amount: z.number().optional(),
    currency: z.string(),
    dueDate: z.string(),
    reference: z.string(),
    bank: z.object({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(),
  }),
  expiresAt: z.string(),
})
export type LinkDeposit = z.infer<typeof linkDepositSchema>

export function readLinkDeposit(api: ApiClient, signal?: AbortSignal): Promise<LinkDeposit> {
  return api.get('/payments/link/deposit', { schema: linkDepositSchema, signal })
}
