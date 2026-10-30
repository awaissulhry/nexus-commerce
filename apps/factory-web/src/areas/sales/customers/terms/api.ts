import { z } from 'zod'
import { PRICE_LIST_KINDS } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { INCOTERMS_2020, INVOICE_TIMINGS } from '@nexus/factory-domain/sales/terms/terms'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The customer's commercial terms (B-W2a-49 on the API of B-W2a-19: apps/factory-api modules/parties commercial-terms.ts
 * and modules/sales/terms): the card's read and its one write, and the payment terms library the card picks from. The
 * minimum order is the price grain: ABSENT (never null) without it. The write sends the party's `version` (the terms are
 * columns of the party: a party changed meanwhile is a 409, never overwritten) with its own Idempotency-Key.
 */

export type Incoterm = (typeof INCOTERMS_2020)[number]
export type InvoiceTiming = (typeof INVOICE_TIMINGS)[number]
export { INCOTERMS_2020, INVOICE_TIMINGS }

const chainList = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.enum(PRICE_LIST_KINDS), currency: z.string(), status: z.string(), companyId: z.string().nullable() })
export type ChainList = z.infer<typeof chainList>
const summary = z.object({ it: z.string(), en: z.string() })
const deposit = z.object({ sharePct: z.string(), days: z.number() })

export const commercialTermsSchema = z.object({
  partyId: z.string(),
  code: z.string(),
  companyId: z.string().nullable(),
  currency: z.string(),
  language: z.string(),
  paymentTermsId: z.string().nullable(),
  paymentTerms: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), status: z.string(), summary, deposit: deposit.nullable() }).nullable(),
  paymentTermsText: z.string().nullable(),
  priceListId: z.string().nullable(),
  priceList: chainList.nullable(),
  discountGroup: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  priceChain: z.array(chainList),
  defaultDepositPct: z.string().nullable(),
  invoiceTiming: z.enum(INVOICE_TIMINGS),
  invoiceTypePreset: z.enum(['TD01', 'TD24']),
  incoterm: z.string().nullable(),
  preferredCarrierCode: z.string().nullable(),
  minimumOrderAmount: z.number().nullable().optional(),
  version: z.number(),
})
export type CommercialTerms = z.infer<typeof commercialTermsSchema>
const oneTerms = z.object({ terms: commercialTermsSchema })

export const paymentTermsSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()).nullable(),
  method: z.string(),
  deposit: deposit.nullable(),
  summary,
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  customers: z.number(),
  version: z.number(),
})
export type PaymentTermsRow = z.infer<typeof paymentTermsSchema>

const enc = encodeURIComponent

export async function getCommercialTerms(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<CommercialTerms> {
  return (await api.get(`/parties/${enc(partyId)}/commercial-terms`, { schema: oneTerms, signal })).terms
}

export interface TermsPatch {
  currency?: string
  language?: string
  paymentTermsId?: string | null
  priceListId?: string | null
  defaultDepositPct?: string | null
  invoiceTiming?: InvoiceTiming
  incoterm?: Incoterm | null
  preferredCarrierCode?: string | null
  /** Net, in the customer's currency, minor units. */
  minimumOrderAmount?: number | null
}

export async function updateCommercialTerms(api: ApiClient, terms: Pick<CommercialTerms, 'partyId' | 'version'>, patch: TermsPatch): Promise<CommercialTerms> {
  return (await api.request('PATCH', `/parties/${enc(terms.partyId)}/commercial-terms`, { body: { version: terms.version, ...patch }, schema: oneTerms, idempotencyKey: newIdempotencyKey() })).terms
}

/** The payment terms library this company may use (its own and every company's), ACTIVE only. */
export async function listPaymentTerms(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PaymentTermsRow[]> {
  return (await api.get('/sales/payment-terms', { query: { companyId: companyId ?? undefined, status: 'ACTIVE' }, schema: z.object({ terms: z.array(paymentTermsSchema) }), signal })).terms
}
