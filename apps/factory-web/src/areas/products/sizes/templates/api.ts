import { z } from 'zod'
import { templateRulesView } from '@nexus/factory-domain/product/mtm-rules/contracts'
import { templateView, type NewTemplateBody, type TemplatePointBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { getTemplate, listTemplates, type TemplateOption, type TemplateRules, type TemplateView } from '../../../sales/mtm/api'

/**
 * Products › Sizes & measurements › Measurement templates (B-W1-17 on B-W2b-358's and B-W2b-248's API; design products.sizes
 * sec:sizes.templates, pop:sizes.newTemplate, the record "Measurement template"): the list and one template come from
 * Sales › Made-to-measure's calls (the same routes); here the writes — a new template, its name, its points saved whole, archive
 * and restore — and the made-to-measure rules read and switched (GATE-MTM, the Owner's product.mtm.switch). Every write sends
 * the template's version and one Idempotency-Key per attempt; answers are checked against factory-domain's own contracts. The
 * API's English (`rulesSummary`, `summary`, `refusal`, an issue's message) is never shown: model.ts says it from facts.
 */

export type { TemplateOption, TemplateRules, TemplateView }
export type TemplatePoint = TemplateView['points'][number]
export type RulesPoint = TemplateRules['points'][number]
export type MtmRule = TemplateRules['rules'][number]
export { getTemplate, listTemplates }

const enc = encodeURIComponent
const BASE = '/product/measurement-templates'
const one = z.object({ template: templateView })
const keyed = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

export async function createTemplate(api: ApiClient, body: NewTemplateBody, idempotencyKey?: string): Promise<TemplateView> {
  return (await api.post(BASE, { body, schema: one, ...keyed(idempotencyKey) })).template
}

export async function renameTemplate(api: ApiClient, template: Pick<TemplateView, 'id' | 'version'>, patch: { name: string }, idempotencyKey?: string): Promise<TemplateView> {
  return (await api.request('PATCH', `${BASE}/${enc(template.id)}`, { body: { version: template.version, ...patch }, schema: one, ...keyed(idempotencyKey) })).template
}

/** The whole list of points in its order: kept by code, changed, added; a point left out is archived (never deleted). */
export async function savePoints(api: ApiClient, template: Pick<TemplateView, 'id' | 'version'>, points: readonly TemplatePointBody[], idempotencyKey?: string): Promise<TemplateView> {
  return (await api.request('PUT', `${BASE}/${enc(template.id)}/points`, { body: { version: template.version, points }, schema: one, ...keyed(idempotencyKey) })).template
}

export async function moveTemplate(api: ApiClient, template: Pick<TemplateView, 'id' | 'version'>, to: 'archive' | 'restore', idempotencyKey?: string): Promise<TemplateView> {
  return (await api.post(`${BASE}/${enc(template.id)}/${to}`, { body: { version: template.version }, schema: one, ...keyed(idempotencyKey) })).template
}

const rulesAnswer = z.object({ rules: templateRulesView })

/** The template's made-to-measure rules (B-W2b-248): on or off, the rules, the base size rule, the points' limits. */
export async function readRules(api: ApiClient, templateId: string, signal?: AbortSignal): Promise<TemplateRules> {
  return (await api.get(`${BASE}/${enc(templateId)}/mtm-rules`, { schema: rulesAnswer, signal })).rules
}

/** Made-to-measure started or stopped for the template (GATE-MTM: product.mtm.switch, the Owner's), at the template's version. */
export async function switchRules(api: ApiClient, templateId: string, body: { version: number; on: boolean; reason: string | null }, idempotencyKey?: string): Promise<TemplateRules> {
  return (await api.request('PUT', `${BASE}/${enc(templateId)}/mtm-rules/switch`, { body, schema: rulesAnswer, ...keyed(idempotencyKey) })).rules
}
