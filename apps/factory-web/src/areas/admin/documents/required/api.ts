import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Required documents' calls (B-W2b-177; apps/factory-api platform/files/required): the rules of the companies the person
 * may see with what a rule may name, a new rule, and a rule's change (blocks or warns, on or off; a rule is never deleted).
 */

export const ruleSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  recordType: z.string(),
  category: z.string(),
  beforeStatus: z.string(),
  partyRole: z.string().nullable(),
  level: z.enum(['BLOCK', 'WARN']),
  active: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Rule = z.infer<typeof ruleSchema>

const listSchema = z.object({
  rules: z.array(ruleSchema),
  recordTypes: z.array(z.object({ recordType: z.string(), statuses: z.array(z.string()) })),
  categories: z.array(z.string()),
  mayChange: z.array(z.string()),
})
export type RulesAnswer = z.infer<typeof listSchema>

export const listRules = (api: ApiClient, companyId: string | null): Promise<RulesAnswer> =>
  api.get('/files/required-rules', { query: companyId ? { companyId } : {}, schema: listSchema })

export const createRule = (
  api: ApiClient,
  body: { companyId: string; recordType: string; category: string; beforeStatus: string; partyRole: string | null; level: 'BLOCK' | 'WARN' },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<Rule> => api.post('/files/required-rules', { body, idempotencyKey, schema: z.object({ rule: ruleSchema }) }).then((answer) => answer.rule)

export const changeRule = (api: ApiClient, rule: Pick<Rule, 'id' | 'version'>, change: { level?: 'BLOCK' | 'WARN'; active?: boolean }): Promise<Rule> =>
  api
    .request('PATCH', `/files/required-rules/${encodeURIComponent(rule.id)}`, { body: { ...change, version: rule.version }, idempotencyKey: newIdempotencyKey(), schema: z.object({ rule: ruleSchema }) })
    .then((answer) => answer.rule)
