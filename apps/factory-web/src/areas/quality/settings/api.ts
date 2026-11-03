import { z } from 'zod'
import { FOUR_EYES_RULES } from '@nexus/factory-domain/quality/release/rules'
import { ALERT_AUDIENCES, ALERT_CHANNELS, QUALITY_ALERT_EVENTS } from '@nexus/factory-domain/quality/rules/alerts'
import { FOUR_EYES_CONDITIONS, LOOSENINGS, SEPARATION_IDS } from '@nexus/factory-domain/quality/rules/duties'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Quality › Settings › Quality rules (SCR-260), with the answer's shape checked (zod; unknown fields dropped).
 * The shapes mirror apps/factory-api modules/quality/rules/contract.ts (B-W2b-118). Each write carries the version read and
 * an Idempotency-Key per attempt; a looser rule of who may sign what carries the reason and asks for a fresh code (403
 * `stepUp`: the page's step-up dialog, then the same call again).
 */

const source = z.enum(['COMPANY', 'TENANT', 'DEFAULT'])
const condition = z.enum(FOUR_EYES_CONDITIONS)
const rule4 = z.enum(FOUR_EYES_RULES)
const place = z.object({ id: z.string(), code: z.string(), name: z.string() })

export const rulesSchema = z.object({
  companyId: z.string().nullable(),
  company: place.nullable(),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
  mayChange: z.boolean(),
  duties: z.object({
    own: z.object({ releaseFourEyes: rule4.nullable(), fourEyesConditions: z.array(condition), secondPersonPartyIds: z.array(z.string()), placerMayRelease: z.boolean().nullable() }).nullable(),
    inForce: z.object({
      releaseFourEyes: z.object({ rule: rule4, source }),
      conditions: z.array(condition),
      conditionsFromTenant: z.array(condition),
      placerMayRelease: z.object({ value: z.boolean(), source }),
    }),
    customers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), listedOn: z.enum(['COMPANY', 'TENANT']) })),
  }),
  results: z.object({
    own: z.object({ stopAtRejectNumber: z.boolean().nullable(), benchUndoSeconds: z.number().int().nullable() }).nullable(),
    inForce: z.object({ stopAtRejectNumber: z.object({ value: z.boolean(), source }), benchUndoSeconds: z.object({ value: z.number().int(), source }) }),
    limits: z.object({ benchUndoMin: z.number().int(), benchUndoMax: z.number().int() }),
  }),
  monitoring: z.array(z.object({ siteId: z.string(), code: z.string(), name: z.string(), scanSubject: z.enum(['WORKER', 'STATION']) })),
  separations: z.array(z.object({ id: z.enum(SEPARATION_IDS), kept: z.boolean(), roles: z.array(z.object({ id: z.string(), key: z.string(), name: z.string(), permissions: z.array(z.string()) })) })),
})
export type Rules = z.infer<typeof rulesSchema>

/** GET /quality/rules?companyId (quality.rules.view): a company's rules (null: every company's). */
export const readRules = (api: ApiClient, companyId: string | null, signal?: AbortSignal) => api.get('/quality/rules', { query: companyId ? { companyId } : {}, schema: rulesSchema, signal })

export interface DutiesBody {
  companyId: string | null
  version: number
  releaseFourEyes: 'WHEN_REQUIRED' | 'ALWAYS' | null
  fourEyesConditions: ('OVERRIDE' | 'CUSTOMER')[]
  secondPersonPartyIds: string[]
  placerMayRelease: boolean | null
  reason?: string | null
}

/** PUT /quality/rules/duties (quality.settings.manage): a looser rule needs `reason` and a fresh code. */
export const saveDuties = (api: ApiClient, body: DutiesBody, idempotencyKey: string) =>
  api.request('PUT', '/quality/rules/duties', { body, schema: z.object({ rules: rulesSchema, loosened: z.array(z.enum(LOOSENINGS)) }), idempotencyKey })

export interface ResultsBody {
  companyId: string | null
  version: number
  stopAtRejectNumber: boolean | null
  benchUndoSeconds: number | null
}

export const saveResults = (api: ApiClient, body: ResultsBody, idempotencyKey: string) =>
  api.request('PUT', '/quality/rules/results', { body, schema: z.object({ rules: rulesSchema, changed: z.array(z.string()) }), idempotencyKey })

// ---- alert and escalation rules ------------------------------------------------------------------------------------------

const event = z.enum(QUALITY_ALERT_EVENTS)
const audience = z.enum(ALERT_AUDIENCES)
const channel = z.enum(ALERT_CHANNELS)

export const alertRuleSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: place.nullable(),
  event,
  audience,
  roleId: z.string().nullable(),
  role: z.object({ id: z.string(), key: z.string(), name: z.string() }).nullable(),
  withinMinutes: z.number().int(),
  daysBefore: z.array(z.number().int()),
  channels: z.array(channel),
  enabled: z.boolean(),
  inForce: z.boolean(),
  sentence: z.object({ it: z.string(), en: z.string() }),
  lastFiredAt: z.string().nullable(),
  fired7d: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AlertRule = z.infer<typeof alertRuleSchema>

export const alertRulesSchema = z.object({
  companyId: z.string().nullable(),
  rules: z.array(alertRuleSchema),
  events: z.array(z.object({ event, timing: z.enum(['EVENT', 'WAIT', 'DAYS', 'ESCALATION']), ownerNamed: z.boolean() })),
  roles: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
  places: z.object({ everywhere: z.boolean(), companies: z.array(place) }),
  starterMissing: z.array(event),
  mayManage: z.boolean(),
})
export type AlertRules = z.infer<typeof alertRulesSchema>

export const readAlertRules = (api: ApiClient, companyId: string | null, signal?: AbortSignal) =>
  api.get('/quality/alert-rules', { query: companyId ? { companyId } : {}, schema: alertRulesSchema, signal })

export interface AlertRuleBody {
  companyId: string | null
  event: AlertRule['event']
  audience: AlertRule['audience']
  roleId: string | null
  withinMinutes: number
  daysBefore: number[]
  channels: AlertRule['channels']
  enabled?: boolean
}

export const createAlertRule = (api: ApiClient, body: AlertRuleBody, idempotencyKey: string) => api.post('/quality/alert-rules', { body, schema: z.object({ rule: alertRuleSchema }), idempotencyKey })

export type AlertRuleEdit = Partial<Pick<AlertRuleBody, 'audience' | 'roleId' | 'withinMinutes' | 'daysBefore' | 'channels' | 'enabled'>>

export const editAlertRule = (api: ApiClient, id: string, version: number, edit: AlertRuleEdit, idempotencyKey: string) =>
  api.request('PATCH', `/quality/alert-rules/${encodeURIComponent(id)}`, { body: { version, ...edit }, schema: z.object({ rule: alertRuleSchema }), idempotencyKey })

export const deleteAlertRule = (api: ApiClient, id: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `/quality/alert-rules/${encodeURIComponent(id)}`, { query: { version }, schema: z.object({ deleted: z.string(), event }), idempotencyKey })

export const addStarterRules = (api: ApiClient, idempotencyKey: string) => api.post('/quality/alert-rules/starter', { body: {}, schema: z.object({ added: z.array(event), ruleIds: z.array(z.string()) }), idempotencyKey })

export const testAlertRule = (api: ApiClient, id: string, idempotencyKey: string) =>
  api.post(`/quality/alert-rules/${encodeURIComponent(id)}/test`, { body: {}, schema: z.object({ sent: z.boolean(), sentence: z.object({ it: z.string(), en: z.string() }) }), idempotencyKey })

// ---- customers for the four-eyes list ---------------------------------------------------------------------------------------

export const customerSchema = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type Customer = z.infer<typeof customerSchema>

/** `GET /parties?role=CUSTOMER,BRAND` (parties.view): the customers the list may name. */
export async function findCustomers(api: ApiClient, q: string, signal?: AbortSignal): Promise<Customer[]> {
  return (await api.get('/parties', { query: { q: q.trim() || undefined, role: 'CUSTOMER,BRAND', limit: 50 }, schema: z.object({ parties: z.array(customerSchema) }), signal })).parties
}
