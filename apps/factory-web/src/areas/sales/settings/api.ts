import { z } from 'zod'
import { DOCUMENT_KINDS } from '@nexus/factory-domain/numbering/kinds'
import { FREIGHT_PAYERS } from '@nexus/factory-domain/sales/returns/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Sales › Settings (SCR-235): the quote rules and defaults (`GET/PUT /sales/settings`, B-W1-21: a company's
 * own row or the tenant-wide one; the margin floor is the margin grain and is absent without it), the return policy
 * (`GET/PUT /sales/returns/policy`, B-W2a-43: per field the company's row, else the tenant's) and the number series of
 * the sales documents (`GET /numbering/series`, read-only here). The quote rules and the return policy live on ONE
 * SalesSettings row with ONE version: after a save both are read again. The reason lists have their own editor
 * (areas/_shared/reasons). Each answer is checked with a zod shape that mirrors the API's contract.
 */

export { FREIGHT_PAYERS }
export type FreightPayer = (typeof FREIGHT_PAYERS)[number]

const settingsRow = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  marginFloorPct: z.string().optional(),
  discountLimitPct: z.string(),
  defaultValidityDays: z.number(),
  defaultDepositPct: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type SettingsRow = z.infer<typeof settingsRow>
const rules = z.object({ marginFloorPct: z.string().optional(), discountLimitPct: z.string(), defaultValidityDays: z.number(), defaultDepositPct: z.string().nullable(), source: z.enum(['DEFAULT', 'TENANT', 'COMPANY']) })
export type QuoteRulesView = z.infer<typeof rules>

const settingsSchema = z.object({ settings: z.object({ tenant: settingsRow.nullable(), company: settingsRow.nullable(), inForce: rules, defaults: rules }) })
export type SalesSettings = z.infer<typeof settingsSchema>['settings']

export const getSalesSettings = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<SalesSettings> =>
  api.get('/sales/settings', { query: companyId ? { companyId } : {}, schema: settingsSchema, signal }).then((answer) => answer.settings)

export interface QuoteRulesBody {
  companyId?: string
  marginFloorPct: string
  discountLimitPct: string
  defaultValidityDays: number
  defaultDepositPct: string | null
  version?: number
}

export const saveSalesSettings = (api: ApiClient, body: QuoteRulesBody) => api.request('PUT', '/sales/settings', { body, schema: z.object({ settings: settingsRow }), idempotencyKey: newIdempotencyKey() })

const policy = z.object({ windowDays: z.number().nullable(), goodsDueDays: z.number().nullable(), freightPaidBy: z.enum(FREIGHT_PAYERS).nullable(), restockingFeePct: z.string().nullable(), conditions: z.string().nullable() })
export type ReturnPolicy = z.infer<typeof policy>
const policyRow = policy.extend({ id: z.string(), companyId: z.string().nullable(), version: z.number(), updatedAt: z.string() })
export type PolicyRow = z.infer<typeof policyRow>

const policySchema = z.object({ policy: z.object({ tenant: policyRow.nullable(), company: policyRow.nullable(), inForce: policy, followsTenant: z.boolean(), canManage: z.boolean() }) })
export type PolicyAnswer = z.infer<typeof policySchema>['policy']

export const getReturnPolicy = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<PolicyAnswer> =>
  api.get('/sales/returns/policy', { query: companyId ? { companyId } : {}, schema: policySchema, signal }).then((answer) => answer.policy)

export interface PolicyBody extends ReturnPolicy {
  companyId?: string
  version?: number
}

export const saveReturnPolicy = (api: ApiClient, body: PolicyBody) => api.request('PUT', '/sales/returns/policy', { body, schema: z.object({ policy: policyRow }), idempotencyKey: newIdempotencyKey() })

const series = z.object({ id: z.string(), companyId: z.string(), kind: z.enum(DOCUMENT_KINDS), code: z.string(), year: z.number().nullable(), nextNumber: z.string().nullable(), status: z.enum(['ACTIVE', 'CLOSED']) })
export type Series = z.infer<typeof series>

/** The company's number series (numbering.view). */
export const listSeries = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<Series[]> =>
  api.get('/numbering/series', { query: { companyId }, schema: z.object({ series: z.array(series) }), signal }).then((answer) => answer.series)
