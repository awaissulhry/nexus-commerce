import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Finance › Settings › Approvals & notifications (B-W2b-425 on B-W2b-403's API; design finance.settings sec:approvals "Money
 * actions that need approval; who hears about what"): what asks a yes or a fresh code for each risky money action, the money
 * notifications and who hears them, the supplier remittance mail switch. The lists mirror factory-api payables/proposal
 * (controls.ts) and platform/notifications/rules/money.ts (the tests hold them equal); the answers' words are never drawn.
 */

export const MONEY_ACTIONS = ['SUPPLIER_INVOICE', 'PAYMENT_PROPOSAL', 'MANUAL_PAYMENT', 'CREDIT_NOTE', 'WRITE_OFF', 'PRICE_OVERRIDE'] as const
export type MoneyAction = (typeof MONEY_ACTIONS)[number]
export const MONEY_NOTIFICATIONS = ['PAYMENT_RECEIVED', 'SDI_REJECTED', 'OVERDUE', 'DEPOSIT_RECEIVED', 'RECONCILIATION_DIFFERENCE'] as const
export const MONEY_AUDIENCES = ['CUSTOMER_FOLLOWERS_AND_ORDER_MAKERS', 'ISSUER_AND_FOLLOWERS', 'CUSTOMER_FOLLOWERS_AND_REMINDER_APPROVERS', 'ORDER_MAKER_AND_RELEASERS', 'BANK_MATCHERS'] as const
export const SETTINGS_SOURCES = ['COMPANY', 'TENANT', 'NONE'] as const

export const controlsSchema = z.object({
  companyId: z.string(),
  currency: z.string(),
  actions: z.array(
    z.object({
      code: z.enum(MONEY_ACTIONS),
      kind: z.object({ code: z.string(), registered: z.boolean(), rules: z.number(), active: z.number() }).nullable(),
      stepUp: z.object({ action: z.string(), on: z.boolean() }).nullable(),
      dual: z.object({ amount: z.number().optional(), decided: z.boolean() }).nullable(),
    }),
  ),
  notifications: z.array(z.object({ code: z.enum(MONEY_NOTIFICATIONS), rule: z.string(), audience: z.enum(MONEY_AUDIENCES) })),
})
export type MoneyControls = z.infer<typeof controlsSchema>
export type MoneyControl = MoneyControls['actions'][number]

export const remittanceSchema = z.object({
  companyId: z.string().nullable(),
  on: z.boolean(),
  source: z.enum(SETTINGS_SOURCES),
  version: z.number().nullable(),
  mayChange: z.boolean(),
})
export type RemittanceSettings = z.infer<typeof remittanceSchema>

/** GET /payables/money-controls (payables.view): read only. */
export function moneyControls(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<MoneyControls> {
  return api.get('/payables/money-controls', { query: { companyId }, schema: controlsSchema, signal })
}

/** GET /payables/remittance/settings (payables.view): the supplier remittance mail switch in force for the company. */
export function remittanceSettings(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<RemittanceSettings> {
  return api.get('/payables/remittance/settings', { query: { companyId }, schema: remittanceSchema, signal })
}

/** PUT /payables/remittance/settings (payables.remittance.switch, the Owner's; a fresh code to turn it ON): the company's row. */
export function setRemittance(api: ApiClient, body: { companyId: string; remittanceMailOn: boolean; version?: number }, idempotencyKey: string): Promise<RemittanceSettings> {
  return api.request('PUT', '/payables/remittance/settings', { body, schema: remittanceSchema, idempotencyKey })
}
