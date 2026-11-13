import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * New quote › Start from: Template or Inquiry (design pop:quotes.new; B-W2b-316 on B-W2b-294's quote templates and
 * B-W2b-295's inquiries). Each start is ONE command on the API that makes the quote and answers what it left out
 * (`leftOut[].reason` and `warnings` are English: the dialog says its own words from the line, new-from/model.ts).
 */

const enc = encodeURIComponent

export const templateRowSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  name: z.string(),
  description: z.string().nullable(),
  language: z.string(),
  currency: z.string(),
  validityDays: z.number().nullable(),
  acceptanceMode: z.enum(['SIGN', 'PAY', 'SIGN_AND_PAY']),
  incoterm: z.string().nullable(),
  incotermPlace: z.string().nullable(),
  shipComplete: z.boolean(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  lineCount: z.number(),
  sections: z.array(z.string()),
  used: z.number(),
  version: z.number(),
  updatedAt: z.string(),
})
export type TemplateRow = z.infer<typeof templateRowSchema>

export const templateLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  section: z.string().nullable(),
  kind: z.enum(['SIZE_GRID', 'FEE']),
  feeKind: z.string().nullable(),
  styleId: z.string(),
  style: z.object({ code: z.string(), name: z.string(), status: z.string() }),
  colourwayId: z.string().nullable(),
  colourway: z.object({ code: z.string(), name: z.string() }).nullable(),
  sizes: z.record(z.string(), z.number()).nullable(),
  pieces: z.number(),
  unitPrice: z.string().nullable().optional(),
  description: z.string().nullable(),
  note: z.string().nullable(),
})
export type TemplateLine = z.infer<typeof templateLineSchema>

export const templateSchema = templateRowSchema.extend({
  firmOffer: z.boolean(),
  depositPct: z.string().nullable(),
  depositKind: z.enum(['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE']).nullable().catch(null),
  paymentTermsId: z.string().nullable(),
  paymentTermsName: z.string().nullable(),
  termsText: z.string().nullable(),
  termsVersion: z.string().nullable(),
  lines: z.array(templateLineSchema),
  mayManage: z.boolean(),
})
export type QuoteTemplate = z.infer<typeof templateSchema>

export async function listTemplates(api: ApiClient, query: { companyId?: string | null; status?: 'ACTIVE' | 'ARCHIVED' | 'ALL'; q?: string }, signal?: AbortSignal): Promise<{ templates: TemplateRow[]; mayCreate: boolean }> {
  return api.get('/sales/quote-templates', { query: { companyId: query.companyId ?? undefined, status: query.status ?? 'ACTIVE', q: query.q?.trim() || undefined }, schema: z.object({ templates: z.array(templateRowSchema), mayCreate: z.boolean() }), signal })
}

export async function getTemplate(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<QuoteTemplate> {
  return (await api.get(`/sales/quote-templates/${enc(templateId)}`, { schema: z.object({ template: templateSchema }), signal })).template
}

export const leftOutSchema = z.object({ seq: z.number(), size: z.string().nullable(), reason: z.string() })
export type LeftOut = z.infer<typeof leftOutSchema>

const startAnswer = z.object({ quote: z.object({ id: z.string(), number: z.string(), lines: z.array(z.object({ id: z.string() })) }), leftOut: z.array(leftOutSchema), warnings: z.array(z.string()) })
export type StartAnswer = z.infer<typeof startAnswer>

export interface StartBody {
  companyId: string
  partyId: string
  contactId?: string | null
  customerRef?: string | null
  lines: Array<{ templateLineId: string; colourwayId?: string | null; sizes?: Record<string, number> | null; skip?: boolean }>
}

/** POST /sales/quote-templates/:id/quote: the quote made from the template, in ONE command. */
export function startFromTemplate(api: ApiClient, templateId: string, body: StartBody, idempotencyKey?: string): Promise<StartAnswer> {
  return api.post(`/sales/quote-templates/${enc(templateId)}/quote`, { body, schema: startAnswer, idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
}

export const OPEN_INQUIRY_STATUSES = ['NEW', 'ASSIGNED', 'NEED_INFO'] as const

const inquiryRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  status: z.string(),
  receivedAt: z.string(),
  summary: z.string(),
  products: z.array(z.string()),
  pieces: z.number(),
  wantedDate: z.string().nullable(),
  version: z.number(),
})
export type OpenInquiry = z.infer<typeof inquiryRowSchema>

/** A customer's open inquiries (new, assigned, waiting for the customer): the ones a quote may be made from. */
export async function openInquiries(api: ApiClient, partyId: string, signal?: AbortSignal): Promise<OpenInquiry[]> {
  const answer = await api.get('/sales/inquiries', { query: { partyId, tile: 'OPEN', limit: 200 }, schema: z.object({ rows: z.array(inquiryRowSchema) }), signal })
  return answer.rows.filter((row) => (OPEN_INQUIRY_STATUSES as readonly string[]).includes(row.status))
}

const inquiryQuoteAnswer = z.object({ quote: z.object({ id: z.string(), number: z.string() }), leftOut: z.array(leftOutSchema), warnings: z.array(z.string()) })
export type InquiryQuoteAnswer = z.infer<typeof inquiryQuoteAnswer>

/** POST /sales/inquiries/:id/quote: the quote made from the inquiry (its lines, the brand's tech pack carried), the inquiry QUOTED. */
export function quoteFromInquiry(api: ApiClient, inquiry: Pick<OpenInquiry, 'id' | 'version'>, customerRef: string | null, idempotencyKey?: string): Promise<InquiryQuoteAnswer> {
  return api.post(`/sales/inquiries/${enc(inquiry.id)}/quote`, { body: { version: inquiry.version, ...(customerRef ? { customerRef } : {}) }, schema: inquiryQuoteAnswer, idempotencyKey: idempotencyKey ?? newIdempotencyKey() })
}
