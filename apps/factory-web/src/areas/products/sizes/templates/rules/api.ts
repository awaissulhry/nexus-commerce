import { z } from 'zod'
import { templateRulesView, type PutRulesBody } from '@nexus/factory-domain/product/mtm-rules/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { TemplateRules } from '../api'

/**
 * The rule editor's one write (B-W2b-371, XF2:05): B-W2b-248's PUT /product/measurement-templates/:id/mtm-rules — the whole rule list
 * (kept by code, changed, added; left out = removed), the base size rule, the points' limits, at the template's version; one
 * Idempotency-Key per attempt. The answer is the rules as kept (factory-domain's contract).
 */
export async function saveRules(api: ApiClient, templateId: string, body: PutRulesBody, idempotencyKey: string = newIdempotencyKey()): Promise<TemplateRules> {
  return (await api.request('PUT', `/product/measurement-templates/${encodeURIComponent(templateId)}/mtm-rules`, { body, schema: z.object({ rules: templateRulesView }), idempotencyKey })).rules
}
