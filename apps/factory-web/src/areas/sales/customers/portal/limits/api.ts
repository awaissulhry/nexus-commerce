import { z } from 'zod'
import { ORDER_FREEZE_ACTIONS, ORDER_FREEZE_FIELDS, ORDER_FREEZE_STAGES, type OrderFreezeAction, type OrderFreezeField, type OrderFreezeStage } from '@nexus/factory-domain/sales/order-changes/freeze'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * F-PR-07 — the freeze points of the limits card (B-PR-14 on B-W2b-309's routes, modules/sales/order-changes): the company's rules
 * beside the customer's own, and the customer's own kept here. Read with orders.view, sales.settings.manage, partners.view or
 * partners.production.manage over the company AND the customer (else 404, the words of an unknown customer); kept with
 * sales.settings.manage or partners.production.manage (`mayManage`). A customer's own rules for a field replace the company's for
 * that customer; another customer's rules never show here. Only containers call these.
 */

const words = z.object({ en: z.string(), it: z.string() })

const freezeRule = z.object({
  id: z.string(),
  companyId: z.string(),
  /** The customer whose own rule it is (null: the company's). */
  partyId: z.string().nullable(),
  field: z.enum(ORDER_FREEZE_FIELDS),
  fieldWords: words,
  frozenFrom: z.enum(ORDER_FREEZE_STAGES),
  stageWords: words,
  action: z.enum(ORDER_FREEZE_ACTIONS),
  active: z.boolean(),
  note: z.string().nullable(),
  words,
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
  version: z.number(),
})
export type FreezeRule = z.infer<typeof freezeRule>

const freezeListSchema = z.object({
  companyId: z.string(),
  partyId: z.string().nullable(),
  rules: z.array(freezeRule),
  /** Whose rules decide each field for this customer (COMPANY when it has none of its own). */
  fields: z.array(z.object({ field: z.enum(ORDER_FREEZE_FIELDS), words, scope: z.enum(['SIZE', 'LINE', 'ORDER']), set: z.enum(['CUSTOMER', 'COMPANY']) })),
  mayManage: z.boolean(),
})
export type FreezeList = z.infer<typeof freezeListSchema>

/** GET /sales/order-freeze-rules?companyId&partyId — the customer's own rules beside the company's. */
export const listFreezeRules = (api: ApiClient, scope: { readonly companyId: string; readonly partyId: string }) =>
  api.get('/sales/order-freeze-rules', { query: { companyId: scope.companyId, partyId: scope.partyId }, schema: freezeListSchema })

export interface FreezeRuleDraftBody {
  readonly companyId: string
  readonly partyId: string
  readonly field: OrderFreezeField
  readonly frozenFrom: OrderFreezeStage
  readonly action: OrderFreezeAction
  readonly note: string | null
}

/** POST /sales/order-freeze-rules — one rule of the customer's own. */
export const createFreezeRule = (api: ApiClient, body: FreezeRuleDraftBody, idempotencyKey: string) =>
  api.post('/sales/order-freeze-rules', { body: { ...body }, idempotencyKey, schema: z.object({ rule: freezeRule }) })

/** PATCH /sales/order-freeze-rules/:ruleId — switch one of the customer's own rules off (back to the company's for that field). */
export const switchOffFreezeRule = (api: ApiClient, rule: Pick<FreezeRule, 'id' | 'version'>, idempotencyKey: string) =>
  api.request('PATCH', `/sales/order-freeze-rules/${encodeURIComponent(rule.id)}`, { body: { version: rule.version, active: false }, idempotencyKey, schema: z.object({ rule: freezeRule }) })
