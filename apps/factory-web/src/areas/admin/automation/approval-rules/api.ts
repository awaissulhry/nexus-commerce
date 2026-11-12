import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { APPROVAL_MEANINGS } from '../../../../shell/panels/approvals/api'

/**
 * Admin › Automation › Approval rules (B-W2b-307 on B-W2b-282's routes; PLT-086, PLT-042, PLT-105): the kinds a rule may
 * be for and the facts its condition may check (`GET /approvals/kinds`), the rules with their sentence, approver, meaning,
 * fired in 30 days and the locked "nobody approves their own request" (`GET /approvals/rules`), a new rule — ALWAYS written
 * OFF (the Owner's answer) — (`POST /approvals/rules`), a change or the switch with the version as read (`PUT
 * /approvals/rules/:id`), and the rule's test against the kind's latest records (`POST /approvals/rules/test`). A money
 * threshold the reader's grains do not show comes `held` without its value. Words come en + it from the API.
 */

const words = z.object({ en: z.string(), it: z.string() })
export type Words = z.infer<typeof words>
const OPERATORS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'contains', 'isTrue', 'isFalse'] as const

const fieldSchema = z.object({
  id: z.string(),
  label: words,
  kind: z.enum(['number', 'text', 'choice', 'yesNo']),
  unit: z.string().nullable(),
  grain: z.string().nullable(),
  options: z.array(z.object({ value: z.string(), label: words })),
  min: z.number().nullable(),
  max: z.number().nullable(),
  heldReason: z.string().nullable(),
})
export type KindField = z.infer<typeof fieldSchema>

const kindSchema = z.object({ kind: z.string(), recordType: z.string(), label: words, fields: z.array(fieldSchema), askable: z.boolean() })
export type RuleKind = z.infer<typeof kindSchema>

const kindsSchema = z.object({
  kinds: z.array(kindSchema),
  notRegistered: z.array(z.string()),
  meanings: z.array(z.object({ meaning: z.enum(APPROVAL_MEANINGS), label: words })),
  operators: z.array(z.string()),
})
export type KindsAnswer = z.infer<typeof kindsSchema>

const conditionSchema = z.object({
  combinator: z.enum(['and', 'or']),
  rows: z.array(z.object({ id: z.string().nullable(), field: z.string(), operator: z.enum(OPERATORS), value: z.union([z.string(), z.array(z.string())]).nullable(), held: z.boolean() })),
})

export const approvalRuleSchema = z.object({
  id: z.string(),
  kind: z.string(),
  kindLabel: words,
  registered: z.boolean(),
  name: z.string(),
  sentence: words,
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  condition: conditionSchema,
  approver: z.object({ kind: z.enum(['ROLE', 'PERSON']), id: z.string(), name: z.string() }),
  signatureMeaning: z.enum(APPROVAL_MEANINGS).nullable(),
  requireStepUp: z.boolean(),
  sequence: z.number().int(),
  dueHours: z.number().int().nullable(),
  active: z.boolean(),
  effectiveFrom: z.string().nullable(),
  fired30Days: z.number().int(),
  changedBy: z.object({ id: z.string(), name: z.string(), me: z.boolean() }).nullable(),
  updatedAt: z.string(),
  canChange: z.boolean(),
  heldReason: z.string().nullable(),
  version: z.number().int(),
})
export type ApprovalRule = z.infer<typeof approvalRuleSchema>

const rulesSchema = z.object({
  asOf: z.string(),
  rules: z.array(approvalRuleSchema),
  fixed: z.array(z.object({ code: z.literal('NO_SELF_APPROVAL'), sentence: words })),
  canAdd: z.boolean(),
})
export type RulesAnswer = z.infer<typeof rulesSchema>

const testSchema = z.object({
  tested: z.number().int(),
  wouldAsk: z.number().int(),
  samples: z.array(z.object({ record: z.object({ type: z.string(), id: z.string(), label: z.string() }), companyId: z.string() })),
  approvers: z.array(z.object({ id: z.string(), name: z.string() })),
  sentence: words,
})
export type RuleTest = z.infer<typeof testSchema>

/** The condition as the API takes it (RuleBuilder's draft: rows of field · operator · value, joined by AND / OR). */
export interface ConditionBody {
  readonly combinator: 'and' | 'or'
  readonly rows: readonly { readonly id?: string; readonly field: string; readonly operator: (typeof OPERATORS)[number]; readonly value: string | readonly string[] | null }[]
}
export type ApproverBody = { readonly roleId: string } | { readonly userId: string }

export interface RuleBody {
  readonly name: string
  readonly condition: ConditionBody
  readonly approver: ApproverBody
  readonly signatureMeaning: (typeof APPROVAL_MEANINGS)[number] | null
  readonly requireStepUp: boolean
  readonly sequence: number
  readonly dueHours: number | null
}

export const fetchKinds = (api: ApiClient, signal?: AbortSignal): Promise<KindsAnswer> => api.get('/approvals/kinds', { schema: kindsSchema, signal })
export const fetchRules = (api: ApiClient, signal?: AbortSignal): Promise<RulesAnswer> => api.get('/approvals/rules', { schema: rulesSchema, signal })

export async function createRule(api: ApiClient, body: RuleBody & { readonly kind: string; readonly companyId: string | null }): Promise<ApprovalRule> {
  return (await api.post('/approvals/rules', { body, schema: z.object({ rule: approvalRuleSchema }), idempotencyKey: newIdempotencyKey() })).rule
}

export async function updateRule(api: ApiClient, rule: Pick<ApprovalRule, 'id' | 'version'>, change: Partial<RuleBody> & { readonly active?: boolean }): Promise<ApprovalRule> {
  return (await api.request('PUT', `/approvals/rules/${encodeURIComponent(rule.id)}`, { body: { version: rule.version, ...change }, schema: z.object({ rule: approvalRuleSchema }), idempotencyKey: newIdempotencyKey() })).rule
}

export const testRule = (api: ApiClient, body: { readonly kind: string; readonly companyId: string | null; readonly condition: ConditionBody; readonly approver?: ApproverBody }): Promise<RuleTest> =>
  api.post('/approvals/rules/test', { body, schema: testSchema })
