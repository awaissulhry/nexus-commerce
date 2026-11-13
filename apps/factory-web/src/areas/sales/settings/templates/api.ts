import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { listTemplates, templateSchema, type QuoteTemplate } from '../../quotes/new-from/api'

/**
 * Sales settings › Quote templates (B-W2b-316 on B-W2b-294's /sales/quote-templates; SAL-144): the list (every template the
 * person reaches, active or archived), one template with its lines, and its writes — each with the template's `version`
 * (a template changed meanwhile is a 409, never overwritten) and an Idempotency-Key. A unit price is the price grain.
 */

export { listTemplates }

const enc = encodeURIComponent
const one = z.object({ template: templateSchema })

export interface TemplateHeader {
  name?: string
  description?: string | null
  language?: 'it' | 'en'
  validityDays?: number | null
  firmOffer?: boolean
  acceptanceMode?: 'SIGN' | 'SIGN_AND_PAY'
  depositPct?: string | null
  depositKind?: 'ACCONTO' | 'CAPARRA' | null
  termsVersion?: string | null
  incoterm?: string | null
  incotermPlace?: string | null
  shipComplete?: boolean
}

export interface TemplateLineInput {
  seq: number
  section?: string | null
  kind: 'SIZE_GRID'
  styleId: string
  colourwayId?: string | null
  sizes?: Record<string, number> | null
  unitPrice?: string | null
  description?: string | null
  note?: string | null
}

export async function createTemplate(api: ApiClient, body: TemplateHeader & { companyId: string | null; name: string; lines: TemplateLineInput[] }): Promise<QuoteTemplate> {
  return (await api.post('/sales/quote-templates', { body, schema: one, idempotencyKey: newIdempotencyKey() })).template
}

export async function updateTemplate(api: ApiClient, template: Pick<QuoteTemplate, 'id' | 'version'>, patch: TemplateHeader): Promise<QuoteTemplate> {
  return (await api.request('PATCH', `/sales/quote-templates/${enc(template.id)}`, { body: { version: template.version, ...patch }, schema: one, idempotencyKey: newIdempotencyKey() })).template
}

export async function replaceTemplateLines(api: ApiClient, template: Pick<QuoteTemplate, 'id' | 'version'>, lines: TemplateLineInput[]): Promise<QuoteTemplate> {
  return (await api.request('PUT', `/sales/quote-templates/${enc(template.id)}/lines`, { body: { version: template.version, lines }, schema: one, idempotencyKey: newIdempotencyKey() })).template
}

export async function moveTemplate(api: ApiClient, template: Pick<QuoteTemplate, 'id' | 'version'>, to: 'archive' | 'restore'): Promise<QuoteTemplate> {
  return (await api.post(`/sales/quote-templates/${enc(template.id)}/${to}`, { body: { version: template.version }, schema: one, idempotencyKey: newIdempotencyKey() })).template
}

/** A template from a quote's current version (its lines, sections and terms); the quote's company, or every company. */
export async function templateFromQuote(api: ApiClient, body: { quoteId: string; name: string; companyId?: string | null }): Promise<QuoteTemplate> {
  return (await api.post('/sales/quote-templates/from-quote', { body, schema: one, idempotencyKey: newIdempotencyKey() })).template
}
