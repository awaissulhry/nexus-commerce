import { z } from 'zod'
import { CANCELLATION_DEPOSIT_KINDS, CANCELLATION_DOCUMENTS, CANCELLED_BY, REFUND_RULES } from '@nexus/factory-domain/invoicing/cancellation/cancellation'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The refund rule on cancellation (B-W2b-396's API; FIN-080; design finance.settings sec:deposits "refund on cancellation
 * (W2b)"): the company's rules — for each kind of deposit, who cancels and which orders, what is kept or paid back and the
 * document that follows — with adding, changing and archiving one. A percent kept is not money. No rule: everything is
 * paid back (the API's own default).
 */

export { CANCELLATION_DEPOSIT_KINDS, CANCELLATION_DOCUMENTS, CANCELLED_BY, REFUND_RULES }
export type DepositKind = (typeof CANCELLATION_DEPOSIT_KINDS)[number]
export type CancelledBy = (typeof CANCELLED_BY)[number]
export type RefundRule = (typeof REFUND_RULES)[number]
export type DocumentKind = (typeof CANCELLATION_DOCUMENTS)[number]

export const depositRuleSchema = z.object({
  id: z.string(),
  version: z.number(),
  companyId: z.string(),
  depositKind: z.enum(CANCELLATION_DEPOSIT_KINDS),
  cancelledBy: z.enum(CANCELLED_BY),
  madeToMeasure: z.boolean().nullable(),
  refundRule: z.enum(REFUND_RULES),
  keepPct: z.string(),
  documentKind: z.enum(CANCELLATION_DOCUMENTS),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
})
export type DepositRule = z.infer<typeof depositRuleSchema>

const listSchema = z.object({ companyId: z.string(), rules: z.array(depositRuleSchema), mayManage: z.boolean() })
export type DepositRules = z.infer<typeof listSchema>

/** The company's rules (invoices.view). */
export function listDepositRules(api: ApiClient, companyId: string, status: 'ACTIVE' | 'ARCHIVED' | 'ALL', signal?: AbortSignal): Promise<DepositRules> {
  return api.get('/invoicing/deposit-rules', { query: { companyId, status }, schema: listSchema, signal })
}

const one = z.object({ rule: depositRuleSchema })

export interface RuleBody {
  depositKind: DepositKind
  cancelledBy: CancelledBy
  madeToMeasure: boolean | null
  refundRule: RefundRule
  keepPct: string
  documentKind: DocumentKind
  note: string | null
}

/** One ACTIVE rule per company, kind, side and kind of order (a second: 409 in words) (invoices.depositRules.manage). */
export async function createDepositRule(api: ApiClient, companyId: string, body: RuleBody, idempotencyKey: string): Promise<DepositRule> {
  return (await api.post('/invoicing/deposit-rules', { body: { companyId, ...body }, schema: one, idempotencyKey })).rule
}

/** What is kept, the document, the note (the kind, the side and the kind of order are fixed). */
export async function updateDepositRule(api: ApiClient, rule: Pick<DepositRule, 'id' | 'version'>, body: Pick<RuleBody, 'refundRule' | 'keepPct' | 'documentKind' | 'note'>, idempotencyKey: string): Promise<DepositRule> {
  return (await api.request('PATCH', `/invoicing/deposit-rules/${encodeURIComponent(rule.id)}`, { body: { version: rule.version, ...body }, schema: one, idempotencyKey })).rule
}

export async function archiveDepositRule(api: ApiClient, rule: Pick<DepositRule, 'id' | 'version'>, idempotencyKey: string): Promise<DepositRule> {
  return (await api.post(`/invoicing/deposit-rules/${encodeURIComponent(rule.id)}/archive`, { body: { version: rule.version }, schema: one, idempotencyKey })).rule
}

export const depositRulesTouched = (change: { type: string }): boolean => change.type === 'deposit_cancellation_rule.changed'
