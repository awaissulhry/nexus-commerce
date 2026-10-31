import { z } from 'zod'
import { INSTALMENT_EVENTS } from '@nexus/factory-domain/sales/terms/terms'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The payment terms library (B-W2a-80 on the API of B-W2a-19, modules/sales/terms; design finance.settings sec:terms
 * "Terms library"): every entry with its instalments, early-payment discount, words (it/en: the API's own summary, printed
 * on the documents) and how many customers have it as their default. No money: shares in percent and days only. Every write
 * sends the entry's version; the rules of terms a quote or an order names are fixed (409): new rules are new terms.
 */

export { INSTALMENT_EVENTS }
export type InstalmentEvent = (typeof INSTALMENT_EVENTS)[number]

export const termsSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()).nullable(),
  method: z.string(),
  instalments: z.array(z.object({ sharePct: z.string(), from: z.enum(INSTALMENT_EVENTS), days: z.number(), endOfMonth: z.boolean() })),
  earlyPaymentDiscountPct: z.string().nullable(),
  earlyPaymentDays: z.number().nullable(),
  deposit: z.object({ sharePct: z.string(), days: z.number() }).nullable(),
  summary: z.object({ it: z.string(), en: z.string() }),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  customers: z.number(),
  version: z.number(),
  updatedAt: z.string().optional(),
})
export type PaymentTerms = z.infer<typeof termsSchema>

const one = z.object({ terms: termsSchema })

/** The terms this company may use (its own and every company's), active, archived or all (paymentterms.view). */
export async function listTerms(api: ApiClient, companyId: string | null, status: 'ACTIVE' | 'ARCHIVED' | 'ALL', signal?: AbortSignal): Promise<PaymentTerms[]> {
  return (await api.get('/sales/payment-terms', { query: { companyId: companyId ?? undefined, status }, schema: z.object({ terms: z.array(termsSchema) }), signal })).terms
}

export interface TermsFields {
  code: string
  name: string
  nameI18n: Record<string, string> | null
  method: string
  instalments: Array<{ sharePct: string; from: InstalmentEvent; days: number; endOfMonth: boolean }>
  earlyPaymentDiscountPct: string | null
  earlyPaymentDays: number | null
}

/** New terms of this company (paymentterms.manage). */
export async function createTerms(api: ApiClient, body: TermsFields & { companyId: string | null }, idempotencyKey: string): Promise<PaymentTerms> {
  return (await api.post('/sales/payment-terms', { body, schema: one, idempotencyKey })).terms
}

const termsPath = (id: string) => `/sales/payment-terms/${encodeURIComponent(id)}`

/** Changes terms (names always; the rules only while no quote version or order names them) (paymentterms.manage). */
export async function updateTerms(api: ApiClient, terms: Pick<PaymentTerms, 'id' | 'version'>, patch: Partial<TermsFields>, idempotencyKey: string): Promise<PaymentTerms> {
  return (await api.request('PATCH', termsPath(terms.id), { body: { version: terms.version, ...patch }, schema: one, idempotencyKey })).terms
}

/** Archives terms (refused while a customer has them as default) or brings them back (paymentterms.manage). */
export async function moveTerms(api: ApiClient, terms: Pick<PaymentTerms, 'id' | 'version'>, move: 'archive' | 'reactivate', idempotencyKey: string): Promise<PaymentTerms> {
  return (await api.post(`${termsPath(terms.id)}/${move}`, { body: { version: terms.version }, schema: one, idempotencyKey })).terms
}
