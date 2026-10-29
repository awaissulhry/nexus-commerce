import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'

/**
 * The customer's accept link (apps/factory-api modules/sales/quotes/accept.ts; B-W1-24; QUOTE_ACCEPT): the version as it
 * was sent (`GET /link/quote`: the party's own prices only, never a cost or margin), its state, what the page must ask
 * before each answer, the deposit and how to pay it once accepted, the privacy notice. The answers name the version the
 * page showed. The token travels only in `x-factory-link` (the client the link landing made).
 */

const postal = z.object({ line1: z.string(), line2: z.string().optional(), postalCode: z.string(), city: z.string(), province: z.string().optional(), country: z.string() })

export const linkQuoteSchema = z.object({
  quote: z.object({
    number: z.string(),
    quoteNumber: z.string(),
    versionId: z.string(),
    revision: z.number(),
    seller: z.object({ legalName: z.string(), tradeName: z.string().nullable() }),
    customerRef: z.string().nullable(),
    date: z.string(),
    language: z.enum(['it', 'en']),
    currency: z.string(),
    priceBasis: z.enum(['NET', 'GROSS']),
    validUntil: z.string(),
    firmOffer: z.boolean(),
    promiseDate: z.string().nullable(),
    paymentTerms: z.string().nullable(),
    billTo: z.object({ legalName: z.string(), address: postal }),
    shipTo: z.object({ name: z.string().optional(), line1: z.string(), line2: z.string().optional(), postalCode: z.string(), city: z.string(), province: z.string().optional(), country: z.string() }),
    lines: z.array(
      z.object({
        seq: z.number(),
        code: z.string(),
        description: z.string(),
        note: z.string().nullable(),
        quantity: z.number(),
        unitPrice: z.string().optional(),
        discountPct: z.string().nullable(),
        netAmount: z.number().optional(),
        vatAmount: z.number().optional(),
        vatRatePct: z.string(),
        vatNature: z.string().nullable(),
        sizesText: z.string(),
      }),
    ),
    totals: z.object({ net: z.number(), vat: z.array(z.object({ rate: z.string().nullable(), nature: z.string().nullable(), taxable: z.number(), vat: z.number() })), gross: z.number() }).optional(),
    deposit: z.object({ pct: z.string(), kind: z.enum(['ACCONTO', 'CAPARRA']), amount: z.number().optional() }).nullable(),
    noWithdrawal: z.boolean(),
    terms: z.object({ termsVersion: z.string(), clauses: z.array(z.object({ code: z.string(), text: z.string() })) }),
    document: z.object({ fileId: z.string(), name: z.string(), sha256: z.string(), sizeBytes: z.number() }).nullable(),
  }),
  state: z.enum(['OPEN', 'EXPIRED', 'REVISING', 'SUPERSEDED', 'ACCEPTED', 'DECLINED', 'CANCELLED']),
  message: z.string(),
  answers: z.array(z.object({ action: z.enum(['accept', 'decline']), typedName: z.enum(['required', 'optional', 'none']), email: z.boolean(), noWithdrawal: z.boolean() })),
  acceptance: z.object({ signerName: z.string(), acceptedAt: z.string(), documentSha256: z.string(), termsVersion: z.string().nullable() }).nullable(),
  deposit: z
    .object({
      id: z.string(),
      kind: z.enum(['ACCONTO', 'CAPARRA']),
      depositPct: z.string().nullable(),
      currency: z.string(),
      amount: z.number().optional(),
      dueDate: z.string(),
      fiscalDocument: z.enum(['TD02', 'NONE']),
      status: z.enum(['OPEN', 'PAID', 'WAIVED', 'CANCELLED']),
      instructions: z.object({
        method: z.literal('BANK_TRANSFER'),
        amount: z.number().optional(),
        currency: z.string(),
        dueDate: z.string(),
        reference: z.string(),
        bank: z.object({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(),
        text: z.string(),
      }),
    })
    .nullable(),
  expiresAt: z.string(),
  privacy: z.object({ url: z.string(), retention: z.string() }),
})
export type LinkQuote = z.infer<typeof linkQuoteSchema>

export function readLinkQuote(api: ApiClient, signal?: AbortSignal): Promise<LinkQuote> {
  return api.get('/link/quote', { schema: linkQuoteSchema, signal })
}

export function acceptLinkQuote(api: ApiClient, body: { versionId: string; typedName: string; email?: string | null; noWithdrawalAccepted?: boolean; note?: string | null }): Promise<LinkQuote> {
  return api.post('/link/quote/accept', { body, schema: linkQuoteSchema, idempotencyKey: newIdempotencyKey() })
}

export function declineLinkQuote(api: ApiClient, body: { versionId: string; typedName?: string | null; note?: string | null }): Promise<LinkQuote> {
  return api.post('/link/quote/decline', { body, schema: linkQuoteSchema, idempotencyKey: newIdempotencyKey() })
}

export function askNewLink(api: ApiClient, note: string | null): Promise<{ asked: boolean }> {
  return api.post('/link/quote/new-link', { body: { note }, schema: z.object({ asked: z.boolean(), message: z.string() }), idempotencyKey: newIdempotencyKey() })
}

/** The version's PDF as it was sent (`GET /link/quote/document`, through the link only): its bytes, for the viewer. */
export function documentBytes(api: ApiClient, signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes('/link/quote/document', { signal })
}
